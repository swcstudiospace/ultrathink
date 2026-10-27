// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../services/ultrathink/test.helpers.ts";
import { appendRun, type ObserveRun, readRuns } from "./runlog.ts";

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
