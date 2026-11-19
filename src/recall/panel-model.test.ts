// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { KnowledgeLookup, KnowledgeStage } from "../greptile/knowledge-probe.ts";
import {
	knowledgeLookupToPanel,
	type PanelBody,
	type PanelEnvelope,
	type PanelItem,
	PREVIEW_MAX_CHARS,
	type PanelSurface,
	panelCounts,
	panelTriggerFromPlanner,
	sanitizePanelText,
	withPanelMeta,
} from "./panel-model.ts";

function lookup(over: Partial<KnowledgeLookup>): KnowledgeLookup {
	return { outcome: "used", docs: [], chars: 0, ms: 0, ...over };
}

function item(id: string, itemStatus: PanelItem["itemStatus"]): PanelItem {
	return {
		id,
		title: id,
		preview: "",
		source: { kind: "greptile_doc", ref: id },
		timestamp: null,
		matchReason: "fixture",
		itemStatus,
	};
}

const STAGES: KnowledgeStage[] = [
	{ name: "gate", inCount: 1, outCount: 1, durationMs: 0, errorClass: null },
	{ name: "namespace", inCount: 1, outCount: 0, durationMs: 4, errorClass: "namespace_not_found" },
];

const mixedBody: PanelBody = {
	items: [item("a.md", "returned"), item("b.md", "injected"), item("c.md", "deduped")],
	excluded: [
		{ ref: "d.md", reason: "below_floor" },
		{ ref: "e.md", reason: "cooldown" },
	],
	missing: [{ ref: "f.md", reason: "source_unavailable" }],
	stages: STAGES,
};

describe("panelCounts", () => {
	test("header counts equal the list lengths for a mixed fixture", () => {
		const panels: PanelEnvelope[] = [
			{ status: "success", ...mixedBody },
			{ status: "partial", remainder: "budget_cap", ...mixedBody },
		];
		for (const panel of panels) {
			expect(panelCounts(panel)).toEqual({ requested: 6, returned: 3, excluded: 2, missing: 1 });
		}
		const counts = panelCounts({ status: "success", ...mixedBody });
		expect(counts.returned).toBe(mixedBody.items.length);
		expect(counts.excluded).toBe(mixedBody.excluded.length);
		expect(counts.missing).toBe(mixedBody.missing.length);
	});

	test("loading and error envelopes carry no list counts", () => {
		expect(panelCounts({ status: "loading", startedAt: 1 })).toEqual({
			requested: 0,
			returned: 0,
			excluded: 0,
			missing: 0,
		});
		const failed = knowledgeLookupToPanel(lookup({ outcome: "error", reasonCode: "timeout" }));
		expect(panelCounts(failed)).toEqual({ requested: 0, returned: 0, excluded: 0, missing: 0 });
	});
});

describe("knowledgeLookupToPanel status transitions", () => {
	test.each([
		["used", lookup({ outcome: "used", docs: ["index.md"], chars: 10, ms: 3 }), "success"],
		["none with no match", lookup({ outcome: "none", reasonCode: "no_route_match" }), "empty"],
		["off with the gate closed", lookup({ outcome: "off", reasonCode: "disabled" }), "empty"],
		["error", lookup({ outcome: "error", reasonCode: "transport_error" }), "error"],
	] as const)("%s becomes %s", (_name, record, status) => {
		expect(knowledgeLookupToPanel(record).status).toBe(status);
	});
});

describe("knowledgeLookupToPanel", () => {
	test("used maps each read document to a returned item, index.md first", () => {
		const panel = knowledgeLookupToPanel(
			lookup({
				outcome: "used",
				docs: ["index.md", "src/auth.md"],
				chars: 40,
				ms: 9,
				stages: STAGES,
			}),
		);
		expect(panel.status).toBe("success");
		if (panel.status !== "success") return;
		expect(panel.items.map((i) => i.id)).toEqual(["doc:index.md", "doc:src/auth.md"]);
		expect(
			panel.items.every((i) => i.itemStatus === "returned" && i.source.kind === "greptile_doc"),
		).toBe(true);
		expect(panel.stages).toBe(STAGES);
	});

	test("none is empty, never an error, and maps the namespace miss to not_generated", () => {
		const panel = knowledgeLookupToPanel(
			lookup({ outcome: "none", reasonCode: "namespace_not_found" }),
		);
		expect(panel).toMatchObject({ status: "empty", reason: "not_generated" });
		expect(panel.status).not.toBe("error");
	});

	test.each([
		["no_documents", "index_empty"],
		["routing_table_missing", "index_empty"],
		["no_route_match", "no_match"],
	] as const)("none with %s is empty with %s", (reasonCode, reason) => {
		expect(knowledgeLookupToPanel(lookup({ outcome: "none", reasonCode }))).toMatchObject({
			status: "empty",
			reason,
		});
	});

	test("a gate-off record is empty with gate_off and not an error", () => {
		const panel = knowledgeLookupToPanel(lookup({ outcome: "off", reasonCode: "disabled" }));
		expect(panel).toMatchObject({ status: "empty", reason: "gate_off" });
		expect(panel.status).not.toBe("error");
	});

	test("a missing credential is empty with source_unavailable, not gate_off", () => {
		const panel = knowledgeLookupToPanel(lookup({ outcome: "off", reasonCode: "no_credential" }));
		expect(panel).toMatchObject({ status: "empty", reason: "source_unavailable" });
	});

	test("an error outcome is error, classed by its reason, with no retry scheduled", () => {
		const panel = knowledgeLookupToPanel(
			lookup({
				outcome: "error",
				reasonCode: "timeout",
				reason: "lookup timed out",
				stages: STAGES,
			}),
		);
		expect(panel).toEqual({
			status: "error",
			errorClass: "timeout",
			message: "lookup timed out",
			retry: { scheduled: false, attempt: 0 },
			stages: STAGES,
		});
	});

	test("an error record without a reason code is classed unclassified and still an error", () => {
		const panel = knowledgeLookupToPanel(lookup({ outcome: "error" }));
		expect(panel).toMatchObject({ status: "error", errorClass: "unclassified" });
	});

	test("error messages are sanitized before they reach the panel", () => {
		const panel = knowledgeLookupToPanel(
			lookup({
				outcome: "error",
				reasonCode: "transport_error",
				reason: "boom\u001b[2J\u0007 <now>",
			}),
		);
		expect(panel.status).toBe("error");
		if (panel.status !== "error") return;
		expect(panel.message).toBe("boom[2J &lt;now&gt;");
	});
});

describe("sanitizePanelText", () => {
	test("removes control characters and turns line breaks into spaces", () => {
		expect(sanitizePanelText("a\u0007b\u001b\u0000c\u007fd\u0085e", PREVIEW_MAX_CHARS)).toBe(
			"abcde",
		);
		expect(sanitizePanelText("line\none\ttwo", PREVIEW_MAX_CHARS)).toBe("line one two");
	});

	test("removes bidi override characters", () => {
		expect(sanitizePanelText("x\u202eyz", PREVIEW_MAX_CHARS)).toBe("xyz");
	});

	test("escapes markup characters", () => {
		expect(sanitizePanelText(`<b>&"'`, PREVIEW_MAX_CHARS)).toBe("&lt;b&gt;&amp;&quot;&#39;");
	});

	test("caps the preview at the exported length and ends a cut with an ellipsis", () => {
		const out = sanitizePanelText("x".repeat(1000), PREVIEW_MAX_CHARS);
		expect(out.length).toBe(PREVIEW_MAX_CHARS);
		expect(out.endsWith("…")).toBe(true);
	});

	test("a cut never splits an escape entity", () => {
		const out = sanitizePanelText("&".repeat(500), PREVIEW_MAX_CHARS);
		expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
		expect(out).toMatch(/^(&amp;)+…$/);
	});

	test("non-string input yields an empty string", () => {
		expect(sanitizePanelText(undefined, PREVIEW_MAX_CHARS)).toBe("");
		expect(sanitizePanelText(42, PREVIEW_MAX_CHARS)).toBe("");
	});
});

const SURFACES: PanelSurface[] = ["substrate", "teachable_moment", "lesson", "knowledge", "skill"];

const INVOCATION = {
	trigger: "explicit_request" as const,
	query: "how is auth wired",
	filters: ["organization:sent"],
	startedAt: 1_000,
	finishedAt: 1_750,
};

const SUCCESS_BODY: PanelEnvelope = { status: "success", ...mixedBody };

describe("envelope metadata", () => {
	test.each(SURFACES)("the %s envelope carries the metadata fields", (surface) => {
		const panel = withPanelMeta(SUCCESS_BODY, { surface, ...INVOCATION });
		expect(panel).toMatchObject({
			surface,
			trigger: "explicit_request",
			request: {
				source: surface,
				queryPreview: "how is auth wired",
				filters: ["organization:sent"],
				startedAt: 1_000,
			},
			timing: { startedAt: 1_000, finishedAt: 1_750, latencyMs: 750 },
		});
		expect(panel.id).toMatch(new RegExp(`^${surface}-[0-9a-f]{16}$`));
		expect(panel.status).toBe("success");
	});

	test("a knowledge lookup carries the metadata when it is invoked and none when it is not", () => {
		const record = lookup({
			outcome: "used",
			docs: ["index.md"],
			chars: 10,
			ms: 3,
			query: { text: "auth", chars: 4, truncated: false },
			filters: { organization: true, maxDocs: 5 },
		});
		expect(knowledgeLookupToPanel(record)).not.toHaveProperty("id");
		expect(
			knowledgeLookupToPanel(record, { trigger: "scope_change", startedAt: 5, finishedAt: 9 }),
		).toMatchObject({
			surface: "knowledge",
			trigger: "scope_change",
			request: {
				source: "knowledge",
				queryPreview: "auth",
				filters: ["organization:sent", "maxDocs:5"],
			},
			timing: { latencyMs: 4 },
		});
	});

	test.each([
		["scopeChange", "scope_change"],
		["failure", "failure"],
		["phaseBoundary", "phase_boundary"],
		["uncertainty", "uncertainty"],
		["explicit", "explicit_request"],
	] as const)("the planner's %s trigger maps to %s", (planner, panelTrigger) => {
		expect(panelTriggerFromPlanner(planner)).toBe(panelTrigger);
	});

	test("the query preview is sanitized and capped, and a cut ends in an ellipsis", () => {
		const panel = withPanelMeta(SUCCESS_BODY, {
			surface: "lesson",
			trigger: "failure",
			query: "q".repeat(1_000),
			filters: [],
			startedAt: 1,
		});
		const preview = panel.request?.queryPreview ?? "";
		expect(preview.length).toBe(PREVIEW_MAX_CHARS);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("latency is present only with a finish time and is never negative", () => {
		const open = withPanelMeta(SUCCESS_BODY, {
			surface: "skill",
			trigger: "uncertainty",
			query: "",
			filters: [],
			startedAt: 10,
		});
		expect(open.timing).toEqual({ startedAt: 10 });
		expect(open.request?.queryPreview).toBe("");
		expect(open).not.toHaveProperty("rawRef");
		const backwards = withPanelMeta(SUCCESS_BODY, {
			surface: "skill",
			trigger: "uncertainty",
			query: "",
			filters: [],
			startedAt: 10,
			finishedAt: 4,
		});
		expect(backwards.timing?.latencyMs).toBe(0);
	});

	test("rawRef is a pointer: control characters go, the rest is kept, and no record content is inlined", () => {
		const panel = withPanelMeta(SUCCESS_BODY, {
			surface: "substrate",
			trigger: "session_end",
			query: "",
			filters: [],
			startedAt: 1,
			rawRef: "store/brief/a&b\u0007",
		});
		expect(panel.rawRef).toBe("store/brief/a&b");
	});

	test("the id is deterministic per invocation and changes when the invocation changes", () => {
		const first = withPanelMeta(SUCCESS_BODY, { surface: "lesson", ...INVOCATION }).id;
		expect(withPanelMeta(SUCCESS_BODY, { surface: "lesson", ...INVOCATION }).id).toBe(first);
		expect(
			withPanelMeta(SUCCESS_BODY, { surface: "lesson", ...INVOCATION, startedAt: 2_000 }).id,
		).not.toBe(first);
		expect(withPanelMeta(SUCCESS_BODY, { surface: "skill", ...INVOCATION }).id).not.toBe(first);
	});

	test("header counts still equal the list lengths once metadata is attached", () => {
		const panel = withPanelMeta(SUCCESS_BODY, { surface: "substrate", ...INVOCATION });
		expect(panelCounts(panel)).toEqual({ requested: 6, returned: 3, excluded: 2, missing: 1 });
	});

	test("the empty reason keeps its optional applied filter or threshold", () => {
		const panel: PanelEnvelope = {
			status: "empty",
			reason: "below_floor",
			appliedFilterOrThreshold: "min score 2.0",
			items: [],
			excluded: [],
			missing: [],
			stages: [],
		};
		expect(panel).toMatchObject({ appliedFilterOrThreshold: "min score 2.0" });
	});
});
