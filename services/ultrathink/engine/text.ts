// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUNS = /\s+/g;

/**
 * One line of untrusted text. Control characters and line terminators become spaces, runs of whitespace collapse to one
 * space, and the ends are trimmed. With `max`, a longer result is cut to at most `max` UTF-16 units (never leaving half
 * of a surrogate pair) and ends in an ellipsis.
 */
export function oneLine(value: string | undefined, max?: number): string {
	const flat = (value ?? "").replace(CONTROL_CHARS, " ").replace(WHITESPACE_RUNS, " ").trim();
	if (max === undefined || flat.length <= max) return flat;
	let end = Math.max(0, max - 1);
	const last = flat.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${flat.slice(0, end).trimEnd()}\u2026`;
}
