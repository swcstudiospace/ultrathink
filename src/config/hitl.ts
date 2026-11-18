// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { HitlConfig } from "../hitl/types.ts";

export function mergeHitl(
	hitl: Record<string, unknown> | undefined,
	defaults: HitlConfig,
): HitlConfig {
	if (!hitl) return defaults;
	return {
		enabled: typeof hitl.enabled === "boolean" ? hitl.enabled : defaults.enabled,
		maxQuestions:
			typeof hitl.maxQuestions === "number" &&
			Number.isInteger(hitl.maxQuestions) &&
			hitl.maxQuestions >= 1 &&
			hitl.maxQuestions <= 4
				? hitl.maxQuestions
				: defaults.maxQuestions,
		knowledgeBase:
			typeof hitl.knowledgeBase === "boolean" ? hitl.knowledgeBase : defaults.knowledgeBase,
	};
}

export function tightenHitl(
	hitl: Record<string, unknown> | undefined,
	base: HitlConfig,
): HitlConfig {
	if (!hitl) return base;
	return {
		...base,
		enabled: base.enabled || hitl.enabled === true,
		knowledgeBase: base.knowledgeBase && hitl.knowledgeBase !== false,
	};
}
