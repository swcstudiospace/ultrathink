// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Registration, installPlugin } from "./install.ts";

let base: string;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "install-test-"));
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

function filesOf(entries: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(entries));
}

interface FakeOptions {
	readonly applyError?: Error;
	readonly revertError?: Error;
}

function fakeRegistration(name: string, log: string[], options: FakeOptions = {}): Registration {
	return {
		name,
		async apply() {
			log.push(`apply:${name}`);
			if (options.applyError !== undefined) throw options.applyError;
		},
		async revert() {
			log.push(`revert:${name}`);
			if (options.revertError !== undefined) throw options.revertError;
		},
	};
}

describe("installPlugin", () => {
	test("fresh install writes every file and reports installed", async () => {
		const targetDir = join(base, "plugin");
		const result = await installPlugin({
			targetDir,
			files: filesOf({ "a.txt": "A", "nested/b.txt": "B" }),
			requiredFiles: ["a.txt"],
		});
		expect(result).toEqual({ ok: true, status: "installed" });
		expect(await readFile(join(targetDir, "a.txt"), "utf8")).toBe("A");
		expect(await readFile(join(targetDir, "nested", "b.txt"), "utf8")).toBe("B");
		expect(await readdir(base)).toEqual(["plugin"]);
	});

	test("repeat with identical files is unchanged and runs no registration", async () => {
		const targetDir = join(base, "plugin");
		const files = filesOf({ "a.txt": "A" });

		const firstLog: string[] = [];
		const first = await installPlugin({
			targetDir,
			files,
			requiredFiles: ["a.txt"],
			registrations: [fakeRegistration("r", firstLog)],
		});
		expect(first).toEqual({ ok: true, status: "installed" });
		expect(firstLog).toEqual(["apply:r"]);

		const secondLog: string[] = [];
		const second = await installPlugin({
			targetDir,
			files,
			requiredFiles: ["a.txt"],
			registrations: [fakeRegistration("r", secondLog)],
		});
		expect(second).toEqual({ ok: true, status: "unchanged" });
		expect(secondLog).toEqual([]);
	});

	test("missing required file fails, leaves the existing target byte-identical, and removes staging", async () => {
		const targetDir = join(base, "plugin");
		await mkdir(targetDir);
		await writeFile(join(targetDir, "keep.txt"), "original");

		const result = await installPlugin({
			targetDir,
			files: filesOf({ "a.txt": "A" }),
			requiredFiles: ["a.txt", "missing.txt"],
		});
		expect(result).toMatchObject({
			ok: false,
			error: { category: "install_failed", message: expect.stringContaining("missing.txt") },
		});
		expect(await readdir(targetDir)).toEqual(["keep.txt"]);
		expect(await readFile(join(targetDir, "keep.txt"), "utf8")).toBe("original");
		expect(await readdir(base)).toEqual(["plugin"]);
	});

	test("rejects a '..' path before any file is written", async () => {
		const targetDir = join(base, "plugin");
		const result = await installPlugin({
			targetDir,
			files: filesOf({ "../escape.txt": "x", "ok.txt": "y" }),
			requiredFiles: [],
		});
		expect(result).toMatchObject({ ok: false, error: { category: "install_failed" } });
		expect(await readdir(base)).toEqual([]);
	});

	test("a throwing registration reverts earlier registrations in reverse order and fails", async () => {
		const targetDir = join(base, "plugin");
		const log: string[] = [];
		const result = await installPlugin({
			targetDir,
			files: filesOf({ "a.txt": "A" }),
			requiredFiles: ["a.txt"],
			registrations: [
				fakeRegistration("first", log),
				fakeRegistration("second", log),
				fakeRegistration("third", log, { applyError: new Error("boom") }),
				fakeRegistration("fourth", log),
			],
		});
		expect(log).toEqual([
			"apply:first",
			"apply:second",
			"apply:third",
			"revert:second",
			"revert:first",
		]);
		expect(result).toMatchObject({
			ok: false,
			error: { category: "install_failed", message: "boom" },
		});
		expect(await readdir(base)).toEqual([]);
	});

	test("failure message is the thrown message without a stack trace", async () => {
		const result = await installPlugin({
			targetDir: join(base, "plugin"),
			files: filesOf({ "a.txt": "A" }),
			requiredFiles: ["a.txt"],
			registrations: [fakeRegistration("r", [], { applyError: new Error("boom") })],
		});
		if (result.ok) throw new Error("expected the install to fail");
		expect(result.error.message).toBe("boom");
		expect(result.error.message).not.toMatch(/\n\s+at /);
	});

	test("a failing revert is reported without stopping the other reverts", async () => {
		const targetDir = join(base, "plugin");
		const log: string[] = [];
		const result = await installPlugin({
			targetDir,
			files: filesOf({ "a.txt": "A" }),
			requiredFiles: ["a.txt"],
			registrations: [
				fakeRegistration("first", log, { revertError: new Error("revert-failed") }),
				fakeRegistration("second", log),
				fakeRegistration("third", log, { applyError: new Error("boom") }),
			],
		});
		expect(log).toEqual([
			"apply:first",
			"apply:second",
			"apply:third",
			"revert:second",
			"revert:first",
		]);
		expect(result).toMatchObject({
			ok: false,
			error: { message: 'boom; revert of "first" failed: revert-failed' },
		});
	});

	test("a failed registration restores the previous target directory", async () => {
		const targetDir = join(base, "plugin");
		await mkdir(targetDir);
		await writeFile(join(targetDir, "old.txt"), "old");

		const result = await installPlugin({
			targetDir,
			files: filesOf({ "new.txt": "new" }),
			requiredFiles: ["new.txt"],
			registrations: [fakeRegistration("only", [], { applyError: new Error("boom") })],
		});
		expect(result).toMatchObject({
			ok: false,
			error: { category: "install_failed", message: "boom" },
		});
		expect(await readdir(targetDir)).toEqual(["old.txt"]);
		expect(await readFile(join(targetDir, "old.txt"), "utf8")).toBe("old");
		expect(await readdir(base)).toEqual(["plugin"]);
	});
});
