// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Size limits for model-controlled text. Every field a model can grow is capped here once, so a
 * single long answer cannot amplify into megabytes of the next prompt. Pure functions, no I/O.
 */

/** Character caps per model-controlled field. */
export const FIELD_CAPS = {
	title: 120,
	goal: 400,
	question: 600,
	thinking: 6000,
	conclusion: 3000,
	step: 400,
	predecessor: 1500,
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

// NUL and C0 controls except TAB, LF and CR, then a high surrogate with no low one after it, then
// a low surrogate with no high one before it. Well-formed pairs match none of the alternatives.
const XML_INVALID =
	/[\u0000-\u0008\u000b\u000c\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Remove characters XML 1.0 cannot carry: NUL, C0 controls except tab/LF/CR, lone surrogates. */
export function stripXmlInvalid(text: string): string {
	return text.replace(XML_INVALID, "");
}
