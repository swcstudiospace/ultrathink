// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { CAPTURE_MODES, type CaptureMode, type TeachConfig } from "../teach/types.ts";
import { booleanOr, intInRange } from "./fields.ts";

/**
 * A project layer can only turn `enabled`, `recall` and `autoPromote` off and lower `capture` (auto -> observe -> explicit);
 * every other key is ignored there. `CAPTURE_MODES` is ordered lowest first.
 */
export function mergeTeach(
	teach: Record<string, unknown> | undefined,
	defaults: TeachConfig,
	project: boolean,
): TeachConfig {
	if (!teach) return defaults;
	const enabled = booleanOr(teach.enabled, defaults.enabled);
	const recall = booleanOr(teach.recall, defaults.recall);
	const autoPromote = booleanOr(teach.autoPromote, defaults.autoPromote);
	const requested = CAPTURE_MODES.find((mode) => mode === teach.capture);
	if (project) {
		const capture: CaptureMode =
			requested !== undefined &&
			CAPTURE_MODES.indexOf(requested) < CAPTURE_MODES.indexOf(defaults.capture)
				? requested
				: defaults.capture;
		return {
			...defaults,
			enabled: defaults.enabled && enabled,
			capture,
			recall: defaults.recall && recall,
			autoPromote: defaults.autoPromote && autoPromote,
		};
	}
	return {
		enabled,
		capture: requested ?? defaults.capture,
		recall,
		recallLimit: intInRange(teach.recallLimit, 1, 10, defaults.recallLimit),
		recallChars: intInRange(teach.recallChars, 500, 8_000, defaults.recallChars),
		promoteAfter: intInRange(teach.promoteAfter, 2, 20, defaults.promoteAfter),
		autoPromote,
		observeMinToolCalls: intInRange(teach.observeMinToolCalls, 0, 50, defaults.observeMinToolCalls),
		timeoutMs: intInRange(teach.timeoutMs, 500, 30_000, defaults.timeoutMs),
	};
}
