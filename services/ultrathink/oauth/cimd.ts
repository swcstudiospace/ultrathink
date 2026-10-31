// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Pure CIMD validation over supplied text: no I/O, registration or OAuth runtime state.
// URL parsing establishes syntax/origin permission only, never a canonical client identity.

export type CimdFailureCode =
	| "INVALID_CLIENT_ID"
	| "INVALID_JSON"
	| "INVALID_DOCUMENT"
	| "CLIENT_ID_MISMATCH"
	| "FORBIDDEN_CREDENTIAL"
	| "UNSUPPORTED_AUTH_METHOD"
	| "INVALID_REDIRECT_URIS";

export type CimdResult<T> =
	| { readonly valid: true; readonly value: T }
	| {
			readonly valid: false;
			readonly refused: { readonly field: string; readonly code: CimdFailureCode };
	  };

export interface CimdDocument {
	readonly client_id: string;
	readonly redirect_uris: readonly string[];
	readonly token_endpoint_auth_method: "none";
	/** Original parsed metadata is untrusted; validate extensions at their consumption boundary. */
	readonly metadata: Readonly<Record<string, unknown>>;
}

const MAX_REDIRECT_URI_CHARS = 2048;
const UNSAFE_URL_CHARACTERS = /[\s\x00-\x1f\x7f\\]/;
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;
const HTTPS_COMPONENTS = /^https:\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?$/i;
const DOT_PATH_COMPONENT = /\/(?:\.|%2e){1,2}(?:\/|$)/i;
const PRIVATE_JWK_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"] as const;

type CimdFailureField =
	| "client_id"
	| "document"
	| "client_secret"
	| "token_endpoint_auth_method"
	| "jwks"
	| "redirect_uris";

function refuse(field: CimdFailureField, code: CimdFailureCode): CimdResult<never> {
	return { valid: false, refused: { field, code } };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Preserve lexical evidence that URL parsing would otherwise repair or erase. */
function parseHttpsUrl(raw: string, pathRequired: boolean): URL | null {
	if (UNSAFE_URL_CHARACTERS.test(raw) || MALFORMED_ESCAPE.test(raw) || raw.includes("#")) {
		return null;
	}
	const parts = HTTPS_COMPONENTS.exec(raw);
	if (parts === null || parts[1]?.includes("@")) return null;
	const path = parts[2];
	if (pathRequired && path === undefined) return null;
	if (path !== undefined && DOT_PATH_COMPONENT.test(path)) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.hostname === "" ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== ""
	) {
		return null;
	}
	return url;
}

/** Validate syntax without fetching; success retains exact case, escapes and explicit ports. */
export function validateCimdClientId(raw: unknown): CimdResult<string> {
	if (
		typeof raw !== "string" ||
		raw.includes("?") ||
		parseHttpsUrl(raw, true) === null
	) {
		return refuse("client_id", "INVALID_CLIENT_ID");
	}
	return { valid: true, value: raw };
}

function inlineJwksFailure(
	jwks: unknown,
): "INVALID_DOCUMENT" | "FORBIDDEN_CREDENTIAL" | null {
	if (!isObject(jwks) || !Object.hasOwn(jwks, "keys") || !Array.isArray(jwks.keys)) {
		return "INVALID_DOCUMENT";
	}
	for (const key of jwks.keys) {
		if (!isObject(key)) return "INVALID_DOCUMENT";
		if (Object.hasOwn(key, "kty") && key.kty === "oct") return "FORBIDDEN_CREDENTIAL";
		for (const member of PRIVATE_JWK_MEMBERS) {
			if (Object.hasOwn(key, member)) return "FORBIDDEN_CREDENTIAL";
		}
	}
	return null;
}

function redirectAllowed(raw: unknown, allowedOrigins: ReadonlySet<string>): raw is string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REDIRECT_URI_CHARS) {
		return false;
	}
	const url = parseHttpsUrl(raw, false);
	return url !== null && allowedOrigins.has(url.origin);
}

/**
 * Accept a complete supplied document or a bounded, non-echoing refusal, never a partial client.
 * Explicit auth method none is our local AS profile, not a draft MUST or DCR omission default.
 * Origins must be normalized trusted caller policy; metadata grants no permissions. Inline
 * public JWK metadata stays inert: this performs no key authentication or jwks_uri fetching.
 * Readonly describes the TypeScript contract, not deep freezing or metadata provenance.
 */
export function parseCimdDocument(
	clientId: string,
	documentText: string,
	allowedRedirectOrigins: ReadonlySet<string>,
): CimdResult<CimdDocument> {
	const identity = validateCimdClientId(clientId);
	if (!identity.valid) return identity;
	let metadata: unknown;
	try {
		metadata = JSON.parse(documentText);
	} catch {
		return refuse("document", "INVALID_JSON");
	}
	if (!isObject(metadata)) return refuse("document", "INVALID_DOCUMENT");
	if (!Object.hasOwn(metadata, "client_id") || typeof metadata.client_id !== "string") {
		return refuse("client_id", "INVALID_DOCUMENT");
	}
	if (metadata.client_id !== clientId) return refuse("client_id", "CLIENT_ID_MISMATCH");
	for (const field of Object.keys(metadata)) {
		if (field.startsWith("client_secret")) return refuse("client_secret", "FORBIDDEN_CREDENTIAL");
	}
	if (
		!Object.hasOwn(metadata, "token_endpoint_auth_method") ||
		metadata.token_endpoint_auth_method !== "none"
	) {
		return refuse("token_endpoint_auth_method", "UNSUPPORTED_AUTH_METHOD");
	}
	if (Object.hasOwn(metadata, "jwks")) {
		const failure = inlineJwksFailure(metadata.jwks);
		if (failure !== null) return refuse("jwks", failure);
	}
	const redirectUris: unknown = metadata.redirect_uris;
	if (
		!Object.hasOwn(metadata, "redirect_uris") ||
		!Array.isArray(redirectUris) ||
		redirectUris.length === 0 ||
		!redirectUris.every((raw): raw is string => redirectAllowed(raw, allowedRedirectOrigins))
	) {
		return refuse("redirect_uris", "INVALID_REDIRECT_URIS");
	}
	return {
		valid: true,
		value: {
			client_id: identity.value,
			redirect_uris: redirectUris,
			token_endpoint_auth_method: "none",
			metadata,
		},
	};
}

/** Match only an identical validated redirect string, without URL or DCR loopback fallback. */
export function cimdRedirectMatches(document: CimdDocument, requested: unknown): boolean {
	return typeof requested === "string" && document.redirect_uris.some((uri) => uri === requested);
}
