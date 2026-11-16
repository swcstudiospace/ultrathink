// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { clientLogFields } from "./router.ts";

describe("clientLogFields", () => {
	test("client IDs that share their first 600 characters get distinct digests", () => {
		const prefix = "https://client.example/".padEnd(600, "a");
		expect(clientLogFields(`${prefix}x`).clientIdDigest).not.toBe(
			clientLogFields(`${prefix}y`).clientIdDigest,
		);
	});

	test("a short client ID gets a 16-character lowercase hex digest", () => {
		expect(clientLogFields("client-a").clientIdDigest).toMatch(/^[0-9a-f]{16}$/);
	});

	test("clientId is returned unchanged", () => {
		const id = "https://client.example/metadata.json";
		expect(clientLogFields(id).clientId).toBe(id);
	});
});
