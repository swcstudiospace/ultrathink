// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ToT release glue for the hook: a plan is released only once every Sub Issue has a generated PRD placed in the
 * specification and that PRD is actually present, hash-marked, in its tracker row. Any unplaced PRD key (unmatched key),
 * any not-generated PRD (failed, held by an unsatisfied dependency, skipped), or any generated PRD missing from its
 * Linear Sub Issue or Notion row holds the release with a secret-free reason; the `PRDS` XML element only carries counts.
 *
 * Presence is read-only: {@link verifyPrdPresence} only reads (`get_issue`, Notion block listing) through the existing
 * gateway callers. It never creates or updates a tracker row, so a locally generated PRD that never reached either
 * tracker still holds the release instead of being waved through on manifest counts alone.
 */
import { notionPageId } from "../mcp/notion-db.ts";
import type { ToolCaller } from "../track/create.ts";
import type { IssueRef } from "../track/types.ts";
import type { PrdOutcome } from "../think/tot/stage.ts";
import type { PrdRecord } from "../think/tot/types.ts";

/** Tracker rows a PRD presence check reads from, keyed by step key (`nodeId.step`). */
export interface PrdPresenceRefs {
	readonly linear?: Readonly<Record<string, IssueRef>>;
	readonly notion?: Readonly<Record<string, string>>;
}

/** The existing gateway callers presence is read through. An absent caller means that tracker is not configured. */
export interface PrdPresenceCallers {
	readonly linear?: ToolCaller;
	readonly notion?: ToolCaller;
}

/** Generated keys whose hash-marked PRD was not found in the named tracker. Empty on both means present everywhere checked. */
export interface PrdPresence {
	readonly missingLinear: readonly string[];
	readonly missingNotion: readonly string[];
}

const LINEAR_END_MARKER = "<!-- ultrathink:prd:end -->";
const NOTION_END_TEXT = "ultrathink:prd:end";
const DEFAULT_NOTION_LIST_TOOL = "API-get-block-children";
const NOTION_PAGE_SIZE = 100;
const MAX_NOTION_PAGES = 50;

function markerSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9._:-]/g, "_");
}

function linearStartMarker(key: string, hash: string): string {
	return `<!-- ultrathink:prd:start key=${markerSafe(key)} hash=${markerSafe(hash)} -->`;
}

function notionStartText(key: string, hash: string): string {
	return `ultrathink:prd key=${markerSafe(key)} hash=${markerSafe(hash)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** One Linear read: true only when the description carries this key's complete hash-marked region. */
async function linearHasPrd(
	caller: ToolCaller,
	issueId: string,
	key: string,
	hash: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	try {
		const reply = asRecord(
			await caller.call("get_issue", { id: issueId, fields: ["description"] }, signal),
		);
		const description = reply?.description;
		if (typeof description !== "string") return false;
		const start = description.indexOf(linearStartMarker(key, hash));
		if (start < 0) return false;
		return description.indexOf(LINEAR_END_MARKER, start) >= 0;
	} catch {
		// reason: an unreadable row is not evidence of presence; the gate must hold, never wave through
		return false;
	}
}

interface SeenBlock {
	readonly type: string;
	readonly text: string;
}

function blockText(block: Record<string, unknown>): string {
	const type = typeof block.type === "string" ? block.type : "";
	const items = asRecord(block[type])?.rich_text;
	if (!Array.isArray(items)) return "";
	return items
		.map((item) => {
			const fields = asRecord(item);
			const plain = fields?.plain_text;
			if (typeof plain === "string") return plain;
			const content = asRecord(fields?.text)?.content;
			return typeof content === "string" ? content : "";
		})
		.join("");
}

async function listNotionBlocks(
	caller: ToolCaller,
	pageId: string,
	listTool: string,
	signal: AbortSignal | undefined,
): Promise<SeenBlock[] | undefined> {
	const seen: SeenBlock[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_NOTION_PAGES; page++) {
		let reply: Record<string, unknown> | undefined;
		try {
			reply = asRecord(
				await caller.call(
					listTool,
					{
						block_id: pageId,
						page_size: NOTION_PAGE_SIZE,
						...(cursor === undefined ? {} : { start_cursor: cursor }),
					},
					signal,
				),
			);
		} catch {
			// reason: an unreadable page is not evidence of presence; the gate must hold, never wave through
			return undefined;
		}
		if (!Array.isArray(reply?.results)) return undefined;
		for (const raw of reply.results) {
			const block = asRecord(raw);
			if (block === undefined) continue;
			seen.push({
				type: typeof block.type === "string" ? block.type : "",
				text: blockText(block),
			});
		}
		if (reply.has_more !== true || typeof reply.next_cursor !== "string") return seen;
		cursor = reply.next_cursor;
	}
	return undefined;
}

/** One Notion read: true only when the page carries this key's complete hash-marked region. */
async function notionHasPrd(
	caller: ToolCaller,
	pageId: string,
	key: string,
	hash: string,
	listTool: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const blocks = await listNotionBlocks(caller, pageId, listTool, signal);
	if (blocks === undefined) return false;
	const startText = notionStartText(key, hash);
	for (let i = 0; i < blocks.length; i++) {
		const start = blocks[i] as SeenBlock;
		if (start.type !== "callout" || start.text.trim() !== startText) continue;
		for (let j = i + 1; j < blocks.length; j++) {
			const next = blocks[j] as SeenBlock;
			if (next.type !== "callout") continue;
			if (next.text.trim() === NOTION_END_TEXT) return true;
			if (next.text.startsWith("ultrathink:prd key=")) break;
		}
	}
	return false;
}

/**
 * Verifies, read-only, that each requested key's hash-marked PRD is present in its Linear Sub Issue and its Notion row,
 * through the existing gateway callers (`get_issue` for Linear, the Notion block-children list tool for Notion). Never
 * creates or writes a row. A key is missing from a tracker when its row reference is absent, its read fails or returns
 * an unreadable result, or the exact start marker for the key and hash plus the end marker is not there.
 *
 * A tracker is checked only when its caller is supplied: an absent caller means that tracker is not configured, which
 * keeps the pre-existing `not-configured` behaviour. Duplicate (key, hash) pairs are checked once, in first-seen order.
 */
export async function verifyPrdPresence(
	records: readonly Pick<PrdRecord, "key" | "hash">[],
	refs: PrdPresenceRefs,
	callers: PrdPresenceCallers,
	options: { readonly notionListTool?: string; readonly signal?: AbortSignal } = {},
): Promise<PrdPresence> {
	const seen = new Set<string>();
	const unique: Array<Pick<PrdRecord, "key" | "hash">> = [];
	for (const record of records) {
		const id = `${record.key}\0${record.hash}`;
		if (seen.has(id)) continue;
		seen.add(id);
		unique.push(record);
	}
	const missingLinear: string[] = [];
	const missingNotion: string[] = [];
	for (const record of unique) {
		if (callers.linear !== undefined) {
			const ref = refs.linear?.[record.key];
			const issueId = ref?.identifier ?? ref?.id;
			const present =
				issueId !== undefined &&
				issueId !== "" &&
				(await linearHasPrd(callers.linear, issueId, record.key, record.hash, options.signal));
			if (!present) missingLinear.push(record.key);
		}
		if (callers.notion !== undefined) {
			const refUrl = refs.notion?.[record.key];
			const pageId = refUrl === undefined ? undefined : notionPageId(refUrl);
			const present =
				pageId !== undefined &&
				(await notionHasPrd(
					callers.notion,
					pageId,
					record.key,
					record.hash,
					options.notionListTool ?? DEFAULT_NOTION_LIST_TOOL,
					options.signal,
				));
			if (!present) missingNotion.push(record.key);
		}
	}
	return { missingLinear, missingNotion };
}

/** Why tracker-side presence holds the release, naming the missing keys per tracker; `undefined` when nothing is missing. */
export function prdPresenceHoldReason(presence: PrdPresence): string | undefined {
	const parts: string[] = [];
	if (presence.missingLinear.length > 0) parts.push(`Linear: ${presence.missingLinear.join(", ")}`);
	if (presence.missingNotion.length > 0) parts.push(`Notion: ${presence.missingNotion.join(", ")}`);
	return parts.length === 0
		? undefined
		: `PRD text not present in tracker rows (${parts.join("; ")})`;
}

/** Why the plan must be held back, or `undefined` when every PRD was generated, placed and present in its tracker rows. */
export function totHoldReason(
	outcome: PrdOutcome,
	unplaced: readonly string[],
	presence?: PrdPresence,
): string | undefined {
	if (unplaced.length > 0) {
		return `no Sub Issue in the specification for ${unplaced.join(", ")}`;
	}
	const present = presence === undefined ? undefined : prdPresenceHoldReason(presence);
	if (present !== undefined) return present;
	if (outcome.manifest.generated < outcome.manifest.total) {
		return (
			outcome.error ??
			`PRD_PARTIAL: ${outcome.manifest.generated} of ${outcome.manifest.total} PRDs generated`
		);
	}
	return outcome.error;
}
