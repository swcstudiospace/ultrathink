// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Verification + observability matrix (SPE-37789, n6).
 *
 * One describe per contract criterion, each driving the real Wave 1-3
 * primitives (`syncTodos`/`isSyncTodosDone`, `GatedFinalHopInjector`,
 * chat-sync view + `onChatCancel` handoff, `PendingStore` gate + ForceStop
 * seam) with stubbed channels and a numeric fake clock (explicit `now`, plus
 * a shortened `timeoutMs` for the timeout variant) — no real timers, no real
 * Swarm. The recorder (`PendingStore` sink) is the assertion surface; every
 * event must carry `{ invocationId, epoch, sessionId, from, to,
 * wait_duration_ms }`.
 *
 * No Swarm cancel primitive exists in this repo (SPE-37788): the ForceStop
 * seam is the cancel stand-in, and the missing-primitive fail-closed path is
 * asserted where the contract requires a stop.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, type SessionRecord, type TodoSnapshotItem, writeSession } from "../claude/state.ts";
import { consumeChatSyncNoDrop, onChatCancel } from "../host/chat-handoff.ts";
import { ArtifactStore, GatedFinalHopInjector, TranscriptStore } from "../host/uplift-delivery.ts";
import { buildChatSyncView, type PlanView } from "../host/view.ts";
import { createEventRecorder, formatObservabilityEvent, type ObservabilityEvent, type ObservabilityEventType } from "./observability.ts";
import {
	PENDING_ARIA_LIVE,
	PendingStore,
	forceStopFinishOff,
	getFailureSurface,
	injectionBackoffMs,
	pendingStatusText,
	syncValidatedTodos,
	validateTodoSnapshot,
} from "./pending.ts";
import { isSyncTodosDone, planWaves, syncTodos, waveTodos } from "./sync-todos.ts";
import type { TrackPlan } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-matrix-"));
	dirs.push(dir);
	return dir;
}

function plan(): TrackPlan {
	return {
		graphId: "ut-matrix",
		task: {
			graphId: "ut-matrix",
			item: "Fix the login redirect",
			description: "desc",
			upliftedPrompt: "prompt",
			agent: "claude-code",
			status: "Todo",
			linearState: "Todo",
		},
		issues: [
			{ graphId: "ut-matrix", nodeId: "n1", item: "First", thought: "t" },
			{ graphId: "ut-matrix", nodeId: "n2", item: "Second", thought: "t" },
			{ graphId: "ut-matrix", nodeId: "n3", item: "Third", thought: "t" },
		],
		subIssues: [],
		linearIssues: [],
		linearSubIssues: [],
		hitl: { blocking: [], nonBlocking: [] },
		dependencies: { n2: ["n1"], n3: ["n1"] },
	};
}

function seedRecord(dir: string, sessionId: string): void {
	const record: SessionRecord = {
		sessionId,
		at: 0,
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
		plan: plan(),
	};
	writeSession(dir, record);
}

/** Chat-visible plan projection (matches `src/host/chat-sync.test.ts` waves). */
const PLAN_VIEW: PlanView = {
	root: "BUILD_PROMPT",
	source: "llm",
	graphId: "ut-matrix",
	elapsedMs: 1000,
	nodes: [
		{ id: "n1", title: "Understand", kind: "understand", wave: 1, dependsOn: [], steps: [] },
		{ id: "n2", title: "Generate left", kind: "generate", wave: 2, dependsOn: ["n1"], steps: [] },
		{ id: "n3", title: "Generate right", kind: "generate", wave: 2, dependsOn: ["n1"], steps: [] },
	],
	waves: [["n1"], ["n2", "n3"]],
	clarifications: [],
};

/** Idle Swarm stub: a substantive spawn attempt consults the gate and dispatches only when it passes. */
function swarmDispatch(store: PendingStore, sessionId: string, now: number): boolean {
	return store.gatePasses(sessionId, now);
}

interface Ctx {
	store: PendingStore;
	recorder: ReturnType<typeof createEventRecorder>;
	dir: string;
	sessionId: string;
	invocation: ReturnType<PendingStore["create"]>;
	identity: { invocationId: string; epoch: number };
}

const SESSION = "s-matrix";
const NOW = 1000;
const UPLIFTED = "the full uplifted prompt";

function setup(): Ctx {
	const dir = stateDir();
	seedRecord(dir, SESSION);
	const recorder = createEventRecorder();
	const store = new PendingStore({ onEvent: recorder.sink });
	const invocation = store.create(SESSION, "build it", NOW);
	return { store, recorder, dir, sessionId: SESSION, invocation, identity: { invocationId: invocation.invocationId, epoch: invocation.epoch } };
}

/** Producer root: persists wave todos + the injection-gate marker, then binds them to the pending. */
function produce(ctx: Ctx, now: number = NOW + 10): { todos: ReturnType<typeof waveTodos> } {
	const synced = syncTodos(plan(), { stateDir: ctx.dir, sessionId: ctx.sessionId, now: () => now });
	expect(synced.ok).toBe(true);
	expect(isSyncTodosDone(readSession(ctx.dir, ctx.sessionId), "ut-matrix")).toBe(true);
	ctx.store.setUpliftedPrompt(ctx.sessionId, ctx.identity, UPLIFTED);
	ctx.store.setValidatedTodos(ctx.sessionId, ctx.identity, synced.todos);
	expect(ctx.store.checkCompletion(ctx.store.get(ctx.sessionId)!).complete).toBe(true);
	return { todos: synced.todos };
}

function toPlanReady(ctx: Ctx, now: number = NOW): void {
	ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, now + 1);
	ctx.store.transition(ctx.sessionId, "SwarmGated", "gated", ctx.identity, now + 2);
	produce(ctx, now + 3);
	ctx.store.transition(ctx.sessionId, "PlanReady", "plan complete", ctx.identity, now + 4);
}

function expectWellFormed(events: ObservabilityEvent[]): void {
	for (const event of events) {
		expect(typeof event.invocationId).toBe("string");
		expect(event.invocationId).not.toBe("");
		expect(typeof event.epoch).toBe("number");
		expect(typeof event.sessionId).toBe("string");
		expect(typeof event.from).toBe("string");
		expect(typeof event.to).toBe("string");
		expect(typeof event.wait_duration_ms).toBe("number");
		expect(event.wait_duration_ms).toBeGreaterThanOrEqual(0);
		expect(typeof event.timestamp).toBe("number");
	}
}

function injector(transcript: TranscriptStore, artifacts: ArtifactStore, channel: () => boolean | Promise<boolean>) {
	return new GatedFinalHopInjector({ deterministic: channel, out: channel, artifacts, transcript });
}

describe("1 - before Swarm: gate blocks, Planning visible, no TODO mutation", () => {
	test("delayed Uplift with idle Swarm stub", () => {
		const ctx = setup();
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, NOW + 1);
		const before = JSON.stringify(readSession(ctx.dir, ctx.sessionId));

		// Substantive dispatch from raw prompt is held; read-only prep is not.
		expect(swarmDispatch(ctx.store, ctx.sessionId, NOW + 2)).toBe(false);
		expect(ctx.store.gateFor(ctx.sessionId, "substantive", NOW + 2).reason).not.toBe("");
		expect(ctx.store.gateFor(ctx.sessionId, "read-only", NOW + 2).allowed).toBe(true);

		// Planning is visible: one labelled pending line + chat rows, without claiming sync completeness.
		expect(pendingStatusText(ctx.store.get(ctx.sessionId))).toContain("UpliftPending");
		const syncView = buildChatSyncView(PLAN_VIEW, { sessionId: ctx.sessionId, kind: "managed", syncDone: false });
		expect(syncView.rows.map((row) => [row.wave_id, row.node_id])).toEqual([
			["w1", "n1"],
			["w2", "n2"],
			["w2", "n3"],
		]);
		expect(syncView.syncDone).toBe(false);

		// No TODO mutation: the session record is byte-identical, no marker, no lastTodos.
		expect(JSON.stringify(readSession(ctx.dir, ctx.sessionId))).toBe(before);
		const record = readSession(ctx.dir, ctx.sessionId)!;
		expect(record.syncTodos).toBeUndefined();
		expect(record.recall?.lastTodos).toBeUndefined();

		// Observability: invoked + gate.blocked, both well-formed.
		expectWellFormed(ctx.recorder.events);
		const first = ctx.recorder.events[0]!;
		expect(first.type).toBe("ultrathink.invoked");
		expect(first.from).toBe("Idle");
		expect(first.to).toBe("Invoked");
		const blocked = ctx.recorder.eventsOf("gate.blocked");
		expect(blocked.length).toBeGreaterThanOrEqual(1);
		expect(blocked[blocked.length - 1]!.wait_duration_ms).toBe(NOW + 2 - NOW);
	});
});

describe("2 - during/after Swarm: forced injection once, stopped/finished, zero orphans/duplicates", () => {
	test("one forced injection, seam stop, single chat entry per invocationId", async () => {
		const ctx = setup();
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, NOW + 1);
		ctx.store.transition(ctx.sessionId, "SwarmGated", "pre-plan Swarm running", ctx.identity, NOW + 2);
		expect(swarmDispatch(ctx.store, ctx.sessionId, NOW + 3)).toBe(false);
		produce(ctx, NOW + 4);
		ctx.store.transition(ctx.sessionId, "PlanReady", "plan complete", ctx.identity, NOW + 5);
		expect(swarmDispatch(ctx.store, ctx.sessionId, NOW + 6)).toBe(true);

		const artifacts = new ArtifactStore();
		artifacts.add({ key: "neg", seeded: false, negative: true, text: "fix me" });
		artifacts.add({ key: "seeded-neg", seeded: true, negative: true, text: "keep me" });
		const transcript = new TranscriptStore();
		let delivered = 0;
		const inj = injector(transcript, artifacts, () => {
			delivered++;
			return true;
		});
		ctx.store.transition(ctx.sessionId, "Injecting", "injection started", ctx.identity, NOW + 7);
		const result = await inj.inject({
			record: readSession(ctx.dir, ctx.sessionId),
			graphId: "ut-matrix",
			sessionId: ctx.sessionId,
			promptText: UPLIFTED,
			replaceKey: ctx.identity.invocationId,
			sessionKind: "managed",
		});
		expect(result.state).toBe("injected");
		expect(delivered).toBe(1);

		// Idempotent re-delivery replaces, never duplicates.
		expect(
			(await inj.inject({
				record: readSession(ctx.dir, ctx.sessionId),
				graphId: "ut-matrix",
				sessionId: ctx.sessionId,
				promptText: UPLIFTED,
				replaceKey: ctx.identity.invocationId,
				sessionKind: "managed",
			})).state,
		).toBe("injected");
		ctx.store.transition(ctx.sessionId, "Injected", "injected", ctx.identity, NOW + 8);
		expect(syncValidatedTodos({ store: ctx.store, sessionId: ctx.sessionId, identity: ctx.identity, todos: ctx.store.get(ctx.sessionId)!.validatedTodos, stateDir: ctx.dir, now: () => NOW + 9 }).ok).toBe(true);

		// No seam: fail closed with the missing primitive, state unmoved (no Swarm cancel primitive in repo).
		const noSeam = await forceStopFinishOff(ctx.store, ctx.sessionId, ctx.identity, undefined, NOW + 10);
		expect(noSeam).toEqual({ ok: false, missingPrimitive: "Swarm cancel seam not provided" });
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("TODOsSynced");

		let stopped = 0;
		const stoppedResult = await forceStopFinishOff(
			ctx.store,
			ctx.sessionId,
			ctx.identity,
			{
				forceStop: () => {
					stopped++;
				},
			},
			NOW + 11,
		);
		expect(stoppedResult.ok).toBe(true);
		expect(stopped).toBe(1);
		ctx.store.transition(ctx.sessionId, "HandedOff", "resume/handoff", ctx.identity, NOW + 12);

		// Zero orphans/duplicates: one chat entry for this invocationId, contiguous command chain.
		const mine = transcript.list().filter((entry) => entry.replaceKey === ctx.identity.invocationId);
		expect(mine).toHaveLength(1);
		expect(mine[0]!.promptText).toBe(UPLIFTED);
		expect(result.removedArtifacts.map((a) => a.key)).toEqual(["neg"]);
		expect(artifacts.list().map((a) => a.key)).toEqual(["seeded-neg"]);
		const pending = ctx.store.get(ctx.sessionId)!;
		for (let i = 1; i < pending.transitions.length; i++) {
			expect(pending.transitions[i]!.from).toBe(pending.transitions[i - 1]!.to);
			expect(pending.transitions[i]!.invocationId).toBe(ctx.identity.invocationId);
		}
		expectWellFormed(ctx.recorder.events);
		expect(ctx.recorder.events.every((e) => e.invocationId === ctx.identity.invocationId)).toBe(true);
	});
});

describe("3 - success order: Injected -> TODOsSynced -> handoff, TODOs equal plan; failures prevent success", () => {
	test("happy path order and plan equality; onChatCancel handoff after stop", async () => {
		const ctx = setup();
		toPlanReady(ctx);
		const todos = ctx.store.get(ctx.sessionId)!.validatedTodos as TodoSnapshotItem[];
		const transcript = new TranscriptStore();
		const inj = injector(transcript, new ArtifactStore(), () => true);
		ctx.store.transition(ctx.sessionId, "Injecting", "injection started", ctx.identity, NOW + 6);
		expect(
			(await inj.inject({
				record: readSession(ctx.dir, ctx.sessionId),
				graphId: "ut-matrix",
				sessionId: ctx.sessionId,
				promptText: UPLIFTED,
				replaceKey: ctx.identity.invocationId,
				sessionKind: "managed",
			})).state,
		).toBe("injected");
		ctx.store.transition(ctx.sessionId, "Injected", "injected", ctx.identity, NOW + 7);
		expect(syncValidatedTodos({ store: ctx.store, sessionId: ctx.sessionId, identity: ctx.identity, todos, stateDir: ctx.dir, now: () => NOW + 8 }).ok).toBe(true);
		expect(readSession(ctx.dir, ctx.sessionId)!.recall!.lastTodos).toEqual(todos);
		expect(readSession(ctx.dir, ctx.sessionId)!.recall!.lastTodos).toEqual(waveTodos(planWaves(plan())));
		expect(await forceStopFinishOff(ctx.store, ctx.sessionId, ctx.identity, { forceStop: () => {} }, NOW + 9)).toMatchObject({ ok: true });
		ctx.store.transition(ctx.sessionId, "HandedOff", "resume/handoff", ctx.identity, NOW + 10);

		const states = ctx.store.get(ctx.sessionId)!.transitions.map((t) => t.to);
		expect(states).toEqual([
			"Invoked",
			"UpliftPending",
			"SwarmGated",
			"PlanReady",
			"Injecting",
			"Injected",
			"TODOsSynced",
			"ForceStoppedOrFinishedOff",
			"HandedOff",
		]);
		const types = ctx.recorder.events.map((e) => e.type);
		const order: ObservabilityEventType[] = ["inject.succeeded", "todo.sync.succeeded", "swarm.force_stop", "swarm.handoff"];
		let prev = -1;
		for (const type of order) {
			const idx = types.indexOf(type);
			expect(idx).toBeGreaterThan(prev);
			prev = idx;
		}
		expectWellFormed(ctx.recorder.events);

		// Handoff durability: a cancelled card still lands in the handoff file (no-drop after kill).
		const path = join(ctx.dir, "handoff.jsonl");
		onChatCancel(path, { wave_id: "w1", node_id: "n1", sessionId: ctx.sessionId, kind: "managed" });
		expect(consumeChatSyncNoDrop(path)).toHaveLength(1);
	});

	test("injection failure prevents Injected, success and resume", async () => {
		const ctx = setup();
		toPlanReady(ctx);
		const transcript = new TranscriptStore();
		const inj = injector(transcript, new ArtifactStore(), () => false);
		ctx.store.transition(ctx.sessionId, "Injecting", "injection started", ctx.identity, NOW + 10);
		const result = await inj.inject({
			record: readSession(ctx.dir, ctx.sessionId),
			graphId: "ut-matrix",
			sessionId: ctx.sessionId,
			promptText: UPLIFTED,
			replaceKey: ctx.identity.invocationId,
			sessionKind: "managed",
		});
		expect(result.state).toBe("dropped-with-reason");
		expect(transcript.list()).toHaveLength(0);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("Injecting");
		expect(() => ctx.store.transition(ctx.sessionId, "HandedOff", "resume", ctx.identity, NOW + 11)).toThrow(/illegal/);
		expect(ctx.store.get(ctx.sessionId)!.state).not.toBe("HandedOff");
	});

	test("sync failure prevents TODOsSynced and resume", () => {
		const ctx = setup();
		toPlanReady(ctx);
		const { todos } = { todos: ctx.store.get(ctx.sessionId)!.validatedTodos! };
		ctx.store.transition(ctx.sessionId, "Injecting", "injection started", ctx.identity, NOW + 10);
		ctx.store.transition(ctx.sessionId, "Injected", "injected", ctx.identity, NOW + 11);
		const before = JSON.stringify(readSession(ctx.dir, ctx.sessionId));
		const failed = syncValidatedTodos({
			store: ctx.store,
			sessionId: ctx.sessionId,
			identity: ctx.identity,
			todos,
			stateDir: ctx.dir,
			now: () => NOW + 12,
			update: () => {
				throw new Error("disk on fire");
			},
		});
		expect(failed.ok).toBe(false);
		expect(failed.error).toBe("disk on fire");
		expect(JSON.stringify(readSession(ctx.dir, ctx.sessionId))).toBe(before);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("Injected");
		expect(() => ctx.store.transition(ctx.sessionId, "HandedOff", "resume", ctx.identity, NOW + 13)).toThrow(/illegal/);
	});
});

describe("4 - empty / malformed / error / timeout: distinct, no injection/mutation, retry/dismiss", () => {
	test("empty uplifted prompt is rejected before any injection", async () => {
		const ctx = setup();
		const transcript = new TranscriptStore();
		const inj = injector(transcript, new ArtifactStore(), () => true);
		const before = JSON.stringify(readSession(ctx.dir, ctx.sessionId));
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, NOW + 1);
		ctx.store.setUpliftedPrompt(ctx.sessionId, ctx.identity, "   ");
		ctx.store.transition(ctx.sessionId, "Failed", "uplifted prompt is empty", ctx.identity, NOW + 2);
		expect(ctx.store.checkCompletion(ctx.store.get(ctx.sessionId)!).complete).toBe(false);
		expect(
			(await inj.inject({
				record: readSession(ctx.dir, ctx.sessionId),
				graphId: "ut-matrix",
				sessionId: ctx.sessionId,
				promptText: "",
				replaceKey: ctx.identity.invocationId,
				sessionKind: "direct",
			})).state,
		).toBe("queued");
		expect(transcript.list()).toHaveLength(0);
		expect(JSON.stringify(readSession(ctx.dir, ctx.sessionId))).toBe(before);
		expect(ctx.recorder.eventsOf("plan.rejected")).toHaveLength(1);
		expect(getFailureSurface(ctx.store.get(ctx.sessionId)!).retryable).toBe(true);
		expect(getFailureSurface(ctx.store.get(ctx.sessionId)!).dismissible).toBe(true);
		ctx.store.retry(ctx.sessionId, NOW + 3);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("Invoked");
	});

	test("malformed TODOs carry distinct schema errors and mutate nothing", () => {
		const errors = [
			validateTodoSnapshot([]).error,
			validateTodoSnapshot("nope").error,
			validateTodoSnapshot([{ content: "", status: "pending" }]).error,
			validateTodoSnapshot([{ content: "x", status: "bogus" }]).error,
			validateTodoSnapshot(["nope"]).error,
		];
		expect(new Set(errors).size).toBe(errors.length);
		for (const error of errors) expect(typeof error).toBe("string");
		const ctx = setup();
		const before = JSON.stringify(readSession(ctx.dir, ctx.sessionId));
		expect(() => ctx.store.setValidatedTodos(ctx.sessionId, ctx.identity, [{ content: "", status: "pending" }])).toThrow(/invalid todos/);
		expect(JSON.stringify(readSession(ctx.dir, ctx.sessionId))).toBe(before);
		expect(ctx.store.checkCompletion(ctx.store.get(ctx.sessionId)!).complete).toBe(false);
	});

	test("provider error lands Failed (distinct from TimedOut) with retry once then dismiss", () => {
		const ctx = setup();
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift", ctx.identity, NOW + 1);
		ctx.store.transition(ctx.sessionId, "Failed", "provider down", ctx.identity, NOW + 2);
		const surface = getFailureSurface(ctx.store.get(ctx.sessionId)!);
		expect(surface.state).toBe("Failed");
		expect(surface.reason).toBe("provider down");
		expect(surface.retryable).toBe(true);
		expect(surface.dismissible).toBe(true);
		ctx.store.retry(ctx.sessionId, NOW + 3);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("Invoked");
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift", ctx.identity, NOW + 4);
		ctx.store.transition(ctx.sessionId, "Failed", "provider down again", ctx.identity, NOW + 5);
		expect(getFailureSurface(ctx.store.get(ctx.sessionId)!).retryable).toBe(false);
		ctx.store.dismiss(ctx.sessionId, NOW + 6);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("Idle");
	});

	test("timeout via shortened timeoutMs (numeric fake clock) is TimedOut, gated until then, retryable", () => {
		const ctx = setup();
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, NOW + 1);
		ctx.store.transition(ctx.sessionId, "SwarmGated", "gated", ctx.identity, NOW + 2);
		expect(swarmDispatch(ctx.store, ctx.sessionId, NOW + 3)).toBe(false);
		expect(ctx.store.applyTimeout(ctx.sessionId, NOW + 100, 5000)).toBe(false);
		expect(ctx.store.applyTimeout(ctx.sessionId, NOW + 2 + 5000 + 1, 5000)).toBe(true);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("TimedOut");
		const surface = getFailureSurface(ctx.store.get(ctx.sessionId)!);
		expect(surface.state).toBe("TimedOut");
		expect(surface.retryable).toBe(true);
		expect(ctx.recorder.eventsOf("uplift.timeout")).toHaveLength(1);
		expect(ctx.recorder.eventsOf("plan.rejected")).toHaveLength(0);
		// No injection after timeout: the injector still queues behind the missing marker.
		expect(JSON.stringify(readSession(ctx.dir, ctx.sessionId))).not.toContain(ctx.identity.invocationId);
		ctx.store.retry(ctx.sessionId, NOW + 6000);
		expect(ctx.store.get(ctx.sessionId)!.state).toBe("Invoked");
		expect(ctx.store.get(ctx.sessionId)!.upliftedPrompt).toBeUndefined();
	});
});

describe("5 - transient injection failure: backoff, plan preserved, dedupe to one entry + one TODO batch", () => {
	test("first deliver round fails, retry with backoff succeeds once", async () => {
		const ctx = setup();
		toPlanReady(ctx);
		const todos = ctx.store.get(ctx.sessionId)!.validatedTodos as TodoSnapshotItem[];
		const transcript = new TranscriptStore();
		let calls = 0;
		const inj = new GatedFinalHopInjector({
			deterministic: () => {
				calls++;
				return calls >= 3;
			},
			out: () => false,
			artifacts: new ArtifactStore(),
			transcript,
		});
		ctx.store.transition(ctx.sessionId, "Injecting", "injection started", ctx.identity, NOW + 10);

		const backoffs: number[] = [];
		let result = await inj.inject({
			record: readSession(ctx.dir, ctx.sessionId),
			graphId: "ut-matrix",
			sessionId: ctx.sessionId,
			promptText: UPLIFTED,
			replaceKey: ctx.identity.invocationId,
			sessionKind: "managed",
		});
		while (result.state !== "injected") {
			const attempt = ctx.store.recordInjectionAttempt(ctx.sessionId, ctx.identity);
			backoffs.push(attempt.backoffMs);
			expect(attempt.budgetExceeded).toBe(false);
			// Fake-timer backoff: the computed delay is pinned, no real sleep.
			expect(injectionBackoffMs(attempt.attempt)).toBe(attempt.backoffMs);
			result = await inj.inject({
				record: readSession(ctx.dir, ctx.sessionId),
				graphId: "ut-matrix",
				sessionId: ctx.sessionId,
				promptText: UPLIFTED,
				replaceKey: ctx.identity.invocationId,
				sessionKind: "managed",
			});
		}
		expect(backoffs).toEqual([500, 1000]);
		// Plan preserved through the failure.
		expect(ctx.store.get(ctx.sessionId)!.upliftedPrompt).toBe(UPLIFTED);
		expect(ctx.store.get(ctx.sessionId)!.validatedTodos).toEqual(todos);
		ctx.store.transition(ctx.sessionId, "Injected", "injected after retry", ctx.identity, NOW + 11);
		expect(syncValidatedTodos({ store: ctx.store, sessionId: ctx.sessionId, identity: ctx.identity, todos, stateDir: ctx.dir, now: () => NOW + 12 }).ok).toBe(true);
		// Dedupe: one chat entry + one TODO batch even though delivery ran twice.
		expect(transcript.list().filter((e) => e.replaceKey === ctx.identity.invocationId)).toHaveLength(1);
		expect(readSession(ctx.dir, ctx.sessionId)!.recall!.lastTodos).toEqual(todos);
		const second = syncValidatedTodos({ store: ctx.store, sessionId: ctx.sessionId, identity: ctx.identity, todos, stateDir: ctx.dir, now: () => NOW + 13 });
		expect(second.ok).toBe(false);
		expect(second.error).toContain("ordering violation");
		expect(readSession(ctx.dir, ctx.sessionId)!.recall!.lastTodos).toEqual(todos);
	});
});

describe("6 - new input/second invocation: queued, epoch++, stale rejected", () => {
	test("queued input holds, second invocation supersedes, stale writes rejected", () => {
		const ctx = setup();
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, NOW + 1);
		expect(ctx.store.queueInput(ctx.sessionId, ctx.identity, "follow-up", NOW + 2)).toBe(1);
		expect(ctx.recorder.eventsOf("user_input.queued")).toHaveLength(1);
		expect(ctx.store.get(ctx.sessionId)!.queuedInputs).toEqual(["follow-up"]);
		expect(swarmDispatch(ctx.store, ctx.sessionId, NOW + 3)).toBe(false);

		const second = ctx.store.create(ctx.sessionId, "second input", NOW + 4);
		expect(second.epoch).toBe(2);
		expect(second.invocationId).not.toBe(ctx.identity.invocationId);
		expect(ctx.recorder.eventsOf("user_input.superseded")).toHaveLength(1);
		expect(ctx.recorder.eventsOf("user_input.superseded")[0]!.invocationId).toBe(ctx.identity.invocationId);
		const invoked = ctx.recorder.eventsOf("ultrathink.invoked");
		expect(invoked[invoked.length - 1]!.epoch).toBe(2);

		// Stale identity + epoch is rejected on every write path.
		expect(() => ctx.store.transition(ctx.sessionId, "UpliftPending", "stale", ctx.identity, NOW + 5)).toThrow(/stale/);
		expect(
			syncValidatedTodos({
				store: ctx.store,
				sessionId: ctx.sessionId,
				identity: ctx.identity,
				todos: [{ content: "stale", status: "pending" }],
				stateDir: ctx.dir,
				now: () => NOW + 5,
			}).ok,
		).toBe(false);
		expect(() => ctx.store.queueInput(ctx.sessionId, ctx.identity, "stale", NOW + 5)).toThrow(/stale/);

		// The new invocation gates again and queues independently.
		expect(swarmDispatch(ctx.store, ctx.sessionId, NOW + 6)).toBe(false);
		const secondIdentity = { invocationId: second.invocationId, epoch: second.epoch };
		expect(ctx.store.queueInput(ctx.sessionId, secondIdentity, "new follow-up", NOW + 6)).toBe(1);
	});

	test("empty uplift queue under a new magic-words invocation cancels the prior", () => {
		const ctx = setup();
		ctx.store.queueInput(ctx.sessionId, ctx.identity, "queued then superseded", NOW + 1);
		const second = ctx.store.create(ctx.sessionId, "new wording", NOW + 2);
		// The prior invocation object is the same registry slot: its queued input is not carried over.
		expect(second.queuedInputs).toEqual([]);
		expect(ctx.recorder.eventsOf("user_input.superseded")[0]!.to).toBe("Cancelled");
	});
});

describe("7 - accessibility: focus/history/aria-live preserved", () => {
	// Pinned here: the pending line's aria-live mode and single-line shape, and
	// the chat sync's history shape. Real keyboard traversal and DOM focus order
	// need a host browser E2E and are not unit-testable — see A11Y_CONTRACT in
	// src/track/observability.ts. What IS unit-testable is pinned below, and
	// chat-sync.test.ts pins the rendered card (rows at exactly render width).
	test("aria-live polite, one line, identity visible, history rows in plan order", () => {
		expect(PENDING_ARIA_LIVE).toBe("polite");
		const ctx = setup();
		ctx.store.transition(ctx.sessionId, "UpliftPending", "uplift started", ctx.identity, NOW + 1);
		const line = pendingStatusText(ctx.store.get(ctx.sessionId));
		expect(line).not.toContain("\n");
		expect(line).toContain("UpliftPending");
		expect(line).toContain(ctx.identity.invocationId);
		expect(line).toContain("epoch 1");
		for (const event of ctx.recorder.events) {
			expect(formatObservabilityEvent(event)).toContain(event.type);
		}
		const view = buildChatSyncView(PLAN_VIEW, { sessionId: ctx.sessionId, kind: "managed", syncDone: true });
		expect(view.rows.map((row) => row.node_id)).toEqual(["n1", "n2", "n3"]);
	});
});
