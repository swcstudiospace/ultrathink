// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { UltrathinkConfig } from "../config.ts";

export function mergeUplift(
	uplift: Record<string, unknown> | undefined,
	defaults: UltrathinkConfig["uplift"],
	project = false,
): UltrathinkConfig["uplift"] {
	if (!uplift) return defaults;
	return {
		enabled: typeof uplift.enabled === "boolean" ? uplift.enabled : defaults.enabled,
		skipTrivial:
			typeof uplift.skipTrivial === "boolean" ? uplift.skipTrivial : defaults.skipTrivial,
		echo: typeof uplift.echo === "boolean" ? uplift.echo : defaults.echo,
		maxChars:
			!project &&
			typeof uplift.maxChars === "number" &&
			Number.isInteger(uplift.maxChars) &&
			uplift.maxChars >= 0
				? uplift.maxChars
				: defaults.maxChars,
	};
}
