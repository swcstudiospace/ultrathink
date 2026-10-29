// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { readBodyPrefix, readBodyText, readJsonBody } from "./body.ts";
import { redactText } from "../../../src/teach/redact.ts";

const encoder = new TextEncoder();

function bodyOf(chunks: string[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
	);
}

describe("body readers", () => {
	test("reads a body within the limit completely", async () => {
		expect(await readBodyPrefix(bodyOf(["hel", "lo"]), 10)).toEqual({
			text: "hello",
			complete: true,
		});
	});

	test("keeps only the prefix when the body exceeds the limit", async () => {
		expect(await readBodyPrefix(bodyOf(["hello", "world"]), 7)).toEqual({
			text: "hellowo",
			complete: false,
		});
	});

	test("readBodyText throws when the body exceeds the limit", async () => {
		await expect(readBodyText(bodyOf(["hello", "world"]), 7)).rejects.toThrow("exceeds limit");
	});

	test("readJsonBody parses a body within the limit", async () => {
		expect(await readJsonBody<{ a: number }>(bodyOf(['{"a":', "1}"]), 20)).toEqual({ a: 1 });
	});

	test("rejects a pending read promptly when the signal aborts", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				// Never produces data, so the read stays pending until the signal aborts.
				return new Promise(() => {
					// reason: the promise never settles; the abort, not a value, ends this read.
				});
			},
			cancel() {
				cancelled = true;
			},
		});
		const reason = new Error("client went away");
		const controller = new AbortController();
		const pending = readBodyPrefix(new Response(stream), 100, controller.signal);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(cancelled).toBe(true);
	});

	test("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("already gone");
		controller.abort(reason);
		await expect(readBodyPrefix(bodyOf(["hello"]), 10, controller.signal)).rejects.toBe(reason);
	});
});

describe("body boundary failures", () => {
	const SECRET = "sk-test-FIXTURE0000000000000000";

	test("an oversized body is refused under readBodyText without its text", async () => {
		const error = await readBodyText(bodyOf([SECRET]), 7).catch((caught: unknown) => caught);
		const message = error instanceof Error ? error.message : "";
		expect(message.startsWith("readBodyText: ")).toBe(true);
		expect(message).not.toContain(SECRET);
		expect(redactText(message, { home: "" })).toBe(message);
	});

	test("a body that is not JSON is refused under readJsonBody without its text", async () => {
		const error = await readJsonBody(bodyOf([`{"token": "${SECRET}"`]), 100).catch(
			(caught: unknown) => caught,
		);
		const message = error instanceof Error ? error.message : "";
		expect(message).toBe("readJsonBody: invalid JSON (SyntaxError)");
		expect(message).not.toContain(SECRET);
		expect(redactText(message, { home: "" })).toBe(message);
	});
});
