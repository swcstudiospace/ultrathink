// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Creates the tracker rows for a TrackPlan (Linear issues/sub-issues, Notion rows) through
 * MCP tool callers. Idempotent against `existing`, bounded by one budget signal, never throws.
 *
 * Every tracker call runs through the retry kernel (429, 5xx, timeouts and Retry-After are retried, a permanent
 * refusal is not). A refusal that covers the whole provider (auth, permission, quota) opens a breaker for that
 * provider for the rest of the run. Linear and Notion run independently of each other.
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
import type { IssueRef, TrackingRefs, TrackPlan } from "./types.ts";
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

/** Re-run only: adopts Linear issues already carrying this graph's description footer. A failure is the caller's to record. */
async function adoptLinear(
	plan: TrackPlan,
	refs: TrackingRefs,
	linear: ToolCaller,
	signal: AbortSignal,
	emitIssue: IssueEmitter,
): Promise<void> {
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
	for (const issue of listEntries(result)) {
		const match = nonEmpty(issue.description)?.match(re);
		if (!match) continue;
		const nodeId = match[1] as string;
		const title = nonEmpty(issue.title) ?? "";
		const ref = extractIssueRef(issue, title);
		if (!ref) continue;
		if (match[2] === undefined) {
			if (refs.linear.nodes[nodeId]) continue;
			refs.linear.nodes[nodeId] = ref;
			emitIssue("linear", nodeId, undefined, ref);
		} else {
			const step = Number(match[2]);
			const key = stepKey(nodeId, step);
			if (refs.linear.steps[key]) continue;
			refs.linear.steps[key] = ref;
			emitIssue("linear", nodeId, step, ref);
		}
	}
}

/** Re-run only: adopts Notion rows already tagged with this graph's Graph ID. A failure is the caller's to record. */
async function adoptNotion(
	plan: TrackPlan,
	refs: TrackingRefs,
	notion: ToolCaller,
	dataSource: string,
	signal: AbortSignal,
): Promise<void> {
	const collection = `collection://${dataSource}`;
	const result = await notion.call(
		"notion-query-data-sources",
		{
			data: {
				data_source_urls: [collection],
				query: `SELECT url, "Level", "Item", "Step" FROM "${collection}" WHERE "Graph ID" = ?`,
				params: [plan.graphId],
			},
		},
		signal,
	);
	for (const row of listEntries(result)) {
		const url = nonEmpty(row.url);
		const level = nonEmpty(row.Level);
		if (!url || !level) continue;
		if (level === "Task") {
			refs.notion.taskUrl ??= url;
			continue;
		}
		const nodeId = nonEmpty(row.Item)?.match(/^\[([^\]]+)\]/)?.[1];
		if (!nodeId) continue;
		if (level === "Issue") refs.notion.nodes[nodeId] ??= url;
		else if (level === "Sub-Issue") {
			const step = Number(row.Step);
			if (Number.isFinite(step)) refs.notion.steps[stepKey(nodeId, step)] ??= url;
		}
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
	/**
	 * A caller whose every call is raced with the budget, retried through the kernel (it throws the last raw error, never
	 * the kernel's wrapper), and refused once its provider's breaker is open.
	 */
	const guarded = (provider: Provider, caller: ToolCaller | undefined): ToolCaller | undefined =>
		caller && {
			async call(name, args) {
				const open = breaker[provider];
				if (open !== undefined) throw new BreakerOpenError(provider, open);
				try {
					const { value } = await withRetry(
						() => withSignal(caller.call(name, args, signal), signal),
						RETRY_POLICY,
						{
							signal,
							sleep: deps.sleep,
							random: deps.random,
							now,
							classify: classifyTrackerFailure,
						},
					);
					return value;
				} catch (error) {
					const cause = unwrapRetryError(error);
					if (breaker[provider] === undefined && refusesProvider(cause)) {
						breaker[provider] = shortError(cause);
						fail(`${provider}: breaker open after ${shortError(cause)}`);
					}
					throw cause;
				}
			},
		};
	const run = {
		...deps,
		linear: guarded("linear", deps.linear),
		notion: guarded("notion", deps.notion),
	};
	/** A provider whose adoption lookup failed gets no new rows this run: they could duplicate rows it could not see. */
	const skipped: Partial<Record<Provider, true>> = {};

	try {
		if (existing) {
			await Promise.all([
				run.linear && deps.linearTeam
					? adoptLinear(plan, refs, run.linear, signal, emitIssue).catch((error: unknown) => {
							skipped.linear = true;
							report("linear adopt", error);
						})
					: undefined,
				run.notion && deps.notionDataSource
					? adoptNotion(plan, refs, run.notion, deps.notionDataSource, signal).catch(
							(error: unknown) => {
								skipped.notion = true;
								report("notion adopt", error);
							},
						)
					: undefined,
			]);
			emit();
		}
		const settle = (work: Promise<void>): Promise<void> =>
			work.catch((error: unknown) => fail(`tracking: ${shortError(error)}`));
		// Both providers start at once; Notion only waits (bounded) for the Linear links it prints on its rows.
		const ctx: RunContext = { plan, refs, deps: run, signal, fail, report, emit, emitIssue };
		const nodesDone = Promise.withResolvers<void>();
		const linearRun =
			deps.linearTeam && !skipped.linear
				? settle(
						createLinear(ctx, graph, () => nodesDone.resolve()).finally(() => nodesDone.resolve()),
					)
				: undefined;
		const notionRun =
			deps.notionDataSource && !skipped.notion
				? settle(
						createNotion(ctx, linearRun ? { nodes: nodesDone.promise, all: linearRun } : undefined),
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
			plan.linearSubIssues.every((sub) => refs.linear.steps[stepKey(sub.nodeId, sub.step)]));
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
	deps: CreateTrackingDeps;
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
	{ plan, refs, deps, signal, fail, report, emit, emitIssue }: RunContext,
	graph: ThoughtGraph | undefined,
	nodesDone: () => void,
): Promise<void> {
	const pendingNodes = plan.linearIssues.filter((issue) => !refs.linear.nodes[issue.nodeId]);
	const pendingSteps = plan.linearSubIssues.filter(
		(sub) => !refs.linear.steps[stepKey(sub.nodeId, sub.step)],
	);
	if (pendingNodes.length === 0 && pendingSteps.length === 0) return;
	const linear = deps.linear;
	if (!linear) {
		fail(noCaller("linear", deps));
		return;
	}
	const degraded = new Set(deps.degradedNodes ?? []);
	const byNode = new Map(plan.linearIssues.map((issue) => [issue.nodeId, issue]));
	const dependsOn = new Map(
		(graph?.nodes ?? []).map((node) => [
			node.id,
			node.dependsOn.filter((dep) => dep !== node.id && byNode.has(dep)),
		]),
	);
	const save = async (
		label: string,
		title: string,
		args: Record<string, unknown>,
	): Promise<IssueRef | undefined> => {
		try {
			const result = await linear.call("save_issue", args, signal);
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
			const title = degraded.has(nodeId)
				? markTitle(nodeId, issue.title)
				: issue.title.startsWith(`[${nodeId}]`)
					? issue.title
					: `[${nodeId}] ${issue.title}`;
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
			const ref = await save(nodeId, title, args);
			if (ref) {
				refs.linear.nodes[nodeId] = ref;
				emitIssue("linear", nodeId, undefined, ref);
				emit();
			}
		});
	}
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
		const ref = await save(key, sub.title, {
			team: deps.linearTeam,
			title: sub.title,
			description: `${degraded.has(sub.nodeId) ? DEGRADED_MARKER : ""}${sub.description}\n\n${footer(plan.graphId, sub.nodeId, sub.step)}`,
			parentId: parent.identifier,
		});
		if (ref) {
			refs.linear.steps[key] = ref;
			emitIssue("linear", sub.nodeId, sub.step, ref);
			emit();
		}
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
	notion: ToolCaller,
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
	const create = async (
		label: string,
		pages: Array<{ properties: Record<string, unknown>; content?: string }>,
	): Promise<string[] | undefined> => {
		try {
			const urls = notionUrls(
				await call("notion-create-pages", {
					parent: { data_source_id: deps.notionDataSource },
					pages,
					allow_async: false,
				}),
			);
			if (urls.length !== pages.length) {
				fail(`notion ${label}: expected ${pages.length} page urls, got ${urls.length}`);
				return undefined;
			}
			return urls;
		} catch (error) {
			report(`notion ${label}`, error);
			return undefined;
		}
	};
	/** A model-controlled value, capped so one long answer cannot become one huge row. */
	const capped = (text: string, max: number): string => clip(text, max).text;
	const { task } = plan;

	if (!refs.notion.taskUrl) {
		const urls = await create("task", [
			{
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
		]);
		if (!urls) return;
		refs.notion.taskUrl = urls[0];
		emit();
	}
	const taskUrl = refs.notion.taskUrl as string;

	if (nodeRows.length > 0 && !signal.aborted) {
		await waitLinear("nodes");
		const pages = nodeRows.map((row) => {
			const linear = refs.linear.nodes[row.nodeId];
			const mark = degraded.has(row.nodeId);
			return {
				properties: props({
					Item: capped(mark ? markTitle(row.nodeId, row.item) : row.item, FIELD_CAPS.title),
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
			};
		});
		const urls = await create("nodes", pages);
		if (urls) {
			nodeRows.forEach((row, index) => {
				const url = urls[index] as string;
				refs.notion.nodes[row.nodeId] = url;
				emitIssue("notion", row.nodeId, undefined, { url });
			});
			emit();
		}
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
		const pages = batch.map((row) => {
			const linear = refs.linear.steps[stepKey(row.nodeId, row.step)];
			const mark = degraded.has(row.nodeId);
			return {
				properties: props({
					Item: capped(row.item, FIELD_CAPS.step),
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
			};
		});
		const first = batch[0] as (typeof ready)[number];
		const urls = await create(`steps ${stepKey(first.nodeId, first.step)}+`, pages);
		if (urls) {
			batch.forEach((row, index) => {
				const url = urls[index] as string;
				refs.notion.steps[stepKey(row.nodeId, row.step)] = url;
				emitIssue("notion", row.nodeId, row.step, { url });
			});
			emit();
		}
	});
}
