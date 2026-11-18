// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Text renderer for one information-panel envelope. Pure: it reads no clock and no filesystem; the render time and the
 * record reference come in through the context. Every returned row fits within `width` terminal columns, and every
 * state carries a text label, so no state is told apart by color alone.
 */
import type { KnowledgeStage } from "../greptile/knowledge-probe.ts";
import { formatElapsed, truncateToWidth } from "../host/omp-paint.ts";
import { type PanelBody, type PanelEnvelope, type PanelItem, panelCounts } from "./panel-model.ts";

export interface PanelRenderContext {
	/** Header label of this panel's source, supplied by the caller: e.g. "Greptile knowledge base", "Lessons", "Skills". */
	label: string;
	/** Render time, epoch ms. A loading panel shows elapsed time from its `startedAt`; without it the elapsed time reads "unknown". */
	now?: number;
	/** Reference of the record the panel belongs to. Shown on error; envelopes do not carry one. */
	recordRef?: string;
}

type EmptyReason = Extract<PanelEnvelope, { status: "empty" }>["reason"];
type PartialReason = Extract<PanelEnvelope, { status: "partial" }>["remainder"];
type ErrorEnvelope = Extract<PanelEnvelope, { status: "error" }>;

const SKELETON = "░".repeat(12);
const CONTROL_RUN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;

const STATUS_TAG: Record<PanelEnvelope["status"], string> = {
	loading: "LOADING",
	success: "SUCCESS",
	empty: "EMPTY",
	partial: "PARTIAL",
	error: "ERROR",
};

const EMPTY_LABEL: Record<EmptyReason, string> = {
	no_match: "no document matched the query",
	index_empty: "the index has no documents",
	filtered: "candidates were filtered out",
	below_floor: "every candidate scored below the floor",
	not_generated: "the knowledge base has not been generated",
	gate_off: "this source is switched off",
	source_unavailable: "no credential or login for the knowledge base",
};

const PARTIAL_LABEL: Record<PartialReason, string> = {
	timeout: "the lookup timed out before it finished",
	budget_cap: "the budget cap stopped the lookup",
	truncated: "the output was cut short",
};

/** Make untrusted text one line: control and bidi characters become spaces, whitespace runs collapse. */
function oneLine(text: string): string {
	return text.replace(CONTROL_RUN, " ").replace(/\s+/g, " ").trim();
}

function formatTime(ms: number | null): string {
	if (ms === null) return "no time";
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "invalid time" : date.toISOString();
}

/** A list row: a fixed-width kind column, then the row text. */
function row(kind: "item" | "excluded" | "missing" | "stage", text: string): string {
	return `  ${kind.padEnd(9)}${text}`;
}

function itemText(item: PanelItem): string {
	const fields = [
		`[${item.itemStatus}] ${oneLine(item.id)}`,
		oneLine(item.title),
		oneLine(item.preview),
		`${item.source.kind}:${oneLine(item.source.ref)}`,
		formatTime(item.timestamp),
		`match: ${oneLine(item.matchReason)}`,
	];
	if (item.score) {
		fields.push(
			`score ${item.score.value.toFixed(2)} (${item.score.kind}, ${item.score.direction})`,
		);
	}
	return fields.filter((field) => field !== "").join(" · ");
}

function stageRows(stages: KnowledgeStage[]): string[] {
	return stages.map((stage) => {
		const outcome = stage.errorClass === null ? "ok" : `error ${stage.errorClass}`;
		return row(
			"stage",
			`${stage.name} · in ${stage.inCount} · out ${stage.outCount} · ${stage.durationMs} ms · ${outcome}`,
		);
	});
}

function bodyRows(body: PanelBody): string[] {
	return [
		...body.items.map((item) => row("item", itemText(item))),
		...body.excluded.map((entry) =>
			row("excluded", `${oneLine(entry.ref)} · reason: ${entry.reason}`),
		),
		...body.missing.map((entry) =>
			row("missing", `${oneLine(entry.ref)} · reason: ${entry.reason}`),
		),
		...stageRows(body.stages),
	];
}

function countsLine(panel: PanelEnvelope): string {
	const counts = panelCounts(panel);
	return `  counts: requested ${counts.requested} · returned ${counts.returned} · excluded ${counts.excluded} · missing ${counts.missing}`;
}

function retryText(retry: ErrorEnvelope["retry"]): string {
	if (!retry.scheduled) return "not scheduled";
	const when = retry.retryAt === undefined ? "" : ` at ${formatTime(retry.retryAt)}`;
	return `scheduled, attempt ${retry.attempt}${when}`;
}

function panelLines(panel: PanelEnvelope, context: PanelRenderContext): string[] {
	const head = `[${STATUS_TAG[panel.status]}] ${oneLine(context.label)}`;
	switch (panel.status) {
		case "loading": {
			const elapsed =
				context.now === undefined
					? "elapsed unknown"
					: `elapsed ${formatElapsed(context.now - panel.startedAt)}`;
			return [`${head} ${SKELETON} ${elapsed}`];
		}
		case "success":
			return [head, countsLine(panel), ...bodyRows(panel)];
		case "empty": {
			const removed = [...new Set(panel.excluded.map((entry) => entry.reason))];
			return [
				head,
				`  reason: ${panel.reason} — ${EMPTY_LABEL[panel.reason]}`,
				...(removed.length > 0 ? [`  removed by: ${removed.join(", ")}`] : []),
				countsLine(panel),
				...bodyRows(panel),
			];
		}
		case "partial":
			return [
				head,
				`  remainder: ${panel.remainder} — ${PARTIAL_LABEL[panel.remainder]}`,
				countsLine(panel),
				...bodyRows(panel),
			];
		case "error":
			return [
				head,
				`  class: ${panel.errorClass}`,
				`  message: ${oneLine(panel.message)}`,
				`  retry: ${retryText(panel.retry)}`,
				`  record: ${context.recordRef === undefined ? "not attached" : oneLine(context.recordRef)}`,
				...stageRows(panel.stages),
			];
	}
}

/**
 * Draw one panel envelope as text rows, each at most `width` terminal columns. A width below one column yields no rows.
 * Long text is cut with an ellipsis by the shared truncation helper.
 */
export function renderPanel(
	panel: PanelEnvelope,
	width: number,
	context: PanelRenderContext,
): string[] {
	const columns = Math.floor(width);
	if (!(columns >= 1)) return [];
	return panelLines(panel, context).map((line) => truncateToWidth(line, columns));
}
