// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Pins hosted clients' legacy fallback behavior alongside modern discovery.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { createLogger } from "../obs/log.ts";
import { type Store, openStore } from "../store/store.ts";
import { type App, createApp } from "./router.ts";

const ORIGIN = "https://ultrathink.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PEER = "127.0.0.1";
const CONNECTOR_KEY = randomBytes(24).toString("hex");
const OWNER_PASSWORD = randomBytes(24).toString("base64url");
const OWNER_HASH = await Bun.password.hash(OWNER_PASSWORD);
const SESSION_SECRET = randomBytes(32).toString("hex");

type Json = Record<string, unknown>;
type LogLine = Record<string, unknown>;
type RpcBody = {
	jsonrpc?: string;
	id?: unknown;
	result?: Json;
	error?: { code: number; message: string };
};

const dirs: string[] = [];
const stores: Store[] = [];

afterAll(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// reason: already closed
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	app: App;
	logs: LogLine[];
	store: Store;
	dir: string;
}

function harness(overrides: Partial<UltrathinkConfig> = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-compat-"));
	dirs.push(dir);
	const config: UltrathinkConfig = {
		publicOrigin: ORIGIN,
		ownerPasswordHash: OWNER_HASH,
		sessionSecret: SESSION_SECRET,
		stateDir: dir,
		dbPath: join(dir, "ultrathink.db"),
		port: 0,
		maxInputChars: 8000,
		maxAnswerChars: 20000,
		maxBodyBytes: 65536,
		runTokenCeiling: 5_000_000,
		dailyTokenCeiling: 50_000_000,
		planningModel: "claude-haiku-5-5",
		connectorKey: CONNECTOR_KEY,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		legacyEnvIgnored: [],
		serverPlanning: false,
		maxConcurrentPlans: 2,
		modelTimeoutMs: 5000,
		planTimeoutMs: 60_000,
		modelMaxOutputTokens: 1000,
		sessionSecretPrevious: [],
		breakerFailures: 5,
		breakerWindowMs: 60000,
		breakerOpenMs: 30000,
		maxInflight: 256,
		drainMs: 5000,
		retentionDays: 30,
		auditLog: true,
		auditAnchorEvery: 1000,
		auditSegmentBytes: 67108864,
		auditRetentionDays: 365,
		auditWatchMs: 1000,
		auditSinkQueue: 10000,
		priorityReservePct: 25,
		fairQueueDepth: 16,
		fairQueueWaitMs: 1500,
		adaptiveQuotaMinPct: 50,
		lagTargetMs: 100,
		replicaCapacityRps: 20,
		abuseFailuresPerMinute: 20,
		penaltyBaseSec: 60,
		penaltyMaxSec: 3600,
		tls: undefined,
		spiffeTrustDomain: "ultrathink.internal",
		plaintextLoopback: true,
		chaosEnabled: false,
		...overrides,
	};
	const store = openStore(config.dbPath);
	stores.push(store);
	const auth = createAuth({
		ownerPasswordHash: OWNER_HASH,
		sessionSecret: SESSION_SECRET,
		cookieSecure: true,
	});
	const logs: LogLine[] = [];
	const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) });
	return { app: createApp({ config, store, auth, logger }), logs, store, dir };
}

/** A /mcp POST whose body is sent exactly as given, so a test can send something that is not JSON. */
function post(
	h: Harness,
	rawBody: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return h.app.handle(
		new Request(RESOURCE, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY, ...headers },
			body: rawBody,
		}),
		PEER,
	);
}

function rpc(h: Harness, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return post(h, JSON.stringify(body), headers);
}

function initialize(protocolVersion: string): Json {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion, capabilities: {}, clientInfo: { name: "probe", version: "0" } },
	};
}

async function body(response: Response): Promise<RpcBody> {
	return (await response.json()) as RpcBody;
}

async function jsonOf(response: Response): Promise<Json> {
	return (await response.json()) as Json;
}

function requestLogs(h: Harness): LogLine[] {
	return h.logs.filter((line) => line.event === "request");
}

let ipSeq = 0;

// Registration, authorize and token calls are limited per IP, so each call gets its own peer.
function freshIp(): string {
	ipSeq += 1;
	return `198.19.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function registerBody(h: Harness, fields: Json): Promise<Response> {
	return h.app.handle(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(fields),
		}),
		freshIp(),
	);
}

async function issueAccessToken(h: Harness): Promise<string> {
	const registered = await registerBody(h, {
		client_name: "Test client",
		redirect_uris: [REDIRECT],
	});
	expect(registered.status).toBe(201);
	const registeredBody = await jsonOf(registered);
	const clientId = String(registeredBody.client_id);
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: RESOURCE,
		state: "state-1",
	});
	const consent = await h.app.handle(
		new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`),
		freshIp(),
	);
	expect(consent.status).toBe(200);
	const html = await consent.text();
	const requestId = /name="req" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
	expect(requestId).not.toBe("");
	const granted = await h.app.handle(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ req: requestId, nonce, password: OWNER_PASSWORD }).toString(),
		}),
		freshIp(),
	);
	const code = new URL(granted.headers.get("location") ?? "").searchParams.get("code") ?? "";
	expect(code).not.toBe("");
	const tokens = await h.app.handle(
		new Request(`${ORIGIN}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: REDIRECT,
				resource: RESOURCE,
			}).toString(),
		}),
		freshIp(),
	);
	expect(tokens.status).toBe(200);
	const tokenBody = await jsonOf(tokens);
	return String(tokenBody.access_token);
}

describe("protocol version header", () => {
	const WIRE_BODY = {
		jsonrpc: "2.0",
		error: { code: -32600, message: "unsupported MCP-Protocol-Version" },
		id: null,
	};

	test("authenticated modern discovery advertises the actual server capabilities", async () => {
		const h = harness();
		const response = await rpc(
			h,
			{
				jsonrpc: "2.0",
				id: "discover-modern",
				method: "server/discover",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			},
			{ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" },
		);
		expect(response.status).toBe(200);
		const answer = await body(response);
		expect(answer.id).toBe("discover-modern");
		expect(answer.result).toMatchObject({
			resultType: "complete",
			supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
			capabilities: {
				tools: {},
				prompts: {},
				resources: {},
				extensions: { "io.modelcontextprotocol/ui": {} },
			},
			_meta: {
				"io.modelcontextprotocol/serverInfo": { name: "ultrathink", version: expect.any(String) },
			},
			instructions: expect.any(String),
			ttlMs: 0,
			cacheScope: "private",
		});
	});

	test("an unsupported MCP-Protocol-Version is answered 400 / -32600, never -32022, whatever the method", async () => {
		const h = harness();
		const probes = [
			{
				jsonrpc: "2.0",
				id: "server-discover-probe-1",
				method: "server/discover",
				params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
			},
			initialize("2026-07-28"),
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		];
		for (const version of ["2024-11-05", "2025-12-01"]) {
			for (const probe of probes) {
				const response = await rpc(h, probe, {
					"MCP-Protocol-Version": version,
					"Mcp-Method": "server/discover",
				});
				expect(response.status).toBe(400);
				const answer = await body(response);
				expect(answer).toEqual(WIRE_BODY);
				expect(answer.error?.code).toBe(-32600);
				expect(answer.error?.code).not.toBe(-32022);
			}
		}
	});

	test("the answer is the same when the body is not JSON or is larger than the body limit", async () => {
		const h = harness({ maxBodyBytes: 256 });
		const headers = { "MCP-Protocol-Version": "2025-12-01" };
		for (const raw of [
			"not json {",
			"",
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(2048) } }),
		]) {
			const response = await post(h, raw, headers);
			expect(response.status).toBe(400);
			expect(await body(response)).toEqual(WIRE_BODY);
		}
	});

	test("initialize with an unknown requested version answers 200 with the newest supported one, and 2025-03-26 is echoed", async () => {
		const h = harness();
		for (const requested of ["2026-07-28", "2024-11-05", "not-a-version"]) {
			const response = await rpc(h, initialize(requested));
			expect(response.status).toBe(200);
			expect((await body(response)).result?.protocolVersion).toBe("2025-11-25");
		}
		const echoed = await rpc(h, initialize("2025-03-26"));
		expect(echoed.status).toBe(200);
		expect((await body(echoed)).result?.protocolVersion).toBe("2025-03-26");
	});

	test("server/discover without a version header is a 200 -32601 that echoes the id and names no protocol revision", async () => {
		const h = harness();
		const response = await rpc(h, {
			jsonrpc: "2.0",
			id: "server-discover-probe-1",
			method: "server/discover",
			params: {},
		});
		expect(response.status).toBe(200);
		const answer = await body(response);
		expect(answer.id).toBe("server-discover-probe-1");
		expect(answer.result).toBeUndefined();
		expect(answer.error?.code).toBe(-32601);
		expect(answer.error?.message).toBe("method not found");
		// A message that names a modern revision flips some clients' verdict on what the server is.
		expect(answer.error?.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(JSON.stringify(answer)).not.toContain("2026");
	});
});

describe("modern request validation", () => {
	const version = "2026-07-28";
	const meta = {
		"io.modelcontextprotocol/protocolVersion": version,
		"io.modelcontextprotocol/clientCapabilities": {},
	};
	const headers = { "MCP-Protocol-Version": version, "Mcp-Method": "ping" };
	const ping = { jsonrpc: "2.0", id: "p", method: "ping", params: { _meta: meta } };

	test("requires metadata before checking headers and echoes the request id", async () => {
		const h = harness();
		for (const invalid of [
			{},
			{ "io.modelcontextprotocol/protocolVersion": version },
			{
				"io.modelcontextprotocol/clientCapabilities": {},
			},
			{
				"io.modelcontextprotocol/protocolVersion": version,
				"io.modelcontextprotocol/clientCapabilities": [],
			},
		]) {
			const response = await rpc(h, { ...ping, params: { _meta: invalid } }, headers);
			expect(response.status).toBe(400);
			expect(await body(response)).toMatchObject({ id: "p", error: { code: -32602 } });
		}
		const both = await rpc(h, { ...ping, params: {} }, { "MCP-Protocol-Version": version });
		expect(both.status).toBe(400);
		expect((await body(both)).error?.code).toBe(-32602);
	});

	test("requires case-sensitive mirrors and accepts mixed-case header names", async () => {
		const h = harness();
		const ok = await rpc(h, ping, { "mcp-protocol-version": version, "mCP-mEThod": "ping" });
		expect(ok.status).toBe(200);
		for (const invalidHeaders of [
			{ "MCP-Protocol-Version": version },
			{ ...headers, "Mcp-Method": "Ping" },
		] as Record<string, string>[]) {
			const response = await rpc(h, ping, invalidHeaders);
			expect(response.status).toBe(400);
			expect((await body(response)).error?.code).toBe(-32020);
		}
		const mismatch = await rpc(
			h,
			{
				...ping,
				params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
			},
			headers,
		);
		expect(mismatch.status).toBe(400);
		expect((await body(mismatch)).error?.code).toBe(-32020);
	});

	test("rejects modern request metadata without a matching version header", async () => {
		const h = harness();
		const request = {
			jsonrpc: "2.0",
			id: 17,
			method: "tools/call",
			params: { name: "ultrathink_pending", arguments: { sessionId: "missing" }, _meta: meta },
		};
		for (const supplied of [
			{ "Mcp-Method": "tools/call", "Mcp-Name": "ultrathink_pending" },
			{
				"MCP-Protocol-Version": "2025-11-25",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "ultrathink_pending",
			},
		] as Record<string, string>[]) {
			const response = await rpc(h, request, supplied);
			expect(response.status).toBe(400);
			expect((await body(response)).error?.code).toBe(-32020);
		}
	});

	test("rejects a modern-declared request inside a legacy batch before dispatch", async () => {
		const h = harness();
		const legacy = { jsonrpc: "2.0", id: 20, method: "ping" };
		const modern = {
			jsonrpc: "2.0",
			id: 21,
			method: "tools/call",
			params: { name: "ultrathink_pending", arguments: { sessionId: "missing" }, _meta: meta },
		};
		for (const headers of [{}, { "MCP-Protocol-Version": "2025-03-26" }] as Record<
			string,
			string
		>[]) {
			const response = await rpc(h, [legacy, modern], headers);
			expect(response.status).toBe(400);
			expect(await body(response)).toMatchObject({ id: 21, error: { code: -32020 } });
		}
		const genuine = await rpc(h, [legacy, { ...legacy, id: 22 }]);
		expect(genuine.status).toBe(200);
		expect(await genuine.json()).toHaveLength(2);
	});

	test("validates notification-named requests while preserving actual notifications", async () => {
		const h = harness();
		const request = {
			jsonrpc: "2.0",
			id: 18,
			method: "notifications/unknown",
			params: { _meta: meta },
		};
		for (const method of [undefined, "other"]) {
			const supplied: Record<string, string> = { "MCP-Protocol-Version": version };
			if (method !== undefined) supplied["Mcp-Method"] = method;
			const response = await rpc(h, request, supplied);
			expect(response.status).toBe(400);
			expect((await body(response)).error?.code).toBe(-32020);
		}
		const notification = await rpc(
			h,
			{ jsonrpc: "2.0", method: "notifications/unknown" },
			{ "MCP-Protocol-Version": version },
		);
		expect(notification.status).toBe(202);
	});

	test("checks names and resource URIs before dispatch", async () => {
		const h = harness();
		for (const [method, field] of [
			["tools/call", "name"],
			["prompts/get", "name"],
			["resources/read", "uri"],
		] as const) {
			const request = {
				jsonrpc: "2.0",
				id: 3,
				method,
				params: { [field]: "expected", _meta: meta },
			};
			for (const name of [undefined, "Expected"]) {
				const sent: Record<string, string> = {
					"MCP-Protocol-Version": version,
					"Mcp-Method": method,
				};
				if (name !== undefined) sent["Mcp-Name"] = name;
				const response = await rpc(h, request, sent);
				expect(response.status).toBe(400);
				expect((await body(response)).error?.code).toBe(-32020);
			}
			const matching = await rpc(h, request, {
				"MCP-Protocol-Version": version,
				"Mcp-Method": method,
				"Mcp-Name": "expected",
			});
			expect((await body(matching)).error?.code).not.toBe(-32020);
		}
	});

	test("mismatched routing headers cannot invoke the tool host", async () => {
		const h = harness();
		const request = {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "ultrathink_pending",
				arguments: { sessionId: "missing" },
				_meta: meta,
			},
		};
		const response = await rpc(h, request, {
			"MCP-Protocol-Version": version,
			"Mcp-Method": "tools/call",
			"Mcp-Name": "ultrathink_status",
		});
		expect(response.status).toBe(400);
		expect((await body(response)).error?.code).toBe(-32020);
		expect(h.app.metrics.sum("ultrathink_mcp_tool_calls_total")).toBe(0);
	});

	test("name encoding is checked on the wire before dispatch", async () => {
		const h = harness();
		for (const name of ["café", "=?base64?SGk=?="]) {
			const request = {
				jsonrpc: "2.0",
				id: 5,
				method: "prompts/get",
				params: { name, _meta: meta },
			};
			const encoded = `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;
			const response = await rpc(h, request, {
				"MCP-Protocol-Version": version,
				"Mcp-Method": "prompts/get",
				"Mcp-Name": encoded,
			});
			expect(response.status).toBe(200);
			expect((await body(response)).error?.code).not.toBe(-32020);
		}
		for (const name of ["=?base64?!!!!?=", "=?base64?/w==?="]) {
			const response = await rpc(
				h,
				{ jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "expected", _meta: meta } },
				{
					"MCP-Protocol-Version": version,
					"Mcp-Method": "prompts/get",
					"Mcp-Name": name,
				},
			);
			expect(response.status).toBe(400);
			expect((await body(response)).error?.code).toBe(-32020);
		}
	});

	test("notifications and malformed envelopes retain their existing behavior", async () => {
		const h = harness();
		const notification = await rpc(
			h,
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ "MCP-Protocol-Version": version },
		);
		expect(notification.status).toBe(202);
		expect(await notification.text()).toBe("");
		const batch = await rpc(h, [ping], headers);
		expect(batch.status).toBe(400);
		expect((await body(batch)).error?.code).toBe(-32600);
		const invalid = await rpc(h, { jsonrpc: "2.0", id: null, method: "ping" }, headers);
		expect(invalid.status).toBe(400);
		expect((await body(invalid)).error?.code).toBe(-32600);
	});

	test("origin and credentials are rejected before modern validation", async () => {
		const h = harness();
		const forbidden = await rpc(h, ping, { ...headers, Origin: "https://evil.example" });
		expect(forbidden.status).toBe(403);
		const noKey = await h.app.handle(
			new Request(RESOURCE, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(ping),
			}),
			PEER,
		);
		expect(noKey.status).toBe(401);
		const badKey = await rpc(h, ping, { ...headers, "x-connector-key": "invalid" });
		expect(badKey.status).toBe(401);
	});

	test("a locally simulated unsupported probe can fall back to legacy initialize", async () => {
		const h = harness();
		const probe = await rpc(h, ping, {
			"MCP-Protocol-Version": "2027-01-01",
			"Mcp-Method": "ping",
		});
		expect(probe.status).toBe(400);
		expect((await body(probe)).error?.code).toBe(-32600);
		const fallback = await rpc(h, initialize("2027-01-01"));
		expect(fallback.status).toBe(200);
		expect((await body(fallback)).result?.protocolVersion).toBe("2025-11-25");
	});
});

describe("era-specific HTTP errors", () => {
	test("modern unknown methods use 404 and missing resources use -32602; legacy remains unchanged", async () => {
		const h = harness();
		for (const version of ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]) {
			const modern = version === "2026-07-28";
			const meta = modern
				? {
						_meta: {
							"io.modelcontextprotocol/protocolVersion": version,
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					}
				: {};
			const unknown = await rpc(
				h,
				{ jsonrpc: "2.0", id: "unknown", method: "sampling/createMessage", params: meta },
				{
					"MCP-Protocol-Version": version,
					...(modern ? { "Mcp-Method": "sampling/createMessage" } : {}),
				},
			);
			expect(unknown.status).toBe(modern ? 404 : 200);
			expect(await body(unknown)).toEqual({
				jsonrpc: "2.0",
				id: "unknown",
				error: { code: -32601, message: "method not found" },
			});
			const missing = await rpc(
				h,
				{
					jsonrpc: "2.0",
					id: "missing",
					method: "resources/read",
					params: { ...meta, uri: "ui://ultrathink/missing" },
				},
				{
					"MCP-Protocol-Version": version,
					...(modern
						? { "Mcp-Method": "resources/read", "Mcp-Name": "ui://ultrathink/missing" }
						: {}),
				},
			);
			expect(missing.status).toBe(200);
			expect(await body(missing)).toEqual({
				jsonrpc: "2.0",
				id: "missing",
				error: { code: modern ? -32602 : -32002, message: "resource not found" },
			});
		}
	});
});

describe("stateless transport across TCP connections", () => {
	test("tool calls work before discovery and on a different connection after discovery", async () => {
		const h = harness();
		const sockets: Socket[] = [];
		const server = createServer(async (incoming, outgoing) => {
			sockets.push(incoming.socket);
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
				const headers = new Headers();
				for (const [name, value] of Object.entries(incoming.headers)) {
					if (value !== undefined)
						headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				}
				const response = await h.app.handle(
					new Request(RESOURCE, {
						method: "POST",
						headers,
						body: Buffer.concat(chunks),
					}),
					PEER,
				);
				outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
				outgoing.end(Buffer.from(await response.arrayBuffer()));
			} catch {
				outgoing.writeHead(500);
				outgoing.end();
			}
		});
		try {
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject);
			server.listen(0, PEER, listening.resolve);
			await listening.promise;
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing loopback address");
			const version = "2026-07-28";
			const send = (method: string, id: string, params: Json = {}) => {
				const { promise, resolve, reject } = Promise.withResolvers<{
					status: number;
					headers: Record<string, unknown>;
					body: RpcBody;
				}>();
				const payload = JSON.stringify({
					jsonrpc: "2.0",
					id,
					method,
					params: {
						...params,
						_meta: {
							"io.modelcontextprotocol/protocolVersion": version,
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					},
				});
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(payload)),
					Connection: "close",
					"x-connector-key": CONNECTOR_KEY,
					"MCP-Protocol-Version": version,
					"Mcp-Method": method,
				};
				if (method === "tools/call") headers["Mcp-Name"] = "ultrathink_sessions";
				const req = httpRequest(
					{ host: PEER, port: address.port, path: "/mcp", method: "POST", headers, agent: false },
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (chunk: Buffer) => chunks.push(chunk));
						res.on("error", reject);
						res.on("end", () => {
							try {
								resolve({
									status: res.statusCode ?? 0,
									headers: res.headers,
									body: JSON.parse(Buffer.concat(chunks).toString()) as RpcBody,
								});
							} catch (error) {
								reject(error);
							}
						});
					},
				);
				req.on("error", reject);
				req.end(payload);
				return promise;
			};
			const toolParams = { name: "ultrathink_sessions", arguments: {} };
			const first = await send("tools/call", "before", toolParams);
			const discovery = await send("server/discover", "discover");
			const last = await send("tools/call", "after", toolParams);
			for (const [response, id] of [
				[first, "before"],
				[discovery, "discover"],
				[last, "after"],
			] as const) {
				expect(response.status).toBe(200);
				expect(response.body.id).toBe(id);
				expect(response.body.result?.resultType).toBe("complete");
				expect(response.headers["mcp-session-id"]).toBeUndefined();
			}
			for (const response of [first, last]) {
				expect(response.body.result?.isError).toBe(false);
				expect(response.body.result?.structuredContent).toMatchObject({
					sessions: [],
					planning: { serverPlanning: false },
				});
			}
			expect(sockets).toHaveLength(3);
			expect(new Set(sockets).size).toBe(3);
		} finally {
			server.closeAllConnections();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			h.store.close();
			stores.splice(stores.indexOf(h.store), 1);
			rmSync(h.dir, { recursive: true, force: true });
			dirs.splice(dirs.indexOf(h.dir), 1);
		}
	});
});

describe("credentials and media type", () => {
	test("the connector key and an OAuth bearer both reach initialize with 200", async () => {
		const withKey = harness();
		const viaKey = await rpc(withKey, initialize("2025-11-25"));
		expect(viaKey.status).toBe(200);
		expect((await body(viaKey)).result?.protocolVersion).toBe("2025-11-25");

		const bearerOnly = harness({ connectorKey: undefined });
		const accessToken = await issueAccessToken(bearerOnly);
		const viaBearer = await bearerOnly.app.handle(
			new Request(RESOURCE, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
				body: JSON.stringify(initialize("2025-11-25")),
			}),
			PEER,
		);
		expect(viaBearer.status).toBe(200);
		expect((await body(viaBearer)).result?.protocolVersion).toBe("2025-11-25");
		expect(
			requestLogs(bearerOnly).some(
				(line) => line.authKind === "bearer" && line.rpcMethod === "initialize",
			),
		).toBe(true);
	});

	test("Accept is not enforced: application/json alone, event-stream alone and the SDK's pair all get JSON", async () => {
		const h = harness();
		for (const accept of [
			"application/json",
			"text/event-stream",
			"application/json, text/event-stream",
		]) {
			const response = await rpc(h, { jsonrpc: "2.0", id: 1, method: "ping" }, { Accept: accept });
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type") ?? "").toContain("application/json");
			expect((await body(response)).result).toEqual({});
		}
	});
});

describe("request log diagnostics", () => {
	test("a rejected probe logs the header value and the method, and nothing else from the body", async () => {
		const h = harness();
		const argumentText = "PRIVATE-PROMPT-TEXT-4711";
		const response = await rpc(
			h,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "ultrathink_plan", arguments: { prompt: argumentText } },
			},
			{ "MCP-Protocol-Version": "2025-12-01" },
		);
		expect(response.status).toBe(400);
		const [line] = requestLogs(h);
		expect(line).toMatchObject({
			endpoint: "mcp",
			status: 400,
			mcpVersion: "2025-12-01",
			rpcMethod: "tools/call",
			authKind: "connector-key",
		});
		// The tool name is a body field too; only the method is read on this path.
		expect(line).not.toHaveProperty("tool");
		const text = JSON.stringify(h.logs);
		expect(text).not.toContain(argumentText);
		expect(text).not.toContain("ultrathink_plan");
	});

	test("a rejected probe whose body does not parse logs the version only, and the 400 is unchanged", async () => {
		const h = harness();
		const response = await post(h, "{ this is not json", { "MCP-Protocol-Version": "2024-11-05" });
		expect(response.status).toBe(400);
		expect((await body(response)).error).toEqual({
			code: -32600,
			message: "unsupported MCP-Protocol-Version",
		});
		const [line] = requestLogs(h);
		expect(line).toMatchObject({ status: 400, mcpVersion: "2024-11-05" });
		expect(line).not.toHaveProperty("rpcMethod");
	});

	test("a rejected probe with an oversized body logs the version only", async () => {
		const h = harness({ maxBodyBytes: 256 });
		const big = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: { pad: "x".repeat(2048) },
		});
		const response = await post(h, big, { "MCP-Protocol-Version": "2025-12-01" });
		expect(response.status).toBe(400);
		const [line] = requestLogs(h);
		expect(line).toMatchObject({ status: 400, mcpVersion: "2025-12-01" });
		expect(line).not.toHaveProperty("rpcMethod");
	});

	test("the logged header value is cut to the log value limit", async () => {
		const h = harness();
		await rpc(
			h,
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			{ "MCP-Protocol-Version": "v".repeat(300) },
		);
		const [line] = requestLogs(h);
		expect(line?.mcpVersion).toBe("v".repeat(64));
	});

	test("an accepted request logs mcpVersion when the header is present and omits it when absent", async () => {
		const h = harness();
		expect(
			(
				await rpc(
					h,
					{ jsonrpc: "2.0", id: 1, method: "ping" },
					{ "MCP-Protocol-Version": "2025-11-25" },
				)
			).status,
		).toBe(200);
		expect((await rpc(h, { jsonrpc: "2.0", id: 2, method: "tools/list" })).status).toBe(200);
		const [withHeader, withoutHeader] = requestLogs(h);
		expect(withHeader).toMatchObject({ status: 200, mcpVersion: "2025-11-25", rpcMethod: "ping" });
		expect(withoutHeader).toMatchObject({ status: 200, rpcMethod: "tools/list" });
		expect(withoutHeader).not.toHaveProperty("mcpVersion");
	});

	test("a request that is not a /mcp request never carries mcpVersion", async () => {
		const h = harness();
		await h.app.handle(
			new Request(`${ORIGIN}/healthz`, { headers: { "MCP-Protocol-Version": "2026-07-28" } }),
			PEER,
		);
		const [line] = requestLogs(h);
		expect(line).not.toHaveProperty("mcpVersion");
	});
});

describe("dynamic client registration", () => {
	test("accepts the metadata current clients send, ignores unknown fields and does not echo them", async () => {
		const h = harness();
		const response = await registerBody(h, {
			client_name: "Claude",
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			application_type: "web",
			scope: "claude-sentinel-scope",
			software_id: "software-sentinel-id",
			contacts: ["contact-sentinel@example.test"],
			logo_uri: "https://logo-sentinel.example.test/logo.png",
			client_uri: "https://client-sentinel.example.test/",
			tos_uri: "https://tos-sentinel.example.test/",
		});
		expect(response.status).toBe(201);
		const text = await response.text();
		const registered = JSON.parse(text) as Json;
		expect(registered.client_name).toBe("Claude");
		expect(registered.redirect_uris).toEqual([REDIRECT]);
		expect(registered.token_endpoint_auth_method).toBe("none");
		expect(registered.grant_types).toEqual(["authorization_code", "refresh_token"]);
		for (const field of [
			"application_type",
			"scope",
			"software_id",
			"contacts",
			"logo_uri",
			"client_uri",
			"tos_uri",
		]) {
			expect(registered).not.toHaveProperty(field);
		}
		expect(text).not.toContain("sentinel");
	});

	test("accepts the redirects of the hosted clients and a loopback redirect", async () => {
		const h = harness();
		const redirects = [
			REDIRECT,
			"https://grok.com/connectors-oauth-exchange-code/",
			"https://console.x.ai/connectors-oauth-exchange-code/",
			"http://127.0.0.1:33418/callback",
		];
		for (const redirect of redirects) {
			const response = await registerBody(h, {
				client_name: "Hosted client",
				redirect_uris: [redirect],
				token_endpoint_auth_method: "none",
			});
			expect(response.status).toBe(201);
			const registeredBody = await jsonOf(response);
			expect(registeredBody.redirect_uris).toEqual([redirect]);
		}
	});

	test("rejects client_secret_post and a redirect outside the allow list", async () => {
		const h = harness();
		const secret = await registerBody(h, {
			client_name: "Confidential",
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "client_secret_post",
		});
		expect(secret.status).toBe(400);
		const secretBody = await jsonOf(secret);
		expect(secretBody.error).toBe("invalid_client_metadata");

		const evil = await registerBody(h, {
			client_name: "Evil",
			redirect_uris: ["https://evil.example/cb"],
			token_endpoint_auth_method: "none",
		});
		expect(evil.status).toBe(400);
		const evilBody = await jsonOf(evil);
		expect(evilBody.error).toBe("invalid_redirect_uri");
	});
});
