// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Structured observability schema (SPE-37789, n6): every contract event, typed and correlatable. */
import { describe, expect, test } from "bun:test";
import {
	A11Y_CONTRACT,
	OBSERVABILITY_EVENT_TYPES,
	createEventRecorder,
	createObservabilityEvent,
	emitObservabilityEvent,
	eventTypeForTransition,
	formatObservabilityEvent,
	waitDurationMs,
} from "./observability.ts";

describe("event schema", () => {
	test("closed set, exactly the contract events in contract order", () => {
		expect(OBSERVABILITY_EVENT_TYPES).toEqual([
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
		]);
	});

	test("every event carries invocationId, epoch, sessionId, from, to and wait_duration_ms", () => {
		const event = createObservabilityEvent({
			type: "gate.blocked",
			invocationId: "pending-1",
			epoch: 2,
			sessionId: "s1",
			from: "UpliftPending",
			to: "UpliftPending",
			startedAt: 1000,
			now: 1500,
		});
		expect(event).toEqual({
			type: "gate.blocked",
			invocationId: "pending-1",
			epoch: 2,
			sessionId: "s1",
			from: "UpliftPending",
			to: "UpliftPending",
			wait_duration_ms: 500,
			timestamp: 1500,
		});
	});

	test("wait clamps at zero and defaults to zero without an anchor", () => {
		expect(waitDurationMs(2000, 1500)).toBe(0);
		expect(waitDurationMs(undefined, 1500)).toBe(0);
		expect(
			createObservabilityEvent({
				type: "gate.blocked",
				invocationId: "i",
				epoch: 1,
				sessionId: "s",
				from: "a",
				to: "a",
				now: 99,
			}).wait_duration_ms,
		).toBe(0);
	});

	test("unknown runtime event type fails loudly, never silently", () => {
		expect(() =>
			createObservabilityEvent({
				type: "nope" as never,
				invocationId: "i",
				epoch: 1,
				sessionId: "s",
				from: "a",
				to: "b",
				now: 1,
			}),
		).toThrow(/unknown observability event type/);
	});
});

describe("recorder + formatting", () => {
	test("recorder appends, filters by type, and clears", () => {
		const recorder = createEventRecorder();
		recorder.emit({
			type: "ultrathink.invoked",
			invocationId: "i",
			epoch: 1,
			sessionId: "s",
			from: "Idle",
			to: "Invoked",
			startedAt: 0,
			now: 5,
		});
		recorder.emit({
			type: "gate.blocked",
			invocationId: "i",
			epoch: 1,
			sessionId: "s",
			from: "Invoked",
			to: "Invoked",
			startedAt: 0,
			now: 6,
		});
		expect(recorder.events).toHaveLength(2);
		expect(recorder.eventsOf("gate.blocked")).toHaveLength(1);
		recorder.clear();
		expect(recorder.events).toHaveLength(0);
	});

	test("sink + format line name type, ids and state pair", () => {
		const seen: unknown[] = [];
		const event = emitObservabilityEvent((e) => void seen.push(e), {
			type: "plan.ready",
			invocationId: "i",
			epoch: 1,
			sessionId: "s",
			from: "SwarmGated",
			to: "PlanReady",
			startedAt: 10,
			now: 40,
		});
		expect(seen).toEqual([event]);
		expect(formatObservabilityEvent(event)).toBe(
			"ultrathink plan.ready invocation=i epoch=1 session=s SwarmGated->PlanReady wait_ms=30",
		);
	});
});

describe("transition mapping + a11y contract", () => {
	test("each keyed transition maps to exactly its contract event", () => {
		expect(eventTypeForTransition("Idle", "Invoked")).toBe("ultrathink.invoked");
		expect(eventTypeForTransition("SwarmGated", "PlanReady")).toBe("plan.ready");
		expect(eventTypeForTransition("SwarmGated", "Failed")).toBe("plan.rejected");
		expect(eventTypeForTransition("PlanReady", "Failed")).toBe("plan.rejected");
		expect(eventTypeForTransition("PlanReady", "Injecting")).toBe("inject.attempt");
		expect(eventTypeForTransition("Injecting", "Injected")).toBe("inject.succeeded");
		expect(eventTypeForTransition("Injecting", "Failed")).toBe("inject.failed");
		expect(eventTypeForTransition("Injected", "TODOsSynced")).toBe("todo.sync.succeeded");
		expect(eventTypeForTransition("Injected", "Failed")).toBe("todo.sync.failed");
		expect(eventTypeForTransition("TODOsSynced", "Failed")).toBe("todo.sync.failed");
		expect(eventTypeForTransition("TODOsSynced", "ForceStoppedOrFinishedOff")).toBe(
			"swarm.force_stop",
		);
		expect(eventTypeForTransition("ForceStoppedOrFinishedOff", "HandedOff")).toBe("swarm.handoff");
		expect(eventTypeForTransition("UpliftPending", "TimedOut")).toBe("uplift.timeout");
		expect(eventTypeForTransition("Injecting", "TimedOut")).toBe("uplift.timeout");
	});

	test("retry, dismiss and cancel have no contract event", () => {
		expect(eventTypeForTransition("Failed", "Invoked")).toBeUndefined();
		expect(eventTypeForTransition("TimedOut", "Idle")).toBeUndefined();
		expect(eventTypeForTransition("Invoked", "Cancelled")).toBeUndefined();
	});

	test("a11y contract names aria-live, focus and history", () => {
		expect(A11Y_CONTRACT).toContain("aria-live=polite");
		expect(A11Y_CONTRACT).toContain("focus");
		expect(A11Y_CONTRACT).toContain("history");
	});
});
