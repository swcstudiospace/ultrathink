// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { randomHash } from "../../../src/test.helpers.ts";
import { loadConfig } from "../config/config.ts";
import { bunAtLeast } from "../security/mtls.ts";
import {
	createOutboundFetchGuard,
	type OutboundFetchDeps,
	type OutboundTransportEvents,
	type PinnedHttpsTarget,
} from "../security/outbound-fetch.ts";
import { type CimdFetchResult, createCimdFetcher } from "./cimd-fetch.ts";

const RAW = "https://CLIENT.example:443/meta.json";
const PUBLIC = "93.184.216.34";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback?state=fixture";
const METADATA = {
	client_id: RAW,
	redirect_uris: [REDIRECT],
	token_endpoint_auth_method: "none",
	client_name: "Untrusted tracer",
	jwks_uri: "https://127.0.0.1/never-fetch-this-key",
};
const TEXT = JSON.stringify(METADATA);
const bytes = new TextEncoder().encode(TEXT);
const encoder = new TextEncoder();
const POLICY = { timeoutMs: 5000, maxBytes: 5000, maxInflight: 4 };

function configured(flag?: string) {
	return loadConfig({
		ULTRATHINK_PUBLIC_ORIGIN: "https://service.example",
		ULTRATHINK_OWNER_PASSWORD_HASH: randomHash(),
		ULTRATHINK_SESSION_SECRET: "phase102-offline-session-secret-00000000000000000000",
		ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
		ULTRATHINK_CIMD: flag,
	});
}

async function pump(): Promise<void> {
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

class OfflineRequest {
	readonly completion = Promise.withResolvers<void>();
	readonly stopped = this.completion.promise;
	destroyed = false;
	stoppedWork = false;
	peerAccepted = false;
	headersAccepted = false;
	bodyReads = 0;
	delivered = 0;
	destroys = 0;
	constructor(
		readonly target: PinnedHttpsTarget,
		readonly events: OutboundTransportEvents,
		readonly autoStop: boolean,
	) {}
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.destroys++;
		if (this.autoStop) queueMicrotask(() => this.stop());
	}
	stop(): void {
		if (!this.destroyed) throw new Error("still active");
		this.stoppedWork = true;
		this.completion.resolve();
	}
	async peer(observed: string | undefined): Promise<boolean> {
		await Promise.resolve();
		if (this.destroyed) return false;
		this.peerAccepted = this.events.peer(observed);
		if (!this.peerAccepted) this.destroy();
		return this.peerAccepted;
	}
	headers(status = 200, headers: Parameters<OutboundTransportEvents["headers"]>[1] = {}): boolean {
		if (this.destroyed || !this.peerAccepted) return false;
		this.headersAccepted = this.events.headers(status, headers);
		if (!this.headersAccepted) this.destroy();
		return this.headersAccepted;
	}
	data(chunk: Uint8Array): void {
		if (this.destroyed || !this.headersAccepted) return;
		this.bodyReads++;
		this.delivered += chunk.byteLength;
		this.events.data(chunk);
	}
	end(): void {
		if (!this.destroyed && this.headersAccepted) this.events.end(true);
	}
}

class OfflinePrimitives {
	clock = 0;
	resolverStarts = 0;
	queries = 0;
	v6: readonly string[] = [];
	autoStop = true;
	readonly requests: OfflineRequest[] = [];
	readonly timers = new Set<{ run: () => void; at: number }>();
	readonly deps: OutboundFetchDeps = {
		runtimeVersion: () => "1.4.0",
		now: () => this.clock,
		schedule: (run, delay) => {
			const entry = { run, at: this.clock + delay };
			this.timers.add(entry);
			return () => {
				this.timers.delete(entry);
			};
		},
		createResolver: () => {
			this.resolverStarts++;
			return {
				resolve4: async () => {
					this.queries++;
					return [PUBLIC];
				},
				resolve6: async () => {
					this.queries++;
					return this.v6;
				},
				cancel: () => {
					throw new Error("settled DNS must not be canceled");
				},
			};
		},
		startRequest: (target, _signal, events) => {
			const request = new OfflineRequest(target, events, this.autoStop);
			this.requests.push(request);
			return request;
		},
	};
	request(index = 0): OfflineRequest {
		const request = this.requests[index];
		if (!request) throw new Error("missing real guarded transport start");
		return request;
	}
	advance(to: number): void {
		this.clock = to;
		for (const timer of [...this.timers]) {
			if (timer.at <= to && this.timers.delete(timer)) timer.run();
		}
	}
	async cleanup(): Promise<void> {
		for (const request of this.requests) {
			request.events.error("NETWORK_FAILURE");
			request.destroy();
			request.stop();
		}
		this.advance(this.clock + 5000);
		await pump();
		expect(this.timers.size).toBe(0);
		expect(this.requests.every((request) => request.stoppedWork)).toBe(true);
	}
}

function metadataText(overrides: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({ ...METADATA, ...overrides });
}

// Exact UTF-8 byte length: the padding is ASCII, so the empty-name text length is the fixed overhead.
function documentBytes(total: number): Uint8Array {
	const overhead = metadataText({ client_name: "" }).length;
	return encoder.encode(metadataText({ client_name: "a".repeat(total - overhead) }));
}

async function retrieve(
	chunks: readonly Uint8Array[],
	options: {
		readonly status?: number;
		readonly headers?: Readonly<Record<string, string | string[]>>;
		readonly origins?: ReadonlySet<string>;
	} = {},
): Promise<{ result: CimdFetchResult; memory: OfflinePrimitives }> {
	const memory = new OfflinePrimitives();
	const fetcher = createCimdFetcher(
		configured("1"),
		options.origins ?? new Set(["https://claude.ai"]),
		createOutboundFetchGuard(POLICY, memory.deps),
	);
	const pending = fetcher.fetch(RAW);
	await pump();
	const request = memory.request();
	expect(await request.peer(PUBLIC)).toBe(true);
	if (request.headers(options.status ?? 200, options.headers ?? {})) {
		for (const chunk of chunks) request.data(chunk);
		request.end();
	}
	const result = await pending;
	await memory.cleanup();
	return { result, memory };
}

describe("phase102 tracer", () => {
	test("loaded ON crosses actual guard and parser with exact raw443 identity and snapshotted origins", async () => {
		const memory = new OfflinePrimitives();
		const config = {
			...configured(" 1 "),
			fetch: () => {
				throw new Error("CONFIG-FETCH-CANARY");
			},
			resolver: () => {
				throw new Error("CONFIG-RESOLVER-CANARY");
			},
			transport: () => {
				throw new Error("CONFIG-TRANSPORT-CANARY");
			},
		};
		const trusted = new Set(["https://claude.ai"]);
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const fetcher = createCimdFetcher(config, trusted, guard);
		trusted.clear();
		config.cimdEnabled = false;
		const pending = fetcher.fetch(RAW);
		await pump();
		const request = memory.request();
		expect(request.target).toEqual({
			address: PUBLIC,
			family: 4,
			hostname: "client.example",
			authority: "CLIENT.example:443",
			port: 443,
			path: "/meta.json",
		});
		expect(await request.peer(PUBLIC)).toBe(true);
		expect(
			request.headers(200, {
				"content-length": String(bytes.byteLength),
				age: "2",
				"set-cookie": "COOKIE-CANARY",
			}),
		).toBe(true);
		request.data(bytes.subarray(0, 17));
		request.data(bytes.subarray(17));
		request.end();
		expect(await pending).toEqual({
			ok: true,
			document: {
				client_id: RAW,
				redirect_uris: [REDIRECT],
				token_endpoint_auth_method: "none",
				metadata: METADATA,
			},
			headers: { age: "2" },
		});
		expect(memory.resolverStarts).toBe(1);
		expect(memory.queries).toBe(2);
		expect(memory.requests).toHaveLength(1);
		expect(request.stoppedWork).toBe(true);
		await memory.cleanup();
	});

	test("loaded OFF is snapshotted and returns before throwing DNS/HTTP dependencies or model validation", async () => {
		let starts = 0;
		const impossible: OutboundFetchDeps = {
			createResolver: () => {
				starts++;
				throw new Error("OFF DNS CANARY");
			},
			startRequest: () => {
				starts++;
				throw new Error("OFF HTTP CANARY");
			},
			now: () => {
				starts++;
				throw new Error("OFF CLOCK CANARY");
			},
			schedule: () => {
				starts++;
				throw new Error("OFF TIMER CANARY");
			},
			runtimeVersion: () => {
				starts++;
				throw new Error("OFF RUNTIME CANARY");
			},
		};
		const config = configured();
		const fetcher = createCimdFetcher(
			config,
			new Set(),
			createOutboundFetchGuard(POLICY, impossible),
		);
		config.cimdEnabled = true;
		const controller = new AbortController();
		controller.abort("ABORT-RAW-CANARY");
		expect(
			await Promise.all([
				fetcher.fetch(RAW),
				fetcher.fetch(null),
				fetcher.fetch(RAW, controller.signal),
			]),
		).toEqual([
			{ ok: false, kind: "fetch", code: "DISABLED" },
			{ ok: false, kind: "fetch", code: "DISABLED" },
			{ ok: false, kind: "fetch", code: "DISABLED" },
		]);
		expect(starts).toBe(0);
	});

	test("invalid query is a model refusal before any guard primitive, and private AAAA refuses before transport", async () => {
		const memory = new OfflinePrimitives();
		const fetcher = createCimdFetcher(
			configured("1"),
			new Set(["https://claude.ai"]),
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		expect(await fetcher.fetch(`${RAW}?URL-SECRET-CANARY`)).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "client_id", code: "INVALID_CLIENT_ID" },
		});
		expect(memory.resolverStarts).toBe(0);
		memory.v6 = ["::ffff:7f00:1"];
		expect(await fetcher.fetch(RAW)).toEqual({ ok: false, kind: "fetch", code: "ADDRESS_REFUSED" });
		expect(memory.queries).toBe(2);
		expect(memory.requests).toHaveLength(0);
		expect(memory.timers.size).toBe(0);
	});

	for (const failure of ["peer", "network"] as const) {
		test(`actual asynchronous ${failure} refusal is a distinct fetch envelope and stopped-work lease`, async () => {
			const memory = new OfflinePrimitives();
			memory.autoStop = false;
			const fetcher = createCimdFetcher(
				configured("1"),
				new Set(["https://claude.ai"]),
				createOutboundFetchGuard(POLICY, memory.deps),
			);
			const held = [fetcher.fetch(RAW), fetcher.fetch(RAW), fetcher.fetch(RAW)];
			const pending = fetcher.fetch(RAW);
			await pump();
			const request = memory.request(3);
			if (failure === "peer") {
				expect(await request.peer("10.77.88.99")).toBe(false);
			} else {
				await Promise.resolve();
				request.events.error("NETWORK_FAILURE");
			}
			const expected = {
				ok: false,
				kind: "fetch",
				code: failure === "peer" ? "PIN_MISMATCH" : "NETWORK_FAILURE",
			} as const satisfies CimdFetchResult;
			expect(await pending).toEqual(expected);
			expect(request.bodyReads).toBe(0);
			expect(request.stoppedWork).toBe(false);
			request.events.error("NETWORK_FAILURE");
			request.events.data(new TextEncoder().encode("RAW-BODY-SECRET-CANARY"));
			request.events.end(true);
			expect(await pending).toEqual(expected);
			const before = [memory.resolverStarts, memory.queries, memory.requests.length];
			expect(await fetcher.fetch(RAW)).toEqual({ ok: false, kind: "fetch", code: "BUSY" });
			expect([memory.resolverStarts, memory.queries, memory.requests.length]).toEqual(before);
			request.stop();
			await pump();
			const replacement = fetcher.fetch(RAW);
			await pump();
			expect(memory.requests).toHaveLength(5);
			expect(await fetcher.fetch(RAW)).toEqual({ ok: false, kind: "fetch", code: "BUSY" });
			const next = memory.request(4);
			expect(await next.peer(PUBLIC)).toBe(true);
			expect(next.headers()).toBe(true);
			next.data(bytes);
			next.end();
			next.destroy();
			next.stop();
			expect((await replacement).ok).toBe(true);
			expect(request.destroys).toBe(1);
			await memory.cleanup();
			await Promise.all(held);
		});
	}

	for (const failure of ["redirect", "declared", "overflow", "stall"] as const) {
		test(`${failure} never yields a partial model or starts a secondary retrieval`, async () => {
			const memory = new OfflinePrimitives();
			const fetcher = createCimdFetcher(
				configured("1"),
				new Set(["https://claude.ai"]),
				createOutboundFetchGuard(POLICY, memory.deps),
			);
			const pending = fetcher.fetch(RAW);
			await pump();
			const request = memory.request();
			expect(await request.peer(PUBLIC)).toBe(true);
			if (failure === "redirect")
				request.headers(302, { location: "https://127.0.0.1/REDIRECT-CANARY" });
			else if (failure === "declared") request.headers(200, { "content-length": "5001" });
			else {
				request.headers();
				request.data(bytes);
				if (failure === "overflow") {
					for (let part = 0; part < 50 && !request.destroyed; part++)
						request.data(new Uint8Array(1000));
				} else memory.advance(5000);
			}
			expect(await pending).toEqual({
				ok: false,
				kind: "fetch",
				code:
					failure === "redirect"
						? "HTTP_STATUS"
						: failure === "stall"
							? "TIMEOUT"
							: "BODY_TOO_LARGE",
			});
			if (failure === "redirect" || failure === "declared") expect(request.bodyReads).toBe(0);
			if (failure === "overflow") expect(request.delivered).toBeLessThan(6001);
			expect(memory.requests).toHaveLength(1);
			expect(memory.queries).toBe(2);
			expect(request.destroyed).toBe(true);
			await memory.cleanup();
		});
	}

	test("complete empty text goes to the existing parser rather than a success fallback", async () => {
		const memory = new OfflinePrimitives();
		const fetcher = createCimdFetcher(
			configured("1"),
			new Set(),
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		const pending = fetcher.fetch(RAW);
		await pump();
		const request = memory.request();
		await request.peer(PUBLIC);
		request.headers();
		request.end();
		expect(await pending).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "document", code: "INVALID_JSON" },
		});
		await memory.cleanup();
	});

	test("default OFF remains inert; actual default ON refuses a literal loopback target before network on either runtime", async () => {
		expect(await createCimdFetcher(configured(), new Set()).fetch(RAW)).toEqual({
			ok: false,
			kind: "fetch",
			code: "DISABLED",
		});
		// The default guard takes Bun.version as its runtime input. A literal loopback target is refused before
		// any DNS or transport on an eligible runtime, and refused by the runtime floor on a legacy one.
		const expected = bunAtLeast(Bun.version, [1, 4, 0]) ? "ADDRESS_REFUSED" : "UNSUPPORTED_RUNTIME";
		expect(
			await createCimdFetcher(configured("1"), new Set()).fetch("https://127.0.0.1/meta.json"),
		).toEqual({ ok: false, kind: "fetch", code: expected });
	});
});

describe("phase102 boundaries — B11 adapter and model", () => {
	test("B11 each refused document field maps to its exact model refusal and never echoes the value", async () => {
		type RefusedCode = Extract<CimdFetchResult, { readonly kind: "model" }>["refused"]["code"];
		const cases: [Record<string, unknown>, string, RefusedCode][] = [
			[{ client_id: "https://client.example:443/meta.json" }, "client_id", "CLIENT_ID_MISMATCH"],
			[{ client_id: "https://CLIENT.example/meta.json" }, "client_id", "CLIENT_ID_MISMATCH"],
			[{ client_id: undefined }, "client_id", "INVALID_DOCUMENT"],
			[{ client_secret: "SECRET-CANARY" }, "client_secret", "FORBIDDEN_CREDENTIAL"],
			[{ client_secret_expires_at: 0 }, "client_secret", "FORBIDDEN_CREDENTIAL"],
			[
				{ token_endpoint_auth_method: "client_secret_basic" },
				"token_endpoint_auth_method",
				"UNSUPPORTED_AUTH_METHOD",
			],
			[
				{ token_endpoint_auth_method: undefined },
				"token_endpoint_auth_method",
				"UNSUPPORTED_AUTH_METHOD",
			],
			[
				{ jwks: { keys: [{ kty: "RSA", n: "AQAB", d: "PRIVATE-CANARY" }] } },
				"jwks",
				"FORBIDDEN_CREDENTIAL",
			],
			[{ jwks: { keys: [{ kty: "oct", k: "AAAA" }] } }, "jwks", "FORBIDDEN_CREDENTIAL"],
			[{ jwks: "not-a-set" }, "jwks", "INVALID_DOCUMENT"],
			[{ jwks: { keys: "no" } }, "jwks", "INVALID_DOCUMENT"],
			[{ jwks: { keys: [1] } }, "jwks", "INVALID_DOCUMENT"],
			[{ redirect_uris: ["http://127.0.0.1:8080/cb"] }, "redirect_uris", "INVALID_REDIRECT_URIS"],
			[{ redirect_uris: ["https://evil.example/cb"] }, "redirect_uris", "INVALID_REDIRECT_URIS"],
			[{ redirect_uris: [`${REDIRECT}#fragment`] }, "redirect_uris", "INVALID_REDIRECT_URIS"],
			[{ redirect_uris: ["https://u:p@claude.ai/cb"] }, "redirect_uris", "INVALID_REDIRECT_URIS"],
			[{ redirect_uris: [] }, "redirect_uris", "INVALID_REDIRECT_URIS"],
			[{ redirect_uris: [42] }, "redirect_uris", "INVALID_REDIRECT_URIS"],
			[
				{ redirect_uris: [`https://claude.ai/${"a".repeat(2048)}`] },
				"redirect_uris",
				"INVALID_REDIRECT_URIS",
			],
			[{ redirect_uris: undefined }, "redirect_uris", "INVALID_REDIRECT_URIS"],
		];
		for (const [overrides, field, code] of cases) {
			const { result, memory } = await retrieve([encoder.encode(metadataText(overrides))]);
			expect(result).toEqual({ ok: false, kind: "model", refused: { field, code } });
			expect(memory.requests).toHaveLength(1);
			expect(JSON.stringify(result)).not.toContain("CANARY");
		}
	});

	test("B11 inert metadata: a public inline JWKS, logo and jwks_uri are carried without any second retrieval", async () => {
		const { result, memory } = await retrieve([
			encoder.encode(
				metadataText({
					logo_uri: "https://127.0.0.1/logo.png",
					jwks: { keys: [{ kty: "RSA", n: "AQAB", e: "AQAB" }] },
				}),
			),
		]);
		expect(result).toMatchObject({
			ok: true,
			document: { metadata: { logo_uri: "https://127.0.0.1/logo.png" } },
		});
		expect(memory.requests).toHaveLength(1);
		expect(memory.queries).toBe(2);
	});

	test("B11 redirect origins are the caller's trusted snapshot: custom origins admit; default and empty sets refuse", async () => {
		const appDocument = encoder.encode(metadataText({ redirect_uris: ["https://app.example/cb"] }));
		expect(
			(await retrieve([appDocument], { origins: new Set(["https://app.example"]) })).result,
		).toMatchObject({ ok: true });
		expect((await retrieve([appDocument])).result).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "redirect_uris", code: "INVALID_REDIRECT_URIS" },
		});
		expect(
			(await retrieve([encoder.encode(metadataText())], { origins: new Set() })).result,
		).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "redirect_uris", code: "INVALID_REDIRECT_URIS" },
		});
	});

	test("B11 each fetch performs exactly one retrieval and no result is cached", async () => {
		const memory = new OfflinePrimitives();
		const fetcher = createCimdFetcher(
			configured("1"),
			new Set(["https://claude.ai"]),
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		for (let round = 1; round <= 2; round++) {
			const pending = fetcher.fetch(RAW);
			await pump();
			expect(memory.requests).toHaveLength(round);
			const request = memory.request(round - 1);
			expect(await request.peer(PUBLIC)).toBe(true);
			expect(request.headers()).toBe(true);
			request.data(bytes);
			request.end();
			expect(await pending).toMatchObject({ ok: true });
		}
		expect(memory.resolverStarts).toBe(2);
		expect(memory.queries).toBe(4);
		await memory.cleanup();
	});
});

describe("phase102 boundaries — B05 and B07 transport and body", () => {
	test("B07 documents of 4999 and 5000 bytes are admitted; 5001 bytes is a fetch overflow", async () => {
		for (const size of [4999, 5000]) {
			const body = documentBytes(size);
			expect(body.byteLength).toBe(size);
			const { result, memory } = await retrieve([body]);
			expect(result).toMatchObject({ ok: true });
			expect(memory.requests).toHaveLength(1);
		}
		expect((await retrieve([documentBytes(5001)])).result).toEqual({
			ok: false,
			kind: "fetch",
			code: "BODY_TOO_LARGE",
		});
	});

	test("B07 a complete valid document followed by excess bytes is a fetch overflow, never a parsed document", async () => {
		const { result } = await retrieve([documentBytes(4990), new Uint8Array(20).fill(32)]);
		expect(result).toEqual({ ok: false, kind: "fetch", code: "BODY_TOO_LARGE" });
	});

	test("B07 the cap counts UTF-8 bytes, not UTF-16 units", async () => {
		const text = metadataText({ client_name: "😀".repeat(1500) });
		expect(text.length).toBeLessThan(5000);
		expect(encoder.encode(text).byteLength).toBeGreaterThan(5000);
		expect((await retrieve([encoder.encode(text)])).result).toEqual({
			ok: false,
			kind: "fetch",
			code: "BODY_TOO_LARGE",
		});
	});

	test("B07 a split UTF-8 code point in a valid document decodes once from the complete bytes", async () => {
		const encoded = encoder.encode(metadataText({ client_name: "😀" }));
		const cut = encoded.indexOf(0xf0) + 2;
		const { result } = await retrieve([encoded.subarray(0, cut), encoded.subarray(cut)]);
		expect(result).toMatchObject({ ok: true, document: { metadata: { client_name: "😀" } } });
	});

	test("B07 invalid UTF-8 in a document is a fetch INVALID_RESPONSE, not a model refusal", async () => {
		const encoded = encoder.encode(metadataText({ client_name: "ab" }));
		encoded[encoded.indexOf(97)] = 0xff;
		expect((await retrieve([encoded])).result).toEqual({
			ok: false,
			kind: "fetch",
			code: "INVALID_RESPONSE",
		});
	});

	test("B07 null, truncated and empty bodies never yield a document", async () => {
		expect((await retrieve([encoder.encode("null")])).result).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "document", code: "INVALID_DOCUMENT" },
		});
		expect((await retrieve([encoder.encode(metadataText().slice(0, 40))])).result).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "document", code: "INVALID_JSON" },
		});
		expect((await retrieve([])).result).toEqual({
			ok: false,
			kind: "model",
			refused: { field: "document", code: "INVALID_JSON" },
		});
	});

	test("B05 non-200 status, gzip encoding and declared-length anomalies are fetch envelopes with no retrieval follow", async () => {
		const encoded = encoder.encode(metadataText());
		expect((await retrieve([], { status: 404 })).result).toEqual({
			ok: false,
			kind: "fetch",
			code: "HTTP_STATUS",
		});
		expect((await retrieve([encoded], { headers: { "content-encoding": "gzip" } })).result).toEqual(
			{ ok: false, kind: "fetch", code: "INVALID_RESPONSE" },
		);
		expect(
			(await retrieve([encoded], { headers: { "content-length": String(encoded.byteLength + 1) } }))
				.result,
		).toEqual({ ok: false, kind: "fetch", code: "INVALID_RESPONSE" });
		expect((await retrieve([encoded], { headers: { "content-length": "5001" } })).result).toEqual({
			ok: false,
			kind: "fetch",
			code: "BODY_TOO_LARGE",
		});
	});
});

describe("phase102 boundaries — B12 isolation and DI", () => {
	test("B12 concurrent OFF calls on a shared guard refuse without admission or mutation of the ON fetch", async () => {
		const memory = new OfflinePrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const origins = new Set(["https://claude.ai"]);
		const on = createCimdFetcher(configured("1"), origins, guard);
		const off = createCimdFetcher(configured(), origins, guard);
		const pending = on.fetch(RAW);
		await pump();
		const before = [memory.resolverStarts, memory.queries, memory.requests.length];
		expect(
			await Promise.all([off.fetch(RAW), off.fetch(null), off.fetch(RAW), off.fetch(RAW)]),
		).toEqual([
			{ ok: false, kind: "fetch", code: "DISABLED" },
			{ ok: false, kind: "fetch", code: "DISABLED" },
			{ ok: false, kind: "fetch", code: "DISABLED" },
			{ ok: false, kind: "fetch", code: "DISABLED" },
		]);
		expect([memory.resolverStarts, memory.queries, memory.requests.length]).toEqual(before);
		const request = memory.request();
		expect(await request.peer(PUBLIC)).toBe(true);
		expect(request.headers()).toBe(true);
		request.data(bytes);
		request.end();
		expect(await pending).toMatchObject({ ok: true });
		await memory.cleanup();
	});

	test("B12 explicit fake guards keep their admission isolated from each other", async () => {
		const first = new OfflinePrimitives();
		first.autoStop = false;
		const second = new OfflinePrimitives();
		const origins = new Set(["https://claude.ai"]);
		const fetchFirst = createCimdFetcher(
			configured("1"),
			origins,
			createOutboundFetchGuard(POLICY, first.deps),
		);
		const fetchSecond = createCimdFetcher(
			configured("1"),
			origins,
			createOutboundFetchGuard(POLICY, second.deps),
		);
		const held = [
			fetchFirst.fetch(RAW),
			fetchFirst.fetch(RAW),
			fetchFirst.fetch(RAW),
			fetchFirst.fetch(RAW),
		];
		await pump();
		expect(await fetchFirst.fetch(RAW)).toEqual({ ok: false, kind: "fetch", code: "BUSY" });
		const pending = fetchSecond.fetch(RAW);
		await pump();
		expect(second.requests).toHaveLength(1);
		const request = second.request();
		expect(await request.peer(PUBLIC)).toBe(true);
		expect(request.headers()).toBe(true);
		request.data(bytes);
		request.end();
		expect(await pending).toMatchObject({ ok: true });
		await second.cleanup();
		await first.cleanup();
		expect(await Promise.all(held)).toEqual(
			Array(4).fill({ ok: false, kind: "fetch", code: "NETWORK_FAILURE" }),
		);
	});

	test("B12 a config property named fetch, resolver or transport is never an executable dependency on the default path", async () => {
		const config = {
			...configured(),
			cimdEnabled: true,
			fetch: () => {
				throw new Error("CONFIG-FETCH-CANARY");
			},
			resolver: () => {
				throw new Error("CONFIG-RESOLVER-CANARY");
			},
			transport: () => {
				throw new Error("CONFIG-TRANSPORT-CANARY");
			},
		};
		const result = await createCimdFetcher(config, new Set()).fetch("https://127.0.0.1/meta.json");
		expect(result).toEqual({
			ok: false,
			kind: "fetch",
			code: bunAtLeast(Bun.version, [1, 4, 0]) ? "ADDRESS_REFUSED" : "UNSUPPORTED_RUNTIME",
		});
	});
});
