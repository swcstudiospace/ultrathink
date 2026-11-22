// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Tree-of-Thought stage through the whole hook and the CompletionGate, on a fake host: 50 Sub Issues, a generation
 * failure at the 37th, a gate that does not release, a rerun that keeps what was written and reaches `ready`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { CompletionGate } from "../host/completion-gate.ts";
import { graphJson, UPLIFT } from "../test.helpers.ts";
import type { PrdOutcome, TotSeams } from "../think/tot/stage.ts";
import type { ToolCaller } from "../track/create.ts";
import type { Tracker } from "../track/gateway.ts";
import { prdPresenceHoldReason, totHoldReason, verifyPrdPresence } from "./hook-tot.ts";
import type { IssueRef, TrackingRefs, TrackPlan } from "../track/types.ts";
import type { ClaudeCompleter } from "./complete.ts";
import {
	type HookDeps,
	type PromptSubmitInput,
	type PromptSubmitResult,
	runPromptSubmit,
} from "./hook.ts";

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(homedir(), prefix));
	made.push(dir);
	return dir;
}

const NODES = 8;
/** Two nodes carry 7 steps and six carry 6: 50 Sub Issues in all. */
const stepsOf = (id: string): number => (id === "n1" || id === "n2" ? 7 : 6);

function planner(): (system: string, user: string) => Promise<string> {
	return async (_system, user) => {
		if (user.includes("<user_request>")) return UPLIFT("add a widget");
		if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const steps = Array.from({ length: stepsOf(id) }, (_, i) => `${i + 1}. ${id} step ${i + 1}`);
			return `<node><rationale>${steps.join(" ")}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		// An edge-free plan cannot be made from the graph this returns: normalizeGraph re-adds the
		// synthesis fan-in (the last node ends up depending on every leaf) after the graph is built,
		// so the strip this scenario needs lands on the stage-facing plan in the tracker below
		// instead. Here the graph only has to parse to eight nodes with distinct ids.
		return graphJson(NODES);
	};
}

function refsFor(plan: TrackPlan): TrackingRefs {
	const ref = (id: string): IssueRef => ({
		id: `uuid-${id}`,
		identifier: `ENG-${id.replace(".", "-")}`,
		url: `https://linear.app/o/issue/${id}`,
		title: id,
	});
	const nodes: Record<string, IssueRef> = {};
	const steps: Record<string, IssueRef> = {};
	for (const issue of plan.issues) nodes[issue.nodeId] = ref(issue.nodeId);
	for (const sub of plan.subIssues)
		steps[`${sub.nodeId}.${sub.step}`] = ref(`${sub.nodeId}.${sub.step}`);
	return {
		graphId: plan.graphId,
		status: "complete",
		linearTeam: "Team",
		linear: { nodes, steps },
		notion: { nodes: {}, steps: {} },
		errors: [],
		updatedAt: 1_000,
	};
}

interface FakeLinear {
	readonly caller: ToolCaller;
	readonly descriptions: Map<string, string>;
	saves: number;
}

/** A Linear that keeps one description per issue id (the identifier the sync addresses it by). */
function fakeLinear(): FakeLinear {
	const descriptions = new Map<string, string>();
	const fake: FakeLinear = {
		descriptions,
		saves: 0,
		caller: {
			async call(name, args) {
				const id = String(args.id);
				if (name === "get_issue")
					return {
						id,
						description: descriptions.get(id) ?? "",
						url: `https://linear.app/o/issue/${id}`,
					};
				if (name === "save_issue") {
					fake.saves++;
					descriptions.set(id, String(args.description));
					return { id };
				}
				throw new Error(`unexpected ${name}`);
			},
		},
	};
	return fake;
}

const DRAFT = JSON.stringify({
	objective: "Wire the runner.",
	acceptanceCriteria: ["It runs"],
	affectedFiles: [{ path: "src/app.ts" }],
	interfaces: ["function runApp(): void"],
	implementation: [{ language: "ts", code: "runApp();" }],
	testSkeleton: { language: "ts", code: "test('x', () => {});" },
	assumptions: [],
});

interface World {
	readonly deps: HookDeps;
	readonly linear: FakeLinear;
	/** Keys the PRD model was asked for, per call. */
	readonly asked: string[];
	failKey: string | undefined;
	/** Once true the PRD model stops failing (the retry). */
	healed: boolean;
}

function world(
	overrides: { config?: (config: UltrathinkConfig) => void; tot?: false } = {},
): World {
	const stateDir = join(makeDir("ut-hook-tot-"), "ultrathink");
	const config = defaultConfig();
	config.linear.team = "Team";
	overrides.config?.(config);
	const linear = fakeLinear();
	const asked: string[] = [];
	const state: World = {
		deps: undefined as unknown as HookDeps,
		linear,
		asked,
		failKey: undefined,
		healed: false,
	};
	const tracker: Tracker = async ({ plan }) => {
		// This scenario needs one isolated failure with the other 49 PRDs placed, so the plan the
		// stage reads is edge-free. The planner's strip cannot deliver that: normalizeGraph re-adds
		// the synthesis fan-in after the graph is built, and the tracker's plan is the object the
		// hook later hands to the ToT stage, so the strip lands here. Without it the last node's
		// PRDs are held behind the failed 37th instead of the failure staying isolated.
		delete plan.dependencies;
		// The 37th Sub Issue is the one whose PRD fails to generate.
		state.failKey ??= (() => {
			const sub = plan.subIssues[36];
			return sub ? `${sub.nodeId}.${sub.step}` : undefined;
		})();
		return refsFor(plan);
	};
	const tot: TotSeams = {
		open: () => ({ linear: linear.caller }),
		retry: { maxAttempts: 1, baseMs: 1, capMs: 1 },
		retrySeams: { sleep: async () => undefined },
		sync: { sleep: async () => undefined, retryPolicy: { maxAttempts: 1, baseMs: 1, capMs: 1 } },
	};
	const planCall = planner();
	const complete: ClaudeCompleter = async (system, user) => {
		if (!user.includes("<SUB_ISSUE key=")) return planCall(system, user);
		const key = user.match(/<SUB_ISSUE key="([^"]+)"/)?.[1] ?? "?";
		asked.push(key);
		if (key === state.failKey && !state.healed) throw new Error("simulated generation failure");
		return DRAFT;
	};

	const deps: HookDeps = {
		config,
		control: {},
		complete,
		engine: "claude:claude-haiku-5-5",
		stateDir,
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => ({ text: "", state: "none" }),
		realmProbe: async () => ({ kind: "absent" }),
		emit: async () => true,
		now: () => 1_000,
		log: () => undefined,
		decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
		track: tracker,
		...(overrides.tot === false ? {} : { tot }),
	};
	return Object.assign(state, { deps });
}

const input: PromptSubmitInput = { session_id: "s1", cwd: "/repo", prompt: "add a widget" };

function gateFor(context: string, prd: PrdOutcome): CompletionGate {
	const gate = new CompletionGate({ inactivityMs: 0 });
	gate.complete({
		text: context,
		expected: { nodes: NODES, issues: NODES, subIssues: 50, prds: prd.manifest.total },
		prd: prd.manifest,
		prdSync: prd.sync,
	});
	return gate;
}

function contextOf(result: PromptSubmitResult): string {
	return result.output?.hookSpecificOutput.additionalContext ?? "";
}

describe("Tree-of-Thought stage through the hook and the gate", () => {
	test("50 Sub Issues, a failure at the 37th: partial_failure, no release; the rerun keeps the rest and reaches ready", async () => {
		const w = world();
		const first = await runPromptSubmit(input, w.deps);
		expect(w.failKey).toBe("n6.5");
		const prd = first.prd;
		if (!prd) throw new Error("the stage did not run");
		expect(prd.manifest).toMatchObject({ total: 50, generated: 49, failed: 1 });
		expect(prd.sync).toEqual({ total: 50, synced: 49, pending: 0, failed: 1 });
		// Every PRD but the failed one is in its Sub Issue; the first 36 were not lost to the failure.
		expect(w.linear.descriptions.size).toBe(49);
		const plan = first.record?.plan;
		const order = (plan?.subIssues ?? []).map((sub) => `ENG-${sub.nodeId}-${sub.step}`);
		for (const id of order.slice(0, 36)) expect(w.linear.descriptions.get(id)).toContain("## PRD");
		expect(w.linear.descriptions.has("ENG-n6-5")).toBe(false);

		// The XML carries the counts, the row links and each generated PRD inside its own Sub Issue.
		const context = contextOf(first);
		expect(context).toContain('<PRDS total="50" generated="49" failed="1"');
		expect(context).toContain('url="https://linear.app/o/issue/n6.5"');
		expect(context.split('<PRD key="').length - 1).toBe(49);
		expect(context).toContain("runApp");

		const gate = gateFor(context, prd);
		expect(gate.state).toBe("partial_failure");
		expect(gate.release()).toMatchObject({ ok: false, reason: "not_ready" });
		expect(gate.released).toBe(false);

		// Retry: the checkpoints hold PRDs 1-36 (and the rest); only the failed one is written again.
		expect(readdirSync(join(w.deps.stateDir, "tot", plan?.graphId ?? "")).length).toBe(50);
		const before = w.asked.length;
		w.healed = true;
		const savesBefore = w.linear.saves;
		const second = await runPromptSubmit(input, w.deps);
		expect(w.asked.slice(before)).toEqual(["n6.5"]);
		expect(w.linear.saves - savesBefore).toBe(1);
		const retried = second.prd;
		if (!retried) throw new Error("the stage did not run on the retry");
		expect(retried.manifest).toMatchObject({ total: 50, generated: 50, failed: 0 });
		expect(retried.sync).toEqual({ total: 50, synced: 50, pending: 0, failed: 0 });
		const ready = gateFor(contextOf(second), retried);
		expect(ready.state).toBe("ready");
		expect(ready.release()).toMatchObject({ ok: true, state: "ready" });
	}, 60_000);

	test("a PRD that was written but could not be delivered keeps the gate from releasing", async () => {
		const w = world();
		Object.assign(w.deps.tot ?? {}, { open: () => undefined });
		const result = await runPromptSubmit(input, w.deps);
		const prd = result.prd;
		if (!prd) throw new Error("the stage did not run");
		expect(prd.manifest.generated).toBe(49);
		expect(prd.sync).toMatchObject({ pending: 49, failed: 1 });
		const gate = gateFor(contextOf(result), prd);
		expect(gate.state).toBe("partial_failure");
		expect(gate.verdict?.problems.map((problem) => problem.code)).toContain("prds_sync_pending");
	}, 60_000);

	test("think.tot.enabled false, or no seams: no stage, no PRDs, the plan is as before", async () => {
		const off = world({ config: (config) => (config.think.tot.enabled = false) });
		const a = await runPromptSubmit(input, off.deps);
		expect(a.prd).toBeUndefined();
		expect(off.asked).toEqual([]);
		expect(contextOf(a)).not.toContain("<PRDS");
		const bare = world({ tot: false });
		const b = await runPromptSubmit(input, bare.deps);
		expect(b.prd).toBeUndefined();
		expect(existsSync(join(bare.deps.stateDir, "tot"))).toBe(false);
	}, 60_000);

	test("ToT waits for the whole plan: no clarifying questions are asked mid-plan", async () => {
		const w = world();
		let clarifyCalls = 0;
		w.deps.clarify = async () => {
			clarifyCalls++;
			return { items: [] };
		};
		const result = await runPromptSubmit(input, w.deps);
		expect(clarifyCalls).toBe(0);
		expect(result.prd).toBeDefined();
	}, 60_000);

	test("no tracker rows, no PRDs: the stage is skipped instead of spending model calls", async () => {
		const w = world();
		w.deps.track = async () => undefined;
		const result = await runPromptSubmit(input, w.deps);
		expect(result.prd).toBeUndefined();
		expect(w.asked).toEqual([]);
	}, 60_000);
});

describe("totHoldReason: unmatched keys and partial plans hold the release", () => {
	function outcome(total: number, generated: number, error?: string): PrdOutcome {
		return {
			manifest: { total, generated, failed: total - generated, fallbacks: 0, records: [] },
			sync: { total, synced: generated, pending: 0, failed: total - generated },
			model: { modelId: "m-1", provider: "x", source: "selected", reason: "r" },
			...(error ? { error } : {}),
		};
	}

	test("a fully placed plan has no hold", () => {
		expect(totHoldReason(outcome(3, 3), [])).toBeUndefined();
	});

	test("an unmatched PRD key holds the release", () => {
		expect(totHoldReason(outcome(3, 3), ["n9.1"])).toBe(
			"no Sub Issue in the specification for n9.1",
		);
	});

	test("a missing PRD holds the release, keeping the stage error when it names the gap", () => {
		expect(totHoldReason(outcome(3, 2), [])).toBe("PRD_PARTIAL: 2 of 3 PRDs generated");
		expect(totHoldReason(outcome(3, 2, "PRD_PARTIAL: 2 of 3 PRDs generated"), [])).toBe(
			"PRD_PARTIAL: 2 of 3 PRDs generated",
		);
	});
});

describe("verifyPrdPresence: tracker-side presence, read-only (SPE-35424)", () => {
	const KEY = "n1.1";
	const HASH = "abc123";
	const linearRegion = `<!-- ultrathink:prd:start key=${KEY} hash=${HASH} -->\n## PRD\n\ntext\n<!-- ultrathink:prd:end -->`;
	const notionBlocks = [
		{
			id: "b1",
			type: "callout",
			callout: {
				rich_text: [{ type: "text", text: { content: `ultrathink:prd key=${KEY} hash=${HASH}` } }],
			},
		},
		{
			id: "b2",
			type: "paragraph",
			paragraph: { rich_text: [{ type: "text", text: { content: "text" } }] },
		},
		{
			id: "b3",
			type: "callout",
			callout: { rich_text: [{ type: "text", text: { content: "ultrathink:prd:end" } }] },
		},
	];
	const refs = {
		linear: {
			[KEY]: { id: "i1", identifier: "ENG-1", url: "https://linear.app/o/issue/ENG-1", title: "t" },
		},
		notion: { [KEY]: "https://www.notion.so/page-0123456789abcdef0123456789abcdef" },
	};

	function outcome(total: number, generated: number): PrdOutcome {
		return {
			manifest: { total, generated, failed: total - generated, fallbacks: 0, records: [] },
			sync: { total, synced: generated, pending: 0, failed: total - generated },
			model: { modelId: "m-1", provider: "x", source: "selected", reason: "r" },
		};
	}

	test("local-generated-but-tracker-missing holds, naming the key, and writes nothing", async () => {
		const calls: string[] = [];
		const linear: ToolCaller = {
			async call(name) {
				calls.push(`linear:${name}`);
				return { id: "ENG-1", description: "no PRD here" };
			},
		};
		const notion: ToolCaller = {
			async call(name) {
				calls.push(`notion:${name}`);
				return { results: [], has_more: false };
			},
		};
		const presence = await verifyPrdPresence([{ key: KEY, hash: HASH }], refs, { linear, notion });
		expect(presence).toEqual({ missingLinear: [KEY], missingNotion: [KEY] });
		expect(prdPresenceHoldReason(presence)).toBe(
			`PRD text not present in tracker rows (Linear: ${KEY}; Notion: ${KEY})`,
		);
		expect(totHoldReason(outcome(1, 1), [], presence)).toBe(prdPresenceHoldReason(presence));
		// Read-only: only reads were issued, never a save/append/write.
		expect(calls).toEqual(["linear:get_issue", "notion:API-get-block-children"]);
	});

	test("both-present proceeds: no hold", async () => {
		const linear: ToolCaller = {
			async call(name) {
				expect(name).toBe("get_issue");
				return { id: "ENG-1", description: linearRegion };
			},
		};
		const notion: ToolCaller = {
			async call(name) {
				expect(name).toBe("API-get-block-children");
				return { results: notionBlocks, has_more: false };
			},
		};
		const presence = await verifyPrdPresence([{ key: KEY, hash: HASH }], refs, { linear, notion });
		expect(presence).toEqual({ missingLinear: [], missingNotion: [] });
		expect(prdPresenceHoldReason(presence)).toBeUndefined();
		expect(totHoldReason(outcome(1, 1), [], presence)).toBeUndefined();
	});

	test("a hash mismatch or an unclosed region is missing, not present", async () => {
		const linear: ToolCaller = {
			async call() {
				return { id: "ENG-1", description: linearRegion.replace(HASH, "otherhash") };
			},
		};
		const presence = await verifyPrdPresence([{ key: KEY, hash: HASH }], refs, { linear });
		expect(presence.missingLinear).toEqual([KEY]);
	});
});
