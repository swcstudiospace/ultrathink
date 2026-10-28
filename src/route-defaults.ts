// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one version-controlled source of built-in planning models for the legacy CLI routes (AD-1). Keyed by route, not by
 * credential provider: each entry is the wire model a route sends when no config layer pins one, and each entry can be
 * changed on its own without touching resolution logic. The native Omp path never reads this map; its defaults come from
 * the host (exact-provider configured selector, then the installed host catalog). Leaf module: no imports, so config and
 * the Grok and Muse types can reference it without cycles.
 */

/** A legacy planning route: the CLI or proxy transport family a named or host-routed engine runs on. */
export type LegacyRoute = "claude" | "grok" | "muse";

export const ROUTE_DEFAULT_MODELS: Readonly<Record<LegacyRoute, string>> = Object.freeze({
	claude: "claude-haiku-5-5",
	grok: "grok-build-0.1",
	muse: "muse-spark-1.3-contributor",
});

/** Variables holding the Jev OpenRouter key; no model-CLI child Ultrathink spawns may inherit them (SDKs auto-read the generic name). */
const JEV_KEY_ENV_NAMES: readonly string[] = Object.freeze([
	"ULTRATHINK_OPENROUTER_KEY",
	"OPENROUTER_API_KEY",
]);

/** Deletes the Jev key variables from a child env the caller already owns (a copy, never `process.env`); the one place every model-CLI launch drops them. */
export function dropJevKeys(env: Record<string, string | undefined>): void {
	for (const name of JEV_KEY_ENV_NAMES) delete env[name];
}
