// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One planner per turn. Grok 1.0.40 only dispatches the global hook file that
 * `scripts/setup.ts apply` installs; if a later Grok also dispatches the plugin's
 * own hooks, both would plan the same prompt and create duplicate tracking rows.
 * The first hook to create the claim file wins, and the claim names its owner (pid and process start time). A
 * duplicate takes the claim over when that owner is dead and never finished, so a first hook that was killed before it
 * planned does not make the turn skip planning for the 24 h the claim would otherwise live. An owner that finishes its
 * turn normally calls `markClaimedTurnsDone`, which stamps `done: true` into its claim, and a done claim stays held for
 * the 24 h window: a late duplicate must not plan a turn that already ran. A hook that is interrupted (SIGTERM,
 * SIGINT, an uncaught exit) never stamps it, so a retried turn can take the claim over. Fail-open: a broken claim store
 * must never block planning.
 */
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	openSync,
	opendirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { errorCode } from "../claude/atomic.ts";
import { processIdentity } from "../swarm/lane.ts";
import { readJsonObject } from "./carrier.ts";

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_SCAN_LIMIT = 200;
/** A takeover mutex older than this belongs to a hook that died holding it. */
const TAKEOVER_STALE_MS = 10_000;

/** Who holds a claim: the process that created it, and whether its turn ended normally. */
interface ClaimOwner {
	pid: number;
	startTime: string;
	done?: true;
}

function ownRecord(done = false): string {
	const owner: ClaimOwner = {
		pid: process.pid,
		startTime: processIdentity(process.pid) ?? "",
		...(done ? { done: true as const } : {}),
	};
	return JSON.stringify(owner);
}

/** Claims this process owns and has not yet marked done. */
const ownedClaims = new Set<string>();

/**
 * Stamps `done: true` into every claim this process still owns. The hook calls it once its turn finished its work
 * normally. It is deliberately not an `exit` listener: a hook killed by SIGTERM or SIGINT also runs exit listeners,
 * and an interrupted turn must stay recoverable by a retry (an unfinished claim falls to the dead-owner takeover).
 */
export function markClaimedTurnsDone(): void {
	for (const path of ownedClaims) {
		try {
			const owner = readJsonObject(path);
			// Only a claim still ours: a takeover after our death is not ours to stamp.
			if (owner?.pid !== process.pid) continue;
			const tmp = `${path}.done-${process.pid}`;
			writeFileSync(tmp, ownRecord(true), { mode: 0o600 });
			renameSync(tmp, path);
		} catch {
			// reason: best effort; an unmarked claim only falls back to the dead-owner takeover
		}
	}
	ownedClaims.clear();
}

function rememberOwnedClaim(path: string): void {
	ownedClaims.add(path);
}

/**
 * Whether the claim at `path` still has a living owner. A claim with no owner record (an older build, or one whose
 * creator has not written it yet), a claim its owner marked done, and any inspection failure count as held: only
 * proof of death without completion frees a claim early.
 */
function claimDead(path: string): boolean {
	try {
		const owner = readJsonObject(path);
		if (owner === undefined) return false;
		const { pid, startTime, done } = owner;
		if (done === true) return false;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
		} catch (error) {
			// EPERM: the pid exists under another user, so it is alive.
			return errorCode(error) === "ESRCH";
		}
		// The pid answers, but pids are recycled: only the same start identity proves it is the same process.
		if (typeof startTime !== "string" || startTime === "") return false;
		const current = processIdentity(pid);
		return current !== undefined && current !== startTime;
	} catch {
		// reason: unreadable or torn claim: treat it as held
		return false;
	}
}

/**
 * Publishes this process's owner record at `path`, failing with EEXIST when a claim already exists. The record is
 * written whole to a unique temp file and hard-linked into place, so a crash never leaves an empty claim. A
 * filesystem without hard links falls back to an exclusive create.
 */
function writeOwnedClaim(path: string): void {
	const record = ownRecord();
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.new`;
	try {
		writeFileSync(tmp, record, { mode: 0o600 });
		try {
			linkSync(tmp, path);
		} catch (error) {
			if (errorCode(error) === "EEXIST") throw error;
			// reason: no hard links here; the exclusive create still keeps duplicates out
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(fd, record);
			} finally {
				closeSync(fd);
			}
		}
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			// reason: the temp file is already gone
		}
	}
	rememberOwnedClaim(path);
}

/** The takeover mutex this process created, by file identity: release removes only that file. */
interface MutexLock {
	dev: number;
	ino: number;
}

/** Exclusively creates the mutex at `mutex`, or returns undefined when another hook holds it. */
function tryCreateMutex(mutex: string): MutexLock | undefined {
	try {
		const fd = openSync(mutex, "wx", 0o600);
		try {
			const { dev, ino } = fstatSync(fd);
			return { dev, ino };
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if (errorCode(error) === "EEXIST") return undefined;
		throw error;
	}
}

/**
 * Moves the takeover mutex aside and deletes it only when the moved file itself is stale: a mutex whose holder died
 * would otherwise block takeover until the claim expires. Judging the moved file (not a name that may have been
 * replaced meanwhile) means a fresh mutex another duplicate created is put back under its name, not deleted.
 * True when a stale mutex was removed.
 */
function removeStaleMutex(mutex: string, now: number): boolean {
	const aside = `${mutex}.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		renameSync(mutex, aside);
	} catch {
		// reason: another duplicate removed or replaced it first
		return false;
	}
	let stale = false;
	try {
		stale = now - statSync(aside).mtimeMs > TAKEOVER_STALE_MS;
	} catch {
		// reason: an unreadable mutex is treated as live and put back
	}
	if (!stale) {
		try {
			linkSync(aside, mutex);
		} catch {
			// reason: a third duplicate recreated the mutex first; it holds the takeover now
		}
	}
	try {
		unlinkSync(aside);
	} catch {
		// reason: already gone
	}
	return stale;
}

/** Takes the takeover mutex, clearing a stale one once. Undefined when another hook is taking over. */
function acquireMutex(mutex: string, now: number): MutexLock | undefined {
	const held = tryCreateMutex(mutex);
	if (held) return held;
	return removeStaleMutex(mutex, now) ? tryCreateMutex(mutex) : undefined;
}

/** Removes the takeover mutex only while it is still the file this process created. */
function releaseMutex(mutex: string, lock: MutexLock): void {
	try {
		const current = statSync(mutex);
		if (current.dev === lock.dev && current.ino === lock.ino) unlinkSync(mutex);
	} catch {
		// reason: pruned or already gone
	}
}

/**
 * Replaces a dead owner's claim with ours. One mutex file serializes the takeover, so a claim another duplicate took
 * over a moment earlier is never deleted as if it were still the dead one. False when another hook is taking over,
 * or won the claim first.
 */
function takeOver(path: string, now: number): boolean {
	const mutex = `${path}.takeover`;
	const lock = acquireMutex(mutex, now);
	if (!lock) return false;
	try {
		if (!claimDead(path)) return false;
		unlinkSync(path);
		writeOwnedClaim(path);
		return true;
	} catch (error) {
		// A creator that slipped in between the unlink and our write owns the turn now.
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	} finally {
		releaseMutex(mutex, lock);
	}
}

function pruneStaleClaims(dir: string, now: number): void {
	try {
		const handle = opendirSync(dir);
		try {
			for (let scanned = 0; scanned < PRUNE_SCAN_LIMIT; scanned++) {
				const entry = handle.readSync();
				if (!entry) break;
				const path = join(dir, entry.name);
				try {
					if (now - statSync(path).mtimeMs > CLAIM_TTL_MS) unlinkSync(path);
				} catch {
					// reason: a sibling hook may have pruned it first
				}
			}
		} finally {
			handle.closeSync();
		}
	} catch {
		// reason: pruning stale claims is best effort; a failed prune only leaves old claim files for a later turn to remove
	}
}

/** True when this process owns the turn `key`; false only when another live hook already claimed it. */
export function claimTurn(stateDir: string, key: string, now = Date.now()): boolean {
	try {
		const dir = join(stateDir, "claims");
		const createsStateDir = !existsSync(stateDir);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (createsStateDir) {
			try {
				chmodSync(stateDir, 0o700);
			} catch {
				// reason: a directory we do not own keeps its mode
			}
		}
		pruneStaleClaims(dir, now);
		const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
		const path = join(dir, name);
		try {
			writeOwnedClaim(path);
			return true;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}
		return claimDead(path) && takeOver(path, now);
	} catch {
		// reason: fail-open: a broken claim store must never block planning
		return true;
	}
}
