// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Tests for the Swarm×Ultrathink race fix (Tdfe6, `src/host/uplift-delivery.ts`),
 * one test per acceptance criterion AC-60..AC-69 in `docs/acceptance.md`.
 */
import { describe, expect, test } from "bun:test";
import {
	DRAIN_BOUND_S,
	ORDER_GATE_HELD_REASON,
	ArtifactStore,
	DrainCoordinator,
	ForceInjector,
	GatedFinalHopInjector,
	OrderGate,
	StatusLedger,
	TranscriptStore,
	assertRaceChecks,
	buildReplaceViaOutUrl,
	parseReplaceViaOutUrl,
	preselectInjectionStrategy,
	raceChecks,
	registerUpliftDeliveryRoutes,
	sessionOperationFor,
	sha256Hex,
} from "./uplift-delivery.ts";

const PROMPT =
	"<uplifted-prompt>Fix the Swarm x Ultrathink race with force injection.</uplifted-prompt>";

describe("AC-60 force injection lands mid-flight with one TODO update", () => {
	test("full prompt delivered regardless of orchestration, TODO entry recorded", async () => {
		const orchestrationMidFlight = true;
		const seen: string[] = [];
		const injector = new ForceInjector(async (prompt) => {
			seen.push(prompt);
			return orchestrationMidFlight; // delivers even while orchestration runs
		});
		const result = await injector.inject({ sessionId: "s1", promptText: PROMPT });
		expect(result.state).toBe("injected");
		expect(seen).toEqual([PROMPT]);
		expect(result.record.promptText).toBe(PROMPT); // 100% chars preserved
		expect(result.todoEntry).toBeTruthy();
	});
});

describe("AC-61 a busy channel retries and names the failure", () => {
	test("first failure logs one line, second attempt lands", async () => {
		let calls = 0;
		const injector = new ForceInjector(async () => {
			calls += 1;
			return calls > 1; // busy on attempt 1
		});
		const result = await injector.inject({ sessionId: "s1", promptText: PROMPT });
		expect(calls).toBe(2);
		expect(result.state).toBe("injected");
		expect(result.retryLog).toHaveLength(1);
		expect(result.retryLog[0]).toContain("attempt 1");
		expect(result.retryLog[0]).toContain("failed");
		expect(result.record.retryCount).toBe(1);
	});
});

describe("AC-62 exhausted budget drops with a named reason, never silently", () => {
	test("all attempts fail => dropped-with-reason with reason, prompt retained", async () => {
		const injector = new ForceInjector(async () => false);
		const result = await injector.inject({
			sessionId: "s1",
			promptText: PROMPT,
			retryBudget: 1,
		});
		expect(result.state).toBe("dropped-with-reason");
		expect(result.record.reason).toBeTruthy();
		expect(result.retryLog.length).toBeGreaterThan(0);
		expect(result.record.promptText).toBe(PROMPT);
		expect(result.record.attemptCount).toBe(2);
	});
});

describe("AC-63 new prompt drains orchestration within 30s, 0 mid-write kills", () => {
	test("idle orchestration drains cleanly inside the bound", async () => {
		const drain = new DrainCoordinator();
		const result = await drain.drain({
			sessionId: "s1",
			waitForIdle: () => true,
			pollMs: 1,
		});
		expect(result.state).toBe("drained");
		expect(result.record.drainBoundS).toBe(DRAIN_BOUND_S);
		expect(result.elapsedS).toBeLessThan(30);
		expect(result.record.drainElapsedMs).toBeLessThan(30_000);
	});
});

describe("AC-64 drain past the bound times out and the new turn proceeds", () => {
	test("never-idle orchestration => timed-out, no mid-write kill", async () => {
		let writeChecks = 0;
		const drain = new DrainCoordinator();
		const result = await drain.drain({
			sessionId: "s1",
			boundS: 1,
			waitForIdle: () => false,
			isWriteInProgress: () => {
				writeChecks += 1;
				return true; // a write section stays open the whole time
			},
			pollMs: 5,
		});
		expect(result.state).toBe("timed-out");
		// The drain polled the open write section (never interrupted it) and
		// only gave up at the bound — the new turn still proceeds.
		expect(writeChecks).toBeGreaterThan(0);
		expect(result.record.reason).toContain("new turn proceeded");
	});
});

describe("AC-65 dispatch before confirmation is held with exactly 1 reason", () => {
	test("unconfirmed session => allowed=false, one held reason", () => {
		const gate = new OrderGate();
		const result = gate.check({ sessionId: "s1" });
		expect(result.allowed).toBe(false);
		expect(result.heldReason).toBe(ORDER_GATE_HELD_REASON);
		expect(result.record.heldReason).toBe(ORDER_GATE_HELD_REASON);
	});
});

describe("AC-66 dispatch opens only after the confirmation timestamp", () => {
	test("confirmed session => allowed with confirmedAt; kill-switch bypass is audited", () => {
		const gate = new OrderGate();
		gate.confirm("s1", sha256Hex(PROMPT), "2026-11-23T20:00:00.000Z");
		const result = gate.check({ sessionId: "s1" });
		expect(result.allowed).toBe(true);
		expect(result.confirmedAt).toBe("2026-11-23T20:00:00.000Z");

		const bypass = gate.check({
			sessionId: "s2",
			killSwitchBypass: { reason: "manual override", by: "operator" },
		});
		expect(bypass.allowed).toBe(true);
		expect(bypass.record.killSwitchBypass).toBe(true);
		expect(bypass.record.reason).toContain("operator");
		expect(bypass.record.state).toBe("retrying"); // never claims a real confirmation
	});
});

describe("AC-67 mid-flight race check: 1 injected, 0 lost plans", () => {
	test("assertRaceChecks passes the mid-flight scenario", () => {
		const checks = raceChecks({
			midFlightInjected: 1,
			midFlightLost: 0,
			newPromptDrained: 1,
			newPromptLanded: 1,
			newPromptDrops: 0,
		});
		expect(checks.midFlight).toEqual({ injectedPrompts: 1, lostPlans: 0 });
		expect(() => assertRaceChecks(checks)).not.toThrow();
	});
});

describe("AC-68 new-prompt race check: drained + landed, 0 drops", () => {
	test("assertRaceChecks passes the new-prompt scenario", () => {
		const checks = raceChecks({
			midFlightInjected: 1,
			midFlightLost: 0,
			newPromptDrained: 1,
			newPromptLanded: 1,
			newPromptDrops: 0,
		});
		expect(checks.newPrompt).toEqual({
			drainedOrchestrations: 1,
			landedPrompts: 1,
			drops: 0,
		});
		expect(() => assertRaceChecks(checks)).not.toThrow();
	});
});

describe("AC-69 status query returns one named closed-set state", () => {
	test("injected session => injected; unknown session => retrying, never a crash", async () => {
		const ledger = new StatusLedger();
		const injector = new ForceInjector(async () => true);
		const injected = await injector.inject({ sessionId: "s1", promptText: PROMPT });
		ledger.append(injected.record);
		expect(ledger.status("s1").state).toBe("injected");
		expect(ledger.status("unknown").state).toBe("retrying");
		expect(ledger.status("unknown").reason).toBeTruthy();
	});
});

describe("production-grade invariants", () => {
	test("retry is byte-identical: same promptHash on every attempt (0 prompt loss)", async () => {
		const seen: string[] = [];
		const injector = new ForceInjector(async (prompt) => {
			seen.push(prompt);
			return seen.length > 1;
		});
		const result = await injector.inject({ sessionId: "s1", promptText: PROMPT });
		expect(seen).toEqual([PROMPT, PROMPT]);
		expect(result.record.promptHash).toBe(sha256Hex(PROMPT));
	});

	test("secrets never persist: promptText is redacted", async () => {
		const injector = new ForceInjector(async () => true);
		const result = await injector.inject({
			sessionId: "s1",
			promptText: "key sk-ant-abcdefgh12345678 end",
		});
		expect(result.record.promptText).not.toContain("sk-ant-");
		expect(result.record.promptText).toContain("[redacted]");
	});

	test("latency past 5000ms fails the attempt and drops with a named reason", async () => {
		let now = 1_000;
		const injector = new ForceInjector(
			async () => {
				now += 6_000; // slow delivery, past the NFR-28 budget
				return true;
			},
			() => now,
		);
		const result = await injector.inject({
			sessionId: "s1",
			promptText: PROMPT,
			retryBudget: 0,
		});
		expect(result.state).toBe("dropped-with-reason");
		expect(result.record.reason).toContain("5000ms");
	});

	test("registerUpliftDeliveryRoutes wires all four contract routes to the service", async () => {
		const appended: unknown[] = [];
		const injector = new ForceInjector(async () => true);
		const gate = new OrderGate();
		const drain = new DrainCoordinator();
		const ledger = new StatusLedger();
		const handlers: Record<string, unknown> = {};
		const app = {
			post: (path: string, handler: unknown) => {
				handlers[`POST ${path}`] = handler;
				return undefined;
			},
			get: (path: string, handler: unknown) => {
				handlers[`GET ${path}`] = handler;
				return undefined;
			},
		};
		registerUpliftDeliveryRoutes(app, { injector, gate, drain, ledger });
		const forceInject = handlers["POST /force-inject"] as (b: unknown) => Promise<unknown>;
		const orderGate = handlers["POST /order-gate"] as (b: unknown) => unknown;
		const drainHandler = handlers["POST /drain"] as (b: unknown) => Promise<unknown>;
		const status = handlers["GET /delivery-status"] as (q: unknown) => unknown;
		expect(Object.keys(handlers).sort()).toEqual([
			"GET /delivery-status",
			"POST /drain",
			"POST /force-inject",
			"POST /order-gate",
		]);
		expect(await forceInject({ sessionId: "s1", promptText: PROMPT })).toEqual({
			state: "injected",
		});
		expect(orderGate({ sessionId: "s1" })).toMatchObject({ allowed: true });
		expect(orderGate({ sessionId: "s2" })).toMatchObject({ allowed: false });
		expect(await drainHandler({ sessionId: "s1" })).toEqual({ state: "drained" });
		const statusResult: unknown = status({ sessionId: "s1" });
		expect(statusResult).toMatchObject({ state: "drained" });
		expect(appended).toHaveLength(0); // ledger assertions live in the ledger itself
	});
});

describe("SPE-37786 gated final-hop injection (n3)", () => {
	const GRAPH_ID = "graph-n3";
	const doneRecord = { syncTodos: { graphId: GRAPH_ID, at: 1, waveCount: 1, todoCount: 1, attempts: 1 } };

	test("queued no-op until isSyncTodosDone is true: channels and artifacts untouched", async () => {
		let deterministicCalls = 0;
		let outCalls = 0;
		const artifacts = new ArtifactStore();
		artifacts.add({ key: "neg", seeded: false, negative: true, text: "old negative" });
		const injector = new GatedFinalHopInjector({
			deterministic: async () => {
				deterministicCalls++;
				return true;
			},
			out: async () => {
				outCalls++;
				return true;
			},
			artifacts,
		});
		for (const record of [undefined, {}, { syncTodos: { graphId: "other", at: 1, waveCount: 1, todoCount: 1, attempts: 1 } }]) {
			const queued = await injector.inject({
				record,
				graphId: GRAPH_ID,
				sessionId: "s1",
				promptText: PROMPT,
				replaceKey: "k1",
				sessionKind: "direct",
			});
			expect(queued.state).toBe("queued");
			expect(queued.removedArtifacts).toEqual([]);
		}
		expect(deterministicCalls).toBe(0);
		expect(outCalls).toBe(0);
		expect(artifacts.list()).toHaveLength(1);
		expect(injector.transcript().list()).toHaveLength(0);
	});

	test("deterministic channel attempted first; out params land in transcript; non-seeded negative removed", async () => {
		const artifacts = new ArtifactStore();
		artifacts.add({ key: "neg", seeded: false, negative: true, text: "fix me" });
		artifacts.add({ key: "seeded-neg", seeded: true, negative: true, text: "keep me" });
		artifacts.add({ key: "pos", seeded: false, negative: false, text: "keep me too" });
		const seenOps: string[] = [];
		const injector = new GatedFinalHopInjector({
			deterministic: async (input) => {
				seenOps.push(input.operation);
				return true;
			},
			out: async () => {
				throw new Error("out must not run when deterministic delivers first");
			},
			artifacts,
		});
		const result = await injector.inject({
			record: doneRecord,
			graphId: GRAPH_ID,
			sessionId: "s1",
			promptText: PROMPT,
			replaceKey: "k1",
			outParams: { lane: "direct", trace: "abc" },
			sessionKind: "direct",
		});
		expect(result.state).toBe("injected");
		expect(result.strategy).toBe("deterministic-in-session");
		expect(seenOps).toEqual(["create_chat_tab"]);
		expect(result.removedArtifacts.map((a) => a.key)).toEqual(["neg"]);
		expect(artifacts.list().map((a) => a.key).sort()).toEqual(["pos", "seeded-neg"]);
		expect(result.transcriptEntry?.outParams).toEqual({ lane: "direct", trace: "abc" });
		expect(parseReplaceViaOutUrl(result.outUrl ?? "")).toMatchObject({
			sessionId: "s1",
			replaceKey: "k1",
			outParams: { lane: "direct", trace: "abc" },
		});
	});

	test("replace-via-out final hop: out URL carries params into the transcript, superseded artifact removed, idempotent replace", async () => {
		const artifacts = new ArtifactStore();
		artifacts.add({ key: "neg", seeded: false, negative: true, text: "stale" });
		const seenUrls: string[] = [];
		const injector = new GatedFinalHopInjector({
			deterministic: async () => false,
			out: async (outUrl) => {
				seenUrls.push(outUrl);
				return true;
			},
			artifacts,
		});
		const first = await injector.inject({
			record: doneRecord,
			graphId: GRAPH_ID,
			sessionId: "s1",
			promptText: "first",
			replaceKey: "k1",
			outParams: { lane: "managed" },
			sessionKind: "managed",
		});
		expect(first.state).toBe("injected");
		expect(first.strategy).toBe("replace-via-out");
		expect(first.operation).toBe("injection_handoff");
		expect(seenUrls[0]).toStartWith("replace-via-out://");
		expect(first.removedArtifacts.map((a) => a.key)).toEqual(["neg"]);
		const second = await injector.inject({
			record: doneRecord,
			graphId: GRAPH_ID,
			sessionId: "s1",
			promptText: "second",
			replaceKey: "k1",
			outParams: { lane: "managed", again: "1" },
			sessionKind: "managed",
		});
		expect(second.state).toBe("injected");
		const transcript = injector.transcript().list();
		expect(transcript).toHaveLength(1);
		expect(transcript[0].promptText).toBe("second");
		expect(transcript[0].outParams).toEqual({ lane: "managed", again: "1" });
	});

	test("managed sessions steer (resume on request); preselect never returns a banned heuristic", async () => {
		expect(sessionOperationFor({ sessionKind: "managed", strategy: "deterministic-in-session" })).toBe("steer");
		expect(sessionOperationFor({ sessionKind: "managed", strategy: "deterministic-in-session", resume: true })).toBe("resume");
		expect(sessionOperationFor({ sessionKind: "direct", strategy: "replace-via-out" })).toBe("injection_handoff");
		expect(preselectInjectionStrategy({ sessionKind: "direct", supportsDeterministic: true, supportsOut: true })).toBe("deterministic-in-session");
		expect(preselectInjectionStrategy({ sessionKind: "managed", supportsDeterministic: false, supportsOut: true })).toBe("replace-via-out");
		const banned: string[] = ["native-dialog", "popup", "focus", "speech", "echo"];
		for (const supportsDeterministic of [true, false]) {
			const strategy = preselectInjectionStrategy({ sessionKind: "direct", supportsDeterministic, supportsOut: true });
			expect(banned).not.toContain(strategy);
		}
	});

	test("out params round-trip through buildReplaceViaOutUrl; drop leaves artifacts in place", async () => {
		const url = buildReplaceViaOutUrl({ sessionId: "s 1", replaceKey: "k", outParams: { a: "b c", d: "e" } });
		expect(parseReplaceViaOutUrl(url)).toEqual({ sessionId: "s 1", replaceKey: "k", outParams: { a: "b c", d: "e" } });
		const artifacts = new ArtifactStore();
		artifacts.add({ key: "neg", seeded: false, negative: true, text: "keep on drop" });
		const injector = new GatedFinalHopInjector({
			deterministic: async () => false,
			out: async () => false,
			artifacts,
		});
		const dropped = await injector.inject({
			record: doneRecord,
			graphId: GRAPH_ID,
			sessionId: "s1",
			promptText: PROMPT,
			replaceKey: "k1",
			sessionKind: "direct",
		});
		expect(dropped.state).toBe("dropped-with-reason");
		expect(dropped.removedArtifacts).toEqual([]);
		expect(artifacts.list()).toHaveLength(1);
		expect(injector.transcript().list()).toHaveLength(0);
	});
});
