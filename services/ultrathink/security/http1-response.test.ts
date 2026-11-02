// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHttp1Parser, type Http1Sink } from "./http1-response.ts";

type Event =
	| { readonly type: "head"; readonly status: number; readonly headers: readonly string[] }
	| { readonly type: "body"; readonly data: string }
	| { readonly type: "end"; readonly complete: boolean }
	| { readonly type: "fail" };

interface Scenario {
	readonly name: string;
	readonly input: string;
	readonly expected: readonly Event[];
	readonly maxHeaderBytes?: number;
	readonly close?: boolean;
	readonly accept?: boolean;
}

const OK = "HTTP/1.1 200 OK\r\n";
const FAIL: Event = { type: "fail" };
const head = (status: number, ...headers: string[]): Event => ({ type: "head", status, headers });
const body = (data: string): Event => ({ type: "body", data });
const end = (complete: boolean): Event => ({ type: "end", complete });

/** Wire bytes: one JS char per octet, so the test strings are byte-exact. */
function wire(text: string): Buffer {
	return Buffer.from(text, "latin1");
}

/**
 * Records every sink call. Consecutive body() calls are merged: how body bytes are split across
 * calls follows the input split, which is not part of the observable contract; the byte sequence is.
 */
function recorder(accept: boolean): { sink: Http1Sink; events: Event[] } {
	const events: Event[] = [];
	const sink: Http1Sink = {
		head(status, rawHeaders) {
			events.push({ type: "head", status, headers: [...rawHeaders] });
			return accept;
		},
		body(chunk) {
			const data = Buffer.from(chunk).toString("latin1");
			const last = events.at(-1);
			if (last?.type === "body") {
				events[events.length - 1] = { type: "body", data: last.data + data };
			} else {
				events.push({ type: "body", data });
			}
		},
		end(complete) {
			events.push({ type: "end", complete });
		},
		fail() {
			events.push({ type: "fail" });
		},
	};
	return { sink, events };
}

function run(scenario: Scenario, pieces: readonly Uint8Array[]): Event[] {
	const { sink, events } = recorder(scenario.accept ?? true);
	const parser = createHttp1Parser(sink, { maxHeaderBytes: scenario.maxHeaderBytes ?? 1024 });
	for (const piece of pieces) {
		parser.push(piece);
	}
	if (scenario.close) {
		parser.close();
	}
	return events;
}

/** A chunked body of `count` one-byte chunks whose size lines each carry a `pad`-byte extension, then the last-chunk line and an empty trailer section. Each size line is pad + 4 bytes: digit, semicolon, pad, CR, LF. */
function paddedChunkBody(count: number, pad: number): string {
	const sizeLine = `1;${"a".repeat(pad)}\r\nx\r\n`;
	return `${sizeLine.repeat(count)}0\r\n\r\n`;
}

const scenarios: readonly Scenario[] = [
	// Content-Length framing.
	{
		name: "Content-Length body is delivered exactly",
		input: `${OK}Content-Length: 3\r\n\r\nabc`,
		expected: [head(200, "Content-Length", "3"), body("abc"), end(true)],
	},
	{
		name: "Content-Length 0 ends right after the header block; later close is ignored",
		input: "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n",
		close: true,
		expected: [head(204, "Content-Length", "0"), end(true)],
	},
	{
		name: "close before Content-Length bytes arrive ends incomplete",
		input: `${OK}Content-Length: 5\r\n\r\nabc`,
		close: true,
		expected: [head(200, "Content-Length", "5"), body("abc"), end(false)],
	},
	{
		name: "bytes after the declared body are ignored",
		input: `${OK}Content-Length: 2\r\n\r\nokEXTRA`,
		expected: [head(200, "Content-Length", "2"), body("ok"), end(true)],
	},
	{
		name: "HTTP/1.0 status line is accepted",
		input: "HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nhi",
		expected: [head(200, "Content-Length", "2"), body("hi"), end(true)],
	},
	{
		name: "status without reason phrase is accepted",
		input: "HTTP/1.1 200\r\nContent-Length: 0\r\n\r\n",
		expected: [head(200, "Content-Length", "0"), end(true)],
	},
	{
		name: "200 with a reason phrase is accepted",
		input: "HTTP/1.1 200 OK fine and dandy\r\nContent-Length: 0\r\n\r\n",
		expected: [head(200, "Content-Length", "0"), end(true)],
	},
	{
		name: "header values are trimmed of optional whitespace; names are kept verbatim",
		input: `${OK}content-LENGTH:\t 3 \t\r\n\r\nabc`,
		expected: [head(200, "content-LENGTH", "3"), body("abc"), end(true)],
	},
	{
		name: "Content-Length at the 2147483647 limit is accepted",
		input: `${OK}Content-Length: 2147483647\r\n\r\n`,
		close: true,
		expected: [head(200, "Content-Length", "2147483647"), end(false)],
	},
	{
		name: "Content-Length above 2147483647 is a violation",
		input: `${OK}Content-Length: 2147483648\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "Content-Length with a sign (+) is a violation",
		input: `${OK}Content-Length: +3\r\n\r\nabc`,
		expected: [FAIL],
	},
	{
		name: "Content-Length with a sign (-) is a violation",
		input: `${OK}Content-Length: -3\r\n\r\nabc`,
		expected: [FAIL],
	},
	{
		name: "Content-Length with an inner space is a violation",
		input: `${OK}Content-Length: 3 4\r\n\r\nabc`,
		expected: [FAIL],
	},
	{
		name: "duplicate Content-Length is a violation even when equal",
		input: `${OK}Content-Length: 3\r\nContent-Length: 3\r\n\r\nabc`,
		expected: [FAIL],
	},

	// Chunked framing.
	{
		name: "chunked with two chunks and the terminator",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abcdefg"), end(true)],
	},
	{
		name: "chunked transfer coding is matched case-insensitively",
		input: `${OK}Transfer-Encoding:  CHUNKED \r\n\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "CHUNKED"), end(true)],
	},
	{
		name: "chunk extension text is ignored",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3;name=value; other\r\nabc\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abc"), end(true)],
	},
	{
		name: "uppercase hex chunk size",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("0123456789"), end(true)],
	},
	{
		name: "lowercase hex chunk size",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\na\r\n0123456789\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("0123456789"), end(true)],
	},
	{
		name: "eight hex digit chunk size is accepted",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n00000003\r\nabc\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abc"), end(true)],
	},
	{
		name: "trailer lines are accepted and ignored",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nExpires: never\r\nX-Trailer: 1\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abc"), end(true)],
	},
	{
		name: "trailer line without a colon is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n0\r\nBad trailer line\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), FAIL],
	},
	{
		name: "trailer section over maxHeaderBytes 1024 is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n0\r\nX-Pad: ${"a".repeat(1016)}\r\n\r\n`,
		maxHeaderBytes: 1024,
		expected: [head(200, "Transfer-Encoding", "chunked"), FAIL],
	},
	{
		name: "chunked response with no data ends at the terminator",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), end(true)],
	},
	{
		name: "invalid hex chunk size is a violation after delivered data",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\nG\r\nxyz\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abc"), FAIL],
	},
	{
		name: "chunk size with whitespace before the extension is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3 \r\nabc\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), FAIL],
	},
	{
		name: "nine hex digit chunk size is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n000000001\r\nA\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), FAIL],
	},
	{
		name: "chunk-size line over maxHeaderBytes 1024 is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3;${"x".repeat(1023)}\r\nabc\r\n0\r\n\r\n`,
		maxHeaderBytes: 1024,
		expected: [head(200, "Transfer-Encoding", "chunked"), FAIL],
	},
	{
		name: "chunk-size lines totalling exactly maxHeaderBytes are accepted: three 44-byte size lines and the 3-byte last-chunk line make 135 bytes",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n${paddedChunkBody(3, 40)}`,
		maxHeaderBytes: 135,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("xxx"), end(true)],
	},
	{
		name: "chunk-size lines totalling one byte over maxHeaderBytes are a budget violation: 135 bytes against a budget of 134, though each 44-byte line alone fits",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n${paddedChunkBody(3, 40)}`,
		maxHeaderBytes: 134,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("xxx"), FAIL],
	},
	{
		name: "missing CRLF after chunk data is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3\r\nabcX\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abc"), FAIL],
	},
	{
		name: "chunk data followed by CR and a non-LF byte is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n5\r\nhello\rX\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("hello"), FAIL],
	},
	{
		name: "bare LF ending a chunk-size line is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n5\nhello\r\n0\r\n\r\n`,
		expected: [head(200, "Transfer-Encoding", "chunked"), FAIL],
	},
	{
		name: "chunked close before the terminator ends incomplete",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n`,
		close: true,
		expected: [head(200, "Transfer-Encoding", "chunked"), body("abc"), end(false)],
	},
	{
		name: "close during the trailer section ends incomplete",
		input: `${OK}Transfer-Encoding: chunked\r\n\r\n0\r\nExpires: never\r\nX-Partial: 1`,
		close: true,
		expected: [head(200, "Transfer-Encoding", "chunked"), end(false)],
	},
	{
		name: "Transfer-Encoding with Content-Length is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\nabc`,
		expected: [FAIL],
	},
	{
		name: "Transfer-Encoding 'gzip, chunked' is a violation",
		input: `${OK}Transfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "Transfer-Encoding 'identity' is a violation",
		input: `${OK}Transfer-Encoding: identity\r\n\r\nabc`,
		expected: [FAIL],
	},
	{
		name: "duplicate Transfer-Encoding is a violation",
		input: `${OK}Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`,
		expected: [FAIL],
	},

	// Missing framing.
	{
		name: "neither framing header is a violation",
		input: `${OK}Server: x\r\n\r\nabc`,
		close: true,
		expected: [FAIL],
	},

	// Status line.
	{
		name: "status 100 is a violation",
		input: "HTTP/1.1 100 Continue\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "status 199 is a violation",
		input: "HTTP/1.1 199 Hint\r\nContent-Length: 0\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "status 101 is a violation",
		input: "HTTP/1.1 101 Switching Protocols\r\nContent-Length: 0\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "HTTP/2.0 status line is a violation",
		input: "HTTP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "status above 599 is a violation",
		input: "HTTP/1.1 600 Nope\r\nContent-Length: 0\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "status 599 is accepted with a valid body",
		input: "HTTP/1.1 599 Custom\r\nContent-Length: 2\r\n\r\nok",
		expected: [head(599, "Content-Length", "2"), body("ok"), end(true)],
	},
	{
		name: "four-digit status is a violation",
		input: "HTTP/1.1 2000 OK\r\nContent-Length: 0\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "bare LF ending the status line is a violation",
		input: "HTTP/1.1 200 OK\nContent-Length: 0\r\n\r\n",
		expected: [FAIL],
	},
	{
		name: "reason phrase with a control octet is a violation",
		input: `HTTP/1.1 200 O\u0001K\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "bare LF ending a header line is a violation",
		input: `${OK}X-A: b\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},

	// Header block.
	{
		name: "obsolete line folding is a violation",
		input: `${OK}X-A: b\r\n c\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "header name followed by space before the colon is a violation",
		input: `${OK}X A: b\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "header line without a colon is a violation",
		input: `${OK}X-A b\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "header line with an empty name is a violation",
		input: `${OK}: x\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "NUL inside a header value is a violation",
		input: `${OK}X-A: a\u0000b\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "bare CR inside a header value is a violation",
		input: `${OK}X-A: a\rb\r\nContent-Length: 0\r\n\r\n`,
		expected: [FAIL],
	},
	{
		name: "header block of exactly maxHeaderBytes is accepted",
		input: `${OK}Content-Length: 0\r\n\r\n`,
		maxHeaderBytes: 38,
		expected: [head(200, "Content-Length", "0"), end(true)],
	},
	{
		name: "header block over maxHeaderBytes is a violation",
		input: `${OK}Content-Length: 0\r\n\r\n`,
		maxHeaderBytes: 37,
		expected: [FAIL],
	},
	{
		name: "header block over maxHeaderBytes is a violation before the blank line arrives",
		input: `${OK}X-Long: ${"a".repeat(30)}`,
		maxHeaderBytes: 40,
		expected: [FAIL],
	},

	// Connection lifecycle.
	{
		name: "close during the header block is a violation",
		input: `${OK}Content-Len`,
		close: true,
		expected: [FAIL],
	},
	{
		name: "close before any bytes is a violation",
		input: "",
		close: true,
		expected: [FAIL],
	},
	{
		name: "head() returning false stops parsing silently, including on close",
		input: `${OK}Content-Length: 3\r\n\r\nabc`,
		accept: false,
		close: true,
		expected: [head(200, "Content-Length", "3")],
	},
];

const modes = [
	{ label: "whole input in one push", pushes: (bytes: Uint8Array) => [[bytes]] },
	{
		label: "one byte per push",
		pushes: (bytes: Uint8Array) => [Array.from(bytes, (_, i) => bytes.subarray(i, i + 1))],
	},
] as const;

describe("createHttp1Parser", () => {
	for (const scenario of scenarios) {
		describe(scenario.name, () => {
			const bytes = wire(scenario.input);

			for (const mode of modes) {
				test(mode.label, () => {
					for (const pushes of mode.pushes(bytes)) {
						expect(run(scenario, pushes)).toEqual([...scenario.expected]);
					}
				});
			}

			test("two pushes split at every byte offset", () => {
				for (let split = 0; split <= bytes.length; split++) {
					const pieces = [bytes.subarray(0, split), bytes.subarray(split)];
					expect({ split, events: run(scenario, pieces) }).toEqual({
						split,
						events: [...scenario.expected],
					});
				}
			});
		});
	}
});

describe("createHttp1Parser delivery", () => {
	test("chunked body bytes are delivered before the chunk completes", () => {
		const { sink, events } = recorder(true);
		const parser = createHttp1Parser(sink, { maxHeaderBytes: 1024 });

		parser.push(wire(`${OK}Transfer-Encoding: chunked\r\n\r\n5\r\nab`));
		expect(events).toEqual([head(200, "Transfer-Encoding", "chunked"), body("ab")]);

		parser.push(wire("cde\r\n0\r\n\r\n"));
		expect(events).toEqual([head(200, "Transfer-Encoding", "chunked"), body("abcde"), end(true)]);
	});

	test("no call is made after end(), fail() or a stopped head()", () => {
		const { sink, events } = recorder(true);
		const parser = createHttp1Parser(sink, { maxHeaderBytes: 1024 });
		parser.push(wire(`${OK}Content-Length: 1\r\n\r\nxy`));
		parser.push(wire("more"));
		parser.close();
		expect(events).toEqual([head(200, "Content-Length", "1"), body("x"), end(true)]);
	});

	test("a non-positive header budget is rejected at construction", () => {
		const { sink } = recorder(true);
		expect(() => createHttp1Parser(sink, { maxHeaderBytes: 0 })).toThrow(RangeError);
	});
});
