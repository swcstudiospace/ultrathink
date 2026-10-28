// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { HANDOFF_MAX_CHARS } from "../host/display-limits.ts";
import { BRIEF_TRUNCATED_MARKER, sanitizeBrief } from "./inject.ts";

const MARKER_LINE = `\n${BRIEF_TRUNCATED_MARKER}`;

describe("sanitizeBrief: control characters", () => {
	test("strips every C0 and C1 control character except newline and tab", () => {
		for (let code = 0; code <= 0x9f; code++) {
			if (code > 0x1f && code < 0x80) continue;
			const ch = String.fromCharCode(code);
			const kept = code === 0x09 || code === 0x0a;
			expect(sanitizeBrief(`a${ch}b`)).toBe(kept ? `a${ch}b` : "ab");
		}
	});

	test("removes an ANSI escape's ESC byte and the BEL that ends an OSC title, leaving the printable rest", () => {
		expect(sanitizeBrief("\u001b]0;pwned\u0007- work\u001b[2J\n")).toBe("]0;pwned- work[2J\n");
	});

	test("carriage returns go: a lone CR cannot overwrite the line before it", () => {
		expect(sanitizeBrief("safe\rovert\r\nnext")).toBe("safeovert\nnext");
	});

	test("leaves printable text, markdown fences, headings, tabs, newlines and non-ASCII alone", () => {
		const text = "## Substrate brief\n\n```ts\n\tconst x = 1;\n```\n- 日本語 – “quoted” é 😀\n";
		expect(sanitizeBrief(text)).toBe(text);
	});

	test("an empty string stays empty", () => {
		expect(sanitizeBrief("")).toBe("");
	});
});

describe("sanitizeBrief: length cap", () => {
	test("text of exactly the handoff limit passes through untouched", () => {
		const text = "x".repeat(HANDOFF_MAX_CHARS);
		expect(sanitizeBrief(text)).toBe(text);
	});

	test("one character over the limit is cut, marked on a final line, and no longer than the limit", () => {
		const out = sanitizeBrief("x".repeat(HANDOFF_MAX_CHARS + 1));
		expect(out.length).toBe(HANDOFF_MAX_CHARS);
		expect(out.endsWith(MARKER_LINE)).toBe(true);
		expect(out.split("\n").at(-1)).toBe(BRIEF_TRUNCATED_MARKER);
		expect(out.slice(0, -MARKER_LINE.length)).toBe(
			"x".repeat(HANDOFF_MAX_CHARS - MARKER_LINE.length),
		);
	});

	test("a 100000-character brief is capped at the limit with the marker", () => {
		const out = sanitizeBrief("y".repeat(100_000));
		expect(out.length).toBe(HANDOFF_MAX_CHARS);
		expect(out.endsWith(MARKER_LINE)).toBe(true);
	});

	test("the cap counts the text left after stripping, not the raw length", () => {
		const text = `${"\u001b".repeat(500)}${"x".repeat(HANDOFF_MAX_CHARS)}`;
		expect(sanitizeBrief(text)).toBe("x".repeat(HANDOFF_MAX_CHARS));
	});

	test("a cut never leaves half of a surrogate pair", () => {
		const keep = HANDOFF_MAX_CHARS - MARKER_LINE.length;
		const text = `${"a".repeat(keep - 1)}😀${"b".repeat(200)}`;
		const out = sanitizeBrief(text);
		expect(out.slice(0, -MARKER_LINE.length)).toBe("a".repeat(keep - 1));
		expect(out.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
	});

	test("sanitising an already sanitised brief changes nothing", () => {
		const once = sanitizeBrief(`\u001b[31m${"z".repeat(50_000)}`);
		expect(sanitizeBrief(once)).toBe(once);
	});
});
