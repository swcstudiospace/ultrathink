// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Swarm lane identity — pure helpers behind `/ultrathink-swarm` lane safety: the `lane.json` record each
 * lane writes right after spawn, the live-lane count, the duplicate and cap guards, and the single gate
 * that decides whether a recorded pid still belongs to its lane before anything signals it.
 *
 * Nothing here spawns, kills or inspects process state on its own: every OS touch point is an injectable
 * seam, and the stop/cap/duplicate wiring lives in `teams.ts` and the Omp host.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isRecord } from "../shared.ts";

/** Facts about one lane, persisted as `<lane state dir>/lane.json`. Never holds env or key material. */
export interface LaneRecord {
	laneId: string;
	pid: number;
	graphId?: string;
	briefDigest: string;
	cwd: string;
	/** ISO-8601 start time. */
	startedAt: string;
}

/** Minimal fs seam for lane.json, mirroring `TeamsFs`, so tests never touch real state outside tmpdirs. */
export interface LaneFileFs {
	writeFileSync(path: string, data: string, options: { mode: number }): void;
	renameSync(from: string, to: string): void;
	readFileSync(path: string, encoding: "utf8"): string;
	existsSync(path: string): boolean;
}

const defaultFs = {
	writeFileSync,
	renameSync,
	readFileSync,
	existsSync,
} satisfies LaneFileFs;

/** Reports whether a pid is alive. */
export type PidAlive = (pid: number) => boolean;

/** Same shape as Swarm's `GRAPH_ID_RE` (`swarm/substrate_tee.py`), full-match. */
const GRAPH_ID = /^ut-[0-9a-z]+-[0-9a-f]{8}$/;

const LANE_FILE = "lane.json";
const RUNNER_MARKER = "autonomous_run.py";
/** The one hint every stop-related refusal and the cap message end with. */
export const STOP_HINT = "stop a lane with /ultrathink-swarm stop [laneId|all]";

/** How far a process start may sit from the lane's recorded `startedAt` before the pid counts as recycled. */
export const START_TIME_TOLERANCE_MS = 10_000;

/**
 * sha256 hex of the normalized brief (trim, collapse whitespace, lowercase). This normalization is the
 * duplicate-guard key: "Build  X" and "build x" are the same brief.
 */
export function briefDigest(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
	return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Prefix the brief with `Graph ID: <id>` on its own first line so Swarm's `graph_id_in_text` binds the
 * lane to the Ultrathink graph. An absent or malformed id leaves the brief untouched.
 */
export function laneBriefWithGraphId(displayBrief: string, graphId: string | undefined): string {
	if (graphId === undefined || !GRAPH_ID.test(graphId)) return displayBrief;
	return `Graph ID: ${graphId}\n\n${displayBrief}`;
}

/** Atomically write `<stateDir>/lane.json` (tmp file then rename), mode 0600, exactly the record's keys. */
export function writeLaneFile(
	stateDir: string,
	record: LaneRecord,
	fs: LaneFileFs = defaultFs,
): void {
	const body: LaneRecord = {
		laneId: record.laneId,
		pid: record.pid,
		graphId: record.graphId,
		briefDigest: record.briefDigest,
		cwd: record.cwd,
		startedAt: record.startedAt,
	};
	const target = join(stateDir, LANE_FILE);
	const tmp = `${target}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
	fs.renameSync(tmp, target);
}

/** Read `<stateDir>/lane.json`; undefined when missing, unparseable or not a lane record. Never authority. */
export function readLaneFile(stateDir: string, fs: LaneFileFs = defaultFs): LaneRecord | undefined {
	const path = join(stateDir, LANE_FILE);
	let parsed: unknown;
	try {
		if (!fs.existsSync(path)) return undefined;
		parsed = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const { laneId, pid, graphId, briefDigest: digest, cwd, startedAt } = parsed;
	if (typeof laneId !== "string" || laneId === "") return undefined;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (typeof digest !== "string" || typeof cwd !== "string" || typeof startedAt !== "string") {
		return undefined;
	}
	if (graphId !== undefined && typeof graphId !== "string") return undefined;
	const record: LaneRecord = { laneId, pid, briefDigest: digest, cwd, startedAt };
	if (graphId !== undefined) record.graphId = graphId;
	return record;
}

/** Records of lanes whose pid is alive; lanes with a missing or corrupt lane.json are not live. */
export function liveLanes(
	lanes: Array<{ stateDir: string }>,
	isAlive: PidAlive,
	fs: LaneFileFs = defaultFs,
): LaneRecord[] {
	const live: LaneRecord[] = [];
	for (const lane of lanes) {
		const record = readLaneFile(lane.stateDir, fs);
		if (record !== undefined && isAlive(record.pid)) live.push(record);
	}
	return live;
}

/** The live lane already running this brief (same digest) in this cwd, if any. */
export function findDuplicate(
	cwd: string,
	normalizedDigest: string,
	live: readonly LaneRecord[],
): LaneRecord | undefined {
	return live.find((lane) => lane.cwd === cwd && lane.briefDigest === normalizedDigest);
}

/** Refusal text for a spawn over the live-lane cap: names every live lane and the stop hint. */
export function capRefusal(live: readonly LaneRecord[], cap: number): string {
	const rows = live.map((lane) => `  ${lane.laneId} (pid ${lane.pid}, ${lane.cwd})`);
	return [
		`Swarm lane cap reached: ${live.length} live lane(s), limit ${cap} (ULTRATHINK_SWARM_MAX_LANES).`,
		...rows,
		`To free a slot, ${STOP_HINT}.`,
	].join("\n");
}

/**
 * What a pid check concluded: the pid `match`es the lane, a successful read says it `mismatch`es (a recycled
 * or foreign pid), or the evidence was unreadable and the answer is `unknown`. Only `match` ever licenses a
 * signal; `unknown` must never be reported as "gone", because a live lane can hide behind an unreadable /proc.
 */
export type LaneVerdict = "match" | "mismatch" | "unknown";

/** Linux `USER_HZ`: the unit of `/proc/<pid>/stat` field 22. Fixed at 100 on every Linux ABI userspace sees. */
const CLOCK_TICKS_PER_SECOND = 100;

function defaultReadCmdline(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf8");
	} catch {
		return undefined;
	}
}

function defaultReadStat(pid: number): string | undefined {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
}

function defaultReadBootTimeSec(): number | undefined {
	try {
		const match = /^btime\s+(\d+)\s*$/m.exec(readFileSync("/proc/stat", "utf8"));
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

function defaultSignalAlive(pid: number): LaneVerdict {
	try {
		process.kill(pid, 0);
		return "match";
	} catch (error) {
		// EPERM means the pid exists but belongs to another user: alive, and certainly not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM" ? "match" : "mismatch";
	}
}

/**
 * The process start (field 22, clock ticks since boot) out of a `/proc/<pid>/stat` line. The command name
 * (field 2) is parenthesised and may itself hold spaces and parentheses, so fields are counted after the LAST
 * `)`. Undefined when the line is not that shape.
 */
export function parseStatStartTicks(stat: string): number | undefined {
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	// After the `)`, the first field is field 3 (the state), so field 22 is index 19.
	const field = stat
		.slice(close + 1)
		.trim()
		.split(/\s+/)[19];
	if (field === undefined || !/^\d+$/.test(field)) return undefined;
	const ticks = Number(field);
	return Number.isSafeInteger(ticks) ? ticks : undefined;
}

/**
 * The single gate before any kill: does the recorded pid still belong to this lane?
 * Linux: `/proc/<pid>/cmdline` must contain `autonomous_run.py`, AND the process start (stat field 22 over
 * {@link CLOCK_TICKS_PER_SECOND}, added to the boot time from `/proc/stat`) must sit within
 * {@link START_TIME_TOLERANCE_MS} of the record's `startedAt`. An unreadable cmdline, stat or boot time (or an
 * unparseable `startedAt`) is `unknown`; only a successful read that disagrees is `mismatch`.
 * Elsewhere: the caller supplies a start-time-aware `signalAlive(pid, startedAt)` that answers with the same
 * tri-state (a dead pid or a start mismatch means a recycled pid).
 */
export function verifyLaneProcess(
	record: LaneRecord,
	opts: {
		platform?: string;
		readCmdline?: (pid: number) => string | undefined;
		readStat?: (pid: number) => string | undefined;
		readBootTimeSec?: () => number | undefined;
		signalAlive?: (pid: number, startedAt: string) => LaneVerdict;
	} = {},
): LaneVerdict {
	const platform = opts.platform ?? process.platform;
	if (platform !== "linux") {
		return (opts.signalAlive ?? defaultSignalAlive)(record.pid, record.startedAt);
	}
	const cmdline = (opts.readCmdline ?? defaultReadCmdline)(record.pid);
	if (cmdline === undefined) return "unknown";
	if (!cmdline.includes(RUNNER_MARKER)) return "mismatch";
	const stat = (opts.readStat ?? defaultReadStat)(record.pid);
	const ticks = stat === undefined ? undefined : parseStatStartTicks(stat);
	const boot = (opts.readBootTimeSec ?? defaultReadBootTimeSec)();
	const recorded = Date.parse(record.startedAt);
	if (ticks === undefined || boot === undefined || !Number.isFinite(boot)) return "unknown";
	if (!Number.isFinite(recorded)) return "unknown";
	const processStartMs = (boot + ticks / CLOCK_TICKS_PER_SECOND) * 1000;
	return Math.abs(processStartMs - recorded) <= START_TIME_TOLERANCE_MS ? "match" : "mismatch";
}

/** The lock directory, under `<stateDir>/swarm/`; it never matches a lane directory name. */
const LOCK_DIR = ".lane-lock";

/** A lock older than this (by mtime) belongs to a crashed holder and is taken over. */
const LANE_LOCK_STALE_MS = 30_000;

/** How long a lane lock is awaited before running unlocked. */
const LANE_LOCK_WAIT_MS = 1_000;

const LANE_LOCK_POLL_MS = 10;

/** Test seams for {@link withLaneLock}; the defaults are the wall clock and a synchronous `Atomics.wait` sleep. */
export interface LaneLockDeps {
	now?: () => number;
	sleep?: (ms: number) => void;
	staleMs?: number;
	waitMs?: number;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding a cross-process lock on the swarm state directory, so the live-lane check, the spawn and the
 * `lane.json` write are one step across Omp processes sharing the directory. The lock is a directory created
 * atomically (`mkdir` without `recursive`: EEXIST means held). A lock older than `staleMs` by mtime belongs to a
 * crashed holder and is removed and taken. After `waitMs` of short synchronous sleeps it FAILS OPEN and runs
 * `fn` unlocked (leaving the other holder's lock alone), as does any other lock failure: a stuck lock must never
 * block prompt submission. A lock this call took is always released.
 */
export function withLaneLock<T>(stateDir: string, fn: () => T, deps: LaneLockDeps = {}): T {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? sleepSync;
	const staleMs = deps.staleMs ?? LANE_LOCK_STALE_MS;
	const swarmDir = join(stateDir, "swarm");
	const lockPath = join(swarmDir, LOCK_DIR);
	let held = false;
	try {
		mkdirSync(swarmDir, { recursive: true, mode: 0o700 });
		const deadline = now() + (deps.waitMs ?? LANE_LOCK_WAIT_MS);
		for (;;) {
			try {
				mkdirSync(lockPath, { mode: 0o700 });
				held = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") break;
			}
			try {
				if (now() - statSync(lockPath).mtimeMs > staleMs) {
					rmdirSync(lockPath);
					continue;
				}
			} catch {
				// reason: the holder released between the mkdir and the stat; the next mkdir decides
			}
			if (now() >= deadline) break;
			sleep(LANE_LOCK_POLL_MS);
		}
	} catch {
		// reason: the lock is advisory; an unusable state directory fails open
	}
	try {
		return fn();
	} finally {
		if (held) {
			try {
				rmdirSync(lockPath);
			} catch {
				// reason: a lock that is already gone is released
			}
		}
	}
}
