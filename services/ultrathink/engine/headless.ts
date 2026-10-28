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
import type { UltrathinkConfig } from "../config/config.ts";
import { CeilingError, type Ledger, LedgerWriteError } from "../cost/ledger.ts";
import { currentRequestContext } from "../obs/context.ts";
import { createFairShare } from "../obs/fair-share.ts";
import { failureLabel, type Logger } from "../obs/log.ts";
import type { SpanSink } from "../obs/otel.ts";
import { childSpan } from "../obs/trace.ts";
import type { Store } from "../store/store.ts";
import type { BreakerState, CircuitBreaker, ReleaseOutcome } from "./breaker.ts";
import type { GraphView } from "./graph-view.ts";
import {
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

export interface HeadlessPlanner {
	/** `config.serverPlanning`. */
	readonly enabled: boolean;
	start(input: { prompt: unknown; sessionId?: unknown }): Promise<JournalResult<StartView>>;
	result(input: {
		sessionId: unknown;
		waitSeconds?: unknown;
		detail?: unknown;
	}): Promise<JournalResult<ResultView>>;
	/** Null when the session is not a server job (including malformed ids, which the journal reports). */
	status(input: { sessionId: unknown }): JournalResult<SessionView> | null;
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
}

type AbortReason = "timeout" | "shutdown" | "budget_exceeded" | "ledger_unavailable";

interface Job extends JobFile {
	controller: AbortController;
	reason?: AbortReason;
	/** First non-abort completer failure, as a code. */
	firstError?: string;
	seq: number;
	settled: boolean;
	done: Promise<void>;
	finish: () => void;
	/** Releases the plan slot taken from the fair-share pool; absent for starts without an admission. */
	slotRelease?: () => void;
	/** Failover summary the plan backend reported (first one wins); memory only, never persisted. */
	failover?: string;
}

interface Outcome {
	status: Exclude<JobStatus, "running">;
	error?: string;
}

const START_WAIT_MS = 15_000;
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
		file.usage !== null
	);
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
	/** Plan slots for admitted starts. The running count below still caps every start, admitted or not. */
	const slots = createFairShare({
		capacity: config.maxConcurrentPlans,
		reserve: config.maxConcurrentPlans >= 2 ? 1 : 0,
		perPrincipalMax: Math.ceil(config.maxConcurrentPlans / 2),
	});
	/** Session ids of settled jobs kept only in memory, oldest first. */
	const unpersisted: string[] = [];
	const enabled = config.serverPlanning;
	let closed = false;

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
		if (slot !== undefined && !slot.ok)
			throw new PlanCompleterError(
				"upstream_unavailable",
				"unavailable",
				undefined,
				slot.retryAfterMs,
			);
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
			const emit = (outcome: string, usage?: PlanUsage): void => {
				if (!opts.onCall) return;
				try {
					opts.onCall({
						sessionId: job.sessionId,
						model,
						ms: Math.max(0, now() - startedAt),
						outcome,
						attempts: 1,
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
				const text = await guarded(model, () => complete(system, user, signal));
				const { usage } = reported;
				emit("ok", usage);
				bill(usage, reservationId);
				return text;
			} catch (error) {
				const code = failureCode(error);
				const failure =
					code ??
					(error instanceof Error && error.name === "AbortError" ? "aborted" : "engine_error");
				// A reply cut at its output limit reports what it cost, so that call is billed like a completed one.
				const cut =
					reported.usage?.promptTokens !== undefined ||
					reported.usage?.completionTokens !== undefined
						? reported.usage
						: undefined;
				emit(failure, cut);
				if (cut) {
					bill(cut, reservationId);
				} else {
					try {
						ledger.abandon(reservationId);
					} catch {
						// reason: the reservation keeps counting, which only errs on the safe side.
					}
				}
				const aborted =
					code === undefined
						? error instanceof Error && error.name === "AbortError"
						: code === "aborted";
				if (!aborted) job.firstError ??= code ?? "engine_error";
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

	function judge(job: Job, response: PlanResponse): Outcome {
		if (job.reason !== undefined || response.skipped === "aborted") return abortOutcome(job);
		if (response.skipped !== undefined && !Object.hasOwn(ENGINE_SKIPS, response.skipped))
			return { status: "skipped", error: response.skipped };
		if (response.skipped !== undefined || response.statePath === undefined)
			return { status: "failed", error: job.firstError ?? response.skipped ?? "engine_error" };
		const record = readSession(stateDir, job.sessionId);
		if (!record) return { status: "failed", error: job.firstError ?? "engine_error" };
		const check = checkRecord(record, { thinkOff: false });
		if (check.ok) return { status: "planned" };
		// The engine's own failure explains a degraded record better than the degradation does.
		if (job.firstError !== undefined) return { status: "failed", error: job.firstError };
		const detail = check.errors.join("; ");
		return {
			status: "invalid",
			error: detail.length > MAX_ERROR_CHARS ? `${detail.slice(0, MAX_ERROR_CHARS)}...` : detail,
		};
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
		job.finish();
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
						error: () => job.firstError,
						failover: () => job.failover,
						resolution: resolutionFor(model),
					}),
				},
			);
			outcome = judge(job, response);
		} catch {
			// reason: a plan failure is carried by job.firstError (set when the completer fails) or by job.reason (set on abort).
			outcome =
				job.reason === undefined
					? { status: "failed", error: job.firstError ?? "engine_error" }
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

	recoverInterrupted();

	return {
		enabled,

		async start(input) {
			const sessionId = input.sessionId === undefined ? randomUUID() : input.sessionId;
			if (!isSessionId(sessionId)) return fail("invalid_session_id");
			if (typeof input.prompt !== "string") return fail("invalid_input");
			const prompt = cleanText(input.prompt);
			if (prompt.length === 0 || (config.maxInputChars > 0 && prompt.length > config.maxInputChars))
				return fail("invalid_input");
			if (!enabled) return fail("disabled");
			if (closed) return fail("not_ready");
			if (opts.completer === undefined && !planBackend().ready().ok) return fail("not_ready");

			const promptSha256 = createHash("sha256").update(prompt).digest("hex");
			const existing = jobs.get(sessionId) ?? readJobFile(sessionId);
			if (existing) {
				if (existing.promptSha256 !== promptSha256) return fail("session_conflict");
				const live = jobs.get(sessionId);
				if (live) await waitFor(live, START_WAIT_MS);
				return { ok: true, data: startView(live ?? existing) };
			}
			// The id already belongs to the client-driven loop.
			if (readMeta(journalDir(stateDir, sessionId))) return fail("session_conflict");
			let running = 0;
			for (const job of jobs.values()) if (!job.settled) running += 1;
			if (running >= config.maxConcurrentPlans) return fail("busy");
			const admission = currentRequestContext()?.admission;
			let slotRelease: (() => void) | undefined;
			if (admission !== undefined) {
				const slot = slots.acquire(admission);
				if (!slot.ok) return fail("busy");
				slotRelease = slot.release;
			}

			let job: Job;
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
				const { promise, resolve } = Promise.withResolvers<void>();
				job = {
					sessionId,
					runId: run.id,
					status: "running",
					createdAt: at,
					updatedAt: at,
					usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
					promptSha256,
					controller: new AbortController(),
					seq: 0,
					settled: false,
					done: promise,
					finish: resolve,
					slotRelease,
				};
				persist(job);
			} catch {
				slotRelease?.();
				return fail("engine_error");
			}
			jobs.set(sessionId, job);
			void execute(job, prompt, planModel);
			await waitFor(job, START_WAIT_MS);
			return { ok: true, data: startView(job) };
		},

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
			} catch {
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
