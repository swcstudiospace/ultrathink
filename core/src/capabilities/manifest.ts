// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export const CAPABILITY_FLAGS = [
	"supports_skills",
	"supports_slash_commands",
	"supports_subagents",
	"supports_hooks",
	"supports_persistent_state",
	"supports_interactive_prompts",
] as const;

export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];

/** A flag value reported by an adapter or probe. `source` names the reporter, e.g. "claude-code". */
interface CapabilityReport {
	readonly value: boolean;
	readonly source: string;
}

/** Reports keyed by flag. An absent key means the flag is unset, which resolves to false. */
export type CapabilityReports = Readonly<Partial<Record<CapabilityFlag, CapabilityReport>>>;

interface ResolvedCapability {
	readonly enabled: boolean;
	/** Reporter of the value, or "unset" when no report exists. */
	readonly source: string;
	/** Degraded-mode behavior when disabled; null when enabled. */
	readonly fallback: string | null;
}

export type ResolvedCapabilities = Readonly<Record<CapabilityFlag, ResolvedCapability>>;

/** Per-command capability needs. `required` flags block the command when disabled; `optional` flags degrade it. */
export interface CommandRequirements {
	readonly required: readonly CapabilityFlag[];
	readonly optional: readonly CapabilityFlag[];
}

/** Capability requirements keyed by command name. */
export type CapabilityManifest = Readonly<Record<string, CommandRequirements>>;

/** Degraded-mode behavior for each flag when it is disabled. Data only; consumed by `resolveCapabilities`. */
export const CAPABILITY_FALLBACKS: Readonly<Record<CapabilityFlag, string>> = {
	supports_skills: "expose as CLI or prompt-file entry",
	supports_slash_commands: "invoke by explicit name via CLI",
	supports_subagents: "run discuss/plan/execute inline in order",
	supports_hooks: "poll status file or explicit event call at step boundaries",
	supports_persistent_state: "state only in .planning/STATE.md and plugin state dir",
	supports_interactive_prompts:
		"write decision record to CONTEXT.md, set awaiting_user_decision, exit, resume on next invoke",
};

/** Resolves every flag. Unset or non-true flags are disabled and select their fallback. */
export function resolveCapabilities(reports: CapabilityReports): ResolvedCapabilities {
	const resolved: Partial<Record<CapabilityFlag, ResolvedCapability>> = {};
	for (const flag of CAPABILITY_FLAGS) {
		const report = reports[flag];
		const enabled = report?.value === true;
		resolved[flag] = {
			enabled,
			source: report?.source ?? "unset",
			fallback: enabled ? null : CAPABILITY_FALLBACKS[flag],
		};
	}
	return resolved as ResolvedCapabilities;
}

export interface CommandPlan {
	/** "blocked": a required flag is disabled. "degraded": only optional flags are disabled. "ready": none are. */
	readonly status: "ready" | "degraded" | "blocked";
	readonly missingRequired: readonly CapabilityFlag[];
	/** Fallback behavior selected for each disabled optional flag. */
	readonly fallbacks: Readonly<Partial<Record<CapabilityFlag, string>>>;
}

/** Plans one command against resolved capabilities. */
export function planCommand(
	requirements: CommandRequirements,
	resolved: ResolvedCapabilities,
): CommandPlan {
	const missingRequired = requirements.required.filter((flag) => !resolved[flag].enabled);
	const fallbacks: Partial<Record<CapabilityFlag, string>> = {};
	for (const flag of requirements.optional) {
		const capability = resolved[flag];
		if (!capability.enabled && capability.fallback !== null) {
			fallbacks[flag] = capability.fallback;
		}
	}
	if (missingRequired.length > 0) {
		return { status: "blocked", missingRequired, fallbacks };
	}
	if (Object.keys(fallbacks).length > 0) {
		return { status: "degraded", missingRequired, fallbacks };
	}
	return { status: "ready", missingRequired, fallbacks };
}
