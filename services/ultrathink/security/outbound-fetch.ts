// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { Resolver } from "node:dns/promises";
import { connect as netConnect, isIP, type NetConnectOpts, type Socket } from "node:net";
import {
	checkServerIdentity,
	type ConnectionOptions,
	connect as tlsConnect,
	type TLSSocket,
} from "node:tls";
import { createSecurityEvent, logSecurityEvent, SecurityEventType } from "./events.ts";
import { createHttp1Parser, type Http1Sink } from "./http1-response.ts";
import { bunAtLeast } from "./mtls.ts";

/**
 * Complete bounded HTTPS retrieval, not an OAuth resolver or a cache. The pinned transport (one TCP
 * connection to the checked literal address, TLS over it with the hostname identity check, a strict
 * HTTP/1.1 response reader) was qualified on Bun 1.2.23 and Bun 1.4.0 with physical receipts (phase 102,
 * physical driver v6, after v5). A version number alone proves nothing: runtime eligibility is the floor below, and
 * the physical receipts are the evidence. A stop that never confirms releases its slot after
 * STOP_RECLAIM_MS; the operation then counts as a zombie until its stop and any DNS lookup confirm,
 * and admission is refused while MAX_ZOMBIES_ADMISSION zombies exist.
 * The finite numeric policy is not a claim to implement the entire future IANA registry.
 */
export interface OutboundFetchPolicy {
	readonly timeoutMs: number;
	readonly maxBytes: number;
	readonly maxInflight: number;
}
export type OutboundFetchCode =
	| "UNSUPPORTED_RUNTIME"
	| "INVALID_TARGET"
	| "DNS_FAILURE"
	| "ADDRESS_REFUSED"
	| "PIN_MISMATCH"
	| "HTTP_STATUS"
	| "INVALID_RESPONSE"
	| "BODY_TOO_LARGE"
	| "TIMEOUT"
	| "ABORTED"
	| "BUSY"
	| "NETWORK_FAILURE";
/**
 * Cache-relevant response headers. `cacheControl` joins every Cache-Control line with ", " (RFC 9110
 * list combining), so a directive on any line is seen. `ambiguous` is set only when Expires, Date or
 * Age appears more than once; no value is picked for them. The field is absent otherwise.
 */
interface OutboundCacheHeaders {
	readonly cacheControl?: string;
	readonly expires?: string;
	readonly date?: string;
	readonly age?: string;
	readonly ambiguous?: true;
}
export type OutboundFetchResult =
	| { readonly ok: true; readonly text: string; readonly headers: OutboundCacheHeaders }
	| { readonly ok: false; readonly code: OutboundFetchCode };
export type GuardedFetch = (target: string, signal?: AbortSignal) => Promise<OutboundFetchResult>;
interface OutboundResolver {
	resolve4(hostname: string): Promise<readonly string[]>;
	resolve6(hostname: string): Promise<readonly string[]>;
	cancel(): void;
}
interface OutboundAddress {
	readonly address: string;
	readonly family: 4 | 6;
}
export interface PinnedHttpsTarget extends OutboundAddress {
	readonly hostname: string;
	readonly authority: string;
	readonly port: number;
	readonly path: string;
}
type HeaderValues = Readonly<Record<string, string | readonly string[] | undefined>>;
export interface OutboundTransportEvents {
	peer(observedAddress: string | undefined): boolean;
	headers(status: number, headers: HeaderValues): boolean;
	data(chunk: Uint8Array): void;
	end(complete: boolean): void;
	error(reason: "NETWORK_FAILURE" | "INVALID_RESPONSE"): void;
}
interface OutboundOperation {
	destroy(): void;
	readonly stopped: Promise<void>;
}
export interface OutboundFetchDeps {
	createResolver(): OutboundResolver;
	startRequest(
		target: PinnedHttpsTarget,
		signal: AbortSignal,
		events: OutboundTransportEvents,
	): OutboundOperation;
	now(): number;
	schedule(run: () => void, delayMs: number): () => void;
	runtimeVersion(): string;
}

/** The two connection primitives a pinned request dials through; nativeDeps supplies node:net and node:tls. */
interface PinnedTransports {
	connectTcp(options: NetConnectOpts): Socket;
	connectTls(options: ConnectionOptions): TLSSocket;
}

const OUTBOUND_FETCH_MIN_BUN: readonly [number, number, number] = [1, 2, 23];

/**
 * Release at the bound. A stop that has not confirmed STOP_RECLAIM_MS after its request finished releases the
 * operation's in-flight slot, and the operation counts as a zombie until its stop and any DNS lookup confirm.
 * Admission is refused while MAX_ZOMBIES_ADMISSION zombies exist. With an in-flight limit M, at most
 * M + MAX_ZOMBIES_ADMISSION - 1 operations are open at once (seven for M = 4).
 */
const STOP_RECLAIM_MS = 5_000;
/** Admission is refused while this many reclaimed operations are still unconfirmed. */
const MAX_ZOMBIES_ADMISSION = 4;

/** The running Bun version, or "" outside Bun. The guard and the CIMD advertisement both read the runtime through here. */
export function runningRuntimeVersion(): string {
	return typeof Bun === "undefined" ? "" : Bun.version;
}

/** Whether a runtime version can run the guarded outbound fetch: Bun 1.2.23 or later. Only the 1.2.23 and 1.4.0 transports are physically proven; other versions are not individually tested. */
export function outboundFetchRuntimeSupported(version: string): boolean {
	return bunAtLeast(version, OUTBOUND_FETCH_MIN_BUN);
}

interface NumericAddress extends OutboundAddress {
	readonly bytes: readonly number[];
	readonly refused: boolean;
}

function ipv4Bytes(address: string): number[] {
	return address.split(".").map(Number);
}

/** Called only after isIP; expansion includes both dotted and hex mapped tails. */
function ipv6Bytes(address: string): number[] {
	let text = address.toLowerCase();
	if (text.includes(".")) {
		const colon = text.lastIndexOf(":");
		const tail = ipv4Bytes(text.slice(colon + 1));
		text = `${text.slice(0, colon)}:${((tail[0] ?? 0) * 256 + (tail[1] ?? 0)).toString(16)}:${((tail[2] ?? 0) * 256 + (tail[3] ?? 0)).toString(16)}`;
	}
	const halves = text.split("::");
	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves[1] ? halves[1].split(":") : [];
	const words =
		halves.length === 1
			? left
			: [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
	const bytes: number[] = [];
	for (const word of words) {
		const value = Number.parseInt(word, 16);
		bytes.push(value >>> 8, value & 255);
	}
	return bytes;
}

function refusedV4(bytes: readonly number[]): boolean {
	const [a, b, c] = bytes;
	return (
		a === 0 ||
		(a !== undefined && a >= 224) ||
		a === 127 ||
		a === 10 ||
		(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b !== undefined && b >= 64 && b <= 127) ||
		// Special-purpose IPv4 ranges that are not public: IETF protocol assignments 192.0.0.0/24 (RFC 6890),
		// documentation 192.0.2.0/24 (RFC 5737), 6to4 relay anycast 192.88.99.0/24 (RFC 3068), benchmarking
		// 198.18.0.0/15 (RFC 2544), and documentation 198.51.100.0/24 and 203.0.113.0/24 (RFC 5737).
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

function mappedTail(bytes: readonly number[]): readonly number[] | undefined {
	return bytes.length === 16 &&
		bytes.slice(0, 10).every((byte) => byte === 0) &&
		bytes[10] === 255 &&
		bytes[11] === 255
		? bytes.slice(12)
		: undefined;
}

/** NAT64 well-known prefix 64:ff9b::/96 (RFC 6052). The embedded IPv4 can be private, so the whole prefix is refused. */
function nat64WellKnown(bytes: readonly number[]): boolean {
	const head = [0, 100, 255, 155];
	return (
		head.every((byte, index) => bytes[index] === byte) &&
		bytes.slice(4, 12).every((byte) => byte === 0)
	);
}
/** 6to4 2002::/16 (RFC 3056). The embedded IPv4 can be private, so the whole prefix is refused. */
function sixToFour(bytes: readonly number[]): boolean {
	return bytes[0] === 32 && bytes[1] === 2;
}

/** NAT64 local-use 64:ff9b:1::/48 (RFC 8215). Refused whole, like the well-known prefix. */
function nat64LocalUse(bytes: readonly number[]): boolean {
	const head = [0, 100, 255, 155, 0, 1];
	return head.every((byte, index) => bytes[index] === byte);
}
/** IPv4-translated ::ffff:0:0:0/96 (RFC 2765, 0:0:0:0:ffff:0:a.b.c.d). The embedded IPv4 can be private, so the whole prefix is refused. */
function ipv4Translated(bytes: readonly number[]): boolean {
	return (
		bytes.slice(0, 8).every((byte) => byte === 0) &&
		bytes[8] === 255 &&
		bytes[9] === 255 &&
		bytes[10] === 0 &&
		bytes[11] === 0
	);
}

/** Documentation 2001:db8::/32 (RFC 3849) and 3fff::/20 (RFC 9637), discard-only 100::/64 (RFC 6666) and deprecated site-local fec0::/10. Never public. */
function nonPublicDocumentationV6(bytes: readonly number[]): boolean {
	const documentation = bytes[0] === 32 && bytes[1] === 1 && bytes[2] === 13 && bytes[3] === 184;
	const discard = bytes[0] === 1 && bytes[1] === 0 && bytes.slice(2, 8).every((byte) => byte === 0);
	const siteLocal = bytes[0] === 254 && ((bytes[1] ?? 0) & 192) === 192;
	const rfc9637 = bytes[0] === 63 && bytes[1] === 255 && ((bytes[2] ?? 0) & 240) === 0;
	return documentation || discard || siteLocal || rfc9637;
}

/** IETF protocol assignments 2001::/23 (RFC 2928), which contain Teredo 2001::/32 (RFC 4380), 2001:2::/48, 2001:10::/28 and 2001:20::/28. Refused by the owner's full-RFC-6890 decision (2026-11-01). */
function ietfProtocolBlockV6(bytes: readonly number[]): boolean {
	return bytes[0] === 32 && bytes[1] === 1 && ((bytes[2] ?? 0) & 254) === 0;
}

function classifyAddress(address: string): NumericAddress | undefined {
	if (typeof address !== "string" || address.includes("%")) return undefined;
	const family = isIP(address);
	if (family !== 4 && family !== 6) return undefined;
	const bytes = family === 4 ? ipv4Bytes(address) : ipv6Bytes(address);
	const tail = family === 6 ? mappedTail(bytes) : undefined;
	const refused =
		family === 4
			? refusedV4(bytes)
			: (tail !== undefined && refusedV4(tail)) ||
				bytes.slice(0, 12).every((byte) => byte === 0) ||
				bytes[0] === 255 ||
				((bytes[0] ?? 0) & 254) === 252 ||
				(bytes[0] === 254 && ((bytes[1] ?? 0) & 192) === 128) ||
				nat64WellKnown(bytes) ||
				sixToFour(bytes) ||
				nat64LocalUse(bytes) ||
				ipv4Translated(bytes) ||
				ietfProtocolBlockV6(bytes) ||
				nonPublicDocumentationV6(bytes);
	return { address, family, bytes, refused };
}

function compareBytes(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < a.length; i++) {
		const difference = (a[i] ?? 0) - (b[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function sameAddress(a: NumericAddress, b: NumericAddress): boolean {
	return compareBytes(mappedTail(a.bytes) ?? a.bytes, mappedTail(b.bytes) ?? b.bytes) === 0;
}

/** No sort/mutation of resolver arrays; all records are classified before selecting one. */
function selectAddress(
	answers: readonly { readonly family: 4 | 6; readonly values: readonly string[] }[],
): NumericAddress | "DNS_FAILURE" | "ADDRESS_REFUSED" {
	let selected: NumericAddress | undefined;
	let denied = false;
	for (const answer of answers) {
		if (!Array.isArray(answer.values)) return "DNS_FAILURE";
		for (const raw of answer.values) {
			const numeric = classifyAddress(raw);
			if (!numeric || numeric.family !== answer.family) return "DNS_FAILURE";
			denied ||= numeric.refused;
			if (
				!selected ||
				numeric.family < selected.family ||
				(numeric.family === selected.family && compareBytes(numeric.bytes, selected.bytes) < 0)
			) {
				selected = numeric;
			}
		}
	}
	return denied ? "ADDRESS_REFUSED" : (selected ?? "DNS_FAILURE");
}

function parseTarget(target: string): Omit<PinnedHttpsTarget, "address" | "family"> | undefined {
	if (
		typeof target !== "string" ||
		/[\s\x00-\x1f\x7f\\]/.test(target) ||
		target.includes("#") ||
		/%(?![0-9a-f]{2})/i.test(target)
	)
		return undefined;
	const parts = /^https:\/\/([^/?#]+)(?:[/?][^#]*)?$/i.exec(target);
	if (!parts?.[1] || parts[1].includes("@")) return undefined;
	try {
		const url = new URL(target);
		const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
		// Layering: the anchored regex above fixes the lexical https:// form of the raw target.
		// This URL.protocol operand independently checks the scheme the WHATWG parser resolves.
		// Both are required; neither is redundant, so do not remove either.
		if (
			url.protocol !== "https:" ||
			!hostname ||
			hostname.includes("%") ||
			url.username ||
			url.password
		)
			return undefined;
		return {
			hostname,
			authority: parts[1],
			port: url.port ? Number(url.port) : 443,
			path: url.pathname + url.search,
		};
	} catch {
		return undefined;
	}
}

// Null prototype: a remote header named "constructor" or "__proto__" must be stored as a plain key.
// On a {} map it reads an inherited Object.prototype value, and spreading that throws.
export function collectRawHeaders(rawHeaders: readonly string[]): HeaderValues | undefined {
	const headers: Record<string, string | string[]> = Object.create(null);
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i]?.toLowerCase();
		const value = rawHeaders[i + 1];
		if (name === undefined || value === undefined) return undefined;
		const previous = headers[name];
		headers[name] =
			previous === undefined
				? value
				: typeof previous === "string"
					? [previous, value]
					: [...previous, value];
	}
	return headers;
}

function headerValues(headers: HeaderValues, name: string): string[] {
	const values: string[] = [];
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== name || value === undefined) continue;
		if (typeof value === "string") values.push(value);
		else values.push(...value);
	}
	return values;
}

function trimOws(value: string): string {
	return value.replace(/^[\t ]+|[\t ]+$/g, "");
}

function readDeclaredLength(
	headers: HeaderValues,
	maxBytes: number,
): number | undefined | "INVALID_RESPONSE" | "BODY_TOO_LARGE" {
	const lengths = headerValues(headers, "content-length");
	const transfers = headerValues(headers, "transfer-encoding");
	if (lengths.length > 1 || transfers.length > 1 || (lengths.length && transfers.length)) {
		return "INVALID_RESPONSE";
	}
	if (transfers.length && trimOws(transfers[0] ?? "").toLowerCase() !== "chunked") {
		return "INVALID_RESPONSE";
	}
	if (!lengths.length) return undefined;
	const raw = trimOws(lengths[0] ?? "");
	if (!/^[0-9]+$/.test(raw)) return "INVALID_RESPONSE";
	const decimal = raw.replace(/^0+/, "") || "0";
	const cap = String(maxBytes);
	if (decimal.length > cap.length || (decimal.length === cap.length && decimal > cap)) {
		return "BODY_TOO_LARGE";
	}
	return Number(decimal);
}

function cacheHeaders(headers: HeaderValues): OutboundCacheHeaders {
	const result: {
		cacheControl?: string;
		expires?: string;
		date?: string;
		age?: string;
		ambiguous?: true;
	} = {};
	const cacheControl = headerValues(headers, "cache-control");
	if (cacheControl.length > 0) result.cacheControl = cacheControl.join(", ");
	for (const [wire, field] of [
		["expires", "expires"],
		["date", "date"],
		["age", "age"],
	] as const) {
		const values = headerValues(headers, wire);
		if (values.length === 1) result[field] = values[0];
		else if (values.length > 1) result.ambiguous = true;
	}
	return result;
}

/**
 * One pinned HTTPS connection per call: TCP to the already-validated literal address, TLS over
 * that same socket with the hostname identity check, then one GET. No redirect following, no
 * proxy, no pooling, no second DNS lookup. Identity encoding only; the response is read by the
 * strict HTTP/1.1 reader in http1-response.ts (bounded header block, chunked decoding, no 1xx).
 * Every failure after the operation exists is reported through events, once.
 */
function startPinnedHttpsRequest(
	target: PinnedHttpsTarget,
	signal: AbortSignal,
	events: OutboundTransportEvents,
	transports: PinnedTransports,
): OutboundOperation {
	const stopped = Promise.withResolvers<void>();
	const request =
		"GET " +
		target.path +
		" HTTP/1.1\r\nHost: " +
		target.authority +
		"\r\nConnection: close\r\nAccept-Encoding: identity\r\n\r\n";
	let destroying = false;
	let ended = false;
	let inputClosed = false;
	let tcpClosed = false;
	let tlsClosed = true;
	let stopConfirmed = false;
	let secure: TLSSocket | undefined;
	const sink: Http1Sink = {
		head(status, rawHeaders) {
			if (destroying) return false;
			const headers = collectRawHeaders(rawHeaders);
			if (headers === undefined) {
				failWith("INVALID_RESPONSE");
				return false;
			}
			const accepted = events.headers(status, headers);
			if (!accepted || destroying) {
				failWith("INVALID_RESPONSE");
				return false;
			}
			return true;
		},
		body(chunk) {
			if (!destroying) events.data(chunk);
		},
		end(complete) {
			if (destroying || ended) return;
			ended = true;
			events.end(complete);
			destroy();
		},
		fail() {
			failWith("INVALID_RESPONSE");
		},
	};
	const parser = createHttp1Parser(sink, { maxHeaderBytes: 16384 });
	function confirmStop(): void {
		if (stopConfirmed || !tcpClosed || !tlsClosed) return;
		stopConfirmed = true;
		signal.removeEventListener("abort", onAbort);
		stopped.resolve();
	}
	function destroy(): void {
		if (destroying) return;
		destroying = true;
		secure?.destroy();
		tcp.destroy();
		confirmStop();
	}
	function failWith(reason: "NETWORK_FAILURE" | "INVALID_RESPONSE"): void {
		if (destroying || ended) return;
		events.error(reason);
		destroy();
	}
	function onAbort(): void {
		destroy();
	}
	function onTransportClose(): void {
		if (!inputClosed) {
			inputClosed = true;
			parser.close();
		}
		failWith("INVALID_RESPONSE");
		confirmStop();
	}
	// The only connection: the literal validated address, never a hostname.
	const tcp = transports.connectTcp({
		host: target.address,
		port: target.port,
		family: target.family,
	});
	tcp.once("connect", () => {
		if (destroying) return;
		const tlsSocket = transports.connectTls({
			socket: tcp,
			servername: isIP(target.hostname) === 0 ? target.hostname : "",
			rejectUnauthorized: true,
			checkServerIdentity: (_host, certificate) =>
				checkServerIdentity(target.hostname, certificate),
		});
		secure = tlsSocket;
		tlsClosed = false;
		tlsSocket.once("secureConnect", () => {
			if (destroying) return;
			// Both checks are required. Bun 1.2.23 may report a handshake success for an untrusted chain, so the
			// verified flag and the hostname identity check are both enforced here, not left to the runtime.
			const identity = checkServerIdentity(target.hostname, tlsSocket.getPeerCertificate());
			if (!tlsSocket.authorized || identity !== undefined) {
				failWith("NETWORK_FAILURE");
				return;
			}
			const observed = tcp.remoteAddress;
			const accepted = events.peer(observed);
			if (!accepted || observed === undefined) {
				destroy();
				return;
			}
			tlsSocket.write(request);
		});
		tlsSocket.on("data", (chunk: string | Uint8Array) => {
			if (destroying) return;
			// No encoding is set on the socket, so chunks are bytes; a string would mean the socket changed mode.
			if (typeof chunk === "string") {
				failWith("INVALID_RESPONSE");
				return;
			}
			parser.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		});
		tlsSocket.on("error", () => failWith("NETWORK_FAILURE"));
		tlsSocket.once("close", () => {
			tlsClosed = true;
			onTransportClose();
		});
	});
	tcp.on("error", () => failWith("NETWORK_FAILURE"));
	tcp.once("close", () => {
		tcpClosed = true;
		onTransportClose();
	});
	if (signal.aborted) destroy();
	else signal.addEventListener("abort", onAbort, { once: true });
	return { destroy, stopped: stopped.promise };
}

/** The pinned request over the given connection primitives. */
export function createPinnedRequest(
	transports: PinnedTransports,
): OutboundFetchDeps["startRequest"] {
	return (target, signal, events) => startPinnedHttpsRequest(target, signal, events, transports);
}

const nativeDeps: OutboundFetchDeps = {
	createResolver: () => new Resolver(),
	startRequest: createPinnedRequest({ connectTcp: netConnect, connectTls: tlsConnect }),
	now: () => performance.now(),
	schedule: (run, delayMs) => {
		const timer = setTimeout(run, delayMs);
		return () => clearTimeout(timer);
	},
	runtimeVersion: runningRuntimeVersion,
};

function absentFamily(reason: unknown): boolean {
	if (typeof reason !== "object" || reason === null || !("code" in reason)) return false;
	return reason.code === "ENOTFOUND" || reason.code === "ENODATA";
}

/** Trusted whole-bag DI is separate from operator configuration; factory construction is inert. */
export function createOutboundFetchGuard(
	policy: OutboundFetchPolicy,
	deps: OutboundFetchDeps = nativeDeps,
): GuardedFetch {
	const { timeoutMs, maxBytes, maxInflight } = policy;
	if (
		![timeoutMs, maxBytes, maxInflight].every((value) => Number.isSafeInteger(value) && value > 0)
	) {
		throw new RangeError("Outbound limits must be positive safe integers");
	}
	let inflight = 0;
	let zombies = 0;
	return (target, signal): Promise<OutboundFetchResult> => {
		if (!outboundFetchRuntimeSupported(deps.runtimeVersion())) {
			return Promise.resolve({ ok: false, code: "UNSUPPORTED_RUNTIME" });
		}
		if (signal?.aborted) return Promise.resolve({ ok: false, code: "ABORTED" });
		if (inflight >= maxInflight || zombies >= MAX_ZOMBIES_ADMISSION) {
			return Promise.resolve({ ok: false, code: "BUSY" });
		}
		inflight++;
		const { promise, resolve } = Promise.withResolvers<OutboundFetchResult>();
		function start(): void {
			const deadline = deps.now() + timeoutMs;
			const controller = new AbortController();
			let terminal = false;
			let released = false;
			let zombie = false;
			let cancelReclaim: (() => void) | undefined;
			let resolver: OutboundResolver | undefined;
			let dnsPending = false;
			let resolverCancelled = false;
			let starting = false;
			let operation: OutboundOperation | undefined;
			let operationStopped = true;
			let destroyRequested = false;
			let destroyed = false;
			let cancelTimer = () => {
				/* No timer is armed until the deadline is scheduled below. */
			};
			let selected: NumericAddress | undefined;
			let peerAccepted = false;
			let headersAccepted = false;
			let declaredLength: number | undefined;
			let headers: OutboundCacheHeaders = {};
			let buffer: Uint8Array | undefined;
			let size = 0;
			let ending = false;
			let completedText: string | undefined;

			function release(): void {
				if (!released && terminal && !dnsPending && !starting && operationStopped) {
					released = true;
					inflight--;
					try {
						cancelReclaim?.();
					} catch {
						/* Released is already set, so an uncancelled reclaim is a no-op. */
					}
					cancelReclaim = undefined;
				}
			}
			function armReclaim(): void {
				if (released) return;
				try {
					cancelReclaim = deps.schedule(reclaimSlot, STOP_RECLAIM_MS);
				} catch {
					/* Without a timer the bound cannot run later, so the slot is reclaimed now. */
					reclaimSlot();
				}
			}
			function reclaimSlot(): void {
				cancelReclaim = undefined;
				if (released) return;
				const unconfirmed = dnsPending || !operationStopped;
				released = true;
				inflight--;
				// A slot whose work never started, or already confirmed, leaves no zombie behind.
				if (!unconfirmed) return;
				zombie = true;
				zombies++;
				try {
					logSecurityEvent(
						createSecurityEvent(SecurityEventType.SUSPICIOUS_ACTIVITY, {
							name: "outbound_fetch.zombie_reclaimed",
							source: "outbound_fetch",
							details: { phase: dnsPending ? "dns" : "transport", zombies },
						}),
					);
				} catch {
					/* The sink must never break slot accounting. */
				}
			}
			/** Retires the zombie once no DNS, start or transport work is unconfirmed. */
			function retireZombie(): void {
				if (!zombie || dnsPending || starting || !operationStopped) return;
				zombie = false;
				zombies--;
			}
			function stopWork(): void {
				destroyRequested = true;
				if (resolver && dnsPending && !resolverCancelled) {
					resolverCancelled = true;
					try {
						resolver.cancel();
					} catch {
						/* Unconfirmed DNS retains its lease until the reclaim bound. */
					}
				}
				if (operation && !destroyed) {
					destroyed = true;
					try {
						operation.destroy();
					} catch {
						/* Unconfirmed transport retains its lease until the reclaim bound. */
					}
				}
			}
			function finish(result: OutboundFetchResult): void {
				if (terminal) return;
				terminal = true;
				buffer = undefined;
				completedText = undefined;
				cancelTimer();
				signal?.removeEventListener("abort", onAbort);
				controller.abort();
				stopWork();
				release();
				armReclaim();
				resolve(result);
			}
			function refuse(code: OutboundFetchCode): void {
				finish({ ok: false, code });
			}
			function active(): boolean {
				if (terminal) return false;
				if (signal?.aborted) {
					refuse("ABORTED");
					return false;
				}
				if (deps.now() >= deadline) {
					refuse("TIMEOUT");
					return false;
				}
				return true;
			}
			function onAbort(): void {
				if (active()) refuse("ABORTED");
			}
			function commitComplete(): void {
				if (!active() || !ending || !operationStopped || starting || dnsPending) return;
				if (completedText === undefined) {
					refuse("INVALID_RESPONSE");
					return;
				}
				finish({ ok: true, text: completedText, headers });
			}
			function bodyGate(): boolean {
				if (!active()) return false;
				if (!peerAccepted) {
					refuse("PIN_MISMATCH");
					return false;
				}
				return true;
			}
			const events: OutboundTransportEvents = {
				peer: (observed) => {
					if (!active()) return false;
					const actual = observed === undefined ? undefined : classifyAddress(observed);
					if (!selected || !actual || !sameAddress(selected, actual)) {
						refuse("PIN_MISMATCH");
						return false;
					}
					peerAccepted = true;
					return true;
				},
				headers: (status, incoming) => {
					if (!bodyGate()) return false;
					if (
						headersAccepted ||
						ending ||
						!Number.isInteger(status) ||
						status < 100 ||
						status > 599
					) {
						refuse("INVALID_RESPONSE");
						return false;
					}
					if (status !== 200) {
						refuse("HTTP_STATUS");
						return false;
					}
					const length = readDeclaredLength(incoming, maxBytes);
					if (typeof length === "string") {
						refuse(length);
						return false;
					}
					const encoding = headerValues(incoming, "content-encoding");
					if (
						encoding.length > 1 ||
						(encoding.length === 1 && trimOws(encoding[0] ?? "").toLowerCase() !== "identity")
					) {
						refuse("INVALID_RESPONSE");
						return false;
					}
					declaredLength = length;
					headers = cacheHeaders(incoming);
					headersAccepted = true;
					return true;
				},
				data: (chunk) => {
					if (!bodyGate()) return;
					if (!headersAccepted || ending || !(chunk instanceof Uint8Array)) {
						refuse("INVALID_RESPONSE");
						return;
					}
					if (chunk.byteLength > maxBytes - size) {
						refuse("BODY_TOO_LARGE");
						return;
					}
					if (declaredLength !== undefined && chunk.byteLength > declaredLength - size) {
						refuse("INVALID_RESPONSE");
						return;
					}
					if (chunk.byteLength === 0) return;
					buffer ??= new Uint8Array(maxBytes);
					buffer.set(chunk, size);
					size += chunk.byteLength;
				},
				end: (complete) => {
					if (!bodyGate()) return;
					if (
						!headersAccepted ||
						ending ||
						!complete ||
						(declaredLength !== undefined && size !== declaredLength)
					) {
						refuse("INVALID_RESPONSE");
						return;
					}
					try {
						completedText = new TextDecoder("utf-8", { fatal: true }).decode(
							buffer?.subarray(0, size),
						);
					} catch {
						refuse("INVALID_RESPONSE");
						return;
					}
					buffer = undefined;
					ending = true;
					stopWork();
					commitComplete();
				},
				error: (reason) => {
					if (active() && !ending) refuse(reason);
				},
			};
			function dial(address: NumericAddress): void {
				if (!active()) return;
				if (!network) {
					refuse("INVALID_TARGET");
					return;
				}
				selected = address;
				starting = true;
				operationStopped = false;
				try {
					operation = deps.startRequest(
						{ ...network, address: address.address, family: address.family },
						controller.signal,
						events,
					);
				} catch {
					operationStopped = true;
					refuse("NETWORK_FAILURE");
				} finally {
					starting = false;
				}
				if (operation) {
					operation.stopped.then(
						() => {
							operationStopped = true;
							retireZombie();
							if (!terminal) {
								if (ending) commitComplete();
								else if (active()) refuse("INVALID_RESPONSE");
							}
							release();
						},
						() => {
							// A rejected stop promise is not stop confirmation: the slot stays held until the reclaim bound.
							if (active()) refuse("NETWORK_FAILURE");
						},
					);
					if (destroyRequested) stopWork();
				}
				release();
			}
			const network = parseTarget(target);
			if (!network) {
				refuse("INVALID_TARGET");
				return;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				try {
					cancelTimer = deps.schedule(
						() => {
							if (!terminal) refuse("TIMEOUT");
						},
						Math.max(0, deadline - deps.now()),
					);
				} catch {
					// A timer that cannot be armed means no deadline or work starts. NETWORK_FAILURE
					// matches the startRequest refusal in dial; DNS_FAILURE would misreport the fault.
					refuse("NETWORK_FAILURE");
					return;
				}
				if (terminal) {
					cancelTimer();
					return;
				}
				if (!active()) return;
				const literal = classifyAddress(network.hostname);
				if (literal) {
					if (literal.refused) refuse("ADDRESS_REFUSED");
					else dial(literal);
					return;
				}
				resolver = deps.createResolver();
				if (!active()) {
					stopWork();
					return;
				}
				dnsPending = true;
				const query = (family: 4 | 6): Promise<readonly string[]> => {
					try {
						if (!resolver) return Promise.reject();
						return family === 4
							? resolver.resolve4(network.hostname)
							: resolver.resolve6(network.hostname);
					} catch (reason) {
						return Promise.reject(reason);
					}
				};
				Promise.allSettled([query(4), query(6)]).then(
					(settled) => {
						dnsPending = false;
						retireZombie();
						if (!active()) {
							release();
							return;
						}
						const answers: { family: 4 | 6; values: readonly string[] }[] = [];
						for (let index = 0; index < settled.length; index++) {
							const entry = settled[index];
							if (!entry) {
								refuse("DNS_FAILURE");
								return;
							}
							if (entry.status === "rejected") {
								if (!absentFamily(entry.reason)) {
									refuse("DNS_FAILURE");
									return;
								}
							} else answers.push({ family: index === 0 ? 4 : 6, values: entry.value });
						}
						const address = selectAddress(answers);
						if (typeof address === "string") refuse(address);
						else dial(address);
					},
					() => {
						dnsPending = false;
						retireZombie();
						if (active()) refuse("DNS_FAILURE");
						release();
					},
				);
			} catch {
				if (active()) refuse("DNS_FAILURE");
			}
		}
		start();
		return promise;
	};
}
