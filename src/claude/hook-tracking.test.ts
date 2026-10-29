// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { runThink } from "../think/pipeline.ts";
import { graphJson, UPLIFT } from "../test.helpers.ts";
import { GRAPH_ID_PATTERN } from "../gateway/types.ts";
import { decideUplift } from "../uplift/detect.ts";
import { createTracking, type ToolCaller } from "../track/create.ts";
import type { Tracker } from "../track/gateway.ts";
import { failure, statefulLinear, statefulNotion } from "../track/test.helpers.ts";
import type { TrackingRefs } from "../track/types.ts";
import { attachReport } from "../types.ts";
import { type HookDeps, type PromptSubmitInput, runPromptSubmit } from "./hook.ts";
import { readSession, sessionPath } from "./state.ts";

function tempStateDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-hook-track-"));
	return {
		dir: join(dir, "ultrathink"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function smartComplete(): (system: string, user: string) => Promise<string> {
	return async (_system, user) => {
		if (user.includes("<user_request>")) return UPLIFT("add a widget");
		if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		return graphJson(5);
	};
}

function trackedConfig(): UltrathinkConfig {
	const config = defaultConfig();
	config.linear.team = "Team";
	config.notion.dataSourceUrl = "collection://ds";
	return config;
}

function baseDeps(overrides: Partial<HookDeps> = {}): { deps: HookDeps; cleanup: () => void } {
	const { dir, cleanup } = tempStateDir();
	const deps: HookDeps = {
		config: trackedConfig(),
		control: {},
		complete: smartComplete(),
		engine: "claude:claude-haiku-5-5",
		stateDir: dir,
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => ({ text: "", state: "none" }),
		realmProbe: async () => ({ kind: "absent" }),
		emit: async () => true,
		now: () => 1_000,
		log: () => {
			// reason: test log sink; assertions read the record and the tracker calls
		},
		decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
		...overrides,
	};
	return { deps, cleanup };
}

const input: PromptSubmitInput = { session_id: "s1", cwd: "/repo", prompt: "add a widget" };

function refsFor(graphId: string): TrackingRefs {
	return {
		graphId,
		status: "complete",
		linearTeam: "Team",
		linear: {
			nodes: {
				n1: {
					id: "u1",
					identifier: "ENG-1",
					url: "https://linear.app/o/issue/ENG-1/x",
					title: "T1",
				},
			},
			steps: {},
		},
		notion: { nodes: {}, steps: {} },
		errors: [],
		updatedAt: 1_000,
	};
}

describe("record-first tracking", () => {
	test("the session record and spec are on disk before the first tracker call", async () => {
		const seen: { statePath: boolean; specPath: boolean; plan?: string }[] = [];
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan }) => {
			const statePath = sessionPath(deps.stateDir, "s1");
			seen.push({
				statePath: existsSync(statePath),
				specPath: existsSync(statePath.replace(/\.json$/, ".xml")),
				plan: readSession(deps.stateDir, "s1")?.plan?.graphId,
			});
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			const result = await runPromptSubmit(input, deps);
			expect(seen).toEqual([
				{ statePath: true, specPath: true, plan: result.record?.plan?.graphId },
			]);
			// The final record carries the tracking and the spec file the tracker links.
			expect(readSession(deps.stateDir, "s1")?.tracking?.linear.nodes.n1?.identifier).toBe("ENG-1");
			const spec = readFileSync(
				sessionPath(deps.stateDir, "s1").replace(/\.json$/, ".xml"),
				"utf8",
			);
			expect(spec).toContain('identifier="ENG-1"');
		} finally {
			cleanup();
		}
	});

	test("a flight killed while tracking leaves a readable record with its spec and state paths", async () => {
		const controller = new AbortController();
		const { deps, cleanup } = baseDeps({ signal: controller.signal });
		deps.track = (async () => {
			// One row was created, then the host cancelled the flight.
			controller.abort();
			throw Object.assign(new Error("Planning cancelled"), { name: "AbortError" });
		}) satisfies Tracker;
		try {
			await expect(runPromptSubmit(input, deps)).rejects.toThrow();
			const record = readSession(deps.stateDir, "s1");
			expect(record?.plan?.issues.length).toBeGreaterThan(0);
			expect(existsSync(sessionPath(deps.stateDir, "s1").replace(/\.json$/, ".xml"))).toBe(true);
		} finally {
			cleanup();
		}
	});
});

/** Live refs as the creator holds them after `count` Linear rows (one more row per call). */
function liveRefs(graphId: string, count: number): TrackingRefs {
	const nodes: TrackingRefs["linear"]["nodes"] = {};
	for (let i = 1; i <= count; i++)
		nodes[`n${i}`] = {
			id: `u${i}`,
			identifier: `ENG-${i}`,
			url: `https://linear.app/o/issue/ENG-${i}/x`,
			title: `T${i}`,
		};
	return {
		graphId,
		status: "failed",
		linearTeam: "Team",
		linear: { nodes, steps: {} },
		notion: { nodes: {}, steps: {} },
		errors: [],
		updatedAt: 1_000,
	};
}

describe("per-ref checkpoint (TRK-01 G5)", () => {
	test("a flight killed after two rows finds both refs in the saved record", async () => {
		const controller = new AbortController();
		const { deps, cleanup } = baseDeps({ signal: controller.signal });
		deps.track = (async ({ plan, onRef }) => {
			onRef?.(liveRefs(plan.graphId, 1));
			onRef?.(liveRefs(plan.graphId, 2));
			// Killed before the tracker could return: no final save ever runs for these refs.
			controller.abort();
			throw Object.assign(new Error("Planning cancelled"), { name: "AbortError" });
		}) satisfies Tracker;
		try {
			await expect(runPromptSubmit(input, deps)).rejects.toThrow();
			const saved = readSession(deps.stateDir, "s1")?.tracking;
			expect(Object.keys(saved?.linear.nodes ?? {}).sort()).toEqual(["n1", "n2"]);
			expect(saved?.linear.nodes.n2?.identifier).toBe("ENG-2");
			expect(saved?.status).toBe("partial");
		} finally {
			cleanup();
		}
	});

	test("a checkpoint merges over the refs the record already holds and never drops them", async () => {
		const { deps, cleanup } = baseDeps();
		let graphId = "";
		deps.track = (async ({ plan }) => {
			graphId = plan.graphId;
			return { ...refsFor(plan.graphId), status: "partial" } satisfies TrackingRefs;
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			const seen: Array<TrackingRefs | undefined> = [];
			deps.track = (async ({ plan, existing, onRef }) => {
				seen.push(existing);
				// A new row n2 on top of the recorded n1.
				const live = liveRefs(plan.graphId, 2);
				delete live.linear.nodes.n1;
				onRef?.(live);
				return undefined;
			}) satisfies Tracker;
			await runPromptSubmit(input, deps);
			expect(seen[0]?.linear.nodes.n1?.identifier).toBe("ENG-1");
			const saved = readSession(deps.stateDir, "s1")?.tracking;
			expect(saved?.graphId).toBe(graphId);
			expect(Object.keys(saved?.linear.nodes ?? {}).sort()).toEqual(["n1", "n2"]);
		} finally {
			cleanup();
		}
	});

	test("a checkpoint keeps the links still to make, and a live run that has made them clears them", async () => {
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan, onRef }) => {
			onRef?.({ ...liveRefs(plan.graphId, 2), pendingLinks: { n2: ["n1"] } });
			return undefined;
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			expect(readSession(deps.stateDir, "s1")?.tracking?.pendingLinks).toEqual({ n2: ["n1"] });
			deps.track = (async ({ plan, onRef }) => {
				// A live run that never touched the links leaves the recorded ones; one that finished them reports none.
				onRef?.(liveRefs(plan.graphId, 2));
				return undefined;
			}) satisfies Tracker;
			await runPromptSubmit(input, deps);
			expect(readSession(deps.stateDir, "s1")?.tracking?.pendingLinks).toEqual({ n2: ["n1"] });
			deps.track = (async ({ plan, onRef }) => {
				onRef?.({ ...liveRefs(plan.graphId, 2), pendingLinks: {} });
				return undefined;
			}) satisfies Tracker;
			await runPromptSubmit(input, deps);
			expect(readSession(deps.stateDir, "s1")?.tracking?.pendingLinks).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("a tracker that returns nothing after checkpointing leaves its refs in the final record", async () => {
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan, onRef }) => {
			onRef?.(liveRefs(plan.graphId, 2));
			return undefined;
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			const saved = readSession(deps.stateDir, "s1")?.tracking;
			expect(Object.keys(saved?.linear.nodes ?? {}).sort()).toEqual(["n1", "n2"]);
		} finally {
			cleanup();
		}
	});
});

describe("deterministic graph id", () => {
	test("the same session and prompt reuse one id; another prompt or session gets another", async () => {
		const ids: string[] = [];
		const track: Tracker = async ({ plan }) => {
			ids.push(plan.graphId);
			return undefined;
		};
		const a = baseDeps({ track });
		const b = baseDeps({ track });
		const c = baseDeps({ track });
		const d = baseDeps({ track });
		try {
			await runPromptSubmit(input, a.deps);
			await runPromptSubmit(input, b.deps);
			await runPromptSubmit({ ...input, prompt: "add another widget please" }, c.deps);
			await runPromptSubmit({ ...input, session_id: "s2" }, d.deps);
			// The real consumers' contracts, not a local regex: gateway registration and the hand-off guard.
			expect(ids[0]).toMatch(GRAPH_ID_PATTERN);
			expect(
				decideUplift(
					{ text: `execute graph ${ids[0]}`, source: "user" },
					{ enabled: true, skipOnce: false, skipTrivial: true },
				),
			).toEqual({ action: "skip", reason: "graph-reference" });
			expect(ids[1]).toBe(ids[0]);
			expect(ids[2]).not.toBe(ids[0]);
			expect(ids[3]).not.toBe(ids[0]);
		} finally {
			a.cleanup();
			b.cleanup();
			c.cleanup();
			d.cleanup();
		}
	});

	test("a resend after a killed flight hands the tracker an existing shell so rows are adopted, not duplicated", async () => {
		const existing: Array<TrackingRefs | undefined> = [];
		const killed = new AbortController();
		const { deps, cleanup } = baseDeps({ signal: killed.signal });
		deps.track = (async ({ existing: seen }) => {
			existing.push(seen);
			killed.abort();
			throw Object.assign(new Error("Planning cancelled"), { name: "AbortError" });
		}) satisfies Tracker;
		try {
			await expect(runPromptSubmit(input, deps)).rejects.toThrow();
			let resendCalls = 0;
			const resend = {
				...deps,
				signal: undefined,
				complete: async (system: string, user: string, signal?: AbortSignal) => {
					resendCalls++;
					return deps.complete(system, user, signal);
				},
			};
			resend.track = (async ({ plan, existing: seen }) => {
				existing.push(seen);
				return refsFor(plan.graphId);
			}) satisfies Tracker;
			const result = await runPromptSubmit(input, resend);
			// The flight was killed after the record was saved: the resend carries on with that plan, no model call.
			expect(resendCalls).toBe(0);
			expect(existing[0]).toBeUndefined();
			expect(existing[1]?.graphId).toBe(result.record?.plan?.graphId);
			expect(existing[1]?.linear.nodes).toEqual({});
		} finally {
			cleanup();
		}
	});

	test("a resend of a plan whose tracking is partial passes the recorded refs as existing", async () => {
		const existing: Array<TrackingRefs | undefined> = [];
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan, existing: seen }) => {
			existing.push(seen);
			return { ...refsFor(plan.graphId), status: "partial" } satisfies TrackingRefs;
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			await runPromptSubmit(input, deps);
			expect(existing[0]).toBeUndefined();
			expect(existing[1]?.linear.nodes.n1?.identifier).toBe("ENG-1");
		} finally {
			cleanup();
		}
	});

	test("a re-plan after complete tracking is a new plan: another graph id, nothing to adopt", async () => {
		const seen: Array<{ graphId: string; existing: TrackingRefs | undefined }> = [];
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan, existing }) => {
			seen.push({ graphId: plan.graphId, existing });
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			await runPromptSubmit(input, deps);
			expect(seen[1]?.graphId).not.toBe(seen[0]?.graphId);
			expect(seen[1]?.existing).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

/** The model's answer for the same prompt: variant "b" renames n2 and rewrites every step of n3, so its graph differs. */
function modelFor(
	variant: () => "a" | "b",
	onCall: () => void = () => undefined,
): (system: string, user: string) => Promise<string> {
	const base = smartComplete();
	return async (system, user) => {
		onCall();
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const lead = variant() === "b" && id === "n3" ? "changed " : "";
			const steps = Array.from(
				{ length: 5 },
				(_, i) => `${i + 1}. ${lead}${id} step ${i + 1}`,
			).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		if (variant() === "b" && !user.includes("<user_request>") && !user.startsWith("<spec>"))
			return graphJson(5).replace('"title":"T2"', '"title":"Rewritten"');
		return base(system, user);
	};
}

/** The real creator over in-memory trackers, so a partial or killed pass leaves real rows behind for the next one. */
function worldTracker(world: { linear: ToolCaller; notion: ToolCaller }): Tracker {
	return ({ plan, graph, existing, degradedNodes, onRef }) =>
		createTracking(plan, graph, existing, {
			linear: world.linear,
			notion: world.notion,
			linearTeam: "Team",
			notionDataSource: "ds",
			concurrency: 2,
			budgetMs: 0,
			sleep: async () => undefined,
			random: () => 0,
			...(degradedNodes ? { degradedNodes } : {}),
			...(onRef ? { onRef } : {}),
		});
}

describe("a resend never adopts the rows of another graph (greptile r2 #0)", () => {
	test("a plan whose tracking stopped half way is resumed without a model call and adopts its rows", async () => {
		let variant: "a" | "b" = "a";
		let calls = 0;
		const linear = statefulLinear();
		let down = true;
		const flaky: ToolCaller = {
			call: (name, args, signal) =>
				down && name === "save_issue" && args.id === undefined && linear.rows.length >= 3
					? Promise.reject(failure("HTTP 400", { status: 400 }))
					: linear.call(name, args, signal),
		};
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps({
			complete: modelFor(
				() => variant,
				() => {
					calls++;
				},
			),
		});
		deps.track = worldTracker({ linear: flaky, notion });
		try {
			const first = await runPromptSubmit(input, deps);
			expect(first.record?.tracking?.status).toBe("partial");
			expect(linear.rows).toHaveLength(3);
			// The rows were made. A resend now asks the model for nothing, even one that would answer another graph.
			calls = 0;
			down = false;
			variant = "b";
			const second = await runPromptSubmit(input, deps);
			expect(calls).toBe(0);
			expect(second.record?.plan?.graphId).toBe(first.record?.plan?.graphId);
			expect(second.record?.graph).toEqual(first.record?.graph);
			expect(second.record?.plan).toEqual(first.record?.plan);
			expect(second.record?.tracking?.status).toBe("complete");
			// Every row exists once: the first run's three Linear rows and its Notion rows were adopted, not made again.
			expect(linear.rows).toHaveLength(30);
			expect(new Set(linear.rows.map((row) => row.title)).size).toBe(30);
			expect(notion.rows).toHaveLength(31);
			expect(new Set(notion.rows.map((row) => `${row.Level}${row.Item}`)).size).toBe(31);
			expect(readSession(deps.stateDir, "s1")?.tracking?.status).toBe("complete");
		} finally {
			cleanup();
		}
	});

	test("a new plan of the same prompt after complete tracking gets a new graph id and rows of its own", async () => {
		let variant: "a" | "b" = "a";
		let calls = 0;
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps({
			complete: modelFor(
				() => variant,
				() => {
					calls++;
				},
			),
		});
		deps.track = worldTracker({ linear, notion });
		try {
			const first = await runPromptSubmit(input, deps);
			expect(first.record?.tracking?.status).toBe("complete");
			expect(first.record?.generation).toBe(0);
			const firstUrls = new Set(linear.rows.map((row) => row.url));
			const firstPages = new Set(notion.rows.map((row) => row.url));
			calls = 0;
			variant = "b";
			const second = await runPromptSubmit(input, deps);
			expect(calls).toBeGreaterThan(0);
			const firstId = first.record?.plan?.graphId ?? "";
			const secondId = second.record?.plan?.graphId ?? "";
			expect(secondId).not.toBe(firstId);
			expect(second.record?.generation).toBe(1);
			// The id keeps the shape every consumer reads: the gateway, the swarm lane brief and the hand-off guard.
			expect(secondId).toMatch(GRAPH_ID_PATTERN);
			expect(secondId.slice(0, 13)).toBe(firstId.slice(0, 13));
			expect(
				decideUplift(
					{ text: `execute graph ${secondId}`, source: "user" },
					{ enabled: true, skipOnce: false, skipTrivial: true },
				),
			).toEqual({ action: "skip", reason: "graph-reference" });
			// Every row of the new plan is new, and no ref of the record points at a row of the first plan.
			const tracking = second.record?.tracking;
			expect(tracking?.status).toBe("complete");
			const refsUrls = [
				...Object.values(tracking?.linear.nodes ?? {}).map((ref) => ref.url),
				...Object.values(tracking?.linear.steps ?? {}).map((ref) => ref.url),
			];
			const refsPages = [
				...Object.values(tracking?.notion.nodes ?? {}),
				...Object.values(tracking?.notion.steps ?? {}),
				tracking?.notion.taskUrl ?? "",
			];
			expect(refsUrls).toHaveLength(30);
			expect(refsUrls.some((url) => firstUrls.has(url))).toBe(false);
			expect(refsPages.some((url) => firstPages.has(url))).toBe(false);
			expect(linear.rows).toHaveLength(60);
			expect(notion.rows).toHaveLength(62);
		} finally {
			cleanup();
		}
	});

	test("a third plan of the session gets a third graph id", async () => {
		const ids = new Set<string>();
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan }) => {
			ids.add(plan.graphId);
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			for (let i = 0; i < 3; i++) await runPromptSubmit(input, deps);
			expect(ids.size).toBe(3);
			expect([...ids].every((id) => GRAPH_ID_PATTERN.test(id))).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("degraded fills reach the tracker", () => {
	test("the tracker is told which nodes have a degraded fill", async () => {
		const seen: Array<readonly string[] | undefined> = [];
		const { deps, cleanup } = baseDeps({
			think: async (opts) => {
				const thought = await runThink(opts);
				return { ...thought, degraded: { graph: false, fills: ["n2"] } };
			},
		});
		deps.track = (async ({ plan, degradedNodes }) => {
			seen.push(degradedNodes);
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			expect(seen).toEqual([["n2"]]);
		} finally {
			cleanup();
		}
	});

	test("a clean think passes no degraded nodes", async () => {
		const seen: Array<readonly string[] | undefined> = [];
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan, degradedNodes }) => {
			seen.push(degradedNodes);
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			await runPromptSubmit(input, deps);
			expect(seen).toEqual([[]]);
		} finally {
			cleanup();
		}
	});
});

describe("an unwritable state directory", () => {
	test("makes no tracker rows, adds a state token to degraded with the cause and says so in the notice", async () => {
		const parent = mkdtempSync(join(tmpdir(), "ultrathink-hook-nostate-"));
		// A regular file where the state directory's parent should be: every save fails with ENOTDIR.
		const blocker = join(parent, "blocker");
		writeFileSync(blocker, "not a directory");
		const { deps, cleanup } = baseDeps({ stateDir: join(blocker, "state") });
		let trackCalls = 0;
		deps.track = (async ({ plan }) => {
			trackCalls += 1;
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			const result = await runPromptSubmit(input, deps);
			expect(trackCalls).toBe(0);
			expect(result.record?.degraded).toContain("state");
			expect(result.record?.tracking).toBeUndefined();
			const context = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(context).toContain("The plan state could not be saved");
			expect(context).toMatch(/ENOTDIR|not a directory/i);
			expect(context).toContain("Tracker rows are not created while the record cannot be saved");
		} finally {
			cleanup();
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("a writable state directory still tracks and reports no state token", async () => {
		let trackCalls = 0;
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan }) => {
			trackCalls += 1;
			return refsFor(plan.graphId);
		}) satisfies Tracker;
		try {
			const result = await runPromptSubmit(input, deps);
			expect(trackCalls).toBe(1);
			expect(result.record?.degraded ?? []).not.toContain("state");
			expect(result.output?.hookSpecificOutput.additionalContext).not.toContain(
				"plan state could not be saved",
			);
		} finally {
			cleanup();
		}
	});
});

describe("a provider that is down", () => {
	/** A graph call the completer already retried (report attempts 3, HTTP 429), then working fills and clarify. */
	function graphDown(counts: { graph: number; clarify: number }, report: boolean) {
		return async (_system: string, user: string): Promise<string> => {
			if (user.includes("<user_request>")) return UPLIFT("add a widget");
			if (user.startsWith("<spec>")) {
				counts.clarify += 1;
				return JSON.stringify({ questions: [] });
			}
			if (user.includes("current_node")) return smartComplete()(_system, user);
			counts.graph += 1;
			if (!report) return "not json at all";
			const error = Object.assign(new Error("rate limited"), { status: 429 });
			attachReport(error, { attempts: 3, httpStatus: 429 });
			throw error;
		};
	}

	test("skips the clarify stage after the graph call exhausted its retries, and records it as degraded with a cause", async () => {
		const counts = { graph: 0, clarify: 0 };
		let clarifyRuns = 0;
		const { deps, cleanup } = baseDeps({
			complete: graphDown(counts, true),
			clarify: async () => {
				clarifyRuns += 1;
				return { items: [] };
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(clarifyRuns).toBe(0);
			expect(result.record?.degraded).toContain("graph");
			expect(result.record?.degraded).toContain("clarify");
			const context = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(context).toContain("Skipped: the clarify step (provider unavailable)");
			expect(context).toContain("the graph structure (rate limited)");
		} finally {
			cleanup();
		}
	});

	test("still runs clarify when the graph fell back only because its reply was unusable", async () => {
		const counts = { graph: 0, clarify: 0 };
		let clarifyRuns = 0;
		const { deps, cleanup } = baseDeps({
			complete: graphDown(counts, false),
			clarify: async () => {
				clarifyRuns += 1;
				return { items: [] };
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(clarifyRuns).toBe(1);
			expect(result.record?.degraded).toContain("graph");
			expect(result.record?.degraded ?? []).not.toContain("clarify");
		} finally {
			cleanup();
		}
	});
});
