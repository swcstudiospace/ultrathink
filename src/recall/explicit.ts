// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Explicit recall: the user's `/ultrathink-recall <query>` request, one pass of the recall planner with the explicit
 * trigger over the knowledge, lessons, moments and skills sources. The caller supplies the fetchers; this module runs them
 * under the recall timeout, turns a rejected or timed-out fetch into the failed lookup the planner already understands, and
 * returns the panels and the audit, with `remainderReason` set when the timeout cut a fetch short.
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
	moments?(query: string): Promise<LessonsLookup>;
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

/**
 * An empty query and a switched-off recall are refused before any fetch; a planner refusal is passed through. A recall
 * whose fetches outlast the recall timeout is partial: `remainderReason` is `timeout`, and each fetch still pending then
 * has an error panel with reason `timeout`.
 */
export type ExplicitRecallResult =
	| {
			ok: true;
			panels: ExplicitPanels;
			audit: RecallAuditEntry[];
			next: RecallRuntimeState;
			remainderReason?: "timeout";
	  }
	| {
			ok: false;
			reason: "recall_off" | "empty_query" | Extract<RecallPlan, { ok: false }>["reason"];
	  };

/** One fetch's lookup, and whether the recall deadline ended the wait before it returned. */
interface Fetched<T> {
	lookup: T | undefined;
	timedOut: boolean;
}

/**
 * Runs one fetch and waits for it until the shared deadline. A rejection becomes the failed lookup `failed` builds; so does
 * a deadline that passes first, with reason `timeout`. An absent fetcher resolves to an undefined lookup.
 */
function settle<T>(
	run: () => Promise<T> | undefined,
	failed: (reason: string) => T,
	deadline: Promise<void>,
): Promise<Fetched<T>> {
	const fetched: Promise<Fetched<T>> = (async () => run())().then(
		(lookup) => ({ lookup, timedOut: false }),
		(error: unknown) => ({
			lookup: failed(error instanceof Error ? error.message : String(error)),
			timedOut: false,
		}),
	);
	const expired: Promise<Fetched<T>> = deadline.then(() => ({
		lookup: failed("timeout"),
		timedOut: true,
	}));
	return Promise.race([fetched, expired]);
}

const failedKnowledge = (reason: string): KnowledgeLookup => ({
	outcome: "error",
	docs: [],
	chars: 0,
	ms: 0,
	reason,
});

const failedLessons = (reason: string): LessonsLookup => ({
	outcome: "error",
	count: 0,
	ids: [],
	chars: 0,
	ms: 0,
	source: "none",
	reason,
});

const failedSkills = (reason: string): SkillsLookup => ({
	outcome: "error",
	count: 0,
	names: [],
	chars: 0,
	ms: 0,
	reason,
});

export async function runExplicitRecall(input: ExplicitRecallInput): Promise<ExplicitRecallResult> {
	const query = input.query.trim();
	if (query === "") return { ok: false, reason: "empty_query" };
	if (!input.settings.recall.enabled) return { ok: false, reason: "recall_off" };

	const { promise: deadline, resolve: expire } = Promise.withResolvers<void>();
	const timer = setTimeout(expire, input.settings.recall.timeoutMs);
	let fetched: [
		Fetched<KnowledgeLookup>,
		Fetched<LessonsLookup>,
		Fetched<LessonsLookup>,
		Fetched<SkillsLookup>,
	];
	try {
		fetched = await Promise.all([
			settle<KnowledgeLookup>(() => input.fetch.knowledge?.(query), failedKnowledge, deadline),
			settle<LessonsLookup>(() => input.fetch.lessons?.(query), failedLessons, deadline),
			settle<LessonsLookup>(() => input.fetch.moments?.(query), failedLessons, deadline),
			settle<SkillsLookup>(() => input.fetch.skills?.(query), failedSkills, deadline),
		]);
	} finally {
		clearTimeout(timer);
	}
	const [knowledge, lessons, moments, skills] = fetched;
	const timedOut = fetched.some((entry) => entry.timedOut);

	const plan = planRecall({
		trigger: { trigger: "explicit" },
		nowMs: input.nowMs,
		settings: input.settings,
		state: input.state,
		lookups: {
			knowledge: knowledge.lookup,
			lessons: lessons.lookup,
			moments: moments.lookup,
			skills: skills.lookup,
		},
	});
	if (!plan.ok) return { ok: false, reason: plan.reason };
	return {
		ok: true,
		panels: plan.panels,
		audit: plan.audit,
		next: plan.next,
		...(timedOut ? { remainderReason: "timeout" as const } : {}),
	};
}
