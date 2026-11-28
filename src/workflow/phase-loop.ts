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
	/** Who resolved a done entry, and when (ISO 8601). Set by `resolve` when the caller gives them. */
	resolvedBy?: string;
	resolvedAt?: string;
	/** Set when the merge gate's reconcile opened the entry on a Ship-closed loop. `resolve` may then act on it after Ship. */
	afterShip?: true;
}

/** How an open HTIL entry leaves the open set. Each resolution needs its record. */
export type HtilResolution =
	| { state: "done"; evidenceId: string; resolvedBy?: string; resolvedAt?: string }
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

/** The owner's repair (F5) of a record written before the runtime marker: the owner's reason and the time it was made (ISO 8601). */
export interface RuntimeRepair {
	reason: string;
	at: string;
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
	/** Every audit or validation result recorded for the loop, by id (LIFE-02). Absent until one is recorded. */
	audits?: AuditRecord[];
	/** The owner decisions an accepted close was made on, with their reasons (LIFE-02). Absent until one is accepted. */
	overrides?: OverrideDecision[];
	/** The runtime session an accepted attempt ran under. The close's connection check reads it, so a record without it is refused as not connected. Absent until an attempt is accepted. */
	runtimeSessionId?: string;
	/** The owner's repair that set runtimeSessionId on a record written before the marker: its reason and time. Absent unless a repair ran. */
	runtimeRepair?: RuntimeRepair;
	/** Persisted-schema version. Absent on records written before the version field existed; set to `FSM_SCHEMA_VERSION` by the first accepted transition. */
	schemaVersion?: number;
	/** Structured history of transition attempts (bounded). Absent until a caller passes a timestamp to a transition. */
	transitions?: TransitionRecord[];
	/** When the loop was cleaned up, and by whom. Only set after a closed, audited Ship. */
	cleanedUpAt?: string;
	cleanedUpBy?: string;
}

/** Current persisted-schema version. Records without it are legacy and migrate to this on first accepted transition. */
export const FSM_SCHEMA_VERSION = 1;

/** Harness lifecycle state derived from a recorded loop. `paused` needs the stored checkpoint; `failed` is never derived from state alone — it is the quarantined/corrupt path (`PhaseLoopCorruptError` / restore). */
export type PhaseLifecycle =
	| "ready"
	| "discussing"
	| "planning"
	| "executing"
	| "verifying"
	| "awaiting-decision"
	| "blocked"
	| "paused"
	| "failed"
	| "completed"
	| "cleaned-up";

/** One transition attempt as recorded for audit. Timestamps are caller-supplied, so the pure decision stays I/O- and clock-free. */
interface TransitionRecord {
	/** Caller-supplied ISO 8601 timestamp of the attempt. */
	at: string;
	from: PhaseLifecycle;
	event: string;
	to: PhaseLifecycle;
	accepted: boolean;
	refusals: readonly string[];
}

/** Error kinds that new, throwing APIs distinguish. Existing gated APIs keep returning `GateOutcome` for compatibility. */
export type FsmErrorKind = "rejection" | "guard" | "transient" | "unrecoverable";

/** Structured FSM error naming the lifecycle state, the attempted event and the legal events for that state. */
export class FsmError extends Error {
	readonly kind: FsmErrorKind;
	readonly state: PhaseLifecycle;
	readonly event: string;
	readonly legalEvents: readonly string[];
	override readonly cause?: unknown;

	constructor(
		kind: FsmErrorKind,
		state: PhaseLifecycle,
		event: string,
		legalEvents: readonly string[],
		message: string,
		cause?: unknown,
	) {
		super(message);
		this.name = "FsmError";
		this.kind = kind;
		this.state = state;
		this.event = event;
		this.legalEvents = legalEvents;
		this.cause = cause;
	}
}

/** Operator status of a loop: current state, completed stages, active blocker, attempts and next legal events. */
export interface PhaseLoopStatus {
	lifecycle: PhaseLifecycle;
	completedStages: readonly PhaseName[];
	blocker: { id: string; owner: string } | undefined;
	attempts: { execute: number; ship: number; operatorConfirmations: number };
	nextEvents: readonly string[];
}

/** Options for transition calls that should record a transition. `at` is the caller-supplied timestamp; without it nothing is recorded. */
export interface TransitionOptions {
	at?: string;
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
		...(row.audits === undefined ? {} : { audits: row.audits.map((item) => ({ ...item })) }),
		...(row.overrides === undefined
			? {}
			: { overrides: row.overrides.map((item) => ({ ...item })) }),
		...(row.runtimeSessionId === undefined ? {} : { runtimeSessionId: row.runtimeSessionId }),
		...(row.runtimeRepair === undefined ? {} : { runtimeRepair: { ...row.runtimeRepair } }),
		...(row.schemaVersion === undefined ? {} : { schemaVersion: row.schemaVersion }),
		...(row.transitions === undefined
			? {}
			: { transitions: row.transitions.map((item) => ({ ...item })) }),
		...(row.cleanedUpAt === undefined ? {} : { cleanedUpAt: row.cleanedUpAt }),
		...(row.cleanedUpBy === undefined ? {} : { cleanedUpBy: row.cleanedUpBy }),
	};
}

/** Derives the harness lifecycle state from a recorded loop. `checkpoint` (from the stored record) yields `paused`; `failed` is never derived here — it is the quarantined/corrupt path (`PhaseLoopCorruptError` / restore). */
export function deriveLifecycle(row: PhaseLoopState, checkpoint?: Checkpoint): PhaseLifecycle {
	if (row.cleanedUpAt !== undefined) return "cleaned-up";
	if (isClosed(row)) return "completed";
	if (checkpoint !== undefined) return "paused";
	if (row.humanItems.some((item) => item.state === "open")) return "awaiting-decision";
	const last = row.phaseOrder[row.phaseOrder.length - 1];
	if (last === undefined) return "ready";
	if (last === "Discuss") return "discussing";
	if (last === "Plan") return "planning";
	if (last === "Execute") return "executing";
	if (last === "Verify") {
		const audits = row.audits ?? [];
		if (
			audits.some((audit) => audit.result === "fail") &&
			!audits.some((audit) => audit.result === "pass")
		) {
			return "blocked";
		}
		return "verifying";
	}
	return "blocked";
}

/** Legal FSM events for a lifecycle state. Terminal states accept none. */
export function nextEvents(lifecycle: PhaseLifecycle): readonly string[] {
	switch (lifecycle) {
		case "ready":
			return ["attempt(Discuss)"];
		case "discussing":
			return ["attempt(Plan)"];
		case "planning":
			return ["attempt(Execute)"];
		case "executing":
			return ["attempt(Verify)"];
		case "verifying":
		case "blocked":
			return ["confirmShip", "recordAudit", "open(HTIL)"];
		case "awaiting-decision":
			return ["resolve(HTIL)"];
		case "paused":
			return ["restore"];
		case "completed":
			return ["cleanup"];
		case "failed":
		case "cleaned-up":
			return [];
	}
}

/** Operator status of a loop: current state, completed stages, active blocker, attempt counts and next legal events. */
export function phaseLoopStatus(row: PhaseLoopState, checkpoint?: Checkpoint): PhaseLoopStatus {
	const lifecycle = deriveLifecycle(row, checkpoint);
	const open = row.humanItems.find((item) => item.state === "open");
	return {
		lifecycle,
		completedStages: [...row.phaseOrder],
		blocker: open === undefined ? undefined : { id: open.id, owner: open.owner },
		attempts: {
			execute: row.executeStarts,
			ship: row.shipStarts,
			operatorConfirmations: row.operatorConfirmations,
		},
		nextEvents: nextEvents(lifecycle),
	};
}

/** Max transition records kept: the oldest are dropped, so the log stays bounded. */
const MAX_TRANSITIONS = 50;

/** Appends one transition record, keeping the last MAX_TRANSITIONS. */
function appendTransition(row: PhaseLoopState, record: TransitionRecord): void {
	row.transitions = [...(row.transitions ?? []).slice(-(MAX_TRANSITIONS - 1)), record];
}

/** How many times a store mutation reloads and reapplies after a lost CAS race. */
const CAS_ATTEMPTS = 3;

/** Wraps a raw store failure as a structured transient failure; corrupt records stay `PhaseLoopCorruptError`. */
function transientFailure(row: PhaseLoopState, event: string, error: unknown): FsmError {
	if (error instanceof FsmError && error.kind === "transient") return error;
	const lifecycle = deriveLifecycle(row);
	const detail = error instanceof Error ? error.message : String(error);
	return new FsmError(
		"transient",
		lifecycle,
		event,
		nextEvents(lifecycle),
		`phase transition could not be persisted: ${detail}`,
		error,
	);
}

/**
 * Loads, builds and commits one store mutation. A store with CAS reloads and reapplies when another
 * writer wins the race, so a duplicate event is refused on the fresh row rather than committed twice.
 */
function commitStoreMutation<T>(
	runtimeId: string,
	store: PhaseLoopStore,
	event: string,
	build: (row: PhaseLoopState) => { value: T; shouldCommit: boolean; record?: PhaseLoopRecord },
): T {
	let lastRow: PhaseLoopState | undefined;
	for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
		let expectedDigest: string | undefined;
		try {
			expectedDigest = store.digest?.(runtimeId);
		} catch (error) {
			throw transientFailure(lastRow ?? emptyState(runtimeId), event, error);
		}
		let outcome: LoadOutcome | undefined;
		try {
			outcome = store.load(runtimeId);
		} catch (error) {
			throw transientFailure(lastRow ?? emptyState(runtimeId), event, error);
		}
		if (outcome.status === "quarantined") {
			throw new PhaseLoopCorruptError(runtimeId, outcome.quarantinedAs);
		}
		const row = outcome.status === "found" ? snapshot(outcome.record) : emptyState(runtimeId);
		lastRow = row;
		const built = build(row);
		if (!built.shouldCommit) return built.value;
		let saved: boolean;
		try {
			if (store.saveIfUnchanged) {
				saved = store.saveIfUnchanged(runtimeId, built.record ?? row, expectedDigest);
			} else {
				store.save(runtimeId, built.record ?? row);
				saved = true;
			}
		} catch (error) {
			throw transientFailure(row, event, error);
		}
		if (saved) return built.value;
	}
	const lifecycle = deriveLifecycle(lastRow ?? emptyState(runtimeId));
	throw new FsmError(
		"transient",
		lifecycle,
		event,
		nextEvents(lifecycle),
		`phase transition could not be persisted: record changed ${CAS_ATTEMPTS} times`,
	);
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
	row.runtimeSessionId = runtimeId;
	row.phaseOrder.push(input.phase);
	if (input.phase === "Execute") row.executeStarts += 1;
	return [];
}

function isBlank(value: string | undefined): boolean {
	return value === undefined || value.trim() === "";
}

/** Once Ship is recorded the loop is closed: it takes no further HTIL or audit writes. */
function isClosed(row: PhaseLoopState): boolean {
	return row.phaseOrder[row.phaseOrder.length - 1] === "Ship";
}

/** A complete override has every field set. */
function overrideComplete(override: OverrideDecision): boolean {
	return ![override.decisionId, override.owner, override.decidedAt, override.reason].some(isBlank);
}

/**
 * LIFE-02: the record a close is recorded against: a passing audit whose id the call cites AND that
 * was previously recorded in the loop's audit ledger (recordAudit), exactly as recorded, or a complete
 * owner override. An audit that was never recorded, that was re-recorded as a fail, or whose presented
 * snapshot differs from the recorded one (kind/recordedAt) is missing or stale and never closes.
 * Undefined when neither holds.
 */
function closeRecord(row: PhaseLoopState, input: ShipConfirmationInput): ClosedBy | undefined {
	const { audit, auditId, override } = input;
	if (audit !== undefined && audit.result === "pass" && audit.id === auditId) {
		const stored = row.audits?.find((item) => item.id === audit.id);
		if (
			stored !== undefined &&
			stored.result === "pass" &&
			stored.kind === audit.kind &&
			stored.recordedAt === audit.recordedAt
		) {
			return { kind: stored.kind, recordId: stored.id, recordedAt: stored.recordedAt };
		}
	}
	if (override !== undefined && overrideComplete(override)) {
		return { kind: "override", recordId: override.decisionId, recordedAt: override.decidedAt };
	}
	return undefined;
}

/** The reasons a close with no record is refused. Call only when closeRecord is undefined. */
function closeRefusals(row: PhaseLoopState, input: ShipConfirmationInput): string[] {
	const { audit, auditId, override } = input;
	const refusals = ["no passing audit or override"];
	if (audit !== undefined && audit.id !== auditId) {
		refusals.push(`audit ${audit.id} does not match cited ${auditId ?? "(none)"}`);
	} else if (audit !== undefined && audit.result !== "pass") {
		refusals.push(`audit ${audit.id} did not pass`);
	} else if (audit !== undefined) {
		const stored = row.audits?.find((item) => item.id === audit.id);
		if (stored === undefined) {
			refusals.push(`audit ${audit.id} is not recorded`);
		} else if (stored.result !== "pass") {
			refusals.push(`audit ${audit.id} did not pass`);
		} else if (stored.kind !== audit.kind || stored.recordedAt !== audit.recordedAt) {
			refusals.push(`audit ${audit.id} is stale; it does not match the recorded audit`);
		}
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
	const closedBy = closeRecord(row, input);
	if (closedBy === undefined) refusals.push(...closeRefusals(row, input));
	for (const item of row.humanItems) {
		if (item.state === "open") refusals.push(`open HTIL entry ${item.id}`);
	}
	if (closedBy === undefined || refusals.length > 0) return refusals;
	row.phaseOrder.push("Ship");
	row.shipStarts = 1;
	row.operatorConfirmations += 1;
	row.closedBy = closedBy;
	if (closedBy.kind === "override" && input.override !== undefined) {
		row.overrides = [...(row.overrides ?? []), { ...input.override }];
	}
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
	log?: { event: string; at?: string },
): GateOutcome {
	const run = (row: PhaseLoopState): GateOutcome => {
		const from = deriveLifecycle(row);
		const refusals = apply(row);
		const accepted = refusals.length === 0;
		if (accepted) {
			if (log?.at !== undefined) {
				appendTransition(row, {
					at: log.at,
					from,
					event: log.event,
					to: deriveLifecycle(row),
					accepted,
					refusals,
				});
			}
			if (row.schemaVersion === undefined) row.schemaVersion = FSM_SCHEMA_VERSION;
		}
		return { accepted, state: snapshot(row), refusals };
	};
	if (!store) {
		return run(rowFor(runtimeId));
	}
	return commitStoreMutation(runtimeId, store, log?.event ?? "transition", (row) => {
		const result = run(row);
		return { value: result, shouldCommit: result.accepted };
	});
}

/**
 * Attempt one phase. Order only grows as Discuss, Plan, Execute, Verify.
 * A refused attempt leaves state unchanged; the outcome names each refusal reason
 * and carries the current snapshot.
 * Refused when the runtime is not connected, the phase is not next in order,
 * or Execute's gates are unmet. Execute needs one complete uplift and zero unanswered
 * blocking clarifications. Ship never starts here; only confirmShip starts it.
 * With a store, state is read from it and an accepted attempt is committed to it before
 * return. Without one, the in-memory row is used. A quarantined record throws
 * PhaseLoopCorruptError.
 * An accepted attempt also records runtimeId as the loop's runtimeSessionId, the marker the close's connection
 * check reads. A refused attempt writes no marker.
 */
export function attemptPhase(
	runtimeId: string,
	input: PhaseAttemptInput,
	isConnected: RuntimeConnectedCheck,
	store?: PhaseLoopStore,
	opts?: TransitionOptions,
): GateOutcome {
	return transition(runtimeId, store, (row) => applyAttempt(runtimeId, row, input, isConnected), {
		event: `attempt(${input.phase})`,
		at: opts?.at,
	});
}

/**
 * Record the one operator confirmation, which closes the phase. Ship starts only when that
 * confirmation follows a recorded Verify (the current phase) on a connected runtime, cites by id an
 * audit that was previously recorded in the loop's ledger and still passes exactly as recorded
 * (a missing, re-recorded-fail, or snapshot-mismatched audit is refused as missing/stale), or
 * carries a complete owner override (LIFE-02), and leaves no HTIL entry open (LIFE-05). An
 * accepted close records that audit or override in `closedBy` in the same save. An accepted
 * override is also kept in `overrides` with its reason. A refused
 * confirmation names each reason in `refusals`. A second confirmation after Ship is refused.
 * With a store, state is read from it and an accepted confirmation is committed before return.
 * A quarantined record throws PhaseLoopCorruptError.
 */
export function confirmShip(
	runtimeId: string,
	input: ShipConfirmationInput,
	isConnected: RuntimeConnectedCheck,
	store?: PhaseLoopStore,
	opts?: TransitionOptions,
): ShipConfirmation {
	return transition(
		runtimeId,
		store,
		(row) => applyShipConfirmation(runtimeId, row, input, isConnected),
		{ event: "confirmShip", at: opts?.at },
	);
}

/** Options for `open`. `afterShip` is set only by the merge gate's reconcile, which records a verification entry on a Ship-closed loop (LIFE-05). */
export interface OpenHtilOptions {
	afterShip?: boolean;
}

/**
 * Record an open HTIL entry (LIFE-05). The entry starts in state open and blocks close until it
 * is resolved. A missing id or owner, or a duplicate id, is refused. Once Ship is recorded an entry is refused
 * unless `options.afterShip` is set.
 */
export function open(
	runtimeId: string,
	entry: Pick<HtilEntry, "id" | "owner">,
	store?: PhaseLoopStore,
	options: OpenHtilOptions = {},
	opts?: TransitionOptions,
): GateOutcome {
	return transition(
		runtimeId,
		store,
		(row) => {
			if (isClosed(row) && options.afterShip !== true)
				return [`loop is closed by Ship; HTIL entry ${entry.id} is not recorded`];
			const refusals: string[] = [];
			if (isBlank(entry.id)) refusals.push("HTIL entry needs an id");
			if (isBlank(entry.owner)) refusals.push(`HTIL entry ${entry.id} needs an owner`);
			if (row.humanItems.some((item) => item.id === entry.id)) {
				refusals.push(`HTIL entry ${entry.id} already exists`);
			}
			if (refusals.length > 0) return refusals;
			// Ship-closed here only through the reconcile (afterShip), so this origin marks exactly those entries.
			const origin: Pick<HtilEntry, "afterShip"> = isClosed(row) ? { afterShip: true } : {};
			row.humanItems.push({ id: entry.id, owner: entry.owner, state: "open", ...origin });
			return [];
		},
		{ event: `open(HTIL ${entry.id})`, at: opts?.at },
	);
}

/**
 * Resolve an open HTIL entry (LIFE-05). `done` needs the evidence it was resolved by; `deferred`
 * needs the recorded owner decision that defers it. A missing record is refused and the entry
 * stays open. Refused once Ship is recorded, unless the entry was opened on the Ship-closed loop by the merge gate's reconcile (`afterShip`).
 */
export function resolve(
	runtimeId: string,
	entryId: string,
	resolution: HtilResolution,
	store?: PhaseLoopStore,
	opts?: TransitionOptions,
): GateOutcome {
	return transition(
		runtimeId,
		store,
		(row) => {
			const entry = row.humanItems.find((item) => item.id === entryId);
			if (isClosed(row) && entry?.afterShip !== true)
				return [`loop is closed by Ship; HTIL entry ${entryId} is not resolved`];
			if (entry === undefined) return [`HTIL entry ${entryId} does not exist`];
			if (entry.state !== "open") return [`HTIL entry ${entryId} is already ${entry.state}`];
			if (resolution.state === "done") {
				if (isBlank(resolution.evidenceId)) return [`done HTIL entry ${entryId} needs evidenceId`];
				if (resolution.resolvedBy !== undefined && isBlank(resolution.resolvedBy)) {
					return [`done HTIL entry ${entryId} needs resolvedBy`];
				}
				entry.state = "done";
				entry.evidenceId = resolution.evidenceId;
				if (resolution.resolvedBy !== undefined) entry.resolvedBy = resolution.resolvedBy;
				if (resolution.resolvedAt !== undefined) entry.resolvedAt = resolution.resolvedAt;
				return [];
			}
			if (isBlank(resolution.decisionId))
				return [`deferred HTIL entry ${entryId} needs decisionId`];
			entry.state = "deferred";
			entry.decisionId = resolution.decisionId;
			return [];
		},
		{ event: `resolve(HTIL ${entryId})`, at: opts?.at },
	);
}

/**
 * LIFE-02: records one audit or validation result, so a later close can cite it by id. A record with the same id is
 * replaced, so the latest result for an id is the one a close reads. A blank id is refused, and so is any audit once Ship is recorded.
 */
export function recordAudit(
	runtimeId: string,
	audit: AuditRecord,
	store?: PhaseLoopStore,
	opts?: TransitionOptions,
): GateOutcome {
	return transition(
		runtimeId,
		store,
		(row) => {
			if (isClosed(row)) return [`loop is closed by Ship; audit ${audit.id} is not recorded`];
			if (isBlank(audit.id)) return ["audit record needs an id"];
			row.audits = [...(row.audits ?? []).filter((item) => item.id !== audit.id), { ...audit }];
			return [];
		},
		{ event: `recordAudit(${audit.id})`, at: opts?.at },
	);
}

/**
 * Durably clean up historical artifacts for a loop. Guard: the loop is completed (Ship
 * recorded) with a recorded close (`closedBy`). Marks the loop `cleaned-up`, which is
 * terminal: no phase events are accepted afterwards. Throws `FsmError` (kind `guard`)
 * when the guard fails, and `PhaseLoopCorruptError` when the stored record is quarantined.
 */
export function cleanupPhaseLoop(
	store: PhaseLoopStore,
	runtimeId: string,
	cleanedBy: string,
	now: string,
): void {
	commitStoreMutation(runtimeId, store, "cleanup", (row) => {
		const lifecycle = deriveLifecycle(row);
		if (!isClosed(row)) {
			throw new FsmError(
				"guard",
				lifecycle,
				"cleanup",
				nextEvents(lifecycle),
				`cleanup requires a completed loop; loop is ${lifecycle}`,
			);
		}
		if (row.closedBy === undefined) {
			throw new FsmError(
				"guard",
				lifecycle,
				"cleanup",
				nextEvents(lifecycle),
				"cleanup requires a recorded close (closedBy)",
			);
		}
		if (row.cleanedUpAt !== undefined) {
			throw new FsmError(
				"rejection",
				lifecycle,
				"cleanup",
				nextEvents(lifecycle),
				"loop is already cleaned-up",
			);
		}
		if (isBlank(cleanedBy)) {
			throw new FsmError(
				"guard",
				lifecycle,
				"cleanup",
				nextEvents(lifecycle),
				"cleanup needs a cleanedBy owner",
			);
		}
		appendTransition(row, {
			at: now,
			from: lifecycle,
			event: "cleanup",
			to: "cleaned-up",
			accepted: true,
			refusals: [],
		});
		row.cleanedUpAt = now;
		row.cleanedUpBy = cleanedBy;
		if (row.schemaVersion === undefined) row.schemaVersion = FSM_SCHEMA_VERSION;
		return { value: undefined, shouldCommit: true };
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
	commitStoreMutation(runtimeId, store, "checkpoint", (row) => ({
		value: undefined,
		shouldCommit: true,
		record: { ...row, checkpoint: { reason, at: now } },
	}));
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
