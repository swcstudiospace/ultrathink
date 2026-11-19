// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { disabledKnowledgeLookup } from "../greptile/knowledge.ts";
import type { LessonRow, LessonsLookup, SkillRow, SkillsLookup } from "../teach/types.ts";
import { type RecallSettings, defaultRecallSettings } from "./config.ts";
import { buildTurnPanels } from "./turn-panels.ts";

const CREATED = "2026-01-01T00:00:00.000Z";

function row(over: Partial<LessonRow> = {}): LessonRow {
	return {
		id: "m1",
		kind: "decision",
		title: "Pin the lockfile",
		preview: "Commit bun.lock.",
		createdAt: CREATED,
		matchReason: "Prompt terms matched the lesson name",
		score: 0.8,
		...over,
	};
}

function lessons(rows: LessonRow[] | undefined, over: Partial<LessonsLookup> = {}): LessonsLookup {
	return {
		outcome: "used",
		count: rows?.length ?? 0,
		ids: rows?.map((r) => r.id) ?? [],
		chars: 0,
		ms: 0,
		source: "local",
		rows,
		...over,
	};
}

function skillRow(over: Partial<SkillRow> = {}): SkillRow {
	return {
		name: "bun-snapshot-tests",
		description: "Use when snapshot tests fail.",
		target: "omp",
		injected: true,
		...over,
	};
}

function skills(rows: SkillRow[] | undefined, over: Partial<SkillsLookup> = {}): SkillsLookup {
	return {
		outcome: "used",
		count: rows?.length ?? 0,
		names: rows?.map((r) => r.name) ?? [],
		chars: 0,
		ms: 0,
		rows,
		...over,
	};
}

/** Recall settings with the information panels on or off and the lessons floor set to `floor`. */
function settings(informationPanels: boolean, floor = 0.5): RecallSettings {
	const defaults = defaultRecallSettings();
	return {
		...defaults,
		panels: { informationPanels },
		recall: { ...defaults.recall, relevanceFloor: { lessons: floor } },
	};
}

describe("buildTurnPanels: gating", () => {
	test("with the panels off it returns undefined even when every lookup was supplied", () => {
		expect(
			buildTurnPanels(
				{
					knowledge: disabledKnowledgeLookup(),
					lessons: lessons([row()]),
					skills: skills([skillRow()]),
				},
				settings(false),
			),
		).toBeUndefined();
	});

	test("with the panels on but no lookup supplied it returns undefined", () => {
		expect(buildTurnPanels({}, settings(true))).toBeUndefined();
	});
});

describe("buildTurnPanels: one envelope per supplied lookup", () => {
	test("a knowledge lookup that never ran is an empty gate_off knowledge panel and no other key", () => {
		const panels = buildTurnPanels({ knowledge: disabledKnowledgeLookup() }, settings(true));
		expect(Object.keys(panels ?? {})).toEqual(["knowledge"]);
		expect(panels?.knowledge).toMatchObject({ status: "empty", reason: "gate_off" });
	});

	test("the lessons floor comes from the settings: a 0.4 lesson is excluded at 0.5 and returned at 0.3", () => {
		const lowScore = lessons([row({ id: "m1", score: 0.4 })]);

		const strict = buildTurnPanels({ lessons: lowScore }, settings(true, 0.5));
		expect(Object.keys(strict ?? {})).toEqual(["lessons"]);
		expect(strict?.lessons).toMatchObject({
			status: "empty",
			reason: "below_floor",
			items: [],
			excluded: [{ ref: "m1", reason: "below_floor" }],
		});

		const loose = buildTurnPanels({ lessons: lowScore }, settings(true, 0.3));
		expect(Object.keys(loose ?? {})).toEqual(["lessons"]);
		expect(loose?.lessons).toMatchObject({
			status: "success",
			items: [{ id: "lesson:m1" }],
			excluded: [],
		});
	});

	test("a skills lookup is a skills panel and no other key", () => {
		const panels = buildTurnPanels({ skills: skills([skillRow()]) }, settings(true));
		expect(Object.keys(panels ?? {})).toEqual(["skills"]);
		expect(panels?.skills).toMatchObject({
			status: "success",
			items: [{ id: "skill:omp:bun-snapshot-tests" }],
		});
	});

	test("a Substrate brief lookup is a substrate panel and no other key", () => {
		const panels = buildTurnPanels(
			{ substrate: { text: "## Brief\n- widget edited", state: "complete" } },
			settings(true),
		);
		expect(Object.keys(panels ?? {})).toEqual(["substrate"]);
		expect(panels?.substrate).toMatchObject({ status: "success" });
	});

	test("a moments lookup is one teachable_moment panel; omitting it yields no moments envelope", () => {
		const withMoments = buildTurnPanels({ moments: lessons([row()]) }, settings(true), {
			trigger: "explicit",
			startedAt: 1_000,
		});
		expect(Object.keys(withMoments ?? {})).toEqual(["moments"]);
		expect(withMoments?.moments).toMatchObject({ surface: "teachable_moment" });

		const without = buildTurnPanels({ skills: skills([skillRow()]) }, settings(true), {
			trigger: "explicit",
			startedAt: 1_000,
		});
		expect(Object.keys(without ?? {})).toEqual(["skills"]);
		expect(without?.moments).toBeUndefined();
	});
});
