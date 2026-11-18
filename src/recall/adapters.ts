// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Panel adapters for the Teachable Moments lookups (the lessons and skills records) and the Substrate brief, each mapped
 * onto the same envelope the knowledge lookup uses (panel-model.ts). Pure: no clock, no filesystem. The lesson relevance
 * floor is the caller's parameter. A skill reaches a panel as a pointer (name, description, target), never a body; a draft
 * is shown only as an excluded row, so the panel can say that drafts exist without ever injecting one.
 */
import type { LessonRow, LessonsLookup, SkillsLookup } from "../teach/types.ts";
import {
	type PanelBody,
	type PanelEnvelope,
	type PanelItem,
	PREVIEW_MAX_CHARS,
	sanitizePanelText,
} from "./panel-model.ts";

const TITLE_MAX_CHARS = 160;
const REF_MAX_CHARS = 512;
const MESSAGE_MAX_CHARS = 200;

type EmptyReason = Extract<PanelEnvelope, { status: "empty" }>["reason"];
type ExcludedRow = PanelBody["excluded"][number];

function emptyEnvelope(reason: EmptyReason, excluded: ExcludedRow[] = []): PanelEnvelope {
	return { status: "empty", reason, items: [], excluded, missing: [], stages: [] };
}

function errorEnvelope(reason: string | undefined, fallback: string): PanelEnvelope {
	return {
		status: "error",
		errorClass: "unclassified",
		message: sanitizePanelText(reason, MESSAGE_MAX_CHARS) || fallback,
		retry: { scheduled: false, attempt: 0 },
		stages: [],
	};
}

function lessonItem(row: LessonRow): PanelItem {
	const createdAt = Date.parse(row.createdAt);
	const item: PanelItem = {
		id: `lesson:${row.id}`,
		title: sanitizePanelText(row.title, TITLE_MAX_CHARS),
		preview: sanitizePanelText(row.preview, PREVIEW_MAX_CHARS),
		source: { kind: "lesson", ref: sanitizePanelText(row.id, REF_MAX_CHARS) },
		timestamp: Number.isFinite(createdAt) ? createdAt : null,
		matchReason: sanitizePanelText(row.matchReason, MESSAGE_MAX_CHARS),
		itemStatus: "returned",
	};
	if (row.score !== undefined)
		item.score = { kind: "confidence", value: row.score, direction: "higher_is_better" };
	return item;
}

/**
 * Map one lessons lookup record onto a panel envelope.
 * - `used`: each row is an item carrying its confidence as a score; a row whose score is below `floor` is excluded as
 *   below_floor with the score kept. A row with no score is returned without one, since there is nothing to judge it by.
 *   When every row is excluded the envelope is empty with reason below_floor.
 * - `none` is empty (no_match). `off` is empty (gate_off: teach or recall is off).
 * - `error` is an error envelope, classed unclassified: the lessons record carries free text, not a probe code.
 * - `used` without rows (a record written before rows existed) is empty (source_unavailable): its lessons cannot be shown.
 */
export function lessonsLookupToPanel(lookup: LessonsLookup, floor: number): PanelEnvelope {
	switch (lookup.outcome) {
		case "error":
			return errorEnvelope(lookup.reason, "Lessons lookup failed.");
		case "off":
			return emptyEnvelope("gate_off");
		case "none":
			return emptyEnvelope("no_match");
		case "used": {
			if (lookup.rows === undefined) return emptyEnvelope("source_unavailable");
			const items: PanelItem[] = [];
			const excluded: ExcludedRow[] = [];
			for (const row of lookup.rows) {
				if (row.score !== undefined && row.score < floor)
					excluded.push({
						ref: sanitizePanelText(row.id, REF_MAX_CHARS),
						reason: "below_floor",
						score: { kind: "confidence", value: row.score, direction: "higher_is_better" },
					});
				else items.push(lessonItem(row));
			}
			if (items.length > 0) return { status: "success", items, excluded, missing: [], stages: [] };
			return emptyEnvelope(excluded.length > 0 ? "below_floor" : "no_match", excluded);
		}
	}
}

/**
 * Map one skills lookup record onto a panel envelope.
 * - `used`: a row with `injected` is a pointer item (its description as the preview, its target in the match reason). A
 *   row without it (a draft, which is not installed) is excluded as filtered and never returned. When no row is injected
 *   the envelope is empty with reason filtered.
 *   The record's names are never shown: only its rows are, so a skill the record does not list (a disabled one never
 *   reaches the record) is absent.
 * - `none` is empty (no_match). `off` is empty (gate_off). `error` is an error envelope, classed unclassified.
 * - `used` without rows (a record written before rows existed) is empty (source_unavailable).
 */
export function skillsLookupToPanel(lookup: SkillsLookup): PanelEnvelope {
	switch (lookup.outcome) {
		case "error":
			return errorEnvelope(lookup.reason, "Skills lookup failed.");
		case "off":
			return emptyEnvelope("gate_off");
		case "none":
			return emptyEnvelope("no_match");
		case "used": {
			if (lookup.rows === undefined) return emptyEnvelope("source_unavailable");
			const items: PanelItem[] = [];
			const excluded: ExcludedRow[] = [];
			for (const row of lookup.rows) {
				if (!row.injected)
					excluded.push({ ref: sanitizePanelText(row.name, REF_MAX_CHARS), reason: "filtered" });
				else
					items.push({
						id: `skill:${row.target}:${row.name}`,
						title: sanitizePanelText(row.name, TITLE_MAX_CHARS),
						preview: sanitizePanelText(row.description, PREVIEW_MAX_CHARS),
						source: { kind: "skill", ref: sanitizePanelText(row.name, REF_MAX_CHARS) },
						timestamp: null,
						matchReason: `Promoted skill matched the prompt (${row.target})`,
						itemStatus: "returned",
					});
			}
			if (items.length > 0) return { status: "success", items, excluded, missing: [], stages: [] };
			return emptyEnvelope(excluded.length > 0 ? "filtered" : "no_match", excluded);
		}
	}
}

/** The Substrate brief as the hook fetched it: already masked, and how it was obtained. */
export interface SubstrateBriefInput {
	text: string;
	state: "complete" | "degraded" | "snapshot" | "none";
	reason?: string;
}

const BRIEF_TITLE = "Substrate brief";
const BRIEF_MATCH_REASON = "Cross-agent brief for this repository";

function briefItem(preview: string): PanelItem {
	return {
		id: "substrate_brief:brief",
		title: BRIEF_TITLE,
		preview,
		source: { kind: "substrate_brief", ref: "brief" },
		timestamp: null,
		matchReason: BRIEF_MATCH_REASON,
		itemStatus: "returned",
	};
}

/**
 * Map one Substrate brief fetch onto a panel envelope. The text is already masked by the caller; this adapter escapes
 * it for display and never redacts.
 * - `none` is empty: gate_off when the brief is disabled, source_unavailable when there is no URL. Any other reason is
 *   an error, classed unclassified.
 * - `complete` with text is success, with the brief as one item.
 * - `degraded` and `snapshot` with text are partial (remainder truncated): the same item, and the live brief as a missing
 *   row (source_unavailable).
 * - Any state with text that is empty once sanitized is empty (no_match).
 */
export function substrateBriefToPanel(input: SubstrateBriefInput): PanelEnvelope {
	if (input.state === "none") {
		switch (input.reason) {
			case "disabled":
				return emptyEnvelope("gate_off");
			case "no-url":
				return emptyEnvelope("source_unavailable");
			default:
				return errorEnvelope(input.reason, "Substrate brief lookup failed.");
		}
	}
	const preview = sanitizePanelText(input.text, PREVIEW_MAX_CHARS);
	if (preview === "") return emptyEnvelope("no_match");
	const items = [briefItem(preview)];
	if (input.state === "complete")
		return { status: "success", items, excluded: [], missing: [], stages: [] };
	return {
		status: "partial",
		remainder: "truncated",
		items,
		excluded: [],
		missing: [{ ref: "brief", reason: "source_unavailable" }],
		stages: [],
	};
}
