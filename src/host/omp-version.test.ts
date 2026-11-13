// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOmpVersionFrom } from "./omp.ts";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-version-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Writes an executable shell script that runs `body` and returns its path. */
function fakeBinary(name: string, body: string): string {
	const path = join(root, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("readOmpVersionFrom", () => {
	test("returns the dotted version the binary prints", () => {
		const binary = fakeBinary("omp", 'echo "omp/18.19.0"');
		expect(readOmpVersionFrom(binary)).toBe("18.19.0");
	});

	test("returns null when the binary prints no dotted version", () => {
		const binary = fakeBinary("omp", 'echo "no version here"');
		expect(readOmpVersionFrom(binary)).toBeNull();
	});

	test("returns null when the binary exits non-zero", () => {
		const binary = fakeBinary("omp", 'echo "omp/18.19.0"; exit 1');
		expect(readOmpVersionFrom(binary)).toBeNull();
	});

	test("returns null when the binary does not exist", () => {
		expect(readOmpVersionFrom(join(root, "missing"))).toBeNull();
	});

	test("returns null when the binary hangs past the 2 second bound", () => {
		const binary = fakeBinary("omp", "exec sleep 10");
		const started = Date.now();
		expect(readOmpVersionFrom(binary)).toBeNull();
		expect(Date.now() - started).toBeLessThan(5000);
	});
});
