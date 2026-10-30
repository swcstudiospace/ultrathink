// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { openJevHealth } from "../decisions/health.ts";
import { hangingFetch, JEV, recordingFetch } from "../test.helpers.ts";
import { probeDecisions } from "./decisions.ts";
import type { StackConnection, StackProbeContext } from "./types.ts";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
const CANARY_VERCEL = "vck_CANARYVERCELCANARY0123456789";
const SET_KEY_COMMAND = "bin/ultrathink-mcp auth set-key openrouter --stdin";

const realFetch = globalThis.fetch;
let dir: string;
let storeFile: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-stack-decisions-"));
	storeFile = join(dir, "mcp-credentials.json");
	mkdirSync(join(dir, "state"), { recursive: true });
});

afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(dir, { recursive: true, force: true });
});

function ctx(
	env: Record<string, string | undefined> = {},
	over: Partial<StackProbeContext> = {},
): StackProbeContext {
	return {
		env: {
			HOME: join(dir, "home"),
			XDG_CONFIG_HOME: join(dir, "xdg"),
			ULTRATHINK_MCP_STORE: storeFile,
			...env,
		},
		config: defaultConfig(),
		cwd: join(dir, "project"),
		stateDir: join(dir, "state"),
		host: "claude-code",
		live: false,
		timeoutMs: 1500,
		now: () => T0,
		...over,
	};
}

/** Everything a probe returned, as text: no secret, URL or path may appear in it. */
function expectClean(connection: StackConnection, ...secrets: string[]): void {
	const text = JSON.stringify(connection);
	for (const secret of secrets) expect(text).not.toContain(secret);
	expect(text).not.toContain("Bearer");
	expect(text).not.toMatch(/https?:\/\//);
	expect(text).not.toContain(dir);
	expect(connection.reason).not.toContain("\n");
}

describe("probeDecisions without ctx.live", () => {
	test("ULTRATHINK_DECISIONS=0 is disabled and sends nothing, whatever keys exist", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const conn = await probeDecisions(
			ctx({ ULTRATHINK_DECISIONS: "0", ULTRATHINK_OPENROUTER_KEY: CANARY }, { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "decisions", status: "disabled", via: "none" });
		expect(conn.reason).toContain("ULTRATHINK_DECISIONS=0");
		expect(r.calls).toHaveLength(0);
		expectClean(conn, CANARY);
	});

	test("no Jev key is misconfigured and the fix names the OpenRouter set-key command", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const conn = await probeDecisions(ctx({}, { fetch: r.fetch }));
		expect(conn).toMatchObject({ member: "decisions", status: "misconfigured", via: "config" });
		expect(conn.fix).toContain(SET_KEY_COMMAND);
		expect(conn.reason).not.toContain("OPENROUTER_API_KEY");
		expect(conn.affects?.length).toBeGreaterThan(0);
		expect(r.calls).toHaveLength(0);
		expectClean(conn);
	});

	test("an exported OPENROUTER_API_KEY with no Jev key is its own misconfiguration, never read or echoed", async () => {
		const plain = await probeDecisions(ctx());
		const exported = await probeDecisions(ctx({ OPENROUTER_API_KEY: CANARY }));
		expect(exported.status).toBe("misconfigured");
		expect(exported.reason).toContain("OPENROUTER_API_KEY");
		expect(exported.reason).not.toBe(plain.reason);
		expect(exported.fix).toContain("bin/ultrathink-mcp auth set-key openrouter --stdin");
		expectClean(exported, CANARY);
	});

	test("an exported OPENROUTER_API_KEY does not hide a configured Jev key", async () => {
		const conn = await probeDecisions(
			ctx({ OPENROUTER_API_KEY: CANARY, ULTRATHINK_OPENROUTER_KEY: "sk-or-v1-OTHERKEY0123456789" }),
		);
		expect(conn.status).toBe("connected");
		expectClean(conn, CANARY, "OTHERKEY");
	});

	test("a configured key is connected with the rail and the env var name as the source, and nothing is requested", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const conn = await probeDecisions(
			ctx({ ULTRATHINK_OPENROUTER_KEY: CANARY }, { fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "decisions", status: "connected", via: "config" });
		expect(conn.reason).toContain("openrouter rail");
		expect(conn.reason).toContain("key from ULTRATHINK_OPENROUTER_KEY");
		expect(r.calls).toHaveLength(0);
		expectClean(conn, CANARY);
	});

	test("a stored Vercel key is not a Jev key: misconfigured, and its value never echoed", async () => {
		writeFileSync(
			storeFile,
			JSON.stringify({
				version: 1,
				providers: { vercel: { kind: "api_key", apiKey: CANARY_VERCEL, updatedAt: 1 } },
			}),
		);
		const conn = await probeDecisions(ctx({ AI_GATEWAY_API_KEY: CANARY_VERCEL }));
		expect(conn).toMatchObject({ status: "misconfigured", reason: "no Jev key" });
		expectClean(conn, CANARY_VERCEL, storeFile);
	});

	test("an open rail breaker is degraded, names the rail and cause only, and sends nothing", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const base = ctx({ ULTRATHINK_OPENROUTER_KEY: CANARY }, { fetch: r.fetch });
		expect((await probeDecisions(base)).status).toBe("connected");
		expect(openJevHealth(base.stateDir).recordFailure("credits", T0)).toEqual({
			opened: true,
		});
		const conn = await probeDecisions(base);
		expect(conn).toMatchObject({ member: "decisions", status: "degraded" });
		expect(conn.reason).toContain("openrouter (credits)");
		expect(conn.affects?.length).toBeGreaterThan(0);
		expect(r.calls).toHaveLength(0);
		expectClean(conn, CANARY);
	});
});

describe("probeDecisions with ctx.live", () => {
	test("sends the one decisions-check request and reports connected on its answer", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const conn = await probeDecisions(
			ctx({ ULTRATHINK_OPENROUTER_KEY: CANARY }, { live: true, fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "decisions", status: "connected", via: "http" });
		expect(conn.reason).toContain("live check ok");
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.method).toBe("POST");
		expect(r.calls[0]?.headers.authorization).toBe(`Bearer ${CANARY}`);
		expect(r.calls[0]?.body).toMatchObject({ trace: { span_name: "check" } });
		expectClean(conn, CANARY);
	});

	test("a failed check is unavailable with the failure kind only, never the upstream message", async () => {
		const r = recordingFetch([
			() =>
				Response.json(
					{ error: { code: 401, message: `rejected ${CANARY} at https://openrouter.ai/x` } },
					{ status: 401 },
				),
		]);
		const conn = await probeDecisions(
			ctx({ ULTRATHINK_OPENROUTER_KEY: CANARY }, { live: true, fetch: r.fetch }),
		);
		expect(conn).toMatchObject({ member: "decisions", status: "unavailable", via: "http" });
		expect(conn.reason).toContain("(auth)");
		expect(conn.fix).toContain(SET_KEY_COMMAND);
		expect(r.calls).toHaveLength(1);
		expectClean(conn, CANARY, "rejected");
	});

	test("the live check closes an open breaker like decisions check does", async () => {
		const base = ctx(
			{ ULTRATHINK_OPENROUTER_KEY: CANARY },
			{ live: true, fetch: recordingFetch([JEV(0.9)]).fetch },
		);
		openJevHealth(base.stateDir).recordFailure("credits", T0);
		const conn = await probeDecisions(base);
		expect(conn.status).toBe("connected");
		expect(openJevHealth(base.stateDir).read().state).toBe("closed");
		expect((await probeDecisions({ ...base, live: false })).status).toBe("connected");
	});

	test("ULTRATHINK_DECISIONS=0 and a missing key send nothing even when live", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const killed = await probeDecisions(
			ctx(
				{ ULTRATHINK_DECISIONS: "0", ULTRATHINK_OPENROUTER_KEY: CANARY },
				{ live: true, fetch: r.fetch },
			),
		);
		const keyless = await probeDecisions(ctx({}, { live: true, fetch: r.fetch }));
		expect(killed.status).toBe("disabled");
		expect(keyless.status).toBe("misconfigured");
		expect(r.calls).toHaveLength(0);
	});

	test("ctx.timeoutMs bounds the live request", async () => {
		const started = Date.now();
		const conn = await probeDecisions(
			ctx(
				{ ULTRATHINK_OPENROUTER_KEY: CANARY },
				{ live: true, fetch: hangingFetch(), timeoutMs: 40, now: undefined },
			),
		);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(conn.status).toBe("unavailable");
		expect(conn.reason).toContain("(timeout)");
		expectClean(conn, CANARY);
	});
});

describe("probeDecisions when a dependency throws", () => {
	test("reports unavailable with the fixed unexpected-failure reason and never echoes the error message", async () => {
		const throwingEnv = new Proxy<Record<string, string | undefined>>(
			{},
			{
				get(): never {
					throw new Error(`boom ${CANARY} at /etc/secret/path`);
				},
			},
		);
		const conn = await probeDecisions({ ...ctx(), env: throwingEnv });
		expect(conn).toMatchObject({
			member: "decisions",
			status: "unavailable",
			reason: "Decisions probe failed unexpectedly",
			via: "none",
		});
		expect(JSON.stringify(conn)).not.toContain("boom");
		expectClean(conn, CANARY, "/etc/secret/path");
	});
});
