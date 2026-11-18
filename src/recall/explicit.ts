// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Explicit recall: the user's `/ultrathink-recall <query>` request, one pass of the recall planner with the explicit
 * trigger over the knowledge, lessons and skills sources. The caller supplies the fetchers; this module runs them,
 * turns a rejected fetch into the failed lookup the planner already understands, and returns the panels and the audit.
 * The planner applies the master switch, the source and trigger flags and the session budget. An explicit request has no
 * cooldown and no per-turn cap. The caller keeps the `next` state and passes it back, so the session ceilings accumulate
 * across explicit calls; a call with no state plans from a fresh session.
 */
import type { KnowledgeLookup } from "../greptile/knowledge-probe.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";
import type { RecallSettings } from "./config.ts";
import {
	type RecallAuditEntry,
	type RecallPlan,
	type RecallRuntimeState,
	planRecall,
} from "./engine.ts";

/** Fetchers for the query. An absent fetcher means its source was not fetched, so its audit entry is `no_source`. */
export interface ExplicitFetchers {
	knowledge?(query: string): Promise<KnowledgeLookup>;
	lessons?(query: string): Promise<LessonsLookup>;
	skills?(query: string): Promise<SkillsLookup>;
}

export interface ExplicitRecallInput {
	query: string;
	/** Clock value in epoch milliseconds, supplied by the caller. */
	nowMs: number;
	settings: RecallSettings;
	/** The session state the caller kept from the last recall. Absent starts a fresh session. */
	state?: RecallRuntimeState;
	fetch: ExplicitFetchers;
}

/** The panels one explicit recall returns: the planner's own panels, so every source the planner fires is typed here. */
type ExplicitPanels = Extract<RecallPlan, { ok: true }>["panels"];

/** An empty query and a switched-off recall are refused before any fetch; a planner refusal is passed through. */
export type ExplicitRecallResult =
	| { ok: true; panels: ExplicitPanels; audit: RecallAuditEntry[]; next: RecallRuntimeState }
	| {
			ok: false;
			reason: "recall_off" | "empty_query" | Extract<RecallPlan, { ok: false }>["reason"];
	  };

/** Runs one fetch. A rejection becomes the failed lookup `failed` builds; an absent fetcher resolves to undefined. */
async function settle<T>(
	run: () => Promise<T> | undefined,
	failed: (reason: string) => T,
): Promise<T | undefined> {
	try {
		return await run();
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	}
}

export async function runExplicitRecall(input: ExplicitRecallInput): Promise<ExplicitRecallResult> {
	const query = input.query.trim();
	if (query === "") return { ok: false, reason: "empty_query" };
	if (!input.settings.recall.enabled) return { ok: false, reason: "recall_off" };

	const [knowledge, lessons, skills] = await Promise.all([
		settle<KnowledgeLookup>(
			() => input.fetch.knowledge?.(query),
			(reason) => ({ outcome: "error", docs: [], chars: 0, ms: 0, reason }),
		),
		settle<LessonsLookup>(
			() => input.fetch.lessons?.(query),
			(reason) => ({
				outcome: "error",
				count: 0,
				ids: [],
				chars: 0,
				ms: 0,
				source: "none",
				reason,
			}),
		),
		settle<SkillsLookup>(
			() => input.fetch.skills?.(query),
			(reason) => ({ outcome: "error", count: 0, names: [], chars: 0, ms: 0, reason }),
		),
	]);

	const plan = planRecall({
		trigger: { trigger: "explicit" },
		nowMs: input.nowMs,
		settings: input.settings,
		state: input.state,
		lookups: { knowledge, lessons, skills },
	});
	if (!plan.ok) return { ok: false, reason: plan.reason };
	return { ok: true, panels: plan.panels, audit: plan.audit, next: plan.next };
}
