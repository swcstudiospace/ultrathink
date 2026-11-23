// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	buildDispatchGate,
	buildFinalPrompt,
	buildIssuesXml,
	buildStageMetrics,
	countXmlLines,
	extractLinkedIssues,
	injectIssuesXml,
	promptAccounting,
	runSecondUplift,
	type IssueRef,
} from "./double-uplift.ts";
import type { ThoughtGraph } from "./types.ts";

const REFS: IssueRef[] = [
	{ nodeId: "n1", identifier: "SPE-100", url: "https://linear.example/SPE-100" },
	{ nodeId: "n2", identifier: "SPE-101", url: "https://linear.example/SPE-101" },
];

function graph(n: number): ThoughtGraph {
	return {
		goal: "Restore dense prompts",
		nodes: Array.from({ length: n }, (_, i) => ({
			id: `n${i + 1}`,
			title: `Node ${i + 1}`,
			kind: "generate",
			question: `q${i + 1}`,
			dependsOn: i === 0 ? [] : [`n${i}`],
			thinking: Array.from({ length: 6 }, (_, s) => `${s + 1}. step ${s + 1}`).join("\n"),
			conclusion: `done n${i + 1}`,
		})),
	};
}

function denseXml(lines: number): string {
	const header = [
		"<ORIGINAL>x</ORIGINAL>",
		"<SYSTEM_ROLE>r</SYSTEM_ROLE>",
		"<CONTEXT>ctx</CONTEXT>",
		"<SCOPE>s</SCOPE>",
		"<CONSTRAINTS>c</CONSTRAINTS>",
		"<ACCEPTANCE_CRITERIA>ok</ACCEPTANCE_CRITERIA>",
		"<OUT_OF_SCOPE>o</OUT_OF_SCOPE>",
	];
	const body = Array.from(
		{ length: Math.max(0, lines - header.length - 2) },
		(_, i) => `<SECTION_${i}>line ${i}</SECTION_${i}>`,
	);
	return ["<BUILD_PROMPT>", ...header, ...body, "</BUILD_PROMPT>"].join("\n");
}

describe("promptAccounting", (): void => {
	test("AC-56: 1 graph + 7 node chains + 2 uplifts = 10", (): void => {
		expect(promptAccounting(7)).toBe("1 graph + 7 node chains + 2 uplifts = 10");
		expect(promptAccounting(5)).toBe("1 graph + 5 node chains + 2 uplifts = 8");
	});
});

describe("buildStageMetrics (AC-53)", (): void => {
	test("names the density-loss stage from the largest line drop", (): void => {
		const m = buildStageMetrics({
			graph: graph(7),
			upliftXml: denseXml(120),
			issuesXml: `<ISSUES>\n${"x\n".repeat(30)}</ISSUES>`,
			secondUpliftXml: denseXml(512),
			finalXml: denseXml(512),
		});
		expect(m.stages).toHaveLength(6);
		expect(m.stages.map((s) => s.stage)).toEqual([
			"graph",
			"per-node-cot",
			"uplift-xml",
			"issues-injected",
			"second-uplift",
			"final",
		]);
		expect(m.stages[1]!.lines).toBeGreaterThan(0);
		// largest drop: second-uplift (512) -> final (512) is 0; issues-injected (30) vs uplift-xml? uplift-xml 120 -> issues 30 drops 90
		expect(m.density_loss_stage).toBe("issues-injected");
		expect(m.finalPromptLanded).toBe(true);
	});

	test("no shrink anywhere: density loss stage is final", (): void => {
		const m = buildStageMetrics({
			graph: graph(5),
			upliftXml: denseXml(40),
			issuesXml: `<ISSUES>\n${"x\n".repeat(38)}</ISSUES>`,
			secondUpliftXml: denseXml(40),
			finalXml: denseXml(40),
		});
		expect(m.density_loss_stage).toBe("final");
	});
});

describe("ISSUES injection (AC-54)", (): void => {
	test("carries every gateway ref into the final XML", (): void => {
		const first =
			"<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n<ACCEPTANCE_CRITERIA>ok</ACCEPTANCE_CRITERIA>\n</BUILD_PROMPT>";
		const out = injectIssuesXml(first, REFS);
		expect(extractLinkedIssues(out)).toEqual(["SPE-100", "SPE-101"]);
	});

	test("is idempotent: re-injection replaces, never duplicates", (): void => {
		const first =
			"<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n<ACCEPTANCE_CRITERIA>ok</ACCEPTANCE_CRITERIA>\n</BUILD_PROMPT>";
		const once = injectIssuesXml(first, REFS);
		expect(injectIssuesXml(once, REFS)).toBe(once);
	});

	test("empty refs leave the XML untouched", (): void => {
		const first = "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>";
		expect(injectIssuesXml(first, [])).toBe(first);
		expect(buildIssuesXml([])).toBe("<ISSUES></ISSUES>");
	});

	test("escapes identifiers and urls", (): void => {
		const xml = buildIssuesXml([{ nodeId: "n&1", identifier: "A<B", url: "https://x?a=1&b=2" }]);
		expect(xml).not.toContain("A<B");
		expect(xml).toContain("A&lt;B");
	});
});

describe("runSecondUplift", (): void => {
	test("llm pass: returns model XML carrying every link, 10th prompt", async (): Promise<void> => {
		let calls = 0;
		const dense = denseXml(512);
		const complete = async (): Promise<string> => {
			calls += 1;
			return dense;
		};
		const out = await runSecondUplift({
			firstXml:
				"<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n<ACCEPTANCE_CRITERIA>ok</ACCEPTANCE_CRITERIA>\n<SCOPE>s</SCOPE>\n<CONSTRAINTS>c</CONSTRAINTS>\n<SYSTEM_ROLE>r</SYSTEM_ROLE>\n<CONTEXT>ctx</CONTEXT>\n<OUT_OF_SCOPE>o</OUT_OF_SCOPE>\n</BUILD_PROMPT>",
			original: "x",
			issues: REFS,
			complete,
		});
		expect(calls).toBe(1);
		expect(out.source).toBe("llm");
		// Missing ISSUES in the model reply is repaired by injection, never a lie.
		expect(extractLinkedIssues(out.xml)).toEqual(["SPE-100", "SPE-101"]);
		expect(countXmlLines(out.xml)).toBeGreaterThanOrEqual(505);
	});

	test("provider error: fail-open to enriched first XML", async (): Promise<void> => {
		const out = await runSecondUplift({
			firstXml: "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>",
			original: "x",
			issues: REFS,
			complete: async (): Promise<string> => {
				throw new Error("503 down");
			},
		});
		expect(out.source).toBe("fallback");
		expect(out.fallbackReason).toBe("provider_error");
		expect(extractLinkedIssues(out.xml)).toEqual(["SPE-100", "SPE-101"]);
	});

	test("empty reply falls back; abort propagates", async (): Promise<void> => {
		const empty = await runSecondUplift({
			firstXml: "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>",
			original: "x",
			issues: REFS,
			complete: async (): Promise<string> => "   ",
		});
		expect(empty.fallbackReason).toBe("empty_reply");
		const abort = new Error("aborted");
		abort.name = "AbortError";
		await expect(
			runSecondUplift({
				firstXml: "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>",
				original: "x",
				issues: REFS,
				complete: async (): Promise<string> => {
					throw abort;
				},
			}),
		).rejects.toThrow("aborted");
	});
});

describe("buildFinalPrompt + dispatch gate (AC-55, AC-58)", (): void => {
	test("AC-55: 500+ lines, 100% rationales, 0 truncation", (): void => {
		const final = buildFinalPrompt(denseXml(512));
		expect(final.line_count).toBeGreaterThanOrEqual(500);
		expect(final.truncation_markers).toBe(0);
		expect(final.rationale_preserved_pct).toBe(100);
		expect(final.full_prompt_beneath).toBe(true);
		expect(final.linked_issues).toEqual([]);
	});

	test("AC-58: 0 specialists before the final prompt lands", (): void => {
		expect(buildDispatchGate(false)).toEqual({
			specialists_before_final: 0,
			final_prompt_landed: false,
		});
		expect(buildDispatchGate(true).specialists_before_final).toBe(0);
	});

	test("countXmlLines counts real lines", (): void => {
		expect(countXmlLines("")).toBe(0);
		expect(countXmlLines("a\nb\n")).toBe(2);
		expect(countXmlLines("a\nb")).toBe(2);
	});
});
