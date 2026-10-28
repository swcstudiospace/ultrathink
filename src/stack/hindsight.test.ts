// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { hangingFetch, recordingFetch } from "../test.helpers.ts";
import { probeHindsight } from "./hindsight.ts";
import type { StackConnection, StackProbeContext } from "./types.ts";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
const URL_PATH_CANARY = "CANARYPATH5678";
const BASE = `https://hs.example.test/${URL_PATH_CANARY}`;

const HEALTHY = () => Response.json({ status: "healthy", database: "connected" });
const VERSION =
	(apiVersion = "0.9.1") =>
	() =>
		Response.json({ api_version: apiVersion, features: { observations: false } });

const realFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-stack-hindsight-"));
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

function configured(hindsight: Partial<UltrathinkConfig["hindsight"]> = {}): UltrathinkConfig {
	const config = defaultConfig();
	return { ...config, hindsight: { ...config.hindsight, enabled: true, url: BASE, ...hindsight } };
}

function ctx(
	env: Record<string, string | undefined> = {},
	config: UltrathinkConfig = configured(),
	over: Partial<StackProbeContext> = {},
): StackProbeContext {
	return {
		env: {
			HOME: join(dir, "home"),
			XDG_CONFIG_HOME: join(dir, "xdg"),
			ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
			...env,
		},
		config,
		cwd: join(dir, "project"),
		stateDir: join(dir, "state"),
		host: "claude-code",
		live: false,
		timeoutMs: 1500,
		now: () => T0,
		...over,
	};
}

/** Everything a probe returned, as text: no key, URL or URL path may appear in it. */
function expectClean(connection: StackConnection, ...secrets: string[]): void {
	const text = JSON.stringify(connection);
	for (const secret of [CANARY, URL_PATH_CANARY, "hs.example.test", ...secrets]) {
		expect(text).not.toContain(secret);
	}
	expect(text).not.toContain("Bearer");
	expect(text).not.toMatch(/https?:\/\//);
	expect(text).not.toContain(dir);
	expect(connection.reason).not.toContain("\n");
}

describe("probeHindsight", () => {
	test("off by default and under the kill switch: disabled, nothing contacted", async () => {
		const r = recordingFetch([HEALTHY, VERSION()]);
		const optedOut = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, defaultConfig(), { fetch: r.fetch }),
		);
		expect(optedOut).toMatchObject({ member: "hindsight", status: "disabled", via: "none" });
		expect(optedOut.reason).toContain("hindsight.enabled");
		const killed = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY, ULTRATHINK_HINDSIGHT: "0" }, configured(), {
				fetch: r.fetch,
			}),
		);
		expect(killed).toMatchObject({ status: "disabled" });
		expect(killed.reason).toContain("ULTRATHINK_HINDSIGHT=0");
		expect(r.calls).toHaveLength(0);
		expectClean(optedOut);
		expectClean(killed);
	});

	test("no URL is misconfigured and the fix names both URL variables", async () => {
		const r = recordingFetch([HEALTHY, VERSION()]);
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured({ url: "" }), { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "hindsight", status: "misconfigured", via: "config" });
		expect(conn.fix).toContain("HINDSIGHT_API_URL");
		expect(conn.fix).toContain("HINDSIGHT_URL");
		expect(r.calls).toHaveLength(0);
		expectClean(conn);
	});

	test("a URL the policy refuses is misconfigured with the policy reason, never the URL", async () => {
		const r = recordingFetch([HEALTHY, VERSION()]);
		const conn = await probeHindsight(
			ctx(
				{ HINDSIGHT_API_KEY: CANARY },
				configured({ url: `http://hs.example.test/${URL_PATH_CANARY}` }),
				{ fetch: r.fetch },
			),
		);
		expect(conn.status).toBe("misconfigured");
		expect(conn.reason).toContain("refused");
		expect(r.calls).toHaveLength(0);
		expectClean(conn);
	});

	test("no key is misconfigured with the set-key fix, and the request is never made", async () => {
		const r = recordingFetch([HEALTHY, VERSION()]);
		const conn = await probeHindsight(ctx({}, configured(), { fetch: r.fetch }));
		expect(conn).toMatchObject({ member: "hindsight", status: "misconfigured", via: "config" });
		expect(conn.reason).toBe("no Hindsight key");
		expect(conn.fix).toContain("bin/ultrathink-mcp auth set-key hindsight --stdin");
		expect(r.calls).toHaveLength(0);
		expectClean(conn);
	});

	test("a healthy server is connected after /health and /version, and the key is never sent", async () => {
		const r = recordingFetch([HEALTHY, VERSION()]);
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured(), { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "hindsight", status: "connected", via: "http" });
		expect(conn.reason).toBe("Hindsight is healthy (api 0.9.1)");
		expect(r.calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
			["GET", `/${URL_PATH_CANARY}/health`],
			["GET", `/${URL_PATH_CANARY}/version`],
		]);
		for (const call of r.calls) {
			expect(call.headers.authorization).toBeUndefined();
			expect(JSON.stringify(call)).not.toContain(CANARY);
		}
		expectClean(conn);
	});

	test("HINDSIGHT_URL alone configures the link, and the canonical name wins over it", async () => {
		const r = recordingFetch([HEALTHY, VERSION()]);
		const config = configured({ url: "" });
		const alias = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY, HINDSIGHT_URL: BASE }, config, { fetch: r.fetch }),
		);
		expect(alias.status).toBe("connected");
		expect(new URL(r.calls[0]?.url ?? "").host).toBe("hs.example.test");
		const both = recordingFetch([HEALTHY, VERSION()]);
		await probeHindsight(
			ctx(
				{
					HINDSIGHT_API_KEY: CANARY,
					HINDSIGHT_API_URL: "https://canonical.example.test",
					HINDSIGHT_URL: BASE,
				},
				config,
				{ fetch: both.fetch },
			),
		);
		expect(new URL(both.calls[0]?.url ?? "").host).toBe("canonical.example.test");
	});

	test("a server that does not answer is unavailable with the failure kind only", async () => {
		const r = recordingFetch([
			() => new Response(`down at ${BASE} for ${CANARY}`, { status: 503 }),
			() => new Response("down", { status: 503 }),
		]);
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured(), { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "hindsight", status: "unavailable", via: "http" });
		expect(conn.reason).toBe("Hindsight did not answer its health check (server)");
		expect(conn.affects?.length).toBeGreaterThan(0);
		expectClean(conn);
	});

	test("a network failure is unavailable and its message is not shown", async () => {
		const failing = (async () => {
			throw new Error(`connect ECONNREFUSED ${BASE} ${CANARY}`);
		}) as unknown as typeof fetch;
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured(), { fetch: failing }),
		);
		expect(conn.status).toBe("unavailable");
		expect(conn.reason).toBe("Hindsight did not answer its health check (network)");
		expectClean(conn);
	});

	test("a server that answers but reports no database is unavailable, not connected", async () => {
		const r = recordingFetch([
			() => Response.json({ status: "unhealthy", database: "disconnected" }),
			VERSION(),
		]);
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured(), { fetch: r.fetch }),
		);
		expect(conn.status).toBe("unavailable");
		expect(conn.reason).toBe(
			"Hindsight answers but reports itself unhealthy (database not connected)",
		);
		expectClean(conn);
	});

	test("an api version that is not a plain version token is left out of the reason", async () => {
		const r = recordingFetch([HEALTHY, VERSION(`0.9.1 see ${BASE} ${CANARY}`)]);
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured(), { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ status: "connected", reason: "Hindsight is healthy" });
		expectClean(conn);
	});

	test("ctx.timeoutMs bounds the probe", async () => {
		const started = Date.now();
		const conn = await probeHindsight(
			ctx({ HINDSIGHT_API_KEY: CANARY }, configured(), {
				fetch: hangingFetch(),
				timeoutMs: 40,
				now: undefined,
			}),
		);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(conn.status).toBe("unavailable");
		expectClean(conn);
	});

	test("the gateway backend without a token is misconfigured and names the token variable", async () => {
		const config = configured({ backend: "gateway" });
		config.gateway = { ...config.gateway, url: "https://gw.example.test" };
		const r = recordingFetch([HEALTHY, VERSION()]);
		const conn = await probeHindsight(ctx({}, config, { fetch: r.fetch }));
		expect(conn).toMatchObject({ status: "misconfigured", reason: "no desk gateway token" });
		expect(conn.fix).toContain("DESK_GATEWAY_TOKEN");
		expect(r.calls).toHaveLength(0);
		expectClean(conn, "gw.example.test");
	});

	test("the gateway backend with a token is not probed without ctx.live and says so", async () => {
		const config = configured({ backend: "gateway" });
		config.gateway = { ...config.gateway, url: "https://gw.example.test" };
		const r = recordingFetch([HEALTHY, VERSION()]);
		const conn = await probeHindsight(
			ctx({ DESK_GATEWAY_TOKEN: CANARY }, config, { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "hindsight", status: "degraded", via: "config" });
		expect(conn.reason).toContain("desk gateway");
		expect(r.calls).toHaveLength(0);
		expectClean(conn, "gw.example.test");
	});
});
