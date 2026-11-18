// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Host process for the kill-checkpoint test in omp-phase.test.ts. It installs the kill hook for one session, then sends
 * itself SIGTERM; the hook checkpoints the session's phase record and ends the process with that signal. The state dir,
 * session id and clock (epoch ms) come from the environment.
 */
import { installKillCheckpoint } from "./omp-phase.ts";

const stateDir = process.env.ULTRATHINK_KILL_STATE_DIR ?? "";
const sessionId = process.env.ULTRATHINK_KILL_SESSION ?? "";
const epochMs = Number(process.env.ULTRATHINK_KILL_NOW);

installKillCheckpoint(
	() => ({ stateDir, sessionId }),
	() => epochMs,
);
// Keeps the event loop alive until the signal arrives; the hook decides how the process ends.
setInterval(() => undefined, 60_000);
process.kill(process.pid, "SIGTERM");
