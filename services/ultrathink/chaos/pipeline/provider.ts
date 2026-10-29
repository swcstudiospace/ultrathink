// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { AssistantMessage, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ClaudeCompleter } from "../../../../src/claude/complete.ts";
import type { CompleteSimple } from "../../../../src/host/omp.ts";
import { abortableSleep } from "../../../../src/resilience/sleep.ts";
import { isAbortError } from "../../../../src/shared.ts";
import type { CompletionReport } from "../../../../src/types.ts";

export type StageName = "uplift" | "graph" | "fill" | "clarify";

export type Effect =
	| { kind: "ok" }
	| { kind: "delay"; ms: number; after?: Effect }
	| { kind: "error"; status?: number; retryAfterSec?: number; message?: string }
	| { kind: "network"; code: "ECONNRESET" | "ETIMEDOUT" }
	| { kind: "empty" }
	| { kind: "truncate"; at: number }
	| { kind: "garbage"; text: string }
	| { kind: "hang" };

/**
 * One fault. A call matches when its stage, node, prompt (index or nonce), per-prompt stage ordinal (`nth`, one number
 * or an inclusive range) and `every` (prompt index is a multiple) all agree; the first matching rule with budget left
 * wins. `count` is the number of matching calls the rule may still hit (default 1, "forever" never runs out).
 */
export interface Rule {
	stage: StageName;
	node?: string;
	promptId?: number | string;
	nth?: number | [number, number];
	every?: number;
	effect: Effect;
	count?: number | "forever";
}

export interface CallLog {
	seq: number;
	stage: StageName;
	/** The prompt nonce, or `call-<n>` when the payload carries none. */
	key: string;
	/** The prompt index parsed from the nonce; absent without one. */
	index: number | undefined;
	node: string | undefined;
	/** 1-based ordinal of this call among the prompt's calls of the same stage. */
	ordinal: number;
	effect: Effect["kind"];
	/** The kinds of the effect and of every `after` effect behind it, so a `delay` that ends in a `hang` is still known as one. */
	chain: Effect["kind"][];
	outcome: "pending" | "ok" | "error" | "aborted";
	status: number | undefined;
	startedAt: number;
	endedAt: number | undefined;
	/** Nonces other than the caller's that the payload carried. */
	foreign: string[];
}

export interface ScriptedProvider {
	complete: ClaudeCompleter;
	/** The same scripted faults over another completer: an `ok` effect calls `inner` instead of writing a reply. */
	wrap(inner: ClaudeCompleter): ClaudeCompleter;
	calls(): CallLog[];
	byPrompt(key: string): CallLog[];
	byStage(stage: StageName): CallLog[];
	inflight(): { now: number; peak: number };
	/** The report of the prompt's most recent call, as a completer's `report()` seam reads it. */
	report(key: string): CompletionReport | undefined;
	/** Stops injecting: every later call takes the ok path. */
	quiesce(): void;
	/** True once a call was refused because `maxCalls` was spent. */
	capped(): boolean;
}

interface ProviderSeams {
	sleep?: typeof abortableSleep;
	now?: () => number;
	/** Varies the written graph size and step count with the prompt index. */
	seed?: number;
	/** Inclusive node count of the graph the provider writes. Default 5 to 8. */
	nodeRange?: [number, number];
	/** Hard cap on logged calls; later calls are refused before they reach an inner completer. */
	maxCalls?: number;
}

const NONCE = /pl-\d+-\d{6}(?!\d)/g;
const NONCE_PARTS = /^pl-\d+-(\d{6})$/;
const CURRENT_NODE = /current_node id="([^"]+)"/;
const DEFAULT_NODE_RANGE: [number, number] = [5, 8];

function abortError(): Error {
	return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function fieldOf(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	const field = fieldOf(value, key);
	return typeof field === "number" ? field : undefined;
}

/** Same sniffing as the host suites' `stageAnswer`: the payload decides the stage, nothing else does. */
function classify(user: string): { stage: StageName; node: string | undefined } {
	if (user.includes("<user_request>")) return { stage: "uplift", node: undefined };
	if (user.startsWith("<spec>")) return { stage: "clarify", node: undefined };
	if (user.includes("current_node")) return { stage: "fill", node: CURRENT_NODE.exec(user)?.[1] };
	return { stage: "graph", node: undefined };
}

/** A small deterministic integer mix: the same parts always give the same value, no `Math.random`. */
function mix(...parts: number[]): number {
	let hash = 0x811c9dc5;
	for (const part of parts) {
		hash ^= part >>> 0;
		hash = Math.imul(hash, 0x01000193);
		hash ^= hash >>> 15;
	}
	return hash >>> 0;
}

function pick(low: number, high: number, ...parts: number[]): number {
	return low + (mix(...parts) % (high - low + 1));
}

function numericOf(node: string): number {
	return Number(node.replace(/\D/g, "")) || 0;
}

interface Reply {
	uplift(key: string): string;
	graph(key: string, index: number): string;
	fill(key: string, index: number, node: string): string;
	clarify(key: string): string;
}

function createReplies(seed: number, range: [number, number]): Reply {
	return {
		uplift: (key) =>
			`<BUILD_PROMPT><SYSTEM_ROLE>Senior engineer.</SYSTEM_ROLE><APP_CONTEXT>A chaos pipeline fixture.</APP_CONTEXT><SCOPE>Only the request.</SCOPE><CONSTRAINTS>Do not invent repo facts.</CONSTRAINTS><ACCEPTANCE_CRITERIA>Done when the request ${key} is met.</ACCEPTANCE_CRITERIA><OUT_OF_SCOPE>Unrelated work.</OUT_OF_SCOPE></BUILD_PROMPT>`,
		graph: (key, index) => {
			const count = pick(range[0], range[1], seed, index, 1);
			const nodes = Array.from({ length: count }, (_, i) => {
				const dependsOn: string[] = [];
				if (i > 0) dependsOn.push(`n${i}`);
				if (i >= 3 && mix(seed, index, i) % 3 === 0) dependsOn.push(`n${i - 1}`);
				return {
					id: `n${i + 1}`,
					title: `Step ${i + 1}`,
					kind: i === 0 ? "understand" : i === count - 1 ? "synthesize" : "generate",
					question: `What does step ${i + 1} of ${key} need?`,
					depends_on: dependsOn,
				};
			});
			return JSON.stringify({ goal: `Ship it ${key}`, nodes });
		},
		fill: (key, index, node) => {
			const count = pick(5, 8, seed, index, numericOf(node), 2);
			const steps = Array.from(
				{ length: count },
				(_, i) => `${i + 1}. Step ${i + 1} of ${node}: a discrete, self-contained action.`,
			).join("\n");
			return `<node><rationale>\n${steps}\n</rationale><conclusion>Answer for ${node} ${key}</conclusion></node>`;
		},
		clarify: (key) =>
			JSON.stringify({
				questions: [
					{
						question: `Which scope applies to ${key}?`,
						header: "Scope",
						why: "The plan depends on it.",
						options: [{ label: "Minimal" }, { label: "Full" }],
						default: "Minimal",
					},
				],
			}),
	};
}

interface RuleState {
	rule: Rule;
	remaining: number;
}

function matches(
	rule: Rule,
	call: { stage: StageName; node: string | undefined; key: string; index: number; ordinal: number },
): boolean {
	if (rule.stage !== call.stage) return false;
	if (rule.node !== undefined && rule.node !== call.node) return false;
	if (rule.promptId !== undefined) {
		const hit =
			typeof rule.promptId === "number" ? call.index === rule.promptId : call.key === rule.promptId;
		if (!hit) return false;
	}
	if (rule.every !== undefined && call.index % rule.every !== 0) return false;
	if (rule.nth !== undefined) {
		const [from, to] = typeof rule.nth === "number" ? [rule.nth, rule.nth] : rule.nth;
		if (call.ordinal < from || call.ordinal > to) return false;
	}
	return true;
}

function faultError(effect: Extract<Effect, { kind: "error" }>): Error {
	const error = new Error(effect.message ?? "provider fault");
	if (effect.status !== undefined)
		Object.assign(error, { status: effect.status, apiErrorStatus: effect.status });
	// Seconds, as a provider's Retry-After carries them: `retryAfter` is the field the retry kernel reads.
	if (effect.retryAfterSec !== undefined) {
		Object.assign(error, { retryAfterSec: effect.retryAfterSec, retryAfter: effect.retryAfterSec });
	}
	return error;
}

function chainOf(effect: Effect): Effect["kind"][] {
	return effect.kind === "delay"
		? [effect.kind, ...chainOf(effect.after ?? { kind: "ok" })]
		: [effect.kind];
}

function failureReport(error: unknown): CompletionReport {
	const status = numberField(error, "status");
	const retryAfterSec = numberField(error, "retryAfterSec");
	const message = error instanceof Error ? error.message : "";
	return {
		attempts: 1,
		...(status === undefined ? {} : { httpStatus: status }),
		...(retryAfterSec === undefined ? {} : { retryAfterMs: retryAfterSec * 1000 }),
		...(message === "" ? {} : { cause: message }),
	};
}

/**
 * A seeded fault-injecting completer. The stage is sniffed from the payload, the prompt from the `pl-<seed>-<6 digit index>`
 * nonce the driver puts in every prompt, and every wait goes through the injected sleep, so a fault is a function of
 * (prompt, stage, node, ordinal) and never of scheduler order. Ok replies are stage-correct and carry the prompt nonce.
 */
export function createScriptedProvider(rules: Rule[], seams: ProviderSeams = {}): ScriptedProvider {
	const sleep = seams.sleep ?? abortableSleep;
	const now = seams.now ?? Date.now;
	const replies = createReplies(seams.seed ?? 0, seams.nodeRange ?? DEFAULT_NODE_RANGE);
	const states: RuleState[] = rules.map((rule) => ({
		rule,
		remaining: rule.count === "forever" ? Number.POSITIVE_INFINITY : (rule.count ?? 1),
	}));
	const log: CallLog[] = [];
	const ordinals = new Map<string, number>();
	const reports = new Map<string, CompletionReport>();
	let inflightNow = 0;
	let inflightPeak = 0;
	let refused = false;
	let anonymous = 0;

	const okReply = (
		call: { stage: StageName; node: string | undefined; key: string; index: number },
		inner: ClaudeCompleter | undefined,
		system: string,
		user: string,
		signal: AbortSignal | undefined,
	): Promise<string> | string => {
		if (inner) return inner(system, user, signal);
		switch (call.stage) {
			case "uplift":
				return replies.uplift(call.key);
			case "graph":
				return replies.graph(call.key, call.index);
			case "fill":
				return replies.fill(call.key, call.index, call.node ?? "n1");
			case "clarify":
				return replies.clarify(call.key);
		}
	};

	const apply = async (
		effect: Effect,
		ok: () => Promise<string> | string,
		signal: AbortSignal | undefined,
	): Promise<string> => {
		switch (effect.kind) {
			case "ok":
				return ok();
			case "delay":
				await sleep(effect.ms, signal);
				return apply(effect.after ?? { kind: "ok" }, ok, signal);
			case "error":
				throw faultError(effect);
			case "network":
				throw Object.assign(new Error(`read ${effect.code}`), { code: effect.code });
			case "empty":
				return "";
			case "truncate":
				return (await ok()).slice(0, effect.at);
			case "garbage":
				return effect.text;
			case "hang": {
				const { promise, reject } = Promise.withResolvers<string>();
				// Without a signal nothing can end the call: it stays pending, as a real hung request would.
				signal?.addEventListener("abort", () => reject(abortError()), { once: true });
				return promise;
			}
		}
	};

	const run = async (
		inner: ClaudeCompleter | undefined,
		system: string,
		user: string,
		signal: AbortSignal | undefined,
	): Promise<string> => {
		if (seams.maxCalls !== undefined && log.length >= seams.maxCalls) {
			refused = true;
			throw new Error(`chaos: max-calls reached (${seams.maxCalls})`);
		}
		const { stage, node } = classify(user);
		const nonces = [...new Set(user.match(NONCE) ?? [])];
		const seq = log.length + 1;
		const key = nonces[0] ?? `call-${seq}`;
		const parsed = nonces[0] === undefined ? undefined : NONCE_PARTS.exec(nonces[0])?.[1];
		const index = parsed === undefined ? undefined : Number(parsed);
		// A call with no nonce still gets a running index, so every/promptId selectors keep working for hand-written payloads.
		const effectiveIndex = index ?? (anonymous += 1);
		const ordinalKey = `${key}\0${stage}`;
		const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1;
		ordinals.set(ordinalKey, ordinal);
		const call = { stage, node, key, index: effectiveIndex, ordinal };
		const entry: CallLog = {
			seq,
			stage,
			key,
			index,
			node,
			ordinal,
			effect: "ok",
			chain: ["ok"],
			outcome: "pending",
			status: undefined,
			startedAt: now(),
			endedAt: undefined,
			foreign: nonces.slice(nonces[0] === undefined ? 0 : 1),
		};
		log.push(entry);
		inflightNow += 1;
		inflightPeak = Math.max(inflightPeak, inflightNow);
		try {
			if (signal?.aborted) throw abortError();
			const state = states.find(
				(candidate) => candidate.remaining > 0 && matches(candidate.rule, call),
			);
			if (state) state.remaining -= 1;
			const effect = state?.rule.effect ?? { kind: "ok" as const };
			entry.effect = effect.kind;
			entry.chain = chainOf(effect);
			if (effect.kind === "error") entry.status = effect.status;
			const text = await apply(effect, () => okReply(call, inner, system, user, signal), signal);
			entry.outcome = "ok";
			reports.set(key, { attempts: 1 });
			return text;
		} catch (error) {
			if (isAbortError(error)) {
				entry.outcome = "aborted";
			} else {
				entry.outcome = "error";
				entry.status ??= numberField(error, "status");
				reports.set(key, failureReport(error));
			}
			throw error;
		} finally {
			inflightNow -= 1;
			entry.endedAt = now();
		}
	};

	return {
		complete: (system, user, signal) => run(undefined, system, user, signal),
		wrap: (inner) => (system, user, signal) => run(inner, system, user, signal),
		calls: () => log.map((entry) => ({ ...entry, foreign: [...entry.foreign] })),
		byPrompt: (key) => log.filter((entry) => entry.key === key).map((entry) => ({ ...entry })),
		byStage: (stage) => log.filter((entry) => entry.stage === stage).map((entry) => ({ ...entry })),
		inflight: () => ({ now: inflightNow, peak: inflightPeak }),
		report: (key) => reports.get(key),
		quiesce: () => {
			for (const state of states) state.remaining = 0;
		},
		capped: () => refused,
	};
}

/**
 * A clock that only the injected sleep moves: a wait yields one macrotask (so other prompts run and an abort can land)
 * and adds its duration when it wakes. Nothing here reads the wall clock.
 */
export function createVirtualClock(start = 0): { now: () => number; sleep: typeof abortableSleep } {
	let time = start;
	return {
		now: () => time,
		sleep: (ms, signal) => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			if (signal?.aborted) {
				reject(abortError());
				return promise;
			}
			const onAbort = (): void => {
				clearImmediate(handle);
				reject(abortError());
			};
			const handle = setImmediate(() => {
				signal?.removeEventListener("abort", onAbort);
				time += Math.max(0, ms);
				resolve();
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			return promise;
		},
	};
}

function textOfUser(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) =>
			fieldOf(block, "type") === "text" ? String(fieldOf(block, "text") ?? "") : "",
		)
		.join("");
}

/**
 * The scripted provider as the native `completeSimple` the Omp planner calls: the same classification, faults and
 * counters, with the reply as one text block. A scripted failure rejects with its own status; its Retry-After goes out
 * through `onResponse` as the header the native binding reads.
 */
export function asCompleteSimple(scripted: Pick<ScriptedProvider, "complete">): CompleteSimple {
	return async (_model, context, options?: SimpleStreamOptions) => {
		const system = fieldOf(context, "systemPrompt");
		const messages = fieldOf(context, "messages");
		const first: unknown = Array.isArray(messages) ? messages[0] : undefined;
		try {
			const text = await scripted.complete(
				Array.isArray(system) ? system.join("\n") : typeof system === "string" ? system : "",
				textOfUser(fieldOf(first, "content")),
				options?.signal,
			);
			return {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "chaos",
				provider: "chaos",
				model: "pipeline",
				usage: {},
				stopReason: "stop",
				timestamp: 0,
			} as unknown as AssistantMessage;
		} catch (error) {
			const status = numberField(error, "status");
			const retryAfterSec = numberField(error, "retryAfterSec");
			if (status !== undefined && options?.onResponse) {
				const metadata: unknown = {
					status,
					headers: retryAfterSec === undefined ? {} : { "retry-after": String(retryAfterSec) },
				};
				await options.onResponse(
					metadata as Parameters<NonNullable<SimpleStreamOptions["onResponse"]>>[0],
				);
			}
			throw error;
		}
	};
}
