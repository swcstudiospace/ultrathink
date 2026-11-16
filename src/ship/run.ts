// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { Run } from "./types.ts";

/** Exit code of a child killed at its deadline (the GNU `timeout` convention): a failure, never a clean exit 1. */
const TIMED_OUT_EXIT = 124;
/** Exit code of a child killed by a signal: the shell's 128 base, with the signal named in stderr. */
const KILLED_EXIT = 128;
/** Runs argv synchronously; never throws (spawn failure -> exitCode 127, deadline -> TIMED_OUT_EXIT with a reason). */
export const defaultRun: Run = (argv, opts = {}) => {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	try {
		const proc = Bun.spawnSync(argv, {
			cwd: opts.cwd,
			timeout: timeoutMs,
			stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitedDueToTimeout)
			return {
				exitCode: TIMED_OUT_EXIT,
				stdout: proc.stdout?.toString() ?? "",
				stderr: `timed out after ${timeoutMs} ms`,
			};
		if (proc.signalCode)
			return {
				exitCode: KILLED_EXIT,
				stdout: proc.stdout?.toString() ?? "",
				stderr: `killed by ${proc.signalCode}`,
			};
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout?.toString() ?? "",
			stderr: proc.stderr?.toString() ?? "",
		};
	} catch (error) {
		return {
			exitCode: 127,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
};
