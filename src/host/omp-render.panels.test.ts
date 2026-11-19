// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { disabledKnowledgeLookup } from "../greptile/knowledge.ts";
import { type PanelEnvelope, knowledgeLookupToPanel } from "../recall/panel-model.ts";
import { PLAN_TYPE, RECALL_TYPE, registerUltrathinkRenderers } from "./omp-render.ts";
import type { PlanView } from "./view.ts";

type Renderer = Parameters<
	Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]
>[1];

/** Plain-text theme: each colour is a visible tag so rows can be compared as plain text. */
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
const renderPlan = renderers[PLAN_TYPE] as Renderer;

const view: PlanView = {
	root: "BUILD_PROMPT",
	source: "llm",
	elapsedMs: 65_000,
	nodes: [
		{ id: "n1", title: "Wire the status bar", kind: "task", wave: 0, dependsOn: [], steps: [] },
		{ id: "n2", title: "Add the panel", kind: "task", wave: 1, dependsOn: ["n1"], steps: [] },
	],
	waves: [["n1"], ["n2"]],
	clarifications: [{ id: "c1", question: "Which DB?", blocking: true, recommended: "Postgres" }],
};

/** The plan card's rows for `details` at `width`; throws when the renderer declines the view. */
function planRows(details: unknown, width = 100): string[] {
	const card = renderPlan({ content: "plan", details }, { expanded: false }, theme);
	if (card === undefined) throw new Error("plan renderer declined the view");
	return [...card.render(width)];
}

describe("plan card with information panels", () => {
	test("a view without a panels key renders the same rows as the same view with panels undefined", () => {
		expect(planRows({ ...view, panels: undefined })).toEqual(planRows(view));
	});

	test("a knowledge panel that never ran adds rows and shows its gate_off label", () => {
		const withPanels = {
			...view,
			panels: { knowledge: knowledgeLookupToPanel(disabledKnowledgeLookup()) },
		};
		const base = planRows(view);
		const rows = planRows(withPanels);
		expect(rows.length).toBeGreaterThan(base.length);
		expect(rows.join("\n")).toContain("gate_off");
	});

	test("a panels entry with no string status renders the same rows as the view without panels", () => {
		expect(planRows({ ...view, panels: { knowledge: { junk: 1 } } })).toEqual(planRows(view));
	});
});

describe("recall card with information panels", () => {
	test("the recall card draws the moments panel", () => {
		const moments: PanelEnvelope = {
			status: "success",
			items: [
				{
					id: "moment-1",
					title: "Check the owner before retrying",
					preview: "Look at the owner and mode of the path first.",
					source: { kind: "lesson", ref: "moment-1" },
					timestamp: null,
					matchReason: "error signature match",
					itemStatus: "returned",
				},
			],
			excluded: [],
			missing: [],
			stages: [],
		};
		const renderRecall = renderers[RECALL_TYPE] as Renderer;

		const card = renderRecall(
			{ content: "recall", details: { moments } },
			{ expanded: true },
			theme,
		);
		if (card === undefined) throw new Error("recall renderer declined the view");
		const text = [...card.render(100)].join("\n");

		expect(text).toContain("Teachable moments");
		expect(text).toContain("Check the owner before retrying");
	});
});

describe("recall card expanded and collapsed (options.expanded)", () => {
	const moments: PanelEnvelope = {
		status: "success",
		items: [
			{
				id: "moment-1",
				title: "Check the owner before retrying",
				preview: "Look at the owner and mode of the path first.",
				source: { kind: "lesson", ref: "moment-1" },
				timestamp: null,
				matchReason: "error signature match",
				itemStatus: "returned",
			},
		],
		excluded: [],
		missing: [],
		stages: [],
	};
	const renderRecall = renderers[RECALL_TYPE] as Renderer;
	const summary = "Recall: moments success";

	function recallText(expanded: boolean, content: unknown = summary): string {
		const card = renderRecall({ content, details: { moments } }, { expanded }, theme);
		if (card === undefined) throw new Error("recall renderer declined the view");
		return [...card.render(100)].join("\n");
	}

	test("expanded shows the full panel rows with their text status labels; collapsed shows only the one-line summary", () => {
		const expanded = recallText(true);
		const collapsed = recallText(false);
		expect(expanded).toContain("✓ [SUCCESS] Teachable moments");
		expect(expanded).toContain("counts: requested 1 · returned 1 · excluded 0 · missing 0");
		expect(expanded).toContain("Check the owner before retrying");
		expect(collapsed).toContain(summary);
		expect(collapsed).not.toContain("Check the owner before retrying");
		expect(collapsed).not.toContain("counts:");
		expect(collapsed.length).toBeLessThan(expanded.length);
	});

	test("collapsed derives its one-line summary from the panel statuses when the content line is absent", () => {
		expect(recallText(false, "")).toContain("Recall: Teachable moments: success");
		expect(recallText(false, "Recall:  moments\nsuccess")).toContain("Recall: moments success");
	});

	test("both states paint through theme tokens and carry no raw hex or rgb colours", () => {
		for (const text of [recallText(true), recallText(false)]) {
			expect(text).toContain("<customMessageLabel>");
			expect(text).toContain("<borderMuted>");
			expect(text).toContain("<bg:customMessageBg>");
			expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
			expect(text).not.toMatch(/rgba?\(/);
		}
	});

	test("the recall renderer is static under reduced motion: repeated renders are identical and animation-free", () => {
		// The host passes no motion input to this renderer, so the card must not depend on the clock either.
		expect(recallText(true)).toEqual(recallText(true));
		expect(recallText(false)).toEqual(recallText(false));
		const card = renderRecall(
			{ content: summary, details: { moments } },
			{ expanded: true },
			theme,
		);
		if (card === undefined) throw new Error("recall renderer declined the view");
		expect([...card.render(100)]).toEqual([...card.render(100)]);
	});
});
