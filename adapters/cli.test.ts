// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AdapterCliDeps,
	childEnvironment,
	renderResult,
	runAdapterCli,
	runInstallVerb,
} from "./cli.ts";

type ChildOutcome = { readonly exitCode: number; readonly stdout: string } | Error;

/** Host version the fake reader reports by default: above every host floor. */
const ABOVE_FLOOR = "99.0.0";

function fakeDeps(outcome: ChildOutcome, entryExists = true, version: string | null = ABOVE_FLOOR) {
	const runCalls: string[][] = [];
	const runEnvs: (Readonly<Record<string, string>> | undefined)[] = [];
	const entryPaths: string[] = [];
	const versionCalls: string[] = [];
	const deps: AdapterCliDeps = {
		runner: {
			async run(argv, env) {
				runCalls.push([...argv]);
				runEnvs.push(env);
				if (outcome instanceof Error) throw outcome;
				return outcome;
			},
		},
		entry: {
			exists(path) {
				entryPaths.push(path);
				return entryExists;
			},
		},
		readVersion: async (command) => {
			versionCalls.push(command);
			return version;
		},
	};
	return { deps, runCalls, runEnvs, entryPaths, versionCalls };
}

describe("runAdapterCli: dispatch", () => {
	test("valid host and verb returns the ok envelope", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "engine says hi\n" });
		const result = await runAdapterCli(["claude-code", "quick"], deps);
		expect(result.exitCode).toBe(0);
		expect(result.raw).toBe(false);
		expect(result.output).toEqual({ ok: true, stdout: "engine says hi\n" });
		expect(runCalls).toEqual([["quick"]]);
	});

	test("every known host runs with its own entry path", async () => {
		const expected: Record<string, string> = {
			"claude-code": "hooks/hooks.json",
			"grok-build": "hooks/hooks.json",
			muse: "hooks/muse-prompt",
			hermes: "hosts/hermes/bridge.py",
			"prime-agent": "hosts/prime-agent/SKILL.md",
		};
		for (const [host, entryPath] of Object.entries(expected)) {
			const { deps, entryPaths } = fakeDeps({ exitCode: 0, stdout: "" });
			const result = await runAdapterCli([host, "status"], deps);
			expect(result.output.ok).toBe(true);
			expect(entryPaths).toEqual([entryPath]);
		}
	});

	test("unknown host returns invalid_input without running the runner", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" });
		const result = await runAdapterCli(["nope", "quick"], deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown host: nope" },
		});
		expect(runCalls).toEqual([]);
	});

	test("prototype-chain host name is rejected as invalid_input", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" });
		const result = await runAdapterCli(["__proto__", "quick"], deps);
		expect(result.output.ok).toBe(false);
		expect(runCalls).toEqual([]);
	});

	test("unknown verb returns invalid_input without running the runner", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" });
		const result = await runAdapterCli(["claude-code", "ship"], deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown verb: ship" },
		});
		expect(runCalls).toEqual([]);
	});

	test("missing verb returns invalid_input", async () => {
		const { deps } = fakeDeps({ exitCode: 0, stdout: "" });
		const result = await runAdapterCli(["claude-code"], deps);
		expect(result.output).toMatchObject({ ok: false, error: { category: "invalid_input" } });
	});

	test("missing entry returns capability_missing without running the runner", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" }, false);
		const result = await runAdapterCli(["claude-code", "quick"], deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host entry point missing" },
		});
		expect(runCalls).toEqual([]);
	});

	test("non-zero child exit returns internal with a fixed message", async () => {
		const { deps } = fakeDeps({ exitCode: 3, stdout: "secret detail" });
		const result = await runAdapterCli(["muse", "on"], deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
	});

	test("a thrown runner error returns internal and never leaks its text", async () => {
		const { deps } = fakeDeps(new Error("spawn bin/ultrathink ENOENT /home/u/.token=abc"));
		const result = await runAdapterCli(["hermes", "status"], deps);
		expect(result.output).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result.output)).not.toContain("abc");
	});
});

describe("runAdapterCli: pass-through arguments", () => {
	test("extra args reach the runner unchanged, in order, after the verb", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" });
		const extra = ["--session", "sess-42", "a b", "--name=$HOME;rm", "", "-x"];
		const result = await runAdapterCli(["claude-code", "skip", ...extra], deps);
		expect(result.output.ok).toBe(true);
		expect(runCalls).toEqual([["skip", ...extra]]);
	});

	test("track on|off forwards its subcommand", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" });
		await runAdapterCli(["grok-build", "track", "off"], deps);
		expect(runCalls).toEqual([["track", "off"]]);
	});

	test("extra args are not forwarded when the entry check fails", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" }, false);
		await runAdapterCli(["claude-code", "skip", "--session", "x"], deps);
		expect(runCalls).toEqual([]);
	});
});

describe("runAdapterCli: host environment", () => {
	test("prime-agent runner receives ULTRATHINK_HOST=prime-agent", async () => {
		const { deps, runEnvs } = fakeDeps({ exitCode: 0, stdout: "" });
		await runAdapterCli(["prime-agent", "status"], deps);
		expect(runEnvs).toEqual([{ ULTRATHINK_HOST: "prime-agent" }]);
	});

	test("claude-code runner does not get ULTRATHINK_HOST from the CLI", async () => {
		const { deps, runEnvs } = fakeDeps({ exitCode: 0, stdout: "" });
		await runAdapterCli(["claude-code", "status"], deps);
		expect(runEnvs).toEqual([undefined]);
	});
});

describe("runAdapterCli: host version", () => {
	test("a version above the floor lets the verb run", async () => {
		const { deps, runCalls, versionCalls } = fakeDeps(
			{ exitCode: 0, stdout: "ran\n" },
			true,
			"claude 2.1.400 (Claude Code)",
		);
		const result = await runAdapterCli(["claude-code", "quick"], deps);
		expect(result.output).toEqual({ ok: true, stdout: "ran\n" });
		expect(versionCalls).toEqual(["claude"]);
		expect(runCalls).toEqual([["quick"]]);
	});

	test("a version below the floor is refused with the adapter's refusal and never runs", async () => {
		// Each adapter words and categorizes its own version refusal; the CLI passes it through.
		const cases: {
			host: string;
			version: string;
			category: "capability_missing" | "version_mismatch";
			message: string;
		}[] = [
			{
				host: "claude-code",
				version: "claude 2.1.321 (Claude Code)",
				category: "capability_missing",
				message: "host version below floor 2.1.322",
			},
			{
				host: "grok-build",
				version: "1.0.76",
				category: "capability_missing",
				message: "host version below minimum 1.0.77",
			},
			{
				host: "muse",
				version: "muse 1.4.13",
				category: "version_mismatch",
				message: "host version is below the minimum 1.4.14",
			},
			{
				host: "hermes",
				version: "hermes v0.23.0",
				category: "version_mismatch",
				message: "host version below v0.23.1",
			},
			{
				host: "prime-agent",
				version: "prime-agent 0.10.1",
				category: "version_mismatch",
				message: "host version below floor 0.10.2",
			},
		];
		for (const { host, version, category, message } of cases) {
			const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "ran" }, true, version);
			const result = await runAdapterCli([host, "quick"], deps);
			expect(result.exitCode).toBe(1);
			expect(result.output).toEqual({ ok: false, error: { category, message } });
			expect(runCalls).toEqual([]);
		}
	});

	test("an unreadable version is refused fail-closed without running", async () => {
		// The version is passed as null, which every adapter refuses; undefined would fall back to
		// the recorded version and let the host run.
		const cases: {
			host: string;
			category: "capability_missing" | "version_mismatch";
			message: string;
		}[] = [
			{ host: "claude-code", category: "capability_missing", message: "host version unknown" },
			{
				host: "grok-build",
				category: "capability_missing",
				message: "host version unknown; minimum 1.0.77",
			},
			{
				host: "muse",
				category: "version_mismatch",
				message: "host version is unknown; minimum is 1.4.14",
			},
			{ host: "hermes", category: "version_mismatch", message: "host version unknown" },
			{ host: "prime-agent", category: "version_mismatch", message: "host version unknown" },
		];
		for (const { host, category, message } of cases) {
			for (const version of [null, "", "dev build"]) {
				const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "ran" }, true, version);
				const result = await runAdapterCli([host, "quick"], deps);
				expect(result.output).toEqual({ ok: false, error: { category, message } });
				expect(runCalls).toEqual([]);
			}
		}
	});

	test("a reader that throws is refused fail-closed and never leaks its text", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "ran" });
		const throwing: AdapterCliDeps = {
			...deps,
			readVersion: async () => {
				throw new Error("spawn grok ENOENT /home/u/.token=abc");
			},
		};
		const result = await runAdapterCli(["grok-build", "quick"], throwing);
		expect(result.output).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host version unknown; minimum 1.0.77" },
		});
		expect(JSON.stringify(result.output)).not.toContain("abc");
		expect(runCalls).toEqual([]);
	});

	test("each host reads its own --version command", async () => {
		const expected: Record<string, string> = {
			"claude-code": "claude",
			"grok-build": "grok",
			muse: "muse",
			hermes: "hermes",
			"prime-agent": "prime-agent",
		};
		for (const [host, command] of Object.entries(expected)) {
			const { deps, versionCalls } = fakeDeps({ exitCode: 0, stdout: "" });
			await runAdapterCli([host, "status"], deps);
			expect(versionCalls).toEqual([command]);
		}
	});
});

describe("childEnvironment", () => {
	test("drops a parent variable that is not on the allowlist", () => {
		const env = childEnvironment({ PATH: "/bin", SECRET_OTHER: "leak" });
		expect(env).toEqual({ PATH: "/bin" });
	});

	test("keeps every listed exact name", () => {
		const names = [
			"PATH",
			"HOME",
			"USER",
			"LANG",
			"LC_ALL",
			"LC_CTYPE",
			"TERM",
			"TMPDIR",
			"SHELL",
			"BUN",
			"BUN_INSTALL",
			"ANTHROPIC_API_KEY",
			"OPENROUTER_API_KEY",
			"AI_GATEWAY_API_KEY",
			"SUBSTRATE_TOKEN",
			"RAGFLOW_API_KEY",
			"HINDSIGHT_API_KEY",
			"PRIME_AGENT_CODING_AGENT_DIR",
			"CLAUDE_CONFIG_DIR",
			"CLAUDE_PLUGIN_ROOT",
			"CLAUDE_SESSION_ID",
		];
		for (const name of names) {
			expect(childEnvironment({ [name]: `value-of-${name}` })).toEqual({
				[name]: `value-of-${name}`,
			});
		}
	});

	test("keeps any ULTRATHINK_ prefixed variable", () => {
		const env = childEnvironment({ ULTRATHINK_OPENROUTER_KEY: "key", ULTRATHINK_HOST: "x" });
		expect(env).toEqual({ ULTRATHINK_OPENROUTER_KEY: "key", ULTRATHINK_HOST: "x" });
	});

	test("a host env entry overrides a parent value of the same name", () => {
		const env = childEnvironment(
			{ PATH: "/bin", ULTRATHINK_HOST: "parent" },
			{ ULTRATHINK_HOST: "prime-agent" },
		);
		expect(env).toEqual({ PATH: "/bin", ULTRATHINK_HOST: "prime-agent" });
	});

	test("undefined parent values are not emitted", () => {
		const env = childEnvironment({ PATH: undefined, HOME: "/root" });
		expect(Object.keys(env)).toEqual(["HOME"]);
	});
});

describe("runAdapterCli: --raw", () => {
	test("--raw is accepted in any position and removed before the verb is read", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" });
		const first = await runAdapterCli(["--raw", "claude-code", "status"], deps);
		const middle = await runAdapterCli(["claude-code", "--raw", "status"], deps);
		expect(first.raw).toBe(true);
		expect(middle.raw).toBe(true);
		expect(runCalls).toEqual([["status"], ["status"]]);
	});

	test("--raw with success renders only the child's stdout", async () => {
		const { deps } = fakeDeps({ exitCode: 0, stdout: "bare line\n" });
		const result = await runAdapterCli(["--raw", "claude-code", "status"], deps);
		expect(result.exitCode).toBe(0);
		expect(renderResult(result)).toEqual({ stdout: "bare line\n", stderr: "" });
	});

	test("--raw prints a 5000-character stdout in full", async () => {
		const stdout = "x".repeat(5000);
		const { deps } = fakeDeps({ exitCode: 0, stdout });
		const result = await runAdapterCli(["--raw", "claude-code", "status"], deps);
		expect(renderResult(result)).toEqual({ stdout, stderr: "" });
	});

	test("--raw with a non-zero child exit exits with that code and prints no stdout", async () => {
		const { deps } = fakeDeps({ exitCode: 3, stdout: "secret detail" });
		const result = await runAdapterCli(["--raw", "claude-code", "on"], deps);
		expect(result.exitCode).toBe(3);
		expect(renderResult(result)).toEqual({ stdout: "", stderr: "command failed\n" });
	});

	test("--raw error cases print the message to stderr and exit 1", async () => {
		const { deps } = fakeDeps({ exitCode: 0, stdout: "" });
		const result = await runAdapterCli(["--raw", "nope", "quick"], deps);
		expect(result.exitCode).toBe(1);
		expect(renderResult(result)).toEqual({
			stdout: "",
			stderr: "unknown host: nope\n",
		});
	});

	test("--raw with a missing entry exits 1 with the message on stderr", async () => {
		const { deps, runCalls } = fakeDeps({ exitCode: 0, stdout: "" }, false);
		const result = await runAdapterCli(["--raw", "claude-code", "quick"], deps);
		expect(result.exitCode).toBe(1);
		expect(renderResult(result).stderr).toBe("host entry point missing\n");
		expect(runCalls).toEqual([]);
	});
});

describe("renderResult: default envelope", () => {
	test("without --raw the JSON envelope is unchanged on success", async () => {
		const { deps } = fakeDeps({ exitCode: 0, stdout: "line\n" });
		const result = await runAdapterCli(["claude-code", "status"], deps);
		expect(renderResult(result)).toEqual({
			stdout: '{"ok":true,"stdout":"line\\n"}\n',
			stderr: "",
		});
	});

	test("without --raw a child failure is still exit 1 with the JSON envelope", async () => {
		const { deps } = fakeDeps({ exitCode: 3, stdout: "" });
		const result = await runAdapterCli(["claude-code", "status"], deps);
		expect(result.exitCode).toBe(1);
		expect(renderResult(result)).toEqual({
			stdout: '{"ok":false,"error":{"category":"internal","message":"command failed"}}\n',
			stderr: "",
		});
	});

	test("without --raw the envelope stdout is cut to 4096 characters", async () => {
		const { deps } = fakeDeps({ exitCode: 0, stdout: "x".repeat(5000) });
		const result = await runAdapterCli(["claude-code", "status"], deps);
		expect(renderResult(result)).toEqual({
			stdout: `${JSON.stringify({ ok: true, stdout: "x".repeat(4096) })}\n`,
			stderr: "",
		});
	});
});

describe("runInstallVerb: install prime-agent", () => {
	const SKILL_TEXT = "# ultrathink\n";
	const scratch: string[] = [];

	afterEach(async () => {
		await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function scratchDir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "ultrathink-install-"));
		scratch.push(dir);
		return dir;
	}

	/** A temp repo root with hosts/prime-agent, holding SKILL.md only when asked. */
	async function sourceRepo(withSkill: boolean): Promise<string> {
		const repo = await scratchDir();
		await mkdir(join(repo, "hosts", "prime-agent"), { recursive: true });
		if (withSkill) await writeFile(join(repo, "hosts", "prime-agent", "SKILL.md"), SKILL_TEXT);
		return repo;
	}

	test("missing --skills-dir exits 2 with a one-line usage message", async () => {
		const source = await sourceRepo(true);
		const result = await runInstallVerb(["prime-agent", "--source", source]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/^usage: ultrathink-adapter install prime-agent /);
		expect(result.stderr.trimEnd().includes("\n")).toBe(false);
	});

	test("relative --source exits 2 and installs nothing", async () => {
		const skillsDir = await scratchDir();
		const result = await runInstallVerb([
			"prime-agent",
			"--source",
			"relative/repo",
			"--skills-dir",
			skillsDir,
		]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("--source must be an absolute path");
		expect(existsSync(join(skillsDir, "ultrathink"))).toBe(false);
	});

	test("an unknown install target is a usage error", async () => {
		const result = await runInstallVerb(["claude-code", "--source", "/x", "--skills-dir", "/y"]);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown install target: claude-code");
	});

	test("a valid run installs the skill and exits 0", async () => {
		const source = await sourceRepo(true);
		const skillsDir = await scratchDir();
		const result = await runInstallVerb([
			"prime-agent",
			"--source",
			source,
			"--skills-dir",
			skillsDir,
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: "installed" });
		expect(await readFile(join(skillsDir, "ultrathink", "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
	});

	test("a source without SKILL.md exits 1 with install_failed and leaves no target", async () => {
		const source = await sourceRepo(false);
		const skillsDir = await scratchDir();
		const result = await runInstallVerb([
			"prime-agent",
			"--source",
			source,
			"--skills-dir",
			skillsDir,
		]);
		expect(result.exitCode).toBe(1);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.ok).toBe(false);
		expect(parsed.error.category).toBe("install_failed");
		expect(existsSync(join(skillsDir, "ultrathink"))).toBe(false);
	});
});
