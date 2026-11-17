// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { disabledKnowledgeLookup } from "../greptile/knowledge.ts";
import { knowledgeLookupToPanel } from "../recall/panel-model.ts";
import { PLAN_TYPE, registerUltrathinkRenderers } from "./omp-render.ts";
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
