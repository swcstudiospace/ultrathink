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
	type PanelSurface,
	type ProducerTrigger,
	PREVIEW_MAX_CHARS,
	clipPanelText,
	producerPanelTrigger,
	sanitizePanelText,
	withPanelMeta,
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

/** When a producer's lookup started and the trigger that called it. Without one, no metadata is added. */
export interface ProducerInvocation {
	trigger: ProducerTrigger;
	startedAt: number;
	/** The query the lookup ran on, when the caller has it. Sanitized into the envelope's preview. */
	query?: string | undefined;
	filters?: readonly string[] | undefined;
}

/** A pointer to the record a lookup read: its kind and the record's own names or ids, never the record's content. */
function recordRef(kind: string, values: readonly string[]): string | undefined {
	return values.length > 0 ? `${kind}:${values.join(",")}` : undefined;
}

/** The query and filters a producer's lookup ran with, when the producer has them. Absent fields fall back to the invocation's. */
interface ProducerRequest {
	query?: string | undefined;
	filters?: readonly string[] | undefined;
}

/**
 * Attach an invocation's metadata to a producer's envelope. The surface is the producer's own source. The request's query
 * and filters win; without them the invocation's are used, and without either the request is empty. Without an invocation
 * the envelope is returned unchanged.
 */
function withInvocation(
	panel: PanelEnvelope,
	surface: PanelSurface,
	invocation: ProducerInvocation | undefined,
	rawRef: string | undefined,
	request: ProducerRequest = {},
): PanelEnvelope {
	if (invocation === undefined) return panel;
	return withPanelMeta(panel, {
		surface,
		trigger: producerPanelTrigger(invocation.trigger),
		query: request.query ?? invocation.query ?? "",
		filters: [...(request.filters ?? invocation.filters ?? [])],
		startedAt: invocation.startedAt,
		rawRef,
	});
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
function lessonsPanel(lookup: LessonsLookup, floor: number): PanelEnvelope {
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

/** The lessons source's envelope, with the invocation's metadata when the caller passes one. */
export function lessonsLookupToPanel(
	lookup: LessonsLookup,
	floor: number,
	invocation?: ProducerInvocation,
): PanelEnvelope {
	return withInvocation(
		lessonsPanel(lookup, floor),
		"lesson",
		invocation,
		recordRef("lessons", lookup.ids),
	);
}

/** The teachable-moments source: the lessons shape, surfaced as teachable_moment. */
export function momentsLookupToPanel(
	lookup: LessonsLookup,
	floor: number,
	invocation?: ProducerInvocation,
): PanelEnvelope {
	return withInvocation(
		lessonsPanel(lookup, floor),
		"teachable_moment",
		invocation,
		recordRef("teachable_moments", lookup.ids),
	);
}

/**
 * Map one skills lookup record onto a panel envelope.
 * - `used`: a row with `injected` is a pointer item (its description as the preview, its target in the match reason). A
 *   row without it (a draft or a disabled skill, which is not installed) is excluded as filtered and never returned, carrying
 *   its manifest status. When no row is injected the envelope is empty with reason filtered.
 *   The record's names are never shown: only its rows are, so a skill the record does not list (a disabled one never
 *   reaches the record) is absent.
 * - `none` is empty (no_match). `off` is empty (gate_off). `error` is an error envelope, classed unclassified.
 * - `used` without rows (a record written before rows existed) is empty (source_unavailable).
 */
function skillsPanel(lookup: SkillsLookup): PanelEnvelope {
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
				if (!row.injected) {
					// A draft or disabled skill carries its manifest status, so the panel can tell the two apart.
					const status = sanitizePanelText(row.status, TITLE_MAX_CHARS);
					excluded.push({
						ref: sanitizePanelText(row.name, REF_MAX_CHARS),
						reason: "filtered",
						...(status === "" ? {} : { status }),
					});
				} else
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

/** The skills source's envelope, with the invocation's metadata when the caller passes one. */
export function skillsLookupToPanel(
	lookup: SkillsLookup,
	invocation?: ProducerInvocation,
): PanelEnvelope {
	return withInvocation(
		skillsPanel(lookup),
		"skill",
		invocation,
		recordRef("skills", lookup.names),
	);
}

/** The Substrate brief as the hook fetched it: already masked, and how it was obtained. */
export interface SubstrateBriefInput {
	text: string;
	state: "complete" | "degraded" | "snapshot" | "none";
	reason?: string;
	/** The substrate request's query, as the caller sent it. Absent: the invocation's query, else none. */
	query?: string | undefined;
	/** The substrate request's filters (its repo, branch and surface scope), one label each. Absent: the invocation's. */
	filters?: readonly string[] | undefined;
}

const BRIEF_TITLE = "Substrate brief";
const BRIEF_MATCH_REASON = "Cross-agent brief for this repository";
const BRIEF_REF = "substrate_brief:brief";

function briefItem(preview: string, size: number): PanelItem {
	return {
		id: "substrate_brief:brief",
		title: BRIEF_TITLE,
		preview,
		source: { kind: "substrate_brief", ref: "brief" },
		timestamp: null,
		matchReason: BRIEF_MATCH_REASON,
		size,
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
 * - Text past PREVIEW_MAX_CHARS is cut; the cut is reported as a trimmed_budget row with its character count.
 */
function briefPanel(input: SubstrateBriefInput): PanelEnvelope {
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
	const clip = clipPanelText(input.text, PREVIEW_MAX_CHARS);
	if (clip.text === "") return emptyEnvelope("no_match");
	const items = [briefItem(clip.text, clip.size)];
	// The cut is reported, never silent: the row names how many characters the preview left out.
	const excluded: ExcludedRow[] =
		clip.trimmed > 0
			? [{ ref: "brief", reason: "trimmed_budget", trimmedChars: clip.trimmed }]
			: [];
	if (input.state === "complete")
		return { status: "success", items, excluded, missing: [], stages: [] };
	return {
		status: "partial",
		remainder: "truncated",
		items,
		excluded,
		missing: [{ ref: "brief", reason: "source_unavailable" }],
		stages: [],
	};
}

/** The Substrate brief's envelope, with the invocation's metadata when the caller passes one. */
export function substrateBriefToPanel(
	input: SubstrateBriefInput,
	invocation?: ProducerInvocation,
): PanelEnvelope {
	return withInvocation(briefPanel(input), "substrate", invocation, BRIEF_REF, {
		query: input.query,
		filters: input.filters,
	});
}
