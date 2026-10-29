// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StackConnection, StackMember, StackProbe } from "../stack/types.ts";
import { runDoctorCommand } from "./cli.ts";
import { checkRegisteredEnv, checkStackConnections } from "./stack-check.ts";
import type { DoctorDeps, DoctorReport, Finding } from "./types.ts";

const CANARY = "sk-or-v1_CANARYCANARYCANARY1234";

describe("doctor env and stack sections", () => {
	let dir: string;
	let originalFetch: typeof fetch;
	let fetchCalls: unknown[];

	/** Every variable that decides where doctor looks points into the temp dir, and the three probes that would otherwise look at the machine are off. */
	function hermeticEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
		return {
			HOME: join(dir, "home"),
			XDG_CONFIG_HOME: join(dir, "xdg"),
			CLAUDE_CONFIG_DIR: join(dir, "claude"),
			ULTRATHINK_STATE_DIR: join(dir, "state"),
			ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
			GH_CONFIG_DIR: join(dir, "gh"),
			SUBSTRATE_DISABLED: "1",
			ULTRATHINK_REALM: "off",
			ULTRATHINK_DECISIONS: "0",
			...extra,
		};
	}

	function depsFor(env: Record<string, string | undefined>): DoctorDeps {
		return {
			env,
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
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-stack-"));
		mkdirSync(join(dir, "project"));
		originalFetch = globalThis.fetch;
		fetchCalls = [];
		globalThis.fetch = ((...args: unknown[]) => {
			fetchCalls.push(args);
			throw new Error("network is off in this test");
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	});

	describe("checkRegisteredEnv", () => {
		test("a clean environment has no env finding", () => {
			expect(checkRegisteredEnv(depsFor(hermeticEnv()))).toEqual([]);
		});

		test("a bad timeout is one env.SUBSTRATE_TIMEOUT_MS warning that names the variable and not the value", () => {
			const findings = checkRegisteredEnv(depsFor(hermeticEnv({ SUBSTRATE_TIMEOUT_MS: CANARY })));
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				id: "env.SUBSTRATE_TIMEOUT_MS",
				section: "env",
				level: "warn",
				title: "SUBSTRATE_TIMEOUT_MS must be an integer",
			});
			expect(JSON.stringify(findings)).not.toContain("CANARY");
		});

		test("an alias that disagrees is one env.HINDSIGHT_API_URL warning whose fix names the canonical variable and the alias", () => {
			const findings = checkRegisteredEnv(
				depsFor(
					hermeticEnv({
						HINDSIGHT_API_URL: "https://a.example.com",
						HINDSIGHT_URL: "https://b.example.com",
					}),
				),
			);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				id: "env.HINDSIGHT_API_URL",
				level: "warn",
				fix: "set HINDSIGHT_API_URL (or remove HINDSIGHT_URL)",
			});
			expect(findings[0]?.title).toContain("HINDSIGHT_URL");
			expect(JSON.stringify(findings)).not.toContain("example.com");
		});

		test("a kill switch with the wrong value says which value works", () => {
			const findings = checkRegisteredEnv(depsFor(hermeticEnv({ ULTRATHINK_HINDSIGHT: "false" })));
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				id: "env.ULTRATHINK_HINDSIGHT",
				level: "warn",
				fix: "unset it or set it to 0",
			});
		});

		test("every problem is listed in one pass, each at warn, and none carries a value", () => {
			const findings = checkRegisteredEnv(
				depsFor(
					hermeticEnv({
						ULTRATHINK_PORT: `${CANARY}9`,
						ULTRATHINK_AUDIT_LOG: "yes",
						ULTRATHINK_SWARM_ROOT: `relative/${CANARY}`,
						RAGFLOW_URL: `https://user:${CANARY}@ragflow.example.com`,
					}),
				),
			);
			expect(findings.map((finding) => finding.id).sort()).toEqual([
				"env.RAGFLOW_URL",
				"env.ULTRATHINK_AUDIT_LOG",
				"env.ULTRATHINK_PORT",
				"env.ULTRATHINK_SWARM_ROOT",
			]);
			expect(findings.every((finding) => finding.level === "warn")).toBe(true);
			expect(JSON.stringify(findings)).not.toContain("CANARY");
		});

		test("OPENROUTER_API_KEY is left to the credentials section: no env finding", () => {
			expect(checkRegisteredEnv(depsFor(hermeticEnv({ OPENROUTER_API_KEY: CANARY })))).toEqual([]);
		});
	});

	describe("checkStackConnections", () => {
		function answering(connection: StackConnection): StackProbe {
			return async () => connection;
		}

		test("with every member switched off there is no finding and no network access", async () => {
			expect(await checkStackConnections(depsFor(hermeticEnv()))).toEqual([]);
			expect(fetchCalls).toEqual([]);
		});

		test("a misconfigured swarm is exactly one stack.swarm warning whose title carries no path value", async () => {
			const findings = await checkStackConnections(
				depsFor(hermeticEnv({ ULTRATHINK_SWARM_ROOT: `relative/${CANARY}` })),
			);
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({ id: "stack.swarm", section: "stack", level: "warn" });
			expect(findings[0]?.title.startsWith("swarm: ")).toBe(true);
			expect(JSON.stringify(findings)).not.toContain("CANARY");
			expect(JSON.stringify(findings)).not.toContain("relative");
			expect(fetchCalls).toEqual([]);
		});

		test("unavailable and misconfigured warn, degraded is info, disabled and connected say nothing, in member order", async () => {
			const probes: Record<StackMember, StackProbe> = {
				substrate: answering({
					member: "substrate",
					status: "unavailable",
					reason: "healthz unreachable",
					fix: "check SUBSTRATE_URL",
				}),
				swarm: answering({ member: "swarm", status: "misconfigured", reason: "no swarm root" }),
				realm: answering({ member: "realm", status: "degraded", reason: "advisory containment" }),
				decisions: answering({ member: "decisions", status: "disabled", reason: "switched off" }),
				hindsight: answering({ member: "hindsight", status: "connected", reason: "healthy" }),
			};
			const findings = await checkStackConnections(depsFor(hermeticEnv()), probes);
			expect(findings).toEqual([
				{
					id: "stack.substrate",
					section: "stack",
					level: "warn",
					title: "substrate: healthz unreachable",
					fix: "check SUBSTRATE_URL",
				},
				{
					id: "stack.swarm",
					section: "stack",
					level: "warn",
					title: "swarm: no swarm root",
				},
				{
					id: "stack.realm",
					section: "stack",
					level: "info",
					title: "realm: advisory containment",
				},
			]);
		});

		test("a probe that throws is one unavailable finding and the other members still report", async () => {
			const findings = await checkStackConnections(depsFor(hermeticEnv()), {
				substrate: async () => {
					throw new Error(`boom ${CANARY}`);
				},
			});
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({
				id: "stack.substrate",
				level: "warn",
				title: "substrate: probe failed",
			});
			expect(JSON.stringify(findings)).not.toContain("CANARY");
		});

		test("a failure of the section itself becomes one stack.report warning and never shows the error", async () => {
			const hostile = new Proxy<Record<string, string | undefined>>(
				{},
				{
					get(): never {
						throw new Error(`env exploded ${CANARY}`);
					},
				},
			);
			const findings = await checkStackConnections({ ...depsFor(hermeticEnv()), env: hostile });
			expect(findings).toEqual([
				{ id: "stack.report", section: "stack", level: "warn", title: "stack check failed" },
			]);
		});
	});

	describe("through runDoctorCommand", () => {
		test("one report holds credential, env and stack findings, with a single OPENROUTER_API_KEY finding and no network", async () => {
			const env = hermeticEnv({
				SUBSTRATE_TIMEOUT_MS: `fast-${CANARY}`,
				HINDSIGHT_API_URL: "https://a.example.com",
				HINDSIGHT_URL: "https://b.example.com",
				ULTRATHINK_SWARM_ROOT: `relative/${CANARY}`,
				OPENROUTER_API_KEY: CANARY,
			});
			const json = await runDoctorCommand(["--json"], depsFor(env));
			expect(json.exitCode).toBe(0);
			const report: DoctorReport = JSON.parse(json.output);
			const ids = report.findings.map((finding: Finding) => finding.id);
			expect(ids).toContain("env.SUBSTRATE_TIMEOUT_MS");
			expect(ids).toContain("env.HINDSIGHT_API_URL");
			expect(ids).toContain("env.ULTRATHINK_SWARM_ROOT");
			expect(ids).toContain("stack.swarm");
			expect(ids.filter((id) => id.startsWith("stack."))).toEqual(["stack.swarm"]);
			expect(ids).not.toContain("env.OPENROUTER_API_KEY");

			// The pre-existing credentials finding is the only one that mentions the exported key.
			const mentioning = report.findings.filter((finding) =>
				`${finding.title} ${finding.fix ?? ""}`.includes("OPENROUTER_API_KEY"),
			);
			expect(mentioning.map((finding) => finding.id)).toEqual(["credentials.openrouter-export"]);

			const text = await runDoctorCommand([], depsFor(env));
			expect(text.exitCode).toBe(0);
			const lines = text.output.split("\n");
			const sections = lines.filter((line) => /^[a-z]+$/.test(line));
			expect(sections).toEqual([
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
			expect(text.output).toContain("  ! SUBSTRATE_TIMEOUT_MS must be an integer");
			expect(text.output).toContain("  ! ULTRATHINK_SWARM_ROOT must be an absolute path");
			expect(text.output).toContain("  ! swarm: ULTRATHINK_SWARM_ROOT must be an absolute path");
			expect(lines.filter((line) => line.includes("OPENROUTER_API_KEY"))).toHaveLength(1);
			for (const output of [json.output, text.output]) expect(output).not.toContain("CANARY");
			expect(fetchCalls).toEqual([]);
		});

		test("when the environment cannot be read the stack section is one warning and every section still prints", async () => {
			const hostile = new Proxy(hermeticEnv(), {
				get(target, property, receiver): unknown {
					if (property === "XDG_CONFIG_HOME") throw new Error(`env read failed ${CANARY}`);
					return Reflect.get(target, property, receiver);
				},
			});
			const { output, exitCode } = await runDoctorCommand([], depsFor(hostile));
			expect(exitCode).toBe(1);
			expect(output).toContain("stack\n  ! stack check failed");
			expect(output).toContain("  ✗ the runtime check failed to run");
			expect(output.split("\n").filter((line) => /^[a-z]+$/.test(line))).toHaveLength(9);
		});
	});
});
