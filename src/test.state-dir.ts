// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Name prefix of the temp state directories the bunfig preload creates (`src/test.setup.ts`). */
export const TEST_STATE_DIR_PREFIX = "ultrathink-test-state-";

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
 * Never throws; a directory another process removes or still uses is skipped.
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
		const path = join(root, name);
		try {
			if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { recursive: true, force: true });
		} catch {
			// reason: best-effort sweep; a directory that vanished or cannot be removed stays for the next run
		}
	}
}
