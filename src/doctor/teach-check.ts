// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The `memory` doctor section: is the Teachable Moments pipeline (observe, outbox, local lessons) working? Filesystem
 * reads only: no network, no child process, and nothing is created. The outbox is read directly (never through
 * `openStore`, which creates directories). Lesson text is never reported; a lesson file is read only for its two
 * timestamps, because its mtime is not the capture time: retain and recall rewrite the file.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultStateDir } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { readRuns } from "../teach/runlog.ts";
import { storeDir } from "../teach/store.ts";
import { type CaptureMode, TEACH_KILL_ENV } from "../teach/types.ts";
import { formatAge } from "./state-check.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const FAILURE_STREAK = 3;
const STALE_LESSON_MS = 3 * DAY_MS;
const ACTIVE_SESSION_MS = DAY_MS;
/** The store's own cap for one lesson file (`MOMENT_MAX_BYTES` in `teach/skills.ts`). */
const LESSON_MAX_BYTES = 64 * 1024;

interface OutboxItem {
	enqueuedAt: number;
	attempts: number;
	lastError?: string;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function jsonFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		// reason: a missing or unreadable directory means there is nothing to report.
		return [];
	}
}

function readOutbox(dir: string): OutboxItem[] {
	const items: OutboxItem[] = [];
	for (const name of jsonFiles(join(dir, "outbox"))) {
		try {
			const raw: unknown = JSON.parse(readFileSync(join(dir, "outbox", name), "utf8"));
			if (typeof raw !== "object" || raw === null) continue;
			const { enqueuedAt, attempts, lastError } = raw as Record<string, unknown>;
			if (typeof enqueuedAt !== "number" || !Number.isFinite(enqueuedAt)) continue;
			if (typeof attempts !== "number" || !Number.isFinite(attempts)) continue;
			const item: OutboxItem = { enqueuedAt, attempts };
			if (typeof lastError === "string") item.lastError = lastError;
			items.push(item);
		} catch {
			// reason: one unreadable or malformed entry must not hide the others.
		}
	}
	return items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

function outboxFinding(dir: string, now: number): Finding {
	const items = readOutbox(dir);
	const oldest = items[0];
	if (!oldest) {
		return {
			id: "memory.outbox",
			section: "memory",
			level: "ok",
			title: "Hindsight outbox is empty",
		};
	}
	const age = Math.max(0, now - oldest.enqueuedAt);
	if (age < DAY_MS) {
		return {
			id: "memory.outbox",
			section: "memory",
			level: "info",
			title: `${plural(items.length, "Hindsight write")} pending (oldest ${formatAge(age)})`,
		};
	}
	const neverTried = items.filter((item) => item.attempts === 0).length;
	const newestError = [...items].reverse().find((item) => item.lastError !== undefined)?.lastError;
	const lines = [`${neverTried} of them were never attempted.`];
	if (newestError !== undefined) lines.push(`Newest error: ${newestError}`);
	return {
		id: "memory.outbox",
		section: "memory",
		level: "warn",
		title: `${items.length} Hindsight writes have waited over 24 h (oldest ${formatAge(age)})`,
		detail: lines.join("\n"),
		fix: "bin/ultrathink teach sync",
	};
}

function isFailure(skipped: string | undefined): boolean {
	return (
		skipped === "distiller failed" ||
		skipped === "lesson not saved" ||
		skipped === "error" ||
		(skipped?.startsWith("no engine") ?? false)
	);
}

function observeFinding(stateDir: string, now: number): Finding {
	const runs = readRuns(stateDir);
	const newest = runs.at(-1);
	if (!newest) {
		return {
			id: "memory.observe",
			section: "memory",
			level: "info",
			title: "No teach observe runs recorded yet",
		};
	}
	const age = formatAge(Math.max(0, now - newest.at));
	const streak = runs.slice(-FAILURE_STREAK);
	if (
		streak.length === FAILURE_STREAK &&
		streak.every((run) => run.outcome === "skipped" && isFailure(run.skipped))
	) {
		return {
			id: "memory.observe",
			section: "memory",
			level: "error",
			title: `Teach observe failed ${FAILURE_STREAK} times in a row (last ${age} ago)`,
			detail: newest.detail ?? newest.skipped ?? "unknown cause",
			fix: "Fix the cause above (for example the claude CLI login or balance), then run a session and check bin/ultrathink doctor again",
		};
	}
	return {
		id: "memory.observe",
		section: "memory",
		level: "ok",
		title: `Last teach observe run: ${newest.outcome} ${age} ago`,
	};
}

/**
 * Epoch ms of the newest capture: a lesson's `lastSeenAt` (captured again) or its `createdAt`. Never the file mtime.
 * Like the store's own reader it skips a symlink and a file over 64 KiB: they count as lessons but give no age.
 */
function newestCapture(dir: string, names: readonly string[]): number {
	let newest = 0;
	for (const name of names) {
		try {
			const path = join(dir, "moments", name);
			const stat = lstatSync(path);
			if (!stat.isFile() || stat.size > LESSON_MAX_BYTES) continue;
			const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof raw !== "object" || raw === null) continue;
			const { lastSeenAt, createdAt } = raw as Record<string, unknown>;
			for (const stamp of [lastSeenAt, createdAt]) {
				const at = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
				if (Number.isFinite(at)) newest = Math.max(newest, at);
			}
		} catch {
			// reason: one unreadable lesson must not hide the others; it still counts as a file.
		}
	}
	return newest;
}

/** The newest write to a session record: proof that Ultrathink planned a run on this machine. 0 when there is none. */
function newestSession(stateDir: string): number {
	let newest = 0;
	for (const name of jsonFiles(join(stateDir, "sessions"))) {
		try {
			newest = Math.max(newest, statSync(join(stateDir, "sessions", name)).mtimeMs);
		} catch {
			// reason: a record removed between listing and stat is not activity.
		}
	}
	return newest;
}

function momentsFinding(
	stateDir: string,
	dir: string,
	now: number,
	capture: CaptureMode,
): Finding | undefined {
	const names = jsonFiles(join(dir, "moments"));
	if (names.length === 0 && !dirExists(join(dir, "moments"))) return undefined;
	const newest = newestCapture(dir, names);
	const idle = Math.max(0, now - newest);
	const title = `${plural(names.length, "local lesson")}${newest > 0 ? `, newest captured ${formatAge(idle)} ago` : ""}`;
	const session = newestSession(stateDir);
	const stalled =
		capture !== "explicit" &&
		newest > 0 &&
		idle > STALE_LESSON_MS &&
		now - session < ACTIVE_SESSION_MS;
	if (!stalled) return { id: "memory.moments", section: "memory", level: "info", title };
	return {
		id: "memory.moments",
		section: "memory",
		level: "warn",
		title: `${title}, yet a session ran ${formatAge(Math.max(0, now - session))} ago`,
		detail: [
			`Capture mode is "${capture}": a finished run should hand a digest to teach observe.`,
			"The digest is built inside the host process, so a host started before the plugin was updated keeps the old capture code.",
		].join("\n"),
		fix: "Check the observe line above, restart the host if the plugin changed since it started, finish a run, then run bin/ultrathink doctor again",
	};
}

const INBOX_NAME = /^[0-9]+-[0-9a-f]{8}\.json(\.tmp)?$/;
const STALE_DIGEST_MS = 60 * 60 * 1000;

function inboxFinding(stateDir: string, now: number): Finding | undefined {
	const inbox = join(stateDir, "teach", "inbox");
	let names: string[];
	try {
		names = readdirSync(inbox);
	} catch {
		// reason: a missing inbox means nothing is waiting; the doctor never creates it.
		return undefined;
	}
	let count = 0;
	let oldest: { path: string; mtime: number } | undefined;
	for (const name of names) {
		if (!INBOX_NAME.test(name)) continue;
		const path = join(inbox, name);
		try {
			const mtime = statSync(path).mtimeMs;
			if (now - mtime < STALE_DIGEST_MS) continue;
			count++;
			if (!oldest || mtime < oldest.mtime) oldest = { path, mtime };
		} catch {
			// reason: a digest consumed between listing and stat is no longer stale.
		}
	}
	if (!oldest) return undefined;
	return {
		id: "memory.inbox",
		section: "memory",
		level: "warn",
		title: `${count} observe ${count === 1 ? "digest was" : "digests were"} never processed (oldest ${formatAge(now - oldest.mtime)})`,
		detail:
			"A detached teach observe reads and deletes its digest as soon as it starts, so a file left behind means the process never started or died before reading it (for example bun missing from the host's PATH).",
		fix: `Run the oldest by hand to see the error: bin/ultrathink teach observe --file ${oldest.path}`,
	};
}

function dirExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		// reason: absence is the answer.
		return false;
	}
}

/** Outbox age, recent observe runs and the local lesson count. Never throws for a missing store; never writes. */
export function checkTeach(deps: DoctorDeps): Finding[] {
	if (deps.env[TEACH_KILL_ENV] === "0") {
		return [
			{
				id: "memory.teach.off",
				section: "memory",
				level: "info",
				title: "Teachable Moments are off (ULTRATHINK_TEACH=0)",
			},
		];
	}
	const teach = loadConfig(claudeConfigPaths(deps.cwd, deps.env)).teach;
	if (!teach.enabled) {
		return [
			{
				id: "memory.teach.off",
				section: "memory",
				level: "info",
				title: "Teachable Moments are off (teach.enabled is false)",
			},
		];
	}
	const stateDir = defaultStateDir(deps.env);
	const dir = storeDir(stateDir);
	const now = deps.now();
	const findings = [outboxFinding(dir, now), observeFinding(stateDir, now)];
	const inbox = inboxFinding(stateDir, now);
	if (inbox) findings.push(inbox);
	const moments = momentsFinding(stateDir, dir, now, teach.capture);
	if (moments) findings.push(moments);
	return findings;
}
