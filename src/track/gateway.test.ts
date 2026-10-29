// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { resolveAuthHeader } from "../mcp/oauth.ts";
import { writeStore } from "../mcp/store.ts";
import { createGatewayTracker, shellArg, trackCommand } from "./gateway.ts";
import type { TrackPlan } from "./types.ts";

let dir: string;
let path: string;
// Fixed wall clock: fixtures and expiry checks read the same instant on every run.
const FIXED = 1_700_000_000_000;
beforeEach(() => {
	setSystemTime(FIXED);
	dir = mkdtempSync(join(tmpdir(), "ut-gateway-"));
	path = join(dir, "creds.json");
});
afterEach(() => {
	setSystemTime();
	rmSync(dir, { recursive: true, force: true });
});

// Never reached by these cases: the tracker must bail before creation.
const plan = { graphId: "g1" } as TrackPlan;

function configured(
	over: { team?: string; dataSourceUrl?: string } = {
		team: "Team",
		dataSourceUrl: "collection://ds",
	},
): UltrathinkConfig {
	const config = defaultConfig();
	config.linear.team = over.team ?? "";
	config.notion.dataSourceUrl = over.dataSourceUrl ?? "";
	return config;
}

/** An expired OAuth credential: resolving its auth header POSTs to `tokenEndpoint`. */
function expiredOauth(issuer: string, now: number) {
	return {
		kind: "oauth" as const,
		client: {
			clientId: "cid-1",
			redirectUri: "http://127.0.0.1:8765/callback",
			issuer,
			authorizationEndpoint: `${issuer}/authorize`,
			tokenEndpoint: `${issuer}/token`,
			registeredAt: now,
		},
		tokens: { accessToken: "at", refreshToken: "rt", expiresAt: now - 1 },
		updatedAt: now,
	};
}

function recordingFetch(urls: string[]): typeof fetch {
	return (async (input: string | URL | Request) => {
		urls.push(String(input));
		return new Response("{}", { status: 500 });
	}) as typeof fetch;
}

describe("trackCommand", () => {
	test("a plain clone path is printed as-is", () => {
		expect(trackCommand("/opt/ultrathink")).toBe(
			"/opt/ultrathink/bin/ultrathink-mcp track complete",
		);
	});

	test("a clone path with a space or a quote is single-quoted so the command still runs", () => {
		expect(trackCommand("/Users/Jane Doe/ultrathink")).toBe(
			"'/Users/Jane Doe/ultrathink/bin/ultrathink-mcp' track complete",
		);
		expect(shellArg("/Users/o'neil/x")).toBe(`'/Users/o'\\''neil/x'`);
	});
});

describe("createGatewayTracker", () => {
	test("is undefined when neither Linear nor Notion is configured", () => {
		expect(createGatewayTracker(defaultConfig(), { storePath: path })).toBeUndefined();
		expect(createGatewayTracker(configured({ team: "  " }), { storePath: path })).toBeUndefined();
	});

	test("Linear-only config never contacts Notion", async () => {
		writeStore(path, {
			version: 1,
			providers: { notion: expiredOauth("https://mcp.notion.com", FIXED) },
		});
		const urls: string[] = [];
		const tracker = createGatewayTracker(configured({ team: "Team" }), {
			storePath: path,
			fetch: recordingFetch(urls),
		})!;
		expect(await tracker({ plan })).toBeUndefined();
		expect(urls).toEqual([]);
	});

	test("Notion-only config never contacts Linear", async () => {
		writeStore(path, {
			version: 1,
			providers: { linear: expiredOauth("https://mcp.linear.app", FIXED) },
		});
		const urls: string[] = [];
		const tracker = createGatewayTracker(configured({ dataSourceUrl: "collection://ds" }), {
			storePath: path,
			fetch: recordingFetch(urls),
		})!;
		expect(await tracker({ plan })).toBeUndefined();
		expect(urls).toEqual([]);
	});

	test("already-aborted signal returns undefined without any request", async () => {
		writeStore(path, {
			version: 1,
			providers: { linear: { kind: "api_key", apiKey: "k", updatedAt: 1 } },
		});
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return new Response("{}");
		}) as typeof fetch;
		const tracker = createGatewayTracker(configured(), { storePath: path, fetch: fakeFetch })!;
		const result = await tracker({ plan, signal: AbortSignal.abort() });
		expect(result).toBeUndefined();
		expect(urls).toEqual([]);
	});

	test("auth resolution slower than the budget returns undefined", async () => {
		const now = FIXED;
		writeStore(path, {
			version: 1,
			providers: { notion: expiredOauth("https://mcp.notion.com", now) },
		});
		const hang = Promise.withResolvers<Response>();
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return hang.promise;
		}) as typeof fetch;
		const config = configured();
		config.track.budgetMs = 50;
		// The budget timer is armed on a test-held port: the test fires it by hand instead of waiting for budgetMs.
		const armed = Promise.withResolvers<() => void>();
		const timers = {
			setTimeout: (fn: () => void) => {
				armed.resolve(fn);
				return {} as NodeJS.Timeout;
			},
			clearTimeout: () => undefined,
		};
		const tracker = createGatewayTracker(config, { storePath: path, fetch: fakeFetch, timers })!;
		const tracking = tracker({ plan });
		const fireBudget = await armed.promise;
		fireBudget();
		const result = await tracking;
		expect(result).toBeUndefined();
		expect(urls).toEqual(["https://mcp.notion.com/token"]);
		// Let the pending refresh settle before the temp dir is removed: a second resolve
		// waits on the store lock the first refresh still holds.
		hang.resolve(new Response("{}", { status: 500 }));
		await resolveAuthHeader("notion", { storePath: path, fetch: fakeFetch }).catch(() => undefined);
	});

	test("budgetMs 0 means no limit: a slow auth refresh is not cut and tracking proceeds", async () => {
		writeStore(path, {
			version: 1,
			providers: { notion: expiredOauth("https://mcp.notion.com", FIXED) },
		});
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			const url = String(input);
			urls.push(url);
			if (!url.endsWith("/token")) return new Response("{}", { status: 500 });
			// Held on a gate the test opens once the refresh has started, so the auth wait is never timed.
			entered.resolve();
			await gate.promise;
			return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), {
				status: 200,
			});
		}) as typeof fetch;
		const config = configured({ dataSourceUrl: "collection://ds" });
		config.track.budgetMs = 0;
		const tracker = createGatewayTracker(config, { storePath: path, fetch: fakeFetch })!;
		const emptyPlan: TrackPlan = {
			...plan,
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
		};
		const tracking = tracker({ plan: emptyPlan });
		await entered.promise;
		gate.resolve();
		const result = await tracking;
		expect(urls).toContain("https://mcp.notion.com/token");
		expect(result).toBeDefined();
	});

	test("a credential lookup error is logged per provider, never as login required", async () => {
		writeFileSync(
			path,
			'{"version":1,"providers":{"linear":{"kind":"api_key","apiKey":"top-secret"',
		);
		const lines: string[] = [];
		const tracker = createGatewayTracker(configured(), {
			storePath: path,
			log: (line) => lines.push(line),
		})!;
		expect(await tracker({ plan })).toBeUndefined();
		const linearLine = lines.find(
			(line) => line.includes("linear") && line.includes("credential error"),
		);
		const notionLine = lines.find(
			(line) => line.includes("notion") && line.includes("credential error"),
		);
		expect(linearLine).toBeDefined();
		expect(notionLine).toBeDefined();
		expect(lines.join("\n")).not.toContain("top-secret");
		expect(lines.join("\n")).not.toContain("login required");
	});

	test("an unconfigured provider is never reported, a configured one without credentials says login required", async () => {
		const lines: string[] = [];
		const tracker = createGatewayTracker(configured({ team: "Team" }), {
			storePath: path,
			log: (line) => lines.push(line),
		})!;
		expect(await tracker({ plan })).toBeUndefined();
		expect(lines.some((line) => line.includes("linear") && line.includes("login required"))).toBe(
			true,
		);
		expect(lines.some((line) => line.includes("notion"))).toBe(false);
	});

	test("one provider's credential error reaches the refs while the other provider proceeds", async () => {
		writeStore(path, {
			version: 1,
			providers: {
				linear: { kind: "api_key", apiKey: "k", updatedAt: 1 },
				notion: expiredOauth("https://mcp.notion.com", FIXED),
			},
		});
		const lines: string[] = [];
		const tracker = createGatewayTracker(configured(), {
			storePath: path,
			fetch: recordingFetch([]),
			log: (line) => lines.push(line),
		})!;
		const emptyPlan: TrackPlan = {
			...plan,
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
		};
		const refs = await tracker({ plan: emptyPlan });
		expect(refs?.errors.some((error) => error.startsWith("notion: credential error:"))).toBe(true);
		expect(refs?.errors).not.toContain("notion: login required");
		expect(lines.some((line) => line.includes("notion") && line.includes("credential error"))).toBe(
			true,
		);
	});

	test("the budget abort listener does not accumulate on a long-lived signal", async () => {
		writeStore(path, {
			version: 1,
			providers: { linear: { kind: "api_key", apiKey: "k", updatedAt: 1 } },
		});
		const tracker = createGatewayTracker(configured({ team: "Team" }), { storePath: path })!;
		const emptyPlan: TrackPlan = {
			...plan,
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
		};
		const controller = new AbortController();
		const added = spyOn(controller.signal, "addEventListener");
		const removed = spyOn(controller.signal, "removeEventListener");
		for (let call = 0; call < 1000; call++)
			await tracker({ plan: emptyPlan, signal: controller.signal });
		expect(added.mock.calls.length - removed.mock.calls.length).toBe(0);
	});
});
