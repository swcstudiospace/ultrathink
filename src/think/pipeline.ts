// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { redactSecrets } from "../redact.ts";
import { clip } from "../resilience/limits.ts";
import {
	isTransientFailure,
	type RetryPolicy,
	unwrapRetryError,
	withRetry,
} from "../resilience/retry.ts";
import { abortableSleep } from "../resilience/sleep.ts";
import type { FlightThrottle } from "../resilience/throttle.ts";
import { isAbortError } from "../shared.ts";
import { nodeStepTitles } from "../track/plan.ts";
import { readReport, type UpliftResult } from "../types.ts";
import { escapeXml } from "../uplift/xml.ts";
import {
	dependencyLevels,
	extractJsonObject,
	graphSketch,
	injectGraphXml,
	isFallbackGraph,
	type NodeFill,
	normalizeGraph,
	parseNodeFill,
	topoSort,
} from "./graph.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "./prompts.ts";
import {
	MAX_NODES,
	MAX_STEPS,
	MIN_NODES,
	MIN_STEPS,
	type ThoughtGraph,
	type ThoughtNode,
} from "./types.ts";

export interface ThinkResult extends UpliftResult {
	graph: ThoughtGraph;
	/** True when the graph fell back to boilerplate or any node fill is still failed after the repair pass. */
	partial?: boolean;
	/**
	 * Think stages that fell back to boilerplate: the graph structure, and node fills by id (graph order).
	 * `causes` holds one redacted single-line reason per failed fill; `repaired` the ids the repair pass refilled.
	 */
	degraded: {
		graph: boolean;
		fills: string[];
		causes?: Record<string, string>;
		repaired?: string[];
		/**
		 * Present only when the graph call itself failed with a completer report (it already classified and retried the
		 * failure): a redacted single-line cause. The provider is unavailable, so a later stage need not try it again.
		 */
		graphFailure?: string;
	};
}

export interface RunThinkOptions {
	uplift: UpliftResult;
	complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
	minNodes?: number;
	maxNodes?: number;
	onProgress?: (message: string) => void;
	/** Fill independent nodes concurrently, level by level. Default 1 (sequential). */
	concurrency?: number;
	/** Structured progress, called synchronously (graph once, then node start/done pairs). */
	onEvent?: (event: ThinkEvent) => void;
	/** Extra attempts per node fill after the first, same model, kernel backoff between them. Default 2. */
	fillRetries?: number;
	/** One dependency-ordered repair pass over failed fills and the successors that read them. Default true. */
	repair?: boolean;
	/** Per-flight limiter every fill attempt acquires before it calls the model. */
	throttle?: FlightThrottle;
	/** Test seams for the retry backoff. */
	sleep?: typeof abortableSleep;
	random?: () => number;
}

type ThinkEvent =
	| {
			type: "graph";
			total: number;
			nodes: Array<{ id: string; title: string; kind: string; dependsOn: string[] }>;
	  }
	| {
			type: "node";
			phase: "start" | "done";
			id: string;
			title: string;
			kind: string;
			index: number;
			total: number;
			fallback?: boolean;
			steps?: string[];
	  };

const DEFAULT_FILL_RETRIES = 2;
const FILL_RETRY_BASE_MS = 500;
const FILL_RETRY_CAP_MS = 8000;
const CAUSE_MAX_CHARS = 200;

/** A completion that is not a closed 5-8 step rationale plus a closed conclusion. It retries like a transient failure. */
class FillRejectedError extends Error {
	constructor() {
		super(
			`node fill was not a closed rationale of ${MIN_STEPS}-${MAX_STEPS} steps plus a closed conclusion`,
		);
		this.name = "FillRejectedError";
	}
}

interface FillContext {
	opts: RunThinkOptions;
	policy: RetryPolicy;
	emit: (event: ThinkEvent) => void;
	progress: (message: string) => void;
	/** Ids of nodes whose fill is currently failed. */
	failed: Set<string>;
	causes: Map<string, string>;
	/** The failed nodes whose failure carried a completer report: the provider failed, not the reply. */
	providerFailed: Set<string>;
}

/** Progress sinks are the caller's: one that throws must never fail the plan. */
function safely(call: () => void): void {
	try {
		call();
	} catch {
		// reason: a broken progress sink must not cost the user the plan
	}
}

async function ensureLive(signal: AbortSignal | undefined): Promise<void> {
	// An aborted signal makes the kernel's one abort-raising sleep reject with its AbortError and arms no timer.
	if (signal?.aborted) await abortableSleep(0, signal);
}

function predecessorBlock(graph: ThoughtGraph, node: ThoughtNode): string {
	const byId = new Map(graph.nodes.map((item) => [item.id, item]));
	const preds = node.dependsOn
		.map((id) => byId.get(id))
		.filter((item): item is ThoughtNode => Boolean(item));
	if (preds.length === 0) return "(no predecessors)";
	return preds
		.map((pred) => {
			const conclusion = pred.conclusion?.trim();
			const body =
				pred.degraded || !conclusion ? "(predecessor unavailable)" : escapeXml(conclusion);
			return `<predecessor id="${escapeXml(pred.id)}" title="${escapeXml(pred.title)}">\n${body}\n</predecessor>`;
		})
		.join("\n\n");
}

function graphUserPayload(uplift: UpliftResult): string {
	return `${uplift.original}\n\n${uplift.xml}`;
}

function cotUserPayload(uplift: UpliftResult, graph: ThoughtGraph, node: ThoughtNode): string {
	return [
		`<original>${escapeXml(uplift.original)}</original>`,
		"",
		uplift.xml,
		"",
		`<graph_goal>${escapeXml(graph.goal)}</graph_goal>`,
		"<graph>",
		escapeXml(graphSketch(graph)),
		"</graph>",
		"",
		"<predecessors>",
		predecessorBlock(graph, node),
		"</predecessors>",
		"",
		`<current_node id="${escapeXml(node.id)}" kind="${escapeXml(node.kind)}" title="${escapeXml(node.title)}">`,
		escapeXml(node.question),
		"</current_node>",
	].join("\n");
}

async function buildGraph(
	opts: RunThinkOptions,
	minNodes: number,
	maxNodes: number,
): Promise<{ graph: ThoughtGraph; fallback: boolean; failure?: string }> {
	try {
		const raw = await opts.complete(
			GRAPH_SYSTEM_PROMPT,
			graphUserPayload(opts.uplift),
			opts.signal,
		);
		const graph = normalizeGraph(extractJsonObject(raw), opts.uplift.original, minNodes, maxNodes);
		return { graph, fallback: isFallbackGraph(graph) };
	} catch (error) {
		if (isAbortError(error)) throw error;
		await ensureLive(opts.signal);
		return {
			graph: normalizeGraph(null, opts.uplift.original, minNodes, maxNodes),
			fallback: true,
			// A report means the completer judged and retried the failure itself: the provider, not the reply, failed.
			...(readReport(unwrapRetryError(error)) === undefined
				? {}
				: { failure: describeCause(error) }),
		};
	}
}

/** One model call for one node, under the flight throttle when given. Throws the raw failure; never writes the node. */
async function attemptFill(
	opts: RunThinkOptions,
	graph: ThoughtGraph,
	node: ThoughtNode,
): Promise<NodeFill> {
	const release = await opts.throttle?.acquire(opts.signal);
	try {
		const raw = await opts.complete(
			COT_SYSTEM_PROMPT,
			cotUserPayload(opts.uplift, graph, node),
			opts.signal,
		);
		const fill = parseNodeFill(raw);
		if (!fill.ok) throw new FillRejectedError();
		opts.throttle?.noteSuccess();
		return fill;
	} catch (error) {
		// A malformed reply says nothing about provider load, so only real provider failures slow the flight.
		if (opts.throttle && !(error instanceof FillRejectedError) && !isAbortError(error)) {
			const verdict = isTransientFailure(error);
			if (verdict.transient) {
				opts.throttle.noteFailure(
					verdict.retryAfterMs === undefined ? undefined : { retryAfterMs: verdict.retryAfterMs },
				);
			}
		}
		throw error;
	} finally {
		release?.();
	}
}

/**
 * What the fill-level retry retries. Only a content failure (a refusal, a truncated or malformed fill) and a provider
 * failure nobody classified (an error with no completion report) are retried here. Every real completer classifies its
 * failures and retries the transient ones itself (three attempts with backoff and Retry-After), then attaches a report
 * to the error, directly or on a wrapper's `cause` (`PlanCompleterError`, `FailoverError`): an error that carries a
 * report is final, whatever its attempt count (a 400, a timeout, a login failure, a stopped deadline), and another
 * round here would multiply the completer's calls. The repair pass gives a failed node one more go after the other
 * fills, which spreads the load in time.
 */
const classifyFill: typeof isTransientFailure = (error, now) => {
	const root = unwrapRetryError(error);
	if (root instanceof FillRejectedError) return { transient: true, reason: "fill rejected" };
	if (isAbortError(root)) return { transient: false, reason: "aborted" };
	if (readReport(root) !== undefined)
		return { transient: false, reason: "the completer already classified it" };
	return isTransientFailure(root, now);
};

function describeCause(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const oneLine = redactSecrets(text).replace(/\s+/g, " ").trim();
	return clip(oneLine || "unknown failure", CAUSE_MAX_CHARS).text;
}

function applyFill(ctx: FillContext, node: ThoughtNode, fill: NodeFill): void {
	node.thinking = fill.thinking;
	node.conclusion = fill.conclusion;
	node.degraded = undefined;
	ctx.failed.delete(node.id);
	ctx.causes.delete(node.id);
	ctx.providerFailed.delete(node.id);
}

/** A failed fill stays empty: the question is never passed off as a conclusion. */
function degradeNode(ctx: FillContext, node: ThoughtNode, error: unknown): void {
	node.thinking = "";
	node.conclusion = "";
	node.degraded = true;
	ctx.failed.add(node.id);
	ctx.causes.set(node.id, describeCause(error));
	if (readReport(unwrapRetryError(error)) === undefined) ctx.providerFailed.delete(node.id);
	else ctx.providerFailed.add(node.id);
}

function nodeEventBase(graph: ThoughtGraph, node: ThoughtNode) {
	return {
		id: node.id,
		title: node.title,
		kind: node.kind,
		index: graph.nodes.indexOf(node),
		total: graph.nodes.length,
	};
}

async function fillNode(ctx: FillContext, graph: ThoughtGraph, node: ThoughtNode): Promise<void> {
	const { opts } = ctx;
	await ensureLive(opts.signal);
	const base = nodeEventBase(graph, node);
	ctx.emit({ type: "node", phase: "start", ...base });
	try {
		const { value } = await withRetry(() => attemptFill(opts, graph, node), ctx.policy, {
			classify: classifyFill,
			signal: opts.signal,
			sleep: opts.sleep,
			random: opts.random,
		});
		await ensureLive(opts.signal);
		applyFill(ctx, node, value);
	} catch (error) {
		const root = unwrapRetryError(error);
		if (isAbortError(root)) throw root;
		await ensureLive(opts.signal);
		degradeNode(ctx, node, root);
	}
	const steps = nodeStepTitles(node);
	ctx.emit(
		node.degraded
			? { type: "node", phase: "done", ...base, fallback: true, steps }
			: { type: "node", phase: "done", ...base, steps },
	);
}

async function fillLevel(
	ctx: FillContext,
	graph: ThoughtGraph,
	group: ThoughtNode[],
	limit: number,
): Promise<void> {
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < group.length) {
			await ensureLive(ctx.opts.signal);
			const node = group[cursor++]!;
			await fillNode(ctx, graph, node);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, group.length) }, worker));
}

const REPAIR_SKIPPED_NOTE = " · repair skipped: no fill succeeded";
const PROVIDER_UNAVAILABLE_NOTE = `${REPAIR_SKIPPED_NOTE}, provider unavailable`;

/**
 * Every fill failed, so the repair pass is skipped; each node's cause says so (the base cause is clipped to keep the
 * 200-character bound). Only a failure the completer reported (the provider failed) says "provider unavailable": a reply
 * that was not a closed rationale is a content failure and the provider may well be fine.
 */
function noteRepairSkipped(ctx: FillContext): void {
	for (const [id, cause] of ctx.causes) {
		const note = ctx.providerFailed.has(id) ? PROVIDER_UNAVAILABLE_NOTE : REPAIR_SKIPPED_NOTE;
		const base = clip(cause, CAUSE_MAX_CHARS - note.length).text;
		ctx.causes.set(id, `${base}${note}`);
	}
}

/**
 * One more single attempt, in dependency order, for every still-failed node and for every node downstream of a node
 * the pass just repaired (it was filled while that predecessor was unavailable). A successor whose refill fails keeps
 * its earlier real fill.
 */
async function repairPass(
	ctx: FillContext,
	graph: ThoughtGraph,
	repaired: string[],
): Promise<void> {
	const { opts } = ctx;
	const stale = new Set<string>();
	for (const node of graph.nodes) {
		if (!ctx.failed.has(node.id) && !stale.has(node.id)) continue;
		await ensureLive(opts.signal);
		ctx.progress(`Repairing ${node.id} · ${node.kind}…`);
		try {
			const fill = await attemptFill(opts, graph, node);
			await ensureLive(opts.signal);
			applyFill(ctx, node, fill);
		} catch (error) {
			if (isAbortError(error)) throw error;
			await ensureLive(opts.signal);
			if (ctx.failed.has(node.id)) ctx.causes.set(node.id, describeCause(error));
			continue;
		}
		repaired.push(node.id);
		for (const child of graph.nodes) {
			if (child.dependsOn.includes(node.id)) stale.add(child.id);
		}
		ctx.emit({
			type: "node",
			phase: "done",
			...nodeEventBase(graph, node),
			steps: nodeStepTitles(node),
		});
	}
}

export async function runThink(opts: RunThinkOptions): Promise<ThinkResult> {
	const minNodes = opts.minNodes ?? MIN_NODES;
	const maxNodes = opts.maxNodes ?? MAX_NODES;
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
	const fillRetries = Math.max(0, Math.floor(opts.fillRetries ?? DEFAULT_FILL_RETRIES));
	const ctx: FillContext = {
		opts,
		policy: {
			maxAttempts: 1 + fillRetries,
			baseMs: FILL_RETRY_BASE_MS,
			capMs: FILL_RETRY_CAP_MS,
		},
		emit: (event) => safely(() => opts.onEvent?.(event)),
		progress: (message) => safely(() => opts.onProgress?.(message)),
		failed: new Set(),
		causes: new Map(),
		providerFailed: new Set(),
	};

	ctx.progress("Graph of Thought…");
	const built = await buildGraph(opts, minNodes, maxNodes);
	const graph = built.graph;
	graph.nodes = topoSort(graph.nodes);
	ctx.emit({
		type: "graph",
		total: graph.nodes.length,
		nodes: graph.nodes.map((node) => ({
			id: node.id,
			title: node.title,
			kind: node.kind,
			dependsOn: [...node.dependsOn],
		})),
	});

	const repaired: string[] = [];
	try {
		if (concurrency === 1) {
			for (let index = 0; index < graph.nodes.length; index++) {
				const node = graph.nodes[index]!;
				ctx.progress(`Node detail n${index + 1}/${graph.nodes.length} · ${node.kind}…`);
				await fillNode(ctx, graph, node);
			}
		} else {
			let done = 0;
			for (const group of dependencyLevels(graph.nodes)) {
				ctx.progress(`Node detail ${done + 1}-${done + group.length}/${graph.nodes.length}…`);
				await fillLevel(ctx, graph, group, concurrency);
				done += group.length;
			}
		}
		if (opts.repair !== false && ctx.failed.size > 0) {
			// Nothing was filled: the provider is down, and a repair attempt per node would only repeat the same failures.
			if (ctx.failed.size === graph.nodes.length) noteRepairSkipped(ctx);
			else await repairPass(ctx, graph, repaired);
		}
	} catch (error) {
		// An abort (the hook budget expiring) keeps every fill already made: the consumer reads `error.partial.graph`.
		if (isAbortError(error)) attachPartialGraph(error, graph);
		throw error;
	}

	const fills = graph.nodes.filter((node) => ctx.failed.has(node.id)).map((node) => node.id);
	const causes = Object.fromEntries(
		fills.map((id) => [id, ctx.causes.get(id) ?? "unknown failure"]),
	);
	return {
		...opts.uplift,
		xml: injectGraphXml(opts.uplift.xml, graph),
		graph,
		source: opts.uplift.source,
		partial: built.fallback || fills.length > 0,
		degraded: {
			graph: built.fallback,
			...(built.failure === undefined ? {} : { graphFailure: built.failure }),
			fills,
			...(fills.length > 0 ? { causes } : {}),
			...(repaired.length > 0 ? { repaired } : {}),
		},
	};
}

/** Hand the graph as far as it got to whoever catches the abort; the nodes not filled yet are marked degraded. */
function attachPartialGraph(error: unknown, graph: ThoughtGraph): void {
	if (typeof error !== "object" || error === null) return;
	for (const node of graph.nodes) {
		if (!node.conclusion?.trim()) node.degraded = true;
	}
	try {
		Object.defineProperty(error, "partial", {
			value: { graph },
			enumerable: false,
			configurable: true,
			writable: true,
		});
	} catch {
		// reason: a frozen error cannot carry the graph; the abort itself must still reach the caller unchanged
	}
}
