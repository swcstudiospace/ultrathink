// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendFlowScore,
	evaluateFlowOutput,
	type FlowRecord,
	lookupFlowScore,
} from "../src/decisions/flow.ts";
import { DEFAULT_DECISIONS_CONFIG } from "../src/decisions/types.ts";
import {
	evaluateFlowHook,
	type FlowHookDeps,
	formatFlowNote,
	type HookInput,
} from "./flow-eval.ts";

const VERCEL_KEY = "vck_CANARYCANARYCANARY1234";
const OPENROUTER_KEY = "sk-or-v1-CANARYCANARYCANARY1234";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-flow-hook-"));
	dirs.push(dir);
	return dir;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const GSD: HookInput = {
	session_id: "s1",
	tool_name: "Skill",
	tool_input: { skill: "gsd-discuss-phase", args: "89" },
	tool_response: "CONTEXT.md written",
};

interface Harness {
	deps: FlowHookDeps;
	lines: string[];
	fetchCalls: number;
	logPath: string;
}

/** Real evaluation and record store under a temp state dir; only the network, the env and the config are fake. */
function harness(
	env: Record<string, string | undefined>,
	respond: () => Response = () => json({ error: { message: "unexpected request" } }, 500),
): Harness {
	const stateDir = tempDir();
	const storePath = join(tempDir(), "mcp-credentials.json");
	writeFileSync(storePath, JSON.stringify({ version: 1, providers: {} }), { mode: 0o600 });
	const lines: string[] = [];
	const state = { fetchCalls: 0 };
	const fetchImpl = (async () => {
		state.fetchCalls += 1;
		return respond();
	}) as unknown as typeof fetch;
	return {
		deps: {
			env,
			stateDir,
			storePath,
			config: () => DEFAULT_DECISIONS_CONFIG,
			evaluate: (input) => evaluateFlowOutput({ ...input, fetch: fetchImpl }),
			lookup: lookupFlowScore,
			append: appendFlowScore,
			log: (line) => lines.push(line),
		},
		lines,
		get fetchCalls() {
			return state.fetchCalls;
		},
		logPath: join(stateDir, "flow-decisions.jsonl"),
	};
}

const vercelAnswer = (): Response =>
	json({
		answers: { verdict: { type: "choice", choice: "approve" } },
		providerMetadata: { typesafe: { confidence: { verdict: 0.9 } } },
		usage: { inputTokens: 3, outputTokens: 2 },
	});

const openRouterAnswer = (): Response =>
	json({
		id: "req_1",
		model: "~typesafe/jev-latest",
		answers: { verdict: { type: "choice", choice: "approve", confidence: 0.9 } },
		usage: { input_tokens: 3, output_tokens: 2 },
	});

/** The additionalContext of the single stdout line the hook printed. */
function noteOf(lines: string[]): string {
	const out: { additionalContext: string } = JSON.parse(lines[0] ?? "{}");
	return out.additionalContext;
}

describe("evaluateFlowHook", () => {
	test("keyless: zero stdout, zero requests, flow-decisions.jsonl untouched", async () => {
		const h = harness({ OPENROUTER_API_KEY: OPENROUTER_KEY });
		const before = '{"hash":"prior"}\n';
		writeFileSync(h.logPath, before);
		await evaluateFlowHook(GSD, h.deps);
		expect(h.lines).toEqual([]);
		expect(h.fetchCalls).toBe(0);
		expect(readFileSync(h.logPath, "utf8")).toBe(before);
	});

	test("keyless with no log yet: no log file is created", async () => {
		const h = harness({});
		await evaluateFlowHook(GSD, h.deps);
		expect(h.lines).toEqual([]);
		expect(existsSync(h.logPath)).toBe(false);
	});

	test("kill switch returns before config, evaluation or any resolution", async () => {
		const h = harness({ ULTRATHINK_DECISIONS: "0", AI_GATEWAY_API_KEY: VERCEL_KEY });
		await evaluateFlowHook(GSD, {
			...h.deps,
			config: () => {
				throw new Error("config must not be read");
			},
			evaluate: () => {
				throw new Error("evaluation must not run");
			},
		});
		expect(h.lines).toEqual([]);
		expect(existsSync(h.logPath)).toBe(false);
	});

	test("a command that is not a GSD flow stays silent", async () => {
		const h = harness({ AI_GATEWAY_API_KEY: VERCEL_KEY }, vercelAnswer);
		await evaluateFlowHook(
			{ tool_name: "Bash", tool_input: { command: "bun test" }, tool_response: "ok" },
			h.deps,
		);
		expect(h.lines).toEqual([]);
		expect(h.fetchCalls).toBe(0);
	});

	test("Vercel-only key: the note names the Vercel rail, never OpenRouter, and the record carries it", async () => {
		const h = harness({ AI_GATEWAY_API_KEY: VERCEL_KEY }, vercelAnswer);
		await evaluateFlowHook(GSD, h.deps);
		expect(h.fetchCalls).toBe(1);
		expect(h.lines).toHaveLength(1);
		const note = noteOf(h.lines);
		expect(note).toStartWith("Jev · approve · confidence 0.9 · Vercel · ");
		expect(note).toEndWith(". This does not clear a human pause.");
		expect(note).not.toContain("OpenRouter");
		const stored: FlowRecord = JSON.parse(readFileSync(h.logPath, "utf8").trim());
		expect(stored).toMatchObject({ provider: "Vercel", state: "success", decision: "approve" });
	});

	test("OpenRouter-only key keeps the original note shape", async () => {
		const h = harness({ ULTRATHINK_OPENROUTER_KEY: OPENROUTER_KEY }, openRouterAnswer);
		await evaluateFlowHook(GSD, h.deps);
		const note = noteOf(h.lines);
		expect(note).toBe(
			"Jev · approve · confidence 0.9 · OpenRouter · ~typesafe/jev-latest · req_1. This does not clear a human pause.",
		);
	});

	test("a cached success is replayed without a request and without a second record", async () => {
		const h = harness({ AI_GATEWAY_API_KEY: VERCEL_KEY }, vercelAnswer);
		await evaluateFlowHook(GSD, h.deps);
		await evaluateFlowHook(GSD, h.deps);
		expect(h.fetchCalls).toBe(1);
		expect(h.lines).toHaveLength(2);
		expect(readFileSync(h.logPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("a cached success stays silent once the key is gone: nothing printed, nothing appended, no request", async () => {
		const h = harness({ AI_GATEWAY_API_KEY: VERCEL_KEY }, vercelAnswer);
		await evaluateFlowHook(GSD, h.deps);
		expect(h.lines).toHaveLength(1);
		const stored = readFileSync(h.logPath, "utf8");
		h.lines.length = 0;
		await evaluateFlowHook(GSD, { ...h.deps, env: {} });
		expect(h.lines).toEqual([]);
		expect(h.fetchCalls).toBe(1);
		expect(readFileSync(h.logPath, "utf8")).toBe(stored);
	});

	test("a rejected key is an error note with no rail text, and the key never reaches the note or the record", async () => {
		const h = harness({ AI_GATEWAY_API_KEY: VERCEL_KEY }, () =>
			json({ error: { message: `invalid key ${VERCEL_KEY}` } }, 401),
		);
		await evaluateFlowHook(GSD, h.deps);
		expect(h.lines).toHaveLength(1);
		const note = noteOf(h.lines);
		expect(note).toBe(
			"Jev · error · auth · retries 0. Not an approval. Do not mark this output Jev-approved.",
		);
		const written = `${h.lines.join("\n")}\n${readFileSync(h.logPath, "utf8")}`;
		expect(written).not.toContain(VERCEL_KEY);
	});
});

describe("formatFlowNote", () => {
	const base: FlowRecord = {
		version: 1,
		subject: "s",
		hash: "h",
		decision: null,
		confidence: null,
		rationale: "r",
		model: "m",
		provider: "OpenRouter",
		state: "inactive",
		retryCount: 0,
		at: 1,
		latencyMs: 0,
		clearsHumanPause: false,
	};

	test("an inactive record has no note at all", () => {
		expect(formatFlowNote(base)).toBeUndefined();
	});

	test("an empty-output record keeps its note", () => {
		expect(formatFlowNote({ ...base, state: "empty" })).toBe(
			"Jev · skipped · empty output. Not an approval.",
		);
	});
});
