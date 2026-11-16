// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { DEFAULT_PROTOCOL_VERSION, TRANSPORT_PROTOCOL_VERSIONS } from "./mcp.ts";

/** Browser origins of the hosted clients that may call /mcp. The service's own origin is added by the router. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
	"https://claude.ai",
	"https://claude.com",
	"https://grok.com",
	"https://console.x.ai",
];

/** Lower-cased scheme, host and non-default port of an http(s) origin, or null when the value is not one. */
function normalizeOrigin(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		return null;
	}
	return url.origin;
}

/**
 * DNS-rebinding guard for /mcp. A request without an Origin (native and server-side clients) is allowed;
 * a browser always sends one. The literal "null" (sandboxed or opaque origin) and any value that does not
 * normalize to an allowed origin are refused.
 */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
	if (origin === null || origin === "") return true;
	const normalized = normalizeOrigin(origin);
	if (normalized === null) return false;
	return allowed.some((entry) => normalizeOrigin(entry) === normalized);
}

/** The version in the MCP-Protocol-Version header. An absent header means the oldest supported version. */
export function resolveProtocolVersion(
	header: string | null,
): { ok: true; version: string } | { ok: false } {
	if (header === null) return { ok: true, version: DEFAULT_PROTOCOL_VERSION };
	const version = TRANSPORT_PROTOCOL_VERSIONS.find((supported) => supported === header);
	return version === undefined ? { ok: false } : { ok: true, version };
}

type ModernValidationError = { id: string | number; code: -32602 | -32020; message: string };

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the case-sensitive sentinel once; reject noncanonical Base64 and invalid UTF-8. */
function decodeName(value: string): string | null {
	if (!value.startsWith("=?base64?") || !value.endsWith("?="))
		return /^[\x20-\x7e]*$/.test(value) ? value : null;
	const encoded = value.slice(9, -2);
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
		return null;
	try {
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.toString("base64") !== encoded) return null;
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

/**
 * Validate only well-formed request envelopes; the core handles batches, invalid envelopes,
 * client responses and notifications. Metadata-first precedence is a local choice, not a spec rule.
 */
export function validateModernRequest(
	payload: unknown,
	headers: Headers,
): ModernValidationError | null {
	if (!record(payload) || payload.jsonrpc !== "2.0" || typeof payload.method !== "string")
		return null;
	const id = payload.id;
	if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) return null;
	// Leave invalid envelopes to the core; requests with IDs always require validation.
	if (
		(typeof id === "string" && (id.length > 256 || /[\x00-\x1f\x7f]/.test(id))) ||
		payload.method.length > 128 ||
		/[\x00-\x1f\x7f]/.test(payload.method)
	)
		return null;
	const params = record(payload.params) ? payload.params : {};
	const meta = record(params._meta) ? params._meta : {};
	const version = meta["io.modelcontextprotocol/protocolVersion"];
	if (typeof version !== "string" || !record(meta["io.modelcontextprotocol/clientCapabilities"])) {
		return { id, code: -32602, message: "invalid params" };
	}
	const mismatch = { id, code: -32020, message: "header mismatch" } as const;
	if (
		headers.get("mcp-protocol-version") !== version ||
		headers.get("mcp-method") !== payload.method
	)
		return mismatch;
	const field =
		payload.method === "resources/read"
			? "uri"
			: payload.method === "tools/call" || payload.method === "prompts/get"
				? "name"
				: null;
	if (field !== null) {
		const name = headers.get("mcp-name");
		if (name === null || typeof params[field] !== "string" || decodeName(name) !== params[field])
			return mismatch;
	}
	return null;
}
