// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Data model of the information panels: one envelope per panel state, the items plus the excluded and missing rows a
 * lookup leaves behind, the header counts derived from those rows, and the adapter that turns one knowledge-base
 * lookup record into an envelope. Pure: no rendering, no clock, no filesystem. Every free-text value passes the
 * sanitizer before it reaches a panel, and the sanitizer escapes markup, so a renderer must not escape it again.
 */
import type {
	KnowledgeLookup,
	KnowledgeReason,
	KnowledgeStage,
} from "../greptile/knowledge-probe.ts";

export const PREVIEW_MAX_CHARS = 280;
const TITLE_MAX_CHARS = 160;
const REF_MAX_CHARS = 512;
const MESSAGE_MAX_CHARS = 200;

/** Why a panel has nothing to show. Closed. */
type PanelEmptyReason =
	| "no_match"
	| "index_empty"
	| "filtered"
	| "below_floor"
	| "not_generated"
	| "gate_off"
	| "source_unavailable";
/** Why a panel shows only part of what it would show. Closed. */
type PanelPartialReason = "timeout" | "budget_cap" | "truncated";
/** The class of a failed lookup: the probe reason code, or `unclassified` when the record carries none. */
type PanelErrorClass = KnowledgeReason | "unclassified";
/** What became of a returned item after the lookup produced it. */
type PanelItemStatus = "returned" | "injected" | "deduped";
/** Why a candidate was left out of the panel. Closed. */
type PanelExcludedReason =
	| "below_floor"
	| "cooldown"
	| "budget"
	| "dedupe"
	| "filtered"
	| "trimmed_budget";
/** Why an expected source has no item. Closed. */
type PanelMissingReason = "index_empty" | "no_match" | "not_generated" | "source_unavailable";
type PanelSourceKind = "greptile_doc" | "lesson" | "skill" | "substrate_brief";
type PanelScoreKind = "lexical_overlap" | "confidence";
type PanelScoreDirection = "higher_is_better" | "lower_is_better";

interface PanelSource {
	kind: PanelSourceKind;
	ref: string;
}

interface PanelScore {
	kind: PanelScoreKind;
	value: number;
	direction: PanelScoreDirection;
}

export interface PanelItem {
	id: string;
	title: string;
	/** Sanitized and capped to PREVIEW_MAX_CHARS. */
	preview: string;
	source: PanelSource;
	/** Epoch milliseconds, or null when the producer has no time for the item. */
	timestamp: number | null;
	matchReason: string;
	score?: PanelScore;
	itemStatus: PanelItemStatus;
}

interface PanelExcluded {
	ref: string;
	reason: PanelExcludedReason;
	/** The candidate's score when it has one, kept visible so an exclusion can be judged (e.g. below_floor). */
	score?: PanelScore;
}

interface PanelMissing {
	ref: string;
	reason: PanelMissingReason;
}

interface PanelRetry {
	scheduled: boolean;
	/** Retries already attempted; 0 when none has run. */
	attempt: number;
	retryAt?: number;
}

/** The lists and stage ladder every panel state that ran a lookup carries. */
export interface PanelBody {
	items: PanelItem[];
	excluded: PanelExcluded[];
	missing: PanelMissing[];
	stages: KnowledgeStage[];
}

export type PanelEnvelope =
	| { status: "loading"; startedAt: number }
	| ({ status: "success" } & PanelBody)
	| ({ status: "empty"; reason: PanelEmptyReason } & PanelBody)
	| ({ status: "partial"; remainder: PanelPartialReason } & PanelBody)
	| {
			status: "error";
			errorClass: PanelErrorClass;
			/** Sanitized, one line. */
			message: string;
			retry: PanelRetry;
			stages: KnowledgeStage[];
	  };

/**
 * Header counts. `requested` is every row the lookup accounted for: returned items, excluded candidates and missing
 * sources. The other three are the list lengths, so the header and the lists cannot disagree. Loading and error
 * envelopes carry no lists and count as zero.
 */
export interface PanelCounts {
	requested: number;
	returned: number;
	excluded: number;
	missing: number;
}

export function panelCounts(panel: PanelEnvelope): PanelCounts {
	if (panel.status === "loading" || panel.status === "error") {
		return { requested: 0, returned: 0, excluded: 0, missing: 0 };
	}
	const returned = panel.items.length;
	const excluded = panel.excluded.length;
	const missing = panel.missing.length;
	return { requested: returned + excluded + missing, returned, excluded, missing };
}

const LINE_BREAKS = /[\t\n\r\u000b\u000c]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const RUN_OF_SPACE = /\s+/g;
const ELLIPSIS = "…";
const ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** Escape code points one at a time until the next one would overflow `limit`. Never splits an entity. */
function takeEscaped(text: string, limit: number): { out: string; complete: boolean } {
	let out = "";
	for (const ch of text) {
		const piece = ENTITIES[ch] ?? ch;
		if (out.length + piece.length > limit) return { out, complete: false };
		out += piece;
	}
	return { out, complete: true };
}

/**
 * Make untrusted text safe for a panel: line breaks become spaces, control and bidi-override characters are removed,
 * whitespace runs collapse, markup characters are escaped, and the result is at most `maxChars` long. A cut result
 * ends in an ellipsis that counts toward the cap. Non-string input yields "".
 */
export function sanitizePanelText(value: unknown, maxChars: number): string {
	if (typeof value !== "string" || maxChars < 1) return "";
	const cleaned = value
		.replace(LINE_BREAKS, " ")
		.replace(CONTROL_CHARS, "")
		.replace(RUN_OF_SPACE, " ")
		.trim();
	const whole = takeEscaped(cleaned, maxChars);
	if (whole.complete) return whole.out;
	return `${takeEscaped(cleaned, maxChars - 1).out}${ELLIPSIS}`;
}

function emptyReasonForNone(reasonCode: KnowledgeReason | undefined): PanelEmptyReason {
	switch (reasonCode) {
		case "no_documents":
		case "routing_table_missing":
			return "index_empty";
		case "namespace_not_found":
			return "not_generated";
		// no_route_match and every other reason fall through: nothing matched, so no_match.
		default:
			return "no_match";
	}
}

const DOC_MATCH_REASON = "Routed from the Greptile knowledge base index";

function docItem(path: string): PanelItem {
	return {
		id: `doc:${path}`,
		title: sanitizePanelText(path, TITLE_MAX_CHARS),
		preview: "",
		source: { kind: "greptile_doc", ref: sanitizePanelText(path, REF_MAX_CHARS) },
		timestamp: null,
		matchReason: DOC_MATCH_REASON,
		itemStatus: "returned",
	};
}

/**
 * Map one knowledge-base lookup record onto a panel envelope.
 * - `used` is success, with each read document as a returned item.
 * - `none` is empty; its reason maps through `emptyReasonForNone`.
 * - `off` is empty: `gate_off` when the gate is disabled, `source_unavailable` when no credential or login is available. Never an error.
 * - `error` is error, classed by the reason code, with no retry scheduled.
 * Every envelope except loading carries the probe's stages.
 */
export function knowledgeLookupToPanel(lookup: KnowledgeLookup): PanelEnvelope {
	const stages = lookup.stages ?? [];
	switch (lookup.outcome) {
		case "used":
			return {
				status: "success",
				items: lookup.docs.map(docItem),
				excluded: [],
				missing: [],
				stages,
			};
		case "none":
			return {
				status: "empty",
				reason: emptyReasonForNone(lookup.reasonCode),
				items: [],
				excluded: [],
				missing: [],
				stages,
			};
		case "off":
			return {
				status: "empty",
				reason: lookup.reasonCode === "disabled" ? "gate_off" : "source_unavailable",
				items: [],
				excluded: [],
				missing: [],
				stages,
			};
		case "error":
			return {
				status: "error",
				errorClass: lookup.reasonCode ?? "unclassified",
				message:
					sanitizePanelText(lookup.reason, MESSAGE_MAX_CHARS) ||
					`Knowledge lookup failed (${lookup.reasonCode ?? "unclassified"}).`,
				retry: { scheduled: false, attempt: 0 },
				stages,
			};
	}
}
