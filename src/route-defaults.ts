// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one version-controlled source of built-in planning models for the legacy CLI routes (AD-1). Keyed by route, not by
 * credential provider: each entry is the wire model a route sends when no config layer pins one, and each entry can be
 * changed on its own without touching resolution logic. The native Omp path never reads this map; its defaults come from
 * the host (exact-provider configured selector, then the installed host catalog). Leaf module: its one import is
 * type-only and erased at runtime, so config and the Grok and Muse types can reference it without cycles.
 */
import type { HostId } from "./host/types.ts";

/** A legacy planning route: the CLI or proxy transport family a named or host-routed engine runs on. */
export type LegacyRoute = "claude" | "grok" | "muse";

export const ROUTE_DEFAULT_MODELS: Readonly<Record<LegacyRoute, string>> = Object.freeze({
	claude: "claude-haiku-5-5",
	grok: "grok-build-0.1",
	muse: "muse-spark-1.3-contributor",
});

/**
 * Cheapest-model candidates for the Tree-of-Thought PRD stage (tier "prd"), keyed by credential-provider family and ordered
 * cheapest first. Data only: `models.tot.candidates` in any config layer replaces a provider's list, a blank list removes it.
 * UNVERIFIED PLACEHOLDERS: the anthropic and xai ids are the ids this repo already sends on its legacy routes; the openai
 * and cursor ids are guesses that were not checked against any provider catalog. A wrong id does no harm: the one-time
 * smoke check drops it and the stage runs on the selected model.
 */
export const TOT_PRD_CANDIDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
	anthropic: Object.freeze([ROUTE_DEFAULT_MODELS.claude]),
	openai: Object.freeze(["gpt-5-mini", "gpt-5-nano"]),
	xai: Object.freeze([ROUTE_DEFAULT_MODELS.grok]),
	cursor: Object.freeze(["cursor-small"]),
});

/** Consecutive cheap-model failures after which the whole ToT stage runs on the selected model. */
export const TOT_BREAKER_THRESHOLD = 3;

/**
 * Whether a host lets a stage call pick its own model (the wire model rides each call). Cursor, Omp and Prime Agent bind
 * one session model, so ToT keeps the selected model there unless the caller injects a capability that says otherwise.
 * Keyed by `HostId`, so a host added to or renamed in `HOSTS` fails to compile until this map follows it.
 */
export const TOT_HOST_PER_CALL_MODEL: Readonly<Record<HostId, boolean>> = Object.freeze({
	"claude-code": true,
	"grok-build": true,
	hermes: true,
	muse: true,
	omp: false,
	"prime-agent": false,
	cursor: false,
});

/** Credential variables no child Ultrathink spawns may inherit. OPENROUTER_API_KEY and AI_GATEWAY_API_KEY are auto-read by SDKs and agents, so they are stripped whether or not Ultrathink reads them. */
const JEV_KEY_ENV_NAMES: readonly string[] = Object.freeze([
	"ULTRATHINK_OPENROUTER_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
]);

/** Deletes the Jev key variables from a child env the caller already owns (a copy, never `process.env`); the one place every model-CLI launch drops them. */
export function dropJevKeys(env: Record<string, string | undefined>): void {
	for (const name of JEV_KEY_ENV_NAMES) delete env[name];
}
