// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import {
	DECISION_POINTS,
	type DecisionPoint,
	type DecisionsConfig,
	isJevModelId,
} from "../decisions/types.ts";
import { unitInterval } from "./fields.ts";

/** Upper bound for `decisions.timeoutMs`; a larger (or non-finite) value keeps the previous layer's (K4). */
const MAX_DECISIONS_TIMEOUT_MS = 30_000;

/**
 * Per-field merge; only the fourteen known keys are read, so a layer can never add a URL (D1). `enabled` is ignored in
 * every layer: Jev is always on, and only ULTRATHINK_DECISIONS=0 disables it. `model` is accepted only when it is a Jev
 * model id (the OpenRouter key is Jev's alone); in every layer, project files included, anything else keeps the earlier
 * layer's value. A project layer (a file a cloned repository controls) may only tighten consent (K5): `zdr` false→true and
 * `points` narrowed to the intersection with the lower layers. Of the thresholds, a project layer can only make a gate
 * stricter: `shipVetoAtOrBelow`, `shipApproveAt`, `groundedAt`, `teachableAutoAt` and `skillworthyAt` can only rise, and
 * `blockingAt` can only fall. `planSkipBelow` and `teachableBelow` merge as usual: they decide planning and storage.
 */
export function mergeDecisions(
	decisions: Record<string, unknown> | undefined,
	defaults: DecisionsConfig,
	project: boolean,
): DecisionsConfig {
	if (!decisions) return defaults;
	let points = Array.isArray(decisions.points)
		? [
				...new Set(
					decisions.points.filter((p): p is DecisionPoint =>
						DECISION_POINTS.includes(p as DecisionPoint),
					),
				),
			]
		: defaults.points;
	if (project && points !== defaults.points)
		points = defaults.points.filter((p) => points.includes(p));
	const zdr = typeof decisions.zdr === "boolean" ? decisions.zdr : defaults.zdr;
	return {
		// Jev is always on: the file value is ignored in every layer; only ULTRATHINK_DECISIONS=0 disables.
		enabled: true,
		model:
			typeof decisions.model === "string" && isJevModelId(decisions.model.trim())
				? decisions.model.trim()
				: defaults.model,
		points,
		timeoutMs:
			typeof decisions.timeoutMs === "number" &&
			Number.isFinite(decisions.timeoutMs) &&
			decisions.timeoutMs > 0 &&
			decisions.timeoutMs <= MAX_DECISIONS_TIMEOUT_MS
				? decisions.timeoutMs
				: defaults.timeoutMs,
		zdr: project ? defaults.zdr || zdr : zdr,
		planSkipBelow: unitInterval(decisions.planSkipBelow, defaults.planSkipBelow),
		shipVetoAtOrBelow: strictness(
			project,
			unitInterval(decisions.shipVetoAtOrBelow, defaults.shipVetoAtOrBelow),
			defaults.shipVetoAtOrBelow,
			"higher",
		),
		shipApproveAt: strictness(
			project,
			unitInterval(decisions.shipApproveAt, defaults.shipApproveAt),
			defaults.shipApproveAt,
			"higher",
		),
		groundedAt: strictness(
			project,
			unitInterval(decisions.groundedAt, defaults.groundedAt),
			defaults.groundedAt,
			"higher",
		),
		blockingAt: strictness(
			project,
			unitInterval(decisions.blockingAt, defaults.blockingAt),
			defaults.blockingAt,
			"lower",
		),
		teachableBelow: unitInterval(decisions.teachableBelow, defaults.teachableBelow),
		teachableAutoAt: strictness(
			project,
			unitInterval(decisions.teachableAutoAt, defaults.teachableAutoAt),
			defaults.teachableAutoAt,
			"higher",
		),
		skillworthyAt: strictness(
			project,
			unitInterval(decisions.skillworthyAt, defaults.skillworthyAt),
			defaults.skillworthyAt,
			"higher",
		),
	};
}

/** A project layer can make a decision threshold stricter than the layer below it, never looser; a user layer sets it freely. */
function strictness(
	project: boolean,
	value: number,
	base: number,
	stricter: "higher" | "lower",
): number {
	if (!project) return value;
	return stricter === "higher" ? Math.max(value, base) : Math.min(value, base);
}
