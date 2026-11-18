// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** Hash reported for a file that does not exist. A file's hash is 64 hex characters, so it cannot collide. */
export const ABSENT = "absent";

/**
 * Thrown by writeGuarded when the file's content no longer hashes to the expected value. The file
 * is not touched. The caller must read again and decide what to write.
 */
export class ConcurrentWriteError extends Error {
	readonly path: string;
	readonly expectedHash: string;
	readonly actualHash: string;

	constructor(path: string, expectedHash: string, actualHash: string) {
		super(`${path} changed since it was read: expected hash ${expectedHash}, found ${actualHash}`);
		this.name = "ConcurrentWriteError";
		this.path = path;
		this.expectedHash = expectedHash;
		this.actualHash = actualHash;
	}
}

/**
 * Thrown by writeGuarded when `<path>.lock` is still held after the wait budget: by a live writer,
 * or by a body that is not a pid. The lock is not removed.
 */
export class LockHeldError extends Error {
	readonly lockPath: string;

	constructor(lockPath: string) {
		super(`${lockPath} exists; another writer holds it, or a crashed writer left it behind`);
		this.name = "LockHeldError";
		this.lockPath = lockPath;
	}
}

/** SHA-256 of the UTF-8 bytes, as lowercase hex. */
export function hashContent(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reads the file and its content hash. A missing file reads as empty text with hash ABSENT. */
export function readGuarded(path: string): { text: string; hash: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { text: "", hash: ABSENT };
		throw error;
	}
	return { text, hash: hashContent(text) };
}

/** Options for writeGuarded. */
export interface WriteGuardedOptions {
	/** Milliseconds to wait for a live lock holder before LockHeldError. Defaults to 30 seconds. */
	lockWaitMs?: number;
}

const DEFAULT_LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 10;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Replaces the file with `next` only when its current hash equals `expectedHash`. Under the lock
 * `<path>.lock`, the file is re-read and compared. A match writes a temp file, fsyncs it, renames
 * it over the file, and fsyncs the directory. A mismatch throws ConcurrentWriteError without
 * touching the file. The lock file is removed on every path after it was created.
 *
 * A failure before the rename leaves the file unchanged. A failure in the directory fsync comes
 * after the rename, so the file already holds `next` when that error is thrown.
 *
 * A lock whose body names a dead pid is taken over. A live or unreadable holder is waited for up
 * to `options.lockWaitMs`, then LockHeldError is thrown.
 */
export function writeGuarded(
	path: string,
	expectedHash: string,
	next: string,
	options: WriteGuardedOptions = {},
): { hash: string } {
	const lockPath = `${path}.lock`;
	acquireLock(lockPath, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
	try {
		const { hash: actualHash } = readGuarded(path);
		if (actualHash !== expectedHash) {
			throw new ConcurrentWriteError(path, expectedHash, actualHash);
		}
		replaceFile(path, next);
		return { hash: hashContent(next) };
	} finally {
		rmSync(lockPath, { force: true });
	}
}

/**
 * Takes `<path>.lock`, retrying until `waitMs` elapses. A lock whose body names a dead pid is
 * removed and retried at once. A lock taken here holds this process's pid as its body.
 */
function acquireLock(lockPath: string, waitMs: number): void {
	const startedAt = Date.now();
	for (;;) {
		if (tryCreateLock(lockPath)) return;
		const heldBody = readLockBody(lockPath);
		if (heldBody !== undefined && isDeadHolder(heldBody) && removeStaleLock(lockPath, heldBody)) {
			continue;
		}
		if (Date.now() - startedAt >= waitMs) throw new LockHeldError(lockPath);
		sleepMs(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS));
	}
}

/**
 * Creates the lock file exclusively, with this process's pid as its body. False when it exists.
 */
function tryCreateLock(lockPath: string): boolean {
	let fd: number;
	try {
		fd = openSync(lockPath, "wx");
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	let written = false;
	try {
		writeSync(fd, String(process.pid));
		written = true;
	} finally {
		closeSync(fd);
		if (!written) rmSync(lockPath, { force: true });
	}
	return true;
}

/** The lock body, or undefined when the lock no longer exists. */
function readLockBody(lockPath: string): string | undefined {
	try {
		return readFileSync(lockPath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * True when the body is a pid that no longer exists (process.kill throws ESRCH). A body that is not
 * a pid is never dead: its writer may still be creating it.
 */
function isDeadHolder(body: string): boolean {
	const text = body.trim();
	if (!/^[1-9]\d*$/.test(text)) return false;
	try {
		process.kill(Number(text), 0);
		return false;
	} catch (error) {
		return errorCode(error) === "ESRCH";
	}
}

/**
 * Removes a dead holder's lock only while its body still equals `staleBody`, the content read
 * before the pid was checked. Returns false when the body changed: a live writer replaced it.
 */
function removeStaleLock(lockPath: string, staleBody: string): boolean {
	const current = readLockBody(lockPath);
	if (current === undefined) return true;
	if (current !== staleBody) return false;
	rmSync(lockPath, { force: true });
	return true;
}

/** Blocks the calling thread for `ms`. The buffer is never notified, so the wait always runs out. */
function sleepMs(ms: number): void {
	Atomics.wait(sleepCell, 0, 0, ms);
}

/** Writes `next` to a unique temp file in the same directory, then renames it over `path`. */
function replaceFile(path: string, next: string): void {
	const dir = dirname(path);
	const temp = join(dir, `${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		const fd = openSync(temp, "wx");
		try {
			writeFileSync(fd, next, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	fsyncDirectory(dir);
}

function fsyncDirectory(dir: string): void {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}
