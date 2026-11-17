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
 * Thrown by writeGuarded when `<path>.lock` already exists. The lock is not removed: it belongs to
 * another writer or to a crashed one, and only an operator clears it.
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

/**
 * Replaces the file with `next` only when its current hash equals `expectedHash`. Under the lock
 * `<path>.lock`, the file is re-read and compared. A match writes a temp file, fsyncs it, renames
 * it over the file, and fsyncs the directory. A mismatch throws ConcurrentWriteError without
 * touching the file. The lock file is removed on every path after it was created.
 *
 * A failure before the rename leaves the file unchanged. A failure in the directory fsync comes
 * after the rename, so the file already holds `next` when that error is thrown.
 */
export function writeGuarded(path: string, expectedHash: string, next: string): { hash: string } {
	const lockPath = `${path}.lock`;
	acquireLock(lockPath);
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

/** Creates the lock file exclusively. The caller removes it only after this returns. */
function acquireLock(lockPath: string): void {
	try {
		closeSync(openSync(lockPath, "wx"));
	} catch (error) {
		if (errorCode(error) === "EEXIST") throw new LockHeldError(lockPath);
		throw error;
	}
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
