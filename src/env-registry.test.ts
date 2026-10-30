// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_REGISTRY, type EnvFinding, validateEnv } from "./env-registry.ts";
import { resolveHindsight } from "./hindsight/settings.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "./hindsight/types.ts";
import { resolveSubstrate } from "./substrate/brief.ts";
import { resolveSubstrateToken } from "./substrate/surface.ts";
import { resolveSwarmRoot } from "./swarm/teams.ts";

function problems(env: Record<string, string | undefined>): string[] {
	return validateEnv(env).map((finding) => `${finding.name}:${finding.problem}`);
}

describe("validateEnv: one case per kind", () => {
	test("url: a non-http scheme or an unparsable value is bad-kind; an http(s) URL is clean", () => {
		expect(problems({ SUBSTRATE_URL: "ftp://substrate.example.com" })).toEqual([
			"SUBSTRATE_URL:bad-kind",
		]);
		expect(problems({ SUBSTRATE_URL: "not a url" })).toEqual(["SUBSTRATE_URL:bad-kind"]);
		expect(problems({ SUBSTRATE_URL: "https://substrate.example.com" })).toEqual([]);
		// The Substrate reader applies no host policy, so a plain-http internal URL is not reported.
		expect(problems({ SUBSTRATE_URL: "http://substrate.internal:3000" })).toEqual([]);
	});

	test("url: variables whose reader applies the service-URL policy reject plain http to a public host", () => {
		expect(problems({ HINDSIGHT_API_URL: "http://hindsight.example.com" })).toEqual([
			"HINDSIGHT_API_URL:bad-kind",
		]);
		expect(problems({ RAGFLOW_URL: "https://user:pw@ragflow.example.com" })).toEqual([
			"RAGFLOW_URL:bad-kind",
		]);
		expect(problems({ HINDSIGHT_API_URL: "http://127.0.0.1:8888" })).toEqual([]);
		expect(problems({ DESK_GATEWAY_URL: "https://gateway.example.com/base" })).toEqual([]);
	});

	test("url: a Decisions endpoint the client would ignore is reported, the default host is clean", () => {
		expect(problems({ ULTRATHINK_DECISIONS_URL: "https://other.example.com/decisions" })).toEqual([
			"ULTRATHINK_DECISIONS_URL:bad-kind",
		]);
		expect(
			problems({ ULTRATHINK_DECISIONS_URL: "https://openrouter.ai/api/alpha/decisions" }),
		).toEqual([]);
		expect(problems({ ULTRATHINK_DECISIONS_URL: "http://127.0.0.1:9000/d" })).toEqual([]);
	});

	test("int: a non-integer is bad-kind, an out-of-range integer is out-of-range, an in-range one is clean", () => {
		expect(problems({ SUBSTRATE_TIMEOUT_MS: "fast" })).toEqual(["SUBSTRATE_TIMEOUT_MS:bad-kind"]);
		expect(problems({ SUBSTRATE_TIMEOUT_MS: "1.5" })).toEqual(["SUBSTRATE_TIMEOUT_MS:bad-kind"]);
		expect(problems({ SUBSTRATE_TIMEOUT_MS: "0" })).toEqual(["SUBSTRATE_TIMEOUT_MS:out-of-range"]);
		expect(problems({ SUBSTRATE_TIMEOUT_MS: "1500" })).toEqual([]);
		expect(problems({ ULTRATHINK_PORT: "80" })).toEqual(["ULTRATHINK_PORT:out-of-range"]);
		expect(problems({ ULTRATHINK_PORT: "65536" })).toEqual(["ULTRATHINK_PORT:out-of-range"]);
		expect(problems({ ULTRATHINK_PORT: "1024" })).toEqual([]);
		expect(problems({ ULTRATHINK_PORT: "65535" })).toEqual([]);
		expect(problems({ ULTRATHINK_PROGRESS_FD: "2" })).toEqual([
			"ULTRATHINK_PROGRESS_FD:out-of-range",
		]);
		expect(problems({ ULTRATHINK_PROGRESS_FD: "3" })).toEqual([]);
	});

	test("int: a limit whose zero means unlimited accepts zero", () => {
		expect(problems({ ULTRATHINK_MODEL_TIMEOUT_MS: "0" })).toEqual([]);
		expect(problems({ ULTRATHINK_MODEL_TIMEOUT_MS: "700000" })).toEqual([
			"ULTRATHINK_MODEL_TIMEOUT_MS:out-of-range",
		]);
	});

	test("bool01: only exact 0 and 1 are clean", () => {
		expect(problems({ ULTRATHINK_AUDIT_LOG: "yes" })).toEqual(["ULTRATHINK_AUDIT_LOG:bad-kind"]);
		expect(problems({ ULTRATHINK_AUDIT_LOG: "true" })).toEqual(["ULTRATHINK_AUDIT_LOG:bad-kind"]);
		expect(problems({ ULTRATHINK_AUDIT_LOG: "0" })).toEqual([]);
		expect(problems({ ULTRATHINK_AUDIT_LOG: "1" })).toEqual([]);
	});

	test("bool1: only the exact 1 is clean", () => {
		expect(problems({ ULTRATHINK_DEBUG: "true" })).toEqual(["ULTRATHINK_DEBUG:bad-kind"]);
		expect(problems({ ULTRATHINK_DEBUG: "0" })).toEqual(["ULTRATHINK_DEBUG:bad-kind"]);
		expect(problems({ ULTRATHINK_DEBUG: "1" })).toEqual([]);
	});

	test("enum: a value outside the list is bad-kind and the message lists the allowed values", () => {
		const [finding] = validateEnv({ ULTRATHINK_HINDSIGHT_BACKEND: "gate" });
		expect(finding).toMatchObject({ name: "ULTRATHINK_HINDSIGHT_BACKEND", problem: "bad-kind" });
		expect(finding?.message).toContain("direct, gateway");
		expect(problems({ ULTRATHINK_HINDSIGHT_BACKEND: "gateway" })).toEqual([]);
		expect(problems({ ULTRATHINK_HINDSIGHT_BACKEND: "direct" })).toEqual([]);
		expect(problems({ ULTRATHINK_HOST: "vim" })).toEqual(["ULTRATHINK_HOST:bad-kind"]);
		expect(problems({ ULTRATHINK_HOST: "omp" })).toEqual([]);
	});

	test("path: a relative path is bad-kind, an absolute one is clean", () => {
		expect(problems({ ULTRATHINK_SWARM_ROOT: "agent-swarm" })).toEqual([
			"ULTRATHINK_SWARM_ROOT:bad-kind",
		]);
		expect(problems({ ULTRATHINK_SWARM_ROOT: "~/agent-swarm" })).toEqual([
			"ULTRATHINK_SWARM_ROOT:bad-kind",
		]);
		expect(problems({ ULTRATHINK_SWARM_ROOT: "/opt/agent-swarm" })).toEqual([]);
		expect(problems({ ULTRATHINK_STATE_DIR: "state" })).toEqual(["ULTRATHINK_STATE_DIR:bad-kind"]);
	});

	test("string: nothing is reported, whatever the value", () => {
		expect(
			problems({ ULTRATHINK_SESSION_SECRET: "x", HINDSIGHT_API_KEY: "", DESK_GATEWAY_SEAT: "?" }),
		).toEqual([]);
	});

	test("an empty or blank value counts as unset for every kind", () => {
		const blanks: Record<string, string> = {};
		for (const def of ENV_REGISTRY) blanks[def.name] = def.name.length % 2 === 0 ? "" : "   ";
		expect(validateEnv(blanks)).toEqual([]);
		expect(validateEnv({})).toEqual([]);
	});

	test("findings follow the registry order", () => {
		const order = ENV_REGISTRY.map((def) => def.name);
		const names = validateEnv({
			ULTRATHINK_PORT: "x",
			SUBSTRATE_TIMEOUT_MS: "x",
			ULTRATHINK_UPLIFT: "x",
		}).map((finding) => finding.name);
		expect(names).toEqual(
			["ULTRATHINK_UPLIFT", "SUBSTRATE_TIMEOUT_MS", "ULTRATHINK_PORT"].sort(
				(a, b) => order.indexOf(a) - order.indexOf(b),
			),
		);
	});
});

describe("validateEnv: aliases", () => {
	test("HINDSIGHT_URL against HINDSIGHT_API_URL: different values conflict, naming both and the winner", () => {
		const findings = validateEnv({
			HINDSIGHT_API_URL: "https://a.example.com",
			HINDSIGHT_URL: "https://b.example.com",
		});
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ name: "HINDSIGHT_API_URL", problem: "alias-conflict" });
		expect(findings[0]?.message).toContain("HINDSIGHT_API_URL");
		expect(findings[0]?.message).toContain("HINDSIGHT_URL");
		expect(findings[0]?.message).toContain("HINDSIGHT_API_URL wins");
	});

	test("the same value (after trimming) is no conflict, and an alias alone is clean", () => {
		expect(
			problems({
				HINDSIGHT_API_URL: "https://a.example.com",
				HINDSIGHT_URL: " https://a.example.com ",
			}),
		).toEqual([]);
		expect(problems({ HINDSIGHT_URL: "https://a.example.com" })).toEqual([]);
		expect(problems({ HINDSIGHT_API_URL: "https://a.example.com" })).toEqual([]);
	});

	test("an empty alias or an empty canonical name never conflicts", () => {
		expect(problems({ HINDSIGHT_API_URL: "https://a.example.com", HINDSIGHT_URL: "" })).toEqual([]);
		expect(problems({ HINDSIGHT_API_URL: "  ", HINDSIGHT_URL: "https://b.example.com" })).toEqual(
			[],
		);
	});

	test("an alias alone with a bad value is reported under the alias name", () => {
		expect(problems({ HINDSIGHT_URL: "ftp://hindsight.example.com" })).toEqual([
			"HINDSIGHT_URL:bad-kind",
		]);
		expect(problems({ SWARM_ROOT: "agent-swarm" })).toEqual(["SWARM_ROOT:bad-kind"]);
	});

	test("SWARM_ROOT against ULTRATHINK_SWARM_ROOT conflicts the same way", () => {
		const findings = validateEnv({ ULTRATHINK_SWARM_ROOT: "/opt/one", SWARM_ROOT: "/opt/two" });
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ name: "ULTRATHINK_SWARM_ROOT", problem: "alias-conflict" });
		expect(findings[0]?.message).toContain("SWARM_ROOT");
		expect(problems({ ULTRATHINK_SWARM_ROOT: "/opt/one", SWARM_ROOT: "/opt/one" })).toEqual([]);
		expect(problems({ SWARM_ROOT: "/opt/two" })).toEqual([]);
	});
});

describe("validateEnv: kill switches", () => {
	test("ULTRATHINK_HINDSIGHT=false disables nothing and is reported; 0, unset and empty are clean", () => {
		const [finding] = validateEnv({ ULTRATHINK_HINDSIGHT: "false" });
		expect(finding).toMatchObject({ name: "ULTRATHINK_HINDSIGHT", problem: "kill-switch" });
		expect(finding?.message).toContain("only the value 0");
		expect(problems({ ULTRATHINK_HINDSIGHT: "0" })).toEqual([]);
		expect(problems({ ULTRATHINK_HINDSIGHT: "" })).toEqual([]);
		expect(problems({})).toEqual([]);
	});

	test("every kill switch keeps its exact disabling value", () => {
		const disabling = Object.fromEntries(
			ENV_REGISTRY.filter((def) => def.disableValue !== undefined).map((def) => [
				def.name,
				def.disableValue,
			]),
		);
		expect(disabling).toEqual({
			ULTRATHINK_UPLIFT: "0",
			ULTRATHINK_TRACK: "0",
			ULTRATHINK_SHIP: "0",
			ULTRATHINK_DECISIONS: "0",
			ULTRATHINK_HINDSIGHT: "0",
			ULTRATHINK_RAGFLOW: "0",
			ULTRATHINK_TEACH: "0",
			ULTRATHINK_GATEWAY: "0",
			ULTRATHINK_PSTACK: "0",
			SUBSTRATE_DISABLED: "1",
			ULTRATHINK_REALM: "off",
		});
	});

	test("each kill switch accepts its disabling value and reports any other value, once", () => {
		for (const def of ENV_REGISTRY.filter((entry) => entry.disableValue !== undefined)) {
			expect(problems({ [def.name]: def.disableValue })).toEqual([]);
			expect(problems({ [def.name]: "false" })).toEqual([`${def.name}:kill-switch`]);
		}
	});

	test("SUBSTRATE_DISABLED disables on 1, so 0 and true are reported", () => {
		expect(problems({ SUBSTRATE_DISABLED: "1" })).toEqual([]);
		expect(problems({ SUBSTRATE_DISABLED: "true" })).toEqual(["SUBSTRATE_DISABLED:kill-switch"]);
		expect(problems({ SUBSTRATE_DISABLED: "0" })).toEqual(["SUBSTRATE_DISABLED:kill-switch"]);
	});

	test("ULTRATHINK_REALM accepts off in any case and padding; other values are reported", () => {
		expect(problems({ ULTRATHINK_REALM: "off" })).toEqual([]);
		expect(problems({ ULTRATHINK_REALM: " OFF " })).toEqual([]);
		expect(problems({ ULTRATHINK_REALM: "on" })).toEqual(["ULTRATHINK_REALM:kill-switch"]);
	});

	test("ULTRATHINK_RAGFLOW=' 0 ' is clean: the RAGFlow reader trims", () => {
		expect(problems({ ULTRATHINK_RAGFLOW: " 0 " })).toEqual([]);
	});

	test("an exact-match kill switch with padding is reported as ineffective, naming the variable and never the value", () => {
		for (const [name, padded] of [
			["SUBSTRATE_DISABLED", " 1 "],
			["ULTRATHINK_DECISIONS", " 0"],
			["ULTRATHINK_HINDSIGHT", "0 "],
			["ULTRATHINK_GATEWAY", "\t0"],
		] as const) {
			const findings = validateEnv({ [name]: padded });
			expect(findings).toHaveLength(1);
			expect(findings[0]).toMatchObject({ name, problem: "kill-switch" });
			expect(findings[0]?.message).toContain(name);
			expect(findings[0]?.message).toContain("whitespace");
			expect(findings[0]?.message).not.toContain(padded);
			expect(problems({ [name]: padded.trim() })).toEqual([]);
		}
	});

	test("a padded value of an exact-match kill switch that is wrong anyway is reported once, as the wrong value", () => {
		const findings = validateEnv({ SUBSTRATE_DISABLED: " true " });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain("only the value 1");
	});

	test("the registry matches the real readers: SUBSTRATE_DISABLED and ULTRATHINK_HINDSIGHT compare the raw string, ULTRATHINK_RAGFLOW trims", () => {
		const byName = new Map(ENV_REGISTRY.map((def) => [def.name, def]));
		expect(byName.get("SUBSTRATE_DISABLED")?.reader).toBe("raw");
		expect(byName.get("ULTRATHINK_HINDSIGHT")?.reader).toBe("raw");
		expect(byName.get("ULTRATHINK_RAGFLOW")?.reader).toBe("trims");
		const url = "https://substrate.example.com";
		expect(resolveSubstrate({ SUBSTRATE_DISABLED: "1" }, url)).toBeUndefined();
		expect(resolveSubstrate({ SUBSTRATE_DISABLED: " 1 " }, url)).toBeDefined();
		const config = { ...DEFAULT_HINDSIGHT_CONFIG, enabled: true };
		expect(resolveHindsight(config, { ULTRATHINK_HINDSIGHT: "0" }).readiness).toMatchObject({
			state: "off",
			reason: "killed",
		});
		expect(resolveHindsight(config, { ULTRATHINK_HINDSIGHT: " 0 " }).readiness).not.toMatchObject({
			reason: "killed",
		});
	});

	test("a boolean or enum row with an exact reader and padding is reported; a trimming reader is clean", () => {
		expect(problems({ ULTRATHINK_DEBUG: " 1 " })).toEqual(["ULTRATHINK_DEBUG:bad-kind"]);
		expect(problems({ ULTRATHINK_OAUTH_TAILSCALE: "1 " })).toEqual([
			"ULTRATHINK_OAUTH_TAILSCALE:bad-kind",
		]);
		expect(problems({ ULTRATHINK_HINDSIGHT_BACKEND: " gateway " })).toEqual([
			"ULTRATHINK_HINDSIGHT_BACKEND:bad-kind",
		]);
		expect(problems({ ULTRATHINK_DEBUG: "1" })).toEqual([]);
		expect(problems({ ULTRATHINK_AUDIT_LOG: " 0 " })).toEqual([]);
		expect(problems({ ULTRATHINK_SERVER_PLANNING: " 1 " })).toEqual([]);
		expect(problems({ ULTRATHINK_PLANNING_FALLBACK: " grok " })).toEqual([]);
		expect(problems({ ULTRATHINK_HOST: " omp " })).toEqual([]);
	});

	test("every kill switch, bool01, bool1 and enum row declares how its reader treats whitespace", () => {
		const undeclared = ENV_REGISTRY.filter(
			(def) =>
				(def.disableValue !== undefined || ["bool01", "bool1", "enum"].includes(def.kind)) &&
				def.reader === undefined,
		).map((def) => def.name);
		expect(undeclared).toEqual([]);
	});
});

describe("validateEnv: never echoes a value", () => {
	const VALUE = "sk-or-v1_CANARYCANARYCANARY1234-vck_CANARYGATEWAY/canary-path";
	const CANARIES = ["sk-or-v1_CANARY", "vck_CANARY", "canary-path", "CANARYCANARY"];

	function expectNoCanary(findings: readonly EnvFinding[]): void {
		const text = JSON.stringify(findings);
		for (const canary of CANARIES) expect(text).not.toContain(canary);
	}

	test("a canary planted in every registered variable and alias appears in no finding", () => {
		const env: Record<string, string> = {};
		for (const def of ENV_REGISTRY) {
			env[def.name] = VALUE;
			for (const alias of def.aliases ?? []) env[alias] = VALUE;
		}
		const findings = validateEnv(env);
		expect(findings.length).toBeGreaterThan(20);
		expectNoCanary(findings);
	});

	test("a canary in a credentialed URL, a hostile path and a numeric slot is never repeated", () => {
		const url =
			"https://user:vck_CANARYPASS@host.example.com/canary-path?token=sk-or-v1_CANARYQ#CANARYCANARY";
		const env: Record<string, string> = {};
		for (const def of ENV_REGISTRY) {
			if (def.kind === "url") env[def.name] = url;
			if (def.kind === "path") env[def.name] = `relative/${VALUE}`;
			if (def.kind === "int") env[def.name] = `${VALUE}9`;
		}
		const findings = validateEnv(env);
		expect(findings.some((finding) => finding.name === "RAGFLOW_URL")).toBe(true);
		expectNoCanary(findings);
	});

	test("a secret variable set to a canary produces no finding at all", () => {
		const secrets = ENV_REGISTRY.filter((def) => def.secret);
		expect(secrets.length).toBeGreaterThan(5);
		for (const def of secrets) expect(problems({ [def.name]: VALUE })).toEqual([]);
	});

	test("OPENROUTER_API_KEY is never reported: env-check owns that finding", () => {
		expect(validateEnv({ OPENROUTER_API_KEY: "sk-or-v1_CANARYCANARYCANARY1234" })).toEqual([]);
		expect(ENV_REGISTRY.map((def) => def.name)).not.toContain("OPENROUTER_API_KEY");
	});
});

describe("ENV_REGISTRY", () => {
	const names = ENV_REGISTRY.map((def) => def.name);

	test("names are unique and no alias is also a registered name", () => {
		expect(new Set(names).size).toBe(names.length);
		for (const def of ENV_REGISTRY) {
			for (const alias of def.aliases ?? []) expect(names).not.toContain(alias);
		}
	});

	test("internal markers and test clocks are not listed", () => {
		for (const internal of [
			"ULTRATHINK_CHILD",
			"ULTRATHINK_BUN_REQUIRED",
			"ULTRATHINK_PRUNE_NOW_MS",
		]) {
			expect(names).not.toContain(internal);
		}
	});

	test("an enum lists its values and a range is ordered", () => {
		for (const def of ENV_REGISTRY) {
			if (def.kind === "enum") expect(def.values?.length ?? 0).toBeGreaterThan(0);
			if (def.min !== undefined && def.max !== undefined)
				expect(def.min).toBeLessThanOrEqual(def.max);
		}
	});

	test("the alias families and the Substrate token family are registered with their canonical links", () => {
		const byName = new Map(ENV_REGISTRY.map((def) => [def.name, def]));
		expect(byName.get("HINDSIGHT_API_URL")?.aliases).toEqual(["HINDSIGHT_URL"]);
		expect(byName.get("ULTRATHINK_SWARM_ROOT")?.aliases).toEqual(["SWARM_ROOT"]);
		for (const token of ["SUBSTRATE_TOKEN", "SUBSTRATE_TOKEN_FILE", "SUBSTRATE_TOKENS_DIR"]) {
			expect(byName.get(token)?.family).toBe("substrate-token");
		}
		expect(byName.get("SUBSTRATE_TOKEN")?.secret).toBe(true);
		expect(byName.get("SUBSTRATE_TOKEN_FILE")?.secret).toBe(false);
	});

	test("a credential variable is a secret and a path or URL variable is not", () => {
		const byName = new Map(ENV_REGISTRY.map((def) => [def.name, def]));
		for (const name of [
			"HINDSIGHT_API_KEY",
			"HINDSIGHT_API_TOKEN",
			"RAGFLOW_API_KEY",
			"DESK_GATEWAY_TOKEN",
			"ULTRATHINK_OPENROUTER_KEY",
			"ULTRATHINK_OWNER_PASSWORD_HASH",
			"ULTRATHINK_SESSION_SECRET",
			"ULTRATHINK_CONNECTOR_KEY",
		]) {
			expect(byName.get(name)?.secret).toBe(true);
		}
		for (const def of ENV_REGISTRY) {
			if (def.kind === "path" || def.kind === "url") expect(def.secret).toBe(false);
		}
	});

	test("every registry variable has a line in .env.example: placeholder only, secrets commented out", () => {
		const text = readFileSync(join(import.meta.dir, "..", ".env.example"), "utf8");
		const lines = text.split("\n");
		for (const def of ENV_REGISTRY) {
			const active = lines.filter((line) => line.startsWith(`${def.name}=`));
			const commented = lines.filter((line) => line.startsWith(`# ${def.name}=`));
			expect(active.length + commented.length).toBe(1);
			const line = active[0] ?? commented[0] ?? "";
			expect(line.slice(line.indexOf("=") + 1)).toMatch(/^<your-[a-z0-9-]+>$/);
			expect(commented.length === 1).toBe(def.secret);
		}
	});
});

describe("alias precedence matches the code the registry documents", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-env-registry-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function swarmCheckout(name: string): string {
		const root = join(dir, name);
		mkdirSync(join(root, "hooks"), { recursive: true });
		writeFileSync(join(root, "hooks", "autonomous_run.py"), "");
		return root;
	}

	test("HINDSIGHT_API_URL wins over HINDSIGHT_URL", () => {
		const resolution = resolveHindsight(
			{ ...DEFAULT_HINDSIGHT_CONFIG, enabled: true },
			{
				HINDSIGHT_API_URL: "https://a.example.com",
				HINDSIGHT_URL: "https://b.example.com",
				HINDSIGHT_API_KEY: "hs-test-not-a-real-key",
			},
			{ storePath: join(dir, "no-store.json") },
		);
		expect(resolution.readiness).toMatchObject({ state: "ready", url: "https://a.example.com" });
	});

	test("HINDSIGHT_URL is read when HINDSIGHT_API_URL is empty", () => {
		const resolution = resolveHindsight(
			{ ...DEFAULT_HINDSIGHT_CONFIG, enabled: true },
			{
				HINDSIGHT_API_URL: " ",
				HINDSIGHT_URL: "https://b.example.com",
				HINDSIGHT_API_KEY: "hs-test-not-a-real-key",
			},
			{ storePath: join(dir, "no-store.json") },
		);
		expect(resolution.readiness).toMatchObject({ state: "ready", url: "https://b.example.com" });
	});

	test("ULTRATHINK_SWARM_ROOT wins over SWARM_ROOT, which is read only when it is empty", () => {
		const first = swarmCheckout("first");
		const second = swarmCheckout("second");
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: first, SWARM_ROOT: second })).toEqual({
			root: first,
		});
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: " ", SWARM_ROOT: second })).toEqual({
			root: second,
		});
	});

	test("the Substrate bearer is the direct token, then the token file, then the per-surface directory", () => {
		const files: Record<string, string> = {
			"/tokens/file": "from-file",
			"/tokens/dir/omp": "from-dir",
		};
		const read = (path: string): string | null => files[path] ?? null;
		const env = {
			SUBSTRATE_TOKEN: "direct",
			SUBSTRATE_TOKEN_FILE: "/tokens/file",
			SUBSTRATE_TOKENS_DIR: "/tokens/dir",
		};
		expect(resolveSubstrateToken(env, "omp", read)).toBe("direct");
		expect(resolveSubstrateToken({ ...env, SUBSTRATE_TOKEN: "" }, "omp", read)).toBe("from-file");
		expect(
			resolveSubstrateToken({ ...env, SUBSTRATE_TOKEN: "", SUBSTRATE_TOKEN_FILE: "" }, "omp", read),
		).toBe("from-dir");
	});
});
