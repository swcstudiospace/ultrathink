// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Mid-session recall planner (SPE-34394). One call plans one trigger. For each source the trigger maps to, it checks
 * the master switch, the source flag and the trigger flag; then whether the caller supplied the lookup; then the
 * cooldown and the budget. A source that passes is admitted: its lookup becomes a panel through the adapters, its items
 * are deduped against everything injected in the current epoch, and its cost is spent. Every source-trigger pair yields
 * exactly one audit entry. Pure: no I/O, no fetch, no clock reads. The caller fetches the lookups and passes them in.
 */
import type { KnowledgeLookup } from "../greptile/knowledge-probe.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";
import { lessonsLookupToPanel, skillsLookupToPanel } from "./adapters.ts";
import type { RecallSettings } from "./config.ts";
import {
	type BudgetDecision,
	type BudgetState,
	type CooldownRequest,
	type CooldownState,
	type CooldownWindows,
	type DedupeState,
	checkBudget,
	checkCooldown,
	cooldownKey,
	filterInjected,
	recordCooldownFire,
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
/** The sources the planner handles. Moments are not in the trigger map, so they are never planned here. */
export type PanelSourceName = "knowledge" | "lessons" | "skills";

/** The trigger-to-source map. Each trigger may recall from exactly these sources. */
const SOURCES_BY_TRIGGER: Record<RecallTrigger, readonly PanelSourceName[]> = {
	scopeChange: ["knowledge", "lessons"],
	failure: ["lessons"],
	phaseBoundary: ["skills"],
	uncertainty: ["knowledge"],
	explicit: ["knowledge", "lessons", "skills"],
};

/** Estimated tokens per character: the convention of decisions/client.ts. */
const CHARS_PER_TOKEN = 4;

/**
 * Lookups the caller already fetched. An absent lookup means its source was not fetched; that source's audit entry is
 * `no_source`.
 */
export interface RecallLookups {
	knowledge?: KnowledgeLookup;
	lessons?: LessonsLookup;
	skills?: SkillsLookup;
}

/** State carried between plans. The caller stores the `next` state a plan returns and passes it to the next plan. */
export interface RecallRuntimeState {
	cooldown: CooldownState;
	budget: BudgetState;
	dedupe: DedupeState;
}

export interface RecallInput {
	trigger: RecallEvent;
	/** Clock value in epoch milliseconds, supplied by the caller. */
	nowMs: number;
	settings: RecallSettings;
	state: RecallRuntimeState;
	lookups: RecallLookups;
	/**
	 * Cooldown window for phaseBoundary, in ms. Defaults to 0. The settings carry no phaseBoundary window yet, so the
	 * caller must supply it until the settings schema adds one.
	 */
	phaseBoundaryWindowMs?: number;
}

type BudgetRefusalReason = Extract<BudgetDecision, { allowed: false }>["reason"];
/** Why a source was not considered: the master switch, its source flag, or the flag of the trigger. */
type DisabledReason = "master_off" | "source_off" | "trigger_off";

type RecallAuditEntry = { source: PanelSourceName; trigger: RecallTrigger } & (
	| { outcome: "fired"; injected: number; deduped: number }
	| { outcome: "skipped_disabled"; reason: DisabledReason }
	| { outcome: "skipped_cooldown"; remainingMs: number }
	| { outcome: "skipped_budget"; reason: BudgetRefusalReason }
	| { outcome: "no_source" }
);

/** The panels of the sources that fired. A source that did not fire has no panel. */
interface RecallPanels {
	knowledge?: PanelEnvelope;
	lessons?: PanelEnvelope;
	skills?: PanelEnvelope;
}

/** Why a plan was refused before any source was considered. The settings or clock are invalid, not the sources. */
type RecallRefusal = "invalid_clock" | "invalid_floor" | "invalid_phase_window";

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

/** The cooldown request of one source under an event; undefined for an explicit request, which has no cooldown. */
function cooldownRequest(source: PanelSourceName, event: RecallEvent): CooldownRequest | undefined {
	switch (event.trigger) {
		case "scopeChange":
			return { source, trigger: "scopeChange", subject: { scopePath: event.scopePath } };
		case "failure":
			return { source, trigger: "failure", subject: { error: event.error } };
		case "phaseBoundary":
			return {
				source,
				trigger: "phaseBoundary",
				subject: { planStep: event.planStep, taskType: event.taskType },
			};
		case "uncertainty":
			return { source, trigger: "uncertainty", subject: { topic: event.topic } };
		case "explicit":
			return undefined;
	}
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
): { panel: PanelEnvelope; chars: number } | undefined {
	switch (source) {
		case "knowledge": {
			const lookup = lookups.knowledge;
			return lookup && { panel: knowledgeLookupToPanel(lookup), chars: lookup.chars };
		}
		case "lessons": {
			const lookup = lookups.lessons;
			return lookup && { panel: lessonsLookupToPanel(lookup, floor), chars: lookup.chars };
		}
		case "skills": {
			const lookup = lookups.skills;
			return lookup && { panel: skillsLookupToPanel(lookup), chars: lookup.chars };
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
 * Plans the recall for one trigger. Sources are considered in the trigger map's order. A refusal (invalid clock, floor
 * or phase window) returns before any source is considered; otherwise every mapped source yields one audit entry, and
 * the returned `next` state carries the cooldown fires, budget spend and injected dedupe keys of the admitted sources.
 */
export function planRecall(input: RecallInput): RecallPlan {
	const { trigger, nowMs, settings, lookups } = input;
	const recall = settings.recall;
	const phaseBoundaryWindowMs = input.phaseBoundaryWindowMs ?? 0;
	const floor = recall.relevanceFloor.lessons;

	if (!Number.isFinite(nowMs)) return { ok: false, reason: "invalid_clock" };
	if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
		return { ok: false, reason: "invalid_floor" };
	}
	if (!Number.isFinite(phaseBoundaryWindowMs) || phaseBoundaryWindowMs < 0) {
		return { ok: false, reason: "invalid_phase_window" };
	}

	const windows: CooldownWindows = { ...recall.cooldownMs, phaseBoundary: phaseBoundaryWindowMs };
	const audit: RecallAuditEntry[] = [];
	const panels: RecallPanels = {};
	const injectedIds: string[] = [];
	let { cooldown, budget, dedupe } = input.state;

	for (const source of SOURCES_BY_TRIGGER[trigger.trigger]) {
		const pair = { source, trigger: trigger.trigger };

		const disabled = disabledReason(recall, source, trigger.trigger);
		if (disabled !== undefined) {
			audit.push({ ...pair, outcome: "skipped_disabled", reason: disabled });
			continue;
		}

		const admitted = panelFor(source, lookups, floor);
		if (admitted === undefined) {
			audit.push({ ...pair, outcome: "no_source" });
			continue;
		}

		const request = cooldownRequest(source, trigger);
		if (request !== undefined) {
			const decision = checkCooldown(cooldown, request, windows, nowMs);
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
			audit.push({ ...pair, outcome: "skipped_budget", reason: spend.reason });
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

		if (request !== undefined) cooldown = recordCooldownFire(cooldown, cooldownKey(request), nowMs);
		budget = recordSpend(budget, tokens);
		audit.push({
			...pair,
			outcome: "fired",
			injected: outcome.fresh.length,
			deduped: outcome.skipped.length,
		});
	}

	return { ok: true, audit, panels, injectedIds, next: { cooldown, budget, dedupe } };
}
