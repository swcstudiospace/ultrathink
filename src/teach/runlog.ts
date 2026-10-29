// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Run log of detached `teach observe` processes, whose stdio is ignored: one small JSON file per run under
 * `<stateDir>/teach/runs/` so a failure (for example a distiller that cannot authenticate) is visible to `doctor` and
 * to the user. Each run is its own atomically written file, so there is no read-modify-write and concurrent observers
 * cannot drop one another's records. File names sort chronologically; 50 runs are kept, the newest, except that runs skipped before the distiller was asked are dropped first (see `pruneVictims`). Holds no lesson
 * text. Never throws.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";
import { redactLine } from "./redact.ts";

const MAX_RUNS = 50;
const AT_DIGITS = 13;
const RUN_FILE = /^\d{13,}-[0-9a-f]{8}\.json$/;
const SKIPPED_CHARS = 80;
const DETAIL_CHARS = 160;
const LOCK_WAIT_MS = 5_000;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface ObserveRun {
	at: number; // epoch ms
	sessionId: string;
	outcome: "captured" | "skipped";
	captured: number;
	skipped?: string; // redactLine, at most 80 chars
	detail?: string; // redactLine, at most 160 chars
}

function runsDir(stateDir: string): string {
	return join(stateDir, "teach", "runs");
}

/** One printable line: the reason comes from a child process, so ESC, backspace and other controls must not reach a terminal. */
function displayable(text: string): string {
	return redactLine(text.replace(CONTROLS, " "), 80).replace(/\s+/g, " ").trim() || "unknown cause";
}

/** Skip reasons recorded before the distiller was asked: they say nothing about its health either way. */
const BEFORE_DISTILLER = new Set([
	"off",
	"capture mode is explicit",
	"child invocation",
	"too few tool calls",
	"no signal",
]);

/** A run skipped before the distiller was asked: it says nothing about the distiller's health. */
function isBeforeDistiller(run: ObserveRun): boolean {
	return run.outcome === "skipped" && BEFORE_DISTILLER.has(run.skipped ?? "");
}

/** Run file names, oldest first (the name starts with the zero-padded `at`). Throws when the directory cannot be listed. */
function listRunFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => RUN_FILE.test(name))
		.sort();
}

/**
 * The run files to drop so that at most 50 remain, never `keep` (the run just written). Runs skipped before the
 * distiller was asked go first, oldest first, then the oldest of the rest: a stream of skipped runs cannot push an
 * unresolved distiller failure out of the log and hide the warning `failureStreak` derives from it.
 */
function pruneVictims(dir: string, keep: string): string[] {
	const names = listRunFiles(dir).filter((name) => name !== keep);
	const excess = names.length + 1 - MAX_RUNS;
	if (excess <= 0) return [];
	const victims: string[] = [];
	for (const name of names) {
		if (victims.length === excess) break;
		try {
			const run = parseRun(JSON.parse(readFileSync(join(dir, name), "utf8")));
			if (run && isBeforeDistiller(run)) victims.push(name);
		} catch {
			// reason: an unreadable file is treated as a real run and kept
		}
	}
	for (const name of names) {
		if (victims.length === excess) break;
		if (!victims.includes(name)) victims.push(name);
	}
	return victims;
}

/** Writes one run as its own file, redacting and clipping `skipped` and `detail`, then keeps 50 runs (see `pruneVictims`). Never throws. */
export function appendRun(stateDir: string, run: ObserveRun): void {
	try {
		const dir = runsDir(stateDir);
		const entry: ObserveRun = {
			at: run.at,
			sessionId: run.sessionId,
			outcome: run.outcome,
			captured: run.captured,
			...(run.skipped ? { skipped: redactLine(run.skipped, SKIPPED_CHARS) } : {}),
			...(run.detail ? { detail: redactLine(run.detail, DETAIL_CHARS) } : {}),
		};
		const name = `${String(Math.max(0, Math.trunc(run.at))).padStart(AT_DIGITS, "0")}-${randomBytes(4).toString("hex")}.json`;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// Write and prune as one step: two observers that each listed the log before the other wrote would each protect
		// only their own file and drop the other's. A lock that cannot be taken runs unlocked.
		withFileLock(
			join(dir, ".append"),
			() => {
				writeFileAtomic(join(dir, name), `${JSON.stringify(entry)}\n`, {
					mode: 0o600,
					dirMode: 0o700,
				});
				try {
					for (const old of pruneVictims(dir, name)) {
						try {
							rmSync(join(dir, old), { force: true });
						} catch {
							// reason: an older run that cannot be removed is pruned by a later append
						}
					}
				} catch {
					// reason: pruning is best effort; the run is already written
				}
			},
			{ timeoutMs: LOCK_WAIT_MS },
		);
	} catch {
		// reason: fail-open: the run log is diagnostics only
	}
}

function parseRun(value: unknown): ObserveRun | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const o = value as Record<string, unknown>;
	if (typeof o.at !== "number" || !Number.isFinite(o.at)) return undefined;
	if (typeof o.sessionId !== "string") return undefined;
	if (o.outcome !== "captured" && o.outcome !== "skipped") return undefined;
	if (typeof o.captured !== "number" || !Number.isInteger(o.captured) || o.captured < 0)
		return undefined;
	return {
		at: o.at,
		sessionId: o.sessionId,
		outcome: o.outcome,
		captured: o.captured,
		...(typeof o.skipped === "string" ? { skipped: o.skipped } : {}),
		...(typeof o.detail === "string" ? { detail: o.detail } : {}),
	};
}

/** Parsed runs, oldest first, from the newest 50 files, skipping malformed ones. Empty when the directory is missing or unreadable. */
export function readRuns(stateDir: string): ObserveRun[] {
	const dir = runsDir(stateDir);
	let names: string[];
	try {
		names = listRunFiles(dir).slice(-MAX_RUNS);
	} catch {
		return [];
	}
	const runs: ObserveRun[] = [];
	for (const name of names) {
		try {
			const run = parseRun(JSON.parse(readFileSync(join(dir, name), "utf8")));
			if (run) runs.push(run);
		} catch {
			// reason: skip one unreadable or malformed run file
		}
	}
	return runs;
}

/** A skip reason that means the distiller (or the store behind it) could not do its work, as opposed to finding nothing teachable. */
export function isObserveFailure(skipped: string | undefined): boolean {
	return (
		skipped === "distiller failed" ||
		skipped === "lesson not saved" ||
		skipped === "error" ||
		(skipped?.startsWith("no engine") ?? false)
	);
}

export interface FailureStreak {
	/** Failed runs in the streak. When `truncated` it is a lower bound: the log keeps only the newest 50 runs. */
	count: number;
	truncated: boolean;
	/** Epoch ms of the oldest failure in the streak. */
	since: number;
	/** Redacted, control-free detail (or skip reason) of the newest failure, at most 80 chars. */
	reason: string;
}

/**
 * The failures ending a run list (oldest first), or undefined when the newest answering run was not a failure. Runs
 * skipped before the distiller was asked do not break a streak; a capture, a nothing-teachable skip or any other
 * outcome does.
 */
export function failureStreak(runs: readonly ObserveRun[]): FailureStreak | undefined {
	let count = 0;
	let since = 0;
	let reason: string | undefined;
	let broken = false;
	for (let i = runs.length - 1; i >= 0; i--) {
		const run = runs[i];
		if (!run) continue;
		if (isBeforeDistiller(run)) continue;
		if (run.outcome !== "skipped" || !isObserveFailure(run.skipped)) {
			broken = true;
			break;
		}
		count++;
		since = run.at;
		reason ??= run.detail ?? run.skipped ?? "unknown cause";
	}
	if (count === 0) return undefined;
	return {
		count,
		truncated: !broken && count >= MAX_RUNS,
		since,
		reason: displayable(reason ?? "unknown cause"),
	};
}

/** Whether the newest failure also deserves an activity receipt: the first of a streak, then every tenth. */
export function shouldNotifyFailure(streak: FailureStreak | undefined): boolean {
	return (
		streak !== undefined && (streak.count === 1 || (streak.count % 10 === 0 && !streak.truncated))
	);
}

/** `observe failing ×<n> since <minute> UTC (<reason>)`; `×50+` when the log cannot show the start. */
export function failureStreakText(streak: FailureStreak): string {
	const since = new Date(streak.since).toISOString().slice(0, 16).replace("T", " ");
	return `observe failing ×${streak.count}${streak.truncated ? "+" : ""} since ${since} UTC (${streak.reason})`;
}
