// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { randomUUID } from "node:crypto";
import type { Clarification } from "../hitl/types.ts";
import { clip } from "../resilience/limits.ts";
import { MAX_STEPS, type ThoughtGraph, type ThoughtNode } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import type {
	HitlPlan,
	IssueRow,
	LinearIssuePlan,
	LinearSubIssuePlan,
	SubIssueRow,
	TaskRow,
	TrackPlan,
} from "./types.ts";

const MAX_TITLE_CHARS = 120;
/** Step titles carry a snippet of the step text; the full text lives in the row's thought/description. */
const MAX_STEP_TITLE_CHARS = 72;

/** Notion's single rich-text property limit is ~2000 chars; leave headroom under it. */
export const MAX_UPLIFTED_PROMPT_CHARS = 1900;

const TRUNCATION_MARKER = "\n<!-- truncated — full spec in the session's .xml file -->";

export function generateGraphId(now: () => number = Date.now): string {
	return `ut-${now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function taskTitle(original: string): string {
	const trimmed = original.trim().replace(/\s+/g, " ");
	if (!trimmed) return "Untitled task";
	return clip(trimmed, MAX_TITLE_CHARS, "...").text;
}

function nodeConclusion(node: ThoughtNode): string {
	return (node.conclusion ?? "").trim();
}

type EnrichedSection = readonly [label: string, values: readonly string[] | undefined];

/**
 * Appends a node's files/acceptance/risks/evidence as labeled bullet sections to `base`.
 * Absent, empty or blank-only arrays add nothing, so legacy nodes produce byte-identical rows.
 * Enriched rows are capped at MAX_UPLIFTED_PROMPT_CHARS with the truncation marker (the Notion
 * rich-text limit the uplifted prompt already respects); unenriched rows stay untouched.
 */
function enrichDescription(base: string, node: ThoughtNode): string {
	const sections: EnrichedSection[] = [
		["Files", node.files],
		["Acceptance", node.acceptance],
		["Risks", node.risks],
		["Evidence", node.evidence],
	];
	const rendered = sections
		.map(([label, values]) => {
			const items = (values ?? []).map((value) => value.trim()).filter(Boolean);
			return items.length > 0 ? `${label}:\n${items.map((item) => `- ${item}`).join("\n")}` : "";
		})
		.filter(Boolean);
	if (rendered.length === 0) return base;
	return clip(`${base}\n\n${rendered.join("\n\n")}`, MAX_UPLIFTED_PROMPT_CHARS, TRUNCATION_MARKER)
		.text;
}

function issueRow(graphId: string, node: ThoughtNode): IssueRow {
	return {
		graphId,
		nodeId: node.id,
		item: `[${node.id}] ${node.title}`,
		thought: enrichDescription(nodeConclusion(node) || node.question, node),
	};
}

/** A step marker at the start of a line: `3.`, `3)`, `**3.**`, `Step 3:`, `Step 3 -` — any number. */
const LINE_MARKER_RE = /^[ \t]*(?:\*\*)?(?:step\s+)?(\d{1,2})(?:[.):]|\s+[-–—])(?:\*\*)?[ \t]+/gim;
/** A step marker inside running text: `2.` or `2)` after whitespace. */
const INLINE_MARKER_RE = /(?:^|\s)(\d{1,2})[.)]\s+/g;

interface Marker {
	start: number;
	end: number;
}

function lineMarkers(text: string): Marker[] {
	return [...text.matchAll(LINE_MARKER_RE)].map((match) => {
		const leading = match[0].length - match[0].trimStart().length;
		return { start: match.index + leading, end: match.index + match[0].length };
	});
}

/** Inline markers must continue the sequence from 1, so "5-8", "v2." and nested lists that restart stay in their step. */
function sequentialInlineMarkers(text: string): Marker[] {
	const markers: Marker[] = [];
	let expected = 1;
	for (const match of text.matchAll(INLINE_MARKER_RE)) {
		if (Number(match[1]) !== expected) continue;
		const leading = match[0].length - match[0].trimStart().length;
		markers.push({ start: match.index + leading, end: match.index + match[0].length });
		expected++;
	}
	return markers;
}

/**
 * Splits a CoT rationale into its numbered steps. One-step-per-line lists (`1.`, `2)`, `**3.**`,
 * `Step 4:`) split on every line marker, even when the model skipped or repeated a number. A
 * rationale written inline (`1. … 2. … 3. …`) splits only on markers that continue the sequence
 * from 1. Unnumbered text is one step; empty text is none. A preamble before the first marker is
 * folded into the first step.
 */
export function splitRationaleSteps(rationale: string): string[] {
	const text = rationale.trim();
	if (!text) return [];

	const byLine = lineMarkers(text);
	const markers = byLine.length >= 2 ? byLine : sequentialInlineMarkers(text);
	if (markers.length === 0) return [text];

	const steps = markers.map((marker, index) => {
		const next = markers[index + 1];
		return text.slice(marker.end, next ? next.start : text.length).trim();
	});
	const preamble = text.slice(0, markers[0]!.start).trim();
	if (preamble) steps[0] = `${preamble} ${steps[0]}`.trim();
	return steps.filter(Boolean);
}

/**
 * The per-step texts tracked as Sub-Issues under a node's Issue. A node whose fill produced no
 * rationale (engine failure, empty completion) still gets one step so every Issue keeps a Sub-Issue.
 * More than MAX_STEPS steps fold their tail into the last one, so a long list never fans out into dozens of rows.
 */
function nodeSteps(node: ThoughtNode): string[] {
	const steps = splitRationaleSteps(node.thinking ?? "");
	if (steps.length === 0) return [nodeConclusion(node) || node.question];
	if (steps.length <= MAX_STEPS) return steps;
	return [...steps.slice(0, MAX_STEPS - 1), steps.slice(MAX_STEPS - 1).join(" / ")];
}

function stepTitle(step: number, text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const cut = clip(oneLine, MAX_STEP_TITLE_CHARS, "…");
	// The cut head drops trailing spaces before the ellipsis, as it always has.
	const snippet = cut.clipped ? `${cut.text.slice(0, -1).trimEnd()}…` : oneLine;
	return `Step ${step}: ${snippet}`;
}

/** The "Step n: …" sub-issue titles for a node, in step order. */
export function nodeStepTitles(node: ThoughtNode): string[] {
	return nodeSteps(node).map((text, index) => stepTitle(index + 1, text));
}

function subIssueRows(graphId: string, node: ThoughtNode): SubIssueRow[] {
	return nodeSteps(node).map((thought, index) => ({
		graphId,
		nodeId: node.id,
		item: `[${node.id}] ${stepTitle(index + 1, thought)}`,
		step: index + 1,
		thought: enrichDescription(thought, node),
	}));
}

function linearIssue(node: ThoughtNode): LinearIssuePlan {
	return {
		nodeId: node.id,
		title: node.title,
		description: enrichDescription(nodeConclusion(node) || node.question, node),
	};
}

function linearSubIssues(node: ThoughtNode): LinearSubIssuePlan[] {
	return nodeSteps(node).map((description, index) => ({
		nodeId: node.id,
		step: index + 1,
		title: `${node.title} — ${stepTitle(index + 1, description)}`,
		description: enrichDescription(description, node),
	}));
}

export function buildTrackPlan(input: {
	uplift: UpliftResult;
	graph?: ThoughtGraph;
	clarifications: Clarification[];
	repo?: string;
	branch?: string;
	graphId?: string;
	agent?: string;
}): TrackPlan {
	const graphId = input.graphId ?? generateGraphId();
	const nodes = input.graph?.nodes ?? [];

	const task: TaskRow = {
		graphId,
		item: taskTitle(input.uplift.original),
		description: input.uplift.original.trim(),
		// Notion's Uplifted Prompt property is capped; the full XML is always persisted to sessions/<id>.xml.
		upliftedPrompt: clip(input.uplift.xml, MAX_UPLIFTED_PROMPT_CHARS, TRUNCATION_MARKER).text,
		agent: input.agent ?? "claude-code",
		status: "Planning",
		linearState: "Todo",
		repo: input.repo,
		branch: input.branch,
	};

	const hitl: HitlPlan = {
		blocking: input.clarifications.filter((c) => c.blocking && c.answer === undefined),
		nonBlocking: input.clarifications.filter((c) => !c.blocking && c.answer === undefined),
	};

	const nodeIds = new Set(nodes.map((node) => node.id));
	const dependencies: Record<string, readonly string[]> = {};
	for (const node of nodes) {
		const edges = [...new Set(node.dependsOn.filter((id) => nodeIds.has(id) && id !== node.id))];
		if (edges.length > 0) dependencies[node.id] = edges;
	}
	return {
		graphId,
		task,
		issues: nodes.map((node) => issueRow(graphId, node)),
		subIssues: nodes.flatMap((node) => subIssueRows(graphId, node)),
		linearIssues: nodes.map(linearIssue),
		linearSubIssues: nodes.flatMap(linearSubIssues),
		...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
		hitl,
	};
}
