// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CliDeps, runRuntimeInstallCli } from "./cli.ts";
import { REGISTRY, scratchTree, SKILLS } from "./test.fixtures.ts";
import type { RuntimeDescriptor } from "./types.ts";

let scratch: string;
let home: string;
let clone: string;
let cwd: string;

beforeEach(() => {
	({ scratch, home, clone, cwd } = scratchTree());
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function deps(): CliDeps {
	return { runtimes: REGISTRY, cloneRoot: clone, home, cwd, env: {} };
}

function run(...argv: string[]) {
	return runRuntimeInstallCli(argv, deps());
}

const SKILLS_ROOT = () => join(home, ".fx-skills");

describe("usage", () => {
	test("is printed with exit 0 for --help and -h", async () => {
		for (const flag of ["--help", "-h"]) {
			const result = await run(flag);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toStartWith(
				"usage: ultrathink-runtime-install <install|uninstall|list>",
			);
			expect(result.stderr).toBe("");
		}
	});

	test("errors exit 2 with the reason on stderr and nothing on stdout", async () => {
		const cases: [string[], string][] = [
			[[], "missing command"],
			[["bogus"], "unknown command: bogus"],
			[["install"], "--runtime is required"],
			[["uninstall"], "--runtime is required"],
			[["install", "--runtime"], "--runtime needs a value"],
			[["install", "--runtime", "--dry-run"], "--runtime needs a value"],
			[["install", "--runtime="], "--runtime needs a value"],
			[["install", "--runtime", "a", "--runtime", "b"], "--runtime given twice"],
			[
				["install", "--runtime", "fx-skills", "--global", "--local"],
				"--global and --local are exclusive",
			],
			[["install", "--runtime", "fx-skills", "--frob"], "unknown argument: --frob"],
			[
				["install", "--runtime", "nope"],
				'unknown runtime "nope"; expected "all" or one of: fx-skills',
			],
			[["list", "--runtime", "nope"], 'unknown runtime "nope"'],
			[["uninstall", "--runtime", "nope"], 'unknown runtime "nope"'],
		];
		for (const [argv, reason] of cases) {
			const result = await run(...argv);
			expect(result.exitCode, argv.join(" ")).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toStartWith("usage: ultrathink-runtime-install");
			expect(result.stderr, argv.join(" ")).toContain(reason);
		}
		expect(readdirSync(home)).toEqual([]);
	});

	test("repeating the same scope flag is fine", async () => {
		const result = await run(
			"install",
			"--runtime",
			"fx-skills",
			"--dry-run",
			"--global",
			"--global",
		);
		expect(result.exitCode).toBe(0);
	});
});

describe("install and uninstall", () => {
	test("print one block per runtime and exit 0", async () => {
		const first = await run("install", "--runtime", "fx-skills");
		expect(first).toEqual({
			exitCode: 0,
			stdout: [
				`fx-skills: installed (${SKILLS_ROOT()})`,
				"  write skills/ultrathink-plan/SKILL.md",
				"  write skills/ultrathink-teach/SKILL.md",
				"",
			].join("\n"),
			stderr: "",
		});
		expect(existsSync(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"))).toBe(true);

		const again = await run("install", "--runtime=fx-skills");
		expect(again.stdout).toBe(`fx-skills: unchanged (${SKILLS_ROOT()})\n`);

		const removed = await run("uninstall", "--runtime", "fx-skills");
		expect(removed.exitCode).toBe(0);
		expect(removed.stdout).toBe(
			[
				`fx-skills: removed (${SKILLS_ROOT()})`,
				"  remove skills/ultrathink-plan/SKILL.md",
				"  remove skills/ultrathink-teach/SKILL.md",
				"",
			].join("\n"),
		);
		expect(existsSync(SKILLS_ROOT())).toBe(false);

		const never = await run("uninstall", "--runtime", "fx-skills");
		expect(never.stdout).toBe(`fx-skills: not-installed (${SKILLS_ROOT()})\n`);
	});

	test("--dry-run reports what would change and writes nothing", async () => {
		const result = await run("install", "--runtime", "fx-both", "--dry-run");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toStartWith(`fx-both: would-install (${join(home, ".fx-both")})\n`);
		expect(result.stdout).toContain("  write commands/ultrathink-off.md\n");
		expect(readdirSync(home)).toEqual([]);

		await run("install", "--runtime", "fx-both");
		const gone = await run("uninstall", "--runtime", "fx-both", "--dry-run");
		expect(gone.stdout).toStartWith(`fx-both: would-remove (${join(home, ".fx-both")})\n`);
		expect(existsSync(join(home, ".fx-both/commands/ultrathink-off.md"))).toBe(true);
	});

	test("--local installs below the working directory", async () => {
		const result = await run("install", "--runtime", "fx-wf", "--local");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toStartWith(`fx-wf: installed (${join(cwd, ".fx-wf")})\n`);
		expect(existsSync(join(cwd, ".fx-wf/workflows/ultrathink-plan.md"))).toBe(true);
	});

	test("all lists skipped runtimes with the reason and exits 0", async () => {
		mkdirSync(join(home, ".fx-both"));
		const result = await run("install", "--runtime", "all");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`fx-both: installed (${join(home, ".fx-both")})\n`);
		expect(result.stdout).toContain(`fx-skills: skipped (${SKILLS_ROOT()})\n  note: not detected:`);
		expect(result.stdout).toContain("fx-wf: skipped\n  note: fx-wf installs into a workspace only");
	});

	test("a runtime that fails exits 1 and says why", async () => {
		const result = await run("install", "--runtime", "fx-wf");
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe(
			"fx-wf: failed\n  error: fx-wf installs into a workspace only; run with --local\n",
		);
	});

	test("an empty registry prints nothing", async () => {
		const result = await runRuntimeInstallCli(["install", "--runtime", "all"], {
			...deps(),
			runtimes: [],
		});
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
	});

	test("an unexpected error exits 1 with a one-line message", async () => {
		const exploding: RuntimeDescriptor = {
			...SKILLS,
			get id(): string {
				throw new Error("registry is unreadable");
			},
		};
		const result = await runRuntimeInstallCli(["list"], { ...deps(), runtimes: [exploding] });
		expect(result).toEqual({
			exitCode: 1,
			stdout: "",
			stderr: "ultrathink-runtime-install: registry is unreadable\n",
		});
	});
});

describe("list", () => {
	test("shows every runtime, one per line, with its state", async () => {
		await run("install", "--runtime", "fx-skills");
		const result = await run("list");
		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines.map((line) => line.split(/\s+/)[0])).toEqual([
			"fx-skills",
			"fx-both",
			"fx-toml",
			"fx-wf",
			"fx-global",
		]);
		expect(lines[0]).toContain("installed, 2 files");
		expect(lines[0]).toEndWith(SKILLS_ROOT());
		expect(lines[1]).toContain("not installed");
		expect(lines[3]).toEndWith("fx-wf installs into a workspace only; run with --local");
	});

	test("reports drift and takes one runtime", async () => {
		await run("install", "--runtime", "fx-skills");
		rmSync(join(SKILLS_ROOT(), "skills/ultrathink-teach/SKILL.md"));
		const result = await run("list", "--runtime", "fx-skills");
		expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(result.stdout).toContain("installed, 2 files, 1 missing");
	});
});

describe("bin/ultrathink-runtime-install", () => {
	test("starts the CLI", async () => {
		const bin = resolve(import.meta.dir, "../../bin/ultrathink-runtime-install");
		const child = Bun.spawn(["sh", bin, "--help"], {
			env: { ...process.env, BUN: process.execPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		expect(stdout).toStartWith("usage: ultrathink-runtime-install <install|uninstall|list>");
	}, 60_000);
});
