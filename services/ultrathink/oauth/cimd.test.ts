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
		for (const raw of [clientId, "HTTPS://CLIENT.example/meta.json"]) {
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
			"https://client.example:8443/meta.json",
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

	test("ID-09: a percent sign in a client_id authority is refused, never decoded", () => {
		for (const raw of [
			"https://%63laude.ai/cb",
			"https://client%2Eexample/x",
			"https://%31%32%37.0.0.1/x",
		]) {
			invalidId(raw);
		}
		validId("https://client.example/%63laude");
	});

	test("ID-10: client_id authority is exactly host or host:443; other port spellings fail", () => {
		for (const raw of [
			"https://client.example:/meta.json",
			"https://client.example:0443/meta.json",
			"https://client.example:00443/meta.json",
			"https://client.example:000443/meta.json",
			"https://client.example:0/meta.json",
			"https://client.example:+443/meta.json",
			"https://[::1]:/meta.json",
			"https://[::1]:0443/meta.json",
		]) {
			invalidId(raw);
		}
		validId("https://client.example:443/meta.json");
		validId("https://[::1]:443/meta.json");
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

	test("DOC-03: own secret-prefixed members are refused case-insensitively, by presence", () => {
		accepted(
			fixture({
				x_client_secret: "unrelated extension",
				extension: { secret: "label", client_secret: "nested inert label" },
			}),
		);
		for (const field of [
			"client_secret",
			"client_secret_expires_at",
			"client_secret_extra",
			"Client_secret",
			"CLIENT_SECRET",
			"CLIENT_SECRET_JWT",
		]) {
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

	test("DOC-06: every redirect must pass; a bad first, middle or last member refuses all", () => {
		accepted();
		for (const redirectUris of [undefined, null, "", {}, 0, false, []]) {
			refused(
				parse(fixture({ redirect_uris: redirectUris })),
				"redirect_uris",
				"INVALID_REDIRECT_URIS",
			);
		}
		const other = "https://claude.ai/other";
		for (const bad of [null, 0, false, {}, [], "", "https://outside.example/callback"]) {
			for (const redirectUris of [
				[bad],
				[bad, redirect, other],
				[redirect, bad, other],
				[redirect, other, bad],
			]) {
				refused(
					parse(fixture({ redirect_uris: redirectUris })),
					"redirect_uris",
					"INVALID_REDIRECT_URIS",
				);
			}
		}
	});

	test("DOC-07: untrusted metadata cannot replace core; list order and duplicates survive", () => {
		const redirects = [
			redirect,
			...[1, 2, 3, 4, 5].map((n) => `https://claude.ai/cb${n}`),
			redirect,
		];
		const metadata = fixture({
			redirect_uris: redirects,
			client_name: `  Unverified <name> ${"n".repeat(130)}  `,
			grant_types: ["untrusted-grant"],
			response_types: ["untrusted-response"],
			valid: false,
			value: { client_id: "forged" },
			metadata: { redirect_uris: ["https://outside.example/forged"] },
			extension: { client_id: "forged", token_endpoint_auth_method: "private_key_jwt" },
		});
		const reordered = Object.fromEntries(Object.entries(metadata).reverse());
		const document = accepted(metadata);
		expect(accepted(reordered)).toEqual(document);
		expect(document.redirect_uris).toEqual(redirects);
		expect(document.redirect_uris.length).toBe(7);
		expect(document.client_id).toBe(clientId);
		expect(document.token_endpoint_auth_method).toBe("none");
		expect(cimdRedirectMatches(document, "https://outside.example/forged")).toBe(false);
		expect(accepted().metadata).not.toHaveProperty("grant_types");
		expect(accepted().metadata).not.toHaveProperty("response_types");
	});

	test("DOC-08: non-string document text is refused as INVALID_JSON before JSON.parse", () => {
		accepted();
		const text = JSON.stringify(fixture());
		for (const value of [[text], 42, null, {}, undefined]) {
			refused(
				parseCimdDocument(clientId, value as unknown as string, origins),
				"document",
				"INVALID_JSON",
			);
		}
	});

	test("DOC-09: repeated member names are refused at any depth, escaped or not", () => {
		const base = JSON.stringify(fixture({ client_name: "first" }));
		const withoutClose = base.slice(0, -1);
		for (const text of [
			// Top-level duplicate: JSON.parse would silently keep the later "none".
			`{"token_endpoint_auth_method":"client_secret_basic",${base.slice(1)}`,
			`${withoutClose},"extension":{"x":1,"x":2}}`,
			`${withoutClose},"list":[{"a":1,"a":2}]}`,
			// Escaped spelling of client_name: \u0063 decodes to "c".
			`${withoutClose},"\\u0063lient_name":"second"}`,
			`${withoutClose},"extension":{"\\u0061":1,"a":2}}`,
		]) {
			refused(parseCimdDocument(clientId, text, origins), "document", "INVALID_JSON");
		}
		// The same name in sibling objects, or in objects inside arrays, is not a duplicate.
		accepted(fixture({ extension: { a: 1, b: { a: 2 } }, list: [{ a: 1 }, { a: 2 }] }));
	});

	test("DOC-09 a non-object root with a repeated name keeps INVALID_DOCUMENT", () => {
		refused(
			parseCimdDocument(clientId, `[{"a":1,"a":2}]`, origins),
			"document",
			"INVALID_DOCUMENT",
		);
	});

	test("REDIR-01: required trusted normalized origins alone grant permission", () => {
		const providerOrigins = [
			"https://claude.ai",
			"https://claude.com",
			"https://grok.com",
			"https://console.x.ai",
		];
		const policy: ReadonlySet<string> = new Set(providerOrigins);
		for (const origin of providerOrigins) {
			accepted(fixture({ redirect_uris: [`${origin}/cb`] }), clientId, policy);
		}
		for (const raw of [
			"https://outside.example/cb",
			"https://claude.ai.evil.example/cb",
			"https://sub.claude.ai/cb",
			"https://claude.ai:8443/cb",
			"https://claude.ai@evil.example/cb",
			"https://evil.example@claude.ai/cb",
		]) {
			refused(
				parse(fixture({ redirect_uris: [raw] }), clientId, policy),
				"redirect_uris",
				"INVALID_REDIRECT_URIS",
			);
		}
		const custom: ReadonlySet<string> = new Set(["https://custom.example"]);
		accepted(fixture({ redirect_uris: ["https://custom.example/cb"] }), clientId, custom);
		refused(parse(fixture(), clientId, custom), "redirect_uris", "INVALID_REDIRECT_URIS");
		refused(parse(fixture(), clientId, new Set()), "redirect_uris", "INVALID_REDIRECT_URIS");
		// Metadata is not trusted policy, even when it names familiar permission keys.
		refused(
			parse(
				fixture({
					redirect_uris: ["https://outside.example/cb"],
					allowedRedirectOrigins: ["https://outside.example"],
					redirect_origins: ["https://outside.example"],
				}),
			),
			"redirect_uris",
			"INVALID_REDIRECT_URIS",
		);
		accepted(fixture({ redirect_uris: ["HTTPS://CLAUDE.AI:443/cb"] }));
	});

	test("REDIR-02: independent HTTPS rule rejects HTTP even with injected origin permission", () => {
		for (const host of ["localhost", "127.0.0.1", "[::1]", "claude.ai"]) {
			for (const port of ["", ":80", ":50000", ":61234"]) {
				const raw = `http://${host}${port}/cb`;
				const policy: ReadonlySet<string> = new Set([new URL(raw).origin]);
				refused(
					parse(fixture({ redirect_uris: [raw] }), clientId, policy),
					"redirect_uris",
					"INVALID_REDIRECT_URIS",
				);
			}
			const httpsOrigin = `https://${host}`;
			accepted(fixture({ redirect_uris: [`${httpsOrigin}/cb`] }), clientId, new Set([httpsOrigin]));
		}
	});

	test("REDIR-03: raw syntax and exact 2048/2049 UTF-16 length boundary", () => {
		for (const raw of [
			"https://claude.ai",
			"https://claude.ai/",
			`${redirect}?`,
			`${redirect}?state=fixture&next=%2F%3F%23`,
			"https://claude.ai/%20%2F%23%40",
			"https://claude.ai/%252e/%252G",
		]) {
			accepted(fixture({ redirect_uris: [raw] }));
		}
		for (const raw of [
			"",
			"not a URL",
			"//claude.ai/cb",
			"https:///cb",
			"https://user:pw@claude.ai/cb",
			"https://user@claude.ai/cb",
			"https://@claude.ai/cb",
			"https://:@claude.ai/cb",
			`${redirect}#`,
			`${redirect}#fragment`,
			` ${redirect}`,
			`${redirect} `,
			"https://claude.ai/a\\b",
			"https://claude.ai/a/../cb",
			"https://claude.ai/%2e/cb",
			"https://claude.ai/%",
			"https://claude.ai/%2",
			"https://claude.ai/%GG",
			"https://claude.ai/cb?q=%GG",
		]) {
			refused(parse(fixture({ redirect_uris: [raw] })), "redirect_uris", "INVALID_REDIRECT_URIS");
		}
		for (const character of ["\t", "\n", "\r", "\x00", "\x1f", "\x7f", "\u00a0"]) {
			refused(
				parse(fixture({ redirect_uris: [`https://claude.ai/a${character}b`] })),
				"redirect_uris",
				"INVALID_REDIRECT_URIS",
			);
		}
		const prefix = "https://claude.ai/";
		for (const data of ["a", "\u{1f600}"]) {
			const remaining = 2048 - prefix.length;
			const atLimit =
				prefix +
				data.repeat(Math.floor(remaining / data.length)) +
				"a".repeat(remaining % data.length);
			expect(atLimit.length).toBe(2048);
			accepted(fixture({ redirect_uris: [atLimit] }));
			const overLimit = `${atLimit}a`;
			expect(overLimit.length).toBe(2049);
			refused(
				parse(fixture({ redirect_uris: [overLimit] })),
				"redirect_uris",
				"INVALID_REDIRECT_URIS",
			);
		}
	});

	test("REDIR-04: percent-encoded redirect authorities are refused, never decoded", () => {
		const policy: ReadonlySet<string> = new Set(["https://claude.ai"]);
		for (const raw of [
			"https://%63laude.ai/cb",
			"https://claude%2Eai/cb",
			"https://%63laude.ai:443/cb",
		]) {
			refused(
				parse(fixture({ redirect_uris: [raw] }), clientId, policy),
				"redirect_uris",
				"INVALID_REDIRECT_URIS",
			);
		}
		accepted(fixture({ redirect_uris: ["https://claude.ai/%63allback"] }), clientId, policy);
	});

	test("MATCH-01: exact requested membership never canonicalizes, decodes or applies port exceptions", () => {
		const pairs = [
			[redirect, `${redirect}/`],
			[redirect, "https://claude.ai/other"],
			[redirect, "HTTPS://claude.ai/callback"],
			[redirect, "https://CLAUDE.AI/callback"],
			[redirect, "https://claude.ai:443/callback"],
			[redirect, "https://claude.ai:8443/callback"],
			[redirect, `${redirect}?`],
			[redirect, `${redirect}?x=1`],
			[redirect, `${redirect}suffix`],
			[redirect, "prefixhttps://claude.ai/callback"],
			["https://claude.ai/a%2fb", "https://claude.ai/a%2Fb"],
			["https://claude.ai/%61", "https://claude.ai/a"],
			[`${redirect}?a=1&b=2`, `${redirect}?b=2&a=1`],
			[`${redirect}?a=1`, `${redirect}?a=2`],
			[`${redirect}?q=a%20b`, `${redirect}?q=a+b`],
			["https://claude.ai/caf\u00e9", "https://claude.ai/cafe\u0301"],
		] as const;
		for (const [registered, requested] of pairs) {
			const document = accepted(fixture({ redirect_uris: [registered] }));
			expect(cimdRedirectMatches(document, registered)).toBe(true);
			expect(cimdRedirectMatches(document, requested)).toBe(false);
		}
		const document = accepted(fixture({ redirect_uris: [`${redirect}?`] }));
		expect(cimdRedirectMatches(document, `${redirect}?`)).toBe(true);
		expect(cimdRedirectMatches(document, redirect)).toBe(false);
		for (const requested of [null, undefined, 0, false, {}, [], ""]) {
			expect(cimdRedirectMatches(document, requested)).toBe(false);
		}
	});

	test("MATCH-02: the returned redirect list is a frozen copy, not the parsed metadata array", () => {
		const document = accepted(fixture({ redirect_uris: [redirect, "https://claude.ai/other"] }));
		const parsedRedirects = document.metadata.redirect_uris as string[];
		parsedRedirects.push("https://claude.ai/evil");
		parsedRedirects[0] = "https://claude.ai/replaced";
		expect(cimdRedirectMatches(document, "https://claude.ai/evil")).toBe(false);
		expect(cimdRedirectMatches(document, "https://claude.ai/replaced")).toBe(false);
		expect(cimdRedirectMatches(document, redirect)).toBe(true);
		expect(cimdRedirectMatches(document, "https://claude.ai/other")).toBe(true);
		expect(Object.isFrozen(document.redirect_uris)).toBe(true);
		expect(() => (document.redirect_uris as string[]).push("https://claude.ai/evil")).toThrow(
			TypeError,
		);
	});

	test("PURE-01: alternating identities, policies and lists remain synchronous and independent", () => {
		const otherId = "https://other.example:443/meta.json";
		const customRedirect = "https://custom.example/cb";
		const custom: ReadonlySet<string> = new Set(["https://custom.example"]);
		const empty: ReadonlySet<string> = new Set();
		const originalOrigins = [...origins];
		const originalCustom = [...custom];
		const otherMetadata = fixture({ client_id: otherId, redirect_uris: [customRedirect] });
		const otherText = JSON.stringify(otherMetadata);
		for (let iteration = 0; iteration < 4; iteration++) {
			validId(clientId);
			validId(otherId);
			const first = accepted();
			const second = accepted(otherMetadata, otherId, custom);
			expect(cimdRedirectMatches(first, redirect)).toBe(true);
			expect(cimdRedirectMatches(first, customRedirect)).toBe(false);
			expect(cimdRedirectMatches(second, customRedirect)).toBe(true);
			expect(cimdRedirectMatches(second, redirect)).toBe(false);
			refused(parse(otherMetadata, otherId, origins), "redirect_uris", "INVALID_REDIRECT_URIS");
			refused(parse(fixture(), clientId, custom), "redirect_uris", "INVALID_REDIRECT_URIS");
			refused(parse(fixture(), clientId, empty), "redirect_uris", "INVALID_REDIRECT_URIS");
			for (const redirects of [
				[redirect, "https://claude.ai/other", redirect],
				["https://claude.ai/other", redirect, redirect],
				[redirect, redirect, "https://claude.ai/other"],
			]) {
				const document = accepted(fixture({ redirect_uris: redirects }));
				for (const member of redirects) {
					expect(cimdRedirectMatches(document, member)).toBe(true);
				}
				expect(cimdRedirectMatches(document, "https://claude.ai/absent")).toBe(false);
			}
			expect(accepted()).toEqual(first);
			expect(accepted(otherMetadata, otherId, custom)).toEqual(second);
		}
		expect([...origins]).toEqual(originalOrigins);
		expect([...custom]).toEqual(originalCustom);
		expect([...empty]).toEqual([]);
		expect(JSON.stringify(otherMetadata)).toBe(otherText);
	});
});
