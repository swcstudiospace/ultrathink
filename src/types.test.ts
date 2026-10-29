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
});
