// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ToT release glue for the hook: a plan is released only once every Sub Issue has a generated PRD placed in the
 * specification. Any unplaced PRD key (unmatched key) or any not-generated PRD (failed, held by an unsatisfied
 * dependency, skipped) holds the release with a secret-free reason; the `PRDS` XML element only carries counts.
 */
import type { PrdOutcome } from "../think/tot/stage.ts";

/** Why the plan must be held back, or `undefined` when every PRD was generated and placed. */
export function totHoldReason(
	outcome: PrdOutcome,
	unplaced: readonly string[],
): string | undefined {
	if (unplaced.length > 0) {
		return `no Sub Issue in the specification for ${unplaced.join(", ")}`;
	}
	if (outcome.manifest.generated < outcome.manifest.total) {
		return (
			outcome.error ??
			`PRD_PARTIAL: ${outcome.manifest.generated} of ${outcome.manifest.total} PRDs generated`
		);
	}
	return outcome.error;
}
