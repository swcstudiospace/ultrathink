// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Redaction for everything Teachable Moments stores or sends. A lesson is distilled from agent transcripts, so it can
 * carry API keys, auth headers, connection strings and absolute paths from the operator's home directory. `redactText`
 * runs before a moment is hashed, written to disk or retained in Hindsight, so none of those ever leaves the process.
 *
 * Idempotent (the replacement `[redacted]` matches no pattern) and never throws: a failure yields `[redacted]` rather
 * than the unredacted text.
 *
 * The secret patterns are the shared table in `src/redact.ts` (`redactSecretShapes`); this module adds only path masking.
 *
 * Paths: an absolute path under `options.home` that is not under `options.repoRoot` becomes `~/.../<last two segments>`
 * (`~/<segments>` when it has at most two, `~` for the home directory itself). A `repoRoot` that is the home directory
 * or one of its ancestors exempts nothing, so a session started in `~` still hides `~/.ssh/...`.
 */

import { redactSecretShapes } from "../redact.ts";

const REDACTED = "[redacted]";

export interface RedactOptions {
	/** Home directory whose absolute paths are hidden; default `process.env.HOME`. */
	home?: string;
	/** Paths under this directory stay readable (the project the lesson is about). */
	repoRoot?: string;
}

function redactPaths(text: string, home: string, repoRoot: string | undefined): string {
	const base = home.replace(/\/+$/, "");
	if (!base.startsWith("/") || base === "") return text;
	// An exemption that covers the whole home directory would keep `~/.ssh` readable.
	const keep = repoRoot?.replace(/\/+$/, "");
	const exempt =
		keep?.startsWith("/") && base !== keep && !base.startsWith(`${keep}/`) ? keep : undefined;
	const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(
		`(?<![\\w.~-])${escaped}(?:/[^\\s"'\`<>()\\[\\]{},;|\\\\]*)?(?![\\w-])`,
		"g",
	);
	return text.replace(pattern, (match) => {
		const trailing = /[.:]+$/.exec(match)?.[0] ?? "";
		const path = trailing ? match.slice(0, -trailing.length) : match;
		if (exempt && (path === exempt || path.startsWith(`${exempt}/`))) return match;
		const segments = path.slice(base.length).split("/").filter(Boolean);
		const shown = segments.length <= 2 ? segments.join("/") : `.../${segments.slice(-2).join("/")}`;
		return `${shown ? `~/${shown}` : "~"}${trailing}`;
	});
}

export function redactText(text: string, options: RedactOptions = {}): string {
	try {
		if (typeof text !== "string" || text === "") return "";
		let out = redactSecretShapes(text);
		const home = options.home ?? process.env.HOME;
		if (home) out = redactPaths(out, home, options.repoRoot);
		return out;
	} catch {
		return REDACTED;
	}
}

/** Redacted, whitespace collapsed to single spaces, at most `max` characters: for error text that ends up in a result, a log line or a file. */
export function redactLine(text: string, max = 200): string {
	return redactText(text).replace(/\s+/g, " ").trim().slice(0, max);
}
