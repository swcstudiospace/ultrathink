// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Pending state machine + Swarm gate (SPE-37788, n5): supersession, gate, completion, atomic sync, timeout/failure. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, type SessionRecord, writeSession } from "../claude/state.ts";
import {
	forceStopFinishOff,
	getFailureSurface,
	INJECTION_RETRY_BUDGET,
	PendingStore,
	syncValidatedTodos,
	UPLIFT_TIMEOUT_MS,
	validateTodoSnapshot,
} from "./pending.ts";
import type { TodoSnapshotItem } from "../claude/state.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-pending-"));
	dirs.push(dir);
	return dir;
}

function seedRecord(dir: string, sessionId: string): void {
	const record: SessionRecord = {
		sessionId,
		at: 0,
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
	};
	writeSession(dir, record);
}

const TODOS: TodoSnapshotItem[] = [
	{ content: "step one", status: "in_progress", activeForm: "step one" },
	{ content: "step two", status: "pending" },
];

function driveToInjected(store: PendingStore, sessionId: string, rawInput = "build it", now = 1000) {
	const invocation = store.create(sessionId, rawInput, now);
	const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
	store.transition(sessionId, "UpliftPending", "uplift started", identity, now + 1);
	store.transition(sessionId, "SwarmGated", "gated", identity, now + 2);
	store.setUpliftedPrompt(sessionId, identity, "the full uplifted prompt");
	store.setValidatedTodos(sessionId, identity, TODOS);
	store.transition(sessionId, "PlanReady", "plan complete", identity, now + 3);
	store.transition(sessionId, "Injecting", "injection started", identity, now + 4);
	store.transition(sessionId, "Injected", "injected", identity, now + 5);
	return invocation;
}

describe("create / supersession", () => {
	test("second magic-words invocation supersedes with epoch++ and stale writes are rejected", () => {
		const store = new PendingStore();
		const first = store.create("s1", "first input", 1000);
		expect(first.state).toBe("Invoked");
		expect(first.epoch).toBe(1);
		expect(first.rawInputHash).toMatch(/^[0-9a-f]{64}$/);
		expect(first.transitions.every((t) => t.invocationId === first.invocationId)).toBe(true);

		const second = store.create("s1", "second input", 2000);
		expect(second.epoch).toBe(2);
		expect(second.invocationId).not.toBe(first.invocationId);
		expect(second.state).toBe("Invoked");

		// Stale identity + epoch: old invocation can no longer transition.
		expect(() =>
			store.transition("s1", "UpliftPending", "stale", { invocationId: first.invocationId, epoch: 1 }, 3000),
		).toThrow(/stale/);
		// Current identity moves forward and every log entry carries invocationId+timestamp+reason.
		store.transition("s1", "UpliftPending", "uplift started", { invocationId: second.invocationId, epoch: 2 }, 3000);
		const current = store.get("s1")!;
		expect(current.state).toBe("UpliftPending");
		expect(current.transitions.every((t) => t.invocationId === second.invocationId)).toBe(true);
		expect(current.transitions.every((t) => typeof t.timestamp === "number" && t.reason !== "")).toBe(true);
	});
});

describe("Swarm gate", () => {
	test("blocks substantive work pre-plan, allows read-only, and passes with no pending", () => {
		const store = new PendingStore();
		expect(store.gatePasses("s1")).toBe(true);
		const invocation = store.create("s1", "raw input", 1000);
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		expect(store.gatePasses("s1")).toBe(false);
		expect(store.gateFor("s1", "read-only")).toEqual({ allowed: true, reason: "" });
		expect(store.gateFor("s1", "substantive").allowed).toBe(false);
		expect(store.gateFor("s1", "substantive").reason).not.toBe("");

		store.transition("s1", "UpliftPending", "uplift", identity, 1100);
		expect(store.gatePasses("s1")).toBe(false);
		store.transition("s1", "SwarmGated", "gated", identity, 1200);
		expect(store.gatePasses("s1")).toBe(false);
		store.transition("s1", "PlanReady", "ready", identity, 1300);
		// Past the gate the spawn entry lets substantive work through.
		expect(store.gatePasses("s1")).toBe(true);
	});
});

describe("completion", () => {
	test("requires both a non-empty prompt and validated TODOs bound to the same invocation", () => {
		const store = new PendingStore();
		const invocation = store.create("s1", "raw input", 1000);
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		expect(store.checkCompletion(invocation).complete).toBe(false);

		store.setUpliftedPrompt("s1", identity, "prompt text");
		expect(store.checkCompletion(store.get("s1")!).complete).toBe(false);
		store.setValidatedTodos("s1", identity, TODOS);
		expect(store.checkCompletion(store.get("s1")!).complete).toBe(true);

		// Unbound / spoofed payloads never complete.
		const spoofed = { ...store.get("s1")!, validatedTodosInvocationId: "other" };
		expect(store.checkCompletion(spoofed).complete).toBe(false);
		const empty = { ...store.get("s1")!, upliftedPrompt: "   " };
		expect(store.checkCompletion(empty).complete).toBe(false);
		expect(validateTodoSnapshot([]).ok).toBe(false);
		expect(validateTodoSnapshot([{ content: "", status: "pending" }]).ok).toBe(false);
	});
});

describe("atomic TODO sync", () => {
	test("success replaces lastTodos in one write and moves to TODOsSynced", () => {
		const store = new PendingStore();
		const dir = stateDir();
		seedRecord(dir, "s1");
		const invocation = driveToInjected(store, "s1");
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		const result = syncValidatedTodos({
			store,
			sessionId: "s1",
			identity,
			todos: TODOS,
			stateDir: dir,
			now: () => 9000,
		});
		expect(result.ok).toBe(true);
		expect(readSession(dir, "s1")!.recall!.lastTodos).toEqual(TODOS);
		expect(store.get("s1")!.state).toBe("TODOsSynced");
	});

	test("failure before the write and a throwing write leave the record untouched", () => {
		const store = new PendingStore();
		const dir = stateDir();
		seedRecord(dir, "s1");
		const invocation = driveToInjected(store, "s1");
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		const before = JSON.stringify(readSession(dir, "s1"));

		const invalid = syncValidatedTodos({
			store,
			sessionId: "s1",
			identity,
			todos: [{ content: "", status: "pending" }],
			stateDir: dir,
			now: () => 9000,
		});
		expect(invalid.ok).toBe(false);
		expect(JSON.stringify(readSession(dir, "s1"))).toBe(before);
		expect(store.get("s1")!.state).toBe("Injected");

		const throwing = syncValidatedTodos({
			store,
			sessionId: "s1",
			identity,
			todos: TODOS,
			stateDir: dir,
			now: () => 9000,
			update: () => {
				throw new Error("disk on fire");
			},
		});
		expect(throwing.ok).toBe(false);
		expect(JSON.stringify(readSession(dir, "s1"))).toBe(before);
		expect(store.get("s1")!.state).toBe("Injected");
	});
});

describe("timeout / failure", () => {
	test("TimedOut and Failed stay distinct, both retryable once and dismissible", () => {
		const store = new PendingStore();
		const invocation = store.create("s1", "raw input", 1000);
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		store.transition("s1", "UpliftPending", "uplift", identity, 1100);
		expect(store.checkTimeout("s1", 1000 + UPLIFT_TIMEOUT_MS + 1)).toBe(true);
		expect(store.applyTimeout("s1", 1000 + UPLIFT_TIMEOUT_MS + 1)).toBe(true);
		expect(store.get("s1")!.state).toBe("TimedOut");
		const timedOut = getFailureSurface(store.get("s1")!);
		expect(timedOut.state).toBe("TimedOut");
		expect(timedOut.retryable).toBe(true);
		expect(timedOut.dismissible).toBe(true);
		store.retry("s1", 1000 + UPLIFT_TIMEOUT_MS + 2);
		expect(store.get("s1")!.state).toBe("Invoked");

		const store2 = new PendingStore();
		const inv2 = store2.create("s2", "raw", 1000);
		const id2 = { invocationId: inv2.invocationId, epoch: inv2.epoch };
		store2.transition("s2", "UpliftPending", "uplift", id2, 1100);
		store2.transition("s2", "Failed", "provider down", id2, 1200);
		expect(store2.get("s2")!.state).toBe("Failed");
		expect(getFailureSurface(store2.get("s2")!).state).toBe("Failed");
		expect(getFailureSurface(store2.get("s2")!).reason).toBe("provider down");
	});

	test("injection attempts respect the 3-attempt budget with exponential backoff", () => {
		const store = new PendingStore();
		const invocation = store.create("s1", "raw", 1000);
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		const first = store.recordInjectionAttempt("s1", identity);
		expect(first).toEqual({ attempt: 1, budgetExceeded: false, backoffMs: 500 });
		store.recordInjectionAttempt("s1", identity);
		store.recordInjectionAttempt("s1", identity);
		expect(store.get("s1")!.injectionAttemptCount).toBe(INJECTION_RETRY_BUDGET);
	});

	test("force-stop needs the seam; with one it moves TODOsSynced onward", async () => {
		const store = new PendingStore();
		const dir = stateDir();
		seedRecord(dir, "s1");
		const invocation = driveToInjected(store, "s1");
		const identity = { invocationId: invocation.invocationId, epoch: invocation.epoch };
		expect(syncValidatedTodos({
			store,
			sessionId: "s1",
			identity,
			todos: TODOS,
			stateDir: dir,
			now: () => 9000,
		}).ok).toBe(true);

		const withoutSeam = await forceStopFinishOff(store, "s1", identity, undefined, 9500);
		expect(withoutSeam.ok).toBe(false);
		expect(withoutSeam.missingPrimitive).toMatch(/Swarm cancel/);
		expect(store.get("s1")!.state).toBe("TODOsSynced");

		let stopped = false;
		const withSeam = await forceStopFinishOff(
			store,
			"s1",
			identity,
			{
				forceStop: () => {
					stopped = true;
				},
			},
			9500,
		);
		expect(withSeam.ok).toBe(true);
		expect(stopped).toBe(true);
		expect(store.get("s1")!.state).toBe("ForceStoppedOrFinishedOff");
		store.transition("s1", "HandedOff", "resume/handoff", identity, 9600);
		expect(store.get("s1")!.state).toBe("HandedOff");
	});
});
