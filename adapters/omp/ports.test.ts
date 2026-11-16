// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpClock, createOmpFileSystem, createOmpProcess } from "./ports.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-ports-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected promise to reject");
}

describe("createOmpFileSystem", () => {
	test("read returns what atomicWrite stored", async () => {
		const fs = createOmpFileSystem(dir);
		await fs.atomicWrite("notes/state.md", "hello");
		await expect(fs.read("notes/state.md")).resolves.toBe("hello");
	});

	test("atomicWrite leaves no temp file behind after success", async () => {
		const fs = createOmpFileSystem(dir);
		await fs.atomicWrite("state.md", "content");
		expect(await readdir(dir)).toEqual(["state.md"]);
	});

	test("a '..' path that escapes root is rejected, and one that stays inside is accepted", async () => {
		const fs = createOmpFileSystem(dir);
		await fs.atomicWrite("STATE.md", "ok");

		const readError = await caught(fs.read("../../etc/passwd"));
		expect(readError).toMatchObject({ category: "permission_denied" });
		expect((readError as Error).message).toContain("outside root");

		const writeError = await caught(fs.atomicWrite("../escape.md", "x"));
		expect(writeError).toMatchObject({ category: "permission_denied" });
		expect((writeError as Error).message).toContain("outside root");

		await expect(fs.read("notes/../STATE.md")).resolves.toBe("ok");
	});

	test("list returns sorted entry names and stat describes a file", async () => {
		const fs = createOmpFileSystem(dir);
		await fs.atomicWrite("b.md", "bb");
		await fs.atomicWrite("a.md", "a");

		await expect(fs.list(".")).resolves.toEqual(["a.md", "b.md"]);
		await expect(fs.stat("b.md")).resolves.toMatchObject({ size: 2, isDirectory: false });
		await expect(fs.stat(".")).resolves.toMatchObject({ isDirectory: true });
	});

	test("read of a missing file rejects with a categorized error", async () => {
		const fs = createOmpFileSystem(dir);
		await expect(fs.read("missing.md")).rejects.toMatchObject({ category: "invalid_input" });
	});

	test("a pre-existing file outside root is never reachable through an absolute path", async () => {
		const outside = join(dir, "..", `outside-${Date.now()}.txt`);
		await writeFile(outside, "secret");
		try {
			const root = join(dir, "root");
			const fs = createOmpFileSystem(root);
			const error = await caught(fs.read(outside));
			expect(error).toMatchObject({ category: "permission_denied" });
		} finally {
			await rm(outside, { force: true });
		}
	});
});

describe("createOmpClock", () => {
	test("now() returns the current epoch milliseconds", () => {
		const before = Date.now();
		const value = createOmpClock().now();
		const after = Date.now();
		expect(value).toBeGreaterThanOrEqual(before);
		expect(value).toBeLessThanOrEqual(after);
	});
});

describe("createOmpProcess", () => {
	test("spawn of a non-allowlisted command is rejected", async () => {
		const processPort = createOmpProcess(["node"]);
		const error = await caught(processPort.spawn({ command: "sh", args: ["-c", "echo hi"] }));
		expect(error).toMatchObject({ category: "permission_denied" });
	});

	test("a path-qualified command is rejected even when its basename is allowlisted", async () => {
		const processPort = createOmpProcess(["node"]);
		const error = await caught(
			processPort.spawn({ command: "/usr/bin/node", args: ["-e", "process.stdout.write('x')"] }),
		);
		expect(error).toMatchObject({ category: "permission_denied" });
	});

	test("spawn of an allowlisted command returns its stdout and exit code", async () => {
		const processPort = createOmpProcess(["node"]);
		await expect(
			processPort.spawn({ command: "node", args: ["-e", "process.stdout.write('omp-ok')"] }),
		).resolves.toEqual({ exitCode: 0, stdout: "omp-ok", stderr: "" });
	});

	test("a non-zero exit is returned as data rather than thrown", async () => {
		const processPort = createOmpProcess(["node"]);
		await expect(
			processPort.spawn({ command: "node", args: ["-e", "process.exit(3)"] }),
		).resolves.toMatchObject({ exitCode: 3 });
	});

	test("cwd is honored for allowlisted commands", async () => {
		const processPort = createOmpProcess(["node"]);
		const result = await processPort.spawn({
			command: "node",
			args: ["-e", "process.stdout.write(process.cwd())"],
			cwd: dir,
		});
		expect(result.stdout).toBe(dir);
	});
});
