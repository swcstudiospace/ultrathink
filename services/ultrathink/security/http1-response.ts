// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { Buffer } from "node:buffer";

/**
 * Receives one HTTP/1.1 response. `head` runs only after the status line, the header block and the
 * framing headers have all validated; `body` receives decoded payload bytes in order. A view passed
 * to `body` aliases the pushed input and is valid only for the duration of that call.
 */
export interface Http1Sink {
	head(status: number, rawHeaders: readonly string[]): boolean;
	body(chunk: Uint8Array): void;
	end(complete: boolean): void;
	fail(): void;
}

export interface Http1Parser {
	push(chunk: Uint8Array): void;
	close(): void;
}

interface HeaderField {
	readonly name: string;
	readonly value: string;
}

type Framing = { readonly kind: "length"; readonly length: number } | { readonly kind: "chunked" };

type Phase =
	| "status"
	| "headers"
	| "chunkSize"
	| "trailers"
	| "fixed"
	| "chunkData"
	| "chunkDataCr"
	| "chunkDataLf";

const CR = 0x0d;
const LF = 0x0a;
const HTAB = 0x09;
const SP = 0x20;
const MAX_CONTENT_LENGTH = 2147483647;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const STATUS_LINE = /^HTTP\/1\.[01] ([0-9]{3})(?: ([\s\S]*))?$/;
const CHUNK_SIZE_DIGITS = /^[0-9A-Fa-f]{1,8}$/;
const CONTENT_LENGTH_VALUE = /^[0-9]{1,10}$/;

/**
 * Field names refused in a trailer section. This is an interpretation of the RFC 9110 section 6.5.1
 * categories, not a list the RFC enumerates. Refusal is fail-closed.
 */
const FORBIDDEN_TRAILER_FIELDS: Readonly<Record<string, true>> = {
	"content-length": true,
	"transfer-encoding": true,
	host: true,
	trailer: true,
	"content-encoding": true,
	"content-type": true,
	"content-range": true,
	authorization: true,
	"proxy-authorization": true,
	"www-authenticate": true,
	"proxy-authenticate": true,
	"set-cookie": true,
	cookie: true,
	"cache-control": true,
	expires: true,
	age: true,
	date: true,
	vary: true,
	expect: true,
	range: true,
	te: true,
	"max-forwards": true,
	pragma: true,
	location: true,
	"retry-after": true,
};

/** True for any control octet other than HTAB; CR, LF and NUL are all rejected here. */
function hasForbiddenOctet(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if ((code < 0x20 && code !== HTAB) || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function latin1(bytes: readonly number[]): string {
	return Buffer.from(bytes).toString("latin1");
}

function parseStatus(bytes: readonly number[]): number | undefined {
	const match = STATUS_LINE.exec(latin1(bytes));
	if (match === null) {
		return undefined;
	}
	const status = Number(match[1]);
	if (status < 200 || status > 599) {
		return undefined;
	}
	const reason = match[2];
	if (reason !== undefined && hasForbiddenOctet(reason)) {
		return undefined;
	}
	return status;
}

function parseField(bytes: readonly number[]): HeaderField | undefined {
	const first = bytes[0];
	if (first === SP || first === HTAB) {
		return undefined;
	}
	const text = latin1(bytes);
	const colon = text.indexOf(":");
	if (colon <= 0) {
		return undefined;
	}
	const name = text.slice(0, colon);
	if (!TOKEN.test(name)) {
		return undefined;
	}
	const value = text
		.slice(colon + 1)
		.replace(/^[ \t]+/, "")
		.replace(/[ \t]+$/, "");
	if (hasForbiddenOctet(value)) {
		return undefined;
	}
	return { name, value };
}

function parseChunkSize(bytes: readonly number[]): number | undefined {
	const text = latin1(bytes);
	const semicolon = text.indexOf(";");
	const digits = semicolon === -1 ? text : text.slice(0, semicolon);
	if (!CHUNK_SIZE_DIGITS.test(digits)) {
		return undefined;
	}
	return Number.parseInt(digits, 16);
}

function framingOf(fields: readonly HeaderField[]): Framing | undefined {
	const transfer = fields.filter((field) => field.name.toLowerCase() === "transfer-encoding");
	const length = fields.filter((field) => field.name.toLowerCase() === "content-length");
	if (transfer.length > 0) {
		const [only] = transfer;
		if (transfer.length !== 1 || length.length > 0 || only === undefined) {
			return undefined;
		}
		return only.value.toLowerCase() === "chunked" ? { kind: "chunked" } : undefined;
	}
	const [declared] = length;
	if (length.length !== 1 || declared === undefined) {
		return undefined;
	}
	if (!CONTENT_LENGTH_VALUE.test(declared.value)) {
		return undefined;
	}
	const value = Number(declared.value);
	return value <= MAX_CONTENT_LENGTH ? { kind: "length", length: value } : undefined;
}

/**
 * Strict single-response HTTP/1.1 parser. Every byte is interpreted by a state machine, so the
 * sink sees the same protocol events for any partition of the input. Violations, and a connection
 * that closes before the header block completes, end in `fail()`. A truncated body ends in
 * `end(false)`. `head` returning false stops parsing silently.
 *
 * Budgets: the status line and header block (through the blank line) share `maxHeaderBytes`. The
 * chunk-size lines of one body (the last-chunk line included) share one cumulative budget of the same
 * size, CR and LF counted. The trailer section has its own budget of the same size.
 */
export function createHttp1Parser(
	sink: Http1Sink,
	options: { readonly maxHeaderBytes: number },
): Http1Parser {
	const maxBlockBytes = options.maxHeaderBytes;
	if (!Number.isSafeInteger(maxBlockBytes) || maxBlockBytes < 1) {
		throw new RangeError("maxHeaderBytes must be a positive safe integer");
	}

	let phase: Phase = "status";
	let finished = false;
	let line: number[] = [];
	let sawCr = false;
	let blockBytes = 0;
	let status = 0;
	const fields: HeaderField[] = [];
	let remaining = 0;

	const fail = (): void => {
		if (finished) {
			return;
		}
		finished = true;
		sink.fail();
	};

	const finish = (complete: boolean): void => {
		if (finished) {
			return;
		}
		finished = true;
		sink.end(complete);
	};

	const endOfHeaderBlock = (): void => {
		const framing = framingOf(fields);
		if (framing === undefined) {
			fail();
			return;
		}
		const rawHeaders = fields.flatMap((field) => [field.name, field.value]);
		if (!sink.head(status, rawHeaders)) {
			finished = true;
			return;
		}
		if (framing.kind === "chunked") {
			phase = "chunkSize";
			blockBytes = 0;
		} else if (framing.length === 0) {
			finish(true);
		} else {
			remaining = framing.length;
			phase = "fixed";
		}
	};

	const onLine = (bytes: number[]): void => {
		switch (phase) {
			case "status": {
				const parsed = parseStatus(bytes);
				if (parsed === undefined) {
					fail();
					return;
				}
				status = parsed;
				phase = "headers";
				return;
			}
			case "headers": {
				if (bytes.length === 0) {
					endOfHeaderBlock();
					return;
				}
				const field = parseField(bytes);
				if (field === undefined) {
					fail();
					return;
				}
				fields.push(field);
				return;
			}
			case "chunkSize": {
				const size = parseChunkSize(bytes);
				if (size === undefined) {
					fail();
				} else if (size === 0) {
					phase = "trailers";
					blockBytes = 0;
				} else {
					remaining = size;
					phase = "chunkData";
				}
				return;
			}
			case "trailers": {
				if (bytes.length === 0) {
					finish(true);
				} else {
					const field = parseField(bytes);
					if (field === undefined || FORBIDDEN_TRAILER_FIELDS[field.name.toLowerCase()] === true) {
						fail();
					}
				}
				return;
			}
			default:
				return;
		}
	};

	const feedLine = (byte: number): void => {
		if (
			phase === "status" ||
			phase === "headers" ||
			phase === "chunkSize" ||
			phase === "trailers"
		) {
			blockBytes++;
			if (blockBytes > maxBlockBytes) {
				fail();
				return;
			}
		}
		if (sawCr) {
			if (byte !== LF) {
				fail();
				return;
			}
			sawCr = false;
			const bytes = line;
			line = [];
			onLine(bytes);
			return;
		}
		if (byte === CR) {
			sawCr = true;
			return;
		}
		if (byte === LF) {
			fail();
			return;
		}
		line.push(byte);
	};

	return {
		push(chunk: Uint8Array): void {
			let index = 0;
			while (!finished && index < chunk.length) {
				switch (phase) {
					case "fixed":
					case "chunkData": {
						const take = Math.min(remaining, chunk.length - index);
						sink.body(chunk.subarray(index, index + take));
						index += take;
						remaining -= take;
						if (remaining === 0) {
							if (phase === "fixed") {
								finish(true);
							} else {
								phase = "chunkDataCr";
							}
						}
						break;
					}
					case "chunkDataCr": {
						if (chunk[index] !== CR) {
							fail();
						} else {
							phase = "chunkDataLf";
						}
						index++;
						break;
					}
					case "chunkDataLf": {
						if (chunk[index] !== LF) {
							fail();
						} else {
							phase = "chunkSize";
						}
						index++;
						break;
					}
					default: {
						const byte = chunk[index];
						index++;
						if (byte === undefined) {
							return;
						}
						feedLine(byte);
					}
				}
			}
		},
		close(): void {
			if (finished) {
				return;
			}
			if (phase === "status" || phase === "headers") {
				fail();
				return;
			}
			finish(false);
		},
	};
}
