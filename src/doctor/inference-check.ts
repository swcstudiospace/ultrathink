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
import { displayId } from "../claude/output.ts";
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { type GrokAuthStatus, grokAuthStatus } from "../grok/auth.ts";
import { detectHost } from "../host/detect.ts";
import { HOST_DEFAULT_ENGINES } from "../host/engine.ts";
import { MEMORY_CHAIN, memoryChainFor } from "../host/memory-chain.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { TEACH_KILL_ENV } from "../teach/types.ts";
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

/** The Claude model planning really sends on this host: a non-blank `models.hosts.<host>.model` wins, except on Omp (a native target, never a CLI wire model). */
function effectiveClaudeModel(
	deps: DoctorDeps,
	config: UltrathinkConfig,
): { model: string; hostOverride: boolean } {
	const host = detectHost(deps.env);
	const override = host === "omp" ? "" : (config.models.hosts[host]?.model.trim() ?? "");
	return override
		? { model: override, hostOverride: true }
		: { model: config.claude.model.trim(), hostOverride: false };
}

/** The minimum Claude Code version for a model id or alias, parsed; undefined for an unknown model. */
function minimumFor(model: string): { text: string; parsed: [number, number, number] } | undefined {
	const text = CLAUDE_MIN_VERSIONS[model.trim().toLowerCase()];
	const parsed = text === undefined ? undefined : parseSemver(text);
	return text !== undefined && parsed ? { text, parsed } : undefined;
}

/**
 * The CLI findings: `inference.claude.cli` for the planning model, then, when `memoryModel` is given, a separate
 * `inference.memory.cli` if the installed Claude Code is below the memory-bank model's minimum and updating for the
 * planning finding would not already fix it.
 */
function cliFindings(
	deps: DoctorDeps,
	bin: string,
	model: string,
	memoryModel: string | undefined,
): Finding[] {
	if (!deps.which(bin)) {
		const finding: Finding = {
			id: "inference.claude.cli",
			section: "inference",
			level: "warn",
			title: "claude CLI not found: the Claude route cannot plan",
			fix: "Install Claude Code (https://code.claude.com/docs/en/setup)",
		};
		// The distill is active exactly when a memory model is passed: say that it needs the CLI too.
		if (memoryModel !== undefined) {
			finding.detail = `The memory-bank distill also needs it: it runs ${displayId(memoryModel, "<opaque-model>")} through the claude CLI first, and Grok Build only with claude.fallbackToGrok and a Grok login. With neither, teach observe reports "distiller failed".`;
		}
		return [finding];
	}
	const line = deps.claudeVersion?.(bin);
	const version = line === undefined ? undefined : parseSemver(line);
	if (!version) return [];
	const shown = version.join(".");
	const planning = minimumFor(model);
	const planningFails = planning !== undefined && compareSemver(version, planning.parsed) < 0;
	const findings: Finding[] = [
		planning && planningFails
			? {
					id: "inference.claude.cli",
					section: "inference",
					level: "warn",
					title: `claude ${shown} is older than ${planning.text}, which ${displayId(model, "<opaque-model>")} needs`,
					fix: "claude update",
				}
			: {
					id: "inference.claude.cli",
					section: "inference",
					level: "ok",
					title: `claude ${shown}`,
				},
	];
	const memory = memoryModel === undefined ? undefined : minimumFor(memoryModel);
	if (memoryModel === undefined || !memory || compareSemver(version, memory.parsed) >= 0) {
		return findings;
	}
	// One `claude update` fixes both when the planning minimum is at least the memory minimum: do not repeat it.
	if (planning && planningFails && compareSemver(planning.parsed, memory.parsed) >= 0) {
		return findings;
	}
	findings.push({
		id: "inference.memory.cli",
		section: "inference",
		level: "warn",
		title: `claude ${shown} is older than ${memory.text}, which ${displayId(memoryModel, "<opaque-model>")} needs for memory-bank calls`,
		fix: "claude update",
	});
	return findings;
}

/** Whether a `teach observe` distill can run, hence a memory-bank model call: not killed by env, enabled, and not explicit-only capture. */
function memoryCallsActive(deps: DoctorDeps, config: UltrathinkConfig): boolean {
	return (
		deps.env[TEACH_KILL_ENV] !== "0" && config.teach.enabled && config.teach.capture !== "explicit"
	);
}

function authFindings(deps: DoctorDeps, mode: "plan" | "api-key", bin: string): Finding[] {
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
	if (!deps.claudeAuth || !deps.which(bin)) return [];
	const raw = deps.claudeAuth(planEnv(deps.env), bin);
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

/** The fix for a missing or expired Grok login: the lane login command, and the raw CLI form for a dedicated home. */
function grokLoginFix(laneHome: string): string {
	return laneHome
		? `ultrathink grok login (or GROK_HOME=${laneHome} grok login --device-auth)`
		: "ultrathink grok login";
}

/** The Grok home the login finding reads and its signed-in state; offline, so an expired token is not refreshed. */
function grokLoginState(
	deps: DoctorDeps,
	config: UltrathinkConfig,
): { laneHome: string; status: GrokAuthStatus } {
	const laneHome = config.grok.home.trim();
	const home =
		laneHome ||
		deps.env.GROK_HOME?.trim() ||
		join(deps.env.HOME?.trim() || deps.env.USERPROFILE?.trim() || homedir(), ".grok");
	return { laneHome, status: grokAuthStatus(home, deps.now()) };
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
	const { laneHome, status } = grokLoginState(deps, config);
	const laneNote = laneHome ? `Grok lane home: ${laneHome}` : undefined;
	if (status.loggedIn && !status.expired) {
		const account = status.email ?? "signed in";
		const expires = status.expiresAt
			? ` expires in ${formatAge(Date.parse(status.expiresAt) - now)}`
			: "";
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "ok",
			title: `Grok login: ${account}${expires}${laneHome ? ` (home ${laneHome})` : ""}`,
		};
	}
	if (status.loggedIn) {
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "warn",
			title: "Grok login expired",
			...(laneNote ? { detail: laneNote } : {}),
			fix: grokLoginFix(laneHome),
		};
	}
	const engine =
		config.think.engine === "auto"
			? HOST_DEFAULT_ENGINES[detectHost(deps.env)]
			: config.think.engine;
	if (config.claude.fallbackToGrok || engine === "grok") {
		const reason = config.claude.fallbackToGrok
			? "claude.fallbackToGrok is on, so a failed Claude call has nowhere to go"
			: "The engine resolves to the Grok route";
		return {
			id: "inference.grok.login",
			section: "inference",
			level: "warn",
			title: "Grok login: not signed in",
			detail: laneNote ? `${reason}\n${laneNote}` : reason,
			fix: grokLoginFix(laneHome),
		};
	}
	return {
		id: "inference.grok.login",
		section: "inference",
		level: "info",
		title: "Grok login: not signed in (the Grok route is not in use)",
		...(laneNote ? { detail: laneNote } : {}),
	};
}

/** Why a memory-bank call has no Grok fallback, mirroring the conditions in `memoryChainFor`. */
function memoryFallbackReason(config: UltrathinkConfig): string {
	if (!config.claude.fallbackToGrok) return "No Grok fallback: claude.fallbackToGrok is off";
	if (!config.grok.enabled) return "No Grok fallback: grok.enabled is false";
	return "No Grok fallback: grok.transport is shunt, which cannot be proven to be Grok Build";
}

/** The pinned memory-bank chain, plus every configured value that does not apply to it. Info only: it describes, never fails. */
function memoryFinding(deps: DoctorDeps, config: UltrathinkConfig): Finding {
	const chain = memoryChainFor(config);
	const primary = displayId(MEMORY_CHAIN.primary.model, "<opaque-model>");
	const fallback = displayId(MEMORY_CHAIN.fallback.model, "<opaque-model>");
	const configured = chain.length > 1;
	// The engine adds Grok only when the lane is signed in; the doctor reads the same state offline.
	const login = configured ? grokLoginState(deps, config).status : undefined;
	const active = login !== undefined && login.loggedIn && !login.expired;
	const detail = [
		"Hindsight needs no inference (chunks mode); only the local observe distill calls a model.",
	];
	if (!configured) detail.push(memoryFallbackReason(config));
	let title = `Memory-bank inference: ${primary}`;
	if (active) title += `, then ${fallback}`;
	else if (configured) {
		const why = login?.loggedIn ? "login expired" : "not signed in";
		title += ` only; Grok Build fallback configured but inactive (${why}: ultrathink grok login)`;
	} else if (!config.claude.fallbackToGrok) {
		title += " only; Grok Build fallback is off (claude.fallbackToGrok is false)";
	} else title += " only";
	const ignored = (setting: string, value: string, scope: string): void => {
		const shown = displayId(value, "<opaque-model>");
		detail.push(`${setting} ${shown} applies to ${scope}, not to memory-bank calls`);
	};
	const claudeModel = config.claude.model.trim();
	if (claudeModel && claudeModel !== MEMORY_CHAIN.primary.model) {
		ignored("claude.model", claudeModel, "planning and helpers");
	}
	const host = detectHost(deps.env);
	const hostModel = config.models.hosts[host]?.model.trim() ?? "";
	if (hostModel && hostModel !== MEMORY_CHAIN.primary.model) {
		ignored(`models.hosts.${host}.model`, hostModel, "planning and helpers");
	}
	const grokModel = config.grok.model.trim();
	if (grokModel && grokModel !== MEMORY_CHAIN.fallback.model) {
		ignored("grok.model", grokModel, "planning");
	}
	const extra = config.grok.fallbackModels.map((model) => displayId(model, "<opaque-model>"));
	if (extra.length > 0) {
		detail.push(
			`grok.fallbackModels (${extra.join(", ")}) apply to planning, not to memory-bank calls`,
		);
	}
	return {
		id: "inference.memory",
		section: "inference",
		level: "info",
		title,
		detail: detail.join("\n"),
	};
}

/** Claude CLI, plan login and Grok login for the inference routes. Reads config and the Grok auth file; never writes. */
export function checkInference(deps: DoctorDeps): Finding[] {
	const config = loadConfig(claudeConfigPaths(deps.cwd, deps.env));
	const findings: Finding[] = [];
	const bin = config.claude.bin;
	const claude = effectiveClaudeModel(deps, config);
	findings.push(
		...cliFindings(
			deps,
			bin,
			claude.model,
			memoryCallsActive(deps, config) ? MEMORY_CHAIN.primary.model : undefined,
		),
	);
	findings.push(...authFindings(deps, config.claude.auth, bin));
	if (config.claude.auth === "plan") {
		const key = keyFinding(deps);
		if (key) findings.push(key);
	}
	findings.push(grokFinding(deps, config));

	const grokModels = [...new Set([config.grok.model, ...config.grok.fallbackModels])].map((model) =>
		displayId(model, "<opaque-model>"),
	);
	findings.push({
		id: "inference.fallback",
		section: "inference",
		level: "info",
		title: config.claude.fallbackToGrok
			? `Claude to Grok fallback: on (models ${grokModels.join(", ")})`
			: "Claude to Grok fallback: off (claude.fallbackToGrok is false)",
	});

	const claudeModel = claude.model;
	const thenModels = config.grok.fallbackModels.map((model) => displayId(model, "<opaque-model>"));
	const models: Finding = {
		id: "inference.models",
		section: "inference",
		level: "info",
		title: `Models: claude ${claudeModel ? displayId(claudeModel, "<opaque-model>") : "(default)"}, grok ${displayId(config.grok.model, "<opaque-model>")}${
			thenModels.length > 0 ? ` then ${thenModels.join(", ")}` : ""
		}`,
	};
	if (claudeModel && claudeModel !== ROUTE_DEFAULT_MODELS.claude) {
		models.detail = claude.hostOverride
			? `claude model comes from models.hosts.${detectHost(deps.env)}.model`
			: "claude.model is pinned in config";
	}
	findings.push(models);
	findings.push(memoryFinding(deps, config));
	return findings;
}
