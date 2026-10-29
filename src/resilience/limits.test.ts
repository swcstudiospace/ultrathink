// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { clip, clipHeadTail, FIELD_CAPS, stripXmlInvalid } from "./limits.ts";

const MARKER = "…[clipped]";

describe("FIELD_CAPS", () => {
	test("holds exactly the contract values", () => {
		expect({ ...FIELD_CAPS }).toEqual({
			title: 160,
			goal: 600,
			question: 3000,
			thinking: 8000,
			conclusion: 26000,
			step: 600,
			predecessor: 3000,
			predecessorHead: 1800,
			predecessorTail: 1000,
		});
	});

	test("the excerpt of a predecessor stays inside its own cap", () => {
		const { predecessor, predecessorHead, predecessorTail } = FIELD_CAPS;
		expect(predecessorHead + predecessorTail + "\n…[middle clipped]…\n".length).toBeLessThanOrEqual(
			predecessor,
		);
	});
});

describe("clipHeadTail", () => {
	const { predecessor, predecessorHead, predecessorTail } = FIELD_CAPS;

	test("leaves text at or under the cap untouched", () => {
		const text = "x".repeat(predecessor);
		expect(clipHeadTail(text, predecessor, predecessorHead, predecessorTail)).toEqual({
			text,
			clipped: false,
		});
	});

	test("keeps the first head and the last tail units with the marker between, inside the cap", () => {
		const text = `${"a".repeat(5000)}${"b".repeat(5000)}\nVerify: bun test`;
		const out = clipHeadTail(text, predecessor, predecessorHead, predecessorTail);
		expect(out.clipped).toBe(true);
		expect(out.text.length).toBeLessThanOrEqual(predecessor);
		expect(out.text.startsWith("a".repeat(predecessorHead))).toBe(true);
		expect(out.text.endsWith(text.slice(-predecessorTail))).toBe(true);
		expect(out.text.endsWith("Verify: bun test")).toBe(true);
		expect(out.text).toContain("…[middle clipped]…");
	});

	test("never splits a surrogate pair at either cut", () => {
		const text = "😀".repeat(3000);
		for (const [head, tail] of [
			[101, 99],
			[100, 101],
		] as const) {
			const out = clipHeadTail(text, 300, head, tail);
			expect(out.clipped).toBe(true);
			expect(stripXmlInvalid(out.text)).toBe(out.text);
		}
	});

	test("falls back to a plain head clip when head, tail and marker cannot fit the cap", () => {
		const out = clipHeadTail("x".repeat(500), 100, 80, 80);
		expect(out).toEqual(clip("x".repeat(500), 100));
	});
});

describe("clip", () => {
	test("leaves text at or under the cap untouched", () => {
		expect(clip("abc", 3)).toEqual({ text: "abc", clipped: false });
		expect(clip("", 0)).toEqual({ text: "", clipped: false });
		expect(clip("abc", 10)).toEqual({ text: "abc", clipped: false });
	});

	test("keeps the marker inside the cap when text is over it", () => {
		const out = clip("x".repeat(500), 100);
		expect(out.clipped).toBe(true);
		expect(out.text.endsWith(MARKER)).toBe(true);
		expect(out.text.length).toBe(100);
		expect(out.text).toBe(`${"x".repeat(100 - MARKER.length)}${MARKER}`);
	});

	test("a cap exactly one over the text still fits the marker", () => {
		const out = clip("abcdefghijklmnop", 15);
		expect(out.clipped).toBe(true);
		expect(out.text.length).toBeLessThanOrEqual(15);
		expect(out.text.endsWith(MARKER)).toBe(true);
	});

	test("a cap smaller than the marker truncates the marker itself", () => {
		const out = clip("abcdefghij", 3);
		expect(out.clipped).toBe(true);
		expect(out.text).toBe(MARKER.slice(0, 3));
		expect(clip("abcdefghijklmnop", MARKER.length).text).toBe(MARKER);
		expect(clip("abcdefghij", 0)).toEqual({ text: "", clipped: true });
	});

	test("honours a custom marker the same way", () => {
		expect(clip("abcdefghij", 6, "[..]")).toEqual({ text: "ab[..]", clipped: true });
		const tiny = clip("abcdefghij", 2, "[..]");
		expect(tiny).toEqual({ text: "[.", clipped: true });
	});

	test("never leaves a lone high surrogate before the marker", () => {
		// "😀" is a surrogate pair; the slice boundary lands between its halves.
		const text = `ab${"😀".repeat(20)}`;
		const max = 2 + MARKER.length + 1; // slice would end on the high surrogate of the first emoji
		const out = clip(text, max);
		expect(out.clipped).toBe(true);
		expect(out.text.length).toBeLessThanOrEqual(max);
		expect(out.text).toBe(`ab${MARKER}`);
		expect(stripXmlInvalid(out.text)).toBe(out.text);
	});
});

describe("stripXmlInvalid", () => {
	test("removes NUL and C0 controls but keeps tab, LF and CR", () => {
		let controls = "";
		for (let code = 0; code < 0x20; code++) controls += String.fromCharCode(code);
		expect(stripXmlInvalid(`a${controls}b`)).toBe("a\t\n\rb");
	});

	test("removes lone high and lone low surrogates", () => {
		expect(stripXmlInvalid("a\ud800b")).toBe("ab");
		expect(stripXmlInvalid("a\udc00b")).toBe("ab");
		expect(stripXmlInvalid("\ud83d")).toBe("");
		expect(stripXmlInvalid("\ud83d\ud83d\ude00")).toBe("😀");
		expect(stripXmlInvalid("\ude00\ud83d")).toBe("");
	});

	test("keeps well-formed surrogate pairs and wrapped emoji intact", () => {
		expect(stripXmlInvalid("😀")).toBe("😀");
		expect(stripXmlInvalid("\u0000a😀b\u0001")).toBe("a😀b");
		expect(stripXmlInvalid("é中文 — ok")).toBe("é中文 — ok");
	});

	test("returns clean text unchanged", () => {
		expect(stripXmlInvalid("plain text\nwith\ttabs\r\n")).toBe("plain text\nwith\ttabs\r\n");
		expect(stripXmlInvalid("")).toBe("");
	});
});
