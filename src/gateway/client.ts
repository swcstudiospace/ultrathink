// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One JSON-RPC `tools/call` per desk tool. The desk contract is a single POST to
 * `<url>/mcp/<seat>`, not the streaming MCP session in `src/mcp/client.ts` (initialize,
 * notifications, SSE relay). The SSE event parser is shared with that session (`src/mcp/sse.ts`). The tool
 * envelope is parsed here, not shared: `src/mcp/client.ts` `unwrapToolResult` throws on `isError`, while this
 * client classifies it. Both use the shared HTTP helper (`requestJson`: hard budget, no redirects, redacted errors).
 */
import { requestJson } from "../net/http.ts";
import { createSseParser } from "../mcp/sse.ts";
import { redactSecrets } from "../redact.ts";
import type { GatewayCallResult, GatewayFailure } from "./types.ts";
import { collapseWhitespace, isRecord } from "../shared.ts";

const MAX_REASON = 200;

export interface GatewayClientOptions {
	/** Normalized gateway origin (no trailing slash). */
	url: string;
	seat: string;
	token: string;
	timeoutMs: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

interface ToolPayload {
	payload: Record<string, unknown>;
	isError: boolean;
}

/** Caps a collapsed, redacted reason at MAX_REASON; the cut is marked with `...`. */
function capReason(line: string): string {
	return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 3)}...` : line;
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** A JSON body, or the last SSE event's `data:` record from a streamable-HTTP response. */
function rpcMessage(json: unknown, text: string): Record<string, unknown> | undefined {
	if (isRecord(json)) return json;
	const events: string[] = [];
	const parser = createSseParser((data) => {
		events.push(data);
	});
	parser.push(text);
	parser.end();
	const last = events.filter((data) => data !== "[DONE]").at(-1);
	return last === undefined ? undefined : jsonRecord(last);
}

function toolPayload(
	message: Record<string, unknown>,
	token: string,
): ToolPayload | GatewayFailure {
	if (isRecord(message.error)) {
		const code =
			typeof message.error.message === "string" ? message.error.message : "request failed";
		const unknown = code.includes("unknown_tool");
		return {
			kind: unknown ? "unready" : "degraded",
			reason: capReason(collapseWhitespace(redactSecrets(code, token))),
		};
	}
	const result = isRecord(message.result) ? message.result : message;
	const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
	let payload = structured;
	if (!payload) {
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find(
			(item) => isRecord(item) && item.type === "text" && typeof item.text === "string",
		);
		const raw = isRecord(text) && typeof text.text === "string" ? text.text : undefined;
		payload = raw
			? (jsonRecord(raw) ?? { text: raw })
			: isRecord(result) && !("content" in result)
				? result
				: {};
	}
	return { payload, isError: result.isError === true };
}

function classify(
	payload: Record<string, unknown>,
	isError: boolean,
	token: string,
): GatewayFailure | undefined {
	const error = typeof payload.error === "string" ? payload.error : "";
	const reason = typeof payload.reason === "string" ? payload.reason : error;
	if (error === "unknown_tool")
		return {
			kind: "unready",
			reason: capReason(
				collapseWhitespace(redactSecrets(`unready: unknown_tool: ${reason}`, token)),
			),
		};
	if (error === "not_configured" || payload.state === "not_configured") {
		return {
			kind: "degraded",
			reason: capReason(
				collapseWhitespace(redactSecrets(`degraded: not_configured: ${reason}`, token)),
			),
		};
	}
	if (error || isError)
		return {
			kind: "degraded",
			reason: capReason(
				collapseWhitespace(
					redactSecrets(`degraded: ${error || "error"}: ${reason || "gateway tool error"}`, token),
				),
			),
		};
	return undefined;
}

/** The error kind an adapter reports for a gateway failure, decided by the typed kind alone and never by the reason text. */
export function gatewayErrorKind(
	failure: GatewayFailure,
): "timeout" | "network" | "not-found" | "server" {
	switch (failure.kind) {
		case "timeout":
			return "timeout";
		case "network":
			return "network";
		case "unready":
			return "not-found";
		case "degraded":
			return "server";
	}
}

export function createGatewayClient(options: GatewayClientOptions): {
	/** Top-level `error` / `isError` is already classified. Nested per-bank errors stay in the payload. */
	call(
		name: string,
		args: Record<string, unknown>,
	): Promise<GatewayCallResult<Record<string, unknown>>>;
} {
	const endpoint = `${options.url}/mcp/${options.seat}`;
	return {
		async call(
			name: string,
			args: Record<string, unknown>,
		): Promise<GatewayCallResult<Record<string, unknown>>> {
			const outcome = await requestJson(endpoint, {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					Authorization: `Bearer ${options.token}`,
				},
				body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
				timeoutMs: options.timeoutMs,
				signal: options.signal,
				fetch: options.fetch,
			});
			if (outcome.kind === "timeout")
				return {
					ok: false,
					kind: "timeout",
					reason: `degraded: timeout after ${options.timeoutMs}ms`,
				};
			if (outcome.kind === "network")
				return {
					ok: false,
					kind: "network",
					reason: capReason(
						collapseWhitespace(redactSecrets(`degraded: ${outcome.message}`, options.token)),
					),
				};
			if (outcome.status < 200 || outcome.status >= 300) {
				return {
					ok: false,
					kind: "degraded",
					reason: capReason(
						collapseWhitespace(
							redactSecrets(`degraded: gateway HTTP ${outcome.status}`, options.token),
						),
					),
				};
			}
			const message = rpcMessage(outcome.json, outcome.text);
			if (!message)
				return { ok: false, kind: "degraded", reason: "degraded: gateway response was not JSON" };
			const parsed = toolPayload(message, options.token);
			if ("kind" in parsed) return { ok: false, ...parsed };
			const failure = classify(parsed.payload, parsed.isError, options.token);
			if (failure) return { ok: false, ...failure };
			return { ok: true, value: parsed.payload };
		},
	};
}
