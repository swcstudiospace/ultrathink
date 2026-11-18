// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { ThinkSettings, TotConfig } from "../config.ts";
import {
	MAX_NODES,
	THINK_ENGINES,
	THINK_REASONING_CEILINGS,
	type ThinkEngine,
	type ThinkReasoningCeiling,
} from "../think/types.ts";
import { asRecord } from "./fields.ts";

/** A positive integer within [min, max] as written; anything else keeps the lower value. */
function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
		? value
		: fallback;
}

function mergeTot(tot: Record<string, unknown> | undefined, defaults: TotConfig): TotConfig {
	if (!tot) return defaults;
	const enabled = typeof tot.enabled === "boolean" ? tot.enabled : defaults.enabled;
	return {
		...(enabled === undefined ? {} : { enabled }),
		concurrency: boundedInt(tot.concurrency, 1, 16, defaults.concurrency),
		maxPrdChars: boundedInt(tot.maxPrdChars, 500, 100_000, defaults.maxPrdChars),
		maxPrdLines: boundedInt(tot.maxPrdLines, 20, 2000, defaults.maxPrdLines),
	};
}

export function mergeThink(
	think: Record<string, unknown> | undefined,
	defaults: ThinkSettings,
): ThinkSettings {
	if (!think) return defaults;
	const minNodes =
		typeof think.minNodes === "number" && Number.isInteger(think.minNodes) && think.minNodes >= 1
			? think.minNodes
			: defaults.minNodes;
	const maxNodes =
		typeof think.maxNodes === "number" &&
		Number.isInteger(think.maxNodes) &&
		think.maxNodes >= minNodes
			? Math.min(think.maxNodes, MAX_NODES)
			: defaults.maxNodes;
	const fillRetries =
		typeof think.fillRetries === "number" &&
		Number.isInteger(think.fillRetries) &&
		think.fillRetries > 0
			? think.fillRetries
			: defaults.fillRetries;
	const repair = typeof think.repair === "boolean" ? think.repair : defaults.repair;
	return {
		enabled: typeof think.enabled === "boolean" ? think.enabled : defaults.enabled,
		minNodes: Math.min(minNodes, maxNodes),
		maxNodes,
		engine: THINK_ENGINES.includes(think.engine as ThinkEngine)
			? (think.engine as ThinkEngine)
			: defaults.engine,
		reasoningCeiling: THINK_REASONING_CEILINGS.includes(
			think.reasoningCeiling as ThinkReasoningCeiling,
		)
			? (think.reasoningCeiling as ThinkReasoningCeiling)
			: defaults.reasoningCeiling,
		fillRetries,
		repair,
		tot: mergeTot(asRecord(think.tot), defaults.tot),
	};
}
