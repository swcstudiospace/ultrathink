// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastSkipLine, recordLastSkip, skipNotice } from "./skip.ts";

describe("last skip record", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-skip-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("shows the reason and its age, newest skip only", () => {
		expect(lastSkipLine(dir)).toBeUndefined();
		recordLastSkip(dir, "trivial", () => 1_000);
		recordLastSkip(dir, "graph-reference", () => 1_000);
		expect(lastSkipLine(dir, () => 1_000 + 5_000)).toBe("last skip: graph-reference 5s ago");
		expect(lastSkipLine(dir, () => 1_000 + 3 * 60_000)).toBe("last skip: graph-reference 3m ago");
		expect(lastSkipLine(dir, () => 1_000 + 2 * 3_600_000)).toBe(
			"last skip: graph-reference 2h ago",
		);
		expect(lastSkipLine(dir, () => 1_000 + 3 * 86_400_000)).toBe(
			"last skip: graph-reference 3d ago",
		);
		expect(lastSkipLine(dir, () => 0)).toBe("last skip: graph-reference 0s ago");
	});

	test("is one small file whatever the reason says: plain characters, at most 64", () => {
		recordLastSkip(dir, `engine x\n"; rm -rf /${"y".repeat(500)}`, () => 1);
		const raw = readFileSync(join(dir, "last-skip.json"), "utf8");
		expect(raw.length).toBeLessThan(200);
		const line = lastSkipLine(dir, () => 1) ?? "";
		expect(line.split("\n")).toHaveLength(1);
		expect(line).not.toContain('"');
		expect(line.length).toBeLessThan(100);
	});

	test("fail-open: an unwritable state directory throws nothing, a corrupt record reads as none", () => {
		expect(() => recordLastSkip(join(dir, "missing", "deeper"), "trivial")).not.toThrow();
		recordLastSkip("", "");
		writeFileSync(join(dir, "last-skip.json"), "{not json");
		expect(lastSkipLine(dir)).toBeUndefined();
		writeFileSync(join(dir, "last-skip.json"), JSON.stringify({ reason: 7, at: "x" }));
		expect(lastSkipLine(dir)).toBeUndefined();
		const locked = join(dir, "ro");
		mkdirSync(locked);
		chmodSync(locked, 0o500);
		expect(() => recordLastSkip(locked, "trivial")).not.toThrow();
		chmodSync(locked, 0o700);
	});
});

describe("skipNotice", () => {
	test("only the skips a user can be surprised by get a one-line note naming the reason and the way out", () => {
		for (const reason of ["graph-reference", "already-uplifted"]) {
			const notice = skipNotice(reason) ?? "";
			expect(notice).toContain(reason);
			expect(notice).toContain("`uplift:`");
			expect(notice.split("\n")).toHaveLength(1);
		}
		for (const reason of [
			"trivial",
			"command",
			"disabled",
			"skip-once",
			"passthrough",
			"empty",
			"constructor",
		])
			expect(skipNotice(reason)).toBeUndefined();
	});
});
