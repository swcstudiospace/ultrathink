// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveStateDir } from "./host/paths.ts";
import {
	removeStaleTestStateDirs,
	resetTestStateDir,
	TEST_STATE_DIR_PREFIX,
} from "./test.state-dir.ts";

const roots: string[] = [];
const tempRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), "ut-setup-test-"));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the bunfig preload isolates the state directory", () => {
	// The runner may call the preload's afterAll once at the end (Bun 1.4) or after every file (Bun 1.2.x), so no
	// assertion here depends on which file ran before this one.
	test("ULTRATHINK_STATE_DIR names an existing temp directory outside the operator's state", () => {
		const dir = process.env.ULTRATHINK_STATE_DIR?.trim();
		expect(dir).toBeTruthy();
		if (!dir) return;
		expect(statSync(dir).isDirectory()).toBe(true);
		expect(relative(tmpdir(), dir).startsWith("..")).toBe(false);
		expect(dir.startsWith(join(homedir(), ".claude"))).toBe(false);
		expect(resolveStateDir()).toBe(dir);
	});

	test("failover cooldowns of a test process never reach the real state directory", () => {
		const dir = process.env.ULTRATHINK_STATE_DIR?.trim() ?? "";
		expect(join(resolveStateDir(), "failover-cooldowns.json").startsWith(dir)).toBe(true);
		// The operator's own file is untouched by this process: it is either absent or not under the temp state dir.
		const real = join(homedir(), ".claude", "ultrathink", "failover-cooldowns.json");
		expect(real.startsWith(dir)).toBe(false);
		expect(existsSync(dir)).toBe(true);
	});
});

describe("the preload's state directory cleanup", () => {
	test("a reset empties the directory and leaves it in place for the next test file", () => {
		const dir = join(tempRoot(), `${TEST_STATE_DIR_PREFIX}x`);
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(join(dir, "sessions", "s1.json"), "{}");
		writeFileSync(join(dir, "failover-cooldowns.json"), "{}");
		resetTestStateDir(dir);
		expect(statSync(dir).isDirectory()).toBe(true);
		expect(readdirSync(dir)).toEqual([]);
		// A second call (the runner fires the hook after every file) finds the empty directory and keeps it.
		resetTestStateDir(dir);
		expect(statSync(dir).isDirectory()).toBe(true);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("a reset recreates a directory that is gone", () => {
		const dir = join(tempRoot(), `${TEST_STATE_DIR_PREFIX}gone`);
		resetTestStateDir(dir);
		expect(statSync(dir).isDirectory()).toBe(true);
	});

	test("the stale sweep removes only the preload's directories older than 24 hours", () => {
		const root = tempRoot();
		const now = Date.UTC(2026, 9, 29, 12);
		const hours = (n: number): number => (now - n * 3_600_000) / 1000;
		const make = (name: string, ageHours: number): string => {
			const path = join(root, name);
			mkdirSync(path);
			writeFileSync(join(path, "marker"), "x");
			utimesSync(path, hours(ageHours), hours(ageHours));
			return path;
		};
		const old = make(`${TEST_STATE_DIR_PREFIX}old`, 25);
		const fresh = make(`${TEST_STATE_DIR_PREFIX}fresh`, 23);
		const foreign = make("somebody-elses-old-directory", 72);
		removeStaleTestStateDirs(root, now);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(foreign)).toBe(true);
	});

	test("the sweep and the reset never throw on a root that does not exist", () => {
		const missing = join(tempRoot(), "nope", "nested");
		expect(() => removeStaleTestStateDirs(missing)).not.toThrow();
		expect(() => resetTestStateDir(join(missing, `${TEST_STATE_DIR_PREFIX}y`))).not.toThrow();
	});
});
