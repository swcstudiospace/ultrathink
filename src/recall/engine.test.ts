// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { KnowledgeLookup } from "../greptile/knowledge-probe.ts";
import type { LessonRow, LessonsLookup, SkillRow, SkillsLookup } from "../teach/types.ts";
import { defaultRecallSettings, type RecallSettings } from "./config.ts";
import {
	type BudgetState,
	createBudgetState,
	createCooldownState,
	createDedupeState,
	dedupeKey,
	recordInjected,
	recordSpend,
	startTurn,
} from "./gates.ts";
import {
	type PanelSourceName,
	type RecallEvent,
	type RecallInput,
	type RecallLookups,
	type RecallPlan,
	type RecallRuntimeState,
	planRecall,
} from "./engine.ts";
import type { PanelBody, PanelEnvelope } from "./panel-model.ts";

const NOW = 1_000_000;
const SCOPE_WINDOW = defaultRecallSettings().recall.cooldownMs.scopeChange;
const SCOPE: RecallEvent = { trigger: "scopeChange", scopePath: "src/recall" };
const EXPLICIT: RecallEvent = { trigger: "explicit" };

const CASES: { name: string; event: RecallEvent; sources: PanelSourceName[] }[] = [
	{ name: "scope change", event: SCOPE, sources: ["knowledge", "lessons"] },
	{
		name: "failure",
		event: { trigger: "failure", error: "TypeError at line 12" },
		sources: ["lessons"],
	},
	{
		name: "phase boundary",
		event: { trigger: "phaseBoundary", planStep: "verify", taskType: "test" },
		sources: ["skills"],
	},
	{
		name: "uncertainty",
		event: { trigger: "uncertainty", topic: "which cache layer" },
		sources: ["knowledge"],
	},
	{ name: "explicit request", event: EXPLICIT, sources: ["knowledge", "lessons", "skills"] },
];

/**
 * Recall enabled with every source and trigger flag on. The per-turn call cap is lifted so that an explicit request's
 * three sources fit one turn; the default cap is pinned separately below.
 */
function enabledSettings(perTurnCalls = 10): RecallSettings {
	const settings = defaultRecallSettings();
	return {
		...settings,
		recall: {
			...settings.recall,
			enabled: true,
			sources: { knowledge: true, lessons: true, moments: true, skills: true },
			triggers: {
				scopeChange: true,
				failure: true,
				phaseBoundary: true,
				uncertainty: true,
				explicit: true,
			},
			budget: { ...settings.recall.budget, perTurnCalls },
		},
	};
}

function knowledgeUsed(docs: string[]): KnowledgeLookup {
	return { outcome: "used", docs, chars: 0, ms: 1 };
}

function lessonRow(id: string, score: number): LessonRow {
	return {
		id,
		kind: "decision",
		title: `Lesson ${id}`,
		preview: "Commit the lockfile.",
		createdAt: "2026-01-01T00:00:00.000Z",
		matchReason: "Prompt terms matched the lesson name",
		score,
	};
}

function lessonsUsed(rows: LessonRow[]): LessonsLookup {
	return {
		outcome: "used",
		count: rows.length,
		ids: rows.map((row) => row.id),
		chars: 0,
		ms: 1,
		source: "local",
		rows,
	};
}

function skillsUsed(rows: SkillRow[]): SkillsLookup {
	return {
		outcome: "used",
		count: rows.length,
		names: rows.map((row) => row.name),
		chars: 0,
		ms: 1,
		rows,
	};
}

const SKILL: SkillRow = {
	name: "bun-snapshot-tests",
	description: "Use when snapshot tests fail.",
	target: "omp",
};

function allLookups(): RecallLookups {
	return {
		knowledge: knowledgeUsed(["docs/a.md"]),
		lessons: lessonsUsed([lessonRow("m1", 0.9)]),
		skills: skillsUsed([SKILL]),
	};
}

function freshState(): RecallRuntimeState {
	return {
		cooldown: createCooldownState(),
		budget: createBudgetState(),
		dedupe: createDedupeState(),
	};
}

/** Session budget spent by `calls` recall calls, each in its own turn so the per-turn cap never refuses first. */
function sessionSpent(calls: number): BudgetState {
	let state = createBudgetState();
	for (let i = 0; i < calls; i++) state = startTurn(recordSpend(state, 0));
	return state;
}

function planInput(over: Partial<RecallInput> = {}): RecallInput {
	return {
		trigger: EXPLICIT,
		nowMs: NOW,
		settings: enabledSettings(),
		state: freshState(),
		lookups: allLookups(),
		...over,
	};
}

function planned(plan: RecallPlan): Extract<RecallPlan, { ok: true }> {
	if (!plan.ok) throw new Error(`plan refused: ${plan.reason}`);
	return plan;
}

/** The list-carrying view of a fired panel; throws when the panel has no list (loading and error envelopes). */
function listed(panel: PanelEnvelope | undefined): PanelBody {
	if (panel === undefined || panel.status === "loading" || panel.status === "error") {
		throw new Error("panel carries no list");
	}
	return panel;
}

describe("planRecall", () => {
	test("the master switch off fires nothing, whatever the sources and triggers say", () => {
		const settings = enabledSettings();
		settings.recall.enabled = false;
		const result = planned(planRecall(planInput({ settings })));
		expect(result.audit).toEqual([
			{
				source: "knowledge",
				trigger: "explicit",
				outcome: "skipped_disabled",
				reason: "master_off",
			},
			{ source: "lessons", trigger: "explicit", outcome: "skipped_disabled", reason: "master_off" },
			{ source: "skills", trigger: "explicit", outcome: "skipped_disabled", reason: "master_off" },
		]);
		expect(result.panels).toEqual({});
		expect(result.injectedIds).toEqual([]);
	});

	for (const c of CASES) {
		test(`${c.name} fires its own sources and no others`, () => {
			const result = planned(planRecall(planInput({ trigger: c.event })));
			expect(result.audit.map((entry) => entry.source)).toEqual(c.sources);
			expect(result.audit.map((entry) => entry.outcome)).toEqual(c.sources.map(() => "fired"));
			expect(Object.keys(result.panels).sort()).toEqual([...c.sources].sort());
		});
	}

	test("a source flag off yields skipped_disabled for that source only", () => {
		const settings = enabledSettings();
		settings.recall.sources.lessons = false;
		const result = planned(planRecall(planInput({ settings, trigger: SCOPE })));
		expect(result.audit).toEqual([
			{ source: "knowledge", trigger: "scopeChange", outcome: "fired", injected: 1, deduped: 0 },
			{
				source: "lessons",
				trigger: "scopeChange",
				outcome: "skipped_disabled",
				reason: "source_off",
			},
		]);
		expect(Object.keys(result.panels)).toEqual(["knowledge"]);
	});

	test("a trigger flag off disables only the sources of that trigger", () => {
		const settings = enabledSettings();
		settings.recall.triggers.failure = false;
		const result = planned(
			planRecall(planInput({ settings, trigger: { trigger: "failure", error: "boom" } })),
		);
		expect(result.audit).toEqual([
			{ source: "lessons", trigger: "failure", outcome: "skipped_disabled", reason: "trigger_off" },
		]);
		expect(result.panels).toEqual({});
	});

	test("a repeated scope change inside the cooldown window is skipped_cooldown", () => {
		const first = planned(planRecall(planInput({ trigger: SCOPE, nowMs: NOW })));
		const second = planned(
			planRecall(planInput({ trigger: SCOPE, nowMs: NOW + SCOPE_WINDOW - 1, state: first.next })),
		);
		expect(second.audit).toEqual([
			{ source: "knowledge", trigger: "scopeChange", outcome: "skipped_cooldown", remainingMs: 1 },
			{ source: "lessons", trigger: "scopeChange", outcome: "skipped_cooldown", remainingMs: 1 },
		]);
		expect(second.panels).toEqual({});
	});

	test("a scope change exactly one window after the last fire fires again", () => {
		const first = planned(planRecall(planInput({ trigger: SCOPE, nowMs: NOW })));
		const second = planned(
			planRecall(planInput({ trigger: SCOPE, nowMs: NOW + SCOPE_WINDOW, state: first.next })),
		);
		expect(second.audit.map((entry) => entry.outcome)).toEqual(["fired", "fired"]);
	});

	test("an explicit request has no cooldown", () => {
		const first = planned(planRecall(planInput({ trigger: EXPLICIT, nowMs: NOW })));
		const second = planned(
			planRecall(planInput({ trigger: EXPLICIT, nowMs: NOW + 1, state: first.next })),
		);
		expect(second.audit.map((entry) => entry.outcome)).toEqual(["fired", "fired", "fired"]);
	});

	test("the phase boundary window comes from the input", () => {
		const PHASE: RecallEvent = { trigger: "phaseBoundary", planStep: "Verify", taskType: "test" };
		const first = planned(
			planRecall(planInput({ trigger: PHASE, nowMs: NOW, phaseBoundaryWindowMs: 60_000 })),
		);
		const second = planned(
			planRecall(
				planInput({
					trigger: PHASE,
					nowMs: NOW + 59_999,
					state: first.next,
					phaseBoundaryWindowMs: 60_000,
				}),
			),
		);
		expect(second.audit).toEqual([
			{ source: "skills", trigger: "phaseBoundary", outcome: "skipped_cooldown", remainingMs: 1 },
		]);
	});

	test("a routine request refused by the session budget is skipped_budget, while a reserved request still fires", () => {
		const state = { ...freshState(), budget: sessionSpent(16) };
		const routine = planned(planRecall(planInput({ trigger: SCOPE, state })));
		expect(routine.audit).toEqual([
			{
				source: "knowledge",
				trigger: "scopeChange",
				outcome: "skipped_budget",
				reason: "session_calls_cap",
			},
			{
				source: "lessons",
				trigger: "scopeChange",
				outcome: "skipped_budget",
				reason: "session_calls_cap",
			},
		]);
		expect(routine.panels).toEqual({});

		const reserved = planned(
			planRecall(
				planInput({ trigger: { trigger: "uncertainty", topic: "which cache layer" }, state }),
			),
		);
		expect(reserved.audit.map((entry) => entry.outcome)).toEqual(["fired"]);
	});

	test("a budget refusal records no cooldown fire", () => {
		const state = { ...freshState(), budget: sessionSpent(16) };
		const result = planned(planRecall(planInput({ trigger: SCOPE, state })));
		expect(result.next.cooldown.size).toBe(0);
	});

	test("an explicit request under the default per-turn cap of 2 still reaches all three sources", () => {
		const result = planned(planRecall(planInput({ settings: enabledSettings(2) })));
		expect(result.audit.map((entry) => entry.outcome)).toEqual(["fired", "fired", "fired"]);
	});

	test("a lesson below the relevance floor is excluded in the panel with its score visible", () => {
		const lessons = lessonsUsed([lessonRow("keep", 0.9), lessonRow("drop", 0.2)]);
		const result = planned(
			planRecall(
				planInput({ trigger: { trigger: "failure", error: "boom" }, lookups: { lessons } }),
			),
		);
		const panel = listed(result.panels.lessons);
		expect(panel.items.map((item) => item.id)).toEqual(["lesson:keep"]);
		expect(panel.excluded).toEqual([
			{
				ref: "drop",
				reason: "below_floor",
				score: { kind: "confidence", value: 0.2, direction: "higher_is_better" },
			},
		]);
		expect(result.injectedIds).toEqual(["lesson:keep"]);
	});

	test("an item already injected in this epoch is deduped and not injected again", () => {
		const state = {
			...freshState(),
			dedupe: recordInjected(createDedupeState(), [
				dedupeKey({ id: "doc:docs/a.md", content: "" }),
			]),
		};
		const lookups = { knowledge: knowledgeUsed(["docs/a.md", "docs/b.md"]) };
		const first = planned(planRecall(planInput({ state, lookups })));
		expect(first.injectedIds).toEqual(["doc:docs/b.md"]);
		expect(listed(first.panels.knowledge).items.map((item) => [item.id, item.itemStatus])).toEqual([
			["doc:docs/a.md", "deduped"],
			["doc:docs/b.md", "injected"],
		]);

		const second = planned(planRecall(planInput({ state: first.next, lookups })));
		expect(second.injectedIds).toEqual([]);
		expect(listed(second.panels.knowledge).items.map((item) => item.itemStatus)).toEqual([
			"deduped",
			"deduped",
		]);
	});

	test("an invalid relevance floor is refused, not applied", () => {
		const settings = enabledSettings();
		settings.recall.relevanceFloor.lessons = 1.5;
		expect(planRecall(planInput({ settings }))).toEqual({ ok: false, reason: "invalid_floor" });
	});

	for (const c of CASES) {
		test(`${c.name}: each source-trigger pair gets one entry, no_source when its lookup is absent`, () => {
			const result = planned(planRecall(planInput({ trigger: c.event, lookups: {} })));
			expect(result.audit.map((entry) => entry.source)).toEqual(c.sources);
			expect(result.audit.map((entry) => entry.outcome)).toEqual(c.sources.map(() => "no_source"));
		});
	}
});
