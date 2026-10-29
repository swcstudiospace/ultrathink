// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { runThink } from "../think/pipeline.ts";
import { graphJson, UPLIFT } from "../test.helpers.ts";
import { GRAPH_ID_PATTERN } from "../gateway/types.ts";
import { decideUplift } from "../uplift/detect.ts";
import type { Tracker } from "../track/gateway.ts";
import type { TrackingRefs } from "../track/types.ts";
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
			return refsFor(plan.graphId);
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

	test("a replan of a tracked prompt passes the recorded refs as existing", async () => {
		const existing: Array<TrackingRefs | undefined> = [];
		const { deps, cleanup } = baseDeps();
		deps.track = (async ({ plan, existing: seen }) => {
			existing.push(seen);
			return refsFor(plan.graphId);
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
