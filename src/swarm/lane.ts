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

import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
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

/** The file inside the lock directory that names the holder's pid. */
const LOCK_OWNER_FILE = "owner";

/** A lock with no readable owner older than this belongs to a holder that crashed between `mkdir` and the owner write. */
const LANE_LOCK_OWNERLESS_MS = 2_000;

/** The takeover mutex sits beside the lock directory (`<lock>.takeover`). */
const TAKEOVER_SUFFIX = ".takeover";

/** A takeover mutex older than this belongs to a recoverer that crashed. */
const TAKEOVER_STALE_MS = 5_000;

/** How long a lane lock is awaited before the start is refused. */
const LANE_LOCK_WAIT_MS = 1_000;

const LANE_LOCK_POLL_MS = 10;

/** The refusal when the lane lock stays held by another live process for the whole wait. */
export const LANE_LOCK_BUSY =
	"another ultrathink process is starting lanes (lane lock busy); try again in a moment";

/** Result of {@link withLaneLock}: `fn` ran under the lock (`held`), or it was NOT run and `reason` says why. */
export type LaneLockResult<T> = { held: true; value: T } | { held: false; reason: string };

/** Minimal fs seam for the lane lock, so tests can force races and failures without touching real state. */
interface LaneLockFs {
	mkdirSync(path: string, options: { mode?: number; recursive?: boolean }): void;
	writeFileSync(path: string, data: string, options: { mode: number }): void;
	readFileSync(path: string, encoding: "utf8"): string;
	statSync(path: string): { mtimeMs: number };
	renameSync(from: string, to: string): void;
	rmSync(path: string, options: { recursive: boolean; force: boolean }): void;
}

const defaultLockFs: LaneLockFs = {
	mkdirSync: (path, options) => {
		mkdirSync(path, options);
	},
	writeFileSync,
	readFileSync,
	statSync,
	renameSync,
	rmSync,
};

/** Test seams for {@link withLaneLock}; the defaults are the wall clock, a synchronous `Atomics.wait` sleep and `process.kill(pid, 0)`. */
export interface LaneLockDeps {
	now?: () => number;
	sleep?: (ms: number) => void;
	waitMs?: number;
	/** How old a lock with no readable owner must be before it counts as left by a crash (default 2 s). */
	ownerlessMs?: number;
	/** Whether a lock owner's pid is alive; a dead owner means the holder crashed. */
	isAlive?: PidAlive;
	fs?: Partial<LaneLockFs>;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `process.kill(pid, 0)`: ESRCH means dead, EPERM (and anything else) means alive. */
function signalZeroAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && code.length > 0 ? code : "UNKNOWN";
}

/**
 * Run `fn` holding a cross-process lock on the swarm state directory, so the live-lane check, the spawn and the
 * `lane.json` write are one step across Omp processes sharing the directory. FAILS CLOSED: `fn` runs only when
 * the lock is held (`{ held: true, value }`); when it stays busy for `waitMs` (`LANE_LOCK_BUSY`, followed by the
 * holder's pid and the lock directory when the owner is known) or the lock directory cannot be created or
 * stamped (`cannot take the lane lock (<code>)`) `fn` is NOT run (`{ held: false, reason }`). Refusing to start
 * lanes never blocks prompt submission, and a cap is a safety limit.
 *
 * The lock is a directory created atomically (`mkdir` without `recursive`: EEXIST means held) holding an `owner`
 * file with the holder's pid. A lock whose owner is ALIVE is never taken over, however old: a live holder is the
 * only one who can release it, and two holders must never share the critical section. Only a holder that can
 * neither release nor recreate the lock is recovered: its `owner` pid is dead, or the directory has no readable
 * owner and is older than `ownerlessMs` (a crash between `mkdir` and the owner write). Recovery is serialised by a
 * second directory, `<lock>.takeover` (EEXIST means another waiter is recovering: keep waiting; one older than
 * `TAKEOVER_STALE_MS` belongs to a crashed recoverer and is cleared). Inside it the condition is judged again and
 * the lock directory is renamed to a unique tombstone only if the SAME condition still holds. A lock this call
 * took is released only while its `owner` file still names this process.
 */
export function withLaneLock<T>(
	stateDir: string,
	fn: () => T,
	deps: LaneLockDeps = {},
): LaneLockResult<T> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? sleepSync;
	const ownerlessMs = deps.ownerlessMs ?? LANE_LOCK_OWNERLESS_MS;
	const isAlive = deps.isAlive ?? signalZeroAlive;
	const fs: LaneLockFs = { ...defaultLockFs, ...deps.fs };
	const swarmDir = join(stateDir, "swarm");
	const lockPath = join(swarmDir, LOCK_DIR);
	const takeoverPath = `${lockPath}${TAKEOVER_SUFFIX}`;

	const readOwner = (dir: string): number | undefined => {
		try {
			const raw = fs.readFileSync(join(dir, LOCK_OWNER_FILE), "utf8").trim();
			const pid = /^\d+$/.test(raw) ? Number(raw) : 0;
			return pid > 0 ? pid : undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * `gone`: the directory does not exist. `dead-owner`: its owner pid is dead. `ownerless`: no readable owner and
	 * older than `ownerlessMs`. `held`: anything else (a live owner, or a lock too young to judge); `pid` is the
	 * owner when one is readable.
	 */
	const inspect = (): { kind: "gone" | "dead-owner" | "ownerless" | "held"; pid?: number } => {
		const pid = readOwner(lockPath);
		if (pid !== undefined) {
			return isAlive(pid) ? { kind: "held", pid } : { kind: "dead-owner", pid };
		}
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(lockPath).mtimeMs;
		} catch (error) {
			return { kind: errorCode(error) === "ENOENT" ? "gone" : "held" };
		}
		return { kind: now() - mtimeMs > ownerlessMs ? "ownerless" : "held" };
	};

	/**
	 * One recovery attempt for a lock a waiter judged `observed`. Returns false when another waiter holds the
	 * takeover mutex (keep waiting); true when the caller should retry the `mkdir` now.
	 */
	const recover = (observed: "dead-owner" | "ownerless"): boolean => {
		try {
			fs.mkdirSync(takeoverPath, { mode: 0o700 });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			try {
				if (now() - fs.statSync(takeoverPath).mtimeMs <= TAKEOVER_STALE_MS) return false;
			} catch (statError) {
				// reason: the recoverer finished between the mkdir and the stat; retry at once
				if (errorCode(statError) === "ENOENT") return true;
				throw statError;
			}
			// reason: a takeover mutex this old belongs to a recoverer that crashed
			fs.rmSync(takeoverPath, { recursive: true, force: true });
			return true;
		}
		try {
			if (inspect().kind !== observed) return true;
			const tombstone = join(
				swarmDir,
				`${LOCK_DIR}.stale-${process.pid}-${randomBytes(4).toString("hex")}`,
			);
			try {
				fs.renameSync(lockPath, tombstone);
			} catch (error) {
				// reason: the lock vanished after the re-check; the next mkdir decides
				if (errorCode(error) === "ENOENT") return true;
				throw error;
			}
			try {
				fs.rmSync(tombstone, { recursive: true, force: true });
			} catch {
				// reason: the lock already moved out of the way; a leftover tombstone blocks nothing
			}
			return true;
		} finally {
			fs.rmSync(takeoverPath, { recursive: true, force: true });
		}
	};

	const busy = (pid: number | undefined): LaneLockResult<T> => ({
		held: false,
		reason:
			pid === undefined
				? LANE_LOCK_BUSY
				: `${LANE_LOCK_BUSY} (held by process ${pid}; if that process is gone, remove ${lockPath})`,
	});

	let held = false;
	try {
		fs.mkdirSync(swarmDir, { recursive: true, mode: 0o700 });
		const deadline = now() + (deps.waitMs ?? LANE_LOCK_WAIT_MS);
		let lastOwner: number | undefined;
		for (;;) {
			try {
				fs.mkdirSync(lockPath, { mode: 0o700 });
				held = true;
				break;
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
			const state = inspect();
			if (state.kind === "gone") continue;
			lastOwner = state.pid;
			if (state.kind === "dead-owner" || state.kind === "ownerless") {
				if (recover(state.kind)) continue;
			}
			if (now() >= deadline) return busy(lastOwner);
			sleep(LANE_LOCK_POLL_MS);
		}
	} catch (error) {
		return { held: false, reason: `cannot take the lane lock (${errorCode(error)})` };
	}
	try {
		try {
			fs.writeFileSync(join(lockPath, LOCK_OWNER_FILE), String(process.pid), { mode: 0o600 });
		} catch (error) {
			// reason: without an owner file a waiter would treat this lock as ownerless and recover it from a live holder
			try {
				fs.rmSync(lockPath, { recursive: true, force: true });
			} catch {
				// reason: an unstamped lock that cannot be removed is recovered by age; the refusal below still stands
			}
			held = false;
			return { held: false, reason: `cannot take the lane lock (${errorCode(error)})` };
		}
		return { held: true, value: fn() };
	} finally {
		if (held) {
			try {
				if (readOwner(lockPath) === process.pid) {
					fs.rmSync(lockPath, { recursive: true, force: true });
				}
			} catch {
				// reason: a lock that is already gone is released
			}
		}
	}
}
