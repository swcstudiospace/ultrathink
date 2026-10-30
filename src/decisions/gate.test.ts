// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hangingFetch, JEV, recordingFetch, yieldTurn } from "../test.helpers.ts";
import {
	buildDecisionsRequest,
	createDecisions,
	type DecisionOutcome,
	type Decisions,
	type DecisionsInput,
	formatDebugLine,
	resolveOpenRouterKey,
	type RunDecisionOptions,
} from "./gate.ts";
import { openJevHealth } from "./health.ts";
import {
	buildPlanState,
	buildSkillworthyState,
	buildTeachableState,
	QUESTIONS,
} from "./questions.ts";
import {
	DECISION_POINTS,
	DEFAULT_DECISIONS_CONFIG,
	type DecisionsConfig,
	type DecisionsErrorKind,
	formatP,
} from "./types.ts";
import { USAGE_FILE } from "./usage.ts";

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const dirs: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ERR = (s: number, headers?: Record<string, string>) => () =>
	Response.json(
		{ error: { code: s, message: `upstream said no for ${K}` } },
		{ status: s, headers },
	);

function tempStore(key?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-gate-"));
	dirs.push(dir);
	const path = join(dir, "mcp-credentials.json");
	if (key !== undefined) writeStoreKey(path, key);
	return path;
}

function tempStateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-state-"));
	dirs.push(dir);
	return dir;
}

function writeStoreKey(path: string, key: string | undefined): void {
	const providers =
		key === undefined ? {} : { openrouter: { kind: "api_key", apiKey: key, updatedAt: 1 } };
	writeFileSync(path, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
}

const ON: DecisionsConfig = {
	...DEFAULT_DECISIONS_CONFIG,
	enabled: true,
	points: [...DEFAULT_DECISIONS_CONFIG.points],
};
const MESSAGE = "Add OAuth login with GitHub to the web app";
const PLAN_STATE = buildPlanState({ message: MESSAGE, recentConversation: "" });
const PLAN_OPTS: RunDecisionOptions = {
	threshold: 0.2,
	action: (p) => (p < 0.2 ? "skip-plan" : "plan"),
};

function runtime(fetchImpl: typeof fetch, overrides: Partial<DecisionsInput> = {}) {
	const lines: string[] = [];
	const decisions = createDecisions({
		config: ON,
		env: { ULTRATHINK_OPENROUTER_KEY: K },
		storePath: tempStore(),
		// A fresh state dir per runtime: one test's breaker must never refuse another test's call.
		stateDir: tempStateDir(),
		fetch: fetchImpl,
		now: () => 1000,
		sleep: async () => {
			// reason: no real delay in the fixture; retries run immediately
		},
		random: () => 0.5,
		debug: (line) => lines.push(line),
		...overrides,
	});
	return { decisions, lines };
}

describe("resolveOpenRouterKey (AC-2.8)", () => {
	test("the stored key wins over ULTRATHINK_OPENROUTER_KEY, which is the fallback", () => {
		const path = tempStore(K);
		const env = { ULTRATHINK_OPENROUTER_KEY: "sk-or-v1-ENVKEY" };
		expect(resolveOpenRouterKey(path, env)).toEqual({ key: K, source: "store" });
		writeStoreKey(path, undefined);
		expect(resolveOpenRouterKey(path, env)).toEqual({
			key: "sk-or-v1-ENVKEY",
			source: "ULTRATHINK_OPENROUTER_KEY",
		});
	});

	test("an empty store and an unset, empty or whitespace-only env key mean no key", () => {
		const path = tempStore(undefined);
		for (const value of [undefined, "", "   "])
			expect(resolveOpenRouterKey(path, { ULTRATHINK_OPENROUTER_KEY: value })).toBeUndefined();
		expect(resolveOpenRouterKey(path, {})).toBeUndefined();
	});

	test("keys are trimmed; a blank stored key, a missing or corrupt store fall back to the env", () => {
		const path = tempStore(`  ${K}  `);
		expect(resolveOpenRouterKey(path, {})).toEqual({ key: K, source: "store" });
		writeStoreKey(path, "   ");
		expect(resolveOpenRouterKey(path, { ULTRATHINK_OPENROUTER_KEY: ` ${K} ` })).toEqual({
			key: K,
			source: "ULTRATHINK_OPENROUTER_KEY",
		});
		writeFileSync(path, "{corrupt");
		expect(resolveOpenRouterKey(path, { ULTRATHINK_OPENROUTER_KEY: K })?.source).toBe(
			"ULTRATHINK_OPENROUTER_KEY",
		);
		expect(
			resolveOpenRouterKey(join(path, "missing", "store.json"), { ULTRATHINK_OPENROUTER_KEY: K })
				?.source,
		).toBe("ULTRATHINK_OPENROUTER_KEY");
	});
});

describe("Decisions.active and inactive runs (AC-2.9)", () => {
	const states = {
		plan: PLAN_STATE,
		ship: { request: "r", acceptance_criteria: [], patch: "" },
		knowledge: { question: "q", answer: "a", document: "d" },
		blocking: { task: "t", question: "q", default: "d" },
		teachable: { name: "n", description: "d", body: "b", kind: "pitfall" },
		skillworthy: { name: "n", description: "d", body: "b", kind: "playbook", occurrences: 3 },
	};

	test("enabled without any key: every point is inactive and makes zero requests", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const { decisions, lines } = runtime(r.fetch, { env: {} });
		for (const point of DECISION_POINTS) {
			expect(decisions.active(point)).toBe(false);
			expect(await decisions.run(point, states[point], PLAN_OPTS)).toEqual({ status: "inactive" });
		}
		expect(r.calls).toHaveLength(0);
		expect(lines).toEqual([]);
	});

	test("enabled:false no longer deactivates, but a point not listed is inactive even with a key (JEV-01)", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const off = runtime(r.fetch, { config: { ...ON, enabled: false } }).decisions;
		for (const point of DECISION_POINTS) expect(off.active(point)).toBe(true);
		expect((await off.run("plan", PLAN_STATE, PLAN_OPTS)).status).toBe("ok");
		const shipOnly = runtime(r.fetch, { config: { ...ON, points: ["ship"] } }).decisions;
		expect(DECISION_POINTS.filter((point) => shipOnly.active(point))).toEqual(["ship"]);
		const none = runtime(r.fetch, { config: { ...ON, points: [] } }).decisions;
		expect(DECISION_POINTS.filter((point) => none.active(point))).toEqual([]);
		expect(r.calls).toHaveLength(1);
	});

	test("K1: ULTRATHINK_DECISIONS=0 makes every point inactive with zero requests, even enabled with a key", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const { decisions, lines } = runtime(r.fetch, {
			env: { ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DECISIONS: "0" },
			storePath: tempStore(K),
		});
		for (const point of DECISION_POINTS) {
			expect(decisions.active(point)).toBe(false);
			expect(await decisions.run(point, states[point], PLAN_OPTS)).toEqual({ status: "inactive" });
		}
		expect(r.calls).toHaveLength(0);
		expect(lines).toEqual([]);
		// Only the exact value "0" is the kill switch.
		expect(
			runtime(r.fetch, {
				env: { ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DECISIONS: "1" },
			}).decisions.active("plan"),
		).toBe(true);
	});

	test("the key is read lazily, once per runtime", () => {
		const path = tempStore(undefined);
		const { decisions } = runtime(recordingFetch([JEV(0.5)]).fetch, { env: {}, storePath: path });
		writeStoreKey(path, K);
		expect(decisions.active("plan")).toBe(true);
		writeStoreKey(path, undefined);
		expect(decisions.active("ship")).toBe(true);
	});
});

describe("Decisions.run", () => {
	test("AC-3.13: an ok decision yields a content-free record with the resolved model", async () => {
		const r = recordingFetch([JEV(0.97)]);
		const { decisions, lines } = runtime(r.fetch);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome).toEqual({
			status: "ok",
			p: 0.97,
			record: {
				point: "plan",
				outcome: "ok",
				model: "typesafe/jev-1.13-20260917",
				id: "gen-dec-test",
				p: 0.97,
				probabilities: { plan_worthy: 0.97 },
				threshold: 0.2,
				action: "plan",
				latencyMs: 0,
				attempts: 1,
				cost: 0.000019,
				at: 1000,
			},
		});
		const serialized = JSON.stringify(outcome);
		expect(serialized).not.toContain(MESSAGE);
		expect(serialized).not.toContain(K);
		expect(r.calls).toHaveLength(1);
		expect(lines).toEqual([
			"decisions plan · p 0.97 · typesafe/jev-1.13-20260917 · 0ms · attempts 1 · cost 0.000019",
		]);
	});

	test("the ok action comes from the caller's rule", async () => {
		const { decisions } = runtime(recordingFetch([JEV(0.04)]).fetch);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome.status === "ok" && outcome.record.action).toBe("skip-plan");
	});

	test("AC-4.15: a failure fails open with an error record, the requested model and no key anywhere", async () => {
		const r = recordingFetch([ERR(402)]);
		const { decisions, lines } = runtime(r.fetch);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		if (outcome.status !== "error") throw new Error("expected an error outcome");
		expect(outcome.error.kind).toBe("credits");
		expect(outcome.record).toEqual({
			point: "plan",
			outcome: "error",
			model: "~typesafe/jev-latest",
			probabilities: {},
			threshold: 0.2,
			action: "fail-open",
			latencyMs: 0,
			attempts: 1,
			error: "credits",
			at: 1000,
		});
		expect(lines).toEqual(["decisions plan · error (credits) · 0ms · attempts 1"]);
		const collected = [JSON.stringify(outcome.record), outcome.error.message, ...lines].join("\n");
		expect(collected).not.toContain(K);
		expect(collected).not.toContain("Bearer sk-or-");
		expect(outcome.error.message.length).toBeLessThanOrEqual(200);
	});

	test("AC-5.1: a retried success records attempts 2", async () => {
		const r = recordingFetch([ERR(503), JEV(0.97)]);
		const outcome = await runtime(r.fetch).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome.status === "ok" && outcome.record.attempts).toBe(2);
		expect(r.calls).toHaveLength(2);
	});

	test("a caller abort is re-thrown with no record and no debug line", async () => {
		const controller = new AbortController();
		const { decisions, lines } = runtime(
			hangingFetch(() => queueMicrotask(() => controller.abort())),
		);
		let error: { name?: string } | undefined;
		try {
			await decisions.run("plan", PLAN_STATE, { ...PLAN_OPTS, signal: controller.signal });
		} catch (caught) {
			// reason: the error is captured and asserted by the caller
			error = caught as { name?: string };
		}
		expect(error?.name).toBe("AbortError");
		expect(lines).toEqual([]);
	});

	test("F3: an unexpected exception inside decide() still fails open with a redacted network record", async () => {
		const r = recordingFetch([ERR(503), JEV(0.97)]);
		const { decisions, lines } = runtime(r.fetch, {
			random: () => {
				throw new Error(`jitter source broke for ${K}`);
			},
		});
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		if (outcome.status !== "error")
			throw new Error(`expected a fail-open error, got ${outcome.status}`);
		expect(outcome.error.kind).toBe("network");
		expect(outcome.error.message).toBe("decisions network: jitter source broke for [redacted]");
		expect(outcome.record).toMatchObject({
			point: "plan",
			outcome: "error",
			action: "fail-open",
			error: "network",
		});
		expect(lines).toHaveLength(1);
		expect([JSON.stringify(outcome.record), ...lines].join("\n")).not.toContain(K);
	});

	test("sends the point's single question with zdr routing, session id and trace", async () => {
		const r = recordingFetch([JEV(0.5)]);
		await runtime(r.fetch, { sessionId: "sess-123" }).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(r.calls[0]?.body).toEqual({
			model: "~typesafe/jev-latest",
			state: { message: MESSAGE, recent_conversation: "" },
			questions: { plan_worthy: QUESTIONS.plan },
			provider: { zdr: true, data_collection: "deny" },
			session_id: "sess-123",
			trace: { trace_name: "ultrathink", span_name: "plan" },
		});
	});

	test("requests the configured model", async () => {
		const r = recordingFetch([JEV(0.5)]);
		await runtime(r.fetch, { config: { ...ON, model: "typesafe/jev-1.13" } }).decisions.run(
			"plan",
			PLAN_STATE,
			PLAN_OPTS,
		);
		expect((r.calls[0]?.body as { model: string }).model).toBe("typesafe/jev-1.13");
	});
});

describe("ULTRATHINK_DECISIONS_URL (AC-2.13)", () => {
	test("only openrouter.ai or loopback overrides are used, without query or hash; the rest fall back to the endpoint", async () => {
		const r = recordingFetch([JEV(0.5)]);
		for (const url of [
			"http://127.0.0.1:9999/decisions?token=x#h",
			"https://gw.example/d",
			"http://gw.example/d",
			"https://user:pw@openrouter.ai/api/alpha/decisions",
			"ftp://127.0.0.1/x",
			"not a url",
		]) {
			await runtime(r.fetch, {
				env: { ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DECISIONS_URL: url },
			}).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		}
		expect(r.calls.map((call) => call.url)).toEqual([
			"http://127.0.0.1:9999/decisions",
			...Array(5).fill(ENDPOINT),
		]);
		for (const call of r.calls) {
			expect(call.method).toBe("POST");
			expect(call.headers.authorization).toBe(`Bearer ${K}`);
		}
	});
});

describe("debug line (AC-3.14, §5.8)", () => {
	async function stderrOf(
		env: Record<string, string | undefined>,
		respond: () => Response,
	): Promise<string> {
		const written: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const decisions = createDecisions({
				config: ON,
				env,
				storePath: tempStore(),
				stateDir: tempStateDir(),
				fetch: recordingFetch([respond]).fetch,
				now: () => 1000,
				sleep: async () => {
					// reason: no real delay in the fixture; retries run immediately
				},
			});
			await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		} finally {
			process.stderr.write = original;
		}
		return written.filter((line) => line.includes("decisions ")).join("");
	}

	test("ULTRATHINK_DEBUG=1 writes exactly one line per decision, without the message or the key", async () => {
		const out = await stderrOf({ ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DEBUG: "1" }, JEV(0.97));
		expect(out).toBe(
			"[ultrathink] decisions plan · p 0.97 · typesafe/jev-1.13-20260917 · 0ms · attempts 1 · cost 0.000019\n",
		);
		expect(out).not.toContain(MESSAGE);
		expect(out).not.toContain(K);
	});

	test("an error writes the kind only", async () => {
		const out = await stderrOf({ ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DEBUG: "1" }, ERR(401));
		expect(out).toBe("[ultrathink] decisions plan · error (auth) · 0ms · attempts 1\n");
		expect(out).not.toContain("upstream said no");
	});

	test("without ULTRATHINK_DEBUG=1 nothing is written", async () => {
		expect(await stderrOf({ ULTRATHINK_OPENROUTER_KEY: K }, JEV(0.97))).toBe("");
		expect(await stderrOf({ ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DEBUG: "0" }, JEV(0.97))).toBe(
			"",
		);
	});

	test("formatDebugLine rounds latency and omits an absent cost", () => {
		const line = formatDebugLine({
			point: "knowledge",
			outcome: "ok",
			model: "typesafe/jev-1.13-20260917",
			p: 0.199,
			probabilities: { supported: 0.199 },
			threshold: 0.8,
			action: "reject-claim",
			latencyMs: 512.6,
			attempts: 2,
			at: 1,
		});
		expect(line).toBe(
			"decisions knowledge · p 0.19 · typesafe/jev-1.13-20260917 · 513ms · attempts 2",
		);
	});
});

describe("buildDecisionsRequest", () => {
	test("zdr off sends no provider key at all (A12)", () => {
		const request = buildDecisionsRequest("plan", PLAN_STATE, { model: "m", zdr: false });
		expect(request).not.toHaveProperty("provider");
		expect(request).not.toHaveProperty("session_id");
	});

	test("session ids are trimmed, capped at 256 chars and omitted when empty or unknown", () => {
		const input = { model: "m", zdr: true };
		expect(
			buildDecisionsRequest("plan", PLAN_STATE, { ...input, sessionId: " sess-1 " }).session_id,
		).toBe("sess-1");
		expect(
			buildDecisionsRequest("plan", PLAN_STATE, { ...input, sessionId: "s".repeat(300) })
				.session_id,
		).toBe("s".repeat(256));
		for (const sessionId of ["", "   ", "unknown", undefined]) {
			expect(buildDecisionsRequest("plan", PLAN_STATE, { ...input, sessionId })).not.toHaveProperty(
				"session_id",
			);
		}
	});

	test("each point asks its own question; the span defaults to the point", () => {
		const ship = buildDecisionsRequest(
			"ship",
			{ request: "r", acceptance_criteria: [], patch: "" },
			{ model: "m", zdr: true },
		);
		expect(ship.questions).toEqual({ complete: QUESTIONS.ship });
		expect(ship.trace).toEqual({ trace_name: "ultrathink", span_name: "ship" });
		const check = buildDecisionsRequest("plan", PLAN_STATE, {
			model: "m",
			zdr: true,
			spanName: "check",
		});
		expect(check.trace).toEqual({ trace_name: "ultrathink", span_name: "check" });
	});
});

describe("teachable and skillworthy points", () => {
	const LESSON = {
		name: "Run bun test per file",
		description: "The whole suite hides the failing file",
		body: "b".repeat(2000),
		kind: "pitfall",
	};
	const TEACHABLE_OPTS: RunDecisionOptions = {
		threshold: 0.3,
		action: (p) => (p < 0.3 ? "drop" : "keep"),
	};

	test("teachable sends its state, its question and the span name under the key `teachable`", async () => {
		const r = recordingFetch([JEV(0.9, "teachable")]);
		const outcome = await runtime(r.fetch).decisions.run(
			"teachable",
			buildTeachableState(LESSON),
			TEACHABLE_OPTS,
		);
		expect(r.calls[0]?.body).toEqual({
			model: "~typesafe/jev-latest",
			state: {
				name: LESSON.name,
				description: LESSON.description,
				body: "b".repeat(800),
				kind: "pitfall",
			},
			questions: { teachable: QUESTIONS.teachable },
			provider: { zdr: true, data_collection: "deny" },
			trace: { trace_name: "ultrathink", span_name: "teachable" },
		});
		expect(outcome.status === "ok" && outcome.record).toMatchObject({
			point: "teachable",
			p: 0.9,
			action: "keep",
			threshold: 0.3,
		});
	});

	test("skillworthy sends the occurrence count and its own question", async () => {
		const r = recordingFetch([JEV(0.2, "skillworthy")]);
		const opts: RunDecisionOptions = { threshold: 0.5, action: (p) => (p < 0.5 ? "skip" : "keep") };
		const outcome = await runtime(r.fetch).decisions.run(
			"skillworthy",
			buildSkillworthyState({ ...LESSON, occurrences: 4 }),
			opts,
		);
		const body = r.calls[0]?.body as {
			state: Record<string, unknown>;
			questions: Record<string, unknown>;
		};
		expect(body.state).toEqual({ ...LESSON, body: "b".repeat(800), occurrences: 4 });
		expect(body.questions).toEqual({ skillworthy: QUESTIONS.skillworthy });
		expect(outcome.status === "ok" && outcome.record).toMatchObject({
			point: "skillworthy",
			p: 0.2,
			action: "skip",
			probabilities: { skillworthy: 0.2 },
		});
	});

	test("each is active only when listed, and the default list names both", () => {
		expect(DEFAULT_DECISIONS_CONFIG.points).toEqual([
			"plan",
			"ship",
			"knowledge",
			"blocking",
			"teachable",
			"skillworthy",
		]);
		const r = recordingFetch([JEV(0.5)]);
		const onlyTeachable = runtime(r.fetch, { config: { ...ON, points: ["teachable"] } }).decisions;
		expect(DECISION_POINTS.filter((point) => onlyTeachable.active(point))).toEqual(["teachable"]);
		const planOnly = runtime(r.fetch, { config: { ...ON, points: ["plan"] } }).decisions;
		expect(planOnly.active("teachable")).toBe(false);
		expect(planOnly.active("skillworthy")).toBe(false);
	});

	test("the kill switch makes both inactive without a request", async () => {
		const r = recordingFetch([JEV(0.5, "teachable")]);
		const { decisions } = runtime(r.fetch, {
			env: { ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DECISIONS: "0" },
		});
		expect(await decisions.run("teachable", buildTeachableState(LESSON), TEACHABLE_OPTS)).toEqual({
			status: "inactive",
		});
		expect(
			await decisions.run(
				"skillworthy",
				buildSkillworthyState({ ...LESSON, occurrences: 1 }),
				TEACHABLE_OPTS,
			),
		).toEqual({ status: "inactive" });
		expect(r.calls).toHaveLength(0);
	});

	test("every failure kind returns a fail-open error record", async () => {
		const invalid = () =>
			Response.json({
				model: "m",
				answers: { teachable: { type: "noul", noul: 7 } },
				usage: { input_tokens: 1, output_tokens: 0 },
			});
		const throwing = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		const cases: Array<[DecisionsErrorKind, typeof fetch]> = [
			["auth", recordingFetch([ERR(401)]).fetch],
			["credits", recordingFetch([ERR(402)]).fetch],
			["bad-request", recordingFetch([ERR(400)]).fetch],
			["too-large", recordingFetch([ERR(413)]).fetch],
			["rate-limit", recordingFetch([ERR(429)]).fetch],
			["upstream", recordingFetch([ERR(500)]).fetch],
			["timeout", recordingFetch([ERR(408)]).fetch],
			["invalid-response", recordingFetch([invalid]).fetch],
			["network", throwing],
		];
		for (const [kind, fetchImpl] of cases) {
			const outcome = await runtime(fetchImpl).decisions.run(
				"teachable",
				buildTeachableState(LESSON),
				TEACHABLE_OPTS,
			);
			if (outcome.status !== "error") throw new Error(`expected an error for ${kind}`);
			expect(outcome.error.kind).toBe(kind);
			expect(outcome.record).toMatchObject({
				point: "teachable",
				action: "fail-open",
				error: kind,
			});
		}
	});
});

describe("formatP (A2)", () => {
	test("prints two decimals, truncated so a value never crosses its threshold", () => {
		expect([0.199, 0.2, 0.97, 0.03, 0.29, 0.3, 1, 0, 0.04].map(formatP)).toEqual([
			"0.19",
			"0.20",
			"0.97",
			"0.03",
			"0.29",
			"0.30",
			"1.00",
			"0.00",
			"0.04",
		]);
	});
});

describe("the Jev key is OpenRouter's alone (JEV-02)", () => {
	const V = "vck_test_key_do_not_use";
	function storeWith(providers: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "ut-decisions-key-"));
		dirs.push(dir);
		const path = join(dir, "mcp-credentials.json");
		writeFileSync(path, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
		return path;
	}
	const stored = (key: string) => ({ kind: "api_key", apiKey: key, updatedAt: 1 });

	test("a stored Vercel credential and AI_GATEWAY_API_KEY are ignored: the call goes to OpenRouter with the Jev model", async () => {
		const path = storeWith({ vercel: stored(V) });
		expect(resolveOpenRouterKey(path, { AI_GATEWAY_API_KEY: V })).toBeUndefined();
		const r = recordingFetch([JEV(0.97)]);
		const { decisions } = runtime(r.fetch, {
			storePath: path,
			env: { AI_GATEWAY_API_KEY: V, ULTRATHINK_OPENROUTER_KEY: K },
		});
		expect(decisions.active("plan")).toBe(true);
		expect(kindOf(await plan(decisions))).toBe("ok");
		expect(r.calls).toHaveLength(1);
		const call = r.calls[0];
		if (!call) throw new Error("expected a decisions call");
		expect(call.url).toBe(ENDPOINT);
		expect(call.headers.authorization).toBe(`Bearer ${K}`);
		expect(call.body).toMatchObject({ model: "~typesafe/jev-latest" });
	});

	test("with no OpenRouter key the decision is inactive and sends nothing, whatever else is stored or exported", async () => {
		const r = recordingFetch([JEV(0.97)]);
		const { decisions } = runtime(r.fetch, {
			storePath: storeWith({ vercel: stored(V) }),
			env: { AI_GATEWAY_API_KEY: V },
		});
		expect(decisions.active("plan")).toBe(false);
		expect(await plan(decisions)).toEqual({ status: "inactive" });
		expect(r.calls).toHaveLength(0);
	});

	test("the kill switch turns OpenRouter off with zero requests", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const { decisions } = runtime(r.fetch, {
			env: { ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DECISIONS: "0" },
		});
		expect(decisions.active("plan")).toBe(false);
		expect(await plan(decisions)).toEqual({ status: "inactive" });
		expect(r.calls).toHaveLength(0);
	});
});

const plan = (decisions: Decisions): Promise<DecisionOutcome> =>
	decisions.run("plan", PLAN_STATE, PLAN_OPTS);
const kindOf = (outcome: DecisionOutcome): string =>
	outcome.status === "error" ? outcome.error.kind : outcome.status;

describe("the legacy OPENROUTER_API_KEY is not read", () => {
	const LEGACY = "sk-or-v1-LEGACYKEY-0123456789abcdef";

	test("resolveOpenRouterKey ignores it, with or without a store entry", () => {
		expect(
			resolveOpenRouterKey(tempStore(undefined), { OPENROUTER_API_KEY: LEGACY }),
		).toBeUndefined();
		expect(resolveOpenRouterKey(tempStore(K), { OPENROUTER_API_KEY: LEGACY })).toEqual({
			key: K,
			source: "store",
		});
		expect(
			resolveOpenRouterKey(tempStore(undefined), {
				OPENROUTER_API_KEY: LEGACY,
				ULTRATHINK_OPENROUTER_KEY: K,
			}),
		).toEqual({ key: K, source: "ULTRATHINK_OPENROUTER_KEY" });
	});

	test("a decide with only the legacy variable reports no key and makes zero requests", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const { decisions } = runtime(r.fetch, { env: { OPENROUTER_API_KEY: LEGACY } });
		expect(decisions.active("plan")).toBe(false);
		expect(await plan(decisions)).toEqual({ status: "inactive" });
		expect(r.calls).toHaveLength(0);
	});
});

describe("health breaker on the Jev rails", () => {
	const T = Date.UTC(2026, 9, 28, 12, 0, 0);
	const BASE = 300_000;
	const neverAnswers = () => Promise.withResolvers<Response>().promise;

	test("a 402 opens it: later calls, here and in another process, make zero requests and return a typed unavailable error", async () => {
		const dir = tempStateDir();
		const r = recordingFetch([ERR(402), JEV(0.9)]);
		const { decisions, lines } = runtime(r.fetch, { stateDir: dir });
		expect(kindOf(await plan(decisions))).toBe("credits");
		expect(r.calls).toHaveLength(1);
		const refused = await plan(decisions);
		if (refused.status !== "error") throw new Error("expected the breaker to refuse the call");
		expect(refused.error.kind).toBe("unavailable");
		expect(refused.error.message).toStartWith(
			"decisions unavailable: OpenRouter reports insufficient credits; next check ",
		);
		expect(refused.error.message.length).toBeLessThanOrEqual(200);
		expect(refused.record).toEqual({
			point: "plan",
			outcome: "error",
			model: "~typesafe/jev-latest",
			probabilities: {},
			threshold: 0.2,
			action: "fail-open",
			latencyMs: 0,
			attempts: 0,
			error: "unavailable",
			at: 1000,
		});
		expect(lines.at(-1)).toBe("decisions plan · error (unavailable) · 0ms · attempts 0");
		const other = runtime(r.fetch, { stateDir: dir }).decisions;
		const shipState = { request: "r", acceptance_criteria: [], patch: "" };
		expect(kindOf(await other.run("ship", shipState, PLAN_OPTS))).toBe("unavailable");
		expect(kindOf(await plan(other))).toBe("unavailable");
		expect(r.calls).toHaveLength(1);
		const file = join(dir, "decisions-health-openrouter.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).not.toContain(K);
	});

	test("401 and 403 open it too", async () => {
		for (const status of [401, 403]) {
			const r = recordingFetch([ERR(status), JEV(0.9)]);
			const { decisions } = runtime(r.fetch);
			expect(kindOf(await plan(decisions))).toBe("auth");
			expect(kindOf(await plan(decisions))).toBe("unavailable");
			expect(r.calls).toHaveLength(1);
		}
	});

	test("429, 5xx, a timeout and a network error do not open it: the next call still goes out", async () => {
		const cases: Array<[string, () => Response | Promise<Response>, Partial<DecisionsConfig>]> = [
			["429", ERR(429), {}],
			["500", ERR(500), {}],
			["503", ERR(503), {}],
			["408", ERR(408), {}],
			[
				"network",
				() => {
					throw new Error("connection refused");
				},
				{},
			],
			["timeout", neverAnswers, { timeoutMs: 20 }],
		];
		for (const [label, respond, config] of cases) {
			const dir = tempStateDir();
			const r = recordingFetch([respond]);
			const { decisions } = runtime(r.fetch, { stateDir: dir, config: { ...ON, ...config } });
			const first = await plan(decisions);
			if (first.status !== "error") throw new Error(`${label}: expected a failure`);
			const before = r.calls.length;
			const second = await plan(decisions);
			if (kindOf(second) === "unavailable") throw new Error(`${label}: opened the breaker`);
			if (r.calls.length <= before) throw new Error(`${label}: the next call made no request`);
			expect(openJevHealth(dir).read().state).toBe("closed");
		}
	});

	test("a hand-built open file proves it across processes: zero requests, typed unavailable", async () => {
		const dir = tempStateDir();
		writeFileSync(
			join(dir, "decisions-health-openrouter.json"),
			JSON.stringify({
				v: 1,
				state: "open",
				cause: "auth",
				since: 0,
				nextProbeAt: 1000 + 60_000,
				coolDownMs: BASE,
				failures: 1,
			}),
		);
		const r = recordingFetch([JEV(0.9)]);
		const outcome = await plan(runtime(r.fetch, { stateDir: dir }).decisions);
		if (outcome.status !== "error") throw new Error("expected the breaker to refuse the call");
		expect(outcome.error.kind).toBe("unavailable");
		expect(outcome.error.message).toContain("OpenRouter rejected the key");
		expect(r.calls).toHaveLength(0);
	});

	test("after the cool-down one call probes, and a success closes the breaker", async () => {
		const dir = tempStateDir();
		const clock = { now: T };
		const health = openJevHealth(dir, { rng: () => 0.5 });
		const r = recordingFetch([ERR(402), JEV(0.9)]);
		const { decisions } = runtime(r.fetch, { stateDir: dir, health, now: () => clock.now });
		expect(kindOf(await plan(decisions))).toBe("credits");
		clock.now = T + BASE - 1;
		expect(kindOf(await plan(decisions))).toBe("unavailable");
		expect(r.calls).toHaveLength(1);
		clock.now = T + BASE;
		expect(kindOf(await plan(decisions))).toBe("ok");
		expect(r.calls).toHaveLength(2);
		expect(health.read().state).toBe("closed");
		expect(kindOf(await plan(decisions))).toBe("ok");
		expect(r.calls).toHaveLength(3);
	});

	test("while one process probes, a second process stays off", async () => {
		const dir = tempStateDir();
		openJevHealth(dir, { rng: () => 0.5 }).recordFailure("credits", T);
		const answer = Promise.withResolvers<Response>();
		const probe = recordingFetch([() => answer.promise]);
		const first = runtime(probe.fetch, { stateDir: dir, now: () => T + BASE }).decisions;
		const pending = plan(first);
		await yieldTurn();
		expect(probe.calls).toHaveLength(1);
		const second = runtime(probe.fetch, { stateDir: dir, now: () => T + BASE + 1000 }).decisions;
		expect(kindOf(await plan(second))).toBe("unavailable");
		expect(probe.calls).toHaveLength(1);
		answer.resolve(JEV(0.9)());
		expect(kindOf(await pending)).toBe("ok");
	});

	test("after a 402 the same URL, model and key are used on every later attempt and nothing else is contacted", async () => {
		const dir = tempStateDir();
		const clock = { now: T };
		const health = openJevHealth(dir, { rng: () => 0.5 });
		const r = recordingFetch([ERR(402)]);
		const { decisions } = runtime(r.fetch, { stateDir: dir, health, now: () => clock.now });
		const kinds: string[] = [];
		for (let round = 0; round < 3; round++) {
			kinds.push(kindOf(await plan(decisions)));
			kinds.push(kindOf(await plan(decisions)));
			clock.now = health.read().nextProbeAt ?? 0;
		}
		expect(kinds).toEqual([
			"credits",
			"unavailable",
			"credits",
			"unavailable",
			"credits",
			"unavailable",
		]);
		expect(r.calls).toHaveLength(3);
		for (const call of r.calls) {
			expect(call.url).toBe(ENDPOINT);
			expect(call.body).toMatchObject({ model: "~typesafe/jev-latest" });
			expect(call.headers.authorization).toBe(`Bearer ${K}`);
		}
		// Each failed probe doubled the cool-down.
		expect(health.read().coolDownMs).toBe(BASE * 4);
	});

	test("without a stateDir nothing is written anywhere, yet the breaker still refuses in-process", async () => {
		const spy = tempStateDir();
		const home = process.env.HOME;
		const cwd = process.cwd();
		// Every place a default could land (HOME, the cwd, the state-dir env vars) is the same empty spy dir.
		process.env.HOME = spy;
		process.chdir(spy);
		try {
			const r = recordingFetch([ERR(402), JEV(0.9)]);
			const { decisions } = runtime(r.fetch, {
				stateDir: undefined,
				env: {
					ULTRATHINK_OPENROUTER_KEY: K,
					HOME: spy,
					ULTRATHINK_STATE_DIR: join(spy, "state"),
					CLAUDE_CONFIG_DIR: join(spy, ".claude"),
				},
			});
			expect(kindOf(await plan(decisions))).toBe("credits");
			expect(kindOf(await plan(decisions))).toBe("unavailable");
			expect(r.calls).toHaveLength(1);
			// The breaker is this runtime's own: a fresh one has no memory of the 402.
			const fresh = runtime(r.fetch, { stateDir: undefined }).decisions;
			expect(kindOf(await plan(fresh))).toBe("ok");
			expect(r.calls).toHaveLength(2);
		} finally {
			process.chdir(cwd);
			if (home !== undefined) process.env.HOME = home;
		}
		expect(readdirSync(spy)).toEqual([]);
	});
});

describe("usage ledger", () => {
	const rows = (dir: string): Array<Record<string, unknown>> =>
		readFileSync(join(dir, USAGE_FILE), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

	test("an ok call appends one record: served model, tokens, cost and request id", async () => {
		const dir = tempStateDir();
		await plan(runtime(recordingFetch([JEV(0.97)]).fetch, { stateDir: dir }).decisions);
		expect(rows(dir)).toEqual([
			{
				ts: 1000,
				point: "plan",
				rail: "openrouter",
				requestedModel: "~typesafe/jev-latest",
				servedModel: "typesafe/jev-1.13-20260917",
				ok: true,
				ms: 0,
				promptTokens: 450,
				completionTokens: 0,
				costUsd: 0.000019,
				requestId: "gen-dec-test",
			},
		]);
	});

	test("a failure is ledgered with kind and status; a breaker refusal appends nothing", async () => {
		const dir = tempStateDir();
		const { decisions } = runtime(recordingFetch([ERR(402)]).fetch, { stateDir: dir });
		await plan(decisions);
		await plan(decisions);
		expect(rows(dir)).toEqual([
			{
				ts: 1000,
				point: "plan",
				rail: "openrouter",
				requestedModel: "~typesafe/jev-latest",
				ok: false,
				kind: "credits",
				status: 402,
				ms: 0,
			},
		]);
	});

	test("a refused model makes no request, no ledger row and no breaker entry", async () => {
		const dir = tempStateDir();
		const r = recordingFetch([JEV(0.9)]);
		const { decisions } = runtime(r.fetch, {
			stateDir: dir,
			config: { ...ON, model: "anthropic/claude-opus-5.5" },
		});
		expect(kindOf(await plan(decisions))).toBe("model");
		expect(r.calls).toHaveLength(0);
		expect(existsSync(join(dir, USAGE_FILE))).toBe(false);
		expect(existsSync(join(dir, "decisions-health-openrouter.json"))).toBe(false);
	});

	test("neither the ledger nor the health file holds the key, the prompt or an upstream body", async () => {
		const dir = tempStateDir();
		const good = runtime(recordingFetch([JEV(0.9)]).fetch, {
			stateDir: dir,
			env: {},
			storePath: tempStore(K),
		});
		await plan(good.decisions);
		const bad = runtime(recordingFetch([ERR(402)]).fetch, { stateDir: dir });
		await plan(bad.decisions);
		const text = ["decisions-health-openrouter.json", USAGE_FILE]
			.map((name) => readFileSync(join(dir, name), "utf8"))
			.join("\n");
		for (const secret of [K, MESSAGE, "Bearer", "upstream said no", "sk-or-"])
			expect(text).not.toContain(secret);
		// The files were really written, so the absence above means something.
		expect(text).toContain("credits");
		expect(rows(dir)).toHaveLength(2);
	});
});

describe("breaker, stragglers and the per-POST ledger", () => {
	const T = Date.UTC(2026, 9, 28, 12, 0, 0);
	const BASE = 300_000;
	const usageRows = (dir: string): Array<Record<string, unknown>> =>
		readFileSync(join(dir, USAGE_FILE), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

	test("a spent OpenRouter account refuses later calls with its own text, and writes only the OpenRouter breaker file", async () => {
		const dir = tempStateDir();
		const r = recordingFetch([ERR(402)]);
		const { decisions } = runtime(r.fetch, { stateDir: dir });
		expect(kindOf(await plan(decisions))).toBe("credits");
		const refused = await plan(decisions);
		if (refused.status !== "error") throw new Error("expected the breaker to refuse");
		expect(refused.error.message).toStartWith(
			"decisions unavailable: OpenRouter reports insufficient credits",
		);
		expect(r.calls).toHaveLength(1);
		const files = readdirSync(dir).filter((name) => name.startsWith("decisions-health"));
		expect(files).toEqual(["decisions-health-openrouter.json"]);
	});

	test("decisions started together cannot double the cool-down: every failure after the first is a straggler", async () => {
		const dir = tempStateDir();
		const health = openJevHealth(dir, { rng: () => 0.5 });
		const r = recordingFetch([ERR(402)]);
		const { decisions } = runtime(r.fetch, { stateDir: dir, health, now: () => T });
		const outcomes = await Promise.all([plan(decisions), plan(decisions), plan(decisions)]);
		expect(outcomes.map(kindOf)).toEqual(["credits", "credits", "credits"]);
		expect(r.calls).toHaveLength(3);
		expect(health.read()).toMatchObject({
			state: "open",
			coolDownMs: BASE,
			nextProbeAt: T + BASE,
			failures: 3,
		});
	});

	test("a success already in flight cannot erase a newer hard failure", async () => {
		const dir = tempStateDir();
		const health = openJevHealth(dir, { rng: () => 0.5 });
		const slow = Promise.withResolvers<Response>();
		const r = recordingFetch([ERR(402), () => slow.promise]);
		const { decisions } = runtime(r.fetch, { stateDir: dir, health, now: () => T });
		const failing = plan(decisions);
		const inFlight = plan(decisions);
		expect(kindOf(await failing)).toBe("credits");
		expect(health.read().state).toBe("open");
		slow.resolve(JEV(0.9)());
		expect(kindOf(await inFlight)).toBe("ok");
		expect(health.read()).toMatchObject({ state: "open", cause: "credits" });
		expect(kindOf(await plan(decisions))).toBe("unavailable");
		expect(r.calls).toHaveLength(2);
	});

	test("the ledger records each real POST: a 503 retried to success is two rows", async () => {
		const dir = tempStateDir();
		const r = recordingFetch([ERR(503), JEV(0.97)]);
		const outcome = await plan(runtime(r.fetch, { stateDir: dir }).decisions);
		expect(outcome.status === "ok" && outcome.record.attempts).toBe(2);
		expect(r.calls).toHaveLength(2);
		expect(usageRows(dir)).toEqual([
			{
				ts: 1000,
				point: "plan",
				rail: "openrouter",
				requestedModel: "~typesafe/jev-latest",
				ok: false,
				kind: "upstream",
				status: 503,
				ms: 0,
			},
			{
				ts: 1000,
				point: "plan",
				rail: "openrouter",
				requestedModel: "~typesafe/jev-latest",
				servedModel: "typesafe/jev-1.13-20260917",
				ok: true,
				ms: 0,
				promptTokens: 450,
				completionTokens: 0,
				costUsd: 0.000019,
				requestId: "gen-dec-test",
			},
		]);
	});
});
