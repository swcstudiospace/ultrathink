// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Size limits for model-controlled text. Every field a model can grow is capped here once, so a
 * single long answer cannot amplify into megabytes of the next prompt. Pure functions, no I/O.
 */

/**
 * Character caps per model-controlled field. Measured on 1,185 recorded plan nodes (167 sessions): title p99.9 93,
 * goal max 417, question p99.9 2,681 (max 3,052), thinking max 5,361, conclusion p99.9 25,152 (max 26,489; synthesize
 * is the long one, ending in the `Verify:` line). Each cap lets at least 99.9% of recorded values through untouched.
 * A node conclusion only reaches the next prompt as a `predecessor` excerpt, so the growth of one prompt stays bounded.
 */
export const FIELD_CAPS = {
	title: 160,
	goal: 600,
	question: 3000,
	thinking: 8000,
	conclusion: 26000,
	step: 600,
	/** A predecessor's conclusion in the next node's prompt: over this, the head and the tail are kept. */
	predecessor: 3000,
	predecessorHead: 1800,
	predecessorTail: 1000,
} as const;

const DEFAULT_MARKER = "…[clipped]";

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

/** Slice to at most `end` UTF-16 units without leaving half of a surrogate pair at the cut. */
function safeHead(text: string, end: number): string {
	if (end <= 0) return "";
	if (end >= text.length) return text;
	return isHighSurrogate(text.charCodeAt(end - 1)) ? text.slice(0, end - 1) : text.slice(0, end);
}

/**
 * Cap `text` at `max` UTF-16 units. Over the cap the result ends in `marker` and the marker counts
 * toward `max`; a cap smaller than the marker truncates the marker itself.
 */
export function clip(
	text: string,
	max: number,
	marker: string = DEFAULT_MARKER,
): { text: string; clipped: boolean } {
	if (text.length <= max) return { text, clipped: false };
	if (marker.length >= max) return { text: safeHead(marker, max), clipped: true };
	return { text: safeHead(text, max - marker.length) + marker, clipped: true };
}

const MIDDLE_MARKER = "\n…[middle clipped]…\n";

/** Slice the last `count` UTF-16 units without starting on the low half of a surrogate pair. */
function safeTail(text: string, count: number): string {
	if (count <= 0) return "";
	if (count >= text.length) return text;
	const start = text.length - count;
	const code = text.charCodeAt(start);
	return code >= 0xdc00 && code <= 0xdfff ? text.slice(start + 1) : text.slice(start);
}

/**
 * Cap `text` at `max` units keeping its start and its end: the first `head` and the last `tail` units around a
 * marker, so a closing line (`Verify:`, `Open questions:`) survives. At or under `max` the text is returned untouched.
 */
export function clipHeadTail(
	text: string,
	max: number,
	head: number,
	tail: number,
	marker: string = MIDDLE_MARKER,
): { text: string; clipped: boolean } {
	if (text.length <= max) return { text, clipped: false };
	if (head + tail + marker.length > max) return clip(text, max);
	return { text: safeHead(text, head) + marker + safeTail(text, tail), clipped: true };
}

// NUL and C0 controls except TAB, LF and CR, then a high surrogate with no low one after it, then
// a low surrogate with no high one before it. Well-formed pairs match none of the alternatives.
const XML_INVALID =
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Remove characters XML 1.0 cannot carry: NUL, C0 controls except tab/LF/CR, lone surrogates. */
export function stripXmlInvalid(text: string): string {
	return text.replace(XML_INVALID, "");
}
