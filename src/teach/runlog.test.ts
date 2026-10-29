// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../services/ultrathink/test.helpers.ts";
import {
	appendRun,
	failureStreak,
	failureStreakText,
	isObserveFailure,
	type ObserveRun,
	readRuns,
	shouldNotifyFailure,
} from "./runlog.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
	return makeTempDir("ut-runlog-", roots);
}

function run(at: number, extra: Partial<ObserveRun> = {}): ObserveRun {
	return { at, sessionId: `s${at}`, outcome: "captured", captured: 1, ...extra };
}

function runFiles(dir: string): string[] {
	return readdirSync(join(dir, "teach", "runs")).filter((name) => name.endsWith(".json"));
}

function allFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isDirectory()) out.push(...allFiles(join(root, entry.name)));
		else out.push(entry.name);
	}
	return out;
}

describe("observe run log", () => {
	test("append then read round-trips, oldest first", () => {
		const dir = stateDir();
		const skipped = run(2, {
			outcome: "skipped",
			captured: 0,
			skipped: "distiller failed",
			detail: "Credit balance is too low",
		});
		appendRun(dir, run(1));
		appendRun(dir, skipped);
		expect(readRuns(dir)).toEqual([run(1), skipped]);
	});

	test("a missing directory gives an empty list", () => {
		expect(readRuns(stateDir())).toEqual([]);
	});

	test("55 appends leave exactly 50 files and readRuns returns the newest 50", () => {
		const dir = stateDir();
		for (let i = 1; i <= 55; i++) appendRun(dir, run(i));
		expect(runFiles(dir)).toHaveLength(50);
		const runs = readRuns(dir);
		expect(runs).toHaveLength(50);
		expect(runs[0]?.at).toBe(6);
		expect(runs[49]?.at).toBe(55);
	});

	test("malformed and mistyped files are skipped", () => {
		const dir = stateDir();
		appendRun(dir, run(1));
		const runs = join(dir, "teach", "runs");
		const bad: unknown[] = [
			"{not json",
			"[]",
			JSON.stringify({ ...run(2), at: "x" }),
			JSON.stringify({ ...run(3), sessionId: 3 }),
			JSON.stringify({ ...run(4), outcome: "weird" }),
			JSON.stringify({ ...run(5), captured: -1 }),
			JSON.stringify({ ...run(6), captured: 1.5 }),
		];
		bad.forEach((text, i) => {
			writeFileSync(
				join(runs, `${String(10 + i).padStart(13, "0")}-0000000${i}.json`),
				String(text),
			);
		});
		expect(readRuns(dir)).toEqual([run(1)]);
	});

	test("a garbage .json file in the directory is ignored", () => {
		const dir = stateDir();
		appendRun(dir, run(1));
		writeFileSync(join(dir, "teach", "runs", "garbage.json"), "not a run");
		appendRun(dir, run(2));
		expect(readRuns(dir)).toEqual([run(1), run(2)]);
	});

	test("two runs with the same at both survive", () => {
		const dir = stateDir();
		appendRun(dir, run(7, { sessionId: "a" }));
		appendRun(dir, run(7, { sessionId: "b" }));
		expect(runFiles(dir)).toHaveLength(2);
		expect(
			readRuns(dir)
				.map((r) => r.sessionId)
				.sort(),
		).toEqual(["a", "b"]);
	});

	test("a failed write throws nothing and leaves no temporary file", () => {
		const dir = stateDir();
		mkdirSync(join(dir, "teach"), { recursive: true });
		writeFileSync(join(dir, "teach", "runs"), "a regular file, not a directory");
		expect(() => appendRun(dir, run(1))).not.toThrow();
		expect(readRuns(dir)).toEqual([]);
		expect(allFiles(join(dir, "teach")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	test("file and directory modes are 0600 and 0700", () => {
		const dir = stateDir();
		appendRun(dir, run(1));
		expect(statSync(join(dir, "teach", "runs")).mode & 0o777).toBe(0o700);
		const [file] = runFiles(dir);
		expect(statSync(join(dir, "teach", "runs", file ?? "")).mode & 0o777).toBe(0o600);
	});

	test("skipped and detail are redacted and clipped", () => {
		const dir = stateDir();
		const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
		appendRun(
			dir,
			run(1, {
				outcome: "skipped",
				captured: 0,
				skipped: `${key} ${"s".repeat(200)}`,
				detail: `${key}\n${"d".repeat(400)}`,
			}),
		);
		const [row] = readRuns(dir);
		expect(row?.skipped).toBeDefined();
		expect(row?.detail).toBeDefined();
		expect(row?.skipped?.length).toBeLessThanOrEqual(80);
		expect(row?.detail?.length).toBeLessThanOrEqual(160);
		const [file] = runFiles(dir);
		expect(readFileSync(join(dir, "teach", "runs", file ?? ""), "utf8")).not.toContain(key);
	});
});

describe("failure streak", () => {
	const failed = (at: number, detail = "Credit balance is too low"): ObserveRun =>
		run(at, { outcome: "skipped", captured: 0, skipped: "distiller failed", detail });
	const skippedFor = (at: number, skipped: string): ObserveRun =>
		run(at, { outcome: "skipped", captured: 0, skipped });

	test("which skip reasons are failures", () => {
		for (const reason of ["distiller failed", "lesson not saved", "error", "no engine: none"])
			expect(isObserveFailure(reason)).toBe(true);
		for (const reason of [undefined, "no signal", "too few tool calls", "nothing teachable"])
			expect(isObserveFailure(reason)).toBe(false);
	});

	test("no runs, or a newest answered run, is no streak", () => {
		expect(failureStreak([])).toBeUndefined();
		expect(failureStreak([failed(1), run(2)])).toBeUndefined();
		expect(failureStreak([failed(1), skippedFor(2, "nothing teachable")])).toBeUndefined();
	});

	test("counts the trailing failures, starts at the oldest and reports the newest reason", () => {
		const streak = failureStreak([run(1), failed(2, "first reason"), failed(3, "newest reason")]);
		expect(streak).toEqual({ count: 2, truncated: false, since: 2, reason: "newest reason" });
		expect(streak && failureStreakText(streak)).toBe(
			"observe failing ×2 since 1970-01-01 00:00 UTC (newest reason)",
		);
	});

	test("a run skipped before the distiller was asked does not break or extend the streak", () => {
		const streak = failureStreak([
			failed(1),
			skippedFor(2, "too few tool calls"),
			skippedFor(3, "no signal"),
			failed(4),
		]);
		expect(streak).toMatchObject({ count: 2, since: 1 });
	});

	test("a log of nothing but failures is a lower bound", () => {
		const runs = Array.from({ length: 50 }, (_, i) => failed(i + 1));
		const streak = failureStreak(runs);
		expect(streak).toMatchObject({ count: 50, truncated: true });
		expect(streak && failureStreakText(streak)).toContain("×50+");
		expect(shouldNotifyFailure(streak)).toBe(false);
	});

	test("receipts for the first failure and every tenth", () => {
		const at = (count: number) =>
			failureStreak(Array.from({ length: count }, (_, i) => failed(i + 1)));
		expect([1, 2, 9, 10, 11, 20].map((n) => shouldNotifyFailure(at(n)))).toEqual([
			true,
			false,
			false,
			true,
			false,
			true,
		]);
		expect(shouldNotifyFailure(undefined)).toBe(false);
	});

	test("skipped runs cannot push an unresolved failure out of the 50-run log", () => {
		const dir = stateDir();
		appendRun(dir, failed(1));
		for (let i = 2; i <= 70; i++)
			appendRun(dir, skippedFor(i, i % 2 === 0 ? "no signal" : "too few tool calls"));
		expect(runFiles(dir)).toHaveLength(50);
		const runs = readRuns(dir);
		expect(runs[0]).toEqual(failed(1));
		expect(runs.at(-1)?.at).toBe(70);
		const streak = failureStreak(runs);
		expect(streak).toMatchObject({ count: 1, since: 1, truncated: false });
		appendRun(dir, failed(71));
		expect(failureStreak(readRuns(dir))).toMatchObject({ count: 2, since: 1 });
		expect(shouldNotifyFailure(failureStreak(readRuns(dir)))).toBe(false);
	});

	test("real runs are still dropped oldest first when no skipped run can go", () => {
		const dir = stateDir();
		for (let i = 1; i <= 52; i++) appendRun(dir, failed(i));
		expect(readRuns(dir).map((r) => r.at)).toEqual(Array.from({ length: 50 }, (_, i) => i + 3));
		appendRun(dir, skippedFor(53, "no signal"));
		expect(runFiles(dir)).toHaveLength(50);
		expect(readRuns(dir)[0]?.at).toBe(4);
	});
});
