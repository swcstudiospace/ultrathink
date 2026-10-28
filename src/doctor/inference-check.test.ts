// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDoctorCommand } from "./cli.ts";
import { checkInference } from "./inference-check.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const FAKE_SECRET = "sk-ant-oat01-not-a-real-token-4242424242";
const FAKE_EMAIL = "owner-secret@example.invalid";
const FAKE_ORG = "Acme Secret Org";

const PLAN_JSON = JSON.stringify({
	loggedIn: true,
	authMethod: "claude.ai",
	subscriptionType: "max",
});

describe("checkInference", () => {
	let dir: string;
	let deps: DoctorDeps;
	let authEnvs: (Record<string, string | undefined> | undefined)[];

	const byId = (findings: Finding[], id: string): Finding => {
		const found = findings.find((finding) => finding.id === id);
		if (!found) throw new Error(`no finding ${id}`);
		return found;
	};

	function userConfig(value: unknown): void {
		const path = join(dir, "xdg", "ultrathink", "config.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	}

	function grokLogin(entry: Record<string, unknown>): void {
		mkdirSync(join(dir, "grok"), { recursive: true });
		writeFileSync(
			join(dir, "grok", "auth.json"),
			JSON.stringify({ "https://auth.x.ai::client": { key: FAKE_SECRET, ...entry } }),
		);
	}

	function setEnv(extra: Record<string, string | undefined>): void {
		deps = { ...deps, env: { ...deps.env, ...extra } };
	}

	function claudeAuth(stdout: string | undefined): void {
		deps = {
			...deps,
			claudeAuth: (env) => {
				authEnvs.push(env);
				return stdout;
			},
		};
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-inference-"));
		mkdirSync(join(dir, "project"));
		authEnvs = [];
		deps = {
			env: {
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "xdg"),
				CLAUDE_CONFIG_DIR: join(dir, "claude"),
				GROK_HOME: join(dir, "grok"),
				ULTRATHINK_STATE_DIR: join(dir, "state"),
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				GH_CONFIG_DIR: join(dir, "gh"),
			},
			cwd: join(dir, "project"),
			now: () => NOW,
			which: (command) => (command === "claude" ? "/usr/bin/claude" : undefined),
			bunVersion: "1.2.0",
			runVersion: () => undefined,
			claudeVersion: () => "2.1.300 (Claude Code)",
		};
		claudeAuth(PLAN_JSON);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("inference.claude.cli", () => {
		test("a missing claude warns with the install fix and runs no probe", () => {
			let probed = 0;
			deps = {
				...deps,
				which: () => undefined,
				claudeVersion: () => {
					probed++;
					return "2.1.300";
				},
				claudeAuth: () => {
					probed++;
					return PLAN_JSON;
				},
			};
			const findings = checkInference(deps);
			expect(byId(findings, "inference.claude.cli")).toEqual({
				id: "inference.claude.cli",
				section: "inference",
				level: "warn",
				title: "claude CLI not found: the Claude route cannot plan",
				fix: "Install Claude Code (https://code.claude.com/docs/en/setup)",
			});
			expect(findings.map((finding) => finding.id)).not.toContain("inference.claude.auth");
			expect(probed).toBe(0);
		});

		test("a version older than the haiku minimum 2.1.293 warns and says claude update", () => {
			deps = { ...deps, claudeVersion: () => "2.1.292 (Claude Code)" };
			expect(byId(checkInference(deps), "inference.claude.cli")).toMatchObject({
				level: "warn",
				title: "claude 2.1.292 is older than 2.1.293, which claude-haiku-5-5 needs",
				fix: "claude update",
			});
		});

		test("the minimum and newer versions are ok, compared numerically", () => {
			for (const line of ["2.1.293", "2.1.294 (Claude Code)", "2.2.0", "2.10.0", "3.0.0"]) {
				deps = { ...deps, claudeVersion: () => line };
				const finding = byId(checkInference(deps), "inference.claude.cli");
				expect(finding.level).toBe("ok");
				expect(finding.title).toBe(`claude ${line.split(" ")[0]}`);
			}
		});

		test("an alias and the other models use their own minimum", () => {
			userConfig({ claude: { model: "haiku" } });
			deps = { ...deps, claudeVersion: () => "2.1.292" };
			expect(byId(checkInference(deps), "inference.claude.cli").title).toBe(
				"claude 2.1.292 is older than 2.1.293, which haiku needs",
			);
			userConfig({ claude: { model: "claude-sonnet-5-5" } });
			deps = { ...deps, claudeVersion: () => "2.1.283" };
			expect(byId(checkInference(deps), "inference.claude.cli").level).toBe("warn");
			deps = { ...deps, claudeVersion: () => "2.1.284" };
			expect(byId(checkInference(deps), "inference.claude.cli").level).toBe("ok");
			userConfig({ claude: { model: "opus" } });
			deps = { ...deps, claudeVersion: () => "2.1.279" };
			expect(byId(checkInference(deps), "inference.claude.cli").level).toBe("warn");
			deps = { ...deps, claudeVersion: () => "2.1.280" };
			expect(byId(checkInference(deps), "inference.claude.cli").level).toBe("ok");
		});

		test("an unknown model has no minimum", () => {
			userConfig({ claude: { model: "some-future-model" } });
			deps = { ...deps, claudeVersion: () => "1.0.0" };
			expect(byId(checkInference(deps), "inference.claude.cli")).toMatchObject({
				level: "ok",
				title: "claude 1.0.0",
			});
		});

		test("a missing or unparseable version probe skips the finding silently", () => {
			deps = { ...deps, claudeVersion: undefined };
			expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.cli");
			deps = { ...deps, claudeVersion: () => undefined };
			expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.cli");
			deps = { ...deps, claudeVersion: () => "no digits here" };
			expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.cli");
		});
	});

	describe("inference.claude.auth in plan mode", () => {
		test("a claude.ai login is ok and names only the subscription type", () => {
			expect(byId(checkInference(deps), "inference.claude.auth")).toMatchObject({
				level: "ok",
				title: "Claude auth: plan login (max)",
			});
			claudeAuth(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
			expect(byId(checkInference(deps), "inference.claude.auth").title).toBe(
				"Claude auth: plan login (plan)",
			);
		});

		test("logged out warns with the login and setup-token fix", () => {
			claudeAuth(JSON.stringify({ loggedIn: false }));
			expect(byId(checkInference(deps), "inference.claude.auth")).toMatchObject({
				level: "warn",
				title: "Claude auth: no plan login",
				fix: "Run claude and sign in with /login, or run claude setup-token and export CLAUDE_CODE_OAUTH_TOKEN",
			});
		});

		test("another auth method is info", () => {
			claudeAuth(JSON.stringify({ loggedIn: true, authMethod: "oauth_token" }));
			expect(byId(checkInference(deps), "inference.claude.auth")).toMatchObject({
				level: "info",
				title: "Claude auth: oauth_token",
			});
		});

		test("JSON wrapped in banner text still parses; garbage and a missing probe skip the finding", () => {
			claudeAuth(`update available\n${PLAN_JSON}\n`);
			expect(byId(checkInference(deps), "inference.claude.auth").level).toBe("ok");
			for (const stdout of ["not json", "[]", "null", "", undefined]) {
				claudeAuth(stdout);
				expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.auth");
			}
			deps = { ...deps, claudeAuth: undefined };
			expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.auth");
		});

		test("the probe runs with the plan env: the key and cloud switches are removed", () => {
			setEnv({
				ANTHROPIC_API_KEY: FAKE_SECRET,
				ANTHROPIC_AUTH_TOKEN: FAKE_SECRET,
				CLAUDE_CODE_USE_BEDROCK: "1",
				CLAUDE_CODE_OAUTH_TOKEN: "oauth-kept",
			});
			claudeAuth(PLAN_JSON);
			checkInference(deps);
			expect(authEnvs).toHaveLength(1);
			const env = authEnvs[0] ?? {};
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
			expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-kept");
			expect(env.HOME).toBe(join(dir, "home"));
		});
	});

	describe("inference.claude.auth in api-key mode", () => {
		beforeEach(() => userConfig({ claude: { auth: "api-key" } }));

		test("is info, warns when no key variable is set, and does not run the probe", () => {
			const findings = checkInference(deps);
			expect(byId(findings, "inference.claude.auth")).toMatchObject({
				level: "info",
				title: "Claude auth: API key (claude.auth is api-key)",
			});
			expect(byId(findings, "inference.claude.auth.key").level).toBe("warn");
			expect(authEnvs).toEqual([]);
		});

		test("either variable silences the warning", () => {
			for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
				setEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, [name]: "x" });
				expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.auth.key");
			}
		});

		test("the key shadow info is plan-mode only", () => {
			setEnv({ ANTHROPIC_API_KEY: FAKE_SECRET });
			expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.key");
		});
	});

	describe("inference.claude.key", () => {
		test("a set ANTHROPIC_API_KEY is info that names the variable and never the value", () => {
			setEnv({ ANTHROPIC_API_KEY: FAKE_SECRET });
			const finding = byId(checkInference(deps), "inference.claude.key");
			expect(finding).toMatchObject({
				level: "info",
				title: "ANTHROPIC_API_KEY is set and ignored for planning (claude.auth is plan)",
				detail: "Other tools, including an interactive claude, still use it and bill the API",
				fix: "Unset it where your shell or service sets it",
			});
			expect(JSON.stringify(finding)).not.toContain(FAKE_SECRET);
		});

		test("ANTHROPIC_AUTH_TOKEN alone, and both together, are named", () => {
			setEnv({ ANTHROPIC_AUTH_TOKEN: FAKE_SECRET });
			expect(byId(checkInference(deps), "inference.claude.key").title).toStartWith(
				"ANTHROPIC_AUTH_TOKEN is set and ignored",
			);
			setEnv({ ANTHROPIC_API_KEY: FAKE_SECRET });
			expect(byId(checkInference(deps), "inference.claude.key").title).toStartWith(
				"ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are set and ignored",
			);
		});

		test("no key variable means no finding", () => {
			expect(checkInference(deps).map((f) => f.id)).not.toContain("inference.claude.key");
		});
	});

	describe("inference.grok.login", () => {
		test("a signed-in session is ok with the account and the time left, never the token", () => {
			grokLogin({ email: "dev@example.com", expires_at: new Date(NOW + 5 * DAY).toISOString() });
			const finding = byId(checkInference(deps), "inference.grok.login");
			expect(finding).toMatchObject({
				level: "ok",
				title: "Grok login: dev@example.com expires in 5 days",
			});
			expect(JSON.stringify(finding)).not.toContain(FAKE_SECRET);
		});

		test("without an email or an expiry it still says signed in", () => {
			grokLogin({});
			expect(byId(checkInference(deps), "inference.grok.login")).toMatchObject({
				level: "ok",
				title: "Grok login: signed in",
			});
		});

		test("an expired session warns with the login fix", () => {
			grokLogin({ expires_at: new Date(NOW - DAY).toISOString() });
			expect(byId(checkInference(deps), "inference.grok.login")).toMatchObject({
				level: "warn",
				title: "Grok login expired",
				fix: "grok login",
			});
		});

		test("no login is info while the Grok route is not in use", () => {
			expect(byId(checkInference(deps), "inference.grok.login")).toMatchObject({
				level: "info",
				title: "Grok login: not signed in (the Grok route is not in use)",
			});
			expect(existsSync(join(dir, "grok"))).toBe(false);
		});

		test("the default Grok home follows deps.env.HOME and never the real home", () => {
			const decoy = mkdtempSync(join(tmpdir(), "ut-doctor-inference-decoy-"));
			mkdirSync(join(decoy, ".grok"));
			writeFileSync(
				join(decoy, ".grok", "auth.json"),
				JSON.stringify({
					a: { key: FAKE_SECRET, expires_at: new Date(NOW - DAY).toISOString() },
				}),
			);
			const realHome = process.env.HOME;
			process.env.HOME = decoy;
			try {
				setEnv({ GROK_HOME: undefined, HOME: join(dir, "home") });
				expect(byId(checkInference(deps), "inference.grok.login")).toMatchObject({
					level: "info",
					title: "Grok login: not signed in (the Grok route is not in use)",
				});
				mkdirSync(join(dir, "home", ".grok"), { recursive: true });
				writeFileSync(
					join(dir, "home", ".grok", "auth.json"),
					JSON.stringify({ a: { key: FAKE_SECRET, email: "home@example.com" } }),
				);
				expect(byId(checkInference(deps), "inference.grok.login").title).toBe(
					"Grok login: home@example.com",
				);
			} finally {
				if (realHome === undefined) delete process.env.HOME;
				else process.env.HOME = realHome;
				rmSync(decoy, { recursive: true, force: true });
			}
		});

		test("no login warns when claude.fallbackToGrok is on", () => {
			userConfig({ claude: { fallbackToGrok: true } });
			expect(byId(checkInference(deps), "inference.grok.login")).toMatchObject({
				level: "warn",
				title: "Grok login: not signed in",
				fix: "grok login",
			});
		});

		test("no login warns when the engine resolves to grok", () => {
			userConfig({ think: { engine: "grok" } });
			expect(byId(checkInference(deps), "inference.grok.login").level).toBe("warn");
			rmSync(join(dir, "xdg"), { recursive: true, force: true });
			setEnv({ ULTRATHINK_HOST: "grok-build" });
			expect(byId(checkInference(deps), "inference.grok.login").level).toBe("warn");
			userConfig({ think: { engine: "claude" } });
			expect(byId(checkInference(deps), "inference.grok.login").level).toBe("info");
		});

		test("the shunt transport is info and reads no login", () => {
			userConfig({
				grok: { transport: "shunt", shuntBaseUrl: "http://127.0.0.1:9999" },
				claude: { fallbackToGrok: true },
			});
			expect(byId(checkInference(deps), "inference.grok.login")).toMatchObject({
				level: "info",
				title: "Grok route uses a shunt gateway",
			});
		});

		test("grok.home in config wins over GROK_HOME", () => {
			const other = join(dir, "other-grok");
			mkdirSync(other);
			writeFileSync(
				join(other, "auth.json"),
				JSON.stringify({ a: { key: FAKE_SECRET, email: "other@example.com" } }),
			);
			userConfig({ grok: { home: other } });
			expect(byId(checkInference(deps), "inference.grok.login").title).toBe(
				"Grok login: other@example.com",
			);
		});
	});

	describe("inference.fallback and inference.models", () => {
		test("the fallback is off by default", () => {
			expect(byId(checkInference(deps), "inference.fallback")).toMatchObject({
				level: "info",
				title: "Claude to Grok fallback: off (claude.fallbackToGrok is false)",
			});
		});

		test("the fallback line lists the Grok models when on", () => {
			userConfig({ claude: { fallbackToGrok: true } });
			expect(byId(checkInference(deps), "inference.fallback").title).toBe(
				"Claude to Grok fallback: on (models grok-build-0.1, grok-4.7)",
			);
			userConfig({ claude: { fallbackToGrok: true }, grok: { fallbackModels: [] } });
			expect(byId(checkInference(deps), "inference.fallback").title).toBe(
				"Claude to Grok fallback: on (models grok-build-0.1)",
			);
		});

		test("the models line names the route defaults without a pin note", () => {
			const finding = byId(checkInference(deps), "inference.models");
			expect(finding).toMatchObject({
				level: "info",
				title: "Models: claude claude-haiku-5-5, grok grok-build-0.1 then grok-4.7",
			});
			expect(finding.detail).toBeUndefined();
		});

		test("a pinned claude.model and an empty fallback list show in the models line", () => {
			userConfig({ claude: { model: "claude-sonnet-5-5" }, grok: { fallbackModels: [] } });
			expect(byId(checkInference(deps), "inference.models")).toMatchObject({
				title: "Models: claude claude-sonnet-5-5, grok grok-build-0.1",
				detail: "claude.model is pinned in config",
			});
		});
	});

	describe("the section as a whole", () => {
		test("findings come in contract order and none is an error", () => {
			setEnv({ ANTHROPIC_API_KEY: FAKE_SECRET });
			const findings = checkInference(deps);
			expect(findings.map((finding) => finding.id)).toEqual([
				"inference.claude.cli",
				"inference.claude.auth",
				"inference.claude.key",
				"inference.grok.login",
				"inference.fallback",
				"inference.models",
			]);
			expect(findings.every((finding) => finding.section === "inference")).toBe(true);
			expect(findings.some((finding) => finding.level === "error")).toBe(false);
		});

		test("missing probes skip their findings silently and nothing else changes", () => {
			deps = { ...deps, claudeVersion: undefined, claudeAuth: undefined };
			expect(checkInference(deps).map((finding) => finding.id)).toEqual([
				"inference.grok.login",
				"inference.fallback",
				"inference.models",
			]);
		});

		test("it creates nothing and makes no network request", () => {
			const original = globalThis.fetch;
			const calls: unknown[] = [];
			globalThis.fetch = ((...args: unknown[]) => {
				calls.push(args);
				throw new Error("network is off in this test");
			}) as unknown as typeof fetch;
			try {
				checkInference(deps);
			} finally {
				globalThis.fetch = original;
			}
			expect(calls).toEqual([]);
			expect(existsSync(join(dir, "grok"))).toBe(false);
			expect(existsSync(join(dir, "xdg"))).toBe(false);
			expect(existsSync(join(dir, "state"))).toBe(false);
		});
	});

	describe("the configured claude.bin", () => {
		const CUSTOM = "/opt/ut-test/claude-custom";

		test("is the binary looked up and probed; a bare claude on PATH is never consulted", () => {
			userConfig({ claude: { bin: CUSTOM } });
			const lookups: string[] = [];
			const versionBins: string[] = [];
			const authBins: string[] = [];
			deps = {
				...deps,
				which: (command) => {
					lookups.push(command);
					return command === CUSTOM ? CUSTOM : command === "claude" ? "/usr/bin/claude" : undefined;
				},
				claudeVersion: (bin) => {
					versionBins.push(bin);
					return "2.1.300";
				},
				claudeAuth: (_env, bin) => {
					authBins.push(bin);
					return PLAN_JSON;
				},
			};
			const findings = checkInference(deps);
			expect(byId(findings, "inference.claude.cli").level).toBe("ok");
			expect(byId(findings, "inference.claude.auth").level).toBe("ok");
			expect(lookups.length).toBeGreaterThan(0);
			expect(lookups.every((command) => command === CUSTOM)).toBe(true);
			expect(versionBins).toEqual([CUSTOM]);
			expect(authBins).toEqual([CUSTOM]);
		});

		test("a missing custom binary warns even when a bare claude is on PATH, and nothing is probed", () => {
			userConfig({ claude: { bin: CUSTOM } });
			let probed = 0;
			deps = {
				...deps,
				which: (command) => (command === "claude" ? "/usr/bin/claude" : undefined),
				claudeVersion: () => {
					probed++;
					return "2.1.300";
				},
				claudeAuth: () => {
					probed++;
					return PLAN_JSON;
				},
			};
			const findings = checkInference(deps);
			expect(byId(findings, "inference.claude.cli").level).toBe("warn");
			expect(findings.map((finding) => finding.id)).not.toContain("inference.claude.auth");
			expect(probed).toBe(0);
		});

		test("the default probes the bare claude command", () => {
			const bins: string[] = [];
			deps = {
				...deps,
				claudeVersion: (bin) => {
					bins.push(bin);
					return "2.1.300";
				},
			};
			checkInference(deps);
			expect(bins).toEqual(["claude"]);
		});
	});

	describe("the effective Claude model", () => {
		beforeEach(() => {
			userConfig({
				claude: { model: "opus" },
				models: { hosts: { "claude-code": { model: "haiku" }, omp: { model: "haiku" } } },
			});
			deps = { ...deps, claudeVersion: () => "2.1.100" };
		});

		test("a host override replaces claude.model for the minimum, the title and the Models line", () => {
			const findings = checkInference(deps);
			expect(byId(findings, "inference.claude.cli").title).toBe(
				"claude 2.1.100 is older than 2.1.293, which haiku needs",
			);
			expect(byId(findings, "inference.models")).toMatchObject({
				title: "Models: claude haiku, grok grok-build-0.1 then grok-4.7",
				detail: "claude model comes from models.hosts.claude-code.model",
			});
		});

		test("on omp the override names a native target and is ignored", () => {
			setEnv({ ULTRATHINK_HOST: "omp" });
			const findings = checkInference(deps);
			expect(byId(findings, "inference.claude.cli").title).toBe(
				"claude 2.1.100 is older than 2.1.280, which opus needs",
			);
			expect(byId(findings, "inference.models")).toMatchObject({
				title: "Models: claude opus, grok grok-build-0.1 then grok-4.7",
				detail: "claude.model is pinned in config",
			});
		});

		test("a blank host override falls back to claude.model", () => {
			userConfig({
				claude: { model: "opus" },
				models: { hosts: { "claude-code": { model: "" } } },
			});
			expect(byId(checkInference(deps), "inference.claude.cli").title).toBe(
				"claude 2.1.100 is older than 2.1.280, which opus needs",
			);
		});
	});

	describe("model ids are masked like engine labels", () => {
		const PRIVATE = "user:private@model";

		test("a credential-shaped selector never reaches the Models, fallback or version lines", () => {
			userConfig({
				claude: { model: PRIVATE, fallbackToGrok: true },
				grok: { model: PRIVATE, fallbackModels: ["other:secret@x", "grok-4.7"] },
			});
			const findings = checkInference(deps);
			expect(byId(findings, "inference.models").title).toBe(
				"Models: claude <opaque-model>, grok <opaque-model> then <opaque-model>, grok-4.7",
			);
			expect(byId(findings, "inference.fallback").title).toBe(
				"Claude to Grok fallback: on (models <opaque-model>, <opaque-model>, grok-4.7)",
			);
			const text = JSON.stringify(findings);
			expect(text).not.toContain("private");
			expect(text).not.toContain("secret");
		});

		test("a masked host override model is masked in the Models line", () => {
			userConfig({ models: { hosts: { "claude-code": { model: PRIVATE } } } });
			const findings = checkInference(deps);
			expect(byId(findings, "inference.models").title).toStartWith(
				"Models: claude <opaque-model>,",
			);
			expect(JSON.stringify(findings)).not.toContain("private");
		});
	});

	describe("through runDoctorCommand", () => {
		beforeEach(() => {
			deps = {
				...deps,
				which: (command) =>
					["git", "gh", "python3", "claude"].includes(command) ? `/usr/bin/${command}` : undefined,
				runVersion: () => "Python 3.12.1",
			};
		});

		test("secrets in the claude auth JSON never reach the text or JSON report", async () => {
			claudeAuth(
				JSON.stringify({
					loggedIn: true,
					authMethod: "claude.ai",
					subscriptionType: "max",
					email: FAKE_EMAIL,
					orgName: FAKE_ORG,
					orgId: "org-secret-id",
					accessToken: FAKE_SECRET,
					refreshToken: FAKE_SECRET,
				}),
			);
			for (const args of [[], ["--json"]]) {
				const { output } = await runDoctorCommand(args, deps);
				expect(output).toContain("Claude auth: plan login (max)");
				for (const secret of [FAKE_SECRET, FAKE_EMAIL, FAKE_ORG, "org-secret-id"]) {
					expect(output).not.toContain(secret);
				}
			}
		});

		test("hostile authMethod and subscriptionType strings are not echoed", async () => {
			claudeAuth(
				JSON.stringify({
					loggedIn: true,
					authMethod: `token ${FAKE_SECRET} for ${FAKE_EMAIL}`,
					subscriptionType: FAKE_ORG,
				}),
			);
			const { output } = await runDoctorCommand([], deps);
			expect(output).toContain("Claude auth: unknown");
			expect(output).not.toContain(FAKE_SECRET);
			expect(output).not.toContain(FAKE_EMAIL);
		});

		test("a key variable shows its name in the report, never its value", async () => {
			setEnv({ ANTHROPIC_API_KEY: FAKE_SECRET });
			const { output } = await runDoctorCommand([], deps);
			expect(output).toContain("ANTHROPIC_API_KEY is set and ignored for planning");
			expect(output).not.toContain(FAKE_SECRET);
		});

		test("warnings keep exit code 0 and appear in both formats", async () => {
			claudeAuth(JSON.stringify({ loggedIn: false }));
			deps = { ...deps, claudeVersion: () => "2.1.100" };
			const text = await runDoctorCommand([], deps);
			expect(text.exitCode).toBe(0);
			expect(text.output).toContain("\ninference\n");
			expect(text.output).toContain("  ! Claude auth: no plan login");
			expect(text.output).toContain("  ! claude 2.1.100 is older than 2.1.293");
			const json = await runDoctorCommand(["--json"], deps);
			expect(json.exitCode).toBe(0);
			const report = JSON.parse(json.output) as { ok: boolean; findings: Finding[] };
			expect(report.ok).toBe(true);
			const inference = report.findings.filter((finding) => finding.section === "inference");
			expect(inference.map((finding) => finding.level)).toContain("warn");
			expect(inference.some((finding) => finding.level === "error")).toBe(false);
		});
	});
});
