// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
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
		expect(
			cimdRedirectMatches(result.value, "https://claude.ai/api/mcp/auth_callback"),
		).toBe(false);
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
