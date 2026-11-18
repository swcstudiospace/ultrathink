// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { MUSE_EFFORTS, type MuseConfig, type MuseEffort } from "../muse/types.ts";
import { nonEmpty, projectTimerMs, selectorField } from "./fields.ts";

/** Same trust rule as `mergeClaude`: a project layer cannot pick the `muse` executable. */
export function mergeMuse(
	muse: Record<string, unknown> | undefined,
	defaults: MuseConfig,
	project: boolean,
): MuseConfig {
	if (!muse) return defaults;
	return {
		bin: project ? defaults.bin : nonEmpty(muse.bin, defaults.bin),
		model: selectorField(muse.model) ?? defaults.model,
		reasoningEffort: MUSE_EFFORTS.includes(muse.reasoningEffort as MuseEffort)
			? (muse.reasoningEffort as MuseEffort)
			: defaults.reasoningEffort,
		callTimeoutMs: projectTimerMs(muse.callTimeoutMs, defaults.callTimeoutMs, project),
	};
}
