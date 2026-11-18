// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import {
	GREPTILE_MAX_SCORE,
	JUDGE_MODES,
	type JudgeMode,
	MERGE_METHODS,
	type ShipConfig,
} from "../ship/types.ts";
import { positiveInt } from "./fields.ts";

/** Absent keeps the lower layer's reviewer; any value other than "greptile" or "claude" is a config error, not a silent fallback. */
function reviewerField(value: unknown, fallback: ShipConfig["reviewer"]): ShipConfig["reviewer"] {
	if (value === undefined) return fallback;
	if (value === "greptile" || value === "claude") return value;
	throw new Error(`ship.reviewer must be "greptile" or "claude", got ${JSON.stringify(value)}`);
}

export function mergeShip(ship: Record<string, unknown> | undefined, defaults: ShipConfig): ShipConfig {
	if (!ship) return defaults;
	const skills =
		Array.isArray(ship.skills) && ship.skills.every((s) => typeof s === "string" && s.trim())
			? (ship.skills as string[]).map((s) => s.trim())
			: defaults.skills;
	const owners = Array.isArray(ship.owners)
		? [
				...new Set(
					ship.owners
						.filter((owner): owner is string => typeof owner === "string")
						.map((owner) => owner.trim())
						.filter((owner) => owner !== ""),
				),
			]
		: defaults.owners;
	return {
		enabled: typeof ship.enabled === "boolean" ? ship.enabled : defaults.enabled,
		autoMerge: typeof ship.autoMerge === "boolean" ? ship.autoMerge : defaults.autoMerge,
		skills,
		owners,
		minScore:
			typeof ship.minScore === "number" &&
			Number.isFinite(ship.minScore) &&
			ship.minScore >= 1 &&
			ship.minScore <= GREPTILE_MAX_SCORE
				? ship.minScore
				: defaults.minScore,
		requireNoComments:
			typeof ship.requireNoComments === "boolean"
				? ship.requireNoComments
				: defaults.requireNoComments,
		maxRounds: positiveInt(ship.maxRounds, defaults.maxRounds),
		mergeMethod: MERGE_METHODS.includes(ship.mergeMethod as ShipConfig["mergeMethod"])
			? (ship.mergeMethod as ShipConfig["mergeMethod"])
			: defaults.mergeMethod,
		deleteBranch:
			typeof ship.deleteBranch === "boolean" ? ship.deleteBranch : defaults.deleteBranch,
		greptileOrganization:
			typeof ship.greptileOrganization === "string"
				? ship.greptileOrganization.trim()
				: defaults.greptileOrganization,
		reviewTimeoutMs: positiveInt(ship.reviewTimeoutMs, defaults.reviewTimeoutMs),
		pollMs: positiveInt(ship.pollMs, defaults.pollMs),
		waitMs: positiveInt(ship.waitMs, defaults.waitMs),
		reviewRetries:
			typeof ship.reviewRetries === "number" &&
			Number.isFinite(ship.reviewRetries) &&
			ship.reviewRetries >= 0
				? Math.floor(ship.reviewRetries)
				: defaults.reviewRetries,
		mergeTimeoutMs: positiveInt(ship.mergeTimeoutMs, defaults.mergeTimeoutMs),
		judge: JUDGE_MODES.includes(ship.judge as JudgeMode)
			? (ship.judge as JudgeMode)
			: defaults.judge,
		reviewer: reviewerField(ship.reviewer, defaults.reviewer),
	};
}

/**
 * Project layers are repository-controlled, so they may only tighten these sections (default-deny, K5). Each helper
 * lets a project move a key toward the safer side and nothing else. `ship.greptileOrganization` is the one other key a
 * project file fills: only where no earlier file sets it. It names an organization the user's own Greptile account
 * already belongs to, and the repository's code goes to Greptile for review either way. Notion and Linear are user-only
 * (see `mergeConfig`). Think is user-only. `ship.owners` is user-only, so the base list passes through unchanged.
 */
export function tightenShip(ship: Record<string, unknown> | undefined, base: ShipConfig): ShipConfig {
	if (!ship) return base;
	const minScore = ship.minScore;
	return {
		...base,
		enabled: ship.enabled === false ? false : base.enabled,
		autoMerge: ship.autoMerge === false ? false : base.autoMerge,
		deleteBranch: ship.deleteBranch === false ? false : base.deleteBranch,
		greptileOrganization:
			base.greptileOrganization || typeof ship.greptileOrganization !== "string"
				? base.greptileOrganization
				: ship.greptileOrganization.trim(),
		minScore:
			typeof minScore === "number" &&
			Number.isFinite(minScore) &&
			minScore > base.minScore &&
			minScore <= GREPTILE_MAX_SCORE
				? minScore
				: base.minScore,
	};
}
