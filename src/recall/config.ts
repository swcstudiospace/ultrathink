// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Settings for recall, the knowledge-base probe record, skill authoring and the information panels. Every new key is
 * off (or the least intrusive value) by default: recall stays disabled until `recall.enabled` is set, generated skills
 * are drafts that are never injected, and panels stay hidden until `panels.informationPanels` is set. The probe record
 * is the one default-on key, and it only records observations; it never changes injected content.
 *
 * Parsing is total. A missing, mistyped or out-of-range field keeps its base value, field by field, so a bad value never
 * throws and never disturbs a neighbouring field. Counts and durations must be finite and at least 1; they are floored
 * and clamped to the documented maximum. Shares and confidence floors must be finite and within [0, 1].
 */

type SkillActivation = "draft" | "active";

interface RecallConfig {
	/** Master switch. While false nothing is recalled, whatever the sources and triggers say. */
	enabled: boolean;
	/**
	 * Whether recall may inject lessons and moments captured without your confirmation. False: only confirmed items.
	 * Skill drafts are never injected, whatever this says.
	 */
	injectNew: boolean;
	sources: { knowledge: boolean; lessons: boolean; moments: boolean; skills: boolean };
	triggers: {
		scopeChange: boolean;
		failure: boolean;
		phaseBoundary: boolean;
		uncertainty: boolean;
		explicit: boolean;
	};
	/** Minimum gap between automatic recalls for one trigger, in ms. Maximum 86 400 000 (one day). */
	cooldownMs: { scopeChange: number; failure: number; uncertainty: number };
	budget: {
		/** Recall calls per turn. Maximum 10. */
		perTurnCalls: number;
		/** Recalled tokens per turn. Maximum 20 000. */
		perTurnTokens: number;
		/** Recall calls per session. Maximum 200. */
		perSessionCalls: number;
		/** Recalled tokens per session. Maximum 200 000. */
		perSessionTokens: number;
		/** Share of each budget held back for explicit recalls, within [0, 1]. */
		reservedShare: number;
	};
	/** Bounded wait for a synchronous recall, in ms. Maximum 30 000. */
	timeoutMs: number;
	/** Minimum confidence a lesson needs to be injected, within [0, 1]. */
	relevanceFloor: { lessons: number };
}

export interface RecallSettings {
	knowledge: { probeRecord: boolean };
	recall: RecallConfig;
	skills: { authoring: { enabled: boolean; activation: SkillActivation } };
	panels: { informationPanels: boolean };
}

const MAX_COOLDOWN_MS = 86_400_000;
const MAX_TURN_CALLS = 10;
const MAX_TURN_TOKENS = 20_000;
const MAX_SESSION_CALLS = 200;
const MAX_SESSION_TOKENS = 200_000;
const MAX_RECALL_TIMEOUT_MS = 30_000;

export function defaultRecallSettings(): RecallSettings {
	return {
		knowledge: { probeRecord: true },
		recall: {
			enabled: false,
			injectNew: false,
			sources: { knowledge: false, lessons: false, moments: false, skills: false },
			triggers: {
				scopeChange: false,
				failure: false,
				phaseBoundary: false,
				uncertainty: false,
				explicit: false,
			},
			cooldownMs: { scopeChange: 300_000, failure: 300_000, uncertainty: 60_000 },
			budget: {
				perTurnCalls: 2,
				perTurnTokens: 1_500,
				perSessionCalls: 20,
				perSessionTokens: 8_000,
				reservedShare: 0.3,
			},
			timeoutMs: 2_500,
			relevanceFloor: { lessons: 0.5 },
		},
		skills: { authoring: { enabled: false, activation: "draft" } },
		panels: { informationPanels: false },
	};
}

/** A plain object as a record; anything else (absent, array, scalar) is an empty record, so every field falls back. */
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function flag(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

/** A finite number of at least 1, floored to a whole count or millisecond and clamped to `max`; anything else falls back. */
function bounded(value: unknown, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const whole = Math.floor(value);
	return whole >= 1 ? Math.min(whole, max) : fallback;
}

/**
 * Reads the recall settings from one config file's root object (`knowledge`, `recall`, `skills`, `panels`). Each field
 * that is absent or invalid keeps its value in `base`, which defaults to `defaultRecallSettings()`. Never throws.
 */
export function parseRecallSettings(
	file: unknown,
	base: RecallSettings = defaultRecallSettings(),
): RecallSettings {
	const root = record(file);
	const knowledge = record(root.knowledge);
	const recall = record(root.recall);
	const sources = record(recall.sources);
	const triggers = record(recall.triggers);
	const cooldownMs = record(recall.cooldownMs);
	const budget = record(recall.budget);
	const relevanceFloor = record(recall.relevanceFloor);
	const authoring = record(record(root.skills).authoring);
	const panels = record(root.panels);
	const b = base.recall;
	return {
		knowledge: { probeRecord: flag(knowledge.probeRecord, base.knowledge.probeRecord) },
		recall: {
			enabled: flag(recall.enabled, b.enabled),
			injectNew: flag(recall.injectNew, b.injectNew),
			sources: {
				knowledge: flag(sources.knowledge, b.sources.knowledge),
				lessons: flag(sources.lessons, b.sources.lessons),
				moments: flag(sources.moments, b.sources.moments),
				skills: flag(sources.skills, b.sources.skills),
			},
			triggers: {
				scopeChange: flag(triggers.scopeChange, b.triggers.scopeChange),
				failure: flag(triggers.failure, b.triggers.failure),
				phaseBoundary: flag(triggers.phaseBoundary, b.triggers.phaseBoundary),
				uncertainty: flag(triggers.uncertainty, b.triggers.uncertainty),
				explicit: flag(triggers.explicit, b.triggers.explicit),
			},
			cooldownMs: {
				scopeChange: bounded(cooldownMs.scopeChange, MAX_COOLDOWN_MS, b.cooldownMs.scopeChange),
				failure: bounded(cooldownMs.failure, MAX_COOLDOWN_MS, b.cooldownMs.failure),
				uncertainty: bounded(cooldownMs.uncertainty, MAX_COOLDOWN_MS, b.cooldownMs.uncertainty),
			},
			budget: {
				perTurnCalls: bounded(budget.perTurnCalls, MAX_TURN_CALLS, b.budget.perTurnCalls),
				perTurnTokens: bounded(budget.perTurnTokens, MAX_TURN_TOKENS, b.budget.perTurnTokens),
				perSessionCalls: bounded(
					budget.perSessionCalls,
					MAX_SESSION_CALLS,
					b.budget.perSessionCalls,
				),
				perSessionTokens: bounded(
					budget.perSessionTokens,
					MAX_SESSION_TOKENS,
					b.budget.perSessionTokens,
				),
				// A finite share in [0, 1]; a value just outside the range falls back rather than clamping.
				reservedShare:
					typeof budget.reservedShare === "number" &&
					Number.isFinite(budget.reservedShare) &&
					budget.reservedShare >= 0 &&
					budget.reservedShare <= 1
						? budget.reservedShare
						: b.budget.reservedShare,
			},
			timeoutMs: bounded(recall.timeoutMs, MAX_RECALL_TIMEOUT_MS, b.timeoutMs),
			relevanceFloor: {
				// A finite confidence in [0, 1]; a value just outside the range falls back rather than clamping.
				lessons:
					typeof relevanceFloor.lessons === "number" &&
					Number.isFinite(relevanceFloor.lessons) &&
					relevanceFloor.lessons >= 0 &&
					relevanceFloor.lessons <= 1
						? relevanceFloor.lessons
						: b.relevanceFloor.lessons,
			},
		},
		skills: {
			authoring: {
				enabled: flag(authoring.enabled, base.skills.authoring.enabled),
				activation:
					authoring.activation === "draft" || authoring.activation === "active"
						? authoring.activation
						: base.skills.authoring.activation,
			},
		},
		panels: { informationPanels: flag(panels.informationPanels, base.panels.informationPanels) },
	};
}
