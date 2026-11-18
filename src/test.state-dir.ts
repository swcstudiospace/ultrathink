// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Name prefix of the temp state directories the bunfig preload creates (`src/test.setup.ts`). The preload puts its PID
 * after the prefix: `${TEST_STATE_DIR_PREFIX}<pid>-<random>`.
 */
export const TEST_STATE_DIR_PREFIX = "ultrathink-test-state-";

/** The PID a preload directory name carries, or `undefined` for a name without one (other suites, older runs). */
function ownerPid(name: string): number | undefined {
	const match = /^([1-9]\d*)-/.exec(name.slice(TEST_STATE_DIR_PREFIX.length));
	return match ? Number(match[1]) : undefined;
}

/** True while a process with `pid` exists; EPERM means it exists under another user. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ESRCH"
		);
	}
}

/** A leftover directory older than this belongs to a run that is long over. */
const TEST_STATE_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Empties `dir` and creates it again, so the next test file finds an existing, empty directory. Never throws: a
 * directory that cannot be reset costs the next file its isolation checks, not the run.
 */
export function resetTestStateDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// reason: best-effort cleanup of a temp directory; the suites create what they need under it
	}
}

/**
 * Removes the preload's directories under `root` that were last modified more than `maxAgeMs` before `now`: the
 * directories earlier runs left behind (a run cannot tell which file is its last, so it leaves one empty directory).
 * A directory whose owning process is still alive is kept whatever its age. Never throws; a directory another process
 * removes or still uses is skipped.
 */
export function removeStaleTestStateDirs(
	root: string,
	now = Date.now(),
	maxAgeMs = TEST_STATE_DIR_MAX_AGE_MS,
): void {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		// reason: an unreadable temp root has nothing the preload may remove
		return;
	}
	for (const name of names) {
		if (!name.startsWith(TEST_STATE_DIR_PREFIX)) continue;
		const owner = ownerPid(name);
		if (owner !== undefined && isAlive(owner)) continue;
		const path = join(root, name);
		try {
			if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
		} catch {
			// reason: best-effort sweep; a directory that vanished or cannot be removed stays for the next run
		}
	}
}
