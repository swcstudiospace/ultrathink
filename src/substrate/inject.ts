// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one gate between a fetched Agent Substrate brief and the model context. The brief is assembled from what other
 * agents wrote, so before it is injected it loses its control characters (an ESC sequence can recolour, hide or rewrite
 * what a terminal or log viewer shows) and is capped at the handoff limit. Redaction is a separate step that runs first.
 */
import { HANDOFF_MAX_CHARS } from "../host/display-limits.ts";

/** The last line of a capped brief. */
export const BRIEF_TRUNCATED_MARKER = "[brief truncated]";

/** C0 (U+0000-U+001F) and C1 (U+0080-U+009F) control characters, except newline and tab. */
function isStrippedControl(code: number): boolean {
	if (code === 0x09 || code === 0x0a) return false;
	return code <= 0x1f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Strips C0 and C1 control characters except newline and tab, then caps the text at HANDOFF_MAX_CHARS. A capped text
 * ends with the line `[brief truncated]` and, marker included, is exactly that long at most. Markdown fences and
 * headings are left alone. Idempotent.
 */
export function sanitizeBrief(text: string): string {
	let clean = "";
	let runStart = 0;
	for (let i = 0; i < text.length; i++) {
		if (!isStrippedControl(text.charCodeAt(i))) continue;
		clean += text.slice(runStart, i);
		runStart = i + 1;
	}
	clean += text.slice(runStart);
	if (clean.length <= HANDOFF_MAX_CHARS) return clean;
	const marker = `\n${BRIEF_TRUNCATED_MARKER}`;
	let keep = HANDOFF_MAX_CHARS - marker.length;
	// Never end the kept text on half of a surrogate pair.
	const last = clean.charCodeAt(keep - 1);
	if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
	return `${clean.slice(0, keep)}${marker}`;
}
