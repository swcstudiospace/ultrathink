// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { makeTempDir } from "../../services/ultrathink/test.helpers.ts";
import { supervise, type TimerPort } from "./launch-supervisor.ts";
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
	/** Runs every callback still scheduled, as if its delay had elapsed. */
	fire(): void;
}

function fakeTimers(): FakeTimers {
	const callbacks = new Map<number, () => void>();
	let next = 0;
	const timers: FakeTimers = {
		delays: [],
		cleared: [],
		setTimeout(fn, ms) {
			next += 1;
			callbacks.set(next, fn);
			timers.delays.push(ms);
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
		expect(timers.cleared).toEqual([1]);
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
		expect(timers.cleared).toEqual([1]);
		expect(readRuns(stateDir)).toEqual([]);
	});
});
