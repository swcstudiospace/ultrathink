// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The stdio clean-room proof as a permanent test: the real bin/ultrathink-connector is started with only PATH, BUN,
 * HOME, ULTRATHINK_STATE_DIR and ULTRATHINK_LOG_LEVEL, and every check the CLI prints (scripts/standalone-smoke.ts)
 * is asserted here. No network, no key, no `claude` binary, no fake host.
 *
 * The hosted-service cases at the bottom start the real services/ultrathink/server.ts on loopback. They run only
 * with ULTRATHINK_SMOKE_SERVICE=1: `ULTRATHINK_SMOKE_SERVICE=1 bun test scripts/standalone-smoke.test.ts`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import {
	CONFIG_OK,
	type StdioSmokeResult,
	evaluateSignalSmoke,
	evaluateStdioSmoke,
	formatSmokeReport,
	listTree,
	runCheckConfig,
	runServiceSmoke,
	runStdioSignalSmoke,
	runStdioSmoke,
	secretsAbsent,
	stateDirForCleanEnv,
	strayHomeEntries,
} from "./standalone-smoke.ts";

const EXPECTED_VERSION = pkg.version;
const TEST_TIMEOUT_MS = 60_000;
const SIGNAL_EXIT_DEADLINE_MS = 30_000;
const EXPECTED_TOOLS = [
	"ultrathink_answer",
	"ultrathink_command",
	"ultrathink_graph",
	"ultrathink_pending",
	"ultrathink_plan",
	"ultrathink_result",
	"ultrathink_sessions",
	"ultrathink_show",
	"ultrathink_status",
];

const cleanups: Array<() => void> = [];
afterAll(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

type Json = Record<string, unknown>;

/** Narrows a parsed value to an object, failing the test when it is not one. */
function obj(value: unknown): Json {
	expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
	// Checked on the line above.
	const checked = value as Json;
	return checked;
}

function parseReply(line: string | undefined): Json {
	expect(line).toBeDefined();
	return obj(JSON.parse(line ?? ""));
}

/** The names of the checks that fail for `result`; empty when the connector passes every one. */
function failedChecks(result: StdioSmokeResult, version = EXPECTED_VERSION): string[] {
	return evaluateStdioSmoke(result, version)
		.filter((item) => !item.ok)
		.map((item) => item.name);
}

/** Runs the clean-room case once: the first test asserts on it and the check-logic test reuses it. */
let cleanRoom: Promise<StdioSmokeResult> | undefined;
function cleanRoomRun(): Promise<StdioSmokeResult> {
	cleanRoom ??= runStdioSmoke().then((result) => {
		cleanups.push(result.cleanup);
		return result;
	});
	return cleanRoom;
}

describe("stdio connector, clean room", () => {
	test(
		"answers the audit recipe with exactly 4 replies and writes only the state dir and Bun's cache under HOME",
		async () => {
			const result = await cleanRoomRun();

			expect(result.childEnvKeys).toEqual([
				"BUN",
				"HOME",
				"PATH",
				"ULTRATHINK_LOG_LEVEL",
				"ULTRATHINK_STATE_DIR",
			]);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.replies).toHaveLength(4);

			const [init, list, sessions, help] = result.replies.map((line) => parseReply(line));
			const initResult = obj(init?.result);
			expect(initResult.protocolVersion).toBe("2025-11-25");
			expect(obj(initResult.serverInfo)).toEqual({ name: "ultrathink", version: EXPECTED_VERSION });

			const tools = obj(list?.result).tools;
			expect(Array.isArray(tools)).toBe(true);
			const names = (tools as unknown[]).map((tool) => obj(tool).name).sort();
			expect(names).toEqual(EXPECTED_TOOLS);
			expect(names).not.toContain("ultrathink_uplift");

			for (const reply of [sessions, help]) {
				expect(reply?.error).toBeUndefined();
				expect(obj(reply?.result).isError).toBe(false);
			}

			// Under HOME only Bun's own cache (Bun 1.4.0 writes $HOME/.bun/install/cache/@t@/*.pile) may appear; the
			// state directory is outside HOME here and is private.
			expect(strayHomeEntries(result.homeDir, result.stateDir)).toEqual([]);
			expect(statSync(result.stateDir).mode & 0o777).toBe(0o700);

			// The log says the connector started and never repeats what the client sent.
			expect(result.stderr).toContain("started");
			expect(result.stderr).not.toContain("notifications/initialized");
			expect(result.stderr).not.toContain("clientInfo");

			expect(failedChecks(result)).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the checks fail when the connector's behaviour regresses",
		async () => {
			const result = await cleanRoomRun();
			const widened = JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				result: { tools: [...EXPECTED_TOOLS, "ultrathink_uplift"].map((name) => ({ name })) },
			});
			const regressed: StdioSmokeResult = {
				...result,
				exitCode: 1,
				replies: [result.replies[0] ?? "", widened, ...result.replies.slice(2), "{}"],
				stderr: `${result.stderr}{"event":"request","text":"notifications/initialized"}\n`,
				childEnvKeys: [...result.childEnvKeys, "OPENROUTER_API_KEY"].sort(),
			};

			expect(failedChecks(regressed)).toEqual([
				"child env is exactly the clean set",
				"exit code 0",
				"exactly 4 reply lines",
				"tools/list is the 9 client-driven tools",
				"stderr carries no request text",
			]);
			// A version other than package.json's is a failure too, never silently accepted.
			expect(failedChecks(result, `${EXPECTED_VERSION}-other`)).toEqual(["initialize reply"]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the tools check ignores the order the connector lists tools in and fails only on a missing or extra name",
		async () => {
			const result = await cleanRoomRun();
			// The connector's own registration order, which is not alphabetical.
			const serverOrder = [
				"ultrathink_plan",
				"ultrathink_pending",
				"ultrathink_show",
				"ultrathink_answer",
				"ultrathink_status",
				"ultrathink_result",
				"ultrathink_graph",
				"ultrathink_sessions",
				"ultrathink_command",
			];
			const withTools = (names: string[]): StdioSmokeResult => ({
				...result,
				replies: [
					result.replies[0] ?? "",
					JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						result: { tools: names.map((name) => ({ name })) },
					}),
					...result.replies.slice(2),
				],
			});

			expect(failedChecks(withTools(serverOrder))).toEqual([]);
			expect(failedChecks(withTools(serverOrder.slice(1)))).toEqual([
				"tools/list is the 9 client-driven tools",
			]);
			expect(failedChecks(withTools([...serverOrder, "ultrathink_extra"]))).toEqual([
				"tools/list is the 9 client-driven tools",
			]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"no state dir override: files appear only under the host's connector dir",
		async () => {
			const result = await runStdioSmoke({ omitStateDir: true });
			cleanups.push(result.cleanup);

			expect(result.childEnvKeys).toEqual(["BUN", "HOME", "PATH", "ULTRATHINK_LOG_LEVEL"]);
			expect(result.exitCode).toBe(0);
			expect(result.replies).toHaveLength(4);

			const expected = stateDirForCleanEnv(result.homeDir);
			expect(result.stateDir).toBe(expected);
			expect(statSync(expected).isDirectory()).toBe(true);
			const entries = listTree(result.homeDir);
			expect(entries).toContain(expected);
			expect(strayHomeEntries(result.homeDir, expected)).toEqual([]);
			expect(failedChecks(result)).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a path under HOME outside the state dir and .bun fails exactly the home check",
		async () => {
			const result = await cleanRoomRun();
			const root = mkdtempSync(join(tmpdir(), "ultrathink-smoke-home-"));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const bunFile = join(root, "home", ".bun", "install", "cache", "x.pile");
			mkdirSync(dirname(bunFile), { recursive: true });
			writeFileSync(bunFile, "");
			const home = join(root, "home");

			// State dir outside HOME (explicit ULTRATHINK_STATE_DIR): Bun's cache alone is allowed.
			const explicit: StdioSmokeResult = { ...result, homeDir: home, omitStateDir: false };
			expect(strayHomeEntries(home, result.stateDir)).toEqual([]);
			expect(failedChecks(explicit)).toEqual([]);
			writeFileSync(join(home, ".bunx"), "");
			expect(failedChecks(explicit)).toEqual([
				"no files outside the state dir and Bun's own cache",
			]);

			// State dir under HOME (no override): its ancestors and contents are allowed, a sibling file is not.
			const stateDir = join(home, ".claude", "ultrathink", "connector");
			mkdirSync(stateDir, { mode: 0o700, recursive: true });
			rmSync(join(home, ".bunx"));
			// A real no-override run has no ULTRATHINK_STATE_DIR in its child env; mirror that so the env check still passes.
			const underHome: StdioSmokeResult = {
				...result,
				homeDir: home,
				stateDir,
				omitStateDir: true,
				childEnvKeys: result.childEnvKeys.filter((key) => key !== "ULTRATHINK_STATE_DIR"),
			};
			writeFileSync(join(stateDir, "log.json"), "");
			expect(strayHomeEntries(home, stateDir)).toEqual([]);
			expect(failedChecks(underHome)).toEqual([]);
			const stray = join(home, ".claude", "ultrathink", "stray.txt");
			writeFileSync(stray, "");
			expect(strayHomeEntries(home, stateDir)).toEqual([stray]);
			expect(failedChecks(underHome)).toEqual([
				"no files outside the state dir and Bun's own cache",
			]);
		},
		TEST_TIMEOUT_MS,
	);

	test.skipIf(process.platform === "win32")(
		"SIGTERM to a running connector exits 0 and logs the signal",
		async () => {
			const result = await runStdioSignalSmoke();
			cleanups.push(result.cleanup);

			expect(parseReply(result.firstReply).id).toBe(1);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(0);
			expect(result.exitMs).toBeLessThan(SIGNAL_EXIT_DEADLINE_MS);
			expect(evaluateSignalSmoke(result).filter((item) => !item.ok)).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a secret in the test process reaches neither the child nor the report",
		async () => {
			const name = "ULTRATHINK_SMOKE_TEST_CANARY";
			const canary = `smoke-canary-${randomBytes(8).toString("hex")}`;
			process.env[name] = canary;
			try {
				const result = await runStdioSmoke();
				cleanups.push(result.cleanup);

				expect(result.childEnvKeys).not.toContain(name);
				expect(result.exitCode).toBe(0);
				const report = formatSmokeReport("canary", evaluateStdioSmoke(result, EXPECTED_VERSION));
				expect(result.stdout).not.toContain(canary);
				expect(result.stderr).not.toContain(canary);
				expect(report).not.toContain(canary);
			} finally {
				delete process.env[name];
			}
		},
		TEST_TIMEOUT_MS,
	);
});

/**
 * The hosted-service cases bind a loopback port and take about 90 s on a loaded host, so a bare `bun test` skips them
 * (and binds nothing). The orchestrator and CI run `ULTRATHINK_SMOKE_SERVICE=1 bun test scripts/standalone-smoke.test.ts`.
 */
const RUN_SERVICE = process.env.ULTRATHINK_SMOKE_SERVICE === "1";
const SERVICE_TEST_TIMEOUT_MS = 90_000;
const SERVICE_SKIP_REASON =
	"skipped: ULTRATHINK_SMOKE_SERVICE != 1 (service cases bind loopback and take ~90 s; orchestrator and CI run this file with ULTRATHINK_SMOKE_SERVICE=1)";

type GatedTest = (name: string, fn: () => Promise<void>, timeoutMs: number) => void;

/** `test` when `enabled`; otherwise a skipped test whose name carries `reason`, so the CI output explains the skip. */
function gatedTest(enabled: boolean, reason: string): GatedTest {
	if (enabled) return (name, fn, timeoutMs) => test(name, fn, timeoutMs);
	return (name, fn, timeoutMs) => test.skip(`${name} [${reason}]`, fn, timeoutMs);
}

const serviceTest = gatedTest(RUN_SERVICE, SERVICE_SKIP_REASON);

describe("secret sweep", () => {
	test("finds a secret in any text and refuses a needle too short to mean anything", () => {
		const canary = `canary-${randomBytes(8).toString("hex")}`;
		const unauthenticated = JSON.stringify({ error: "unauthenticated" });

		expect(secretsAbsent([unauthenticated, "Bearer realm"], [canary])).toBe(true);
		expect(secretsAbsent([unauthenticated, `echo ${canary} echo`], [canary])).toBe(false);
		expect(secretsAbsent([], [canary])).toBe(true);
		expect(() => secretsAbsent([unauthenticated], [""])).toThrow();
		expect(() => secretsAbsent([unauthenticated], ["short"])).toThrow();
	});
});

describe("hosted service, loopback", () => {
	serviceTest(
		"passes the full HTTP and MCP checklist, drains on SIGTERM and leaks no secret",
		async () => {
			const result = await runServiceSmoke();

			expect(result.checks.filter((item) => !item.ok)).toEqual([]);
			expect(result.exitCode).toBe(0);
			expect(result.secrets).toEqual({ keyLength: 40, secretLength: 48 });
			expect(result.port).toBeGreaterThanOrEqual(1024);
			expect(result.port).toBeLessThanOrEqual(65535);
			const names = result.checks.map((item) => item.name);
			expect(names.filter((name) => name.startsWith("SECRET-SWEEP "))).toHaveLength(3);
			expect(names).toContain("POST /mcp without a key is 401");
			expect(names).toContain("SIGTERM: /readyz fails while /healthz stays 200");
			expect(names).toContain("SIGTERM drains and the service exits 0");
			expect(result.report).not.toContain("FAIL");
		},
		SERVICE_TEST_TIMEOUT_MS,
	);

	serviceTest(
		"check-config accepts a valid environment, then lists every problem in one secret-free block",
		async () => {
			const valid = await runCheckConfig();
			expect(valid.timedOut).toBe(false);
			expect(valid.listened).toBe(false);
			expect(valid.output).toContain(CONFIG_OK);
			expect(valid.exitCode).toBe(0);

			const canary = `canary-${randomBytes(4).toString("hex")}`;
			const result = await runCheckConfig({
				ULTRATHINK_PUBLIC_ORIGIN: "not-a-url",
				ULTRATHINK_SESSION_SECRET: canary,
				ULTRATHINK_OWNER_PASSWORD_HASH: undefined,
			});

			expect(result.timedOut).toBe(false);
			expect(result.listened).toBe(false);
			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain("configuration problems");
			for (const name of [
				"ULTRATHINK_PUBLIC_ORIGIN",
				"ULTRATHINK_SESSION_SECRET",
				"ULTRATHINK_OWNER_PASSWORD_HASH",
			]) {
				expect(result.output).toContain(name);
			}
			expect(result.output).not.toContain(canary);
		},
		SERVICE_TEST_TIMEOUT_MS,
	);
});
