// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * In-process Code Blocked PRD (contracts/ultrathink-plugin-tab6a.openapi.json 1.0.0,
 * schemas CodeBlockedPrdRequest and CodeBlockedPrd). Caller-supplied prices only.
 * No price service and no network client. Binds AC-6 through AC-12, NFR-S1, NFR-C1.
 */

import { redactSecrets } from "../redact.ts";

/** Published input price row. A missing price is not a published price. */
export interface ModelPrice {
	modelId: string;
	callable: boolean;
	inputUsdPerMillion?: number;
}

/** POST body plus the path ids that key the in-memory node store. */
export interface CodeBlockedPrdRequest {
	graphId: string;
	nodeId: string;
	cotStepCount: number;
	selectedModelId: string;
	treeOfThoughtFinished?: boolean;
	prices: readonly ModelPrice[];
	/** Full body from the ToT pass (post CoT + scoped review). When present and valid, used instead of the generated prdText. */
	fullBody?: string;
	/** For per-sub-issue PRDs (sub-issue = CoT step). */
	step?: number;
}

export type PrdErrorCode = "PRD_NO_PRICE" | "PRD_NO_SELECTED_MODEL" | "PRD_SECRET_SCAN_MATCH";

/** GET/POST result. secretScanMatches stays 0; a secret is never echoed. */
export interface CodeBlockedPrd {
	count: 0 | 1;
	secretScanMatches: 0;
	cotStepCount?: number;
	heading?: "Code Blocked PRD";
	blockedUntilLines?: number;
	fencedCodeBlocks?: number;
	selectedModelId?: string;
	treeModelId?: string;
	graphModelId?: string;
	cotModelId?: string;
	code?: PrdErrorCode;
	/** Full document. Absent when nothing was attached. Never contains a secret-scan match. */
	body?: string;
}

const HEADING = "Code Blocked PRD" as const;

const store = new Map<string, CodeBlockedPrd>();

/** NUL separates ids so a graph id cannot collide with another graph's node id or step. */
function nodeKey(graphId: string, nodeId: string, step = 0): string {
	return `${graphId}\0${nodeId}\0${step}`;
}

function empty(code?: PrdErrorCode): CodeBlockedPrd {
	return code === undefined
		? { count: 0, secretScanMatches: 0 }
		: { count: 0, secretScanMatches: 0, code };
}

/** Unicode code-point order, ascending. Not locale order. */
function compareCodePoint(left: string, right: string): number {
	const width = Math.min(left.length, right.length);
	for (let i = 0; i < width; ) {
		const a = left.codePointAt(i) ?? 0;
		const b = right.codePointAt(i) ?? 0;
		if (a !== b) return a - b;
		i += a > 0xffff ? 2 : 1;
	}
	return left.length - right.length;
}

/**
 * Lowest published inputUsdPerMillion among callable models. Price 0 counts.
 * Ties break by Unicode code-point order of modelId, ascending.
 * Callable false and a missing price are ignored.
 */
export function selectCheapest(prices: readonly ModelPrice[]): string | undefined {
	let bestId: string | undefined;
	let bestPrice = Number.POSITIVE_INFINITY;
	for (const row of prices) {
		if (row.callable !== true || typeof row.modelId !== "string") continue;
		const price = row.inputUsdPerMillion;
		if (typeof price !== "number" || !Number.isFinite(price)) continue;
		if (
			bestId === undefined ||
			price < bestPrice ||
			(price === bestPrice && compareCodePoint(row.modelId, bestId) < 0)
		) {
			bestId = row.modelId;
			bestPrice = price;
		}
	}
	return bestId;
}

/** Generated body: heading, expanded CoT, concrete fence, Blocked until, acceptance, linkage. */
function prdText(cotStepCount: number, selectedModelId: string, treeModelId: string): string {
	return [
		HEADING,
		"",
		`Expanded CoT description: recorded ${cotStepCount} CoT steps for the sub-issue.`,
		"",
		"## Concrete code block",
		"```",
		"// change for sub-issue (populated by ToT when review available)",
		"```",
		"",
		`Blocked until: sub-issue implementation and verification after ${cotStepCount} recorded steps`,
		`Recorded CoT step count: ${cotStepCount}`,
		`Graph of Thought model ${selectedModelId}.`,
		`Chain of Thought model ${selectedModelId}.`,
		`Tree of Thought model ${treeModelId}.`,
		"",
		"## Acceptance",
		"- PRD has fence and Blocked until",
		"- Matches CoT step count",
		"",
		"## Linkage",
		"CoT steps under GoT node.",
	].join("\n");
}

/**
 * Attaches one PRD after Tree-of-Thought, or records nothing.
 * Supports fullBody (from ToT in pipeline after CoT) per sub-issue.
 * Empty selected wins over unfinished. No callable priced model writes nothing, with or without fullBody.
 * An unfinished tree returns count 0.
 */
export function createCodeBlockedPrd(input: CodeBlockedPrdRequest): CodeBlockedPrd {
	const selected = typeof input.selectedModelId === "string" ? input.selectedModelId : "";
	if (selected.length === 0) return empty("PRD_NO_SELECTED_MODEL");
	if (input.treeOfThoughtFinished !== true) return empty();

	const step =
		Number.isInteger(input.step) && (input.step as number) > 0 ? (input.step as number) : 0;
	const graphId = typeof input.graphId === "string" ? input.graphId : "";
	const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
	const steps =
		Number.isInteger(input.cotStepCount) && input.cotStepCount >= 0 ? input.cotStepCount : 0;

	if (typeof input.fullBody === "string" && input.fullBody.length > 0) {
		const text = input.fullBody;
		if (redactSecrets(text) !== text) {
			return empty("PRD_SECRET_SCAN_MATCH");
		}
		const fenceMarks = text.match(/```/g);
		let blockedUntilLines = 0;
		for (const line of text.split("\n")) {
			if (line.startsWith("Blocked until:")) blockedUntilLines += 1;
		}
		const prices = Array.isArray(input.prices) ? input.prices : [];
		const treeModelId = selectCheapest(prices);
		if (treeModelId === undefined) return empty("PRD_NO_PRICE");
		const attached: CodeBlockedPrd = {
			count: 1,
			secretScanMatches: 0,
			cotStepCount: steps,
			heading: HEADING,
			blockedUntilLines,
			fencedCodeBlocks: fenceMarks === null ? 0 : Math.floor(fenceMarks.length / 2),
			selectedModelId: selected,
			treeModelId,
			graphModelId: selected,
			cotModelId: selected,
			body: text,
		};
		store.set(nodeKey(graphId, nodeId, step), attached);
		return { ...attached };
	}

	// price-selected path (no fullBody)
	const prices = Array.isArray(input.prices) ? input.prices : [];
	const treeModelId = selectCheapest(prices);
	if (treeModelId === undefined) return empty("PRD_NO_PRICE");

	const text = prdText(steps, selected, treeModelId);
	if (redactSecrets(text) !== text) {
		return empty("PRD_SECRET_SCAN_MATCH");
	}

	const fenceMarks = text.match(/```/g);
	let blockedUntilLines = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("Blocked until:")) blockedUntilLines += 1;
	}
	const attached: CodeBlockedPrd = {
		count: 1,
		secretScanMatches: 0,
		cotStepCount: steps,
		heading: HEADING,
		blockedUntilLines,
		fencedCodeBlocks: fenceMarks === null ? 0 : Math.floor(fenceMarks.length / 2),
		selectedModelId: selected,
		treeModelId,
		graphModelId: selected,
		cotModelId: selected,
		body: text,
	};
	store.set(nodeKey(graphId, nodeId, step), attached);
	return { ...attached };
}

/** Count is 0 until createCodeBlockedPrd attaches a PRD for this node (or step within node for sub-issues). */
export function getCodeBlockedPrd(graphId: string, nodeId: string, step = 0): CodeBlockedPrd {
	const row = store.get(nodeKey(graphId, nodeId, step));
	return row === undefined ? empty() : { ...row };
}
