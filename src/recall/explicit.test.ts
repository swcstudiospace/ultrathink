// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { KnowledgeLookup } from "../greptile/knowledge-probe.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";
import { defaultRecallSettings, type RecallSettings } from "./config.ts";
import { type ExplicitFetchers, runExplicitRecall } from "./explicit.ts";
import { createBudgetState, createCooldownState, createDedupeState } from "./gates.ts";
import type { RecallRuntimeState } from "./engine.ts";

const NOW = 1_000_000;

/** Recall on, every source on, the explicit trigger on. The budget stays at its defaults. */
function enabledSettings(): RecallSettings {
	const base = defaultRecallSettings();
	return {
		...base,
		recall: {
			...base.recall,
			enabled: true,
			sources: { knowledge: true, lessons: true, moments: true, skills: true },
			triggers: { ...base.recall.triggers, explicit: true },
		},
	};
}

function freshState(): RecallRuntimeState {
	return {
		cooldown: createCooldownState(),
		budget: createBudgetState(),
		dedupe: createDedupeState(),
	};
}

const KNOWLEDGE: KnowledgeLookup = { outcome: "used", docs: ["docs/a.md"], chars: 0, ms: 1 };
const LESSONS: LessonsLookup = {
	outcome: "used",
	count: 1,
	ids: ["m1"],
	chars: 0,
	ms: 1,
	source: "local",
	rows: [
		{
			id: "m1",
			kind: "decision",
			title: "Lesson m1",
			preview: "Commit the lockfile.",
			createdAt: "2026-01-01T00:00:00.000Z",
			matchReason: "Prompt terms matched the lesson name",
			score: 0.9,
		},
	],
};
const MOMENTS: LessonsLookup = {
	...LESSONS,
	ids: ["t1"],
	rows: (LESSONS.rows ?? []).map((row) => ({ ...row, id: "t1", title: "Moment t1" })),
};
const SKILLS: SkillsLookup = {
	outcome: "used",
	count: 1,
	names: ["bun-snapshot-tests"],
	chars: 0,
	ms: 1,
	rows: [
		{
			name: "bun-snapshot-tests",
			description: "Use when snapshot tests fail.",
			target: "omp",
			injected: true,
		},
	],
};

/** Fetchers that answer with the fixtures and record every query they were asked. */
function recordingFetchers(): { fetch: ExplicitFetchers; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fetch: {
			knowledge: async (query) => {
				calls.push(`knowledge:${query}`);
				return KNOWLEDGE;
			},
			lessons: async (query) => {
				calls.push(`lessons:${query}`);
				return LESSONS;
			},
			moments: async (query) => {
				calls.push(`moments:${query}`);
				return MOMENTS;
			},
			skills: async (query) => {
				calls.push(`skills:${query}`);
				return SKILLS;
			},
		},
	};
}

describe("explicit recall", () => {
	test("an empty or whitespace-only query is refused before any fetch", async () => {
		const { fetch, calls } = recordingFetchers();

		const result = await runExplicitRecall({
			query: "   ",
			nowMs: NOW,
			settings: enabledSettings(),
			state: freshState(),
			fetch,
		});

		expect(result).toEqual({ ok: false, reason: "empty_query" });
		expect(calls).toEqual([]);
	});

	test("with recall switched off nothing is fetched", async () => {
		const { fetch, calls } = recordingFetchers();

		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings: defaultRecallSettings(),
			state: freshState(),
			fetch,
		});

		expect(result).toEqual({ ok: false, reason: "recall_off" });
		expect(calls).toEqual([]);
	});

	test("an explicit request fires knowledge, lessons, moments and skills, each with a panel", async () => {
		const { fetch, calls } = recordingFetchers();

		const result = await runExplicitRecall({
			query: "  why does the build fail  ",
			nowMs: NOW,
			settings: enabledSettings(),
			state: freshState(),
			fetch,
		});

		expect(calls).toEqual([
			"knowledge:why does the build fail",
			"lessons:why does the build fail",
			"moments:why does the build fail",
			"skills:why does the build fail",
		]);
		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.audit.map((entry) => [entry.source, entry.trigger, entry.outcome])).toEqual([
			["knowledge", "explicit", "fired"],
			["lessons", "explicit", "fired"],
			["moments", "explicit", "fired"],
			["skills", "explicit", "fired"],
		]);
		expect(Object.keys(result.panels).sort()).toEqual([
			"knowledge",
			"lessons",
			"moments",
			"skills",
		]);
		expect(result.panels.knowledge?.status).toBe("success");
		expect(result.panels.lessons?.status).toBe("success");
		expect(result.panels.skills?.status).toBe("success");
		expect(result.panels.moments?.status).toBe("success");
	});

	test("four sources fire although the per-turn call cap is two", async () => {
		const { fetch } = recordingFetchers();
		const settings = enabledSettings();
		expect(settings.recall.budget.perTurnCalls).toBeLessThan(3);
		expect(settings.recall.budget.perSessionCalls).toBeGreaterThan(3);

		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings,
			state: freshState(),
			fetch,
		});

		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.audit.filter((entry) => entry.outcome === "fired")).toHaveLength(4);
	});

	test("a rejected fetch becomes an error panel and the other sources still return", async () => {
		const { fetch } = recordingFetchers();
		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings: enabledSettings(),
			state: freshState(),
			fetch: {
				...fetch,
				knowledge: async () => {
					throw new Error("greptile unreachable");
				},
			},
		});

		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.panels.knowledge).toMatchObject({
			status: "error",
			message: "greptile unreachable",
		});
		expect(result.audit.find((entry) => entry.source === "knowledge")).toMatchObject({
			outcome: "fired",
		});
		expect(result.panels.lessons?.status).toBe("success");
		expect(result.panels.skills?.status).toBe("success");
	});

	test("a source with no fetcher is not fetched and is audited as no_source", async () => {
		const { fetch } = recordingFetchers();
		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings: enabledSettings(),
			state: freshState(),
			fetch: { lessons: fetch.lessons },
		});

		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.audit.map((entry) => [entry.source, entry.outcome])).toEqual([
			["knowledge", "no_source"],
			["lessons", "fired"],
			["moments", "no_source"],
			["skills", "no_source"],
		]);
		expect(Object.keys(result.panels)).toEqual(["lessons"]);
	});

	test("a recall that outlasts its timeout returns partial results with remainderReason timeout", async () => {
		const settings = enabledSettings();
		settings.recall.timeoutMs = 20;

		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings,
			state: freshState(),
			fetch: {
				knowledge: async () => KNOWLEDGE,
				lessons: () => Promise.withResolvers<LessonsLookup>().promise,
				moments: async () => MOMENTS,
				skills: async () => SKILLS,
			},
		});

		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.remainderReason).toBe("timeout");
		expect(result.panels.knowledge?.status).toBe("success");
		expect(result.panels.lessons?.status).toBe("error");
		expect(result.panels.moments?.status).toBe("success");
		expect(result.panels.skills?.status).toBe("success");
	});

	test("a timed-out request keeps the completed panels and turns each pending fetch into an error panel", async () => {
		const settings = enabledSettings();
		settings.recall.timeoutMs = 20;

		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings,
			state: freshState(),
			fetch: {
				knowledge: async () => KNOWLEDGE,
				lessons: () => Promise.withResolvers<LessonsLookup>().promise,
				moments: () => Promise.withResolvers<LessonsLookup>().promise,
				skills: async () => SKILLS,
			},
		});

		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.remainderReason).toBe("timeout");
		expect(result.panels.knowledge).toMatchObject({ status: "success" });
		expect(result.panels.skills).toMatchObject({ status: "success" });
		expect(result.panels.lessons).toMatchObject({ status: "error", message: "timeout" });
		expect(result.panels.moments).toMatchObject({ status: "error", message: "timeout" });
	});

	test("an explicit request with a moments fetcher fetches moments and returns a moments panel", async () => {
		const { fetch, calls } = recordingFetchers();

		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings: enabledSettings(),
			state: freshState(),
			fetch: { moments: fetch.moments },
		});

		expect(calls).toEqual(["moments:why does the build fail"]);
		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.audit.map((entry) => [entry.source, entry.outcome])).toEqual([
			["knowledge", "no_source"],
			["lessons", "no_source"],
			["moments", "fired"],
			["skills", "no_source"],
		]);
		expect(result.panels.moments).toMatchObject({ status: "success" });
	});

	test("a recall that finishes inside its timeout carries no remainderReason", async () => {
		const { fetch } = recordingFetchers();

		const result = await runExplicitRecall({
			query: "why does the build fail",
			nowMs: NOW,
			settings: enabledSettings(),
			state: freshState(),
			fetch,
		});

		if (!result.ok) throw new Error(`refused: ${result.reason}`);
		expect(result.remainderReason).toBeUndefined();
	});
});
