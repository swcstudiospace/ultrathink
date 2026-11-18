// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { isAbortError, platformTimers } from "./shared.ts";

describe("isAbortError", () => {
	test("an Error named AbortError is an abort", () => {
		expect(isAbortError(Object.assign(new Error("Aborted"), { name: "AbortError" }))).toBe(true);
	});

	test("a DOMException named AbortError is an abort", () => {
		expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
	});

	test("a plain object named AbortError is an abort", () => {
		expect(isAbortError({ name: "AbortError", message: "cancelled" })).toBe(true);
	});

	test("a TimeoutError is not an abort, as an Error, a DOMException or a plain object", () => {
		expect(isAbortError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(
			false,
		);
		expect(isAbortError(new DOMException("timed out", "TimeoutError"))).toBe(false);
		expect(isAbortError({ name: "TimeoutError" })).toBe(false);
	});

	test("an ordinary Error and a nameless object are not aborts", () => {
		expect(isAbortError(new Error("AbortError"))).toBe(false);
		expect(isAbortError({ message: "AbortError" })).toBe(false);
	});

	test("null, undefined and primitives are not aborts", () => {
		expect(isAbortError(null)).toBe(false);
		expect(isAbortError(undefined)).toBe(false);
		expect(isAbortError("AbortError")).toBe(false);
		expect(isAbortError(0)).toBe(false);
	});
});

describe("platformTimers", () => {
	test("a cleared timeout never fires; a live one does", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		let fired = 0;
		const cancelled = platformTimers.setTimeout(() => {
			fired += 10;
		}, 1);
		platformTimers.clearTimeout(cancelled);
		platformTimers.setTimeout(() => {
			fired += 1;
			resolve();
		}, 1);
		await promise;
		expect(fired).toBe(1);
	});

	test("an interval repeats until it is cleared", async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		let ticks = 0;
		const handle = platformTimers.setInterval(() => {
			ticks += 1;
			if (ticks === 2) resolve();
		}, 1);
		await promise;
		platformTimers.clearInterval(handle);
		expect(ticks).toBe(2);
	});
});
