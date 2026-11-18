// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { StateConfig, SwarmConfig, UiConfig } from "../config.ts";
import { booleanOr, intInRange } from "./fields.ts";

/**
 * A project layer (a file a cloned repository controls) is ignored entirely: a hostile `retentionDays: 1` would delete
 * the user's history. Only user files can opt in to the scheduled prune.
 */
export function mergeState(
	state: Record<string, unknown> | undefined,
	defaults: StateConfig,
	project: boolean,
): StateConfig {
	if (!state || project) return defaults;
	return { retentionDays: intInRange(state.retentionDays, 0, 3650, defaults.retentionDays) };
}

/**
 * Swarm auto-run is opt-in and user-only: a project layer (a file a cloned repository controls) is ignored
 * entirely, and a non-boolean `autoRun` keeps the lower layer's value.
 */
export function mergeSwarm(
	swarm: Record<string, unknown> | undefined,
	defaults: SwarmConfig,
	project: boolean,
): SwarmConfig {
	if (!swarm || project) return defaults;
	return { autoRun: booleanOr(swarm.autoRun, defaults.autoRun) };
}

/**
 * Motion settings are user-only: a project layer (a file a cloned repository controls) is ignored entirely. A
 * non-boolean `reducedMotion` keeps the lower layer's value.
 */
export function mergeUi(
	ui: Record<string, unknown> | undefined,
	defaults: UiConfig,
	project: boolean,
): UiConfig {
	if (!ui || project) return defaults;
	return { reducedMotion: booleanOr(ui.reducedMotion, defaults.reducedMotion) };
}
