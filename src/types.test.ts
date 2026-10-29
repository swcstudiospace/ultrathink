// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { attachReport, readReport } from "./types.ts";

describe("completion report seam", () => {
	test("a report round-trips through the error that carries it", () => {
		const error = new Error("boom");
		attachReport(error, {
			attempts: 3,
			httpStatus: 429,
			retryAfterMs: 7000,
			cause: "rate limited",
		});
		expect(readReport(error)).toEqual({
			attempts: 3,
			httpStatus: 429,
			retryAfterMs: 7000,
			cause: "rate limited",
		});
	});

	test("the report is invisible to enumeration and JSON", () => {
		const error = new Error("boom");
		attachReport(error, { attempts: 2 });
		expect(Object.keys(error)).toEqual([]);
		expect(JSON.stringify(error)).toBe("{}");
	});

	test("nothing attached, a primitive or a malformed value reads as undefined and never throws", () => {
		expect(readReport(new Error("plain"))).toBeUndefined();
		expect(readReport("text")).toBeUndefined();
		expect(readReport(null)).toBeUndefined();
		const error = new Error("bad");
		attachReport(error, { attempts: Number.NaN });
		expect(readReport(error)).toBeUndefined();
	});

	test("a frozen error cannot carry a report and attaching to it does not throw", () => {
		const error = Object.freeze(new Error("frozen"));
		expect(() => attachReport(error, { attempts: 1 })).not.toThrow();
		expect(readReport(error)).toBeUndefined();
		expect(() => attachReport("not an object", { attempts: 1 })).not.toThrow();
	});

	test("attaching again keeps the last report", () => {
		const error = new Error("boom");
		attachReport(error, { attempts: 1, cause: "first" });
		attachReport(error, { attempts: 4, httpStatus: 503 });
		expect(readReport(error)).toEqual({ attempts: 4, httpStatus: 503 });
	});

	test("a hostile getter reads as undefined and never throws", () => {
		const error = new Error("hostile");
		Object.defineProperty(error, Symbol.for("ultrathink.completionReport"), {
			get() {
				throw new Error("getter");
			},
		});
		expect(readReport(error)).toBeUndefined();
	});
});

describe("readReport across wrapped errors", () => {
	test("finds the report on a cause up to four levels down, nearest report first", () => {
		const root = new Error("root");
		attachReport(root, { attempts: 3, httpStatus: 429 });
		let outer: Error = root;
		for (let level = 0; level < 4; level++) outer = new Error(`wrap ${level}`, { cause: outer });
		expect(readReport(outer)).toEqual({ attempts: 3, httpStatus: 429 });
		const middle = new Error("middle", { cause: root });
		attachReport(middle, { attempts: 1 });
		expect(readReport(new Error("top", { cause: middle }))).toEqual({ attempts: 1 });
	});

	test("a report deeper than four levels, a cyclic cause or a hostile cause getter reads as undefined and never throws", () => {
		const root = new Error("root");
		attachReport(root, { attempts: 3 });
		let outer: Error = root;
		for (let level = 0; level < 5; level++) outer = new Error(`wrap ${level}`, { cause: outer });
		expect(readReport(outer)).toBeUndefined();
		const loop = new Error("loop");
		Object.defineProperty(loop, "cause", { value: loop });
		expect(readReport(loop)).toBeUndefined();
		const hostile = new Error("hostile");
		Object.defineProperty(hostile, "cause", {
			get() {
				throw new Error("getter");
			},
		});
		expect(readReport(hostile)).toBeUndefined();
	});
});
