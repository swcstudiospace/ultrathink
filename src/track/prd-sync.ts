// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Attaches each generated PRD to the Sub Issue that CoT already made, in Linear (description) and Notion (page body).
 * It never creates a Sub Issue: a PRD whose Sub Issue is unknown stays `pending` until a later run knows it.
 *
 * Local first: before any tracker call the (secret-redacted) PRD is written under the state dir and its hash goes into
 * the ledger as `pending`. A re-run skips a PRD whose hash the ledger says is already synced and updates a changed one
 * in place: Linear between `<!-- ultrathink:prd:start key=K hash=H -->` and `<!-- ultrathink:prd:end -->`, Notion
 * between two marker callouts. `resumePrds` re-sends only what the ledger still owes, from the local copies.
 *
 * Every call runs through the retry kernel (429/5xx/timeouts retried with jitter raised to Retry-After, other 4xx not).
 * The ledger holds hashes, ids, urls and failure classes only: no PRD text and no error text.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";
import { CLI_LOCK } from "../claude/state.ts";
import { resolveStateDir } from "../host/paths.ts";
import { notionPageId } from "../mcp/notion-db.ts";
import { redactSecrets } from "../redact.ts";
import { clip } from "../resilience/limits.ts";
import {
	RETRY_AFTER_CAP_MS,
	RetryExhaustedError,
	isTransientFailure,
	unwrapRetryError,
	withRetry,
	type FailureVerdict,
	type RetryPolicy,
} from "../resilience/retry.ts";
import { isAbortError } from "../shared.ts";
import type { PrdRecord } from "../think/tot/types.ts";
import type { ToolCaller } from "./create.ts";
import type {
	KeyReport,
	LedgerEntry,
	LedgerStatus,
	LedgerTracker,
	NotionBlockTools,
	PrdLedger,
	SyncDeps,
	SyncOutcome,
	SyncReport,
	SyncSummary,
	TrackerName,
	TrackerResult,
} from "./prd-types.ts";

/**
 * Notion limits, from the public Notion API reference and the repo's own note (src/track/plan.ts: rich text ~2000):
 * 2000 characters per rich-text segment, 100 blocks per append request, 100 rich-text segments per block.
 * UNVERIFIED against the hosted Notion MCP: nothing here calls Notion, so they are constants, not measurements.
 */
export const NOTION_RICH_TEXT_LIMIT = 2000;
export const NOTION_BLOCKS_PER_REQUEST = 100;
const NOTION_RICH_TEXT_ITEMS = 100;
/** UNVERIFIED: Linear's description cap is not documented in the repo; a longer PRD goes to a linked document. */
const DEFAULT_LINEAR_INLINE_LIMIT = 50_000;

const DEFAULT_NOTION_TOOLS: NotionBlockTools = {
	list: "API-get-block-children",
	append: "API-patch-block-children",
	remove: "API-delete-a-block",
};

/** Same policy as src/track/create.ts: three tries, full-jitter backoff raised to Retry-After. */
const RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseMs: 500, capMs: 8_000 };
const SUMMARY_CHARS = 1_200;
const MAX_SCAN_PAGES = 50;
const RETRY_AFTER_TEXT = /retry after (\d+(?:\.\d+)?)\s*s/i;
const QUOTA_TEXT = /\bquota\b|usage limit|plan limit|billing/i;
const END_MARKER = "<!-- ultrathink:prd:end -->";
const NOTION_END_TEXT = "ultrathink:prd:end";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function markerSafe(value: string): string {
	return value.replace(/[^A-Za-z0-9._:-]/g, "_");
}

function startMarker(key: string, hash: string): string {
	return `<!-- ultrathink:prd:start key=${markerSafe(key)} hash=${markerSafe(hash)} -->`;
}

function notionStartPrefix(key: string): string {
	return `ultrathink:prd key=${markerSafe(key)} hash=`;
}

/** A PRD body must not carry the managed-region markers: they would end or fake a region. */
function neutralize(markdown: string): string {
	return markdown.replace(/<!--\s*ultrathink:prd:/gi, "<!-- ultrathink-prd:");
}

// ---------------------------------------------------------------------------------------------------------------------
// Failures

class MissingTargetError extends Error {
	constructor(what: string) {
		super(`${what} not known: this run does not create Sub Issues`);
		this.name = "MissingTargetError";
	}
}

interface Failure {
	errorClass: string;
	/** True when a later run can fix it: the ledger says `pending`; otherwise `failed`. */
	retryable: boolean;
	/** Short and redacted. */
	message: string;
	status?: number;
}

/** The kernel's verdict plus the relay's `retry after Ns` text and quota text, as src/track/create.ts reads them. */
function classifyFailure(error: unknown, now?: number): FailureVerdict {
	const verdict = isTransientFailure(error, now);
	if (!verdict.transient) return verdict;
	const text = error instanceof Error ? error.message : String(error);
	if (QUOTA_TEXT.test(text)) return { ...verdict, transient: false, reason: "quota text" };
	if (verdict.retryAfterMs !== undefined) return verdict;
	const seconds = RETRY_AFTER_TEXT.exec(text)?.[1];
	const ms = seconds === undefined ? 0 : Math.round(Number(seconds) * 1000);
	return ms > 0 ? { ...verdict, retryAfterMs: Math.min(ms, RETRY_AFTER_CAP_MS) } : verdict;
}

function shortText(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSecrets(raw).replace(/\s+/g, " ").trim().slice(0, 160) || "error";
}

function describeFailure(raw: unknown): Failure {
	const error = unwrapRetryError(raw);
	if (isAbortError(error)) return { errorClass: "aborted", retryable: true, message: "aborted" };
	if (error instanceof MissingTargetError) {
		return { errorClass: "missing-sub-issue", retryable: true, message: shortText(error) };
	}
	const verdict = classifyFailure(error);
	const text = error instanceof Error ? error.message : String(error);
	const { status } = verdict;
	let errorClass: string;
	if (QUOTA_TEXT.test(text) || status === 402) errorClass = "quota";
	else if (status === 429) errorClass = "rate-limit";
	else if (status !== undefined && status >= 500) errorClass = "server";
	else if (status === 408 || status === 425) errorClass = "timeout";
	else if (status === 401 || status === 403) errorClass = "auth";
	else if (status === 404) errorClass = "not-found";
	else if (status !== undefined) errorClass = "client-error";
	else errorClass = verdict.transient ? "network" : "refused";
	return {
		errorClass,
		retryable: verdict.transient,
		message: shortText(error),
		...(status === undefined ? {} : { status }),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Notion blocks

export interface NotionBlock {
	object: "block";
	type: string;
	[field: string]: unknown;
}

const NOTION_LANGUAGES: ReadonlySet<string> = new Set([
	"bash",
	"c",
	"c#",
	"c++",
	"css",
	"dart",
	"diff",
	"docker",
	"elixir",
	"go",
	"graphql",
	"html",
	"java",
	"javascript",
	"json",
	"kotlin",
	"markdown",
	"php",
	"plain text",
	"python",
	"ruby",
	"rust",
	"shell",
	"sql",
	"swift",
	"toml",
	"typescript",
	"xml",
	"yaml",
]);

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	ts: "typescript",
	tsx: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	sh: "shell",
	zsh: "shell",
	py: "python",
	yml: "yaml",
	md: "markdown",
	rs: "rust",
	cs: "c#",
	csharp: "c#",
	cpp: "c++",
	dockerfile: "docker",
	text: "plain text",
	txt: "plain text",
	plaintext: "plain text",
	"": "plain text",
};

/** A fence's info string as a language Notion accepts (`ts` → `typescript`); anything unknown is `plain text`. */
function notionLanguage(info: string): string {
	const name = info.trim().toLowerCase();
	const mapped = Object.hasOwn(LANGUAGE_ALIASES, name) ? (LANGUAGE_ALIASES[name] as string) : name;
	return NOTION_LANGUAGES.has(mapped) ? mapped : "plain text";
}

/** Pieces of at most `max` UTF-16 units, never cutting a surrogate pair. */
function splitText(text: string, max: number): string[] {
	const out: string[] = [];
	for (let at = 0; at < text.length; ) {
		let end = Math.min(at + max, text.length);
		const last = text.charCodeAt(end - 1);
		// Never cut between the halves of a surrogate pair.
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		out.push(text.slice(at, end));
		at = end;
	}
	return out;
}

function richText(text: string): Array<{ type: "text"; text: { content: string } }> {
	return splitText(text, NOTION_RICH_TEXT_LIMIT).map((content) => ({
		type: "text" as const,
		text: { content },
	}));
}

/** One block per `NOTION_RICH_TEXT_ITEMS` segments, so a very long text is several blocks, never an invalid one. */
function textBlocks(
	type: string,
	text: string,
	extra: Record<string, unknown> = {},
): NotionBlock[] {
	const parts = splitText(text, NOTION_RICH_TEXT_ITEMS * NOTION_RICH_TEXT_LIMIT);
	if (parts.length === 0) parts.push("");
	return parts.map((part) => ({
		object: "block" as const,
		type,
		[type]: { rich_text: richText(part), ...extra },
	}));
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*).*$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const DIVIDER = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * The PRD markdown as flat Notion blocks: headings, paragraphs, list items, dividers and code blocks (fence language
 * kept). Text is plain: inline markdown is not parsed.
 */
export function markdownToBlocks(markdown: string): NotionBlock[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: NotionBlock[] = [];
	let paragraph: string[] = [];
	const flush = () => {
		if (paragraph.length > 0) blocks.push(...textBlocks("paragraph", paragraph.join("\n")));
		paragraph = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const marker = fence[1] as string;
			const body: string[] = [];
			for (i++; i < lines.length; i++) {
				const close = FENCE_CLOSE.exec(lines[i] as string)?.[1];
				if (close !== undefined && close[0] === marker[0] && close.length >= marker.length) break;
				body.push(lines[i] as string);
			}
			blocks.push(
				...textBlocks("code", body.join("\n"), { language: notionLanguage(fence[2] ?? "") }),
			);
			continue;
		}
		if (line.trim() === "") {
			flush();
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			flush();
			const level = Math.min((heading[1] as string).length, 3);
			blocks.push(...textBlocks(`heading_${level}`, heading[2] ?? ""));
			continue;
		}
		if (DIVIDER.test(line)) {
			flush();
			blocks.push({ object: "block", type: "divider", divider: {} });
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet) {
			flush();
			blocks.push(...textBlocks("bulleted_list_item", bullet[1] ?? ""));
			continue;
		}
		const numbered = NUMBERED.exec(line);
		if (numbered) {
			flush();
			blocks.push(...textBlocks("numbered_list_item", numbered[1] ?? ""));
			continue;
		}
		paragraph.push(line);
	}
	flush();
	return blocks;
}

function markerCallout(text: string): NotionBlock {
	return {
		object: "block",
		type: "callout",
		callout: {
			rich_text: richText(text),
			icon: { type: "emoji", emoji: "📄" },
			color: "gray_background",
		},
	};
}

/** The managed region: a callout carrying key and hash, the PRD blocks, then an end callout. */
export function buildNotionBlocks(key: string, hash: string, markdown: string): NotionBlock[] {
	return [
		markerCallout(`${notionStartPrefix(key)}${markerSafe(hash)}`),
		...markdownToBlocks(markdown),
		markerCallout(NOTION_END_TEXT),
	];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
	return out;
}

interface SeenBlock {
	id: string;
	type: string;
	text: string;
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

interface NotionRegion {
	hash: string;
	ids: string[];
}

/** Complete regions of `key`: a start callout through the next end callout. An unclosed start is not a region. */
function findNotionRegions(blocks: readonly SeenBlock[], key: string): NotionRegion[] {
	const prefix = notionStartPrefix(key);
	const regions: NotionRegion[] = [];
	for (let i = 0; i < blocks.length; i++) {
		const start = blocks[i] as SeenBlock;
		if (start.type !== "callout" || !start.text.startsWith(prefix)) continue;
		for (let j = i + 1; j < blocks.length; j++) {
			const next = blocks[j] as SeenBlock;
			if (next.type !== "callout") continue;
			if (next.text.trim() === NOTION_END_TEXT) {
				regions.push({
					hash: start.text.slice(prefix.length).trim(),
					ids: blocks.slice(i, j + 1).map((block) => block.id),
				});
				i = j;
				break;
			}
			if (next.text.startsWith("ultrathink:prd key=")) break;
		}
	}
	return regions;
}

// ---------------------------------------------------------------------------------------------------------------------
// Linear description region

interface LinearRegion {
	start: number;
	end: number;
	hash: string;
}

function findLinearRegion(description: string, key: string): LinearRegion | undefined {
	const prefix = `<!-- ultrathink:prd:start key=${markerSafe(key)} hash=`;
	const start = description.indexOf(prefix);
	if (start < 0) return undefined;
	const hashStart = start + prefix.length;
	const close = description.indexOf(" -->", hashStart);
	if (close < 0) return undefined;
	const endMarker = description.indexOf(END_MARKER, close);
	return {
		start,
		// An unclosed region (someone deleted the end marker) is replaced through the end of the description.
		end: endMarker < 0 ? description.length : endMarker + END_MARKER.length,
		hash: description.slice(hashStart, close),
	};
}

function summarize(markdown: string): string {
	const cut = clip(markdown, SUMMARY_CHARS, "…").text;
	const fences = cut.match(/^\s*(?:```|~~~)/gm)?.length ?? 0;
	return fences % 2 === 1 ? `${cut}\n\`\`\`` : cut;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ledger

const LEDGER_STATUSES: ReadonlySet<string> = new Set<LedgerStatus>(["pending", "synced", "failed"]);

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function parseTracker(value: unknown): LedgerTracker | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const { status, attempts, updatedAt } = record;
	if (typeof status !== "string" || !LEDGER_STATUSES.has(status)) return undefined;
	if (typeof attempts !== "number" || typeof updatedAt !== "number") return undefined;
	const out: LedgerTracker = { status: status as LedgerStatus, attempts, updatedAt };
	for (const field of ["lastHash", "errorClass", "url", "docId", "docUrl"] as const) {
		const text = optionalString(record, field);
		if (text !== undefined) out[field] = text;
	}
	return out;
}

function parseEntry(value: unknown): LedgerEntry | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const { key, hash, localPath } = record;
	const linear = parseTracker(record.linear);
	const notion = parseTracker(record.notion);
	if (typeof key !== "string" || typeof hash !== "string" || typeof localPath !== "string") {
		return undefined;
	}
	if (!linear || !notion) return undefined;
	const out: LedgerEntry = { key, hash, localPath, linear, notion };
	const issue = optionalString(record, "linearIssueId");
	if (issue !== undefined) out.linearIssueId = issue;
	const page = optionalString(record, "notionPageId");
	if (page !== undefined) out.notionPageId = page;
	if (Array.isArray(record.notionStagedIds)) {
		const ids = record.notionStagedIds.filter((id): id is string => typeof id === "string");
		if (ids.length > 0) out.notionStagedIds = ids;
	}
	return out;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "graph";
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

interface Ctx {
	deps: SyncDeps;
	policy: RetryPolicy;
	notionTools: NotionBlockTools;
	root: string;
	ledgerPath: string;
	entries: Map<string, LedgerEntry>;
	/**
	 * What this sync changed, per key: the trackers whose state it wrote (none for a local-copy change alone). Each persist
	 * lays only these onto the ledger file's current entries, so another sync's changes survive.
	 */
	dirty: Map<string, Set<TrackerName>>;
	now: () => number;
	log: (message: string) => void;
	/** Providers that refused the whole account (auth, quota): the rest of the run does not call them. */
	refused: Partial<Record<TrackerName, Failure>>;
}

/** The ledger file's entries by key: a missing file is empty; an unreadable one is logged and read as empty. */
function readLedger(ledgerPath: string, log: (message: string) => void): Map<string, LedgerEntry> {
	const entries = new Map<string, LedgerEntry>();
	try {
		const parsed = asRecord(JSON.parse(readFileSync(ledgerPath, "utf8")));
		if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
			for (const raw of parsed.entries) {
				const entry = parseEntry(raw);
				if (entry) entries.set(entry.key, entry);
			}
		}
	} catch (error) {
		if (asRecord(error)?.code !== "ENOENT") {
			log(`prd-sync: ledger unreadable, starting empty: ${shortText(error)}`);
		}
	}
	return entries;
}

/** Records that this sync changed `key`: its local copy, and the `tracker` state when one is given. */
function markDirty(ctx: Ctx, key: string, tracker?: TrackerName): void {
	const trackers = ctx.dirty.get(key) ?? new Set<TrackerName>();
	if (tracker !== undefined) trackers.add(tracker);
	ctx.dirty.set(key, trackers);
}

/**
 * The file's entry for one key with this sync's changes laid over it: the local copy's hash and path, and each tracker
 * this sync wrote with its ids. A tracker this sync did not write keeps the file's state.
 */
function mergeEntry(
	current: LedgerEntry | undefined,
	ours: LedgerEntry,
	trackers: ReadonlySet<TrackerName>,
): LedgerEntry {
	if (current === undefined) return ours;
	const merged: LedgerEntry = { ...current, hash: ours.hash, localPath: ours.localPath };
	if (trackers.has("linear")) {
		merged.linear = ours.linear;
		merged.linearIssueId = ours.linearIssueId;
	}
	if (trackers.has("notion")) {
		merged.notion = ours.notion;
		merged.notionPageId = ours.notionPageId;
		merged.notionStagedIds = ours.notionStagedIds;
	}
	return merged;
}

/**
 * Writes this sync's changes under the ledger's lock. The file is re-read inside the lock and only what this sync
 * touched is laid over it, so a concurrent sync's entries survive. A lock that cannot be taken throws (after
 * `CLI_LOCK`'s wait, a `LockTimeoutError`): nothing is written, and the ledger is never written unlocked.
 */
function persist(ctx: Ctx): void {
	withFileLock(
		ctx.ledgerPath,
		() => {
			const entries = readLedger(ctx.ledgerPath, ctx.log);
			for (const [key, trackers] of ctx.dirty) {
				const ours = ctx.entries.get(key);
				if (ours) entries.set(key, mergeEntry(entries.get(key), ours, trackers));
			}
			const ledger: PrdLedger = {
				version: 1,
				graphId: ctx.deps.graphId,
				entries: [...entries.values()],
			};
			writeFileAtomic(ctx.ledgerPath, `${JSON.stringify(ledger, null, "\t")}\n`);
		},
		{ ...CLI_LOCK, createParent: true },
	);
}

function makeCtx(deps: SyncDeps): Ctx {
	const root = join(deps.stateDir ?? resolveStateDir(), "prd-sync", sanitizeSegment(deps.graphId));
	const ledgerPath = join(root, "ledger.json");
	const log = deps.log ?? (() => undefined);
	return {
		deps,
		policy: deps.retryPolicy ?? RETRY_POLICY,
		notionTools: { ...DEFAULT_NOTION_TOOLS, ...deps.notionTools },
		root,
		ledgerPath,
		entries: readLedger(ledgerPath, log),
		dirty: new Map(),
		now: deps.now ?? Date.now,
		log,
		refused: {},
	};
}

function freshTracker(now: number): LedgerTracker {
	return { status: "pending", attempts: 0, updatedAt: now };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tracker calls

interface Counter {
	n: number;
}

async function callTracker(
	ctx: Ctx,
	caller: ToolCaller,
	counter: Counter,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const { signal, sleep, random } = ctx.deps;
	try {
		const { value, attempts } = await withRetry(
			(): Promise<unknown> => caller.call(name, args, signal),
			ctx.policy,
			{
				classify: classifyFailure,
				now: ctx.now,
				...(signal ? { signal } : {}),
				...(sleep ? { sleep } : {}),
				...(random ? { random } : {}),
			},
		);
		counter.n += attempts;
		return value;
	} catch (error) {
		counter.n += error instanceof RetryExhaustedError ? error.attempts : 1;
		throw error;
	}
}

interface WorkItem {
	entry: LedgerEntry;
	/** Secret-redacted PRD text: what is stored locally and uploaded. */
	markdown: string;
}

type WriteResult = { outcome: Exclude<SyncOutcome, "failed" | "pending">; url?: string };

function shouldSkip(ctx: Ctx, tracker: LedgerTracker, hash: string): boolean {
	if (tracker.status !== "synced") return false;
	return ctx.deps.resume === true || tracker.lastHash === hash;
}

function pendingResult(reason: string, errorClass?: string): TrackerResult {
	return {
		outcome: "pending",
		attempts: 0,
		reason,
		...(errorClass === undefined ? {} : { errorClass }),
	};
}

async function runTracker(
	ctx: Ctx,
	name: TrackerName,
	item: WorkItem,
	write: (counter: Counter) => Promise<WriteResult>,
): Promise<TrackerResult> {
	const { entry } = item;
	const tracker = entry[name];
	if (shouldSkip(ctx, tracker, entry.hash)) {
		return {
			outcome: "skipped",
			attempts: 0,
			reason: "unchanged",
			...(tracker.url === undefined ? {} : { url: tracker.url }),
		};
	}
	if (ctx.deps.signal?.aborted) return pendingResult("aborted", "aborted");
	// Marked before this tracker's first change, so every persist of this write carries its state.
	markDirty(ctx, entry.key, name);
	const refused = ctx.refused[name];
	if (refused) {
		tracker.status = "failed";
		tracker.errorClass = refused.errorClass;
		tracker.updatedAt = ctx.now();
		persist(ctx);
		return {
			outcome: "failed",
			attempts: 0,
			errorClass: refused.errorClass,
			error: refused.message,
		};
	}
	const counter: Counter = { n: 0 };
	let result: WriteResult;
	try {
		result = await write(counter);
	} catch (error) {
		const failure = describeFailure(error);
		tracker.status = failure.retryable ? "pending" : "failed";
		tracker.errorClass = failure.errorClass;
		tracker.attempts += counter.n;
		tracker.updatedAt = ctx.now();
		persist(ctx);
		if (failure.errorClass === "auth" || failure.errorClass === "quota") {
			ctx.refused[name] = failure;
		}
		ctx.log(`prd-sync: ${name} ${entry.key}: ${failure.errorClass}`);
		return {
			outcome: failure.retryable ? "pending" : "failed",
			attempts: counter.n,
			errorClass: failure.errorClass,
			error: failure.message,
		};
	}
	// Outside the catch above: a ledger write that fails (lock) is not recorded as a tracker failure.
	tracker.status = "synced";
	tracker.lastHash = entry.hash;
	delete tracker.errorClass;
	if (result.url !== undefined) tracker.url = result.url;
	tracker.attempts += counter.n;
	tracker.updatedAt = ctx.now();
	persist(ctx);
	return {
		outcome: result.outcome,
		attempts: counter.n,
		...(result.url === undefined ? {} : { url: result.url }),
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// Linear

function documentFields(result: unknown): { id?: string; url?: string } {
	const outer = asRecord(result);
	const record = asRecord(outer?.document) ?? outer;
	const out: { id?: string; url?: string } = {};
	if (typeof record?.id === "string" && record.id !== "") out.id = record.id;
	if (typeof record?.url === "string" && record.url !== "") out.url = record.url;
	return out;
}

async function writeLinear(
	ctx: Ctx,
	caller: ToolCaller,
	item: WorkItem,
	counter: Counter,
): Promise<WriteResult> {
	const { entry, markdown } = item;
	const tracker = entry.linear;
	const known = ctx.deps.refs?.linear.steps;
	const ref = known && Object.hasOwn(known, entry.key) ? known[entry.key] : undefined;
	const issueId = ref?.identifier ?? ref?.id ?? entry.linearIssueId;
	if (issueId === undefined || issueId === "") throw new MissingTargetError("linear sub issue");
	entry.linearIssueId = issueId;
	const issue = asRecord(
		await callTracker(ctx, caller, counter, "get_issue", {
			id: issueId,
			fields: ["description", "url"],
		}),
	);
	const description = issue?.description;
	// The description is rewritten around the managed region, so an unreadable result must stop the write.
	if (!issue || (typeof description !== "string" && description !== null)) {
		throw new Error("linear get_issue: unexpected result");
	}
	const current = description ?? "";
	const url = typeof issue.url === "string" ? issue.url : (ref?.url ?? tracker.url);
	const found = findLinearRegion(current, entry.key);
	if (found && found.hash === markerSafe(entry.hash)) {
		return { outcome: "skipped", ...(url === undefined ? {} : { url }) };
	}
	const limit = ctx.deps.linearInlineLimit ?? DEFAULT_LINEAR_INLINE_LIMIT;
	let body: string;
	if (markdown.length > limit) {
		const saved = documentFields(
			await callTracker(ctx, caller, counter, "save_document", {
				title: `PRD ${entry.key}`,
				content: markdown,
				...(tracker.docId === undefined ? { issue: issueId } : { id: tracker.docId }),
			}),
		);
		const docId = saved.id ?? tracker.docId;
		const docUrl = saved.url ?? tracker.docUrl;
		if (docId === undefined && docUrl === undefined) {
			throw new Error("linear save_document: no id or url in result");
		}
		if (docId !== undefined) tracker.docId = docId;
		if (docUrl !== undefined) tracker.docUrl = docUrl;
		// Recorded before the description write, so a failure there never makes a second document.
		persist(ctx);
		const link = docUrl ?? `linear document ${docId}`;
		body = `## PRD (summary)\n\n${neutralize(summarize(markdown))}\n\n[Full PRD](${link})`;
	} else {
		body = `## PRD\n\n${neutralize(markdown)}`;
	}
	const region = `${startMarker(entry.key, entry.hash)}\n${body}\n${END_MARKER}`;
	const trimmed = current.trimEnd();
	const next = found
		? `${current.slice(0, found.start)}${region}${current.slice(found.end)}`
		: trimmed === ""
			? region
			: `${trimmed}\n\n${region}`;
	await callTracker(ctx, caller, counter, "save_issue", { id: issueId, description: next });
	return { outcome: found ? "updated" : "created", ...(url === undefined ? {} : { url }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Notion

async function listChildren(
	ctx: Ctx,
	caller: ToolCaller,
	counter: Counter,
	pageId: string,
): Promise<SeenBlock[]> {
	const seen: SeenBlock[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_SCAN_PAGES; page++) {
		const reply = asRecord(
			await callTracker(ctx, caller, counter, ctx.notionTools.list, {
				block_id: pageId,
				page_size: NOTION_BLOCKS_PER_REQUEST,
				...(cursor === undefined ? {} : { start_cursor: cursor }),
			}),
		);
		if (!Array.isArray(reply?.results)) throw new Error("notion: unexpected block list result");
		for (const raw of reply.results) {
			const block = asRecord(raw);
			if (!block || typeof block.id !== "string") continue;
			seen.push({
				id: block.id,
				type: typeof block.type === "string" ? block.type : "",
				text: blockText(block),
			});
		}
		if (reply.has_more !== true || typeof reply.next_cursor !== "string") return seen;
		cursor = reply.next_cursor;
	}
	throw new Error("notion: page has too many blocks to scan");
}

function isGone(error: unknown): boolean {
	const cause = unwrapRetryError(error);
	if (classifyFailure(cause).status === 404) return true;
	return /object_not_found|could not find block|already archived/i.test(
		cause instanceof Error ? cause.message : String(cause),
	);
}

async function removeBlocks(
	ctx: Ctx,
	caller: ToolCaller,
	counter: Counter,
	ids: readonly string[],
): Promise<void> {
	for (const id of ids) {
		try {
			await callTracker(ctx, caller, counter, ctx.notionTools.remove, { block_id: id });
		} catch (error) {
			// A block that is already gone is the state asked for.
			if (!isGone(error)) throw error;
		}
	}
}

function appendedIds(reply: unknown, count: number): string[] {
	const results = asRecord(reply)?.results;
	if (!Array.isArray(results)) return [];
	const ids = results.flatMap((raw) => {
		const id = asRecord(raw)?.id;
		return typeof id === "string" ? [id] : [];
	});
	return ids.slice(-count);
}

async function writeNotion(
	ctx: Ctx,
	caller: ToolCaller,
	item: WorkItem,
	counter: Counter,
): Promise<WriteResult> {
	const { entry, markdown } = item;
	const tracker = entry.notion;
	const known = ctx.deps.refs?.notion.steps;
	const refUrl = known && Object.hasOwn(known, entry.key) ? known[entry.key] : undefined;
	const pageId = (refUrl === undefined ? undefined : notionPageId(refUrl)) ?? entry.notionPageId;
	if (pageId === undefined) throw new MissingTargetError("notion sub issue page");
	entry.notionPageId = pageId;
	const url = refUrl ?? tracker.url;
	const withUrl = (outcome: WriteResult["outcome"]): WriteResult => ({
		outcome,
		...(url === undefined ? {} : { url }),
	});
	const regions = findNotionRegions(await listChildren(ctx, caller, counter, pageId), entry.key);
	const inRegions = new Set(regions.flatMap((region) => region.ids));
	// Blocks a write that died half way appended (no end callout yet): gone before anything else is written.
	const leftovers = (entry.notionStagedIds ?? []).filter((id) => !inRegions.has(id));
	await removeBlocks(ctx, caller, counter, leftovers);
	const wanted = markerSafe(entry.hash);
	const keep = [...regions].reverse().find((region) => region.hash === wanted);
	if (keep) {
		const stale = regions.filter((region) => region !== keep);
		await removeBlocks(
			ctx,
			caller,
			counter,
			stale.flatMap((region) => region.ids),
		);
		delete entry.notionStagedIds;
		return withUrl(stale.length > 0 || leftovers.length > 0 ? "updated" : "skipped");
	}
	// The new region goes in first and the old one is removed after it, so a failed write never leaves the page
	// without a PRD.
	const staged: string[] = [];
	entry.notionStagedIds = staged;
	persist(ctx);
	const blocks = buildNotionBlocks(entry.key, entry.hash, markdown);
	for (const batch of chunk(blocks, NOTION_BLOCKS_PER_REQUEST)) {
		const reply = await callTracker(ctx, caller, counter, ctx.notionTools.append, {
			block_id: pageId,
			children: batch,
		});
		staged.push(...appendedIds(reply, batch.length));
		persist(ctx);
	}
	await removeBlocks(
		ctx,
		caller,
		counter,
		regions.flatMap((region) => region.ids),
	);
	delete entry.notionStagedIds;
	return withUrl(regions.length > 0 ? "updated" : "created");
}

// ---------------------------------------------------------------------------------------------------------------------
// Orchestration

async function runPool<T>(
	items: readonly T[],
	limit: number,
	signal: AbortSignal | undefined,
	work: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length && !signal?.aborted) {
			await work(items[next++] as T);
		}
	};
	const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	await Promise.all(Array.from({ length: size }, worker));
}

function stateOf(linear: TrackerResult, notion: TrackerResult): KeyReport["state"] {
	if (linear.outcome === "failed" || notion.outcome === "failed") return "failed";
	if (linear.outcome === "pending" || notion.outcome === "pending") return "pending";
	return "synced";
}

function summarizeKeys(keys: readonly KeyReport[]): SyncSummary {
	const count = (state: KeyReport["state"]) => keys.filter((key) => key.state === state).length;
	return {
		total: keys.length,
		synced: count("synced"),
		pending: count("pending"),
		failed: count("failed"),
	};
}

const UNCONFIGURED: TrackerResult = { outcome: "skipped", attempts: 0, reason: "not-configured" };

function localName(key: string): string {
	return `${sanitizeSegment(key)}-${sha256(key).slice(0, 8)}.md`;
}

/**
 * Syncs each PRD to its Linear and Notion Sub Issue. Never throws for a tracker failure: the report says what happened
 * per key and tracker. Only `generated` records are synced; a `failed` PRD reports `failed` and a `skipped` one reports
 * `synced` (nothing is owed). `summary.synced` counts keys with nothing left to send to any configured tracker.
 */
export async function syncPrds(records: readonly PrdRecord[], deps: SyncDeps): Promise<SyncReport> {
	const ctx = makeCtx(deps);
	const reports = new Map<string, KeyReport>();
	const items: WorkItem[] = [];
	const redactedKeys = new Set<string>();
	const unique = new Map<string, PrdRecord>();
	for (const record of records) unique.set(record.key, record);

	// Phase 1, local first: the PRD copy and its hash are on disk before any tracker is contacted.
	let localError: string | undefined;
	for (const record of unique.values()) {
		if (record.status !== "generated") {
			const skipped: TrackerResult = {
				outcome: "skipped",
				attempts: 0,
				reason: `prd-${record.status}`,
			};
			reports.set(record.key, {
				key: record.key,
				state: record.status === "failed" ? "failed" : "synced",
				redacted: false,
				linear: skipped,
				notion: skipped,
			});
			continue;
		}
		try {
			const clean = redactSecrets(record.markdown);
			if (clean !== record.markdown) redactedKeys.add(record.key);
			const hash = /^[0-9a-f]{8,128}$/i.test(record.hash)
				? record.hash.toLowerCase()
				: sha256(record.markdown);
			const localPath = join(ctx.root, localName(record.key));
			writeFileAtomic(localPath, clean);
			let entry = ctx.entries.get(record.key);
			if (entry) {
				entry.hash = hash;
				entry.localPath = localPath;
				for (const name of ["linear", "notion"] as const) {
					const tracker = entry[name];
					if (!deps.resume && tracker.status === "synced" && tracker.lastHash !== hash) {
						tracker.status = "pending";
						markDirty(ctx, record.key, name);
					}
				}
			} else {
				const now = ctx.now();
				entry = {
					key: record.key,
					hash,
					localPath,
					linear: freshTracker(now),
					notion: freshTracker(now),
				};
				ctx.entries.set(record.key, entry);
			}
			markDirty(ctx, record.key);
			items.push({ entry, markdown: clean });
		} catch (error) {
			localError = shortText(error);
			break;
		}
	}
	if (localError === undefined) {
		try {
			persist(ctx);
		} catch (error) {
			localError = shortText(error);
		}
	}
	if (localError !== undefined) {
		// Nothing durable to resume from: no network call is made.
		ctx.log("prd-sync: local write failed, no tracker contacted");
		for (const record of unique.values()) {
			if (reports.has(record.key)) continue;
			const result: TrackerResult = {
				...pendingResult("local-write-failed", "local-write"),
				error: localError,
			};
			reports.set(record.key, {
				key: record.key,
				state: "pending",
				redacted: false,
				linear: result,
				notion: result,
			});
		}
		return finish(ctx, unique, reports);
	}

	// Phase 2: the two trackers run side by side, each with its own bounded pool.
	const results = new Map<string, Partial<Record<TrackerName, TrackerResult>>>();
	const setResult = (key: string, name: TrackerName, result: TrackerResult) => {
		results.set(key, { ...results.get(key), [name]: result });
	};
	const lane = (
		name: TrackerName,
		caller: ToolCaller | undefined,
		limit: number,
		write: typeof writeLinear,
	) =>
		runPool(items, limit, deps.signal, async (item) => {
			if (!caller) {
				setResult(item.entry.key, name, UNCONFIGURED);
				return;
			}
			const result = await runTracker(ctx, name, item, (counter) =>
				write(ctx, caller, item, counter),
			);
			setResult(item.entry.key, name, result);
		});
	await Promise.all([
		lane("linear", deps.linear, deps.concurrency?.linear ?? 4, writeLinear),
		lane("notion", deps.notion, deps.concurrency?.notion ?? 3, writeNotion),
	]);
	for (const item of items) {
		const done = results.get(item.entry.key);
		const linear = done?.linear ?? pendingResult("aborted", "aborted");
		const notion = done?.notion ?? pendingResult("aborted", "aborted");
		reports.set(item.entry.key, {
			key: item.entry.key,
			state: stateOf(linear, notion),
			redacted: redactedKeys.has(item.entry.key),
			linear,
			notion,
		});
	}
	return finish(ctx, unique, reports);
}

function finish(
	ctx: Ctx,
	unique: ReadonlyMap<string, PrdRecord>,
	reports: ReadonlyMap<string, KeyReport>,
): SyncReport {
	// Input order, one entry per key.
	const keys = [...unique.keys()].flatMap((key) => {
		const report = reports.get(key);
		return report ? [report] : [];
	});
	return {
		graphId: ctx.deps.graphId,
		keys,
		summary: summarizeKeys(keys),
		ledgerPath: ctx.ledgerPath,
	};
}

/**
 * Re-sends what the ledger still owes: every key with a configured tracker in `pending` or `failed`, from the local PRD
 * copy written before the first attempt. A synced tracker is never touched. A key whose local copy is gone reports
 * `failed` (`local-missing`).
 */
export async function resumePrds(deps: SyncDeps): Promise<SyncReport> {
	const ctx = makeCtx(deps);
	const owes = (tracker: LedgerTracker, caller: ToolCaller | undefined) =>
		caller !== undefined && tracker.status !== "synced";
	const records: PrdRecord[] = [];
	const missing: KeyReport[] = [];
	for (const entry of ctx.entries.values()) {
		if (!owes(entry.linear, deps.linear) && !owes(entry.notion, deps.notion)) continue;
		let markdown: string;
		try {
			markdown = readFileSync(entry.localPath, "utf8");
		} catch {
			const lost: TrackerResult = {
				outcome: "failed",
				attempts: 0,
				errorClass: "local-missing",
				error: "local PRD copy is missing",
			};
			missing.push({
				key: entry.key,
				state: "failed",
				redacted: false,
				linear: lost,
				notion: lost,
			});
			continue;
		}
		records.push({
			key: entry.key,
			hash: entry.hash,
			markdown,
			status: "generated",
			model: "local",
			fallback: false,
			attempts: 0,
		});
	}
	const report = await syncPrds(records, { ...deps, resume: true });
	const keys = [...report.keys, ...missing];
	return { ...report, keys, summary: summarizeKeys(keys) };
}
