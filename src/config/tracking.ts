// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { LinearConfig, NotionConfig, TrackConfig } from "../config.ts";
import { MAX_TIMER_MS, nonEmpty } from "./fields.ts";

export function mergeNotion(
	notion: Record<string, unknown> | undefined,
	defaults: NotionConfig,
): NotionConfig {
	if (!notion) return defaults;
	return { dataSourceUrl: nonEmpty(notion.dataSourceUrl, defaults.dataSourceUrl) };
}

export function mergeLinear(
	linear: Record<string, unknown> | undefined,
	defaults: LinearConfig,
): LinearConfig {
	if (!linear) return defaults;
	return { team: nonEmpty(linear.team, defaults.team) };
}

export function mergeTrack(
	track: Record<string, unknown> | undefined,
	defaults: TrackConfig,
): TrackConfig {
	if (!track) return defaults;
	return {
		enabled: typeof track.enabled === "boolean" ? track.enabled : defaults.enabled,
		budgetMs:
			typeof track.budgetMs === "number" && Number.isFinite(track.budgetMs) && track.budgetMs >= 0
				? Math.min(track.budgetMs, MAX_TIMER_MS)
				: defaults.budgetMs,
		concurrency:
			typeof track.concurrency === "number" &&
			Number.isFinite(track.concurrency) &&
			track.concurrency >= 1
				? Math.floor(track.concurrency)
				: defaults.concurrency,
	};
}

export function tightenTrack(track: Record<string, unknown> | undefined, base: TrackConfig): TrackConfig {
	if (!track) return base;
	return { ...base, enabled: track.enabled === false ? false : base.enabled };
}
