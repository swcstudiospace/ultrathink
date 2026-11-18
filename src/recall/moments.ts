// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Teachable moments for a failure's second occurrence (SPE-34394). The local store's confirmed moments are scored against
 * the query by the teach recall's own scorer and capped at its limit, then returned as a lessons-shaped lookup, which is
 * the moments source the planner reads. Local only: Hindsight is not asked. The lessons recall's gates apply: the kill
 * switch, `teach.enabled` and `teach.recall`. Never throws.
 */
import { teachEnabled, tryStore } from "../teach/context.ts";
import { projectOf } from "../teach/mapping.ts";
import { redactLine } from "../teach/redact.ts";
import { MAX_LIMIT, formatLessonsSection, lessonsLookup, recallLocal } from "../teach/recall.ts";
import type { LessonsLookup, RecallOutcome, RecalledLesson, TeachContext } from "../teach/types.ts";

/** The lessons recall's query cap; teach/recall.ts keeps its copy private. */
const MAX_QUERY_CHARS = 1_500;

/**
 * The teachable moments that match `query` in this machine's store, as the moments lookup the planner reads. With
 * `countUse`, each moment shown is counted as recalled, as a lesson is when a plan injects it.
 */
export async function recallMoments(
	query: string,
	ctx: TeachContext,
	options: { countUse?: boolean } = {},
): Promise<LessonsLookup> {
	const now = ctx.now ?? Date.now;
	const started = now();
	const outcome = (
		status: RecallOutcome["status"],
		rest: Partial<RecallOutcome> = {},
	): LessonsLookup =>
		lessonsLookup({
			status,
			lessons: [],
			source: "none",
			chars: 0,
			ms: Math.max(0, now() - started),
			...rest,
		});
	if (!teachEnabled(ctx)) return outcome("off", { reason: "teach is off" });
	if (!ctx.config.teach.recall) return outcome("off", { reason: "recall is off" });
	const text = query.trim().slice(0, MAX_QUERY_CHARS);
	if (text === "") return outcome("none");
	const store = tryStore(ctx);
	if (!store) return outcome("none");
	try {
		const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(ctx.config.teach.recallLimit)));
		const scored = await recallLocal(store, projectOf(ctx.cwd), text, limit);
		if (scored.length === 0) return outcome("none");
		const chars = ctx.config.teach.recallChars;
		const render = (moments: RecalledLesson[], maxChars: number): string =>
			formatLessonsSection(
				{ status: "used", lessons: moments, source: "local", chars: 0, ms: 0 },
				maxChars,
			);
		// The moments that fit whole, best first; when none does, the best one is kept with its body cut, as lessons are.
		let count = scored.length;
		while (count > 1 && render(scored.slice(0, count), Number.MAX_SAFE_INTEGER).length > chars)
			count -= 1;
		const used = scored.slice(0, count);
		const section = render(used, chars);
		if (section === "")
			return outcome("none", { reason: "moments do not fit the character budget" });
		if (options.countUse) {
			try {
				store.bumpRecalled(used.map((moment) => moment.id));
			} catch {
				// reason: a counter must never fail a plan
			}
		}
		return outcome("used", { lessons: used, source: "local", chars: section.length });
	} catch (error) {
		return outcome("error", {
			reason: redactLine(error instanceof Error ? error.message : String(error)),
		});
	}
}
