// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { TotManifest } from "../think/tot/types.ts";
import {
	CompletionGate,
	DEFAULT_GATE_INACTIVITY_MS,
	type GateProgress,
	type GateState,
	type GateTimers,
	planGateAllowed,
	planGateHash,
	validateArtifacts,
	validatePlanChecklist,
} from "./completion-gate.ts";

/** A fake clock for the watchdog: timers fire only when the test advances time. */
function fakeClock(): { timers: GateTimers; advance: (ms: number) => void; armed: () => number } {
	let time = 0;
	const entries = new Map<object, { at: number; run: () => void }>();
	return {
		timers: {
			setTimeout: (run, ms) => {
				const handle = {} as NodeJS.Timeout;
				entries.set(handle, { at: time + ms, run });
				return handle;
			},
			clearTimeout: (handle) => {
				if (handle) entries.delete(handle);
			},
		},
		advance: (ms) => {
			time += ms;
			for (const [handle, entry] of [...entries]) {
				if (entry.at > time) continue;
				entries.delete(handle);
				entry.run();
			}
		},
		armed: () => entries.size,
	};
}

const SPEC = [
	"<SYSTEM_ROLE>r</SYSTEM_ROLE>",
	"<CONTEXT>c</CONTEXT>",
	"<SCOPE>s</SCOPE>",
	"<CONSTRAINTS>k</CONSTRAINTS>",
	"<ACCEPTANCE_CRITERIA>a</ACCEPTANCE_CRITERIA>",
].join("\n");

/** A complete plan: a closed spec root, a graph of `nodes` nodes and an issue block with `steps` sub-issues per node. */
function plan(
	options: { nodes?: number; steps?: number; pending?: boolean; issues?: boolean } = {},
): string {
	const nodes = options.nodes ?? 2;
	const steps = options.steps ?? 2;
	const ids = Array.from({ length: nodes }, (_, i) => `n${i + 1}`);
	const graph = `<GRAPH_OF_THOUGHT>\n${ids.map((id) => `<NODE id="${id}" kind="task" title="t"><CONCLUSION>c</CONCLUSION></NODE>`).join("\n")}\n</GRAPH_OF_THOUGHT>`;
	const issues =
		options.issues === false
			? ""
			: `<ISSUES graphId="g" status="complete">\n${ids
					.map(
						(id) =>
							`<ISSUE node="${id}"${options.pending ? ' status="pending"' : ""}>i\n${Array.from({ length: steps }, (_, s) => `<SUBISSUE step="${s + 1}">s</SUBISSUE>`).join("\n")}\n</ISSUE>`,
					)
					.join("\n")}\n</ISSUES>`;
	return `Header line\n<BUILD_PROMPT>\n${SPEC}\n${graph}\n${issues}\n</BUILD_PROMPT>`;
}

const FULL = { nodes: 2, issues: 2, subIssues: 4 };

describe("validateArtifacts", () => {
	test("a complete plan with every expected count is ready", () => {
		const verdict = validateArtifacts({ text: plan(), expected: FULL });
		expect(verdict.state).toBe("ready");
		expect(verdict.problems).toEqual([]);
		expect(verdict.observed).toMatchObject({ nodes: 2, issues: 2, subIssues: 4, pendingRows: 0 });
	});

	test("truncated XML is rejected as unusable, never as partial", () => {
		const cut = plan().slice(0, plan().indexOf("</BUILD_PROMPT>"));
		const verdict = validateArtifacts({ text: cut, expected: FULL });
		expect(verdict.state).toBe("failed_or_cancelled");
		expect(verdict.problems[0]).toMatchObject({ severity: "fatal", code: "truncated" });
	});

	test("a closed root whose graph block is cut off is rejected", () => {
		const text = plan().replace("</GRAPH_OF_THOUGHT>", "");
		expect(validateArtifacts({ text }).state).toBe("failed_or_cancelled");
	});

	test("a root missing a required child is rejected", () => {
		const text = plan().replace(/<SCOPE>s<\/SCOPE>/, "");
		const verdict = validateArtifacts({ text });
		expect(verdict.state).toBe("failed_or_cancelled");
		expect(verdict.problems[0]).toMatchObject({ code: "missing_child" });
	});

	test("an empty plan fails", () => {
		expect(validateArtifacts({ text: "  \n" }).state).toBe("failed_or_cancelled");
	});

	test("a short node, issue or sub-issue count is a partial failure", () => {
		const verdict = validateArtifacts({ text: plan({ nodes: 1, steps: 1 }), expected: FULL });
		expect(verdict.state).toBe("partial_failure");
		expect(verdict.problems.map((problem) => problem.code)).toEqual([
			"nodes_short",
			"issues_short",
			"subIssues_short",
		]);
	});

	test("an issue block that the tracker never produced is a partial failure when rows are expected", () => {
		const verdict = validateArtifacts({ text: plan({ issues: false }), expected: FULL });
		expect(verdict.state).toBe("partial_failure");
	});

	test("pending tracker rows and a partial tracking status are partial failures", () => {
		const verdict = validateArtifacts({ text: plan({ pending: true }), expected: FULL });
		expect(verdict.state).toBe("partial_failure");
		expect(verdict.problems.map((problem) => problem.code)).toContain("rows_pending");
		const status = plan().replace('status="complete"', 'status="partial"');
		expect(
			validateArtifacts({ text: status, expected: FULL }).problems.map((problem) => problem.code),
		).toEqual(["tracking_incomplete"]);
	});

	test("a degraded node and a flagged degradation are partial failures", () => {
		const degraded = plan().replace('<NODE id="n1"', '<NODE degraded="true" id="n1"');
		expect(validateArtifacts({ text: degraded }).problems.map((problem) => problem.code)).toEqual([
			"nodes_degraded",
		]);
		expect(validateArtifacts({ text: plan(), degraded: "fallback graph" }).state).toBe(
			"partial_failure",
		);
	});

	test("PRDs: a missing or failed PRD is partial, a full set is ready", () => {
		const record = (key: string, status: "generated" | "failed") => ({
			key,
			hash: "h",
			markdown: "m",
			status,
			model: "m",
			fallback: false,
			attempts: 1,
		});
		const manifest = (statuses: ("generated" | "failed")[]): TotManifest => ({
			total: statuses.length,
			generated: statuses.filter((status) => status === "generated").length,
			failed: statuses.filter((status) => status === "failed").length,
			fallbacks: 0,
			records: statuses.map((status, i) => record(`n1.${i + 1}`, status)),
		});
		const expected = { ...FULL, prds: 4 };
		expect(
			validateArtifacts({
				text: plan(),
				expected,
				prd: manifest(["generated", "generated", "generated", "generated"]),
			}).state,
		).toBe("ready");
		const partial = validateArtifacts({
			text: plan(),
			expected,
			prd: manifest(["generated", "generated", "generated", "failed"]),
		});
		expect(partial.state).toBe("partial_failure");
		expect(partial.problems.map((problem) => problem.code)).toEqual(["prds_short", "prds_failed"]);
	});

	test("plain text with no counts expected has nothing to count and is ready", () => {
		expect(validateArtifacts({ text: "PLAN" }).state).toBe("ready");
	});

	test("a plain-text plan fails the node and issue counts it was expected to reach", () => {
		const verdict = validateArtifacts({ text: "PLAN", expected: FULL });
		expect(verdict.state).toBe("partial_failure");
		expect(verdict.problems.map((problem) => problem.code)).toEqual([
			"nodes_short",
			"issues_short",
			"subIssues_short",
		]);
	});

	test("root-less text with an unclosed graph block is fatal and truncated", () => {
		const verdict = validateArtifacts({
			text: 'PLAN\n<GRAPH_OF_THOUGHT>\n<NODE id="n1" kind="task" title="t">',
		});
		expect(verdict.state).toBe("failed_or_cancelled");
		expect(verdict.problems).toContainEqual(
			expect.objectContaining({ severity: "fatal", code: "truncated" }),
		);
	});

	test("a node example outside the uplift root is not counted", () => {
		const text = `Example: <NODE id="x" kind="task" title="t" />\n${plan({ nodes: 1, steps: 1 })}`;
		expect(validateArtifacts({ text, expected: { nodes: 1 } })).toMatchObject({
			state: "ready",
			observed: { nodes: 1 },
		});
	});

	test("requireXml refuses plain text", () => {
		expect(validateArtifacts({ text: "PLAN" }, { requireXml: true }).state).toBe(
			"failed_or_cancelled",
		);
	});
});

describe("CompletionGate", () => {
	test("staged artifacts are unreadable until the one atomic release", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		expect(gate.state).toBe("generating");
		gate.stage({ text: plan(), expected: FULL }, "graph");
		expect(gate.release()).toMatchObject({ ok: false, reason: "not_ready" });
		const outcome = gate.complete();
		expect(outcome.state).toBe("ready");
		expect(gate.state).toBe("ready");
		const first = gate.release();
		expect(first).toMatchObject({ ok: true, state: "ready", text: plan() });
		expect(gate.released).toBe(true);
		expect(gate.release()).toMatchObject({ ok: false, reason: "already_released" });
	});

	test("legacy staged-only ready cannot beginExecution without a validated Plan", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.stage({ text: plan(), expected: FULL }, "graph");
		expect(gate.complete().state).toBe("ready");
		expect(gate.plan).toBeUndefined();
		expect(gate.beginExecution()).toBe(false);
		expect(gate.state).toBe("ready");
		expect(gate.transitions.at(-1)).toMatchObject({
			accepted: false,
			from: "ready",
			to: "executing",
		});
	});

	test("quarantine resets the one-shot release so a revived plan can release", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const first = gate.submitPlan(CHECKLIST_PLAN);
		expect(first).toBeDefined();
		expect(gate.release()).toMatchObject({ ok: true, state: "ready", text: first!.text });
		expect(gate.release()).toMatchObject({ ok: false, reason: "already_released" });
		expect(gate.submitPlan("plain text, no checklist")).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.released).toBe(false);
		const revived = gate.submitPlan(
			CHECKLIST_PLAN.replace("ship the plan gate", "ship the revived gate"),
		);
		expect(revived).toBeDefined();
		expect(gate.release()).toMatchObject({ ok: true, state: "ready", text: revived!.text });
		expect(gate.released).toBe(true);
	});

	test("generating -> validating -> ready is observable through the progress side channel", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const seen: GateProgress[] = [];
		const off = gate.onProgress((progress) => seen.push(progress));
		gate.touch("uplift");
		gate.stage({ text: plan(), expected: FULL }, "graph");
		gate.complete();
		off();
		gate.touch("ignored");
		expect(seen.map((progress) => `${progress.state}:${progress.label}`)).toEqual([
			"generating:uplift",
			"generating:graph",
			"validating:validating the plan",
			"ready:plan complete",
		]);
	});

	test("a throwing progress listener never breaks the gate", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.onProgress(() => {
			throw new Error("display only");
		});
		expect(gate.complete({ text: plan() }).state).toBe("ready");
	});

	test("a partial plan never releases, whatever the options", () => {
		const short = { text: plan({ nodes: 1 }), expected: FULL };
		for (const options of [
			{ inactivityMs: 0 },
			{ inactivityMs: 1_000, timers: fakeClock().timers },
		]) {
			const gate = new CompletionGate(options);
			expect(gate.complete(short).state).toBe("partial_failure");
			expect(gate.verdict?.problems.map((problem) => problem.code)).toContain("nodes_short");
			expect(gate.release()).toMatchObject({
				ok: false,
				reason: "not_ready",
				detail: expect.stringContaining("1 of 2 nodes"),
			});
			expect(gate.release()).toMatchObject({ ok: false, reason: "not_ready" });
			expect(gate.released).toBe(false);
		}
	});

	test("a pending row, a failed PRD or a degraded node never releases, whatever the options", () => {
		const failedPrd: TotManifest = {
			total: 1,
			generated: 0,
			failed: 1,
			fallbacks: 0,
			records: [
				{
					key: "n1.1",
					hash: "h",
					markdown: "m",
					status: "failed",
					model: "m",
					fallback: false,
					attempts: 1,
				},
			],
		};
		const cases = [
			{ artifacts: { text: plan({ pending: true }), expected: FULL }, code: "rows_pending" },
			{ artifacts: { text: plan(), expected: FULL, prd: failedPrd }, code: "prds_failed" },
			{
				artifacts: {
					text: plan().replace('<NODE id="n1"', '<NODE degraded="true" id="n1"'),
					expected: FULL,
				},
				code: "nodes_degraded",
			},
		];
		for (const options of [
			{ inactivityMs: 0 },
			{ inactivityMs: 1_000, timers: fakeClock().timers },
		]) {
			for (const { artifacts, code } of cases) {
				const gate = new CompletionGate(options);
				expect(gate.complete(artifacts).state).toBe("partial_failure");
				expect(gate.verdict?.problems.map((problem) => problem.code)).toContain(code);
				expect(gate.release()).toMatchObject({ ok: false, reason: "not_ready" });
				expect(gate.release()).toMatchObject({ ok: false, reason: "not_ready" });
				expect(gate.released).toBe(false);
			}
		}
	});

	test("truncated XML settles failed_or_cancelled and can never be released", async () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const cut = plan().slice(0, plan().indexOf("</BUILD_PROMPT>"));
		const outcome = gate.complete({ text: cut, expected: FULL });
		expect(outcome.state).toBe("failed_or_cancelled");
		expect(await gate.settled).toMatchObject({ state: "failed_or_cancelled" });
		expect(gate.release()).toMatchObject({ ok: false, reason: "failed" });
		expect(gate.reason).toContain("never closed");
	});

	test("complete with nothing staged fails; cancel drops staged content and settles once", async () => {
		const empty = new CompletionGate({ inactivityMs: 0 });
		expect(empty.complete().state).toBe("failed_or_cancelled");

		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.stage({ text: plan() });
		const cancelled = gate.cancel("superseded by a newer prompt");
		expect(cancelled).toMatchObject({
			state: "failed_or_cancelled",
			reason: "superseded by a newer prompt",
		});
		expect(await gate.settled).toEqual(cancelled);
		expect(gate.release()).toMatchObject({ ok: false, reason: "failed" });
		// A late planner result cannot revive a cancelled gate.
		expect(gate.complete({ text: plan() }).state).toBe("failed_or_cancelled");
		expect(gate.state).toBe("failed_or_cancelled");
		expect(gate.release()).toMatchObject({ ok: false, reason: "failed" });
	});

	test("a validator that throws fails the gate instead of rejecting", () => {
		const gate = new CompletionGate({
			inactivityMs: 0,
			validate: () => {
				throw new Error("boom");
			},
		});
		const outcome = gate.complete({ text: plan() });
		expect(outcome.state).toBe("failed_or_cancelled");
		expect(gate.reason).toContain("boom");
	});

	test("a finished gate ignores later fail and cancel", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.complete({ text: plan() });
		expect(gate.fail("late").state).toBe("ready");
		expect(gate.cancel("late").state).toBe("ready");
		expect(gate.release()).toMatchObject({ ok: true });
	});
});

describe("CompletionGate watchdog", () => {
	test("defaults to 30 minutes and fails loudly once, calling onStall", async () => {
		expect(DEFAULT_GATE_INACTIVITY_MS).toBe(30 * 60_000);
		const clock = fakeClock();
		const stalls: string[] = [];
		const gate = new CompletionGate({
			timers: clock.timers,
			onStall: (reason) => stalls.push(reason),
		});
		clock.advance(30 * 60_000 - 1);
		expect(gate.state).toBe("generating");
		clock.advance(1);
		expect(gate.state).toBe("failed_or_cancelled");
		expect(gate.stalled).toBe(true);
		expect(stalls).toEqual(["planning stalled: no progress for 30 min"]);
		expect(await gate.settled).toMatchObject({ state: "failed_or_cancelled", reason: stalls[0] });
		expect(gate.release()).toMatchObject({ ok: false, reason: "failed" });
		expect(clock.armed()).toBe(0);
	});

	test("a multi-minute run with steady progress never stalls; silence after it does", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({ timers: clock.timers, inactivityMs: 10 * 60_000 });
		// Two hours of planning, a touch every 9 minutes: always inside the window.
		for (let minute = 0; minute < 120; minute += 9) {
			clock.advance(9 * 60_000);
			expect(gate.state).toBe("generating");
			gate.touch();
		}
		gate.stage({ text: plan(), expected: FULL });
		clock.advance(9 * 60_000);
		expect(gate.state).toBe("generating");
		clock.advance(60_000);
		expect(gate.state).toBe("failed_or_cancelled");
		expect(gate.stalled).toBe(true);
	});

	test("completion disarms the watchdog", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({ timers: clock.timers, inactivityMs: 1_000 });
		expect(clock.armed()).toBe(1);
		gate.complete({ text: plan() });
		expect(clock.armed()).toBe(0);
		clock.advance(60_000);
		expect(gate.state).toBe("ready");
	});

	test("0 disables the watchdog: no timer is ever armed", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({ timers: clock.timers, inactivityMs: 0 });
		expect(clock.armed()).toBe(0);
		clock.advance(24 * 60 * 60_000);
		expect(gate.state).toBe("generating");
	});

	test("a failing onStall cannot leave the gate unsettled", async () => {
		const clock = fakeClock();
		const gate = new CompletionGate({
			timers: clock.timers,
			inactivityMs: 1_000,
			onStall: () => {
				throw new Error("display");
			},
		});
		clock.advance(1_000);
		expect(await gate.settled).toMatchObject({ state: "failed_or_cancelled" });
	});
});

const CHECKLIST_PLAN = plan().replace(
	"</BUILD_PROMPT>",
	`\nObjective: ship the plan gate. Scope: host only. Named surfaces: completion-gate.ts, omp.ts.
Acceptance: regression tests. Out-of-scope: other files. Dependencies: node:crypto only. Ordering: checklist first.
Linear SPE-35029 ROADMAP wave 1.
</BUILD_PROMPT>`,
);

describe("Plan gate (SPE-35029 design B)", () => {
	test("(1) missing Plan blocks execution, release and completion", () => {
		// Executing before plan_validated is rejected, with actor/from/to/reason logged.
		const early = new CompletionGate({ inactivityMs: 0 });
		expect(early.tryTransition("executing", "tester", "too early")).toBe(false);
		expect(early.transitions.at(-1)).toMatchObject({
			accepted: false,
			actor: "tester",
			to: "executing",
			reason: "too early",
		});

		const gate = new CompletionGate({ inactivityMs: 0 });
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.beginExecution()).toBe(false);
		expect(gate.completeExecution()).toBe(false);
		expect(gate.buildWorkerContexts(["w1"])).toBeUndefined();
		expect(gate.getExecutionContext()).toBeUndefined();
		expect(gate.release()).toMatchObject({ ok: false });
		expect(gate.transitions.find((t) => t.to === "executing")).toMatchObject({
			accepted: false,
			from: "waiting_for_plan",
		});
		for (const t of gate.transitions) {
			expect(typeof t.timestamp).toBe("number");
			expect(typeof t.actor).toBe("string");
			expect(t.from).toBeTruthy();
			expect(t.to).toBeTruthy();
		}
	});

	test("(2) invalid/stale Plan is rejected and quarantined", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		expect(gate.submitPlan(undefined)).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.submitPlan("plain text, no checklist")).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.plan).toBeUndefined();
		expect(gate.submitPlan(CHECKLIST_PLAN, { stale: true })).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.plan).toBeUndefined();
		expect(gate.beginExecution()).toBe(false);
	});

	test("(3) late valid Plan auto-resumes to ready; done requires validation", () => {
		let calls = 0;
		const gate = new CompletionGate({
			inactivityMs: 0,
			maxPollAttempts: 5,
			planProvider: () => (calls++ < 1 ? undefined : CHECKLIST_PLAN),
		});
		gate.enterWaitingForPlan();
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		const accepted = gate.pollOnce();
		expect(accepted).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.planHash).toBe(accepted!.planHash);
		// Done-before-validation is rejected; evidence recorded outside validating is ignored.
		expect(gate.beginExecution()).toBe(true);
		gate.recordValidationEvidence("too early");
		expect(gate.hasValidationEvidence).toBe(false);
		expect(gate.completeExecution()).toBe(false);
		expect(gate.beginValidation()).toBe(true);
		expect(gate.completeExecution()).toBe(false);
		gate.recordValidationEvidence("tests green");
		expect(gate.hasValidationEvidence).toBe(true);
		expect(gate.completeExecution()).toBe(true);
		expect(gate.state).toBe("complete");

		// Bounded polling blocks loudly after max attempts, never silent.
		const blocked = new CompletionGate({ inactivityMs: 0, maxPollAttempts: 2 });
		blocked.enterWaitingForPlan();
		blocked.pollOnce();
		blocked.pollOnce();
		expect(blocked.blocked).toBe(true);
		expect(blocked.blockReason).toContain("blocked");
		expect(blocked.state).toBe("waiting_for_plan");
	});

	test("(4) every worker receives the identical plan hash", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		const contexts = gate.buildWorkerContexts(["w1", "w2", "w3"]);
		expect(contexts).toHaveLength(3);
		expect(new Set(contexts!.map((c) => c.planHash)).size).toBe(1);
		expect(contexts?.at(0)?.planHash).toBe(accepted!.planHash);
		expect(contexts?.at(0)?.planId).toBe(accepted!.planId);
		expect(gate.getExecutionContext()).toMatchObject({
			planId: accepted!.planId,
			planHash: accepted!.planHash,
		});
		expect(gate.planRecord()).toContain(accepted!.planHash);
		expect(gate.release()).toMatchObject({
			ok: true,
			text: expect.stringContaining("Objective: ship the plan gate"),
		});
	});
});

describe("Plan gate review fixes (round 1)", () => {
	const CHECKLIST_PLAN_V2 = CHECKLIST_PLAN.replace(
		"ship the plan gate",
		"ship the replacement gate",
	);

	test("(1) a valid resubmission in ready/executing/validating keeps the original planHash", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.submitPlan(CHECKLIST_PLAN_V2)).toBeUndefined();
		expect(gate.state).toBe("ready");
		expect(gate.planHash).toBe(accepted!.planHash);
		expect(gate.beginExecution()).toBe(true);
		expect(gate.submitPlan(CHECKLIST_PLAN_V2)).toBeUndefined();
		expect(gate.state).toBe("executing");
		expect(gate.planHash).toBe(accepted!.planHash);
		expect(gate.beginValidation()).toBe(true);
		expect(gate.submitPlan(CHECKLIST_PLAN_V2)).toBeUndefined();
		expect(gate.state).toBe("validating");
		expect(gate.planHash).toBe(accepted!.planHash);
		expect(
			gate.transitions.filter((t) => t.to === "plan_validated" && !t.accepted).length,
		).toBeGreaterThan(0);
	});

	test("(2) an invalid candidate in ready/plan_validated quarantines to waiting and clears the prior plan", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		expect(gate.submitPlan(CHECKLIST_PLAN)).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.submitPlan("plain text, no checklist")).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.plan).toBeUndefined();
		expect(gate.planHash).toBeUndefined();
		expect(gate.buildWorkerContexts(["w1"])).toBeUndefined();
		expect(gate.getExecutionContext()).toBeUndefined();
		expect(gate.beginExecution()).toBe(false);
		expect(
			gate.transitions.find((t) => t.to === "waiting_for_plan" && t.from === "ready"),
		).toMatchObject({ accepted: true });
		// A late valid Plan is quarantined-in, then auto-resumes to ready with its own hash.
		const revived = gate.submitPlan(CHECKLIST_PLAN_V2);
		expect(revived).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.planHash).toBe(revived!.planHash);

		const validated = new CompletionGate({ inactivityMs: 0 });
		// No pending/validated plan record exists, so the public edge alone cannot enter
		// plan_validated (round 4); an invalid candidate then quarantines from generating.
		expect(validated.tryTransition("plan_validated")).toBe(false);
		expect(validated.state).toBe("generating");
		expect(validated.submitPlan("plain text, no checklist")).toBeUndefined();
		expect(validated.state).toBe("waiting_for_plan");
		expect(validated.plan).toBeUndefined();
	});

	test("(3) manual pollOnce and re-arming leave at most one poll timer", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({
			inactivityMs: 0,
			timers: clock.timers,
			pollIntervalMs: 1_000,
		});
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(clock.armed()).toBe(1);
		gate.pollOnce();
		expect(clock.armed()).toBe(1);
		gate.pollOnce();
		expect(clock.armed()).toBe(1);
		clock.advance(1_000);
		expect(gate.state).toBe("waiting_for_plan");
		expect(clock.armed()).toBe(1);
		// Re-entering waiting restarts polling without stacking a second handle.
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(clock.armed()).toBe(1);
	});

	test("(4) the checklist requires labeled non-empty values, SPE-<n> and ROADMAP wave/ordering", () => {
		expect(validatePlanChecklist(CHECKLIST_PLAN)).toEqual({ ok: true, problems: [] });
		// Bulleted and bold labels count as labeled values.
		const bulleted = CHECKLIST_PLAN.replace(
			"Objective: ship the plan gate.",
			"- **Objective:** ship the plan gate.",
		);
		expect(validatePlanChecklist(bulleted).problems).not.toContain("objective missing");
		// Bare keywords with no `Label:` lines do not count.
		const bare = plan().replace(
			"</BUILD_PROMPT>",
			"\nObjective scope named surfaces acceptance out-of-scope dependencies ordering SPE-123 ROADMAP wave 1\n</BUILD_PROMPT>",
		);
		const bareVerdict = validatePlanChecklist(bare);
		expect(bareVerdict.ok).toBe(false);
		expect(bareVerdict.problems).toContain("objective missing");
		expect(bareVerdict.problems).toContain("scope missing");
		expect(bareVerdict.problems).toContain("named surfaces missing");
		expect(bareVerdict.problems).toContain("acceptance missing");
		expect(bareVerdict.problems).toContain("out-of-scope missing");
		expect(bareVerdict.problems).toContain("dependencies missing");
		expect(bareVerdict.problems).toContain("ordering missing");
		// A label with an empty value does not count.
		const empty = CHECKLIST_PLAN.replace("Objective: ship the plan gate.", "Objective:");
		expect(validatePlanChecklist(empty).problems).toContain("objective missing");
		// A value on a later line does not satisfy a bare labeled line.
		const split = CHECKLIST_PLAN.replace(
			"Objective: ship the plan gate.",
			"Objective:\n\nAn unrelated line.",
		);
		expect(validatePlanChecklist(split).problems).toContain("objective missing");
		// An explicit SPE-<n> reference is required.
		expect(
			validatePlanChecklist(CHECKLIST_PLAN.replace("SPE-35029", "an issue")).problems,
		).toContain("referenced Linear issues missing");
		// ROADMAP alone, without a wave/ordering/consistency reference on its line, does not count.
		expect(
			validatePlanChecklist(CHECKLIST_PLAN.replace("ROADMAP wave 1", "ROADMAP")).problems,
		).toContain("ROADMAP consistency missing");
	});
});

describe("Plan gate review fixes (round 2)", () => {
	test("(1) staged+plan coexistence: validated #plan is the release authority", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.stage({ text: plan(), expected: FULL });
		expect(gate.complete().state).toBe("ready");
		// Quarantine then a late valid Plan leaves #staged/#verdict in place alongside #plan.
		expect(gate.enterWaitingForPlan()).toBe(true);
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.plan).toBeDefined();
		// #plan is the release authority when present, so record, release and workers all attribute it.
		expect(gate.planRecord()).toContain(accepted!.planId);
		expect(gate.planRecord()).toContain(accepted!.planHash);
		const contexts = gate.buildWorkerContexts(["w1", "w2"]);
		expect(contexts?.map((c) => c.planHash)).toEqual([accepted!.planHash, accepted!.planHash]);
		expect(gate.getExecutionContext()).toMatchObject({
			planId: accepted!.planId,
			planHash: accepted!.planHash,
			text: accepted!.text,
		});
		const released = gate.release();
		expect(released.ok).toBe(true);
		const releasedText = released.ok ? released.text : "";
		expect(releasedText).toBe(accepted!.text);
		expect(releasedText).not.toBe(plan());
		// `released.text` is the delivered text; re-hashing it must match the workers' hash.
		expect(planGateHash(releasedText)).toBe(accepted!.planHash);
		for (const ctx of contexts ?? []) expect(planGateHash(releasedText)).toBe(ctx.planHash);
		expect(gate.planRecord()).toContain(accepted!.planId);
		expect(gate.planRecord()).toContain(accepted!.planHash);
		expect(releasedText).not.toContain(gate.planRecord());
	});

	test("(2) a pure plan gate still records its plan id/hash", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(gate.planRecord()).toContain(accepted!.planId);
		expect(gate.planRecord()).toContain(accepted!.planHash);
		const released = gate.release();
		expect(released.ok).toBe(true);
		const releasedText = released.ok ? released.text : "";
		expect(releasedText).toContain("Objective: ship the plan gate");
		// `released.text` is the delivered text; re-hashing it must match the workers' hash.
		expect(planGateHash(releasedText)).toBe(accepted!.planHash);
		expect(gate.planRecord()).toContain(accepted!.planId);
		expect(gate.planRecord()).toContain(accepted!.planHash);
		expect(releasedText).not.toContain(gate.planRecord());
	});
});
describe("Plan gate review fixes (round 3)", () => {
	test("(1) hardened table: ready cannot beginValidation, validating cannot go ready, generating cannot jump to validating, no skip to plan_validated", () => {
		// ready must pass through executing before validating.
		const ready = new CompletionGate({ inactivityMs: 0 });
		expect(ready.submitPlan(CHECKLIST_PLAN)).toBeDefined();
		expect(ready.state).toBe("ready");
		expect(ready.beginValidation()).toBe(false);
		expect(ready.state).toBe("ready");
		expect(ready.transitions.at(-1)).toMatchObject({
			accepted: false,
			from: "ready",
			to: "validating",
		});

		// generating (legacy entry) cannot jump straight to validating; legacy complete() bypasses the
		// table by direct assignment and is covered elsewhere.
		const generating = new CompletionGate({ inactivityMs: 0 });
		expect(generating.state).toBe("generating");
		expect(generating.tryTransition("validating")).toBe(false);
		expect(generating.state).toBe("generating");

		// validating cannot go back to ready.
		const validating = new CompletionGate({ inactivityMs: 0 });
		expect(validating.submitPlan(CHECKLIST_PLAN)).toBeDefined();
		expect(validating.beginExecution()).toBe(true);
		expect(validating.beginValidation()).toBe(true);
		expect(validating.tryTransition("ready")).toBe(false);
		expect(validating.state).toBe("validating");

		// discovering/discussing/planning cannot skip to plan_validated; they must walk the chain.
		const chains: readonly (readonly GateState[])[] = [
			["discovering"],
			["discovering", "discussing"],
			["discovering", "discussing", "planning"],
		];
		for (const path of chains) {
			const gate = new CompletionGate({ inactivityMs: 0 });
			for (const step of path) expect(gate.tryTransition(step)).toBe(true);
			const last = path.at(-1)!;
			expect(gate.state).toBe(last);
			expect(gate.tryTransition("plan_validated")).toBe(false);
			expect(gate.state).toBe(last);
		}
	});

	test("(2) entering executing/validating clears prior-cycle validation evidence", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		expect(gate.submitPlan(CHECKLIST_PLAN)).toBeDefined();
		expect(gate.beginExecution()).toBe(true);
		expect(gate.beginValidation()).toBe(true);
		gate.recordValidationEvidence("first cycle green");
		expect(gate.hasValidationEvidence).toBe(true);
		// Side-step to partial_failure, quarantine back to waiting, then a late valid Plan revives to ready.
		expect(gate.tryTransition("partial_failure")).toBe(true);
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(gate.submitPlan(CHECKLIST_PLAN)).toBeDefined();
		expect(gate.state).toBe("ready");
		// New cycle: executing clears the first cycle's evidence, so complete is rejected until
		// fresh evidence is recorded in this cycle's validating.
		expect(gate.beginExecution()).toBe(true);
		expect(gate.hasValidationEvidence).toBe(false);
		expect(gate.beginValidation()).toBe(true);
		expect(gate.hasValidationEvidence).toBe(false);
		expect(gate.completeExecution()).toBe(false);
		gate.recordValidationEvidence("second cycle green");
		expect(gate.completeExecution()).toBe(true);
		expect(gate.state).toBe("complete");
	});
});

describe("Plan gate review fixes (round 4)", () => {
	test("(1) direct bypass cannot reach executing without a validated Plan", () => {
		expect(planGateAllowed("generating").has("plan_validated")).toBe(false);

		const gate = new CompletionGate({ inactivityMs: 0 });
		expect(gate.tryTransition("plan_validated")).toBe(false);
		expect(gate.tryTransition("ready")).toBe(false);
		expect(gate.beginExecution()).toBe(false);
		expect(gate.state).toBe("generating");
		expect(gate.plan).toBeUndefined();

		const waiting = new CompletionGate({ inactivityMs: 0 });
		expect(waiting.enterWaitingForPlan()).toBe(true);
		expect(waiting.tryTransition("plan_validated")).toBe(false);
		expect(waiting.tryTransition("ready")).toBe(false);
		expect(waiting.beginExecution()).toBe(false);
		expect(waiting.state).toBe("waiting_for_plan");
		expect(waiting.plan).toBeUndefined();

		// A valid submitted plan from generating still gets through, via waiting_for_plan.
		const submitted = new CompletionGate({ inactivityMs: 0 });
		expect(submitted.submitPlan(CHECKLIST_PLAN)).toBeDefined();
		expect(submitted.state).toBe("ready");
		expect(submitted.plan).toBeDefined();
		expect(submitted.transitions.map((t) => `${t.from}->${t.to}:${t.accepted}`)).toEqual([
			"generating->waiting_for_plan:true",
			"waiting_for_plan->plan_validated:true",
			"plan_validated->ready:true",
		]);
	});

	test("(2) a throwing planProvider blocks loudly and stays waiting, never silent", () => {
		const progress: GateProgress[] = [];
		const gate = new CompletionGate({
			inactivityMs: 0,
			maxPollAttempts: 5,
			planProvider: () => {
				throw new Error("boom-provider");
			},
		});
		gate.onProgress((p) => progress.push(p));
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.blocked).toBe(true);
		expect(gate.blockReason).toContain("boom-provider");
		expect(progress.some((p) => p.label)).toBe(true);
		expect(progress.at(-1)).toMatchObject({ state: "waiting_for_plan" });
		expect(progress.at(-1)!.label).toContain("boom-provider");
	});

	test("(3) ROADMAP scan requires every ROADMAP line to carry the token", () => {
		// A bare ROADMAP line anywhere fails, even if another ROADMAP line is qualified.
		const mixed = CHECKLIST_PLAN.replace("ROADMAP wave 1.", "ROADMAP\nROADMAP wave 1.");
		expect(validatePlanChecklist(mixed).problems).toContain("ROADMAP consistency missing");
		// Lowercase roadmap mentions count too.
		const lowerBare = CHECKLIST_PLAN.replace("ROADMAP wave 1.", "roadmap\nROADMAP wave 1.");
		expect(validatePlanChecklist(lowerBare).problems).toContain("ROADMAP consistency missing");
		// No qualified ROADMAP line anywhere still fails.
		expect(
			validatePlanChecklist(CHECKLIST_PLAN.replace("ROADMAP wave 1", "ROADMAP")).problems,
		).toContain("ROADMAP consistency missing");
	});
});

describe("Plan gate review fixes (round 5)", () => {
	test("(1) released text re-hashes to the exact planHash every worker receives (staged+plan)", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.stage({ text: plan(), expected: FULL });
		expect(gate.complete().state).toBe("ready");
		expect(gate.enterWaitingForPlan()).toBe(true);
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		const contextsBefore = gate.buildWorkerContexts(["w1", "w2", "w3"]);
		const released = gate.release();
		expect(released.ok).toBe(true);
		const releasedText = released.ok ? released.text : "";
		// The invariant: re-hashing the released text yields the hash workers were given.
		expect(planGateHash(releasedText)).toBe(accepted!.planHash);
		expect(planGateHash(releasedText)).toBe(gate.planHash!);
		for (const ctx of contextsBefore!) expect(planGateHash(releasedText)).toBe(ctx.planHash);
		const contextsAfter = gate.buildWorkerContexts(["w1", "w2", "w3"]);
		for (const ctx of contextsAfter!) expect(planGateHash(releasedText)).toBe(ctx.planHash);
		expect(gate.getExecutionContext()).toMatchObject({
			planHash: planGateHash(releasedText),
			text: releasedText,
		});
		expect(gate.planRecord()).toContain(planGateHash(releasedText));
		expect(releasedText).toBe(accepted!.text);
		// The delivered text is `released.text` itself; no record is appended to it.
		expect(releasedText).not.toContain(gate.planRecord());
	});

	test("(2) legacy staged-only release is unchanged: staged text, no record, no plan contexts", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		gate.stage({ text: plan(), expected: FULL });
		expect(gate.complete().state).toBe("ready");
		expect(gate.plan).toBeUndefined();
		expect(gate.buildWorkerContexts(["w1"])).toBeUndefined();
		expect(gate.getExecutionContext()).toBeUndefined();
		expect(gate.planRecord()).toBe("");
		const released = gate.release();
		expect(released.ok).toBe(true);
		expect(released.ok ? released.text : "").toBe(plan());
		expect(gate.planRecord()).toBe("");
	});
});
describe("Plan gate review fixes (round 6)", () => {
	test("(1) released text re-hashes to planHash even with a plan record (no append breaks planHash)", () => {
		const gate = new CompletionGate({ inactivityMs: 0 });
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		const contexts = gate.buildWorkerContexts(["w1"]);
		const released = gate.release();
		expect(released.ok).toBe(true);
		const releasedText = released.ok ? released.text : "";
		// Record is non-empty here, so the old `${text}\n\n${record}` composition would re-hash differently.
		expect(gate.planRecord()).not.toBe("");
		expect(planGateHash(releasedText)).toBe(accepted!.planHash);
		for (const ctx of contexts!) expect(planGateHash(releasedText)).toBe(ctx.planHash);
		expect(gate.planRecord()).toContain(planGateHash(releasedText));
		expect(releasedText).not.toContain(gate.planRecord());
	});
});
describe("Plan gate review fixes (round 7)", () => {
	test("(1) tryTransition waiting_for_plan from ready quarantines the stale plan and starts polling", () => {
		const clock = fakeClock();
		let calls = 0;
		const gate = new CompletionGate({
			inactivityMs: 0,
			timers: clock.timers,
			pollIntervalMs: 1_000,
			maxPollAttempts: 3,
			planProvider: () => (calls++ < 1 ? undefined : CHECKLIST_PLAN),
		});
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.planHash).toBe(accepted!.planHash);
		// The raw public edge (not enterWaitingForPlan) must quarantine identically.
		expect(gate.tryTransition("waiting_for_plan", "tester", "quarantine from ready")).toBe(true);
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.transitions.at(-1)).toMatchObject({
			accepted: true,
			from: "ready",
			to: "waiting_for_plan",
		});
		expect(gate.plan).toBeUndefined();
		expect(gate.planHash).toBeUndefined();
		expect(gate.planId).toBeUndefined();
		expect(gate.planRecord()).toBe("");
		expect(gate.buildWorkerContexts(["w1"])).toBeUndefined();
		expect(gate.getExecutionContext()).toBeUndefined();
		expect(gate.release()).toMatchObject({ ok: false });
		// Polling started with a fresh budget: exactly one timer, no attempts consumed yet.
		expect(clock.armed()).toBe(1);
		expect(gate.pollAttempts).toBe(0);
		expect(gate.blocked).toBe(false);
		// The stale plan cannot re-enter: neither guard may accept it.
		expect(gate.tryTransition("plan_validated", "tester", "stale bypass")).toBe(false);
		expect(gate.tryTransition("ready", "tester", "stale bypass")).toBe(false);
		expect(gate.beginExecution()).toBe(false);
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.plan).toBeUndefined();
		// A late valid Plan still auto-resumes through polling (fresh budget of 3).
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		const revived = gate.pollOnce();
		expect(revived).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.planHash).toBe(revived!.planHash);
		expect(clock.armed()).toBe(0);
	});

	test("(2) waiting self-transition preserves the in-flight poll budget", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({
			inactivityMs: 0,
			timers: clock.timers,
			pollIntervalMs: 1_000,
			maxPollAttempts: 2,
		});
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.pollAttempts).toBe(1);
		// Re-quarantining while already waiting (the invalid-candidate self path)
		// must not reset the budget, or bounded polling could never block.
		expect(gate.submitPlan("plain text, no checklist")).toBeUndefined();
		expect(gate.state).toBe("waiting_for_plan");
		expect(gate.pollAttempts).toBe(1);
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.pollAttempts).toBe(2);
		expect(gate.blocked).toBe(true);
		expect(gate.blockReason).toContain("blocked");
	});
});
describe("Plan gate review fixes (round 9)", () => {
	test("(1) blocked gate clears blocked/blockReason when a valid plan leaves waiting_for_plan", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({
			inactivityMs: 0,
			timers: clock.timers,
			pollIntervalMs: 1_000,
			maxPollAttempts: 2,
		});
		expect(gate.enterWaitingForPlan()).toBe(true);
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.pollOnce()).toBeUndefined();
		expect(gate.blocked).toBe(true);
		expect(gate.blockReason).toContain("blocked");
		expect(clock.armed()).toBe(0);
		const accepted = gate.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(gate.state).toBe("ready");
		expect(gate.blocked).toBe(false);
		expect(gate.blockReason).toBe("");
		expect(clock.armed()).toBe(0);
	});

	test("(2) valid candidate rejected by state emits a progress notification naming rejection and current state", () => {
		const clock = fakeClock();
		const gate = new CompletionGate({ inactivityMs: 0, timers: clock.timers });
		const first = gate.submitPlan(CHECKLIST_PLAN);
		expect(first).toBeDefined();
		expect(gate.state).toBe("ready");
		const progress: GateProgress[] = [];
		gate.onProgress((entry) => progress.push(entry));
		const rejected = gate.submitPlan(CHECKLIST_PLAN, { version: "2" });
		expect(rejected).toBeUndefined();
		expect(gate.state).toBe("ready");
		expect(gate.planHash).toBe(first!.planHash);
		expect(
			progress.some(
				(entry) =>
					entry.label.includes("rejected") &&
					entry.label.includes("plan_validated") &&
					entry.label.includes("ready"),
			),
		).toBe(true);
		expect(progress.some((entry) => entry.state === "ready")).toBe(true);
	});
});
describe("Plan gate review fixes (round 10)", () => {
	const REPLACEMENT_PLAN = CHECKLIST_PLAN.replace(
		"ship the plan gate",
		"ship the replacement gate",
	);

	test("(1) valid candidates revive from partial_failure and planning through waiting_for_plan to ready", () => {
		const partial = new CompletionGate({ inactivityMs: 0 });
		const first = partial.submitPlan(CHECKLIST_PLAN);
		expect(first).toBeDefined();
		expect(partial.beginExecution()).toBe(true);
		expect(partial.beginValidation()).toBe(true);
		expect(partial.tryTransition("partial_failure")).toBe(true);
		const revived = partial.submitPlan(REPLACEMENT_PLAN);
		expect(revived).toBeDefined();
		expect(partial.state).toBe("ready");
		expect(partial.planHash).toBe(revived!.planHash);
		expect(partial.planHash).not.toBe(first!.planHash);
		expect(partial.transitions.map((t) => `${t.from}->${t.to}:${t.accepted}`).slice(-3)).toEqual([
			"partial_failure->waiting_for_plan:true",
			"waiting_for_plan->plan_validated:true",
			"plan_validated->ready:true",
		]);

		const planning = new CompletionGate({ inactivityMs: 0 });
		expect(planning.tryTransition("discovering")).toBe(true);
		expect(planning.tryTransition("discussing")).toBe(true);
		expect(planning.tryTransition("planning")).toBe(true);
		const accepted = planning.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(planning.state).toBe("ready");
		expect(planning.planHash).toBe(accepted!.planHash);
		expect(planning.transitions.map((t) => `${t.from}->${t.to}:${t.accepted}`).slice(-3)).toEqual([
			"planning->waiting_for_plan:true",
			"waiting_for_plan->plan_validated:true",
			"plan_validated->ready:true",
		]);
	});

	test("(2) valid candidates revive from discovering and discussing by walking the forward chain to ready", () => {
		const discovering = new CompletionGate({ inactivityMs: 0 });
		expect(discovering.tryTransition("discovering")).toBe(true);
		const accepted = discovering.submitPlan(CHECKLIST_PLAN);
		expect(accepted).toBeDefined();
		expect(discovering.state).toBe("ready");
		expect(discovering.planHash).toBe(accepted!.planHash);
		expect(
			discovering.transitions.map((t) => `${t.from}->${t.to}:${t.accepted}`).slice(-5),
		).toEqual([
			"discovering->discussing:true",
			"discussing->planning:true",
			"planning->waiting_for_plan:true",
			"waiting_for_plan->plan_validated:true",
			"plan_validated->ready:true",
		]);

		const discussing = new CompletionGate({ inactivityMs: 0 });
		expect(discussing.tryTransition("discovering")).toBe(true);
		expect(discussing.tryTransition("discussing")).toBe(true);
		const revived = discussing.submitPlan(REPLACEMENT_PLAN);
		expect(revived).toBeDefined();
		expect(discussing.state).toBe("ready");
		expect(discussing.planHash).toBe(revived!.planHash);
		expect(discussing.transitions.map((t) => `${t.from}->${t.to}:${t.accepted}`).slice(-4)).toEqual(
			[
				"discussing->planning:true",
				"planning->waiting_for_plan:true",
				"waiting_for_plan->plan_validated:true",
				"plan_validated->ready:true",
			],
		);
	});

	test("(3) ready/executing/validating/complete/failed still reject replacement plans loudly and keep the original", () => {
		const setup = (
			target: GateState,
		): { gate: CompletionGate; hash: string | undefined; progress: GateProgress[] } => {
			const gate = new CompletionGate({ inactivityMs: 0 });
			const first = gate.submitPlan(CHECKLIST_PLAN);
			expect(first).toBeDefined();
			if (target === "executing" || target === "validating" || target === "complete")
				expect(gate.beginExecution()).toBe(true);
			if (target === "validating" || target === "complete")
				expect(gate.beginValidation()).toBe(true);
			if (target === "complete") {
				gate.recordValidationEvidence("tests green");
				expect(gate.completeExecution()).toBe(true);
			}
			const progress: GateProgress[] = [];
			gate.onProgress((entry) => progress.push(entry));
			return { gate, hash: gate.planHash, progress };
		};
		for (const target of ["ready", "executing", "validating", "complete"] as const) {
			const { gate, hash, progress } = setup(target);
			expect(gate.state).toBe(target);
			expect(gate.submitPlan(REPLACEMENT_PLAN)).toBeUndefined();
			expect(gate.state).toBe(target);
			expect(gate.planHash).toBe(hash);
			expect(gate.transitions.at(-1)).toMatchObject({
				accepted: false,
				from: target,
				to: "plan_validated",
			});
			expect(
				progress.some(
					(entry) =>
						entry.label.includes("rejected") &&
						entry.label.includes("plan_validated") &&
						entry.label.includes(target),
				),
			).toBe(true);
		}

		const failed = new CompletionGate({ inactivityMs: 0 });
		expect(failed.tryTransition("failed_or_cancelled")).toBe(true);
		const progress: GateProgress[] = [];
		failed.onProgress((entry) => progress.push(entry));
		expect(failed.submitPlan(CHECKLIST_PLAN)).toBeUndefined();
		expect(failed.state).toBe("failed_or_cancelled");
		expect(failed.plan).toBeUndefined();
		expect(failed.transitions.at(-1)).toMatchObject({
			accepted: false,
			from: "failed_or_cancelled",
			to: "plan_validated",
		});
		expect(
			progress.some(
				(entry) =>
					entry.label.includes("rejected") &&
					entry.label.includes("plan_validated") &&
					entry.label.includes("failed_or_cancelled"),
			),
		).toBe(true);
	});
});

describe("Tracker-side PRD presence gate (SPE-35424)", () => {
	const generated = {
		total: 1,
		generated: 1,
		failed: 0,
		fallbacks: 0,
		records: [
			{
				key: "n1.1",
				hash: "h",
				markdown: "# PRD",
				status: "generated",
				model: "m",
				fallback: false,
				attempts: 1,
			},
		],
	} as const;
	const synced = { total: 1, synced: 1, pending: 0, failed: 0 };

	test("local-generated-but-tracker-missing holds, even when the sync summary says delivered", () => {
		const verdict = validateArtifacts({
			text: plan(),
			expected: { nodes: 2, issues: 2, subIssues: 4, prds: 1 },
			prd: generated,
			prdSync: synced,
			prdPresence: { missingLinear: ["n1.1"], missingNotion: ["n1.1"] },
		});
		expect(verdict.state).toBe("partial_failure");
		expect(verdict.observed.prdsMissingInTrackers).toBe(1);
		expect(verdict.problems).toContainEqual({
			severity: "partial",
			code: "prds_not_in_trackers",
			detail: "PRD text not present in tracker rows (Linear: n1.1; Notion: n1.1)",
		});
	});

	test("present in both trackers proceeds", () => {
		const verdict = validateArtifacts({
			text: plan(),
			expected: { nodes: 2, issues: 2, subIssues: 4, prds: 1 },
			prd: generated,
			prdSync: synced,
			prdPresence: { missingLinear: [], missingNotion: [] },
		});
		expect(verdict.state).toBe("ready");
		expect(verdict.observed.prdsMissingInTrackers).toBe(0);
	});

	test("missing in only one tracker still holds", () => {
		const verdict = validateArtifacts({
			text: plan(),
			expected: { nodes: 2, issues: 2, subIssues: 4, prds: 1 },
			prd: generated,
			prdSync: synced,
			prdPresence: { missingNotion: ["n1.1"] },
		});
		expect(verdict.state).toBe("partial_failure");
		expect(verdict.problems.map((problem) => problem.code)).toContain("prds_not_in_trackers");
	});
});
