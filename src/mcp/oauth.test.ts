// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	beginLogin,
	completeLogin,
	recoverUnauthorized,
	logout,
	resolveAuthHeader,
	setApiKey,
	status,
} from "./oauth.ts";
import { readStore, withStoreLock, writeStore } from "./store.ts";
import type { OAuthClient } from "./store.ts";
import type { McpProviderId } from "./providers.ts";
import {
	getSecurityLogger,
	setSecurityLogger,
	type SecurityEvent,
	type SecurityEventLogger,
} from "../../services/ultrathink/security/events.ts";

const NOW = 1_700_000_000_000;
const REDIRECT = "http://127.0.0.1:8765/callback";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-mcp-"));
	path = join(dir, "creds.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
	url: string;
	body?: string;
	redirect?: RequestInit["redirect"];
}

function fakeFetch(routes: Record<string, (body: string | undefined) => Response>): {
	fetch: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({ url, body, redirect: init?.redirect });
		const route = routes[url];
		return route ? route(body) : new Response("nf", { status: 404 });
	};
	return { fetch: impl as typeof fetch, calls };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

const notionRoutes = (token: (body: string | undefined) => Response = () => json({})) => ({
	"https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": () =>
		json({
			resource: "https://mcp.notion.com/mcp",
			authorization_servers: ["https://mcp.notion.com"],
		}),
	"https://mcp.notion.com/.well-known/oauth-authorization-server": () =>
		json({
			issuer: "https://mcp.notion.com",
			authorization_endpoint: "https://mcp.notion.com/authorize",
			token_endpoint: "https://mcp.notion.com/token",
			registration_endpoint: "https://mcp.notion.com/register",
		}),
	"https://mcp.notion.com/register": () => json({ client_id: "cid-1" }, 201),
	"https://mcp.notion.com/token": token,
});

const client: OAuthClient = {
	clientId: "cid-1",
	redirectUri: REDIRECT,
	issuer: "https://mcp.notion.com",
	authorizationEndpoint: "https://mcp.notion.com/authorize",
	tokenEndpoint: "https://mcp.notion.com/token",
	registeredAt: NOW,
};

function seedOAuth(expiresAt: number, refreshToken = "rt-old") {
	writeStore(path, {
		version: 1,
		providers: {
			notion: {
				kind: "oauth",
				client,
				tokens: { accessToken: "at-old", refreshToken, expiresAt },
				updatedAt: NOW,
			},
		},
	});
}

/** A lock clock that starts at NOW, the instant the test stamps on each lock dir. Each injected wait advances it, so staleness is judged with no real delay. */
function lockClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
	let clock = NOW;
	return {
		now: () => clock,
		sleep: (ms) => {
			clock += ms;
			return Promise.resolve();
		},
	};
}

/**
 * A lock clock the test moves by hand. Heartbeat intervals are captured instead of run: a holder stays fresh only when the
 * test calls `fireHeartbeats`, so a test that never calls it models a holder that has stopped heartbeating.
 */
function manualLockClock() {
	let clock = NOW;
	const heartbeats = new Set<() => void>();
	return {
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		},
		timers: {
			setInterval: (fn: () => void) => {
				heartbeats.add(fn);
				return fn;
			},
			clearInterval: (handle: unknown) => {
				heartbeats.delete(handle as () => void);
			},
		},
		fireHeartbeats: () => {
			for (const beat of [...heartbeats]) beat();
		},
	};
}

describe("store", () => {
	test("round trip, 0600 mode, corrupt reads empty", () => {
		const store = {
			version: 1 as const,
			providers: { linear: { kind: "api_key" as const, apiKey: "k", updatedAt: 1 } },
		};
		writeStore(path, store);
		expect(readStore(path)).toEqual(store);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		writeFileSync(path, "{not json");
		expect(readStore(path)).toEqual({ version: 1, providers: {} });
		expect(readStore(join(dir, "missing.json"))).toEqual({ version: 1, providers: {} });
	});

	test("lock serializes concurrent callers", async () => {
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const a = withStoreLock(
			path,
			async () => {
				events.push("a-start");
				entered.resolve();
				await gate.promise;
				events.push("a-end");
			},
			{ pollMs: 1 },
		);
		await entered.promise;
		const b = withStoreLock(
			path,
			async () => {
				events.push("b-start");
			},
			{ pollMs: 1 },
		);
		events.push("released");
		gate.resolve();
		await Promise.all([a, b]);
		expect(events).toEqual(["a-start", "released", "a-end", "b-start"]);
	});

	test("stale lock dir is removed", async () => {
		mkdirSync(`${path}.lock`);
		const old = new Date(NOW - 120_000);
		utimesSync(`${path}.lock`, old, old);
		expect(
			await withStoreLock(path, async () => 42, { waitMs: 200, pollMs: 5, now: () => NOW }),
		).toBe(42);
	});

	// Staleness is judged from the lock directory's mtime against the injected clock. The holder stamps the lock at NOW,
	// and waits go through the injected sleep. Each wait advances the clock, so the test reaches "stale" with no real delay.
	test("a broken stale lock is never released by its previous holder", async () => {
		const lock = `${path}.lock`;
		const clock = lockClock();
		const events: string[] = [];
		const aRelease = Promise.withResolvers<void>();
		const bStarted = Promise.withResolvers<void>();
		const aDone = Promise.withResolvers<void>();
		const a = withStoreLock(
			path,
			async () => {
				events.push("a-start");
				utimesSync(lock, new Date(NOW), new Date(NOW));
				await aRelease.promise;
				events.push("a-end");
			},
			{ staleMs: 60_000, pollMs: 5 },
		);
		const b = withStoreLock(
			path,
			async () => {
				events.push("b-start");
				bStarted.resolve();
				await aDone.promise;
				events.push(statSync(lock, { throwIfNoEntry: false }) ? "lock-held" : "lock-lost");
			},
			{ staleMs: 100, pollMs: 5, waitMs: 5_000, ...clock },
		);
		await bStarted.promise;
		aRelease.resolve();
		await a;
		aDone.resolve();
		await b;
		expect(events).toEqual(["a-start", "b-start", "a-end", "lock-held"]);
		expect(statSync(lock, { throwIfNoEntry: false })).toBeUndefined();
	});

	test("a live holder is not judged stale while a waiter polls", async () => {
		const events: string[] = [];
		const release = Promise.withResolvers<void>();
		const waiterSettled = Promise.withResolvers<void>();
		const clock = manualLockClock();
		let polls = 0;
		// Each poll moves the clock 200ms, so the clock passes staleMs (500) after three polls. The holder heartbeats
		// before every judgement, so the lock stays fresh and the waiter stays blocked through all ten polls.
		const opts = {
			staleMs: 500,
			pollMs: 10,
			waitMs: 10_000,
			now: clock.now,
			timers: clock.timers,
			sleep: () => {
				polls += 1;
				clock.advance(200);
				clock.fireHeartbeats();
				if (polls === 10) waiterSettled.resolve();
				return Promise.resolve();
			},
		};
		const a = withStoreLock(
			path,
			async () => {
				events.push("a-start");
				utimesSync(`${path}.lock`, new Date(NOW), new Date(NOW));
				await release.promise;
				events.push("a-end");
			},
			opts,
		);
		// A waiter that gets in early settles the wait too, so a lost heartbeat fails the assertions instead of hanging.
		const b = withStoreLock(
			path,
			async () => {
				events.push("b-start");
				waiterSettled.resolve();
			},
			opts,
		);
		await waiterSettled.promise;
		release.resolve();
		await Promise.all([a, b]);
		expect(events).toEqual(["a-start", "a-end", "b-start"]);
		expect(clock.now() - NOW).toBeGreaterThan(opts.staleMs);
	});

	test("a holder that stops heartbeating is taken over once the clock passes staleMs", async () => {
		const events: string[] = [];
		const release = Promise.withResolvers<void>();
		const clock = manualLockClock();
		// Same clock and poll pacing, but nothing fires the heartbeat. The lock keeps its NOW stamp, and the waiter takes
		// over on the third poll, when the clock is 600ms past it.
		const opts = {
			staleMs: 500,
			pollMs: 10,
			waitMs: 10_000,
			now: clock.now,
			timers: clock.timers,
			sleep: () => {
				clock.advance(200);
				return Promise.resolve();
			},
		};
		const a = withStoreLock(
			path,
			async () => {
				events.push("a-start");
				utimesSync(`${path}.lock`, new Date(NOW), new Date(NOW));
				await release.promise;
				events.push("a-end");
			},
			opts,
		);
		await withStoreLock(path, async () => void events.push("b-start"), opts);
		expect(clock.now() - NOW).toBeGreaterThan(opts.staleMs);
		release.resolve();
		await a;
		expect(events).toEqual(["a-start", "b-start", "a-end"]);
		expect(statSync(`${path}.lock`, { throwIfNoEntry: false })).toBeUndefined();
	});
});

describe("login", () => {
	test("beginLogin builds S256 URL and reuses the registered client", async () => {
		const fake = fakeFetch(notionRoutes());
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path, redirectUri: REDIRECT };
		const pending = await beginLogin("notion", deps);
		const url = new URL(pending.url);
		expect(url.origin + url.pathname).toBe("https://mcp.notion.com/authorize");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(pending.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("state")).toBe(pending.state);
		expect(url.searchParams.get("resource")).toBe("https://mcp.notion.com/mcp");
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
		expect(url.searchParams.get("client_id")).toBe("cid-1");
		expect(url.searchParams.get("scope")).toBe("default");

		const second = await beginLogin("notion", deps);
		expect(second.client.clientId).toBe("cid-1");
		expect(fake.calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
	});

	test("completeLogin exchanges with verifier + resource and persists tokens", async () => {
		const fake = fakeFetch(
			notionRoutes(() => json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 })),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await completeLogin(pending, `${REDIRECT}?code=abc&state=${pending.state}`, deps);
		const body = new URLSearchParams(fake.calls.at(-1)?.body);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code_verifier")).toBe(pending.verifier);
		expect(body.get("resource")).toBe("https://mcp.notion.com/mcp");
		expect(body.get("code")).toBe("abc");
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.tokens).toEqual({
			accessToken: "at-1",
			refreshToken: "rt-1",
			expiresAt: NOW + 3_600_000,
			scope: undefined,
		});
	});

	test("state mismatch rejects without persisting tokens", async () => {
		const fake = fakeFetch(notionRoutes(() => json({ access_token: "at-1" })));
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await expect(completeLogin(pending, "code=abc&state=evil", deps)).rejects.toThrow(
			"state mismatch",
		);
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.tokens).toBeUndefined();
		expect(fake.calls.some((c) => c.url.endsWith("/token"))).toBe(false);
	});

	test("callback without state is rejected before any token request; bare code accepted", async () => {
		const fake = fakeFetch(
			notionRoutes(() => json({ access_token: "at-1", refresh_token: "rt-1" })),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await expect(completeLogin(pending, "?code=X", deps)).rejects.toThrow("state mismatch");
		await expect(completeLogin(pending, `${REDIRECT}?code=X`, deps)).rejects.toThrow(
			"state mismatch",
		);
		expect(fake.calls.some((c) => c.url.endsWith("/token"))).toBe(false);
		await completeLogin(pending, "X", deps);
		expect(new URLSearchParams(fake.calls.at(-1)?.body).get("code")).toBe("X");
		expect(await resolveAuthHeader("notion", deps)).toBe("Bearer at-1");
	});

	test("discovered metadata that does not name its issuer is refused", async () => {
		const fake = fakeFetch({
			"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": () =>
				json({ authorization_servers: ["https://mcp.linear.app"] }),
			"https://mcp.linear.app/.well-known/oauth-authorization-server": () =>
				json({
					authorization_endpoint: "https://mcp.linear.app/authorize",
					token_endpoint: "https://mcp.linear.app/token",
				}),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		await expect(beginLogin("linear", { ...deps, redirectUri: REDIRECT })).rejects.toThrow(
			"issuer mismatch",
		);
	});

	test("a token response of exactly the body cap is read", async () => {
		const body = (padding: number) =>
			JSON.stringify({ access_token: "at-1", pad: "x".repeat(padding) });
		const cap = 1024 * 1024;
		const fake = fakeFetch(
			notionRoutes(
				() =>
					new Response(body(cap - body(0).length), {
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await completeLogin(pending, "X", deps);
		expect(await resolveAuthHeader("notion", deps)).toBe("Bearer at-1");
	});

	test("a token response one byte over the body cap is refused", async () => {
		const body = (padding: number) =>
			JSON.stringify({ access_token: "at-1", pad: "x".repeat(padding) });
		const cap = 1024 * 1024;
		const fake = fakeFetch(
			notionRoutes(
				() =>
					new Response(body(cap - body(0).length + 1), {
						headers: { "content-type": "application/json" },
					}),
			),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await expect(completeLogin(pending, "X", deps)).rejects.toThrow();
	});

	test("an unreadable metadata body falls back to the next discovery document", async () => {
		const broken = new Response(
			new ReadableStream({ pull: (controller) => controller.error(new Error("connection reset")) }),
			{
				headers: { "content-type": "application/json" },
			},
		);
		const fake = fakeFetch({
			"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": () =>
				json({ authorization_servers: ["https://mcp.linear.app"] }),
			"https://mcp.linear.app/.well-known/oauth-authorization-server": () => broken,
			"https://mcp.linear.app/.well-known/openid-configuration": () =>
				json({
					issuer: "https://mcp.linear.app",
					authorization_endpoint: "https://mcp.linear.app/authorize",
					token_endpoint: "https://mcp.linear.app/token",
					registration_endpoint: "https://mcp.linear.app/register",
				}),
			"https://mcp.linear.app/register": () => json({ client_id: "lin-cid" }, 201),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("linear", { ...deps, redirectUri: REDIRECT });
		expect(pending.client.clientId).toBe("lin-cid");
	});

	test("beginLogin keeps an existing api key or live tokens usable", async () => {
		const linearRoutes = {
			"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": () =>
				json({ authorization_servers: ["https://mcp.linear.app"] }),
			"https://mcp.linear.app/.well-known/oauth-authorization-server": () =>
				json({
					issuer: "https://mcp.linear.app",
					authorization_endpoint: "https://mcp.linear.app/authorize",
					token_endpoint: "https://mcp.linear.app/token",
					registration_endpoint: "https://mcp.linear.app/register",
				}),
			"https://mcp.linear.app/register": () => json({ client_id: "lin-cid" }, 201),
		};
		const fake = fakeFetch({ ...notionRoutes(), ...linearRoutes });
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		await setApiKey("linear", "lin_api_x", deps);
		const pending = await beginLogin("linear", { ...deps, redirectUri: REDIRECT });
		expect(pending.client.clientId).toBe("lin-cid");
		expect(await resolveAuthHeader("linear", deps)).toBe("Bearer lin_api_x");

		seedOAuth(NOW + 3_600_000);
		await beginLogin("notion", { ...deps, redirectUri: "http://127.0.0.1:9999/other" });
		expect(await resolveAuthHeader("notion", deps)).toBe("Bearer at-old");
	});

	test("token errors never leak secrets", async () => {
		const fake = fakeFetch(
			notionRoutes(() =>
				json({ error: "invalid_request", error_description: "code SECRETCODE bad" }, 400),
			),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		const error = await completeLogin(pending, "SECRETCODE", deps).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("HTTP 400");
		expect((error as Error).message).toContain("invalid_request");
		expect((error as Error).message).not.toContain("SECRETCODE");
		expect((error as Error).message).not.toContain(pending.verifier);
	});

	test("discovery, token and registration fetches never follow redirects", async () => {
		const fake = fakeFetch(notionRoutes(() => json({ access_token: "at-1" })));
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await completeLogin(pending, "X", deps);
		expect(fake.calls.length).toBeGreaterThanOrEqual(4);
		expect(fake.calls.every((c) => c.redirect === "error")).toBe(true);
	});

	test("metadata with an http token endpoint is rejected before any registration or token request", async () => {
		const fake = fakeFetch({
			...notionRoutes(() => json({ access_token: "at-1" })),
			"https://mcp.notion.com/.well-known/oauth-authorization-server": () =>
				json({
					issuer: "https://mcp.notion.com",
					authorization_endpoint: "https://mcp.notion.com/authorize",
					token_endpoint: "http://mcp.notion.com/token",
					registration_endpoint: "https://mcp.notion.com/register",
				}),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path, redirectUri: REDIRECT };
		await expect(beginLogin("notion", deps)).rejects.toThrow("must use https");
		expect(fake.calls.some((c) => c.url.endsWith("/register") || c.url.endsWith("/token"))).toBe(
			false,
		);
		expect(readStore(path).providers.notion).toBeUndefined();
	});

	test("an http authorization server or registration endpoint is rejected", async () => {
		const httpAs = fakeFetch({
			...notionRoutes(),
			"https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": () =>
				json({
					resource: "https://mcp.notion.com/mcp",
					authorization_servers: ["http://mcp.notion.com"],
				}),
		});
		const deps = { now: () => NOW, storePath: path, redirectUri: REDIRECT };
		await expect(beginLogin("notion", { ...deps, fetch: httpAs.fetch })).rejects.toThrow(
			"must use https",
		);
		expect(httpAs.calls.some((c) => c.url.startsWith("http://"))).toBe(false);

		const httpDcr = fakeFetch({
			...notionRoutes(),
			"https://mcp.notion.com/.well-known/oauth-authorization-server": () =>
				json({
					authorization_endpoint: "https://mcp.notion.com/authorize",
					token_endpoint: "https://mcp.notion.com/token",
					registration_endpoint: "http://mcp.notion.com/register",
				}),
		});
		await expect(beginLogin("notion", { ...deps, fetch: httpDcr.fetch })).rejects.toThrow(
			"must use https",
		);
		expect(httpDcr.calls.some((c) => c.url.startsWith("http://"))).toBe(false);
	});

	test("metadata naming a different issuer is rejected", async () => {
		const fake = fakeFetch({
			...notionRoutes(),
			"https://mcp.notion.com/.well-known/oauth-authorization-server": () =>
				json({
					issuer: "https://evil.example",
					authorization_endpoint: "https://mcp.notion.com/authorize",
					token_endpoint: "https://mcp.notion.com/token",
					registration_endpoint: "https://mcp.notion.com/register",
				}),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path, redirectUri: REDIRECT };
		await expect(beginLogin("notion", deps)).rejects.toThrow("issuer mismatch");
		expect(fake.calls.some((c) => c.url.endsWith("/register"))).toBe(false);
	});

	test("a stored client with an http token endpoint is re-registered instead of reused", async () => {
		writeStore(path, {
			version: 1,
			providers: {
				notion: {
					kind: "oauth",
					client: { ...client, tokenEndpoint: "http://mcp.notion.com/token" },
					updatedAt: NOW,
				},
			},
		});
		const fake = fakeFetch(notionRoutes());
		const pending = await beginLogin("notion", {
			fetch: fake.fetch,
			now: () => NOW,
			storePath: path,
			redirectUri: REDIRECT,
		});
		expect(fake.calls.filter((c) => c.url.endsWith("/register"))).toHaveLength(1);
		expect(pending.client.tokenEndpoint).toBe("https://mcp.notion.com/token");
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.client.tokenEndpoint).toBe(
			"https://mcp.notion.com/token",
		);
	});
});

describe("resolveAuthHeader", () => {
	test("api key", async () => {
		await setApiKey("linear", "lin_api_x", { storePath: path });
		expect(await resolveAuthHeader("linear", { storePath: path })).toBe("Bearer lin_api_x");
		expect(status({ storePath: path }).find((s) => s.provider === "linear")?.detail).not.toContain(
			"lin_api_x",
		);
	});

	test("setApiKey rejects notion", async () => {
		await expect(setApiKey("notion", "k", { storePath: path })).rejects.toThrow();
	});

	test("fresh token needs no network", async () => {
		seedOAuth(NOW + 3_600_000);
		const fake = fakeFetch({});
		expect(
			await resolveAuthHeader("notion", { fetch: fake.fetch, now: () => NOW, storePath: path }),
		).toBe("Bearer at-old");
		expect(fake.calls).toHaveLength(0);
	});

	test("expiring token is refreshed and rotated refresh token persisted", async () => {
		seedOAuth(NOW + 10_000);
		const fake = fakeFetch({
			"https://mcp.notion.com/token": () =>
				json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 }),
		});
		expect(
			await resolveAuthHeader("notion", { fetch: fake.fetch, now: () => NOW, storePath: path }),
		).toBe("Bearer at-new");
		const body = new URLSearchParams(fake.calls[0]?.body);
		expect(body.get("refresh_token")).toBe("rt-old");
		expect(body.get("resource")).toBe("https://mcp.notion.com/mcp");
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.tokens?.refreshToken).toBe("rt-new");
	});

	test("concurrent callers perform exactly one refresh", async () => {
		seedOAuth(NOW + 10_000);
		const fake = fakeFetch({
			"https://mcp.notion.com/token": () =>
				json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 }),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const results = await Promise.all([
			resolveAuthHeader("notion", deps),
			resolveAuthHeader("notion", deps),
		]);
		expect(results).toEqual(["Bearer at-new", "Bearer at-new"]);
		expect(fake.calls).toHaveLength(1);
	});

	test("a waiter on a slow refresh does not refresh a second time", async () => {
		seedOAuth(NOW + 10_000);
		const clock = manualLockClock();
		let tokenCalls = 0;
		// The refresh is held on a gate and the waiter's lock polls go through an injected sleep, so no real time passes.
		// The holder stamps its lock on the test clock and heartbeats before every waiter judgement. The clock moves past
		// staleMs, yet the lock stays fresh, so the waiter must read the token the first caller stored instead of stealing it.
		const refreshed = Promise.withResolvers<void>();
		const waiterPolled = Promise.withResolvers<void>();
		let polls = 0;
		const slowFetch = (async () => {
			tokenCalls++;
			utimesSync(`${path}.lock`, new Date(NOW), new Date(NOW));
			await refreshed.promise;
			return json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 });
		}) as unknown as typeof fetch;
		const deps = {
			fetch: slowFetch,
			now: clock.now,
			storePath: path,
			lock: { staleMs: 500, pollMs: 10, waitMs: 10_000, timers: clock.timers },
			sleep: () => {
				polls += 1;
				clock.advance(200);
				clock.fireHeartbeats();
				if (polls === 3) waiterPolled.resolve();
				return Promise.resolve();
			},
		};
		const results = Promise.all([
			resolveAuthHeader("notion", deps),
			resolveAuthHeader("notion", deps),
		]);
		await waiterPolled.promise;
		refreshed.resolve();
		expect(await results).toEqual(["Bearer at-new", "Bearer at-new"]);
		expect(tokenCalls).toBe(1);
		expect(clock.now() - NOW).toBeGreaterThan(500);
	});

	test("a waiter on a slow refresh refreshes again once the holder stops heartbeating", async () => {
		seedOAuth(NOW + 10_000);
		const clock = manualLockClock();
		let tokenCalls = 0;
		// The holder stamps its lock once and never heartbeats. Each poll moves the clock 200ms, so the waiter judges the
		// lock stale on the third poll, takes it over and starts a second token refresh.
		const refreshed = Promise.withResolvers<void>();
		const takenOver = Promise.withResolvers<void>();
		const slowFetch = (async () => {
			tokenCalls++;
			if (tokenCalls === 1) utimesSync(`${path}.lock`, new Date(NOW), new Date(NOW));
			else takenOver.resolve();
			await refreshed.promise;
			return json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 });
		}) as unknown as typeof fetch;
		const deps = {
			fetch: slowFetch,
			now: clock.now,
			storePath: path,
			lock: { staleMs: 500, pollMs: 10, waitMs: 10_000, timers: clock.timers },
			sleep: () => {
				clock.advance(200);
				return Promise.resolve();
			},
		};
		const results = Promise.all([
			resolveAuthHeader("notion", deps),
			resolveAuthHeader("notion", deps),
		]);
		await takenOver.promise;
		refreshed.resolve();
		expect(await results).toEqual(["Bearer at-new", "Bearer at-new"]);
		expect(tokenCalls).toBe(2);
	});
});

describe("recoverUnauthorized", () => {
	test("token already replaced -> true without network", async () => {
		seedOAuth(NOW + 3_600_000);
		const fake = fakeFetch({});
		expect(
			await recoverUnauthorized("notion", "Bearer stale", { fetch: fake.fetch, storePath: path }),
		).toBe(true);
		expect(fake.calls).toHaveLength(0);
	});

	test("invalid_grant marks needsLogin", async () => {
		seedOAuth(NOW + 3_600_000);
		const fake = fakeFetch({
			"https://mcp.notion.com/token": () => json({ error: "invalid_grant" }, 400),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		expect(await recoverUnauthorized("notion", "Bearer at-old", deps)).toBe(false);
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.needsLogin).toBe("invalid_grant");
		expect(await resolveAuthHeader("notion", deps)).toBeUndefined();
		expect(status(deps).find((s) => s.provider === "notion")).toMatchObject({ ready: false });
	});

	test("api key -> false", async () => {
		await setApiKey("greptile", "g", { storePath: path });
		expect(await recoverUnauthorized("greptile", "Bearer g", { storePath: path })).toBe(false);
	});
});

/** Keeps each validation refusal the logger seam reports, and writes nothing. */
class RecordingLogger implements SecurityEventLogger {
	readonly validation: Partial<SecurityEvent>[] = [];
	log(): void {
		// reason: test double, no-op by design
	}
	logAuthFailure(): void {
		// reason: test double, no-op by design
	}
	logValidationFailure(details: Partial<SecurityEvent>): void {
		this.validation.push(details);
	}
	logRateLimitExceeded(): void {
		// reason: test double, no-op by design
	}
	logSuspiciousActivity(): void {
		// reason: test double, no-op by design
	}
}

describe("refused input", () => {
	test("a provider the table does not name and a pasted callback with a control character are refused before any request", async () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			const fake = fakeFetch(notionRoutes());
			const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
			// The type promises a provider id; a runtime caller can still pass anything.
			const hostile: string = "notion\u0000";
			await expect(
				beginLogin(hostile as McpProviderId, { ...deps, redirectUri: REDIRECT }),
			).rejects.toThrow("unknown MCP provider");
			expect(fake.calls).toHaveLength(0);
			const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
			const requests = fake.calls.length;
			await expect(
				completeLogin(pending, `${REDIRECT}?code=abc&state=${pending.state}\u0007`, deps),
			).rejects.toThrow("authorization callback is not valid text");
			expect(fake.calls).toHaveLength(requests);
			expect(recorder.validation).toEqual([
				{
					source: "mcp_oauth",
					resource: "oauth",
					details: { field: "provider", code: "INVALID_VALUE" },
				},
				{
					source: "mcp_oauth",
					resource: "oauth",
					details: { field: "callback", code: "PATTERN_MISMATCH" },
				},
			]);
		} finally {
			setSecurityLogger(previous);
		}
	});
});

describe("callback and token limits", () => {
	test("a percent-encoded control character in a callback parameter is refused before the token request, and logged", async () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			const fake = fakeFetch(notionRoutes(() => json({ access_token: "at-1" })));
			const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
			const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
			const requests = fake.calls.length;
			// The raw callback passes the text check: %07 is plain text there. It decodes to BEL, which must not reach the token endpoint.
			await expect(
				completeLogin(pending, `${REDIRECT}?code=abc%07&state=${pending.state}`, deps),
			).rejects.toThrow("authorization callback is not valid text");
			expect(fake.calls).toHaveLength(requests);
			expect(recorder.validation).toEqual([
				{
					source: "mcp_oauth",
					resource: "oauth",
					details: { field: "code", code: "PATTERN_MISMATCH" },
				},
			]);
		} finally {
			setSecurityLogger(previous);
		}
	});

	test("a 5000-character access token is accepted, sent, and recovered after a 401 without being refused", async () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			const token = "a".repeat(5000);
			const fake = fakeFetch(
				notionRoutes(() => json({ access_token: token, refresh_token: "rt-1", expires_in: 3600 })),
			);
			const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
			const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
			await completeLogin(pending, `${REDIRECT}?code=abc&state=${pending.state}`, deps);
			const sent = await resolveAuthHeader("notion", deps);
			expect(sent).toBe(`Bearer ${token}`);
			const refreshed = fakeFetch(
				notionRoutes(() =>
					json({ access_token: "b".repeat(5000), refresh_token: "rt-2", expires_in: 3600 }),
				),
			);
			expect(
				await recoverUnauthorized("notion", sent, {
					fetch: refreshed.fetch,
					now: () => NOW,
					storePath: path,
				}),
			).toBe(true);
			expect(refreshed.calls.some((c) => c.url.endsWith("/token"))).toBe(true);
			expect(recorder.validation).toEqual([]);
		} finally {
			setSecurityLogger(previous);
		}
	});

	test("an access token over the limit is refused when accepted, logged, and nothing is stored", async () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			const fake = fakeFetch(notionRoutes(() => json({ access_token: "a".repeat(8200) })));
			const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
			const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
			await expect(
				completeLogin(pending, `${REDIRECT}?code=abc&state=${pending.state}`, deps),
			).rejects.toThrow("too long or malformed");
			const cred = readStore(path).providers.notion;
			expect(cred?.kind === "oauth" && cred.tokens).toBeUndefined();
			expect(recorder.validation).toEqual([
				{
					source: "mcp_oauth",
					resource: "oauth",
					details: { field: "access_token", code: "TOO_LONG" },
				},
			]);
		} finally {
			setSecurityLogger(previous);
		}
	});
});

describe("credential store cannot be wiped", () => {
	const corrupt = '{"version":1,"providers":{"notion":{"kind":"api_key","apiKey":"keep-me"';

	test("an unreadable store makes a mutation throw and leaves the bytes untouched", async () => {
		writeFileSync(path, corrupt);
		const before = statSync(path);
		await expect(
			setApiKey("linear", "lin-key", { storePath: path, now: () => NOW }),
		).rejects.toThrow("credential store");
		await expect(logout("linear", { storePath: path, now: () => NOW })).rejects.toThrow(
			"credential store",
		);
		expect(readFileSync(path, "utf8")).toBe(corrupt);
		expect(statSync(path).ino).toBe(before.ino);
	});

	test("a newer-version store is unreadable in the lock and kept, while an unlocked status read stays lenient", async () => {
		const newer = JSON.stringify({
			version: 2,
			providers: { notion: { kind: "api_key", apiKey: "k" } },
		});
		writeFileSync(path, newer);
		await expect(
			setApiKey("linear", "lin-key", { storePath: path, now: () => NOW }),
		).rejects.toThrow("credential store");
		expect(readFileSync(path, "utf8")).toBe(newer);
		expect(
			status({ storePath: path, now: () => NOW }).every((entry) => entry.kind === "none"),
		).toBe(true);
	});

	test("a mutation that changes nothing performs no write", async () => {
		writeStore(path, {
			version: 1,
			providers: { notion: { kind: "api_key", apiKey: "k", updatedAt: 1 } },
		});
		const old = new Date(1_000_000);
		utimesSync(path, old, old);
		const before = statSync(path);
		await logout("linear", { storePath: path, now: () => NOW });
		const after = statSync(path);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	test("an unreadable store is a credential error from resolveAuthHeader, distinct from not configured", async () => {
		expect(await resolveAuthHeader("linear", { storePath: path, now: () => NOW })).toBeUndefined();
		writeFileSync(path, corrupt);
		await expect(resolveAuthHeader("linear", { storePath: path, now: () => NOW })).rejects.toThrow(
			"credential store",
		);
	});

	test("a changed store is written once", async () => {
		await setApiKey("linear", "lin-key", { storePath: path, now: () => NOW });
		expect(readStore(path).providers.linear).toEqual({
			kind: "api_key",
			apiKey: "lin-key",
			updatedAt: NOW,
		});
	});
});
