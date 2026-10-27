// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Run log of detached `teach observe` processes, whose stdio is ignored: one small JSON file per run under
 * `<stateDir>/teach/runs/` so a failure (for example a distiller that cannot authenticate) is visible to `doctor` and
 * to the user. Each run is its own atomically written file, so there is no read-modify-write and concurrent observers
 * cannot drop one another's records. File names sort chronologically; only the newest 50 are kept. Holds no lesson
 * text. Never throws.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../claude/atomic.ts";
import { redactLine } from "./redact.ts";

const MAX_RUNS = 50;
const AT_DIGITS = 13;
const RUN_FILE = /^\d{13,}-[0-9a-f]{8}\.json$/;
const SKIPPED_CHARS = 80;
const DETAIL_CHARS = 160;

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

/** Run file names, oldest first (the name starts with the zero-padded `at`). Throws when the directory cannot be listed. */
function listRunFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => RUN_FILE.test(name))
		.sort();
}

/** Writes one run as its own file, redacting and clipping `skipped` and `detail`, then keeps the newest 50. Never throws. */
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
		writeFileAtomic(join(dir, name), `${JSON.stringify(entry)}\n`, { mode: 0o600, dirMode: 0o700 });
		try {
			for (const old of listRunFiles(dir).slice(0, -MAX_RUNS)) {
				try {
					rmSync(join(dir, old), { force: true });
				} catch {
					// reason: an older run that cannot be removed is pruned by a later append
				}
			}
		} catch {
			// reason: pruning is best effort; the run is already written
		}
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
