// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Credential, type CredentialStore, writeStore } from "../mcp/store.ts";
import { byId } from "../test.helpers.ts";
import { checkCredentials, checkRuntime } from "./env-check.ts";
import { buildReport, formatReport, reportJson } from "./report.ts";
import type { DoctorDeps } from "./types.ts";

const FAKE_KEY = "sk-test-not-a-real-key-4242424242";

describe("env checks", () => {
	let dir: string;
	let deps: DoctorDeps;
	let installed: string[];
	let probed: string[];
	let versions: Record<string, string>;

	function setEnv(extra: Record<string, string>): void {
		deps = { ...deps, env: { ...deps.env, ...extra } };
	}

	function userConfig(config: Record<string, unknown>): void {
		mkdirSync(join(dir, "xdg", "ultrathink"), { recursive: true });
		writeFileSync(join(dir, "xdg", "ultrathink", "config.json"), JSON.stringify(config));
	}

	function store(providers: CredentialStore["providers"]): void {
		writeStore(join(dir, "mcp-credentials.json"), { version: 1, providers });
	}

	function apiKey(): Credential {
		return { kind: "api_key", apiKey: FAKE_KEY, updatedAt: 0 };
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-env-"));
		installed = ["git", "gh", "python3"];
		probed = [];
		versions = { python3: "Python 3.12.1", python: "Python 2.7.18" };
		deps = {
			env: {
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "xdg"),
				CLAUDE_CONFIG_DIR: join(dir, "claude"),
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				GH_CONFIG_DIR: join(dir, "gh"),
			},
			cwd: join(dir, "project"),
			now: () => 0,
			which: (command) => (installed.includes(command) ? `/usr/bin/${command}` : undefined),
			bunVersion: "1.2.0",
			runVersion: (command) => {
				probed.push(command);
				return versions[command];
			},
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("service timeouts", () => {
		test("warns when the hosted service plans with both timeouts unset or 0", () => {
			setEnv({ ULTRATHINK_SERVER_PLANNING: "1" });
			expect(byId(checkRuntime(deps), "runtime.service-timeouts")).toMatchObject({
				level: "warn",
				fix: expect.stringContaining("ULTRATHINK_PLAN_TIMEOUT_MS"),
			});
			setEnv({ ULTRATHINK_MODEL_TIMEOUT_MS: "0", ULTRATHINK_PLAN_TIMEOUT_MS: "0" });
			expect(byId(checkRuntime(deps), "runtime.service-timeouts").level).toBe("warn");
		});

		test("is absent once either timeout is set, and when the service does not plan", () => {
			setEnv({ ULTRATHINK_SERVER_PLANNING: "1", ULTRATHINK_PLAN_TIMEOUT_MS: "600000" });
			expect(checkRuntime(deps).some((f) => f.id === "runtime.service-timeouts")).toBe(false);
			deps = { ...deps, env: { ...deps.env, ULTRATHINK_PLAN_TIMEOUT_MS: undefined } };
			setEnv({ ULTRATHINK_MODEL_TIMEOUT_MS: "120000" });
			expect(checkRuntime(deps).some((f) => f.id === "runtime.service-timeouts")).toBe(false);
			setEnv({ ULTRATHINK_SERVER_PLANNING: "0", ULTRATHINK_MODEL_TIMEOUT_MS: "0" });
			expect(checkRuntime(deps).some((f) => f.id === "runtime.service-timeouts")).toBe(false);
		});
	});

	describe("checkRuntime", () => {
		test("a complete machine reports ok for Bun, git, gh and Python, and the detected host", () => {
			const findings = checkRuntime(deps);
			expect(byId(findings, "runtime.bun")).toMatchObject({ level: "ok", title: "Bun 1.2.0" });
			expect(byId(findings, "runtime.git").level).toBe("ok");
			expect(byId(findings, "runtime.gh").level).toBe("ok");
			expect(byId(findings, "runtime.python")).toMatchObject({ level: "ok", title: "Python 3.12" });
			expect(byId(findings, "runtime.host").title).toBe("Detected host: claude-code");
			expect(findings.every((finding) => finding.section === "runtime")).toBe(true);
		});

		test("Bun below 1.2 is an error; 1.10 is not below 1.2", () => {
			deps = { ...deps, bunVersion: "1.1.45" };
			expect(byId(checkRuntime(deps), "runtime.bun")).toMatchObject({
				level: "error",
				fix: "Install Bun 1.2 or later (https://bun.sh).",
			});
			deps = { ...deps, bunVersion: "1.10.0" };
			expect(byId(checkRuntime(deps), "runtime.bun").level).toBe("ok");
			deps = { ...deps, bunVersion: "2.0.0" };
			expect(byId(checkRuntime(deps), "runtime.bun").level).toBe("ok");
		});

		test("a missing git is an error", () => {
			installed = ["gh", "python3"];
			expect(byId(checkRuntime(deps), "runtime.git").level).toBe("error");
		});

		test("a missing gh is info unless ship is enabled, then a warning", () => {
			installed = ["git"];
			expect(byId(checkRuntime(deps), "runtime.gh").level).toBe("info");
			expect(checkRuntime(deps).some((finding) => finding.id === "runtime.gh-auth")).toBe(false);

			userConfig({ ship: { enabled: true } });
			expect(byId(checkRuntime(deps), "runtime.gh")).toMatchObject({
				level: "warn",
				title: "gh not found on PATH, but ship.enabled is on",
			});

			setEnv({ ULTRATHINK_SHIP: "0" });
			expect(byId(checkRuntime(deps), "runtime.gh").level).toBe("info");
		});

		test("gh credentials come from the token variables or the hosts file and are never verified", () => {
			let auth = byId(checkRuntime(deps), "runtime.gh-auth");
			expect(auth.level).toBe("info");
			expect(auth.title).toContain("no GH_TOKEN, GITHUB_TOKEN or gh hosts file found");

			setEnv({ GITHUB_TOKEN: FAKE_KEY });
			auth = byId(checkRuntime(deps), "runtime.gh-auth");
			expect(auth.title).toBe("gh credentials: GITHUB_TOKEN is set");
			expect(auth.detail).toContain("not verified offline");
			expect(JSON.stringify(checkRuntime(deps))).not.toContain(FAKE_KEY);

			deps = { ...deps, env: { ...deps.env, GITHUB_TOKEN: undefined } };
			mkdirSync(join(dir, "gh"), { recursive: true });
			writeFileSync(join(dir, "gh", "hosts.yml"), "github.com:\n    user: someone\n");
			expect(byId(checkRuntime(deps), "runtime.gh-auth").title).toBe(
				"gh credentials: a gh hosts file exists",
			);
		});

		test("no gh credentials is a warning only when ship is enabled", () => {
			userConfig({ ship: { enabled: true } });
			expect(byId(checkRuntime(deps), "runtime.gh-auth")).toMatchObject({
				level: "warn",
				fix: "Run `gh auth login`, or set GH_TOKEN.",
			});
		});

		test("Python is info only: absent, old and current", () => {
			installed = ["git", "gh"];
			expect(byId(checkRuntime(deps), "runtime.python")).toMatchObject({
				level: "info",
				title: "Python not found",
			});

			installed = ["git", "gh", "python3"];
			versions.python3 = "Python 3.9.2";
			expect(byId(checkRuntime(deps), "runtime.python")).toMatchObject({
				level: "info",
				title: "Python 3.9 is older than 3.10",
			});

			installed = ["git", "gh", "python"];
			versions.python = "Python 3.11.4";
			expect(byId(checkRuntime(deps), "runtime.python")).toMatchObject({
				level: "ok",
				title: "Python 3.11",
			});

			versions.python = "unparseable";
			expect(byId(checkRuntime(deps), "runtime.python").title).toBe("Python not found");
		});

		test("only Python is ever probed for a version: never gh or curl", () => {
			checkRuntime(deps);
			expect(probed).toEqual(["python3"]);
		});

		test("the host follows ULTRATHINK_HOST", () => {
			setEnv({ ULTRATHINK_HOST: "omp" });
			expect(byId(checkRuntime(deps), "runtime.host").title).toBe("Detected host: omp");
		});
	});

	describe("checkCredentials", () => {
		test("with every feature off only Jev is reported, as info without a key", () => {
			const findings = checkCredentials(deps);
			expect(findings.map((finding) => finding.id)).toEqual(["credentials.jev"]);
			expect(findings[0]).toMatchObject({ level: "info", section: "credentials" });
			expect(findings[0]?.fix).toContain("auth set-key openrouter --stdin");
		});

		test("a Jev key from the environment or the store is present, named by source, never shown", () => {
			setEnv({ ULTRATHINK_OPENROUTER_KEY: FAKE_KEY });
			let jev = byId(checkCredentials(deps), "credentials.jev");
			expect(jev).toMatchObject({
				level: "ok",
				title: "Jev decisions: OpenRouter key present (ULTRATHINK_OPENROUTER_KEY)",
			});

			deps = { ...deps, env: { ...deps.env, ULTRATHINK_OPENROUTER_KEY: undefined } };
			store({ openrouter: apiKey() });
			jev = byId(checkCredentials(deps), "credentials.jev");
			expect(jev.title).toBe("Jev decisions: OpenRouter key present (credential store)");
		});

		test("an exported OPENROUTER_API_KEY is warned about and never counted as a Jev key", () => {
			let findings = checkCredentials(deps);
			expect(findings.map((finding) => finding.id)).not.toContain("credentials.openrouter-export");

			setEnv({ OPENROUTER_API_KEY: FAKE_KEY });
			findings = checkCredentials(deps);
			expect(byId(findings, "credentials.openrouter-export")).toMatchObject({
				level: "warn",
				fix: "remove the export from your shell profile or service unit",
			});
			expect(byId(findings, "credentials.openrouter-export").title).toContain(
				"Ultrathink no longer reads it",
			);
			// With no other key the legacy variable gets the actionable message, not a "key present" one.
			expect(byId(findings, "credentials.jev").level).toBe("info");
			expect(byId(findings, "credentials.jev.legacy")).toMatchObject({
				level: "warn",
				fix: "bin/ultrathink-mcp auth set-key openrouter --stdin",
			});
			expect(JSON.stringify(findings)).not.toContain(FAKE_KEY);

			setEnv({ ULTRATHINK_OPENROUTER_KEY: FAKE_KEY });
			expect(checkCredentials(deps).map((finding) => finding.id)).not.toContain(
				"credentials.jev.legacy",
			);
		});

		test("an open Jev breaker is a decisions.health warning; closed, missing or corrupt is silent", () => {
			const stateDir = join(dir, "state");
			setEnv({ ULTRATHINK_STATE_DIR: stateDir, ULTRATHINK_OPENROUTER_KEY: FAKE_KEY });
			const health = join(stateDir, "decisions-health-openrouter.json");
			const ids = () => checkCredentials(deps).map((finding) => finding.id);
			expect(ids()).not.toContain("decisions.health");

			mkdirSync(stateDir, { recursive: true });
			writeFileSync(
				health,
				JSON.stringify({
					v: 1,
					state: "open",
					cause: "auth",
					since: 1,
					nextProbeAt: 3_600_000,
					coolDownMs: 300_000,
					failures: 1,
				}),
			);
			const finding = byId(checkCredentials(deps), "decisions.health");
			expect(finding.level).toBe("warn");
			expect(finding.title).toContain("Jev unavailable");

			writeFileSync(health, JSON.stringify({ v: 1, state: "closed", failures: 0 }));
			expect(ids()).not.toContain("decisions.health");
			writeFileSync(health, "{not json");
			expect(ids()).not.toContain("decisions.health");
		});

		test("ULTRATHINK_DECISIONS=0 shows no breaker finding even with a saved open breaker", () => {
			const stateDir = join(dir, "state");
			setEnv({ ULTRATHINK_STATE_DIR: stateDir, ULTRATHINK_DECISIONS: "0" });
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(
				join(stateDir, "decisions-health-openrouter.json"),
				JSON.stringify({
					v: 1,
					state: "open",
					cause: "auth",
					since: 1,
					nextProbeAt: 3_600_000,
					coolDownMs: 300_000,
					failures: 1,
				}),
			);
			expect(checkCredentials(deps).map((finding) => finding.id)).not.toContain("decisions.health");
		});

		test("ULTRATHINK_DECISIONS=0 reports Jev as off", () => {
			setEnv({ ULTRATHINK_DECISIONS: "0" });
			expect(byId(checkCredentials(deps), "credentials.jev").title).toBe(
				"Jev decisions: off (ULTRATHINK_DECISIONS=0)",
			);
		});

		test("ship and the knowledge base need Greptile; one finding names both", () => {
			userConfig({ ship: { enabled: true }, hitl: { knowledgeBase: true } });
			const greptile = byId(checkCredentials(deps), "credentials.greptile");
			expect(greptile).toMatchObject({
				level: "warn",
				title: "Greptile: no credential",
				detail: "needed for ship and knowledge base",
			});
			expect(greptile.fix).toContain("bin/ultrathink-mcp auth set-key greptile --stdin");
			expect(greptile.fix).toContain("bin/ultrathink-mcp auth login greptile");

			store({ greptile: apiKey() });
			expect(byId(checkCredentials(deps), "credentials.greptile")).toMatchObject({
				level: "ok",
				title: "Greptile: credential present (credential store)",
			});
		});

		test("the knowledge base alone needs Greptile, and ULTRATHINK_SHIP=0 drops the ship need", () => {
			userConfig({ ship: { enabled: true }, hitl: { knowledgeBase: true } });
			setEnv({ ULTRATHINK_SHIP: "0" });
			expect(byId(checkCredentials(deps), "credentials.greptile").detail).toBe(
				"needed for knowledge base",
			);
		});

		test("a missing or healthy 0600 store raises no store finding", () => {
			const ids = (): string[] => checkCredentials(deps).map((finding) => finding.id);
			expect(ids()).not.toContain("credentials.store.unreadable");
			expect(ids()).not.toContain("credentials.store.mode");
			store({ greptile: apiKey() });
			expect(ids()).not.toContain("credentials.store.unreadable");
			expect(ids()).not.toContain("credentials.store.mode");
		});

		test("a store that does not parse warns with the path only, never its content", () => {
			const path = join(dir, "mcp-credentials.json");
			writeFileSync(path, `{"version":1,"providers":{"openrouter":{"apiKey":"${FAKE_KEY}"`, {
				mode: 0o600,
			});
			const finding = byId(checkCredentials(deps), "credentials.store.unreadable");
			expect(finding.level).toBe("warn");
			expect(finding.section).toBe("credentials");
			expect(finding.title).toContain(path);
			expect(JSON.stringify(finding)).not.toContain(FAKE_KEY);
			expect(JSON.stringify(finding)).not.toContain("openrouter");

			writeFileSync(path, JSON.stringify({ version: 2, providers: {} }), { mode: 0o600 });
			expect(byId(checkCredentials(deps), "credentials.store.unreadable").level).toBe("warn");
		});

		test("a store readable by group or others warns with the chmod 600 fix", () => {
			store({ greptile: apiKey() });
			const path = join(dir, "mcp-credentials.json");
			chmodSync(path, 0o644);
			const finding = byId(checkCredentials(deps), "credentials.store.mode");
			expect(finding).toMatchObject({ level: "warn", fix: `chmod 600 ${path}` });
			expect(finding.title).toContain("0644");
			expect(JSON.stringify(finding)).not.toContain(FAKE_KEY);
			chmodSync(path, 0o640);
			expect(byId(checkCredentials(deps), "credentials.store.mode").level).toBe("warn");
			chmodSync(path, 0o600);
			expect(checkCredentials(deps).some((f) => f.id === "credentials.store.mode")).toBe(false);
		});

		test("a stored OAuth credential that needs a new login is not present", () => {
			userConfig({ ship: { enabled: true } });
			store({
				greptile: {
					kind: "oauth",
					client: {
						clientId: "c",
						redirectUri: "r",
						issuer: "i",
						authorizationEndpoint: "a",
						tokenEndpoint: "t",
						registeredAt: 0,
					},
					needsLogin: "refresh token revoked",
					updatedAt: 0,
				},
			});
			expect(byId(checkCredentials(deps), "credentials.greptile")).toMatchObject({
				level: "warn",
				title: "Greptile: stored credential needs a new login",
			});
		});

		test("tracking needs Notion and Linear only for what is configured", () => {
			userConfig({ notion: { dataSourceUrl: "collection://abc" } });
			let findings = checkCredentials(deps);
			expect(byId(findings, "credentials.notion")).toMatchObject({
				level: "warn",
				fix: "bin/ultrathink-mcp auth login notion",
			});
			expect(findings.some((finding) => finding.id === "credentials.linear")).toBe(false);

			userConfig({ notion: { dataSourceUrl: "collection://abc" }, linear: { team: "Acme" } });
			store({ linear: apiKey() });
			findings = checkCredentials(deps);
			expect(byId(findings, "credentials.linear").level).toBe("ok");
			expect(byId(findings, "credentials.notion").level).toBe("warn");
		});

		test("Hindsight and RAGFlow, when enabled, need their key from the store or the environment", () => {
			userConfig({ hindsight: { enabled: true }, ragflow: { enabled: true } });
			let findings = checkCredentials(deps);
			expect(byId(findings, "credentials.hindsight")).toMatchObject({
				level: "warn",
				fix: "bin/ultrathink-mcp auth set-key hindsight --stdin",
			});
			expect(byId(findings, "credentials.ragflow")).toMatchObject({
				level: "warn",
				fix: "bin/ultrathink-mcp auth set-key ragflow --stdin",
			});

			setEnv({ HINDSIGHT_API_TOKEN: FAKE_KEY });
			store({ ragflow: apiKey() });
			findings = checkCredentials(deps);
			expect(byId(findings, "credentials.hindsight").title).toBe(
				"Hindsight: credential present (HINDSIGHT_API_TOKEN)",
			);
			expect(byId(findings, "credentials.ragflow").title).toBe(
				"RAGFlow: credential present (credential store)",
			);
		});

		test("gateway-backed features need only one desk-gateway token and never inspect direct keys", () => {
			userConfig({
				hindsight: { enabled: true, backend: "gateway" },
				ragflow: { enabled: true, backend: "gateway" },
				substrate: { backend: "gateway" },
			});
			setEnv({ DESK_GATEWAY_URL: "https://gateway.example", DESK_GATEWAY_TOKEN: FAKE_KEY });
			for (const name of ["HINDSIGHT_API_KEY", "HINDSIGHT_API_TOKEN", "RAGFLOW_API_KEY"]) {
				Object.defineProperty(deps.env, name, {
					get: () => {
						throw new Error(`unexpected direct credential read: ${name}`);
					},
					configurable: true,
				});
			}
			const findings = checkCredentials(deps);
			expect(findings.map((finding) => finding.id)).toEqual([
				"credentials.desk-gateway",
				"credentials.jev",
			]);
			expect(byId(findings, "credentials.desk-gateway")).toMatchObject({
				level: "ok",
				title: "Desk gateway: credential present (DESK_GATEWAY_TOKEN)",
				detail: "needed for Hindsight and RAGFlow and substrate",
			});
			const report = buildReport(findings);
			for (const output of [formatReport(report), reportJson(report)]) {
				expect(output).not.toContain(FAKE_KEY);
				expect(output).not.toContain("sk-test");
				expect(output).not.toMatch(new RegExp(`\\b${FAKE_KEY.length}\\b`));
			}
			expect(probed).toEqual([]);
		});

		test("a missing gateway token is not satisfied by direct service credentials", () => {
			userConfig({
				hindsight: { enabled: true, backend: "gateway" },
				ragflow: { enabled: true, backend: "gateway" },
			});
			setEnv({
				DESK_GATEWAY_URL: "https://gateway.example",
				HINDSIGHT_API_KEY: FAKE_KEY,
				RAGFLOW_API_KEY: FAKE_KEY,
				DESK_GATEWAY_TOKEN: "  ",
			});
			store({ hindsight: apiKey(), ragflow: apiKey() });
			const findings = checkCredentials(deps);
			expect(byId(findings, "credentials.desk-gateway")).toMatchObject({
				level: "warn",
				title: "Desk gateway: no credential",
				detail: "needed for Hindsight and RAGFlow",
			});
			expect(byId(findings, "credentials.desk-gateway").fix).toContain("DESK_GATEWAY_TOKEN");
			expect(
				findings.some(
					(finding) =>
						finding.id === "credentials.hindsight" || finding.id === "credentials.ragflow",
				),
			).toBe(false);
		});

		test.each(["api_key", "oauth"] as const)(
			"gateway %s store credentials precede environment tokens",
			(kind) => {
				userConfig({
					hindsight: { enabled: true, backend: "gateway" },
					gateway: { url: "https://gateway.example" },
				});
				setEnv({ DESK_GATEWAY_TOKEN: FAKE_KEY });
				const credential: Credential =
					kind === "api_key"
						? apiKey()
						: {
								kind: "oauth",
								client: {
									clientId: "c",
									redirectUri: "r",
									issuer: "i",
									authorizationEndpoint: "a",
									tokenEndpoint: "t",
									registeredAt: 0,
								},
								tokens: { accessToken: FAKE_KEY },
								updatedAt: 0,
							};
				store({ "desk-gateway": credential } as CredentialStore["providers"]);
				const finding = byId(checkCredentials(deps), "credentials.desk-gateway");
				expect(finding).toMatchObject({
					level: "ok",
					title: "Desk gateway: credential present (credential store)",
				});
				expect(JSON.stringify(finding)).not.toContain(FAKE_KEY);
				store({
					"desk-gateway": { kind: "api_key", apiKey: " ", updatedAt: 0 },
				} as CredentialStore["providers"]);
				expect(byId(checkCredentials(deps), "credentials.desk-gateway").title).toContain(
					"(DESK_GATEWAY_TOKEN)",
				);
			},
		);

		test.each(["", "not a service URL"])(
			"gateway token presence is independent of target URL %s",
			(url) => {
				userConfig({ hindsight: { enabled: true, backend: "gateway" }, gateway: { url } });
				setEnv({ DESK_GATEWAY_TOKEN: FAKE_KEY });
				expect(byId(checkCredentials(deps), "credentials.desk-gateway").level).toBe("ok");
				store({ "desk-gateway": apiKey() } as CredentialStore["providers"]);
				expect(byId(checkCredentials(deps), "credentials.desk-gateway").title).toContain(
					"(credential store)",
				);
				expect(JSON.stringify(checkCredentials(deps))).not.toContain(FAKE_KEY);
			},
		);

		test("backend overrides select gateway or direct credentials and the global gateway kill switch wins", () => {
			userConfig({
				hindsight: { enabled: true, backend: "gateway" },
				ragflow: { enabled: true, backend: "direct" },
			});
			setEnv({
				ULTRATHINK_HINDSIGHT_BACKEND: "direct",
				ULTRATHINK_RAGFLOW_BACKEND: "gateway",
				DESK_GATEWAY_TOKEN: FAKE_KEY,
				HINDSIGHT_API_KEY: FAKE_KEY,
			});
			let findings = checkCredentials(deps);
			expect(byId(findings, "credentials.hindsight").level).toBe("ok");
			expect(byId(findings, "credentials.desk-gateway")).toMatchObject({
				level: "ok",
				detail: "needed for RAGFlow",
			});
			expect(findings.some((finding) => finding.id === "credentials.ragflow")).toBe(false);
			setEnv({ ULTRATHINK_GATEWAY: "0" });
			findings = checkCredentials(deps);
			expect(byId(findings, "credentials.hindsight").level).toBe("ok");
			expect(byId(findings, "credentials.ragflow").level).toBe("warn");
			expect(findings.some((finding) => finding.id === "credentials.desk-gateway")).toBe(false);
		});

		test("disabled gateway features remove their token need, and direct substrate adds none", () => {
			userConfig({
				hindsight: { enabled: true, backend: "gateway" },
				ragflow: { enabled: true, backend: "gateway" },
				substrate: { backend: "gateway" },
			});
			setEnv({ ULTRATHINK_HINDSIGHT: "0", ULTRATHINK_RAGFLOW: "0", SUBSTRATE_DISABLED: "1" });
			expect(checkCredentials(deps).map((finding) => finding.id)).toEqual(["credentials.jev"]);
			userConfig({ substrate: { url: "https://substrate.example", backend: "direct" } });
			expect(checkCredentials(deps).map((finding) => finding.id)).toEqual(["credentials.jev"]);
		});

		test("the kill switches remove the Hindsight and RAGFlow needs", () => {
			userConfig({ hindsight: { enabled: true }, ragflow: { enabled: true } });
			setEnv({ ULTRATHINK_HINDSIGHT: "0", ULTRATHINK_RAGFLOW: "0" });
			expect(checkCredentials(deps).map((finding) => finding.id)).toEqual(["credentials.jev"]);
		});

		test("a missing or unreadable store reads as no credentials, not an error", () => {
			writeFileSync(join(dir, "mcp-credentials.json"), "not json");
			userConfig({ ship: { enabled: true } });
			expect(byId(checkCredentials(deps), "credentials.greptile").level).toBe("warn");
		});

		test("no key, prefix or length reaches the text or the JSON output", () => {
			userConfig({
				ship: { enabled: true },
				hindsight: { enabled: true },
				ragflow: { enabled: true },
				linear: { team: "Acme" },
			});
			setEnv({
				ULTRATHINK_OPENROUTER_KEY: FAKE_KEY,
				HINDSIGHT_API_KEY: FAKE_KEY,
				GH_TOKEN: FAKE_KEY,
			});
			store({ greptile: apiKey(), ragflow: apiKey() });
			const report = buildReport([...checkRuntime(deps), ...checkCredentials(deps)]);
			for (const output of [formatReport(report), reportJson(report)]) {
				expect(output).not.toContain(FAKE_KEY);
				expect(output).not.toContain("sk-test");
				expect(output).not.toMatch(new RegExp(`\\b${FAKE_KEY.length}\\b`));
			}
		});
	});
});
