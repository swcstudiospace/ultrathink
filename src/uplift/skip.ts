// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Why the last prompt was not planned. A skip is a decision the user cannot see, so every host entry records its reason
 * here (a tiny state-directory file `ultrathink status` reads), and the two skips a user can be surprised by get a one
 * line status note. Fail-open and bounded: nothing here ever throws or grows.
 */
import { join } from "node:path";
import { updateJsonAtomic } from "../claude/atomic.ts";
import { readJson } from "../shared.ts";

const FILE = "last-skip.json";
const MAX_REASON_CHARS = 64;

interface LastSkip {
	reason: string;
	at: number;
}

/** A reason code made of plain characters only: it is printed in the status text and the hook log. */
function cleanReason(reason: string): string {
	return reason.replace(/[^A-Za-z0-9:._ ()-]/g, "").slice(0, MAX_REASON_CHARS);
}

/** Records the last skip (one record, overwritten); a state directory that cannot be written is ignored. */
export function recordLastSkip(
	stateDir: string,
	reason: string,
	now: () => number = Date.now,
): void {
	const clean = cleanReason(reason);
	if (!clean) return;
	try {
		const record: LastSkip = { reason: clean, at: now() };
		updateJsonAtomic(join(stateDir, FILE), () => record);
	} catch {
		// reason: fail-open: a skip record is a diagnostic, never a reason to fail a prompt
	}
}

function readLastSkip(stateDir: string): LastSkip | undefined {
	const raw = readJson(join(stateDir, FILE));
	if (typeof raw !== "object" || raw === null) return undefined;
	const reason = "reason" in raw && typeof raw.reason === "string" ? cleanReason(raw.reason) : "";
	const at =
		"at" in raw && typeof raw.at === "number" && Number.isFinite(raw.at) ? raw.at : undefined;
	return reason && at !== undefined ? { reason, at } : undefined;
}

function age(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86_400)}d ago`;
}

/** `last skip: <reason> <age>` for `ultrathink status`; undefined when nothing was skipped or the record is unreadable. */
export function lastSkipLine(stateDir: string, now: () => number = Date.now): string | undefined {
	const last = readLastSkip(stateDir);
	return last ? `last skip: ${last.reason} ${age(now() - last.at)}` : undefined;
}

const NOTICES: Record<string, string> = {
	"graph-reference":
		"Prompt Uplift skipped · this prompt carries out an existing graph (graph-reference), so it is not planned again; start it with `uplift:` to plan it anyway.",
	"already-uplifted":
		"Prompt Uplift skipped · this prompt is already an uplifted spec (already-uplifted); start it with `uplift:` to redo the uplift.",
};

/** The one-line status note of a skip a user can be surprised by; undefined for the routine ones (they stay quiet). */
export function skipNotice(reason: string): string | undefined {
	return Object.hasOwn(NOTICES, reason) ? NOTICES[reason] : undefined;
}
