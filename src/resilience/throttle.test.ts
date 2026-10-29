// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { isAbortError } from "../shared.ts";
import { FlightThrottle } from "./throttle.ts";

/** A fake clock whose `sleep` advances it at once and honours the signal like the real one. */
function fakeClock(start = 0) {
	const clock = { now: start };
	const sleeps: number[] = [];
	const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
		if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
		sleeps.push(ms);
		clock.now += ms;
	};
	return { clock, sleeps, sleep, now: () => clock.now };
}

/** Lets every queued promise continuation run; no timer involved. */
async function flush(): Promise<void> {
	for (let i = 0; i < 25; i++) await Promise.resolve();
}

function noteSuccesses(throttle: FlightThrottle, count: number): void {
	for (let i = 0; i < count; i++) throttle.noteSuccess();
}

describe("FlightThrottle limit", () => {
	test("starts at max, halves on each failure and never drops below one", () => {
		const throttle = new FlightThrottle({ max: 8 });
		expect(throttle.limit).toBe(8);
		throttle.noteFailure();
		expect(throttle.limit).toBe(4);
		throttle.noteFailure();
		expect(throttle.limit).toBe(2);
		throttle.noteFailure();
		expect(throttle.limit).toBe(1);
		throttle.noteFailure();
		expect(throttle.limit).toBe(1);
	});

	test("three consecutive successes raise the limit by one, capped at max", () => {
		const throttle = new FlightThrottle({ max: 4 });
		throttle.noteFailure();
		throttle.noteFailure();
		expect(throttle.limit).toBe(1);
		noteSuccesses(throttle, 2);
		expect(throttle.limit).toBe(1);
		throttle.noteSuccess();
		expect(throttle.limit).toBe(2);
		noteSuccesses(throttle, 3);
		expect(throttle.limit).toBe(3);
		noteSuccesses(throttle, 30);
		expect(throttle.limit).toBe(4);
	});

	test("a failure resets the success streak", () => {
		const throttle = new FlightThrottle({ max: 4 });
		throttle.noteFailure();
		expect(throttle.limit).toBe(2);
		noteSuccesses(throttle, 2);
		throttle.noteFailure();
		expect(throttle.limit).toBe(1);
		noteSuccesses(throttle, 2);
		expect(throttle.limit).toBe(1);
		throttle.noteSuccess();
		expect(throttle.limit).toBe(2);
	});
});

describe("FlightThrottle acquire", () => {
	test("grants up to the limit, then queues until a release; release is idempotent", async () => {
		const throttle = new FlightThrottle({ max: 2 });
		const a = await throttle.acquire();
		const b = await throttle.acquire();
		let thirdGranted = false;
		const third = throttle.acquire().then((release) => {
			thirdGranted = true;
			return release;
		});
		await flush();
		expect(thirdGranted).toBe(false);
		a();
		a();
		a();
		await flush();
		expect(thirdGranted).toBe(true);
		// The triple release freed one slot only: a fourth caller still waits behind b and third.
		let fourthGranted = false;
		const fourth = throttle.acquire().then((release) => {
			fourthGranted = true;
			return release;
		});
		await flush();
		expect(fourthGranted).toBe(false);
		b();
		await flush();
		expect(fourthGranted).toBe(true);
		(await third)();
		(await fourth)();
	});

	test("a limit of one serializes callers in FIFO order", async () => {
		const throttle = new FlightThrottle({ max: 1 });
		const order: string[] = [];
		const first = await throttle.acquire();
		const waiters = ["b", "c", "d"].map((name) =>
			throttle.acquire().then((release) => {
				order.push(name);
				return release;
			}),
		);
		await flush();
		expect(order).toEqual([]);
		first();
		await flush();
		expect(order).toEqual(["b"]);
		(await waiters[0])?.();
		await flush();
		expect(order).toEqual(["b", "c"]);
		(await waiters[1])?.();
		await flush();
		expect(order).toEqual(["b", "c", "d"]);
		(await waiters[2])?.();
	});

	test("a lowered limit holds new callers back until enough slots are released", async () => {
		const throttle = new FlightThrottle({ max: 4 });
		const held = await Promise.all([1, 2, 3, 4].map(() => throttle.acquire()));
		throttle.noteFailure();
		expect(throttle.limit).toBe(2);
		let granted = false;
		const next = throttle.acquire().then((release) => {
			granted = true;
			return release;
		});
		held[0]?.();
		held[1]?.();
		await flush();
		expect(granted).toBe(false);
		held[2]?.();
		await flush();
		expect(granted).toBe(true);
		held[3]?.();
		(await next)();
	});

	test("a rising limit wakes a queued caller", async () => {
		const throttle = new FlightThrottle({ max: 2 });
		throttle.noteFailure();
		expect(throttle.limit).toBe(1);
		const first = await throttle.acquire();
		let granted = false;
		const second = throttle.acquire().then((release) => {
			granted = true;
			return release;
		});
		await flush();
		expect(granted).toBe(false);
		noteSuccesses(throttle, 3);
		await flush();
		expect(granted).toBe(true);
		first();
		(await second)();
	});

	test("a Retry-After cooldown holds acquire until the fake clock passes it", async () => {
		const { clock, sleeps, sleep, now } = fakeClock(1000);
		const throttle = new FlightThrottle({ max: 2, now, sleep });
		throttle.noteFailure({ retryAfterMs: 5000 });
		const release = await throttle.acquire();
		expect(clock.now).toBeGreaterThanOrEqual(6000);
		expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(5000);
		release();
		// The cooldown is over: the next caller does not wait again.
		const before = sleeps.length;
		(await throttle.acquire())();
		expect(sleeps.length).toBe(before);
	});

	test("a failure without a hint adds no cooldown", async () => {
		const { sleeps, sleep, now } = fakeClock();
		const throttle = new FlightThrottle({ max: 2, now, sleep });
		throttle.noteFailure();
		(await throttle.acquire())();
		expect(sleeps).toEqual([]);
	});

	test("a cooldown is shared: every queued caller waits behind it", async () => {
		const { clock, sleep, now } = fakeClock();
		const throttle = new FlightThrottle({ max: 4, now, sleep });
		throttle.noteFailure({ retryAfterMs: 2000 });
		const releases = await Promise.all([throttle.acquire(), throttle.acquire()]);
		expect(clock.now).toBeGreaterThanOrEqual(2000);
		for (const release of releases) release();
	});

	test("acquire rejects with an AbortError when the signal is already aborted", async () => {
		const throttle = new FlightThrottle({ max: 1 });
		const controller = new AbortController();
		controller.abort();
		const error = await throttle.acquire(controller.signal).catch((e: unknown) => e);
		expect(isAbortError(error)).toBe(true);
		// Nothing was taken: the single slot is still free.
		(await throttle.acquire())();
	});

	test("an abort while queued rejects that waiter only and leaves the slots intact", async () => {
		const throttle = new FlightThrottle({ max: 1 });
		const holder = await throttle.acquire();
		const controller = new AbortController();
		const aborted = throttle.acquire(controller.signal).catch((e: unknown) => e);
		let laterGranted = false;
		const later = throttle.acquire().then((release) => {
			laterGranted = true;
			return release;
		});
		await flush();
		controller.abort();
		expect(isAbortError(await aborted)).toBe(true);
		await flush();
		expect(laterGranted).toBe(false);
		holder();
		await flush();
		expect(laterGranted).toBe(true);
		(await later)();
		// Exactly one slot exists: after the release a fresh acquire is immediate.
		(await throttle.acquire())();
	});

	test("an abort during the cooldown wait rejects with an AbortError", async () => {
		const controller = new AbortController();
		const pendingSleep = (_ms: number, signal?: AbortSignal): Promise<void> => {
			const { promise, reject } = Promise.withResolvers<void>();
			signal?.addEventListener(
				"abort",
				() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
				{ once: true },
			);
			return promise;
		};
		const throttle = new FlightThrottle({ max: 1, now: () => 0, sleep: pendingSleep });
		throttle.noteFailure({ retryAfterMs: 60_000 });
		const waiting = throttle.acquire(controller.signal).catch((e: unknown) => e);
		await flush();
		controller.abort();
		expect(isAbortError(await waiting)).toBe(true);
	});
});
