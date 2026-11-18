// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type HttpFetch, type HttpRequestInit, httpTarget } from "./observe.ts";

const BASE = "http://127.0.0.1:9/prefix";

describe("httpTarget origin guard", () => {
	test("refuses a path that resolves to another origin, before any fetch", async () => {
		const calls: Array<{ url: string; init: HttpRequestInit }> = [];
		const fake: HttpFetch = async (url, init) => {
			calls.push({ url, init });
			return new Response("");
		};
		const target = httpTarget(BASE, { fetch: fake });
		await expect(target.request("POST", "/https://attacker.example/x", { a: 1 })).rejects.toThrow(
			TypeError,
		);
		await expect(target.request("POST", "/\\/attacker.example/x", { a: 1 })).rejects.toThrow(
			TypeError,
		);
		expect(calls).toHaveLength(0);
	});

	test("refuses an off-origin path even when mTLS material is configured", async () => {
		const calls: Array<{ url: string; init: HttpRequestInit }> = [];
		const fake: HttpFetch = async (url, init) => {
			calls.push({ url, init });
			return new Response("");
		};
		const target = httpTarget("https://127.0.0.1:9", {
			fetch: fake,
			tls: { ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" },
		});
		await expect(target.request("GET", "/\\\\attacker.example/x")).rejects.toThrow(TypeError);
		expect(calls).toHaveLength(0);
	});

	test("an ordinary path still reaches the configured origin", async () => {
		const calls: Array<{ url: string; init: HttpRequestInit }> = [];
		const fake: HttpFetch = async (url, init) => {
			calls.push({ url, init });
			return new Response("ok");
		};
		const target = httpTarget(BASE, { fetch: fake });
		const response = await target.request("GET", "/readyz");
		expect(response.text).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:9/prefix/readyz");
	});
});
