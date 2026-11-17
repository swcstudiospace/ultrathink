// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { Checkpoint, CheckpointReason, PhaseLoopStore } from "./phase-loop-store.ts";

/** Canonical GSD phase order. Recorded order is only a prefix of this list. */
const PHASE_ORDER = ["Discuss", "Plan", "Execute", "Verify", "Ship"] as const;

export type PhaseName = (typeof PHASE_ORDER)[number];

/** Reports whether a runtime is connected. Injected by the caller; this module reads no inventory. */
export type RuntimeConnectedCheck = (runtimeId: string) => boolean;

export interface PhaseAttemptInput {
	phase: PhaseName;
	completeUpliftCount: number;
	unansweredBlockingClarifications: number;
}

export interface ShipConfirmationInput {
	afterVerify: boolean;
	/** The audit or validation record the close presents. Its result must be "pass". */
	audit?: AuditRecord;
	/** The id the close cites. The audit passes only when audit.id equals it. */
	auditId?: string;
	/** Owner decision that closes the phase without a passing audit. */
	override?: OverrideDecision;
}

/** A recorded audit or validation result. The close cites it by id (LIFE-02). */
export interface AuditRecord {
	id: string;
	kind: "audit" | "validation";
	result: "pass" | "fail";
	recordedAt: string;
}

/** A recorded owner decision that closes a phase without a passing audit (LIFE-02). */
export interface OverrideDecision {
	decisionId: string;
	owner: string;
	decidedAt: string;
	reason: string;
}

/** A human-verification or owner-gated item (LIFE-05). An open entry blocks close. */
export interface HtilEntry {
	id: string;
	owner: string;
	state: "open" | "done" | "deferred";
	evidenceId?: string;
	decisionId?: string;
}

/** How an open HTIL entry leaves the open set. Each resolution needs its record. */
export type HtilResolution =
	| { state: "done"; evidenceId: string }
	| { state: "deferred"; decisionId: string };

/** Outcome of a gated call. A refusal names every reason and changes nothing. */
export interface GateOutcome {
	accepted: boolean;
	state: PhaseLoopState;
	refusals: readonly string[];
}

/** Outcome of confirmShip: accepted, or refused with each reason named. */
export type ShipConfirmation = GateOutcome;

export interface ClosedBy {
	kind: "audit" | "validation" | "override";
	/** The audit or validation id, or the override's decision id. */
	recordId: string;
	recordedAt: string;
}

export interface PhaseLoopState {
	runtimeId: string;
	phaseOrder: PhaseName[];
	executeStarts: number;
	shipStarts: number;
	operatorConfirmations: number;
	humanItems: HtilEntry[];
	/** The record the accepted close cites (LIFE-02). Absent until a close is accepted. */
	closedBy?: ClosedBy;
}

/** Result of a resume (LIFE-04): what was restored, and whether an unreadable record was set aside. */
export interface RestoreReport {
	restored: boolean;
	quarantined: boolean;
	/** Location of the moved-aside copy, when quarantined. */
	quarantinedAs?: string;
	state: PhaseLoopState;
	/** Reason and time of the checkpoint the stored record holds, when one exists. */
	checkpoint?: Checkpoint;
}

/**
 * Thrown by attemptPhase, confirmShip, open, resolve, and checkpointPhaseLoop when the stored
 * record is quarantined. Nothing is written and the quarantined copy stays where it is.
 * restorePhaseLoop does not throw; it reports `quarantined` instead.
 */
export class PhaseLoopCorruptError extends Error {
	readonly runtimeId: string;
	readonly quarantinedAs: string;

	constructor(runtimeId: string, quarantinedAs: string) {
		super(`phase loop record for ${runtimeId} is corrupt; quarantined at ${quarantinedAs}`);
		this.name = "PhaseLoopCorruptError";
		this.runtimeId = runtimeId;
		this.quarantinedAs = quarantinedAs;
	}
}

/**
 * Per-process phase state keyed by runtime id, used when a call passes no store. Nothing here
 * is persisted. resetPhaseLoopStateForTests clears it between tests.
 */
const loops = new Map<string, PhaseLoopState>();

function emptyState(runtimeId: string): PhaseLoopState {
	return {
		runtimeId,
		phaseOrder: [],
		executeStarts: 0,
		shipStarts: 0,
		operatorConfirmations: 0,
		humanItems: [],
	};
}

function rowFor(runtimeId: string): PhaseLoopState {
	let row = loops.get(runtimeId);
	if (!row) {
		row = emptyState(runtimeId);
		loops.set(runtimeId, row);
	}
	return row;
}

/**
 * Copies the state fields only. Callers cannot mutate a row or a store's copy, and a checkpoint
 * is never carried into a transition.
 */
function snapshot(row: PhaseLoopState): PhaseLoopState {
	return {
		runtimeId: row.runtimeId,
		phaseOrder: [...row.phaseOrder],
		executeStarts: row.executeStarts,
		shipStarts: row.shipStarts,
		operatorConfirmations: row.operatorConfirmations,
		humanItems: row.humanItems.map((item) => ({ ...item })),
		...(row.closedBy === undefined ? {} : { closedBy: { ...row.closedBy } }),
	};
}

/** Applies one attempt to row in place. Returns the refusal reasons; none means it was applied. */
function applyAttempt(
	runtimeId: string,
	row: PhaseLoopState,
	input: PhaseAttemptInput,
	isConnected: RuntimeConnectedCheck,
): readonly string[] {
	if (!isConnected(runtimeId)) return ["runtime is not connected"];
	if (input.phase === "Ship") return ["Ship starts only through confirmShip"];
	if (input.phase !== PHASE_ORDER[row.phaseOrder.length]) {
		return [`${input.phase} is not the next phase`];
	}
	if (input.phase === "Execute") {
		const gatesMet = input.completeUpliftCount >= 1 && input.unansweredBlockingClarifications === 0;
		if (!gatesMet) return ["Execute gates are unmet"];
	}
	row.phaseOrder.push(input.phase);
	if (input.phase === "Execute") row.executeStarts += 1;
	return [];
}

function isBlank(value: string | undefined): boolean {
	return value === undefined || value.trim() === "";
}

/** A complete override has every field set. */
function overrideComplete(override: OverrideDecision): boolean {
	return ![override.decisionId, override.owner, override.decidedAt, override.reason].some(isBlank);
}

/**
 * LIFE-02: the record a close is recorded against: a passing audit whose id the call cites, or a
 * complete owner override. Undefined when neither holds.
 */
function closeRecord(input: ShipConfirmationInput): ClosedBy | undefined {
	const { audit, auditId, override } = input;
	if (audit !== undefined && audit.result === "pass" && audit.id === auditId) {
		return { kind: audit.kind, recordId: audit.id, recordedAt: audit.recordedAt };
	}
	if (override !== undefined && overrideComplete(override)) {
		return { kind: "override", recordId: override.decisionId, recordedAt: override.decidedAt };
	}
	return undefined;
}

/** The reasons a close with no record is refused. Call only when closeRecord is undefined. */
function closeRefusals(input: ShipConfirmationInput): string[] {
	const { audit, auditId, override } = input;
	const refusals = ["no passing audit or override"];
	if (audit !== undefined && audit.id !== auditId) {
		refusals.push(`audit ${audit.id} does not match cited ${auditId ?? "(none)"}`);
	} else if (audit !== undefined && audit.result !== "pass") {
		refusals.push(`audit ${audit.id} did not pass`);
	}
	if (override !== undefined) refusals.push("override is missing an owner decision field");
	return refusals;
}

/**
 * Checks every gate of the close and collects each failing reason. The confirmation is applied
 * to row in place only when none fails. Returns the reasons; none means it was applied.
 */
function applyShipConfirmation(
	runtimeId: string,
	row: PhaseLoopState,
	input: ShipConfirmationInput,
	isConnected: RuntimeConnectedCheck,
): readonly string[] {
	const refusals: string[] = [];
	if (!input.afterVerify) refusals.push("confirmation is not after Verify");
	if (row.phaseOrder[row.phaseOrder.length - 1] !== "Verify") {
		refusals.push("Verify is not the last recorded phase");
	}
	if (!isConnected(runtimeId)) refusals.push("runtime is not connected");
	const closedBy = closeRecord(input);
	if (closedBy === undefined) refusals.push(...closeRefusals(input));
	for (const item of row.humanItems) {
		if (item.state === "open") refusals.push(`open HTIL entry ${item.id}`);
	}
	if (closedBy === undefined || refusals.length > 0) return refusals;
	row.phaseOrder.push("Ship");
	row.shipStarts = 1;
	row.operatorConfirmations += 1;
	row.closedBy = closedBy;
	return [];
}

/**
 * Runs one gated transition. `apply` checks every gate, returns the reason for each failing one,
 * and changes the row only when there are none. With no store, the in-memory row is used. With a
 * store, the row is loaded from it and an accepted transition is saved, as one commit, before this
 * returns. The saved record carries no checkpoint, so an accepted transition clears one. A refused
 * transition calls no save. A quarantined record throws PhaseLoopCorruptError before any gate runs,
 * so nothing is written.
 */
function transition(
	runtimeId: string,
	store: PhaseLoopStore | undefined,
	apply: (row: PhaseLoopState) => readonly string[],
): GateOutcome {
	if (!store) {
		const row = rowFor(runtimeId);
		const refusals = apply(row);
		return { accepted: refusals.length === 0, state: snapshot(row), refusals };
	}
	const outcome = store.load(runtimeId);
	if (outcome.status === "quarantined") {
		throw new PhaseLoopCorruptError(runtimeId, outcome.quarantinedAs);
	}
	const row = outcome.status === "found" ? snapshot(outcome.record) : emptyState(runtimeId);
	const refusals = apply(row);
	if (refusals.length === 0) store.save(runtimeId, row);
	return { accepted: refusals.length === 0, state: snapshot(row), refusals };
}

/**
 * Attempt one phase. Order only grows as Discuss, Plan, Execute, Verify.
 * A refused attempt leaves state unchanged and returns the current snapshot.
 * Refused when the runtime is not connected, the phase is not next in order,
 * or Execute's gates are unmet. Execute needs one complete uplift and zero unanswered
 * blocking clarifications. Ship never starts here; only confirmShip starts it.
 * With a store, state is read from it and an accepted attempt is committed to it before
 * return. Without one, the in-memory row is used. A quarantined record throws
 * PhaseLoopCorruptError.
 */
export function attemptPhase(
	runtimeId: string,
	input: PhaseAttemptInput,
	isConnected: RuntimeConnectedCheck,
	store?: PhaseLoopStore,
): PhaseLoopState {
	return transition(runtimeId, store, (row) => applyAttempt(runtimeId, row, input, isConnected))
		.state;
}

/**
 * Record the one operator confirmation, which closes the phase. Ship starts only when that
 * confirmation follows a recorded Verify on a connected runtime, cites a passing audit by id or
 * carries a complete owner override (LIFE-02), and leaves no HTIL entry open (LIFE-05). An
 * accepted close records that audit or override in `closedBy` in the same save. A refused
 * confirmation names each reason in `refusals`. A second confirmation after Ship is refused.
 * With a store, state is read from it and an accepted confirmation is committed before return.
 * A quarantined record throws PhaseLoopCorruptError.
 */
export function confirmShip(
	runtimeId: string,
	input: ShipConfirmationInput,
	isConnected: RuntimeConnectedCheck,
	store?: PhaseLoopStore,
): ShipConfirmation {
	return transition(runtimeId, store, (row) =>
		applyShipConfirmation(runtimeId, row, input, isConnected),
	);
}

/**
 * Record an open HTIL entry (LIFE-05). The entry starts in state open and blocks close until it
 * is resolved. A missing id or owner, or a duplicate id, is refused.
 */
export function open(
	runtimeId: string,
	entry: Pick<HtilEntry, "id" | "owner">,
	store?: PhaseLoopStore,
): GateOutcome {
	return transition(runtimeId, store, (row) => {
		const refusals: string[] = [];
		if (isBlank(entry.id)) refusals.push("HTIL entry needs an id");
		if (isBlank(entry.owner)) refusals.push(`HTIL entry ${entry.id} needs an owner`);
		if (row.humanItems.some((item) => item.id === entry.id)) {
			refusals.push(`HTIL entry ${entry.id} already exists`);
		}
		if (refusals.length > 0) return refusals;
		row.humanItems.push({ id: entry.id, owner: entry.owner, state: "open" });
		return [];
	});
}

/**
 * Resolve an open HTIL entry (LIFE-05). `done` needs the evidence it was resolved by; `deferred`
 * needs the recorded owner decision that defers it. A missing record is refused and the entry
 * stays open.
 */
export function resolve(
	runtimeId: string,
	entryId: string,
	resolution: HtilResolution,
	store?: PhaseLoopStore,
): GateOutcome {
	return transition(runtimeId, store, (row) => {
		const entry = row.humanItems.find((item) => item.id === entryId);
		if (entry === undefined) return [`HTIL entry ${entryId} does not exist`];
		if (entry.state !== "open") return [`HTIL entry ${entryId} is already ${entry.state}`];
		if (resolution.state === "done") {
			if (isBlank(resolution.evidenceId)) return [`done HTIL entry ${entryId} needs evidenceId`];
			entry.state = "done";
			entry.evidenceId = resolution.evidenceId;
			return [];
		}
		if (isBlank(resolution.decisionId)) return [`deferred HTIL entry ${entryId} needs decisionId`];
		entry.state = "deferred";
		entry.decisionId = resolution.decisionId;
		return [];
	});
}

/**
 * Pause or catchable kill (LIFE-04): saves the current state with a checkpoint naming the reason
 * and the caller's time. With no readable record, the empty state is checkpointed. A quarantined
 * record throws PhaseLoopCorruptError: a checkpoint written over it would start from empty and
 * clear the quarantine.
 */
export function checkpointPhaseLoop(
	store: PhaseLoopStore,
	runtimeId: string,
	reason: CheckpointReason,
	now: string,
): void {
	const outcome = store.load(runtimeId);
	if (outcome.status === "quarantined") {
		throw new PhaseLoopCorruptError(runtimeId, outcome.quarantinedAs);
	}
	const row = outcome.status === "found" ? snapshot(outcome.record) : emptyState(runtimeId);
	store.save(runtimeId, { ...row, checkpoint: { reason, at: now } });
}

/**
 * Resume (LIFE-04): return the latest stored state for the runtime, with its checkpoint when one
 * exists. `restored` is false when no readable record exists; `state` is then the empty state a
 * new loop starts from. An unreadable record is set aside and reported as `quarantined`. This
 * never throws for a quarantined record.
 */
export function restorePhaseLoop(store: PhaseLoopStore, runtimeId: string): RestoreReport {
	const outcome = store.load(runtimeId);
	if (outcome.status === "found") {
		return {
			restored: true,
			quarantined: false,
			state: snapshot(outcome.record),
			checkpoint: outcome.record.checkpoint,
		};
	}
	if (outcome.status === "quarantined") {
		return {
			restored: false,
			quarantined: true,
			quarantinedAs: outcome.quarantinedAs,
			state: emptyState(runtimeId),
		};
	}
	return { restored: false, quarantined: false, state: emptyState(runtimeId) };
}

/** Test-only: clears the per-process phase state. */
export function resetPhaseLoopStateForTests(): void {
	loops.clear();
}
