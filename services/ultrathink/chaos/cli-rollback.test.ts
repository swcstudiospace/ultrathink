// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config.ts";
import { makeTempDir } from "../test.helpers.ts";
import { type CliDeps, historyPathOf, runCli, runRollback } from "./cli.ts";
import { readHistory } from "./history.ts";
import type { HttpFetch } from "./observe.ts";

const EXPERIMENTS = join(import.meta.dir, "experiments");
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("rollback deadline", () => {
	test("a rollback that never exits is bounded and recorded as failed", async () => {
		const historyPath = join(makeTempDir("chaos-rollback-", roots), "history.jsonl");
		const fetchImpl: HttpFetch = async (url) => {
			const path = new URL(url).pathname;
			return new Response("{}", { status: path === "/readyz" ? 503 : 200 });
		};
		const out: string[] = [];
		const deps: CliDeps = {
			stdout: (text) => out.push(text),
			stderr: () => undefined,
			env: { ULTRATHINK_CHAOS_ENV: "staging" },
			fetch: fetchImpl,
			exec: (argv) => runRollback(argv, 50),
			confirm: async () => undefined,
			now: () => new Date("2026-10-21T00:00:00.000Z"),
			sleep: () => Promise.resolve(),
			templatesDir: EXPERIMENTS,
			historyPath,
		};

		const started = Date.now();
		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"http://127.0.0.1:9",
				"--rollback-argv",
				JSON.stringify(["sleep", "60"]),
			],
			deps,
		);

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(code).toBe(1);
		const { records } = readHistory(historyPath);
		expect(records).toHaveLength(1);
		expect(records[0]?.rollback).toBe("failed");
		expect(records[0]?.rollbackExitCode).toBe(124);
		expect(out.join("")).toContain("rollback failed (exit 124)");
	});

	test("a rollback that exits before its deadline keeps its exit code", async () => {
		expect(await runRollback(["sh", "-c", "exit 3"], 5_000)).toBe(3);
	});
});

describe("state directory", () => {
	test("a relative ULTRATHINK_STATE_DIR is refused the way the service refuses it", () => {
		const message = "ULTRATHINK_STATE_DIR must be an absolute path";
		expect(() => historyPathOf({ ULTRATHINK_STATE_DIR: "relative/dir" })).toThrow(message);
		expect(() => loadConfig({ ULTRATHINK_STATE_DIR: "relative/dir" })).toThrow(message);
	});

	test("a ULTRATHINK_STATE_DIR inside a .planning tree is refused", () => {
		expect(() => historyPathOf({ ULTRATHINK_STATE_DIR: "/srv/repo/.planning/state" })).toThrow(
			"must not point into a .planning tree",
		);
	});

	test("unset and blank use the service default; a trailing slash is dropped", () => {
		const defaults = join("/var/lib/ultrathink", "chaos", "history.jsonl");
		expect(historyPathOf({})).toBe(defaults);
		expect(historyPathOf({ ULTRATHINK_STATE_DIR: "   " })).toBe(defaults);
		expect(historyPathOf({ ULTRATHINK_STATE_DIR: "/srv/ut/" })).toBe(
			join("/srv/ut", "chaos", "history.jsonl"),
		);
	});
});
