// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One planner per turn. Grok 1.0.40 only dispatches the global hook file that
 * `scripts/setup.ts apply` installs; if a later Grok also dispatches the plugin's
 * own hooks, both would plan the same prompt and create duplicate tracking rows.
 * The first hook to create the claim file wins, and the claim names its owner (pid and process start time). A
 * duplicate takes the claim over when that owner is dead and never finished, so a first hook that was killed before it
 * planned does not make the turn skip planning for the 24 h the claim would otherwise live. An owner that exits
 * normally stamps `done: true` into its claim (process `exit` event), and a done claim stays held for the 24 h
 * window: a late duplicate must not plan a turn that already ran. Fail-open: a broken claim store
 * must never block planning.
 */
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	opendirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { errorCode } from "../claude/atomic.ts";
import { processIdentity } from "../swarm/lane.ts";

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

/** Claims this process owns and has not yet marked done; one `exit` listener stamps them all. */
const ownedClaims = new Set<string>();

function markOwnedClaimsDone(): void {
	for (const path of ownedClaims) {
		try {
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (typeof value !== "object" || value === null) continue;
			// Only a claim still ours: a takeover after our death is not ours to stamp.
			if (Object.fromEntries(Object.entries(value)).pid !== process.pid) continue;
			const tmp = `${path}.done-${process.pid}`;
			writeFileSync(tmp, ownRecord(true), { mode: 0o600 });
			renameSync(tmp, path);
		} catch {
			// reason: best effort on exit; an unmarked claim only falls back to the dead-owner takeover
		}
	}
	ownedClaims.clear();
}

function rememberOwnedClaim(path: string): void {
	if (ownedClaims.size === 0) process.once("exit", markOwnedClaimsDone);
	ownedClaims.add(path);
}

/**
 * Whether the claim at `path` still has a living owner. A claim with no owner record (an older build, or one whose
 * creator has not written it yet), a claim its owner marked done, and any inspection failure count as held: only
 * proof of death without completion frees a claim early.
 */
function claimDead(path: string): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null) return false;
		const { pid, startTime, done } = Object.fromEntries(Object.entries(value));
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

function writeOwnedClaim(path: string): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeSync(fd, ownRecord());
	} finally {
		closeSync(fd);
	}
	rememberOwnedClaim(path);
}

/**
 * Replaces a dead owner's claim with ours. One mutex file serializes the takeover, so a claim another duplicate took
 * over a moment earlier is never deleted as if it were still the dead one. False when another hook is taking over,
 * or won the claim first.
 */
function takeOver(path: string, now: number): boolean {
	const mutex = `${path}.takeover`;
	try {
		closeSync(openSync(mutex, "wx", 0o600));
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		try {
			// A mutex whose holder died would block takeover until the claim itself expires.
			if (now - statSync(mutex).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(mutex);
		} catch {
			// reason: another duplicate released or replaced it first
		}
		return false;
	}
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
		try {
			unlinkSync(mutex);
		} catch {
			// reason: pruned or already gone
		}
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
