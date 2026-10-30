// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { assertMemoryCandidates, type NativeEngineSelector, selectEngine } from "./engine.ts";
import { MemoryChainError } from "./memory-chain.ts";
import { configWith, createEngineFixtures, engineOf } from "./engine-test.helpers.ts";

const { tempDir, grokLogin, cleanup } = createEngineFixtures();
afterEach(cleanup);

const SONNET = "claude-sonnet-5-5";
const HAIKU_LABEL = "claude:claude-haiku-5-5";
const PLAN_LIMIT = JSON.stringify({
	type: "result",
	is_error: true,
	result: "You've hit your session limit · resets 3:45pm",
});
const REPLY_OK = JSON.stringify({ type: "result", is_error: false, result: "CLAUDE_REPLY" });
const RATE_LIMIT_ZERO =
	'{"code":"resource-exhausted","error":"Too many requests for team t-1 and model grok-build-0.1. Your team\'s rate limit is — Requests per Minute (actual/limit): 0/0. Your rate limit tier is determined based on your historical API spend."}';

/** A `claude` stub that logs its argv, then prints `out` and exits `code`. */
function claudeStub(out: string, code = 0): { bin: string; argv: () => string[][] } {
	const dir = tempDir("ultrathink-memory-claude-stub-");
	const bin = join(dir, "claude");
	const outFile = join(dir, "out.json");
	const logFile = join(dir, "argv.log");
	writeFileSync(outFile, out);
	writeFileSync(
		bin,
		[
			"#!/bin/sh",
			"cat >/dev/null",
			`printf '%s\\n' "$*" >> '${logFile}'`,
			`cat '${outFile}'`,
			`exit ${code}`,
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	return {
		bin,
		argv: () => {
			try {
				return readFileSync(logFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => line.split(/\s+/));
			} catch {
				// reason: the stub never ran, so no log exists
				return [];
			}
		},
	};
}

/** The model the stub was asked for on each call. */
function modelsAsked(argv: string[][]): string[] {
	return argv.map((args) => args[args.indexOf("--model") + 1] ?? "");
}

/** A local Grok gateway; `answer` sees each request body's model and returns the reply. */
function gateway(answer: (model: string) => Response): {
	origin: string;
	models: string[];
	stop: () => void;
} {
	const models: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as { model?: string };
			models.push(body.model ?? "");
			return answer(body.model ?? "");
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, models, stop: () => server.stop(true) };
}

/**
 * Every setting that could steer the chain elsewhere: Sonnet pinned for Claude and for the host, a Grok model and
 * fallback list that name grok-4.7 and grok-4.6, and a Grok engine request under the http transport.
 */
function adversarial(
	bin: string,
	grok: Partial<UltrathinkConfig["grok"]> = {},
	fallbackToGrok = true,
): UltrathinkConfig {
	const base = defaultConfig();
	const config = configWith({
		claude: { ...base.claude, bin, model: SONNET, fallbackToGrok },
		grok: {
			...base.grok,
			model: "grok-4.7",
			fallbackModels: ["grok-4.7", "grok-4.6"],
			...grok,
		},
		think: { ...base.think, engine: "grok" },
	});
	config.models.hosts["claude-code"] = { provider: "", model: SONNET };
	return config;
}

describe("selectEngine purpose memory", () => {
	test("pins Claude to Haiku 5.5 whatever the config says, and walks to exactly grok-build-0.1", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const gw = gateway(() => Response.json({ output_text: "HTTP_REPLY" }));
		try {
			const config = adversarial(claude.bin, { home: grokLogin(), baseUrl: `${gw.origin}/v1` });
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-memory-cwd-"), {
					host: "claude-code",
					purpose: "memory",
				}),
			);
			expect(selected.label).toBe(HAIKU_LABEL);
			expect(selected.resolution).toMatchObject({
				state: "default",
				transport: "claude-cli",
				source: "memory-chain",
				modelId: "claude-haiku-5-5",
			});
			expect(await selected.complete("system", "user")).toBe("HTTP_REPLY");
			expect(selected.failover?.()).toBe(`${HAIKU_LABEL} → grok:grok-build-0.1 (plan-limit)`);
			expect(selected.label).toBe(HAIKU_LABEL);
			expect(modelsAsked(claude.argv())).toEqual(["claude-haiku-5-5"]);
			expect(gw.models).toEqual(["grok-build-0.1"]);
		} finally {
			gw.stop();
		}
	});

	test("a failing fallback ends the chain: no other Grok model and no Sonnet is ever tried", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const gw = gateway(() => new Response(RATE_LIMIT_ZERO, { status: 429 }));
		try {
			const config = adversarial(claude.bin, { home: grokLogin(), baseUrl: `${gw.origin}/v1` });
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-memory-cwd-"), {
					host: "claude-code",
					purpose: "memory",
				}),
			);
			await expect(selected.complete("system", "user")).rejects.toThrow();
			expect(gw.models).toEqual(["grok-build-0.1"]);
			expect(modelsAsked(claude.argv())).toEqual(["claude-haiku-5-5"]);
			expect(selected.failover?.()).toBeUndefined();
		} finally {
			gw.stop();
		}
	});

	test("the other purposes still honor the pins (the memory pin is not a global change)", async () => {
		const claude = claudeStub(REPLY_OK);
		// Fallback off: nothing may look at the real ~/.grok login while this test runs.
		const config = adversarial(claude.bin, {}, false);
		const aux = engineOf(
			await selectEngine(config, { engine: "claude" }, tempDir("ultrathink-memory-cwd-"), {
				host: "claude-code",
				purpose: "auxiliary",
			}),
		);
		expect(aux.label).toBe(`claude:${SONNET}`);
		expect(aux.resolution).toMatchObject({ source: "host-override", modelId: SONNET });
		expect(await aux.complete("system", "user")).toBe("CLAUDE_REPLY");
		expect(modelsAsked(claude.argv())).toEqual([SONNET]);
		const planning = engineOf(
			await selectEngine(config, { engine: "claude" }, tempDir("ultrathink-memory-cwd-"), {
				host: "claude-code",
			}),
		);
		expect(planning.label).toBe(`claude:${SONNET}`);
	});

	test("without fallbackToGrok the chain is Haiku alone", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const config = adversarial(claude.bin, { home: grokLogin() }, false);
		const selected = engineOf(
			await selectEngine(config, {}, tempDir("ultrathink-memory-cwd-"), {
				host: "claude-code",
				purpose: "memory",
			}),
		);
		expect(selected.failover).toBeUndefined();
		await expect(selected.complete("system", "user")).rejects.toThrow(/session limit/);
		expect(modelsAsked(claude.argv())).toEqual(["claude-haiku-5-5"]);
	});

	test("Omp never reaches the native selector for memory-bank calls", async () => {
		const claude = claudeStub(REPLY_OK);
		const native: NativeEngineSelector = async () => {
			throw new Error("a memory-bank call must not reach the native selector");
		};
		const config = configWith({ claude: { ...defaultConfig().claude, bin: claude.bin } });
		const selected = engineOf(
			await selectEngine(config, {}, tempDir("ultrathink-memory-cwd-"), {
				host: "omp",
				purpose: "memory",
				native,
			}),
		);
		expect(selected.label).toBe(HAIKU_LABEL);
		expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
	});
});

describe("assertMemoryCandidates", () => {
	const complete = async (): Promise<string> => "never called";
	const candidate = (id: string) => ({ id, label: id, complete });

	test("accepts the memory chain", () => {
		expect(() => assertMemoryCandidates([candidate(HAIKU_LABEL)])).not.toThrow();
		expect(() =>
			assertMemoryCandidates([candidate(HAIKU_LABEL), candidate("grok:grok-build-0.1")]),
		).not.toThrow();
	});

	test("a hand-built bad candidate list throws MemoryChainError instead of running", () => {
		for (const ids of [
			[`claude:${SONNET}`],
			[HAIKU_LABEL, "grok:grok-4.7"],
			[HAIKU_LABEL, "openrouter:x-ai/grok-4.7"],
			["grok:grok-build-0.1", HAIKU_LABEL],
			[HAIKU_LABEL, "grok:grok-build-0.1", "grok:grok-build-0.1"],
		]) {
			expect(() => assertMemoryCandidates(ids.map(candidate))).toThrow(MemoryChainError);
		}
	});
});
