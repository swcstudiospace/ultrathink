// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { HtilEntry, PhaseLoopStatus } from "./phase-loop.ts";

/**
 * Run-level orchestration states for harness/Substrate steering (SPE-40093 n3).
 * The first nine are the nominal run progression; FAILED, BLOCKED and DONE are
 * terminal. This module adapts the phase-loop FSM for display and steering only:
 * it persists nothing and changes no existing behavior.
 */
export const ORCHESTRATION_ORDER = [
	"IDLE",
	"DISCOVERING",
	"ISSUE_PROGRAMMING",
	"DISCUSSING",
	"PLANNING",
	"EXECUTING",
	"VERIFYING",
	"MERGING",
	"AUDITING",
	"FAILED",
	"BLOCKED",
	"DONE",
] as const;

export type OrchestrationState = (typeof ORCHESTRATION_ORDER)[number];

export type TerminalOrchestrationState = "FAILED" | "BLOCKED" | "DONE";

/** Reports whether a run-level state is terminal (no further transitions expected). */
export function isTerminalOrchestrationState(
	state: OrchestrationState,
): state is TerminalOrchestrationState {
	return state === "FAILED" || state === "BLOCKED" || state === "DONE";
}

/** Severity of a human-verification item; mirrors the phase-loop SLA driver. Local so this module imports types only. */
type HtilSeverity = "critical" | "high" | "normal";

/** Max lines listed per section so the rendering stays bounded. */
const MAX_LISTED_OVERDUE = 20;
const MAX_LISTED_DECISIONS = 20;
/** Hard cap on the rendered status text. */
const MAX_PLAIN_CHARS = 8000;

/**
 * Bounded plain-text rendering of a phase-loop status for harness/Substrate
 * steering. Emits ids, counts, timestamps and booleans only: never
 * reason/evidence text, never refusal strings, never file paths, never secrets.
 * Owners appear only as the ids already present on the status.
 */
export function formatPhaseStatusPlain(status: PhaseLoopStatus): string {
	const lines: string[] = [];
	lines.push(`lifecycle ${status.lifecycle}`);
	lines.push(
		`completed ${status.completedStages.length === 0 ? "none" : status.completedStages.join(",")}`,
	);
	lines.push(`next ${status.nextEvents.length === 0 ? "none" : status.nextEvents.join(",")}`);
	lines.push(
		status.blocker === undefined
			? "blocker none"
			: `blocker ${status.blocker.id} owner=${status.blocker.owner}`,
	);
	lines.push(
		`attempts execute=${status.attempts.execute} ship=${status.attempts.ship} ` +
			`confirmations=${status.attempts.operatorConfirmations}`,
	);
	lines.push(
		`transitions attempts=${status.transitionMetrics.attempts} ` +
			`accepted=${status.transitionMetrics.accepted} refused=${status.transitionMetrics.refused}`,
	);
	const last = status.recentTransitions.at(-1);
	lines.push(
		last === undefined
			? "last none"
			: `last ${last.event} ${last.from}->${last.to} accepted=${last.accepted} at=${last.at}`,
	);
	if (status.closedBy !== undefined) {
		lines.push(
			`closedBy ${status.closedBy.kind} ${status.closedBy.recordId} at=${status.closedBy.recordedAt}`,
		);
	}
	const overdue = status.signals.overdue ?? [];
	lines.push(`overdue ${overdue.length}`);
	for (const item of overdue.slice(0, MAX_LISTED_OVERDUE)) {
		lines.push(
			`overdue ${item.entryId} owner=${item.owner} severity=${item.severity} dueAt=${item.dueAt}`,
		);
	}
	if (overdue.length > MAX_LISTED_OVERDUE) {
		lines.push(`overdue +${overdue.length - MAX_LISTED_OVERDUE} more`);
	}
	const decisions = status.signals.decisions ?? [];
	lines.push(`decisions ${decisions.length}`);
	for (const decision of decisions.slice(0, MAX_LISTED_DECISIONS)) {
		// Derived internally from the refusal set; the refusal text itself is never emitted.
		const expired = decision.refusals.some((refusal) => refusal.includes("expired"));
		const expires = decision.expiresAt === undefined ? "" : ` expiresAt=${decision.expiresAt}`;
		lines.push(
			`decision ${decision.decisionId} live=${decision.live} ` +
				`quorum=${decision.quorumHave}/${decision.quorumRequired} ` +
				`expired=${expired} revoked=${decision.revoked}${expires}`,
		);
	}
	if (decisions.length > MAX_LISTED_DECISIONS) {
		lines.push(`decisions +${decisions.length - MAX_LISTED_DECISIONS} more`);
	}
	const out = lines.join("\n");
	return out.length > MAX_PLAIN_CHARS ? out.slice(0, MAX_PLAIN_CHARS) : out;
}

/** SLA hours per severity; mirrors the phase-loop HTIL SLA. Local so this module imports types only. */
const HTIL_SLA_HOURS: Record<HtilSeverity, number> = { critical: 4, high: 24, normal: 72 };
const MS_PER_HOUR = 60 * 60 * 1000;

type HtilAllowedAction = "resolve-done" | "resolve-deferred" | "escalate";

/** Decision-ready plain-data packet for one HTIL entry. Ids and timestamps only; no reason/evidence text. */
export interface HtilHitlPayload {
	entryId: string;
	owner: string;
	severity: HtilSeverity;
	state: "open" | "done" | "deferred";
	createdAt: string | undefined;
	dueAt: string | undefined;
	/** Milliseconds from `now` to the deadline; negative when overdue, NaN when no deadline is computable. */
	slaMsRemaining: number;
	escalationCount: number;
	escalatedTo: string | undefined;
	allowedActions: HtilAllowedAction[];
}

/**
 * Builds the decision-ready packet for one HTIL entry at `now` (ISO 8601).
 * `dueAt` is the entry's own deadline when present, else `createdAt` plus the
 * severity SLA (critical 4h, high 24h, normal 72h). Open entries offer all three
 * actions; closed entries offer none.
 */
export function htilHITLPayload(entry: HtilEntry, now: string): HtilHitlPayload {
	const severity: HtilSeverity = entry.severity ?? "normal";
	const createdMs = entry.createdAt === undefined ? Number.NaN : Date.parse(entry.createdAt);
	const derivedDueAt =
		entry.dueAt ??
		(entry.createdAt !== undefined && Number.isFinite(createdMs)
			? new Date(createdMs + HTIL_SLA_HOURS[severity] * MS_PER_HOUR).toISOString()
			: undefined);
	const nowMs = Date.parse(now);
	const dueMs = derivedDueAt === undefined ? Number.NaN : Date.parse(derivedDueAt);
	const slaMsRemaining =
		Number.isFinite(nowMs) && Number.isFinite(dueMs) ? dueMs - nowMs : Number.NaN;
	return {
		entryId: entry.id,
		owner: entry.owner,
		severity,
		state: entry.state,
		createdAt: entry.createdAt,
		dueAt: derivedDueAt,
		slaMsRemaining,
		escalationCount: entry.escalationCount ?? 0,
		escalatedTo: entry.escalatedTo,
		allowedActions: entry.state === "open" ? ["resolve-done", "resolve-deferred", "escalate"] : [],
	};
}

/** Hard cap on the one-line run summary. */
const MAX_SUMMARY_CHARS = 200;

/**
 * One-line `state[: detail]` renderer for run-level state. The detail is
 * flattened to a single line and the whole summary is capped at 200 chars.
 */
export function orchestrationSummary(state: OrchestrationState, detail?: string): string {
	const clean = (detail ?? "").replace(/\s+/g, " ").trim();
	const out = clean === "" ? state : `${state}: ${clean}`;
	return out.length > MAX_SUMMARY_CHARS ? out.slice(0, MAX_SUMMARY_CHARS) : out;
}
