// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

// Planning, failover cooldowns, carriers and trackers write under the state directory. A test process gets a fresh
// temp one (unless the caller set its own) so no suite can touch the operator's real state, e.g. failover-cooldowns.json.
if (!process.env.ULTRATHINK_STATE_DIR?.trim()) {
	const stateDir = mkdtempSync(join(tmpdir(), "ultrathink-test-state-"));
	process.env.ULTRATHINK_STATE_DIR = stateDir;
	// `bun test` never fires process "exit" handlers, so the preload's global afterAll removes the directory.
	afterAll(() => {
		try {
			rmSync(stateDir, { recursive: true, force: true });
		} catch {
			// reason: best-effort cleanup of a temp directory after the run
		}
	});
}

/** Default per-test budget on an idle host; a cold `bun` child alone costs seconds when the host is loaded. */
const BASE_TIMEOUT_MS = 30_000;

/** ULTRATHINK_TEST_TIMEOUT_SCALE overrides the load-derived factor when it parses to a finite number above 0. */
const override = Number(process.env.ULTRATHINK_TEST_TIMEOUT_SCALE);
const [oneMinuteLoad = 0] = loadavg();
const scale =
	Number.isFinite(override) && override > 0
		? override
		: Math.max(1, oneMinuteLoad / availableParallelism());

// Bun 1.4 discards a preload's setDefaultTimeout after the first file (oven-sh/bun#45192), so this covers
// every file only under `bun test --isolate` or `--parallel`; suites that spawn children keep explicit budgets.
setDefaultTimeout(Math.ceil(BASE_TIMEOUT_MS * scale));
