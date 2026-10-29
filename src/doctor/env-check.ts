// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Runtime and credential checks. Both are offline: the runtime check looks for executables on `PATH` (it never starts `gh`
 * or `curl`; GitHub authentication is reported from the token variables and the gh hosts file, and is not verified), and
 * the credential check reports provider names as present or missing for the features the effective config switches on.
 * A credential value, a prefix of one and its length never appear in a finding.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultStateDir } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { decisionsKilled, resolveDecisionsKeys } from "../decisions/gate.ts";
import { describeJevHealth } from "../decisions/health.ts";
import { DECISIONS_PROVIDERS, type DecisionsProvider } from "../decisions/types.ts";
import { resolveGatewayToken, serviceBackend } from "../gateway/settings.ts";
import {
	GATEWAY_STORE_PROVIDER,
	HINDSIGHT_BACKEND_ENV,
	RAGFLOW_BACKEND_ENV,
	SUBSTRATE_BACKEND_ENV,
} from "../gateway/types.ts";
import { detectHost } from "../host/detect.ts";
import { resolveHindsightKey } from "../hindsight/settings.ts";
import { hasUsableCredential } from "../mcp/client.ts";
import { PROVIDERS, type ProviderId } from "../mcp/providers.ts";
import { readStore, storePath, storeStatus } from "../mcp/store.ts";
import { resolveRagflowKey } from "../ragflow/settings.ts";
import { type DoctorDeps, type Finding, PYTHON_COMMANDS } from "./types.ts";

const MIN_BUN = { major: 1, minor: 2 };
const MIN_PYTHON = { major: 3, minor: 10 };

function parseVersion(text: string | undefined): { major: number; minor: number } | undefined {
	const match = text ? /(\d+)\.(\d+)/.exec(text) : null;
	return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}

function atLeast(
	version: { major: number; minor: number },
	minimum: { major: number; minor: number },
): boolean {
	return (
		version.major > minimum.major ||
		(version.major === minimum.major && version.minor >= minimum.minor)
	);
}

function shipOn(config: UltrathinkConfig, env: DoctorDeps["env"]): boolean {
	return config.ship.enabled && env.ULTRATHINK_SHIP !== "0";
}

function ghHostsFile(env: DoctorDeps["env"]): string {
	const dir =
		env.GH_CONFIG_DIR?.trim() ||
		join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config"), "gh");
	return join(dir, "hosts.yml");
}

/** Bun, git, gh, Python and the detected host. Never throws. */
export function checkRuntime(deps: DoctorDeps): Finding[] {
	const { env } = deps;
	const config = loadConfig(claudeConfigPaths(deps.cwd, env));
	const findings: Finding[] = [];
	const add = (finding: Omit<Finding, "section">): void => {
		findings.push({ section: "runtime", ...finding });
	};

	const bun = parseVersion(deps.bunVersion);
	if (bun && atLeast(bun, MIN_BUN))
		add({ id: "runtime.bun", level: "ok", title: `Bun ${deps.bunVersion}` });
	else {
		add({
			id: "runtime.bun",
			level: "error",
			title: `Bun ${deps.bunVersion || "unknown"} is older than ${MIN_BUN.major}.${MIN_BUN.minor}`,
			detail: "The hooks and every command run on Bun.",
			fix: "Install Bun 1.2 or later (https://bun.sh).",
		});
	}

	if (deps.which("git")) add({ id: "runtime.git", level: "ok", title: "git found on PATH" });
	else {
		add({
			id: "runtime.git",
			level: "error",
			title: "git not found on PATH",
			detail: "Ship and the branch signals need git.",
			fix: "Install git and make sure it is on PATH.",
		});
	}

	const ship = shipOn(config, env);
	const gh = deps.which("gh");
	if (gh) add({ id: "runtime.gh", level: "ok", title: "gh found on PATH" });
	else if (ship) {
		add({
			id: "runtime.gh",
			level: "warn",
			title: "gh not found on PATH, but ship.enabled is on",
			detail: "Ship opens and merges pull requests through gh.",
			fix: "Install the GitHub CLI (https://cli.github.com) or set ship.enabled to false.",
		});
	} else {
		add({
			id: "runtime.gh",
			level: "info",
			title: "gh not found on PATH",
			detail: "Only needed when ship.enabled is on.",
		});
	}
	if (gh || ship) {
		const tokenVar = (["GH_TOKEN", "GITHUB_TOKEN"] as const).find((name) => env[name]?.trim());
		const hostsFile = ghHostsFile(env);
		const hostsPresent = existsSync(hostsFile);
		const source = tokenVar
			? `${tokenVar} is set`
			: hostsPresent
				? "a gh hosts file exists"
				: undefined;
		add({
			id: "runtime.gh-auth",
			level: source ? "info" : ship ? "warn" : "info",
			title: source
				? `gh credentials: ${source}`
				: "gh credentials: no GH_TOKEN, GITHUB_TOKEN or gh hosts file found",
			detail: "Authentication is not verified offline: doctor never runs gh.",
			...(source ? {} : { fix: "Run `gh auth login`, or set GH_TOKEN." }),
		});
	}

	const pythonCommand = PYTHON_COMMANDS.find((name) => deps.which(name));
	const python = pythonCommand ? parseVersion(deps.runVersion(pythonCommand)) : undefined;
	const hermesNote = "Only the Hermes and Prime Agent hosts need Python.";
	if (python && atLeast(python, MIN_PYTHON)) {
		add({ id: "runtime.python", level: "ok", title: `Python ${python.major}.${python.minor}` });
	} else if (python) {
		add({
			id: "runtime.python",
			level: "info",
			title: `Python ${python.major}.${python.minor} is older than ${MIN_PYTHON.major}.${MIN_PYTHON.minor}`,
			detail: hermesNote,
		});
	} else {
		add({ id: "runtime.python", level: "info", title: "Python not found", detail: hermesNote });
	}

	// The hosted service reads its own variables; a doctor run in that environment checks the two that bound a hung plan.
	if (
		env.ULTRATHINK_SERVER_PLANNING === "1" &&
		noTimeout(env.ULTRATHINK_MODEL_TIMEOUT_MS) &&
		noTimeout(env.ULTRATHINK_PLAN_TIMEOUT_MS)
	) {
		add({
			id: "runtime.service-timeouts",
			level: "warn",
			title: "Hosted service plans with no model and no plan timeout",
			detail:
				"ULTRATHINK_MODEL_TIMEOUT_MS and ULTRATHINK_PLAN_TIMEOUT_MS are both unset or 0, so a model call that hangs is never stopped and holds its plan slot until the process restarts or the client cancels.",
			fix: "Set ULTRATHINK_PLAN_TIMEOUT_MS (30000 to 1800000) and/or ULTRATHINK_MODEL_TIMEOUT_MS (5000 to 600000) in the service environment.",
		});
	}

	add({ id: "runtime.host", level: "ok", title: `Detected host: ${detectHost(env)}` });
	return findings;
}

/** A service timeout variable that is unset, blank or 0 turns the timer off. */
function noTimeout(value: string | undefined): boolean {
	const text = value?.trim();
	return text === undefined || text === "" || Number(text) === 0;
}

interface Feature {
	provider: ProviderId | typeof GATEWAY_STORE_PROVIDER;
	features: string[];
}

function featuresOn(config: UltrathinkConfig, env: DoctorDeps["env"]): Feature[] {
	const wanted = new Map<Feature["provider"], string[]>();
	const want = (provider: Feature["provider"], feature: string): void => {
		wanted.set(provider, [...(wanted.get(provider) ?? []), feature]);
	};
	if (shipOn(config, env)) want("greptile", "ship");
	if (config.hitl.knowledgeBase) want("greptile", "knowledge base");
	if (config.notion.dataSourceUrl) want("notion", "Notion tracking");
	if (config.linear.team) want("linear", "Linear tracking");
	if (config.hindsight.enabled && env.ULTRATHINK_HINDSIGHT !== "0") {
		want(
			serviceBackend(config.hindsight.backend, env, HINDSIGHT_BACKEND_ENV) === "gateway"
				? GATEWAY_STORE_PROVIDER
				: "hindsight",
			"Hindsight",
		);
	}
	if (config.ragflow.enabled && env.ULTRATHINK_RAGFLOW?.trim() !== "0") {
		want(
			serviceBackend(config.ragflow.backend, env, RAGFLOW_BACKEND_ENV) === "gateway"
				? GATEWAY_STORE_PROVIDER
				: "ragflow",
			"RAGFlow",
		);
	}
	if (
		env.SUBSTRATE_DISABLED !== "1" &&
		serviceBackend(config.substrate.backend, env, SUBSTRATE_BACKEND_ENV) === "gateway"
	) {
		want(GATEWAY_STORE_PROVIDER, "substrate");
	}
	return [...wanted].map(([provider, features]) => ({ provider, features }));
}

function fixFor(provider: ProviderId): string {
	const base = "bin/ultrathink-mcp";
	if (provider === "notion") return `${base} auth login notion`;
	if (PROVIDERS[provider].kind === "mcp")
		return `${base} auth set-key ${provider} --stdin (or ${base} auth login ${provider})`;
	return `${base} auth set-key ${provider} --stdin`;
}

/** Provider names, present or missing, for the features the config switches on. Never reads or prints a credential value. */
/** The key-based rails Jev can run on: every decisions provider but `auto`, so no rail is spelled out in this module. */
const JEV_RAILS = DECISIONS_PROVIDERS.filter(
	(provider): provider is Exclude<DecisionsProvider, "auto"> => provider !== "auto",
);

export function checkCredentials(deps: DoctorDeps): Finding[] {
	const { env } = deps;
	const config = loadConfig(claudeConfigPaths(deps.cwd, env));
	const path = storePath(env);
	const store = readStore(path);
	const findings: Finding[] = [];
	const add = (finding: Omit<Finding, "section">): void => {
		findings.push({ section: "credentials", ...finding });
	};

	const status = storeStatus(path);
	if (status.exists && !status.parsable) {
		// The path only: the content of a credential file is never read into a finding.
		add({
			id: "credentials.store.unreadable",
			level: "warn",
			title: `Credential store does not parse: ${path}`,
			detail:
				"The file exists but is not a version 1 credential store, so every stored credential reads as missing.",
			fix: "Repair or remove the file, then store the keys again with bin/ultrathink-mcp auth set-key <provider> --stdin or auth login <provider>.",
		});
	}
	if (status.exists && status.mode !== undefined && (status.mode & 0o044) !== 0) {
		add({
			id: "credentials.store.mode",
			level: "warn",
			title: `Credential store is readable by group or others (mode ${status.mode.toString(8).padStart(4, "0")}): ${path}`,
			detail: "The file holds API keys and OAuth tokens; only its owner should be able to read it.",
			fix: `chmod 600 ${path}`,
		});
	}

	for (const { provider, features } of featuresOn(config, env)) {
		const used = `needed for ${features.join(" and ")}`;
		if (provider === GATEWAY_STORE_PROVIDER) {
			const source = resolveGatewayToken(path, env)?.source;
			add({
				id: `credentials.${provider}`,
				level: source ? "ok" : "warn",
				title: source
					? `Desk gateway: credential present (${source === "store" ? "credential store" : source})`
					: "Desk gateway: no credential",
				detail: used,
				...(source ? {} : { fix: "Set DESK_GATEWAY_TOKEN or store a desk-gateway credential." }),
			});
			continue;
		}
		const label = PROVIDERS[provider].label;
		let source: string | undefined;
		if (provider === "hindsight") source = resolveHindsightKey(path, env)?.source;
		else if (provider === "ragflow") source = resolveRagflowKey(path, env)?.source;
		else if (hasUsableCredential(provider, path)) source = "store";
		const present = source !== undefined;
		const stored = PROVIDERS[provider].kind === "mcp" && store.providers[provider] !== undefined;
		if (present) {
			add({
				id: `credentials.${provider}`,
				level: "ok",
				title: `${label}: credential present (${source === "store" ? "credential store" : source})`,
				detail: used,
			});
		} else {
			add({
				id: `credentials.${provider}`,
				level: "warn",
				title: `${label}: ${stored ? "stored credential needs a new login" : "no credential"}`,
				detail: used,
				fix: fixFor(provider),
			});
		}
	}

	if (decisionsKilled(env)) {
		add({
			id: "credentials.jev",
			level: "info",
			title: "Jev decisions: off (ULTRATHINK_DECISIONS=0)",
		});
	} else {
		const jev = resolveDecisionsKeys(config.decisions, path, env);
		if (jev.key) {
			add({
				id: "credentials.jev",
				level: "ok",
				title: `Jev decisions: ${PROVIDERS[jev.provider].label} key present (${jev.key.source === "store" ? "credential store" : jev.key.source})`,
			});
		} else {
			const [firstRail, ...otherRails] = JEV_RAILS;
			add({
				id: "credentials.jev",
				level: "info",
				title: `Jev decisions: no ${JEV_RAILS.map((rail) => PROVIDERS[rail].label).join(" or ")} key`,
				detail: "Decision points are skipped without one; planning continues.",
				fix: `bin/ultrathink-mcp auth set-key ${firstRail} --stdin${otherRails.length > 0 ? ` (or ${otherRails.join(", ")})` : ""}`,
			});
			if (env.OPENROUTER_API_KEY?.trim()) {
				// Retired name: say so instead of leaving the owner wondering why an exported key does nothing.
				add({
					id: "credentials.jev.legacy",
					level: "warn",
					title: "Jev decisions: OPENROUTER_API_KEY is set but Ultrathink no longer reads it",
					detail: "Jev reads the credential store or ULTRATHINK_OPENROUTER_KEY.",
					fix: "bin/ultrathink-mcp auth set-key openrouter --stdin",
				});
			}
		}
		const breaker = describeJevHealth(defaultStateDir(env), deps.now());
		if (breaker) add({ id: "decisions.health", level: "warn", title: breaker });
	}
	if (env.OPENROUTER_API_KEY?.trim()) {
		add({
			id: "credentials.openrouter-export",
			level: "warn",
			title:
				"OPENROUTER_API_KEY is exported: Ultrathink no longer reads it (Jev uses the credential store or ULTRATHINK_OPENROUTER_KEY), so the export only lets other tools in this environment spend the key",
			fix: "remove the export from your shell profile or service unit",
		});
	}
	return findings;
}
