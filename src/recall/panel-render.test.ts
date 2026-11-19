// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { KnowledgeStage } from "../greptile/knowledge-probe.ts";
import { visibleWidth } from "../host/omp-paint.ts";
import type { PanelEnvelope, PanelItem } from "./panel-model.ts";
import { type PanelRenderContext, renderPanel } from "./panel-render.ts";

const T0 = 1_700_000_000_000;
const WIDE = 400;
const KNOWLEDGE = "Greptile knowledge base";
const CTX: PanelRenderContext = {
	label: KNOWLEDGE,
	now: 1_000 + 65_000,
	recordRef: "session-record/7f3a",
};
const HEADER: PanelRenderContext = { label: KNOWLEDGE };

const ITEM_ROW = "  item ";
const EXCLUDED_ROW = "  excluded ";
const MISSING_ROW = "  missing ";
const STAGE_ROW = "  stage ";

const STAGES: KnowledgeStage[] = [
	{ name: "gate", inCount: 1, outCount: 1, durationMs: 0, errorClass: null },
	{
		name: "lexical_match",
		inCount: 3,
		outCount: 2,
		durationMs: 4,
		errorClass: null,
		scores: [2.5, 1.25],
	},
];

function item(id: string, over: Partial<PanelItem> = {}): PanelItem {
	const ref = id.replace(/^doc:/, "");
	return {
		id,
		title: ref,
		preview: "First paragraph of the document.",
		source: { kind: "greptile_doc", ref },
		timestamp: T0,
		matchReason: "Routed from the Greptile knowledge base index",
		itemStatus: "returned",
		...over,
	};
}

type Envelope<S extends PanelEnvelope["status"]> = Extract<PanelEnvelope, { status: S }>;

const LOADING: Envelope<"loading"> = { status: "loading", startedAt: 1_000 };

const SUCCESS: Envelope<"success"> = {
	status: "success",
	items: [
		item("doc:docs/a.md", {
			score: { kind: "lexical_overlap", value: 2.5, direction: "higher_is_better" },
		}),
		item("doc:index.md", { itemStatus: "injected" }),
	],
	excluded: [{ ref: "docs/b.md", reason: "cooldown" }],
	missing: [{ ref: "docs/c.md", reason: "not_generated" }],
	stages: STAGES,
};

const EMPTY: Envelope<"empty"> = {
	status: "empty",
	reason: "below_floor",
	items: [],
	excluded: [
		{ ref: "docs/d.md", reason: "below_floor" },
		{ ref: "docs/e.md", reason: "filtered" },
	],
	missing: [],
	stages: STAGES,
};

const PARTIAL: Envelope<"partial"> = {
	status: "partial",
	remainder: "budget_cap",
	items: [item("doc:index.md")],
	excluded: [],
	missing: [{ ref: "docs/f.md", reason: "source_unavailable" }],
	stages: [],
};

const ERROR: Envelope<"error"> = {
	status: "error",
	errorClass: "timeout",
	message: "Knowledge lookup timed out after 5000 ms.",
	retry: { scheduled: true, attempt: 1, retryAt: T0 + 30_000 },
	stages: STAGES,
};

function rowsStarting(rows: string[], prefix: string): string[] {
	return rows.filter((line) => line.startsWith(prefix));
}

describe("renderPanel states", () => {
	test("loading renders one skeleton line with the source name and elapsed time", () => {
		const rows = renderPanel(LOADING, WIDE, CTX);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("[LOADING] Greptile knowledge base");
		expect(rows[0]).toContain("elapsed 1:05");
	});

	test("loading without a render time says the elapsed time is unknown", () => {
		const [row] = renderPanel(LOADING, WIDE, HEADER);
		expect(row).toContain("elapsed unknown");
	});

	test("loading shows the elapsed time from the supplied clock", () => {
		const [row] = renderPanel(LOADING, WIDE, {
			label: "Lessons",
			now: LOADING.startedAt + 3_723_000,
		});
		expect(row).toContain("[LOADING] Lessons ");
		expect(row).toContain("elapsed 62:03");
	});

	test.each([
		["knowledge", "Greptile knowledge base"],
		["lessons", "Lessons"],
		["skills", "Skills"],
		["substrate", "Substrate brief"],
	])("the %s panel header is its source label", (_source, label) => {
		expect(renderPanel(SUCCESS, WIDE, { label })[0]).toBe(`✓ [SUCCESS] ${label}`);
		expect(renderPanel(ERROR, WIDE, { label })[0]).toBe(`✗ [ERROR] ${label}`);
	});

	test("success lists each item with its fields and score only when it carries one", () => {
		const rows = renderPanel(SUCCESS, WIDE, HEADER);
		expect(rows[0]).toBe("✓ [SUCCESS] Greptile knowledge base");
		const [withScore, withoutScore] = rowsStarting(rows, ITEM_ROW);
		expect(withScore).toContain("[returned] doc:docs/a.md");
		expect(withScore).toContain("docs/a.md · First paragraph of the document.");
		expect(withScore).toContain("greptile_doc:docs/a.md");
		expect(withScore).toContain(new Date(T0).toISOString());
		expect(withScore).toContain("match: Routed from the Greptile knowledge base index");
		expect(withScore).toContain("score 2.50 (lexical_overlap, higher_is_better)");
		expect(withoutScore).toContain("[injected] doc:index.md");
		expect(withoutScore).not.toContain("score ");
	});

	test("empty shows the reason label, the reasons that removed results, and the stage ladder", () => {
		const rows = renderPanel(EMPTY, WIDE, HEADER);
		expect(rows[0]).toBe("○ [EMPTY] Greptile knowledge base");
		expect(rows).toContain("  reason: below_floor — every candidate scored below the floor");
		expect(rows).toContain("  removed by: below_floor, filtered");
		expect(rowsStarting(rows, STAGE_ROW)).toEqual([
			"  stage    gate · in 1 · out 1 · 0 ms · ok",
			"  stage    lexical_match · in 3 · out 2 · 4 ms · ok",
		]);
	});

	test("partial shows the returned item and the remainder reason", () => {
		const rows = renderPanel(PARTIAL, WIDE, HEADER);
		expect(rows[0]).toBe("◐ [PARTIAL] Greptile knowledge base");
		expect(rows).toContain("  remainder: budget_cap — the budget cap stopped the lookup");
		expect(rowsStarting(rows, ITEM_ROW)).toHaveLength(1);
		expect(rowsStarting(rows, ITEM_ROW)[0]).toContain("[returned] doc:index.md");
	});

	test("error shows the class, the sanitized message, the retry state and the record reference", () => {
		const rows = renderPanel(ERROR, WIDE, CTX);
		expect(rows[0]).toBe("✗ [ERROR] Greptile knowledge base");
		expect(rows).toContain("  class: timeout");
		expect(rows).toContain("  message: Knowledge lookup timed out after 5000 ms.");
		expect(rows).toContain(
			`  retry: scheduled, attempt 1 at ${new Date(T0 + 30_000).toISOString()}`,
		);
		expect(rows).toContain("  record: session-record/7f3a");
	});

	test("error without a retry or a record reference says so", () => {
		const rows = renderPanel(
			{
				status: "error",
				errorClass: "unclassified",
				message: "boom",
				retry: { scheduled: false, attempt: 0 },
				stages: [],
			},
			WIDE,
			HEADER,
		);
		expect(rows).toContain("  retry: not scheduled");
		expect(rows).toContain("  record: not attached");
	});
});

describe("renderPanel rows", () => {
	test.each([
		["success", SUCCESS, 2, 1, 1],
		["empty", EMPTY, 0, 2, 0],
		["partial", PARTIAL, 1, 0, 1],
	] as [string, PanelEnvelope, number, number, number][])(
		"header counts match the list lengths for %s",
		(_name, panel, returned, excluded, missing) => {
			const rows = renderPanel(panel, WIDE, HEADER);
			expect(rows).toContain(
				`  counts: requested ${returned + excluded + missing} · returned ${returned} · excluded ${excluded} · missing ${missing}`,
			);
			expect(rowsStarting(rows, ITEM_ROW)).toHaveLength(returned);
			expect(rowsStarting(rows, EXCLUDED_ROW)).toHaveLength(excluded);
			expect(rowsStarting(rows, MISSING_ROW)).toHaveLength(missing);
		},
	);

	test("excluded and missing rows show their closed-enum reasons as text", () => {
		expect(renderPanel(SUCCESS, WIDE, HEADER)).toEqual(
			expect.arrayContaining([
				"  excluded docs/b.md · reason: cooldown",
				"  missing  docs/c.md · reason: not_generated",
			]),
		);
		expect(renderPanel(EMPTY, WIDE, HEADER)).toEqual(
			expect.arrayContaining([
				"  excluded docs/d.md · reason: below_floor",
				"  excluded docs/e.md · reason: filtered",
			]),
		);
		expect(renderPanel(PARTIAL, WIDE, HEADER)).toContain(
			"  missing  docs/f.md · reason: source_unavailable",
		);
	});

	test("stage rows appear only when the envelope carries stages", () => {
		expect(rowsStarting(renderPanel(PARTIAL, WIDE, HEADER), STAGE_ROW)).toEqual([]);
		expect(rowsStarting(renderPanel(SUCCESS, WIDE, HEADER), STAGE_ROW)).toHaveLength(STAGES.length);
	});

	test("a long preview is cut to the width with an ellipsis", () => {
		const long: Envelope<"success"> = {
			...SUCCESS,
			items: [item("doc:long.md", { preview: "alpha beta gamma ".repeat(30) })],
		};
		const row = rowsStarting(renderPanel(long, 60, HEADER), ITEM_ROW)[0] ?? "";
		expect(row.endsWith("…")).toBe(true);
		expect(visibleWidth(row)).toBe(60);
		expect(row).toContain("alpha beta");
	});

	test("no row is wider than the width, at every width", () => {
		const panels: PanelEnvelope[] = [LOADING, SUCCESS, EMPTY, PARTIAL, ERROR];
		const violations: string[] = [];
		for (const panel of panels) {
			for (let width = 1; width <= 120; width++) {
				for (const line of renderPanel(panel, width, CTX)) {
					if (visibleWidth(line) > width) violations.push(`${panel.status}@${width}: ${line}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("a width below one column renders no rows", () => {
		expect(renderPanel(SUCCESS, 0, HEADER)).toEqual([]);
	});

	test("line breaks and terminal escapes in untrusted text neither split nor style a row", () => {
		const hostile: Envelope<"success"> = {
			...SUCCESS,
			items: [],
			excluded: [{ ref: "docs/a\n\u001b[2J\u001b[31mb.md", reason: "cooldown" }],
			missing: [],
		};
		const rows = renderPanel(hostile, WIDE, HEADER);
		expect(rows.some((line) => line.includes("\n") || line.includes("\u001b"))).toBe(false);
		expect(rowsStarting(rows, EXCLUDED_ROW)).toEqual([
			"  excluded docs/a [2J [31mb.md · reason: cooldown",
		]);
	});

	test("the panel renders no terminal escape sequences in any state", () => {
		const panels: PanelEnvelope[] = [LOADING, SUCCESS, EMPTY, PARTIAL, ERROR];
		const violations: string[] = [];
		for (const panel of panels) {
			for (const width of [WIDE, 40]) {
				const rows = renderPanel(panel, width, CTX);
				expect(rows.length).toBeGreaterThan(0);
				for (const line of rows) {
					if (line.includes("\u001b")) violations.push(`${panel.status}@${width}: ${line}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});

describe("renderPanel status icons", () => {
	test.each([
		["loading", LOADING, "◌"],
		["success", SUCCESS, "✓"],
		["empty", EMPTY, "○"],
		["partial", PARTIAL, "◐"],
		["error", ERROR, "✗"],
	] as [string, PanelEnvelope, string][])(
		"the %s state renders its icon and its text label",
		(status, panel, icon) => {
			const [header] = renderPanel(panel, WIDE, HEADER);
			expect(header?.startsWith(`${icon} `)).toBe(true);
			expect(header).toContain(`[${status.toUpperCase()}]`);
		},
	);

	test("each state has a distinct icon", () => {
		const icons = [LOADING, SUCCESS, EMPTY, PARTIAL, ERROR].map(
			(panel) => renderPanel(panel, WIDE, HEADER)[0]?.split(" ")[0],
		);
		expect(new Set(icons).size).toBe(5);
	});

	test("an empty panel names the filter or threshold that removed its candidates", () => {
		const rows = renderPanel({ ...EMPTY, appliedFilterOrThreshold: "min score 2.0" }, WIDE, HEADER);
		expect(rows).toContain("  applied: min score 2.0");
	});

	test("an empty panel without one shows no applied row", () => {
		expect(rowsStarting(renderPanel(EMPTY, WIDE, HEADER), "  applied")).toEqual([]);
	});
});
