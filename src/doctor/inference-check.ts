// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The `inference` doctor section: can the two coding-plan logins serve planning? The Claude CLI (installed, new enough
 * for the configured model, signed in with a plan login) and the Grok Build login (the fallback). Offline: the only
 * outside inputs are the injected `claudeVersion` and `claudeAuth` probes (`claude --version` and
 * `claude auth status --json`) and one read of the Grok `auth.json`; nothing is created and nothing is sent anywhere.
 * `claude auth status` output is parsed for `loggedIn`, `authMethod` and `subscriptionType` only: an email, an
 * organization or any token field in it is never read into a finding. Every finding is info, ok or warn.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { planEnv } from "../claude/complete.ts";
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { grokAuthStatus } from "../grok/auth.ts";
import { detectHost } from "../host/detect.ts";
import { HOST_DEFAULT_ENGINES } from "../host/engine.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { formatAge } from "./state-check.ts";
import type { DoctorDeps, Finding } from "./types.ts";

/** Oldest Claude Code that serves a model. Keyed by lowercase model id or alias; an unknown model has no minimum. */
const CLAUDE_MIN_VERSIONS: Readonly<Record<string, string>> = {
	"claude-haiku-5-5": "2.1.293",
	haiku: "2.1.293",
	"claude-sonnet-5-5": "2.1.284",
	sonnet: "2.1.284",
	"claude-opus-5-5": "2.1.280",
	opus: "2.1.280",
};

const SEMVER = /(\d+)\.(\d+)\.(\d+)/;

function parseSemver(text: string): [number, number, number] | undefined {
	const match = SEMVER.exec(text);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer. */
function compareSemver(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

const SAFE_LABEL = /^[A-Za-z0-9_.-]{1,40}$/;

/** A short machine label from the status JSON, or undefined: free text never reaches a finding. */
function safeLabel(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_LABEL.test(value) ? value : undefined;
}

interface ClaudeStatus {
	loggedIn: boolean;
	authMethod: string | undefined;
	subscriptionType: string | undefined;
}

/** Tolerant: a banner before or after the JSON object is skipped; anything else unparseable yields undefined. */
function parseClaudeStatus(stdout: string): ClaudeStatus | undefined {
	const text = stdout.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// reason: fall through to the object-slice attempt below.
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start < 0 || end <= start) return undefined;
		try {
			parsed = JSON.parse(text.slice(start, end + 1));
		} catch {
			// reason: not JSON at all; the auth finding is skipped.
			return undefined;
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const record = parsed as Record<string, unknown>;
	return {
		loggedIn: record.loggedIn === true,
		authMethod: safeLabel(record.authMethod),
		subscriptionType: safeLabel(record.subscriptionType),
	};
}

function cliFinding(deps: DoctorDeps, model: string): Finding | undefined {
	if (!deps.which("claude")) {
		return {
			id: "inference.claude.cli",
			section: "inference",
			level: "warn",
			title: "claude CLI not found: the Claude route cannot plan",
			fix: "Install Claude Code (https://code.claude.com/docs/en/setup)",
		};
	}
	const line = deps.claudeVersion?.();
	const version = line === undefined ? undefined : parseSemver(line);
	if (!version) return undefined;
	const shown = version.join(".");
	const minimum = CLAUDE_MIN_VERSIONS[model.trim().toLowerCase()];
	const minimumVersion = minimum === undefined ? undefined : parseSemver(minimum);
	if (minimum && minimumVersion && compareSemver(version, minimumVersion) < 0) {
		return {
			id: "inference.claude.cli",
			section: "inference",
			level: "warn",
			title: `claude ${shown} is older than ${minimum}, which ${model} needs`,
			fix: "claude update",
		};
	}
	return {
		id: "inference.claude.cli",
		section: "inference",
		level: "ok",
		title: `claude ${shown}`,
	};
}

function authFindings(deps: DoctorDeps, mode: "plan" | "api-key"): Finding[] {
	if (mode === "api-key") {
		const findings: Finding[] = [
			{
				id: "inference.claude.auth",
				section: "inference",
				level: "info",
				title: "Claude auth: API key (claude.auth is api-key)",
			},
		];
		if (!deps.env.ANTHROPIC_API_KEY?.trim() && !deps.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
			findings.push({
				id: "inference.claude.auth.key",
				section: "inference",
				level: "warn",
				title:
					"claude.auth is api-key but neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set",
				fix: "Export ANTHROPIC_API_KEY, or set claude.auth to plan to use your Claude login",
			});
		}
		return findings;
	}
	if (!deps.claudeAuth || !deps.which("claude")) return [];
	const raw = deps.claudeAuth(planEnv(deps.env));
	const status = raw === undefined ? undefined : parseClaudeStatus(raw);
	if (!status) return [];
	if (!status.loggedIn) {
		return [
			{
				id: "inference.claude.auth",
				section: "inference",
				level: "warn",
				title: "Claude auth: no plan login",
				fix: "Run claude and sign in with /login, or run claude setup-token and export CLAUDE_CODE_OAUTH_TOKEN",
			},
		];
	}
	if (status.authMethod === "claude.ai") {
		return [
			{
				id: "inference.claude.auth",
				section: "inference",
				level: "ok",
				title: `Claude auth: plan login (${status.subscriptionType ?? "plan"})`,
			},
		];
	}
	return [
		{
			id: "inference.claude.auth",
			section: "inference",
			level: "info",
			title: `Claude auth: ${status.authMethod ?? "unknown"}`,
		},
	];
}

function keyFinding(deps: DoctorDeps): Finding | undefined {
	const set = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].filter((name) =>
		deps.env[name]?.trim(),
	);
	if (set.length === 0) return undefined;
	return {
		id: "inference.claude.key",
		section: "inference",
		level: "info",
		title: `${set.join(" and ")} ${set.length === 1 ? "is" : "are"} set and ignored for planning (claude.auth is plan)`,
		detail: "Other tools, including an interactive claude, still use it and bill the API",
		fix: "Unset it where your shell or service sets it",
	};
}

function grokFinding(deps: DoctorDeps, config: UltrathinkConfig): Finding {
	if (config.grok.transport === "shunt") {
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "info",
			title: "Grok route uses a shunt gateway",
		};
	}
	const now = deps.now();
	const home =
		config.grok.home.trim() ||
		deps.env.GROK_HOME?.trim() ||
		join(deps.env.HOME?.trim() || deps.env.USERPROFILE?.trim() || homedir(), ".grok");
	const status = grokAuthStatus(home, now);
	if (status.loggedIn && !status.expired) {
		const account = status.email ?? "signed in";
		const expires = status.expiresAt
			? ` expires in ${formatAge(Date.parse(status.expiresAt) - now)}`
			: "";
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "ok",
			title: `Grok login: ${account}${expires}`,
		};
	}
	if (status.loggedIn) {
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "warn",
			title: "Grok login expired",
			fix: "grok login",
		};
	}
	const engine =
		config.think.engine === "auto"
			? HOST_DEFAULT_ENGINES[detectHost(deps.env)]
			: config.think.engine;
	if (config.claude.fallbackToGrok || engine === "grok") {
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "warn",
			title: "Grok login: not signed in",
			detail: config.claude.fallbackToGrok
				? "claude.fallbackToGrok is on, so a failed Claude call has nowhere to go"
				: "The engine resolves to the Grok route",
			fix: "grok login",
		};
	}
	return {
		id: "inference.grok.login",
		section: "inference",
		level: "info",
		title: "Grok login: not signed in (the Grok route is not in use)",
	};
}

/** Claude CLI, plan login and Grok login for the inference routes. Reads config and the Grok auth file; never writes. */
export function checkInference(deps: DoctorDeps): Finding[] {
	const config = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
	const findings: Finding[] = [];
	const cli = cliFinding(deps, config.claude.model);
	if (cli) findings.push(cli);
	findings.push(...authFindings(deps, config.claude.auth));
	if (config.claude.auth === "plan") {
		const key = keyFinding(deps);
		if (key) findings.push(key);
	}
	findings.push(grokFinding(deps, config));

	const grokModels = [...new Set([config.grok.model, ...config.grok.fallbackModels])];
	findings.push({
		id: "inference.fallback",
		section: "inference",
		level: "info",
		title: config.claude.fallbackToGrok
			? `Claude to Grok fallback: on (models ${grokModels.join(", ")})`
			: "Claude to Grok fallback: off (claude.fallbackToGrok is false)",
	});

	const claudeModel = config.claude.model.trim();
	const thenModels = config.grok.fallbackModels;
	const models: Finding = {
		id: "inference.models",
		section: "inference",
		level: "info",
		title: `Models: claude ${claudeModel || "(default)"}, grok ${config.grok.model}${
			thenModels.length > 0 ? ` then ${thenModels.join(", ")}` : ""
		}`,
	};
	if (claudeModel && claudeModel !== ROUTE_DEFAULT_MODELS.claude) {
		models.detail = "claude.model is pinned in config";
	}
	findings.push(models);
	return findings;
}
