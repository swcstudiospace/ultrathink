// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GrokAuthStatus } from "./auth.ts";
import type { GrokCheckResult } from "./check.ts";
import { type GrokLoginDeps, runGrokLogin } from "./login.ts";
import { DEFAULT_GROK_CONFIG } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-grok-login-"));
	dirs.push(dir);
	return dir;
}

interface SpawnCall {
	cmd: string[];
	env: Record<string, string | undefined>;
}

const SIGNED_IN: GrokAuthStatus = {
	loggedIn: true,
	expired: false,
	email: "lane@example.com",
	expiresAt: "2030-01-01T00:00:00.000Z",
	home: "/ignored",
};

const CHECK_OK: GrokCheckResult = { ok: true, exitCode: 0, text: "CHECK-OK-LINE", json: {} };

/** Deps with every external effect stubbed; `xdg` keeps the user config inside a temp dir. */
function harness(overrides: Partial<GrokLoginDeps> = {}) {
	const xdg = tempDir();
	const calls: SpawnCall[] = [];
	const deps: GrokLoginDeps = {
		grok: DEFAULT_GROK_CONFIG,
		env: {
			XDG_CONFIG_HOME: xdg,
			CLAUDE_CONFIG_DIR: join(xdg, "claude"),
			XAI_API_KEY: "xai-planted-key",
			KEEP: "1",
		},
		spawn: async (cmd, env) => {
			calls.push({ cmd, env });
			return 0;
		},
		status: () => SIGNED_IN,
		check: async () => CHECK_OK,
		...overrides,
	};
	return {
		deps,
		calls,
		xdg,
		configPath: join(xdg, "ultrathink", "config.json"),
		claudePath: join(xdg, "claude", "ultrathink.json"),
	};
}

describe("runGrokLogin", () => {
	test("a relative home is refused with a usage line and nothing runs", async () => {
		const { deps, calls } = harness();
		const result = await runGrokLogin(deps, { home: "relative/lane" });
		expect(result.exitCode).toBe(2);
		expect(result.ok).toBe(false);
		expect(result.text).toContain("absolute");
		expect(result.text).toContain("Usage: ultrathink grok login");
		expect(calls).toHaveLength(0);
	});

	test("creates the home with mode 0700 and runs the official CLI under GROK_HOME without XAI_API_KEY", async () => {
		const base = tempDir();
		const home = join(base, "nested", "lane");
		const { deps, calls } = harness({ grok: { ...DEFAULT_GROK_CONFIG, bin: "/opt/grok" } });
		const result = await runGrokLogin(deps, { home });
		expect(result.exitCode).toBe(0);
		expect(statSync(home).mode & 0o777).toBe(0o700);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cmd).toEqual(["/opt/grok", "login", "--device-auth"]);
		expect(calls[0]?.env.GROK_HOME).toBe(home);
		expect(calls[0]?.env).not.toHaveProperty("XAI_API_KEY");
		expect(calls[0]?.env.KEEP).toBe("1");
		expect(deps.env).toHaveProperty("XAI_API_KEY");
	});

	test("the default home is <XDG_CONFIG_HOME>/ultrathink/grok", async () => {
		const { deps, calls, xdg } = harness();
		const made: string[] = [];
		await runGrokLogin({ ...deps, mkdir: (path) => made.push(path) });
		expect(made).toEqual([join(xdg, "ultrathink", "grok")]);
		expect(calls[0]?.env.GROK_HOME).toBe(join(xdg, "ultrathink", "grok"));
	});

	test("grok.home from config is used when no --home is given", async () => {
		const home = join(tempDir(), "configured");
		const { deps, calls } = harness({ grok: { ...DEFAULT_GROK_CONFIG, home } });
		await runGrokLogin(deps);
		expect(calls[0]?.env.GROK_HOME).toBe(home);
	});

	test("a non-zero CLI exit is exit 1 and names the code; no check runs", async () => {
		let checked = false;
		const { deps } = harness({
			spawn: async () => 7,
			check: async () => {
				checked = true;
				return CHECK_OK;
			},
		});
		const result = await runGrokLogin(deps, { home: join(tempDir(), "lane") });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.text).toContain("code 7");
		expect(checked).toBe(false);
	});

	test("reports the account, home and expiry, runs the check against the lane home", async () => {
		const home = join(tempDir(), "lane");
		const checkedHomes: string[] = [];
		const { deps } = harness({
			check: async (lane) => {
				checkedHomes.push(lane);
				return CHECK_OK;
			},
		});
		const result = await runGrokLogin(deps, { home });
		expect(result.text).toContain(
			`Grok login: lane@example.com · home ${home} · expires 2030-01-01T00:00:00.000Z`,
		);
		expect(result.text).toContain("CHECK-OK-LINE");
		expect(checkedHomes).toEqual([home]);
	});

	test("without writeConfig it prints the exact snippet and writes nothing", async () => {
		const home = join(tempDir(), "lane");
		const { deps, configPath } = harness();
		const result = await runGrokLogin(deps, { home });
		expect(result.text).toContain(`{"grok":{"home":"${home}"}}`);
		expect(existsSync(configPath)).toBe(false);
	});

	test("a failed entitlement check is reported with its fix but the login still succeeds", async () => {
		const failed: GrokCheckResult = {
			ok: false,
			exitCode: 1,
			text: "Grok check: error (model-unavailable) · limit 0 · fix: run `ultrathink grok login` as the account",
			json: {},
		};
		const { deps } = harness({ check: async () => failed });
		const result = await runGrokLogin(deps, { home: join(tempDir(), "lane") });
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.text).toContain(failed.text);
	});

	test("a CLI that exits 0 without leaving a session is a failure", async () => {
		const { deps } = harness({
			status: () => ({ loggedIn: false, expired: false, home: "/x" }),
		});
		const result = await runGrokLogin(deps, { home: join(tempDir(), "lane") });
		expect(result.exitCode).toBe(1);
		expect(result.text).toContain("no session");
	});

	test("a spawn that throws (missing binary) is exit 1", async () => {
		const { deps } = harness({
			spawn: async () => {
				throw new Error("spawn grok ENOENT");
			},
		});
		const result = await runGrokLogin(deps, { home: join(tempDir(), "lane") });
		expect(result.exitCode).toBe(1);
		expect(result.text).toContain("ENOENT");
	});
});

describe("runGrokLogin --write-config", () => {
	test("creates the user config with only grok.home", async () => {
		const home = join(tempDir(), "lane");
		const { deps, configPath } = harness();
		const result = await runGrokLogin(deps, { home, writeConfig: true });
		expect(result.exitCode).toBe(0);
		expect(result.text).toContain(configPath);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ grok: { home } });
		expect(readFileSync(configPath, "utf8").endsWith("\n")).toBe(true);
	});

	test("preserves other keys, sibling grok keys, file mode and the trailing newline, atomically", async () => {
		const home = join(tempDir(), "lane");
		const { deps, configPath } = harness();
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(
			configPath,
			`${JSON.stringify({ claude: { model: "claude-haiku-5-5" }, grok: { enabled: true, home: "/old" }, other: [1, 2] }, null, "\t")}\n`,
		);
		chmodSync(configPath, 0o640);
		await runGrokLogin(deps, { home, writeConfig: true });
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			claude: { model: "claude-haiku-5-5" },
			grok: { enabled: true, home },
			other: [1, 2],
		});
		expect(statSync(configPath).mode & 0o777).toBe(0o640);
		expect(readFileSync(configPath, "utf8").endsWith("\n")).toBe(true);
		expect(readFileSync(configPath, "utf8")).toContain('\n\t"claude"');
		// tmp + rename leaves no temp file behind
		expect(readdirSync(join(configPath, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("a file without a trailing newline stays without one", async () => {
		const { deps, configPath } = harness();
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(configPath, '{"a":1}');
		await runGrokLogin(deps, { home: join(tempDir(), "lane"), writeConfig: true });
		expect(readFileSync(configPath, "utf8").endsWith("\n")).toBe(false);
	});

	test("invalid JSON is refused, reported, left untouched, and the login exits 1", async () => {
		const { deps, configPath } = harness();
		mkdirSync(join(configPath, ".."), { recursive: true });
		writeFileSync(configPath, "{ not json");
		const result = await runGrokLogin(deps, { home: join(tempDir(), "lane"), writeConfig: true });
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.text).toContain("not valid JSON");
		expect(readFileSync(configPath, "utf8")).toBe("{ not json");
	});

	test("writeUserConfig is the seam: its returned path is reported", async () => {
		const homes: string[] = [];
		const { deps, configPath } = harness();
		const home = join(tempDir(), "lane");
		const result = await runGrokLogin(
			{
				...deps,
				writeUserConfig: (lane) => {
					homes.push(lane);
					mkdirSync(dirname(configPath), { recursive: true });
					writeFileSync(configPath, JSON.stringify({ grok: { home: lane } }));
					return configPath;
				},
			},
			{ home, writeConfig: true },
		);
		expect(homes).toEqual([home]);
		expect(result.exitCode).toBe(0);
		expect(result.text).toContain(configPath);
	});

	test("writes into the higher-priority user file that already sets grok.home", async () => {
		const home = join(tempDir(), "lane");
		const { deps, configPath, claudePath } = harness();
		mkdirSync(dirname(configPath), { recursive: true });
		mkdirSync(dirname(claudePath), { recursive: true });
		writeFileSync(configPath, `${JSON.stringify({ grok: { home: "/low" }, keep: 1 })}\n`);
		writeFileSync(claudePath, `${JSON.stringify({ grok: { home: "/old", enabled: true } })}\n`);
		chmodSync(claudePath, 0o600);
		const lowBefore = readFileSync(configPath, "utf8");
		const result = await runGrokLogin(deps, { home, writeConfig: true });
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.text).toContain(`set grok.home in ${claudePath}`);
		expect(JSON.parse(readFileSync(claudePath, "utf8"))).toEqual({
			grok: { home, enabled: true },
		});
		expect(statSync(claudePath).mode & 0o777).toBe(0o600);
		expect(readFileSync(configPath, "utf8")).toBe(lowBefore);
	});

	test("when no user file sets grok.home the default user file is created", async () => {
		const home = join(tempDir(), "lane");
		const { deps, configPath, claudePath } = harness();
		mkdirSync(dirname(claudePath), { recursive: true });
		writeFileSync(claudePath, `${JSON.stringify({ claude: { model: "claude-haiku-5-5" } })}\n`);
		const claudeBefore = readFileSync(claudePath, "utf8");
		const result = await runGrokLogin(deps, { home, writeConfig: true });
		expect(result.exitCode).toBe(0);
		expect(result.text).toContain(`set grok.home in ${configPath}`);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ grok: { home } });
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(claudePath, "utf8")).toBe(claudeBefore);
	});

	test("an override that was not changed is a warning naming the winning file and value, exit 1", async () => {
		const home = join(tempDir(), "lane");
		const { deps, configPath, claudePath } = harness();
		mkdirSync(dirname(claudePath), { recursive: true });
		writeFileSync(claudePath, `${JSON.stringify({ grok: { home: "/winner" } })}\n`);
		const result = await runGrokLogin(
			{ ...deps, writeUserConfig: () => configPath },
			{ home, writeConfig: true },
		);
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.text).toContain("warning");
		expect(result.text).toContain(claudePath);
		expect(result.text).toContain("/winner");
		expect(result.text).toContain(home);
	});
});
