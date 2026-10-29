// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { isAbortError } from "../shared.ts";
import { abortableSleep } from "./sleep.ts";

interface FakeTimer {
	id: number;
	ms: number;
	fire: () => void;
	cleared: boolean;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timers: FakeTimer[] = [];

/** Replaces the global timer pair so no real timer ever runs; `fire` runs a callback by hand. */
function installFakeTimers(): void {
	timers = [];
	let next = 1;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		const timer: FakeTimer = { id: next++, ms: ms ?? 0, fire: fn, cleared: false };
		timers.push(timer);
		return timer.id;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		const timer = timers.find((t) => t.id === id);
		if (timer) timer.cleared = true;
	}) as unknown as typeof clearTimeout;
}

beforeEach(installFakeTimers);
afterEach(() => {
	globalThis.setTimeout = realSetTimeout;
	globalThis.clearTimeout = realClearTimeout;
});

describe("abortableSleep", () => {
	test("resolves once its timer fires and arms exactly the requested delay", async () => {
		const sleeping = abortableSleep(1500);
		expect(timers).toHaveLength(1);
		expect(timers[0]?.ms).toBe(1500);
		timers[0]?.fire();
		await expect(sleeping).resolves.toBeUndefined();
	});

	test("resolves normally with a live signal and removes its abort listener", async () => {
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		const sleeping = abortableSleep(50, controller.signal);
		timers[0]?.fire();
		await expect(sleeping).resolves.toBeUndefined();
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove.mock.calls[0]?.[0]).toBe("abort");
	});

	test("rejects at once with an AbortError when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await abortableSleep(1000, controller.signal).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("AbortError");
		expect(isAbortError(error)).toBe(true);
		expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
	});

	test("rejects the moment the signal aborts mid-wait and clears its timer and listener", async () => {
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		const clear = spyOn(globalThis, "clearTimeout");
		const sleeping = abortableSleep(60_000, controller.signal);
		const timer = timers[0];
		expect(timer?.cleared).toBe(false);
		controller.abort();
		const error = await sleeping.catch((e: unknown) => e);
		expect(isAbortError(error)).toBe(true);
		expect((error as Error).name).toBe("AbortError");
		expect(clear).toHaveBeenCalledWith(timer?.id);
		expect(timer?.cleared).toBe(true);
		expect(remove).toHaveBeenCalled();
	});

	test("a timer that fires after an abort is a no-op (settles once)", async () => {
		const controller = new AbortController();
		const sleeping = abortableSleep(100, controller.signal);
		controller.abort();
		await sleeping.catch(() => undefined);
		expect(() => timers[0]?.fire()).not.toThrow();
	});

	test("zero and negative delays arm a zero-delay timer and resolve", async () => {
		const zero = abortableSleep(0);
		const negative = abortableSleep(-25);
		expect(timers.map((t) => t.ms)).toEqual([0, 0]);
		for (const timer of timers) timer.fire();
		await expect(Promise.all([zero, negative])).resolves.toEqual([undefined, undefined]);
	});
});
