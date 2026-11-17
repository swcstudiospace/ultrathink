// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Panel adapters for the Teachable Moments lookups: the lessons record and the skills record, each mapped onto the same
 * envelope the knowledge lookup uses (panel-model.ts). Pure: no clock, no filesystem. The lesson relevance floor is the
 * caller's parameter. A skill reaches a panel as a pointer (name, description, target), never a body; a draft is shown
 * only as an excluded row, so the panel can say that drafts exist without ever injecting one.
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
 * - `used`: a published skill is a pointer item (its description as the preview, its target in the match reason). A
 *   draft is excluded as filtered and never returned. When only drafts matched the envelope is empty with reason filtered.
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
				if (row.target === "drafts")
					excluded.push({ ref: sanitizePanelText(row.name, REF_MAX_CHARS), reason: "filtered" });
				else
					items.push({
						id: `skill:${row.name}`,
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
