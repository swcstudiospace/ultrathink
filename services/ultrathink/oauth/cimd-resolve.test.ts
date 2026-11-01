// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import type { CimdFetcher, CimdFetchResult } from "./cimd-fetch.ts";
import type { CimdDocument } from "./cimd.ts";
import {
	CIMD_CACHE_MAX_ENTRIES,
	CIMD_CACHE_TTL_CEILING_MS,
	type CimdResolution,
	cacheLifetimeMs,
	createCimdResolver,
	metadataDigest,
} from "./cimd-resolve.ts";
import type { OutboundCacheHeaders } from "../security/outbound-fetch.ts";

const START = 1_800_000_000_000;
const CLIENT = "https://client.example/cimd.json";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const OTHER_REDIRECT = "https://claude.com/api/mcp/callback";
const SUPPORTED = ["authorization_code", "refresh_token"];
const DEFAULTS = ["authorization_code"];

interface Probe {
	readonly fetcher: CimdFetcher;
	readonly calls: () => number;
}

// A fetcher that answers each call from `next`. It counts calls, so tests can observe fetches.
function scripted(next: (raw: unknown, call: number) => CimdFetchResult): Probe {
	let calls = 0;
	return {
		fetcher: {
			async fetch(raw) {
				calls += 1;
				return next(raw, calls);
			},
		},
		calls: () => calls,
	};
}

// Answers the calls in order. A call past the script fails the test loudly.
function queued(results: readonly CimdFetchResult[]): Probe {
	return scripted((_raw, call) => {
		const result = results[call - 1];
		if (result === undefined) throw new Error(`unexpected fetch number ${call}`);
		return result;
	});
}

function ok(
	clientId: string,
	metadata: Record<string, unknown> = {},
	headers: OutboundCacheHeaders = {},
): CimdFetchResult {
	const redirectUris = [REDIRECT];
	const document: CimdDocument = {
		client_id: clientId,
		redirect_uris: redirectUris,
		token_endpoint_auth_method: "none",
		metadata: {
			client_id: clientId,
			token_endpoint_auth_method: "none",
			redirect_uris: redirectUris,
			...metadata,
		},
	};
	return { ok: true, document, headers };
}

function resolverWith(probe: Probe, clock: { now: number }) {
	return createCimdResolver({
		fetcher: probe.fetcher,
		now: () => clock.now,
		supportedGrants: SUPPORTED,
		defaultGrantTypes: DEFAULTS,
	});
}

describe("CIMD metadata digest and consumer checks", () => {
	test("digest is identical for reordered or duplicated identical sets and differs when redirect_uris or grant_types change", () => {
		const base = metadataDigest([REDIRECT, OTHER_REDIRECT], ["authorization_code", "refresh_token"]);
		expect(base).toMatch(/^[0-9a-f]{64}$/);
		expect(
			metadataDigest([OTHER_REDIRECT, REDIRECT], ["refresh_token", "authorization_code"]),
		).toBe(base);
		expect(
			metadataDigest(
				[REDIRECT, REDIRECT, OTHER_REDIRECT],
				["authorization_code", "authorization_code", "refresh_token"],
			),
		).toBe(base);
		expect(metadataDigest([REDIRECT], ["authorization_code", "refresh_token"])).not.toBe(base);
		expect(
			metadataDigest(
				[REDIRECT, OTHER_REDIRECT, "https://grok.com/callback"],
				["authorization_code", "refresh_token"],
			),
		).not.toBe(base);
		expect(metadataDigest([REDIRECT, OTHER_REDIRECT], ["authorization_code"])).not.toBe(base);
	});

	test("absent grant_types defaults to authorization_code; empty, non-array, non-string or unsupported grant_types refuse the document as INVALID_DOCUMENT", async () => {
		const clock = { now: START };
		const absent = await resolverWith(scripted(() => ok(CLIENT)), clock).resolve(CLIENT);
		expect(absent).toMatchObject({ ok: true, client: { grantTypes: ["authorization_code"] } });
		const refused: unknown[] = [
			[],
			"authorization_code",
			null,
			{ 0: "authorization_code" },
			[1],
			["implicit"],
			["authorization_code", "password"],
		];
		for (const value of refused) {
			const resolver = resolverWith(scripted(() => ok(CLIENT, { grant_types: value })), clock);
			expect(await resolver.resolveFresh(CLIENT)).toEqual({
				ok: false,
				kind: "failed",
				code: "INVALID_DOCUMENT",
			});
		}
	});

	test("client_name: absent, null or blank gives MCP client; a non-string value or any C0 or DEL character, including one past character 120, refuses the document as INVALID_DOCUMENT; the name is sliced to 120 before it is trimmed, so 118 spaces followed by abc gives ab", async () => {
		const clock = { now: START };
		const named = (metadata: Record<string, unknown>) =>
			resolverWith(scripted(() => ok(CLIENT, metadata)), clock).resolve(CLIENT);
		expect(await named({})).toMatchObject({ ok: true, client: { name: "MCP client" } });
		expect(await named({ client_name: null })).toMatchObject({
			ok: true,
			client: { name: "MCP client" },
		});
		expect(await named({ client_name: "   " })).toMatchObject({
			ok: true,
			client: { name: "MCP client" },
		});
		const refused: unknown[] = [
			42,
			true,
			["Grok"],
			{ name: "Grok" },
			"bad\u0001name",
			"bad\u007fname",
			`${"a".repeat(130)}\u0007`,
		];
		for (const value of refused) {
			expect(await named({ client_name: value })).toEqual({
				ok: false,
				kind: "failed",
				code: "INVALID_DOCUMENT",
			});
		}
		expect(await named({ client_name: `${" ".repeat(118)}abc` })).toMatchObject({
			ok: true,
			client: { name: "ab" },
		});
	});

	test("client_name: an ASCII input of exactly 1024 characters (1024 UTF-16 code units) is accepted, and an ASCII input of 1025 characters refuses the document as INVALID_DOCUMENT (the DCR input cap, oauth.ts:67)", async () => {
		const clock = { now: START };
		const named = (metadata: Record<string, unknown>) =>
			resolverWith(scripted(() => ok(CLIENT, metadata)), clock).resolve(CLIENT);
		expect(await named({ client_name: "a".repeat(1024) })).toMatchObject({
			ok: true,
			client: { name: "a".repeat(120) },
		});
		expect(await named({ client_name: "a".repeat(1025) })).toEqual({
			ok: false,
			kind: "failed",
			code: "INVALID_DOCUMENT",
		});
	});
});

describe("CIMD cache policy", () => {
	const date = new Date(START).toUTCString();
	const at = (offsetMs: number) => new Date(START + offsetMs).toUTCString();
	const rows: Array<[string, OutboundCacheHeaders, number]> = [
		["no headers give the ceiling", {}, CIMD_CACHE_TTL_CEILING_MS],
		["max-age below the ceiling", { cacheControl: "max-age=60" }, 60_000],
		["max-age above the ceiling is capped", { cacheControl: "max-age=600" }, 300_000],
		["max-age minus Age", { cacheControl: "max-age=60", age: "10" }, 50_000],
		["Age above max-age clamps to zero", { cacheControl: "max-age=5", age: "10" }, 0],
		["no-store gives zero", { cacheControl: "no-store" }, 0],
		["no-cache gives zero", { cacheControl: "no-cache" }, 0],
		["max-age=0 gives zero", { cacheControl: "max-age=0" }, 0],
		["private is cacheable", { cacheControl: "private, max-age=30" }, 30_000],
		["a quoted max-age is read", { cacheControl: 'max-age="45"' }, 45_000],
		["a non-digit max-age gives zero", { cacheControl: "max-age=abc" }, 0],
		["a negative max-age gives zero", { cacheControl: "max-age=-1" }, 0],
		["a fractional max-age gives zero", { cacheControl: "max-age=1.5" }, 0],
		[
			"max-age wins over Expires",
			{ cacheControl: "max-age=60", date, expires: at(3_600_000) },
			60_000,
		],
		["Expires minus Date", { date, expires: at(120_000) }, 120_000],
		["Expires minus Date minus Age", { date, expires: at(120_000), age: "20" }, 100_000],
		["an invalid Expires gives zero", { expires: "not a date" }, 0],
		["Expires without Date uses now", { expires: at(40_000) }, 40_000],
		["an invalid Date falls back to now", { date: "garbage", expires: at(40_000) }, 40_000],
		["an Expires in the past gives zero", { date, expires: at(-5_000) }, 0],
	];

	test("cacheLifetimeMs table: max-age minus Age capped at the ceiling; no-store, no-cache and max-age=0 give 0; private is cacheable; invalid max-age or Expires give 0; Expires minus Date; no headers give the ceiling; max-age wins over Expires", () => {
		for (const [label, headers, expected] of rows) {
			expect([label, cacheLifetimeMs(headers, START, CIMD_CACHE_TTL_CEILING_MS)]).toEqual([
				label,
				expected,
			]);
		}
	});

	test("a max-age=N document is served from cache for N seconds and refetched after", async () => {
		const clock = { now: START };
		const probe = scripted(() => ok(CLIENT, {}, { cacheControl: "max-age=10" }));
		const resolver = resolverWith(probe, clock);
		await resolver.resolve(CLIENT);
		clock.now = START + 9_999;
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true });
		expect(probe.calls()).toBe(1);
		clock.now = START + 10_000;
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true });
		expect(probe.calls()).toBe(2);
	});

	test("DISABLED and a model refusal with refused.code INVALID_CLIENT_ID map to unknown; BUSY maps to busy; every other failure maps to failed", async () => {
		const clock = { now: START };
		const cases: Array<[CimdFetchResult, CimdResolution]> = [
			[
				{ ok: false, kind: "fetch", code: "DISABLED" },
				{ ok: false, kind: "unknown", code: "DISABLED" },
			],
			[
				{
					ok: false,
					kind: "model",
					refused: { field: "client_id", code: "INVALID_CLIENT_ID" },
				},
				{ ok: false, kind: "unknown", code: "INVALID_CLIENT_ID" },
			],
			[
				{ ok: false, kind: "fetch", code: "BUSY" },
				{ ok: false, kind: "busy", code: "BUSY" },
			],
			[
				{ ok: false, kind: "fetch", code: "TIMEOUT" },
				{ ok: false, kind: "failed", code: "TIMEOUT" },
			],
			[
				{ ok: false, kind: "fetch", code: "HTTP_STATUS" },
				{ ok: false, kind: "failed", code: "HTTP_STATUS" },
			],
			[
				{ ok: false, kind: "model", refused: { field: "document", code: "INVALID_JSON" } },
				{ ok: false, kind: "failed", code: "INVALID_JSON" },
			],
			[
				{
					ok: false,
					kind: "model",
					refused: { field: "redirect_uris", code: "INVALID_REDIRECT_URIS" },
				},
				{ ok: false, kind: "failed", code: "INVALID_REDIRECT_URIS" },
			],
		];
		for (const [result, expected] of cases) {
			const resolver = resolverWith(scripted(() => result), clock);
			expect(await resolver.resolve(CLIENT)).toEqual(expected);
		}
	});

	test("non-200 (HTTP_STATUS), invalid documents and every fetch failure are never cached; the next resolve calls the fetcher again", async () => {
		const clock = { now: START };
		const failing: CimdFetchResult[] = [
			{ ok: false, kind: "fetch", code: "HTTP_STATUS" },
			{ ok: false, kind: "fetch", code: "TIMEOUT" },
			{ ok: false, kind: "model", refused: { field: "document", code: "INVALID_JSON" } },
			// An invalid document is refused even with a positive max-age, so it is not cached.
			ok(CLIENT, { grant_types: [] }, { cacheControl: "max-age=300" }),
		];
		const valid = ok(CLIENT, {}, { cacheControl: "max-age=300" });
		const probe = queued([...failing.flatMap((result) => [result, result]), valid]);
		const resolver = resolverWith(probe, clock);
		for (let attempt = 0; attempt < failing.length * 2; attempt += 1) {
			expect((await resolver.resolve(CLIENT)).ok).toBe(false);
		}
		expect(probe.calls()).toBe(8);
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true });
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true });
		expect(probe.calls()).toBe(9);
	});

	test("the cache never holds more than 128 keys and evicts the oldest inserted key first", async () => {
		const clock = { now: START };
		const probe = scripted((raw) => ok(String(raw), {}, { cacheControl: "max-age=300" }));
		const resolver = resolverWith(probe, clock);
		const key = (index: number) => `https://client.example/${index}.json`;
		for (let index = 0; index < CIMD_CACHE_MAX_ENTRIES; index += 1) {
			await resolver.resolve(key(index));
		}
		expect(probe.calls()).toBe(CIMD_CACHE_MAX_ENTRIES);
		// A read does not move key 0 back in line: insertion order alone decides eviction.
		await resolver.resolve(key(0));
		expect(probe.calls()).toBe(CIMD_CACHE_MAX_ENTRIES);
		await resolver.resolve(key(CIMD_CACHE_MAX_ENTRIES));
		expect(probe.calls()).toBe(CIMD_CACHE_MAX_ENTRIES + 1);
		for (let index = 1; index <= CIMD_CACHE_MAX_ENTRIES; index += 1) {
			await resolver.resolve(key(index));
		}
		expect(probe.calls()).toBe(CIMD_CACHE_MAX_ENTRIES + 1);
		await resolver.resolve(key(0));
		expect(probe.calls()).toBe(CIMD_CACHE_MAX_ENTRIES + 2);
	});

	test("the cache key is the exact client_id string: https://host:443/x and https://host/x are separate entries", async () => {
		const clock = { now: START };
		const probe = scripted((raw) => ok(String(raw), {}, { cacheControl: "max-age=300" }));
		const resolver = resolverWith(probe, clock);
		await resolver.resolve("https://host:443/x");
		await resolver.resolve("https://host/x");
		expect(probe.calls()).toBe(2);
		await resolver.resolve("https://host:443/x");
		await resolver.resolve("https://host/x");
		expect(probe.calls()).toBe(2);
	});

	test("resolveFresh always calls the fetcher, even with a live cache entry; an ok result replaces the cache entry; a non-ok result leaves the existing entry unchanged", async () => {
		const clock = { now: START };
		const probe = queued([
			ok(CLIENT, { client_name: "First" }, { cacheControl: "max-age=100" }),
			ok(CLIENT, { client_name: "Second" }, { cacheControl: "max-age=100" }),
			{ ok: false, kind: "fetch", code: "HTTP_STATUS" },
			ok(CLIENT, { client_name: "Third" }, { cacheControl: "no-store" }),
			ok(CLIENT, { client_name: "Fourth" }, { cacheControl: "max-age=100" }),
		]);
		const resolver = resolverWith(probe, clock);
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true, client: { name: "First" } });
		expect(await resolver.resolveFresh(CLIENT)).toMatchObject({
			ok: true,
			client: { name: "Second" },
		});
		expect(probe.calls()).toBe(2);
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true, client: { name: "Second" } });
		expect(probe.calls()).toBe(2);
		expect(await resolver.resolveFresh(CLIENT)).toEqual({
			ok: false,
			kind: "failed",
			code: "HTTP_STATUS",
		});
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true, client: { name: "Second" } });
		expect(probe.calls()).toBe(3);
		// A fresh ok result with lifetime zero removes the entry, so the next resolve fetches.
		expect(await resolver.resolveFresh(CLIENT)).toMatchObject({
			ok: true,
			client: { name: "Third" },
		});
		expect(await resolver.resolve(CLIENT)).toMatchObject({ ok: true, client: { name: "Fourth" } });
		expect(probe.calls()).toBe(5);
	});
});
