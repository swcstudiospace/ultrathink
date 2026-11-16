// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * One CLI agent the data-driven runtime installer can install into. The registry (`runtimes.ts`) holds one
 * descriptor per agent; `plan.ts`, `convert.ts` and `engine.ts` read nothing else about an agent.
 */
export interface RuntimeDescriptor {
	/** Kebab-case registry id, e.g. "codex". */
	readonly id: string;
	readonly label: string;
	/** GSD-Core installer flag for the same agent, e.g. "--codex". */
	readonly gsdFlag: string;
	/** First set env var wins, else first default; "~" = home. */
	readonly configRoot: {
		readonly env: readonly string[];
		readonly defaults: readonly string[];
	};
	readonly layout: "skills" | "commands" | "skills+commands" | "workflows";
	/** Relative to the config root. */
	readonly skillsDir?: string;
	/** Relative to the config root. */
	readonly commandsDir?: string;
	readonly commandSuffix: ".md" | ".toml";
	readonly hooks: "none" | "json" | "toml";
	readonly scope: "global" | "workspace" | "both";
	readonly gating: "yes" | "partial" | "no" | "unverified";
	readonly modelRouting: "per-call" | "per-session" | "none" | "unverified";
	/** Citations (file or URL) from the findings doc. */
	readonly sources: readonly string[];
}
