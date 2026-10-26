// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { currentRequestContext, type RequestContext, runWithRequestContext } from "./context.ts";

const OUTER: RequestContext = {
	reqId: "req-outer",
	traceId: "a".repeat(32),
	spanId: "b".repeat(16),
};
const INNER: RequestContext = {
	reqId: "req-inner",
	traceId: "c".repeat(32),
	spanId: "d".repeat(16),
};

describe("request context", () => {
	test("is undefined outside any run", () => {
		expect(currentRequestContext()).toBeUndefined();
	});

	test("is visible in a native I/O callback started inside the run", async () => {
		// The point is that AsyncLocalStorage follows a native callback. A file read's completion is that callback, so no
		// timer is needed and no duration is guessed.
		const seen = await runWithRequestContext(OUTER, () =>
			Bun.file(import.meta.path)
				.text()
				.then(() => currentRequestContext()),
		);
		expect(seen).toEqual(OUTER);
	});

	test("is visible in a promise continuation started inside the run", async () => {
		const seen = await runWithRequestContext(OUTER, async () => {
			await Promise.resolve();
			return currentRequestContext();
		});
		expect(seen).toEqual(OUTER);
	});

	test("carries into a job that outlives the run and is awaited outside it", async () => {
		const gate = Promise.withResolvers<void>();
		const job = runWithRequestContext(OUTER, async () => {
			await gate.promise;
			return currentRequestContext();
		});
		expect(currentRequestContext()).toBeUndefined();
		gate.resolve();
		expect(await job).toEqual(OUTER);
	});

	test("a nested run shadows the outer one and restores it afterwards", async () => {
		const trail = await runWithRequestContext(OUTER, async () => {
			const before = currentRequestContext();
			const inner = await runWithRequestContext(INNER, async () => {
				await Promise.resolve();
				return currentRequestContext();
			});
			return [before, inner, currentRequestContext()];
		});
		expect(trail).toEqual([OUTER, INNER, OUTER]);
		expect(currentRequestContext()).toBeUndefined();
	});
});
