// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Decisions runtime every decision point shares: the key lookup, the one is-point-active predicate, and a
 * fail-open run() that returns a typed outcome plus a content-free DecisionRecord. Jev runs on OpenRouter or the
 * Vercel AI Gateway rail; `resolveDecisionsKeys` is the one place the rail and key are picked. Every real attempt
 * feeds the health breaker and, when the host names a `stateDir`, the usage ledger (no `stateDir` means no disk at
 * all); while the breaker is open run() makes no request.
 */
import { readStore, storePath as defaultStorePath } from "../mcp/store.ts";
import {
	type DecideOutcome,
	type DecisionAttempt,
	decide,
	redact,
	resolveDecisionsUrl,
} from "./client.ts";
import {
	type JevCall,
	type JevHealth,
	type JevRail,
	openJevHealth,
	openMemoryJevHealth,
	unavailableMessage,
} from "./health.ts";
import { type DecisionStates, QUESTION_KEYS, QUESTIONS } from "./questions.ts";
import {
	type DecisionAction,
	type DecisionPoint,
	type DecisionRecord,
	type DecisionsConfig,
	DecisionsError,
	type DecisionsRequest,
	formatP,
} from "./types.ts";
import { appendUsage, type UsageRecord } from "./usage.ts";
import { decideVercel, resolveGatewayModel } from "./vercel.ts";

type Env = Record<string, string | undefined>;

export type KeySource = "store" | "ULTRATHINK_OPENROUTER_KEY" | "AI_GATEWAY_API_KEY";

/**
 * Stored openrouter api_key (trimmed, non-empty) wins; else trimmed non-empty env.ULTRATHINK_OPENROUTER_KEY; else
 * undefined. The generic OpenRouter variable that SDKs and agents auto-read is deliberately not read: exporting it
 * would let every other tool in the shell spend Jev's key. Never throws.
 */
export function resolveOpenRouterKey(
	storePath: string,
	env: Env,
): { key: string; source: KeySource } | undefined {
	return resolveStoreKey(storePath, env, "openrouter", "ULTRATHINK_OPENROUTER_KEY");
}

/** Stored vercel api_key (trimmed, non-empty) wins; else trimmed non-empty env.AI_GATEWAY_API_KEY; else undefined. Never throws. */
export function resolveVercelKey(
	storePath: string,
	env: Env,
): { key: string; source: KeySource } | undefined {
	return resolveStoreKey(storePath, env, "vercel", "AI_GATEWAY_API_KEY");
}

function resolveStoreKey(
	storePath: string,
	env: Env,
	provider: string,
	envVar: "ULTRATHINK_OPENROUTER_KEY" | "AI_GATEWAY_API_KEY",
): { key: string; source: KeySource } | undefined {
	try {
		const providers = readStore(storePath).providers as Record<string, unknown>;
		const credential = providers[provider] as { kind?: unknown; apiKey?: unknown } | undefined;
		const stored =
			credential?.kind === "api_key" && typeof credential.apiKey === "string"
				? credential.apiKey.trim()
				: "";
		if (stored) return { key: stored, source: "store" };
	} catch {
		// reason: unreadable store falls back to the environment; the failure is hidden. Deferred: outside services, see 79-CONTEXT D-03 (root-side B sites).
	}
	const fromEnv = env[envVar]?.trim();
	return fromEnv ? { key: fromEnv, source: envVar } : undefined;
}

/** The picked rail: `auto` resolves to vercel when its key is present, else openrouter; explicit pins either. */
export type ResolvedProvider = JevRail;

export interface ResolvedDecisionsKeys {
	provider: ResolvedProvider;
	key?: { key: string; source: KeySource };
}

/** The one rail + key picker, shared by the runtime, the CLI and the status line. Never throws. */
export function resolveDecisionsKeys(
	config: DecisionsConfig,
	storePath: string,
	env: Env,
): ResolvedDecisionsKeys {
	const vercel = resolveVercelKey(storePath, env);
	const openrouter = resolveOpenRouterKey(storePath, env);
	const provider: ResolvedProvider =
		config.provider === "vercel"
			? "vercel"
			: config.provider === "openrouter"
				? "openrouter"
				: vercel
					? "vercel"
					: "openrouter";
	const key = provider === "vercel" ? vercel : openrouter;
	return { provider, ...(key ? { key } : {}) };
}

export interface DecisionsDeps {
	env?: Env; // default process.env
	storePath?: string; // default storePath(env)
	fetch?: typeof fetch; // default: globalThis.fetch at call time
	now?: () => number; // default Date.now
	sleep?: (ms: number) => Promise<void>; // default Bun.sleep
	random?: () => number; // default Math.random
	/** One line per decision, without the "[ultrathink] " prefix. Default: when env.ULTRATHINK_DEBUG === "1",
	 *  process.stderr.write(`[ultrathink] ${line}\n`); otherwise no output. */
	debug?: (line: string) => void;
	/**
	 * Where the health breaker and the usage ledger persist. Absent: no disk at all; the breaker lives in memory for
	 * this runtime only and no ledger is written. Production hosts pass their real state dir.
	 */
	stateDir?: string;
	/** Test seam: the breaker run() consults and feeds; default is the file breaker under `stateDir`, else an in-memory one. */
	health?: JevHealth;
}

export interface DecisionsInput extends DecisionsDeps {
	config: DecisionsConfig;
	/** Host session id; omitted from requests when empty or "unknown"; sliced to 256 chars. */
	sessionId?: string;
}

export interface RunDecisionOptions {
	signal?: AbortSignal;
	/** Stored in the record. */
	threshold: number;
	/** Action recorded for an ok outcome (errors record "fail-open"). */
	action: (p: number) => DecisionAction;
}

export type DecisionOutcome =
	| { status: "inactive" } // no request, no record, no debug line
	| { status: "ok"; p: number; record: DecisionRecord }
	| { status: "error"; error: DecisionsError; record: DecisionRecord }; // record.action === "fail-open"

export interface Decisions {
	readonly config: DecisionsConfig;
	/** The one is-point-active predicate: env.ULTRATHINK_DECISIONS !== "0" ∧ config.points.includes(point) ∧ key
	 *  present. Jev is always on; only the kill switch disables. Checks the kill switch and points first; resolves the
	 *  key at most once per runtime (lazily). */
	active(point: DecisionPoint): boolean;
	/** One decision. Never rejects except with an AbortError (caller abort). */
	run<P extends DecisionPoint>(
		point: P,
		state: DecisionStates[P],
		opts: RunDecisionOptions,
	): Promise<DecisionOutcome>;
}

/** The body run() and the CLI send. */
export function buildDecisionsRequest<P extends DecisionPoint>(
	point: P,
	state: DecisionStates[P],
	input: { model: string; zdr: boolean; sessionId?: string; spanName?: string },
): DecisionsRequest {
	const sessionId = input.sessionId?.trim();
	return {
		model: input.model,
		state,
		questions: { [QUESTION_KEYS[point]]: QUESTIONS[point] },
		// zdr false → no provider key at all (A12)
		...(input.zdr ? { provider: { zdr: true, data_collection: "deny" as const } } : {}),
		...(sessionId && sessionId !== "unknown" ? { session_id: sessionId.slice(0, 256) } : {}),
		trace: { trace_name: "ultrathink", span_name: input.spanName ?? point },
	};
}

/** Debug line text (no prefix): never the message, state, error message or key. */
export function formatDebugLine(record: DecisionRecord): string {
	const tail = `${Math.round(record.latencyMs)}ms · attempts ${record.attempts}`;
	if (record.outcome === "error")
		return `decisions ${record.point} · error (${record.error}) · ${tail}`;
	const cost = record.cost !== undefined ? ` · cost ${record.cost}` : "";
	return `decisions ${record.point} · p ${formatP(record.p ?? 0)} · ${record.model} · ${tail}${cost}`;
}

/** `ULTRATHINK_DECISIONS=0` turns every decision point off for this shell, whatever the config says. */
export function decisionsKilled(env: Env): boolean {
	return env.ULTRATHINK_DECISIONS === "0";
}

/**
 * Feeds one finished decision to its rail's breaker, handing back the verdict `shouldCall` gave the call, so only the
 * claimed probe (or an operator's forced call) can close or re-schedule an open breaker. A request reached the wire
 * iff `attempts > 0`; the breaker's own refusals and the local request checks make none, so they are neither a
 * service success nor a failure. Never throws.
 */
export function recordHealth(
	health: JevHealth,
	outcome: DecideOutcome,
	ts: number,
	call?: JevCall,
): void {
	if (outcome.attempts === 0) return;
	if (outcome.ok) health.recordSuccess(ts, call);
	else health.recordFailure(outcome.error.kind, ts, call);
}

/**
 * The transport hook that writes one usage row per real POST (a retried decision is two rows), or undefined when the
 * host named no state dir (no disk at all). Rows carry counts, timings and ids only: never a key, a prompt or a body.
 */
export function usageListener(
	stateDir: string | undefined,
	call: { point: string; rail: ResolvedProvider; model: string },
): ((attempt: DecisionAttempt) => void) | undefined {
	if (stateDir === undefined) return undefined;
	const requestedModel = call.rail === "vercel" ? resolveGatewayModel(call.model) : call.model;
	return (attempt) => {
		const row: UsageRecord = {
			ts: attempt.at,
			point: call.point,
			rail: call.rail,
			requestedModel,
			servedModel: attempt.model,
			ok: attempt.ok,
			kind: attempt.kind,
			status: attempt.status,
			ms: attempt.ms,
			promptTokens: attempt.promptTokens,
			completionTokens: attempt.completionTokens,
			costUsd: attempt.costUsd,
			requestId: attempt.requestId,
		};
		appendUsage(stateDir, row);
	};
}

/** Never throws; reads nothing until active()/run() is called. */
export function createDecisions(input: DecisionsInput): Decisions {
	const { config } = input;
	const env = input.env ?? process.env;
	const now = input.now ?? Date.now;
	const debug =
		input.debug ??
		((line: string) => {
			if (env.ULTRATHINK_DEBUG === "1") process.stderr.write(`[ultrathink] ${line}\n`);
		});
	let resolved: ResolvedDecisionsKeys | undefined;
	const keys = (): ResolvedDecisionsKeys => {
		resolved ??= resolveDecisionsKeys(config, input.storePath ?? defaultStorePath(env), env);
		return resolved;
	};
	const active = (point: DecisionPoint): boolean =>
		!decisionsKilled(env) && config.points.includes(point) && keys().key !== undefined;
	const breakers = new Map<ResolvedProvider, JevHealth>();
	// One breaker per rail (separate keys and accounts). Persisted only when the host named a state dir; otherwise in
	// memory, so a bare runtime touches no disk.
	const healthOf = (rail: ResolvedProvider): JevHealth => {
		let health = breakers.get(rail);
		if (!health) {
			health =
				input.health ??
				(input.stateDir === undefined
					? openMemoryJevHealth(rail)
					: openJevHealth(input.stateDir, rail));
			breakers.set(rail, health);
		}
		return health;
	};

	return {
		config,
		active,
		async run(point, state, opts) {
			const picked = active(point) ? keys() : undefined;
			const apiKeyNow = picked?.key?.key;
			if (!apiKeyNow || !picked) return { status: "inactive" };
			const questionKey = QUESTION_KEYS[point];
			const health = healthOf(picked.provider);
			const start = now();
			// The breaker answers before any request: while it is open there is no network I/O at all.
			const verdict = health.shouldCall(start);
			// What shouldCall told this call (claimed probe or not) goes back with its result.
			let ticket: JevCall | undefined;
			let outcome: DecideOutcome;
			if (!verdict.call) {
				outcome = {
					ok: false,
					error: new DecisionsError("unavailable", unavailableMessage(verdict, picked.provider)),
					attempts: 0,
					latencyMs: 0,
				};
			} else {
				ticket = { ...verdict, startedAt: start };
				try {
					// The Vercel rail has a fixed endpoint; only the OpenRouter rail honors ULTRATHINK_DECISIONS_URL.
					const rail = picked.provider === "vercel" ? decideVercel : decide;
					outcome = await rail(
						buildDecisionsRequest(point, state, {
							model: config.model,
							zdr: config.zdr,
							sessionId: input.sessionId,
						}),
						{
							apiKey: apiKeyNow,
							timeoutMs: config.timeoutMs,
							...(picked.provider === "openrouter" ? { url: resolveDecisionsUrl(env).url } : {}),
							fetch: input.fetch,
							signal: opts.signal,
							now,
							sleep: input.sleep,
							random: input.random,
							onAttempt: usageListener(input.stateDir, {
								point,
								rail: picked.provider,
								model: config.model,
							}),
						},
					);
				} catch (error) {
					// Only the caller's abort propagates; anything else decide() should never throw still fails open.
					if (opts.signal?.aborted) throw error;
					const message = error instanceof Error ? error.message : String(error);
					outcome = {
						ok: false,
						error: new DecisionsError(
							"network",
							redact(
								`decisions network: ${redact(message || "unexpected error", apiKeyNow)}`,
								apiKeyNow,
							),
						),
						attempts: 0,
						latencyMs: Math.max(0, now() - start),
					};
				}
			}
			recordHealth(health, outcome, now(), ticket);
			const base = {
				point,
				threshold: opts.threshold,
				latencyMs: outcome.latencyMs,
				attempts: outcome.attempts,
			};
			let result: Exclude<DecisionOutcome, { status: "inactive" }>;
			if (outcome.ok) {
				const { response } = outcome;
				const answer = response.answers[questionKey];
				// parseDecisionsResponse guarantees a noul answer for the asked key.
				const p = answer?.type === "noul" ? answer.noul : Number.NaN;
				const record: DecisionRecord = {
					...base,
					outcome: "ok",
					model: response.model,
					...(response.id !== undefined ? { id: response.id } : {}),
					p,
					probabilities: { [questionKey]: p },
					action: opts.action(p),
					...(response.usage.cost !== undefined ? { cost: response.usage.cost } : {}),
					at: now(),
				};
				result = { status: "ok", p, record };
			} else {
				const record: DecisionRecord = {
					...base,
					outcome: "error",
					model: config.model,
					probabilities: {},
					action: "fail-open",
					error: outcome.error.kind,
					at: now(),
				};
				result = { status: "error", error: outcome.error, record };
			}
			try {
				debug(formatDebugLine(result.record));
			} catch {
				// reason: a failing debug sink never changes the decision
			}
			return result;
		},
	};
}
