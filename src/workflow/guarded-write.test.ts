// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ABSENT,
	ConcurrentWriteError,
	hashContent,
	LockHeldError,
	readGuarded,
	writeGuarded,
} from "./guarded-write.ts";

/** Returns the error a call throws, or fails the test when it does not throw. */
function thrownBy(call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

describe("guarded writer", () => {
	let root: string;
	let path: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "guarded-write-"));
		path = join(root, "STATE.md");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("a read followed by a write with the same hash replaces the file", () => {
		writeGuarded(path, ABSENT, "base\n");
		const { text, hash } = readGuarded(path);
		const next = "updated\n";

		const result = writeGuarded(path, hash, next);

		expect(readFileSync(path, "utf8")).toBe(next);
		expect(result.hash).toBe(hashContent(next));
		expect(existsSync(`${path}.lock`)).toBe(false);
		expect(text).toBe("base\n");
	});

	test("a second writer from the same base hash fails and leaves the first writer's text", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeGuarded(path, base, "first\n");
		const firstHash = hashContent("first\n");

		const error = thrownBy(() => writeGuarded(path, base, "second\n"));

		expect(error).toBeInstanceOf(ConcurrentWriteError);
		expect((error as ConcurrentWriteError).message).toContain(base);
		expect((error as ConcurrentWriteError).message).toContain(firstHash);
		expect(readFileSync(path, "utf8")).toBe("first\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
		expect(readdirSync(root)).toEqual(["STATE.md"]);
	});

	test("a pre-existing lock file makes the write throw and is left in place", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeFileSync(`${path}.lock`, "held");

		const error = thrownBy(() => writeGuarded(path, base, "next\n"));

		expect(error).toBeInstanceOf(LockHeldError);
		expect((error as LockHeldError).message).toContain(`${path}.lock`);
		expect(readFileSync(path, "utf8")).toBe("base\n");
		expect(readFileSync(`${path}.lock`, "utf8")).toBe("held");
	});

	test("a missing file reads as ABSENT; creating it succeeds once and a second create fails", () => {
		expect(readGuarded(path)).toEqual({ text: "", hash: ABSENT });

		writeGuarded(path, ABSENT, "created\n");
		expect(readFileSync(path, "utf8")).toBe("created\n");

		const error = thrownBy(() => writeGuarded(path, ABSENT, "again\n"));

		expect(error).toBeInstanceOf(ConcurrentWriteError);
		expect(readFileSync(path, "utf8")).toBe("created\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("a stale hash fails even when the new content equals the current content", () => {
		writeGuarded(path, ABSENT, "old\n");
		const staleHash = readGuarded(path).hash;
		writeGuarded(path, staleHash, "same\n");

		const error = thrownBy(() => writeGuarded(path, staleHash, "same\n"));

		expect(error).toBeInstanceOf(ConcurrentWriteError);
		expect(readFileSync(path, "utf8")).toBe("same\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});
});
