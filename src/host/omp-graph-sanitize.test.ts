// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { type GraphModel, type GraphRenderOptions, renderGraph } from "./omp-graph.ts";

const FG = [
	"accent",
	"muted",
	"dim",
	"success",
	"warning",
	"error",
	"borderMuted",
	"borderAccent",
	"customMessageLabel",
	"customMessageText",
];
const theme = {
	fg(color: string, text: string) {
		if (!FG.includes(color)) throw new Error(`Unknown theme color: ${color}`);
		return `\x1b[38;5;${FG.indexOf(color) + 1}m${text}\x1b[39m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	status: { running: "RR", success: "OK", error: "XX", warning: "WW", pending: ".." },
	getSpinnerFrames: () => ["S0", "S1"],
};

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_52 = `${ESC}]52;c;aGVsbG8=${BEL}`;
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const options: GraphRenderOptions = { now: 0, steps: "all", animate: false };

/** Rows with the theme's own colour codes removed: anything left is control text from the model. */
const plainRows = (model: GraphModel) =>
	renderGraph(model, theme, 80, options).join("\n").replace(SGR, "");

describe("renderGraph terminal sanitization", () => {
	test("a node title that contains an OSC 52 escape renders without the escape byte, and the rest of the title is kept", () => {
		const model: GraphModel = {
			nodes: [
				{
					id: "n1",
					title: `Plan ${OSC_52}the work`,
					kind: "generate",
					dependsOn: [],
					status: "done",
					steps: [],
				},
			],
		};
		const text = plainRows(model);
		expect(text).not.toContain(ESC);
		expect(text).not.toContain("]52;");
		expect(text).toContain("Plan the work");
	});

	test("step titles and issue identifiers are sanitized the same way", () => {
		const model: GraphModel = {
			nodes: [
				{
					id: "n1",
					title: "Plan",
					kind: "generate",
					dependsOn: [],
					status: "done",
					steps: [
						{
							step: 1,
							title: `Wire ${OSC_52}the step`,
							issue: { identifier: `ENG${OSC_52}-1`, url: "u" },
						},
					],
				},
			],
		};
		const text = plainRows(model);
		expect(text).not.toContain(ESC);
		expect(text).toContain("Wire the step");
		expect(text).toContain("ENG-1");
	});
});
