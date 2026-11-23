// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Double Uplift host UI (SCR-DenseGraph, SCR-StageLineCounts, SCR-UpliftedPromptSummary,
 * SCR-FullPromptBeneath, SCR-TrackerLinksPerNode, SCR-DispatchGate; AC-53..AC-58). Synthetic fixtures only.
 */
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import { paint } from "./omp-paint.ts";
import {
	dispatchGateRows,
	DOUBLE_UPLIFT_ORDER_LINES,
	finalPromptLineCount,
	fullPromptSectionRows,
	promptAccountingRows,
	registerUltrathinkRenderers,
	stageLineCountRows,
} from "./omp-render.ts";
import { buildPlanView, type PlanView } from "./view.ts";

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
const p = paint(theme);

/** A 7-node Double Uplift record: 1 graph + 7 node chains + 2 uplifts = 10. */
function record7(): SessionRecord {
	const nodes = Array.from({ length: 7 }, (_, i) => ({
		id: `n${i + 1}`,
		title: `Node ${i + 1}`,
		kind: "generate" as const,
		question: "q",
		dependsOn: i === 0 ? [] : [`n${i}`],
		conclusion: `done n${i + 1}`,
	}));
	return {
		sessionId: "s-double",
		at: 1,
		engine: "claude:claude-haiku-5-5",
		result: {
			xml: "<spec>\n<node>n1</node>\n</spec>",
			original: "add",
			root: "BUILD_PROMPT",
			source: "llm",
		},
		graph: { goal: "Restore dense prompts", nodes },
		clarifications: [],
	};
}

describe("buildPlanView double uplift projection", () => {
	test("derives the 10-prompt accounting line from the node count (AC-56)", () => {
		const view = buildPlanView(record7(), 0);
		expect(view.nodes).toHaveLength(7);
		expect(view.promptAccounting).toBe("1 graph + 7 node chains + 2 uplifts = 10");
	});

	test("projects recorded stageMetrics verbatim and drops malformed rows (AC-53)", () => {
		const withMetrics = {
			...record7(),
			stageMetrics: {
				stages: [
					{ stage: "graph", lines: 7 },
					{ stage: "per-node-cot", lines: 98 },
					{ stage: "uplift-xml", lines: 120 },
					{ stage: "issues-injected", lines: 160 },
					{ stage: "second-uplift", lines: 510 },
					{ stage: "final", lines: 512 },
					{ stage: "bad", lines: -1 },
					{ stage: 42, lines: 5 },
				],
				densityLossStage: "uplift-xml",
			},
		} as unknown as SessionRecord;
		const view = buildPlanView(withMetrics, 0);
		expect(view.stageMetrics?.stages).toHaveLength(6);
		expect(view.stageMetrics?.stages[0]).toEqual({ stage: "graph", lines: 7 });
		expect(view.stageMetrics?.densityLossStage).toBe("uplift-xml");
		expect(buildPlanView(record7(), 0).stageMetrics).toBeUndefined();
	});

	test("projects dispatchGate from the record, else derives it from the final prompt (AC-58)", () => {
		expect(buildPlanView(record7(), 0).dispatchGate).toEqual({
			specialistsBeforeFinal: 0,
			finalPromptLanded: true,
		});
		const pending = buildPlanView(
			{ ...record7(), result: { ...record7().result, xml: "" } } as SessionRecord,
			0,
		);
		expect(pending.dispatchGate).toBeUndefined();
		const recorded = buildPlanView(
			{
				...record7(),
				dispatchGate: { specialistsBeforeFinal: 0, finalPromptLanded: false },
			} as unknown as SessionRecord,
			0,
		);
		expect(recorded.dispatchGate?.finalPromptLanded).toBe(false);
	});
});

describe("double uplift row builders", () => {
	const view = buildPlanView(record7(), 0);

	test("stage rows use the [stage] lines:<n> format and name the density-loss stage (AC-53)", () => {
		const metricsView: PlanView = {
			...view,
			stageMetrics: {
				stages: [
					{ stage: "graph", lines: 7 },
					{ stage: "final", lines: 512 },
				],
				densityLossStage: "uplift-xml",
			},
		};
		const text = stageLineCountRows(metricsView, p).join("\n");
		expect(text).toContain("[graph] lines:7");
		expect(text).toContain("[final] lines:512");
		expect(text).toContain("[density-loss] stage:uplift-xml");
	});

	test("without recorded metrics the only stage row is the measured final count", () => {
		const rows = stageLineCountRows(view, p);
		expect(rows.join("\n")).toContain("[final] lines:3");
		expect(rows).toHaveLength(1);
	});

	test("accounting row reads 1 graph + 7 node chains + 2 uplifts = 10 (AC-56)", () => {
		expect(promptAccountingRows(view, p).join("\n")).toContain(
			"1 graph + 7 node chains + 2 uplifts = 10",
		);
	});

	test("dispatch banner names the full order and 0 dispatch before the final prompt (AC-58)", () => {
		const text = dispatchGateRows(view, p).join("\n");
		expect(text).toContain(DOUBLE_UPLIFT_ORDER_LINES[0]);
		expect(text).toContain(DOUBLE_UPLIFT_ORDER_LINES[1]);
		expect(text).toContain("0 specialists before final prompt");
		expect(text).toContain("final prompt landed");
	});

	test("full prompt header carries the measured line count and 0 truncation (AC-55, AC-57)", () => {
		const xml = Array.from({ length: 512 }, (_, i) => `<line>${i}</line>`).join("\n");
		const rows = fullPromptSectionRows(xml, p, 96);
		expect(rows[1]).toContain("full prompt · 512 lines · 0 truncation");
		expect(rows.slice(2).join("\n")).toBe(xml);
		expect(finalPromptLineCount(xml)).toBe(512);
	});

	test("expanded plan card renders accounting, stage counts and dispatch order; collapsed does not", () => {
		const renderers: Record<
			string,
			Parameters<Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]>[1]
		> = {};
		registerUltrathinkRenderers({
			registerMessageRenderer: (type, renderer) => void (renderers[type] = renderer),
		});
		const renderPlan = renderers["ultrathink-plan"]!;
		const expanded = renderPlan({ content: "", details: view }, { expanded: true }, theme)!
			.render(100)
			.join("\n");
		expect(expanded).toContain("1 graph + 7 node chains + 2 uplifts = 10");
		expect(expanded).toContain("[final] lines:3");
		expect(expanded).toContain(DOUBLE_UPLIFT_ORDER_LINES[0]);
		expect(expanded).toContain(DOUBLE_UPLIFT_ORDER_LINES[1]);
		expect(expanded).toContain(DOUBLE_UPLIFT_ORDER_LINES[2]);
		const collapsed = renderPlan({ content: "", details: view }, { expanded: false }, theme)!
			.render(100)
			.join("\n");
		expect(collapsed).not.toContain(DOUBLE_UPLIFT_ORDER_LINES[0]);
	});
});
