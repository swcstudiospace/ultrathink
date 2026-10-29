// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { isAbortError } from "../shared.ts";
import { abortableSleep } from "./sleep.ts";

/** The longest wait any server hint can buy, so a hostile `Retry-After` cannot stall a flight. */
export const RETRY_AFTER_CAP_MS = 120_000;

export interface RetryPolicy {
	maxAttempts: number;
	baseMs: number;
	capMs: number;
}

export interface RetrySeams {
	sleep?: typeof abortableSleep;
	random?: () => number;
	now?: () => number;
}

export interface FailureVerdict {
	transient: boolean;
	status?: number;
	retryAfterMs?: number;
	reason: string;
}

/**
 * Refusals no later attempt can fix. Unknown text is not on this list: a status-less failure retries unless it says
 * plainly that the account, key or request is refused (including a Claude CLI login failure), or that its usage window (session, usage, weekly, monthly,
 * daily limit) or a zero request limit (`limit: 0`, `0/0`, `actual/limit): 5/0`) is out of reach for a retry.
 */
const PERMANENT_TEXT =
	/subscription|permission|not entitled|forbidden|unauthori[sz]ed|not logged in|please run \/login|not authenticated|authentication_error|insufficient[ _]quota|credit balance|access denied|content policy|invalid api key|\b(?:session|usage|weekly|monthly|daily) limit\b|\blimit\)?:?\s*0(?!\d|\.\d)|\bactual\/limit\)?:?\s*\d+\s*\/\s*0(?!\d)|\b0\s*\/\s*0(?!\d)/i;

const DELTA_SECONDS = /^\d+(?:\.\d+)?$/;

/**
 * A `Retry-After` value as milliseconds to wait: delta-seconds (integer or decimal) or an HTTP-date. Garbage, zero and a
 * date at or before `now` give `undefined`; a longer wait is clamped to `RETRY_AFTER_CAP_MS`. Never throws.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number = Date.now(),
): number | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (text === "") return undefined;
	let ms: number;
	if (DELTA_SECONDS.test(text)) {
		ms = Number(text) * 1000;
	} else {
		const at = Date.parse(text);
		if (!Number.isFinite(at)) return undefined;
		ms = at - now;
	}
	if (!(ms > 0)) return undefined;
	return Math.min(Math.round(ms), RETRY_AFTER_CAP_MS);
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function statusOf(error: Record<string, unknown>): number | undefined {
	const candidates = [
		error.status,
		error.statusCode,
		error.errorStatus,
		record(error.response)?.status,
	];
	return candidates.find((c): c is number => typeof c === "number" && Number.isFinite(c));
}

/** One header value from a `Headers` instance or a plain object (case-insensitive key search). */
function headerOf(headers: unknown, name: string): string | undefined {
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const bag = record(headers);
	if (!bag) return undefined;
	const key = Object.keys(bag).find((k) => k.toLowerCase() === name);
	const value = key === undefined ? undefined : bag[key];
	return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function positiveMs(ms: number): number | undefined {
	return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), RETRY_AFTER_CAP_MS) : undefined;
}

function hintOf(error: Record<string, unknown>, now: number): number | undefined {
	if (typeof error.retryAfterMs === "number") return positiveMs(error.retryAfterMs);
	if (typeof error.retryAfter === "number") return positiveMs(error.retryAfter * 1000);
	if (typeof error.retryAfter === "string") return parseRetryAfter(error.retryAfter, now);
	const header =
		headerOf(error.headers, "retry-after") ??
		headerOf(record(error.response)?.headers, "retry-after");
	return parseRetryAfter(header, now);
}

function textOf(error: unknown): string {
	if (typeof error === "string") return error;
	const message = record(error)?.message;
	return typeof message === "string" ? message : "";
}

/**
 * Whether another attempt can help. A status decides when one is present: 408, 425, 429 and every 5xx (529 included)
 * are transient, any other error status is permanent; a 429 whose text says the quota is gone stays permanent. With no
 * status (provider errors delivered as text) the failure is transient unless its text is a plain refusal. An
 * `AbortError` is never transient. Status and hint field names follow `src/failover/classify.ts`.
 */
export function isTransientFailure(error: unknown, now: number = Date.now()): FailureVerdict {
	if (isAbortError(error)) return { transient: false, reason: "aborted" };
	const fields = record(error);
	const status = fields ? statusOf(fields) : undefined;
	const retryAfterMs = fields ? hintOf(fields, now) : undefined;
	const hint = retryAfterMs === undefined ? {} : { retryAfterMs };
	const text = textOf(error);
	if (status !== undefined && status >= 400) {
		const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
		if (status === 429 && PERMANENT_TEXT.test(text)) {
			return { transient: false, status, ...hint, reason: "HTTP 429 with a permanent refusal" };
		}
		return {
			transient: retryable,
			status,
			...hint,
			reason: `HTTP ${status} is ${retryable ? "transient" : "permanent"}`,
		};
	}
	const permanent = PERMANENT_TEXT.test(text);
	return {
		transient: !permanent,
		...(status === undefined ? {} : { status }),
		...hint,
		reason: permanent
			? "no status, text is a permanent refusal"
			: "no status, treated as transient",
	};
}

/** The duck-typed fields downstream classifiers read from whatever is thrown; the wrapper repeats them from its cause. */
const FORWARDED_FIELDS = [
	"status",
	"statusCode",
	"errorStatus",
	"code",
	"retryAfterMs",
	"retryAfter",
	"headers",
	"response",
] as const;

/**
 * What `withRetry` throws when it stops: the last error's message, its `cause`, how many attempts ran, and the cause's
 * `status`, `statusCode`, `errorStatus`, `code`, `retryAfterMs`, `retryAfter`, `headers` and `response` (by reference,
 * only those the cause has), so a wrapped 429 is still a 429 to code that reads the thrown error.
 */
export class RetryExhaustedError extends Error {
	readonly attempts: number;

	constructor(cause: unknown, attempts: number) {
		super(textOf(cause) || String(cause), { cause });
		this.name = "RetryExhaustedError";
		this.attempts = attempts;
		const fields = record(cause);
		if (!fields) return;
		for (const key of FORWARDED_FIELDS) {
			if (fields[key] !== undefined) Object.assign(this, { [key]: fields[key] });
		}
	}
}

/** The error `withRetry` wrapped, or `error` itself when it is not a `RetryExhaustedError`. */
export function unwrapRetryError(error: unknown): unknown {
	return error instanceof RetryExhaustedError ? error.cause : error;
}

/**
 * Runs `fn` until it succeeds, a failure is permanent, or `policy.maxAttempts` is spent. The wait before retry `n` is
 * full jitter, `random() * min(capMs, baseMs * 2^(n-1))`, raised to at least the server's `Retry-After`. An abort is
 * never retried and is checked before every attempt.
 */
export async function withRetry<T>(
	fn: (attempt: number) => Promise<T>,
	policy: RetryPolicy,
	opts: RetrySeams & {
		signal?: AbortSignal;
		classify?: typeof isTransientFailure;
		onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
	} = {},
): Promise<{ value: T; attempts: number }> {
	const { signal, onRetry } = opts;
	const sleep = opts.sleep ?? abortableSleep;
	const random = opts.random ?? Math.random;
	const now = opts.now ?? Date.now;
	const classify = opts.classify ?? isTransientFailure;
	const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts));
	for (let attempt = 1; ; attempt++) {
		// An aborted signal makes the one sleep that raises the kernel's AbortError reject, without arming a timer.
		if (signal?.aborted) await abortableSleep(0, signal);
		try {
			return { value: await fn(attempt), attempts: attempt };
		} catch (error) {
			if (isAbortError(error)) throw error;
			const verdict = classify(error, now());
			if (!verdict.transient || attempt >= maxAttempts) {
				throw new RetryExhaustedError(error, attempt);
			}
			const window = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
			const delayMs = Math.max(random() * window, verdict.retryAfterMs ?? 0);
			onRetry?.({ attempt, delayMs, reason: verdict.reason });
			await sleep(delayMs, signal);
		}
	}
}
