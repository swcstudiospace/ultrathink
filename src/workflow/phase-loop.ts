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
}

export interface PhaseLoopState {
	runtimeId: string;
	phaseOrder: PhaseName[];
	executeStarts: number;
	shipStarts: number;
	operatorConfirmations: number;
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
 * Thrown by attemptPhase, confirmShip, and checkpointPhaseLoop when the stored record is
 * quarantined. Nothing is written and the quarantined copy stays where it is. restorePhaseLoop
 * does not throw; it reports `quarantined` instead.
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
	};
}

/** Applies one attempt to row in place and reports whether it changed. */
function applyAttempt(
	runtimeId: string,
	row: PhaseLoopState,
	input: PhaseAttemptInput,
	isConnected: RuntimeConnectedCheck,
): boolean {
	if (!isConnected(runtimeId)) return false;
	if (input.phase === "Ship") return false;
	if (input.phase !== PHASE_ORDER[row.phaseOrder.length]) return false;
	if (input.phase === "Execute") {
		const gatesMet = input.completeUpliftCount >= 1 && input.unansweredBlockingClarifications === 0;
		if (!gatesMet) return false;
	}
	row.phaseOrder.push(input.phase);
	if (input.phase === "Execute") row.executeStarts += 1;
	return true;
}

/** Applies one operator confirmation to row in place and reports whether it changed. */
function applyShipConfirmation(
	runtimeId: string,
	row: PhaseLoopState,
	input: ShipConfirmationInput,
	isConnected: RuntimeConnectedCheck,
): boolean {
	if (!input.afterVerify) return false;
	if (row.phaseOrder[row.phaseOrder.length - 1] !== "Verify") return false;
	if (!isConnected(runtimeId)) return false;
	row.phaseOrder.push("Ship");
	row.shipStarts = 1;
	row.operatorConfirmations += 1;
	return true;
}

/**
 * Runs one transition. With no store, the in-memory row is used. With a store, the row is
 * loaded from it and an accepted transition is saved, as one commit, before this returns. The
 * saved record carries no checkpoint, so an accepted transition clears one. A refused
 * transition calls no save. A quarantined record throws PhaseLoopCorruptError before any gate
 * runs, so nothing is written.
 */
function transition(
	runtimeId: string,
	store: PhaseLoopStore | undefined,
	apply: (row: PhaseLoopState) => boolean,
): PhaseLoopState {
	if (!store) {
		const row = rowFor(runtimeId);
		apply(row);
		return snapshot(row);
	}
	const outcome = store.load(runtimeId);
	if (outcome.status === "quarantined") {
		throw new PhaseLoopCorruptError(runtimeId, outcome.quarantinedAs);
	}
	const row = outcome.status === "found" ? snapshot(outcome.record) : emptyState(runtimeId);
	if (apply(row)) store.save(runtimeId, row);
	return snapshot(row);
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
	return transition(runtimeId, store, (row) => applyAttempt(runtimeId, row, input, isConnected));
}

/**
 * Record the one operator confirmation. Ship starts only when that confirmation
 * follows a recorded Verify on a connected runtime. A confirmation that is not after Verify
 * does not start Ship, and a second confirmation after Ship does not start it again.
 * With a store, state is read from it and an accepted confirmation is committed before return.
 * A quarantined record throws PhaseLoopCorruptError.
 */
export function confirmShip(
	runtimeId: string,
	input: ShipConfirmationInput,
	isConnected: RuntimeConnectedCheck,
	store?: PhaseLoopStore,
): PhaseLoopState {
	return transition(runtimeId, store, (row) =>
		applyShipConfirmation(runtimeId, row, input, isConnected),
	);
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
