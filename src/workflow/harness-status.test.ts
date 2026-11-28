// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	formatPhaseStatusPlain,
	htilHITLPayload,
	isTerminalOrchestrationState,
	ORCHESTRATION_ORDER,
	orchestrationSummary,
	type OrchestrationState,
} from "./harness-status.ts";
import { phaseLoopStatus, type PhaseLoopState, type PhaseLoopStatus } from "./phase-loop.ts";

const SECRET_REASON = "super-secret-owner-reason-9f2c";
const SECRET_EVIDENCE = "top-secret-evidence-text-7a1d";

function minimalStatus(): PhaseLoopStatus {
	return {
		lifecycle: "ready",
		completedStages: [],
		blocker: undefined,
		attempts: { execute: 0, ship: 0, operatorConfirmations: 0 },
		transitionMetrics: { attempts: 0, accepted: 0, refused: 0 },
		recentTransitions: [],
		signals: {},
		nextEvents: ["attempt(Discuss)"],
	};
}

describe("orchestration states", () => {
	test("order holds the nine run states then the three terminal states", () => {
		expect([...ORCHESTRATION_ORDER]).toEqual([
			"IDLE",
			"DISCOVERING",
			"ISSUE_PROGRAMMING",
			"DISCUSSING",
			"PLANNING",
			"EXECUTING",
			"VERIFYING",
			"MERGING",
			"AUDITING",
			"FAILED",
			"BLOCKED",
			"DONE",
		]);
	});

	test("terminal guard accepts only FAILED, BLOCKED and DONE", () => {
		const terminal: OrchestrationState[] = ["FAILED", "BLOCKED", "DONE"];
		for (const state of terminal) expect(isTerminalOrchestrationState(state)).toBe(true);
		const live: OrchestrationState[] = [
			"IDLE",
			"DISCOVERING",
			"ISSUE_PROGRAMMING",
			"DISCUSSING",
			"PLANNING",
			"EXECUTING",
			"VERIFYING",
			"MERGING",
			"AUDITING",
		];
		for (const state of live) expect(isTerminalOrchestrationState(state)).toBe(false);
	});
});

describe("formatPhaseStatusPlain", () => {
	test("renders lifecycle, stages, next events, counts and last transition", () => {
		const status: PhaseLoopStatus = {
			...minimalStatus(),
			lifecycle: "executing",
			completedStages: ["Discuss", "Plan"],
			attempts: { execute: 2, ship: 0, operatorConfirmations: 1 },
			transitionMetrics: { attempts: 5, accepted: 4, refused: 1 },
			recentTransitions: [
				{
					at: "2026-11-27T10:00:00.000Z",
					from: "planning",
					event: "attempt(Execute)",
					to: "executing",
					accepted: true,
					refusals: [],
				},
			],
			nextEvents: ["attempt(Verify)", "open(HTIL)"],
		};
		const out = formatPhaseStatusPlain(status);
		expect(out).toContain("lifecycle executing");
		expect(out).toContain("completed Discuss,Plan");
		expect(out).toContain("next attempt(Verify),open(HTIL)");
		expect(out).toContain("execute=2");
		expect(out).toContain("attempts=5");
		expect(out).toContain("attempt(Execute) planning->executing");
	});

	test("renders overdue entries with owner, severity and dueAt", () => {
		const status: PhaseLoopStatus = {
			...minimalStatus(),
			blocker: { id: "htil-1", owner: "owner-1" },
			signals: {
				overdue: [
					{
						entryId: "htil-1",
						owner: "owner-1",
						severity: "critical",
						dueAt: "2026-11-27T04:00:00.000Z",
					},
				],
			},
		};
		const out = formatPhaseStatusPlain(status);
		expect(out).toContain("overdue 1");
		expect(out).toContain("overdue htil-1 owner=owner-1 severity=critical");
		expect(out).toContain("dueAt=2026-11-27T04:00:00.000Z");
		expect(out).toContain("blocker htil-1 owner=owner-1");
	});

	test("renders per-decision liveness without leaking reason text", () => {
		const status: PhaseLoopStatus = {
			...minimalStatus(),
			signals: {
				decisions: [
					{
						decisionId: "dec-1",
						live: true,
						quorumHave: 2,
						quorumRequired: 2,
						revoked: false,
						refusals: [],
					},
					{
						decisionId: "dec-2",
						live: false,
						quorumHave: 0,
						quorumRequired: 1,
						expiresAt: "2026-11-20T00:00:00.000Z",
						revoked: false,
						refusals: ["override dec-2 is expired"],
					},
				],
			},
		};
		const out = formatPhaseStatusPlain(status);
		expect(out).toContain("decisions 2");
		expect(out).toContain("decision dec-1 live=true quorum=2/2");
		expect(out).toContain("expired=false revoked=false");
		expect(out).toContain("decision dec-2 live=false");
		expect(out).toContain("expired=true");
		expect(out).toContain("expiresAt=2026-11-20T00:00:00.000Z");
	});

	test("never emits reason, evidence, refusal or path text", () => {
		const status: PhaseLoopStatus = {
			...minimalStatus(),
			lifecycle: "awaiting-decision",
			blocker: { id: "htil-9", owner: "owner-9" },
			transitionMetrics: { attempts: 2, accepted: 1, refused: 1 },
			recentTransitions: [
				{
					at: "2026-11-27T10:00:00.000Z",
					from: "executing",
					event: "confirmShip",
					to: "executing",
					accepted: false,
					refusals: [`missing audit ${SECRET_EVIDENCE}`, `/etc/secret/path/key.pem`],
				},
			],
			signals: {
				overdue: [
					{
						entryId: "htil-9",
						owner: "owner-9",
						severity: "high",
						dueAt: "2026-11-26T00:00:00.000Z",
					},
				],
				decisions: [
					{
						decisionId: "dec-9",
						live: true,
						quorumHave: 1,
						quorumRequired: 1,
						revoked: false,
						refusals: [`needs work: ${SECRET_REASON}`],
					},
				],
			},
			nextEvents: [],
		};
		const out = formatPhaseStatusPlain(status);
		expect(out).not.toContain(SECRET_REASON);
		expect(out).not.toContain(SECRET_EVIDENCE);
		expect(out).not.toContain("/etc/secret/path/key.pem");
		expect(out).not.toContain("missing audit");
		// Ids already present on the status are fine to emit.
		expect(out).toContain("htil-9");
		expect(out).toContain("dec-9");
	});

	test("derives overdue and decisions from a real phaseLoopStatus without leaking the override reason", () => {
		const row: PhaseLoopState = {
			runtimeId: "harness-test",
			phaseOrder: ["Discuss"],
			executeStarts: 0,
			shipStarts: 0,
			operatorConfirmations: 0,
			humanItems: [
				{
					id: "htil-1",
					owner: "owner-1",
					state: "open",
					severity: "critical",
					createdAt: "2026-11-27T00:00:00.000Z",
					dueAt: "2026-11-27T04:00:00.000Z",
				},
			],
			overrides: [
				{
					decisionId: "dec-1",
					owner: "owner-1",
					decidedAt: "2026-11-27T01:00:00.000Z",
					reason: SECRET_REASON,
				},
			],
		};
		const status = phaseLoopStatus(row, undefined, "2026-11-27T05:00:00.000Z");
		const out = formatPhaseStatusPlain(status);
		expect(out).toContain("overdue htil-1 owner=owner-1");
		expect(out).toContain("decision dec-1 live=true");
		expect(out).not.toContain(SECRET_REASON);
	});
});

describe("htilHITLPayload", () => {
	test("critical SLA is 4h and reports negative remaining when overdue", () => {
		const payload = htilHITLPayload(
			{
				id: "htil-1",
				owner: "owner-1",
				state: "open",
				severity: "critical",
				createdAt: "2026-11-27T00:00:00.000Z",
			},
			"2026-11-27T05:00:00.000Z",
		);
		expect(payload.entryId).toBe("htil-1");
		expect(payload.owner).toBe("owner-1");
		expect(payload.severity).toBe("critical");
		expect(payload.state).toBe("open");
		expect(payload.dueAt).toBe("2026-11-27T04:00:00.000Z");
		expect(payload.slaMsRemaining).toBe(-3_600_000);
		expect(payload.escalationCount).toBe(0);
		expect(payload.escalatedTo).toBeUndefined();
		expect(payload.allowedActions).toEqual(["resolve-done", "resolve-deferred", "escalate"]);
	});

	test("high SLA is 24h and normal defaults to 72h", () => {
		const high = htilHITLPayload(
			{
				id: "h",
				owner: "o",
				state: "open",
				severity: "high",
				createdAt: "2026-11-27T00:00:00.000Z",
			},
			"2026-11-27T01:00:00.000Z",
		);
		expect(high.dueAt).toBe("2026-11-28T00:00:00.000Z");
		expect(high.slaMsRemaining).toBe(23 * 3_600_000);

		const normal = htilHITLPayload(
			{ id: "n", owner: "o", state: "open", createdAt: "2026-11-27T00:00:00.000Z" },
			"2026-11-27T00:00:00.000Z",
		);
		expect(normal.severity).toBe("normal");
		expect(normal.dueAt).toBe("2026-11-30T00:00:00.000Z");
		expect(normal.slaMsRemaining).toBe(72 * 3_600_000);
	});

	test("explicit dueAt wins and escalation fields pass through", () => {
		const payload = htilHITLPayload(
			{
				id: "htil-2",
				owner: "owner-2",
				state: "open",
				severity: "critical",
				createdAt: "2026-11-20T00:00:00.000Z",
				dueAt: "2026-11-28T00:00:00.000Z",
				escalationCount: 2,
				escalatedTo: "owner-3",
			},
			"2026-11-28T01:00:00.000Z",
		);
		expect(payload.dueAt).toBe("2026-11-28T00:00:00.000Z");
		expect(payload.slaMsRemaining).toBe(-3_600_000);
		expect(payload.escalationCount).toBe(2);
		expect(payload.escalatedTo).toBe("owner-3");
	});

	test("closed entries offer no actions", () => {
		for (const state of ["done", "deferred"] as const) {
			const payload = htilHITLPayload(
				{
					id: "htil-3",
					owner: "owner-3",
					state,
					severity: "normal",
					createdAt: "2026-11-27T00:00:00.000Z",
				},
				"2026-11-27T01:00:00.000Z",
			);
			expect(payload.allowedActions).toEqual([]);
			expect(payload.state).toBe(state);
		}
	});
});

describe("orchestrationSummary", () => {
	test("renders state alone and state with detail", () => {
		expect(orchestrationSummary("EXECUTING")).toBe("EXECUTING");
		expect(orchestrationSummary("EXECUTING", "phase 2 of 5")).toBe("EXECUTING: phase 2 of 5");
		expect(orchestrationSummary("IDLE", "   ")).toBe("IDLE");
	});

	test("flattens detail to one line", () => {
		expect(orchestrationSummary("PLANNING", "line one\nline two\r\nline three")).toBe(
			"PLANNING: line one line two line three",
		);
	});

	test("caps output at 200 chars", () => {
		const out = orchestrationSummary("VERIFYING", "x".repeat(500));
		expect(out.length).toBeLessThanOrEqual(200);
		expect(out.startsWith("VERIFYING:")).toBe(true);
	});
});
