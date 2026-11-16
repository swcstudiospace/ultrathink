// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { RuntimeDescriptor } from "./types.ts";

/*
 * Data-only table of the 15 CLI agents that GSD-Core supports and Ultrathink
 * has no dedicated adapter for. Every value comes from docs/gsd-core-findings.md
 * (F) or docs/agent-matrix.md (M); cells those docs mark UNVERIFIED, conflicting
 * or unstated are `unverified` or the most conservative value.
 *
 * - `gating` is `unverified` everywhere: agent-matrix.md says no gating claim
 *   is proven on any agent (M "Not verified", "How to read the columns").
 * - `modelRouting`: `per-call` = host `modelMode` active (a plugin can supply a
 *   model); `per-session` = passive with an argv/config model choice; `none` =
 *   passive and UI only; `unverified` = axis not read in the docs.
 * - `hooks` is the registration-file kind of the host's hook surface; `none`
 *   also covers conflicting docs, script-file hooks and extension bridges.
 */
const F3 = "docs/gsd-core-findings.md §3 (per-runtime mechanism)";
const F2 = "docs/gsd-core-findings.md §2 (supported runtimes, config dir env vars)";
const F8 = "docs/gsd-core-findings.md §8 (model routing)";
const F9 = "docs/gsd-core-findings.md §9 (capability matrix)";
const MATRIX = "docs/agent-matrix.md (matrix table, row";

export const RUNTIMES: readonly RuntimeDescriptor[] = [
	{
		id: "kimi",
		label: "Kimi CLI (legacy kimi-cli)",
		gsdFlag: "--kimi",
		// Skills root is the first existing of ~/.config/agents, ~/.agents; no env var is tied to it in the docs.
		configRoot: { env: [], defaults: ["~/.config/agents", "~/.agents"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "toml",
		// Local install is deferred and guarded (F3).
		scope: "global",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F3, F9, `${MATRIX} 2)`],
	},
	{
		id: "kimi-code",
		label: "Kimi Code",
		gsdFlag: "--kimi-code",
		// KIMI_CONFIG_DIR is the skills-root override; ~/.kimi-code (KIMI_CODE_HOME) is the documented hooks root.
		configRoot: { env: ["KIMI_CONFIG_DIR", "KIMI_CODE_HOME"], defaults: ["~/.kimi-code"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "toml",
		scope: "global",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F3, F9, `${MATRIX} 3)`],
	},
	{
		id: "kilo",
		label: "Kilo",
		gsdFlag: "--kilo",
		configRoot: { env: ["KILO_CONFIG_DIR"], defaults: ["~/.config/kilo", "~/.kilo", "./.kilo"] },
		layout: "skills+commands",
		skillsDir: "skills",
		// Singular `command/` directory (M row 4).
		commandsDir: "command",
		commandSuffix: ".md",
		hooks: "none",
		scope: "both",
		gating: "unverified",
		// Host modelMode not read in MATRIX (F9).
		modelRouting: "unverified",
		sources: [F2, F3, F9, `${MATRIX} 4)`],
	},
	{
		id: "opencode",
		label: "OpenCode",
		gsdFlag: "--opencode",
		configRoot: {
			env: ["OPENCODE_CONFIG_DIR"],
			defaults: ["~/.config/opencode", "~/.opencode", "./.opencode"],
		},
		layout: "skills+commands",
		skillsDir: "skills",
		// Plural `commands/` directory (M row 5).
		commandsDir: "commands",
		commandSuffix: ".md",
		// hooksSurface is `none` natively; a JS plugin bridges events (F3).
		hooks: "none",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-call",
		sources: [F2, F3, F8, F9, `${MATRIX} 5)`],
	},
	{
		id: "pi",
		label: "pi",
		gsdFlag: "--pi",
		configRoot: { env: ["PI_CODING_AGENT_DIR"], defaults: ["~/.pi/agent", "./.pi"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		// No settings hook bus; a single extension bridges events (F3).
		hooks: "none",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-call",
		sources: [F3, F9, `${MATRIX} 6)`],
	},
	{
		id: "codex",
		label: "Codex CLI",
		gsdFlag: "--codex",
		// Codex takes --config-dir; no env var is documented (F2).
		configRoot: { env: [], defaults: ["~/.codex", "./.codex"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "toml",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F2, F3, F9, `${MATRIX} 7)`],
	},
	{
		id: "copilot",
		label: "GitHub Copilot CLI",
		gsdFlag: "--copilot",
		configRoot: {
			env: ["COPILOT_CONFIG_DIR", "COPILOT_HOME"],
			defaults: ["~/.copilot", "./.github"],
		},
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "json",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F2, F3, F9, `${MATRIX} 8)`],
	},
	{
		id: "antigravity",
		label: "Antigravity CLI",
		gsdFlag: "--antigravity",
		// Skills live only under ~/.gemini/config/skills; skills under an
		// auto-detected ~/.gemini/antigravity* dir are not scanned (M row 9),
		// so ANTIGRAVITY_CONFIG_DIR is deliberately not mapped here.
		configRoot: { env: [], defaults: ["~/.gemini/config", "./.agent"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "json",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F2, F3, F9, `${MATRIX} 9)`],
	},
	{
		id: "windsurf",
		label: "Windsurf / Devin Desktop",
		gsdFlag: "--windsurf",
		// Workspace install only: the global workflow install is a deliberate no-op (F3).
		configRoot: { env: [], defaults: ["./.windsurf"] },
		layout: "workflows",
		commandsDir: "workflows",
		commandSuffix: ".md",
		hooks: "none",
		scope: "workspace",
		gating: "unverified",
		// passive, UI only (M row 11).
		modelRouting: "none",
		sources: [F3, F9, `${MATRIX} 11)`],
	},
	{
		id: "augment",
		label: "Augment Code (Auggie)",
		gsdFlag: "--augment",
		configRoot: { env: ["AUGMENT_CONFIG_DIR"], defaults: ["~/.augment", "./.augment"] },
		layout: "skills+commands",
		skillsDir: "skills",
		commandsDir: "commands",
		commandSuffix: ".md",
		// Install doc says settings.json hooks, ARCHITECTURE says none: conflict, UNVERIFIED (F3).
		hooks: "none",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F2, F3, F9, `${MATRIX} 12)`],
	},
	{
		id: "trae",
		label: "Trae",
		gsdFlag: "--trae",
		configRoot: { env: ["TRAE_CONFIG_DIR"], defaults: ["~/.trae", "./.trae"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		// Rule references only; GSD installs no hooks (F3).
		hooks: "none",
		scope: "both",
		gating: "unverified",
		// passive, UI only (M row 13).
		modelRouting: "none",
		sources: [F2, F3, F9, `${MATRIX} 13)`],
	},
	{
		id: "qwen",
		label: "Qwen Code",
		gsdFlag: "--qwen",
		configRoot: { env: ["QWEN_CONFIG_DIR"], defaults: ["~/.qwen", "./.qwen"] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "json",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F2, F3, F8, F9, `${MATRIX} 14)`],
	},
	{
		id: "codebuddy",
		label: "CodeBuddy",
		gsdFlag: "--codebuddy",
		configRoot: { env: ["CODEBUDDY_CONFIG_DIR"], defaults: ["~/.codebuddy", "./.codebuddy"] },
		layout: "skills+commands",
		skillsDir: "skills",
		commandsDir: "commands",
		commandSuffix: ".md",
		hooks: "json",
		scope: "both",
		gating: "unverified",
		modelRouting: "per-session",
		sources: [F2, F3, F9, `${MATRIX} 16)`],
	},
	{
		id: "cline",
		label: "Cline",
		gsdFlag: "--cline",
		configRoot: { env: ["CLINE_CONFIG_DIR"], defaults: ["~/.cline"] },
		// Skills are global-only and there are no slash commands (F3); the local form is rules-only, so scope is global.
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		// Hooks are `.clinerules/hooks/PreToolUse` script files, not a json/toml registration.
		hooks: "none",
		scope: "global",
		gating: "unverified",
		modelRouting: "per-call",
		sources: [F2, F3, F9, `${MATRIX} 17)`],
	},
	{
		id: "zcode",
		label: "ZCode",
		gsdFlag: "--zcode",
		// No env var documented; local scope not stated (F3).
		configRoot: { env: [], defaults: ["~/.zcode"] },
		layout: "skills+commands",
		skillsDir: "skills",
		commandsDir: "commands",
		commandSuffix: ".md",
		// Hook format is not published by ZCode (F3).
		hooks: "none",
		scope: "global",
		gating: "unverified",
		// Host modelMode axes not read (M row 18).
		modelRouting: "unverified",
		sources: [F3, F9, `${MATRIX} 18)`],
	},
];

export function findRuntime(id: string): RuntimeDescriptor | undefined {
	return RUNTIMES.find((runtime) => runtime.id === id);
}
