// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Run log of detached `teach observe` processes, whose stdio is ignored: one NDJSON line per run so a failure
 * (for example a distiller that cannot authenticate) is visible to `doctor` and to the user. Holds no lesson text.
 * Never throws.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../claude/atomic.ts";
import { redactLine } from "./redact.ts";

const MAX_LINES = 50;
const FILE_NAME = "observe-runs.ndjson";
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

function runsPath(stateDir: string): string {
	return join(stateDir, "teach", FILE_NAME);
}

/** Appends one run, redacting and clipping `skipped` and `detail`. Keeps the newest 50 lines. Never throws. */
export function appendRun(stateDir: string, run: ObserveRun): void {
	try {
		const dir = join(stateDir, "teach");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			chmodSync(dir, 0o700);
		} catch {
			// reason: a directory we do not own keeps its mode
		}
		const path = runsPath(stateDir);
		const entry: ObserveRun = {
			at: run.at,
			sessionId: run.sessionId,
			outcome: run.outcome,
			captured: run.captured,
			...(run.skipped ? { skipped: redactLine(run.skipped, SKIPPED_CHARS) } : {}),
			...(run.detail ? { detail: redactLine(run.detail, DETAIL_CHARS) } : {}),
		};
		withFileLock(path, () => {
			let prior = "";
			try {
				prior = readFileSync(path, "utf8");
			} catch (error) {
				// reason: only a missing file means no prior runs; any other read error throws before the rename, so runs already on disk are kept
				if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
			}
			const lines = prior.split("\n").filter((line) => line !== "");
			lines.push(JSON.stringify(entry));
			const tail = lines.slice(-MAX_LINES);
			const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
			writeFileSync(tmp, `${tail.join("\n")}\n`, { mode: 0o600 });
			try {
				chmodSync(tmp, 0o600);
			} catch {
				// reason: mode was set at create
			}
			renameSync(tmp, path);
		});
		try {
			chmodSync(path, 0o600);
		} catch {
			// reason: the chmod only tightens a file the write just created; a failure leaves the mode the write set
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

/** Parsed runs, oldest first, skipping malformed lines. Empty when the file is missing or unreadable. */
export function readRuns(stateDir: string): ObserveRun[] {
	try {
		const text = readFileSync(runsPath(stateDir), "utf8");
		const runs: ObserveRun[] = [];
		for (const line of text.split("\n")) {
			if (line === "") continue;
			try {
				const run = parseRun(JSON.parse(line));
				if (run) runs.push(run);
			} catch {
				// reason: skip one bad line
			}
		}
		return runs;
	} catch {
		return [];
	}
}
