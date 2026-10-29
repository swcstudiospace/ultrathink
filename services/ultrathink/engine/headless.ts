// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Server-side planner: runs the plugin's own pipeline (`planPrompt`: uplift, Graph of Thought, Chain of Thought,
 * clarify) against the plan-login `claude -p` backend (with the optional `grok` fallback), as a background job with
 * long-polled results.
 *
 * The plan never reads the operator's personal config or control state: the plugin config is built here and handed
 * over captured, the env is built from scratch, and tracking, substrate, Hindsight, RAGFlow, shipping, lessons and
 * Jev stay off. The only outbound traffic is the `claude` CLI child (plus the `grok` CLI when the Grok fallback is
 * on), each with an allowlisted env.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeCompleter } from "../../../src/claude/complete.ts";
import { readSession } from "../../../src/claude/state.ts";
import { defaultConfig, type UltrathinkConfig as PluginConfig } from "../../../src/config.ts";
import type { ModelResolution, SelectedEngine } from "../../../src/host/engine.ts";
import {
	GROKBOT_ENGINE_HOST,
	checkRecord,
	journalDir,
	readMeta,
} from "../../../src/host/grokbot.ts";
import { type PlanResponse, planPrompt } from "../../../src/host/plan.ts";
import { redactSecrets } from "../../../src/redact.ts";
import { isAbortError } from "../../../src/shared.ts";
import { type CompletionReport, readReport } from "../../../src/types.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { CeilingError, type Ledger, LedgerWriteError } from "../cost/ledger.ts";
import { currentRequestContext } from "../obs/context.ts";
import { type Admission, createFairShare, type FairShareTimers } from "../obs/fair-share.ts";
import { failureLabel, type Logger } from "../obs/log.ts";
import type { SpanSink } from "../obs/otel.ts";
import { childSpan } from "../obs/trace.ts";
import type { Store } from "../store/store.ts";
import type { BreakerState, CircuitBreaker, ReleaseOutcome } from "./breaker.ts";
import type { GraphView } from "./graph-view.ts";
import {
	type JournalErrorCode,
	type JournalResult,
	type SessionView,
	cleanText,
	isSessionId,
	isolatedConfigEnv,
	fail,
} from "./journal.ts";
import { clientPlanView, serverPlanView } from "./plan-view.ts";
import {
	type PlanBackend,
	PlanCompleterError,
	type PlanErrorCode,
	type PlanUsage,
	createPlanBackend,
} from "./plan.ts";
import type { ChatQuestion } from "./render.ts";

export type JobStatus = "running" | "planned" | "failed" | "invalid" | "skipped";

export interface JobUsage {
	calls: number;
	inputTokens: number;
	outputTokens: number;
}

export interface ResultView {
	sessionId: string;
	status: JobStatus;
	mode: "server" | "client";
	/** Chat-ready plan when planned, otherwise one status line. */
	text: string;
	truncated?: boolean;
	questions?: ChatQuestion[];
	/** Structured Graph of Thought x Chain of Thought of a planned session; absent for a fallback or empty graph. */
	graph?: GraphView;
	usage?: JobUsage;
	/** Seconds a poller should wait before asking again; present while running. */
	pollAfterSec?: number;
	error?: string;
}

export interface StartView {
	sessionId: string;
	status: JobStatus;
	pollAfterSec?: number;
	error?: string;
}

/** Codes a start can be refused with: the journal's, plus the two a hosted plan adds. */
type StartRefusal = JournalErrorCode | "upstream_unavailable" | "aborted";

/**
 * A start's answer. A refusal that is worth retrying (`busy`, `upstream_unavailable`) carries `retryAfterSec`, the number
 * of seconds the caller should wait before asking again.
 */
export type StartResult =
	| { ok: true; data: StartView }
	| { ok: false; code: StartRefusal; errors?: string[]; retryAfterSec?: number };

/** What one finished job reports, once, when it reaches its final status; counts and timings only, never text. */
export interface JobOutcome {
	sessionId: string;
	status: Exclude<JobStatus, "running">;
	error?: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	/** Milliseconds from the job's creation to its final status, queue time excluded. */
	ms: number;
}

export interface HeadlessPlanner {
	/** `config.serverPlanning`. */
	readonly enabled: boolean;
	/**
	 * Starts a plan. Over capacity the start waits in a bounded queue (at most 60 s) instead of answering busy at once; a
	 * full queue or an expired wait answers `busy` with a retry hint. An open upstream breaker refuses before anything is
	 * created, and a request that aborts while waiting or while its plan runs ends the job as aborted.
	 */
	start(input: { prompt: unknown; sessionId?: unknown }): Promise<StartResult>;
	result(input: {
		sessionId: unknown;
		waitSeconds?: unknown;
		detail?: unknown;
	}): Promise<JournalResult<ResultView>>;
	/** Null when the session is not a server job (including malformed ids, which the journal reports). */
	status(input: { sessionId: unknown }): JournalResult<SessionView> | null;
	/**
	 * Ends a running job as failed "aborted" and frees its plan slot. A session that is unknown, finished or another
	 * principal's answers not_found; never throws. Absent on a planner that cannot cancel.
	 */
	cancel?(input: { sessionId: unknown }): JournalResult<StartView>;
	/** Refuses every new plan (and every queued one) with not_ready; accepted jobs keep running until `shutdown`. */
	beginDrain?(): void;
	/** Aborts running jobs, waits up to 5 s, then marks what is left failed with error "interrupted". */
	shutdown(): Promise<void>;
	/** Upstream circuit breaker state and failure count for health reporting; undefined when the planner has no breaker. */
	upstream(): { state: BreakerState; failures: number } | undefined;
	/** Readiness of the plan backend: the `claude` CLI check; always ok when a test completer replaces the backend. */
	backendReady(): { ok: boolean; detail?: string };
}

export interface PlannerCall {
	sessionId: string;
	model: string;
	ms: number;
	outcome: string;
	attempts: number;
	inputTokens: number;
	outputTokens: number;
}

export interface HeadlessOptions {
	config: UltrathinkConfig;
	store: Store;
	ledger: Ledger;
	now?: () => number;
	/** Resolves early when `signal` aborts. Drives the start window, the long poll, the plan timeout and the shutdown wait. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Replaces the plan backend's `complete` (tests); the plan backend readiness check is skipped. Its calls are still reserved and settled in the ledger. */
	completer?: ClaudeCompleter;
	/** Replaces the plan-login backend (tests). */
	planBackend?: PlanBackend;
	/** Environment the planner's allowlisted pass-through keys are read from; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Plugin entry point; defaults to `planPrompt`. A test seam, never a behavior switch. */
	plan?: typeof planPrompt;
	/** One event per model call; counts and timings only, never keys, prompts or response text. A throwing hook is ignored. */
	onCall?: (call: PlannerCall) => void;
	/** One event per job, when it reaches its final status (not when a client polls it). A throwing hook is ignored. */
	onOutcome?: (outcome: JobOutcome) => void;
	/** The abort signal of the request that is calling `start`; read once, synchronously, when `start` is called. */
	requestSignal?: () => AbortSignal | undefined;
	/** Receives one `job_persist_failed` event per settled job whose file could not be written; never prompts or keys. */
	logger?: Logger;
	/** Upstream circuit breaker guarding every model call; a refused call fails the job with `upstream_unavailable`. */
	breaker?: CircuitBreaker;
	/** Receives one CLIENT span per model call made under a sampled request context; never sees prompts, replies or env. */
	spans?: SpanSink;
}

interface JobFile {
	sessionId: string;
	runId: string;
	status: JobStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
	usage: JobUsage;
	promptSha256: string;
	/** Principal of the admitted request that started the job; absent for an unadmitted start and for older files. */
	principal?: string;
}

type AbortReason = "timeout" | "shutdown" | "budget_exceeded" | "ledger_unavailable" | "aborted";

interface Job extends JobFile {
	controller: AbortController;
	reason?: AbortReason;
	/** First non-abort completer failure, as a code. A breaker refusal is not one: it is kept in `refusal`. */
	firstError?: string;
	/** Set when the breaker refused a model call; the retry hint of the first refusal. */
	refusal?: { retryAfterMs: number | undefined };
	seq: number;
	settled: boolean;
	done: Promise<void>;
	finish: () => void;
	/** Releases the plan slot taken from the fair-share pool; absent for starts without an admission. */
	slotRelease?: () => void;
	/** Failover summary the plan backend reported (first one wins); memory only, never persisted. */
	failover?: string;
	/** The report of the model call that settled last: why it failed and after how many attempts; absent after an answer. Memory only. */
	report?: CompletionReport;
}

interface Outcome {
	status: Exclude<JobStatus, "running">;
	error?: string;
}

const START_WAIT_MS = 15_000;
/** Longest a start waits for a plan slot; a wait that runs out answers busy. */
const QUEUE_WAIT_MS = 60_000;
/** Waiting starts allowed per plan slot: the queue holds `maxConcurrentPlans * QUEUE_DEPTH_PER_PLAN`. */
const QUEUE_DEPTH_PER_PLAN = 4;
/** Retry hint of a busy answer, in seconds. */
const BUSY_RETRY_AFTER_SEC = 30;
/** The fairness key of a start that carries no admission (stdio, tests). */
const UNADMITTED_PRINCIPAL = "unknown";
const MAX_CAUSE_CHARS = 200;
const SHUTDOWN_WAIT_MS = 5_000;
const DEFAULT_WAIT_SECONDS = 40;
const MAX_WAIT_SECONDS = 45;
const POLL_AFTER_SEC = 5;
const CHARS_PER_TOKEN = 3;
const MAX_ERROR_CHARS = 300;
const PLANNER_OWNER = "ultrathink-server-planner";
/**
 * Accounting allowance reserved for the reply when the output cap is unlimited (0). It is an estimate, not an output
 * cap: a completion call without a cap sends no max_tokens.
 */
const RESERVATION_ALLOWANCE_TOKENS = 16000;
/** Settled jobs whose file could not be written stay readable in memory up to this many; the oldest are dropped. */
export const UNPERSISTED_JOBS_MAX = 50;
const JOB_STATUSES: Record<string, true> = {
	running: true,
	planned: true,
	failed: true,
	invalid: true,
	skipped: true,
};
/** Skips that mean the engine failed rather than that the request was declined. */
const ENGINE_SKIPS: Record<string, true> = { "uplift-failed": true, "engine-error": true };
/** Codes a plan-login completer failure carries. */
const PLAN_ERROR_CODES: Readonly<Record<PlanErrorCode, true>> = {
	auth: true,
	rate_limited: true,
	upstream: true,
	timeout: true,
	aborted: true,
	upstream_unavailable: true,
};

/** The classified code of a completer failure: the closed-set `code` of a `PlanCompleterError`. */
function failureCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !("code" in error)) return undefined;
	const { code } = error;
	return typeof code === "string" && Object.hasOwn(PLAN_ERROR_CODES, code) ? code : undefined;
}

/**
 * What one call tells the breaker: a reply counts as a success, an unreachable, slow or overloaded upstream as a
 * failure, and anything the upstream is not responsible for (the caller's abort, an unclassified error) as neither.
 */
function releaseFor(code: string | undefined): ReleaseOutcome {
	switch (code) {
		case "upstream":
		case "timeout":
		case "rate_limited":
			return "failure";
		default:
			return "ignored";
	}
}

/** Sum of two optional token counts; a count nobody reported stays absent. */
function addCount(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	return b === undefined ? a : a + b;
}

/** Variables with no secret and no config meaning that a plan may inherit. */
const PASS_THROUGH_ENV = ["PATH", "TZ", "LANG", "LC_ALL", "TMPDIR"] as const;

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted) return Promise.resolve();
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve();
		},
		{ once: true },
	);
	return promise;
};

/** The plugin config a server plan runs with: planning on, everything that reaches outside the model off. */
function pluginConfig(): PluginConfig {
	const config = defaultConfig();
	config.uplift = { ...config.uplift, enabled: true, skipTrivial: false, echo: false };
	config.claude = { ...config.claude, concurrency: 3, callTimeoutMs: 0, budgetMs: 0, echo: false };
	config.think = { ...config.think, enabled: true };
	config.hitl = { ...config.hitl, enabled: true, knowledgeBase: false };
	config.track = { ...config.track, enabled: false };
	config.ship = { ...config.ship, enabled: false, autoMerge: false };
	config.hindsight = { ...config.hindsight, enabled: false, url: "" };
	config.ragflow = { ...config.ragflow, enabled: false, ground: false, url: "" };
	config.teach = { ...config.teach, enabled: false, recall: false };
	// Decision spend is not metered yet, so Jev stays off in every server plan.
	config.decisions = { ...config.decisions, enabled: false };
	config.substrate = { ...config.substrate, url: "" };
	config.gateway = { ...config.gateway, url: "" };
	config.notion = { dataSourceUrl: "" };
	config.linear = { team: "" };
	config.state = { ...config.state, retentionDays: 0 };
	config.pstack = { ...config.pstack, enabled: false };
	config.swarm = { ...config.swarm, autoRun: false };
	return config;
}

function isJobFile(value: unknown): value is JobFile {
	if (typeof value !== "object" || value === null) return false;
	const file = value as Record<string, unknown>;
	return (
		typeof file.sessionId === "string" &&
		typeof file.runId === "string" &&
		typeof file.status === "string" &&
		Object.hasOwn(JOB_STATUSES, file.status) &&
		typeof file.createdAt === "number" &&
		typeof file.updatedAt === "number" &&
		typeof file.promptSha256 === "string" &&
		typeof file.usage === "object" &&
		file.usage !== null &&
		(file.principal === undefined || typeof file.principal === "string")
	);
}

/** Why a plan threw: the error's class or code and its redacted, single-line, bounded message. Never a prompt or a key. */
function causeOf(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const oneLine = redactSecrets(message).replace(/\s+/g, " ").trim().slice(0, MAX_CAUSE_CHARS);
	return oneLine.length === 0 ? failureLabel(error) : `${failureLabel(error)}: ${oneLine}`;
}

/** Whole seconds to wait for a retry hint in ms; at least 1, and 1 s when the breaker named no time. */
function retryAfterSec(ms: number | undefined): number {
	return Math.max(1, Math.ceil((ms ?? 1000) / 1000));
}

/**
 * A model call the breaker refused: nothing reached the upstream. `retryAfterMs` says when to ask again.
 *
 * `status` is 424 (Failed Dependency) so the retry kernel treats the refusal as permanent: the breaker, not a node fill's
 * backoff, decides when the upstream is tried again, and a fill that slept out the breaker's whole open period (up to 30 s
 * per attempt) would hold its plan slot for minutes. A refused fill is therefore degraded at once, as the plan's record
 * and the job's retry hint report it.
 */
class BreakerRefusal extends PlanCompleterError {
	readonly status = 424;

	constructor(retryAfterMs: number) {
		super("upstream_unavailable", "unavailable", undefined, retryAfterMs);
	}
}

export function createHeadlessPlanner(opts: HeadlessOptions): HeadlessPlanner {
	const { config, store, ledger } = opts;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? defaultSleep;
	const plan = opts.plan ?? planPrompt;
	const stateDir = config.stateDir;
	const planModel = config.planningModel;
	let backend: PlanBackend | undefined;
	/** Built once, on first use, so a test that injects a completer never touches the plan module's process checks. */
	function planBackend(): PlanBackend {
		backend ??=
			opts.planBackend ??
			createPlanBackend({
				model: planModel,
				fallback: config.planFallback ?? "none",
				concurrency: config.planConcurrency ?? 2,
				timeoutMs: config.modelTimeoutMs,
				env: opts.env ?? process.env,
			});
		return backend;
	}
	const jobsDir = join(stateDir, "jobs");
	const cwd = join(stateDir, "cwd");
	const jobs = new Map<string, Job>();
	/**
	 * The queue's timers run on the planner's own `sleep`, so a test that injects one controls the 60 s wait. A wait that
	 * was cleared resolves its sleep early; the guard keeps it from firing.
	 */
	const queueTimers: FairShareTimers = {
		setTimeout(run, ms) {
			const timer = new AbortController();
			sleep(ms, timer.signal)
				.then(() => {
					if (!timer.signal.aborted) run();
				})
				.catch(() => {
					// reason: sleep rejects only on abort, which is the intended cancellation.
				});
			return timer;
		},
		clearTimeout(handle) {
			(handle as AbortController).abort();
		},
	};
	const queueDepth = config.maxConcurrentPlans * QUEUE_DEPTH_PER_PLAN;
	/**
	 * Fairness rule of the wait queue: one principal may have at most half the queue waiting, so a single key that sends
	 * a burst cannot fill it and starve the others. A start that finds its principal at that share, or the queue full,
	 * is answered busy at once; the rest wait in arrival order, an owner's start ahead of a connector's.
	 */
	const queuedPerPrincipalMax = Math.max(1, Math.ceil(queueDepth / 2));
	/** Plan slots for every start, admitted or not; a start over the budget waits here. */
	const slots = createFairShare({
		capacity: config.maxConcurrentPlans,
		reserve: config.maxConcurrentPlans >= 2 ? 1 : 0,
		perPrincipalMax: Math.ceil(config.maxConcurrentPlans / 2),
		queue: { depth: queueDepth, waitMs: QUEUE_WAIT_MS, timers: queueTimers },
	});
	/** Starts waiting for a slot, per principal. */
	const queuedByPrincipal = new Map<string, number>();
	/** Ends every wait for a slot when the planner drains. */
	const drainWaiters = new AbortController();
	/** Session ids of settled jobs kept only in memory, oldest first. */
	const unpersisted: string[] = [];
	const enabled = config.serverPlanning;
	let closed = false;
	let draining = false;

	const jobPath = (sessionId: string): string => join(jobsDir, `${sessionId}.json`);

	function persist(file: JobFile): void {
		mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
		const path = jobPath(file.sessionId);
		const tmp = `${path}.${process.pid}.tmp`;
		const body: JobFile = {
			sessionId: file.sessionId,
			runId: file.runId,
			status: file.status,
			createdAt: file.createdAt,
			updatedAt: file.updatedAt,
			...(file.error === undefined ? {} : { error: file.error }),
			usage: { ...file.usage },
			promptSha256: file.promptSha256,
			...(file.principal === undefined ? {} : { principal: file.principal }),
		};
		writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	}

	function readJobFile(sessionId: string): JobFile | undefined {
		try {
			const parsed: unknown = JSON.parse(readFileSync(jobPath(sessionId), "utf8"));
			return isJobFile(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	// A job left running by a previous process has no one to finish it.
	function recoverInterrupted(): void {
		let names: string[];
		try {
			names = readdirSync(jobsDir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const file = readJobFile(name.slice(0, -".json".length));
			if (file?.status !== "running") continue;
			try {
				persist({ ...file, status: "failed", error: "interrupted", updatedAt: now() });
			} catch (error) {
				// reason: the file keeps its running status; the other jobs are still recovered.
				opts.logger?.error(`recoverInterrupted: ${failureLabel(error)}`);
				continue;
			}
			try {
				store.updateRun(file.runId, { status: "failed", reason: "interrupted" });
			} catch (error) {
				// reason: the run row is bookkeeping only.
				opts.logger?.error(`recoverInterrupted: ${failureLabel(error)}`);
			}
		}
	}

	function plannerEnv(): Record<string, string | undefined> {
		const base = opts.env ?? process.env;
		const env: Record<string, string | undefined> = {};
		for (const key of PASS_THROUGH_ENV) if (base[key] !== undefined) env[key] = base[key];
		Object.assign(env, isolatedConfigEnv(stateDir), {
			ULTRATHINK_HOST: GROKBOT_ENGINE_HOST,
			ULTRATHINK_STATE_DIR: stateDir,
			ULTRATHINK_SHIP: "0",
			ULTRATHINK_HINDSIGHT: "0",
			ULTRATHINK_RAGFLOW: "0",
			ULTRATHINK_TEACH: "0",
			ULTRATHINK_GATEWAY: "0",
			ULTRATHINK_DECISIONS: "0",
			SUBSTRATE_DISABLED: "1",
		});
		// Decision spend is not metered, so Jev stays off here.
		// ULTRATHINK_CHILD and ULTRATHINK_UPLIFT are not on the allowlist, so they cannot reach the plan.
		return env;
	}

	function resolutionFor(model: string): ModelResolution {
		return {
			version: "1.0.0",
			state: "override",
			host: GROKBOT_ENGINE_HOST,
			source: "host-override",
			reason: "explicit-model",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			modelKnown: true,
			modelId: model,
			label: `plan:${model}`,
		};
	}

	/**
	 * One model call behind the circuit breaker, recorded as one CLIENT span under a sampled request context.
	 * No traceparent goes anywhere: the model is a CLI child, not an HTTP hop.
	 */
	async function guarded(model: string, call: () => Promise<string>): Promise<string> {
		const slot = opts.breaker?.tryAcquire();
		if (slot !== undefined && !slot.ok) throw new BreakerRefusal(slot.retryAfterMs);
		const ctx = currentRequestContext();
		const spanId =
			ctx === undefined || ctx.sampled === false || opts.spans === undefined
				? undefined
				: childSpan({ traceId: ctx.traceId, spanId: ctx.spanId, sampled: true }).spanId;
		const startWall = Date.now();
		const startMono = performance.now();
		let release: ReleaseOutcome = "ignored";
		try {
			const text = await call();
			release = "success";
			return text;
		} catch (error) {
			release = releaseFor(failureCode(error));
			throw error;
		} finally {
			slot?.release(release);
			if (ctx !== undefined && spanId !== undefined) {
				const startUnixNano = BigInt(startWall) * 1_000_000n;
				try {
					opts.spans?.record({
						traceId: ctx.traceId,
						spanId,
						parentSpanId: ctx.spanId,
						name: "plan complete",
						kind: 3,
						startUnixNano,
						endUnixNano:
							startUnixNano + BigInt(Math.round((performance.now() - startMono) * 1_000_000)),
						attributes: {
							"ultrathink.engine": "plan",
							"ultrathink.model": model,
							"ultrathink.attempt": 1,
						},
						error: release === "failure",
					});
				} catch {
					// reason: a throwing sink must not change the call's result.
				}
			}
		}
	}

	/** One model call, reserved before and settled after in the ledger; a ceiling ends the whole job. */
	function meteredCompleter(job: Job, model: string): ClaudeCompleter {
		return async (system, user, signal) => {
			if (signal?.aborted || job.controller.signal.aborted)
				throw new DOMException("plan aborted", "AbortError");
			const inputEstimate = Math.ceil((system.length + user.length) / CHARS_PER_TOKEN);
			let outputCap: number | undefined;
			let estimated = 0;
			let reservationId: number;
			try {
				const budget = ledger.headroom(job.runId);
				if (config.modelMaxOutputTokens > 0) {
					outputCap = config.modelMaxOutputTokens;
				} else if (budget !== undefined) {
					const derived = Math.min(budget.tokens - inputEstimate, RESERVATION_ALLOWANCE_TOKENS);
					if (derived < 1) throw new CeilingError(budget.reason);
					outputCap = derived;
				}
				estimated = inputEstimate + (outputCap ?? RESERVATION_ALLOWANCE_TOKENS);
				reservationId = ledger.reserve({
					runId: job.runId,
					phase: `model-${++job.seq}`,
					attempt: 1,
					estimatedTokens: estimated,
				}).reservationId;
			} catch (error) {
				job.reason ??= error instanceof CeilingError ? "budget_exceeded" : "ledger_unavailable";
				job.controller.abort();
				if (error instanceof CeilingError || error instanceof LedgerWriteError) throw error;
				throw new Error(`meteredCompleter: ${failureLabel(error)}`, { cause: error });
			}
			const reported: { usage?: PlanUsage } = {};
			const startedAt = now();
			const emit = (outcome: string, usage?: PlanUsage, attempts?: number): void => {
				if (!opts.onCall) return;
				try {
					opts.onCall({
						sessionId: job.sessionId,
						model,
						ms: Math.max(0, now() - startedAt),
						outcome,
						attempts: attempts ?? 1,
						inputTokens: usage?.promptTokens ?? 0,
						outputTokens: usage?.completionTokens ?? 0,
					});
				} catch {
					// reason: telemetry must never affect the job.
				}
			};

			/** Books one model call: its usage joins the job totals and the reservation settles to the actual tokens. */
			const bill = (usage: PlanUsage | undefined, reservation: number): void => {
				job.usage.calls += 1;
				if (usage) {
					job.usage.inputTokens += usage.promptTokens ?? 0;
					job.usage.outputTokens += usage.completionTokens ?? 0;
				}
				const known = (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
				// An endpoint that omits a count has not said the call was free: the reservation (the worst-case estimate) stays, so the ceilings keep counting.
				const countsKnown =
					usage?.promptTokens !== undefined && usage.completionTokens !== undefined;
				const actual = countsKnown ? known : Math.max(known, estimated);
				try {
					ledger.settle(reservation, Math.max(0, Math.round(actual)));
				} catch {
					// reason: the reservation keeps counting, which only errs on the safe side.
				}
			};
			// False when the breaker refuses the call: nothing reached the backend, so nothing was spent.
			let dispatched = false;
			try {
				const complete: ClaudeCompleter =
					opts.completer ??
					((planSystem, planUser, planSignal) =>
						planBackend().complete(planSystem, planUser, planSignal, {
							...(outputCap === undefined ? {} : { maxOutputTokens: outputCap }),
							// One report per attempt: they add up, so a failed attempt plus an answering one bill both.
							onUsage: (usage) => {
								const sum = reported.usage ?? {};
								const promptTokens = addCount(sum.promptTokens, usage.promptTokens);
								const completionTokens = addCount(sum.completionTokens, usage.completionTokens);
								reported.usage = {
									...(promptTokens === undefined ? {} : { promptTokens }),
									...(completionTokens === undefined ? {} : { completionTokens }),
								};
							},
							onFailover: (summary) => {
								job.failover ??= summary;
							},
						}));
				const text = await guarded(model, () => {
					dispatched = true;
					return complete(system, user, signal);
				});
				const { usage } = reported;
				job.report = undefined;
				emit("ok", usage);
				bill(usage, reservationId);
				return text;
			} catch (error) {
				const code = failureCode(error);
				const failure = code ?? (isAbortError(error) ? "aborted" : "engine_error");
				// A reply cut at its output limit reports what it cost, so that call is billed like a completed one.
				const cut =
					reported.usage?.promptTokens !== undefined ||
					reported.usage?.completionTokens !== undefined
						? reported.usage
						: undefined;
				const report = readReport(error);
				job.report = report;
				emit(failure, cut, report?.attempts);
				if (!dispatched) {
					// A refusal spends no tokens: releasing it in full keeps an outage from eating the daily ceiling.
					try {
						ledger.settle(reservationId, 0);
					} catch {
						// reason: the reservation keeps counting, which only errs on the safe side.
					}
				} else if (cut) {
					bill(cut, reservationId);
				} else {
					try {
						ledger.abandon(reservationId);
					} catch {
						// reason: the reservation keeps counting, which only errs on the safe side.
					}
				}
				const aborted = code === undefined ? isAbortError(error) : code === "aborted";
				if (error instanceof BreakerRefusal) job.refusal ??= { retryAfterMs: error.retryAfterMs };
				else if (!aborted) job.firstError ??= code ?? "engine_error";
				if (!aborted && code === undefined)
					throw new Error(`meteredCompleter: ${failureLabel(error)}`, { cause: error });
				throw error;
			}
		};
	}

	function abortOutcome(job: Job): Outcome {
		switch (job.reason) {
			case "timeout":
				return { status: "failed", error: "timeout" };
			case "shutdown":
				return { status: "failed", error: "interrupted" };
			case "budget_exceeded":
				return { status: "failed", error: "budget_exceeded" };
			case "ledger_unavailable":
				return { status: "failed", error: "ledger_unavailable" };
			default:
				return { status: "failed", error: "aborted" };
		}
	}

	/** The code that explains a failed plan: the engine's own failure, else a breaker refusal. */
	function engineError(job: Job): string | undefined {
		return job.firstError ?? (job.refusal === undefined ? undefined : "upstream_unavailable");
	}

	function judge(job: Job, response: PlanResponse): Outcome {
		if (job.reason !== undefined || response.skipped === "aborted") return abortOutcome(job);
		if (response.skipped !== undefined && !Object.hasOwn(ENGINE_SKIPS, response.skipped))
			return { status: "skipped", error: response.skipped };
		if (response.skipped !== undefined || response.statePath === undefined)
			return { status: "failed", error: engineError(job) ?? response.skipped ?? "engine_error" };
		const record = readSession(stateDir, job.sessionId);
		if (!record) return { status: "failed", error: engineError(job) ?? "engine_error" };
		const check = checkRecord(record, { thinkOff: false });
		if (check.ok) return { status: "planned" };
		// The engine's own failure explains a degraded record better than the degradation does.
		if (job.firstError !== undefined) return { status: "failed", error: job.firstError };
		// Nothing was answered at all: every call was refused, which is a plan the upstream failed, not a degraded one.
		if (job.refusal !== undefined && job.usage.calls === 0)
			return { status: "failed", error: "upstream_unavailable" };
		// A refused fill is not a failed plan: the record says which stages degraded, and the hint says when to retry.
		const hint =
			job.refusal === undefined
				? ""
				: `; upstream refused, retry after ${retryAfterSec(job.refusal.retryAfterMs)}s`;
		const detail = check.errors.join("; ");
		const room = Math.max(0, MAX_ERROR_CHARS - hint.length);
		const shown = detail.length > room ? `${detail.slice(0, Math.max(0, room - 3))}...` : detail;
		return { status: "invalid", error: `${shown}${hint}` };
	}

	/** A settled job without a file is served from memory for a while; the map must not grow for the process lifetime. */
	function retainUnpersisted(job: Job, error: unknown): void {
		try {
			opts.logger?.error("job_persist_failed", {
				sessionId: job.sessionId,
				status: job.status,
				error,
			});
		} catch {
			// reason: logging must never affect the job.
		}
		unpersisted.push(job.sessionId);
		while (unpersisted.length > UNPERSISTED_JOBS_MAX) {
			const oldest = unpersisted.shift();
			if (oldest !== undefined) jobs.delete(oldest);
		}
	}

	function finalize(job: Job, outcome: Outcome): void {
		if (job.settled) return;
		job.settled = true;
		job.slotRelease?.();
		job.status = outcome.status;
		if (outcome.error === undefined) delete job.error;
		else job.error = outcome.error;
		job.updatedAt = now();
		let persistError: unknown;
		let written = true;
		try {
			persist(job);
		} catch (error) {
			// reason: the error is kept and logged by retainUnpersisted (job_persist_failed); the job stays in memory.
			written = false;
			persistError = error;
		}
		try {
			store.updateRun(
				job.runId,
				outcome.status === "planned"
					? { status: "complete", reason: null }
					: { status: "failed", reason: outcome.error ?? outcome.status },
			);
		} catch (error) {
			// reason: the run row is bookkeeping only; the job outcome is already set above.
			opts.logger?.error(`finalize: ${failureLabel(error)}`);
		}
		if (written) jobs.delete(job.sessionId);
		else retainUnpersisted(job, persistError);
		reportOutcome(job, outcome);
		job.finish();
	}

	/** One outcome event per job, at its end: the metrics must not depend on a client coming back to poll. */
	function reportOutcome(job: Job, outcome: Outcome): void {
		if (!opts.onOutcome) return;
		try {
			opts.onOutcome({
				sessionId: job.sessionId,
				status: outcome.status,
				...(outcome.error === undefined ? {} : { error: outcome.error }),
				calls: job.usage.calls,
				inputTokens: job.usage.inputTokens,
				outputTokens: job.usage.outputTokens,
				ms: Math.max(0, job.updatedAt - job.createdAt),
			});
		} catch {
			// reason: telemetry must never affect the job.
		}
	}

	/** Ends a running job as aborted: its model call is told to stop, and the job settles without waiting for it. */
	function cancelJob(job: Job): void {
		if (job.settled) return;
		job.reason ??= "aborted";
		job.controller.abort();
		finalize(job, abortOutcome(job));
	}

	async function execute(job: Job, prompt: string, model: string): Promise<void> {
		const timer = new AbortController();
		if (config.planTimeoutMs > 0) {
			sleep(config.planTimeoutMs, timer.signal)
				.then(() => {
					if (timer.signal.aborted || job.settled) return;
					job.reason ??= "timeout";
					job.controller.abort();
				})
				.catch(() => {
					// reason: sleep rejects only on abort, which is the intended cancellation.
				});
		}
		let outcome: Outcome;
		try {
			const response = await plan(
				{ host: GROKBOT_ENGINE_HOST, session_id: job.sessionId, prompt, cwd },
				plannerEnv(),
				{
					stateDir,
					signal: job.controller.signal,
					config: pluginConfig(),
					control: { enabled: true },
					createTracker: () => undefined,
					selectEngine: async (): Promise<SelectedEngine> => ({
						label: `plan:${model}`,
						complete: meteredCompleter(job, model),
						error: () => engineError(job),
						report: () => job.report,
						failover: () => job.failover,
						resolution: resolutionFor(model),
					}),
				},
			);
			outcome = judge(job, response);
		} catch (error) {
			// A failure the completer or an abort explains is carried by job.firstError, job.refusal or job.reason; one nobody explains is logged with its cause.
			if (job.reason === undefined && engineError(job) === undefined)
				opts.logger?.error("engine_error", { sessionId: job.sessionId, cause: causeOf(error) });
			outcome =
				job.reason === undefined
					? { status: "failed", error: engineError(job) ?? "engine_error" }
					: abortOutcome(job);
		} finally {
			timer.abort();
		}
		finalize(job, outcome);
	}

	async function waitFor(job: Job, ms: number): Promise<void> {
		if (job.settled || ms <= 0) return;
		const wait = new AbortController();
		try {
			await Promise.race([job.done, sleep(ms, wait.signal)]);
		} finally {
			wait.abort();
		}
	}

	function startView(file: JobFile): StartView {
		return {
			sessionId: file.sessionId,
			status: file.status,
			...(file.status === "running" ? { pollAfterSec: POLL_AFTER_SEC } : {}),
			...(file.error === undefined ? {} : { error: file.error }),
		};
	}

	/** An open breaker's refusal, or undefined when a call would be let through (a probe is not consumed). */
	function breakerRefusal(): StartResult | undefined {
		const verdict = opts.breaker?.peek();
		if (verdict === undefined || verdict.ok) return undefined;
		return {
			ok: false,
			code: "upstream_unavailable",
			retryAfterSec: retryAfterSec(verdict.retryAfterMs),
		};
	}

	/** A start whose request already went away must not begin a plan nobody will read. */
	function lateAbort(signal: AbortSignal | undefined): StartResult | undefined {
		return signal?.aborted ? { ok: false, code: "aborted" } : undefined;
	}

	type Slot = { ok: true; release: () => void } | { ok: false; refusal: StartResult };

	/**
	 * One plan slot for `asked`: at once when the budget allows, otherwise after a bounded wait in arrival order. The wait
	 * ends early when the request aborts or the planner drains, and a principal at its share of the queue is not queued.
	 */
	async function takeSlot(asked: Admission, signal: AbortSignal | undefined): Promise<Slot> {
		const busy = (): Slot => ({
			ok: false,
			refusal: { ok: false, code: "busy", retryAfterSec: BUSY_RETRY_AFTER_SEC },
		});
		const immediate = slots.acquire(asked);
		if (immediate.ok) return { ok: true, release: immediate.release };
		const waiting = queuedByPrincipal.get(asked.principal) ?? 0;
		if (waiting >= queuedPerPrincipalMax) return busy();
		queuedByPrincipal.set(asked.principal, waiting + 1);
		const ends = [drainWaiters.signal, ...(signal === undefined ? [] : [signal])];
		let outcome: Awaited<ReturnType<typeof slots.admit>>;
		try {
			outcome = await slots.admit(asked, { signal: AbortSignal.any(ends) });
		} finally {
			const left = (queuedByPrincipal.get(asked.principal) ?? 1) - 1;
			if (left > 0) queuedByPrincipal.set(asked.principal, left);
			else queuedByPrincipal.delete(asked.principal);
		}
		if (outcome.ok) return { ok: true, release: outcome.release };
		if (outcome.cause === "aborted")
			return {
				ok: false,
				refusal: closed || draining ? fail("not_ready") : { ok: false, code: "aborted" },
			};
		return busy();
	}

	/** What an id's existing owner makes of a start: a conflict, or the job the start joins. */
	type Claim = { refusal: StartResult } | { join: JobFile; live: Job | undefined };

	/** Synchronous on purpose: the caller relies on nothing running between this check and `jobs.set`. */
	function sessionClaim(sessionId: string, promptSha256: string): Claim | undefined {
		const live = jobs.get(sessionId);
		const existing = live ?? readJobFile(sessionId);
		if (existing) {
			if (existing.promptSha256 !== promptSha256) return { refusal: fail("session_conflict") };
			return { join: existing, live };
		}
		// The id already belongs to the client-driven loop.
		if (readMeta(journalDir(stateDir, sessionId))) return { refusal: fail("session_conflict") };
		return undefined;
	}

	async function answerClaimed(claim: Claim): Promise<StartResult> {
		if ("refusal" in claim) return claim.refusal;
		if (claim.live) await waitFor(claim.live, START_WAIT_MS);
		return { ok: true, data: startView(claim.live ?? claim.join) };
	}

	/** An unadmitted caller (stdio, a test) and an owner may act on any job; a principal only on its own. */
	function mayAct(job: Job): boolean {
		const admission = currentRequestContext()?.admission;
		if (admission === undefined || admission.class === "owner") return true;
		return job.principal === admission.principal;
	}

	function beginDrain(): void {
		if (draining) return;
		draining = true;
		drainWaiters.abort();
	}

	recoverInterrupted();

	return {
		enabled,

		async start(input) {
			// Read first: this runs before the first await, inside the request that called start.
			const callerSignal = opts.requestSignal?.();
			const sessionId = input.sessionId === undefined ? randomUUID() : input.sessionId;
			if (!isSessionId(sessionId)) return fail("invalid_session_id");
			if (typeof input.prompt !== "string") return fail("invalid_input");
			const prompt = cleanText(input.prompt);
			if (prompt.length === 0 || (config.maxInputChars > 0 && prompt.length > config.maxInputChars))
				return fail("invalid_input");
			if (!enabled) return fail("disabled");
			if (closed || draining) return fail("not_ready");
			if (opts.completer === undefined && !planBackend().ready().ok) return fail("not_ready");

			const promptSha256 = createHash("sha256").update(prompt).digest("hex");
			const claimed = sessionClaim(sessionId, promptSha256);
			if (claimed) return answerClaimed(claimed);
			// An open breaker refuses before a run row, a job file or a slot exists.
			const refused = breakerRefusal();
			if (refused) return refused;

			const admission = currentRequestContext()?.admission;
			const asked: Admission = admission ?? { principal: UNADMITTED_PRINCIPAL, class: "owner" };
			const granted = await takeSlot(asked, callerSignal);
			if (!granted.ok) return granted.refusal;
			let slotRelease: (() => void) | undefined = granted.release;
			// The wait was long enough for the world to change: re-check what a refusal depends on.
			const late =
				closed || draining ? fail("not_ready") : (breakerRefusal() ?? lateAbort(callerSignal));
			if (late) {
				slotRelease();
				return late;
			}
			// Another start of this id may have run while this one waited. Nothing awaits between this check and
			// jobs.set below, so exactly one start per id creates the job and the others answer from it.
			const raced = sessionClaim(sessionId, promptSha256);
			if (raced) {
				slotRelease();
				return answerClaimed(raced);
			}

			let job: Job;
			let runId: string | undefined;
			try {
				mkdirSync(cwd, { recursive: true });
				const at = now();
				// A claimable status would let a queue worker adopt the row; paused-for-blocker is never claimed.
				const run = store.db
					.transaction(() => {
						const created = store.createRun({
							ownerId: PLANNER_OWNER,
							request: `server plan ${sessionId}`,
							route: "server-planning",
						});
						store.updateRun(created.id, {
							status: "paused-for-blocker",
							reason: "server_planning",
							currentPhase: "plan",
						});
						return created;
					})
					.immediate();
				runId = run.id;
				const { promise, resolve } = Promise.withResolvers<void>();
				job = {
					sessionId,
					runId: run.id,
					status: "running",
					createdAt: at,
					updatedAt: at,
					usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
					promptSha256,
					...(admission === undefined ? {} : { principal: admission.principal }),
					controller: new AbortController(),
					seq: 0,
					settled: false,
					done: promise,
					finish: resolve,
					slotRelease,
				};
				persist(job);
			} catch (error) {
				slotRelease?.();
				slotRelease = undefined;
				opts.logger?.error("start_failed", { sessionId, cause: causeOf(error) });
				// A row that was created but whose job file could not be written must not stay paused for ever.
				if (runId !== undefined) {
					try {
						store.updateRun(runId, { status: "failed", reason: "persist_failed" });
					} catch (updateError) {
						// reason: the run row is bookkeeping only; the failed start is already answered.
						opts.logger?.error(`start: ${failureLabel(updateError)}`);
					}
				}
				return fail("engine_error");
			}
			jobs.set(sessionId, job);
			void execute(job, prompt, planModel);
			// A caller that goes away while it waits for the first answer takes its plan with it.
			const running = job;
			const onAbort = (): void => cancelJob(running);
			callerSignal?.addEventListener("abort", onAbort, { once: true });
			try {
				await waitFor(job, START_WAIT_MS);
			} finally {
				callerSignal?.removeEventListener("abort", onAbort);
			}
			return { ok: true, data: startView(job) };
		},

		cancel(input) {
			const { sessionId } = input;
			if (!isSessionId(sessionId)) return fail("invalid_session_id");
			const job = jobs.get(sessionId);
			if (!job || job.settled || !mayAct(job)) return fail("not_found");
			cancelJob(job);
			return { ok: true, data: startView(job) };
		},

		beginDrain,

		async result(input) {
			const { sessionId } = input;
			if (!isSessionId(sessionId)) return fail("invalid_session_id");
			let waitSeconds = DEFAULT_WAIT_SECONDS;
			if (input.waitSeconds !== undefined) {
				if (typeof input.waitSeconds !== "number" || Number.isNaN(input.waitSeconds))
					return fail("invalid_input");
				waitSeconds = Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(input.waitSeconds)));
			}
			if (input.detail !== undefined && input.detail !== "brief" && input.detail !== "full")
				return fail("invalid_input");
			const detail: "brief" | "full" = input.detail === "full" ? "full" : "brief";
			try {
				const live = jobs.get(sessionId);
				if (live) await waitFor(live, waitSeconds * 1000);
				const file = live ?? readJobFile(sessionId);
				return file
					? serverPlanView(stateDir, file, detail)
					: clientPlanView(stateDir, sessionId, detail);
			} catch (error) {
				opts.logger?.error("engine_error", { sessionId, cause: causeOf(error) });
				return fail("engine_error");
			}
		},

		status(input) {
			const sessionId = input.sessionId;
			if (!isSessionId(sessionId)) return null;
			const file = jobs.get(sessionId) ?? readJobFile(sessionId);
			if (!file) return null;
			return { ok: true, data: { sessionId, status: file.status, pendingCount: 0, pending: [] } };
		},

		backendReady() {
			return opts.completer === undefined ? planBackend().ready() : { ok: true };
		},

		upstream() {
			if (opts.breaker === undefined) return undefined;
			const snapshot = opts.breaker.snapshot();
			return { state: snapshot.state, failures: snapshot.failures };
		},

		async shutdown() {
			closed = true;
			beginDrain();
			const running = [...jobs.values()].filter((job) => !job.settled);
			if (running.length === 0) return;
			for (const job of running) {
				job.reason ??= "shutdown";
				job.controller.abort();
			}
			const wait = new AbortController();
			try {
				await Promise.race([
					Promise.all(running.map((job) => job.done)),
					sleep(SHUTDOWN_WAIT_MS, wait.signal),
				]);
			} finally {
				wait.abort();
			}
			for (const job of running) finalize(job, { status: "failed", error: "interrupted" });
		},
	};
}
