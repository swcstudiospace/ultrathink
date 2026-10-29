// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { abortError } from "../claude/complete.ts";
import { attachReport, readReport } from "../types.ts";
import { createFailoverCompleter, type FailoverCandidate } from "./chain.ts";
import { classifyFailure } from "./classify.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "Bearer abcdef0123456789abcdef";
const PLAN_LIMIT = "You've hit your session limit \u00b7 resets 3:45pm";

type Step = string | Error;

/** Candidate that plays `steps` in order (the last one repeats) and counts its calls. */
function scripted(
	id: string,
	steps: Step[],
): FailoverCandidate & { calls: () => number; seen: () => (AbortSignal | undefined)[] } {
	let calls = 0;
	const signals: (AbortSignal | undefined)[] = [];
	return {
		id,
		label: id,
		calls: () => calls,
		seen: () => signals,
		complete: async (_system, _user, signal) => {
			const step = steps[Math.min(calls, steps.length - 1)];
			calls += 1;
			signals.push(signal);
			if (step instanceof Error) throw step;
			return step ?? "";
		},
	};
}

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
	let t = start;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
	};
}

describe("single candidate", () => {
	test("rethrows the very same error object and records nothing", async () => {
		const boom = new Error(PLAN_LIMIT);
		const only = scripted("claude:claude-haiku-5-5", [boom]);
		const chain = createFailoverCompleter([only]);
		let caught: unknown;
		try {
			await chain.complete("s", "u");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(boom);
		expect(chain.attempts()).toEqual([]);
		expect(chain.failover()).toBeUndefined();
		// not in cooldown: the next call still reaches the candidate
		await expect(chain.complete("s", "u")).rejects.toBe(boom);
		expect(only.calls()).toBe(2);
	});

	test("passes the answer and the signal through untouched", async () => {
		const only = scripted("a", ["fine"]);
		const controller = new AbortController();
		const chain = createFailoverCompleter([only]);
		expect(await chain.complete("s", "u", controller.signal)).toBe("fine");
		expect(only.seen()[0]).toBe(controller.signal);
	});
});

describe("failover and cooldown", () => {
	test("plan-limit on the first moves to the second, which is skipped until the cooldown ends", async () => {
		const time = clock();
		const first = scripted("claude:claude-haiku-5-5", [new Error(PLAN_LIMIT), "from claude"]);
		const second = scripted("grok:grok-4.7", ["from grok"]);
		const chain = createFailoverCompleter([first, second], { now: time.now });

		expect(chain.failover()).toBeUndefined();
		expect(await chain.complete("s", "u")).toBe("from grok");
		expect(chain.failover()).toBe("claude:claude-haiku-5-5 \u2192 grok:grok-4.7 (plan-limit)");
		expect(first.calls()).toBe(1);

		// inside the 15 minute plan-limit cooldown the first is not called
		time.advance(899_999);
		expect(await chain.complete("s", "u")).toBe("from grok");
		expect(first.calls()).toBe(1);
		expect(second.calls()).toBe(2);

		// at the cooldown edge it is retried and answers again
		time.advance(1);
		expect(await chain.complete("s", "u")).toBe("from claude");
		expect(first.calls()).toBe(2);
		expect(second.calls()).toBe(2);
	});

	test("a retried first that fails again is put back into cooldown", async () => {
		const time = clock();
		const first = scripted("a", [new Error(PLAN_LIMIT)]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await chain.complete("s", "u");
		time.advance(900_000);
		await chain.complete("s", "u");
		expect(first.calls()).toBe(2);
		time.advance(899_999);
		await chain.complete("s", "u");
		expect(first.calls()).toBe(2);
	});

	test("cooldown length follows the failure class", async () => {
		const time = clock();
		const first = scripted("a", [new Error("fetch failed"), "back"]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await chain.complete("s", "u");
		expect(chain.failover()).toBe("a \u2192 b (network)");
		time.advance(29_999);
		await chain.complete("s", "u");
		expect(first.calls()).toBe(1);
		time.advance(1);
		expect(await chain.complete("s", "u")).toBe("back");
	});

	test("failover() stays set after the first candidate answers again", async () => {
		const time = clock();
		const first = scripted("a", [new Error("fetch failed"), "back"]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await chain.complete("s", "u");
		time.advance(30_000);
		expect(await chain.complete("s", "u")).toBe("back");
		expect(chain.failover()).toBe("a \u2192 b (network)");
	});

	test("a first candidate that answers never produces a failover", async () => {
		const first = scripted("a", ["ok"]);
		const second = scripted("b", ["nope"]);
		const chain = createFailoverCompleter([first, second]);
		expect(await chain.complete("s", "u")).toBe("ok");
		expect(second.calls()).toBe(0);
		expect(chain.failover()).toBeUndefined();
		expect(chain.attempts()).toEqual([]);
	});

	test("a model the plan cannot use fails over as model-unavailable", async () => {
		const missing = new Error(
			"There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.",
		);
		const first = scripted("claude:claude-nonexistent-9", [missing]);
		const second = scripted("grok:grok-4.7", ["from grok"]);
		const chain = createFailoverCompleter([first, second]);
		expect(await chain.complete("s", "u")).toBe("from grok");
		expect(chain.failover()?.endsWith("(model-unavailable)")).toBe(true);
		expect(chain.failover()).toBe(
			"claude:claude-nonexistent-9 \u2192 grok:grok-4.7 (model-unavailable)",
		);
	});

	test("a later fallback takes over when the second also fails", async () => {
		const first = scripted("a", [new Error("Credit balance is too low")]);
		const second = scripted("b", [new Error("Request rejected (429)")]);
		const third = scripted("c", ["third"]);
		const chain = createFailoverCompleter([first, second, third]);
		expect(await chain.complete("s", "u")).toBe("third");
		expect(chain.failover()).toBe("a \u2192 c (billing)");
		expect(chain.attempts().map((a) => [a.candidate, a.failure])).toEqual([
			["a", "billing"],
			["b", "rate-limit"],
		]);
	});
});

describe("errors that must not fail over", () => {
	for (const [label, message, failure] of [
		["other", "claude output is not JSON", "other"],
	] as const) {
		test(`${label} rethrows at once without calling the second`, async () => {
			const time = clock();
			const boom = new Error(message);
			const first = scripted("a", [boom]);
			const second = scripted("b", ["ok"]);
			const chain = createFailoverCompleter([first, second], { now: time.now });
			await expect(chain.complete("s", "u")).rejects.toBe(boom);
			expect(second.calls()).toBe(0);
			expect(chain.attempts()).toEqual([{ candidate: "a", failure, message }]);
			expect(chain.failover()).toBeUndefined();
			// no cooldown was set: the first is called again immediately
			await expect(chain.complete("s", "u")).rejects.toBe(boom);
			expect(first.calls()).toBe(2);
			expect(second.calls()).toBe(0);
		});
	}
});

describe("all candidates fail", () => {
	test("one error lists both labels, cause is the first error", async () => {
		const e1 = new Error(PLAN_LIMIT);
		const e2 = new Error("grok HTTP 503: upstream");
		const chain = createFailoverCompleter([
			scripted("a", [e1]),
			scripted("b", [Object.assign(e2, { name: "GrokHttpError", status: 503 })]),
		]);
		let caught: unknown;
		try {
			await chain.complete("s", "u");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		const error = caught as Error;
		expect(error).not.toBe(e1);
		expect(error).not.toBe(e2);
		expect(error.message).toBe(`a: ${PLAN_LIMIT}; b: grok HTTP 503: upstream`);
		expect(error.cause).toBe(e1);
		expect(error.name).toBe("FailoverError");
		expect((error as Error & { failure?: string }).failure).toBe("plan-limit");
		expect(chain.failover()).toBeUndefined();
	});

	test("the combined error carries the last candidate's completion report, or one attempt per candidate when none reported", async () => {
		const first = Object.assign(new Error(PLAN_LIMIT), {});
		attachReport(first, { attempts: 1 });
		const last = Object.assign(new Error("grok HTTP 429: {}"), {
			name: "GrokHttpError",
			status: 429,
		});
		attachReport(last, { attempts: 3, httpStatus: 429 });
		const reported = await createFailoverCompleter([scripted("a", [first]), scripted("b", [last])])
			.complete("s", "u")
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(readReport(reported)).toEqual({ attempts: 3, httpStatus: 429 });
		const bare = await createFailoverCompleter([
			scripted("a", [new Error(PLAN_LIMIT)]),
			scripted("b", [Object.assign(new Error("grok HTTP 503"), { status: 503 })]),
		])
			.complete("s", "u")
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		expect(readReport(bare)).toEqual({ attempts: 2 });
	});

	test("the error thrown while every candidate is cooling also carries a report, so a caller never retries it", async () => {
		const time = clock();
		const chain = createFailoverCompleter(
			[scripted("a", [new Error(PLAN_LIMIT)]), scripted("b", [new Error(PLAN_LIMIT)])],
			{ now: time.now },
		);
		await chain.complete("s", "u").catch(() => undefined);
		const cooling = await chain.complete("s", "u").then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(readReport(cooling)).toBeDefined();
	});

	test("the combined error reports the class of the first failure", async () => {
		const chain = createFailoverCompleter([
			scripted("a", [new Error("Not logged in \u00b7 Please run /login")]),
			scripted("b", [
				Object.assign(new Error("grok HTTP 429: {}"), { name: "GrokHttpError", status: 429 }),
			]),
		]);
		const error = await chain.complete("s", "u").then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(classifyFailure(error)).toBe("auth");
		expect(chain.attempts().map((a) => a.failure)).toEqual(["auth", "rate-limit"]);
	});

	test("message is redacted and at most 500 characters", async () => {
		const long = `fetch failed ${TOKEN} ${"x".repeat(400)}`;
		const chain = createFailoverCompleter(
			["a", "b", "c", "d"].map((id) => scripted(id, [new Error(long)])),
		);
		const error = await chain.complete("s", "u").then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(error?.message.length).toBe(500);
		expect(error?.message).not.toContain("abcdef0123456789abcdef");
		expect(error?.message.startsWith("a: ")).toBe(true);
	});

	test("with every candidate in cooldown nothing is invoked until a window lapses", async () => {
		const time = clock();
		const first = scripted("a", [new Error(PLAN_LIMIT)]);
		const second = scripted("b", [new Error("Request rejected (429)")]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await expect(chain.complete("s", "u")).rejects.toThrow("a: ");
		expect([first.calls(), second.calls()]).toEqual([1, 1]);
		await expect(chain.complete("s", "u")).rejects.toThrow("a: ");
		expect([first.calls(), second.calls()]).toEqual([1, 1]);
	});

	test("a recovered candidate is found once its cooldown lapsed", async () => {
		const time = clock();
		const first = scripted("a", [new Error(PLAN_LIMIT), new Error(PLAN_LIMIT), "back"]);
		const second = scripted("b", [new Error("Request rejected (429)"), "back-b"]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await expect(chain.complete("s", "u")).rejects.toThrow();
		time.advance(60_000);
		expect(await chain.complete("s", "u")).toBe("back-b");
		expect(chain.failover()).toBe("a \u2192 b (plan-limit)");
	});
});

describe("fail-fast and single probe", () => {
	test("while every candidate cools, ten calls invoke nothing and reject with the remembered error", async () => {
		const time = clock();
		const first = scripted("a", [new Error("Credit balance is too low")]);
		const second = scripted("b", [new Error("Not logged in \u00b7 Please run /login")]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		const remembered = await chain.complete("s", "u").then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(remembered).toBeInstanceOf(Error);
		for (let i = 0; i < 10; i++) {
			time.advance(1_000);
			await expect(chain.complete("s", "u")).rejects.toBe(remembered);
		}
		expect([first.calls(), second.calls()]).toEqual([1, 1]);
	});

	test("after the earliest window lapses exactly one candidate is probed, once per window", async () => {
		const time = clock();
		const first = scripted("a", [new Error("Credit balance is too low")]);
		const second = scripted("b", [new Error("Not logged in \u00b7 Please run /login")]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await expect(chain.complete("s", "u")).rejects.toThrow();
		// b (auth, 10 min) expires first; a (billing, 1 h) is still cooling
		time.advance(600_000);
		await expect(chain.complete("s", "u")).rejects.toThrow("b: ");
		expect([first.calls(), second.calls()]).toEqual([1, 2]);
		// the probe failed: a fresh window, no further call inside it
		for (let i = 0; i < 5; i++) await expect(chain.complete("s", "u")).rejects.toThrow("b: ");
		expect([first.calls(), second.calls()]).toEqual([1, 2]);
	});

	test("when both windows lapsed together only one candidate is walked per call", async () => {
		const time = clock();
		const first = scripted("a", [new Error("Not logged in \u00b7 Please run /login")]);
		const second = scripted("b", [new Error("Not logged in \u00b7 Please run /login")]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await expect(chain.complete("s", "u")).rejects.toThrow();
		time.advance(600_000);
		await expect(chain.complete("s", "u")).rejects.toThrow();
		expect(first.calls() + second.calls()).toBe(3);
	});

	test("a probe that answers clears the remembered error and the chain recovers", async () => {
		const time = clock();
		const first = scripted("a", [new Error(PLAN_LIMIT), "back"]);
		const second = scripted("b", [new Error("Request rejected (429)"), "back-b"]);
		const chain = createFailoverCompleter([first, second], { now: time.now });
		await expect(chain.complete("s", "u")).rejects.toThrow();
		time.advance(60_000);
		expect(await chain.complete("s", "u")).toBe("back-b");
		// b is healthy again, so a call is no longer fail-fast even though a still cools
		expect(await chain.complete("s", "u")).toBe("back-b");
		time.advance(900_000);
		expect(await chain.complete("s", "u")).toBe("back");
	});
});

describe("persisted cooldowns", () => {
	function persistPath(): string {
		const dir = mkdtempSync(join(tmpdir(), "failover-persist-"));
		dirs.push(dir);
		return join(dir, "state", "failover-cooldowns.json");
	}

	test("a second chain over the same file sees the cooldown and invokes nothing", async () => {
		const time = clock();
		const path = persistPath();
		const first = scripted("a", [new Error("Credit balance is too low")]);
		const second = scripted("b", [new Error("Not logged in \u00b7 Please run /login")]);
		const chain = createFailoverCompleter([first, second], { now: time.now, persist: { path } });
		await expect(chain.complete("s", "u")).rejects.toThrow();
		const nextFirst = scripted("a", ["ok-a"]);
		const nextSecond = scripted("b", ["ok-b"]);
		const next = createFailoverCompleter([nextFirst, nextSecond], {
			now: time.now,
			persist: { path },
		});
		const error = await next.complete("s", "u").then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(error?.name).toBe("FailoverError");
		expect(classifyFailure(error)).toBe("billing");
		expect([nextFirst.calls(), nextSecond.calls()]).toEqual([0, 0]);
	});

	test("a persisted cooldown on the first sends the next process straight to the second", async () => {
		const time = clock();
		const path = persistPath();
		const chain = createFailoverCompleter(
			[scripted("a", [new Error(PLAN_LIMIT)]), scripted("b", ["x"])],
			{
				now: time.now,
				persist: { path },
			},
		);
		await chain.complete("s", "u");
		const nextFirst = scripted("a", ["ok-a"]);
		const nextSecond = scripted("b", ["ok-b"]);
		const next = createFailoverCompleter([nextFirst, nextSecond], {
			now: time.now,
			persist: { path },
		});
		expect(await next.complete("s", "u")).toBe("ok-b");
		expect(nextFirst.calls()).toBe(0);
		time.advance(900_000);
		expect(await next.complete("s", "u")).toBe("ok-a");
	});

	test("expired, malformed or unreadable files load as empty", async () => {
		const time = clock();
		const path = persistPath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ until: { a: time.now() - 1 }, failure: { a: "billing" } }),
		);
		const first = scripted("a", ["ok-a"]);
		const chain = createFailoverCompleter([first, scripted("b", ["ok-b"])], {
			now: time.now,
			persist: { path },
		});
		expect(await chain.complete("s", "u")).toBe("ok-a");
		for (const junk of ["not json", "[]", '{"until":{"a":"x"},"failure":{"a":"bogus"}}']) {
			writeFileSync(path, junk);
			const fresh = scripted("a", ["ok-a"]);
			const again = createFailoverCompleter([fresh, scripted("b", ["ok-b"])], {
				now: time.now,
				persist: { path },
			});
			expect(await again.complete("s", "u")).toBe("ok-a");
		}
	});

	test("a path that cannot be written never breaks the call", async () => {
		const time = clock();
		const dir = mkdtempSync(join(tmpdir(), "failover-persist-"));
		dirs.push(dir);
		const blocker = join(dir, "file");
		writeFileSync(blocker, "x");
		const chain = createFailoverCompleter(
			[scripted("a", [new Error(PLAN_LIMIT)]), scripted("b", ["ok-b"])],
			{ now: time.now, persist: { path: join(blocker, "cooldowns.json") } },
		);
		expect(await chain.complete("s", "u")).toBe("ok-b");
	});

	test("a timeout fails over to the next candidate and the file records it", async () => {
		const time = clock();
		const path = persistPath();
		const first = scripted("a", [new Error("claude timed out after 90000ms")]);
		const second = scripted("b", ["ok-b"]);
		const chain = createFailoverCompleter([first, second], { now: time.now, persist: { path } });
		expect(await chain.complete("s", "u")).toBe("ok-b");
		expect(chain.failover()).toBe("a \u2192 b (timeout)");
		const saved = JSON.parse(readFileSync(path, "utf8")) as { until: Record<string, number> };
		expect(saved.until.a).toBe(time.now() + 30_000);
		time.advance(30_000);
		await chain.complete("s", "u");
		expect(first.calls()).toBe(2);
	});
});

describe("attempts()", () => {
	test("messages are redacted and clipped to 160 characters", async () => {
		const first = scripted("a", [new Error(`fetch failed ${TOKEN} ${"y".repeat(400)}`)]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second]);
		await chain.complete("s", "u");
		const [attempt] = chain.attempts();
		expect(attempt?.candidate).toBe("a");
		expect(attempt?.failure).toBe("network");
		expect(attempt?.message.length).toBeLessThanOrEqual(160);
		expect(attempt?.message.length).toBeGreaterThan(100);
		expect(attempt?.message).not.toContain("abcdef0123456789abcdef");
		expect(JSON.stringify(chain.attempts())).not.toContain("abcdef0123456789abcdef");
	});

	test("returns a snapshot, not the live list", async () => {
		const chain = createFailoverCompleter([
			scripted("a", [new Error("fetch failed")]),
			scripted("b", ["ok"]),
		]);
		await chain.complete("s", "u");
		const snapshot = chain.attempts();
		await chain.complete("s", "u");
		expect(snapshot).toHaveLength(1);
	});
});

describe("abort handling", () => {
	test("an already-aborted signal throws AbortError before any call", async () => {
		const first = scripted("a", ["ok"]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second]);
		const controller = new AbortController();
		controller.abort();
		const error = await chain.complete("s", "u", controller.signal).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(error?.name).toBe("AbortError");
		expect([first.calls(), second.calls()]).toEqual([0, 0]);
	});

	test("an abort mid-call rethrows without trying the next candidate or cooling down", async () => {
		const controller = new AbortController();
		const aborted = abortError();
		const first: FailoverCandidate = {
			id: "a",
			label: "a",
			complete: async () => {
				controller.abort();
				throw aborted;
			},
		};
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second]);
		await expect(chain.complete("s", "u", controller.signal)).rejects.toBe(aborted);
		expect(second.calls()).toBe(0);
		expect(chain.attempts()).toEqual([]);
		expect(chain.failover()).toBeUndefined();
	});

	test("a failover-worthy error raised because the caller aborted is not failed over", async () => {
		const controller = new AbortController();
		const boom = new Error("fetch failed");
		const first: FailoverCandidate = {
			id: "a",
			label: "a",
			complete: async () => {
				controller.abort();
				throw boom;
			},
		};
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second]);
		await expect(chain.complete("s", "u", controller.signal)).rejects.toBe(boom);
		expect(second.calls()).toBe(0);
	});

	test("an AbortError from the candidate itself is never classified as a failover", async () => {
		const aborted = Object.assign(new Error("claude timed out after 90000ms"), {
			name: "AbortError",
		});
		const first = scripted("a", [aborted]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second]);
		await expect(chain.complete("s", "u")).rejects.toBe(aborted);
		expect(second.calls()).toBe(0);
	});
});

describe("onFailover", () => {
	const SUMMARY = "a \u2192 b (plan-limit)";

	test("fires once per failing-over call, including while the first candidate is in cooldown", async () => {
		const time = clock();
		const seen: string[] = [];
		const first = scripted("a", [new Error(PLAN_LIMIT), "back"]);
		const second = scripted("b", ["ok"]);
		const chain = createFailoverCompleter([first, second], {
			now: time.now,
			onFailover: (summary) => seen.push(summary),
		});

		await chain.complete("s", "u");
		expect(seen).toEqual([SUMMARY]);

		// first is in cooldown, second answers: this call reports again
		time.advance(1_000);
		await chain.complete("s", "u");
		expect(first.calls()).toBe(1);
		expect(seen).toEqual([SUMMARY, SUMMARY]);

		// cooldown over, first answers again: no report, failover() stays cumulative
		time.advance(900_000);
		expect(await chain.complete("s", "u")).toBe("back");
		expect(seen).toHaveLength(2);
		expect(chain.failover()).toBe(SUMMARY);
	});

	test("does not fire when the first candidate answers", async () => {
		const seen: string[] = [];
		const chain = createFailoverCompleter([scripted("a", ["ok"]), scripted("b", ["nope"])], {
			onFailover: (summary) => seen.push(summary),
		});
		await chain.complete("s", "u");
		expect(seen).toEqual([]);
	});

	test("does not fire when every candidate fails", async () => {
		const seen: string[] = [];
		const chain = createFailoverCompleter(
			[
				scripted("a", [new Error(PLAN_LIMIT)]),
				scripted("b", [new Error("Request rejected (429)")]),
			],
			{ onFailover: (summary) => seen.push(summary) },
		);
		await expect(chain.complete("s", "u")).rejects.toThrow();
		expect(seen).toEqual([]);
		expect(chain.failover()).toBeUndefined();
	});

	test("does not fire for a single-candidate passthrough", async () => {
		const seen: string[] = [];
		const chain = createFailoverCompleter([scripted("a", ["ok"])], {
			onFailover: (summary) => seen.push(summary),
		});
		expect(await chain.complete("s", "u")).toBe("ok");
		expect(seen).toEqual([]);
	});

	test("a throwing callback does not change the returned text", async () => {
		const chain = createFailoverCompleter(
			[scripted("a", [new Error(PLAN_LIMIT)]), scripted("b", ["from b"])],
			{
				onFailover: () => {
					throw new Error("hook broke");
				},
			},
		);
		expect(await chain.complete("s", "u")).toBe("from b");
		expect(chain.failover()).toBe(SUMMARY);
	});

	test("two overlapping calls each receive their own summary exactly once", async () => {
		const answers: ((text: string) => void)[] = [];
		const bothReached = Promise.withResolvers<void>();
		const second: FailoverCandidate = {
			id: "b",
			label: "b",
			complete: () => {
				const gate = Promise.withResolvers<string>();
				answers.push(gate.resolve);
				if (answers.length === 2) bothReached.resolve();
				return gate.promise;
			},
		};
		let firstCalls = 0;
		const first: FailoverCandidate = {
			id: "a",
			label: "a",
			complete: async () => {
				firstCalls += 1;
				// call A (first to start) hits the plan limit, call B a network error
				throw new Error(firstCalls === 1 ? PLAN_LIMIT : "fetch failed");
			},
		};
		const seen: string[] = [];
		const chain = createFailoverCompleter([first, second], {
			onFailover: (summary) => seen.push(summary),
		});

		const callA = chain.complete("s", "A");
		const callB = chain.complete("s", "B");
		await bothReached.promise;
		expect(seen).toEqual([]);

		// settle B first, then A: neither wipes or replaces the other's summary
		answers[1]?.("answer B");
		expect(await callB).toBe("answer B");
		expect(seen).toEqual(["a \u2192 b (network)"]);
		answers[0]?.("answer A");
		expect(await callA).toBe("answer A");
		expect(seen).toEqual(["a \u2192 b (network)", "a \u2192 b (plan-limit)"]);
	});
});
