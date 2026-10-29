// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ClaudeCallInfo,
	type ClaudeCompleteOptions,
	type ClaudeCompleter,
	createClaudeCompleter,
} from "../../../src/claude/complete.ts";
import { classifyFailure, type FailureClass } from "../../../src/failover/classify.ts";
import {
	type Completer,
	createFailoverCompleter,
	type FailoverCandidate,
} from "../../../src/failover/chain.ts";
import {
	createGrokCompleter,
	type GrokCallInfo,
	type GrokCompleteOptions,
} from "../../../src/grok/complete.ts";
import { ROUTE_DEFAULT_MODELS } from "../../../src/route-defaults.ts";
import { attachReport, readReport } from "../../../src/types.ts";

/**
 * The hosted service's coding-plan backend: `claude -p` on the plan holder's login, optionally
 * chained with the Grok Build login. Single-owner by design (see docs): the child process only
 * ever sees the allowlisted variables below, never the server's own secrets.
 *
 * Errors carry a classified `code` and a fixed message. The child's stderr, the prompt and any
 * credential never reach `message`; the original error is kept on `cause` for in-process use only.
 */

export interface PlanUsage {
	/** Absent when the CLI did not report a count; unknown is not zero. */
	promptTokens?: number;
	completionTokens?: number;
}

export type PlanErrorCode =
	| "auth"
	| "rate_limited"
	| "upstream"
	| "timeout"
	| "aborted"
	| "upstream_unavailable";

export class PlanCompleterError extends Error {
	readonly code: PlanErrorCode;
	readonly failure: FailureClass;
	/** Set only on `upstream_unavailable`: how long the open circuit breaker keeps refusing calls. */
	readonly retryAfterMs?: number;

	constructor(code: PlanErrorCode, failure: FailureClass, cause?: unknown, retryAfterMs?: number) {
		super(`plan ${code}`, cause === undefined ? undefined : { cause });
		this.name = "PlanCompleterError";
		this.code = code;
		this.failure = failure;
		if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
	}
}

export interface PlanCallHooks {
	/** Output-token cap for this call, passed to every completer that supports one. */
	maxOutputTokens?: number;
	/** Fires once per attempt that reported tokens (a failed Claude attempt, then Grok). */
	onUsage?: (usage: PlanUsage) => void;
	/** Fires once after a call that a later candidate answered, with the chain's summary. */
	onFailover?: (summary: string) => void;
}

export interface PlanBackend {
	/** `plan:<model>` or `plan:<model>+grok`. */
	readonly label: string;
	ready(): { ok: boolean; detail?: string };
	/** One model call. Throws PlanCompleterError. */
	complete(
		system: string,
		user: string,
		signal?: AbortSignal,
		hooks?: PlanCallHooks,
	): Promise<string>;
}

export interface PlanBackendOptions {
	model: string;
	fallback: "none" | "grok";
	concurrency: number;
	/** 0 = no timer. */
	timeoutMs: number;
	/** Filtered through the allowlist inside; never passed whole. */
	env: Record<string, string | undefined>;
	/** Default `Bun.which`. */
	which?: (command: string) => string | undefined;
	/** Test seam; default `createClaudeCompleter`. */
	claude?: (opts: Omit<ClaudeCompleteOptions, "signal">) => ClaudeCompleter;
	/** Test seam; default `createGrokCompleter`. */
	grok?: (opts: Omit<GrokCompleteOptions, "signal">) => Completer;
}

/** The only variables a plan child may inherit. */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
	"PATH",
	"TZ",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"HOME",
	"XDG_CONFIG_HOME",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"GROK_HOME",
];

function allowlistedEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const name of CHILD_ENV_ALLOWLIST) {
		const value = env[name];
		if (value !== undefined) out[name] = value;
	}
	return out;
}

function codeFor(failure: FailureClass): PlanErrorCode {
	switch (failure) {
		case "auth":
			return "auth";
		case "plan-limit":
		case "billing":
		case "rate-limit":
			return "rate_limited";
		case "timeout":
			return "timeout";
		case "aborted":
			return "aborted";
		default:
			return "upstream";
	}
}

function toPlanError(error: unknown): PlanCompleterError {
	if (error instanceof PlanCompleterError) return error;
	const failure = classifyFailure(error);
	const planError = new PlanCompleterError(codeFor(failure), failure, error);
	// The think stage judges a failed fill by the completer's report: a failure it already retried must not be retried again.
	attachReport(planError, readReport(error) ?? { attempts: 1 });
	return planError;
}

function abortedError(): PlanCompleterError {
	return new PlanCompleterError("aborted", "aborted");
}

/** Counting semaphore: FIFO hand-off, abortable while queued. */
class Semaphore {
	private active = 0;
	private readonly waiting: Array<{ grant: () => void }> = [];

	constructor(private readonly limit: number) {}

	async acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortedError();
		if (this.active < this.limit) {
			this.active += 1;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const waiter = {
			grant: () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
		};
		const onAbort = (): void => {
			const index = this.waiting.indexOf(waiter);
			if (index >= 0) this.waiting.splice(index, 1);
			reject(abortedError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.waiting.push(waiter);
		await promise;
	}

	release(): void {
		const next = this.waiting.shift();
		if (next) {
			// The slot passes straight to the next waiter; `active` stays.
			next.grant();
			return;
		}
		this.active -= 1;
	}
}

export function createPlanBackend(opts: PlanBackendOptions): PlanBackend {
	const env = allowlistedEnv(opts.env);
	const which = opts.which ?? ((command: string) => Bun.which(command) ?? undefined);
	const makeClaude = opts.claude ?? createClaudeCompleter;
	const makeGrok = opts.grok ?? createGrokCompleter;
	const semaphore = new Semaphore(Math.max(1, Math.floor(opts.concurrency)));
	// The failover chain is built once (its cooldown state must outlive a call). The per-call hooks
	// and the output cap travel through async context, and each attempt builds its completer from
	// them, so concurrent calls never see each other's tokens or caps.
	const callHooks = new AsyncLocalStorage<PlanCallHooks>();

	const report = (promptTokens: number | undefined, completionTokens: number | undefined): void => {
		const hook = callHooks.getStore()?.onUsage;
		if (!hook) return;
		const usage: PlanUsage = {};
		if (promptTokens !== undefined) usage.promptTokens = promptTokens;
		if (completionTokens !== undefined) usage.completionTokens = completionTokens;
		if (usage.promptTokens === undefined && usage.completionTokens === undefined) return;
		try {
			hook(usage);
		} catch {
			// reason: a usage hook must never change the completion outcome
		}
	};

	// One report per attempt: a failed Claude attempt that consumed tokens is not folded into the
	// attempt that answered. Note: whether the Claude CLI honors the output cap is up to
	// `maxOutputTokens` in src/claude/complete.ts; each completer is given what it supports.
	const claudeAttempt: Completer = (system, user, signal) =>
		makeClaude({
			auth: "plan",
			env,
			model: opts.model,
			timeoutMs: opts.timeoutMs,
			maxOutputTokens: callHooks.getStore()?.maxOutputTokens,
			onResult: (info: ClaudeCallInfo) => report(info.inputTokens, info.outputTokens),
		})(system, user, signal);

	const grokAttempt =
		(model: string): Completer =>
		(system, user, signal) =>
			makeGrok({
				model,
				transport: "http",
				timeoutMs: opts.timeoutMs,
				env,
				maxOutputTokens: callHooks.getStore()?.maxOutputTokens,
				...(env.GROK_HOME ? { home: env.GROK_HOME } : {}),
				onResult: (info: GrokCallInfo) => report(info.inputTokens, info.outputTokens),
			})(system, user, signal);

	let run: Completer = claudeAttempt;
	if (opts.fallback === "grok") {
		// Exactly one Grok model: the hosted fallback never tries another one.
		const grokModel = ROUTE_DEFAULT_MODELS.grok;
		const candidates: FailoverCandidate[] = [
			{ id: `claude:${opts.model}`, label: `claude:${opts.model}`, complete: claudeAttempt },
			{ id: `grok:${grokModel}`, label: `grok:${grokModel}`, complete: grokAttempt(grokModel) },
		];
		// The chain calls this inside the caller's async context, so it reaches this call's hook only.
		run = createFailoverCompleter(candidates, {
			onFailover: (summary) => callHooks.getStore()?.onFailover?.(summary),
		}).complete;
	}

	return {
		label: opts.fallback === "grok" ? `plan:${opts.model}+grok` : `plan:${opts.model}`,
		ready() {
			if (!which("claude")) return { ok: false, detail: "claude CLI not found" };
			if (opts.fallback === "grok" && !which("grok")) {
				return {
					ok: true,
					detail: "grok CLI not found: the Grok fallback cannot refresh its login",
				};
			}
			return { ok: true };
		},
		async complete(system, user, signal, hooks = {}) {
			await semaphore.acquire(signal);
			try {
				return await callHooks.run(hooks, () => run(system, user, signal));
			} catch (error) {
				throw toPlanError(error);
			} finally {
				semaphore.release();
			}
		},
	};
}
