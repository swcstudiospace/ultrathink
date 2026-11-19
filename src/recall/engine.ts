// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Mid-session recall planner (SPE-34394). One call plans one trigger. For each source the trigger maps to, it checks
 * the master switch, the source flag and the trigger flag; then whether the caller supplied the lookup; then the
 * cooldown and the budget. A source that passes is admitted: its lookup becomes a panel through the adapters, its items
 * are deduped against everything injected in the current epoch, and its cost is spent. Every source a trigger considers
 * yields exactly one audit entry. The session state (cooldown, budget, dedupe, failure occurrences) is passed in and the
 * next state returned, so a caller that keeps it carries the session ceilings across calls. Pure: no I/O, no fetch, no
 * clock reads. The caller fetches the lookups and passes them in.
 */
import type { KnowledgeLookup } from "../greptile/knowledge-probe.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";
import {
	type ProducerInvocation,
	lessonsLookupToPanel,
	momentsLookupToPanel,
	skillsLookupToPanel,
} from "./adapters.ts";
import type { RecallSettings } from "./config.ts";
import {
	type BudgetDecision,
	type BudgetState,
	type CooldownRequest,
	type CooldownState,
	type DedupeState,
	type FailureState,
	checkBudget,
	checkCooldown,
	createBudgetState,
	createCooldownState,
	createDedupeState,
	createFailureState,
	filterInjected,
	pruneCooldown,
	pruneFailures,
	recordCooldownFire,
	recordFailure,
	recordInjected,
	recordSpend,
} from "./gates.ts";
import { type PanelEnvelope, type PanelItem, knowledgeLookupToPanel } from "./panel-model.ts";

/** A trigger with the subject its cooldown is keyed on. `explicit` is a user request and has no cooldown. */
export type RecallEvent =
	| { trigger: "scopeChange"; scopePath: string }
	| { trigger: "failure"; error: string }
	| { trigger: "phaseBoundary"; planStep: string; taskType: string }
	| { trigger: "uncertainty"; topic: string }
	| { trigger: "explicit" };

type RecallTrigger = RecallEvent["trigger"];
/** The sources the planner handles. A failure recalls teachable moments on its second occurrence (see `failureSources`). */
export type PanelSourceName = "knowledge" | "lessons" | "moments" | "skills";

/** The trigger-to-source map for the triggers whose sources do not depend on an occurrence. */
const SOURCES_BY_TRIGGER: Record<Exclude<RecallTrigger, "failure">, readonly PanelSourceName[]> = {
	scopeChange: ["knowledge", "lessons"],
	phaseBoundary: ["skills"],
	uncertainty: ["knowledge"],
	explicit: ["knowledge", "lessons", "moments", "skills"],
};

/** Estimated tokens per character: the convention of decisions/client.ts. */
const CHARS_PER_TOKEN = 4;

/** The largest age a cooldown fire or failure occurrence is kept for: the largest windowed cooldown, capped at one day. */
const MAX_PRUNE_AGE_MS = 86_400_000;

/**
 * Teachable moments the caller fetched for a failure's second occurrence. A moment is recalled the way a lesson is, so it
 * shares the lessons record shape and the lessons adapter renders it.
 */
type MomentsLookup = LessonsLookup;

/**
 * Lookups the caller already fetched. An absent lookup means its source was not fetched; that source's audit entry is
 * `no_source`.
 */
export interface RecallLookups {
	knowledge?: KnowledgeLookup;
	lessons?: LessonsLookup;
	skills?: SkillsLookup;
	moments?: MomentsLookup;
}

/**
 * The session state the planner carries between calls: cooldown fires, the budget (turn counter and spend), the dedupe
 * epoch with the ids injected in it, and failure occurrences. The caller stores the `next` state a plan returns, passes
 * it to the next plan, calls `resetTurn` on the budget at each turn boundary and `resetDedupeEpoch` on compaction.
 */
export interface RecallRuntimeState {
	cooldown: CooldownState;
	budget: BudgetState;
	dedupe: DedupeState;
	/** Failure occurrences. Absent on a state written before failure tracking; it then counts as empty. */
	failures?: FailureState;
}

/** A fresh session state: nothing cooled down, nothing spent, nothing injected, no failure seen. */
export function createRecallState(): RecallRuntimeState {
	return {
		cooldown: createCooldownState(),
		budget: createBudgetState(),
		dedupe: createDedupeState(),
		failures: createFailureState(),
	};
}

export interface RecallInput {
	trigger: RecallEvent;
	/** Clock value in epoch milliseconds, supplied by the caller. */
	nowMs: number;
	settings: RecallSettings;
	/** The session state the last plan returned. Absent starts a fresh session (see `createRecallState`). */
	state?: RecallRuntimeState;
	lookups: RecallLookups;
}

type BudgetRefusalReason = Extract<BudgetDecision, { allowed: false }>["reason"];
/** Why a source was not considered: the master switch, its source flag, or the flag of the trigger. */
type DisabledReason = "master_off" | "source_off" | "trigger_off";

export type RecallAuditEntry = { source: PanelSourceName; trigger: RecallTrigger } & (
	| { outcome: "fired"; injected: number; deduped: number }
	| { outcome: "skipped_disabled"; reason: DisabledReason }
	| { outcome: "skipped_cooldown"; remainingMs: number }
	| { outcome: "skipped_budget"; reason: "skipped-by-budget"; cap: BudgetRefusalReason }
	| { outcome: "no_source" }
);

/** The panels of the sources that fired. A source that did not fire has no panel. */
interface RecallPanels {
	knowledge?: PanelEnvelope;
	lessons?: PanelEnvelope;
	skills?: PanelEnvelope;
	moments?: PanelEnvelope;
}

/** Why a plan was refused before any source was considered. The settings or clock are invalid, not the sources. */
type RecallRefusal = "invalid_clock" | "invalid_floor";

export type RecallPlan =
	| {
			ok: true;
			audit: RecallAuditEntry[];
			panels: RecallPanels;
			/** Ids of the items injected by this plan, after the relevance floor and dedupe. */
			injectedIds: string[];
			next: RecallRuntimeState;
	  }
	| { ok: false; reason: RecallRefusal };

/**
 * The cooldown request of one source under an event; undefined when that source does not cool down under it. A failure's
 * lessons and moments cool down per error signature for the failure window. Its skills do not, so a repeat that is still
 * within the window plans them again. An explicit request has no cooldown.
 */
function cooldownRequest(source: PanelSourceName, event: RecallEvent): CooldownRequest | undefined {
	switch (event.trigger) {
		case "scopeChange":
			return { source, trigger: "scopeChange", subject: { scopePath: event.scopePath } };
		case "phaseBoundary":
			return {
				source,
				trigger: "phaseBoundary",
				subject: { planStep: event.planStep, taskType: event.taskType },
			};
		case "uncertainty":
			return { source, trigger: "uncertainty", subject: { topic: event.topic } };
		case "failure":
			return source === "lessons" || source === "moments"
				? { source, trigger: "failure", subject: { error: event.error } }
				: undefined;
		case "explicit":
			return undefined;
	}
}

/**
 * The sources a failure recalls for its occurrence number: lessons on the first occurrence of its error signature,
 * teachable moments on the second, and none after that. Each of the first two also plans the skills source.
 */
function failureSources(occurrence: number): readonly PanelSourceName[] {
	if (occurrence === 1) return ["lessons", "skills"];
	if (occurrence === 2) return ["moments", "skills"];
	return [];
}

function disabledReason(
	recall: RecallSettings["recall"],
	source: PanelSourceName,
	trigger: RecallTrigger,
): DisabledReason | undefined {
	if (!recall.enabled) return "master_off";
	if (!recall.sources[source]) return "source_off";
	if (!recall.triggers[trigger]) return "trigger_off";
	return undefined;
}

/**
 * The panel of one supplied lookup, with the characters it carries. The lesson floor is applied by the lessons adapter,
 * which keeps score-less rows and reports each excluded row with its score; the gate applyRelevanceFloor would drop
 * score-less rows, so it is not used here.
 */
function panelFor(
	source: PanelSourceName,
	lookups: RecallLookups,
	floor: number,
	invocation: ProducerInvocation,
): { panel: PanelEnvelope; chars: number } | undefined {
	switch (source) {
		case "knowledge": {
			const lookup = lookups.knowledge;
			return lookup && { panel: knowledgeLookupToPanel(lookup), chars: lookup.chars };
		}
		case "lessons": {
			const lookup = lookups.lessons;
			return (
				lookup && { panel: lessonsLookupToPanel(lookup, floor, invocation), chars: lookup.chars }
			);
		}
		case "skills": {
			const lookup = lookups.skills;
			return lookup && { panel: skillsLookupToPanel(lookup, invocation), chars: lookup.chars };
		}
		case "moments": {
			const lookup = lookups.moments;
			return (
				lookup && { panel: momentsLookupToPanel(lookup, floor, invocation), chars: lookup.chars }
			);
		}
	}
}

/** The panel with each listed item's status set: `injected` when it survived dedupe, `deduped` otherwise. */
function markItems(panel: PanelEnvelope, fresh: ReadonlySet<PanelItem>): PanelEnvelope {
	if (panel.status === "loading" || panel.status === "error") return panel;
	return {
		...panel,
		items: panel.items.map(
			(item): PanelItem => ({ ...item, itemStatus: fresh.has(item) ? "injected" : "deduped" }),
		),
	};
}

/**
 * Plans the recall for one trigger. A failure's sources depend on its occurrence: lessons on the first occurrence of its
 * error signature, teachable moments on the second, none after that. Each other trigger considers its mapped sources in
 * the trigger map's order. A refusal (invalid clock or floor) returns before any source is considered; otherwise each
 * source considered yields one audit entry. The `next` state carries the cooldown fires, failure occurrences, budget
 * spend and injected dedupe keys of the admitted sources, with cooldown fires and failure occurrences older than the
 * largest windowed cooldown dropped. A call with no `state` plans from a fresh session.
 */
export function planRecall(input: RecallInput): RecallPlan {
	const { trigger, nowMs, settings, lookups } = input;
	const recall = settings.recall;
	const floor = recall.relevanceFloor.lessons;
	const invocation: ProducerInvocation = { trigger: trigger.trigger, startedAt: nowMs };

	if (!Number.isFinite(nowMs)) return { ok: false, reason: "invalid_clock" };
	if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
		return { ok: false, reason: "invalid_floor" };
	}

	const { cooldownMs } = recall;
	const pruneAgeMs = Math.min(
		Math.max(cooldownMs.scopeChange, cooldownMs.failure, cooldownMs.uncertainty),
		MAX_PRUNE_AGE_MS,
	);
	const audit: RecallAuditEntry[] = [];
	const panels: RecallPanels = {};
	const injectedIds: string[] = [];
	const prior = input.state ?? createRecallState();
	let { cooldown, budget, dedupe } = prior;
	let failures = prior.failures ?? createFailureState();

	let sources: readonly PanelSourceName[];
	if (trigger.trigger === "failure") {
		const recorded = recordFailure(failures, trigger.error, nowMs, pruneAgeMs);
		failures = recorded.state;
		sources = failureSources(recorded.occurrence);
	} else {
		sources = SOURCES_BY_TRIGGER[trigger.trigger];
	}

	for (const source of sources) {
		const pair = { source, trigger: trigger.trigger };

		const disabled = disabledReason(recall, source, trigger.trigger);
		if (disabled !== undefined) {
			audit.push({ ...pair, outcome: "skipped_disabled", reason: disabled });
			continue;
		}

		const admitted = panelFor(source, lookups, floor, invocation);
		if (admitted === undefined) {
			audit.push({ ...pair, outcome: "no_source" });
			continue;
		}

		const request = cooldownRequest(source, trigger);
		if (request !== undefined) {
			const decision = checkCooldown(cooldown, request, cooldownMs, nowMs);
			if (!decision.allowed) {
				audit.push({ ...pair, outcome: "skipped_cooldown", remainingMs: decision.remainingMs });
				continue;
			}
		}

		const tokens = Math.ceil(admitted.chars / CHARS_PER_TOKEN);
		// An explicit request is the user's own ask: only the session ceiling applies to it, not the per-turn caps.
		const caps =
			trigger.trigger === "explicit"
				? {
						...recall.budget,
						perTurnCalls: recall.budget.perSessionCalls,
						perTurnTokens: recall.budget.perSessionTokens,
					}
				: recall.budget;
		const spend = checkBudget(budget, caps, { trigger: trigger.trigger, tokens });
		if (!spend.allowed) {
			audit.push({
				...pair,
				outcome: "skipped_budget",
				reason: "skipped-by-budget",
				cap: spend.reason,
			});
			continue;
		}

		const listed: readonly PanelItem[] =
			admitted.panel.status === "loading" || admitted.panel.status === "error"
				? []
				: admitted.panel.items;
		const outcome = filterInjected(
			dedupe,
			listed.map((item) => ({ id: item.id, content: item.preview, item })),
		);
		const fresh = new Set(outcome.fresh.map((entry) => entry.candidate.item));
		for (const entry of outcome.fresh) injectedIds.push(entry.candidate.item.id);
		dedupe = recordInjected(
			dedupe,
			outcome.fresh.map((entry) => entry.key),
		);
		panels[source] = markItems(admitted.panel, fresh);

		// A panel whose every item was already injected surfaced nothing new, so it does not arm the cooldown: a later
		// fresh item on the same scope may still fire. An empty or unavailable panel still arms it, as before.
		const exhausted = listed.length > 0 && outcome.fresh.length === 0;
		if (request !== undefined && !exhausted)
			cooldown = recordCooldownFire(cooldown, request, nowMs);
		budget = recordSpend(budget, tokens);
		audit.push({
			...pair,
			outcome: "fired",
			injected: outcome.fresh.length,
			deduped: outcome.skipped.length,
		});
	}

	return {
		ok: true,
		audit,
		panels,
		injectedIds,
		next: {
			cooldown: pruneCooldown(cooldown, nowMs, pruneAgeMs),
			budget,
			dedupe,
			failures: pruneFailures(failures, nowMs, pruneAgeMs),
		},
	};
}
