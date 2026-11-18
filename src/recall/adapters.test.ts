// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { LessonRow, LessonsLookup, SkillRow, SkillsLookup } from "../teach/types.ts";
import {
	lessonsLookupToPanel,
	skillsLookupToPanel,
	type SubstrateBriefInput,
	substrateBriefToPanel,
} from "./adapters.ts";
import { type PanelBody, type PanelEnvelope, PREVIEW_MAX_CHARS } from "./panel-model.ts";

const FLOOR = 0.5;
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

/** The list-carrying view of a panel; throws when the envelope has no list (loading and error envelopes). */
function listed(panel: PanelEnvelope): PanelBody {
	if (!("items" in panel)) throw new Error(`panel ${panel.status} carries no list`);
	return panel;
}

const confidence = (value: number) => ({
	kind: "confidence" as const,
	value,
	direction: "higher_is_better" as const,
});

describe("lessonsLookupToPanel: returned lessons", () => {
	test("each returned lesson is an item with its confidence as a score and its record time", () => {
		const panel = lessonsLookupToPanel(
			lessons([
				row({ id: "a", score: 0.8 }),
				row({ id: "b", score: 0.6, createdAt: "2026-02-01T00:00:00.000Z" }),
			]),
			FLOOR,
		);
		expect(panel).toEqual({
			status: "success",
			items: [
				{
					id: "lesson:a",
					title: "Pin the lockfile",
					preview: "Commit bun.lock.",
					source: { kind: "lesson", ref: "a" },
					timestamp: Date.parse(CREATED),
					matchReason: "Prompt terms matched the lesson name",
					score: confidence(0.8),
					itemStatus: "returned",
				},
				{
					id: "lesson:b",
					title: "Pin the lockfile",
					preview: "Commit bun.lock.",
					source: { kind: "lesson", ref: "b" },
					timestamp: Date.parse("2026-02-01T00:00:00.000Z"),
					matchReason: "Prompt terms matched the lesson name",
					score: confidence(0.6),
					itemStatus: "returned",
				},
			],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("a long lesson preview is capped to the panel's preview length", () => {
		const panel = listed(
			lessonsLookupToPanel(lessons([row({ preview: "word ".repeat(200) })]), FLOOR),
		);
		const preview = panel.items[0]?.preview ?? "";
		expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("a lesson the record scored nothing for is returned without a score", () => {
		const panel = listed(
			lessonsLookupToPanel(lessons([row({ id: "a", score: undefined })]), FLOOR),
		);
		expect(panel.items).toHaveLength(1);
		expect(panel.items[0]).not.toHaveProperty("score");
		expect(panel.excluded).toEqual([]);
	});

	test("a lesson below the floor is excluded as below_floor with its score visible; the rest are returned", () => {
		const panel = lessonsLookupToPanel(
			lessons([row({ id: "a", score: 0.8 }), row({ id: "c", score: 0.3 })]),
			FLOOR,
		);
		expect(panel).toEqual({
			status: "success",
			items: [expect.objectContaining({ id: "lesson:a" })],
			excluded: [{ ref: "c", reason: "below_floor", score: confidence(0.3) }],
			missing: [],
			stages: [],
		});
	});

	test("the floor is the caller's parameter: a lesson that clears 0.5 is excluded under 0.9, and an all-excluded record is empty below_floor", () => {
		const panel = lessonsLookupToPanel(lessons([row({ id: "a", score: 0.8 })]), 0.9);
		expect(panel).toEqual({
			status: "empty",
			reason: "below_floor",
			items: [],
			excluded: [{ ref: "a", reason: "below_floor", score: confidence(0.8) }],
			missing: [],
			stages: [],
		});
	});
});

describe("lessonsLookupToPanel: failures and empty records", () => {
	test("a lookup that could not read its store is an error envelope", () => {
		expect(
			lessonsLookupToPanel(
				lessons(undefined, {
					outcome: "error",
					count: 0,
					ids: [],
					source: "none",
					reason: "store unreadable",
				}),
				FLOOR,
			),
		).toEqual({
			status: "error",
			errorClass: "unclassified",
			message: "store unreadable",
			retry: { scheduled: false, attempt: 0 },
			stages: [],
		});
	});

	test("an error without a reason says the lookup failed", () => {
		expect(
			lessonsLookupToPanel(lessons(undefined, { outcome: "error", count: 0, ids: [] }), FLOOR),
		).toMatchObject({ status: "error", message: "Lessons lookup failed." });
	});

	test("a lookup that ran and found nothing is an empty envelope with its reason", () => {
		expect(lessonsLookupToPanel(lessons([], { outcome: "none", count: 0 }), FLOOR)).toEqual({
			status: "empty",
			reason: "no_match",
			items: [],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("a lookup with lessons switched off is an empty envelope with reason gate_off", () => {
		expect(lessonsLookupToPanel(lessons([], { outcome: "off", count: 0 }), FLOOR)).toMatchObject({
			status: "empty",
			reason: "gate_off",
		});
	});

	test("a used record written before rows existed cannot show its lessons", () => {
		expect(lessonsLookupToPanel(lessons(undefined), FLOOR)).toMatchObject({
			status: "empty",
			reason: "source_unavailable",
			items: [],
		});
	});
});

describe("skillsLookupToPanel", () => {
	test("a published skill is a pointer item: its name, its description and its target, never a body", () => {
		expect(skillsLookupToPanel(skills([skillRow()]))).toEqual({
			status: "success",
			items: [
				{
					id: "skill:omp:bun-snapshot-tests",
					title: "bun-snapshot-tests",
					preview: "Use when snapshot tests fail.",
					source: { kind: "skill", ref: "bun-snapshot-tests" },
					timestamp: null,
					matchReason: "Promoted skill matched the prompt (omp)",
					itemStatus: "returned",
				},
			],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("a draft is never returned: it is excluded as filtered while the published skill is still an item", () => {
		const panel = skillsLookupToPanel(
			skills([skillRow(), skillRow({ name: "lesson-draft", target: "drafts", injected: false })]),
		);
		expect(panel).toMatchObject({
			status: "success",
			items: [{ id: "skill:omp:bun-snapshot-tests" }],
			excluded: [{ ref: "lesson-draft", reason: "filtered" }],
		});
		expect(listed(panel).items.map((item) => item.id)).not.toContain("skill:lesson-draft");
	});

	test("a lookup whose only skill is a draft is an empty envelope with reason filtered", () => {
		expect(
			skillsLookupToPanel(
				skills([skillRow({ name: "lesson-draft", target: "drafts", injected: false })]),
			),
		).toEqual({
			status: "empty",
			reason: "filtered",
			items: [],
			excluded: [{ ref: "lesson-draft", reason: "filtered" }],
			missing: [],
			stages: [],
		});
	});

	test("an injected row is a pointer item even when its target is drafts: the adapter decides by injected only", () => {
		expect(
			skillsLookupToPanel(
				skills([skillRow({ name: "generated-skill", target: "drafts", injected: true })]),
			),
		).toMatchObject({
			status: "success",
			items: [
				{
					id: "skill:drafts:generated-skill",
					source: { kind: "skill", ref: "generated-skill" },
					matchReason: "Promoted skill matched the prompt (drafts)",
				},
			],
			excluded: [],
		});
	});

	test("a row that is not injected is an excluded row, even when its target is an install", () => {
		expect(
			skillsLookupToPanel(
				skills([skillRow({ name: "omp-draft", target: "omp", injected: false })]),
			),
		).toEqual({
			status: "empty",
			reason: "filtered",
			items: [],
			excluded: [{ ref: "omp-draft", reason: "filtered" }],
			missing: [],
			stages: [],
		});
	});

	test("a disabled skill is omitted: it never reaches the record, so it is absent from the panel", () => {
		expect(skillsLookupToPanel(skills([skillRow({ name: "enabled-skill" })]))).toMatchObject({
			status: "success",
			items: [{ id: "skill:omp:enabled-skill" }],
			excluded: [],
		});
	});

	test("names alone never produce items: a used record without rows is empty source_unavailable", () => {
		expect(skillsLookupToPanel(skills(undefined, { names: ["bun-snapshot-tests"] }))).toEqual({
			status: "empty",
			reason: "source_unavailable",
			items: [],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("an error lookup is an error envelope, and an empty lookup is an empty envelope with its reason", () => {
		expect(
			skillsLookupToPanel(
				skills(undefined, {
					outcome: "error",
					count: 0,
					names: [],
					reason: "skills index unreadable",
				}),
			),
		).toEqual({
			status: "error",
			errorClass: "unclassified",
			message: "skills index unreadable",
			retry: { scheduled: false, attempt: 0 },
			stages: [],
		});
		expect(skillsLookupToPanel(skills([], { outcome: "none", count: 0, names: [] }))).toMatchObject(
			{
				status: "empty",
				reason: "no_match",
			},
		);
	});
});

describe("substrateBriefToPanel", () => {
	const briefItem = {
		id: "substrate_brief:brief",
		title: "Substrate brief",
		preview: "Ship the migration first.",
		source: { kind: "substrate_brief" as const, ref: "brief" },
		timestamp: null,
		matchReason: "Cross-agent brief for this repository",
		itemStatus: "returned" as const,
	};

	function brief(over: Partial<SubstrateBriefInput> = {}): SubstrateBriefInput {
		return { text: "Ship the migration first.", state: "complete", ...over };
	}

	test("a complete brief with text is a success with the brief as its one item", () => {
		expect(substrateBriefToPanel(brief())).toEqual({
			status: "success",
			items: [briefItem],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("the brief preview is escaped and capped to PREVIEW_MAX_CHARS with an ellipsis", () => {
		const envelope = substrateBriefToPanel(brief({ text: `<b>${"a".repeat(PREVIEW_MAX_CHARS)}` }));
		expect(envelope.status).toBe("success");
		const preview = listed(envelope).items[0]?.preview ?? "";
		expect(preview.length).toBe(PREVIEW_MAX_CHARS);
		expect(preview.startsWith("&lt;b&gt;a")).toBe(true);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("a degraded brief with text is partial with the same item and the live brief missing", () => {
		expect(substrateBriefToPanel(brief({ state: "degraded" }))).toEqual({
			status: "partial",
			remainder: "truncated",
			items: [briefItem],
			excluded: [],
			missing: [{ ref: "brief", reason: "source_unavailable" }],
			stages: [],
		});
	});

	test("a snapshot brief with text is partial with the same item and the live brief missing", () => {
		expect(substrateBriefToPanel(brief({ state: "snapshot" }))).toEqual({
			status: "partial",
			remainder: "truncated",
			items: [briefItem],
			excluded: [],
			missing: [{ ref: "brief", reason: "source_unavailable" }],
			stages: [],
		});
	});

	test("a disabled brief is empty with gate_off", () => {
		expect(substrateBriefToPanel(brief({ state: "none", text: "", reason: "disabled" }))).toEqual({
			status: "empty",
			reason: "gate_off",
			items: [],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("a brief with no URL is empty with source_unavailable", () => {
		expect(substrateBriefToPanel(brief({ state: "none", text: "", reason: "no-url" }))).toEqual({
			status: "empty",
			reason: "source_unavailable",
			items: [],
			excluded: [],
			missing: [],
			stages: [],
		});
	});

	test("a brief lookup with any other reason is an error classed unclassified, with no retry", () => {
		expect(
			substrateBriefToPanel(brief({ state: "none", text: "", reason: "hook timed out" })),
		).toEqual({
			status: "error",
			errorClass: "unclassified",
			message: "hook timed out",
			retry: { scheduled: false, attempt: 0 },
			stages: [],
		});
	});

	test("a brief lookup error with no reason carries the fallback message", () => {
		expect(substrateBriefToPanel(brief({ state: "none", text: "" }))).toMatchObject({
			status: "error",
			errorClass: "unclassified",
			message: "Substrate brief lookup failed.",
		});
	});

	test("a complete, degraded or snapshot brief with no text is empty with no_match", () => {
		for (const state of ["complete", "degraded", "snapshot"] as const) {
			expect(substrateBriefToPanel(brief({ state, text: "" }))).toEqual({
				status: "empty",
				reason: "no_match",
				items: [],
				excluded: [],
				missing: [],
				stages: [],
			});
		}
	});
});
