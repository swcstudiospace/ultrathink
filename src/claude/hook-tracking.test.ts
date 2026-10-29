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
			const resend = { ...deps, signal: undefined };
			resend.track = (async ({ plan, existing: seen }) => {
				existing.push(seen);
				return refsFor(plan.graphId);
			}) satisfies Tracker;
			const result = await runPromptSubmit(input, resend);
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
});

/**
 * The model's answer for the same prompt. Variant "b" renames n2, so its graph differs; "fills" rewrites the fill of n3 only
 * (the graph is the same); "fallback" answers the graph call with nothing usable.
 */
function modelFor(
	variant: () => "a" | "b" | "fills" | "fallback",
	onCall: () => void = () => undefined,
): (system: string, user: string) => Promise<string> {
	const base = smartComplete();
	return async (system, user) => {
		onCall();
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const lead = variant() === "fills" && id === "n3" ? "changed " : "";
			const steps = Array.from(
				{ length: 5 },
				(_, i) => `${i + 1}. ${lead}${id} step ${i + 1}`,
			).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		const graphCall = !user.includes("<user_request>") && !user.startsWith("<spec>");
		if (variant() === "fallback" && graphCall) return "not a graph";
		if (variant() === "b" && graphCall)
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

describe("the graph id is content-addressed (greptile r3)", () => {
	/** A world whose Linear refuses new issues once three exist, so the first run ends with half its rows. */
	function halfWorld(): {
		linear: ReturnType<typeof statefulLinear>;
		notion: ReturnType<typeof statefulNotion>;
		tracker: Tracker;
		heal: () => void;
	} {
		const linear = statefulLinear();
		let down = true;
		const flaky: ToolCaller = {
			call: (name, args, signal) =>
				down && name === "save_issue" && args.id === undefined && linear.rows.length >= 3
					? Promise.reject(failure("HTTP 400", { status: 400 }))
					: linear.call(name, args, signal),
		};
		const notion = statefulNotion();
		return {
			linear,
			notion,
			tracker: worldTracker({ linear: flaky, notion }),
			heal: () => {
				down = false;
			},
		};
	}

	test("a resend that produces the same graph gets the same id and adopts every row without duplicates", async () => {
		const world = halfWorld();
		const { deps, cleanup } = baseDeps();
		deps.track = world.tracker;
		try {
			const first = await runPromptSubmit(input, deps);
			expect(first.record?.tracking?.status).toBe("partial");
			expect(world.linear.rows).toHaveLength(3);
			world.heal();
			const second = await runPromptSubmit(input, deps);
			expect(second.record?.plan?.graphId).toBe(first.record?.plan?.graphId);
			expect(second.record?.tracking?.status).toBe("complete");
			expect(world.linear.rows).toHaveLength(30);
			expect(new Set(world.linear.rows.map((row) => row.title)).size).toBe(30);
			expect(world.notion.rows).toHaveLength(31);
			expect(new Set(world.notion.rows.map((row) => `${row.Level}${row.Item}`)).size).toBe(31);
		} finally {
			cleanup();
		}
	});

	test("the fills are identity too: the same skeleton with other fills gets another id, so no row of the first attempt is adopted", async () => {
		let variant: "a" | "fills" = "a";
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps({ complete: modelFor(() => variant) });
		deps.track = worldTracker({ linear, notion });
		try {
			const first = await runPromptSubmit(input, deps);
			variant = "fills";
			const second = await runPromptSubmit(input, deps);
			expect(second.record?.plan?.graphId).not.toBe(first.record?.plan?.graphId);
			// A whole second set under its own id: no step row is created under an adopted node of the first attempt.
			expect(linear.rows).toHaveLength(60);
			expect(notion.rows).toHaveLength(62);
			expect(second.record?.tracking?.status).toBe("complete");
		} finally {
			cleanup();
		}
	});

	test("a byte-identical graph with the same fills gets the same id and adopts every row", async () => {
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps();
		deps.track = worldTracker({ linear, notion });
		try {
			const first = await runPromptSubmit(input, deps);
			const second = await runPromptSubmit(input, deps);
			expect(second.record?.plan?.graphId).toBe(first.record?.plan?.graphId);
			expect(linear.rows).toHaveLength(30);
			expect(notion.rows).toHaveLength(31);
		} finally {
			cleanup();
		}
	});

	test("a first-time plan makes no lookup call, and a resend of the same graph looks its rows up", async () => {
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps();
		deps.track = worldTracker({ linear, notion });
		try {
			await runPromptSubmit(input, deps);
			expect(linear.calls.filter((call) => call.name === "list_issues")).toHaveLength(0);
			expect(notion.calls.filter((call) => call.name === "notion-query-data-sources")).toHaveLength(
				0,
			);
			await runPromptSubmit(input, deps);
			expect(linear.calls.filter((call) => call.name === "list_issues").length).toBeGreaterThan(0);
			expect(linear.rows).toHaveLength(30);
			expect(notion.rows).toHaveLength(31);
		} finally {
			cleanup();
		}
	});

	test("a resend that produces another graph gets another id and none of the earlier rows is adopted", async () => {
		let variant: "a" | "b" = "a";
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps({ complete: modelFor(() => variant) });
		deps.track = worldTracker({ linear, notion });
		try {
			const first = await runPromptSubmit(input, deps);
			expect(first.record?.tracking?.status).toBe("complete");
			const firstUrls = new Set(linear.rows.map((row) => row.url));
			const firstPages = new Set(notion.rows.map((row) => row.url));
			variant = "b";
			const second = await runPromptSubmit(input, deps);
			const firstId = first.record?.plan?.graphId ?? "";
			const secondId = second.record?.plan?.graphId ?? "";
			expect(secondId).not.toBe(firstId);
			// The id keeps the shape every consumer reads: the gateway, the swarm lane brief and the hand-off guard.
			expect(firstId).toMatch(GRAPH_ID_PATTERN);
			expect(secondId).toMatch(GRAPH_ID_PATTERN);
			expect(secondId.slice(0, 13)).toBe(firstId.slice(0, 13));
			expect(
				decideUplift(
					{ text: `execute graph ${secondId}`, source: "user" },
					{ enabled: true, skipOnce: false, skipTrivial: true },
				),
			).toEqual({ action: "skip", reason: "graph-reference" });
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
			// The earlier rows are left alone, as orphans.
			expect(linear.rows).toHaveLength(60);
			expect(notion.rows).toHaveLength(62);
		} finally {
			cleanup();
		}
	});

	test("a prompt that is not planned in between changes nothing", async () => {
		const world = halfWorld();
		const { deps, cleanup } = baseDeps();
		deps.track = world.tracker;
		try {
			const first = await runPromptSubmit(input, deps);
			const between = await runPromptSubmit({ ...input, prompt: "/model" }, deps);
			expect(between.skipped).toBeDefined();
			world.heal();
			const second = await runPromptSubmit(input, deps);
			expect(second.record?.plan?.graphId).toBe(first.record?.plan?.graphId);
			expect(world.linear.rows).toHaveLength(30);
			expect(world.notion.rows).toHaveLength(31);
		} finally {
			cleanup();
		}
	});

	test("a fallback graph makes no tracker rows and no plan, as before", async () => {
		const calls: string[] = [];
		const { deps, cleanup } = baseDeps({ complete: modelFor(() => "fallback") });
		deps.track = (async ({ plan }) => {
			calls.push(plan.graphId);
			return undefined;
		}) satisfies Tracker;
		try {
			const result = await runPromptSubmit(input, deps);
			expect(calls).toEqual([]);
			expect(result.record?.plan).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("the same prompt and graph in another repository gets another id and new rows; the same repository adopts", async () => {
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps();
		deps.track = worldTracker({ linear, notion });
		const inRepo = (repo: string) => ({ ...deps, git: () => ({ repo, branch: "main" }) });
		try {
			const a1 = await runPromptSubmit(input, inRepo("acme/widgets"));
			const idA = a1.record?.plan?.graphId ?? "";
			const firstUrls = new Set(linear.rows.map((row) => row.url));
			const firstPages = new Set(notion.rows.map((row) => row.url));
			const b = await runPromptSubmit(input, inRepo("acme/gadgets"));
			const idB = b.record?.plan?.graphId ?? "";
			expect(idB).not.toBe(idA);
			expect(idB).toMatch(GRAPH_ID_PATTERN);
			expect(idB.slice(0, 13)).toBe(idA.slice(0, 13));
			// The record's refs are the new id's: nothing of the first repository's rows is adopted.
			expect(b.record?.tracking?.graphId).toBe(idB);
			const refs = b.record?.tracking;
			expect(Object.values(refs?.linear.nodes ?? {}).some((ref) => firstUrls.has(ref.url))).toBe(
				false,
			);
			expect(Object.values(refs?.notion.nodes ?? {}).some((url) => firstPages.has(url))).toBe(
				false,
			);
			expect(refs?.notion.taskUrl && firstPages.has(refs.notion.taskUrl)).toBeFalsy();
			expect(linear.rows).toHaveLength(60);
			expect(notion.rows).toHaveLength(62);
			// Back in the first repository the byte-identical graph has the first id again. B's save replaced the record, so
			// no lookup runs and its rows are made again (the documented limit; the first rows stay as orphans).
			const a2 = await runPromptSubmit(input, inRepo("acme/widgets"));
			expect(a2.record?.plan?.graphId).toBe(idA);
			expect(a2.record?.tracking?.graphId).toBe(idA);
			// An unchanged repository keeps the id and adopts.
			const a3 = await runPromptSubmit(input, inRepo("acme/widgets"));
			expect(a3.record?.plan?.graphId).toBe(idA);
			expect(linear.rows).toHaveLength(90);
		} finally {
			cleanup();
		}
	});

	test("without a repository slug the working directory is the repository identity", async () => {
		const ids: string[] = [];
		const { deps, cleanup } = baseDeps({ git: () => ({}) });
		deps.track = (async ({ plan }) => {
			ids.push(plan.graphId);
			return undefined;
		}) satisfies Tracker;
		try {
			await runPromptSubmit({ ...input, cwd: "/work/one" }, deps);
			await runPromptSubmit({ ...input, cwd: "/work/one" }, deps);
			await runPromptSubmit({ ...input, cwd: "/work/two" }, deps);
			expect(ids[1]).toBe(ids[0]);
			expect(ids[2]).not.toBe(ids[0]);
		} finally {
			cleanup();
		}
	});

	test("with thinking off (no graph) the id still depends on the prompt and the repository, and only the Task row is made", async () => {
		const linear = statefulLinear();
		const notion = statefulNotion();
		const { deps, cleanup } = baseDeps({ control: { thinkEnabled: false } });
		deps.track = worldTracker({ linear, notion });
		const inRepo = (repo: string) => ({ ...deps, git: () => ({ repo, branch: "main" }) });
		try {
			const a1 = await runPromptSubmit(input, inRepo("acme/widgets"));
			const a2 = await runPromptSubmit(input, inRepo("acme/widgets"));
			const b = await runPromptSubmit(input, inRepo("acme/gadgets"));
			expect(a1.record?.graph).toBeUndefined();
			expect(a2.record?.plan?.graphId).toBe(a1.record?.plan?.graphId);
			expect(b.record?.plan?.graphId).not.toBe(a1.record?.plan?.graphId);
			expect(linear.rows).toHaveLength(0);
			expect(notion.rows.map((row) => row.Level)).toEqual(["Task", "Task"]);
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
