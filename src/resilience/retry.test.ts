// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { isAbortError } from "../shared.ts";
import {
	isTransientFailure,
	parseRetryAfter,
	RETRY_AFTER_CAP_MS,
	RetryExhaustedError,
	type RetrySeams,
	unwrapRetryError,
	withRetry,
} from "./retry.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");

function failure(message: string, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), extra);
}

function abortError(): Error {
	return Object.assign(new Error("aborted"), { name: "AbortError" });
}

describe("parseRetryAfter", () => {
	test("reads delta-seconds, integer and decimal, as milliseconds", () => {
		expect(parseRetryAfter("7", NOW)).toBe(7000);
		expect(parseRetryAfter("0.5", NOW)).toBe(500);
		expect(parseRetryAfter(" 3 ", NOW)).toBe(3000);
	});

	test("reads an HTTP-date in the future as the milliseconds until then", () => {
		const date = new Date(NOW + 30_000).toUTCString();
		expect(parseRetryAfter(date, NOW)).toBe(30_000);
	});

	test("returns undefined for garbage, a past date, zero, null and undefined without throwing", () => {
		for (const value of ["soon", "", "abc123", "NaN", "-5", "0", "0.0", null, undefined]) {
			expect(parseRetryAfter(value, NOW)).toBeUndefined();
		}
		const past = new Date(NOW - 60_000).toUTCString();
		expect(parseRetryAfter(past, NOW)).toBeUndefined();
		expect(parseRetryAfter(new Date(NOW).toUTCString(), NOW)).toBeUndefined();
	});

	test("clamps a hostile hint, delta or date, to the cap", () => {
		expect(RETRY_AFTER_CAP_MS).toBe(120_000);
		expect(parseRetryAfter("99999", NOW)).toBe(RETRY_AFTER_CAP_MS);
		expect(parseRetryAfter(new Date(NOW + 86_400_000).toUTCString(), NOW)).toBe(RETRY_AFTER_CAP_MS);
	});
});

describe("isTransientFailure", () => {
	test("408, 425, 429 and every 5xx including 529 are transient", () => {
		for (const status of [408, 425, 429, 500, 502, 503, 529, 599]) {
			const verdict = isTransientFailure(failure("boom", { status }));
			expect(verdict.transient).toBe(true);
			expect(verdict.status).toBe(status);
			expect(verdict.reason.length).toBeGreaterThan(0);
		}
	});

	test("400, 401, 403, 404, 409 and 422 are permanent", () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			const verdict = isTransientFailure(failure("boom", { status }));
			expect(verdict.transient).toBe(false);
			expect(verdict.status).toBe(status);
		}
	});

	test("a 429 whose text says the quota or subscription is gone is permanent", () => {
		expect(isTransientFailure(failure("insufficient_quota", { status: 429 })).transient).toBe(
			false,
		);
		expect(isTransientFailure(failure("Too many requests", { status: 429 })).transient).toBe(true);
	});

	test("a status-less network failure is transient", () => {
		for (const text of ["fetch failed", "socket hang up", "terminated", "something odd"]) {
			const verdict = isTransientFailure(failure(text));
			expect(verdict.transient).toBe(true);
			expect(verdict.status).toBeUndefined();
		}
		expect(isTransientFailure("plain string failure").transient).toBe(true);
		expect(isTransientFailure(undefined).transient).toBe(true);
	});

	test("a status-less clearly permanent failure is permanent", () => {
		for (const text of [
			"subscription required",
			"Invalid API key",
			"permission denied",
			"Access denied",
			"blocked by content policy",
			"credit balance is too low",
			"You are not entitled to this model",
			"Unauthorised",
			"forbidden",
		]) {
			expect(isTransientFailure(failure(text)).transient).toBe(false);
		}
	});

	test("an AbortError is never transient, whatever its text says", () => {
		const error = Object.assign(new Error("fetch failed"), { name: "AbortError" });
		expect(isTransientFailure(error).transient).toBe(false);
		expect(isTransientFailure(Object.assign(error, { status: 503 })).transient).toBe(false);
	});

	test("reads the status from status, statusCode, errorStatus and response.status", () => {
		expect(isTransientFailure({ status: 503 }).status).toBe(503);
		expect(isTransientFailure({ statusCode: 502 }).status).toBe(502);
		expect(isTransientFailure({ errorStatus: 429 }).status).toBe(429);
		expect(isTransientFailure({ response: { status: 401 } }).status).toBe(401);
		expect(isTransientFailure({ status: "x", statusCode: 500 }).status).toBe(500);
		expect(isTransientFailure({ status: Number.NaN, response: { status: 404 } }).status).toBe(404);
	});

	test("reads the hint from retryAfterMs, retryAfter and retry-after on plain or Headers", () => {
		expect(isTransientFailure({ status: 429, retryAfterMs: 4500 }).retryAfterMs).toBe(4500);
		expect(isTransientFailure({ status: 429, retryAfter: "7" }, NOW).retryAfterMs).toBe(7000);
		expect(isTransientFailure({ status: 429, retryAfter: 3 }, NOW).retryAfterMs).toBe(3000);
		expect(
			isTransientFailure({ status: 429, headers: { "Retry-After": "7" } }, NOW).retryAfterMs,
		).toBe(7000);
		expect(
			isTransientFailure({ status: 429, headers: new Headers({ "retry-after": "7" }) }, NOW)
				.retryAfterMs,
		).toBe(7000);
		expect(
			isTransientFailure({ response: { status: 429, headers: { "retry-after": "2" } } }, NOW)
				.retryAfterMs,
		).toBe(2000);
		expect(
			isTransientFailure(
				{ response: { status: 429, headers: new Headers({ "retry-after": "9" }) } },
				NOW,
			).retryAfterMs,
		).toBe(9000);
		expect(
			isTransientFailure({ status: 429, headers: { "retry-after": "soon" } }).retryAfterMs,
		).toBeUndefined();
	});

	test("clamps a numeric hint and ignores a negative or non-finite one", () => {
		expect(isTransientFailure({ status: 429, retryAfterMs: 9_999_999 }).retryAfterMs).toBe(
			RETRY_AFTER_CAP_MS,
		);
		expect(isTransientFailure({ status: 429, retryAfterMs: -1 }).retryAfterMs).toBeUndefined();
		expect(
			isTransientFailure({ status: 429, retryAfterMs: Number.NaN }).retryAfterMs,
		).toBeUndefined();
	});
});

/** A fake clock: `sleep` advances it, so a wait is observable without real time. */
function fakeSeams(random = 0.5) {
	const clock = { now: 0 };
	const sleeps: number[] = [];
	const seams: Required<Pick<RetrySeams, "sleep" | "random" | "now">> = {
		sleep: async (ms) => {
			sleeps.push(ms);
			clock.now += ms;
		},
		random: () => random,
		now: () => clock.now,
	};
	return { clock, sleeps, seams };
}

const POLICY = { maxAttempts: 3, baseMs: 1000, capMs: 30_000 };

describe("withRetry", () => {
	test("503, then 429 with Retry-After 7, then 200: three attempts and at least 7 s waited before the third", async () => {
		const { clock, sleeps, seams } = fakeSeams();
		const script = [
			failure("overloaded", { status: 503 }),
			failure("slow down", { status: 429, headers: { "retry-after": "7" } }),
		];
		const startedAt: number[] = [];
		const retries: { attempt: number; delayMs: number; reason: string }[] = [];
		const result = await withRetry(
			async (attempt) => {
				startedAt.push(clock.now);
				const next = script[attempt - 1];
				if (next) throw next;
				return "ok";
			},
			POLICY,
			{ ...seams, onRetry: (info) => retries.push(info) },
		);
		expect(result).toEqual({ value: "ok", attempts: 3 });
		expect(startedAt).toHaveLength(3);
		// First retry: jitter 0.5 * min(30000, 1000 * 2^0) = 500. Second: the 7000 hint wins over 0.5 * 2000.
		expect(sleeps).toEqual([500, 7000]);
		expect((startedAt[2] ?? 0) - (startedAt[1] ?? 0)).toBeGreaterThanOrEqual(7000);
		expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
		expect(retries.map((r) => r.delayMs)).toEqual([500, 7000]);
		expect(retries.every((r) => r.reason.length > 0)).toBe(true);
	});

	test("full jitter: the delay is random() times the capped exponential window", async () => {
		const { sleeps, seams } = fakeSeams(1);
		const run = withRetry(
			async () => {
				throw failure("down", { status: 503 });
			},
			{ maxAttempts: 5, baseMs: 1000, capMs: 3000 },
			seams,
		);
		await expect(run).rejects.toBeInstanceOf(RetryExhaustedError);
		expect(sleeps).toEqual([1000, 2000, 3000, 3000]);
	});

	test("a clamped hint above the policy cap still wins (never below the server's ask)", async () => {
		const { sleeps, seams } = fakeSeams(0);
		await withRetry(
			async (attempt) => {
				if (attempt === 1) throw failure("slow", { status: 429, retryAfterMs: 9_999_999 });
				return 1;
			},
			POLICY,
			seams,
		);
		expect(sleeps).toEqual([RETRY_AFTER_CAP_MS]);
	});

	test("a 401 makes exactly one attempt and reports it", async () => {
		const { sleeps, seams } = fakeSeams();
		let calls = 0;
		const run = withRetry(
			async () => {
				calls += 1;
				throw failure("unauthorized", { status: 401 });
			},
			POLICY,
			seams,
		);
		const error = await run.catch((e: unknown) => e);
		expect(calls).toBe(1);
		expect(sleeps).toEqual([]);
		expect(error).toBeInstanceOf(RetryExhaustedError);
		expect((error as RetryExhaustedError).attempts).toBe(1);
		expect((error as RetryExhaustedError).message).toBe("unauthorized");
	});

	test("a status-less transient text is retried; status-less permanent text is not", async () => {
		const { seams } = fakeSeams();
		let calls = 0;
		const ok = await withRetry(
			async () => {
				calls += 1;
				if (calls === 1) throw failure("fetch failed");
				return "fine";
			},
			POLICY,
			seams,
		);
		expect(ok).toEqual({ value: "fine", attempts: 2 });
		let permanentCalls = 0;
		await withRetry(
			async () => {
				permanentCalls += 1;
				throw failure("subscription required");
			},
			POLICY,
			seams,
		).catch(() => undefined);
		expect(permanentCalls).toBe(1);
	});

	test("an abort before attempt 2 throws an AbortError without a second call", async () => {
		const { seams } = fakeSeams();
		const controller = new AbortController();
		let calls = 0;
		const run = withRetry(
			async () => {
				calls += 1;
				controller.abort();
				throw failure("overloaded", { status: 503 });
			},
			POLICY,
			{ ...seams, signal: controller.signal },
		);
		const error = await run.catch((e: unknown) => e);
		expect(isAbortError(error)).toBe(true);
		expect(calls).toBe(1);
	});

	test("an already-aborted signal never calls fn", async () => {
		const { seams } = fakeSeams();
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		const error = await withRetry(
			async () => {
				calls += 1;
				return 1;
			},
			POLICY,
			{ ...seams, signal: controller.signal },
		).catch((e: unknown) => e);
		expect(isAbortError(error)).toBe(true);
		expect(calls).toBe(0);
	});

	test("an AbortError thrown by fn is rethrown as is, never retried or wrapped", async () => {
		const { sleeps, seams } = fakeSeams();
		const cancelled = abortError();
		let calls = 0;
		const error = await withRetry(
			async () => {
				calls += 1;
				throw cancelled;
			},
			POLICY,
			seams,
		).catch((e: unknown) => e);
		expect(error).toBe(cancelled);
		expect(calls).toBe(1);
		expect(sleeps).toEqual([]);
	});

	test("an abort that lands during the backoff wait rejects with the AbortError from sleep", async () => {
		const controller = new AbortController();
		let calls = 0;
		const run = withRetry(
			async () => {
				calls += 1;
				throw failure("overloaded", { status: 503 });
			},
			POLICY,
			{
				signal: controller.signal,
				random: () => 0.5,
				sleep: async () => {
					controller.abort();
					throw abortError();
				},
			},
		);
		const error = await run.catch((e: unknown) => e);
		expect(isAbortError(error)).toBe(true);
		expect(calls).toBe(1);
	});

	test("hands the signal to the injected sleep", async () => {
		const controller = new AbortController();
		const seen: (AbortSignal | undefined)[] = [];
		await withRetry(
			async (attempt) => {
				if (attempt === 1) throw failure("down", { status: 503 });
				return 1;
			},
			POLICY,
			{
				signal: controller.signal,
				random: () => 0,
				sleep: async (_ms, signal) => {
					seen.push(signal);
				},
			},
		);
		expect(seen).toEqual([controller.signal]);
	});

	test("exhaustion throws the last error's message with attempts attached and the error as cause", async () => {
		const { seams } = fakeSeams();
		const errors = [1, 2, 3].map((n) => failure(`failure ${n}`, { status: 503 }));
		const run = withRetry(
			async (attempt) => {
				throw errors[attempt - 1];
			},
			POLICY,
			seams,
		);
		const error = await run.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RetryExhaustedError);
		const exhausted = error as RetryExhaustedError;
		expect(exhausted.attempts).toBe(3);
		expect(exhausted.cause).toBe(errors[2]);
		expect(exhausted.message).toBe("failure 3");
	});

	test("a custom classify decides what retries", async () => {
		const { seams } = fakeSeams();
		let calls = 0;
		const result = await withRetry(
			async () => {
				calls += 1;
				if (calls < 3) throw failure("weird");
				return "done";
			},
			POLICY,
			{ ...seams, classify: () => ({ transient: true, reason: "always" }) },
		);
		expect(result.attempts).toBe(3);
	});

	test("maxAttempts of 1 never retries", async () => {
		const { sleeps, seams } = fakeSeams();
		let calls = 0;
		await withRetry(
			async () => {
				calls += 1;
				throw failure("down", { status: 503 });
			},
			{ ...POLICY, maxAttempts: 1 },
			seams,
		).catch(() => undefined);
		expect(calls).toBe(1);
		expect(sleeps).toEqual([]);
	});
});

describe("RetryExhaustedError forwards the cause's duck-typed fields", () => {
	test("a wrapped 429 with a retry-after header still exposes status and classifies as transient", () => {
		const headers = { "retry-after": "7" };
		const cause = failure("slow down", { status: 429, code: "rate_limited", headers });
		const wrapper = new RetryExhaustedError(cause, 3);
		expect(wrapper.attempts).toBe(3);
		expect(wrapper.cause).toBe(cause);
		expect(wrapper.message).toBe("slow down");
		const view: Record<string, unknown> = { ...wrapper };
		expect(view.status).toBe(429);
		expect(view.code).toBe("rate_limited");
		expect(view.headers).toBe(headers);
		expect(isTransientFailure(wrapper, NOW)).toEqual({
			transient: true,
			status: 429,
			retryAfterMs: 7000,
			reason: "HTTP 429 is transient",
		});
	});

	test("forwards statusCode, errorStatus, retryAfterMs, retryAfter and response by reference", () => {
		const response = { status: 503, headers: new Headers({ "retry-after": "2" }) };
		const cause = failure("down", {
			statusCode: 503,
			errorStatus: 503,
			retryAfterMs: 1500,
			retryAfter: "2",
			response,
		});
		const wrapper = new RetryExhaustedError(cause, 2) as unknown as Record<string, unknown>;
		expect(wrapper.statusCode).toBe(503);
		expect(wrapper.errorStatus).toBe(503);
		expect(wrapper.retryAfterMs).toBe(1500);
		expect(wrapper.retryAfter).toBe("2");
		expect(wrapper.response).toBe(response);
	});

	test("a cause without those fields adds none", () => {
		const wrapper = new RetryExhaustedError(failure("plain"), 1);
		for (const key of [
			"status",
			"statusCode",
			"errorStatus",
			"code",
			"retryAfterMs",
			"retryAfter",
			"headers",
			"response",
		]) {
			expect(Object.hasOwn(wrapper, key)).toBe(false);
		}
		const text = new RetryExhaustedError("just text", 1);
		expect(text.message).toBe("just text");
		expect(Object.hasOwn(text, "status")).toBe(false);
	});

	test("unwrapRetryError returns the cause of a wrapper and anything else as is", () => {
		const cause = failure("inner", { status: 500 });
		expect(unwrapRetryError(new RetryExhaustedError(cause, 2))).toBe(cause);
		const other = failure("other");
		expect(unwrapRetryError(other)).toBe(other);
		expect(unwrapRetryError("text")).toBe("text");
		expect(unwrapRetryError(undefined)).toBeUndefined();
	});
});
