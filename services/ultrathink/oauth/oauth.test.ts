// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Auth, createAuth } from "../auth/auth.ts";
import type { Logger } from "../obs/log.ts";
import { redactText } from "../../../src/teach/redact.ts";
import {
	DEFAULT_REDIRECT_ORIGINS,
	type DurableFs,
	type OAuth,
	type OAuthOptions,
	createOAuth,
	writeFileDurably,
} from "./oauth.ts";
import { loadConfig, type UltrathinkConfig } from "../config/config.ts";
import { openStore, type Store } from "../store/store.ts";
import { createHandler } from "../routes/router.ts";
import {
	getSecurityLogger,
	setSecurityLogger,
	type SecurityEvent,
	type SecurityEventLogger,
} from "../security/events.ts";
import type { GuardedFetch } from "../security/outbound-fetch.ts";
import { createCimdFetcher } from "./cimd-fetch.ts";
import type { CimdFetchResult } from "./cimd-fetch.ts";
import { parseCimdDocument } from "./cimd.ts";
import type { OutboundCacheHeaders } from "../security/outbound-fetch.ts";
import { randomHash } from "../../../src/test.helpers.ts";

const ORIGIN = "https://ultrathink.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PEER = "127.0.0.1";
const ACCESS_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const CONNECTOR_KEY = randomBytes(24).toString("hex");

type Handler = (req: Request, peerIp: string) => Promise<Response>;

let dir: string;
let store: Store;
let handler: Handler;
let password: string;
let clock: number;

function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function form(body: Record<string, string>): string {
	return new URLSearchParams(body).toString();
}

async function registerClient(redirect = REDIRECT): Promise<string> {
	const response = await handler(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Grok",
				redirect_uris: [redirect],
				grant_types: ["authorization_code", "refresh_token"],
			}),
		}),
		freshIp(),
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as { client_id: string };
	return body.client_id;
}

async function startAuthorize(
	clientId: string,
	challenge: string,
	overrides: Record<string, string> = {},
): Promise<Response> {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: RESOURCE,
		state: "state-1",
		...overrides,
	});
	return handler(
		new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`, { method: "GET" }),
		freshIp(),
	);
}

function consentFrom(html: string): { requestId: string; nonce: string } {
	const requestId = /name="req" value="([^"]+)"/.exec(html)?.[1];
	const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
	if (!requestId || !nonce) throw new Error("consent form has no request id");
	return { requestId, nonce };
}

let loginSeq = 0;
let ipSeq = 0;

// Registration, authorize and token calls are limited per IP, so each call gets its own peer.
function freshIp(): string {
	ipSeq += 1;
	return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

// The owner login allows 5 attempts per IP per window, so each approval gets its own peer.
async function approve(html: string, owner: string, peer?: string): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	loginSeq += 1;
	return handler(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, password: owner }),
		}),
		peer ?? `10.0.${Math.floor(loginSeq / 250)}.${(loginSeq % 250) + 1}`,
	);
}

async function pollConsent(html: string): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	return handler(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, action: "poll" }),
		}),
		PEER,
	);
}

function codeFrom(response: Response): string {
	const location = response.headers.get("location");
	expect(location).not.toBeNull();
	const code = new URL(location ?? "").searchParams.get("code");
	expect(code).not.toBeNull();
	return code ?? "";
}

async function exchange(body: Record<string, string>): Promise<Response> {
	return handler(
		new Request(`${ORIGIN}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(body),
		}),
		freshIp(),
	);
}

async function issueTokens(
	clientId: string,
): Promise<{ access_token: string; refresh_token: string; code: string; verifier: string }> {
	const { verifier, challenge } = pkcePair();
	const consent = await startAuthorize(clientId, challenge);
	expect(consent.status).toBe(200);
	const granted = await approve(await consent.text(), password);
	const code = codeFrom(granted);
	const tokens = await exchange({
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		client_id: clientId,
		redirect_uri: REDIRECT,
		resource: RESOURCE,
	});
	expect(tokens.status).toBe(200);
	const body = (await tokens.json()) as { access_token: string; refresh_token: string };
	return { ...body, code, verifier };
}

function mcpToolsList(token: string | null): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	return new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-"));
	password = randomBytes(24).toString("base64url");
	const ownerPasswordHash = await Bun.password.hash(password);
	const sessionSecret = randomBytes(32).toString("hex");
	const config: UltrathinkConfig = {
		publicOrigin: ORIGIN,
		ownerPasswordHash,
		sessionSecret,
		stateDir: dir,
		dbPath: join(dir, "ultrathink.db"),
		port: 0,
		maxInputChars: 200,
		maxAnswerChars: 20000,
		maxBodyBytes: 16384,
		runTokenCeiling: 150000,
		dailyTokenCeiling: 1000000,
		planningModel: "claude-haiku-5-5",
		connectorKey: CONNECTOR_KEY,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		legacyEnvIgnored: [],
		serverPlanning: false,
		maxConcurrentPlans: 2,
		modelTimeoutMs: 120000,
		planTimeoutMs: 600000,
		modelMaxOutputTokens: 8000,
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
	};
	const auth = createAuth({ ownerPasswordHash, sessionSecret, cookieSecure: true });
	store = openStore(config.dbPath);
	clock = 1_700_000_000_000;
	handler = createHandler({ config, store, auth, now: () => clock });
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("OAuth discovery", () => {
	test("publishes protected-resource and authorization-server metadata with S256 PKCE", async () => {
		const resource = await handler(
			new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`),
			PEER,
		);
		expect(resource.status).toBe(200);
		const protectedBody = (await resource.json()) as {
			resource: string;
			authorization_servers: string[];
		};
		expect(protectedBody.resource).toBe(RESOURCE);
		expect(protectedBody.authorization_servers).toEqual([ORIGIN]);

		const server = await handler(
			new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
			PEER,
		);
		const serverBody = (await server.json()) as Record<string, unknown>;
		expect(serverBody.code_challenge_methods_supported).toEqual(["S256"]);
		expect(serverBody.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
		expect(serverBody.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
		expect(serverBody.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
	});

	test("challenges MCP calls without a token with the metadata URL", async () => {
		const response = await handler(mcpToolsList(null), PEER);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(
			`${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
		);
	});
});

describe("OAuth authorization code flow", () => {
	test("PKCE exchange issues a token that opens the MCP endpoint", async () => {
		const clientId = await registerClient();
		const tokens = await issueTokens(clientId);
		const list = await handler(mcpToolsList(tokens.access_token), PEER);
		expect(list.status).toBe(200);
		expect(await list.text()).toContain("ultrathink_plan");
	});

	test("a wrong owner password re-renders consent and issues no code", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const retry = await approve(await consent.text(), "not-the-password");
		expect(retry.status).toBe(200);
		expect(retry.headers.get("location")).toBeNull();
		expect(await retry.text()).toContain("Incorrect password.");
	});

	test("a wrong PKCE verifier is refused and the code stays usable", async () => {
		const clientId = await registerClient();
		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(await consent.text(), password));
		const base = {
			grant_type: "authorization_code",
			code,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: RESOURCE,
		};
		const wrong = await exchange({ ...base, code_verifier: randomBytes(32).toString("base64url") });
		expect(wrong.status).toBe(400);
		expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
		const right = await exchange({ ...base, code_verifier: verifier });
		expect(right.status).toBe(200);
	});

	test("a replayed code revokes the tokens it issued", async () => {
		const clientId = await registerClient();
		const tokens = await issueTokens(clientId);
		const replay = await exchange({
			grant_type: "authorization_code",
			code: tokens.code,
			code_verifier: tokens.verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: RESOURCE,
		});
		expect(replay.status).toBe(400);
		expect((await handler(mcpToolsList(tokens.access_token), PEER)).status).toBe(401);
	});

	test("the code is bound to the MCP resource", async () => {
		const clientId = await registerClient();
		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(await consent.text(), password));
		const other = await exchange({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: `${ORIGIN}/other`,
		});
		expect(other.status).toBe(400);
		expect(((await other.json()) as { error: string }).error).toBe("invalid_target");
	});

	test("authorize refuses a non-S256 challenge and a foreign resource through the redirect", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const plain = await startAuthorize(clientId, challenge, { code_challenge_method: "plain" });
		expect(new URL(plain.headers.get("location") ?? "").searchParams.get("error")).toBe(
			"invalid_request",
		);
		const foreign = await startAuthorize(clientId, challenge, {
			resource: "https://other.test/mcp",
		});
		expect(new URL(foreign.headers.get("location") ?? "").searchParams.get("error")).toBe(
			"invalid_target",
		);
	});

	test("authorize rejects an unregistered redirect URI without redirecting", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const response = await startAuthorize(clientId, challenge, {
			redirect_uri: "https://evil.test/cb",
		});
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	});

	test("registration refuses plain http redirect URIs outside loopback", async () => {
		const response = await handler(
			new Request(`${ORIGIN}/oauth/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ redirect_uris: ["http://grok.example/cb"] }),
			}),
			PEER,
		);
		expect(response.status).toBe(400);
	});

	test("refresh tokens rotate, and a spent refresh token revokes the grant", async () => {
		const clientId = await registerClient();
		const first = await issueTokens(clientId);
		const rotated = await exchange({
			grant_type: "refresh_token",
			refresh_token: first.refresh_token,
			client_id: clientId,
		});
		expect(rotated.status).toBe(200);
		const next = (await rotated.json()) as { access_token: string; refresh_token: string };
		const spent = await exchange({
			grant_type: "refresh_token",
			refresh_token: first.refresh_token,
			client_id: clientId,
		});
		expect(spent.status).toBe(400);
		expect((await handler(mcpToolsList(next.access_token), PEER)).status).toBe(401);
	});

	test("access tokens and codes expire", async () => {
		const clientId = await registerClient();
		const tokens = await issueTokens(clientId);
		clock += ACCESS_TTL_MS + 1;
		expect((await handler(mcpToolsList(tokens.access_token), PEER)).status).toBe(401);

		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(await consent.text(), password));
		clock += CODE_TTL_MS + 1;
		const late = await exchange({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: RESOURCE,
		});
		expect(late.status).toBe(400);
	});

	test("the connector key still opens the MCP endpoint", async () => {
		const response = await handler(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
			PEER,
		);
		expect(response.status).toBe(200);
	});

	test("a 45s delay stays PENDING_APPROVAL and approve does not expire", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const html = await consent.text();
		expect(consent.headers.get("content-security-policy")).toContain(
			"form-action 'self' https://claude.ai;",
		);
		expect(html).toContain('data-approval-state="PENDING_APPROVAL"');
		clock += 45_000;
		const polled = await pollConsent(html);
		expect(polled.status).toBe(200);
		const body: unknown = await polled.json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("state" in body) ||
			body.state !== "PENDING_APPROVAL"
		) {
			throw new Error("poll did not stay PENDING_APPROVAL");
		}
		if (!("refreshed_at" in body) || body.refreshed_at !== clock)
			throw new Error("approve poll did not refresh the timestamp");
		const granted = await approve(html, password);
		expect(granted.status).toBe(302);
		expect(await granted.text()).not.toContain("expired");
		expect(granted.headers.get("location")).toContain("code=");
	});

	test("approval stays PENDING_APPROVAL until the absolute timeout", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const html = await consent.text();
		clock += 10 * 60 * 1000 - 1;
		const still = await pollConsent(html);
		expect(still.status).toBe(200);
		const stillBody: unknown = await still.json();
		if (
			typeof stillBody !== "object" ||
			stillBody === null ||
			!("state" in stillBody) ||
			stillBody.state !== "PENDING_APPROVAL"
		) {
			throw new Error("request left PENDING_APPROVAL before the deadline");
		}
		clock += 2;
		const late = await approve(html, password);
		expect(late.status).toBe(400);
		const text = await late.text();
		expect(text).toContain(
			"This authorization request expired. Start the connection again from your client.",
		);
		expect(text).not.toContain('data-approval-state="PENDING_APPROVAL"');
	});

	test("a third approve attempt in one minute is limited and the request stays pending", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const html = await (await startAuthorize(clientId, challenge)).text();
		const peer = "198.51.100.77";
		expect(await (await approve(html, "not-the-password", peer)).text()).toContain(
			"Incorrect password.",
		);
		expect(await (await approve(html, "not-the-password", peer)).text()).toContain(
			"Incorrect password.",
		);
		const third = await approve(html, password, peer);
		const limited = await third.text();
		expect(third.status).toBe(429);
		expect(limited).toContain("Too many attempts");
		expect(limited).not.toContain("authorization request expired");
		const pendingBody: unknown = await (await pollConsent(html)).json();
		if (
			typeof pendingBody !== "object" ||
			pendingBody === null ||
			!("state" in pendingBody) ||
			pendingBody.state !== "PENDING_APPROVAL"
		) {
			throw new Error("rate limit expired the pending approval");
		}
	});

	test("a bad nonce is rejected without consuming the pending approval", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const html = await (await startAuthorize(clientId, challenge)).text();
		const { requestId } = consentFrom(html);
		loginSeq += 1;
		const tampered = await handler(
			new Request(`${ORIGIN}/oauth/authorize`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form({ req: requestId, nonce: "not-the-nonce", password }),
			}),
			`10.1.0.${loginSeq}`,
		);
		expect(tampered.status).toBe(400);
		expect(await tampered.text()).toContain("This authorization request expired");
		expect((await approve(html, password)).status).toBe(302);
	});

	test("reloading persisted state still approves after a 45s delay", async () => {
		const restartDir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-restart-"));
		try {
			const localAuth = createAuth({
				ownerPasswordHash: await Bun.password.hash(password),
				sessionSecret: randomBytes(32).toString("hex"),
				cookieSecure: true,
				now: () => clock,
			});
			const opened = { origin: ORIGIN, stateDir: restartDir, auth: localAuth, now: () => clock };
			const first = createOAuth(opened);
			const registered = await first.register(
				new Request(`${ORIGIN}/oauth/register`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ client_name: "Grok", redirect_uris: [REDIRECT] }),
				}),
			);
			expect(registered.status).toBe(201);
			const registeredBody: unknown = await registered.json();
			if (
				typeof registeredBody !== "object" ||
				registeredBody === null ||
				!("client_id" in registeredBody) ||
				typeof registeredBody.client_id !== "string"
			) {
				throw new Error("registration has no client id");
			}
			const clientId = registeredBody.client_id;
			const { challenge } = pkcePair();
			const params = new URLSearchParams({
				response_type: "code",
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				code_challenge_method: "S256",
				resource: RESOURCE,
				state: "state-1",
			});
			const consent = await first.authorize(
				new Request(`${ORIGIN}/oauth/authorize?${params}`),
				PEER,
			);
			const html = await consent.text();
			const fields = consentFrom(html);
			clock += 45_000;
			const second = createOAuth(opened);
			const granted = await second.authorize(
				new Request(`${ORIGIN}/oauth/authorize`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form({ req: fields.requestId, nonce: fields.nonce, password }),
				}),
				"198.51.100.88",
			);
			expect(granted.status).toBe(302);
			expect(await granted.text()).not.toContain("expired");
		} finally {
			rmSync(restartDir, { recursive: true, force: true });
		}
	});
});

describe("OAuth through the router", () => {
	test("registration and token calls are limited per client IP", async () => {
		const peer = "203.0.113.50";
		const register = () =>
			handler(
				new Request(`${ORIGIN}/oauth/register`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ redirect_uris: [REDIRECT] }),
				}),
				peer,
			);
		for (let i = 0; i < 10; i += 1) expect((await register()).status).toBe(201);
		expect((await register()).status).toBe(429);

		const tokenPeer = "203.0.113.51";
		const token = () =>
			handler(
				new Request(`${ORIGIN}/oauth/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form({ grant_type: "unsupported" }),
				}),
				tokenPeer,
			);
		for (let i = 0; i < 60; i += 1) expect((await token()).status).toBe(400);
		expect((await token()).status).toBe(429);
	});
});

// Direct module tests: the router has no revoke route yet and these need injected clocks and schedulers.
const HARNESS_SECRET = randomBytes(32).toString("hex");
const HARNESS_START = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

interface Timer {
	run: () => void;
	intervalMs: number;
	cancelled: boolean;
}

interface Harness {
	oauth: OAuth;
	dir: string;
	clock: { now: number };
	timers: Timer[];
	statePath: string;
}

interface Granted {
	access: string;
	refresh: string;
	body: Record<string, unknown>;
}

let ownerHash: string | undefined;
const harnessDirs: string[] = [];

async function makeHarness(
	options: Partial<OAuthOptions> = {},
	from?: { dir: string; clock: { now: number } },
): Promise<Harness> {
	ownerHash ??= await Bun.password.hash(password);
	let dir = from?.dir;
	if (dir === undefined) {
		dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-h-"));
		harnessDirs.push(dir);
	}
	const clock = from?.clock ?? { now: HARNESS_START };
	const timers: Timer[] = [];
	const auth = createAuth({
		ownerPasswordHash: ownerHash,
		sessionSecret: HARNESS_SECRET,
		cookieSecure: true,
		now: () => clock.now,
	});
	const oauth = createOAuth({
		origin: ORIGIN,
		stateDir: dir,
		auth,
		now: () => clock.now,
		schedule: (run, intervalMs) => {
			const timer: Timer = { run, intervalMs, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		...options,
	});
	return { oauth, dir, clock, timers, statePath: join(dir, "oauth.json") };
}

function firstTimer(h: Harness): Timer {
	const timer = h.timers[0];
	if (timer === undefined) throw new Error("no sweeper was scheduled");
	return timer;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
	const parsed: unknown = await response.json();
	if (typeof parsed !== "object" || parsed === null)
		throw new Error("response is not a JSON object");
	return Object.fromEntries(Object.entries(parsed));
}

function registerCall(
	h: Harness,
	body: Record<string, unknown>,
	ip = freshIp(),
): Promise<Response> {
	return h.oauth.register(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		ip,
	);
}

async function registered(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
	const response = await registerCall(h, {
		client_name: "Test client",
		redirect_uris: [REDIRECT],
		grant_types: ["authorization_code", "refresh_token"],
		...overrides,
	});
	expect(response.status).toBe(201);
	const id = (await bodyOf(response)).client_id;
	if (typeof id !== "string") throw new Error("registration has no client id");
	return id;
}

function authorizeCall(
	h: Harness,
	clientId: string,
	challenge: string,
	overrides: Record<string, string> = {},
	ip = freshIp(),
): Promise<Response> {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: RESOURCE,
		state: "state-1",
		...overrides,
	});
	return h.oauth.authorize(new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`), ip);
}

function approveWith(h: Harness, html: string, owner: string, ip = freshIp()): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	return h.oauth.authorize(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, password: owner }),
		}),
		ip,
	);
}

function pollWith(h: Harness, html: string, ip = freshIp()): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	return h.oauth.authorize(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, action: "poll" }),
		}),
		ip,
	);
}

function tokenCall(h: Harness, fields: Record<string, string>, ip = freshIp()): Promise<Response> {
	return h.oauth.token(
		new Request(`${ORIGIN}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(fields),
		}),
		ip,
	);
}

function revokeCall(h: Harness, fields: Record<string, string>, ip = freshIp()): Promise<Response> {
	return h.oauth.revoke(
		new Request(`${ORIGIN}/oauth/revoke`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(fields),
		}),
		ip,
	);
}

async function authorizedCode(
	h: Harness,
	clientId: string,
	options: { redirect?: string; scope?: string } = {},
): Promise<{ code: string; verifier: string; redirect: string }> {
	const { verifier, challenge } = pkcePair();
	const redirect = options.redirect ?? REDIRECT;
	const overrides: Record<string, string> = { redirect_uri: redirect };
	if (options.scope !== undefined) overrides.scope = options.scope;
	const consent = await authorizeCall(h, clientId, challenge, overrides);
	expect(consent.status).toBe(200);
	const approved = await approveWith(h, await consent.text(), password);
	return { code: codeFrom(approved), verifier, redirect };
}

async function grant(
	h: Harness,
	clientId: string,
	options: { redirect?: string; scope?: string } = {},
): Promise<Granted> {
	const { code, verifier, redirect } = await authorizedCode(h, clientId, options);
	const response = await tokenCall(h, {
		grant_type: "authorization_code",
		code,
		code_verifier: verifier,
		client_id: clientId,
		redirect_uri: redirect,
		resource: RESOURCE,
	});
	expect(response.status).toBe(200);
	const body = await bodyOf(response);
	const { access_token: access, refresh_token: refresh } = body;
	if (typeof access !== "string" || typeof refresh !== "string")
		throw new Error("token response has no tokens");
	return { access, refresh, body };
}

function formAction(response: Response): string {
	const policy = response.headers.get("content-security-policy") ?? "";
	const action = /form-action ([^;]+)/.exec(policy)?.[1];
	if (action === undefined) throw new Error("no form-action directive");
	return action;
}

function savedKeys(
	h: Harness,
	section: "clients" | "grants" | "tokens" | "pending" | "codes",
): string[] {
	const saved = JSON.parse(readFileSync(h.statePath, "utf8")) as Record<string, unknown>;
	if (!(section in saved)) throw new Error(`state file has no ${section}`);
	const value = saved[section];
	if (typeof value !== "object" || value === null)
		throw new Error(`state file ${section} is malformed`);
	return Object.keys(value);
}

afterAll(() => {
	for (const dir of harnessDirs) rmSync(dir, { recursive: true, force: true });
});

describe("OAuth redirect allowlist", () => {
	test("registers every default https origin", async () => {
		const h = await makeHarness();
		for (const allowed of DEFAULT_REDIRECT_ORIGINS) {
			const response = await registerCall(h, { redirect_uris: [`${allowed}/oauth/callback`] });
			expect(response.status).toBe(201);
		}
	});

	test("refuses an https origin that is not on the list", async () => {
		const h = await makeHarness();
		const response = await registerCall(h, { redirect_uris: ["https://grok.example/callback"] });
		expect(response.status).toBe(400);
		expect((await bodyOf(response)).error).toBe("invalid_redirect_uri");
		const mixed = await registerCall(h, { redirect_uris: [REDIRECT, "https://evil.test/cb"] });
		expect(mixed.status).toBe(400);
	});

	test("refuses embedded credentials and fragments", async () => {
		const h = await makeHarness();
		expect(
			(await registerCall(h, { redirect_uris: ["https://claude.ai@evil.test/cb"] })).status,
		).toBe(400);
		expect(
			(await registerCall(h, { redirect_uris: ["https://user:pw@claude.ai/cb"] })).status,
		).toBe(400);
		expect((await registerCall(h, { redirect_uris: [`${REDIRECT}#frag`] })).status).toBe(400);
	});

	test("the list is configurable and replaces the default", async () => {
		const h = await makeHarness({ redirectOrigins: ["https://custom.example"] });
		expect((await registerCall(h, { redirect_uris: ["https://custom.example/cb"] })).status).toBe(
			201,
		);
		expect((await registerCall(h, { redirect_uris: [REDIRECT] })).status).toBe(400);
	});

	test("loopback http is accepted with any port", async () => {
		const h = await makeHarness();
		for (const uri of [
			"http://127.0.0.1:53211/cb",
			"http://localhost:1/x",
			"http://[::1]:8080/cb",
			"http://127.0.0.1/cb",
		]) {
			expect((await registerCall(h, { redirect_uris: [uri] })).status).toBe(201);
		}
		expect((await registerCall(h, { redirect_uris: ["http://192.168.1.5:8080/cb"] })).status).toBe(
			400,
		);
	});

	test("a loopback client may authorize on another port but not another path", async () => {
		const h = await makeHarness();
		const clientId = await registered(h, { redirect_uris: ["http://127.0.0.1:50000/cb"] });
		const { challenge } = pkcePair();
		const moved = await authorizeCall(h, clientId, challenge, {
			redirect_uri: "http://127.0.0.1:61234/cb",
		});
		expect(moved.status).toBe(200);
		expect(formAction(moved)).toBe("'self' http://127.0.0.1:61234");
		const other = await authorizeCall(h, clientId, challenge, {
			redirect_uri: "http://127.0.0.1:61234/other",
		});
		expect(other.status).toBe(400);
		const tokens = await grant(h, clientId, { redirect: "http://127.0.0.1:61234/cb" });
		expect(tokens.access).not.toBe("");
	});

	test("a non-loopback redirect must match the registration exactly", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const response = await authorizeCall(h, clientId, challenge, {
			redirect_uri: "https://claude.ai/other",
		});
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	});

	test("duplicate redirect URIs are collapsed", async () => {
		const h = await makeHarness();
		const response = await registerCall(h, {
			redirect_uris: [REDIRECT, REDIRECT, "https://claude.ai/other"],
		});
		expect(response.status).toBe(201);
		expect((await bodyOf(response)).redirect_uris).toEqual([REDIRECT, "https://claude.ai/other"]);
	});

	test("registration echoes the registered grant types", async () => {
		const h = await makeHarness();
		const both = await registerCall(h, {
			redirect_uris: [REDIRECT],
			grant_types: ["authorization_code", "refresh_token", "refresh_token"],
		});
		expect((await bodyOf(both)).grant_types).toEqual(["authorization_code", "refresh_token"]);
		const plain = await registerCall(h, { redirect_uris: [REDIRECT] });
		expect((await bodyOf(plain)).grant_types).toEqual(["authorization_code"]);
		const bad = await registerCall(h, { redirect_uris: [REDIRECT], grant_types: ["password"] });
		expect(bad.status).toBe(400);
	});
});

describe("OAuth per-IP rate limits", () => {
	test("registration allows 10 an hour per IP and recovers after the window", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.9";
		for (let i = 0; i < 10; i += 1)
			expect((await registerCall(h, { redirect_uris: [REDIRECT] }, ip)).status).toBe(201);
		const limited = await registerCall(h, { redirect_uris: [REDIRECT] }, ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await registerCall(h, { redirect_uris: [REDIRECT] })).status).toBe(201);
		h.clock.now += HOUR_MS + 1;
		expect((await registerCall(h, { redirect_uris: [REDIRECT] }, ip)).status).toBe(201);
	});

	test("authorize allows 30 a minute per IP and recovers after the window", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const ip = "203.0.113.10";
		// response_type=token redirects with an error, so no pending request builds up.
		const probe = (address: string) =>
			authorizeCall(h, clientId, challenge, { response_type: "token" }, address);
		for (let i = 0; i < 30; i += 1) expect((await probe(ip)).status).toBe(302);
		const limited = await probe(ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await probe(freshIp())).status).toBe(302);
		h.clock.now += 61_000;
		expect((await probe(ip)).status).toBe(302);
	});

	test("token allows 60 a minute per IP and recovers after the window", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.11";
		for (let i = 0; i < 60; i += 1)
			expect((await tokenCall(h, { grant_type: "unsupported" }, ip)).status).toBe(400);
		const limited = await tokenCall(h, { grant_type: "unsupported" }, ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await tokenCall(h, { grant_type: "unsupported" })).status).toBe(400);
		h.clock.now += 61_000;
		expect((await tokenCall(h, { grant_type: "unsupported" }, ip)).status).toBe(400);
	});

	test("revoke allows 60 a minute per IP", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.12";
		for (let i = 0; i < 60; i += 1)
			expect((await revokeCall(h, { token: "ut_at_unknown" }, ip)).status).toBe(200);
		expect((await revokeCall(h, { token: "ut_at_unknown" }, ip)).status).toBe(429);
		expect((await revokeCall(h, { token: "ut_at_unknown" })).status).toBe(200);
		h.clock.now += 61_000;
		expect((await revokeCall(h, { token: "ut_at_unknown" }, ip)).status).toBe(200);
	});

	test("authorize polls share the per-IP budget and a pending poll does not rewrite the state file", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		expect(consent.status).toBe(200);
		const html = await consent.text();
		const ip = "203.0.113.13";
		rmSync(h.statePath);
		for (let i = 0; i < 30; i += 1) {
			const polled = await pollWith(h, html, ip);
			expect(polled.status).toBe(200);
			expect((await bodyOf(polled)).state).toBe("PENDING_APPROVAL");
		}
		expect(existsSync(h.statePath)).toBe(false);
		const limited = await pollWith(h, html, ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await pollWith(h, html)).status).toBe(200);
		h.clock.now += 61_000;
		expect((await pollWith(h, html, ip)).status).toBe(200);
		expect(existsSync(h.statePath)).toBe(false);
	});

	test("token allows 30 a minute per client, and another client on the same IP still passes", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.14";
		const busy = await registered(h);
		const quiet = await registered(h);
		const attempt = (clientId: string) =>
			tokenCall(
				h,
				{ grant_type: "refresh_token", refresh_token: "ut_rt_unknown", client_id: clientId },
				ip,
			);
		for (let i = 0; i < 30; i += 1) expect((await attempt(busy)).status).toBe(400);
		const limited = await attempt(busy);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await bodyOf(limited)).error).toBe("temporarily_unavailable");
		expect((await attempt(quiet)).status).toBe(400);
		h.clock.now += 61_000;
		expect((await attempt(busy)).status).toBe(400);
	});
});

describe("OAuth grant types", () => {
	test("a client registered for authorization_code only cannot refresh", async () => {
		const h = await makeHarness();
		const clientId = await registered(h, { grant_types: ["authorization_code"] });
		const tokens = await grant(h, clientId);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(400);
		expect((await bodyOf(refreshed)).error).toBe("unauthorized_client");
		expect(h.oauth.verifyAccessToken(tokens.access)).toBe(true);
	});

	test("a client registered for both grants still refreshes", async () => {
		const h = await makeHarness();
		const clientId = await registered(h, { grant_types: ["authorization_code", "refresh_token"] });
		const tokens = await grant(h, clientId);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(200);
	});

	test("a persisted client without grantTypes keeps refreshing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-legacy-"));
		harnessDirs.push(dir);
		const clientId = "ut_client_legacy";
		const legacy = {
			name: "Legacy",
			redirectUris: [REDIRECT],
			createdAt: HARNESS_START,
			lastUsedAt: HARNESS_START,
		};
		writeFileSync(
			join(dir, "oauth.json"),
			JSON.stringify({
				clients: { [clientId]: legacy },
				grants: {},
				codes: {},
				tokens: {},
				pending: {},
			}),
		);
		const h = await makeHarness({}, { dir, clock: { now: HARNESS_START } });
		const tokens = await grant(h, clientId);
		expect(h.oauth.verifyAccessToken(tokens.access)).toBe(true);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(200);
		expect(typeof (await bodyOf(refreshed)).refresh_token).toBe("string");
	});
});

describe("OAuth client table", () => {
	test("a full table evicts the oldest client that never received a grant", async () => {
		const h = await makeHarness({ maxClients: 2 });
		const first = await registered(h);
		h.clock.now += 1000;
		const second = await registered(h);
		h.clock.now += 1000;
		const third = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, first, challenge)).status).toBe(400);
		expect((await authorizeCall(h, second, challenge)).status).toBe(200);
		expect((await authorizeCall(h, third, challenge)).status).toBe(200);
	});

	test("a client with a grant is never evicted", async () => {
		const h = await makeHarness({ maxClients: 2 });
		const granted = await registered(h);
		const tokens = await grant(h, granted);
		h.clock.now += 1000;
		const spare = await registered(h);
		h.clock.now += 1000;
		const newest = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, spare, challenge)).status).toBe(400);
		expect((await authorizeCall(h, granted, challenge)).status).toBe(200);
		expect((await authorizeCall(h, newest, challenge)).status).toBe(200);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: granted,
		});
		expect(refreshed.status).toBe(200);
	});

	test("a client whose owner approval is being checked is not evicted; another ungranted client is", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const real = createAuth({
			ownerPasswordHash: ownerHash ?? (ownerHash = await Bun.password.hash(password)),
			sessionSecret: HARNESS_SECRET,
			cookieSecure: true,
		});
		const auth = {
			...real,
			login: async (input: { password: string; clientIp: string }) => {
				entered.resolve();
				await gate.promise;
				return real.login(input);
			},
		};
		const h = await makeHarness({ maxClients: 2, auth });
		const approving = await registered(h);
		h.clock.now += 1000;
		const bystander = await registered(h);
		const { verifier, challenge } = pkcePair();
		const consent = await authorizeCall(h, approving, challenge);
		expect(consent.status).toBe(200);
		const approval = approveWith(h, await consent.text(), password);
		await entered.promise;

		// The approving client is the oldest never-granted one, so without protection it would be the victim.
		h.clock.now += 1000;
		const newest = await registered(h);
		gate.resolve();
		const approved = await approval;
		const code = codeFrom(approved);
		const redeemed = await tokenCall(h, {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: approving,
			redirect_uri: REDIRECT,
			resource: RESOURCE,
		});
		expect(redeemed.status).toBe(200);

		const other = pkcePair().challenge;
		expect((await authorizeCall(h, bystander, other)).status).toBe(400);
		expect((await authorizeCall(h, newest, other)).status).toBe(200);
	});

	test("registration reports unavailable while the only ungranted client is being approved", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const real = createAuth({
			ownerPasswordHash: ownerHash ?? (ownerHash = await Bun.password.hash(password)),
			sessionSecret: HARNESS_SECRET,
			cookieSecure: true,
		});
		const auth = {
			...real,
			login: async (input: { password: string; clientIp: string }) => {
				entered.resolve();
				await gate.promise;
				return real.login(input);
			},
		};
		const h = await makeHarness({ maxClients: 1, auth });
		const clientId = await registered(h);
		const { verifier, challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		const approval = approveWith(h, await consent.text(), password);
		await entered.promise;
		expect((await registerCall(h, { redirect_uris: [REDIRECT] })).status).toBe(503);
		gate.resolve();
		const code = codeFrom(await approval);
		const redeemed = await tokenCall(h, {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: RESOURCE,
		});
		expect(redeemed.status).toBe(200);
	});

	test("registration reports unavailable only when every client holds a grant", async () => {
		const h = await makeHarness({ maxClients: 1 });
		await grant(h, await registered(h));
		const full = await registerCall(h, { redirect_uris: [REDIRECT] });
		expect(full.status).toBe(503);
		expect((await bodyOf(full)).error).toBe("temporarily_unavailable");
	});

	test("clients that never received a grant expire after 24 hours, granted ones do not", async () => {
		const h = await makeHarness();
		const idle = await registered(h);
		const used = await registered(h);
		await grant(h, used);
		h.clock.now += 25 * HOUR_MS;
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, idle, challenge)).status).toBe(400);
		expect((await authorizeCall(h, used, challenge)).status).toBe(200);
		expect(savedKeys(h, "clients")).toEqual([used]);
	});

	test("grants and clients with nothing live and no recent use are pruned", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		h.clock.now += 31 * 24 * HOUR_MS;
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, clientId, challenge)).status).toBe(400);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(401);
		const fresh = await registered(h);
		expect(savedKeys(h, "clients")).toEqual([fresh]);
		expect(savedKeys(h, "grants")).toEqual([]);
		expect(savedKeys(h, "tokens")).toEqual([]);
	});

	test("a client holds at most 5 pending authorizations", async () => {
		const h = await makeHarness();
		const busy = await registered(h);
		const other = await registered(h);
		const { challenge } = pkcePair();
		for (let i = 0; i < 5; i += 1)
			expect((await authorizeCall(h, busy, challenge)).status).toBe(200);
		expect((await authorizeCall(h, busy, challenge)).status).toBe(429);
		expect((await authorizeCall(h, other, challenge)).status).toBe(200);
		h.clock.now += PENDING_TTL_MS + 1;
		expect((await authorizeCall(h, busy, challenge)).status).toBe(200);
	});
});

describe("OAuth sweeper", () => {
	test("one shared timer serves every pending request", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		expect(h.timers).toHaveLength(0);
		const { challenge } = pkcePair();
		for (let i = 0; i < 3; i += 1)
			expect((await authorizeCall(h, clientId, challenge)).status).toBe(200);
		expect(h.timers).toHaveLength(1);
		expect(firstTimer(h).intervalMs).toBeGreaterThan(0);
	});

	test("a pass writes the state only when something expired, then stops when nothing is pending", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, clientId, challenge)).status).toBe(200);
		const timer = firstTimer(h);

		rmSync(h.statePath);
		timer.run();
		expect(existsSync(h.statePath)).toBe(false);
		expect(timer.cancelled).toBe(false);

		h.clock.now += PENDING_TTL_MS + 1;
		timer.run();
		expect(existsSync(h.statePath)).toBe(true);
		expect(timer.cancelled).toBe(true);
		expect(savedKeys(h, "pending")).toEqual([]);
	});

	test("a restart re-arms one sweeper for restored pending requests", async () => {
		const first = await makeHarness();
		const clientId = await registered(first);
		const { challenge } = pkcePair();
		expect((await authorizeCall(first, clientId, challenge)).status).toBe(200);
		const second = await makeHarness({}, first);
		expect(second.timers).toHaveLength(1);
	});
});

describe("OAuth consent page and CSP", () => {
	test("form-action allows the registered redirect origin and nothing else", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		expect(formAction(consent)).toBe("'self' https://claude.ai");

		const loopback = await registered(h, { redirect_uris: ["http://127.0.0.1:53211/cb"] });
		const local = await authorizeCall(h, loopback, challenge, {
			redirect_uri: "http://127.0.0.1:53211/cb",
		});
		expect(formAction(local)).toBe("'self' http://127.0.0.1:53211");
	});

	test("error pages allow 'self' only", async () => {
		const h = await makeHarness();
		const { challenge } = pkcePair();
		const unknown = await authorizeCall(h, "ut_client_missing", challenge);
		expect(unknown.status).toBe(400);
		expect(formAction(unknown)).toBe("'self'");
		const expired = await approveWith(
			h,
			`<input name="req" value="nope"><input name="nonce" value="nope">`,
			password,
		);
		expect(expired.status).toBe(400);
		expect(formAction(expired)).toBe("'self'");
	});

	test("a wrong password keeps the redirect origin in the policy", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		const retry = await approveWith(h, await consent.text(), "not-the-password");
		expect(retry.status).toBe(200);
		expect(formAction(retry)).toBe("'self' https://claude.ai");
	});

	test("the page shows the redirect origin and marks the client name unverified", async () => {
		const h = await makeHarness();
		const clientId = await registered(h, { client_name: "Claude <script>alert(1)</script>" });
		const { challenge } = pkcePair();
		const html = await (await authorizeCall(h, clientId, challenge)).text();
		// The shared encoder writes "/" as &#x2F;. A browser reads that back as the same origin.
		expect(html).toContain('data-redirect-origin="https:&#x2F;&#x2F;claude.ai"');
		expect(html).toContain('data-client-unverified="true"');
		expect(html).not.toContain("<script>");
	});

	test("a hostile client name and the page message render inert", async () => {
		const h = await makeHarness();
		const hostileName = `<img src=x onerror="alert(1)">"'&`;
		const clientId = await registered(h, { client_name: hostileName });
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		const html = await consent.text();
		expect(consent.status).toBe(200);
		expect(html).not.toContain("<img");
		expect(html).toContain(
			"<strong>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&quot;&apos;&amp;</strong>",
		);
		// A wrong password re-renders the page with its alert. The hostile name stays inert on that page too.
		const retryHtml = await (await approveWith(h, html, "not-the-password")).text();
		expect(retryHtml).toContain('<p class="err">Incorrect password.</p>');
		expect(retryHtml).not.toContain("<img");
		expect(retryHtml).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
	});
});

/** Keeps each validation refusal the logger seam reports, and writes nothing. */
class RecordingLogger implements SecurityEventLogger {
	readonly validation: Partial<SecurityEvent>[] = [];
	log(): void {
		// reason: the refusal test reads only validation events; other security events are not captured here.
	}
	logAuthFailure(): void {
		// reason: the refusal test reads only validation events; auth failures are not captured here.
	}
	logValidationFailure(details: Partial<SecurityEvent>): void {
		this.validation.push(details);
	}
	logRateLimitExceeded(): void {
		// reason: the refusal test reads only validation events; rate-limit events are not captured here.
	}
	logSuspiciousActivity(): void {
		// reason: the refusal test reads only validation events; suspicious-activity events are not captured here.
	}
}

describe("OAuth refused requests", () => {
	test("a repeated token parameter is refused before the code is redeemed, and the refusal is logged", async () => {
		const recorder = new RecordingLogger();
		const previous = getSecurityLogger();
		setSecurityLogger(recorder);
		try {
			const h = await makeHarness();
			const clientId = await registered(h);
			const { code, verifier, redirect } = await authorizedCode(h, clientId);
			const repeated = await h.oauth.token(
				new Request(`${ORIGIN}/oauth/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams([
						["grant_type", "authorization_code"],
						["code", code],
						["code", "ut_code_bogus"],
						["code_verifier", verifier],
						["client_id", clientId],
						["redirect_uri", redirect],
						["resource", RESOURCE],
					]).toString(),
				}),
				"203.0.113.50",
			);
			expect(repeated.status).toBe(400);
			expect(await bodyOf(repeated)).toEqual({
				error: "invalid_request",
				error_description: "code must appear once.",
			});
			expect(recorder.validation).toHaveLength(1);
			expect(recorder.validation[0]).toMatchObject({
				source: "oauth",
				resource: "/oauth/token",
				details: { field: "code", code: "DUPLICATE" },
			});
			// The refused request never reached the code store, so the single-valued retry still redeems the code.
			const redeemed = await tokenCall(h, {
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: redirect,
				resource: RESOURCE,
			});
			expect(redeemed.status).toBe(200);
		} finally {
			setSecurityLogger(previous);
		}
	});
});

describe("OAuth audit trail and response headers", () => {
	test("the audit sink records the grant lifecycle in order and never a secret", async () => {
		const events: { event: string; fields: Record<string, string | number | boolean> }[] = [];
		const h = await makeHarness({ audit: (event, fields) => events.push({ event, fields }) });
		const clientId = await registered(h);
		const { code, verifier, redirect } = await authorizedCode(h, clientId);
		const exchanged = await tokenCall(h, {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: redirect,
			resource: RESOURCE,
		});
		expect(exchanged.status).toBe(200);
		const first = await bodyOf(exchanged);
		const firstAccess = String(first.access_token);
		const firstRefresh = String(first.refresh_token);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: firstRefresh,
			client_id: clientId,
			resource: RESOURCE,
		});
		expect(refreshed.status).toBe(200);
		const second = await bodyOf(refreshed);
		expect(
			(
				await tokenCall(h, {
					grant_type: "refresh_token",
					refresh_token: firstRefresh,
					client_id: clientId,
				})
			).status,
		).toBe(400);
		const next = await grant(h, clientId);
		expect((await revokeCall(h, { token: next.access, client_id: clientId })).status).toBe(200);
		expect(events.map((entry) => entry.event)).toEqual([
			"client_registered",
			"login_ok",
			"consent_approved",
			"code_exchanged",
			"token_refreshed",
			"refresh_reuse_detected",
			"login_ok",
			"consent_approved",
			"code_exchanged",
			"token_revoked",
		]);
		for (const entry of events)
			expect(entry.fields).toEqual(
				entry.event === "login_ok" ? { ip: expect.any(String) } : { clientId },
			);
		const serialised = JSON.stringify(events);
		for (const secret of [
			code,
			verifier,
			firstAccess,
			firstRefresh,
			String(second.access_token),
			String(second.refresh_token),
			next.access,
			next.refresh,
		]) {
			expect(serialised).not.toContain(secret);
		}
	});

	test("a failing audit sink never changes an OAuth response", async () => {
		const h = await makeHarness({
			audit: () => {
				throw new Error("sink unavailable");
			},
		});
		const clientId = await registered(h);
		const { code, verifier, redirect } = await authorizedCode(h, clientId);
		const exchanged = await tokenCall(h, {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: redirect,
			resource: RESOURCE,
		});
		expect(exchanged.status).toBe(200);
		expect(typeof (await bodyOf(exchanged)).access_token).toBe("string");
	});

	test("OAuth JSON responses carry the framing and permissions headers", async () => {
		const h = await makeHarness();
		const responses = [
			h.oauth.protectedResourceMetadata(),
			h.oauth.authorizationServerMetadata(),
			await registerCall(h, { redirect_uris: [REDIRECT] }),
			await tokenCall(h, { grant_type: "unsupported" }),
			await revokeCall(h, { token: "ut_at_unknown" }),
		];
		for (const response of responses) {
			expect(response.headers.get("x-frame-options")).toBe("DENY");
			expect(response.headers.get("content-security-policy")).toBe(
				"default-src 'none'; frame-ancestors 'none'",
			);
			expect(response.headers.get("permissions-policy")).toBe(
				"camera=(), microphone=(), geolocation=()",
			);
		}
	});

	test("HTML pages keep their own CSP", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		const policy = consent.headers.get("content-security-policy") ?? "";
		expect(policy).toContain("form-action 'self' https://claude.ai");
		expect(policy).toContain("style-src 'unsafe-inline'");
		expect(policy).not.toBe("default-src 'none'; frame-ancestors 'none'");
	});

	test("a wrong consent password records login_failed and a correct one records login_ok", async () => {
		const events: { event: string; fields: Record<string, string | number | boolean> }[] = [];
		const h = await makeHarness({ audit: (event, fields) => events.push({ event, fields }) });
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const html = await (await authorizeCall(h, clientId, challenge)).text();
		const ip = "203.0.113.70";
		const wrong = await approveWith(h, html, "not-the-password", ip);
		expect(await wrong.text()).toContain("Incorrect password.");
		const right = await approveWith(h, html, password, ip);
		expect(new URL(right.headers.get("location") ?? "").searchParams.get("code")).not.toBeNull();
		expect(events.map((entry) => entry.event)).toEqual([
			"client_registered",
			"login_failed",
			"login_ok",
			"consent_approved",
		]);
		expect(events[1]?.fields).toEqual({ ip });
		expect(events[2]?.fields).toEqual({ ip });
		expect(JSON.stringify(events)).not.toContain(password);
	});

	test("exhausting the login window records rate_limited and no login_failed for the refused attempt", async () => {
		const events: { event: string; fields: Record<string, string | number | boolean> }[] = [];
		const h = await makeHarness({ audit: (event, fields) => events.push({ event, fields }) });
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const html = await (await authorizeCall(h, clientId, challenge)).text();
		const ip = "203.0.113.71";
		// Each attempt waits out the one-minute approval window, so only the login window can refuse.
		for (let i = 0; i < 5; i += 1) {
			h.clock.now += 61_000;
			expect(await (await approveWith(h, html, "not-the-password", ip)).text()).toContain(
				"Incorrect password.",
			);
		}
		h.clock.now += 61_000;
		const refused = await approveWith(h, html, "not-the-password", ip);
		expect(refused.status).toBe(429);
		expect(events.map((entry) => entry.event)).toEqual([
			"client_registered",
			"login_failed",
			"login_failed",
			"login_failed",
			"login_failed",
			"login_failed",
			"rate_limited",
		]);
		expect(events.at(-1)?.fields).toEqual({ scope: "login", ip });
	});
});

describe("OAuth resource, scope, client and issuer handling", () => {
	test("authorize accepts a trailing slash on the resource", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, clientId, challenge, { resource: `${RESOURCE}/` })).status).toBe(
			200,
		);
		const foreign = await authorizeCall(h, clientId, challenge, { resource: `${ORIGIN}/other` });
		expect(new URL(foreign.headers.get("location") ?? "").searchParams.get("error")).toBe(
			"invalid_target",
		);
	});

	test("resource is optional at the token endpoint and a different one is invalid_target", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { code, verifier } = await authorizedCode(h, clientId);
		const base = {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
		};
		const wrong = await tokenCall(h, { ...base, resource: `${ORIGIN}/other` });
		expect(wrong.status).toBe(400);
		expect((await bodyOf(wrong)).error).toBe("invalid_target");
		const without = await tokenCall(h, base);
		expect(without.status).toBe(200);
		const tokens = await bodyOf(without);
		expect(typeof tokens.refresh_token).toBe("string");
	});

	test("a trailing-slash resource is accepted at the token endpoint", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { code, verifier } = await authorizedCode(h, clientId);
		const response = await tokenCall(h, {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: `${RESOURCE}/`,
		});
		expect(response.status).toBe(200);
	});

	test("resource is optional on refresh, a different one is invalid_target and keeps the token usable", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const first = await grant(h, clientId);
		const wrong = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: first.refresh,
			client_id: clientId,
			resource: `${ORIGIN}/other`,
		});
		expect(wrong.status).toBe(400);
		expect((await bodyOf(wrong)).error).toBe("invalid_target");
		const without = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: first.refresh,
			client_id: clientId,
		});
		expect(without.status).toBe(200);
		const next = await bodyOf(without);
		const withResource = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: String(next.refresh_token),
			client_id: clientId,
			resource: RESOURCE,
		});
		expect(withResource.status).toBe(200);
	});

	test("an unknown client_id at the token endpoint is 401 invalid_client", async () => {
		const h = await makeHarness();
		const cases: Record<string, string>[] = [
			{
				grant_type: "authorization_code",
				code: "ut_code_x",
				client_id: "ut_client_gone",
				redirect_uri: REDIRECT,
			},
			{ grant_type: "refresh_token", refresh_token: "ut_rt_x", client_id: "ut_client_gone" },
			{ grant_type: "refresh_token", refresh_token: "ut_rt_x" },
		];
		for (const fields of cases) {
			const response = await tokenCall(h, fields);
			expect(response.status).toBe(401);
			expect((await bodyOf(response)).error).toBe("invalid_client");
			expect(response.headers.get("www-authenticate")).not.toBeNull();
		}
	});

	test("a known client with a bad code stays invalid_grant", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const response = await tokenCall(h, {
			grant_type: "authorization_code",
			code: "ut_code_x",
			client_id: clientId,
			redirect_uri: REDIRECT,
		});
		expect(response.status).toBe(400);
		expect((await bodyOf(response)).error).toBe("invalid_grant");
	});

	test("authorization redirects carry the issuer", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const failure = await authorizeCall(h, clientId, challenge, { response_type: "token" });
		expect(new URL(failure.headers.get("location") ?? "").searchParams.get("iss")).toBe(ORIGIN);
		const consent = await authorizeCall(h, clientId, challenge);
		const approved = await approveWith(h, await consent.text(), password);
		const location = new URL(approved.headers.get("location") ?? "");
		expect(location.searchParams.get("iss")).toBe(ORIGIN);
		expect(location.searchParams.get("state")).toBe("state-1");
		expect(location.searchParams.get("code")).not.toBeNull();
	});

	test("any requested scope is accepted and echoed on issue and refresh", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const first = await grant(h, clientId, { scope: "claudeai" });
		expect(first.body.scope).toBe("claudeai");
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: first.refresh,
			client_id: clientId,
		});
		expect((await bodyOf(refreshed)).scope).toBe("claudeai");
		const several = await grant(h, clientId, { scope: "mcp something:else" });
		expect(several.body.scope).toBe("mcp something:else");
	});

	test("no scope means no scope in the response, and a malformed one is ignored", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		expect("scope" in (await grant(h, clientId)).body).toBe(false);
		expect("scope" in (await grant(h, clientId, { scope: "bad\u0001scope" })).body).toBe(false);
	});

	test("metadata advertises issuer response, revocation and scopes", async () => {
		const h = await makeHarness();
		const metadata = await bodyOf(h.oauth.authorizationServerMetadata());
		expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
		expect(metadata.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
		expect(metadata.scopes_supported).toEqual(["mcp"]);
		expect(metadata.issuer).toBe(ORIGIN);
	});
});

describe("OAuth revocation and bearer classification", () => {
	test("revoking an access token ends the grant", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
		const response = await revokeCall(h, { token: tokens.access, token_type_hint: "access_token" });
		expect(response.status).toBe(200);
		expect(h.oauth.verifyAccessToken(tokens.access)).toBe(false);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("invalid");
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(400);
	});

	test("revoking a refresh token ends the access token too", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		expect((await revokeCall(h, { token: tokens.refresh, client_id: clientId })).status).toBe(200);
		expect(h.oauth.verifyAccessToken(tokens.access)).toBe(false);
		const refreshed = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: tokens.refresh,
			client_id: clientId,
		});
		expect(refreshed.status).toBe(400);
	});

	test("an unknown token still answers 200 and changes nothing", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		expect((await revokeCall(h, { token: "ut_at_does-not-exist" })).status).toBe(200);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
	});

	test("a client that names itself must own the token", async () => {
		const h = await makeHarness();
		const owner = await registered(h);
		const stranger = await registered(h);
		const tokens = await grant(h, owner);
		expect((await revokeCall(h, { token: tokens.access, client_id: stranger })).status).toBe(200);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
	});

	test("a call without a token is a bad request", async () => {
		const h = await makeHarness();
		expect((await revokeCall(h, { token_type_hint: "access_token" })).status).toBe(400);
	});

	test("classifyBearer separates valid, invalid and absent", async () => {
		const h = await makeHarness();
		const tokens = await grant(h, await registered(h));
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
		expect(h.oauth.classifyBearer("ut_at_not-a-real-token")).toBe("invalid");
		expect(h.oauth.classifyBearer(tokens.refresh)).toBe("invalid");
		expect(h.oauth.classifyBearer(null)).toBe("absent");
		expect(h.oauth.classifyBearer("")).toBe("absent");
		h.clock.now += ACCESS_TTL_MS + 1;
		expect(h.oauth.classifyBearer(tokens.access)).toBe("invalid");
	});
});

describe("OAuth state file", () => {
	test("is written 0600 with no temp file left behind", async () => {
		const h = await makeHarness();
		await registered(h);
		expect(statSync(h.statePath).mode & 0o777).toBe(0o600);
		expect(readdirSync(h.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("loading tightens a loose file mode", async () => {
		const first = await makeHarness();
		await registered(first);
		chmodSync(first.statePath, 0o644);
		await makeHarness({}, first);
		expect(statSync(first.statePath).mode & 0o777).toBe(0o600);
	});

	test("registered clients survive a restart", async () => {
		const first = await makeHarness();
		const clientId = await registered(first);
		const second = await makeHarness({}, first);
		const { challenge } = pkcePair();
		expect((await authorizeCall(second, clientId, challenge)).status).toBe(200);
	});

	async function rotate(h: Harness, clientId: string, refresh: string): Promise<Granted> {
		const rotated = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: refresh,
			client_id: clientId,
		});
		expect(rotated.status).toBe(200);
		const body = await bodyOf(rotated);
		const { access_token: access, refresh_token: next } = body;
		if (typeof access !== "string" || typeof next !== "string")
			throw new Error("rotation has no tokens");
		return { access, refresh: next, body };
	}

	test("a spent refresh token still revokes the grant inside the detection window", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const first = await grant(h, clientId);
		h.clock.now += HOUR_MS;
		const second = await rotate(h, clientId, first.refresh);
		// Live access + live refresh + the spent refresh kept for reuse detection.
		expect(savedKeys(h, "tokens")).toHaveLength(3);
		h.clock.now += 60_000;
		const reused = await tokenCall(h, {
			grant_type: "refresh_token",
			refresh_token: first.refresh,
			client_id: clientId,
		});
		expect(reused.status).toBe(400);
		expect(h.oauth.verifyAccessToken(second.access)).toBe(false);
		expect(savedKeys(h, "tokens")).toEqual([]);
	});

	test("hourly refresh rotation does not accumulate spent tokens", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		let current = await grant(h, clientId);
		for (let i = 0; i < 50; i += 1) {
			h.clock.now += HOUR_MS;
			current = await rotate(h, clientId, current.refresh);
		}
		expect(savedKeys(h, "tokens").length).toBeLessThanOrEqual(3);
		h.clock.now += 5 * 60 * 1000 + 1;
		// Registration prunes and writes the store.
		await registered(h);
		expect(savedKeys(h, "tokens")).toHaveLength(2);
		expect(h.oauth.verifyAccessToken(current.access)).toBe(true);
	});

	for (const [label, content] of [
		["garbage", "{not json"],
		["empty", ""],
		["a JSON array", "[]"],
	] as const) {
		test(`a corrupt file (${label}) is moved aside and the store starts empty`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-corrupt-"));
			harnessDirs.push(dir);
			writeFileSync(join(dir, "oauth.json"), content);
			const h = await makeHarness({}, { dir, clock: { now: HARNESS_START } });
			const aside = `oauth.json.corrupt-${HARNESS_START}`;
			expect(readdirSync(dir)).toContain(aside);
			expect(readFileSync(join(dir, aside), "utf8")).toBe(content);
			expect(existsSync(h.statePath)).toBe(false);
			await registered(h);
			expect(savedKeys(h, "clients")).toHaveLength(1);
		});
	}
});

describe("durable state writes", () => {
	function recordingFs(ops: string[]): DurableFs {
		return {
			...nodeFs,
			fsyncSync(fd) {
				ops.push("fsync");
				nodeFs.fsyncSync(fd);
			},
			renameSync(from, to) {
				ops.push("rename");
				nodeFs.renameSync(from, to);
			},
		};
	}

	test("syncs the file, renames it, then syncs the directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-durable-"));
		harnessDirs.push(dir);
		const ops: string[] = [];
		const path = join(dir, "state.json");
		writeFileDurably(dir, path, '{"a":1}', recordingFs(ops));
		expect(ops).toEqual(["fsync", "rename", "fsync"]);
		expect(readFileSync(path, "utf8")).toBe('{"a":1}');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	test("a failed sync leaves the old file and removes the temp file", () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-durable-"));
		harnessDirs.push(dir);
		const path = join(dir, "state.json");
		writeFileSync(path, "old");
		const failing: DurableFs = {
			...nodeFs,
			fsyncSync() {
				throw new Error("disk full");
			},
		};
		expect(() => writeFileDurably(dir, path, "new", failing)).toThrow("disk full");
		expect(readFileSync(path, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});
});

describe("OAuth token rollback when the state save fails", () => {
	// writeFileDurably opens `<state>.<pid>.tmp` before it writes anything. A directory at that path makes
	// the open fail, so persist() throws and the store never reaches disk. Removing it restores normal saves.
	function blockStateSave(h: Harness): string {
		const blocker = `${h.statePath}.${process.pid}.tmp`;
		nodeFs.mkdirSync(blocker);
		return blocker;
	}

	test("exchangeCode save-failure rollback restores the unused code and issues no tokens", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { code, verifier, redirect } = await authorizedCode(h, clientId);
		const fields = {
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: redirect,
			resource: RESOURCE,
		};
		const before = readFileSync(h.statePath, "utf8");
		const blocker = blockStateSave(h);
		try {
			const failed = await tokenCall(h, fields);
			expect(failed.status).toBe(500);
			expect((await bodyOf(failed)).error).toBe("server_error");
		} finally {
			rmSync(blocker, { recursive: true, force: true });
		}
		expect(readFileSync(h.statePath, "utf8")).toBe(before);
		expect(readdirSync(h.dir)).toEqual(["oauth.json"]);
		// The code was rolled back to unused, so a retry still redeems it.
		const retry = await tokenCall(h, fields);
		expect(retry.status).toBe(200);
		const tokens = await bodyOf(retry);
		expect(typeof tokens.access_token).toBe("string");
		expect(h.oauth.verifyAccessToken(tokens.access_token as string)).toBe(true);
	});

	test("refreshGrant save-failure rollback restores the refresh token and keeps the grant", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const first = await grant(h, clientId);
		const before = readFileSync(h.statePath, "utf8");
		const fields = {
			grant_type: "refresh_token",
			refresh_token: first.refresh,
			client_id: clientId,
		};
		const blocker = blockStateSave(h);
		try {
			const failed = await tokenCall(h, fields);
			expect(failed.status).toBe(500);
			expect((await bodyOf(failed)).error).toBe("server_error");
		} finally {
			rmSync(blocker, { recursive: true, force: true });
		}
		expect(readFileSync(h.statePath, "utf8")).toBe(before);
		expect(readdirSync(h.dir)).toEqual(["oauth.json"]);
		// The refresh token was rolled back to unspent, so a retry rotates it instead of tripping reuse detection.
		const retry = await tokenCall(h, fields);
		expect(retry.status).toBe(200);
		const rotated = await bodyOf(retry);
		expect(typeof rotated.access_token).toBe("string");
		expect(h.oauth.verifyAccessToken(rotated.access_token as string)).toBe(true);
	});
});

describe("OAuth boundary failures", () => {
	test("a quarantine rename that fails is logged under loadStore without the echoed token", async () => {
		const TOKEN_FIXTURE = "tok-test-FIXTURE0000000000000000";
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-boundary-"));
		harnessDirs.push(dir);
		const statePath = join(dir, "oauth.json");
		writeFileSync(statePath, `{"tokens": {"${TOKEN_FIXTURE}": `);
		nodeFs.mkdirSync(`${statePath}.corrupt-${HARNESS_START}`);
		const lines: string[] = [];
		const logger: Logger = {
			info() {
				// reason: info logs are not asserted by the OAuth test; only error lines are collected
			},
			warn() {
				// reason: warn logs are not asserted by the OAuth test; only error lines are collected
			},
			error: (event) => {
				lines.push(event);
			},
		};
		await makeHarness({ logger }, { dir, clock: { now: HARNESS_START } });
		expect(lines).toHaveLength(1);
		const line = lines[0] ?? "";
		expect(line.startsWith("loadStore: ")).toBe(true);
		expect(line).not.toContain(TOKEN_FIXTURE);
		expect(redactText(line, { home: "" })).toBe(line);
	});
});

describe("CIMD OFF handler", () => {
	const CLIENT = "https://client.example/meta.json";
	const REDIRECT_ORIGIN = "https://claude.ai";
	const DOCUMENT = JSON.stringify({
		client_id: CLIENT,
		redirect_uris: [`${REDIRECT_ORIGIN}/api/mcp/auth_callback`],
		token_endpoint_auth_method: "none",
	});

	function configFor(flag: string | undefined) {
		return loadConfig({
			ULTRATHINK_PUBLIC_ORIGIN: ORIGIN,
			ULTRATHINK_OWNER_PASSWORD_HASH: randomHash(),
			ULTRATHINK_SESSION_SECRET: randomBytes(24).toString("hex"),
			ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
			ULTRATHINK_CIMD: flag,
		});
	}

	// Counts every target that reaches the guarded transport and answers with a complete document.
	function countingGuard(): { guard: GuardedFetch; targets: string[] } {
		const targets: string[] = [];
		const guard: GuardedFetch = async (target) => {
			targets.push(target);
			return { ok: true, text: DOCUMENT, headers: {} };
		};
		return { guard, targets };
	}

	// No state file yet means nothing was saved, so no pending request or grant exists.
	function savedOrEmpty(h: Harness, section: "pending" | "grants"): string[] {
		return existsSync(h.statePath) ? savedKeys(h, section) : [];
	}

	test("unset and 0 answer DISABLED and never reach the guarded transport", async () => {
		for (const flag of [undefined, "0"]) {
			const { guard, targets } = countingGuard();
			const fetcher = createCimdFetcher(configFor(flag), new Set([REDIRECT_ORIGIN]), guard);
			expect(await fetcher.fetch(CLIENT)).toEqual({ ok: false, kind: "fetch", code: "DISABLED" });
			expect(targets).toEqual([]);
		}
	});

	test("OFF decides before the client id is judged or the signal is read", async () => {
		const { guard, targets } = countingGuard();
		const fetcher = createCimdFetcher(configFor("0"), new Set([REDIRECT_ORIGIN]), guard);
		const aborted = new AbortController();
		aborted.abort("OFF-SIGNAL-CANARY");
		const results = await Promise.all([
			fetcher.fetch(null),
			fetcher.fetch("http://insecure.example/meta.json"),
			fetcher.fetch(CLIENT, aborted.signal),
		]);
		const disabled = { ok: false, kind: "fetch", code: "DISABLED" } as const;
		expect(results).toEqual([disabled, disabled, disabled]);
		expect(targets).toEqual([]);
	});

	test("ON with the same guard reaches the transport once and returns the parsed document", async () => {
		const { guard, targets } = countingGuard();
		const fetcher = createCimdFetcher(configFor("1"), new Set([REDIRECT_ORIGIN]), guard);
		expect(await fetcher.fetch(CLIENT)).toMatchObject({
			ok: true,
			document: { client_id: CLIENT, token_endpoint_auth_method: "none" },
		});
		expect(targets).toEqual([CLIENT]);
	});

	test("the flag is read once when the fetcher is built, so a later change cannot turn it on", async () => {
		const { guard, targets } = countingGuard();
		const config: { cimdEnabled?: boolean } = { cimdEnabled: false };
		const fetcher = createCimdFetcher(config, new Set([REDIRECT_ORIGIN]), guard);
		config.cimdEnabled = true;
		expect(await fetcher.fetch(CLIENT)).toEqual({ ok: false, kind: "fetch", code: "DISABLED" });
		expect(targets).toEqual([]);
	});

	test("with the flag OFF, the authorize flow refuses an HTTPS client id with the unknown-client page and creates no pending authorization or consent record", async () => {
		const h = await makeHarness();
		const { challenge } = pkcePair();
		expect(savedOrEmpty(h, "pending")).toEqual([]);
		expect(savedOrEmpty(h, "grants")).toEqual([]);
		const response = await authorizeCall(h, CLIENT, challenge);
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("text/html");
		const body = await response.text();
		expect(body).toContain("Authorization failed");
		expect(body).toContain("This client is not registered with ultrathink.");
		expect(response.headers.get("location")).toBeNull();
		expect(savedOrEmpty(h, "pending")).toEqual([]);
		expect(savedOrEmpty(h, "grants")).toEqual([]);
	});

	test("with the switch OFF, the authorization server metadata has no client_id_metadata_document_supported key", async () => {
		const h = await makeHarness();
		const metadata = await bodyOf(h.oauth.authorizationServerMetadata());
		expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
	});
});

describe("CIMD advertisement (CIMD-13)", () => {
	test("with advertiseCimd on, the authorization server metadata advertises client_id_metadata_document_supported as true", async () => {
		const h = await makeHarness({ advertiseCimd: true });
		const metadata = await bodyOf(h.oauth.authorizationServerMetadata());
		expect(metadata.client_id_metadata_document_supported).toBe(true);
	});
});

describe("CIMD storage, digest and restart", () => {
	const URL_CLIENT = "https://client.example/cimd.json";

	function plantedDir(state: {
		clients?: Record<string, unknown>;
		grants?: Record<string, unknown>;
	}): string {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-cimd-"));
		harnessDirs.push(dir);
		writeFileSync(
			join(dir, "oauth.json"),
			JSON.stringify({ clients: {}, grants: {}, codes: {}, tokens: {}, pending: {}, ...state }),
		);
		return dir;
	}

	test("a metadataDigest written on a grant survives a reopen from oauth.json and a persisting DCR registration with the same value (OW-4 restore proof, unit level, not a disaster-recovery test)", async () => {
		const digest = "a".repeat(64);
		const dir = plantedDir({
			grants: {
				"grant-cimd": {
					clientId: URL_CLIENT,
					resource: RESOURCE,
					createdAt: HARNESS_START,
					metadataDigest: digest,
				},
			},
		});
		const from = { dir, clock: { now: HARNESS_START } };
		const first = await makeHarness({}, from);
		await registered(first);
		const reopened = await makeHarness({}, from);
		await registered(reopened);
		const saved = JSON.parse(readFileSync(reopened.statePath, "utf8")) as {
			grants: Record<string, { metadataDigest?: string }>;
		};
		expect(saved.grants["grant-cimd"]?.metadataDigest).toBe(digest);
	});

	test("a URL-keyed client that has a grant survives prune and reopen when it has no grantedAt and a createdAt older than 24 h (literal 25 h); the test reads savedKeys(h, 'clients') after a persisting DCR registration", async () => {
		const dir = plantedDir({
			clients: {
				[URL_CLIENT]: {
					name: "Planted",
					redirectUris: [REDIRECT],
					grantTypes: ["authorization_code"],
					createdAt: HARNESS_START - 25 * HOUR_MS,
				},
			},
			grants: {
				"grant-cimd": { clientId: URL_CLIENT, resource: RESOURCE, createdAt: HARNESS_START },
			},
		});
		const from = { dir, clock: { now: HARNESS_START } };
		const first = await makeHarness({}, from);
		await registered(first);
		expect(savedKeys(first, "clients")).toContain(URL_CLIENT);
		const reopened = await makeHarness({}, from);
		await registered(reopened);
		expect(savedKeys(reopened, "clients")).toContain(URL_CLIENT);
	});

	test("an ungranted DCR client past the 24 h TTL is still removed by clientRemovable on a persisting registration", async () => {
		const dir = plantedDir({
			clients: {
				ut_client_stale: {
					name: "Stale",
					redirectUris: [REDIRECT],
					grantTypes: ["authorization_code"],
					createdAt: HARNESS_START - 25 * HOUR_MS,
				},
			},
		});
		const h = await makeHarness({}, { dir, clock: { now: HARNESS_START } });
		const fresh = await registered(h);
		const keys = savedKeys(h, "clients");
		expect(keys).not.toContain("ut_client_stale");
		expect(keys).toContain(fresh);
	});

	test("CIMD-10: a granted URL client idle past GRANTED_CLIENT_IDLE_MS survives a prune while its grant exists", async () => {
		const idle = HARNESS_START - 31 * 24 * HOUR_MS;
		const dir = plantedDir({
			clients: {
				[URL_CLIENT]: {
					name: "Planted",
					redirectUris: [REDIRECT],
					grantTypes: ["authorization_code"],
					createdAt: idle,
					grantedAt: idle,
					lastUsedAt: idle,
				},
			},
			grants: {
				"grant-cimd": {
					clientId: URL_CLIENT,
					resource: RESOURCE,
					createdAt: HARNESS_START,
					lastUsedAt: HARNESS_START,
				},
			},
		});
		const h = await makeHarness({}, { dir, clock: { now: HARNESS_START } });
		await registered(h);
		expect(savedKeys(h, "clients")).toContain(URL_CLIENT);
		expect(savedKeys(h, "grants")).toEqual(["grant-cimd"]);
	});
});

// CIMD fixtures for the URL client id tests. The fake fetcher parses each document with the real
// parser, so the document checks and the trusted redirect origins behave as they do in production.
const CIMD_ORIGIN = "https://client.example";
const CIMD_URL = `${CIMD_ORIGIN}/cimd.json`;
const DOCUMENT_NAMED = {
	client_id: CIMD_URL,
	client_name: "Example Client",
	redirect_uris: [REDIRECT],
	grant_types: ["authorization_code", "refresh_token"],
	token_endpoint_auth_method: "none",
};

// A mutable CimdFetcher. It counts calls, answers with the current document or the configured
// failure, and sends the same cache headers on every fetch.
interface FakeCimd {
	fetch(raw: unknown): Promise<CimdFetchResult>;
	calls(): number;
	set(next: Record<string, unknown>): void;
	failWith(result: CimdFetchResult | null): void;
}

function fakeCimd(initial: Record<string, unknown>, headers: OutboundCacheHeaders = {}): FakeCimd {
	let current: Record<string, unknown> = initial;
	const cacheHeaders: OutboundCacheHeaders = headers;
	let failure: CimdFetchResult | null = null;
	let count = 0;
	return {
		async fetch(raw: unknown): Promise<CimdFetchResult> {
			count += 1;
			if (failure !== null) return failure;
			const parsed = parseCimdDocument(
				String(raw),
				JSON.stringify(current),
				new Set(DEFAULT_REDIRECT_ORIGINS),
			);
			if (!parsed.valid) return { ok: false, kind: "model", refused: parsed.refused };
			return { ok: true, document: parsed.value, headers: cacheHeaders };
		},
		calls: () => count,
		set(next: Record<string, unknown>) {
			current = next;
		},
		failWith(result: CimdFetchResult | null) {
			failure = result;
		},
	};
}

function savedOrNone(
	h: Harness,
	section: "clients" | "grants" | "tokens" | "pending" | "codes",
): string[] {
	return existsSync(h.statePath) ? savedKeys(h, section) : [];
}

describe("CIMD authorize GET", () => {
	// The same switch setup as the CIMD OFF handler, for the switch-off and guard-count cases.
	function configFor(flag: string | undefined) {
		return loadConfig({
			ULTRATHINK_PUBLIC_ORIGIN: ORIGIN,
			ULTRATHINK_OWNER_PASSWORD_HASH: randomHash(),
			ULTRATHINK_SESSION_SECRET: randomBytes(24).toString("hex"),
			ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
			ULTRATHINK_CIMD: flag,
		});
	}

	// Counts every target that reaches the guarded transport and answers with a complete document.
	function countingGuard(): { guard: GuardedFetch; targets: string[] } {
		const targets: string[] = [];
		const guard: GuardedFetch = async (target) => {
			targets.push(target);
			return { ok: true, text: JSON.stringify(DOCUMENT_NAMED), headers: {} };
		};
		return { guard, targets };
	}

	test("GET shows the document client_name, not MCP client, and creates one pending request", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const response = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("Example Client");
		expect(body).not.toContain("MCP client");
		expect(fake.calls()).toBe(1);
		expect(savedKeys(h, "pending")).toHaveLength(1);
		expect(savedKeys(h, "clients")).toEqual([]);
	});

	test("GET with a client_name containing HTML markup renders the consent page with the markup escaped and the raw tag absent", async () => {
		const fake = fakeCimd({ ...DOCUMENT_NAMED, client_name: `<img src=x onerror=1>&"` });
		const h = await makeHarness({ cimd: fake });
		const response = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("&lt;img src=x onerror=1&gt;");
		expect(body).not.toContain("<img src=x onerror=1>");
	});

	test("GET with a redirect_uri not byte-equal to the document shows the DCR redirect message and creates no pending request", async () => {
		const h = await makeHarness({ cimd: fakeCimd(DOCUMENT_NAMED) });
		const response = await authorizeCall(h, CIMD_URL, pkcePair().challenge, {
			redirect_uri: `${REDIRECT}/`,
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain(
			"The redirect address does not match this client&apos;s registration.",
		);
		expect(savedOrNone(h, "pending")).toEqual([]);
	});

	test("GET with a query in client_id, or with the switch off, shows the unknown-client page and makes zero guard calls", async () => {
		const { challenge } = pkcePair();
		const onGuard = countingGuard();
		const onHarness = await makeHarness({
			cimd: createCimdFetcher(configFor("1"), new Set(DEFAULT_REDIRECT_ORIGINS), onGuard.guard),
		});
		const withQuery = await authorizeCall(onHarness, `${CIMD_URL}?x=1`, challenge);
		expect(withQuery.status).toBe(400);
		expect(await withQuery.text()).toContain("This client is not registered with ultrathink.");
		const offGuard = countingGuard();
		const offHarness = await makeHarness({
			cimd: createCimdFetcher(
				configFor(undefined),
				new Set(DEFAULT_REDIRECT_ORIGINS),
				offGuard.guard,
			),
		});
		const off = await authorizeCall(offHarness, CIMD_URL, challenge);
		expect(off.status).toBe(400);
		expect(await off.text()).toContain("This client is not registered with ultrathink.");
		expect(onGuard.targets).toEqual([]);
		expect(offGuard.targets).toEqual([]);
	});

	test("GET with a valid URL client_id and a bad response_type, with the document redirect_uri matched, fetches the document exactly once and returns the existing 302 unsupported_response_type redirect to that redirect_uri", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const response = await authorizeCall(h, CIMD_URL, pkcePair().challenge, {
			response_type: "token",
		});
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
		expect(location.searchParams.get("error")).toBe("unsupported_response_type");
		expect(fake.calls()).toBe(1);
	});

	test("each GET failure class (guard refusal, fetch failure, timeout, HTTP 404, invalid document) shows the failed-class error page, creates no pending request, and the body contains neither the URL nor its host", async () => {
		const cases: Array<[string, (fake: FakeCimd) => void]> = [
			[
				"guard refusal",
				(fake) => fake.failWith({ ok: false, kind: "fetch", code: "ADDRESS_REFUSED" }),
			],
			[
				"fetch failure",
				(fake) => fake.failWith({ ok: false, kind: "fetch", code: "NETWORK_FAILURE" }),
			],
			["timeout", (fake) => fake.failWith({ ok: false, kind: "fetch", code: "TIMEOUT" })],
			["HTTP 404", (fake) => fake.failWith({ ok: false, kind: "fetch", code: "HTTP_STATUS" })],
			[
				"invalid document",
				(fake) =>
					fake.set({ ...DOCUMENT_NAMED, token_endpoint_auth_method: "client_secret_basic" }),
			],
		];
		for (const [, arrange] of cases) {
			const fake = fakeCimd(DOCUMENT_NAMED);
			arrange(fake);
			const h = await makeHarness({ cimd: fake });
			const response = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
			const body = await response.text();
			expect(response.status).toBe(400);
			expect(body).toContain("The client details could not be retrieved.");
			expect(body).not.toContain(CIMD_URL);
			expect(body).not.toContain(CIMD_ORIGIN);
			expect(response.headers.get("location")).toBeNull();
			expect(savedOrNone(h, "pending")).toEqual([]);
		}
	});

	test("a BUSY result at GET shows 503 with the busy text and creates no pending request", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		fake.failWith({ ok: false, kind: "fetch", code: "BUSY" });
		const h = await makeHarness({ cimd: fake });
		const response = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain(
			"Client details are busy. Start the connection again from your client.",
		);
		expect(savedOrNone(h, "pending")).toEqual([]);
	});

	test("after cache expiry a failed re-fetch at GET shows an error page and never the consent page", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, { cacheControl: "max-age=60" });
		const h = await makeHarness({ cimd: fake });
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, CIMD_URL, challenge)).status).toBe(200);
		h.clock.now += 61_000;
		fake.failWith({ ok: false, kind: "fetch", code: "TIMEOUT" });
		const response = await authorizeCall(h, CIMD_URL, challenge);
		const body = await response.text();
		expect(response.status).toBe(400);
		expect(body).toContain("The client details could not be retrieved.");
		expect(body).not.toContain('name="req"');
		expect(fake.calls()).toBe(2);
	});

	test("a ut_client_ id on the same authorize path still resolves through data.clients and shows the DCR consent page", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const clientId = await registered(h);
		const response = await authorizeCall(h, clientId, pkcePair().challenge);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Test client");
		expect(fake.calls()).toBe(0);
	});

	test("restart empties the resolver cache and the next authorize calls the fetcher again", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, { cacheControl: "max-age=300" });
		const { challenge } = pkcePair();
		const first = await makeHarness({ cimd: fake });
		expect((await authorizeCall(first, CIMD_URL, challenge)).status).toBe(200);
		expect((await authorizeCall(first, CIMD_URL, challenge)).status).toBe(200);
		expect(fake.calls()).toBe(1);
		const restarted = await makeHarness({ cimd: fake }, { dir: first.dir, clock: first.clock });
		expect((await authorizeCall(restarted, CIMD_URL, challenge)).status).toBe(200);
		expect(fake.calls()).toBe(2);
	});

	test("a DCR registration after CIMD is enabled returns the same response shape as before", async () => {
		const body = {
			client_name: "Test client",
			redirect_uris: [REDIRECT],
			grant_types: ["authorization_code", "refresh_token"],
		};
		const plain = await makeHarness();
		const plainResponse = await registerCall(plain, body);
		expect(plainResponse.status).toBe(201);
		const plainKeys = Object.keys(await bodyOf(plainResponse)).sort();
		const enabled = await makeHarness({ cimd: fakeCimd(DOCUMENT_NAMED) });
		const enabledResponse = await registerCall(enabled, body);
		expect(enabledResponse.status).toBe(201);
		const enabledBody = await bodyOf(enabledResponse);
		expect(Object.keys(enabledBody).sort()).toEqual(plainKeys);
		expect(String(enabledBody.client_id)).toMatch(/^ut_client_/);
	});
});

describe("CIMD approval POST", () => {
	const OTHER_REDIRECT = "https://claude.com/api/mcp/auth_callback";
	const CHANGED_REDIRECTS = { ...DOCUMENT_NAMED, redirect_uris: [REDIRECT, OTHER_REDIRECT] };
	const EXPIRED_TEXT = "This authorization request expired.";
	const FAILED_TEXT =
		"The client details could not be retrieved. Start the connection again from your client.";

	test("POST approval resolves the URL, issues a code, and leaves data.clients unchanged", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const approved = await approveWith(h, await consent.text(), password);
		expect(approved.status).toBe(302);
		expect(codeFrom(approved)).toMatch(/^ut_code_/);
		expect(savedKeys(h, "clients")).toEqual([]);
		expect(fake.calls()).toBe(2);
	});

	test("POST with a wrong password makes no outbound call and re-renders the consent page with the stored name", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const wrong = await approveWith(h, await consent.text(), "not-the-owner-password");
		expect(wrong.status).toBe(200);
		const body = await wrong.text();
		expect(body).toContain("Incorrect password.");
		expect(body).toContain("Example Client");
		expect(fake.calls()).toBe(1);
	});

	test("POST after the document's redirect_uris or grant_types changed expires the pending request and creates no grant or code", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, { cacheControl: "no-store" });
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const html = await consent.text();
		fake.set(CHANGED_REDIRECTS);
		const expired = await approveWith(h, html, password);
		expect(expired.status).toBe(400);
		expect(await expired.text()).toContain(EXPIRED_TEXT);
		expect(expired.headers.get("location")).toBeNull();
		expect(savedKeys(h, "grants")).toEqual([]);
		expect(savedKeys(h, "pending")).toEqual([]);
	});

	test("a change made within the cache window is seen at approval and expires the pending request", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, { cacheControl: "max-age=300" });
		const h = await makeHarness({ cimd: fake });
		const t0 = h.clock.now;
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const html = await consent.text();
		h.clock.now = t0 + 100_000;
		fake.set(CHANGED_REDIRECTS);
		h.clock.now = t0 + 101_000;
		const expired = await approveWith(h, html, password);
		expect(expired.status).toBe(400);
		expect(await expired.text()).toContain(EXPIRED_TEXT);
		expect(fake.calls()).toBe(2);
		expect(savedKeys(h, "grants")).toEqual([]);
		expect(expired.headers.get("location")).toBeNull();
	});

	test("POST with a failed re-resolution shows the failed-class error page, creates no grant or code, and keeps the pending request until its TTL", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const html = await consent.text();
		fake.failWith({ ok: false, kind: "fetch", code: "TIMEOUT" });
		const failed = await approveWith(h, html, password);
		expect(failed.status).toBe(400);
		expect(await failed.text()).toContain(FAILED_TEXT);
		expect(failed.headers.get("location")).toBeNull();
		expect(savedKeys(h, "grants")).toEqual([]);
		expect(savedKeys(h, "pending")).toHaveLength(1);
		fake.failWith(null);
		const retried = await approveWith(h, html, password);
		expect(retried.status).toBe(302);
		expect(codeFrom(retried)).toMatch(/^ut_code_/);
	});

	test("POST with a BUSY re-resolution shows 503 with the busy text and creates no grant or code", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const html = await consent.text();
		fake.failWith({ ok: false, kind: "fetch", code: "BUSY" });
		const busy = await approveWith(h, html, password);
		expect(busy.status).toBe(503);
		expect(await busy.text()).toContain(
			"Client details are busy. Start the connection again from your client.",
		);
		expect(busy.headers.get("location")).toBeNull();
		expect(savedOrNone(h, "grants")).toEqual([]);
	});

	test("a client_name change between consent and approval re-prompts: the pending request is expired, the expired page is shown, and no grant or code is created", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const html = await consent.text();
		fake.set({ ...DOCUMENT_NAMED, client_name: "Renamed Client" });
		const expired = await approveWith(h, html, password);
		expect(expired.status).toBe(400);
		expect(await expired.text()).toContain(EXPIRED_TEXT);
		expect(expired.headers.get("location")).toBeNull();
		expect(savedKeys(h, "grants")).toEqual([]);
		expect(savedKeys(h, "pending")).toEqual([]);
	});

	test("a client_name unchanged between consent and approval approves and issues a code", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const approved = await approveWith(h, await consent.text(), password);
		expect(approved.status).toBe(302);
		expect(codeFrom(approved)).toMatch(/^ut_code_/);
	});
});

describe("OAuth approval deadline at the commit point", () => {
	const EXPIRED_TEXT = "This authorization request expired.";

	// The real owner auth with one change: onLogin runs before each login, so the clock can move while the password is checked.
	async function authAdvancingOnLogin(now: () => number, onLogin: () => void): Promise<Auth> {
		const real = createAuth({
			ownerPasswordHash: await Bun.password.hash(password),
			sessionSecret: HARNESS_SECRET,
			cookieSecure: true,
			now,
		});
		return {
			...real,
			login(input) {
				onLogin();
				return real.login(input);
			},
		};
	}

	test("a URL client whose deadline passes during login gets the expired response and creates no grant or code", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h: Harness = await makeHarness({
			cimd: fake,
			auth: await authAdvancingOnLogin(
				() => h.clock.now,
				() => {
					h.clock.now += PENDING_TTL_MS;
				},
			),
		});
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		expect(consent.status).toBe(200);
		const approved = await approveWith(h, await consent.text(), password);
		expect(approved.status).toBe(400);
		expect(await approved.text()).toContain(EXPIRED_TEXT);
		expect(approved.headers.get("location")).toBeNull();
		expect(fake.calls()).toBe(1);
		expect(savedOrNone(h, "grants")).toEqual([]);
		expect(savedOrNone(h, "codes")).toEqual([]);
	});

	test("a URL client whose deadline passes during the CIMD fetch is refused at the commit point and keeps no grant, code or pending request", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		let advanceOnFetch = false;
		const h: Harness = await makeHarness({
			cimd: {
				fetch(raw) {
					if (advanceOnFetch) h.clock.now += PENDING_TTL_MS;
					return fake.fetch(raw);
				},
			},
		});
		const consent = await authorizeCall(h, CIMD_URL, pkcePair().challenge);
		const html = await consent.text();
		advanceOnFetch = true;
		const expired = await approveWith(h, html, password);
		expect(expired.status).toBe(400);
		expect(await expired.text()).toContain(EXPIRED_TEXT);
		expect(expired.headers.get("location")).toBeNull();
		expect(fake.calls()).toBe(2);
		expect(savedOrNone(h, "grants")).toEqual([]);
		expect(savedOrNone(h, "codes")).toEqual([]);
		expect(savedOrNone(h, "pending")).toEqual([]);
	});
});

describe("OAuth client_id length by client kind", () => {
	const LONG_CIMD = `https://client.example/${"a".repeat(300)}/cimd.json`;
	const OVER_LIMIT_CIMD = `https://client.example/${"a".repeat(2048)}`;
	const AUTHORIZE_REFUSED = "This authorization request is not valid.";
	const CLIENT_ID_REFUSED = {
		error: "invalid_request",
		error_description: "client_id is not valid.",
	};

	test("an https client id longer than 256 and within 2048 characters completes authorize, approval and token exchange", async () => {
		expect(LONG_CIMD.length).toBeGreaterThan(256);
		const longDocument = { ...DOCUMENT_NAMED, client_id: LONG_CIMD };
		const h = await makeHarness({ cimd: fakeCimd(longDocument) });
		const tokens = await grant(h, LONG_CIMD);
		expect(tokens.access.length).toBeGreaterThan(0);
	});

	test("a client id over 256 characters that is not https is refused by authorize, token and revoke with the unchanged response", async () => {
		const h = await makeHarness();
		for (const clientId of ["c".repeat(257), `http://client.example/${"a".repeat(240)}`]) {
			const authorize = await authorizeCall(h, clientId, pkcePair().challenge);
			expect(authorize.status).toBe(400);
			expect(await authorize.text()).toContain(AUTHORIZE_REFUSED);
			const token = await tokenCall(h, {
				grant_type: "authorization_code",
				client_id: clientId,
			});
			expect(token.status).toBe(400);
			expect(await bodyOf(token)).toEqual(CLIENT_ID_REFUSED);
			const revoke = await revokeCall(h, { token: "t", client_id: clientId });
			expect(revoke.status).toBe(400);
			expect(await bodyOf(revoke)).toEqual(CLIENT_ID_REFUSED);
		}
	});

	test("an https client id over 2048 characters is refused by authorize before the CIMD fetch, with the unchanged response", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const response = await authorizeCall(h, OVER_LIMIT_CIMD, pkcePair().challenge);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain(AUTHORIZE_REFUSED);
		expect(fake.calls()).toBe(0);
	});
});

describe("CIMD token, refresh and drift", () => {
	const OTHER_REDIRECT = "https://claude.com/api/mcp/auth_callback";
	const OTHER_CLIENT = "https://other.example/cimd.json";
	const CHANGED = { ...DOCUMENT_NAMED, redirect_uris: [REDIRECT, OTHER_REDIRECT] };
	// No cache headers: every resolve fetches, so a change is seen at the next resolve (K2).
	const NO_STORE: OutboundCacheHeaders = { cacheControl: "no-store" };
	const DRIFT_TEXT = "The client details changed. Authorize the connection again.";
	const UNVERIFIED_TEXT =
		"The client details could not be verified. Start the connection again from your client.";
	// The client table cap (oauth.ts MAX_CLIENTS).
	const CLIENT_CAP = 200;

	function refreshFields(refresh: string): Record<string, string> {
		return {
			grant_type: "refresh_token",
			refresh_token: refresh,
			client_id: CIMD_URL,
			resource: RESOURCE,
		};
	}

	function codeFields(issued: {
		code: string;
		verifier: string;
		redirect: string;
	}): Record<string, string> {
		return {
			grant_type: "authorization_code",
			code: issued.code,
			code_verifier: issued.verifier,
			client_id: CIMD_URL,
			redirect_uri: issued.redirect,
			resource: RESOURCE,
		};
	}

	async function expectRefused(
		response: Response,
		error: string,
	): Promise<Record<string, unknown>> {
		expect(response.status).toBe(400);
		const body = await bodyOf(response);
		expect(body.error).toBe(error);
		return body;
	}

	async function expectUnverified(response: Response): Promise<void> {
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Basic realm="ultrathink"');
		const body = await bodyOf(response);
		expect(body.error).toBe("invalid_client");
		expect(body.error_description).toBe(UNVERIFIED_TEXT);
		expect(JSON.stringify(body)).not.toContain("Register the client again");
	}

	test("authorization_code exchange for a URL client issues tokens and leaves data.clients unchanged", async () => {
		const h = await makeHarness({ cimd: fakeCimd(DOCUMENT_NAMED) });
		const granted = await grant(h, CIMD_URL);
		expect(granted.access).toMatch(/^ut_at_/);
		expect(granted.refresh).toMatch(/^ut_rt_/);
		expect(savedKeys(h, "clients")).toEqual([]);
	});

	test("a CIMD grant from a real authorize, approval and exchange survives filling the client table to `MAX_CLIENTS` (200) and one more registration, and its refresh still succeeds", async () => {
		const h = await makeHarness({ cimd: fakeCimd(DOCUMENT_NAMED) });
		const granted = await grant(h, CIMD_URL);
		// The first CLIENT_CAP registrations fill the table; the one after forces makeRoomForClient to
		// evict the oldest ungranted DCR client.
		for (let i = 0; i <= CLIENT_CAP; i += 1) {
			const response = await registerCall(h, {
				client_name: `Filler ${i}`,
				redirect_uris: [REDIRECT],
				grant_types: ["authorization_code", "refresh_token"],
			});
			expect(response.status).toBe(201);
		}
		const clients = savedKeys(h, "clients");
		expect(clients).toHaveLength(CLIENT_CAP);
		expect(clients).not.toContain(CIMD_URL);
		expect(savedKeys(h, "grants")).toHaveLength(1);
		expect((await tokenCall(h, refreshFields(granted.refresh))).status).toBe(200);
	}, 60_000);

	test("a URL client whose document omits grant_types gets unauthorized_client on refresh", async () => {
		const noGrantTypes = {
			client_id: CIMD_URL,
			client_name: "Example Client",
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "none",
		};
		const h = await makeHarness({ cimd: fakeCimd(noGrantTypes) });
		const granted = await grant(h, CIMD_URL);
		const refreshed = await tokenCall(h, refreshFields(granted.refresh));
		expect(refreshed.status).toBe(400);
		expect((await bodyOf(refreshed)).error).toBe("unauthorized_client");
	});

	test("every token resolution failure (unknown, busy, failed, no resolver) returns 401 invalid_client with the URL message and without the register-again text", async () => {
		for (const code of ["DISABLED", "BUSY", "TIMEOUT"] as const) {
			const fake = fakeCimd(DOCUMENT_NAMED);
			const h = await makeHarness({ cimd: fake });
			const granted = await grant(h, CIMD_URL);
			// Refresh reads the cache. Age the entry past the 300 s ceiling so the refresh must fetch.
			h.clock.now += 5 * 60 * 1000 + 1;
			fake.failWith({ ok: false, kind: "fetch", code });
			await expectUnverified(await tokenCall(h, refreshFields(granted.refresh)));
		}
		const h = await makeHarness({ cimd: fakeCimd(DOCUMENT_NAMED) });
		const granted = await grant(h, CIMD_URL);
		const bare = await makeHarness({}, { dir: h.dir, clock: h.clock });
		await expectUnverified(await tokenCall(bare, refreshFields(granted.refresh)));
	}, 60_000);

	test("token exchange for a URL client whose document sends no-store refuses with invalid_client when the fetch fails at exchange", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, { cacheControl: "no-store" });
		const h = await makeHarness({ cimd: fake });
		const issued = await authorizedCode(h, CIMD_URL);
		// A no-store document is never cached, so the exchange must fetch and sees the failure.
		fake.failWith({ ok: false, kind: "fetch", code: "TIMEOUT" });
		await expectUnverified(await tokenCall(h, codeFields(issued)));
	});

	test("a token request for a URL client whose code is unknown, used, expired or bound to another client, or whose refresh token is unknown, used or bound to another client, calls the fetcher zero times and returns invalid_grant; a replayed used code and a replayed used refresh token still revoke their grant", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED);
		const h = await makeHarness({ cimd: fake });
		const refuse = async (fields: Record<string, string>): Promise<void> => {
			const before = fake.calls();
			await expectRefused(await tokenCall(h, fields), "invalid_grant");
			expect(fake.calls()).toBe(before);
		};
		await refuse({
			grant_type: "authorization_code",
			code: "ut_code_unknown",
			client_id: CIMD_URL,
			redirect_uri: REDIRECT,
		});
		await refuse(refreshFields("ut_rt_unknown"));

		const bound = await authorizedCode(h, CIMD_URL);
		await refuse({ ...codeFields(bound), client_id: OTHER_CLIENT });
		// The refusal revoked nothing: the code still redeems for its own client.
		expect((await tokenCall(h, codeFields(bound))).status).toBe(200);

		const expiring = await authorizedCode(h, CIMD_URL);
		h.clock.now += CODE_TTL_MS + 1;
		await refuse(codeFields(expiring));

		const used = await authorizedCode(h, CIMD_URL);
		const issued = await tokenCall(h, codeFields(used));
		expect(issued.status).toBe(200);
		const access = String((await bodyOf(issued)).access_token);
		expect(h.oauth.verifyAccessToken(access)).toBe(true);
		await refuse(codeFields(used));
		expect(h.oauth.verifyAccessToken(access)).toBe(false);

		const rolling = await grant(h, CIMD_URL);
		const rotated = await tokenCall(h, refreshFields(rolling.refresh));
		expect(rotated.status).toBe(200);
		const next = String((await bodyOf(rotated)).refresh_token);
		await refuse(refreshFields(rolling.refresh));
		await refuse(refreshFields(next));

		const other = await grant(h, CIMD_URL);
		await refuse({ ...refreshFields(other.refresh), client_id: OTHER_CLIENT });
		expect((await tokenCall(h, refreshFields(other.refresh))).status).toBe(200);
	});

	test("unchanged re-fetch: refresh returns 200 with tokens, and the persisted pending and grants key sets are unchanged (savedOrEmpty before and after)", async () => {
		const h = await makeHarness({ cimd: fakeCimd(DOCUMENT_NAMED, NO_STORE) });
		const granted = await grant(h, CIMD_URL);
		expect((await authorizeCall(h, CIMD_URL, pkcePair().challenge)).status).toBe(200);
		const pendingBefore = savedOrNone(h, "pending");
		const grantsBefore = savedOrNone(h, "grants");
		expect(pendingBefore).toHaveLength(1);
		const refreshed = await tokenCall(h, refreshFields(granted.refresh));
		expect(refreshed.status).toBe(200);
		expect(savedOrNone(h, "pending")).toEqual(pendingBefore);
		expect(savedOrNone(h, "grants")).toEqual(grantsBefore);
	});

	test("re-fetch that changes redirect_uris (changed after the approval POST and before the token call): refresh is refused with invalid_grant; fresh consent then issues tokens", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const granted = await grant(h, CIMD_URL);
		fake.set(CHANGED);
		const refused = await expectRefused(
			await tokenCall(h, refreshFields(granted.refresh)),
			"invalid_grant",
		);
		expect(refused.error_description).toBe(DRIFT_TEXT);
		const fresh = await grant(h, CIMD_URL);
		expect(fresh.access).toMatch(/^ut_at_/);
	});

	test("re-fetch that changes grant_types (changed after the approval POST and before the token call): refresh is refused with invalid_grant", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const granted = await grant(h, CIMD_URL);
		fake.set({ ...DOCUMENT_NAMED, grant_types: ["refresh_token"] });
		const refused = await expectRefused(
			await tokenCall(h, refreshFields(granted.refresh)),
			"invalid_grant",
		);
		expect(refused.error_description).toBe(DRIFT_TEXT);
	});

	test("re-fetch that changes the document between authorize and exchange (changed after the approval POST and before the token call): exchange is refused with invalid_grant and issues no token", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const issued = await authorizedCode(h, CIMD_URL);
		fake.set(CHANGED);
		const refused = await expectRefused(await tokenCall(h, codeFields(issued)), "invalid_grant");
		expect(refused.error_description).toBe(DRIFT_TEXT);
		expect(refused.access_token).toBeUndefined();
		// The refusal did not mark the code used: once the document reverts, the same code exchanges.
		fake.set(DOCUMENT_NAMED);
		expect((await tokenCall(h, codeFields(issued))).status).toBe(200);
	});

	test("a URL client whose re-fetched document no longer lists authorization_code gets unauthorized_client at exchange, with no token", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const issued = await authorizedCode(h, CIMD_URL);
		fake.set({ ...DOCUMENT_NAMED, grant_types: ["refresh_token"] });
		const refused = await tokenCall(h, codeFields(issued));
		expect(refused.status).toBe(400);
		const body = await bodyOf(refused);
		expect(body.error).toBe("unauthorized_client");
		expect(body.access_token).toBeUndefined();
	});

	test("a drift refusal leaves the refresh token usable (changed after the approval POST and before the token call): once the document reverts, the same refresh token refreshes", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const granted = await grant(h, CIMD_URL);
		fake.set(CHANGED);
		await expectRefused(await tokenCall(h, refreshFields(granted.refresh)), "invalid_grant");
		fake.set(DOCUMENT_NAMED);
		expect((await tokenCall(h, refreshFields(granted.refresh))).status).toBe(200);
	});

	test("a re-fetch that only reorders redirect_uris or grant_types, or only adds duplicates (changed after the approval POST and before the token call), refreshes with no drift refusal", async () => {
		const fake = fakeCimd(
			{ ...DOCUMENT_NAMED, redirect_uris: [REDIRECT, OTHER_REDIRECT] },
			NO_STORE,
		);
		const h = await makeHarness({ cimd: fake });
		const granted = await grant(h, CIMD_URL);
		fake.set({
			...DOCUMENT_NAMED,
			redirect_uris: [OTHER_REDIRECT, REDIRECT, REDIRECT],
			grant_types: ["refresh_token", "authorization_code", "refresh_token"],
		});
		expect((await tokenCall(h, refreshFields(granted.refresh))).status).toBe(200);
	});

	test("a CIMD grant with no metadataDigest refuses refresh (fail closed)", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const granted = await grant(h, CIMD_URL);
		const saved = JSON.parse(readFileSync(h.statePath, "utf8")) as {
			grants: Record<string, Record<string, unknown>>;
		};
		for (const [id, record] of Object.entries(saved.grants)) {
			saved.grants[id] = Object.fromEntries(
				Object.entries(record).filter(([key]) => key !== "metadataDigest"),
			);
		}
		writeFileSync(h.statePath, JSON.stringify(saved));
		const reopened = await makeHarness({ cimd: fake }, { dir: h.dir, clock: h.clock });
		await expectRefused(await tokenCall(reopened, refreshFields(granted.refresh)), "invalid_grant");
	});

	test("OW-1: a token minted before a drift stays valid until ACCESS_TTL_MS, while the next refresh and the next code exchange under the drifted document are refused with invalid_grant", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const h = await makeHarness({ cimd: fake });
		const first = await grant(h, CIMD_URL);
		const second = await authorizedCode(h, CIMD_URL);
		fake.set(CHANGED);
		const exchanged = await expectRefused(await tokenCall(h, codeFields(second)), "invalid_grant");
		expect(exchanged.access_token).toBeUndefined();
		await expectRefused(await tokenCall(h, refreshFields(first.refresh)), "invalid_grant");
		expect(h.oauth.verifyAccessToken(first.access)).toBe(true);
		h.clock.now += ACCESS_TTL_MS + 1;
		expect(h.oauth.verifyAccessToken(first.access)).toBe(false);
	});

	test("OW-6: with a max-age=300 document fetched by the approval POST at time t0 (the approval replaces the cache entry), a change made at t0 after that approval POST and before the token call is seen by refresh only after the cache entry expires: a refresh at t0+100 s succeeds from cache with zero new fetches, and a refresh at t0+301 s is refused with invalid_grant. With a no-store document, the same change is refused on the next refresh with no lag", async () => {
		const cached = fakeCimd(DOCUMENT_NAMED, { cacheControl: "max-age=300" });
		const h = await makeHarness({ cimd: cached });
		const t0 = h.clock.now;
		const granted = await grant(h, CIMD_URL);
		const afterGrant = cached.calls();
		cached.set(CHANGED);
		h.clock.now = t0 + 100_000;
		const early = await tokenCall(h, refreshFields(granted.refresh));
		expect(early.status).toBe(200);
		expect(cached.calls()).toBe(afterGrant);
		const rotated = String((await bodyOf(early)).refresh_token);
		h.clock.now = t0 + 301_000;
		await expectRefused(await tokenCall(h, refreshFields(rotated)), "invalid_grant");
		expect(cached.calls()).toBe(afterGrant + 1);

		const strict = fakeCimd(DOCUMENT_NAMED, NO_STORE);
		const strictHarness = await makeHarness({ cimd: strict });
		const strictGrant = await grant(strictHarness, CIMD_URL);
		strict.set(CHANGED);
		await expectRefused(
			await tokenCall(strictHarness, refreshFields(strictGrant.refresh)),
			"invalid_grant",
		);
	});

	test("a fresh fetch that returns the consented metadata does not refuse, even after the cache entry has expired at 301 s: the document is changed to B after the approval POST and before the token call, then set back to the consented A before the refresh at t0+301 s, which fetches fresh and succeeds", async () => {
		const fake = fakeCimd(DOCUMENT_NAMED, { cacheControl: "max-age=300" });
		const h = await makeHarness({ cimd: fake });
		const t0 = h.clock.now;
		const granted = await grant(h, CIMD_URL);
		fake.set(CHANGED);
		fake.set(DOCUMENT_NAMED);
		h.clock.now = t0 + 301_000;
		const before = fake.calls();
		expect((await tokenCall(h, refreshFields(granted.refresh))).status).toBe(200);
		expect(fake.calls()).toBe(before + 1);
	});
});
