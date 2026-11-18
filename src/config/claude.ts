// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { CLAUDE_AUTH_MODES, type ClaudeAuthMode } from "../claude/complete.ts";
import type { ClaudeConfig } from "../config.ts";
import { nonEmpty, projectTimerMs, selectorField } from "./fields.ts";

/** `project` (a repository-controlled layer) cannot choose the executable or its setting sources; model/effort/timers stay open. */
export function mergeClaude(
	claude: Record<string, unknown> | undefined,
	defaults: ClaudeConfig,
	project: boolean,
): ClaudeConfig {
	if (!claude) return defaults;
	const positive = (value: unknown, fallback: number): number =>
		typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
	return {
		bin: project ? defaults.bin : nonEmpty(claude.bin, defaults.bin),
		auth:
			!project && CLAUDE_AUTH_MODES.includes(claude.auth as ClaudeAuthMode)
				? (claude.auth as ClaudeAuthMode)
				: defaults.auth,
		fallbackToGrok:
			!project && typeof claude.fallbackToGrok === "boolean"
				? claude.fallbackToGrok
				: defaults.fallbackToGrok,
		model: selectorField(claude.model) ?? defaults.model,
		thinking: typeof claude.thinking === "boolean" ? claude.thinking : defaults.thinking,
		settingSources:
			!project && typeof claude.settingSources === "string"
				? claude.settingSources.trim()
				: defaults.settingSources,
		callTimeoutMs: projectTimerMs(claude.callTimeoutMs, defaults.callTimeoutMs, project),
		budgetMs: projectTimerMs(claude.budgetMs, defaults.budgetMs, project),
		concurrency: Math.max(1, Math.floor(positive(claude.concurrency, defaults.concurrency))),
		echo: typeof claude.echo === "boolean" ? claude.echo : defaults.echo,
	};
}
