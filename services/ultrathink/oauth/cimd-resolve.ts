// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// CIMD resolution over one injected fetcher: a bounded in-process cache, the cache lifetime rules,
// the metadata digest and the consumer-side document checks. No I/O and no OAuth runtime state.

import { createHash } from "node:crypto";
import type { CimdFetcher, CimdFetchResult } from "./cimd-fetch.ts";
import type { CimdDocument, CimdFailureCode } from "./cimd.ts";
import type { OutboundCacheHeaders, OutboundFetchCode } from "../security/outbound-fetch.ts";

/** Engineering choice, accepted by the owner on 2026-10-31: the most any cached document lives. */
export const CIMD_CACHE_TTL_CEILING_MS = 300_000;
/** Engineering choice, accepted by the owner on 2026-10-31: the cache holds at most this many client ids. */
export const CIMD_CACHE_MAX_ENTRIES = 128;

const DEFAULT_CLIENT_NAME = "MCP client";
// Same limits as the DCR client_name field (oauth.ts MAX_CLIENT_NAME_INPUT_CHARS and MAX_NAME_CHARS).
const MAX_CLIENT_NAME_INPUT_CHARS = 1024;
const MAX_CLIENT_NAME_CHARS = 120;
/** No C0 control characters and no DEL, as the DCR text fields require. */
const NO_CONTROL = /^[^\x00-\x1f\x7f]*$/;
const DIGITS = /^\d+$/;

type CimdResolutionCode = "DISABLED" | CimdFailureCode | OutboundFetchCode;

export interface CimdClient {
	readonly clientId: string;
	readonly name: string;
	readonly redirectUris: readonly string[];
	readonly grantTypes: readonly string[];
	readonly metadataDigest: string;
}

export type CimdResolution =
	| { readonly ok: true; readonly client: CimdClient }
	| {
			readonly ok: false;
			readonly kind: "unknown" | "busy" | "failed";
			readonly code: CimdResolutionCode;
	  };

export interface CimdResolver {
	/** Serves a live cache entry, otherwise fetches. Only an ok result is cached. */
	resolve(clientId: string): Promise<CimdResolution>;
	/** Always fetches, never reads the cache. An ok result replaces the entry; a non-ok result leaves it. */
	resolveFresh(clientId: string): Promise<CimdResolution>;
}

export interface CimdResolverOptions {
	readonly fetcher: CimdFetcher;
	readonly now: () => number;
	readonly supportedGrants: readonly string[];
	readonly defaultGrantTypes: readonly string[];
	readonly maxEntries?: number;
	readonly ceilingMs?: number;
}

interface CacheEntry {
	readonly client: CimdClient;
	readonly expiresAt: number;
}

/**
 * SHA-256 hex over the sorted, de-duplicated redirect_uris and grant_types. Reordering or
 * duplicating a set is not drift (owner decision, 2026-10-31); changing a member is.
 */
export function metadataDigest(
	redirectUris: readonly string[],
	grantTypes: readonly string[],
): string {
	const canonical = JSON.stringify({
		grant_types: [...new Set(grantTypes)].sort(),
		redirect_uris: [...new Set(redirectUris)].sort(),
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * How long a document may be served from cache, in milliseconds, clamped to [0, ceilingMs].
 * Engineering choice (owner, 2026-10-31), not quoted from the pinned draft. `private` is cacheable
 * because this cache is private to the process. An invalid Age counts as 0. Ambiguous headers
 * (repeated Expires, Date or Age) give 0.
 */
export function cacheLifetimeMs(
	headers: OutboundCacheHeaders,
	nowMs: number,
	ceilingMs: number,
): number {
	if (headers.ambiguous === true) return 0;
	const directives = parseCacheControl(headers.cacheControl);
	if (directives.has("no-store") || directives.has("no-cache")) return 0;
	const ageMs = digitsOrZero(headers.age) * 1000;
	const maxAge = directives.get("max-age");
	let lifetime: number;
	if (maxAge !== undefined) {
		if (!DIGITS.test(maxAge)) return 0;
		lifetime = Number(maxAge) * 1000 - ageMs;
	} else if (headers.expires !== undefined) {
		const expires = Date.parse(headers.expires);
		if (Number.isNaN(expires)) return 0;
		const date = headers.date === undefined ? Number.NaN : Date.parse(headers.date);
		const reference = Number.isNaN(date) ? nowMs : date;
		lifetime = expires - reference - ageMs;
	} else {
		lifetime = ceilingMs;
	}
	return Math.min(Math.max(lifetime, 0), ceilingMs);
}

function parseCacheControl(raw: string | undefined): Map<string, string> {
	const directives = new Map<string, string>();
	if (raw === undefined) return directives;
	for (const part of raw.split(",")) {
		const [name = "", ...value] = part.split("=");
		const key = name.trim().toLowerCase();
		if (key === "") continue;
		directives.set(key, value.join("=").trim().replace(/^"|"$/g, "").toLowerCase());
	}
	return directives;
}

function digitsOrZero(value: string | undefined): number {
	const text = value?.trim() ?? "";
	return DIGITS.test(text) ? Number(text) : 0;
}

/** The DCR client_name rule (oauth.ts registration), applied to a document's untyped metadata. */
function clientName(input: unknown): string | null {
	const value = input ?? "";
	if (typeof value !== "string") return null;
	if (value.length > MAX_CLIENT_NAME_INPUT_CHARS || !NO_CONTROL.test(value)) return null;
	const trimmed = value.slice(0, MAX_CLIENT_NAME_CHARS).trim();
	return trimmed === "" ? DEFAULT_CLIENT_NAME : trimmed;
}

function grantTypesOf(
	input: unknown,
	supported: readonly string[],
	defaults: readonly string[],
): string[] | null {
	if (input === undefined) return [...defaults];
	if (!Array.isArray(input) || input.length === 0) return null;
	const grants: string[] = [];
	for (const grant of input) {
		if (typeof grant !== "string" || !supported.includes(grant)) return null;
		grants.push(grant);
	}
	return grants;
}

function clientFrom(
	clientId: string,
	document: CimdDocument,
	supported: readonly string[],
	defaults: readonly string[],
): CimdClient | null {
	const name = clientName(document.metadata.client_name);
	const grantTypes = grantTypesOf(document.metadata.grant_types, supported, defaults);
	if (name === null || grantTypes === null) return null;
	const redirectUris = [...document.redirect_uris];
	return {
		clientId,
		name,
		redirectUris,
		grantTypes,
		metadataDigest: metadataDigest(redirectUris, grantTypes),
	};
}

function failure(result: Exclude<CimdFetchResult, { readonly ok: true }>): CimdResolution {
	if (result.kind === "model") {
		const code = result.refused.code;
		return code === "INVALID_CLIENT_ID"
			? { ok: false, kind: "unknown", code }
			: { ok: false, kind: "failed", code };
	}
	if (result.code === "DISABLED") return { ok: false, kind: "unknown", code: "DISABLED" };
	if (result.code === "BUSY") return { ok: false, kind: "busy", code: "BUSY" };
	return { ok: false, kind: "failed", code: result.code };
}

export function createCimdResolver(options: CimdResolverOptions): CimdResolver {
	const { fetcher, now, supportedGrants, defaultGrantTypes } = options;
	const maxEntries = options.maxEntries ?? CIMD_CACHE_MAX_ENTRIES;
	const ceilingMs = options.ceilingMs ?? CIMD_CACHE_TTL_CEILING_MS;
	const cache = new Map<string, CacheEntry>();
	// At most one fetch per id runs. One more may wait behind it. A waiting fetch has not started, so every
	// caller that joins it still gets a result from a fetch that began after the call.
	const inflight = new Map<string, Promise<CimdResolution>>();
	const waiting = new Map<string, Promise<CimdResolution>>();
	const running = new Map<string, Promise<CimdResolution>>();

	// Insert order decides eviction. Reads never reorder the map.
	function remember(
		clientId: string,
		client: CimdClient,
		lifetime: number,
		receivedAt: number,
	): void {
		cache.delete(clientId);
		if (lifetime <= 0) return;
		while (cache.size >= maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		cache.set(clientId, { client, expiresAt: receivedAt + lifetime });
	}

	async function fetchAndStore(clientId: string): Promise<CimdResolution> {
		const result = await fetcher.fetch(clientId);
		if (!result.ok) return failure(result);
		const receivedAt = now();
		const client = clientFrom(clientId, result.document, supportedGrants, defaultGrantTypes);
		if (client === null) return { ok: false, kind: "failed", code: "INVALID_DOCUMENT" };
		const lifetime = cacheLifetimeMs(result.headers, receivedAt, ceilingMs);
		remember(clientId, client, lifetime, receivedAt);
		return { ok: true, client };
	}

	// The earlier outcome is ignored: the later fetch decides what the cache holds.
	function startFetch(clientId: string): Promise<CimdResolution> {
		const queued = waiting.get(clientId);
		if (queued !== undefined) return queued;
		const previous = inflight.get(clientId);
		const ready = Promise.resolve(previous).catch(() => undefined);
		const pending: Promise<CimdResolution> = ready.then(async () => {
			if (waiting.get(clientId) === pending) waiting.delete(clientId);
			running.set(clientId, pending);
			try {
				return await fetchAndStore(clientId);
			} finally {
				if (running.get(clientId) === pending) running.delete(clientId);
				if (inflight.get(clientId) === pending) inflight.delete(clientId);
			}
		});
		inflight.set(clientId, pending);
		if (previous === undefined) running.set(clientId, pending);
		else waiting.set(clientId, pending);
		return pending;
	}

	return {
		async resolve(clientId) {
			const entry = cache.get(clientId);
			if (entry !== undefined) {
				if (now() < entry.expiresAt) return { ok: true, client: entry.client };
				cache.delete(clientId);
			}
			return running.get(clientId) ?? waiting.get(clientId) ?? startFetch(clientId);
		},
		resolveFresh(clientId) {
			return startFetch(clientId);
		},
	};
}
