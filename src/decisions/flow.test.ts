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
	isGsdFlowCommand,
	lookupFlowScore,
	openRouterKey,
} from "./flow.ts";
import { openJevHealth } from "./health.ts";
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

describe("isGsdFlowCommand", () => {
	test("matches gsd skill and phase commands and skips unrelated tools", () => {
		expect(isGsdFlowCommand("Skill", "gsd-discuss-phase 15")).toBe(true);
		expect(isGsdFlowCommand("Bash", "echo hi && gsd-audit-milestone")).toBe(true);
		expect(isGsdFlowCommand("Bash", "bun test")).toBe(false);
		expect(isGsdFlowCommand("Read", "src/decisions/flow.ts")).toBe(false);
	});
});

describe("openRouterKey", () => {
	test("reads the store, then ULTRATHINK_OPENROUTER_KEY, and never the legacy variable", () => {
		const store = join(tempDir(), "mcp-credentials.json");
		writeFileSync(store, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
		expect(openRouterKey(store, { OPENROUTER_API_KEY: K })).toBeUndefined();
		expect(openRouterKey(store, { ULTRATHINK_OPENROUTER_KEY: K })).toBe(K);
		const stored = { openrouter: { kind: "api_key", apiKey: "sk-or-v1-STORED", updatedAt: 1 } };
		writeFileSync(store, JSON.stringify({ version: 1, providers: stored }), { mode: 0o600 });
		expect(
			openRouterKey(store, {
				ULTRATHINK_OPENROUTER_KEY: K,
				OPENROUTER_API_KEY: "sk-or-v1-LEGACYKEY-0123456789abcdef",
			}),
		).toBe("sk-or-v1-STORED");
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
		expect(openJevHealth(dir).read()).toMatchObject({ state: "open", cause: "credits" });
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
			join(dir, "decisions-health.json"),
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
		expect(openJevHealth(dir).read().state).toBe("closed");
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
			readFileSync(join(dir, "decisions-health.json"), "utf8"),
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
		expect(existsSync(join(dir, "decisions-health.json"))).toBe(false);
	});

	test("the same URL, model and key are used for a probe after a 402; nothing else is contacted", async () => {
		const dir = tempDir();
		const r = serving(() => json({ error: { message: "insufficient credits" } }, 402));
		await evaluate(dir, r.fetch);
		const due = openJevHealth(dir).read().nextProbeAt ?? 0;
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
