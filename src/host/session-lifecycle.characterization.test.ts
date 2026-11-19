// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Characterization of the Omp session-start and session-end phase reports. These snapshots pin what the host shows when
 * a session starts (restoreSessionPhases) and when it ends (pauseSessionPhases) today, so a later change to the report
 * wording or to the checkpoint rules shows up as a snapshot diff.
 *
 * The session_start and session_shutdown handlers in omp.ts only forward these reports to the UI; the report text is
 * built here. Each case works in its own temporary state directory with a fixed checkpoint time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_STATE_DIR_PREFIX } from "../test.state-dir.ts";
import { attemptPhase } from "../workflow/phase-loop.ts";
import { fileStore } from "../workflow/phase-loop-store.ts";
import { pauseSessionPhases, restoreSessionPhases } from "./omp-phase.ts";

const SESSION = "sess-lifecycle";
const PAUSE_AT = "2026-11-17T10:00:00.000Z";

const roots: string[] = [];
const newStateDir = (): string => {
	const root = mkdtempSync(join(tmpdir(), TEST_STATE_DIR_PREFIX));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Opens a Discuss phase loop for the session, as an accepted Discuss attempt does. */
function openDiscuss(stateDir: string, sessionId = SESSION): void {
	attemptPhase(
		sessionId,
		{ phase: "Discuss", completeUpliftCount: 1, unansweredBlockingClarifications: 0 },
		() => true,
		fileStore(join(stateDir, "phase-loop")),
	);
}

describe("session start: restoreSessionPhases", () => {
	test("no phase-loop directory: nothing is restored or reported", () => {
		expect(restoreSessionPhases({ stateDir: newStateDir(), sessionId: SESSION })).toMatchSnapshot();
	});

	test("empty session id: nothing is restored even when a record exists", () => {
		const stateDir = newStateDir();
		openDiscuss(stateDir);
		expect(restoreSessionPhases({ stateDir, sessionId: "" })).toMatchSnapshot();
	});

	test("stored record of this session: the restored phase order is reported", () => {
		const stateDir = newStateDir();
		openDiscuss(stateDir);
		expect(restoreSessionPhases({ stateDir, sessionId: SESSION })).toMatchSnapshot();
	});

	test("record of another session: this session restores nothing", () => {
		const stateDir = newStateDir();
		openDiscuss(stateDir, "sess-other");
		expect(restoreSessionPhases({ stateDir, sessionId: SESSION })).toMatchSnapshot();
	});

	test("paused record: the report names the pause checkpoint and its time", () => {
		const stateDir = newStateDir();
		openDiscuss(stateDir);
		pauseSessionPhases({ stateDir, sessionId: SESSION, at: PAUSE_AT });
		expect(restoreSessionPhases({ stateDir, sessionId: SESSION })).toMatchSnapshot();
	});
});

describe("session end: pauseSessionPhases", () => {
	test("no phase-loop directory: nothing is paused and nothing is reported", () => {
		expect(
			pauseSessionPhases({ stateDir: newStateDir(), sessionId: SESSION, at: PAUSE_AT }),
		).toMatchSnapshot();
	});

	test("no record for this session: nothing is paused and nothing is reported", () => {
		const stateDir = newStateDir();
		openDiscuss(stateDir, "sess-other");
		expect(pauseSessionPhases({ stateDir, sessionId: SESSION, at: PAUSE_AT })).toMatchSnapshot();
	});

	test("stored record: the pause is written silently", () => {
		const stateDir = newStateDir();
		openDiscuss(stateDir);
		expect(pauseSessionPhases({ stateDir, sessionId: SESSION, at: PAUSE_AT })).toMatchSnapshot();
	});
});
