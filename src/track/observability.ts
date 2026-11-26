// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Structured observability schema for every uplift/swarm transition (SPE-37789, n6).
 *
 * One closed event type per contract clause; every event carries the same
 * fields — `{ invocationId, epoch, sessionId, from, to, wait_duration_ms }` —
 * plus `timestamp`. The `PendingStore` emits through an optional sink on each
 * keyed transition (see `eventTypeForTransition`); the host composes the
 * remaining events (`gate.blocked` decisions, `inject.attempt/succeeded/failed`
 * from `GatedFinalHopInjector` results, `late_plan.injected` after a retry)
 * with the same helpers, so n7 composition can assert one flat event log.
 * Pure + typed: no I/O, no globals, clock-free (callers pass `now`).
 */
export type ObservabilityEventType =
	| "ultrathink.invoked"
	| "gate.blocked"
	| "plan.ready"
	| "plan.rejected"
	| "inject.attempt"
	| "inject.succeeded"
	| "inject.failed"
	| "todo.sync.succeeded"
	| "todo.sync.failed"
	| "swarm.force_stop"
	| "swarm.handoff"
	| "uplift.timeout"
	| "late_plan.injected"
	| "user_input.queued"
	| "user_input.superseded";

/** Every event type the schema admits, in contract order. */
export const OBSERVABILITY_EVENT_TYPES: readonly ObservabilityEventType[] = [
	"ultrathink.invoked",
	"gate.blocked",
	"plan.ready",
	"plan.rejected",
	"inject.attempt",
	"inject.succeeded",
	"inject.failed",
	"todo.sync.succeeded",
	"todo.sync.failed",
	"swarm.force_stop",
	"swarm.handoff",
	"uplift.timeout",
	"late_plan.injected",
	"user_input.queued",
	"user_input.superseded",
];

/** One structured observability event: closed type plus the correlation keys and wait. */
export interface ObservabilityEvent {
	type: ObservabilityEventType;
	invocationId: string;
	epoch: number;
	sessionId: string;
	from: string;
	to: string;
	wait_duration_ms: number;
	timestamp: number;
}

/** A sink receives each emitted event. The recorder below is the default sink for tests and the host. */
export type ObservabilitySink = (event: ObservabilityEvent) => void;

/** Input to `createObservabilityEvent`: the correlation keys + state pair; `wait_duration_ms` derives from the clock. */
export interface CreateObservabilityEventInput {
	type: ObservabilityEventType;
	invocationId: string;
	epoch: number;
	sessionId: string;
	from: string;
	to: string;
	/** Invocation start (`startedAt`); omitted only for gate decisions with no live clock anchor, yielding `wait_duration_ms: 0`. */
	startedAt?: number;
	/** Emission clock. Defaults to `Date.now()`. */
	now?: number;
}

/** Milliseconds from `startedAt` to `now`, clamped at zero so a skewed clock never reports a negative wait. */
export function waitDurationMs(startedAt: number | undefined, now: number): number {
	if (startedAt === undefined) return 0;
	return Math.max(0, now - startedAt);
}

/** Builds one validated event. Throws on an unknown (runtime) event type — untyped callers fail loudly, never silently. */
export function createObservabilityEvent(input: CreateObservabilityEventInput): ObservabilityEvent {
	if (!(OBSERVABILITY_EVENT_TYPES as readonly string[]).includes(input.type)) {
		throw new Error(`unknown observability event type: ${String(input.type)}`);
	}
	const now = input.now ?? Date.now();
	return {
		type: input.type,
		invocationId: input.invocationId,
		epoch: input.epoch,
		sessionId: input.sessionId,
		from: input.from,
		to: input.to,
		wait_duration_ms: waitDurationMs(input.startedAt, now),
		timestamp: now,
	};
}

/** Builds and delivers one event to `sink`, returning the event. */
export function emitObservabilityEvent(
	sink: ObservabilitySink,
	input: CreateObservabilityEventInput,
): ObservabilityEvent {
	const event = createObservabilityEvent(input);
	sink(event);
	return event;
}

/** In-memory recorder: the default sink. `events` is the assertion surface; `clear()` resets it. */
export interface ObservabilityRecorder {
	readonly events: ObservabilityEvent[];
	readonly sink: ObservabilitySink;
	emit(input: CreateObservabilityEventInput): ObservabilityEvent;
	eventsOf(type: ObservabilityEventType): ObservabilityEvent[];
	clear(): void;
}

export function createEventRecorder(): ObservabilityRecorder {
	const events: ObservabilityEvent[] = [];
	return {
		events,
		sink: (event) => void events.push(event),
		emit: (input) => emitObservabilityEvent((event) => void events.push(event), input),
		eventsOf: (type) => events.filter((event) => event.type === type),
		clear: () => void events.splice(0, events.length),
	};
}

/** One log line per event for plain-text log sinks (the host `log` surface). Field names match the schema, not prose. */
export function formatObservabilityEvent(event: ObservabilityEvent): string {
	return (
		`ultrathink ${event.type} invocation=${event.invocationId} epoch=${event.epoch} ` +
		`session=${event.sessionId} ${event.from}->${event.to} wait_ms=${event.wait_duration_ms}`
	);
}

/**
 * The `PendingStore` transition → event mapping. States are strings (not
 * `PendingState`) so this module needs no import from `pending.ts` and stays
 * cycle-free. `undefined` means the transition has no contract event (retry,
 * dismiss, cancel) and emits nothing.
 *
 * Table: `Idle -> Invoked` = invoked; `* -> PlanReady` = plan.ready;
 * `UpliftPending|SwarmGated|PlanReady -> Failed` = plan.rejected;
 * `PlanReady -> Injecting` = inject.attempt; `Injecting -> Injected` =
 * inject.succeeded; `Injecting -> Failed` = inject.failed;
 * `Injected -> TODOsSynced` = todo.sync.succeeded;
 * `Injected|TODOsSynced -> Failed` = todo.sync.failed;
 * `TODOsSynced -> ForceStoppedOrFinishedOff` = swarm.force_stop;
 * `ForceStoppedOrFinishedOff -> HandedOff` = swarm.handoff;
 * `* -> TimedOut` = uplift.timeout.
 */
export function eventTypeForTransition(
	from: string,
	to: string,
): ObservabilityEventType | undefined {
	if (to === "TimedOut") return "uplift.timeout";
	if (from === "Idle" && to === "Invoked") return "ultrathink.invoked";
	if (to === "PlanReady") return "plan.ready";
	if (to === "Failed") {
		if (from === "Injecting") return "inject.failed";
		if (from === "Injected" || from === "TODOsSynced") return "todo.sync.failed";
		return "plan.rejected";
	}
	if (from === "PlanReady" && to === "Injecting") return "inject.attempt";
	if (from === "Injecting" && to === "Injected") return "inject.succeeded";
	if (from === "Injected" && to === "TODOsSynced") return "todo.sync.succeeded";
	if (from === "TODOsSynced" && to === "ForceStoppedOrFinishedOff") return "swarm.force_stop";
	if (from === "ForceStoppedOrFinishedOff" && to === "HandedOff") return "swarm.handoff";
	return undefined;
}

/**
 * Accessibility contract behind `pendingStatusText` (unit-testable half):
 * the visible pending line is a single labelled line announced via
 * `aria-live="polite"`; focus is never moved by a transition; chat history
 * keeps one row per wave/node in plan order. Real keyboard traversal and DOM
 * focus order are host-E2E properties — the matrix tests pin these constants
 * and prose, not a browser.
 */
export const A11Y_CONTRACT =
	"pending line: single line, aria-live=polite, focus preserved; chat sync history keeps every wave/node row in plan order (focus/keyboard/DOM focus order verified in host E2E, not unit tests).";
