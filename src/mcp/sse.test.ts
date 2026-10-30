// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	getSecurityLogger,
	setSecurityLogger,
	type SecurityEvent,
	type SecurityEventLogger,
} from "../../services/ultrathink/security/events.ts";
import { createSseParser } from "./sse.ts";

const noop = (): void => {
	// reason: no events are needed; only the refusal under test is observed
};

/** Keeps each validation refusal the logger seam reports, and writes nothing. */
class RecordingLogger implements SecurityEventLogger {
	readonly validation: Partial<SecurityEvent>[] = [];
	log(): void {
		// reason: test double, no-op by design
	}
	logAuthFailure(): void {
		// reason: test double, no-op by design
	}
	logValidationFailure(details: Partial<SecurityEvent>): void {
		this.validation.push(details);
	}
	logRateLimitExceeded(): void {
		// reason: test double, no-op by design
	}
	logSuspiciousActivity(): void {
		// reason: test double, no-op by design
	}
}

/** Returns what `run` threw, so the class and message can be asserted separately. */
function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

describe("createSseParser refusals", () => {
	test("refuses a zero, fractional or NaN maxLineChars with RangeError and logs its code", () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			for (const value of [0, 1.5, Number.NaN]) {
				const error = thrownBy(() => createSseParser(noop, value));
				expect(error).toBeInstanceOf(RangeError);
				expect(error).toHaveProperty("message", "maxLineChars must be a positive integer");
			}
			expect(recorder.validation).toEqual([
				{
					source: "mcp_sse",
					resource: "sse",
					details: { field: "maxLineChars", code: "TOO_SMALL" },
				},
				{
					source: "mcp_sse",
					resource: "sse",
					details: { field: "maxLineChars", code: "NOT_INTEGER" },
				},
				{
					source: "mcp_sse",
					resource: "sse",
					details: { field: "maxLineChars", code: "TYPE_MISMATCH" },
				},
			]);
		} finally {
			setSecurityLogger(previous);
		}
	});

	test("an event that reaches the cap only at end() throws from end() and dispatches nothing", () => {
		const got: string[] = [];
		const parser = createSseParser((data) => got.push(data), 8);
		expect(() => parser.push("data:12345\n")).not.toThrow();
		expect(() => parser.push("data:678")).not.toThrow();
		expect(() => parser.end()).toThrow("SSE event too large");
		expect(got).toEqual([]);
	});

	test("an oversized event is logged as field event, code TOO_LARGE", () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			const parser = createSseParser(noop, 8);
			parser.push("data: 1234\n");
			expect(() => parser.push("data: 5678\n")).toThrow("SSE event too large");
			expect(recorder.validation).toEqual([
				{ source: "mcp_sse", resource: "sse", details: { field: "event", code: "TOO_LARGE" } },
			]);
		} finally {
			setSecurityLogger(previous);
		}
	});
});
