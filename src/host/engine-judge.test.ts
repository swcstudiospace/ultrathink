// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { selectJudgeEngine } from "./engine.ts";
import { configWith, createEngineFixtures, engineOf } from "./engine-test.helpers.ts";

const { tempDir, emptyHome, grokLogin, cleanup } = createEngineFixtures();
afterEach(cleanup);

const CLAUDE_HAIKU = "claude:claude-haiku-5-5";
const CLAUDE_SESSION = "anthropic/claude-sonnet-5-5";
const GROK_SESSION = "xai-oauth/grok-4.7";
const WEEKLY_LIMIT = JSON.stringify({
	type: "result",
	is_error: true,
	result: "You've hit your weekly limit · resets Oct 31",
});
const REPLY_OK = JSON.stringify({ type: "result", is_error: false, result: "CLAUDE_REPLY" });

/** A stub binary that logs each call's argv, then prints `out` and exits `code`. */
function argvStub(name: string, out: string, code = 0): { bin: string; argv: () => string[] } {
	const dir = tempDir(`ultrathink-judge-${name}-stub-`);
	const bin = join(dir, name);
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
				return readFileSync(logFile, "utf8").trim().split("\n");
			} catch {
				// reason: the stub never ran, so no log exists
				return [];
			}
		},
	};
}

/** A `claude` stub that logs each call's argv, then prints `out` and exits `code`. */
function claudeStub(out: string, code = 0): { bin: string; argv: () => string[] } {
	return argvStub("claude", out, code);
}

/** A local gateway; `answer` sees each request's path and wire model and returns the reply. */
function gateway(answer: (path: string, model: string) => Response): {
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
			return answer(new URL(request.url).pathname, body.model ?? "");
		},
	});
	return { origin: `http://127.0.0.1:${server.port}`, models, stop: () => server.stop(true) };
}

/**
 * Judge config with no Grok login (an empty home) unless `grok` names one. Claude fails over by `fallbackToGrok`.
 */
function judgeConfig(
	bin: string,
	options: {
		fallbackToGrok?: boolean;
		grok?: Partial<UltrathinkConfig["grok"]>;
	} = {},
): UltrathinkConfig {
	const base = defaultConfig();
	return configWith({
		claude: { ...base.claude, bin, fallbackToGrok: options.fallbackToGrok ?? true },
		grok: {
			...base.grok,
			home: emptyHome(),
			model: "grok-4.7",
			...options.grok,
		},
		think: { ...base.think, engine: "claude" },
	});
}

describe("selectJudgeEngine: the judge's route follows the session's provider", () => {
	test("(b) with no Grok login, a Claude judge stays a single candidate", async () => {
		const claude = claudeStub(WEEKLY_LIMIT, 1);
		const config = judgeConfig(claude.bin);
		const selected = engineOf(
			await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), CLAUDE_SESSION),
		);
		expect(selected.failover).toBeUndefined();
		await expect(selected.complete("system", "user")).rejects.toThrow(/weekly limit/);
		expect(claude.argv()).toHaveLength(1);
	});

	test("(e) a Claude session takes the auxiliary path: Claude answers first, the Grok route is never asked", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway(() => Response.json({ output_text: "GATEWAY_REPLY" }));
		try {
			const config = judgeConfig(claude.bin, {
				grok: { home: grokLogin(), baseUrl: `${gw.origin}/v1` },
			});
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), CLAUDE_SESSION),
			);
			expect(selected.label).toBe(CLAUDE_HAIKU);
			expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
			expect(selected.failover?.()).toBeUndefined();
			expect(gw.models).toEqual([]);
			expect(claude.argv()).toHaveLength(1);
		} finally {
			gw.stop();
		}
	});

	test("(g) a Grok session with no Grok candidate takes the auxiliary route", async () => {
		const claude = claudeStub(REPLY_OK);
		const config = judgeConfig(claude.bin);
		const selected = engineOf(
			await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
		);
		expect(selected.label).toBe(CLAUDE_HAIKU);
		expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
		expect(selected.failover).toBeUndefined();
	});

	test("a Grok session judges on Grok over HTTP and never reaches Claude", async () => {
		const claude = claudeStub(REPLY_OK);
		const paths: string[] = [];
		const gw = gateway((path) => {
			paths.push(path);
			return Response.json({ output_text: "GROK_REPLY" });
		});
		try {
			const config = judgeConfig(claude.bin, {
				grok: { home: grokLogin(), baseUrl: `${gw.origin}/v1`, transport: "http" },
			});
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
			);
			expect(await selected.complete("system", "user")).toBe("GROK_REPLY");
			expect(paths).toEqual(["/v1/responses"]);
			expect(gw.models).toEqual(["grok-4.7"]);
			expect(claude.argv()).toEqual([]);
			expect(selected.failover?.()).toBeUndefined();
		} finally {
			gw.stop();
		}
	});

	test("a Grok session judges on Grok over the CLI transport and never reaches Claude", async () => {
		const claude = claudeStub(REPLY_OK);
		const grok = argvStub("grok", JSON.stringify({ text: "GROK_REPLY", stopReason: "end_turn" }));
		const config = judgeConfig(claude.bin, {
			grok: { home: grokLogin(), bin: grok.bin, transport: "cli" },
		});
		const selected = engineOf(
			await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
		);
		expect(await selected.complete("system", "user")).toBe("GROK_REPLY");
		expect(grok.argv()).toHaveLength(1);
		expect(grok.argv()[0]).toContain("-m grok-4.7");
		expect(claude.argv()).toEqual([]);
		expect(selected.failover?.()).toBeUndefined();
	});

	test("a Grok session whose judge call fails with billing falls back to Claude", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway(() => new Response("payment required", { status: 402 }));
		try {
			const config = judgeConfig(claude.bin, {
				grok: { home: grokLogin(), baseUrl: `${gw.origin}/v1`, transport: "http" },
			});
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
			);
			expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
			expect(gw.models).toEqual(["grok-4.7"]);
			expect(claude.argv()).toHaveLength(1);
			expect(selected.failover?.()).toMatch(/\(billing\)$/);
		} finally {
			gw.stop();
		}
	});
});
