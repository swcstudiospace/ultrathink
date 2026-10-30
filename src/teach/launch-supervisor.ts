// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Detached supervisor of one `teach observe` launch. A host's Stop hook starts this process and exits at once, so the
 * host never waits for the observe command. This process starts the command, waits for it, and appends a
 * `launch exited` run when the exit code is non-zero, or when the command was killed by a signal or never started.
 *
 * Input: one argv argument, the JSON object `{ "stateDir", "sessionId", "command", "args" }`. It is argv rather than
 * the environment so that the observe arguments never reach an environment variable. The spawner starts this process
 * with the host environment and the session directory as cwd, and it is launched through `bin/run-bun` (which passes
 * `--no-env-file`). The observe command gets this process's environment and cwd, with stdio ignored and its own
 * process group, as the direct launch did. Never throws; always exits 0.
 */
import { spawn } from "node:child_process";
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

/** The command's exit code: null when it was killed by a signal or never started. Never rejects. */
function runToExit(command: string, args: string[]): Promise<number | null> {
	const { promise, resolve } = Promise.withResolvers<number | null>();
	try {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env: process.env,
			detached: true,
			stdio: "ignore",
		});
		// A missing command is reported as an 'error' event; without a listener it would crash the supervisor.
		child.on("error", () => resolve(null));
		child.on("exit", (code) => resolve(code));
	} catch {
		// reason: a synchronous spawn failure is the same as a command that never started
		resolve(null);
	}
	return promise;
}

async function supervise(task: LaunchTask): Promise<void> {
	const code = await runToExit(task.command, task.args);
	if (code === 0) return;
	try {
		// One attempt: the run log is diagnostics only, so a failure to record is ignored.
		appendRun(task.stateDir, {
			at: Date.now(),
			sessionId: task.sessionId,
			outcome: "skipped",
			captured: 0,
			skipped: "launch exited",
			exitCode: code,
		});
	} catch {
		// reason: fail-open: the run log is diagnostics only
	}
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
