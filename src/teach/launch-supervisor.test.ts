// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../services/ultrathink/test.helpers.ts";
import type { TimerPort } from "../shared.ts";
import { supervise } from "./launch-supervisor.ts";
import { readRuns } from "./runlog.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FakeTimers extends TimerPort {
	/** Delays requested, in order. */
	delays: number[];
	/** Handles passed to clearTimeout, in order. */
	cleared: unknown[];
	/** Handles returned by setTimeout, in order. */
	scheduled: unknown[];
	/** Runs every callback still scheduled, as if its delay had elapsed. */
	fire(): void;
}

function fakeTimers(): FakeTimers {
	const callbacks = new Map<number, () => void>();
	let next = 0;
	const timers: FakeTimers = {
		delays: [],
		cleared: [],
		scheduled: [],
		setTimeout(fn, ms) {
			next += 1;
			callbacks.set(next, fn);
			timers.delays.push(ms);
			timers.scheduled.push(next);
			return next;
		},
		clearTimeout(handle) {
			timers.cleared.push(handle);
			callbacks.delete(handle as number);
		},
		fire() {
			for (const fn of [...callbacks.values()]) fn();
		},
	};
	return timers;
}

/**
 * Polls `check` until it passes or about five seconds elapse. The processes here are real and exit on the OS clock,
 * which no fake timer reaches, so this bounded poll is the exception to deterministic time; it returns as soon as
 * the condition holds.
 */
async function eventually(check: () => boolean): Promise<boolean> {
	for (let i = 0; i < 500; i++) {
		if (check()) return true;
		await Bun.sleep(10);
	}
	return false;
}

/** The pid a shell wrote to `file`; fails instead of returning a non-pid. */
async function readPid(file: string): Promise<number> {
	const pidText = (): string => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
	if (!(await eventually(() => /^\d+$/.test(pidText()))))
		throw new Error(`no pid was written to ${file}`);
	return Number(pidText());
}

/** Whether `pid` runs. A killed process its parent never reaped is a zombie, which has exited. */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		// reason: no such process: it exited and was reaped
		return false;
	}
	try {
		return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		// reason: no /proc (not Linux): the signal probe is all there is
		return true;
	}
}

describe("supervise", () => {
	test("a command that never exits is killed at its deadline and settles with a timeout", async () => {
		const stateDir = makeTempDir("ut-launch-timeout-", roots);
		const timers = fakeTimers();
		const settled = supervise(
			{ stateDir, sessionId: "s1", command: "sleep", args: ["60"] },
			timers,
			5_000,
		);
		timers.fire();
		expect(await settled).toEqual({ reason: "timeout" });
		expect(timers.delays).toEqual([5_000]);
		expect(readRuns(stateDir)).toMatchObject([
			{ sessionId: "s1", outcome: "skipped", skipped: "launch exited", exitCode: null },
		]);
	});

	test("a command that exits before its deadline clears the deadline and records its exit code", async () => {
		const stateDir = makeTempDir("ut-launch-exit-", roots);
		const timers = fakeTimers();
		const outcome = await supervise(
			{ stateDir, sessionId: "s2", command: "sh", args: ["-c", "exit 3"] },
			timers,
			5_000,
		);
		expect(outcome).toEqual({ reason: "exited", exitCode: 3 });
		expect(timers.scheduled).toHaveLength(1);
		expect(timers.cleared).toEqual(timers.scheduled);
		expect(readRuns(stateDir)).toMatchObject([
			{ sessionId: "s2", outcome: "skipped", skipped: "launch exited", exitCode: 3 },
		]);
	});

	test("a zero exit clears the deadline and records nothing", async () => {
		const stateDir = makeTempDir("ut-launch-ok-", roots);
		const timers = fakeTimers();
		const outcome = await supervise(
			{ stateDir, sessionId: "s3", command: "sh", args: ["-c", "exit 0"] },
			timers,
			5_000,
		);
		expect(outcome).toEqual({ reason: "exited", exitCode: 0 });
		expect(timers.scheduled).toHaveLength(1);
		expect(timers.cleared).toEqual(timers.scheduled);
		expect(readRuns(stateDir)).toEqual([]);
	});

	test("deadline kill reaches a child that outlives its parent", async () => {
		const stateDir = makeTempDir("ut-launch-grandchild-", roots);
		const pidFile = join(stateDir, "grandchild.pid");
		const timers = fakeTimers();
		const settled = supervise(
			{
				stateDir,
				sessionId: "s4",
				command: "sh",
				args: ["-c", 'sleep 60 & echo $! > "$0"; wait', pidFile],
			},
			timers,
			5_000,
		);
		const grandchild = await readPid(pidFile);
		try {
			timers.fire();
			expect(await settled).toEqual({ reason: "timeout" });
			expect(await eventually(() => !isAlive(grandchild))).toBe(true);
		} finally {
			// reason: a grandchild the kill missed is stopped here, so it cannot outlive the test
			if (isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
		}
	});
});
