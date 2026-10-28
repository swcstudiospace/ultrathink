// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The table of every user-facing environment variable, and a reporting-only validator over it.
 *
 * The runtime stays lenient: every reader of these variables still falls back silently on a bad value. {@link validateEnv}
 * changes nothing about that. It only names what the code would ignore or reject, so `ultrathink doctor` can list every
 * problem in one report. A finding names variables and expectations; it NEVER carries a value, because a value may be a
 * token, a path or a URL with credentials.
 *
 * Each row was checked against the code that reads it (cited in the row's family notes below). Not listed on purpose:
 * internal markers (`ULTRATHINK_CHILD`, `ULTRATHINK_BUN_REQUIRED`, `ULTRATHINK_PRUNE_NOW_MS`, test clocks) and
 * `OPENROUTER_API_KEY`, whose misuse `src/doctor/env-check.ts` already reports (no duplicate finding here).
 *
 * Kind semantics: `bool01` means only exact `"0"` and `"1"` are meaningful; `bool1` means only exact `"1"` enables;
 * `enum` lists the allowed values in `values`. An entry with `disableValue` is a kill switch: only that exact value
 * (trimmed, compared without case) has an effect, so any other non-empty value is reported. Empty or blank values count
 * as unset everywhere. Each such row (and every boolean and enum row) records in `reader` whether its real reader trims
 * the value or compares the raw string; a padded value is reported when only a trimming reader would honour it.
 *
 * Precedence of the setting families, as the resolvers implement it:
 * - Hindsight URL: `hindsight.url` in config, else `HINDSIGHT_API_URL`, else `HINDSIGHT_URL` (src/hindsight/settings.ts).
 * - Swarm root: a non-empty `ULTRATHINK_SWARM_ROOT` wins; `SWARM_ROOT` is read only when it is empty (src/swarm/teams.ts).
 * - Substrate bearer: `SUBSTRATE_TOKEN`, then the first line of `SUBSTRATE_TOKEN_FILE`, then the first line of
 *   `SUBSTRATE_TOKENS_DIR/<surface>` (src/substrate/surface.ts).
 */
import { isAbsolute } from "node:path";
import { resolveDecisionsUrl } from "./decisions/client.ts";
import { HOSTS } from "./host/types.ts";
import { checkServiceUrl } from "./net/safe-url.ts";

type EnvKind = "url" | "int" | "bool01" | "bool1" | "enum" | "path" | "string";
export type EnvScope = "plugin" | "service" | "stack";

export interface EnvVarDef {
	name: string;
	/** Other names read for the same setting; the canonical `name` wins when both are set. */
	aliases?: readonly string[];
	secret: boolean;
	kind: EnvKind;
	scope: EnvScope;
	description: string;
	/** The setting family the generated reference groups the row under, for example `substrate-url` or `kill-switch`. */
	family: string;
	/** For a kill switch: the one value that has an effect. */
	disableValue?: string;
	/**
	 * Required on every `bool01`, `bool1` and `enum` row and every kill switch: how the real reader treats surrounding
	 * whitespace. `trims` readers strip it (the value still works); `raw` readers compare the exact string, so a padded
	 * value (for example `SUBSTRATE_DISABLED=" 1 "`) has no effect even though {@link validateEnv} would accept it trimmed.
	 */
	reader?: "trims" | "raw";
	/** For `enum`: the allowed values. */
	values?: readonly string[];
	default?: string;
	min?: number;
	max?: number;
}

/** The optional parts of a row; `secret` defaults to false. */
type RowExtra = Partial<
	Pick<
		EnvVarDef,
		"secret" | "aliases" | "disableValue" | "reader" | "values" | "default" | "min" | "max"
	>
>;

function row(
	scope: EnvScope,
	family: string,
	kind: EnvKind,
	name: string,
	description: string,
	extra: RowExtra = {},
): EnvVarDef {
	return { name, secret: false, kind, scope, description, family, ...extra };
}

const KILL = "kill-switch";

/** Kill switches that disable on the exact string `0` (the polarity differs from `SUBSTRATE_DISABLED=1`). */
function killZero(
	scope: EnvScope,
	name: string,
	description: string,
	reader: "trims" | "raw" = "raw",
): EnvVarDef {
	return row(scope, KILL, "bool01", name, description, { disableValue: "0", reader });
}

export const ENV_REGISTRY: readonly EnvVarDef[] = [
	// Kill switches: src/host/plan.ts, src/uplift/commands.ts, src/ship/policy.ts, src/decisions/gate.ts,
	// src/hindsight/settings.ts, src/ragflow/settings.ts, src/teach/types.ts, src/gateway/settings.ts,
	// src/doctor/pstack-check.ts, src/stack/realm.ts, src/substrate/brief.ts.
	killZero(
		"plugin",
		"ULTRATHINK_UPLIFT",
		"Set to 0 to plan no prompt in this process. The uplift prefix does not override it.",
	),
	killZero(
		"plugin",
		"ULTRATHINK_TRACK",
		"Set to 0 so the planner creates no tracker rows in this process.",
	),
	killZero(
		"plugin",
		"ULTRATHINK_SHIP",
		"Set to 0 for no ship instruction in the plan and no ship nudge, even with ship.enabled.",
	),
	killZero(
		"stack",
		"ULTRATHINK_DECISIONS",
		"Set to 0 to turn every Jev decision point off for this process, whatever the config says.",
	),
	killZero(
		"stack",
		"ULTRATHINK_HINDSIGHT",
		"Set to 0 to send no Hindsight request in this process, even with hindsight.enabled.",
	),
	killZero(
		"plugin",
		"ULTRATHINK_RAGFLOW",
		"Set to 0 to send no RAGFlow request in this process; whitespace around the 0 is trimmed.",
		"trims",
	),
	killZero(
		"plugin",
		"ULTRATHINK_TEACH",
		"Set to 0 to turn Teachable Moments off for this process (no capture, recall or promote).",
	),
	killZero(
		"plugin",
		"ULTRATHINK_GATEWAY",
		"Set to 0 to force Hindsight, RAGFlow and the Substrate brief back to their direct backends.",
	),
	killZero(
		"plugin",
		"ULTRATHINK_PSTACK",
		"Set to 0 so the Cursor pstack hook injects nothing for this process.",
	),
	row(
		"stack",
		KILL,
		"bool1",
		"SUBSTRATE_DISABLED",
		"Set to 1 to never contact Agent Substrate, even when SUBSTRATE_URL or substrate.url is set.",
		{ disableValue: "1", reader: "raw" },
	),
	row(
		"stack",
		KILL,
		"enum",
		"ULTRATHINK_REALM",
		"Set to off to skip the Realm probe; any other value leaves it on.",
		{ disableValue: "off", values: ["off"], reader: "trims" },
	),

	// Backend selectors: src/gateway/settings.ts serviceBackend; other values silently fall back to the config value.
	row(
		"plugin",
		"gateway",
		"enum",
		"ULTRATHINK_HINDSIGHT_BACKEND",
		"Chooses the Hindsight backend and wins over hindsight.backend unless ULTRATHINK_GATEWAY is 0.",
		{ values: ["direct", "gateway"], reader: "raw" },
	),
	row(
		"plugin",
		"gateway",
		"enum",
		"ULTRATHINK_RAGFLOW_BACKEND",
		"Chooses the RAGFlow backend and wins over ragflow.backend unless ULTRATHINK_GATEWAY is 0.",
		{ values: ["direct", "gateway"], reader: "raw" },
	),
	row(
		"plugin",
		"gateway",
		"enum",
		"ULTRATHINK_SUBSTRATE_BACKEND",
		"Chooses the Substrate brief backend and wins over substrate.backend unless ULTRATHINK_GATEWAY is 0.",
		{ values: ["direct", "gateway"], reader: "raw" },
	),

	// Substrate: src/substrate/brief.ts (URL, timeout, disabled) and src/substrate/surface.ts (bearer).
	row(
		"stack",
		"substrate-url",
		"url",
		"SUBSTRATE_URL",
		"Agent Substrate base URL. It wins over substrate.url in the config file.",
	),
	row(
		"stack",
		"substrate-token",
		"string",
		"SUBSTRATE_TOKEN",
		"Bearer sent to Agent Substrate. It wins over SUBSTRATE_TOKEN_FILE and the per-surface tokens directory.",
		{ secret: true },
	),
	row(
		"stack",
		"substrate-token",
		"path",
		"SUBSTRATE_TOKEN_FILE",
		"File whose first line is the bearer when SUBSTRATE_TOKEN is empty. It wins over the per-surface tokens directory.",
	),
	row(
		"stack",
		"substrate-token",
		"path",
		"SUBSTRATE_TOKENS_DIR",
		"Directory of per-surface bearer files, read as DIR/SURFACE when neither SUBSTRATE_TOKEN nor SUBSTRATE_TOKEN_FILE gives one. The surface is the host name (claude-code, cursor, hermes, omp, muse, grok-build; prime-agent uses pi) and must match [a-z0-9][a-z0-9-]{0,63}.",
		{ default: "/etc/substrate/tokens" },
	),
	row(
		"stack",
		"substrate-url",
		"int",
		"SUBSTRATE_TIMEOUT_MS",
		"Timeout of one Agent Substrate request in milliseconds. A positive number; anything else means the default.",
		{ default: "1500", min: 1 },
	),

	// Hindsight: src/hindsight/types.ts and settings.ts. The stored key wins over both key variables.
	row(
		"stack",
		"hindsight-url",
		"url",
		"HINDSIGHT_API_URL",
		"Hindsight base URL, used only when hindsight.url is empty. HINDSIGHT_URL is read when this one is empty.",
		{ aliases: ["HINDSIGHT_URL"] },
	),
	row(
		"stack",
		"hindsight-key",
		"string",
		"HINDSIGHT_API_KEY",
		"Hindsight API key, used when no hindsight key is stored. The stored key wins.",
		{ secret: true },
	),
	row(
		"stack",
		"hindsight-key",
		"string",
		"HINDSIGHT_API_TOKEN",
		"Hindsight API key, used only when no key is stored and HINDSIGHT_API_KEY is empty.",
		{ secret: true },
	),

	// RAGFlow: src/ragflow/types.ts and settings.ts.
	row(
		"plugin",
		"ragflow",
		"url",
		"RAGFLOW_URL",
		"RAGFlow base URL, used only when ragflow.url is empty.",
	),
	row(
		"plugin",
		"ragflow",
		"string",
		"RAGFLOW_API_KEY",
		"RAGFlow API key, used when no ragflow key is stored. The stored key wins.",
		{ secret: true },
	),

	// Desk gateway: src/gateway/settings.ts and types.ts.
	row(
		"plugin",
		"gateway",
		"url",
		"DESK_GATEWAY_URL",
		"Desk gateway base URL. It wins over gateway.url in the config file.",
	),
	row(
		"plugin",
		"gateway",
		"string",
		"DESK_GATEWAY_SEAT",
		"Desk gateway seat name; a name that does not match [a-z][a-z0-9-]{0,31} is ignored.",
	),
	row(
		"plugin",
		"gateway",
		"string",
		"DESK_GATEWAY_TOKEN",
		"Desk gateway token, used when no gateway token is stored. The stored token wins.",
		{ secret: true },
	),
	row(
		"plugin",
		"gateway",
		"int",
		"DESK_GATEWAY_TIMEOUT_MS",
		"Timeout of one desk gateway request in milliseconds; a value outside the range is ignored.",
		{ min: 1, max: 120000 },
	),

	// Jev decisions: src/decisions/gate.ts and client.ts.
	row(
		"stack",
		"decisions",
		"string",
		"ULTRATHINK_OPENROUTER_KEY",
		"OpenRouter key for Jev decisions, used when no openrouter key is stored. The stored key wins.",
		{ secret: true },
	),
	row(
		"stack",
		"decisions",
		"string",
		"AI_GATEWAY_API_KEY",
		"Vercel AI Gateway key for Jev decisions, used when no stored key is found.",
		{ secret: true },
	),
	row(
		"stack",
		"decisions",
		"url",
		"ULTRATHINK_DECISIONS_URL",
		"Decisions endpoint. Only an https://openrouter.ai URL or a loopback URL is accepted; anything else is ignored.",
		{ default: "https://openrouter.ai/api/alpha/decisions" },
	),

	// Swarm: src/swarm/teams.ts. A non-empty ULTRATHINK_SWARM_ROOT wins over SWARM_ROOT.
	row(
		"stack",
		"swarm",
		"path",
		"ULTRATHINK_SWARM_ROOT",
		"Absolute path of an agent-swarm checkout, required for swarm lanes. SWARM_ROOT is read when this one is empty.",
		{ aliases: ["SWARM_ROOT"] },
	),
	row(
		"stack",
		"swarm",
		"int",
		"ULTRATHINK_SWARM_MAX_LANES",
		"Most swarm lanes alive at once across all commands, and the most briefs one command starts. A value that is not a number from 1 up means 3; larger values are cut to 6.",
		{ default: "3", min: 1, max: 6 },
	),
	row(
		"stack",
		"swarm",
		"string",
		"SWARM_AUTONOMOUS_RUN_CAP_S",
		"Run cap in seconds, passed through unchanged to each swarm lane.",
	),
	row(
		"stack",
		"swarm",
		"string",
		"SWARM_AUTONOMOUS_RUN_GRACE_S",
		"Seconds between SIGTERM and SIGKILL when a lane is stopped; a number of 0 or more, else 15.",
		{ default: "15" },
	),

	// Credentials and OAuth: src/mcp/store.ts, redirect.ts, cli.ts.
	row("plugin", "mcp", "path", "ULTRATHINK_MCP_STORE", "Path of the credential store.", {
		default: "$XDG_CONFIG_HOME/ultrathink/mcp-credentials.json",
	}),
	row(
		"plugin",
		"mcp",
		"url",
		"ULTRATHINK_OAUTH_REDIRECT",
		"OAuth callback URL for ultrathink-mcp auth login; the --redirect flag wins over it.",
	),
	row(
		"plugin",
		"mcp",
		"bool1",
		"ULTRATHINK_OAUTH_TAILSCALE",
		"Set to 1 to receive the OAuth callback through tailscale serve on a remote session.",
		{ reader: "raw" },
	),
	row(
		"plugin",
		"debug",
		"bool1",
		"ULTRATHINK_DEBUG",
		"Set to 1 to write ultrathink log lines and one line per Jev decision to stderr.",
		{ reader: "raw" },
	),
	row(
		"plugin",
		"debug",
		"bool1",
		"ULTRATHINK_MCP_DEBUG",
		"Set to 1 so ultrathink-mcp serve writes relay log lines to stderr.",
		{ reader: "raw" },
	),
	row(
		"plugin",
		"debug",
		"int",
		"ULTRATHINK_PROGRESS_FD",
		"File descriptor that receives one JSON progress line per event; 3 or higher, else ignored.",
		{ min: 3 },
	),

	// Host, state and config paths: src/host/detect.ts, src/host/paths.ts, src/doctor/pstack-check.ts, scripts/setup.ts.
	row(
		"plugin",
		"paths",
		"enum",
		"ULTRATHINK_HOST",
		"Forces the detected host; an unknown value is ignored.",
		// detectHost trims; hooks/engine.ts compares the raw value only to fill an absent host, then detection still trims.
		{ values: HOSTS, reader: "trims" },
	),
	row(
		"plugin",
		"paths",
		"path",
		"ULTRATHINK_STATE_DIR",
		"Directory for control state and session records instead of the host default. The hosted service reads it too and defaults to /var/lib/ultrathink; a path inside .planning is ignored.",
	),
	row(
		"plugin",
		"paths",
		"path",
		"ULTRATHINK_CONFIG_DIR",
		"Directory holding config.json for the Cursor pstack hook and the doctor pstack section only.",
	),
	row(
		"plugin",
		"paths",
		"path",
		"ULTRATHINK_PSTACK_CURSOR_DIR",
		"Absolute Cursor directory for the pstack hook; it wins over pstack.cursorDir.",
	),
	row(
		"plugin",
		"paths",
		"path",
		"ULTRATHINK_AGENT_SKILLS_DIR",
		"Shared Agent Skills directory that scripts/setup.ts installs into.",
		{ default: "~/.agents/skills" },
	),
	row(
		"plugin",
		"paths",
		"path",
		"XDG_CONFIG_HOME",
		"Base of the user config, the credential store and some host state directories.",
		{ default: "~/.config" },
	),
	row(
		"plugin",
		"paths",
		"path",
		"CLAUDE_CONFIG_DIR",
		"Claude user config directory, also the Claude Code state directory.",
		{ default: "~/.claude" },
	),
	row(
		"plugin",
		"paths",
		"path",
		"GROK_HOME",
		"Grok home directory, also the Grok Build state directory when GROK_PLUGIN_DATA is unset.",
		{ default: "~/.grok" },
	),
	row("plugin", "paths", "path", "GROK_PLUGIN_DATA", "Grok Build state directory."),
	row(
		"plugin",
		"paths",
		"path",
		"HERMES_HOME",
		"Hermes home directory, also the Hermes state directory.",
		{ default: "~/.hermes" },
	),
	row(
		"plugin",
		"paths",
		"path",
		"PI_CODING_AGENT_DIR",
		"Omp agent directory, also the Omp state directory.",
		{ default: "~/.omp/agent" },
	),
	row(
		"plugin",
		"paths",
		"path",
		"PRIME_AGENT_CODING_AGENT_DIR",
		"Prime Agent directory, also the Prime Agent state directory.",
		{ default: "~/.prime/agent" },
	),
	row(
		"plugin",
		"hosts",
		"int",
		"ULTRATHINK_HERMES_TIMEOUT",
		"Hermes only: longest time in seconds one plan may run. A positive integer; anything else means the default.",
		{ default: "540", min: 1 },
	),
	row(
		"plugin",
		"hosts",
		"int",
		"ULTRATHINK_CURSOR_BUDGET_MS",
		"Cursor only: longest wait for one plan in milliseconds. A positive integer; anything else means the default.",
		{ default: "180000", min: 1 },
	),
	row(
		"plugin",
		"hosts",
		"string",
		"ULTRATHINK_LOG_LEVEL",
		"Log level of the stdio tool host: info, warn or error, compared without case; anything else means warn.",
		{ default: "warn" },
	),

	// Hosted service (names and kinds only; the service keeps its own loader, services/ultrathink/config/config.ts).
	row(
		"service",
		"service-required",
		"url",
		"ULTRATHINK_PUBLIC_ORIGIN",
		"Public origin of the hosted service: https, or http for localhost and 127.0.0.1; scheme, host and port only. Required.",
	),
	row(
		"service",
		"service-required",
		"string",
		"ULTRATHINK_OWNER_PASSWORD_HASH",
		"Argon2 or bcrypt hash of the owner password, as Bun.password.hash makes it. Required.",
		{ secret: true },
	),
	row(
		"service",
		"service-required",
		"string",
		"ULTRATHINK_SESSION_SECRET",
		"Session signing secret of at least 32 characters. Required.",
		{ secret: true },
	),
	row(
		"service",
		"service-required",
		"string",
		"ULTRATHINK_SESSION_SECRET_PREVIOUS",
		"Comma list of up to 4 earlier session secrets still accepted, so a rotation signs nobody out.",
		{ secret: true },
	),
	row(
		"service",
		"service-required",
		"string",
		"ULTRATHINK_CONNECTOR_KEY",
		"Connector key of at least 32 characters, for the MCP connector route.",
		{ secret: true },
	),
	row("service", "service-tuning", "int", "ULTRATHINK_PORT", "Listen port of the hosted service.", {
		default: "8795",
		min: 1024,
		max: 65535,
	}),
	row(
		"service",
		"service-tuning",
		"string",
		"ULTRATHINK_ALLOWED_ORIGINS",
		"Comma list of bare origins (https or http) allowed to call the service from a browser.",
	),
	row(
		"service",
		"service-tuning",
		"string",
		"ULTRATHINK_OAUTH_REDIRECT_ORIGINS",
		"Comma list of bare https origins accepted as OAuth redirect targets.",
	),
	row(
		"service",
		"service-tuning",
		"string",
		"ULTRATHINK_PLANNING_MODEL",
		"Claude model id of the hosted planner: 1 to 80 characters from letters, digits, dot, underscore, colon and dash.",
		{ default: "claude-haiku-5-5" },
	),
	row(
		"service",
		"service-tuning",
		"enum",
		"ULTRATHINK_PLANNING_FALLBACK",
		"Whether a failed Claude call fails over to Grok.",
		{ default: "none", values: ["none", "grok"], reader: "trims" },
	),
	row(
		"service",
		"service-tuning",
		"bool01",
		"ULTRATHINK_SERVER_PLANNING",
		"Set to 1 to let the service plan on the server.",
		{ default: "0", reader: "trims" },
	),
	row(
		"service",
		"service-tuning",
		"bool01",
		"ULTRATHINK_PLAINTEXT_LOOPBACK",
		"Set to 1 to run without TLS; for development and local smoke tests only.",
		{ default: "0", reader: "trims" },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_MAX_INPUT_CHARS",
		"Longest accepted prompt in characters; 0 means no limit, otherwise at least 1.",
		{ default: "4000000", min: 0 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_MAX_ANSWER_CHARS",
		"Longest accepted answer in characters.",
		{ default: "20000", min: 1, max: 200000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_RUN_TOKEN_CEILING",
		"Token ceiling of one run; 0 means unlimited, otherwise at least 1.",
		{ default: "0", min: 0 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_DAILY_TOKEN_CEILING",
		"Token ceiling per day; 0 means unlimited, otherwise at least 1.",
		{ default: "0", min: 0 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_PLAN_CONCURRENCY",
		"Most claude children in flight at once.",
		{ default: "2", min: 1, max: 6 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_MAX_CONCURRENT_PLANS",
		"Most plans running at once.",
		{ default: "2", min: 1, max: 8 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_MODEL_TIMEOUT_MS",
		"Timeout of one model call in milliseconds; 0 means unlimited, otherwise 5000 or more.",
		{ default: "0", min: 0, max: 600000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_PLAN_TIMEOUT_MS",
		"Timeout of one plan in milliseconds; 0 means unlimited, otherwise 30000 or more.",
		{ default: "0", min: 0, max: 1800000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS",
		"Output token cap of one model call; 0 means no configured cap, otherwise 256 or more.",
		{ default: "0", min: 0, max: 32000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_BREAKER_FAILURES",
		"Upstream failures within the window that open the breaker; 0 disables it.",
		{ default: "5", min: 0, max: 100 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_BREAKER_WINDOW_MS",
		"Window in which upstream failures are counted, in milliseconds.",
		{ default: "60000", min: 1000, max: 3600000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_BREAKER_OPEN_MS",
		"How long the breaker stays open before a trial request, in milliseconds.",
		{ default: "30000", min: 1000, max: 600000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_MAX_INFLIGHT",
		"Most concurrent HTTP requests the router admits.",
		{ default: "256", min: 1, max: 10000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_PRIORITY_RESERVE_PCT",
		"Percent of in-flight capacity kept free for the owner.",
		{ default: "25", min: 0, max: 90 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_FAIR_QUEUE_DEPTH",
		"Over-budget requests that may wait per priority class; 0 refuses at once.",
		{ default: "16", min: 0, max: 1000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_FAIR_QUEUE_WAIT_MS",
		"Longest wait in the fair-share queue, in milliseconds.",
		{ default: "1500", min: 1, max: 60000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT",
		"Lowest percentage the adaptive quota may shrink the request windows to.",
		{ default: "50", min: 10, max: 100 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_LAG_TARGET_MS",
		"Event-loop lag above which the adaptive quota shrinks, in milliseconds.",
		{ default: "100", min: 10, max: 5000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_REPLICA_CAPACITY_RPS",
		"Requests per second one replica is assumed to serve.",
		{ default: "20", min: 1, max: 100000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_ABUSE_FAILURES_PER_MINUTE",
		"Failures per minute from one IP that start an abuse penalty.",
		{ default: "20", min: 1, max: 10000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_PENALTY_BASE_SEC",
		"Length of an IP's first abuse penalty block, in seconds.",
		{ default: "60", min: 1, max: 86400 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_PENALTY_MAX_SEC",
		"Longest abuse penalty block in seconds; never below the base block.",
		{ default: "3600", min: 1, max: 86400 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_DRAIN_MS",
		"Wait after shutdown begins so in-flight work can finish, in milliseconds.",
		{ default: "5000", min: 0, max: 60000 },
	),
	row(
		"service",
		"service-tuning",
		"int",
		"ULTRATHINK_RETENTION_DAYS",
		"Days of finished jobs, sessions and journals to keep; 0 disables the sweep.",
		{ default: "30", min: 0, max: 3650 },
	),
	row(
		"service",
		"service-audit",
		"bool01",
		"ULTRATHINK_AUDIT_LOG",
		"Set to 0 to stop writing the append-only audit log.",
		{ default: "1", reader: "trims" },
	),
	row(
		"service",
		"service-audit",
		"int",
		"ULTRATHINK_AUDIT_ANCHOR_EVERY",
		"Audit records between anchor records of the hash chain.",
		{ default: "1000", min: 1, max: 1000000 },
	),
	row(
		"service",
		"service-audit",
		"int",
		"ULTRATHINK_AUDIT_SEGMENT_BYTES",
		"Size at which the audit log rolls to a new segment, in bytes.",
		{ default: "67108864", min: 1048576, max: 4294967296 },
	),
	row(
		"service",
		"service-audit",
		"int",
		"ULTRATHINK_AUDIT_RETENTION_DAYS",
		"Days of audit segments to keep; 0 keeps them all.",
		{ default: "365", min: 0, max: 36500 },
	),
	row(
		"service",
		"service-audit",
		"int",
		"ULTRATHINK_AUDIT_WATCH_MS",
		"Interval of the audit integrity watch, in milliseconds.",
		{ default: "1000", min: 100, max: 1000 },
	),
	row(
		"service",
		"service-audit",
		"int",
		"ULTRATHINK_AUDIT_SINK_QUEUE",
		"Envelopes each audit sink may hold waiting before the oldest is dropped.",
		{ default: "10000", min: 1, max: 1000000 },
	),
	row(
		"service",
		"service-audit",
		"string",
		"ULTRATHINK_AUDIT_RULES",
		"JSON array of anomaly rules; unset means the built-in rules.",
	),
	row(
		"service",
		"service-audit",
		"url",
		"ULTRATHINK_AUDIT_HTTP_URL",
		"HTTP audit sink endpoint: https, or http to 127.0.0.1 or localhost.",
	),
	row(
		"service",
		"service-audit",
		"string",
		"ULTRATHINK_AUDIT_HTTP_TOKEN",
		"Token for the HTTP audit sink: at least 16 printable ASCII characters.",
		{ secret: true },
	),
	row(
		"service",
		"service-audit",
		"string",
		"ULTRATHINK_AUDIT_SYSLOG",
		"Syslog audit sink as host:port, with a port from 1 to 65535.",
	),
	row(
		"service",
		"service-audit",
		"url",
		"ULTRATHINK_AUDIT_KAFKA_REST_URL",
		"Kafka REST proxy endpoint of the audit sink; set together with the topic.",
	),
	row(
		"service",
		"service-audit",
		"string",
		"ULTRATHINK_AUDIT_KAFKA_TOPIC",
		"Kafka topic of the audit sink; set together with the REST URL.",
	),
	row(
		"service",
		"service-tuning",
		"url",
		"ULTRATHINK_OTLP_ENDPOINT",
		"OTLP/JSON trace collector base URL: https, or http to loopback. Unset disables span export.",
	),
	row(
		"service",
		"service-tls",
		"path",
		"ULTRATHINK_TLS_CERT",
		"Absolute path of the server certificate; set with the key and the client CA, or none.",
	),
	row(
		"service",
		"service-tls",
		"path",
		"ULTRATHINK_TLS_KEY",
		"Absolute path of the server certificate key; set with the certificate and the client CA, or none.",
	),
	row(
		"service",
		"service-tls",
		"path",
		"ULTRATHINK_TLS_CLIENT_CA",
		"Absolute path of the CA that signs client certificates; set with the certificate and the key, or none.",
	),
	row(
		"service",
		"service-tls",
		"string",
		"ULTRATHINK_SPIFFE_TRUST_DOMAIN",
		"SPIFFE trust domain that peer certificate identities must belong to.",
		{ default: "ultrathink.internal" },
	),
	row(
		"service",
		"service-chaos",
		"bool01",
		"ULTRATHINK_CHAOS",
		"Set to 1 to arm fault injection at the upstream seam; needs the staging environment and a plan.",
		{ default: "0", reader: "trims" },
	),
	row(
		"service",
		"service-chaos",
		"string",
		"ULTRATHINK_CHAOS_ENV",
		"Must be staging whenever chaos is enabled.",
	),
	row(
		"service",
		"service-chaos",
		"path",
		"ULTRATHINK_CHAOS_PLAN",
		"Absolute path of the fault plan; required whenever chaos is enabled.",
	),
];

type EnvProblem = "bad-kind" | "out-of-range" | "alias-conflict" | "kill-switch";

export interface EnvFinding {
	/** The registered (canonical) variable the finding is about; for a bad alias value, the alias. */
	name: string;
	problem: EnvProblem;
	/** Names variables and expectations; never a value. */
	message: string;
}

type Env = Record<string, string | undefined>;

/** The variables whose reader applies `checkServiceUrl` (hindsight/settings.ts, ragflow/settings.ts, gateway/settings.ts). */
const SERVICE_URL_VARIABLES: readonly string[] = [
	"HINDSIGHT_API_URL",
	"RAGFLOW_URL",
	"DESK_GATEWAY_URL",
];

const INTEGER = /^-?\d+$/;

function nonEmpty(env: Env, name: string): string | undefined {
	const value = env[name]?.trim();
	return value === undefined || value === "" ? undefined : value;
}

/** True for an http(s) URL that parses. No other rule: the readers of these variables apply none. */
function isHttpUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function urlProblem(def: EnvVarDef, name: string, value: string): string | undefined {
	if (def.name === "ULTRATHINK_DECISIONS_URL") {
		return resolveDecisionsUrl({ ULTRATHINK_DECISIONS_URL: value }).ignored
			? `${name} must be an https://openrouter.ai URL or a loopback URL without credentials; it is ignored as set`
			: undefined;
	}
	if (SERVICE_URL_VARIABLES.includes(def.name)) {
		const checked = checkServiceUrl(value);
		// The reason is one of the checker's fixed strings; it never repeats the URL.
		return checked.ok ? undefined : `${name} is not accepted as a service URL: ${checked.reason}`;
	}
	return isHttpUrl(value) ? undefined : `${name} must be an absolute http(s) URL`;
}

function rangeMessage(name: string, min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined) return `${name} must be between ${min} and ${max}`;
	if (min !== undefined) return `${name} must be at least ${min}`;
	if (max !== undefined) return `${name} must be at most ${max}`;
	return `${name} must be a safe integer`;
}

/** Checks one value of one name against the definition; `undefined` when it is fine. */
function checkValue(def: EnvVarDef, name: string, value: string): EnvFinding | undefined {
	const bad = (problem: EnvProblem, message: string): EnvFinding => ({ name, problem, message });
	switch (def.kind) {
		case "url": {
			const message = urlProblem(def, name, value);
			return message === undefined ? undefined : bad("bad-kind", message);
		}
		case "int": {
			if (!INTEGER.test(value)) return bad("bad-kind", `${name} must be an integer`);
			const parsed = Number(value);
			const below = def.min !== undefined && parsed < def.min;
			const above = def.max !== undefined && parsed > def.max;
			if (below || above || !Number.isSafeInteger(parsed))
				return bad("out-of-range", rangeMessage(name, def.min, def.max));
			return undefined;
		}
		case "bool01":
			return value === "0" || value === "1" ? undefined : bad("bad-kind", `${name} must be 0 or 1`);
		case "bool1":
			return value === "1"
				? undefined
				: bad("bad-kind", `${name} must be 1; any other value does nothing`);
		case "enum":
			return def.values?.includes(value)
				? undefined
				: bad("bad-kind", `${name} must be one of ${(def.values ?? []).join(", ")}`);
		case "path":
			return isAbsolute(value) ? undefined : bad("bad-kind", `${name} must be an absolute path`);
		case "string":
			return undefined;
	}
}

/**
 * A value that is accepted only after trimming but whose reader compares the raw string, so the surrounding whitespace
 * makes the setting ineffective. `undefined` for a trimming reader, an unpadded value, or a value already reported as bad.
 * Names the variable only, never the value.
 */
function paddedFinding(
	def: EnvVarDef,
	raw: string | undefined,
	trimmed: string,
): EnvFinding | undefined {
	if (def.reader !== "raw" || raw === undefined || raw === trimmed) return undefined;
	const accepted =
		def.disableValue !== undefined
			? trimmed.toLowerCase() === def.disableValue.toLowerCase()
			: checkValue(def, def.name, trimmed) === undefined;
	if (!accepted) return undefined;
	return {
		name: def.name,
		problem: def.disableValue !== undefined ? "kill-switch" : "bad-kind",
		message: `${def.name} has whitespace around its value, and its reader compares the exact string, so the setting has no effect`,
	};
}

/**
 * One finding per problem in `env`, in registry order. Reporting only: nothing here changes how a variable is read.
 * Never reports `OPENROUTER_API_KEY` (env-check owns that finding) and never echoes a value.
 */
export function validateEnv(env: Env): EnvFinding[] {
	const findings: EnvFinding[] = [];
	for (const def of ENV_REGISTRY) {
		const value = nonEmpty(env, def.name);
		if (def.disableValue !== undefined) {
			// Only the disabling value has an effect (compared trimmed and without case, as the readers do for 0 and off).
			if (value !== undefined) {
				if (value.toLowerCase() !== def.disableValue.toLowerCase()) {
					findings.push({
						name: def.name,
						problem: "kill-switch",
						message: `${def.name} is set but only the value ${def.disableValue} has an effect, so it disables nothing`,
					});
				} else {
					const padded = paddedFinding(def, env[def.name], value);
					if (padded) findings.push(padded);
				}
			}
			continue;
		}
		if (value !== undefined) {
			const finding = checkValue(def, def.name, value) ?? paddedFinding(def, env[def.name], value);
			if (finding) findings.push(finding);
		}
		for (const alias of def.aliases ?? []) {
			const aliasValue = nonEmpty(env, alias);
			if (aliasValue === undefined) continue;
			const finding = checkValue(def, alias, aliasValue);
			if (finding) findings.push(finding);
			if (value !== undefined && aliasValue !== value) {
				findings.push({
					name: def.name,
					problem: "alias-conflict",
					message: `${def.name} and ${alias} are both set to different values; ${def.name} wins`,
				});
			}
		}
	}
	return findings;
}
