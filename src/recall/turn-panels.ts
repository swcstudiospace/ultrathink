/**
 * The information panels one prompt's plan carries (SPE-34395): the knowledge, lessons, skills, teachable moments and
 * Substrate brief lookups the planner already made, mapped to panel envelopes. Off unless `panels.informationPanels` is
 * set, so the plan view is unchanged by default. Pure: the caller passes the lookups it holds; nothing is fetched here.
 */
import type { KnowledgeLookup } from "../greptile/knowledge.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";
import {
	type ProducerInvocation,
	lessonsLookupToPanel,
	momentsLookupToPanel,
	skillsLookupToPanel,
	type SubstrateBriefInput,
	substrateBriefToPanel,
} from "./adapters.ts";
import type { RecallSettings } from "./config.ts";
import { type PanelEnvelope, knowledgeLookupToPanel, producerPanelTrigger } from "./panel-model.ts";

/** Panel envelopes for one prompt; a source the planner did not look up has no entry. */
export interface TurnPanels {
	knowledge?: PanelEnvelope;
	lessons?: PanelEnvelope;
	skills?: PanelEnvelope;
	moments?: PanelEnvelope;
	substrate?: PanelEnvelope;
}

/** The lookups the planner made for one prompt; each is absent when that source did not run. */
interface TurnLookups {
	knowledge?: KnowledgeLookup;
	lessons?: LessonsLookup;
	skills?: SkillsLookup;
	moments?: LessonsLookup;
	substrate?: SubstrateBriefInput;
}

/** The panels for one prompt, or undefined when the panels are off or no source was looked up. */
export function buildTurnPanels(
	lookups: TurnLookups,
	settings: RecallSettings,
	invocation?: ProducerInvocation,
): TurnPanels | undefined {
	if (!settings.panels.informationPanels) return undefined;
	const panels: TurnPanels = {};
	if (lookups.knowledge)
		panels.knowledge = knowledgeLookupToPanel(
			lookups.knowledge,
			invocation
				? { trigger: producerPanelTrigger(invocation.trigger), startedAt: invocation.startedAt }
				: undefined,
		);
	if (lookups.lessons)
		panels.lessons = lessonsLookupToPanel(
			lookups.lessons,
			settings.recall.relevanceFloor.lessons,
			invocation,
		);
	if (lookups.skills) panels.skills = skillsLookupToPanel(lookups.skills, invocation);
	if (lookups.moments)
		panels.moments = momentsLookupToPanel(
			lookups.moments,
			settings.recall.relevanceFloor.lessons,
			invocation,
		);
	if (lookups.substrate) panels.substrate = substrateBriefToPanel(lookups.substrate, invocation);
	return Object.keys(panels).length > 0 ? panels : undefined;
}

/**
 * A lookup as the session record keeps it: row titles and previews are not persisted, so the record holds counts and
 * names only. The panels are built in memory from the rows the planner already has (see `buildTurnPanels`).
 */
export function withoutRows<T extends { rows?: unknown }>(lookup: T): Omit<T, "rows"> {
	const { rows: _rows, ...kept } = lookup;
	return kept;
}
