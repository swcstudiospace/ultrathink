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
const GROK_SHUNT = "grok:grok-4.7@shunt";
const CLAUDE_SESSION = "anthropic/claude-sonnet-5-5";
const GROK_SESSION = "xai-oauth/grok-4.7";
const WEEKLY_LIMIT = JSON.stringify({
	type: "result",
	is_error: true,
	result: "You've hit your weekly limit · resets Oct 31",
});
const REPLY_OK = JSON.stringify({ type: "result", is_error: false, result: "CLAUDE_REPLY" });
const SHUNT_BODY = { content: [{ type: "text", text: "GATEWAY_REPLY" }] };
const RATE_LIMIT_ZERO =
	'{"code":"resource-exhausted","error":"Too many requests for team t-1 and model grok-4.7. Your team\'s rate limit is — Requests per Minute (actual/limit): 0/0. Your rate limit tier is determined based on your historical API spend."}';

/** A `claude` stub that logs each call's argv, then prints `out` and exits `code`. */
function claudeStub(out: string, code = 0): { bin: string; argv: () => string[] } {
	const dir = tempDir("ultrathink-judge-claude-stub-");
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
				return readFileSync(logFile, "utf8").trim().split("\n");
			} catch {
				// reason: the stub never ran, so no log exists
				return [];
			}
		},
	};
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
 * Judge config with no Grok login (an empty home) unless `grok` names one. Claude fails over by `fallbackToGrok`; the
 * shunt gateway is set by `shunt` ("" = not configured).
 */
function judgeConfig(
	bin: string,
	options: {
		shunt?: string;
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
			shuntBaseUrl: options.shunt ?? "",
			...options.grok,
		},
		think: { ...base.think, engine: "claude" },
	});
}

describe("selectJudgeEngine: the judge's route follows the session's provider", () => {
	test("(a) a Claude judge that hits its weekly limit answers from the shunt gateway", async () => {
		const claude = claudeStub(WEEKLY_LIMIT, 1);
		const gw = gateway(() => Response.json(SHUNT_BODY));
		try {
			const config = judgeConfig(claude.bin, { shunt: gw.origin });
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), CLAUDE_SESSION),
			);
			expect(selected.label).toBe(CLAUDE_HAIKU);
			expect(await selected.complete("system", "user")).toBe("GATEWAY_REPLY");
			expect(selected.failover?.()).toBe(`${CLAUDE_HAIKU} → ${GROK_SHUNT} (plan-limit)`);
			expect(claude.argv()).toHaveLength(1);
			expect(gw.models).toEqual(["grok-4.7"]);
		} finally {
			gw.stop();
		}
	});

	test("(b) with no shunt and no Grok login, a Claude judge stays a single candidate", async () => {
		const claude = claudeStub(WEEKLY_LIMIT, 1);
		const config = judgeConfig(claude.bin);
		const selected = engineOf(
			await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), CLAUDE_SESSION),
		);
		expect(selected.failover).toBeUndefined();
		await expect(selected.complete("system", "user")).rejects.toThrow(/weekly limit/);
		expect(claude.argv()).toHaveLength(1);
	});

	test("(c) a Grok session answers from the shunt gateway and never calls Claude", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway(() => Response.json(SHUNT_BODY));
		try {
			const config = judgeConfig(claude.bin, { shunt: gw.origin });
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
			);
			expect(selected.label).toBe(GROK_SHUNT);
			expect(selected.resolution.transport).toBe("grok-shunt");
			expect(await selected.complete("system", "user")).toBe("GATEWAY_REPLY");
			expect(selected.failover?.()).toBeUndefined();
			expect(gw.models).toEqual(["grok-4.7"]);
			expect(claude.argv()).toEqual([]);
		} finally {
			gw.stop();
		}
	});

	test("(d) a Grok session whose shunt gateway refuses connections falls through to Claude", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway(() => Response.json(SHUNT_BODY));
		const refused = gw.origin;
		gw.stop();
		const config = judgeConfig(claude.bin, { shunt: refused });
		const selected = engineOf(
			await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
		);
		expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
		expect(selected.failover?.()).toContain(`${GROK_SHUNT} → ${CLAUDE_HAIKU}`);
		expect(claude.argv()).toHaveLength(1);
	}, 20_000);

	test("(d2) a Grok session whose shunt gateway refuses the model falls through to Claude", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway(() => new Response(RATE_LIMIT_ZERO, { status: 429 }));
		try {
			const config = judgeConfig(claude.bin, { shunt: gw.origin });
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
			);
			expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
			expect(selected.failover?.()).toBe(`${GROK_SHUNT} → ${CLAUDE_HAIKU} (model-unavailable)`);
			expect(gw.models).toEqual(["grok-4.7"]);
			expect(claude.argv()).toHaveLength(1);
		} finally {
			gw.stop();
		}
	}, 20_000);

	test("(e) a Claude session takes the auxiliary path: Claude answers first, the shunt is never asked", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway(() => Response.json(SHUNT_BODY));
		try {
			const config = judgeConfig(claude.bin, { shunt: gw.origin });
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

	test("(f) a shunt alias with a control character is never a failover candidate", async () => {
		const claude = claudeStub(WEEKLY_LIMIT, 1);
		const gw = gateway(() => Response.json(SHUNT_BODY));
		try {
			const config = judgeConfig(claude.bin, {
				shunt: gw.origin,
				grok: { shuntModel: "bad\nalias" },
			});
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), CLAUDE_SESSION),
			);
			expect(selected.failover).toBeUndefined();
			await expect(selected.complete("system", "user")).rejects.toThrow(/weekly limit/);
			expect(gw.models).toEqual([]);
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

	test("(h) a Grok session with a login walks the login model, then the shunt gateway", async () => {
		const claude = claudeStub(REPLY_OK);
		const gw = gateway((path) =>
			path === "/v1/messages"
				? Response.json(SHUNT_BODY)
				: new Response(RATE_LIMIT_ZERO, { status: 429 }),
		);
		try {
			const config = judgeConfig(claude.bin, {
				shunt: gw.origin,
				grok: { home: grokLogin(), baseUrl: `${gw.origin}/v1` },
			});
			const selected = engineOf(
				await selectJudgeEngine(config, {}, tempDir("ultrathink-judge-cwd-"), GROK_SESSION),
			);
			expect(selected.label).toBe("grok:grok-4.7");
			expect(await selected.complete("system", "user")).toBe("GATEWAY_REPLY");
			expect(selected.failover?.()).toBe(`grok:grok-4.7 → ${GROK_SHUNT} (model-unavailable)`);
			expect(claude.argv()).toEqual([]);
		} finally {
			gw.stop();
		}
	}, 20_000);
});
