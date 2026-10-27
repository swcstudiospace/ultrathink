// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
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

	test("keeps only the newest 50 runs", () => {
		const dir = stateDir();
		for (let i = 1; i <= 55; i++) appendRun(dir, run(i));
		const runs = readRuns(dir);
		expect(runs).toHaveLength(50);
		expect(runs[0]?.at).toBe(6);
		expect(runs[49]?.at).toBe(55);
	});

	test("a missing file gives an empty list", () => {
		expect(readRuns(stateDir())).toEqual([]);
	});

	test("malformed and mistyped lines are skipped", () => {
		const dir = stateDir();
		appendRun(dir, run(1));
		const path = join(dir, "teach", "observe-runs.ndjson");
		const good = readFileSync(path, "utf8");
		const bad = [
			"{not json",
			"[]",
			JSON.stringify({ ...run(2), at: "x" }),
			JSON.stringify({ ...run(3), sessionId: 3 }),
			JSON.stringify({ ...run(4), outcome: "weird" }),
			JSON.stringify({ ...run(5), captured: -1 }),
			JSON.stringify({ ...run(6), captured: 1.5 }),
		].join("\n");
		writeFileSync(path, `${bad}\n${good}`);
		expect(readRuns(dir)).toEqual([run(1)]);
	});

	test("a read failure other than a missing file keeps the seeded runs on disk", () => {
		const dir = stateDir();
		appendRun(dir, run(1));
		const path = join(dir, "teach", "observe-runs.ndjson");
		const seeded = readFileSync(path, "utf8");
		const original = fs.readFileSync;
		const failing = spyOn(fs, "readFileSync").mockImplementation(((
			...args: Parameters<typeof original>
		) => {
			if (args[0] === path) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
			return (original as (...rest: unknown[]) => unknown)(...args);
		}) as typeof fs.readFileSync);
		try {
			appendRun(dir, run(2));
		} finally {
			failing.mockRestore();
		}
		expect(readFileSync(path, "utf8")).toBe(seeded);
		expect(readRuns(dir)).toEqual([run(1)]);
	});

	test("file and directory modes are 0600 and 0700", () => {
		const dir = stateDir();
		appendRun(dir, run(1));
		expect(statSync(join(dir, "teach")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "teach", "observe-runs.ndjson")).mode & 0o777).toBe(0o600);
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
		expect(readFileSync(join(dir, "teach", "observe-runs.ndjson"), "utf8")).not.toContain(key);
	});
});
