// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { probeSubstrate } from "./substrate.ts";
import type { StackConnection, StackProbeContext } from "./types.ts";

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
const CANARY_FILE = "sk-or-v1-CANARYFILEFILEFILE5678";
const URL_BASE = "http://127.0.0.1:7410";
const MISMATCH = { error: "this token is claude-code and cannot act as omp" };

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: Record<string, unknown> | undefined;
}

type Handler = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-stack-substrate-"));
	dirs.push(dir);
	return dir;
}

/** A recording fetch stub; it is handed to the probe as `ctx.fetch`, which the brief leg uses too. */
function install(handler: Handler): { calls: Call[]; fetch: typeof fetch } {
	const calls: Call[] = [];
	const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body:
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: undefined,
		};
		calls.push(call);
		return handler(call, init?.signal ?? undefined);
	};
	return { calls, fetch: stub as unknown as typeof fetch };
}

/** A request that never answers; it ends only when its signal aborts (the way a real fetch does). */
function hang(signal: AbortSignal | undefined): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	signal?.addEventListener("abort", () => reject(new Error("aborted")));
	return promise;
}

function brief(handler: (call: Call, n: number) => Response | Promise<Response>): {
	calls: Call[];
	briefCalls: Call[];
	fetch: typeof fetch;
} {
	const briefCalls: Call[] = [];
	const { calls, fetch: stub } = install((call) => {
		if (call.url.endsWith("/healthz")) return Response.json({ ok: true });
		briefCalls.push(call);
		return handler(call, briefCalls.length);
	});
	return { calls, briefCalls, fetch: stub };
}

function context(
	stub: typeof fetch | undefined,
	env: Record<string, string | undefined> = {},
	over: Partial<StackProbeContext> = {},
): StackProbeContext {
	return {
		env: {
			SUBSTRATE_URL: URL_BASE,
			SUBSTRATE_TOKENS_DIR: tempDir(),
			ULTRATHINK_MCP_STORE: join(tempDir(), "mcp-credentials.json"),
			SUBSTRATE_TOKEN: CANARY,
			...env,
		},
		config: defaultConfig(),
		cwd: "/work/space",
		stateDir: "/work/state",
		host: "omp",
		live: false,
		timeoutMs: 2000,
		...(stub ? { fetch: stub } : {}),
		...over,
	};
}

function expectNoSecret(result: StackConnection): void {
	const text = JSON.stringify(result);
	expect(text).not.toContain(CANARY);
	expect(text).not.toContain(CANARY_FILE);
}

describe("probeSubstrate", () => {
	test("SUBSTRATE_DISABLED=1 is disabled and contacts nothing", async () => {
		const { calls, fetch: stub } = brief(() => new Response("x"));
		const result = await probeSubstrate(context(stub, { SUBSTRATE_DISABLED: "1" }));
		expect(result).toMatchObject({
			member: "substrate",
			status: "disabled",
			reason: "SUBSTRATE_DISABLED=1",
			via: "config",
		});
		expect(calls).toEqual([]);
	});

	test("no URL anywhere is disabled, names the settings, and contacts nothing", async () => {
		const { calls, fetch: stub } = brief(() => new Response("x"));
		const result = await probeSubstrate(context(stub, { SUBSTRATE_URL: undefined }));
		expect(result.status).toBe("disabled");
		expect(result.reason).toBe("no Substrate URL (set SUBSTRATE_URL or substrate.url)");
		expect(calls).toEqual([]);
	});

	test("the configured URL is used when SUBSTRATE_URL is unset, and SUBSTRATE_URL wins when both are set", async () => {
		const { calls, fetch: stub } = brief(() => new Response("# brief"));
		const config = defaultConfig();
		config.substrate.url = "https://configured.test/";
		await probeSubstrate({ ...context(stub, { SUBSTRATE_URL: undefined }), config });
		expect(calls.map((c) => c.url)).toEqual([
			"https://configured.test/healthz",
			"https://configured.test/brief",
		]);
		calls.length = 0;
		await probeSubstrate({ ...context(stub), config });
		expect(calls.map((c) => c.url)).toEqual([`${URL_BASE}/healthz`, `${URL_BASE}/brief`]);
	});

	describe("desk gateway backend", () => {
		const GATEWAY_URL = "https://gw.example.test";
		const gatewayConfig = (): StackProbeContext["config"] => {
			const config = defaultConfig();
			config.substrate.backend = "gateway";
			config.gateway = { ...config.gateway, url: GATEWAY_URL };
			return config;
		};

		test("a gateway that is not ready (no token) is misconfigured, secret-free, and the direct URL is never contacted", async () => {
			const { calls, fetch: stub } = brief(() => new Response("# brief"));
			const result = await probeSubstrate({
				...context(stub, { SUBSTRATE_TOKEN: undefined }),
				config: gatewayConfig(),
			});
			expect(result).toMatchObject({
				member: "substrate",
				status: "misconfigured",
				affects: ["brief"],
				via: "config",
			});
			expect(result.reason).toContain("no token");
			expect(calls).toEqual([]);
			expectNoSecret(result);
		});

		test("a ready gateway is degraded (configured, link not probed), never connected, and no request is sent", async () => {
			const { calls, fetch: stub } = brief(() => new Response("# brief"));
			const result = await probeSubstrate({
				...context(stub, { DESK_GATEWAY_TOKEN: CANARY_FILE }),
				config: gatewayConfig(),
			});
			expect(result).toMatchObject({
				status: "degraded",
				reason: "desk gateway configured; link not probed",
				via: "config",
			});
			expect(calls).toEqual([]);
			expectNoSecret(result);
		});

		test("ULTRATHINK_SUBSTRATE_BACKEND=gateway selects the gateway, and ULTRATHINK_GATEWAY=0 forces the direct probe back", async () => {
			const { calls, fetch: stub } = brief(() => new Response("# brief"));
			const gateway = await probeSubstrate(
				context(stub, { ULTRATHINK_SUBSTRATE_BACKEND: "gateway", DESK_GATEWAY_URL: GATEWAY_URL }),
			);
			expect(gateway.status).toBe("misconfigured");
			expect(calls).toEqual([]);
			const direct = await probeSubstrate({
				...context(stub, { ULTRATHINK_GATEWAY: "0" }),
				config: gatewayConfig(),
			});
			expect(direct.status).toBe("connected");
			expect(direct.via).toBe("http");
			expect(calls.map((c) => c.url)).toEqual([`${URL_BASE}/healthz`, `${URL_BASE}/brief`]);
		});

		test("SUBSTRATE_DISABLED=1 still wins over the gateway backend", async () => {
			const { calls, fetch: stub } = brief(() => new Response("# brief"));
			const result = await probeSubstrate({
				...context(stub, { SUBSTRATE_DISABLED: "1", DESK_GATEWAY_TOKEN: CANARY_FILE }),
				config: gatewayConfig(),
			});
			expect(result).toMatchObject({ status: "disabled", reason: "SUBSTRATE_DISABLED=1" });
			expect(calls).toEqual([]);
		});
	});

	test("healthz refused is unavailable with the exact reason and no brief request", async () => {
		const { calls, fetch: stub } = install(() => {
			throw new Error("connect ECONNREFUSED");
		});
		const result = await probeSubstrate(context(stub));
		expect(result).toMatchObject({
			status: "unavailable",
			reason: "healthz unreachable",
			affects: ["brief"],
			via: "http",
		});
		expect(calls.map((c) => c.url)).toEqual([`${URL_BASE}/healthz`]);
	});

	test("a 5xx healthz is unavailable and names the status", async () => {
		const { calls, fetch: stub } = install(() => new Response("down", { status: 503 }));
		const result = await probeSubstrate(context(stub));
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("healthz http-503");
		expect(calls).toHaveLength(1);
	});

	test("healthz is a plain GET with no bearer; the brief carries the per-surface token through the shared client", async () => {
		const tokens = tempDir();
		writeFileSync(join(tokens, "omp"), `${CANARY_FILE}\n`);
		const { calls, fetch: stub } = brief(() => new Response("# brief"));
		const result = await probeSubstrate(
			context(stub, { SUBSTRATE_TOKEN: undefined, SUBSTRATE_TOKENS_DIR: tokens }),
		);
		expect(result.status).toBe("connected");
		const [health, request] = calls;
		expect(health?.method).toBe("GET");
		expect(health?.headers.authorization).toBeUndefined();
		expect(request?.method).toBe("POST");
		expect(request?.headers.authorization).toBe(`Bearer ${CANARY_FILE}`);
		expect(request?.body?.surface).toBe("omp");
		expectNoSecret(result);
	});

	test("a 401 on the brief is misconfigured and names the fix without any token value", async () => {
		const { fetch: stub } = brief(() =>
			Response.json({ error: "unknown or missing bearer token" }, { status: 401 }),
		);
		const result = await probeSubstrate(context(stub));
		expect(result).toMatchObject({
			status: "misconfigured",
			reason: "brief refused the bearer (401)",
			fix: "set SUBSTRATE_TOKEN (or SUBSTRATE_TOKEN_FILE / SUBSTRATE_TOKENS_DIR per-surface files)",
			affects: ["brief"],
			via: "http",
		});
		expectNoSecret(result);
	});

	test("a surface mismatch recovered by the retry is connected and names the token surface and the host", async () => {
		const { briefCalls, fetch: stub } = brief((_call, n) =>
			n === 1 ? Response.json(MISMATCH, { status: 403 }) : new Response("# brief"),
		);
		const result = await probeSubstrate(context(stub));
		expect(result.status).toBe("connected");
		expect(result.reason).toBe("brief via token surface claude-code for host omp");
		expect(result.fix).toBeUndefined();
		expect(briefCalls).toHaveLength(2);
		expect(briefCalls[0]?.body?.surface).toBe("omp");
		expect(briefCalls[1]?.body).not.toHaveProperty("surface");
		expectNoSecret(result);
	});

	test("a prime-agent host asks as the pi surface and is named by its own host id", async () => {
		const { briefCalls, fetch: stub } = brief((_call, n) =>
			n === 1
				? Response.json(
						{ error: "this token is claude-code and cannot act as pi" },
						{ status: 403 },
					)
				: new Response("# brief"),
		);
		const result = await probeSubstrate(context(stub, {}, { host: "prime-agent" }));
		expect(briefCalls[0]?.body?.surface).toBe("pi");
		expect(result.reason).toBe("brief via token surface claude-code for host prime-agent");
	});

	test.each(["degraded", "snapshot"] as const)(
		"an X-Substrate-Brief %s brief is degraded and affects the brief",
		async (state) => {
			const { fetch: stub } = brief(
				() => new Response("# brief", { headers: { "x-substrate-brief": state } }),
			);
			const result = await probeSubstrate(context(stub));
			expect(result).toMatchObject({
				status: "degraded",
				reason: `brief is ${state}`,
				affects: ["brief"],
				via: "http",
			});
		},
	);

	test("a degraded brief recovered through the retry is degraded and still names the token surface", async () => {
		const { fetch: stub } = brief((_call, n) =>
			n === 1
				? Response.json(MISMATCH, { status: 403 })
				: new Response("# brief", { headers: { "x-substrate-brief": "degraded" } }),
		);
		const result = await probeSubstrate(context(stub));
		expect(result.status).toBe("degraded");
		expect(result.reason).toBe("brief is degraded (via token surface claude-code for host omp)");
		expect(result.affects).toEqual(["brief"]);
	});

	test("a complete brief is connected with reason `brief ok` and a latency", async () => {
		const { fetch: stub } = brief(
			() => new Response("# brief", { headers: { "x-substrate-brief": "complete" } }),
		);
		const result = await probeSubstrate(context(stub));
		expect(result.member).toBe("substrate");
		expect(result.status).toBe("connected");
		expect(result.reason).toBe("brief ok");
		expect(result.affects).toBeUndefined();
		expect(result.via).toBe("http");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(result.latencyMs).toBeLessThan(2000);
	});

	test("an empty 200 is connected and says the brief is empty", async () => {
		const { fetch: stub } = brief(() => new Response("", { status: 200 }));
		const result = await probeSubstrate(context(stub));
		expect(result.status).toBe("connected");
		expect(result.reason).toBe("brief empty");
	});

	test.each([
		[400, "brief request rejected (400)"],
		[404, "brief http-404"],
		[500, "brief http-500"],
		[503, "brief http-503"],
	] as const)("a %d on the brief is unavailable: %s", async (status, reason) => {
		const { fetch: stub } = brief(() => Response.json({ error: "no" }, { status }));
		const result = await probeSubstrate(context(stub));
		expect(result).toMatchObject({
			status: "unavailable",
			reason,
			affects: ["brief"],
			via: "http",
		});
	});

	test("a brief that connects then fails is unavailable and says unreachable", async () => {
		const { fetch: stub } = install((call) => {
			if (call.url.endsWith("/healthz")) return Response.json({ ok: true });
			throw new Error("socket hang up");
		});
		const result = await probeSubstrate(context(stub));
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("brief unreachable");
	});

	test("a brief that never answers is unavailable (brief timed out) inside the probe's timeout", async () => {
		const { fetch: stub } = install((call, signal) =>
			call.url.endsWith("/healthz") ? Response.json({ ok: true }) : hang(signal),
		);
		const began = Date.now();
		const result = await probeSubstrate(context(stub, {}, { timeoutMs: 400 }));
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("brief timed out");
		expect(Date.now() - began).toBeLessThan(1500);
		expect(result.latencyMs).toBeLessThanOrEqual(1000);
	});

	test("a fetch that ignores its abort signal still resolves at the timeout and never rejects", async () => {
		const { fetch: stub } = install(() => new Promise<Response>(() => undefined));
		const began = Date.now();
		const result = await probeSubstrate(context(stub, {}, { timeoutMs: 200 }));
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("probe timed out");
		expect(Date.now() - began).toBeLessThan(1500);
	});

	test("a probe that throws internally resolves as unavailable instead of rejecting", async () => {
		const { fetch: stub } = brief(() => new Response("x"));
		const broken = { ...context(stub), config: undefined as never };
		const result = await probeSubstrate(broken);
		expect(result).toMatchObject({
			member: "substrate",
			status: "unavailable",
			reason: "probe failed",
		});
	});

	test("a fetch that throws synchronously is unavailable, not a rejection", async () => {
		const throwing = (() => {
			throw new Error("boom");
		}) as unknown as typeof fetch;
		const result = await probeSubstrate(context(throwing));
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("healthz unreachable");
	});

	test("no field of any outcome carries a planted token, even one echoed by the server", async () => {
		const scenarios: Array<[string, Handler]> = [
			["401", () => Response.json({ error: `bad ${CANARY}` }, { status: 401 })],
			[
				"mismatch naming the token",
				(call) =>
					call.body && "surface" in call.body
						? Response.json(
								{ error: `this token is ${CANARY} and cannot act as omp` },
								{ status: 403 },
							)
						: new Response(`# brief ${CANARY}`),
			],
			["degraded", () => new Response("# brief", { headers: { "x-substrate-brief": "degraded" } })],
			["500", () => Response.json({ error: CANARY }, { status: 500 })],
			["complete", () => new Response("# brief")],
		];
		for (const [, handler] of scenarios) {
			const { fetch: stub } = install((call, signal) =>
				call.url.endsWith("/healthz") ? Response.json({ ok: true }) : handler(call, signal),
			);
			const result = await probeSubstrate(context(stub));
			expectNoSecret(result);
			expect(result.reason.split("\n")).toHaveLength(1);
		}
	});

	test("a per-surface token file for another surface is never sent for this host", async () => {
		const tokens = tempDir();
		writeFileSync(join(tokens, "cursor"), `${CANARY_FILE}\n`);
		const { briefCalls, fetch: stub } = brief(() => new Response("# brief"));
		const result = await probeSubstrate(
			context(stub, { SUBSTRATE_TOKEN: undefined, SUBSTRATE_TOKENS_DIR: tokens }),
		);
		expect(briefCalls[0]?.headers.authorization).toBeUndefined();
		expectNoSecret(result);
	});

	describe("URL policy, redirects and bounded reasons", () => {
		/** Real fetch semantics for `redirect: "error"`: a 3xx is a thrown TypeError; otherwise the target answers. */
		function redirecting(): { hops: Call[]; fetch: typeof fetch } {
			const hops: Call[] = [];
			async function stub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
				const url = String(input);
				hops.push({
					url,
					method: init?.method ?? "GET",
					headers: Object.fromEntries(new Headers(init?.headers).entries()),
					body:
						typeof init?.body === "string"
							? (JSON.parse(init.body) as Record<string, unknown>)
							: undefined,
				});
				if (url.endsWith("/healthz")) return Response.json({ ok: true });
				if (url.startsWith("https://evil.example.com")) return new Response("# stolen");
				// The server answers 302. A fetch told `redirect: "error"` fails; any other follows to the target, bearer and all.
				if (init?.redirect === "error")
					throw new TypeError("fetch failed: redirect is not allowed");
				return stub("https://evil.example.com/brief", init);
			}
			return { hops, fetch: stub as unknown as typeof fetch };
		}

		test("a redirecting server is refused: unavailable `brief redirect refused`, the bearer never reaches the second hop", async () => {
			const { hops, fetch: stub } = redirecting();
			const result = await probeSubstrate(context(stub));
			expect(result).toMatchObject({
				status: "unavailable",
				reason: "brief redirect refused",
				affects: ["brief"],
				via: "http",
			});
			expect(hops.some((hop) => hop.url.startsWith("https://evil.example.com"))).toBe(false);
			expect(hops.map((hop) => hop.method)).toEqual(["GET", "POST"]);
			expectNoSecret(result);
		});

		test("a plain-http remote URL with a bearer is misconfigured and no brief request is sent", async () => {
			const { calls, briefCalls, fetch: stub } = brief(() => new Response("# brief"));
			const result = await probeSubstrate(
				context(stub, { SUBSTRATE_URL: "http://substrate.example.com" }),
			);
			expect(result.status).toBe("misconfigured");
			expect(result.reason).toStartWith("brief url refused: ");
			expect(result.reason).not.toContain("substrate.example.com");
			expect(result.fix).toContain("https");
			expect(briefCalls).toEqual([]);
			expect(calls.every((call) => call.headers.authorization === undefined)).toBe(true);
			expectNoSecret(result);
		});

		test("an explicitly allowed URL is normalised: https with a trailing slash and a path", async () => {
			const { calls, fetch: stub } = brief(() => new Response("# brief"));
			const result = await probeSubstrate(
				context(stub, { SUBSTRATE_URL: "https://x.example.com/base/" }),
			);
			expect(result.status).toBe("connected");
			expect(calls.map((c) => c.url)).toEqual([
				"https://x.example.com/base/healthz",
				"https://x.example.com/base/brief",
			]);
		});

		test("a 403 body of 5000 characters with control characters yields a short, control-free reason", async () => {
			const hostile = `\u001b[31m${"A\u0007\u009b ".repeat(1000)}`;
			const { fetch: stub } = brief(() =>
				Response.json({ error: `this token is ${hostile} and cannot act as omp` }, { status: 403 }),
			);
			const result = await probeSubstrate(context(stub));
			expect(result.reason.length).toBeLessThanOrEqual(200);
			expect(/[\u0000-\u001f\u007f-\u009f]/.test(result.reason)).toBe(false);
		});
	});
});
