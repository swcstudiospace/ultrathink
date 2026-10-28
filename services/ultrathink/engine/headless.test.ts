// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeCompleter } from "../../../src/claude/complete.ts";
import { readSession, writeSession } from "../../../src/claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../../../src/config.ts";
import { stageOf } from "../../../src/host/grokbot.ts";
import { planPrompt } from "../../../src/host/plan.ts";
import { redactText } from "../../../src/teach/redact.ts";
import { NODE, UPLIFT } from "../../../src/test.helpers.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "../../../src/think/prompts.ts";
import { FALLBACK_GRAPH } from "../../../src/think/types.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../../../src/uplift/prompt.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { createLedger } from "../cost/ledger.ts";
import { type RequestContext, runWithRequestContext } from "../obs/context.ts";
import type { Admission } from "../obs/fair-share.ts";
import type { FinishedSpan, SpanSink } from "../obs/otel.ts";
import { openStore, type Store } from "../store/store.ts";
import { createCircuitBreaker } from "./breaker.ts";
import {
	createHeadlessPlanner,
	type HeadlessOptions,
	type HeadlessPlanner,
	type PlannerCall,
	UNPERSISTED_JOBS_MAX,
} from "./headless.ts";
import { answerRequest, listPendingRequests, showRequest, startPlan } from "./journal.ts";
import {
	type PlanBackend,
	type PlanCallHooks,
	PlanCompleterError,
	type PlanErrorCode,
	type PlanUsage,
} from "./plan.ts";

const PROMPT =
	"Build a small TypeScript CLI that converts CSV files to JSON with streaming support, tests and a README.";
const FAKE_KEY = "sk-fake-key-0123456789abcdef";
const dirs: string[] = [];
const stores: Store[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-headless-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// reason: already closed
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GRAPH = JSON.stringify({
	goal: "Ship a streaming CSV to JSON CLI",
	nodes: [
		{
			id: "n1",
			title: "Understand the request",
			kind: "understand",
			question: "What exactly must the CLI do?",
			depends_on: [],
		},
		{
			id: "n2",
			title: "Parser design",
			kind: "decompose",
			question: "How is CSV parsed as a stream?",
			depends_on: ["n1"],
		},
		{
			id: "n3",
			title: "CLI surface",
			kind: "generate",
			question: "What flags and outputs does the CLI expose?",
			depends_on: ["n1"],
		},
		{
			id: "n4",
			title: "Gaps and risks",
			kind: "critique",
			question: "What is missing or ambiguous?",
			depends_on: ["n2", "n3"],
		},
		{
			id: "n5",
			title: "Execution plan",
			kind: "synthesize",
			question: "What is the ordered wave plan?",
			depends_on: ["n4"],
		},
	],
});

const CLARIFY = JSON.stringify({
	questions: [
		{
			id: "q1",
			question: "Should output be a JSON array or JSON lines?",
			header: "Output",
			why: "Changes the writer.",
			options: [
				{ label: "JSON array", description: "Standard" },
				{ label: "JSON lines", description: "Streamable" },
			],
			default: "JSON array",
			blocking: false,
		},
	],
});

/** The scripted model: answers each plugin request by its system prompt. */
function scriptedModel(): (system: string, user: string) => string {
	return (system, user) => {
		if (system === UPLIFT_SYSTEM_PROMPT) return UPLIFT(PROMPT);
		if (system === GRAPH_SYSTEM_PROMPT) return GRAPH;
		if (system === COT_SYSTEM_PROMPT) {
			const match = user.match(/<current_node id="([^"]+)" kind="([^"]+)"/);
			return NODE(match?.[1] ?? "n?", match?.[2] ?? "generate", 8);
		}
		if (stageOf(system) === "clarify") return CLARIFY;
		throw new Error(`unexpected request: ${system.slice(0, 40)}`);
	};
}

const aborted = (signal: AbortSignal): Promise<never> => {
	const { promise, reject } = Promise.withResolvers<never>();
	if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
	signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
		once: true,
	});
	return promise;
};

/** A fake completer; with a gate, every call waits for it (and, by default, for the plan's abort). */
function fakeModel(gate?: Promise<void>, honorAbort = true) {
	const script = scriptedModel();
	const stages: string[] = [];
	const firstCall = Promise.withResolvers<void>();
	const complete: ClaudeCompleter = async (system, user, signal) => {
		stages.push(stageOf(system));
		firstCall.resolve();
		if (gate) await (honorAbort && signal ? Promise.race([gate, aborted(signal)]) : gate);
		return script(system, user);
	};
	return { complete, stages, firstCall: firstCall.promise };
}

interface FakeClock {
	waits: Array<{ ms: number; resolve: () => void }>;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	fire: (ms: number) => void;
	has: (ms: number) => boolean;
}

/** Fake sleeps that only end when the test fires them or their signal aborts. */
function fakeClock(): FakeClock {
	const waits: FakeClock["waits"] = [];
	return {
		waits,
		sleep: (ms, signal) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (signal?.aborted) return Promise.resolve();
			waits.push({ ms, resolve });
			signal?.addEventListener("abort", () => resolve(), { once: true });
			return promise;
		},
		fire(ms) {
			for (const wait of waits) if (wait.ms === ms) wait.resolve();
		},
		has: (ms) => waits.some((wait) => wait.ms === ms),
	};
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 6; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
};

interface Harness {
	planner: HeadlessPlanner;
	config: UltrathinkConfig;
	stateDir: string;
	store: Store;
	clock: FakeClock;
}

function setup(
	overrides: Partial<UltrathinkConfig> = {},
	options: Partial<HeadlessOptions> = {},
): Harness {
	const stateDir = join(tmp(), "state");
	const config: UltrathinkConfig = {
		publicOrigin: "https://ultrathink.example.test",
		ownerPasswordHash: "fake-hash",
		sessionSecret: "s".repeat(32),
		stateDir,
		dbPath: join(stateDir, "ultrathink.sqlite"),
		port: 0,
		maxInputChars: 8000,
		maxAnswerChars: 20000,
		maxBodyBytes: 65536,
		runTokenCeiling: 5_000_000,
		dailyTokenCeiling: 50_000_000,
		planningModel: "claude-haiku-5-5",
		connectorKey: undefined,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		serverPlanning: true,
		legacyEnvIgnored: [],
		maxConcurrentPlans: 2,
		modelTimeoutMs: 5000,
		planTimeoutMs: 60_000,
		modelMaxOutputTokens: 1000,
		sessionSecretPrevious: [],
		breakerFailures: 5,
		breakerWindowMs: 60000,
		breakerOpenMs: 30000,
		maxInflight: 256,
		drainMs: 5000,
		retentionDays: 30,
		auditLog: true,
		auditAnchorEvery: 1000,
		auditSegmentBytes: 67108864,
		auditRetentionDays: 365,
		auditWatchMs: 1000,
		auditSinkQueue: 10000,
		priorityReservePct: 25,
		fairQueueDepth: 16,
		fairQueueWaitMs: 1500,
		adaptiveQuotaMinPct: 50,
		lagTargetMs: 100,
		replicaCapacityRps: 20,
		abuseFailuresPerMinute: 20,
		penaltyBaseSec: 60,
		penaltyMaxSec: 3600,
		tls: undefined,
		spiffeTrustDomain: "ultrathink.internal",
		plaintextLoopback: true,
		chaosEnabled: false,
		...overrides,
	};
	const store = openStore(config.dbPath);
	stores.push(store);
	const ledger = createLedger(store, {
		runTokenCeiling: config.runTokenCeiling,
		dailyTokenCeiling: config.dailyTokenCeiling,
	});
	const clock = fakeClock();
	const planner = createHeadlessPlanner({
		config,
		store,
		ledger,
		sleep: clock.sleep,
		completer: fakeModel().complete,
		...options,
	});
	return { planner, config, stateDir, store, clock };
}

const jobFile = (stateDir: string, sessionId: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(stateDir, "jobs", `${sessionId}.json`), "utf8")) as Record<
		string,
		unknown
	>;

/** Starts a job that waits for the gate, leaving it running after the start window. */
async function startRunning(h: Harness, sessionId: string, prompt = PROMPT) {
	const started = h.planner.start({ prompt, sessionId });
	await flush();
	h.clock.fire(15_000);
	return started;
}

describe("headless planner: start and result", () => {
	test("start reports running, result long-polls to the finished plan, and job state is private", async () => {
		const gate = Promise.withResolvers<void>();
		const model = fakeModel(gate.promise);
		const h = setup({}, { completer: model.complete });
		const sessionId = randomUUID();
		const started = await startRunning(h, sessionId);
		expect(started).toEqual({
			ok: true,
			data: { sessionId, status: "running", pollAfterSec: expect.any(Number) },
		});

		const pending = h.planner.result({ sessionId, waitSeconds: 30 });
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await flush();
		expect(h.clock.has(30_000)).toBe(true);
		expect(settled).toBe(false);
		gate.resolve();
		const result = await pending;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toMatchObject({ sessionId, status: "planned", mode: "server" });
		expect(result.data.text).toContain(PROMPT);
		expect(result.data.text).not.toMatch(/TodoWrite|Linear|Notion/);
		expect(result.data.usage?.calls).toBeGreaterThanOrEqual(8);
		expect(result.data.questions?.[0]?.question).toContain("JSON");
		expect(h.planner.status({ sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "planned", pendingCount: 0, pending: [] },
		});

		const file = join(h.stateDir, "jobs", `${sessionId}.json`);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "planned",
			usage: { calls: result.data.usage?.calls },
		});
		const runId = String(jobFile(h.stateDir, sessionId).runId);
		const ledger = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 });
		expect(ledger.spentForRun(runId)).toBeGreaterThan(0);
		expect(readdirSync(join(h.stateDir, "jobs")).filter((name) => name.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	test("start returns planned directly when the plan finishes inside the start window", async () => {
		const h = setup();
		const sessionId = randomUUID();
		const started = await h.planner.start({ prompt: PROMPT, sessionId });
		expect(started).toEqual({ ok: true, data: { sessionId, status: "planned" } });
		const detail = await h.planner.result({ sessionId, detail: "full", waitSeconds: 0 });
		expect(detail).toMatchObject({ ok: true, data: { status: "planned", mode: "server" } });
	});

	test("generates a session id when none is given", async () => {
		const h = setup();
		const started = await h.planner.start({ prompt: PROMPT });
		expect(started.ok).toBe(true);
		if (started.ok)
			expect(started.data.sessionId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
	});

	test("a repeated start is idempotent: no second job, no second model call", async () => {
		const model = fakeModel();
		const h = setup({}, { completer: model.complete });
		const sessionId = randomUUID();
		const first = await h.planner.start({ prompt: PROMPT, sessionId });
		const calls = model.stages.length;
		const again = await h.planner.start({ prompt: `  ${PROMPT}\u0007 `, sessionId });
		expect(again).toEqual(first);
		expect(model.stages.length).toBe(calls);
	});

	test("a repeated start while running joins the running job", async () => {
		const gate = Promise.withResolvers<void>();
		const model = fakeModel(gate.promise);
		const h = setup({}, { completer: model.complete });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);
		// The running job reaches the model on its own schedule; count only once it has, so a
		// slow runner cannot credit the first job's call to the repeated start.
		await model.firstCall;
		const calls = model.stages.length;
		const again = h.planner.start({ prompt: PROMPT, sessionId });
		await flush();
		h.clock.fire(15_000);
		expect(await again).toMatchObject({ ok: true, data: { sessionId, status: "running" } });
		expect(model.stages.length).toBe(calls);
		gate.resolve();
		expect(await h.planner.result({ sessionId, waitSeconds: 30 })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
	});

	test("the same session id with a different prompt is session_conflict, also across restarts", async () => {
		const h = setup();
		const sessionId = randomUUID();
		await h.planner.start({ prompt: PROMPT, sessionId });
		expect(await h.planner.start({ prompt: `${PROMPT} Also add a man page.`, sessionId })).toEqual({
			ok: false,
			code: "session_conflict",
		});
		const reborn = createHeadlessPlanner({
			config: h.config,
			store: h.store,
			ledger: createLedger(h.store, { runTokenCeiling: 1e9, dailyTokenCeiling: 1e9 }),
			sleep: h.clock.sleep,
			completer: fakeModel().complete,
		});
		expect(await reborn.start({ prompt: "Something else entirely", sessionId })).toEqual({
			ok: false,
			code: "session_conflict",
		});
		expect(await reborn.start({ prompt: PROMPT, sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "planned" },
		});
	});

	test("a session id that belongs to the client-driven loop is session_conflict", async () => {
		const h = setup();
		const sessionId = randomUUID();
		const o = { stateDir: h.stateDir, maxPromptChars: 4000, maxAnswerChars: 200_000 };
		expect((await startPlan(o, { prompt: PROMPT, sessionId })).ok).toBe(true);
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toEqual({
			ok: false,
			code: "session_conflict",
		});
	});

	test("busy at the concurrency cap, and free again once a job ends", async () => {
		const gate = Promise.withResolvers<void>();
		const model = fakeModel(gate.promise);
		const h = setup({ maxConcurrentPlans: 1 }, { completer: model.complete });
		const first = randomUUID();
		await startRunning(h, first);
		expect(await h.planner.start({ prompt: PROMPT, sessionId: randomUUID() })).toEqual({
			ok: false,
			code: "busy",
		});
		gate.resolve();
		await h.planner.result({ sessionId: first, waitSeconds: 30 });
		expect(await h.planner.start({ prompt: PROMPT, sessionId: randomUUID() })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
	});

	test("disabled when server planning is off, not_ready while the plan backend is not ready", async () => {
		const off = setup({ serverPlanning: false });
		expect(off.planner.enabled).toBe(false);
		expect(await off.planner.start({ prompt: PROMPT })).toEqual({ ok: false, code: "disabled" });
		const fake = fakeBackend();
		fake.setReady({ ok: false, detail: "claude CLI not found" });
		const unready = setup({}, { completer: undefined, planBackend: fake.backend });
		expect(unready.planner.enabled).toBe(true);
		expect(await unready.planner.start({ prompt: PROMPT })).toEqual({
			ok: false,
			code: "not_ready",
		});
	});

	test("rejects invalid ids, prompts and result arguments", async () => {
		const h = setup({ maxInputChars: 100 });
		expect(await h.planner.start({ prompt: PROMPT, sessionId: "nope" })).toEqual({
			ok: false,
			code: "invalid_session_id",
		});
		expect(await h.planner.start({ prompt: PROMPT, sessionId: 7 })).toEqual({
			ok: false,
			code: "invalid_session_id",
		});
		expect(await h.planner.start({ prompt: 42 })).toEqual({ ok: false, code: "invalid_input" });
		expect(await h.planner.start({ prompt: " \u0001\n\t " })).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(await h.planner.start({ prompt: "x".repeat(101) })).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(await h.planner.result({ sessionId: "nope" })).toEqual({
			ok: false,
			code: "invalid_session_id",
		});
		const sessionId = randomUUID();
		expect(await h.planner.result({ sessionId, waitSeconds: "5" })).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(await h.planner.result({ sessionId, detail: "everything" })).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toEqual({
			ok: false,
			code: "not_found",
		});
		expect(h.planner.status({ sessionId: "nope" })).toBeNull();
		expect(h.planner.status({ sessionId })).toBeNull();
	});

	test("a short explicit request still plans, and a declined one is skipped with a reason", async () => {
		const model = fakeModel();
		const h = setup({}, { completer: model.complete });
		await h.planner.start({ prompt: "ok" });
		expect(model.stages[0]).toBe("uplift");

		const declined = fakeModel();
		const g = setup({}, { completer: declined.complete });
		const sessionId = randomUUID();
		const started = await g.planner.start({ prompt: "raw: leave this alone", sessionId });
		expect(started).toMatchObject({
			ok: true,
			data: { sessionId, status: "skipped", error: expect.any(String) },
		});
		expect(declined.stages).toEqual([]);
		const result = await g.planner.result({ sessionId, waitSeconds: 0 });
		expect(result).toMatchObject({
			ok: true,
			data: {
				status: "skipped",
				mode: "server",
				text: expect.any(String),
				error: expect.any(String),
			},
		});
	});
});

describe("headless planner: limits and lifecycle", () => {
	test("the run and the daily ceiling end the job as budget_exceeded before any model call", async () => {
		for (const ceiling of [{ runTokenCeiling: 100 }, { dailyTokenCeiling: 100 }]) {
			const model = fakeModel();
			const h = setup(ceiling, { completer: model.complete });
			const sessionId = randomUUID();
			const started = await h.planner.start({ prompt: PROMPT, sessionId });
			expect(started).toEqual({
				ok: true,
				data: { sessionId, status: "failed", error: "budget_exceeded" },
			});
			expect(model.stages).toEqual([]);
			expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toMatchObject({
				ok: true,
				data: { status: "failed", error: "budget_exceeded" },
			});
			expect(jobFile(h.stateDir, sessionId)).toMatchObject({
				status: "failed",
				error: "budget_exceeded",
			});
		}
	});

	test("with output cap 0, a run ceiling with no headroom for the input refuses before any model call", async () => {
		let requests = 0;
		const counting: ClaudeCompleter = async () => {
			requests += 1;
			return "unreachable";
		};
		const h = setup({ runTokenCeiling: 10, modelMaxOutputTokens: 0 }, { completer: counting });
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "failed", error: "budget_exceeded" },
		});
		expect(requests).toBe(0);
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "failed",
			error: "budget_exceeded",
		});
	});

	test("a response without usage, or with only some counts, keeps the estimate in the ledger so the ceiling still ends the job", async () => {
		const shapes: PlanUsage[][] = [[], [{ promptTokens: 10 }], [{ completionTokens: 5 }]];
		for (const reports of shapes) {
			const fake = fakeBackend(undefined, { reports });
			const h = setup(
				{ runTokenCeiling: 6000 },
				{ completer: undefined, planBackend: fake.backend },
			);
			const sessionId = randomUUID();
			const started = await h.planner.start({ prompt: PROMPT, sessionId });
			expect(started).toEqual({
				ok: true,
				data: { sessionId, status: "failed", error: "budget_exceeded" },
			});
			const seen = fake.stages.length;
			// A plan needs at least eight calls; zero-settled calls would have let them all through.
			expect(seen).toBeGreaterThanOrEqual(1);
			expect(seen).toBeLessThan(8);
			const runId = String(jobFile(h.stateDir, sessionId).runId);
			const spent = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 }).spentForRun(
				runId,
			);
			// Each call held at least its max output tokens (1000) and none was settled to zero.
			expect(spent).toBeGreaterThanOrEqual(1000 * seen);
			expect(spent).toBeLessThanOrEqual(6000);
		}
	});

	test("the plan timeout aborts the job", async () => {
		const gate = Promise.withResolvers<void>();
		const model = fakeModel(gate.promise);
		const h = setup({ planTimeoutMs: 60_000 }, { completer: model.complete });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);
		// The job has reached the model once its first stage is recorded; await that event, not a timer.
		await model.firstCall;
		h.clock.fire(60_000);
		const result = await h.planner.result({ sessionId, waitSeconds: 30 });
		expect(result).toMatchObject({ ok: true, data: { status: "failed", error: "timeout" } });
	});

	test("an engine failure ends the job as failed with the code, never the response body", async () => {
		const failing = fakeBackend(
			new PlanCompleterError("auth", "auth", new Error("secret upstream body")),
		);
		const h = setup({}, { completer: undefined, planBackend: failing.backend });
		const sessionId = randomUUID();
		const started = await h.planner.start({ prompt: PROMPT, sessionId });
		expect(started).toEqual({ ok: true, data: { sessionId, status: "failed", error: "auth" } });
		expect(JSON.stringify(jobFile(h.stateDir, sessionId))).not.toContain("secret upstream body");
	});

	test("an engine error mid-run does not fail a plan whose record still passes the check", async () => {
		const script = scriptedModel();
		const h = setup(
			{},
			{
				completer: (system, user) => Promise.resolve(script(system, user)),
				plan: async (request, env, options) => {
					const select = options?.selectEngine;
					if (!select) throw new Error("selectEngine missing");
					let probed = false;
					return planPrompt(request, env, {
						...options,
						selectEngine: async (...args) => {
							const engine = await select(...args);
							if ("skipped" in engine) return engine;
							const real = engine.complete;
							return {
								...engine,
								complete: async (system, user, signal) => {
									if (!probed) {
										probed = true;
										// A request the script cannot answer: the completer error is captured, the plan carries on.
										await real("unscripted", "unscripted", signal).catch(() => undefined);
									}
									return real(system, user, signal);
								},
							};
						},
					});
				},
			},
		);
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "planned" },
		});
		expect(jobFile(h.stateDir, sessionId).error).toBeUndefined();
	});

	test("a thin plan without any engine error is invalid with the check reasons, capped at 300 characters", async () => {
		const script = scriptedModel();
		const thin: ClaudeCompleter = async (system, user) => {
			if (system === COT_SYSTEM_PROMPT) {
				const match = user.match(/<current_node id="([^"]+)" kind="([^"]+)"/);
				return NODE(match?.[1] ?? "n?", match?.[2] ?? "generate", 2);
			}
			return script(system, user);
		};
		const h = setup({}, { completer: thin });
		const sessionId = randomUUID();
		const started = await h.planner.start({ prompt: PROMPT, sessionId });
		if (!started.ok) throw new Error(`start failed: ${started.code}`);
		const error = started.data.error;
		expect(started).toMatchObject({ ok: true, data: { sessionId, status: "invalid" } });
		expect(typeof error).toBe("string");
		expect(error).toContain("steps");
		expect((error ?? "").length).toBeLessThanOrEqual(303);
		expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toMatchObject({
			ok: true,
			data: { status: "invalid", mode: "server" },
		});
	});

	test("shutdown aborts running jobs and marks them failed interrupted, even when the model ignores the abort", async () => {
		const gate = Promise.withResolvers<void>();
		const model = fakeModel(gate.promise, false);
		const h = setup({}, { completer: model.complete });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);
		const closing = h.planner.shutdown();
		await flush();
		h.clock.fire(5_000);
		await closing;
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "failed",
			error: "interrupted",
		});
		expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toMatchObject({
			ok: true,
			data: { status: "failed", error: "interrupted" },
		});
		expect(await h.planner.start({ prompt: PROMPT })).toEqual({ ok: false, code: "not_ready" });
		gate.resolve();
		await flush();
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "failed",
			error: "interrupted",
		});
	});

	test("shutdown ends a job that honors the abort without waiting for the deadline", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({}, { completer: fakeModel(gate.promise).complete });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);
		await h.planner.shutdown();
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "failed",
			error: "interrupted",
		});
	});

	test("a job left running by a previous process becomes failed interrupted on startup", async () => {
		const h = setup();
		const sessionId = randomUUID();
		const run = h.store.createRun({ ownerId: "x", request: "x", route: "x" });
		mkdirSync(join(h.stateDir, "jobs"), { recursive: true });
		writeFileSync(
			join(h.stateDir, "jobs", `${sessionId}.json`),
			JSON.stringify({
				sessionId,
				runId: run.id,
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
				promptSha256: "0".repeat(64),
			}),
		);
		const reborn = createHeadlessPlanner({
			config: h.config,
			store: h.store,
			ledger: createLedger(h.store, { runTokenCeiling: 1e9, dailyTokenCeiling: 1e9 }),
			sleep: h.clock.sleep,
			completer: fakeModel().complete,
		});
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "failed",
			error: "interrupted",
		});
		expect(await reborn.result({ sessionId, waitSeconds: 0 })).toMatchObject({
			ok: true,
			data: { status: "failed", mode: "server", error: "interrupted" },
		});
		expect(reborn.status({ sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "failed", pendingCount: 0, pending: [] },
		});
		expect(
			h.store.db
				.query<{ status: string }, [string]>("SELECT status FROM runs WHERE id = ?")
				.get(run.id)?.status,
		).toBe("failed");
	});

	test("a job file without a runId is ignored", async () => {
		const h = setup();
		const sessionId = randomUUID();
		mkdirSync(join(h.stateDir, "jobs"), { recursive: true });
		const file = join(h.stateDir, "jobs", `${sessionId}.json`);
		writeFileSync(
			file,
			JSON.stringify({
				sessionId,
				status: "running",
				createdAt: 1,
				updatedAt: 1,
				usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
				promptSha256: "0".repeat(64),
			}),
		);
		const reborn = createHeadlessPlanner({
			config: h.config,
			store: h.store,
			ledger: createLedger(h.store, { runTokenCeiling: 1e9, dailyTokenCeiling: 1e9 }),
			sleep: h.clock.sleep,
			completer: fakeModel().complete,
		});
		// Not recovered on startup, not a server job, not a client session.
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ status: "running" });
		expect(reborn.status({ sessionId })).toBeNull();
		expect(await reborn.result({ sessionId, waitSeconds: 0 })).toEqual({
			ok: false,
			code: "not_found",
		});
	});

	test("settled jobs whose file cannot be written are kept in memory only up to the cap, and each failure is logged once", async () => {
		const total = UNPERSISTED_JOBS_MAX + 5;
		const gate = Promise.withResolvers<void>();
		const completer: ClaudeCompleter = async (_system, _user, signal) => {
			await (signal ? Promise.race([gate.promise, aborted(signal)]) : gate.promise);
			throw new Error("model down");
		};
		const events: Array<{ level: string; event: string; fields?: Record<string, unknown> }> = [];
		const logger = {
			info: (event: string, fields?: Record<string, unknown>) =>
				events.push({ level: "info", event, fields }),
			warn: (event: string, fields?: Record<string, unknown>) =>
				events.push({ level: "warn", event, fields }),
			error: (event: string, fields?: Record<string, unknown>) =>
				events.push({ level: "error", event, fields }),
		};
		const h = setup({ maxConcurrentPlans: total + 1 }, { completer, logger });
		const ids = Array.from({ length: total }, () => randomUUID());
		for (const sessionId of ids) {
			expect(await startRunning(h, sessionId)).toEqual({
				ok: true,
				data: { sessionId, status: "running", pollAfterSec: expect.any(Number) },
			});
		}
		// The running file is on disk; the settled write fails because its temp path is now a directory.
		for (const sessionId of ids)
			mkdirSync(join(h.stateDir, "jobs", `${sessionId}.json.${process.pid}.tmp`));
		gate.resolve();
		for (const sessionId of ids) await h.planner.result({ sessionId, waitSeconds: 30 });

		// In memory the job is failed; once dropped, only the stale running file on disk is left.
		const seen = { failed: 0, running: 0 };
		for (const sessionId of ids) {
			const status = h.planner.status({ sessionId });
			if (!status?.ok) throw new Error("job vanished");
			if (status.data.status === "failed") seen.failed += 1;
			else if (status.data.status === "running") seen.running += 1;
		}
		expect(seen).toEqual({ failed: UNPERSISTED_JOBS_MAX, running: total - UNPERSISTED_JOBS_MAX });
		expect(events).toHaveLength(total);
		expect(new Set(events.map((e) => e.fields?.sessionId)).size).toBe(total);
		for (const entry of events)
			expect(entry).toMatchObject({
				level: "error",
				event: "job_persist_failed",
				fields: { status: "failed", error: expect.any(Error) },
			});
		expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
		expect(JSON.stringify(events)).not.toContain(PROMPT);
	});

	test("result waits at most the clamped time and then reports running", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({}, { completer: fakeModel(gate.promise).complete });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);

		const huge = h.planner.result({ sessionId, waitSeconds: 9999 });
		await flush();
		expect(h.clock.has(45_000)).toBe(true);
		h.clock.fire(45_000);
		expect(await huge).toMatchObject({
			ok: true,
			data: { status: "running", mode: "server", text: expect.any(String) },
		});

		const before = h.clock.waits.length;
		expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toMatchObject({
			ok: true,
			data: { status: "running" },
		});
		expect(await h.planner.result({ sessionId, waitSeconds: -5 })).toMatchObject({
			ok: true,
			data: { status: "running" },
		});
		expect(h.clock.waits.length).toBe(before);
		gate.resolve();
		await h.planner.result({ sessionId, waitSeconds: 30 });
	});

	test("a plan timeout of 0 starts no timer, so a zero-length wait never aborts the plan", async () => {
		const gate = Promise.withResolvers<void>();
		const model = fakeModel(gate.promise);
		const h = setup({ planTimeoutMs: 0 }, { completer: model.complete });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);
		h.clock.fire(0);
		gate.resolve();
		const result = await h.planner.result({ sessionId, waitSeconds: 30 });
		expect(result).toMatchObject({ ok: true, data: { status: "planned" } });
	});
});

describe("headless planner: client-mode fallback", () => {
	test("returns a finished client-driven session with mode client, and null from status()", async () => {
		const h = setup();
		const sessionId = randomUUID();
		const o = { stateDir: h.stateDir, maxPromptChars: 4000, maxAnswerChars: 200_000 };
		const model = scriptedModel();
		let status = "needs-model";
		for (let pass = 0; pass < 12 && status === "needs-model"; pass++) {
			const plan = await startPlan(o, { prompt: PROMPT, sessionId });
			if (!plan.ok) throw new Error(`startPlan failed: ${plan.code}`);
			status = plan.data.status;
			if (status !== "needs-model") break;
			const listed = listPendingRequests(o, { sessionId });
			if (!listed.ok) throw new Error("list failed");
			for (const entry of listed.data) {
				const system = showRequest(o, { sessionId, key: entry.key, part: "system" });
				const user = showRequest(o, { sessionId, key: entry.key, part: "user" });
				if (!system.ok || !user.ok) throw new Error("show failed");
				const answered = answerRequest(o, {
					sessionId,
					key: entry.key,
					answer: model(system.data.system ?? "", user.data.user ?? ""),
				});
				expect(answered.ok).toBe(true);
			}
		}
		expect(status).toBe("planned");
		const result = await h.planner.result({ sessionId, waitSeconds: 0 });
		expect(result).toMatchObject({
			ok: true,
			data: { sessionId, status: "planned", mode: "client" },
		});
		if (result.ok) expect(result.data.text).toContain(PROMPT);
		expect(h.planner.status({ sessionId })).toBeNull();
	});

	test("an unfinished client session reports running with mode client; an unknown id is not_found", async () => {
		const h = setup();
		const sessionId = randomUUID();
		const o = { stateDir: h.stateDir, maxPromptChars: 4000, maxAnswerChars: 200_000 };
		expect(await startPlan(o, { prompt: PROMPT, sessionId })).toMatchObject({
			ok: true,
			data: { status: "needs-model" },
		});
		expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toMatchObject({
			ok: true,
			data: { status: "running", mode: "client", pollAfterSec: 10 },
		});
		expect(await h.planner.result({ sessionId: randomUUID(), waitSeconds: 0 })).toEqual({
			ok: false,
			code: "not_found",
		});
	});
});

describe("headless planner: call telemetry", () => {
	test("emits one event per model call with the session id, model, counts and no prompt text", async () => {
		const fake = fakeBackend();
		const calls: PlannerCall[] = [];
		const h = setup(
			{},
			{ completer: undefined, planBackend: fake.backend, onCall: (call) => calls.push(call) },
		);
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
		expect(calls.length).toBe(fake.stages.length);
		expect(calls.length).toBeGreaterThanOrEqual(8);
		for (const call of calls) {
			expect(call.sessionId).toBe(sessionId);
			expect(call.model).toBe("claude-haiku-5-5");
			expect(call.outcome).toBe("ok");
			expect(call.attempts).toBe(1);
			expect(call.ms).toBeGreaterThanOrEqual(0);
			expect(call.inputTokens).toBe(100);
			expect(call.outputTokens).toBe(50);
		}
		expect(JSON.stringify(calls)).not.toContain(PROMPT);
	});

	test("a failing call emits the error code with zero tokens, and a throwing hook does not affect the job", async () => {
		const fake = fakeBackend(new PlanCompleterError("auth", "auth"));
		const calls: PlannerCall[] = [];
		const h = setup(
			{},
			{
				completer: undefined,
				planBackend: fake.backend,
				onCall: (call) => {
					calls.push(call);
					throw new Error("hook failure");
				},
			},
		);
		const sessionId = randomUUID();
		const started = await h.planner.start({ prompt: PROMPT, sessionId });
		expect(started).toEqual({ ok: true, data: { sessionId, status: "failed", error: "auth" } });
		expect(calls.length).toBeGreaterThanOrEqual(1);
		for (const call of calls) {
			expect(call.outcome).toBe("auth");
			expect(call.attempts).toBe(1);
			expect(call.inputTokens).toBe(0);
			expect(call.outputTokens).toBe(0);
		}
	});
});

describe("headless planner: upstream breaker", () => {
	test("a tripped breaker fails the job with upstream_unavailable before any backend call, and upstream() reports open", async () => {
		const breaker = createCircuitBreaker({ failureThreshold: 1, windowMs: 60_000, openMs: 30_000 });
		const slot = breaker.tryAcquire();
		if (!slot.ok) throw new Error("expected a closed breaker");
		slot.release("failure");
		expect(breaker.state()).toBe("open");
		const fake = fakeBackend();
		const calls: PlannerCall[] = [];
		const refusals: unknown[] = [];
		const h = setup(
			{},
			{
				completer: undefined,
				planBackend: fake.backend,
				breaker,
				onCall: (call) => calls.push(call),
				plan: async (request, env, options) => {
					const select = options?.selectEngine;
					if (!select) throw new Error("selectEngine missing");
					return planPrompt(request, env, {
						...options,
						selectEngine: async (...args) => {
							const engine = await select(...args);
							if ("skipped" in engine) return engine;
							const real = engine.complete;
							return {
								...engine,
								complete: async (system, user, signal) => {
									try {
										return await real(system, user, signal);
									} catch (error) {
										refusals.push(error);
										throw error;
									}
								},
							};
						},
					});
				},
			},
		);
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "failed", error: "upstream_unavailable" },
		});
		expect(await h.planner.result({ sessionId, waitSeconds: 0 })).toMatchObject({
			ok: true,
			data: { status: "failed", mode: "server", error: "upstream_unavailable" },
		});
		expect(jobFile(h.stateDir, sessionId)).toMatchObject({
			status: "failed",
			error: "upstream_unavailable",
			usage: { calls: 0 },
		});
		expect(fake.stages).toEqual([]);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		for (const call of calls)
			expect(call).toMatchObject({
				outcome: "upstream_unavailable",
				attempts: 1,
				inputTokens: 0,
				outputTokens: 0,
			});
		expect(refusals.length).toBeGreaterThanOrEqual(1);
		for (const error of refusals) {
			expect(error).toBeInstanceOf(PlanCompleterError);
			const refused = error as PlanCompleterError;
			expect(refused.code).toBe("upstream_unavailable");
			expect(refused.retryAfterMs).toBeGreaterThan(0);
			expect(refused.retryAfterMs).toBeLessThanOrEqual(30_000);
		}
		expect(h.planner.upstream()).toEqual({ state: "open", failures: 1 });
		// Every reservation made for the refused calls was abandoned, none left reserved or settled.
		const states = h.store.db
			.query<{ state: string; n: number }, []>(
				"SELECT state, COUNT(*) AS n FROM token_ledger GROUP BY state",
			)
			.all();
		expect(states).toEqual([{ state: "abandoned", n: calls.length }]);
		const run = h.store.db
			.query<{ status: string; reason: string | null }, []>("SELECT status, reason FROM runs")
			.get();
		expect(run).toEqual({ status: "failed", reason: "upstream_unavailable" });
	});

	test("upstream, timeout and rate_limited failures trip the shared breaker; later calls never reach the backend", async () => {
		const cases: Array<[PlanErrorCode, ConstructorParameters<typeof PlanCompleterError>[1]]> = [
			["upstream", "other"],
			["timeout", "timeout"],
			["rate_limited", "plan-limit"],
		];
		for (const [code, failure] of cases) {
			const breaker = createCircuitBreaker({
				failureThreshold: 1,
				windowMs: 60_000,
				openMs: 30_000,
			});
			const fake = fakeBackend(new PlanCompleterError(code, failure));
			const h = setup({}, { completer: undefined, planBackend: fake.backend, breaker });
			const sessionId = randomUUID();
			expect(await h.planner.start({ prompt: PROMPT, sessionId })).toEqual({
				ok: true,
				data: { sessionId, status: "failed", error: code },
			});
			// One failed call opens the breaker, so whatever the pipeline asks next is refused without a backend call.
			expect(fake.stages).toHaveLength(1);
			expect(h.planner.upstream()).toEqual({ state: "open", failures: 1 });
		}
	});

	test("a reply, an auth failure and an unclassified error never count against the breaker", async () => {
		const options = { failureThreshold: 1, windowMs: 60_000, openMs: 30_000 };
		const answered = createCircuitBreaker(options);
		const ok = setup(
			{},
			{ completer: undefined, planBackend: fakeBackend().backend, breaker: answered },
		);
		expect(await ok.planner.start({ prompt: PROMPT })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
		expect(ok.planner.upstream()).toEqual({ state: "closed", failures: 0 });

		const denied = createCircuitBreaker(options);
		const auth = setup(
			{},
			{
				completer: undefined,
				planBackend: fakeBackend(new PlanCompleterError("auth", "auth")).backend,
				breaker: denied,
			},
		);
		await auth.planner.start({ prompt: PROMPT });
		expect(auth.planner.upstream()).toEqual({ state: "closed", failures: 0 });

		const broken = createCircuitBreaker(options);
		const boom = setup(
			{},
			{
				completer: async () => {
					throw new Error("boom");
				},
				breaker: broken,
			},
		);
		await boom.planner.start({ prompt: PROMPT });
		expect(boom.planner.upstream()).toEqual({ state: "closed", failures: 0 });
	});

	test("a planner without a breaker reports upstream() as undefined and keeps today's behaviour", async () => {
		const h = setup();
		expect(h.planner.upstream()).toBeUndefined();
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toMatchObject({
			ok: true,
			data: { sessionId, status: "planned" },
		});
		expect(h.planner.upstream()).toBeUndefined();
	});
});

describe("headless planner: isolation", () => {
	test("the env and options given to planPrompt carry the kill switches and none of the operator's state", async () => {
		const captured: {
			call?: {
				request: Parameters<typeof planPrompt>[0];
				env: Record<string, string | undefined>;
				options: NonNullable<Parameters<typeof planPrompt>[2]>;
			};
		} = {};
		const hostile = {
			ULTRATHINK_CHILD: "1",
			ULTRATHINK_UPLIFT: "0",
			ULTRATHINK_SHIP: "1",
			ULTRATHINK_DECISIONS: "1",
			ANTHROPIC_API_KEY: FAKE_KEY,
			GITHUB_TOKEN: "ghp_fake",
			PATH: "/usr/bin",
		};
		const h = setup(
			{},
			{
				env: hostile,
				plan: async (request, env, options) => {
					captured.call = { request, env: env ?? {}, options: options ?? {} };
					return planPrompt(request, env, options);
				},
			},
		);
		const sessionId = randomUUID();
		const started = await h.planner.start({ prompt: PROMPT, sessionId });
		expect(started).toMatchObject({ ok: true, data: { status: "planned" } });
		if (!captured.call) throw new Error("planPrompt was not called");
		const { request, env, options } = captured.call;
		expect(request).toMatchObject({
			host: "prime-agent",
			session_id: sessionId,
			prompt: PROMPT,
			cwd: join(h.stateDir, "cwd"),
		});
		expect(env).toMatchObject({
			ULTRATHINK_SHIP: "0",
			ULTRATHINK_HINDSIGHT: "0",
			ULTRATHINK_RAGFLOW: "0",
			SUBSTRATE_DISABLED: "1",
			ULTRATHINK_DECISIONS: "0",
		});
		expect("ULTRATHINK_CHILD" in env).toBe(false);
		expect("ULTRATHINK_UPLIFT" in env).toBe(false);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		for (const key of ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"])
			expect(env[key]?.startsWith(h.stateDir)).toBe(true);
		expect(options.stateDir).toBe(h.stateDir);
		expect(options.control).toEqual({ enabled: true });
		expect(options.createTracker?.(options.config as never)).toBeUndefined();
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(options.config).toMatchObject({
			track: { enabled: false },
			ship: { enabled: false },
			hindsight: { enabled: false },
			ragflow: { enabled: false },
			teach: { enabled: false },
			decisions: { enabled: false },
			hitl: { knowledgeBase: false },
		});
	});

	test("ULTRATHINK_SERVER_DECISIONS in the environment never gives a server plan a provider key or Jev", async () => {
		let env: Record<string, string | undefined> = {};
		let decisions: boolean | undefined;
		const h = setup(
			{},
			{
				// The operator's environment asks for decisions and holds a key; neither reaches the plan.
				env: {
					PATH: process.env.PATH,
					ULTRATHINK_SERVER_DECISIONS: "1",
					ANTHROPIC_API_KEY: FAKE_KEY,
				},
				// Not the real planPrompt: a live Jev gate would call out.
				plan: async (_request, given, options) => {
					if (!options?.config) throw new Error("planPrompt was called without a config");
					env = given ?? {};
					decisions = options.config.decisions.enabled;
					return { context: "", skipped: "precheck-skip" };
				},
			},
		);
		await h.planner.start({ prompt: PROMPT });
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ULTRATHINK_SERVER_DECISIONS).toBeUndefined();
		expect(env.ULTRATHINK_DECISIONS).toBe("0");
		expect(decisions).toBe(false);
	});

	test("a hostile operator config changes nothing and nothing outside the plan backend is contacted", async () => {
		const hostileRoot = tmp();
		const hostileConfig = JSON.stringify({
			uplift: { enabled: false },
			hindsight: { enabled: true, url: "https://hindsight.invalid" },
			ragflow: { enabled: true, ground: true, url: "https://ragflow.invalid", datasetIds: ["d1"] },
			track: { enabled: true },
			ship: { enabled: true },
			teach: { enabled: true, recall: true },
			decisions: { enabled: true },
			substrate: { url: "https://substrate.invalid" },
			gateway: { url: "https://gateway.invalid" },
		});
		for (const file of [
			join(hostileRoot, "xdg", "ultrathink", "config.json"),
			join(hostileRoot, "claude", "ultrathink.json"),
			join(hostileRoot, "home", ".config", "ultrathink", "config.json"),
		]) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, hostileConfig);
		}
		const keys = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"] as const;
		const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		const realFetch = globalThis.fetch;
		const stray: string[] = [];
		globalThis.fetch = ((input: string | URL | Request) => {
			stray.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return Promise.reject(new Error("offline"));
		}) as unknown as typeof fetch;
		process.env.HOME = join(hostileRoot, "home");
		process.env.XDG_CONFIG_HOME = join(hostileRoot, "xdg");
		process.env.CLAUDE_CONFIG_DIR = join(hostileRoot, "claude");

		const fake = fakeBackend();
		const seen = fake.stages;
		try {
			// The fixture is hostile: read the way the plugin reads it, it would switch everything on and planning off.
			const hostileSeen = loadConfig(claudeConfigPaths(join(hostileRoot, "cwd")));
			expect(hostileSeen.uplift.enabled).toBe(false);
			expect(hostileSeen.hindsight.enabled).toBe(true);

			const h = setup({}, { completer: undefined, planBackend: fake.backend, env: process.env });
			const sessionId = randomUUID();
			const started = await h.planner.start({ prompt: PROMPT, sessionId });
			expect(started).toEqual({ ok: true, data: { sessionId, status: "planned" } });
			const result = await h.planner.result({ sessionId, waitSeconds: 0 });
			expect(result).toMatchObject({ ok: true, data: { status: "planned" } });
			if (!result.ok) return;

			expect(stray).toEqual([]);
			expect(seen.length).toBeGreaterThanOrEqual(8);
			expect(result.data.usage).toMatchObject({
				calls: seen.length,
				inputTokens: 100 * seen.length,
				outputTokens: 50 * seen.length,
			});
			const runId = String(jobFile(h.stateDir, sessionId).runId);
			const ledger = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 });
			expect(ledger.spentForRun(runId)).toBe(150 * seen.length);

			// No secret in any job file.
			for (const name of readdirSync(join(h.stateDir, "jobs"))) {
				const text = readFileSync(join(h.stateDir, "jobs", name), "utf8");
				expect(text).not.toContain(FAKE_KEY);
				expect(text).not.toContain(h.config.sessionSecret);
			}
			expect(existsSync(join(h.stateDir, "jobs", `${sessionId}.json`))).toBe(true);
		} finally {
			globalThis.fetch = realFetch;
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});
});

/** Drives a session through the client-driven loop (the chat model answers every request) until it is planned. */
async function finishClientSession(stateDir: string, sessionId: string): Promise<void> {
	const o = { stateDir, maxPromptChars: 4000, maxAnswerChars: 200_000 };
	const model = scriptedModel();
	let status = "needs-model";
	for (let pass = 0; pass < 12 && status === "needs-model"; pass++) {
		const plan = await startPlan(o, { prompt: PROMPT, sessionId });
		if (!plan.ok) throw new Error(`startPlan failed: ${plan.code}`);
		status = plan.data.status;
		if (status !== "needs-model") break;
		const listed = listPendingRequests(o, { sessionId });
		if (!listed.ok) throw new Error("list failed");
		for (const entry of listed.data) {
			const system = showRequest(o, { sessionId, key: entry.key, part: "system" });
			const user = showRequest(o, { sessionId, key: entry.key, part: "user" });
			if (!system.ok || !user.ok) throw new Error("show failed");
			expect(
				answerRequest(o, {
					sessionId,
					key: entry.key,
					answer: model(system.data.system ?? "", user.data.user ?? ""),
				}).ok,
			).toBe(true);
		}
	}
	expect(status).toBe("planned");
}

describe("headless planner: graph view", () => {
	test("a server-planned session carries the structured graph and the diagram in its text", async () => {
		const h = setup();
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
		for (const detail of ["brief", "full"] as const) {
			const result = await h.planner.result({ sessionId, detail, waitSeconds: 0 });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const graph = result.data.graph;
			expect(graph).toBeDefined();
			if (!graph) return;
			expect(graph.version).toBe(1);
			expect(graph.goal).toBe("Ship a streaming CSV to JSON CLI");
			expect(graph.counts).toMatchObject({ nodes: 5, edges: 5, waves: 4 });
			expect(graph.waves.map((w) => w.ids)).toEqual([["n1"], ["n2", "n3"], ["n4"], ["n5"]]);
			expect(graph.waves[1]?.parallel).toBe(true);
			for (const node of graph.nodes) {
				expect(node.steps).toHaveLength(8);
				expect(node.conclusion).toContain(`Answer for ${node.id}.`);
			}
			expect(JSON.parse(JSON.stringify(result.data)).graph).toEqual(graph);
			expect(result.data.text).toContain("## Graph of Thought x Chain of Thought");
			expect(result.data.text).toContain("```mermaid\nflowchart TD\n");
			expect(result.data.text.indexOf("## Graph of Thought x Chain of Thought")).toBeLessThan(
				result.data.text.indexOf("## Request"),
			);
		}
	});

	test("a client-driven session carries the same structured graph", async () => {
		const h = setup();
		const sessionId = randomUUID();
		await finishClientSession(h.stateDir, sessionId);
		const result = await h.planner.result({ sessionId, waitSeconds: 0 });
		expect(result).toMatchObject({ ok: true, data: { status: "planned", mode: "client" } });
		if (!result.ok) return;
		expect(result.data.graph).toMatchObject({ version: 1, counts: { nodes: 5, waves: 4 } });
		expect(result.data.text).toContain("```mermaid\nflowchart TD\n");
	});

	test("a fallback graph exposes no graph and no diagram", async () => {
		const h = setup();
		const sessionId = randomUUID();
		await h.planner.start({ prompt: PROMPT, sessionId });
		const record = readSession(h.stateDir, sessionId);
		if (!record) throw new Error("no session record");
		writeSession(h.stateDir, {
			...record,
			graph: {
				goal: FALLBACK_GRAPH.goal,
				nodes: FALLBACK_GRAPH.nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })),
			},
		});
		const result = await h.planner.result({ sessionId, waitSeconds: 0 });
		expect(result).toMatchObject({ ok: true, data: { status: "planned", mode: "server" } });
		if (!result.ok) return;
		expect("graph" in result.data).toBe(false);
		expect(result.data.text).not.toContain("## Graph of Thought x Chain of Thought");
		expect(result.data.text).not.toContain("Show the wave tree first.");
	});

	test("running and failed views carry no graph and keep their shape", async () => {
		const gate = Promise.withResolvers<void>();
		const running = setup({}, { completer: fakeModel(gate.promise).complete });
		const runningId = randomUUID();
		await startRunning(running, runningId);
		const pending = await running.planner.result({ sessionId: runningId, waitSeconds: 0 });
		expect(pending).toEqual({
			ok: true,
			data: {
				sessionId: runningId,
				status: "running",
				mode: "server",
				text: expect.stringContaining("still being prepared"),
				usage: expect.any(Object),
			},
		});
		gate.resolve();
		await running.planner.result({ sessionId: runningId, waitSeconds: 30 });

		const failing = fakeBackend(new PlanCompleterError("auth", "auth"));
		const h = setup({}, { completer: undefined, planBackend: failing.backend });
		const failedId = randomUUID();
		await h.planner.start({ prompt: PROMPT, sessionId: failedId });
		expect(await h.planner.result({ sessionId: failedId, waitSeconds: 0 })).toEqual({
			ok: true,
			data: {
				sessionId: failedId,
				status: "failed",
				mode: "server",
				text: expect.stringContaining("Planning failed (auth)"),
				usage: expect.any(Object),
				error: "auth",
			},
		});

		const client = setup();
		const clientId = randomUUID();
		const o = { stateDir: client.stateDir, maxPromptChars: 4000, maxAnswerChars: 200_000 };
		await startPlan(o, { prompt: PROMPT, sessionId: clientId });
		expect(await client.planner.result({ sessionId: clientId, waitSeconds: 0 })).toEqual({
			ok: true,
			data: {
				sessionId: clientId,
				status: "running",
				mode: "client",
				text: expect.stringContaining("driven by the chat model"),
				pollAfterSec: 10,
			},
		});
	});
});

describe("headless planner: plan-slot fairness", () => {
	const owner: Admission = { principal: "owner", class: "owner" };
	const connector = (principal: string): Admission => ({ principal, class: "connector" });
	const admittedAs = (admission: Admission): RequestContext => ({
		reqId: randomUUID(),
		traceId: "0".repeat(32),
		spanId: "0".repeat(16),
		admission,
	});

	/** Starts a plan inside an admitted request (or none); a started plan waits out the start window, so fire it. */
	async function startAs(h: Harness, admission: Admission | undefined, sessionId: string) {
		const call = () => h.planner.start({ prompt: PROMPT, sessionId });
		const started =
			admission === undefined ? call() : runWithRequestContext(admittedAs(admission), call);
		await flush();
		h.clock.fire(15_000);
		return started;
	}

	test("connectors leave the reserved slot to owners: a second connector start is busy, a second owner start is busy at the cap", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({ maxConcurrentPlans: 2 }, { completer: fakeModel(gate.promise).complete });
		const connectorPlan = randomUUID();
		const ownerPlan = randomUUID();
		expect(await startAs(h, connector("key-a"), connectorPlan)).toMatchObject({
			ok: true,
			data: { sessionId: connectorPlan, status: "running" },
		});
		expect(await startAs(h, connector("key-b"), randomUUID())).toEqual({ ok: false, code: "busy" });
		expect(await startAs(h, owner, ownerPlan)).toMatchObject({
			ok: true,
			data: { sessionId: ownerPlan, status: "running" },
		});
		expect(await startAs(h, owner, randomUUID())).toEqual({ ok: false, code: "busy" });
		gate.resolve();
		for (const sessionId of [connectorPlan, ownerPlan])
			await h.planner.result({ sessionId, waitSeconds: 30 });
	});

	test("one connector principal is capped at its share while another principal is still admitted", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({ maxConcurrentPlans: 4 }, { completer: fakeModel(gate.promise).complete });
		const started: string[] = [];
		for (let i = 0; i < 2; i++) {
			const sessionId = randomUUID();
			started.push(sessionId);
			expect(await startAs(h, connector("key-a"), sessionId)).toMatchObject({
				ok: true,
				data: { status: "running" },
			});
		}
		expect(await startAs(h, connector("key-a"), randomUUID())).toEqual({ ok: false, code: "busy" });
		const other = randomUUID();
		started.push(other);
		expect(await startAs(h, connector("key-b"), other)).toMatchObject({
			ok: true,
			data: { status: "running" },
		});
		gate.resolve();
		for (const sessionId of started) await h.planner.result({ sessionId, waitSeconds: 30 });
	});

	test("a settled plan frees its slot for the next connector start", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({ maxConcurrentPlans: 2 }, { completer: fakeModel(gate.promise).complete });
		const first = randomUUID();
		await startAs(h, connector("key-a"), first);
		expect(await startAs(h, connector("key-b"), randomUUID())).toEqual({ ok: false, code: "busy" });
		gate.resolve();
		await h.planner.result({ sessionId: first, waitSeconds: 30 });
		const next = randomUUID();
		expect(await startAs(h, connector("key-b"), next)).toMatchObject({ ok: true });
		await h.planner.result({ sessionId: next, waitSeconds: 30 });
	});

	test("starts without an admission keep the count-only check", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({ maxConcurrentPlans: 2 }, { completer: fakeModel(gate.promise).complete });
		const plans = [randomUUID(), randomUUID()] as const;
		expect(await startAs(h, undefined, plans[0])).toMatchObject({
			ok: true,
			data: { status: "running" },
		});
		expect(await startAs(h, undefined, plans[1])).toMatchObject({
			ok: true,
			data: { status: "running" },
		});
		expect(await startAs(h, undefined, randomUUID())).toEqual({ ok: false, code: "busy" });
		gate.resolve();
		for (const sessionId of plans) await h.planner.result({ sessionId, waitSeconds: 30 });
	});

	test("re-starting a running session is never busy, whoever asks", async () => {
		const gate = Promise.withResolvers<void>();
		const h = setup({ maxConcurrentPlans: 1 }, { completer: fakeModel(gate.promise).complete });
		const sessionId = randomUUID();
		await startAs(h, connector("key-a"), sessionId);
		expect(await startAs(h, connector("key-b"), randomUUID())).toEqual({ ok: false, code: "busy" });
		expect(await startAs(h, connector("key-b"), sessionId)).toMatchObject({
			ok: true,
			data: { sessionId, status: "running" },
		});
		gate.resolve();
		await h.planner.result({ sessionId, waitSeconds: 30 });
	});
});

describe("headless planner: client span threading", () => {
	const CTX: RequestContext = {
		reqId: "req-plan-span",
		traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
		spanId: "00f067aa0ba902b7",
	};
	const collect = (): { spans: FinishedSpan[]; sink: SpanSink } => {
		const spans: FinishedSpan[] = [];
		return {
			spans,
			sink: {
				record: (span) => {
					spans.push(span);
				},
			},
		};
	};

	test("each model call started inside a request context records one hop span parented by that context", async () => {
		const fake = fakeBackend();
		const { spans, sink } = collect();
		const h = setup({}, { completer: undefined, planBackend: fake.backend, spans: sink });
		const sessionId = randomUUID();
		const started = await runWithRequestContext(CTX, () =>
			h.planner.start({ prompt: PROMPT, sessionId }),
		);
		expect(started).toMatchObject({ ok: true, data: { status: "planned" } });
		expect(spans.length).toBe(fake.stages.length);
		expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);
		for (const span of spans) {
			expect(span).toMatchObject({
				traceId: CTX.traceId,
				parentSpanId: CTX.spanId,
				name: "plan complete",
				kind: 3,
				error: false,
				attributes: {
					"ultrathink.engine": "plan",
					"ultrathink.model": "claude-haiku-5-5",
					"ultrathink.attempt": 1,
				},
			});
		}
	});

	test("a failing call marks its span as an error only for an upstream failure, never for an auth failure", async () => {
		const cases: Array<[PlanCompleterError, boolean]> = [
			[new PlanCompleterError("upstream", "other"), true],
			[new PlanCompleterError("timeout", "timeout"), true],
			[new PlanCompleterError("auth", "auth"), false],
		];
		for (const [failure, error] of cases) {
			const { spans, sink } = collect();
			const h = setup(
				{},
				{ completer: undefined, planBackend: fakeBackend(failure).backend, spans: sink },
			);
			const sessionId = randomUUID();
			const started = await runWithRequestContext(CTX, () =>
				h.planner.start({ prompt: PROMPT, sessionId }),
			);
			expect(started).toEqual({
				ok: true,
				data: { sessionId, status: "failed", error: failure.code },
			});
			expect(spans.length).toBeGreaterThanOrEqual(1);
			for (const span of spans) expect(span).toMatchObject({ kind: 3, error });
		}
	});

	test("an unsampled context, no context, no sink and a refused call record nothing, and a throwing sink changes nothing", async () => {
		const { spans, sink } = collect();
		const unsampled = setup({}, { spans: sink });
		await runWithRequestContext({ ...CTX, sampled: false }, () =>
			unsampled.planner.start({ prompt: PROMPT }),
		);
		const bare = setup({}, { spans: sink });
		await bare.planner.start({ prompt: PROMPT });
		const sinkless = setup();
		expect(
			await runWithRequestContext(CTX, () => sinkless.planner.start({ prompt: PROMPT })),
		).toMatchObject({ ok: true, data: { status: "planned" } });

		const breaker = createCircuitBreaker({ failureThreshold: 1, windowMs: 60_000, openMs: 30_000 });
		const slot = breaker.tryAcquire();
		if (!slot.ok) throw new Error("expected a closed breaker");
		slot.release("failure");
		const refused = setup({}, { spans: sink, breaker });
		await runWithRequestContext(CTX, () => refused.planner.start({ prompt: PROMPT }));
		expect(spans).toEqual([]);

		const throwing = setup(
			{},
			{
				spans: {
					record: () => {
						throw new Error("sink down");
					},
				},
			},
		);
		expect(
			await runWithRequestContext(CTX, () => throwing.planner.start({ prompt: PROMPT })),
		).toMatchObject({ ok: true, data: { status: "planned" } });
	});
});

describe("headless planner: boundary failures", () => {
	test("a run-row write that fails is logged under finalize without the echoed secret", async () => {
		const SECRET = "sk-test-FIXTURE0000000000000000";
		const gate = Promise.withResolvers<void>();
		const completer: ClaudeCompleter = async (_system, _user, signal) => {
			await (signal ? Promise.race([gate.promise, aborted(signal)]) : gate.promise);
			throw new Error(`upstream echoed ${SECRET}`);
		};
		const lines: string[] = [];
		const logger = {
			info: () => {
				// reason: headless tests do not assert on info-level logs; only error lines are collected
			},
			warn: () => {
				// reason: warnings are not part of the redaction contract under test; only error lines are collected
			},
			error: (event: string) => {
				lines.push(event);
			},
		};
		const h = setup({}, { completer, logger });
		const sessionId = randomUUID();
		await startRunning(h, sessionId);
		spyOn(h.store, "updateRun").mockImplementation(() => {
			throw new Error(`row write echoed ${SECRET}`);
		});
		gate.resolve();
		await h.planner.result({ sessionId, waitSeconds: 30 });
		const line = lines.find((entry) => entry.startsWith("finalize: ")) ?? "";
		expect(line).toBe("finalize: Error");
		expect(line).not.toContain(SECRET);
		expect(redactText(line, { home: "" })).toBe(line);
	});
});

interface FakeBackend {
	backend: PlanBackend;
	/** Stage of every call that reached the backend. */
	stages: string[];
	/** `hooks.maxOutputTokens` of every call. */
	caps: Array<number | undefined>;
	/** How many times readiness was asked. */
	readyChecks: () => number;
	setReady: (ready: { ok: boolean; detail?: string }) => void;
}

interface FakeBackendBehavior {
	/** One `onUsage` report per entry, made before the call ends. Default: one 100/50 report, none when failing. */
	reports?: PlanUsage[];
	/** Summary handed to `onFailover` on every call. */
	failover?: string;
}

/** A scripted plan backend; with `failWith` every call throws it after its reports. */
function fakeBackend(
	failWith?: PlanCompleterError,
	behavior: FakeBackendBehavior = {},
): FakeBackend {
	const script = scriptedModel();
	const stages: string[] = [];
	const caps: Array<number | undefined> = [];
	const reports =
		behavior.reports ?? (failWith ? [] : [{ promptTokens: 100, completionTokens: 50 }]);
	let ready: { ok: boolean; detail?: string } = { ok: true };
	let readyChecks = 0;
	const backend: PlanBackend = {
		label: "plan:claude-haiku-5-5",
		ready: () => {
			readyChecks += 1;
			return ready;
		},
		async complete(system, user, _signal, hooks?: PlanCallHooks) {
			stages.push(stageOf(system));
			caps.push(hooks?.maxOutputTokens);
			if (behavior.failover !== undefined) hooks?.onFailover?.(behavior.failover);
			for (const report of reports) hooks?.onUsage?.(report);
			if (failWith) throw failWith;
			return script(system, user);
		},
	};
	return {
		backend,
		stages,
		caps,
		readyChecks: () => readyChecks,
		setReady: (next) => {
			ready = next;
		},
	};
}

describe("headless planner: plan backend", () => {
	test("the plan runs through the backend and settles tokens without a cost", async () => {
		const fake = fakeBackend();
		const calls: PlannerCall[] = [];
		const labels: Array<string | undefined> = [];
		const h = setup(
			{},
			{
				completer: undefined,
				planBackend: fake.backend,
				onCall: (call) => calls.push(call),
				plan: async (request, env, options) => {
					const inner = options?.selectEngine;
					if (!inner) throw new Error("planPrompt got no engine selector");
					return planPrompt(request, env, {
						...options,
						selectEngine: async (...args) => {
							const engine = await inner(...args);
							if ("skipped" in engine) return engine;
							labels.push(engine.label, engine.resolution?.label);
							return engine;
						},
					});
				},
			},
		);
		const sessionId = randomUUID();
		expect(await h.planner.start({ prompt: PROMPT, sessionId })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
		expect(fake.stages.length).toBeGreaterThanOrEqual(8);
		expect(calls.length).toBe(fake.stages.length);
		for (const call of calls) {
			expect(call.model).toBe("claude-haiku-5-5");
			expect(call.outcome).toBe("ok");
			expect(call.inputTokens).toBe(100);
			expect(call.outputTokens).toBe(50);
		}
		const n = fake.stages.length;
		const file = jobFile(h.stateDir, sessionId);
		expect(file.usage).toEqual({ calls: n, inputTokens: 100 * n, outputTokens: 50 * n });
		const ledger = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 });
		expect(ledger.spentForRun(String(file.runId))).toBe(150 * n);
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) expect(label).toBe("plan:claude-haiku-5-5");
	});

	test("a PlanCompleterError code ends the job with that code", async () => {
		const cases: Array<[PlanErrorCode, ConstructorParameters<typeof PlanCompleterError>[1]]> = [
			["auth", "auth"],
			["rate_limited", "plan-limit"],
			["upstream", "other"],
			["timeout", "timeout"],
		];
		for (const [code, failure] of cases) {
			const fake = fakeBackend(new PlanCompleterError(code, failure));
			const calls: PlannerCall[] = [];
			const h = setup(
				{},
				{
					completer: undefined,
					planBackend: fake.backend,
					onCall: (call) => calls.push(call),
				},
			);
			const sessionId = randomUUID();
			expect(await h.planner.start({ prompt: PROMPT, sessionId })).toEqual({
				ok: true,
				data: { sessionId, status: "failed", error: code },
			});
			expect(calls.length).toBeGreaterThanOrEqual(1);
			for (const call of calls) {
				expect(call.outcome).toBe(code);
				expect(call.inputTokens).toBe(0);
			}
		}
	});

	test("a plan call that fails bills no usage to the job and its reservation stays counted", async () => {
		const fake = fakeBackend(new PlanCompleterError("auth", "auth"));
		const h = setup({}, { completer: undefined, planBackend: fake.backend });
		const sessionId = randomUUID();
		await h.planner.start({ prompt: PROMPT, sessionId });
		expect(jobFile(h.stateDir, sessionId).usage).toEqual({
			calls: 0,
			inputTokens: 0,
			outputTokens: 0,
		});
		// The call reported no usage, so its reservation is abandoned, not settled, and still counts toward the ceilings.
		const states = h.store.db
			.query<{ state: string; n: number }, []>(
				"SELECT state, COUNT(*) AS n FROM token_ledger GROUP BY state",
			)
			.all();
		expect(states).toEqual([{ state: "abandoned", n: fake.stages.length }]);
		const ledger = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 });
		expect(ledger.spentForRun(String(jobFile(h.stateDir, sessionId).runId))).toBeGreaterThan(0);
	});

	test("a failed plan call that reported usage bills it, so the ledger holds the reported tokens, not the reservation", async () => {
		const fake = fakeBackend(new PlanCompleterError("rate_limited", "plan-limit"), {
			reports: [{ promptTokens: 30, completionTokens: 7 }],
		});
		const h = setup({}, { completer: undefined, planBackend: fake.backend });
		const sessionId = randomUUID();
		await h.planner.start({ prompt: PROMPT, sessionId });
		const n = fake.stages.length;
		expect(n).toBeGreaterThanOrEqual(1);
		const file = jobFile(h.stateDir, sessionId);
		expect(file.usage).toEqual({ calls: n, inputTokens: 30 * n, outputTokens: 7 * n });
		const states = h.store.db
			.query<{ state: string; n: number }, []>(
				"SELECT state, COUNT(*) AS n FROM token_ledger GROUP BY state",
			)
			.all();
		expect(states).toEqual([{ state: "settled", n }]);
		const ledger = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 });
		expect(ledger.spentForRun(String(file.runId))).toBe(37 * n);
	});

	test("the output cap reaches the backend as hooks.maxOutputTokens, and is absent when no cap applies", async () => {
		const capped = fakeBackend();
		const withCap = setup({}, { completer: undefined, planBackend: capped.backend });
		await withCap.planner.start({ prompt: PROMPT });
		expect(capped.caps.length).toBeGreaterThanOrEqual(8);
		for (const cap of capped.caps) expect(cap).toBe(1000);

		const open = fakeBackend();
		const noCap = setup(
			{ modelMaxOutputTokens: 0, runTokenCeiling: 0, dailyTokenCeiling: 0 },
			{ completer: undefined, planBackend: open.backend },
		);
		await noCap.planner.start({ prompt: PROMPT });
		expect(open.caps.length).toBeGreaterThanOrEqual(8);
		for (const cap of open.caps) expect(cap).toBeUndefined();
	});

	test("with output cap 0 and a run ceiling, the cap reaching the backend is bounded by the budget left and by 16000", async () => {
		const bounded = fakeBackend();
		const withCeiling = setup(
			{ modelMaxOutputTokens: 0, runTokenCeiling: 100_000, dailyTokenCeiling: 0 },
			{ completer: undefined, planBackend: bounded.backend },
		);
		await withCeiling.planner.start({ prompt: PROMPT });
		expect(bounded.caps.length).toBeGreaterThanOrEqual(8);
		for (const cap of bounded.caps) {
			expect(cap).toBeGreaterThan(0);
			expect(cap).toBeLessThanOrEqual(16_000);
		}

		const roomy = fakeBackend();
		const withRoom = setup(
			{ modelMaxOutputTokens: 0, runTokenCeiling: 5_000_000, dailyTokenCeiling: 0 },
			{ completer: undefined, planBackend: roomy.backend },
		);
		await withRoom.planner.start({ prompt: PROMPT });
		expect(roomy.caps.length).toBeGreaterThanOrEqual(8);
		for (const cap of roomy.caps) expect(cap).toBe(16_000);
	});

	test("several usage reports of one call add up, so a failed attempt and an answering one both bill", async () => {
		const fake = fakeBackend(undefined, {
			reports: [
				{ promptTokens: 100, completionTokens: 50 },
				{ promptTokens: 20, completionTokens: 10 },
			],
		});
		const calls: PlannerCall[] = [];
		const h = setup(
			{},
			{
				completer: undefined,
				planBackend: fake.backend,
				onCall: (call) => calls.push(call),
			},
		);
		const sessionId = randomUUID();
		await h.planner.start({ prompt: PROMPT, sessionId });
		const n = fake.stages.length;
		expect(n).toBeGreaterThanOrEqual(8);
		for (const call of calls) {
			expect(call.inputTokens).toBe(120);
			expect(call.outputTokens).toBe(60);
		}
		const file = jobFile(h.stateDir, sessionId);
		expect(file.usage).toEqual({ calls: n, inputTokens: 120 * n, outputTokens: 60 * n });
		const ledger = createLedger(h.store, { runTokenCeiling: 1, dailyTokenCeiling: 1 });
		expect(ledger.spentForRun(String(file.runId))).toBe(180 * n);
	});

	test("the selected engine reports the failover the backend signalled, and none otherwise", async () => {
		const summary = "claude:claude-haiku-5-5 → grok:grok-4.7 (plan-limit)";
		const seen: Array<() => string | undefined> = [];
		const watch: Pick<HeadlessOptions, "plan"> = {
			plan: async (request, env, options) => {
				const inner = options?.selectEngine;
				if (!inner) throw new Error("planPrompt got no engine selector");
				return planPrompt(request, env, {
					...options,
					selectEngine: async (...args) => {
						const engine = await inner(...args);
						if (!("skipped" in engine) && engine.failover) seen.push(engine.failover);
						return engine;
					},
				});
			},
		};
		const switched = fakeBackend(undefined, {
			reports: [{ promptTokens: 1, completionTokens: 1 }],
			failover: summary,
		});
		const h = setup({}, { completer: undefined, planBackend: switched.backend, ...watch });
		await h.planner.start({ prompt: PROMPT });
		expect(seen.length).toBe(1);
		expect(seen[0]?.()).toBe(summary);

		seen.length = 0;
		const plain = fakeBackend();
		const p = setup({}, { completer: undefined, planBackend: plain.backend, ...watch });
		await p.planner.start({ prompt: PROMPT });
		expect(seen.length).toBe(1);
		expect(seen[0]?.()).toBeUndefined();
	});

	test("start is not_ready only while the plan backend is not ready", async () => {
		const fake = fakeBackend();
		fake.setReady({ ok: false, detail: "claude CLI not found" });
		const h = setup({}, { completer: undefined, planBackend: fake.backend });
		expect(await h.planner.start({ prompt: PROMPT })).toEqual({ ok: false, code: "not_ready" });
		expect(fake.stages).toEqual([]);
		fake.setReady({ ok: true });
		expect(await h.planner.start({ prompt: PROMPT })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
	});

	test("backendReady reports the plan backend, and is ok without consulting it when a completer replaces it", () => {
		const fake = fakeBackend();
		const plan = setup({}, { completer: undefined, planBackend: fake.backend });
		expect(plan.planner.backendReady()).toEqual({ ok: true });
		fake.setReady({ ok: false, detail: "claude CLI not found" });
		expect(plan.planner.backendReady()).toEqual({ ok: false, detail: "claude CLI not found" });

		const before = fake.readyChecks();
		const injected = setup({}, { planBackend: fake.backend });
		expect(injected.planner.backendReady()).toEqual({ ok: true });
		expect(fake.readyChecks()).toBe(before);
	});

	test("an injected completer never touches the plan backend or its readiness, and the engine label is plan:<model>", async () => {
		const fake = fakeBackend();
		fake.setReady({ ok: false, detail: "claude CLI not found" });
		const labels: Array<string | undefined> = [];
		const h = setup(
			{},
			{
				planBackend: fake.backend,
				plan: async (request, env, options) => {
					const inner = options?.selectEngine;
					if (!inner) throw new Error("planPrompt got no engine selector");
					return planPrompt(request, env, {
						...options,
						selectEngine: async (...args) => {
							const engine = await inner(...args);
							if ("skipped" in engine) return engine;
							labels.push(engine.label, engine.resolution?.label);
							return engine;
						},
					});
				},
			},
		);
		expect(await h.planner.start({ prompt: PROMPT })).toMatchObject({
			ok: true,
			data: { status: "planned" },
		});
		expect(fake.stages).toEqual([]);
		expect(fake.readyChecks()).toBe(0);
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) expect(label).toBe("plan:claude-haiku-5-5");
	});
});
