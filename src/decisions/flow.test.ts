// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendFlowScore,
	evaluateFlowOutput,
	FLOW_OUTPUT_MAX,
	flowEvalActive,
	isGsdFlowCommand,
	lookupFlowScore,
} from "./flow.ts";
import { openJevHealth } from "./health.ts";
import { DEFAULT_DECISIONS_CONFIG, VERCEL_DECISIONS_URL } from "./types.ts";
import { USAGE_FILE } from "./usage.ts";

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-flow-"));
	dirs.push(dir);
	return dir;
}

const usage = { input_tokens: 3, output_tokens: 2 };
function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
function ok(choice: string, confidence?: number, id = "req_1") {
	return json({
		id,
		model: "~typesafe/jev-latest",
		answers: {
			verdict: { type: "choice", choice, ...(confidence === undefined ? {} : { confidence }) },
		},
		usage,
	});
}

describe("evaluateFlowOutput", () => {
	test("a choice with in-range confidence is success on OpenRouter", async () => {
		const record = await evaluateFlowOutput({
			subject: "phase:discuss",
			output: "CONTEXT.md written",
			apiKey: "sk-test",
			fetch: (async () => ok("approve", 0.82)) as unknown as typeof fetch,
		});
		expect(record.state).toBe("success");
		expect(record.decision).toBe("approve");
		expect(record.confidence).toBe(0.82);
		expect(record.provider).toBe("OpenRouter");
		expect(record.requestId).toBe("req_1");
		expect(record.clearsHumanPause).toBe(false);
	});

	test("missing confidence fails after one repair", async () => {
		let calls = 0;
		const record = await evaluateFlowOutput({
			subject: "phase:plan",
			output: "plan body",
			apiKey: "sk-test",
			fetch: (async () => {
				calls += 1;
				return ok("approve");
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(2);
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("invalid-response");
		expect(record.confidence).toBeNull();
	});

	test("out-of-range confidence fails after repair", async () => {
		const record = await evaluateFlowOutput({
			subject: "phase:execute",
			output: "done",
			apiKey: "sk-test",
			fetch: (async () => ok("approve", 1.4)) as unknown as typeof fetch,
		});
		expect(record.state).toBe("error");
		expect(record.confidence).toBeNull();
	});

	test("401 is terminal auth and does not invent a score", async () => {
		let calls = 0;
		const record = await evaluateFlowOutput({
			subject: "audit",
			output: "audit text",
			apiKey: "sk-test",
			fetch: (async () => {
				calls += 1;
				return json({ error: { message: "unauthorized" } }, 401);
			}) as unknown as typeof fetch,
		});
		expect(calls).toBe(1);
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("auth");
		expect(record.confidence).toBeNull();
	});

	test("empty output is an explicit skip", async () => {
		const record = await evaluateFlowOutput({
			subject: "cleanup",
			output: "  \n",
			apiKey: "sk-test",
			fetch: (async () => {
				throw new Error("no");
			}) as unknown as typeof fetch,
		});
		expect(record.state).toBe("empty");
		expect(record.confidence).toBeNull();
	});

	test("oversized output is not scored", async () => {
		const record = await evaluateFlowOutput({
			subject: "summary",
			output: "x".repeat(FLOW_OUTPUT_MAX + 1),
			apiKey: "sk-test",
			fetch: (async () => ok("approve", 1)) as unknown as typeof fetch,
		});
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("truncated");
		expect(record.confidence).toBeNull();
	});

	test("identical success bytes are reused", () => {
		const dir = mkdtempSync(join(tmpdir(), "flow-"));
		const path = join(dir, "flow-decisions.jsonl");
		const record = {
			version: 1 as const,
			subject: "s",
			hash: "abc",
			decision: "approve" as const,
			confidence: 0.5,
			rationale: "choice.confidence",
			model: "m",
			provider: "OpenRouter" as const,
			state: "success" as const,
			retryCount: 0,
			at: 1,
			latencyMs: 1,
			clearsHumanPause: false as const,
		};
		appendFlowScore(path, record);
		expect(lookupFlowScore(path, "abc")?.confidence).toBe(0.5);
		expect(lookupFlowScore(path, "nope")).toBeUndefined();
	});
});

describe("flowEvalActive", () => {
	function storeFile(): string {
		const path = join(tempDir(), "mcp-credentials.json");
		writeFileSync(path, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
		return path;
	}

	test("true only with a usable key on the picked rail and the kill switch off", () => {
		const storePath = storeFile();
		const input = { subject: "s", output: "o", storePath };
		expect(flowEvalActive(input, { AI_GATEWAY_API_KEY: "vck_CANARYCANARYCANARY1234" })).toBe(true);
		expect(flowEvalActive(input, { ULTRATHINK_OPENROUTER_KEY: K })).toBe(true);
		expect(flowEvalActive(input, {})).toBe(false);
		// OPENROUTER_API_KEY is not a Jev key variable.
		expect(flowEvalActive(input, { OPENROUTER_API_KEY: K })).toBe(false);
		expect(flowEvalActive(input, { ULTRATHINK_OPENROUTER_KEY: K, ULTRATHINK_DECISIONS: "0" })).toBe(
			false,
		);
	});

	test("agrees with evaluateFlowOutput: inactive exactly when the evaluation is inactive", async () => {
		const storePath = storeFile();
		for (const env of [{}, { ULTRATHINK_OPENROUTER_KEY: K }, { ULTRATHINK_DECISIONS: "0" }]) {
			const input = { subject: "s", output: "", storePath, env };
			const record = await evaluateFlowOutput(input);
			expect(flowEvalActive(input, env)).toBe(record.state !== "inactive");
		}
	});
});

describe("isGsdFlowCommand", () => {
	test("matches gsd skill and phase commands and skips unrelated tools", () => {
		expect(isGsdFlowCommand("Skill", "gsd-discuss-phase 15")).toBe(true);
		expect(isGsdFlowCommand("Bash", "echo hi && gsd-audit-milestone")).toBe(true);
		expect(isGsdFlowCommand("Bash", "bun test")).toBe(false);
		expect(isGsdFlowCommand("Read", "src/decisions/flow.ts")).toBe(false);
	});
});

describe("evaluateFlowOutput rail selection", () => {
	const OUTPUT = "SENTINEL-FLOW-OUTPUT written to CONTEXT.md";
	const VK = "vck_CANARYCANARYCANARY1234";
	const OK_KEY = "sk-or-v1-CANARYCANARYCANARY1234";

	function emptyStore(): string {
		const store = join(tempDir(), "mcp-credentials.json");
		writeFileSync(store, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
		return store;
	}

	function vercelAnswer(choice: string, confidence: number): Response {
		return json({
			answers: { verdict: { type: "choice", choice } },
			providerMetadata: { typesafe: { confidence: { verdict: confidence } } },
			usage: { inputTokens: 3, outputTokens: 2 },
		});
	}

	function recording(respond: () => Response) {
		const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(input),
				body: JSON.parse(String(init?.body)) as Record<string, unknown>,
				headers: new Headers(init?.headers),
			});
			return respond();
		}) as unknown as typeof fetch;
		return { fetch: fetchImpl, calls };
	}

	function evaluate(
		fetchImpl: typeof fetch,
		extra: {
			env?: Record<string, string | undefined>;
			config?: typeof DEFAULT_DECISIONS_CONFIG;
			output?: string;
			stateDir?: string;
		},
	) {
		return evaluateFlowOutput({
			subject: "phase:discuss",
			output: extra.output ?? OUTPUT,
			storePath: emptyStore(),
			fetch: fetchImpl,
			now: () => 1000,
			env: {},
			...extra,
		});
	}

	test("no key on either rail is inactive: no request, no usage row, no breaker file, whatever the output", async () => {
		const dir = tempDir();
		const r = recording(() => ok("approve", 0.9));
		// The generic OpenRouter variable is never read, so exporting it must not make the hook speak.
		const env = { OPENROUTER_API_KEY: OK_KEY };
		for (const output of [OUTPUT, "  \n", "x".repeat(FLOW_OUTPUT_MAX + 1)]) {
			const record = await evaluate(r.fetch, { env, output, stateDir: dir });
			expect(record.state).toBe("inactive");
			expect(record.decision).toBeNull();
			expect(record.confidence).toBeNull();
		}
		expect(r.calls).toHaveLength(0);
		expect(existsSync(join(dir, USAGE_FILE))).toBe(false);
		expect(existsSync(join(dir, "decisions-health-openrouter.json"))).toBe(false);
	});

	test("a pinned rail with no key is inactive even when the other rail has one", async () => {
		const r = recording(() => ok("approve", 0.9));
		const onlyVercel = { AI_GATEWAY_API_KEY: VK };
		const onlyOpenRouter = { ULTRATHINK_OPENROUTER_KEY: OK_KEY };
		expect(
			(
				await evaluate(r.fetch, {
					env: onlyVercel,
					config: { ...DEFAULT_DECISIONS_CONFIG, provider: "openrouter" },
				})
			).state,
		).toBe("inactive");
		expect(
			(
				await evaluate(r.fetch, {
					env: onlyOpenRouter,
					config: { ...DEFAULT_DECISIONS_CONFIG, provider: "vercel" },
				})
			).state,
		).toBe("inactive");
		expect(r.calls).toHaveLength(0);
	});

	test("the kill switch is inactive before any resolution or request, keys present", async () => {
		const r = recording(() => ok("approve", 0.9));
		const record = await evaluate(r.fetch, {
			env: { ULTRATHINK_DECISIONS: "0", AI_GATEWAY_API_KEY: VK, ULTRATHINK_OPENROUTER_KEY: OK_KEY },
		});
		expect(record.state).toBe("inactive");
		expect(r.calls).toHaveLength(0);
	});

	test("a Vercel-only key decides on the Vercel rail: the choice question goes out, no ZDR preference, rail named", async () => {
		const dir = tempDir();
		const r = recording(() => vercelAnswer("approve", 0.77));
		const record = await evaluate(r.fetch, { env: { AI_GATEWAY_API_KEY: VK }, stateDir: dir });
		expect(record.state).toBe("success");
		expect(record.decision).toBe("approve");
		expect(record.confidence).toBe(0.77);
		expect(record.provider).toBe("Vercel");
		expect(r.calls).toHaveLength(1);
		const call = r.calls[0]!;
		expect(call.url).toBe(VERCEL_DECISIONS_URL);
		expect(call.headers.get("authorization")).toBe(`Bearer ${VK}`);
		expect(call.headers.get("ai-model-id")).toBe("typesafe-ai/jev");
		const questions = call.body.questions as Record<string, { type: string }>;
		expect(questions.verdict?.type).toBe("choice");
		expect(call.body.provider).toBeUndefined();
		expect(JSON.stringify(call.body)).toContain(OUTPUT);
		expect(JSON.stringify(call.body)).not.toContain('"zdr"');
		const usageRows = readFileSync(join(dir, USAGE_FILE), "utf8").trim().split("\n");
		expect(usageRows).toHaveLength(1);
		expect(JSON.parse(usageRows[0]!)).toMatchObject({ point: "flow", rail: "vercel", ok: true });
		expect(existsSync(join(dir, "decisions-health-openrouter.json"))).toBe(false);
	});

	test("Vercel answer without a confidence is one repair then a flow error, never a default score", async () => {
		const r = recording(() =>
			json({
				answers: { verdict: { type: "choice", choice: "approve" } },
				usage: { inputTokens: 3, outputTokens: 2 },
			}),
		);
		const record = await evaluate(r.fetch, { env: { AI_GATEWAY_API_KEY: VK } });
		expect(r.calls).toHaveLength(2);
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("invalid-response");
		expect(record.confidence).toBeNull();
		expect(record.provider).toBe("Vercel");
	});

	test("a Vercel breaker open on its own rail refuses the call with zero requests, naming Vercel", async () => {
		const dir = tempDir();
		openJevHealth(dir, "vercel").recordFailure("credits", 1000);
		const r = recording(() => vercelAnswer("approve", 0.9));
		const record = await evaluate(r.fetch, {
			env: { AI_GATEWAY_API_KEY: VK },
			stateDir: dir,
		});
		expect(record.errorClass).toBe("unavailable");
		expect(record.rationale).not.toContain("OpenRouter");
		expect(r.calls).toHaveLength(0);
	});

	test("an OpenRouter-only key decides on OpenRouter with decisions.zdr and honors ULTRATHINK_DECISIONS_URL", async () => {
		const r = recording(() => ok("approve", 0.6));
		const env = {
			ULTRATHINK_OPENROUTER_KEY: OK_KEY,
			ULTRATHINK_DECISIONS_URL: "http://127.0.0.1:9/api/alpha/decisions",
		};
		const withZdr = await evaluate(r.fetch, { env });
		expect(withZdr.provider).toBe("OpenRouter");
		expect(r.calls[0]?.url).toBe("http://127.0.0.1:9/api/alpha/decisions");
		expect(r.calls[0]?.body.provider).toEqual({ zdr: true });
		await evaluate(r.fetch, { env, config: { ...DEFAULT_DECISIONS_CONFIG, zdr: false } });
		expect(r.calls[1]?.body.provider).toBeUndefined();
	});

	test("with both keys auto picks Vercel; decisions.provider pins either rail", async () => {
		const env = { AI_GATEWAY_API_KEY: VK, ULTRATHINK_OPENROUTER_KEY: OK_KEY };
		const urls: string[] = [];
		const routed = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return String(input) === VERCEL_DECISIONS_URL
				? vercelAnswer("approve", 0.6)
				: ok("approve", 0.6);
		}) as unknown as typeof fetch;
		const auto = await evaluate(routed, { env });
		const pinnedOpenRouter = await evaluate(routed, {
			env,
			config: { ...DEFAULT_DECISIONS_CONFIG, provider: "openrouter" },
		});
		const pinnedVercel = await evaluate(routed, {
			env,
			config: { ...DEFAULT_DECISIONS_CONFIG, provider: "vercel" },
		});
		expect([auto.provider, pinnedOpenRouter.provider, pinnedVercel.provider]).toEqual([
			"Vercel",
			"OpenRouter",
			"Vercel",
		]);
		expect(urls).toEqual([
			VERCEL_DECISIONS_URL,
			"https://openrouter.ai/api/alpha/decisions",
			VERCEL_DECISIONS_URL,
		]);
	});

	test("the store key resolves like the gates: stored Vercel key beats nothing, and the key never reaches the record", async () => {
		const store = join(tempDir(), "mcp-credentials.json");
		const providers = { vercel: { kind: "api_key", apiKey: VK, updatedAt: 1 } };
		writeFileSync(store, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
		const r = recording(() => vercelAnswer("reject", 0.4));
		const record = await evaluateFlowOutput({
			subject: "phase:plan",
			output: OUTPUT,
			storePath: store,
			env: {},
			fetch: r.fetch,
		});
		expect(record.state).toBe("success");
		expect(r.calls[0]?.headers.get("authorization")).toBe(`Bearer ${VK}`);
		const serialized = JSON.stringify(record);
		for (const secret of [VK, OK_KEY, "Bearer"]) expect(serialized).not.toContain(secret);
	});
});

describe("evaluateFlowOutput with a state dir", () => {
	const T = Date.UTC(2026, 9, 28, 12, 0, 0);
	const OUTPUT = "SENTINEL-FLOW-OUTPUT written to CONTEXT.md";
	const rows = (dir: string): Array<Record<string, unknown>> =>
		readFileSync(join(dir, USAGE_FILE), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

	function serving(respond: () => Response) {
		const calls: Array<{ url: string; body: unknown; authorization: string }> = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: String(input),
				body: JSON.parse(String(init?.body)),
				authorization: new Headers(init?.headers).get("authorization") ?? "",
			});
			return respond();
		}) as unknown as typeof fetch;
		return { fetch: fetchImpl, calls };
	}

	function evaluate(dir: string, fetchImpl: typeof fetch, extra: { model?: string } = {}) {
		return evaluateFlowOutput({
			subject: "phase:discuss",
			output: OUTPUT,
			apiKey: K,
			fetch: fetchImpl,
			now: () => T,
			stateDir: dir,
			...extra,
		});
	}

	test("a 402 opens the shared breaker: the next evaluation makes zero requests and says unavailable", async () => {
		const dir = tempDir();
		const r = serving(() => json({ error: { message: "insufficient credits" } }, 402));
		const first = await evaluate(dir, r.fetch);
		expect(first.errorClass).toBe("credits");
		expect(openJevHealth(dir, "openrouter").read()).toMatchObject({
			state: "open",
			cause: "credits",
		});
		const second = await evaluate(dir, r.fetch);
		expect(second.state).toBe("error");
		expect(second.errorClass).toBe("unavailable");
		expect(second.decision).toBeNull();
		expect(second.confidence).toBeNull();
		expect(second.rationale).toStartWith(
			"decisions unavailable: OpenRouter reports insufficient credits; next check ",
		);
		expect(r.calls).toHaveLength(1);
	});

	test("a hand-built open file refuses the call in a fresh process with zero requests", async () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, "decisions-health-openrouter.json"),
			JSON.stringify({
				v: 1,
				state: "open",
				cause: "auth",
				since: T - 1000,
				nextProbeAt: T + 60_000,
				coolDownMs: 300_000,
				failures: 1,
			}),
		);
		const r = serving(() => ok("approve", 0.9));
		const record = await evaluate(dir, r.fetch);
		expect(record.errorClass).toBe("unavailable");
		expect(record.rationale).toContain("OpenRouter rejected the key");
		expect(r.calls).toHaveLength(0);
	});

	test("a 429 is a flow error but never opens the breaker: the next evaluation goes out", async () => {
		const dir = tempDir();
		const r = serving(() => json({ error: { message: "slow down" } }, 429));
		expect((await evaluate(dir, r.fetch)).errorClass).toBe("rate-limit");
		const before = r.calls.length;
		expect((await evaluate(dir, r.fetch)).errorClass).toBe("rate-limit");
		expect(r.calls.length).toBeGreaterThan(before);
		expect(openJevHealth(dir, "openrouter").read().state).toBe("closed");
	});

	test("every real attempt is ledgered as point flow, without the key or the output", async () => {
		const dir = tempDir();
		// No confidence: one repair retry, so two real calls and two rows.
		const r = serving(() => ok("approve"));
		await evaluate(dir, r.fetch);
		expect(r.calls).toHaveLength(2);
		const expected = {
			ts: T,
			point: "flow",
			rail: "openrouter",
			requestedModel: "~typesafe/jev-latest",
			servedModel: "~typesafe/jev-latest",
			ok: true,
			ms: 0,
			promptTokens: 3,
			completionTokens: 2,
			requestId: "req_1",
		};
		expect(rows(dir)).toEqual([expected, expected]);
		const text = [
			readFileSync(join(dir, USAGE_FILE), "utf8"),
			readFileSync(join(dir, "decisions-health-openrouter.json"), "utf8"),
		].join("\n");
		for (const secret of [K, OUTPUT, "Bearer", "sk-or-"]) expect(text).not.toContain(secret);
	});

	test("a refused model makes no request, no ledger row and no breaker entry", async () => {
		const dir = tempDir();
		const r = serving(() => ok("approve", 0.9));
		const record = await evaluate(dir, r.fetch, { model: "z-ai/glm-5.3-flash" });
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("model");
		expect(r.calls).toHaveLength(0);
		expect(existsSync(join(dir, USAGE_FILE))).toBe(false);
		expect(existsSync(join(dir, "decisions-health-openrouter.json"))).toBe(false);
	});

	test("an open Vercel breaker does not stop the flow judge, which only ever uses OpenRouter", async () => {
		const dir = tempDir();
		openJevHealth(dir, "vercel").recordFailure("credits", T);
		const r = serving(() => ok("approve", 0.9));
		const record = await evaluate(dir, r.fetch);
		expect(record.state).toBe("success");
		expect(r.calls).toHaveLength(1);
	});

	/** Replies in order (the last repeats); the injected clock advances 10 ms per real request. */
	function ticking(clock: { now: number }, replies: Array<() => Response>) {
		const calls: number[] = [];
		const fetchImpl = (async () => {
			const reply = replies[Math.min(calls.length, replies.length - 1)];
			if (!reply) throw new Error("no reply queued");
			calls.push(clock.now);
			clock.now += 10;
			return reply();
		}) as unknown as typeof fetch;
		return { fetch: fetchImpl, calls };
	}

	function openedAt(dir: string): number {
		const health = openJevHealth(dir, "openrouter", { rng: () => 0.5 });
		health.recordFailure("credits", T);
		return health.read().nextProbeAt ?? 0;
	}

	test("a repair after a probe closed the breaker is an ordinary call: its 401 reopens it and warns", async () => {
		const dir = tempDir();
		const clock = { now: openedAt(dir) };
		// The probe's reply lacks confidence and closes the breaker; the repair is then refused with a 401.
		const r = ticking(clock, [() => ok("approve"), () => json({ error: { message: "no" } }, 401)]);
		const record = await evaluateFlowOutput({
			subject: "phase:discuss",
			output: OUTPUT,
			apiKey: K,
			fetch: r.fetch,
			now: () => clock.now,
			stateDir: dir,
		});
		expect(r.calls).toHaveLength(2);
		expect(record.errorClass).toBe("auth");
		const health = openJevHealth(dir, "openrouter");
		expect(health.read()).toMatchObject({ state: "open", cause: "auth" });
		expect(health.takeWarning(clock.now)).toContain("OpenRouter rejected the key");
	});

	test("a repair that succeeds after the probe closed the breaker leaves it closed", async () => {
		const dir = tempDir();
		const clock = { now: openedAt(dir) };
		const r = ticking(clock, [() => ok("approve"), () => ok("approve", 0.8)]);
		const record = await evaluateFlowOutput({
			subject: "phase:discuss",
			output: OUTPUT,
			apiKey: K,
			fetch: r.fetch,
			now: () => clock.now,
			stateDir: dir,
		});
		expect(record.state).toBe("success");
		const health = openJevHealth(dir, "openrouter");
		expect(health.read().state).toBe("closed");
		expect(health.takeWarning(clock.now)).toBeUndefined();
	});

	test("the same URL, model and key are used for a probe after a 402; nothing else is contacted", async () => {
		const dir = tempDir();
		const r = serving(() => json({ error: { message: "insufficient credits" } }, 402));
		await evaluate(dir, r.fetch);
		const due = openJevHealth(dir, "openrouter").read().nextProbeAt ?? 0;
		await evaluateFlowOutput({
			subject: "phase:discuss",
			output: OUTPUT,
			apiKey: K,
			fetch: r.fetch,
			now: () => due,
			stateDir: dir,
		});
		expect(r.calls).toHaveLength(2);
		for (const call of r.calls) {
			expect(call.url).toBe("https://openrouter.ai/api/alpha/decisions");
			expect(call.body).toMatchObject({ model: "~typesafe/jev-latest" });
			expect(call.authorization).toBe(`Bearer ${K}`);
		}
	});
});
