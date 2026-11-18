// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Detached supervisor of one `teach observe` launch. A host's Stop hook starts this process and exits at once, so the
 * host never waits for the observe command. This process starts the command, waits for it, and appends a
 * `launch exited` run when the exit code is non-zero, or when the command was killed by a signal, never started, or
 * outlived its deadline.
 *
 * Input: one argv argument, the JSON object `{ "stateDir", "sessionId", "command", "args" }`. It is argv rather than
 * the environment so that the observe arguments never reach an environment variable. The spawner starts this process
 * with the host environment and the session directory as cwd, and it is launched through `bin/run-bun` (which passes
 * `--no-env-file`). The observe command gets this process's environment and cwd, with stdio ignored and its own
 * process group, as the direct launch did. Never throws; always exits 0.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { TimerPort } from "../shared.ts";
import { appendRun } from "./runlog.ts";

interface LaunchTask {
	stateDir: string;
	sessionId: string;
	command: string;
	args: string[];
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseTask(text: string | undefined): LaunchTask | undefined {
	try {
		const value: unknown = JSON.parse(text ?? "");
		if (typeof value !== "object" || value === null) return undefined;
		const { stateDir, sessionId, command, args } = value as Record<string, unknown>;
		if (
			typeof stateDir !== "string" ||
			typeof sessionId !== "string" ||
			typeof command !== "string" ||
			!isStrings(args)
		)
			return undefined;
		return { stateDir, sessionId, command, args };
	} catch {
		// reason: unparseable input leaves nothing to supervise
		return undefined;
	}
}

/** Longest the observe command may run before it is killed. The command bounds its own distiller at 90 seconds, so only a hang reaches this. */
const LAUNCH_DEADLINE_MS = 3 * 60_000;

const platformTimers: TimerPort = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout,
};

/**
 * Sends SIGTERM to the command's process group. `detached: true` made the command its group's leader, so a grandchild
 * that stays in the group (a shell's background job, say) is stopped with it. Windows has no groups: the command alone.
 */
function signalGroup(child: ChildProcess | undefined): void {
	if (!child) return;
	try {
		if (child.pid === undefined || process.platform === "win32") child.kill();
		else process.kill(-child.pid, "SIGTERM");
	} catch {
		// reason: the group is already gone (ESRCH); there is nothing left to signal
	}
}

/** How the command ended: its exit code (null when killed by a signal or never started), or the deadline that killed it. */
export type LaunchOutcome = { reason: "exited"; exitCode: number | null } | { reason: "timeout" };

/** Starts the command and settles on its exit, or at the deadline after killing it. Never rejects. */
function runToExit(
	command: string,
	args: string[],
	timers: TimerPort,
	deadlineMs: number,
): Promise<LaunchOutcome> {
	const { promise, resolve } = Promise.withResolvers<LaunchOutcome>();
	let child: ChildProcess | undefined;
	let deadline: unknown;
	const settle = (outcome: LaunchOutcome): void => {
		timers.clearTimeout(deadline);
		resolve(outcome);
	};
	try {
		child = spawn(command, args, {
			cwd: process.cwd(),
			env: process.env,
			detached: true,
			stdio: "ignore",
		});
		// A missing command is reported as an 'error' event; without a listener it would crash the supervisor.
		child.on("error", () => settle({ reason: "exited", exitCode: null }));
		child.on("exit", (code) => settle({ reason: "exited", exitCode: code }));
		// A hung command would keep this process alive forever, so it is killed at the deadline.
		deadline = timers.setTimeout(() => {
			signalGroup(child);
			settle({ reason: "timeout" });
		}, deadlineMs);
	} catch {
		// reason: a synchronous spawn failure is the same as a command that never started
		settle({ reason: "exited", exitCode: null });
	}
	return promise;
}

/** Runs the task to its exit or deadline. Every launch that did not exit 0 is recorded as a `launch exited` run. */
export async function supervise(
	task: LaunchTask,
	timers: TimerPort = platformTimers,
	deadlineMs = LAUNCH_DEADLINE_MS,
): Promise<LaunchOutcome> {
	const outcome = await runToExit(task.command, task.args, timers, deadlineMs);
	if (outcome.reason === "exited" && outcome.exitCode === 0) return outcome;
	try {
		// One attempt: the run log is diagnostics only, so a failure to record is ignored.
		appendRun(task.stateDir, {
			at: Date.now(),
			sessionId: task.sessionId,
			outcome: "skipped",
			captured: 0,
			skipped: "launch exited",
			// A command killed at its deadline has no exit code, as when a signal kills it.
			exitCode: outcome.reason === "exited" ? outcome.exitCode : null,
		});
	} catch {
		// reason: fail-open: the run log is diagnostics only
	}
	return outcome;
}

if (import.meta.main) {
	try {
		const task = parseTask(process.argv[2]);
		if (task) await supervise(task);
	} catch {
		// reason: the supervisor never fails; its exit code stays 0
	}
	process.exit(0);
}
