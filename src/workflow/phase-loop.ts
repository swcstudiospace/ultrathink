// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

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

/**
 * Per-process phase state keyed by runtime id. Nothing is persisted, so a new process starts empty.
 * resetPhaseLoopStateForTests clears it between tests.
 */
const loops = new Map<string, PhaseLoopState>();

function rowFor(runtimeId: string): PhaseLoopState {
	let row = loops.get(runtimeId);
	if (!row) {
		row = {
			runtimeId,
			phaseOrder: [],
			executeStarts: 0,
			shipStarts: 0,
			operatorConfirmations: 0,
		};
		loops.set(runtimeId, row);
	}
	return row;
}

/** Copy so callers cannot mutate the in-memory row. */
function snapshot(row: PhaseLoopState): PhaseLoopState {
	return { ...row, phaseOrder: [...row.phaseOrder] };
}

/**
 * Attempt one phase. Order only grows as Discuss, Plan, Execute, Verify.
 * A refused attempt leaves state unchanged and returns the current snapshot.
 * Refused when the runtime is not connected, the phase is not next in order,
 * or Execute's gates are unmet. Execute needs one complete uplift and zero unanswered
 * blocking clarifications. Ship never starts here; only confirmShip starts it.
 */
export function attemptPhase(
	runtimeId: string,
	input: PhaseAttemptInput,
	isConnected: RuntimeConnectedCheck,
): PhaseLoopState {
	const row = rowFor(runtimeId);
	if (!isConnected(runtimeId)) return snapshot(row);
	if (input.phase === "Ship") return snapshot(row);
	if (input.phase !== PHASE_ORDER[row.phaseOrder.length]) return snapshot(row);
	if (input.phase === "Execute") {
		const gatesMet = input.completeUpliftCount >= 1 && input.unansweredBlockingClarifications === 0;
		if (!gatesMet) return snapshot(row);
	}
	row.phaseOrder.push(input.phase);
	if (input.phase === "Execute") row.executeStarts += 1;
	return snapshot(row);
}

/**
 * Record the one operator confirmation. Ship starts only when that confirmation
 * follows a recorded Verify on a connected runtime. A confirmation that is not after Verify
 * does not start Ship, and a second confirmation after Ship does not start it again.
 */
export function confirmShip(
	runtimeId: string,
	input: ShipConfirmationInput,
	isConnected: RuntimeConnectedCheck,
): PhaseLoopState {
	const row = rowFor(runtimeId);
	if (!input.afterVerify) return snapshot(row);
	if (row.phaseOrder[row.phaseOrder.length - 1] !== "Verify") return snapshot(row);
	if (!isConnected(runtimeId)) return snapshot(row);
	row.phaseOrder.push("Ship");
	row.shipStarts = 1;
	row.operatorConfirmations += 1;
	return snapshot(row);
}

/** Test-only: clears the per-process phase state. */
export function resetPhaseLoopStateForTests(): void {
	loops.clear();
}
