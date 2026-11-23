// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * In-phase playbook dispatcher for gsd-autonomous (contract operationId
 * `dispatchPhasePlaybook`, contracts/pstack-dispatch.openapi.json@1.3.0).
 *
 * One wave unit per call: it checks the phase PLAN gate (no dispatch before a
 * plan exists), routes the phase type via `PLAYBOOK_ROUTES` (through the
 * shared fleet resolver in `./outcome.ts` + `./subagents.ts` — no second
 * resolver), applies the fail-open/fail-closed rule, and returns one
 * {@link PhaseDispatchRecord} provenance record. Actual `Task` spawning stays
 * with the workflow; this module only decides whether a unit may run and
 * records why. Never throws.
 */
import { playbookForStage, type SubagentFleet } from "./subagents.ts";
import {
	fleetStageFor,
	redactReason,
	resolveFleetOutcome,
	resolveStrictFlag,
	type DispatchUnit,
	type DispatchUnitOutcome,
	type FleetFallback,
	type FleetState,
	type PhaseDispatchRecord,
	type PhaseType,
} from "./outcome.ts";

/** Record factory for a unit that must not run: the reason doubles as the unit detail. */
function blockedRecord(input: {
	phaseType: PhaseType;
	playbook: string;
	state: FleetState;
	fallback: FleetFallback;
	strict: boolean;
	reason: string;
	unit: string;
	detail: string;
	correlationId?: string;
	taskId?: string;
	summaryLine?: string;
	createdAt?: string;
}): PhaseDispatchRecord {
	const reason = redactReason(input.reason);
	const units: DispatchUnit[] = [
		{ unit: input.unit, outcome: "blocked", detail: redactReason(input.detail) },
	];
	return {
		phaseType: input.phaseType,
		playbook: input.playbook,
		state: input.state,
		fallback: input.fallback,
		strict: input.strict,
		reason,
		units,
		summaryLine: input.summaryLine,
		correlationId: input.correlationId,
		taskId: input.taskId,
		createdAt: input.createdAt,
	};
}

/**
 * Phase summary line in the data-contract shape
 * (`summaryLineFormat`): `phase=<type> playbook=<playbook> fleet=<token>
 * outcome=<landed|vanilla|blocked> units=<landed>/<total> fallback=<token>`.
 */
function summaryLineFor(input: {
	phaseType: PhaseType;
	playbook: string;
	fleetToken: string;
	outcomeWord: string;
	landed: number;
	total: number;
	fallback: string;
}): string {
	return (
		`phase=${input.phaseType} playbook=${input.playbook} ` +
		`fleet=${input.fleetToken} outcome=${input.outcomeWord} ` +
		`units=${input.landed}/${input.total} fallback=${input.fallback}`
	);
}

/**
 * Dispatches one wave unit to the routed playbook. Gates, in order:
 * 1. No phase PLAN context (blank `planContext`) → `blocked`, 0 units run,
 *    regardless of the fleet (AC-46).
 * 2. Fleet unresolvable/disabled/forced-off → fail-open: the unit runs vanilla
 *    (recorded, never a stop); strict: the phase stops `blocked` with the
 *    named reason and 0 vanilla units run (AC-44/AC-45).
 * 3. Routed (or overridden) playbook file absent → the unit stops `blocked`
 *    with the absent path named; 0 improvised steps (AC-48).
 * 4. Otherwise the unit runs under the routed playbook; a red unit
 *    (`unitOutcome: "failed"`) is recorded and the phase does not advance
 *    (`shouldAdvancePhase` returns false, AC-50).
 */
export function dispatchPhasePlaybook(input: {
	phaseType: PhaseType;
	unit: string;
	planContext?: string;
	playbookOverride?: string;
	enabled: boolean;
	homeDir: string;
	cursorDir?: string;
	mapping?: Partial<Record<PhaseType, readonly string[]>>;
	forcedOff?: boolean;
	strict?: boolean;
	configStrict?: boolean;
	env?: Record<string, string | undefined>;
	argv?: readonly string[];
	rosterCap?: number;
	unitOutcome?: DispatchUnitOutcome;
	correlationId?: string;
	taskId?: string;
	createdAt?: string;
}): PhaseDispatchRecord {
	try {
		const routed = input.playbookOverride ?? playbookForStage(fleetStageFor(input.phaseType));
		const strict = resolveStrictFlag(input);
		if (!input.planContext?.trim()) {
			const detail = "no phase PLAN: 0 subagents spawned";
			return blockedRecord({
				phaseType: input.phaseType,
				playbook: routed,
				state: "blocked",
				fallback: strict ? "blocked" : "vanilla",
				strict,
				reason: detail,
				unit: input.unit,
				detail,
				correlationId: input.correlationId,
				taskId: input.taskId,
				summaryLine: summaryLineFor({
					phaseType: input.phaseType,
					playbook: routed,
					fleetToken: "none",
					outcomeWord: "blocked",
					landed: 0,
					total: 1,
					fallback: strict ? "blocked" : "vanilla",
				}),
				createdAt: input.createdAt,
			});
		}
		const outcome = resolveFleetOutcome({ ...input });
		if (!outcome.ok || !outcome.fleet?.ok) {
			if (strict) {
				const detail = redactReason(outcome.reason);
				return blockedRecord({
					phaseType: input.phaseType,
					playbook: routed,
					state: "blocked",
					fallback: "blocked",
					strict,
					reason: detail,
					unit: input.unit,
					detail,
					correlationId: input.correlationId,
					taskId: input.taskId,
					summaryLine: summaryLineFor({
						phaseType: input.phaseType,
						playbook: routed,
						fleetToken: "blocked",
						outcomeWord: "blocked",
						landed: 0,
						total: 1,
						fallback: "blocked",
					}),
					createdAt: input.createdAt,
				});
			}
			return {
				phaseType: input.phaseType,
				playbook: routed,
				state: outcome.state,
				fallback: outcome.fallback,
				strict,
				reason: redactReason(outcome.reason),
				units: [
					{
						unit: input.unit,
						outcome: "landed",
						detail: redactReason(`vanilla executor (fallback: ${outcome.reason})`),
					},
				],
				summaryLine: summaryLineFor({
					phaseType: input.phaseType,
					playbook: routed,
					fleetToken: "vanilla",
					outcomeWord: "vanilla",
					landed: 1,
					total: 1,
					fallback: outcome.fallback,
				}),
				correlationId: input.correlationId,
				taskId: input.taskId,
				createdAt: input.createdAt,
			};
		}
		const fleet: Extract<SubagentFleet, { ok: true }> = outcome.fleet;
		const title = outcome.playbook ?? routed;
		const route = fleet.playbooks.find((entry) => entry.title === title);
		if (!route) {
			const absent = `playbooks/${title}.md`;
			const reason = `missing playbook ${absent}: 0 improvised steps`;
			return blockedRecord({
				phaseType: input.phaseType,
				playbook: title,
				state: "blocked",
				fallback: strict ? "blocked" : "vanilla",
				strict,
				reason,
				unit: input.unit,
				detail: reason,
				correlationId: input.correlationId,
				taskId: input.taskId,
				summaryLine: summaryLineFor({
					phaseType: input.phaseType,
					playbook: title,
					fleetToken: "blocked",
					outcomeWord: "blocked",
					landed: 0,
					total: 1,
					fallback: strict ? "blocked" : "vanilla",
				}),
				createdAt: input.createdAt,
			});
		}
		const unitOutcome: DispatchUnitOutcome = input.unitOutcome ?? "landed";
		const skillNames = fleet.skills.map((skill) => skill.name).join("+") || "resolved";
		const detail =
			unitOutcome === "failed"
				? redactReason(`red unit under ${route.path}; phase does not advance`)
				: redactReason(`playbook ${route.path}`);
		return {
			phaseType: input.phaseType,
			playbook: title,
			state: "ok",
			fallback: outcome.fallback,
			strict,
			reason: redactReason(outcome.reason),
			units: [{ unit: input.unit, outcome: unitOutcome, detail }],
			summaryLine: summaryLineFor({
				phaseType: input.phaseType,
				playbook: title,
				fleetToken: skillNames,
				outcomeWord: unitOutcome === "failed" ? "failed" : "landed",
				landed: unitOutcome === "landed" ? 1 : 0,
				total: 1,
				fallback: "none",
			}),
			correlationId: input.correlationId,
			taskId: input.taskId,
			createdAt: input.createdAt,
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return blockedRecord({
			phaseType: input.phaseType,
			playbook: input.playbookOverride ?? playbookForStage(fleetStageFor(input.phaseType)),
			state: "blocked",
			fallback: "blocked",
			strict: resolveStrictFlag(input),
			reason: `resolution failed: ${reason}`,
			unit: input.unit,
			detail: `resolution failed: ${reason}`,
			correlationId: input.correlationId,
			taskId: input.taskId,
		});
	}
}

/**
 * A phase advances only when every recorded unit landed (AC-50): a red unit
 * holds the phase no matter the fleet state.
 */
export function shouldAdvancePhase(record: PhaseDispatchRecord): boolean {
	return record.units.length > 0 && record.units.every((unit) => unit.outcome === "landed");
}
