// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { type AdapterCliDeps, renderResult, runAdapterCli } from "./cli.ts";

type ChildOutcome = { readonly exitCode: number; readonly stdout: string } | Error;

function fakeDeps(outcome: ChildOutcome, entryExists = true) {
	const runCalls: string[][] = [];
	const runEnvs: (Readonly<Record<string, string>> | undefined)[] = [];
	const entryPaths: string[] = [];
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
	};
	return { deps, runCalls, runEnvs, entryPaths };
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
