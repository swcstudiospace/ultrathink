// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { TotManifest } from "../think/tot/types.ts";
import {
	CompletionGate,
	DEFAULT_GATE_INACTIVITY_MS,
	type GateProgress,
	type GateTimers,
	validateArtifacts,
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

	test("an unread project review is fatal even when every PRD was generated", () => {
		const prd: TotManifest = {
			total: 1,
			generated: 1,
			failed: 0,
			fallbacks: 0,
			review: "unread",
			records: [
				{
					key: "n1.1",
					hash: "h",
					markdown: "m",
					status: "generated",
					model: "m",
					fallback: false,
					attempts: 1,
				},
			],
		};
		const verdict = validateArtifacts({ text: plan(), prd });
		expect(verdict.state).toBe("failed_or_cancelled");
		expect(verdict.problems).toContainEqual(
			expect.objectContaining({ severity: "fatal", code: "review_unread" }),
		);
		const read = validateArtifacts({ text: plan(), prd: { ...prd, review: "read" } });
		expect(read.problems.map((problem) => problem.code)).not.toContain("review_unread");
	});

	test("truncated XML stays fatal when the review is also unread", () => {
		const cut = plan().slice(0, plan().indexOf("</BUILD_PROMPT>"));
		const verdict = validateArtifacts({
			text: cut,
			prd: { total: 0, generated: 0, failed: 0, fallbacks: 0, review: "unread", records: [] },
		});
		expect(verdict.state).toBe("failed_or_cancelled");
		expect(verdict.problems.map((problem) => problem.code)).toEqual(
			expect.arrayContaining(["truncated", "review_unread"]),
		);
	});

	test("plain text with no spec structure has nothing to count and is ready", () => {
		expect(validateArtifacts({ text: "PLAN", expected: FULL }).state).toBe("ready");
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

	test("a partial plan blocks release until it is confirmed or partial sync is allowed", () => {
		const blocked = new CompletionGate({ inactivityMs: 0 });
		blocked.complete({ text: plan({ nodes: 1 }), expected: FULL });
		expect(blocked.state).toBe("partial_failure");
		const refused = blocked.release();
		expect(refused).toMatchObject({ ok: false, reason: "needs_confirmation" });
		expect(blocked.released).toBe(false);
		expect(blocked.release({ confirmPartial: true })).toMatchObject({
			ok: true,
			state: "partial_failure",
		});

		const allowed = new CompletionGate({ inactivityMs: 0, allowPartialSync: true });
		allowed.complete({ text: plan({ nodes: 1 }), expected: FULL });
		expect(allowed.release()).toMatchObject({ ok: true, state: "partial_failure" });
	});

	test("truncated XML settles failed_or_cancelled and can never be released, even when confirmed", async () => {
		const gate = new CompletionGate({ inactivityMs: 0, allowPartialSync: true });
		const cut = plan().slice(0, plan().indexOf("</BUILD_PROMPT>"));
		const outcome = gate.complete({ text: cut, expected: FULL });
		expect(outcome.state).toBe("failed_or_cancelled");
		expect(await gate.settled).toMatchObject({ state: "failed_or_cancelled" });
		expect(gate.release({ confirmPartial: true })).toMatchObject({ ok: false, reason: "failed" });
		expect(gate.reason).toContain("never closed");
	});

	test("an unread review stays failed even when confirmed and partial sync is allowed", () => {
		const gate = new CompletionGate({ inactivityMs: 0, allowPartialSync: true });
		const prd: TotManifest = {
			total: 1,
			generated: 1,
			failed: 0,
			fallbacks: 0,
			review: "unread",
			records: [
				{
					key: "n1.1",
					hash: "h",
					markdown: "m",
					status: "generated",
					model: "m",
					fallback: false,
					attempts: 1,
				},
			],
		};
		const outcome = gate.complete({ text: plan(), prd });
		expect(outcome.state).toBe("failed_or_cancelled");
		expect(gate.release({ confirmPartial: true })).toMatchObject({ ok: false, reason: "failed" });
		expect(gate.released).toBe(false);
		expect(gate.reason).toContain("not read");
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
