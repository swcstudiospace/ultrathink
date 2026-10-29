// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one way ultrathink persists a state file and the one cross-process lock around a read-modify-write.
 * Hooks are short-lived processes that overlap, so an in-process mutex cannot protect a session file, and a plain
 * `writeFileSync` leaves a truncated file behind when the process dies mid-write. Session records hold verbatim
 * prompts, so files are owner-only (`0600` in `0700` directories). Constraint: never throw for a lock problem and
 * never block a prompt; a lock that cannot be taken in time degrades to running the callback unlocked.
 */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { diskFingerprint } from "../shared.ts";
import { processIdentity } from "../swarm/lane.ts";

/** The synchronous file calls `writeFileAtomic` needs, so a test can make one of them fail. */
interface AtomicFs {
	mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
	openSync(path: string, flags: string, mode: number): number;
	writeSync(fd: number, data: Uint8Array): number;
	fsyncSync(fd: number): void;
	closeSync(fd: number): void;
	renameSync(from: string, to: string): void;
	unlinkSync(path: string): void;
	fchmodSync(fd: number, mode: number): void;
	chmodSync(path: string, mode: number): void;
}

export interface AtomicWriteOptions {
	/** File mode of the new file (default 0o600). */
	mode?: number;
	/** Mode of directories this call creates (default 0o700). */
	dirMode?: number;
	/** Overrides for individual file calls (default: node:fs). */
	fs?: Partial<AtomicFs>;
}

const NODE_FS: AtomicFs = {
	mkdirSync,
	openSync,
	writeSync,
	fsyncSync,
	closeSync,
	renameSync,
	unlinkSync,
	fchmodSync,
	chmodSync,
};

const TEXT = new TextEncoder();

/**
 * Replaces `path` with `data`: a temporary file in the same directory is written and flushed, then renamed over the
 * target, so a reader sees the old file or the new one and never a partial one. On failure the temporary file is
 * removed and the original error is rethrown.
 */
export function writeFileAtomic(
	path: string,
	data: string | Uint8Array,
	options: AtomicWriteOptions = {},
): void {
	const fs: AtomicFs = { ...NODE_FS, ...options.fs };
	const dir = dirname(path);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const bytes = typeof data === "string" ? TEXT.encode(data) : data;
	let fd: number | undefined;
	try {
		const dirMode = options.dirMode ?? 0o700;
		const mode = options.mode ?? 0o600;
		const created = fs.mkdirSync(dir, { recursive: true, mode: dirMode });
		// The create modes are filtered by the umask; explicit chmod calls are not.
		if (typeof created === "string") {
			for (let made = dir; ; made = dirname(made)) {
				fs.chmodSync(made, dirMode);
				if (resolve(made) === resolve(created) || dirname(made) === made) break;
			}
		}
		fd = fs.openSync(tmp, "wx", mode);
		fs.fchmodSync(fd, mode);
		let offset = 0;
		while (offset < bytes.length) offset += fs.writeSync(fd, bytes.subarray(offset));
		fs.fsyncSync(fd);
		const done = fd;
		fd = undefined;
		fs.closeSync(done);
		fs.renameSync(tmp, path);
	} catch (error) {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// reason: the original error is the one to report
			}
		}
		try {
			fs.unlinkSync(tmp);
		} catch {
			// reason: the temporary file may not exist yet
		}
		throw error;
	}
}

/** The seams behind the holder-liveness check, so a test can plant live and dead holders without real processes. */
interface LockLiveness {
	/** Passed to `processIdentity` (default: the running platform). */
	platform?: string;
	/** Passed to `processIdentity`: the `/proc/<pid>/stat` line on Linux. */
	readStat?: (pid: number) => string | undefined;
	/** Passed to `processIdentity`: the `ps -o lstart=` output elsewhere. */
	runPs?: (pid: number) => string | undefined;
	/** Whether the pid is running (default: `process.kill(pid, 0)`; EPERM counts as running). */
	killAlive?: (pid: number) => boolean;
}

export interface LockOptions {
	/**
	 * A lock whose holder cannot be verified (legacy bare token, unreadable start identity) is reclaimed once older
	 * than this (default 10 s). A lock whose holder is alive is never taken, whatever its age.
	 */
	staleMs?: number;
	/** How long to wait for a held lock before `onTimeout` applies (default 2 s; non-hook writers pass longer). */
	timeoutMs?: number;
	/**
	 * What happens when the wait expires: `"run-unlocked"` runs the callback without the lock (default, so hook
	 * paths stay fail-open); `"throw"` throws a {@link LockTimeoutError} naming the lock instead.
	 */
	onTimeout?: "run-unlocked" | "throw";
	/** Base wait between attempts (default 15 ms, plus up to the same again as jitter). */
	pollMs?: number;
	now?: () => number;
	/** Blocks for the given milliseconds (default: `Atomics.wait`, so a one-shot hook can wait without async). */
	sleep?: (ms: number) => void;
	/** Receives one line when the lock could not be taken and the callback ran unlocked. */
	log?: (message: string) => void;
	/** Seams for the holder-liveness check (default: the real process table). */
	liveness?: LockLiveness;
}

const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

function blockingSleep(ms: number): void {
	Atomics.wait(SLEEP_WORD, 0, 0, ms);
}

export function errorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

function discardGuard(path: string, owner: string): void {
	try {
		unlinkSync(join(path, owner));
	} catch {
		return;
	}
	try {
		rmdirSync(path);
	} catch {
		// reason: A successor may already have atomically replaced the now-empty directory.
	}
}

const GUARD_OWNER = /^[1-9]\d*\.[a-f0-9]{32}$/;

function deadGuardOwner(owner: string): boolean {
	if (!GUARD_OWNER.test(owner)) return false;
	try {
		process.kill(Number.parseInt(owner, 10), 0);
		return false;
	} catch (error) {
		return errorCode(error) === "ESRCH";
	}
}

function reclaimDeadGuard(path: string): void {
	try {
		const owners = readdirSync(path);
		const owner = owners[0];
		if (owners.length !== 1 || !owner || !deadGuardOwner(owner)) return;
		discardGuard(path, owner);
	} catch {
		// reason: An unverifiable owner remains held.
	}
}

/** Removes only a prepared guard candidate whose immutable named owner is dead; a dry run changes nothing. */
export function removeDeadLockCandidate(path: string, dryRun = false): boolean {
	const owner = basename(path).match(/\.lock\.guard\.([1-9]\d*\.[a-f0-9]{32})\.tmp$/)?.[1];
	if (!owner || !deadGuardOwner(owner)) return false;
	try {
		if (!lstatSync(path).isDirectory()) return false;
		const entries = readdirSync(path);
		if (entries.length > 1 || (entries.length === 1 && entries[0] !== owner)) return false;
		if (entries.length === 1) {
			const marker = lstatSync(join(path, owner));
			if (!marker.isFile() || marker.size !== 0) return false;
		}
		if (dryRun) return true;
		if (entries.length === 1) unlinkSync(join(path, owner));
		rmdirSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

/**
 * Serializes lock-name creation, reclamation and release, not the protected RMW itself. A prepared nonempty
 * directory is renamed into the guard name atomically; it cannot replace another owner's nonempty directory.
 * Dead-owner recovery unlinks only that owner's unique entry, so a delayed recovery cannot remove a successor.
 * Returns undefined when busy; other filesystem errors and callback errors propagate to the caller's policy.
 */
export function withLockMutation<T>(lockPath: string, fn: () => T): T | undefined {
	const guard = `${lockPath}.guard`;
	const owner = `${process.pid}.${randomBytes(16).toString("hex")}`;
	const candidate = `${guard}.${owner}.tmp`;
	let fd: number | undefined;
	let prepared = false;
	let claimed = false;
	try {
		mkdirSync(candidate, { mode: 0o700 });
		prepared = true;
		chmodSync(candidate, 0o700);
		fd = openSync(join(candidate, owner), "wx", 0o600);
		fchmodSync(fd, 0o600);
		closeSync(fd);
		fd = undefined;
		try {
			renameSync(candidate, guard);
		} catch (error) {
			if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
			reclaimDeadGuard(guard);
			try {
				renameSync(candidate, guard);
			} catch (retryError) {
				if (errorCode(retryError) === "EEXIST" || errorCode(retryError) === "ENOTEMPTY")
					return undefined;
				throw retryError;
			}
		}
		claimed = true;
		return fn();
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* reason: best effort after a preparation error */
			}
		}
		if (claimed) discardGuard(guard, owner);
		else if (prepared) {
			try {
				unlinkSync(join(candidate, owner));
			} catch {
				/* reason: preparation may not have reached the file */
			}
			try {
				rmdirSync(candidate);
			} catch {
				/* reason: orphan pruning can reclaim the dead owner's prepared candidate */
			}
		}
	}
}

type Reclaim = "reclaimed" | "fresh" | "gone";

/** The record a lock file holds: who owns it (pid plus process start identity) and the owner's unique token. */
interface LockHolder {
	pid: number;
	startTime: string;
	token: string;
}

/** The holder record, or undefined for a legacy bare-token lock or any content that is not a holder record. */
function parseHolder(raw: string): LockHolder | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		// reason: a legacy bare-token lock is not JSON; the caller falls back to the mtime rule
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { pid, startTime, token } = value as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (typeof startTime !== "string" || typeof token !== "string") return undefined;
	return { pid, startTime, token };
}

/** Whether the lock's holder is running: `live` never loses its lock, `dead` loses it at once, `unknown` ages out. */
type Verdict = "live" | "dead" | "unknown";

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists under another user: alive.
		return errorCode(error) !== "ESRCH";
	}
}

function holderVerdict(holder: LockHolder, liveness: LockLiveness | undefined): Verdict {
	if (!(liveness?.killAlive ?? pidAlive)(holder.pid)) return "dead";
	// The pid is alive, but pids are recycled: only an identical start identity proves it is the same process.
	if (holder.startTime === "") return "unknown";
	const current = processIdentity(holder.pid, liveness);
	if (current === undefined) return "unknown";
	return current === holder.startTime ? "live" : "dead";
}

let ownIdentity: string | undefined;

/** This process's start identity (a pid never changes, so the default read is cached); "" when unreadable. */
function selfIdentity(liveness: LockLiveness | undefined): string {
	if (liveness !== undefined) return processIdentity(process.pid, liveness) ?? "";
	ownIdentity ??= processIdentity(process.pid) ?? "";
	return ownIdentity;
}

/** Called only while holding the mutation guard, so the stale name cannot become a successor during deletion. */
function reclaimStale(
	lockPath: string,
	staleMs: number,
	now: () => number,
	liveness: LockLiveness | undefined,
): Reclaim {
	try {
		const holder = parseHolder(readFileSync(lockPath, "utf8"));
		if (holder !== undefined) {
			const verdict = holderVerdict(holder, liveness);
			if (verdict === "live") return "fresh";
			if (verdict === "dead") {
				unlinkSync(lockPath);
				return "reclaimed";
			}
		}
		if (now() - statSync(lockPath).mtimeMs <= staleMs) return "fresh";
		unlinkSync(lockPath);
		return "reclaimed";
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "gone" : "fresh";
	}
}

/** Thrown by {@link withFileLock} with `onTimeout: "throw"` when a live holder keeps the lock past `timeoutMs`. */
export class LockTimeoutError extends Error {
	readonly code = "ELOCKTIMEOUT";
	constructor(lockPath: string, timeoutMs: number) {
		super(`lock ${lockPath} still held after ${timeoutMs} ms`);
		this.name = "LockTimeoutError";
	}
}

/** Returns our token once the lock file is ours, or undefined when the callback should run unlocked. */
function acquire(lockPath: string, options: LockOptions): string | undefined {
	const staleMs = options.staleMs ?? 10_000;
	const timeoutMs = options.timeoutMs ?? 2_000;
	const pollMs = options.pollMs ?? 15;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? blockingSleep;
	const token = randomBytes(16).toString("hex");
	const record = JSON.stringify({
		pid: process.pid,
		startTime: selfIdentity(options.liveness),
		token,
	} satisfies LockHolder);
	const started = now();
	for (let attempt = 0; ; attempt++) {
		let retry: string | boolean | undefined;
		try {
			retry = withLockMutation(lockPath, () => {
				try {
					const fd = openSync(lockPath, "wx", 0o600);
					try {
						// The create mode is filtered by the umask; the explicit mode is not.
						fchmodSync(fd, 0o600);
						writeSync(fd, record);
					} catch (error) {
						try {
							unlinkSync(lockPath);
						} catch {
							/* reason: the lock file may already be gone; the original write error is rethrown */
						}
						throw error;
					} finally {
						closeSync(fd);
					}
					return token;
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
				}
				return reclaimStale(lockPath, staleMs, now, options.liveness) !== "fresh";
			});
		} catch (error) {
			options.log?.(
				`lock unavailable for ${basename(lockPath)}, writing unlocked: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
		if (typeof retry === "string") return retry;
		// Reclaimed names retry immediately, but every retry takes the same mutation guard.
		if (retry === true && attempt < 1_000) continue;
		if (now() - started >= timeoutMs) {
			if (options.onTimeout === "throw") throw new LockTimeoutError(lockPath, timeoutMs);
			options.log?.(
				`lock ${basename(lockPath)} still held after ${timeoutMs} ms, writing unlocked`,
			);
			return undefined;
		}
		sleep(pollMs + Math.floor(Math.random() * (pollMs + 1)));
	}
}

function release(lockPath: string, token: string, options: LockOptions): void {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? blockingSleep;
	const started = now();
	for (let attempt = 0; attempt < 1_000; attempt++) {
		try {
			if (
				withLockMutation(lockPath, () => {
					try {
						const holder = parseHolder(readFileSync(lockPath, "utf8"));
						if (holder?.token === token) unlinkSync(lockPath);
					} catch {
						// reason: The lock is already gone or no longer ours.
					}
					return true;
				})
			)
				return;
		} catch {
			return;
		}
		if (now() - started >= (options.timeoutMs ?? 2_000)) return;
		sleep(options.pollMs ?? 15);
	}
}

/**
 * Runs `fn` while holding `<target>.lock`, so overlapping processes take turns on one read-modify-write. A lock
 * whose holder is alive is never taken. A dead holder's lock is reclaimed at once; a lock without a verifiable
 * holder (legacy writer, unreadable identity) is reclaimed once older than `staleMs`. Past `timeoutMs`, or on any
 * lock bookkeeping error, `fn` runs unlocked (`onTimeout: "run-unlocked"`, the default) or the wait throws a
 * {@link LockTimeoutError} (`onTimeout: "throw"`). Errors thrown by `fn` propagate. `fn` must not take the same
 * lock again.
 */
export function withFileLock<T>(target: string, fn: () => T, options: LockOptions = {}): T {
	const lockPath = `${target}.lock`;
	const token = acquire(lockPath, options);
	if (token === undefined) return fn();
	try {
		return fn();
	} finally {
		release(lockPath, token, options);
	}
}

/** How many times {@link updateJsonAtomic} re-reads and re-applies before it reports busy. */
const JSON_UPDATE_ATTEMPTS = 5;

/** A file's size, mtime and inode as `diskFingerprint` reports them; undefined for a file that does not exist. */
interface FileFingerprint {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
}

function sameFingerprint(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Read-modify-write of one JSON file that never silently overwrites a concurrent writer. Under the file lock (when
 * it can be taken) the file is read, `apply` maps its parsed content to the next value, and the result is written
 * only if the file's fingerprint (size, mtime, inode) is unchanged since the read; otherwise the file is re-read and
 * `apply` runs again, up to 5 attempts. `apply` must be a pure function of its argument and returns `undefined`
 * for "no change". A missing file reads as `opts.initial`; unparseable content is handed to `apply` as the raw
 * text. Returns true when `next` was written, false when `apply` declined or every attempt lost a race (callers
 * treat false as "busy, retry later", never as a write that happened). The compare and the rename are two steps, so
 * with a lock timeout the check narrows the lost-update window rather than closing it.
 */
export function updateJsonAtomic(
	path: string,
	apply: (current: unknown) => unknown | undefined,
	opts: LockOptions & { initial?: unknown } = {},
): boolean {
	const { initial, ...lockOptions } = opts;
	return withFileLock(
		path,
		() => {
			for (let attempt = 0; attempt < JSON_UPDATE_ATTEMPTS; attempt++) {
				// Fingerprint BEFORE the read: a replacement between the two then fails the later compare.
				const before = diskFingerprint(path);
				let current: unknown = initial;
				if (before !== undefined) {
					let raw: string;
					try {
						raw = readFileSync(path, "utf8");
					} catch (error) {
						if (errorCode(error) === "ENOENT") continue;
						throw error;
					}
					try {
						current = JSON.parse(raw);
					} catch {
						// reason: apply decides what to do with content that is not JSON
						current = raw;
					}
				}
				const next = apply(current);
				if (next === undefined) return false;
				if (!sameFingerprint(before, diskFingerprint(path))) continue;
				writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
				return true;
			}
			lockOptions.log?.(
				`${basename(path)} changed under ${JSON_UPDATE_ATTEMPTS} consecutive updates, not written`,
			);
			return false;
		},
		lockOptions,
	);
}
