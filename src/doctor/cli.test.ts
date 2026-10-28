// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeStore } from "../mcp/store.ts";
import { runDoctorCommand } from "./cli.ts";
import type { DoctorDeps, DoctorReport } from "./types.ts";

const FAKE_KEY = "sk-test-not-a-real-key-4242424242";
const USAGE = "Usage: ultrathink doctor [--json]";

describe("runDoctorCommand", () => {
	let dir: string;
	let deps: Partial<DoctorDeps>;

	function projectConfig(content: string): void {
		const path = join(dir, "project", ".claude", "ultrathink.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-cli-"));
		mkdirSync(join(dir, "project"));
		deps = {
			env: {
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "xdg"),
				CLAUDE_CONFIG_DIR: join(dir, "claude"),
				ULTRATHINK_STATE_DIR: join(dir, "state"),
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				GH_CONFIG_DIR: join(dir, "gh"),
				// The stack section runs the real probes: switch off the two that would otherwise look at the machine.
				ULTRATHINK_DECISIONS: "0",
				ULTRATHINK_REALM: "off",
			},
			cwd: join(dir, "project"),
			now: () => 1_800_000_000_000,
			which: (command) =>
				["git", "gh", "python3", "claude"].includes(command) ? `/usr/bin/${command}` : undefined,
			bunVersion: "1.2.0",
			runVersion: () => "Python 3.12.1",
			claudeVersion: () => "2.1.300 (Claude Code)",
			claudeAuth: () =>
				JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }),
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a healthy machine exits 0 and the text report has the nine sections and a summary", async () => {
		const { output, exitCode } = await runDoctorCommand([], deps);
		expect(exitCode).toBe(0);
		const lines = output.split("\n");
		expect(lines[0]).toBe("ultrathink doctor");
		expect(lines.filter((line) => /^[a-z]+$/.test(line))).toEqual([
			"runtime",
			"config",
			"credentials",
			"env",
			"inference",
			"state",
			"memory",
			"pstack",
			"stack",
		]);
		expect(lines.at(-1)).toBe("0 errors, 0 warnings");
		expect(output).not.toEndWith("\n");
	});

	test("the claude probes never hand the Jev key variables to the child", async () => {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const seenFile = join(dir, "probe-env.log");
		// A leaf script: it must not call `claude` again through PATH. It dumps its whole environment so a leaked name cannot hide.
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh\nenv >> "${seenFile}"\nif [ "$1" = "--version" ]; then echo "2.1.308 (Claude Code)"; else echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; fi\n`,
			{ mode: 0o755 },
		);
		const planted = "sk-or-v1-UTTESTKEY-0123456789abcdef";
		const plantedGateway = "vck_UTTESTGATEWAYKEY0123456789abcdef";
		const names = [
			"PATH",
			"ULTRATHINK_OPENROUTER_KEY",
			"OPENROUTER_API_KEY",
			"AI_GATEWAY_API_KEY",
			"UT_TEST_PLANTED",
		];
		const saved = names.map((name) => process.env[name]);
		process.env.PATH = `${bin}:${saved[0] ?? ""}`;
		process.env.ULTRATHINK_OPENROUTER_KEY = planted;
		process.env.OPENROUTER_API_KEY = planted;
		process.env.AI_GATEWAY_API_KEY = plantedGateway;
		process.env.UT_TEST_PLANTED = "1";
		// The probes are production deps: an explicit `undefined` override would replace them, so leave both keys out.
		const { claudeVersion: _version, claudeAuth: _auth, ...rest } = deps;
		try {
			await runDoctorCommand([], {
				...rest,
				env: {
					...deps.env,
					PATH: process.env.PATH,
					ULTRATHINK_OPENROUTER_KEY: planted,
					OPENROUTER_API_KEY: planted,
					AI_GATEWAY_API_KEY: plantedGateway,
					UT_TEST_PLANTED: "1",
				},
			});
		} finally {
			names.forEach((name, i) => {
				const value = saved[i];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			});
		}
		const log = readFileSync(seenFile, "utf8");
		// The control proves the stub ran with the inherited environment, so the absences below are not vacuous.
		expect(log).toContain("UT_TEST_PLANTED=1");
		expect(log).not.toContain("ULTRATHINK_OPENROUTER_KEY");
		expect(log).not.toContain("OPENROUTER_API_KEY");
		expect(log).not.toContain("AI_GATEWAY_API_KEY");
		expect(log).not.toContain(planted);
		expect(log).not.toContain(plantedGateway);
	});

	test("the python version probe never hands the Jev key variables to the child", async () => {
		const bin = join(dir, "bin-python");
		mkdirSync(bin);
		const seenFile = join(dir, "python-env.log");
		writeFileSync(join(bin, "python3"), `#!/bin/sh\nenv >> "${seenFile}"\necho "Python 3.12.1"\n`, {
			mode: 0o755,
		});
		const planted = "sk-or-v1-CANARYCANARYCANARY1234";
		const names = [
			"PATH",
			"ULTRATHINK_OPENROUTER_KEY",
			"OPENROUTER_API_KEY",
			"AI_GATEWAY_API_KEY",
			"UT_TEST_PLANTED",
		];
		const saved = names.map((name) => process.env[name]);
		process.env.PATH = `${bin}:${saved[0] ?? ""}`;
		process.env.ULTRATHINK_OPENROUTER_KEY = planted;
		process.env.OPENROUTER_API_KEY = `${planted}B`;
		process.env.AI_GATEWAY_API_KEY = `${planted}C`;
		process.env.UT_TEST_PLANTED = "1";
		// runVersion is a production dep: leave the key out so the real probe runs.
		const { runVersion: _runVersion, ...rest } = deps;
		try {
			await runDoctorCommand([], { ...rest });
		} finally {
			names.forEach((name, i) => {
				const value = saved[i];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			});
		}
		const log = readFileSync(seenFile, "utf8");
		// The control proves the stub ran with the inherited environment, so the absences below are not vacuous.
		expect(log).toContain("UT_TEST_PLANTED=1");
		expect(log).toContain("PATH=");
		expect(log).not.toContain("ULTRATHINK_OPENROUTER_KEY");
		expect(log).not.toContain("OPENROUTER_API_KEY");
		expect(log).not.toContain("AI_GATEWAY_API_KEY");
		expect(log).not.toContain("CANARYCANARY");
	});

	test("the text output is identical across runs with a fixed clock", async () => {
		const first = await runDoctorCommand([], deps);
		const second = await runDoctorCommand([], deps);
		expect(second).toEqual(first);
	});

	test("a warning alone keeps exit 0 and is counted", async () => {
		projectConfig(`{"ship":{"autoMerg":true}}`);
		const { output, exitCode } = await runDoctorCommand([], deps);
		expect(exitCode).toBe(0);
		expect(output).toContain("  ! project config: unknown key ship.autoMerg");
		expect(output).toContain("      fix: Did you mean ship.autoMerge?");
		expect(output.split("\n").at(-1)).toBe("0 errors, 1 warning");
	});

	test("an error finding exits 1", async () => {
		projectConfig("{ not json");
		const { output, exitCode } = await runDoctorCommand([], deps);
		expect(exitCode).toBe(1);
		expect(output).toContain("  ✗ project config: not valid JSON; every key in it is ignored");
		expect(output.split("\n").at(-1)).toBe("1 error, 0 warnings");
	});

	test("a missing git is an error too", async () => {
		const { exitCode, output } = await runDoctorCommand([], { ...deps, which: () => undefined });
		expect(exitCode).toBe(1);
		expect(output).toContain("git not found on PATH");
	});

	const BAD_ARGUMENTS: string[][] = [["--bogus"], ["check"], ["--json", "extra"], ["-j"]];
	for (const args of BAD_ARGUMENTS) {
		test(`${args.join(" ")} is a usage error`, async () => {
			expect(await runDoctorCommand(args, deps)).toEqual({ output: USAGE, exitCode: 2 });
		});
	}

	test("--json prints one stable object whose ok matches the exit code", async () => {
		projectConfig(`{"shipp":{}}`);
		const { output, exitCode } = await runDoctorCommand(["--json"], deps);
		expect(exitCode).toBe(0);
		const report: DoctorReport = JSON.parse(output);
		expect(Object.keys(report)).toEqual(["ok", "summary", "findings"]);
		expect(report.ok).toBe(true);
		expect(report.summary).toMatchObject({ error: 0, warn: 1 });
		const order = [
			"runtime",
			"config",
			"credentials",
			"env",
			"inference",
			"state",
			"memory",
			"pstack",
			"stack",
		];
		const sections = report.findings.map((finding) => finding.section);
		expect(sections).toEqual([...sections].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
		expect(sections).toContain("inference");
		const typo = report.findings.find(
			(finding) => finding.id === "config.project.unknown-section.shipp",
		);
		expect(typo).toMatchObject({ section: "config", level: "warn", fix: "Did you mean ship?" });

		projectConfig("[");
		const failing = await runDoctorCommand(["--json"], deps);
		expect(failing.exitCode).toBe(1);
		expect(JSON.parse(failing.output)).toMatchObject({ ok: false });
	});

	test("fake keys in the environment and the credential store never appear in text or JSON", async () => {
		writeStore(join(dir, "mcp-credentials.json"), {
			version: 1,
			providers: {
				greptile: { kind: "api_key", apiKey: FAKE_KEY, updatedAt: 0 },
				ragflow: { kind: "api_key", apiKey: FAKE_KEY, updatedAt: 0 },
			},
		});
		mkdirSync(join(dir, "xdg", "ultrathink"), { recursive: true });
		writeFileSync(
			join(dir, "xdg", "ultrathink", "config.json"),
			JSON.stringify({
				ship: { enabled: true },
				hitl: { knowledgeBase: true },
				ragflow: { enabled: true },
				hindsight: { enabled: true },
			}),
		);
		const env = {
			...deps.env,
			ULTRATHINK_OPENROUTER_KEY: FAKE_KEY,
			HINDSIGHT_API_KEY: FAKE_KEY,
			GH_TOKEN: FAKE_KEY,
			AI_GATEWAY_API_KEY: FAKE_KEY,
		};
		for (const args of [[], ["--json"]]) {
			const { output } = await runDoctorCommand(args, { ...deps, env });
			expect(output).not.toContain(FAKE_KEY);
			expect(output).not.toContain("sk-test");
			expect(output).not.toMatch(new RegExp(`\\b${FAKE_KEY.length}\\b`));
			expect(output).toContain("Greptile: credential present (credential store)");
			expect(output).toContain("RAGFlow: credential present (credential store)");
			expect(output).toContain("Hindsight: credential present (HINDSIGHT_API_KEY)");
		}
	});

	test("a check that throws becomes an error finding and the other sections still print", async () => {
		const { output, exitCode } = await runDoctorCommand([], {
			...deps,
			which: () => {
				throw new Error("PATH lookup failed");
			},
		});
		expect(exitCode).toBe(1);
		expect(output).toContain("  ✗ the runtime check failed to run");
		expect(output).toContain("PATH lookup failed");
		expect(output).toContain("  i user config: not found (optional)");
	});

	test("it opens no network connection", async () => {
		const original = globalThis.fetch;
		const calls: unknown[] = [];
		globalThis.fetch = ((...args: unknown[]) => {
			calls.push(args);
			throw new Error("network is off in this test");
		}) as unknown as typeof fetch;
		try {
			await runDoctorCommand(["--json"], deps);
		} finally {
			globalThis.fetch = original;
		}
		expect(calls).toEqual([]);
	});

	test("the blocking local checks finish before any stack probe starts its request", async () => {
		// `claude --version` / `claude auth status` block the thread; a probe started before them would have its 3 s timer
		// run down while they block. A fetch is the first thing the Substrate probe does, so it marks the probe's start.
		const events: string[] = [];
		const tokens = join(dir, "no-tokens");
		mkdirSync(tokens);
		const original = globalThis.fetch;
		globalThis.fetch = ((..._args: unknown[]) => {
			events.push("probe");
			return Promise.resolve(new Response("ok", { status: 200 }));
		}) as unknown as typeof fetch;
		try {
			const { exitCode } = await runDoctorCommand([], {
				...deps,
				env: {
					...deps.env,
					SUBSTRATE_URL: "https://substrate.example.test",
					SUBSTRATE_TOKENS_DIR: tokens,
				},
				runVersion: () => {
					events.push("python");
					return "Python 3.12.1";
				},
				claudeVersion: () => {
					events.push("claude-version");
					return "2.1.300 (Claude Code)";
				},
				claudeAuth: () => {
					events.push("claude-auth");
					return JSON.stringify({
						loggedIn: true,
						authMethod: "claude.ai",
						subscriptionType: "max",
					});
				},
			});
			expect(exitCode).toBe(0);
		} finally {
			globalThis.fetch = original;
		}
		// Control: the probe really ran and every local check really ran.
		expect(events).toContain("probe");
		expect(events).toContain("python");
		expect(events).toContain("claude-version");
		expect(events).toContain("claude-auth");
		const firstProbe = events.indexOf("probe");
		const lastLocal = Math.max(
			events.lastIndexOf("python"),
			events.lastIndexOf("claude-version"),
			events.lastIndexOf("claude-auth"),
		);
		expect(firstProbe).toBeGreaterThan(lastLocal);
	});
});
