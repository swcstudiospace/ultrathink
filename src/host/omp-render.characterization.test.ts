// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Characterization of the Omp message cards. These snapshots pin what the renderers draw today, so a later change to
 * the frame, the activity card or the insight card shows up as a snapshot diff.
 *
 * Only registerUltrathinkRenderers and activityFallbackLine are exported. The frame, card, insightRows, activityRows
 * and activityHeader functions are module-private and are reached through the renderers registered on a fake host.
 * The swarm rows are module-private too and are not pinned here.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityNotice } from "./activity-notice.ts";
import { visibleWidth } from "./omp-paint.ts";
import {
	ACTIVITY_TYPE,
	activityFallbackLine,
	INSIGHT_TYPE,
	registerUltrathinkRenderers,
} from "./omp-render.ts";

type Renderer = Parameters<
	Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]
>[1];

/** Plain-text theme: each colour is a visible tag so snapshots show which colour a row was painted with. */
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</>`,
	bg: (color: string, text: string) => `<bg:${color}>${text}</>`,
	bold: (text: string) => `**${text}**`,
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	icon: {},
	status: {},
};

const renderers: Record<string, Renderer> = {};
registerUltrathinkRenderers({
	registerMessageRenderer: (type, renderer) => void (renderers[type] = renderer),
});

/** Renders one registered card at `width`; undefined when the renderer declines the details. */
function draw(
	type: string,
	details: unknown,
	width: number,
	expanded = false,
): readonly string[] | undefined {
	const renderer = renderers[type];
	if (renderer === undefined) throw new Error(`no renderer registered for ${type}`);
	return renderer({ content: "", details }, { expanded }, theme)?.render(width);
}

const recalled: ActivityNotice = {
	v: 1,
	kind: "teachable-recalled",
	title: "Recalled 4 lessons",
	source: "hindsight",
	outcome: "used",
	count: 4,
	names: [
		"Use bun test snapshots",
		"Snapshot formatter output",
		"Keep greps out of tests",
		"Pin before refactor",
	],
	detail: "2 lessons matched this prompt",
};

const FIXED_AT = 1_800_000_000_000;

const insight = {
	project: "ultrathink",
	session: "sess-1",
	at: FIXED_AT,
	decisions: [
		{
			point: "plan",
			outcome: "ok",
			action: "plan",
			model: "omp-native:gpt",
			p: 0.97,
			threshold: 0.5,
			latencyMs: 1200,
			attempts: 1,
			at: FIXED_AT,
			cost: 0.002,
			questions: [
				{ key: "scope", p: 0.4 },
				{ key: "tests", p: 0.8 },
			],
		},
		{
			point: "knowledge",
			outcome: "error",
			action: "fail-open",
			model: "",
			error: "auth",
			questions: [],
		},
	],
	lessons: [
		{
			id: "l1",
			name: "Use bun test snapshots",
			status: "promoted",
			kind: "pattern",
			occurrences: 3,
			eligible: true,
			promoted: { target: "omp", skill: "bun-snapshots" },
		},
		{
			id: "l2",
			name: "Avoid grep tests",
			status: "candidate",
			kind: "pitfall",
			occurrences: 1,
			eligible: false,
		},
	],
	policy: {
		enabled: true,
		capture: "explicit",
		recall: true,
		recallLimit: 3,
		recallChars: 800,
		autoPromote: false,
		promoteAfter: 3,
		jevEnabled: true,
	},
	counts: { candidate: 1, confirmed: 0, promoted: 1, superseded: 0 },
	eligible: 1,
	promoted: 1,
	partial: true,
	limitations: ["Partial snapshot: could not read 2 lesson files", "Showing up to 50 lessons"],
};

describe("activity card frame and rows (frame, card, activityRows)", () => {
	test("frame: an activity card at a normal width draws the rounded border around its rows", () => {
		expect(draw(ACTIVITY_TYPE, recalled, 60)).toMatchSnapshot();
	});

	test("frame: row widths of a framed activity card are pinned as observed (base can exceed the requested width)", () => {
		const rows = draw(ACTIVITY_TYPE, recalled, 60) ?? [];
		expect(rows.map((row) => visibleWidth(row))).toMatchSnapshot();
	});

	test("frame: below the minimum frame width the rows are unframed and cut to the width", () => {
		expect(draw(ACTIVITY_TYPE, recalled, 6)).toMatchSnapshot();
	});

	test("card: repeated renders at the same width return the same rows array", () => {
		const renderer = renderers[ACTIVITY_TYPE];
		if (renderer === undefined) throw new Error("activity renderer missing");
		const component = renderer({ content: "", details: recalled }, { expanded: false }, theme);
		const first = component?.render(60);
		expect(component?.render(60)).toBe(first);
	});

	test("activityRows: a recalled-lessons notice draws its header, source, outcome, count, three names, hidden count and detail", () => {
		expect(draw(ACTIVITY_TYPE, recalled, 60)).toMatchSnapshot();
	});

	test("activityRows: details that are not a v1 notice draw the unavailable line", () => {
		expect(draw(ACTIVITY_TYPE, { kind: "nope" }, 60)).toMatchSnapshot();
	});
});

describe("activity header (activityHeader) and fallback line (activityFallbackLine)", () => {
	test("activityHeader: each activity kind has its fixed header in the plain fallback line", () => {
		const lines = [
			{ v: 1, kind: "teachable-created", title: "Created moment" } satisfies ActivityNotice,
			{
				v: 1,
				kind: "teachable-failed",
				title: "Capture failed",
				outcome: "error",
				source: "hindsight",
			} satisfies ActivityNotice,
			{
				v: 1,
				kind: "teachable-recalled",
				title: "Recalled",
				count: 2,
				source: "local",
			} satisfies ActivityNotice,
			{ v: 1, kind: "skill-recalled", title: "Skill", count: 1 } satisfies ActivityNotice,
			{
				v: 1,
				kind: "resource",
				title: "Substrate read",
				outcome: "ok",
				source: "substrate",
			} satisfies ActivityNotice,
		].map(activityFallbackLine);
		expect(lines).toMatchSnapshot();
	});
});

describe("insight card rows (insightRows)", () => {
	test("insightRows: the compact card shows scope, latest decision, lessons, autonomy and counts in its rows", () => {
		expect(draw(INSIGHT_TYPE, insight, 80, false)).toMatchSnapshot();
	});

	test("insightRows: the expanded card lists Jev decisions, lessons, skills, the policy footer and limitations", () => {
		expect(draw(INSIGHT_TYPE, insight, 80, true)).toMatchSnapshot();
	});

	test("insightRows: a narrow expanded card wraps its detail lines within the width", () => {
		expect(draw(INSIGHT_TYPE, insight, 30, true)).toMatchSnapshot();
	});

	test("insightRows: an empty snapshot renders the no-history lines in both card sizes", () => {
		const empty = {
			...insight,
			decisions: [],
			lessons: [],
			counts: { candidate: 0, confirmed: 0, promoted: 0, superseded: 0 },
			eligible: 0,
			promoted: 0,
			partial: false,
			limitations: [],
		};
		expect({
			compact: draw(INSIGHT_TYPE, empty, 80, false),
			expanded: draw(INSIGHT_TYPE, empty, 80, true),
		}).toMatchSnapshot();
	});

	test("insightRows: details that fail validation render the unavailable fallback", () => {
		expect(draw(INSIGHT_TYPE, { project: 1 }, 80, false)).toMatchSnapshot();
	});
});
