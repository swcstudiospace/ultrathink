// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	createOutboundFetchGuard,
	type GuardedFetch,
	type OutboundFetchCode,
	type OutboundFetchDeps,
	type OutboundFetchResult,
	type OutboundTransportEvents,
	type PinnedHttpsTarget,
} from "./outbound-fetch.ts";

const POLICY = { timeoutMs: 5000, maxBytes: 5000, maxInflight: 4 };
const URL_ID = "https://client.example:443/meta.json";
const PUBLIC = "93.184.216.34";
const PUBLIC_V6 = "2606:4700:4700::1111";
const encoder = new TextEncoder();

async function pump(): Promise<void> {
	// Finite microtask drain, never a polling loop or a real-time/network wait.
	for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

class MemoryRequest {
	readonly completion = Promise.withResolvers<void>();
	readonly stopped = this.completion.promise;
	destroyed = false;
	stoppedWork = false;
	destroyCalls = 0;
	peerAllowed = false;
	headersAllowed = false;
	bodyReads = 0;
	deliveredBytes = 0;
	readonly abort: () => void;
	constructor(
		readonly target: PinnedHttpsTarget,
		readonly signal: AbortSignal,
		readonly events: OutboundTransportEvents,
		readonly automaticStop: boolean,
	) {
		this.abort = () => this.destroy();
		signal.addEventListener("abort", this.abort, { once: true });
	}
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.destroyCalls++;
		if (this.automaticStop) queueMicrotask(() => this.confirmStop());
	}
	confirmStop(): void {
		if (!this.destroyed) throw new Error("cannot confirm live work stopped");
		if (this.stoppedWork) return;
		this.stoppedWork = true;
		this.signal.removeEventListener("abort", this.abort);
		this.completion.resolve();
	}
	async observe(address: string | undefined): Promise<boolean> {
		await Promise.resolve();
		if (this.destroyed) return false;
		// Report independently chosen observation; never compute/echo the expected comparison.
		this.peerAllowed = this.events.peer(address);
		if (!this.peerAllowed) this.destroy();
		return this.peerAllowed;
	}
	headers(status = 200, values: Parameters<OutboundTransportEvents["headers"]>[1] = {}): boolean {
		if (this.destroyed || !this.peerAllowed) return false;
		this.headersAllowed = this.events.headers(status, values);
		if (!this.headersAllowed) this.destroy();
		return this.headersAllowed;
	}
	chunk(bytes: Uint8Array): void {
		if (this.destroyed || !this.headersAllowed) return;
		this.bodyReads++;
		this.deliveredBytes += bytes.byteLength;
		this.events.data(bytes);
	}
	end(complete = true): void {
		if (!this.destroyed && this.headersAllowed) this.events.end(complete);
	}
}

class MemoryPrimitives {
	clock = 0;
	version = "1.4.0";
	resolverStarts = 0;
	queries = 0;
	cancels = 0;
	v4: readonly string[] = [PUBLIC];
	v6: readonly string[] = [];
	v4Error: unknown = undefined;
	v6Error: unknown = undefined;
	v4Gate: Promise<void> | undefined = undefined;
	v6Gate: Promise<void> | undefined = undefined;
	holdDns = false;
	automaticStop = true;
	readonly requests: MemoryRequest[] = [];
	readonly timers = new Set<{ at: number; run: () => void }>();
	readonly pendingDns: { resolver: number; complete: () => void }[] = [];
	readonly deps: OutboundFetchDeps = {
		runtimeVersion: () => this.version,
		now: () => this.clock,
		schedule: (run, delay) => {
			const timer = { at: this.clock + delay, run };
			this.timers.add(timer);
			return () => {
				this.timers.delete(timer);
			};
		},
		createResolver: () => {
			this.resolverStarts++;
			const resolverId = this.resolverStarts;
			const pending: (() => void)[] = [];
			const answer = (
				values: readonly string[],
				error: unknown,
				gate: Promise<void> | undefined,
			) => {
				this.queries++;
				if (gate === undefined && error !== undefined) return Promise.reject(error);
				if (gate === undefined && !this.holdDns) return Promise.resolve(values);
				const deferred = Promise.withResolvers<readonly string[]>();
				pending.push(() => deferred.reject({ code: "ECANCELLED", detail: "DNS-RAW-CANARY" }));
				const settle = () => {
					if (error !== undefined) deferred.reject(error);
					else deferred.resolve(values);
				};
				if (gate === undefined) this.pendingDns.push({ resolver: resolverId, complete: settle });
				else void gate.then(settle);
				return deferred.promise;
			};
			return {
				resolve4: () => answer(this.v4, this.v4Error, this.v4Gate),
				resolve6: () => answer(this.v6, this.v6Error, this.v6Gate),
				cancel: () => {
					this.cancels++;
					for (const cancel of pending) cancel();
				},
			};
		},
		startRequest: (target, signal, events) => {
			const request = new MemoryRequest(target, signal, events, this.automaticStop);
			this.requests.push(request);
			return request;
		},
	};
	request(index = 0): MemoryRequest {
		const request = this.requests[index];
		if (!request) throw new Error("expected admitted transport");
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
			request.confirmStop();
		}
		this.advance(this.clock + 5000);
		await pump();
		expect(this.timers.size).toBe(0);
		expect(this.requests.every((request) => request.stoppedWork)).toBe(true);
	}
}

async function openPeer(memory: MemoryPrimitives, guard: GuardedFetch, signal?: AbortSignal) {
	const pending = guard(URL_ID, signal);
	await pump();
	const request = memory.request();
	expect(await request.observe(PUBLIC)).toBe(true);
	return { pending, request };
}

async function openBody(memory: MemoryPrimitives, guard: GuardedFetch, signal?: AbortSignal) {
	const opened = await openPeer(memory, guard, signal);
	expect(opened.request.headers()).toBe(true);
	return opened;
}

async function deliver(
	options: {
		readonly chunks?: readonly Uint8Array[];
		readonly headers?: Readonly<Record<string, string | string[]>>;
		readonly status?: number;
		readonly complete?: boolean;
	} = {},
): Promise<{ result: OutboundFetchResult; request: MemoryRequest; memory: MemoryPrimitives }> {
	const memory = new MemoryPrimitives();
	const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
	await pump();
	const request = memory.request();
	expect(await request.observe(PUBLIC)).toBe(true);
	if (request.headers(options.status ?? 200, options.headers ?? {})) {
		for (const chunk of options.chunks ?? []) request.chunk(chunk);
		request.end(options.complete ?? true);
	}
	const result = await pending;
	await memory.cleanup();
	return { result, request, memory };
}

describe("phase102 tracer", () => {
	test("equal and mapped-equivalent observed public peers deliver complete bytes after stop", async () => {
		for (const observed of [PUBLIC, "::ffff:5db8:d822"]) {
			const memory = new MemoryPrimitives();
			const guard = createOutboundFetchGuard(POLICY, memory.deps);
			const pending = guard(URL_ID);
			await pump();
			const request = memory.request();
			expect(request.target).toEqual({
				address: PUBLIC,
				family: 4,
				hostname: "client.example",
				authority: "client.example:443",
				port: 443,
				path: "/meta.json",
			});
			expect(await request.observe(observed)).toBe(true);
			expect(
				request.headers(200, {
					"content-length": "0005",
					"cache-control": "max-age=30",
					location: "https://private.invalid/",
				}),
			).toBe(true);
			const bytes = encoder.encode("hello");
			request.chunk(bytes);
			bytes.fill(120);
			request.end();
			expect(await pending).toEqual({
				ok: true,
				text: "hello",
				headers: { cacheControl: "max-age=30" },
			});
			expect(memory.queries).toBe(2);
			expect(memory.requests).toHaveLength(1);
			expect(request.stoppedWork).toBe(true);
			expect(request.destroyCalls).toBe(1);
			await memory.cleanup();
		}
	});

	test("amended nonusable numeric targets refuse while native public IPv6 remains usable", async () => {
		const memory = new MemoryPrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		for (const target of [
			"https://0/meta",
			"https://224.0.0.1/meta",
			"https://255.255.255.255/meta",
			"https://[::]/meta",
			"https://[::8.8.8.8]/meta",
			"https://[ff02::1]/meta",
			"https://[::ffff:0.0.0.1]/meta",
		]) {
			expect(await guard(target)).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		}
		expect(memory.resolverStarts).toBe(0);
		expect(memory.requests).toHaveLength(0);
		const pending = guard("https://[2606:4700:4700::1111]/meta");
		const request = memory.request();
		expect(await request.observe("2606:4700:4700:0:0:0:0:1111")).toBe(true);
		expect(request.headers()).toBe(true);
		request.chunk(encoder.encode("ok"));
		request.end();
		expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
		expect(memory.resolverStarts).toBe(0);
		await memory.cleanup();
	});

	test("synchronous failure before handle return cannot release around owned work", async () => {
		const memory = new MemoryPrimitives();
		memory.automaticStop = false;
		const deps: OutboundFetchDeps = {
			...memory.deps,
			startRequest: (target, signal, events) => {
				const request = new MemoryRequest(target, signal, events, false);
				memory.requests.push(request);
				events.error("NETWORK_FAILURE");
				return request;
			},
		};
		const guard = createOutboundFetchGuard(POLICY, deps);
		const pending = Array.from({ length: 4 }, () => guard(URL_ID));
		await pump();
		expect(await Promise.all(pending)).toEqual(
			Array(4).fill({ ok: false, code: "NETWORK_FAILURE" }),
		);
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
		expect(memory.requests).toHaveLength(4);
		expect(memory.requests.every((request) => request.destroyed && !request.stoppedWork)).toBe(
			true,
		);
		memory.request().confirmStop();
		await pump();
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "NETWORK_FAILURE" });
		expect(memory.requests).toHaveLength(5);
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
		expect(memory.requests.every((request) => request.destroyCalls === 1)).toBe(true);
		await memory.cleanup();
	});

	test("all families are examined and a private answer prevents any HTTPS start", async () => {
		const memory = new MemoryPrimitives();
		memory.v6 = ["::1"];
		const result = await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		expect(result).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		expect(memory.queries).toBe(2);
		expect(memory.requests).toHaveLength(0);
		expect(memory.timers.size).toBe(0);
	});

	for (const stimulus of ["peer", "network", "redirect", "declared", "overflow"] as const) {
		test(`${stimulus} refusal holds its lease until owned stop, preserves its code and admits one replacement`, async () => {
			const memory = new MemoryPrimitives();
			memory.automaticStop = false;
			const guard = createOutboundFetchGuard(POLICY, memory.deps);
			const held = [guard(URL_ID), guard(URL_ID), guard(URL_ID)];
			const pending = guard(URL_ID);
			await pump();
			expect(memory.requests).toHaveLength(4);
			const request = memory.request(3);
			let code: OutboundFetchCode;
			if (stimulus === "peer") {
				code = "PIN_MISMATCH";
				expect(await request.observe("10.12.34.56")).toBe(false);
			} else if (stimulus === "network") {
				code = "NETWORK_FAILURE";
				request.events.error("NETWORK_FAILURE");
			} else {
				expect(await request.observe(PUBLIC)).toBe(true);
				if (stimulus === "redirect") {
					code = "HTTP_STATUS";
					expect(request.headers(302, { location: "https://127.0.0.1/URL-CANARY" })).toBe(false);
				} else if (stimulus === "declared") {
					code = "BODY_TOO_LARGE";
					expect(request.headers(200, { "content-length": "5001" })).toBe(false);
				} else {
					code = "BODY_TOO_LARGE";
					expect(request.headers()).toBe(true);
					// Lazy producer: the remaining planned 20,000 bytes are never requested.
					for (let part = 0; part < 25 && !request.destroyed; part++) {
						request.chunk(new Uint8Array(part === 5 ? 1 : 1000).fill(65));
					}
					expect(request.deliveredBytes).toBe(5001);
					expect(request.bodyReads).toBe(6);
				}
			}
			const refusal = { ok: false, code } satisfies OutboundFetchResult;
			expect(await pending).toEqual(refusal);
			expect(request.destroyed).toBe(true);
			expect(request.stoppedWork).toBe(false);
			if (stimulus !== "overflow") expect(request.bodyReads).toBe(0);
			// Deliberately adversarial late native callbacks cannot leak or overwrite the decision.
			request.events.error("NETWORK_FAILURE");
			request.events.peer("RAW-ADDRESS-CANARY");
			request.events.data(encoder.encode("BODY-SECRET-CANARY"));
			request.events.end(true);
			expect(await pending).toEqual(refusal);
			const before = [memory.resolverStarts, memory.queries, memory.requests.length];
			expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
			expect([memory.resolverStarts, memory.queries, memory.requests.length]).toEqual(before);
			request.confirmStop();
			await pump();
			const replacement = guard(URL_ID);
			await pump();
			expect(memory.requests).toHaveLength(5);
			expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
			const next = memory.request(4);
			expect(await next.observe(PUBLIC)).toBe(true);
			expect(next.headers()).toBe(true);
			next.chunk(encoder.encode("ok"));
			next.end();
			let committed = false;
			void replacement.then(() => {
				committed = true;
			});
			await pump();
			expect(committed).toBe(false);
			next.confirmStop();
			expect(await replacement).toEqual({ ok: true, text: "ok", headers: {} });
			expect(request.destroyCalls).toBe(1);
			await memory.cleanup();
			await Promise.all(held);
		});
	}

	test("one deadline times out stalled bytes and holds capacity until physical stop", async () => {
		const memory = new MemoryPrimitives();
		memory.automaticStop = false;
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const pending = guard(URL_ID);
		await pump();
		const request = memory.request();
		expect(await request.observe(PUBLIC)).toBe(true);
		expect(request.headers()).toBe(true);
		request.chunk(new Uint8Array(5000));
		memory.advance(100);
		const held = [guard(URL_ID), guard(URL_ID), guard(URL_ID)];
		await pump();
		memory.advance(5000);
		expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
		expect(memory.requests).toHaveLength(4);
		request.events.end(true);
		request.confirmStop();
		await pump();
		const replacement = guard(URL_ID);
		await pump();
		expect(memory.requests).toHaveLength(5);
		await memory.cleanup();
		await Promise.all([...held, replacement]);
	});

	test("never-answering owned DNS is canceled with no late dial and the slots recover", async () => {
		const memory = new MemoryPrimitives();
		memory.holdDns = true;
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const pending = Array.from({ length: 4 }, () => guard(URL_ID));
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
		expect(memory.resolverStarts).toBe(4);
		expect(memory.queries).toBe(8);
		memory.advance(5000);
		expect(await Promise.all(pending)).toEqual(Array(4).fill({ ok: false, code: "TIMEOUT" }));
		expect(memory.cancels).toBe(4);
		for (const entry of memory.pendingDns) entry.complete();
		await pump();
		expect(memory.requests).toHaveLength(0);
		memory.holdDns = false;
		const replacement = guard(URL_ID);
		await pump();
		expect(memory.resolverStarts).toBe(5);
		expect(memory.requests).toHaveLength(1);
		await memory.cleanup();
		await replacement;
	});

	test("exact 5000 split UTF8 bytes succeed only on complete end and confirmed stop", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		expect(await request.observe(PUBLIC)).toBe(true);
		expect(request.headers(200, { "content-length": "5000" })).toBe(true);
		const bytes = encoder.encode(`${"a".repeat(4996)}😀`);
		request.chunk(bytes.subarray(0, 4998));
		request.chunk(bytes.subarray(4998));
		request.end();
		expect(await pending).toEqual({ ok: true, text: `${"a".repeat(4996)}😀`, headers: {} });
		expect(request.stoppedWork).toBe(true);
		await memory.cleanup();
	});

	test("a callback after expiration cannot beat a delayed timer, and early end is not complete", async () => {
		for (const expired of [false, true]) {
			const memory = new MemoryPrimitives();
			const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
			await pump();
			const request = memory.request();
			expect(await request.observe(PUBLIC)).toBe(true);
			request.headers();
			request.chunk(encoder.encode("prefix"));
			if (expired) memory.clock = 5000; // Timer deliberately not dispatched.
			request.end(!!expired);
			expect(await pending).toEqual({ ok: false, code: expired ? "TIMEOUT" : "INVALID_RESPONSE" });
			await memory.cleanup();
		}
	});

	test("unknown and legacy dependency runtimes refuse before admission or primitives", async () => {
		for (const version of ["unknown", "1.2.23"]) {
			const memory = new MemoryPrimitives();
			memory.version = version;
			expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID)).toEqual({
				ok: false,
				code: "UNSUPPORTED_RUNTIME",
			});
			expect(memory.resolverStarts).toBe(0);
			expect(memory.requests).toHaveLength(0);
			expect(memory.timers.size).toBe(0);
		}
	});
});

describe("phase102 boundaries — B01 address policy", () => {
	test("B01 IPv4 prefix first and last members refuse; adjacent public members are classified on their own", async () => {
		const memory = new MemoryPrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const refused = [
			"0.0.0.0",
			"0.255.255.255",
			"10.0.0.0",
			"10.255.255.255",
			"127.0.0.0",
			"127.255.255.255",
			"172.16.0.0",
			"172.31.255.255",
			"192.168.0.0",
			"192.168.255.255",
			"169.254.0.0",
			"169.254.255.255",
			"100.64.0.0",
			"100.127.255.255",
			"224.0.0.0",
			"239.255.255.255",
			"240.0.0.0",
			"255.255.255.255",
		];
		for (const ip of refused)
			expect(await guard(`https://${ip}/meta`)).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		expect(memory.resolverStarts).toBe(0);
		expect(memory.requests).toHaveLength(0);
		const adjacent = [
			"1.0.0.0",
			"9.255.255.255",
			"11.0.0.0",
			"126.255.255.255",
			"128.0.0.0",
			"172.15.255.255",
			"172.32.0.0",
			"192.167.255.255",
			"192.169.0.0",
			"169.253.255.255",
			"169.255.0.0",
			"100.63.255.255",
			"100.128.0.0",
			"223.255.255.255",
		];
		for (const ip of adjacent) {
			const pending = guard(`https://${ip}/meta`);
			const request = memory.request(memory.requests.length - 1);
			expect(request.target.address).toBe(ip);
			expect(await request.observe(ip)).toBe(true);
			expect(request.headers()).toBe(true);
			request.chunk(encoder.encode("ok"));
			request.end();
			expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
		}
		expect(memory.requests).toHaveLength(adjacent.length);
		await memory.cleanup();
	});

	test("B01 IPv6 ::1, ::/96, fc00::/7, fe80::/10 and ff00::/8 boundaries refuse; adjacent nonmembers proceed", async () => {
		const memory = new MemoryPrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const refused = [
			"::",
			"::1",
			"::ffff:ffff",
			"fc00::",
			"fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			"fe80::",
			"febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			"ff00::",
			"ff02::1",
			"ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		];
		for (const ip of refused)
			expect(await guard(`https://[${ip}]/meta`)).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		expect(memory.resolverStarts).toBe(0);
		expect(memory.requests).toHaveLength(0);
		const adjacent = [
			"::1:0:0",
			"fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			"fe00::1",
			"fec0::1",
			PUBLIC_V6,
		];
		for (const ip of adjacent) {
			const pending = guard(`https://[${ip}]/meta`);
			const request = memory.request(memory.requests.length - 1);
			expect(await request.observe(ip)).toBe(true);
			expect(request.headers()).toBe(true);
			request.chunk(encoder.encode("ok"));
			request.end();
			expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
		}
		expect(memory.requests).toHaveLength(adjacent.length);
		await memory.cleanup();
	});
});

describe("phase102 boundaries — B02 encodings and parsed literals", () => {
	test("B02 compressed, expanded, uppercase, dotted-mapped and hex-mapped denied forms refuse identically", async () => {
		const memory = new MemoryPrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const refused = [
			"https://[FE80:0:0:0:0:0:0:1]/m",
			"https://[fe80::1]/m",
			"https://[::FFFF:127.0.0.1]/m",
			"https://[::ffff:7f00:1]/m",
			"https://[0:0:0:0:0:ffff:0a00:0001]/m",
			"https://[::ffff:AC10:0001]/m",
			"https://[::ffff:c0a8:101]/m",
			"https://[::ffff:a9fe:a9fe]/m",
			"https://[::ffff:6440:1]/m",
			"https://[::ffff:0.0.0.0]/m",
			"https://[::127.0.0.1]/m",
		];
		for (const target of refused)
			expect(await guard(target)).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		expect(memory.resolverStarts).toBe(0);
		expect(memory.requests).toHaveLength(0);
	});

	test("B02 WHATWG-repaired numeric IPv4 literals classify numerically; public controls in every spelling are usable", async () => {
		const memory = new MemoryPrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		for (const target of [
			"https://0x7f.1/m",
			"https://2130706433/m",
			"https://0177.0.0.1/m",
			"https://127.1/m",
		]) {
			expect(await guard(target)).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		}
		const controls: [string, string, string][] = [
			["https://[::ffff:5db8:d822]/m", "::ffff:5db8:d822", PUBLIC],
			["https://1572395042/m", PUBLIC, PUBLIC],
			["https://0x5db8d822/m", PUBLIC, PUBLIC],
			["https://[2606:4700:4700:0000:0000:0000:0000:1111]/m", PUBLIC_V6, PUBLIC_V6],
		];
		for (const [target, address, observed] of controls) {
			const pending = guard(target);
			const request = memory.request(memory.requests.length - 1);
			expect(request.target.address).toBe(address);
			expect(await request.observe(observed)).toBe(true);
			expect(request.headers()).toBe(true);
			request.chunk(encoder.encode("ok"));
			request.end();
			expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
		}
		expect(memory.resolverStarts).toBe(0);
		await memory.cleanup();
	});

	test("B02 malformed targets, zone identifiers, userinfo and fragments refuse before any resolver", async () => {
		const memory = new MemoryPrimitives();
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const malformed: string[] = [
			"https://[fe80::1%25eth0]/m",
			"https://[fe80::1%eth0]/m",
			"https://[2606:4700::1%25]/m",
			"https://user@client.example/m",
			"https://user:pw@client.example/m",
			"http://client.example/m",
			"https://client.example/a\\b",
			"https://client.example/a b",
			"https://client.example/m#frag",
			"https://[::ffff:127.0.0.1/m",
			"https://",
			"",
			"not a url",
			null as unknown as string,
			42 as unknown as string,
		];
		for (const target of malformed)
			expect(await guard(target)).toEqual({ ok: false, code: "INVALID_TARGET" });
		expect(memory.resolverStarts).toBe(0);
		expect(memory.requests).toHaveLength(0);
		expect(memory.timers.size).toBe(0);
	});
});

describe("phase102 boundaries — B03 DNS completeness", () => {
	test("B03 absent families: a complete public answer from the other family proceeds; double absence fails", async () => {
		const aOnly = new MemoryPrimitives();
		aOnly.v6Error = { code: "ENOTFOUND" };
		const pendingA = createOutboundFetchGuard(POLICY, aOnly.deps)(URL_ID);
		await pump();
		const requestA = aOnly.request();
		expect(requestA.target.family).toBe(4);
		expect(await requestA.observe(PUBLIC)).toBe(true);
		expect(requestA.headers()).toBe(true);
		requestA.chunk(encoder.encode("ok"));
		requestA.end();
		expect(await pendingA).toEqual({ ok: true, text: "ok", headers: {} });
		await aOnly.cleanup();

		const aaaaOnly = new MemoryPrimitives();
		aaaaOnly.v4Error = { code: "ENODATA" };
		aaaaOnly.v6 = [PUBLIC_V6];
		const pending = createOutboundFetchGuard(POLICY, aaaaOnly.deps)(URL_ID);
		await pump();
		const request = aaaaOnly.request();
		expect(request.target).toMatchObject({ address: PUBLIC_V6, family: 6 });
		expect(await request.observe(PUBLIC_V6)).toBe(true);
		expect(request.headers()).toBe(true);
		request.end();
		expect(await pending).toEqual({ ok: true, text: "", headers: {} });
		await aaaaOnly.cleanup();

		const none = new MemoryPrimitives();
		none.v4Error = { code: "ENOTFOUND" };
		none.v6Error = { code: "ENODATA" };
		expect(await createOutboundFetchGuard(POLICY, none.deps)(URL_ID)).toEqual({
			ok: false,
			code: "DNS_FAILURE",
		});
		expect(none.requests).toHaveLength(0);
	});

	test("B03 uncertainty is never treated as absence: resolver errors other than ENOTFOUND or ENODATA refuse", async () => {
		const cases: [unknown, unknown][] = [
			[{ code: "ESERVFAIL" }, { code: "ENOTFOUND" }],
			[{ code: "ENOTFOUND" }, { code: "ESERVFAIL" }],
			[{ code: "ETIMEOUT" }, undefined],
			[{ code: "ECONNREFUSED" }, { code: "ENODATA" }],
		];
		for (const [v4Error, v6Error] of cases) {
			const memory = new MemoryPrimitives();
			memory.v4Error = v4Error;
			memory.v6Error = v6Error;
			memory.v6 = [PUBLIC_V6];
			expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID)).toEqual({
				ok: false,
				code: "DNS_FAILURE",
			});
			expect(memory.queries).toBe(2);
			expect(memory.requests).toHaveLength(0);
		}
	});

	test("B03 a denied member in any family refuses regardless of answer order or mixed public answers", async () => {
		const cases: [readonly string[], readonly string[]][] = [
			[[PUBLIC, "10.0.0.1"], []],
			[["10.0.0.1", PUBLIC], []],
			[[PUBLIC], ["::1"]],
			[[PUBLIC], [PUBLIC_V6, "fe80::1"]],
			[[PUBLIC], ["::ffff:127.0.0.1", PUBLIC_V6]],
			[["93.184.216.35", "172.16.0.1"], []],
			[[], ["::"]],
		];
		for (const [v4, v6] of cases) {
			const memory = new MemoryPrimitives();
			memory.v4 = v4;
			memory.v6 = v6;
			expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID)).toEqual({
				ok: false,
				code: "ADDRESS_REFUSED",
			});
			expect(memory.requests).toHaveLength(0);
		}
	});

	test("B03 a late denied family blocks HTTPS, and a late public family cannot rescue an immediate denial", async () => {
		const memory = new MemoryPrimitives();
		const gate = Promise.withResolvers<void>();
		memory.v4Gate = gate.promise;
		memory.v6 = ["::1"];
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		expect(memory.requests).toHaveLength(0);
		gate.resolve();
		expect(await pending).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		expect(memory.requests).toHaveLength(0);

		const reversed = new MemoryPrimitives();
		const reverseGate = Promise.withResolvers<void>();
		reversed.v6Gate = reverseGate.promise;
		reversed.v6 = [PUBLIC_V6];
		reversed.v4 = ["10.0.0.1"];
		const late = createOutboundFetchGuard(POLICY, reversed.deps)(URL_ID);
		await pump();
		expect(reversed.requests).toHaveLength(0);
		reverseGate.resolve();
		expect(await late).toEqual({ ok: false, code: "ADDRESS_REFUSED" });
		expect(reversed.requests).toHaveLength(0);
	});

	test("B03 empty and malformed answer sets refuse before transport", async () => {
		const cases: [readonly string[], readonly string[]][] = [
			[[], []],
			[["93.184.216"], []],
			[["999.1.1.1"], []],
			[["2606:4700:4700::1111"], []],
			[[], ["93.184.216.34"]],
			[[], ["fe80::1%eth0"]],
			[[PUBLIC, "not-an-ip"], []],
			[
				[PUBLIC, "93.184.216.35"],
				[PUBLIC_V6, "fe80::1%eth0"],
			],
		];
		for (const [v4, v6] of cases) {
			const memory = new MemoryPrimitives();
			memory.v4 = v4;
			memory.v6 = v6;
			expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID)).toEqual({
				ok: false,
				code: "DNS_FAILURE",
			});
			expect(memory.requests).toHaveLength(0);
		}
		const nonArray = new MemoryPrimitives();
		nonArray.v4 = PUBLIC as unknown as readonly string[];
		expect(await createOutboundFetchGuard(POLICY, nonArray.deps)(URL_ID)).toEqual({
			ok: false,
			code: "DNS_FAILURE",
		});
		expect(nonArray.requests).toHaveLength(0);
	});

	test("B03 ESERVFAIL with a valid public other family is DNS_FAILURE, not a successful fallback", async () => {
		const memory = new MemoryPrimitives();
		memory.v4Error = { code: "ESERVFAIL" };
		memory.v6 = [PUBLIC_V6];
		expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID)).toEqual({
			ok: false,
			code: "DNS_FAILURE",
		});
		expect(memory.requests).toHaveLength(0);
	});

	test("B03 deterministic checked choice prefers family 4 then lowest bytes, without mutating resolver arrays", async () => {
		const memory = new MemoryPrimitives();
		const answers = ["93.184.216.35", PUBLIC];
		memory.v4 = answers;
		memory.v6 = [PUBLIC_V6];
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		expect(request.target).toMatchObject({ address: PUBLIC, family: 4 });
		expect(answers).toEqual(["93.184.216.35", PUBLIC]);
		expect(memory.v6).toEqual([PUBLIC_V6]);
		// The peer must equal the selected checked address, not another family's valid answer.
		expect(await request.observe(PUBLIC_V6)).toBe(false);
		expect(await pending).toEqual({ ok: false, code: "PIN_MISMATCH" });
		await memory.cleanup();
	});

	test("B03 caller abort during outstanding DNS cancels only the owned resolver; late answers cannot dial", async () => {
		const memory = new MemoryPrimitives();
		memory.holdDns = true;
		const controller = new AbortController();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID, controller.signal);
		await pump();
		controller.abort();
		expect(await pending).toEqual({ ok: false, code: "ABORTED" });
		expect(memory.cancels).toBe(1);
		for (const entry of memory.pendingDns) entry.complete();
		await pump();
		expect(memory.requests).toHaveLength(0);
		expect(memory.resolverStarts).toBe(1);
		await memory.cleanup();
	});

	test("B03 overlapping DNS operations own their resolvers and never exchange answers or peers", async () => {
		const memory = new MemoryPrimitives();
		memory.holdDns = true;
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		const abort = new AbortController();
		const first = guard(URL_ID, abort.signal);
		await pump();
		memory.v4 = ["93.184.216.35"];
		const second = guard(URL_ID);
		await pump();
		abort.abort();
		expect(await first).toEqual({ ok: false, code: "ABORTED" });
		expect(memory.cancels).toBe(1);
		for (const entry of memory.pendingDns) if (entry.resolver === 2) entry.complete();
		await pump();
		expect(memory.requests).toHaveLength(1);
		const request = memory.request();
		expect(request.target.address).toBe("93.184.216.35");
		// Late answers for the aborted operation cannot dial, and completing again changes nothing.
		for (const entry of memory.pendingDns) entry.complete();
		await pump();
		expect(memory.requests).toHaveLength(1);
		expect(await request.observe("93.184.216.35")).toBe(true);
		expect(request.headers()).toBe(true);
		request.chunk(encoder.encode("ok"));
		request.end();
		expect(await second).toEqual({ ok: true, text: "ok", headers: {} });
		await memory.cleanup();
	});
});

describe("phase102 boundaries — B04 pin, identity and target shape", () => {
	test("B04 a checked address is pinned: a later DNS change to a private address is never resolved or dialed", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		memory.v4 = ["10.0.0.5"];
		const request = memory.request();
		expect(request.target.address).toBe(PUBLIC);
		expect(await request.observe("10.0.0.5")).toBe(false);
		expect(await pending).toEqual({ ok: false, code: "PIN_MISMATCH" });
		expect(memory.queries).toBe(2);
		expect(memory.requests).toHaveLength(1);
		expect(request.bodyReads).toBe(0);
		await memory.cleanup();
	});

	test("B04 independently observed peers accept only the checked address in equal or mapped-equivalent spellings", async () => {
		const cases: [string | undefined, boolean][] = [
			[PUBLIC, true],
			["::ffff:5db8:d822", true],
			["::ffff:93.184.216.34", true],
			["93.184.216.35", false],
			[undefined, false],
			["not-an-ip", false],
			["fe80::1%eth0", false],
			[PUBLIC_V6, false],
			["::ffff:93.184.216.35", false],
		];
		for (const [observed, accepted] of cases) {
			const memory = new MemoryPrimitives();
			const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
			await pump();
			const request = memory.request();
			expect(await request.observe(observed)).toBe(accepted);
			if (accepted) {
				expect(request.headers()).toBe(true);
				request.chunk(encoder.encode("ok"));
				request.end();
				expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
			} else {
				expect(await pending).toEqual({ ok: false, code: "PIN_MISMATCH" });
				expect(request.bodyReads).toBe(0);
			}
			await memory.cleanup();
		}
	});

	test("B04 response events before peer acceptance are refused as PIN_MISMATCH and no body is retained", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		expect(request.events.headers(200, { "content-length": "2" })).toBe(false);
		request.events.data(encoder.encode("ok"));
		request.events.end(true);
		expect(await pending).toEqual({ ok: false, code: "PIN_MISMATCH" });
		expect(request.destroyed).toBe(true);
		await memory.cleanup();
	});

	test("B04 an ordinary transport error after an accepted peer is NETWORK_FAILURE and never PIN_MISMATCH", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		expect(await request.observe(PUBLIC)).toBe(true);
		request.events.error("NETWORK_FAILURE");
		expect(request.events.peer("10.0.0.1")).toBe(false);
		expect(await pending).toEqual({ ok: false, code: "NETWORK_FAILURE" });
		await memory.cleanup();
	});

	test("B04 target shape carries only pinned fields, keeps explicit ports and paths, and defaults the port to 443", async () => {
		const explicit = new MemoryPrimitives();
		const pendingExplicit = createOutboundFetchGuard(
			POLICY,
			explicit.deps,
		)("https://client.example:8443/meta.json?x=1");
		await pump();
		expect(explicit.request().target).toEqual({
			address: PUBLIC,
			family: 4,
			hostname: "client.example",
			authority: "client.example:8443",
			port: 8443,
			path: "/meta.json?x=1",
		});
		await explicit.cleanup();
		await pendingExplicit;

		const literal = new MemoryPrimitives();
		const pendingLiteral = createOutboundFetchGuard(
			POLICY,
			literal.deps,
		)("https://[2606:4700:4700::1111]:9443/x");
		expect(literal.request().target).toEqual({
			address: PUBLIC_V6,
			family: 6,
			hostname: PUBLIC_V6,
			authority: "[2606:4700:4700::1111]:9443",
			port: 9443,
			path: "/x",
		});
		await literal.cleanup();
		await pendingLiteral;

		const defaulted = new MemoryPrimitives();
		const pendingDefault = createOutboundFetchGuard(
			POLICY,
			defaulted.deps,
		)("https://client.example/meta");
		await pump();
		expect(defaulted.request().target).toMatchObject({
			authority: "client.example",
			port: 443,
			path: "/meta",
		});
		await defaulted.cleanup();
		await pendingDefault;
	});
});

describe("phase102 boundaries — B05 status and empty body", () => {
	test("B05 non-200, out-of-range and non-integer statuses refuse before any body read or redirect follow", async () => {
		const cases: [number, OutboundFetchCode][] = [
			[204, "HTTP_STATUS"],
			[301, "HTTP_STATUS"],
			[302, "HTTP_STATUS"],
			[303, "HTTP_STATUS"],
			[307, "HTTP_STATUS"],
			[308, "HTTP_STATUS"],
			[404, "HTTP_STATUS"],
			[500, "HTTP_STATUS"],
			[0, "INVALID_RESPONSE"],
			[99, "INVALID_RESPONSE"],
			[600, "INVALID_RESPONSE"],
			[Number.NaN, "INVALID_RESPONSE"],
			[1.5, "INVALID_RESPONSE"],
		];
		for (const [status, code] of cases) {
			const { result, request, memory } = await deliver({
				status,
				headers: { location: "https://10.0.0.5/steal" },
				chunks: [encoder.encode("body")],
			});
			expect(result).toEqual({ ok: false, code });
			expect(request.bodyReads).toBe(0);
			expect(memory.requests).toHaveLength(1);
		}
	});

	test("B05 an upgrade or informational frame is INVALID_RESPONSE, never a followed or accepted response", async () => {
		const memory = new MemoryPrimitives();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		request.events.error("INVALID_RESPONSE");
		expect(await pending).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		expect(memory.requests).toHaveLength(1);
		await memory.cleanup();
	});

	test("B05 an exact empty complete 200 body reaches the consumer as empty text; missing or null completion never does", async () => {
		const empty = await deliver({});
		expect(empty.result).toEqual({ ok: true, text: "", headers: {} });

		const incomplete = await deliver({ complete: false });
		expect(incomplete.result).toEqual({ ok: false, code: "INVALID_RESPONSE" });

		const memory = new MemoryPrimitives();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		request.events.end(undefined as unknown as boolean);
		expect(await pending).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		await memory.cleanup();
	});
});

describe("phase102 boundaries — B06 declared length", () => {
	test("B06 declared lengths are unsigned decimals; over-cap, malformed and duplicate framing refuse before any body read", async () => {
		const refusals: [Record<string, string | string[]>, OutboundFetchCode][] = [
			[{ "content-length": "5001" }, "BODY_TOO_LARGE"],
			[{ "content-length": "00005001" }, "BODY_TOO_LARGE"],
			[{ "content-length": "99999999999999999999999999" }, "BODY_TOO_LARGE"],
			[{ "content-length": "-1" }, "INVALID_RESPONSE"],
			[{ "content-length": "1.5" }, "INVALID_RESPONSE"],
			[{ "content-length": "1e3" }, "INVALID_RESPONSE"],
			[{ "content-length": "0x10" }, "INVALID_RESPONSE"],
			[{ "content-length": "NaN" }, "INVALID_RESPONSE"],
			[{ "content-length": "5,000" }, "INVALID_RESPONSE"],
			[{ "content-length": "+5" }, "INVALID_RESPONSE"],
			[{ "content-length": "" }, "INVALID_RESPONSE"],
			[{ "content-length": ["5", "5"] }, "INVALID_RESPONSE"],
			[{ "Content-Length": "5", "content-length": "5" }, "INVALID_RESPONSE"],
			[{ "content-length": "5", "transfer-encoding": "chunked" }, "INVALID_RESPONSE"],
			[{ "transfer-encoding": "gzip" }, "INVALID_RESPONSE"],
			[{ "transfer-encoding": ["chunked", "chunked"] }, "INVALID_RESPONSE"],
		];
		for (const [headers, code] of refusals) {
			const { result, request, memory } = await deliver({
				headers,
				chunks: [encoder.encode("body")],
			});
			expect(result).toEqual({ ok: false, code });
			expect(request.bodyReads).toBe(0);
			expect(request.deliveredBytes).toBe(0);
			expect(memory.requests).toHaveLength(1);
		}
	});

	test("B06 declared lengths 4999, 5000, padded equivalents and chunked framing are admitted and complete", async () => {
		const admitted: [Record<string, string>, number][] = [
			[{ "content-length": "4999" }, 4999],
			[{ "content-length": "5000" }, 5000],
			[{ "content-length": "0005000" }, 5000],
			[{ "content-length": " 4999 " }, 4999],
			[{ "content-length": "0" }, 0],
			[{ "transfer-encoding": " Chunked " }, 10],
		];
		for (const [headers, size] of admitted) {
			const chunks = size > 0 ? [new Uint8Array(size).fill(97)] : [];
			const { result } = await deliver({ headers, chunks });
			expect(result).toEqual({ ok: true, text: "a".repeat(size), headers: {} });
		}
	});

	test("B06 declared-length mismatch and truncation refuse; a missing length is still byte-capped", async () => {
		expect(
			(await deliver({ headers: { "content-length": "10" }, chunks: [new Uint8Array(9).fill(97)] }))
				.result,
		).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		expect(
			(await deliver({ headers: { "content-length": "5" }, chunks: [new Uint8Array(6).fill(97)] }))
				.result,
		).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		expect(await request.observe(PUBLIC)).toBe(true);
		expect(request.headers(200, { "content-length": "5" })).toBe(true);
		for (let part = 0; part < 25 && !request.destroyed; part++) {
			request.chunk(new Uint8Array(6).fill(97));
		}
		request.end(true);
		expect(request.destroyed).toBe(true);
		expect(request.bodyReads).toBe(1);
		expect(request.deliveredBytes).toBe(6);
		expect(await pending).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		await memory.cleanup();
		expect((await deliver({ headers: { "content-length": "5000" }, chunks: [] })).result).toEqual({
			ok: false,
			code: "INVALID_RESPONSE",
		});
		expect((await deliver({ chunks: [new Uint8Array(5001).fill(97)] })).result).toEqual({
			ok: false,
			code: "BODY_TOO_LARGE",
		});
	});

	test("policy limits must be positive safe integers before any admission", () => {
		const invalid: Partial<typeof POLICY>[] = [
			{ maxBytes: 0 },
			{ maxBytes: 1.5 },
			{ maxInflight: 0 },
			{ timeoutMs: -1 },
			{ timeoutMs: Number.NaN },
		];
		for (const override of invalid) {
			const memory = new MemoryPrimitives();
			expect(() => createOutboundFetchGuard({ ...POLICY, ...override }, memory.deps)).toThrow(
				RangeError,
			);
		}
	});
});

describe("phase102 boundaries — B07 streaming bytes and encodings", () => {
	test("B07 byte boundaries 4999, 5000 and 5001 count raw bytes whether split or delivered in one chunk", async () => {
		expect((await deliver({ chunks: [new Uint8Array(4999).fill(97)] })).result).toEqual({
			ok: true,
			text: "a".repeat(4999),
			headers: {},
		});
		expect(
			(await deliver({ chunks: [new Uint8Array(2500).fill(97), new Uint8Array(2500).fill(97)] }))
				.result,
		).toEqual({ ok: true, text: "a".repeat(5000), headers: {} });
		expect(
			(await deliver({ chunks: [new Uint8Array(5000).fill(97), new Uint8Array(1).fill(97)] }))
				.result,
		).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
		expect((await deliver({ chunks: [new Uint8Array(5001).fill(97)] })).result).toEqual({
			ok: false,
			code: "BODY_TOO_LARGE",
		});
		expect((await deliver({ chunks: [new Uint8Array(1_000_000).fill(97)] })).result).toEqual({
			ok: false,
			code: "BODY_TOO_LARGE",
		});
	});

	test("B07 a long paced producer stops at the cap: later planned chunks are never requested", async () => {
		const memory = new MemoryPrimitives();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		for (let part = 0; part < 25 && !request.destroyed; part++)
			request.chunk(new Uint8Array(1000).fill(65));
		expect(await pending).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
		expect(request.bodyReads).toBe(6);
		expect(request.deliveredBytes).toBe(6000);
		await memory.cleanup();
	});

	test("B07 a 5000-byte body followed by a stall is incomplete and times out at the deadline", async () => {
		for (const size of [4999, 5000]) {
			const memory = new MemoryPrimitives();
			const { pending, request } = await openBody(
				memory,
				createOutboundFetchGuard(POLICY, memory.deps),
			);
			request.chunk(new Uint8Array(size).fill(97));
			memory.advance(4999);
			memory.advance(5000);
			expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
			await memory.cleanup();
		}
	});

	test("B07 non-identity encodings refuse without decompression or body reads", async () => {
		const encodings: (string | string[])[] = [
			"gzip",
			"br",
			"identity, gzip",
			["identity", "identity"],
		];
		for (const value of encodings) {
			const { result, request } = await deliver({
				headers: { "content-encoding": value },
				chunks: [encoder.encode("zip")],
			});
			expect(result).toEqual({ ok: false, code: "INVALID_RESPONSE" });
			expect(request.bodyReads).toBe(0);
		}
		expect(
			(
				await deliver({
					headers: { "content-encoding": "identity" },
					chunks: [encoder.encode("plain")],
				})
			).result,
		).toEqual({ ok: true, text: "plain", headers: {} });
	});

	test("B07 invalid and truncated UTF-8 refuse; a split complete code point decodes once from bytes", async () => {
		const emoji = encoder.encode("😀");
		const split = await deliver({ chunks: [emoji.subarray(0, 2), emoji.subarray(2)] });
		expect(split.result).toEqual({ ok: true, text: "😀", headers: {} });
		expect((await deliver({ chunks: [new Uint8Array([0xff, 0x61])] })).result).toEqual({
			ok: false,
			code: "INVALID_RESPONSE",
		});
		expect((await deliver({ chunks: [encoder.encode("é").subarray(0, 1)] })).result).toEqual({
			ok: false,
			code: "INVALID_RESPONSE",
		});
	});

	test("B07 UTF-16 length is not the cap: 1250 astral code points at exactly 5000 bytes are admitted, 1251 refuse", async () => {
		const admitted = encoder.encode("😀".repeat(1250));
		expect(admitted.byteLength).toBe(5000);
		expect((await deliver({ chunks: [admitted] })).result).toEqual({
			ok: true,
			text: "😀".repeat(1250),
			headers: {},
		});
		const refused = encoder.encode("😀".repeat(1251));
		expect(refused.byteLength).toBe(5004);
		expect((await deliver({ chunks: [refused] })).result).toEqual({
			ok: false,
			code: "BODY_TOO_LARGE",
		});
	});
});

describe("phase102 boundaries — B08 one deadline", () => {
	test("B08 DNS spends part of the single budget; a stalled transport times out at the absolute deadline", async () => {
		const memory = new MemoryPrimitives();
		memory.holdDns = true;
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		memory.clock = 3000;
		for (const entry of memory.pendingDns) entry.complete();
		await pump();
		const request = memory.request();
		expect(await request.observe(PUBLIC)).toBe(true);
		expect(request.headers()).toBe(true);
		let outcome: OutboundFetchResult | undefined;
		void pending.then((result) => {
			outcome = result;
		});
		memory.advance(4999);
		await pump();
		expect(outcome).toBeUndefined();
		memory.advance(5000);
		expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
		expect(request.destroyed).toBe(true);
		await memory.cleanup();
	});

	test("B08 a never-answering transport times out at the absolute deadline with no caller signal", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		expect(memory.request().target.address).toBe(PUBLIC);
		memory.advance(4999);
		let outcome: OutboundFetchResult | undefined;
		void pending.then((result) => {
			outcome = result;
		});
		await pump();
		expect(outcome).toBeUndefined();
		memory.advance(5000);
		expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
		await memory.cleanup();
	});

	test("B08 trickled bytes cannot extend the single stage budget", async () => {
		const memory = new MemoryPrimitives();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		for (const at of [1000, 2000, 3000, 4000]) {
			memory.advance(at);
			request.chunk(new Uint8Array(10).fill(97));
		}
		memory.advance(5000);
		expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
		expect(request.deliveredBytes).toBe(40);
		await memory.cleanup();
	});

	test("B08 the deadline is start plus 5000 monotonic milliseconds with no stage rounding", async () => {
		const memory = new MemoryPrimitives();
		memory.clock = 1000;
		const { pending } = await openPeer(memory, createOutboundFetchGuard(POLICY, memory.deps));
		let outcome: OutboundFetchResult | undefined;
		void pending.then((result) => {
			outcome = result;
		});
		memory.advance(5999);
		await pump();
		expect(outcome).toBeUndefined();
		memory.advance(6000);
		expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
		await memory.cleanup();
	});

	test("B08 an end callback succeeds only strictly before expiration at 4999, and not at 5000 or 5001 milliseconds", async () => {
		for (const at of [4999, 5000, 5001]) {
			const memory = new MemoryPrimitives();
			const { pending, request } = await openBody(
				memory,
				createOutboundFetchGuard(POLICY, memory.deps),
			);
			request.chunk(encoder.encode("ok"));
			memory.clock = at;
			request.end();
			expect(await pending).toEqual(
				at === 4999 ? { ok: true, text: "ok", headers: {} } : { ok: false, code: "TIMEOUT" },
			);
			await memory.cleanup();
		}
	});

	test("B08 a callback delivered after expiration cannot grant a fresh stage: headers after expiry are TIMEOUT", async () => {
		const memory = new MemoryPrimitives();
		const { pending, request } = await openPeer(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		memory.clock = 5000; // Timer deliberately not dispatched.
		expect(request.headers()).toBe(false);
		expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
		await memory.cleanup();
	});

	test("B08 already-aborted signals are refused before admission; abort during headers settles once as ABORTED", async () => {
		const memory = new MemoryPrimitives();
		const aborted = new AbortController();
		aborted.abort();
		expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID, aborted.signal)).toEqual({
			ok: false,
			code: "ABORTED",
		});
		expect(memory.resolverStarts).toBe(0);

		const controller = new AbortController();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
			controller.signal,
		);
		controller.abort();
		request.chunk(encoder.encode("late"));
		request.end();
		expect(await pending).toEqual({ ok: false, code: "ABORTED" });
		await memory.cleanup();
	});
});

describe("phase102 boundaries — B09 leases and isolation", () => {
	test("B09 four operations stalled in DNS, TLS, headers and body hold every lease; the fifth is BUSY with zero DNS and HTTPS", async () => {
		const memory = new MemoryPrimitives();
		memory.automaticStop = false;
		const guard = createOutboundFetchGuard(POLICY, memory.deps);
		memory.holdDns = true;
		const dns = guard(URL_ID);
		await pump();
		memory.holdDns = false;
		const tls = guard(URL_ID);
		await pump();
		const handshaking = guard(URL_ID);
		await pump();
		const body = guard(URL_ID);
		await pump();
		const tlsRequest = memory.request(0);
		const headersRequest = memory.request(1);
		const bodyRequest = memory.request(2);
		expect(await headersRequest.observe(PUBLIC)).toBe(true);
		expect(await bodyRequest.observe(PUBLIC)).toBe(true);
		expect(bodyRequest.headers()).toBe(true);
		bodyRequest.chunk(new Uint8Array(10));
		const before = [memory.resolverStarts, memory.queries, memory.requests.length];
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
		expect([memory.resolverStarts, memory.queries, memory.requests.length]).toEqual(before);

		memory.advance(5000);
		const timedOut: OutboundFetchResult = { ok: false, code: "TIMEOUT" };
		expect(await Promise.all([dns, tls, handshaking, body])).toEqual([
			timedOut,
			timedOut,
			timedOut,
			timedOut,
		]);
		await pump();
		// The DNS slot is released once its resolver settles; the transport slots wait for confirmed stops.
		const extra = guard(URL_ID);
		await pump();
		expect(memory.requests).toHaveLength(4);
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });

		tlsRequest.confirmStop();
		await pump();
		const after = guard(URL_ID);
		await pump();
		expect(memory.requests).toHaveLength(5);
		expect(await guard(URL_ID)).toEqual({ ok: false, code: "BUSY" });

		await memory.cleanup();
		expect(await extra).toEqual({ ok: false, code: "NETWORK_FAILURE" });
		expect(await after).toEqual({ ok: false, code: "NETWORK_FAILURE" });
	});

	test("B09 two independently constructed fake guards keep their admission isolated", async () => {
		const first = new MemoryPrimitives();
		first.automaticStop = false;
		const second = new MemoryPrimitives();
		const firstGuard = createOutboundFetchGuard(POLICY, first.deps);
		const secondGuard = createOutboundFetchGuard(POLICY, second.deps);
		const held = [firstGuard(URL_ID), firstGuard(URL_ID), firstGuard(URL_ID), firstGuard(URL_ID)];
		await pump();
		expect(await firstGuard(URL_ID)).toEqual({ ok: false, code: "BUSY" });
		const other = secondGuard(URL_ID);
		await pump();
		expect(second.requests).toHaveLength(1);
		expect(await second.request().observe(PUBLIC)).toBe(true);
		expect(second.request().headers()).toBe(true);
		second.request().chunk(encoder.encode("ok"));
		second.request().end();
		expect(await other).toEqual({ ok: true, text: "ok", headers: {} });
		await second.cleanup();
		await first.cleanup();
		expect(await Promise.all(held)).toEqual(Array(4).fill({ ok: false, code: "NETWORK_FAILURE" }));
	});
});

describe("phase102 boundaries — B10 terminal races", () => {
	test("B10 success is terminal: competing peer, error, end, data and abort callbacks after commit change nothing", async () => {
		const memory = new MemoryPrimitives();
		const controller = new AbortController();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
			controller.signal,
		);
		request.chunk(encoder.encode("abc"));
		request.end();
		expect(await pending).toEqual({ ok: true, text: "abc", headers: {} });
		request.events.error("NETWORK_FAILURE");
		request.events.end(false);
		expect(request.events.peer("10.0.0.1")).toBe(false);
		request.events.data(encoder.encode("late"));
		controller.abort();
		expect(await pending).toEqual({ ok: true, text: "abc", headers: {} });
		await memory.cleanup();
	});

	test("B10 peer refusal stays PIN_MISMATCH despite later ordinary errors, ends and closes", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		expect(request.events.peer("10.0.0.9")).toBe(false);
		request.events.error("NETWORK_FAILURE");
		request.events.end(true);
		request.events.error("INVALID_RESPONSE");
		expect(await pending).toEqual({ ok: false, code: "PIN_MISMATCH" });
		expect(request.destroyed).toBe(true);
		await memory.cleanup();
	});

	test("B10 an ordinary request error before any peer keeps NETWORK_FAILURE; a late peer acceptance cannot revive it", async () => {
		const memory = new MemoryPrimitives();
		const pending = createOutboundFetchGuard(POLICY, memory.deps)(URL_ID);
		await pump();
		const request = memory.request();
		request.events.error("NETWORK_FAILURE");
		expect(request.events.peer(PUBLIC)).toBe(false);
		expect(await pending).toEqual({ ok: false, code: "NETWORK_FAILURE" });
		await memory.cleanup();
	});

	test("B10 upgrade, premature close and incomplete end are INVALID_RESPONSE and never a success", async () => {
		const upgrade = new MemoryPrimitives();
		const upgraded = await openBody(upgrade, createOutboundFetchGuard(POLICY, upgrade.deps));
		upgraded.request.events.error("INVALID_RESPONSE");
		expect(await upgraded.pending).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		await upgrade.cleanup();

		const incomplete = new MemoryPrimitives();
		const short = await openBody(incomplete, createOutboundFetchGuard(POLICY, incomplete.deps));
		short.request.chunk(encoder.encode("ab"));
		short.request.end(false);
		expect(await short.pending).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		await incomplete.cleanup();

		const closed = new MemoryPrimitives();
		const premature = await openBody(closed, createOutboundFetchGuard(POLICY, closed.deps));
		premature.request.chunk(encoder.encode("ab"));
		premature.request.events.error("INVALID_RESPONSE");
		expect(await premature.pending).toEqual({ ok: false, code: "INVALID_RESPONSE" });
		await closed.cleanup();
	});

	test("B10 redirect, overlength and overflow refuse once and drop every later callback", async () => {
		const redirect = new MemoryPrimitives();
		const redirected = await openPeer(redirect, createOutboundFetchGuard(POLICY, redirect.deps));
		expect(redirected.request.headers(302, { location: "https://10.0.0.5/steal" })).toBe(false);
		redirected.request.chunk(encoder.encode("late"));
		redirected.request.end();
		expect(await redirected.pending).toEqual({ ok: false, code: "HTTP_STATUS" });
		await redirect.cleanup();

		const overlength = new MemoryPrimitives();
		const big = await openBody(overlength, createOutboundFetchGuard(POLICY, overlength.deps));
		big.request.chunk(new Uint8Array(5001));
		big.request.end();
		expect(await big.pending).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
		await overlength.cleanup();

		const overflow = new MemoryPrimitives();
		const streamed = await openBody(overflow, createOutboundFetchGuard(POLICY, overflow.deps));
		for (let part = 0; part < 5; part++) streamed.request.chunk(new Uint8Array(1000));
		streamed.request.chunk(new Uint8Array(1));
		streamed.request.end();
		expect(await streamed.pending).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
		expect(streamed.request.destroyCalls).toBe(1);
		await overflow.cleanup();
	});

	test("B10 timeout and caller abort are terminal, and late callbacks cannot dial or accept a body", async () => {
		const timed = new MemoryPrimitives();
		const expired = await openPeer(timed, createOutboundFetchGuard(POLICY, timed.deps));
		timed.advance(5000);
		expect(expired.request.events.headers(200, {})).toBe(false);
		expired.request.events.end(true);
		expect(await expired.pending).toEqual({ ok: false, code: "TIMEOUT" });
		await timed.cleanup();

		const aborted = new MemoryPrimitives();
		const controller = new AbortController();
		const cancelled = await openPeer(
			aborted,
			createOutboundFetchGuard(POLICY, aborted.deps),
			controller.signal,
		);
		controller.abort();
		expect(cancelled.request.events.peer(PUBLIC)).toBe(false);
		cancelled.request.events.end(true);
		expect(await cancelled.pending).toEqual({ ok: false, code: "ABORTED" });
		await aborted.cleanup();
	});

	test("B10 DNS failure and denied address are terminal before any transport", async () => {
		const failed = new MemoryPrimitives();
		failed.v4Error = { code: "ESERVFAIL" };
		expect(await createOutboundFetchGuard(POLICY, failed.deps)(URL_ID)).toEqual({
			ok: false,
			code: "DNS_FAILURE",
		});
		expect(failed.requests).toHaveLength(0);

		const denied = new MemoryPrimitives();
		denied.v4 = ["10.0.0.1"];
		expect(await createOutboundFetchGuard(POLICY, denied.deps)(URL_ID)).toEqual({
			ok: false,
			code: "ADDRESS_REFUSED",
		});
		expect(denied.requests).toHaveLength(0);
	});

	test("B10 a callback that arrives before the operation handle returns is ordered and commits exactly once", async () => {
		const memory = new MemoryPrimitives();
		const stop = Promise.withResolvers<void>();
		let destroys = 0;
		const deps: OutboundFetchDeps = {
			...memory.deps,
			startRequest: (_target, _signal, events) => {
				expect(events.peer(PUBLIC)).toBe(true);
				expect(events.headers(200, {})).toBe(true);
				events.data(encoder.encode("early"));
				events.end(true);
				return {
					destroy: () => {
						destroys++;
						stop.resolve();
					},
					stopped: stop.promise,
				};
			},
		};
		expect(await createOutboundFetchGuard(POLICY, deps)(URL_ID)).toEqual({
			ok: true,
			text: "early",
			headers: {},
		});
		expect(destroys).toBe(1);
		expect(memory.timers.size).toBe(0);
	});

	test("B10 a synchronous startRequest throw is NETWORK_FAILURE without reading the thrown value, and every lease is released", async () => {
		const memory = new MemoryPrimitives();
		const deps: OutboundFetchDeps = {
			...memory.deps,
			startRequest: () => {
				throw new Error("THROW-RAW-CANARY");
			},
		};
		const guard = createOutboundFetchGuard(POLICY, deps);
		for (let round = 0; round < 6; round++) {
			const result = await guard(URL_ID);
			expect(result).toEqual({ ok: false, code: "NETWORK_FAILURE" });
			expect(JSON.stringify(result)).not.toContain("THROW-RAW-CANARY");
		}
		expect(memory.resolverStarts).toBe(6);
		expect(memory.timers.size).toBe(0);
	});

	test("B10 destroy is idempotent: one transport destroy per terminal refusal and late errors are consumed through stop", async () => {
		const memory = new MemoryPrimitives();
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		request.events.error("NETWORK_FAILURE");
		request.events.error("NETWORK_FAILURE");
		request.events.error("INVALID_RESPONSE");
		expect(await pending).toEqual({ ok: false, code: "NETWORK_FAILURE" });
		expect(request.destroyCalls).toBe(1);
		await memory.cleanup();
	});

	test("B10 terminal branches leak no timers or caller listeners", async () => {
		const listeners = new Set<() => void>();
		const callerSignal = {
			aborted: false,
			addEventListener: (_type: string, listener: () => void) => {
				listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: () => void) => {
				listeners.delete(listener);
			},
		} as unknown as AbortSignal;

		const success = new MemoryPrimitives();
		const { pending, request } = await openBody(
			success,
			createOutboundFetchGuard(POLICY, success.deps),
			callerSignal,
		);
		expect(listeners.size).toBe(1);
		request.chunk(encoder.encode("ok"));
		request.end();
		expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
		expect(listeners.size).toBe(0);
		expect(success.timers.size).toBe(0);

		const refused = new MemoryPrimitives();
		const pendingRefused = createOutboundFetchGuard(POLICY, refused.deps)(URL_ID, callerSignal);
		await pump();
		expect(listeners.size).toBe(1);
		expect(await refused.request().observe("10.0.0.2")).toBe(false);
		expect(await pendingRefused).toEqual({ ok: false, code: "PIN_MISMATCH" });
		expect(listeners.size).toBe(0);
		expect(refused.timers.size).toBe(0);
		await success.cleanup();
		await refused.cleanup();
	});
});

describe("phase102 boundaries — B12 runtime floor and DI isolation", () => {
	test("B12 injected policy refuses every runtime below the floor before admission or primitives", async () => {
		for (const version of ["unknown", "", "0.9.9", "1.2.23", "1.3.99"]) {
			const memory = new MemoryPrimitives();
			memory.version = version;
			expect(await createOutboundFetchGuard(POLICY, memory.deps)(URL_ID)).toEqual({
				ok: false,
				code: "UNSUPPORTED_RUNTIME",
			});
			expect(memory.resolverStarts).toBe(0);
			expect(memory.requests).toHaveLength(0);
			expect(memory.timers.size).toBe(0);
		}
	});

	test("B12 the floor is numeric: 1.10.0 is admitted by major, minor and patch comparison", async () => {
		const memory = new MemoryPrimitives();
		memory.version = "1.10.0";
		const { pending, request } = await openBody(
			memory,
			createOutboundFetchGuard(POLICY, memory.deps),
		);
		request.chunk(encoder.encode("ok"));
		request.end();
		expect(await pending).toEqual({ ok: true, text: "ok", headers: {} });
		await memory.cleanup();
	});
});
