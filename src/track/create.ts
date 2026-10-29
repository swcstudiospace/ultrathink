// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Creates the tracker rows for a TrackPlan (Linear issues/sub-issues, Notion rows) through
 * MCP tool callers. Idempotent against `existing`, bounded by one budget signal, never throws.
 *
 * Every tracker call runs through the retry kernel (429, 5xx, timeouts and Retry-After are retried, a permanent
 * refusal is not). A refusal that covers the whole provider (auth, permission, quota) opens a breaker for that
 * provider for the rest of the run. Linear and Notion run independently of each other.
 *
 * A create has no idempotency key, so a failure that may have left the row behind (a timeout, a 5xx, a reset, a lost
 * reply) is never answered by a blind repeat: the tracker is read back for the row first, and when that read fails
 * the create is not repeated. Adoption on a re-run matches a row by its title as well as its key, so a resend that got
 * another graph under the same graph id does not point its checklist at rows that describe the old plan.
 */
import type { ThoughtGraph } from "../think/types.ts";
import type { ProgressSink } from "../host/progress.ts";
import { FIELD_CAPS, clip } from "../resilience/limits.ts";
import {
	RETRY_AFTER_CAP_MS,
	isTransientFailure,
	unwrapRetryError,
	withRetry,
	type FailureVerdict,
	type RetryPolicy,
} from "../resilience/retry.ts";
import type { abortableSleep } from "../resilience/sleep.ts";
import { isAbortError } from "../shared.ts";
import type { IssueRef, IssueRow, SubIssueRow, TrackingRefs, TrackPlan } from "./types.ts";
import { nonEmpty } from "../teach/digest.ts";

export interface ToolCaller {
	/** Resolves structuredContent, else JSON-parsed first text content, else the raw text; throws on isError/transport error. */
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export function stepKey(nodeId: string, step: number): string {
	return `${nodeId}.${step}`;
}

/** A prototype-free copy of a tracking map: node ids come from the model and from tracker rows, so `constructor` or `__proto__` must act as plain keys. */
function trackingMap<T>(entries: Readonly<Record<string, T>> | undefined): Record<string, T> {
	const out = Object.create(null) as Record<string, T>;
	for (const [key, value] of Object.entries(entries ?? {})) out[key] = value;
	return out;
}

/** Minimal timer port: the platform `setTimeout`/`clearTimeout` by default, or a test double. */
type TimerPort = {
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
};

const platformTimers: TimerPort = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

export interface CreateTrackingDeps {
	linear?: ToolCaller;
	notion?: ToolCaller;
	/** Linear team; unset = Linear not configured: no Linear calls, and its rows do not count toward `status`. */
	linearTeam?: string;
	/** Notion data source uuid, without the `collection://` prefix; unset = Notion not configured, like `linearTeam`. */
	notionDataSource?: string;
	concurrency: number;
	/** Whole creation budget in ms; 0 = no limit (no abort timer is created). */
	budgetMs: number;
	now?: () => number;
	/** Timer port for the creation budget and the Linear link wait; defaults to the platform timers. */
	timers?: TimerPort;
	/** Wait between retries of a tracker call; defaults to the kernel's abortable sleep. */
	sleep?: typeof abortableSleep;
	/** Jitter source of the retry wait; defaults to `Math.random`. */
	random?: () => number;
	/** How long Notion node and step rows wait for Linear's links before going without them (default 20 s). */
	linkWaitMs?: number;
	/** Node ids whose fill is degraded: their Linear and Notion rows carry a "[degraded fill]" marker. */
	degradedNodes?: readonly string[];
	/** A credential lookup that failed, per provider (short, secret-free): reported apart from "login required". */
	credentialErrors?: { linear?: string; notion?: string };
	log?: (message: string) => void;
	/**
	 * Called with the live refs right after each row is created or adopted (a Linear issue or sub-issue, the Notion task, or
	 * one Notion batch of node or step pages), before the next call starts: a checkpoint the caller can save so a kill keeps every ref made so far.
	 * It must copy what it keeps; errors thrown by it are ignored.
	 */
	onRef?: (refs: TrackingRefs) => void;
	/** Receives a `track` event after every creation, adoption pass and failure; errors thrown by it are ignored. */
	progress?: ProgressSink;
}

const LINEAR_URL_RE = /https:\/\/linear\.app\/\S+?\/issue\/[A-Z][A-Z0-9]*-\d+[^\s"')\]]*/;
const IDENTIFIER_RE = /\b[A-Z][A-Z0-9]*-\d+\b/;
const NOTION_URL_RE =
	/https:\/\/(?:(?:www\.)?notion\.(?:so|site)|app\.notion\.com)\/[^\s"')\]<>]+/g;
const NOTION_BATCH = 25;

/** Three tries per tracker call: the first plus two retries, full-jitter backoff raised to any Retry-After. */
const RETRY_POLICY: RetryPolicy = { maxAttempts: 3, baseMs: 500, capMs: 8_000 };
/** The longest Notion rows wait for Linear's links when Linear is slow or stuck. */
const LINK_WAIT_MS = 20_000;
/** The relay's rate-limit text: `... rate limited; retry after 3s`. */
const RETRY_AFTER_TEXT = /retry after (\d+(?:\.\d+)?)\s*s/i;
/** A message that says the account has run out of allowance: no later attempt helps. */
const QUOTA_TEXT = /\bquota\b|usage limit|plan limit|billing/i;
/** Failure text that says the request never reached the tracker's create: no connection, no DNS answer, a rate limit. */
const PRE_CREATION_TEXT =
	/connection refused|econnrefused|enotfound|eai_again|getaddrinfo|dns (?:lookup|failure|error)|could not resolve host|no route to host|rate limit|too many requests/i;
const DEGRADED_MARKER = "[degraded fill] ";

type Provider = "linear" | "notion";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function toText(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

/** Pulls id/identifier/url out of a save_issue result; undefined when identifier or url is missing. */
function extractIssueRef(result: unknown, title: string): IssueRef | undefined {
	let record = asRecord(result);
	if (!record && typeof result === "string") {
		try {
			record = asRecord(JSON.parse(result));
		} catch {
			record = undefined;
		}
	}
	const candidates = [record, asRecord(record?.issue)].filter(
		(entry): entry is Record<string, unknown> => !!entry,
	);
	let id: string | undefined;
	let identifier: string | undefined;
	let url: string | undefined;
	for (const candidate of candidates) {
		identifier ??= nonEmpty(candidate.identifier);
		url ??= nonEmpty(candidate.url);
		id ??= nonEmpty(candidate.id);
	}
	const text = toText(result);
	url ??= text.match(LINEAR_URL_RE)?.[0];
	identifier ??= (url ?? "").match(IDENTIFIER_RE)?.[0] ?? text.match(IDENTIFIER_RE)?.[0];
	if (!identifier || !url) return undefined;
	return { id: id ?? identifier, identifier, url, title };
}

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/\s+/g, " ").trim().slice(0, 160) || "error";
}

/** The failure a raced call reports once the budget is gone. Named `AbortError` so the retry kernel never retries it. */
function budgetExhausted(): Error {
	return Object.assign(new Error("budget exhausted"), { name: "AbortError" });
}

/** Races `promise` with the signal so a caller that ignores the signal cannot outlive the budget. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(budgetExhausted());
	const { promise: raced, resolve, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(budgetExhausted());
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	return raced;
}

/**
 * How the kernel judges a tracker failure: its own verdict, plus the two things only this transport shows. The relay
 * reports a rate limit as text carrying `retry after Ns`, and a quota message without a status is still permanent.
 */
function classifyTrackerFailure(error: unknown, now?: number): FailureVerdict {
	const verdict = isTransientFailure(error, now);
	if (!verdict.transient) return verdict;
	const text = error instanceof Error ? error.message : String(error);
	if (QUOTA_TEXT.test(text)) return { ...verdict, transient: false, reason: "quota text" };
	if (verdict.retryAfterMs !== undefined) return verdict;
	const seconds = RETRY_AFTER_TEXT.exec(text)?.[1];
	const ms = seconds === undefined ? 0 : Math.round(Number(seconds) * 1000);
	return ms > 0 ? { ...verdict, retryAfterMs: Math.min(ms, RETRY_AFTER_CAP_MS) } : verdict;
}

/** True when a refusal covers the whole provider (auth, permission, quota), not just the one request that met it. */
function refusesProvider(error: unknown): boolean {
	if (isAbortError(error)) return false;
	const verdict = classifyTrackerFailure(error, Date.now());
	if (verdict.transient) return false;
	if (/content policy/i.test(shortError(error))) return false;
	return verdict.status === undefined || [401, 402, 403, 429].includes(verdict.status);
}

/** Thrown for a call the breaker refused: the provider's one recorded error already says why. */
class BreakerOpenError extends Error {
	constructor(provider: Provider, reason: string) {
		super(`${provider} breaker open: ${reason}`);
		this.name = "BreakerOpenError";
	}
}

async function runPool<T>(
	items: T[],
	limit: number,
	signal: AbortSignal,
	work: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < items.length && !signal.aborted) {
			const item = items[next++] as T;
			await work(item);
		}
	};
	const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
	await Promise.all(Array.from({ length: size }, worker));
}

function footer(graphId: string, nodeId: string, step?: number): string {
	return `ultrathink graph ${graphId} · node ${nodeId}${step === undefined ? "" : ` · step ${step}`}`;
}

/** `[n2] Build` becomes `[n2] [degraded fill] Build`: the node id stays first, because adoption reads it from there. */
function markTitle(nodeId: string, title: string): string {
	const prefix = `[${nodeId}]`;
	const rest = title.startsWith(prefix) ? title.slice(prefix.length).trimStart() : title;
	return `${prefix} ${DEGRADED_MARKER}${rest}`;
}

const DEGRADED_RE = /\[degraded fill\]\s*/gi;

/**
 * A title as adoption compares it: without the degraded marker (it says how the fill went, not what the row is about),
 * trimmed, whitespace collapsed, case-insensitive.
 */
function normalTitle(title: string): string {
	return title.replace(DEGRADED_RE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sameTitle(left: string | undefined, right: string | undefined): boolean {
	return left !== undefined && right !== undefined && normalTitle(left) === normalTitle(right);
}

/** The title of a node's Linear issue: the plan's, led by `[nodeId]` (and the degraded marker for a degraded fill). */
function linearNodeTitle(nodeId: string, title: string, degraded: boolean): string {
	if (degraded) return markTitle(nodeId, title);
	return title.startsWith(`[${nodeId}]`) ? title : `[${nodeId}] ${title}`;
}

/**
 * The Item a node's Notion row is created with, the one rule for building it and for comparing it. A degraded node's
 * base title is clipped to leave room for the `[<id>] [degraded fill] ` prefix and the prefix is added after, so the
 * marker is never clipped and the base title's tail is the same whichever way it is read.
 */
function notionNodeItem(row: IssueRow, degraded: boolean): string {
	if (!degraded) return clip(row.item, FIELD_CAPS.title).text;
	const prefix = markTitle(row.nodeId, "");
	const lead = `[${row.nodeId}]`;
	const base = row.item.startsWith(lead) ? row.item.slice(lead.length).trimStart() : row.item;
	return prefix + clip(base, Math.max(FIELD_CAPS.title - prefix.length, 1)).text;
}

/** The Items a node's Notion row can carry: as a clean node or as a degraded one (a later run may not know which it was). */
function notionNodeItems(row: IssueRow): string[] {
	return [notionNodeItem(row, false), notionNodeItem(row, true)];
}

/** The Item a step's Notion row is created with. */
function notionStepItem(row: SubIssueRow): string {
	return clip(row.item, FIELD_CAPS.step).text;
}

/** A Notion page as compared: its 32-digit id when the text has one (any url form, dashes or not), else the url lowercased. */
function pageKey(value: string): string {
	const text = value
		.trim()
		.toLowerCase()
		.replace(/[?#].*$/, "")
		.replace(/\/+$/, "");
	return text.replace(/-/g, "").match(/[0-9a-f]{32}$/)?.[0] ?? text;
}

/** True when two Notion urls or ids name the same page (any url form: workspace slug, host, query, dashes). */
function samePage(recorded: string | undefined, url: string): boolean {
	return recorded !== undefined && pageKey(recorded) === pageKey(url);
}

/** The pages a `Parent Item` relation value points at (a JSON array, urls, ids or a list of them), as `pageKey`s. */
function parentKeys(value: unknown): string[] {
	const text = Array.isArray(value)
		? value.map(String).join(" ")
		: typeof value === "string"
			? value
			: "";
	const found = [
		...(text.match(/https?:\/\/[^\s"',[\]]+/g) ?? []),
		...(text.match(/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi) ?? []),
	];
	const keys = found.map(pageKey);
	return keys.length > 0 || text.trim() === "" ? keys : [pageKey(text)];
}

/** What a tracker caller is guarded with: retried, refused once its breaker is open, and able to read back a create. */
interface GuardedCaller extends ToolCaller {
	/**
	 * A create. A failure that may have left the row behind (a timeout, a 5xx, a reset, a lost reply) is never answered
	 * by a blind repeat: `readBack` looks for the row first and the row it finds is the answer. A read-back that fails
	 * ends the create with an error, because a duplicate row is worse than a missing one. `makeArgs` is called again for
	 * every attempt, so a repeat can ask for less than the first try did.
	 */
	create(
		name: string,
		makeArgs: () => Record<string, unknown>,
		readBack: () => Promise<unknown>,
	): Promise<unknown>;
}

/** The deps a run hands its providers: the same as the caller's, with guarded callers. */
type RunDeps = Omit<CreateTrackingDeps, "linear" | "notion"> & {
	linear?: GuardedCaller;
	notion?: GuardedCaller;
};

/** The titles every row of a plan is created with, by key (`nodeId`, or `nodeId.step`). */
interface PlanTitles {
	linearNodes: Map<string, string>;
	linearSteps: Map<string, string>;
	notionNodes: Map<string, string[]>;
	notionSteps: Map<string, string[]>;
}

function planTitles(plan: TrackPlan): PlanTitles {
	return {
		linearNodes: new Map(
			plan.linearIssues.map((issue) => [
				issue.nodeId,
				linearNodeTitle(issue.nodeId, issue.title, false),
			]),
		),
		linearSteps: new Map(
			plan.linearSubIssues.map((sub) => [stepKey(sub.nodeId, sub.step), sub.title]),
		),
		notionNodes: new Map(plan.issues.map((row) => [row.nodeId, notionNodeItems(row)])),
		notionSteps: new Map(
			plan.subIssues.map((row) => [stepKey(row.nodeId, row.step), [notionStepItem(row)]]),
		),
	};
}

/** Keys of recorded rows that describe other work than the plan now does. */
interface StaleKeys {
	linearNodes: Set<string>;
	linearSteps: Set<string>;
	notionNodes: Set<string>;
	notionSteps: Set<string>;
}

function emptyStale(): StaleKeys {
	return {
		linearNodes: new Set(),
		linearSteps: new Set(),
		notionNodes: new Set(),
		notionSteps: new Set(),
	};
}

/** A title that is known on both sides and differs. An unknown side is not a difference: nothing says the row is stale. */
function differs(have: string | undefined, want: string | undefined): boolean {
	return have !== undefined && want !== undefined && !sameTitle(have, want);
}

function matchesAny(title: string, want: readonly string[] | undefined): boolean {
	return want !== undefined && want.some((candidate) => sameTitle(title, candidate));
}

/** The recorded Linear refs whose issue no longer carries the title the plan gives that key (the refs keep their own title). */
function staleRefs(refs: TrackingRefs, current: PlanTitles): StaleKeys {
	const stale = emptyStale();
	for (const [key, ref] of Object.entries(refs.linear.nodes))
		if (differs(refTitle(ref), current.linearNodes.get(key))) stale.linearNodes.add(key);
	for (const [key, ref] of Object.entries(refs.linear.steps))
		if (differs(refTitle(ref), current.linearSteps.get(key))) stale.linearSteps.add(key);
	return stale;
}

function refTitle(ref: IssueRef): string | undefined {
	return typeof ref.title === "string" ? ref.title : undefined;
}

/** Remembers that `nodeId`'s issue still has to be blocked by `deps` (their issues did not exist, or are being replaced). */
function addPending(refs: TrackingRefs, nodeId: string, deps: readonly string[]): void {
	const pending = (refs.pendingLinks ??= trackingMap<string[]>(undefined));
	pending[nodeId] = [...new Set([...(pending[nodeId] ?? []), ...deps])];
}

/**
 * Takes the stale rows out of `refs` so the run creates fresh ones. The old rows are left alone in the trackers. The steps
 * of a replaced node hang under its old row and go with it; a kept node that was blocked by a replaced node waits for the
 * link to the new row.
 */
function removeStale(
	refs: TrackingRefs,
	plan: TrackPlan,
	graph: ThoughtGraph | undefined,
	stale: StaleKeys,
): void {
	for (const sub of plan.linearSubIssues)
		if (stale.linearNodes.has(sub.nodeId)) stale.linearSteps.add(stepKey(sub.nodeId, sub.step));
	for (const sub of plan.subIssues)
		if (stale.notionNodes.has(sub.nodeId)) stale.notionSteps.add(stepKey(sub.nodeId, sub.step));
	for (const key of stale.linearNodes) {
		delete refs.linear.nodes[key];
		if (refs.pendingLinks) delete refs.pendingLinks[key];
	}
	for (const key of stale.linearSteps) delete refs.linear.steps[key];
	for (const key of stale.notionNodes) delete refs.notion.nodes[key];
	for (const key of stale.notionSteps) delete refs.notion.steps[key];
	if (stale.linearNodes.size === 0) return;
	for (const node of graph?.nodes ?? []) {
		if (!refs.linear.nodes[node.id]) continue;
		const replaced = node.dependsOn.filter((dep) => dep !== node.id && stale.linearNodes.has(dep));
		if (replaced.length > 0) addPending(refs, node.id, replaced);
	}
}

/** Drops the pending links that no longer apply: a node or dependency that left the plan or the graph, or a node with no issue. */
function prunePending(refs: TrackingRefs, plan: TrackPlan, graph: ThoughtGraph | undefined): void {
	const pending = refs.pendingLinks;
	if (!pending) return;
	const inPlan = new Set(plan.linearIssues.map((issue) => issue.nodeId));
	const wanted = graph && new Map(graph.nodes.map((node) => [node.id, new Set(node.dependsOn)]));
	for (const [nodeId, deps] of Object.entries(pending)) {
		const keep = deps.filter(
			(dep) => dep !== nodeId && inPlan.has(dep) && (!wanted || wanted.get(nodeId)?.has(dep)),
		);
		if (!inPlan.has(nodeId) || !refs.linear.nodes[nodeId] || keep.length === 0)
			delete pending[nodeId];
		else pending[nodeId] = keep;
	}
}

/** True when the failure happened before the tracker could have created anything: a refusal, a rate limit, no connection. */
function failedBeforeCreation(error: unknown): boolean {
	const { status } = classifyTrackerFailure(error);
	if (status !== undefined)
		return status === 425 || status === 429 || (status >= 400 && status < 500 && status !== 408);
	const code = asRecord(error)?.code;
	const text = error instanceof Error ? error.message : String(error);
	return PRE_CREATION_TEXT.test(`${typeof code === "string" ? code : ""} ${text}`);
}

/** Thrown when a create's outcome is unknown and the read-back that would tell failed too: the create is not repeated. */
class ReadBackFailedError extends Error {
	constructor(createError: unknown, readError: unknown) {
		super(
			`read-back failed (${shortError(readError).slice(0, 60)}) after an uncertain create (${shortError(createError).slice(0, 60)}); not repeated`,
		);
		this.name = "ReadBackFailedError";
	}
}

/** How the kernel judges a failed create: a refused read-back or an open breaker ends it; the rest as for any call. */
function classifyCreate(error: unknown, now?: number): FailureVerdict {
	if (error instanceof ReadBackFailedError || error instanceof BreakerOpenError)
		return { transient: false, reason: "read-back unavailable" };
	return classifyTrackerFailure(error, now);
}

/** Dependency levels for the plan's nodes (graph order when no graph). */
function nodeLevels(nodeIds: string[], graph: ThoughtGraph | undefined): string[][] {
	const inPlan = new Set(nodeIds);
	const deps = new Map<string, string[]>();
	for (const node of graph?.nodes ?? [])
		deps.set(
			node.id,
			node.dependsOn.filter((dep) => inPlan.has(dep) && dep !== node.id),
		);
	const level = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (id: string): number => {
		const known = level.get(id);
		if (known !== undefined) return known;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const value = Math.max(-1, ...(deps.get(id) ?? []).map(depth)) + 1;
		visiting.delete(id);
		level.set(id, value);
		return value;
	};
	const levels: string[][] = [];
	for (const id of nodeIds) (levels[depth(id)] ??= []).push(id);
	return levels.filter((entry) => entry.length > 0);
}

/** Property names every ultrathink Agent Task Graph data source has; a parsed schema without them was not understood. */
const CORE_PROPERTIES = ["Item", "Level", "Graph ID"] as const;

function collectSchemaNames(result: unknown): Set<string> {
	const names = new Set<string>();
	const texts: string[] = [];
	const walk = (value: unknown, depth: number): void => {
		if (depth > 8) return;
		if (typeof value === "string") {
			texts.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry, depth + 1);
			return;
		}
		const record = asRecord(value);
		if (!record) return;
		for (const [key, child] of Object.entries(record)) {
			if (key === "properties" || key === "schema") {
				const props = asRecord(child);
				if (props) for (const name of Object.keys(props)) names.add(name);
				if (Array.isArray(child)) {
					for (const entry of child) {
						const name = nonEmpty(asRecord(entry)?.name);
						if (name) names.add(name);
					}
				}
			}
			walk(child, depth + 1);
		}
	};
	walk(result, 0);
	// A text payload carries the schema as JSON inside markup, e.g. `{ text: "…<data-source-state>{…}</data-source-state>…" }`.
	// Scan each string leaf itself: stringifying the whole result would escape the quotes the patterns rely on.
	for (const text of [...texts]) {
		for (const match of text.matchAll(/"([^"\\\n]{1,80})"\s*:\s*\{[^{}]*?"type"\s*:/g))
			names.add(match[1] as string);
		const blocks = [...text.matchAll(/<([\w-]+)>\s*(\{[\s\S]*?\})\s*<\/\1>/g)].map(
			(match) => match[2] as string,
		);
		for (const block of [...blocks, ...(text.match(/\{[\s\S]*\}/g) ?? [])]) {
			try {
				walk(JSON.parse(block), 0);
			} catch {
				// reason: not JSON
			}
		}
	}
	names.delete("type");
	return names;
}

function notionUrls(result: unknown): string[] {
	const record = asRecord(result);
	const structured = Array.isArray(result)
		? result
		: Array.isArray(record?.pages)
			? (record.pages as unknown[])
			: undefined;
	if (structured && structured.length > 0) {
		const urls = structured.map((entry) => nonEmpty(asRecord(entry)?.url));
		if (urls.every((url) => url !== undefined)) return urls as string[];
	}
	const seen = new Set<string>();
	const urls: string[] = [];
	for (const match of toText(result).matchAll(NOTION_URL_RE)) {
		const url = match[0].replace(/[.,;]+$/, "");
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

/** Finds the first array of records in a list-style result: array, or {issues|nodes|results|rows|pages: [...]}. */
function listEntries(result: unknown): Record<string, unknown>[] {
	let value = result;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return [];
		}
	}
	const record = asRecord(value);
	const list = Array.isArray(value)
		? value
		: (["issues", "nodes", "results", "rows", "pages", "data"]
				.map((key) => record?.[key])
				.find(Array.isArray) as unknown[] | undefined);
	return (list ?? []).map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry);
}

type IssueEmitter = (
	provider: Provider,
	nodeId: string,
	step: number | undefined,
	ref: { identifier?: string; url: string },
) => void;

interface LinearRow {
	nodeId: string;
	step: number | undefined;
	title: string;
	ref: IssueRef;
	/** The listed issue as the tracker returned it. */
	issue: Record<string, unknown>;
}

/** Every Linear issue that carries this graph's description footer. A failure is the caller's to record. */
async function lookupLinear(
	plan: TrackPlan,
	linear: ToolCaller,
	signal: AbortSignal,
): Promise<LinearRow[]> {
	const result = await linear.call(
		"list_issues",
		{ query: `ultrathink graph ${plan.graphId}`, limit: 250 },
		signal,
	);
	const graphPattern = plan.graphId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`ultrathink graph ${graphPattern} · node (\\S+?)(?: · step (\\d+))?\\s*$`,
		"m",
	);
	const rows: LinearRow[] = [];
	for (const issue of listEntries(result)) {
		const match = nonEmpty(issue.description)?.match(re);
		if (!match) continue;
		const title = nonEmpty(issue.title) ?? "";
		const ref = extractIssueRef(issue, title);
		if (!ref) continue;
		rows.push({
			nodeId: match[1] as string,
			step: match[2] === undefined ? undefined : Number(match[2]),
			title,
			ref,
			issue,
		});
	}
	return rows;
}

/**
 * Re-run only: adopts the Linear issues this graph's footer marks and whose title is the one the plan gives that node or
 * step now. A row with other work under the same key is left alone. A failure is the caller's to record.
 */
async function adoptLinear(
	plan: TrackPlan,
	refs: TrackingRefs,
	linear: ToolCaller,
	signal: AbortSignal,
	emitIssue: IssueEmitter,
	titles: PlanTitles,
): Promise<void> {
	const rows = await lookupLinear(plan, linear, signal);
	const listed = new Set<string>();
	for (const row of rows) {
		if (row.step !== undefined) continue;
		listed.add(row.nodeId);
		if (refs.linear.nodes[row.nodeId]) continue;
		if (!sameTitle(row.title, titles.linearNodes.get(row.nodeId))) continue;
		refs.linear.nodes[row.nodeId] = row.ref;
		emitIssue("linear", row.nodeId, undefined, row.ref);
	}
	for (const row of rows) {
		if (row.step === undefined) continue;
		// A node whose issues are listed but none matches the plan was replaced: its steps hang under the old issue.
		if (listed.has(row.nodeId) && !refs.linear.nodes[row.nodeId]) continue;
		const key = stepKey(row.nodeId, row.step);
		if (refs.linear.steps[key]) continue;
		if (!sameTitle(row.title, titles.linearSteps.get(key))) continue;
		refs.linear.steps[key] = row.ref;
		emitIssue("linear", row.nodeId, row.step, row.ref);
	}
}

interface NotionRow {
	url: string;
	level: string;
	/** Set for node and step rows only. */
	nodeId?: string;
	step?: number;
	item: string;
	/** The pages the `Parent Item` relation points at, as `pageKey`s; empty when the row says none or the query did not return it. */
	parents: string[];
}

/** Every Notion row tagged with this graph's Graph ID. A failure is the caller's to record. */
async function lookupNotion(
	plan: TrackPlan,
	notion: ToolCaller,
	dataSource: string,
	signal: AbortSignal,
): Promise<NotionRow[]> {
	const collection = `collection://${dataSource}`;
	const result = await notion.call(
		"notion-query-data-sources",
		{
			data: {
				data_source_urls: [collection],
				query: `SELECT url, "Level", "Item", "Step", "Parent Item" FROM "${collection}" WHERE "Graph ID" = ?`,
				params: [plan.graphId],
			},
		},
		signal,
	);
	const rows: NotionRow[] = [];
	for (const row of listEntries(result)) {
		const url = nonEmpty(row.url);
		const level = nonEmpty(row.Level);
		if (!url || !level) continue;
		const item = nonEmpty(row.Item) ?? "";
		if (level === "Task") {
			rows.push({ url, level, item, parents: [] });
			continue;
		}
		const nodeId = item.match(/^\[([^\]]+)\]/)?.[1];
		if (!nodeId) continue;
		const step = Number(row.Step);
		rows.push({
			url,
			level,
			nodeId,
			item,
			parents: parentKeys(row["Parent Item"]),
			...(level === "Sub-Issue" && Number.isFinite(step) ? { step } : {}),
		});
	}
	return rows;
}

/**
 * Re-run only: adopts the Notion rows tagged with this graph's Graph ID whose Item is the one the plan gives that node or
 * step now. A recorded ref whose row says something else is dropped (the row stays in Notion), so a fresh row replaces
 * it. A failure is the caller's to record.
 */
async function adoptNotion(
	plan: TrackPlan,
	graph: ThoughtGraph | undefined,
	refs: TrackingRefs,
	notion: ToolCaller,
	dataSource: string,
	signal: AbortSignal,
	titles: PlanTitles,
): Promise<void> {
	const rows = await lookupNotion(plan, notion, dataSource, signal);
	const stale = emptyStale();
	const nodes: NotionRow[] = [];
	const steps: NotionRow[] = [];
	const listed = new Set<string>();
	for (const row of rows) {
		if (row.level === "Task") {
			refs.notion.taskUrl ??= row.url;
		} else if (row.nodeId === undefined) {
			// reason: a row without a node id belongs to no node, so there is nothing to adopt
		} else if (row.level === "Issue") {
			listed.add(row.nodeId);
			const want = titles.notionNodes.get(row.nodeId);
			if (matchesAny(row.item, want)) nodes.push(row);
			else if (want !== undefined && samePage(refs.notion.nodes[row.nodeId], row.url))
				stale.notionNodes.add(row.nodeId);
		} else if (row.level === "Sub-Issue" && row.step !== undefined) {
			const key = stepKey(row.nodeId, row.step);
			const want = titles.notionSteps.get(key);
			if (matchesAny(row.item, want)) steps.push(row);
			else if (want !== undefined && samePage(refs.notion.steps[key], row.url))
				stale.notionSteps.add(key);
		}
	}
	removeStale(refs, plan, graph, stale);
	for (const row of nodes) refs.notion.nodes[row.nodeId as string] ??= row.url;
	for (const row of steps) {
		const nodeId = row.nodeId as string;
		// A node whose rows are listed but none matches the plan was replaced: its steps hang under the old row.
		if (listed.has(nodeId) && !refs.notion.nodes[nodeId]) continue;
		// A child belongs to the Issue its `Parent Item` names: one that hangs under another Issue (the replaced one) is not this one's.
		const parent = refs.notion.nodes[nodeId];
		if (parent && row.parents.length > 0 && !row.parents.includes(pageKey(parent))) continue;
		refs.notion.steps[stepKey(nodeId, row.step as number)] ??= row.url;
	}
}

export async function createTracking(
	plan: TrackPlan,
	graph: ThoughtGraph | undefined,
	existing: TrackingRefs | undefined,
	deps: CreateTrackingDeps,
): Promise<TrackingRefs> {
	const now = deps.now ?? Date.now;
	const timers = deps.timers ?? platformTimers;
	const refs: TrackingRefs = {
		graphId: plan.graphId,
		status: "failed",
		...(deps.linearTeam ? { linearTeam: deps.linearTeam } : {}),
		linear: {
			nodes: trackingMap(existing?.linear.nodes),
			steps: trackingMap(existing?.linear.steps),
		},
		notion: {
			taskUrl: existing?.notion.taskUrl,
			nodes: trackingMap(existing?.notion.nodes),
			steps: trackingMap(existing?.notion.steps),
		},
		errors: [],
		updatedAt: now(),
	};
	if (refs.notion.taskUrl === undefined) delete refs.notion.taskUrl;
	refs.pendingLinks = trackingMap(existing?.pendingLinks);
	const titles = planTitles(plan);
	removeStale(refs, plan, graph, staleRefs(refs, titles));
	prunePending(refs, plan, graph);
	const controller = new AbortController();
	const signal = controller.signal;
	const timer =
		deps.budgetMs > 0 ? timers.setTimeout(() => controller.abort(), deps.budgetMs) : undefined;
	const emit = (error?: string) => {
		// Every non-failure emit follows a created or adopted row (a Notion batch emits once): the refs are checkpointed here.
		if (error === undefined) {
			try {
				deps.onRef?.(refs);
			} catch {
				// reason: a broken checkpoint must never affect tracking
			}
		}
		if (!deps.progress) return;
		try {
			deps.progress({
				type: "track",
				at: Date.now(),
				...(deps.linearTeam
					? {
							linear: {
								nodes: [Object.keys(refs.linear.nodes).length, plan.linearIssues.length],
								steps: [Object.keys(refs.linear.steps).length, plan.linearSubIssues.length],
							},
						}
					: {}),
				...(deps.notionDataSource
					? {
							notion: {
								task: !!refs.notion.taskUrl,
								nodes: [Object.keys(refs.notion.nodes).length, plan.issues.length],
								steps: [Object.keys(refs.notion.steps).length, plan.subIssues.length],
							},
						}
					: {}),
				...(error === undefined ? {} : { error }),
			});
		} catch {
			// reason: a broken progress sink must never affect tracking
		}
	};
	const emitIssue: IssueEmitter = (provider, nodeId, step, ref) => {
		if (!deps.progress) return;
		try {
			deps.progress({
				type: "issue",
				at: Date.now(),
				provider,
				nodeId,
				...(step === undefined ? {} : { step }),
				...(ref.identifier === undefined ? {} : { identifier: ref.identifier }),
				url: ref.url,
			});
		} catch {
			// reason: a broken progress sink must never affect tracking
		}
	};
	const fail = (message: string) => {
		refs.errors.push(message);
		deps.log?.(message);
		emit(message);
	};
	/** Records a failed call; a call the breaker refused is not recorded again, its provider already said why. */
	const report = (label: string, error: unknown) => {
		if (!(error instanceof BreakerOpenError)) fail(`${label}: ${shortError(error)}`);
	};

	const breaker: Partial<Record<Provider, string>> = {};
	/** Runs one provider call under that provider's breaker; a refusal that covers the whole provider opens it. */
	const guard = async <T>(provider: Provider, work: () => Promise<T>): Promise<T> => {
		const open = breaker[provider];
		if (open !== undefined) throw new BreakerOpenError(provider, open);
		try {
			return await work();
		} catch (error) {
			const cause = unwrapRetryError(error);
			const settled = cause instanceof BreakerOpenError || cause instanceof ReadBackFailedError;
			if (!settled && breaker[provider] === undefined && refusesProvider(cause)) {
				breaker[provider] = shortError(cause);
				fail(`${provider}: breaker open after ${shortError(cause)}`);
			}
			throw cause;
		}
	};
	const seams = { signal, sleep: deps.sleep, random: deps.random, now };
	/**
	 * One create through the retry kernel. A failure the tracker may have survived with the row made is followed, before
	 * any repeat, by `readBack`: the row it finds is the result. When it finds none the create is repeated; when it
	 * fails, nothing is repeated and the node says why.
	 */
	const createOnce = async (
		caller: ToolCaller,
		name: string,
		makeArgs: () => Record<string, unknown>,
		readBack: () => Promise<unknown>,
	): Promise<unknown> => {
		/** The last failure that may have left a row behind; cleared once a read-back finds nothing. */
		let uncertain: unknown;
		const lookup = async (): Promise<unknown> => {
			try {
				return await readBack();
			} catch (readError) {
				if (isAbortError(readError) || readError instanceof BreakerOpenError) throw readError;
				throw new ReadBackFailedError(uncertain, readError);
			}
		};
		try {
			const { value } = await withRetry(
				async () => {
					if (uncertain !== undefined) {
						const found = await lookup();
						if (found !== undefined) return found;
						uncertain = undefined;
					}
					try {
						return await withSignal(caller.call(name, makeArgs(), signal), signal);
					} catch (error) {
						if (!isAbortError(error) && !failedBeforeCreation(error)) uncertain = error;
						throw error;
					}
				},
				RETRY_POLICY,
				{ ...seams, classify: classifyCreate },
			);
			return value;
		} catch (error) {
			const cause = unwrapRetryError(error);
			if (
				uncertain === undefined ||
				isAbortError(cause) ||
				cause instanceof BreakerOpenError ||
				cause instanceof ReadBackFailedError
			)
				throw error;
			// The attempts ran out on an uncertain failure: the last one may have made the row, so look once more.
			try {
				const found = await readBack();
				if (found !== undefined) return found;
			} catch {
				// reason: the create already failed and is reported; a later run adopts the row by its footer
			}
			throw error;
		}
	};
	/**
	 * A caller whose every call is raced with the budget, retried through the kernel (it throws the last raw error, never
	 * the kernel's wrapper), and refused once its provider's breaker is open.
	 */
	const guarded = (provider: Provider, caller: ToolCaller | undefined): GuardedCaller | undefined =>
		caller && {
			call: (name, args) =>
				guard(provider, async () => {
					const { value } = await withRetry(
						() => withSignal(caller.call(name, args, signal), signal),
						RETRY_POLICY,
						{ ...seams, classify: classifyTrackerFailure },
					);
					return value;
				}),
			create: (name, makeArgs, readBack) =>
				guard(provider, () => createOnce(caller, name, makeArgs, readBack)),
		};
	const run: RunDeps = {
		...deps,
		linear: guarded("linear", deps.linear),
		notion: guarded("notion", deps.notion),
	};
	try {
		const settle = (work: Promise<void>): Promise<void> =>
			work.catch((error: unknown) => fail(`tracking: ${shortError(error)}`));
		// Each provider is its own branch: lookup, adopt, create. A lookup that is slow or never answers holds up that
		// provider only (until the budget ends it), never the other one. A provider whose lookup failed gets no new rows
		// this run: they could duplicate rows it could not see.
		const ctx: RunContext = {
			plan,
			refs,
			entered: new Set(),
			deps: run,
			signal,
			fail,
			report,
			emit,
			emitIssue,
		};
		const nodesDone = Promise.withResolvers<void>();
		const linearRun = deps.linearTeam
			? settle(
					(async () => {
						if (existing && run.linear) {
							try {
								await adoptLinear(plan, refs, run.linear, signal, emitIssue, titles);
							} catch (error) {
								report("linear adopt", error);
								return;
							}
							prunePending(refs, plan, graph);
							emit();
						}
						/**
						 * The nodes that have an issue now, adopted ones included: a dependency that gets one later in this run
						 * was not linked to them, whether they were made by an earlier run or found in the tracker.
						 */
						const entered = new Set(Object.keys(refs.linear.nodes));
						await createLinear({ ...ctx, entered }, graph, () => nodesDone.resolve());
					})().finally(() => nodesDone.resolve()),
				)
			: undefined;
		const notionRun = deps.notionDataSource
			? settle(
					(async () => {
						if (existing && run.notion) {
							try {
								await adoptNotion(
									plan,
									graph,
									refs,
									run.notion,
									deps.notionDataSource as string,
									signal,
									titles,
								);
							} catch (error) {
								report("notion adopt", error);
								return;
							}
							emit();
						}
						await createNotion(
							ctx,
							linearRun ? { nodes: nodesDone.promise, all: linearRun } : undefined,
						);
					})(),
				)
			: undefined;
		await Promise.all([linearRun, notionRun]);
	} catch (error) {
		// reason: the failure is recorded through fail() as a tracking error; the run continues to the status below
		fail(`tracking: ${shortError(error)}`);
	} finally {
		timers.clearTimeout(timer);
	}
	if (signal.aborted) fail("tracking: budget exhausted");
	if (refs.pendingLinks && Object.keys(refs.pendingLinks).length === 0) delete refs.pendingLinks;
	refs.status = trackingStatus(plan, refs, !!deps.linearTeam, !!deps.notionDataSource);
	refs.updatedAt = now();
	return refs;
}

/** Unconfigured providers count as done: their rows are never created, so they are not missing. */
function trackingStatus(
	plan: TrackPlan,
	refs: TrackingRefs,
	linearConfigured: boolean,
	notionConfigured: boolean,
): TrackingRefs["status"] {
	const linearDone =
		!linearConfigured ||
		(plan.linearIssues.every((issue) => refs.linear.nodes[issue.nodeId]) &&
			plan.linearSubIssues.every((sub) => refs.linear.steps[stepKey(sub.nodeId, sub.step)]) &&
			Object.keys(refs.pendingLinks ?? {}).length === 0);
	const notionDone =
		!notionConfigured ||
		(!!refs.notion.taskUrl &&
			plan.issues.every((row) => refs.notion.nodes[row.nodeId]) &&
			plan.subIssues.every((row) => refs.notion.steps[stepKey(row.nodeId, row.step)]));
	if (linearDone && notionDone) return "complete";
	const any =
		Object.keys(refs.linear.nodes).length +
		Object.keys(refs.linear.steps).length +
		Object.keys(refs.notion.nodes).length +
		Object.keys(refs.notion.steps).length +
		(refs.notion.taskUrl ? 1 : 0);
	return any > 0 ? "partial" : "failed";
}

/** Why a provider has no caller: a credential lookup that failed, or no login at all. */
function noCaller(provider: Provider, deps: CreateTrackingDeps): string {
	const credential = deps.credentialErrors?.[provider];
	return credential === undefined
		? `${provider}: login required`
		: `${provider}: credential error: ${credential}`;
}

/** What a provider's creation pass shares with the run: the plan, the refs it fills and the ways to report. */
interface RunContext {
	plan: TrackPlan;
	refs: TrackingRefs;
	entered: ReadonlySet<string>;
	deps: RunDeps;
	signal: AbortSignal;
	fail: (message: string) => void;
	report: (label: string, error: unknown) => void;
	emit: () => void;
	emitIssue: IssueEmitter;
}

/** Linear's progress as Notion sees it: its node issues are all attempted, and everything is. */
interface LinearProgress {
	nodes: Promise<void>;
	all: Promise<void>;
}

async function createLinear(
	{ plan, refs, entered, deps, signal, fail, report, emit, emitIssue }: RunContext,
	graph: ThoughtGraph | undefined,
	nodesDone: () => void,
): Promise<void> {
	const byNode = new Map(plan.linearIssues.map((issue) => [issue.nodeId, issue]));
	const dependsOn = new Map(
		(graph?.nodes ?? []).map((node) => [
			node.id,
			node.dependsOn.filter((dep) => dep !== node.id && byNode.has(dep)),
		]),
	);
	/**
	 * An issue that existed before this run was made without any link to a dependency that had no issue then. When that
	 * dependency has one now (made or adopted by this run) the link is owed, whatever the record says about pending links.
	 */
	const oweLinks = (): void => {
		for (const node of graph?.nodes ?? []) {
			if (!entered.has(node.id) || !refs.linear.nodes[node.id]) continue;
			const fresh = (dependsOn.get(node.id) ?? []).filter(
				(dep) => !entered.has(dep) && refs.linear.nodes[dep],
			);
			if (fresh.length > 0) addPending(refs, node.id, fresh);
		}
	};
	oweLinks();
	const pendingNodes = plan.linearIssues.filter((issue) => !refs.linear.nodes[issue.nodeId]);
	const pendingSteps = plan.linearSubIssues.filter(
		(sub) => !refs.linear.steps[stepKey(sub.nodeId, sub.step)],
	);
	const hasPendingLinks = Object.keys(refs.pendingLinks ?? {}).length > 0;
	if (pendingNodes.length === 0 && pendingSteps.length === 0 && !hasPendingLinks) return;
	const linear = deps.linear;
	if (!linear) {
		fail(noCaller("linear", deps));
		return;
	}
	const degraded = new Set(deps.degradedNodes ?? []);
	const save = async (
		label: string,
		title: string,
		args: Record<string, unknown>,
		row: { nodeId: string; step?: number },
	): Promise<IssueRef | undefined> => {
		try {
			const result = await linear.create(
				"save_issue",
				() => args,
				async () =>
					(await lookupLinear(plan, linear, signal)).find(
						(entry) =>
							entry.nodeId === row.nodeId &&
							entry.step === row.step &&
							sameTitle(entry.title, title),
					)?.issue,
			);
			const ref = extractIssueRef(result, title);
			if (!ref) fail(`linear ${label}: no identifier in result`);
			return ref;
		} catch (error) {
			report(`linear ${label}`, error);
			return undefined;
		}
	};

	for (const level of nodeLevels(
		plan.linearIssues.map((issue) => issue.nodeId),
		graph,
	)) {
		if (signal.aborted) return;
		const todo = level.filter((id) => !refs.linear.nodes[id]);
		await runPool(todo, deps.concurrency, signal, async (nodeId) => {
			const issue = byNode.get(nodeId);
			if (!issue) return;
			const title = linearNodeTitle(nodeId, issue.title, degraded.has(nodeId));
			// A dependency that was never created cannot be blocked on: the node is still created, without that link.
			const nodeDeps = dependsOn.get(nodeId) ?? [];
			const created = nodeDeps.filter((dep) => refs.linear.nodes[dep]);
			const missing = nodeDeps.filter((dep) => !refs.linear.nodes[dep]);
			if (missing.length > 0) {
				fail(`linear ${nodeId}: blockedBy ${missing.join(", ")} omitted (dependency not created)`);
			}
			const blockedBy = created.map((dep) => (refs.linear.nodes[dep] as IssueRef).identifier);
			const args: Record<string, unknown> = {
				team: deps.linearTeam,
				title,
				description: `${degraded.has(nodeId) ? DEGRADED_MARKER : ""}${issue.description}\n\n${footer(plan.graphId, nodeId)}`,
			};
			if (blockedBy.length > 0) args.blockedBy = blockedBy;
			// A node that is made again starts from nothing: its old pending links belonged to the row it replaces.
			if (refs.pendingLinks) delete refs.pendingLinks[nodeId];
			const ref = await save(nodeId, title, args, { nodeId });
			if (ref) {
				refs.linear.nodes[nodeId] = ref;
				// The links omitted above are made on this issue once their dependencies have issues.
				if (missing.length > 0) addPending(refs, nodeId, missing);
				emitIssue("linear", nodeId, undefined, ref);
				emit();
			}
		});
	}
	oweLinks();
	nodesDone();
	const steps = plan.linearSubIssues.filter((sub) => {
		if (refs.linear.steps[stepKey(sub.nodeId, sub.step)]) return false;
		if (refs.linear.nodes[sub.nodeId]) return true;
		fail(`linear ${stepKey(sub.nodeId, sub.step)}: parent missing`);
		return false;
	});
	await runPool(steps, deps.concurrency, signal, async (sub) => {
		const key = stepKey(sub.nodeId, sub.step);
		const parent = refs.linear.nodes[sub.nodeId] as IssueRef;
		const ref = await save(
			key,
			sub.title,
			{
				team: deps.linearTeam,
				title: sub.title,
				description: `${degraded.has(sub.nodeId) ? DEGRADED_MARKER : ""}${sub.description}\n\n${footer(plan.graphId, sub.nodeId, sub.step)}`,
				parentId: parent.identifier,
			},
			{ nodeId: sub.nodeId, step: sub.step },
		);
		if (ref) {
			refs.linear.steps[key] = ref;
			emitIssue("linear", sub.nodeId, sub.step, ref);
			emit();
		}
	});
	// Links left out when a node was made (its dependency had no issue) are added to the existing issue, once the dependency
	// has one. `blockedBy` only adds, so a repeat is safe; a link that fails stays pending for the next run.
	const repairs = Object.entries(refs.pendingLinks ?? {}).flatMap(([nodeId, depIds]) => {
		const issue = refs.linear.nodes[nodeId];
		const ready = depIds.filter((dep) => refs.linear.nodes[dep]);
		return issue && ready.length > 0 ? [{ nodeId, issue, ready }] : [];
	});
	await runPool(repairs, deps.concurrency, signal, async ({ nodeId, issue, ready }) => {
		try {
			await linear.call(
				"save_issue",
				{
					id: issue.identifier,
					blockedBy: ready.map((dep) => (refs.linear.nodes[dep] as IssueRef).identifier),
				},
				signal,
			);
		} catch (error) {
			report(`linear ${nodeId}: blockedBy ${ready.join(", ")}`, error);
			return;
		}
		const left = (refs.pendingLinks?.[nodeId] ?? []).filter((dep) => !ready.includes(dep));
		if (refs.pendingLinks) {
			if (left.length > 0) refs.pendingLinks[nodeId] = left;
			else delete refs.pendingLinks[nodeId];
		}
		emit();
	});
}

async function createNotion(ctx: RunContext, linear: LinearProgress | undefined): Promise<void> {
	const { plan, refs, deps, signal, fail } = ctx;
	const nodeRows = plan.issues.filter((row) => !refs.notion.nodes[row.nodeId]);
	const stepRows = plan.subIssues.filter(
		(row) => !refs.notion.steps[stepKey(row.nodeId, row.step)],
	);
	if (refs.notion.taskUrl && nodeRows.length === 0 && stepRows.length === 0) return;
	const notion = deps.notion;
	if (!notion) {
		fail(noCaller("notion", deps));
		return;
	}
	if (signal.aborted) return;
	const timers = deps.timers ?? platformTimers;

	// Rows print the Linear links of what Linear has created. Waiting for Linear is bounded: once the grace is spent,
	// rows go without links instead of waiting on a stuck provider.
	const grace = Promise.withResolvers<void>();
	let graceTimer: NodeJS.Timeout | undefined;
	const waitLinear = async (part: keyof LinearProgress): Promise<void> => {
		if (!linear) return;
		graceTimer ??= timers.setTimeout(() => grace.resolve(), deps.linkWaitMs ?? LINK_WAIT_MS);
		await Promise.race([linear[part], grace.promise]);
	};
	try {
		await createNotionRows(ctx, notion, waitLinear, nodeRows, stepRows);
	} finally {
		timers.clearTimeout(graceTimer);
	}
}

async function createNotionRows(
	{ plan, refs, deps, signal, fail, report, emit, emitIssue }: RunContext,
	notion: GuardedCaller,
	waitLinear: (part: keyof LinearProgress) => Promise<void>,
	nodeRows: TrackPlan["issues"],
	stepRows: TrackPlan["subIssues"],
): Promise<void> {
	const degraded = new Set(deps.degradedNodes ?? []);
	const call = (name: string, args: Record<string, unknown>) => notion.call(name, args, signal);

	let names: Set<string>;
	try {
		names = collectSchemaNames(
			await call("notion-fetch", { id: `collection://${deps.notionDataSource}` }),
		);
	} catch (error) {
		report("notion schema", error);
		return;
	}
	// A schema read that misses the core names was not understood. Filtering by it would create rows with fields silently
	// dropped, and later runs skip rows whose URLs are recorded, so send every property instead: a data source that really
	// lacks one fails the create loudly and nothing is recorded.
	const understood = CORE_PROPERTIES.every((name) => names.has(name));
	const props = (values: Record<string, string | number | undefined>): Record<string, unknown> => {
		const out: Record<string, unknown> = {};
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined || value === "" || (understood && !names.has(name))) continue;
			out[name] = value;
		}
		return out;
	};
	/** A row to create, with the identity a read-back finds it by. */
	interface RowSpec {
		level: "Task" | "Issue" | "Sub-Issue";
		nodeId?: string;
		step?: number;
		/** The Item the row is created with. */
		item: string;
		page: { properties: Record<string, unknown>; content?: string };
		/** The Issue page a child hangs under (its `Parent Item`). */
		parent?: string;
	}
	const isRow = (row: NotionRow, spec: RowSpec): boolean =>
		row.level === spec.level &&
		row.nodeId === spec.nodeId &&
		row.step === spec.step &&
		(spec.level === "Task" || sameTitle(row.item, spec.item)) &&
		(spec.parent === undefined ||
			row.parents.length === 0 ||
			row.parents.includes(pageKey(spec.parent)));
	/**
	 * Creates the rows and returns each one's url (undefined for a row that was not made). A create whose outcome is
	 * unknown is read back first: rows already there are adopted and only the missing ones are created again.
	 */
	const create = async (label: string, specs: RowSpec[]): Promise<Array<string | undefined>> => {
		const found = new Map<RowSpec, string>();
		const missing = () => specs.filter((spec) => !found.has(spec));
		try {
			const result = await notion.create(
				"notion-create-pages",
				() => ({
					parent: { data_source_id: deps.notionDataSource },
					pages: missing().map((spec) => spec.page),
					allow_async: false,
				}),
				async () => {
					const rows = await lookupNotion(plan, notion, deps.notionDataSource as string, signal);
					for (const spec of missing()) {
						const row = rows.find((entry) => isRow(entry, spec));
						if (row) found.set(spec, row.url);
					}
					return missing().length === 0 ? { pages: [] } : undefined;
				},
			);
			const need = missing();
			if (need.length > 0) {
				const urls = notionUrls(result);
				if (urls.length !== need.length)
					fail(`notion ${label}: expected ${need.length} page urls, got ${urls.length}`);
				else
					need.forEach((spec, index) => {
						found.set(spec, urls[index] as string);
					});
			}
		} catch (error) {
			report(`notion ${label}`, error);
		}
		return specs.map((spec) => found.get(spec));
	};
	/** A model-controlled value, capped so one long answer cannot become one huge row. */
	const capped = (text: string, max: number): string => clip(text, max).text;
	const { task } = plan;

	if (!refs.notion.taskUrl) {
		const [url] = await create("task", [
			{
				level: "Task",
				item: capped(task.item, FIELD_CAPS.title),
				page: {
					properties: props({
						Item: capped(task.item, FIELD_CAPS.title),
						Level: "Task",
						Description: capped(task.description, FIELD_CAPS.conclusion),
						"Uplifted Prompt": task.upliftedPrompt,
						Agent: task.agent,
						Status: task.status,
						"Linear State": task.linearState,
						Repo: task.repo,
						Branch: task.branch,
						"Graph ID": plan.graphId,
					}),
				},
			},
		]);
		if (!url) return;
		refs.notion.taskUrl = url;
		emit();
	}
	const taskUrl = refs.notion.taskUrl as string;

	if (nodeRows.length > 0 && !signal.aborted) {
		await waitLinear("nodes");
		const specs: RowSpec[] = nodeRows.map((row) => {
			const linear = refs.linear.nodes[row.nodeId];
			const mark = degraded.has(row.nodeId);
			const item = notionNodeItem(row, mark);
			return {
				level: "Issue",
				nodeId: row.nodeId,
				item,
				page: {
					properties: props({
						Item: item,
						Level: "Issue",
						Agent: task.agent,
						Status: task.status,
						"Linear State": task.linearState,
						"Graph ID": plan.graphId,
						Thought: capped(`${mark ? DEGRADED_MARKER : ""}${row.thought}`, FIELD_CAPS.conclusion),
						"Parent Item": JSON.stringify([taskUrl]),
						"Linear URL": linear?.url,
						"Issue ID": linear?.identifier,
					}),
				},
			};
		});
		const urls = await create("nodes", specs);
		nodeRows.forEach((row, index) => {
			const url = urls[index];
			if (url === undefined) return;
			refs.notion.nodes[row.nodeId] = url;
			emitIssue("notion", row.nodeId, undefined, { url });
		});
		if (urls.some((url) => url !== undefined)) emit();
	}

	const ready = stepRows.filter((row) => {
		if (refs.notion.nodes[row.nodeId]) return true;
		fail(`notion ${stepKey(row.nodeId, row.step)}: parent missing`);
		return false;
	});
	if (ready.length > 0 && !signal.aborted) await waitLinear("all");
	const batches: (typeof ready)[] = [];
	for (let index = 0; index < ready.length; index += NOTION_BATCH)
		batches.push(ready.slice(index, index + NOTION_BATCH));
	await runPool(batches, deps.concurrency, signal, async (batch) => {
		const specs: RowSpec[] = batch.map((row) => {
			const linear = refs.linear.steps[stepKey(row.nodeId, row.step)];
			const mark = degraded.has(row.nodeId);
			const item = notionStepItem(row);
			return {
				level: "Sub-Issue",
				nodeId: row.nodeId,
				step: row.step,
				item,
				parent: refs.notion.nodes[row.nodeId],
				page: {
					properties: props({
						Item: item,
						Level: "Sub-Issue",
						Agent: task.agent,
						Status: task.status,
						"Linear State": task.linearState,
						"Graph ID": plan.graphId,
						Thought: capped(`${mark ? DEGRADED_MARKER : ""}${row.thought}`, FIELD_CAPS.thinking),
						Step: row.step,
						"Parent Item": JSON.stringify([refs.notion.nodes[row.nodeId]]),
						"Linear URL": linear?.url,
						"Issue ID": linear?.identifier,
					}),
				},
			};
		});
		const first = batch[0] as (typeof ready)[number];
		const urls = await create(`steps ${stepKey(first.nodeId, first.step)}+`, specs);
		batch.forEach((row, index) => {
			const url = urls[index];
			if (url === undefined) return;
			refs.notion.steps[stepKey(row.nodeId, row.step)] = url;
			emitIssue("notion", row.nodeId, row.step, { url });
		});
		if (urls.some((url) => url !== undefined)) emit();
	});
}
