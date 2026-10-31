// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { Resolver } from "node:dns/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";
import { checkServerIdentity } from "node:tls";
import { bunAtLeast } from "./mtls.ts";

/**
 * Complete bounded HTTPS retrieval, not an OAuth resolver or a cache. Native eligibility is
 * feature-specific: the selected literal HTTPS/owned Resolver primitives were qualified on
 * Bun 1.4.0, not on the legacy baseline. Physical deadline/stop/byte properties still require
 * parent runtime evidence; neither a version number nor an offline fixture proves them.
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
export interface OutboundCacheHeaders {
	readonly cacheControl?: string;
	readonly expires?: string;
	readonly date?: string;
	readonly age?: string;
}
export type OutboundFetchResult =
	| { readonly ok: true; readonly text: string; readonly headers: OutboundCacheHeaders }
	| { readonly ok: false; readonly code: OutboundFetchCode };
export type GuardedFetch = (target: string, signal?: AbortSignal) => Promise<OutboundFetchResult>;
export interface OutboundResolver {
	resolve4(hostname: string): Promise<readonly string[]>;
	resolve6(hostname: string): Promise<readonly string[]>;
	cancel(): void;
}
export interface OutboundAddress {
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
export interface OutboundOperation {
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

const OUTBOUND_FETCH_MIN_BUN: readonly [number, number, number] = [1, 4, 0];

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
	const [a, b] = bytes;
	return (
		a === 0 ||
		(a !== undefined && a >= 224) ||
		a === 127 ||
		a === 10 ||
		(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b !== undefined && b >= 64 && b <= 127)
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
				(bytes[0] === 254 && ((bytes[1] ?? 0) & 192) === 128);
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
	const result: { cacheControl?: string; expires?: string; date?: string; age?: string } = {};
	for (const [wire, field] of [
		["cache-control", "cacheControl"],
		["expires", "expires"],
		["date", "date"],
		["age", "age"],
	] as const) {
		const values = headerValues(headers, wire);
		if (values.length === 1) result[field] = values[0];
	}
	return result;
}

/** One owned raw Node HTTPS operation. No redirect, proxy, pool or second DNS lookup. */
function startPinnedHttpsRequest(
	target: PinnedHttpsTarget,
	signal: AbortSignal,
	events: OutboundTransportEvents,
): OutboundOperation {
	const stopped = Promise.withResolvers<void>();
	let req: ClientRequest | undefined;
	let res: IncomingMessage | undefined;
	let socket: Socket | undefined;
	let constructing = true;
	let requestClosed = false;
	let responseClosed = true;
	let socketClosed = true;
	let destroying = false;
	let ended = false;
	let peerAccepted = false;
	let stopConfirmed = false;
	const consumeError = () => {
		if (!destroying && !ended) events.error("NETWORK_FAILURE");
	};
	const confirmStop = () => {
		if (stopConfirmed || constructing || !requestClosed || !responseClosed || !socketClosed) return;
		stopConfirmed = true;
		socket?.removeListener("secureConnect", observePeer);
		res?.removeListener("data", onData);
		stopped.resolve();
	};
	const destroy = () => {
		if (destroying) return;
		destroying = true;
		res?.removeListener("data", onData);
		res?.destroy();
		req?.destroy();
		socket?.destroy();
		confirmStop();
	};
	function observePeer(): void {
		if (destroying || peerAccepted) return;
		peerAccepted = events.peer(socket?.remoteAddress);
		if (!peerAccepted) destroy();
	}
	function onData(chunk: Uint8Array): void {
		if (!destroying) events.data(chunk);
	}
	const onResponse = (response: IncomingMessage) => {
		res = response;
		responseClosed = false;
		response.on("error", consumeError);
		response.once("aborted", () => {
			if (!destroying && !ended) events.error("INVALID_RESPONSE");
		});
		response.once("close", () => {
			responseClosed = true;
			if (!destroying && !ended) events.error("INVALID_RESPONSE");
			confirmStop();
		});
		response.once("end", () => {
			if (destroying) return;
			ended = true;
			events.end(response.complete);
		});
		if (destroying) {
			response.destroy();
			return;
		}
		// A response is TLS-established; this also covers adapters without secureConnect delivery.
		observePeer();
		if (!peerAccepted || destroying) {
			destroy();
			return;
		}
		const headers: Record<string, string | string[]> = {};
		for (let i = 0; i < response.rawHeaders.length; i += 2) {
			const name = response.rawHeaders[i]?.toLowerCase();
			const value = response.rawHeaders[i + 1];
			if (name === undefined || value === undefined) {
				events.error("INVALID_RESPONSE");
				destroy();
				return;
			}
			const previous = headers[name];
			headers[name] =
				previous === undefined
					? value
					: typeof previous === "string"
						? [previous, value]
						: [...previous, value];
		}
		if (!events.headers(response.statusCode ?? 0, headers) || destroying) {
			destroy();
			return;
		}
		response.on("data", onData);
	};
	// A creation throw owns no observable request. After creation all throws use the event seam.
	req = httpsRequest(
		{
			protocol: "https:",
			hostname: target.address,
			family: target.family,
			port: target.port,
			method: "GET",
			path: target.path,
			servername: isIP(target.hostname) === 0 ? target.hostname : "",
			checkServerIdentity: (_host, certificate) =>
				checkServerIdentity(target.hostname, certificate),
			rejectUnauthorized: true,
			agent: false,
			signal,
			headers: { Host: target.authority, Connection: "close", "Accept-Encoding": "identity" },
		},
		onResponse,
	);
	req.on("error", consumeError);
	req.once("socket", (assigned: Socket) => {
		socket = assigned;
		socketClosed = false;
		assigned.on("error", consumeError);
		assigned.once("close", () => {
			socketClosed = true;
			if (!destroying && !ended) events.error("INVALID_RESPONSE");
			confirmStop();
		});
		assigned.once("secureConnect", observePeer);
		if (destroying) assigned.destroy();
	});
	req.once("close", () => {
		requestClosed = true;
		if (!destroying && !ended) events.error("INVALID_RESPONSE");
		confirmStop();
	});
	req.once("upgrade", (_response, upgraded) => {
		events.error("INVALID_RESPONSE");
		upgraded.destroy();
		destroy();
	});
	req.on("information", () => {
		events.error("INVALID_RESPONSE");
		destroy();
	});
	constructing = false;
	try {
		req.end();
	} catch {
		events.error("NETWORK_FAILURE");
		destroy();
	}
	confirmStop();
	return { destroy, stopped: stopped.promise };
}

const nativeDeps: OutboundFetchDeps = {
	createResolver: () => new Resolver(),
	startRequest: startPinnedHttpsRequest,
	now: () => performance.now(),
	schedule: (run, delayMs) => {
		const timer = setTimeout(run, delayMs);
		return () => clearTimeout(timer);
	},
	runtimeVersion: () => (typeof Bun === "undefined" ? "" : Bun.version),
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
	return (target, signal): Promise<OutboundFetchResult> => {
		if (!bunAtLeast(deps.runtimeVersion(), OUTBOUND_FETCH_MIN_BUN)) {
			return Promise.resolve({ ok: false, code: "UNSUPPORTED_RUNTIME" });
		}
		if (signal?.aborted) return Promise.resolve({ ok: false, code: "ABORTED" });
		if (inflight >= maxInflight) return Promise.resolve({ ok: false, code: "BUSY" });
		inflight++;
		const { promise, resolve } = Promise.withResolvers<OutboundFetchResult>();
		function start(): void {
			const deadline = deps.now() + timeoutMs;
			const controller = new AbortController();
			let terminal = false;
			let released = false;
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
				}
			}
			function stopWork(): void {
				destroyRequested = true;
				if (resolver && dnsPending && !resolverCancelled) {
					resolverCancelled = true;
					try {
						resolver.cancel();
					} catch {
						/* Unconfirmed DNS retains its lease. */
					}
				}
				if (operation && !destroyed) {
					destroyed = true;
					try {
						operation.destroy();
					} catch {
						/* Unconfirmed transport retains its lease. */
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
							if (!terminal) {
								if (ending) commitComplete();
								else if (active()) refuse("INVALID_RESPONSE");
							}
							release();
						},
						() => {
							// A rejected stop promise is not stop confirmation: retain admission fail-closed.
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
				cancelTimer = deps.schedule(
					() => {
						if (!terminal) refuse("TIMEOUT");
					},
					Math.max(0, deadline - deps.now()),
				);
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
