// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrokAuthError, GrokHttpError } from "./auth.ts";
import { runGrokCheck } from "./check.ts";
import { grokComplete } from "./complete.ts";
import { DEFAULT_GROK_CONFIG } from "./types.ts";

const SENTINEL_TOKEN = "sentinel-token-DO-NOT-PRINT-0123456789";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A lane home whose auth.json holds a sentinel token, so any leak into output is caught. */
function laneHome(): string {
	const home = mkdtempSync(join(tmpdir(), "ultrathink-grok-check-"));
	dirs.push(home);
	writeFileSync(
		join(home, "auth.json"),
		JSON.stringify({
			"https://auth.x.ai::client-abc": {
				key: SENTINEL_TOKEN,
				expires_at: "2030-01-01T00:00:00.000Z",
				email: "lane@example.com",
			},
		}),
	);
	return home;
}

type Complete = typeof grokComplete;
type CompleteOptions = NonNullable<Parameters<Complete>[2]>;

function okComplete(seen: CompleteOptions[] = []): Complete {
	return async (_system, _user, opts = {}) => {
		seen.push(opts);
		opts.onResult?.({ model: "grok-build-0.1", inputTokens: 21, outputTokens: 2 });
		return "pong";
	};
}

function failing(error: unknown): Complete {
	return async () => {
		throw error;
	};
}

const RESOURCE_EXHAUSTED = `grok HTTP 429: {"code":"resource-exhausted","error":"Too many requests for team t and model grok-build-0.1. Your team's rate limit is — Requests per Minute (actual/limit): 0/0. Your rate limit tier is determined based on your historical API spend."}`;

describe("runGrokCheck", () => {
	test("ok line carries model, seconds, tokens, account, home and transport", async () => {
		const home = laneHome();
		const ticks = [1_000, 3_500];
		const result = await runGrokCheck({
			grok: { ...DEFAULT_GROK_CONFIG, home },
			complete: okComplete(),
			now: () => ticks.shift() ?? 0,
		});
		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.text).toBe(
			`Grok check: ok · grok-build-0.1 · 2.5 s · in 21 out 2 · account lane@example.com · home ${home} · transport http`,
		);
		expect(result.text).not.toContain(SENTINEL_TOKEN);
		expect(JSON.stringify(result.json)).not.toContain(SENTINEL_TOKEN);
		expect(result.json).toEqual({
			ok: true,
			model: "grok-build-0.1",
			seconds: 2.5,
			inputTokens: 21,
			outputTokens: 2,
			account: "lane@example.com",
			home,
			transport: "http",
		});
	});

	test("an unset home reads as default and unknown parts are omitted", async () => {
		const result = await runGrokCheck({
			grok: DEFAULT_GROK_CONFIG,
			complete: async () => "pong",
			status: () => ({ loggedIn: false, expired: false, home: "/unused" }),
			now: () => 0,
		});
		expect(result.text).toBe(
			"Grok check: ok · grok-build-0.1 · 0 s · home default · transport http",
		);
		expect(result.json).not.toHaveProperty("inputTokens");
		expect(result.json).not.toHaveProperty("account");
	});

	test("model and transport overrides and the configured route reach the completer", async () => {
		const seen: CompleteOptions[] = [];
		const grok = {
			...DEFAULT_GROK_CONFIG,
			home: "/lane",
			bin: "/opt/grok",
			baseUrl: "https://proxy.test/v1",
			callTimeoutMs: 1234,
		};
		await runGrokCheck(
			{
				grok,
				complete: okComplete(seen),
				status: () => ({ loggedIn: true, expired: false, home: "/lane" }),
			},
			{ model: "grok-4.7", transport: "cli" },
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			model: "grok-4.7",
			transport: "cli",
			home: "/lane",
			bin: "/opt/grok",
			baseUrl: "https://proxy.test/v1",
			timeoutMs: 1234,
			maxOutputTokens: 16,
			shuntMaxTokens: 16,
		});
	});

	test("the 16-token cap reaches the HTTP and shunt wire bodies, whatever shuntMaxTokens says", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchStub = (async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({
				output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
				content: [{ type: "text", text: "pong" }],
			});
		}) as typeof fetch;
		const viaRealTransport: Complete = (system, user, opts = {}) =>
			grokComplete(system, user, { ...opts, fetch: fetchStub });
		const grok = {
			...DEFAULT_GROK_CONFIG,
			home: laneHome(),
			shuntBaseUrl: "http://gateway.test",
			shuntMaxTokens: 8192,
		};
		await runGrokCheck({ grok, complete: viaRealTransport }, { transport: "http" });
		await runGrokCheck({ grok: { ...grok, transport: "shunt" }, complete: viaRealTransport });
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.max_output_tokens).toBe(16);
		expect(bodies[1]?.max_tokens).toBe(16);
	});

	test("the options handed to the completer carry the cap for both capped routes", async () => {
		const seen: CompleteOptions[] = [];
		await runGrokCheck({
			grok: { ...DEFAULT_GROK_CONFIG, shuntMaxTokens: 8192 },
			complete: okComplete(seen),
			status: () => ({ loggedIn: false, expired: false, home: "/x" }),
		});
		expect(seen[0]?.maxOutputTokens).toBe(16);
		expect(seen[0]?.shuntMaxTokens).toBe(16);
	});

	test("a shunt alias is the effective model: sent, reported as such, never as grok-build-0.1", async () => {
		const seen: CompleteOptions[] = [];
		const grok = {
			...DEFAULT_GROK_CONFIG,
			transport: "shunt" as const,
			shuntBaseUrl: "http://gateway.test",
			shuntModel: "route-xhigh",
		};
		const result = await runGrokCheck({
			grok,
			complete: async (_system, _user, opts = {}) => {
				seen.push(opts);
				return "pong";
			},
			status: () => ({ loggedIn: false, expired: false, home: "/x" }),
		});
		expect(seen[0]?.model).toBe("route-xhigh");
		expect(result.text).toContain("ok · route-xhigh (shunt alias) ·");
		expect(result.text).not.toContain("grok-build-0.1");
		expect(result.json).toMatchObject({
			model: "route-xhigh",
			shuntAlias: true,
			transport: "shunt",
		});
	});

	test("an empty shunt alias falls back to grok.model and sets no alias flag", async () => {
		const plain = await runGrokCheck({
			grok: { ...DEFAULT_GROK_CONFIG, transport: "shunt", shuntModel: "  " },
			complete: async () => "pong",
			status: () => ({ loggedIn: false, expired: false, home: "/x" }),
		});
		expect(plain.text).toContain("ok · grok-build-0.1 ·");
		expect(plain.json).not.toHaveProperty("shuntAlias");
	});

	test("a failure through a shunt alias names the alias", async () => {
		const result = await runGrokCheck({
			grok: { ...DEFAULT_GROK_CONFIG, transport: "shunt", shuntModel: "route-xhigh" },
			complete: failing(new GrokHttpError(RESOURCE_EXHAUSTED, 429, RESOURCE_EXHAUSTED)),
		});
		expect(result.text).toContain("not entitled to route-xhigh (shunt alias)");
		expect(result.json).toMatchObject({ model: "route-xhigh", shuntAlias: true });
	});

	test("a 429 resource-exhausted is model-unavailable with the entitlement fix", async () => {
		const result = await runGrokCheck({
			grok: DEFAULT_GROK_CONFIG,
			complete: failing(new GrokHttpError(RESOURCE_EXHAUSTED, 429, RESOURCE_EXHAUSTED)),
		});
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.text).toStartWith("Grok check: error (model-unavailable) · ");
		expect(result.text).toContain("fix: the login is not entitled to grok-build-0.1");
		expect(result.text).toContain("ultrathink grok login");
		expect(result.text).not.toContain("\n");
		expect(result.json).toMatchObject({ ok: false, class: "model-unavailable" });
	});

	test("an auth failure says to run ultrathink grok login", async () => {
		const result = await runGrokCheck({
			grok: DEFAULT_GROK_CONFIG,
			complete: failing(new GrokAuthError("Grok login missing: run `grok login`")),
		});
		expect(result.text).toStartWith("Grok check: error (auth) · ");
		expect(result.text).toEndWith("fix: run `ultrathink grok login`");
	});

	test("a plan limit says the plan is rate limited", async () => {
		const result = await runGrokCheck({
			grok: DEFAULT_GROK_CONFIG,
			complete: failing(new Error("You've hit your session limit · resets 3:45pm")),
		});
		expect(result.text).toStartWith("Grok check: error (plan-limit) · ");
		expect(result.text).toEndWith("fix: the plan is rate limited, retry later");
	});

	test("an unclassified failure has no fix hint and the message is redacted", async () => {
		const result = await runGrokCheck({
			grok: DEFAULT_GROK_CONFIG,
			complete: failing(new Error(`weird output with Bearer ${SENTINEL_TOKEN} inside`)),
		});
		expect(result.text).toStartWith("Grok check: error (other) · ");
		expect(result.text).not.toContain("fix:");
		expect(result.text).not.toContain(SENTINEL_TOKEN);
		expect(result.json).not.toHaveProperty("fix");
	});
});
