// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import type { CimdFailureCode } from "./cimd.ts";
import { cimdRedirectMatches, parseCimdDocument, validateCimdClientId } from "./cimd.ts";

describe("phase101 tracer", () => {
	const clientId = "https://client.example:443/meta.json";
	const redirect = "https://claude.ai/api/mcp/auth_callback?source=cimd&state=fixture";
	const allowedOrigins: ReadonlySet<string> = new Set(["https://claude.ai"]);
	const metadata = {
		client_id: clientId,
		redirect_uris: [redirect],
		token_endpoint_auth_method: "none",
		client_name: "Unverified fixture client",
	};
	const documentText = JSON.stringify(metadata);

	test("accepts supplied metadata and preserves raw identity and exact redirect query", () => {
		expect(validateCimdClientId(clientId)).toEqual({ valid: true, value: clientId });
		const result = parseCimdDocument(clientId, documentText, allowedOrigins);
		expect(result).toEqual({
			valid: true,
			value: {
				client_id: clientId,
				redirect_uris: [redirect],
				token_endpoint_auth_method: "none",
				metadata,
			},
		});
		if (!result.valid) throw new Error("Expected a complete validated document");
		expect(cimdRedirectMatches(result.value, redirect)).toBe(true);
		expect(cimdRedirectMatches(result.value, "https://claude.ai/api/mcp/auth_callback")).toBe(
			false,
		);
	});

	test("refuses a query-bearing expected identity before accepting its document", () => {
		const queryId = `${clientId}?source=fixture`;
		const identity = validateCimdClientId(queryId);
		expect(identity).toEqual({
			valid: false,
			refused: { field: "client_id", code: "INVALID_CLIENT_ID" },
		});
		expect(identity).not.toHaveProperty("value");
		const result = parseCimdDocument(queryId, documentText, allowedOrigins);
		expect(result).toEqual({
			valid: false,
			refused: { field: "client_id", code: "INVALID_CLIENT_ID" },
		});
		expect(result).not.toHaveProperty("value");
	});

	test("refuses a different associated identity even when only the default port differs", () => {
		const otherId = "https://client.example/meta.json";
		expect(validateCimdClientId(otherId)).toEqual({ valid: true, value: otherId });
		const result = parseCimdDocument(
			clientId,
			JSON.stringify({ ...metadata, client_id: otherId }),
			allowedOrigins,
		);
		expect(result).toEqual({
			valid: false,
			refused: { field: "client_id", code: "CLIENT_ID_MISMATCH" },
		});
		expect(result).not.toHaveProperty("value");
	});

	test("refuses the whole document when one redirect origin is not permitted", () => {
		const result = parseCimdDocument(
			clientId,
			JSON.stringify({
				...metadata,
				redirect_uris: [redirect, "https://outside.example/callback"],
			}),
			allowedOrigins,
		);
		expect(result).toEqual({
			valid: false,
			refused: { field: "redirect_uris", code: "INVALID_REDIRECT_URIS" },
		});
		expect(result).not.toHaveProperty("value");
	});

	test("does not match a requested redirect with a different path or query spelling", () => {
		const result = parseCimdDocument(clientId, documentText, allowedOrigins);
		expect(result.valid).toBe(true);
		if (!result.valid) throw new Error("Expected a complete validated document");
		expect(cimdRedirectMatches(result.value, redirect)).toBe(true);
		expect(
			cimdRedirectMatches(
				result.value,
				"https://claude.ai/other_callback?source=cimd&state=fixture",
			),
		).toBe(false);
		expect(
			cimdRedirectMatches(
				result.value,
				"https://claude.ai/api/mcp/auth_callback?state=fixture&source=cimd",
			),
		).toBe(false);
	});
});

describe("phase101 boundaries", () => {
	const clientId = "https://client.example/meta.json";
	const redirect = "https://claude.ai/callback";
	const origins: ReadonlySet<string> = new Set(["https://claude.ai"]);

	function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			client_id: clientId,
			redirect_uris: [redirect],
			token_endpoint_auth_method: "none",
			...overrides,
		};
	}

	function parse(metadata: Record<string, unknown>, expectedId = clientId, policy = origins) {
		return parseCimdDocument(expectedId, JSON.stringify(metadata), policy);
	}

	function accepted(metadata = fixture(), expectedId = clientId, policy = origins) {
		const redirectUris = metadata.redirect_uris;
		if (
			!Array.isArray(redirectUris) ||
			!redirectUris.every((uri): uri is string => typeof uri === "string")
		) {
			throw new Error("Expected a string-array redirect fixture");
		}
		const result = parse(metadata, expectedId, policy);
		expect(result).toEqual({
			valid: true,
			value: {
				client_id: expectedId,
				redirect_uris: redirectUris,
				token_endpoint_auth_method: "none",
				metadata,
			},
		});
		if (!result.valid) throw new Error("Expected a complete validated document");
		return result.value;
	}

	// Exact envelopes also forbid input echoes, extra error detail and partial values.
	function refused(result: unknown, field: string, code: CimdFailureCode) {
		expect(result).toEqual({ valid: false, refused: { field, code } });
		expect(result).not.toHaveProperty("value");
	}

	function validId(raw: string) {
		expect(validateCimdClientId(raw)).toEqual({ valid: true, value: raw });
		accepted(fixture({ client_id: raw }), raw);
	}

	function invalidId(raw: string) {
		refused(validateCimdClientId(raw), "client_id", "INVALID_CLIENT_ID");
		// All other fields are valid, so direct parsing cannot bypass ID validation.
		refused(parse(fixture({ client_id: raw }), raw), "client_id", "INVALID_CLIENT_ID");
	}

	test("ID-01: HTTPS syntax without case folding or authority repair", () => {
		for (const raw of [
			clientId,
			"HTTPS://CLIENT.example/meta.json",
			"https://client.example:8443/meta.json",
		]) {
			validId(raw);
		}
		for (const raw of [
			"http://client.example/meta.json",
			"ftp://client.example/meta.json",
			"//client.example/meta.json",
			"client.example/meta.json",
			"https:///meta.json",
			"https:/client.example/meta.json",
			"https://:443/meta.json",
			"https://[::1/meta.json",
			"https://client.example:65536/meta.json",
			"https://client.example:wrong/meta.json",
		]) {
			invalidId(raw);
		}
	});

	test("ID-02: an explicit path, including root or repeated slashes, is required", () => {
		for (const path of ["/", "/a", "/a/", "//a///b"]) {
			validId(`https://client.example${path}`);
		}
		for (const raw of ["https://client.example", "https://client.example:443"]) {
			invalidId(raw);
		}
	});

	test("ID-03: every raw userinfo form is forbidden, including empty @", () => {
		validId(clientId);
		for (const authority of [
			"user:pw@client.example",
			"user@client.example",
			"@client.example",
			":@client.example",
		]) {
			invalidId(`https://${authority}/meta.json`);
		}
	});

	test("ID-04: raw queries and fragments fail while encoded delimiters remain data", () => {
		validId(clientId);
		for (const suffix of ["?x=1", "?", "#section", "#"]) {
			invalidId(`${clientId}${suffix}`);
		}
		for (const path of ["/meta%3Fquery.json", "/meta%23fragment.json", "/%3f%23"]) {
			validId(`https://client.example${path}`);
		}
	});

	test("ID-05: dot-only segments fail before repair, not non-dot or encoded data", () => {
		for (const segment of [".", "..", "%2e", "%2E", ".%2E", "%2e.", "%2E%2e"]) {
			for (const path of [`/a/${segment}/b`, `/a/${segment}`, `/${segment}/`]) {
				invalidId(`https://client.example${path}`);
			}
		}
		for (const path of [
			"/file..json",
			"/.well-known/meta",
			"/.../meta",
			"/%252e/",
			"/%252e%252e/",
			"/%2F/",
			"/%2e%2f/meta",
			"/%3F%23%40/meta",
		]) {
			validId(`https://client.example${path}`);
		}
	});

	test("ID-06: raw whitespace, controls, backslashes and malformed escapes are not repaired", () => {
		for (const character of [" ", "\t", "\n", "\r", "\x00", "\x1f", "\x7f", "\u00a0"]) {
			for (const raw of [
				`${character}${clientId}`,
				`${clientId}${character}`,
				`https://client.example/a${character}b`,
			])
				invalidId(raw);
		}
		for (const raw of [
			"https:\\\\client.example\\meta.json",
			"https://client.example/a\\b",
			"https://",
			"https:///meta",
			"https://client.example/%",
			"https://client.example/%2",
			"https://client.example/%GG",
			"https://client.example/%2G",
		])
			invalidId(raw);
		for (const path of ["/a%20b", "/a%2Fb", "/%00%7f%5c", "/%252G"]) {
			validId(`https://client.example${path}`);
		}
	});

	test("ID-07: valid identity spellings mismatch in both directions, without an ID cap", () => {
		const pairs = [
			[clientId, "https://client.example:443/meta.json"],
			[clientId, "HTTPS://client.example/meta.json"],
			[clientId, "https://CLIENT.example/meta.json"],
			["https://client.example/a%2fb", "https://client.example/a%2Fb"],
			["https://client.example/%61", "https://client.example/a"],
			["https://client.example/caf\u00e9", "https://client.example/cafe\u0301"],
		] as const;
		for (const [left, right] of pairs) {
			const directions = [
				[left, right],
				[right, left],
			] as const;
			for (const [expectedId, documentId] of directions) {
				validId(expectedId);
				refused(
					parse(fixture({ client_id: documentId }), expectedId),
					"client_id",
					"CLIENT_ID_MISMATCH",
				);
			}
		}
		const longId = `https://client.example/${"a".repeat(300)}`;
		expect(longId.length).toBeGreaterThan(256);
		validId(longId);
	});

	test("ID-08: wrong and empty ID inputs fail; HTTPS loopback is syntax, not fetch permission", () => {
		for (const raw of [undefined, null, 0, false, {}, []]) {
			refused(validateCimdClientId(raw), "client_id", "INVALID_CLIENT_ID");
		}
		invalidId("");
		validId("https://127.0.0.1/meta.json");
		validId("https://[::1]/meta.json");
	});

	test("DOC-01: JSON syntax and root shape have distinct bounded refusals", () => {
		accepted();
		for (const text of ["", "{", "not-json", '{"client_id":', '{"client_id":"x",}']) {
			refused(parseCimdDocument(clientId, text, origins), "document", "INVALID_JSON");
		}
		for (const root of [null, [], "text", 42, true, false]) {
			refused(
				parseCimdDocument(clientId, JSON.stringify(root), origins),
				"document",
				"INVALID_DOCUMENT",
			);
		}
		refused(parse({}), "client_id", "INVALID_DOCUMENT");
	});

	test("DOC-02: own string identity is required and expected IDs are revalidated", () => {
		accepted();
		for (const value of [undefined, null, 0, false, [], {}]) {
			refused(parse(fixture({ client_id: value })), "client_id", "INVALID_DOCUMENT");
		}
		for (const value of ["", "https://other.example/meta", `${clientId}:443`]) {
			refused(parse(fixture({ client_id: value })), "client_id", "CLIENT_ID_MISMATCH");
		}
		// A nested or __proto__ JSON member cannot stand in for an own core field.
		refused(
			parse(fixture({ client_id: undefined, extension: { client_id: clientId } })),
			"client_id",
			"INVALID_DOCUMENT",
		);
		const inheritedLooking = JSON.stringify(fixture({ client_id: undefined }));
		refused(
			parseCimdDocument(
				clientId,
				`{"__proto__":{"client_id":${JSON.stringify(clientId)}},${inheritedLooking.slice(1)}`,
				origins,
			),
			"client_id",
			"INVALID_DOCUMENT",
		);
		for (const raw of [`${clientId}?`, "https://client.example", "https://@client.example/meta"]) {
			invalidId(raw);
		}
	});

	test("DOC-03: own case-sensitive secret prefixes are forbidden by presence, not truthiness", () => {
		accepted(
			fixture({
				Client_secret: "untrusted case-sensitive extension",
				x_client_secret: "unrelated extension",
				extension: { secret: "label", client_secret: "nested inert label" },
			}),
		);
		for (const field of ["client_secret", "client_secret_expires_at", "client_secret_extra"]) {
			for (const value of [null, 0, "", false, "private-fixture-value"]) {
				refused(parse(fixture({ [field]: value })), "client_secret", "FORBIDDEN_CREDENTIAL");
			}
		}
		refused(
			parse(fixture({ [`client_secret_${"x".repeat(300)}`]: "must-not-echo" })),
			"client_secret",
			"FORBIDDEN_CREDENTIAL",
		);
	});

	test("DOC-04: only explicit none is supported by the local AS profile", () => {
		accepted();
		for (const method of [
			undefined,
			null,
			0,
			false,
			[],
			{},
			"",
			"NONE",
			"client_secret_post",
			"client_secret_basic",
			"client_secret_jwt",
			"private_key_jwt",
			"unknown_method",
		]) {
			refused(
				parse(fixture({ token_endpoint_auth_method: method })),
				"token_endpoint_auth_method",
				"UNSUPPORTED_AUTH_METHOD",
			);
		}
	});

	test("DOC-05: inline JWK shape and private-member presence, without crypto or fetching", () => {
		accepted();
		for (const jwks of [
			{ keys: [] },
			{ keys: [{}] },
			{ keys: [{ kty: "RSA", n: "not-a-crypto-validation", e: "AQAB" }] },
			{ keys: [{ kty: "EC", crv: "fixture", x: "inert", y: "inert" }] },
			{ keys: [{ kty: "unknown-public-shape", extension: { d: "nested inert" } }] },
		]) {
			accepted(fixture({ jwks, jwks_uri: "https://unreachable.invalid/keys" }));
		}
		accepted(fixture({ jwks_uri: "https://unreachable.invalid/keys" }));
		for (const jwks of [
			null,
			[],
			"text",
			0,
			false,
			{},
			{ keys: null },
			{ keys: {} },
			{ keys: "text" },
			{ keys: 0 },
			{ keys: [null] },
			{ keys: [[]] },
			{ keys: ["text"] },
			{ keys: [0] },
			{ keys: [false] },
		]) {
			refused(parse(fixture({ jwks })), "jwks", "INVALID_DOCUMENT");
		}
		const publicKey = { kty: "RSA", n: "public-fixture", e: "AQAB" };
		for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
			for (const value of [null, 0, "", false, "private-fixture-value"]) {
				const key = { ...publicKey, [field]: value };
				refused(
					parse(fixture({ jwks: { keys: [publicKey, key] } })),
					"jwks",
					"FORBIDDEN_CREDENTIAL",
				);
			}
		}
		refused(parse(fixture({ jwks: { keys: [{ kty: "oct" }] } })), "jwks", "FORBIDDEN_CREDENTIAL");
	});
});
