// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Shared fixtures for the route tests: one connector key, owner password and session secret per test process, the base
// UltrathinkConfig, and a harness that opens the real SQLite store and keeps the logger's lines. Each test file passes its
// own config and deps overrides through HarnessOptions. closeHarnesses() releases what the harnesses opened; a file calls
// it from afterAll.

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type Auth, createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { createLogger } from "../obs/log.ts";
import { type Store, openStore } from "../store/store.ts";
import { makeTempDir } from "../test.helpers.ts";
import { type App, type RouterDeps, createApp } from "./router.ts";

export const ORIGIN = "https://ultrathink.test";
export const RESOURCE = `${ORIGIN}/mcp`;
export const PEER = "127.0.0.1";
export const CONNECTOR_KEY = randomBytes(24).toString("hex");
export const OWNER_PASSWORD = randomBytes(24).toString("base64url");
export const OWNER_HASH = await Bun.password.hash(OWNER_PASSWORD);
export const SESSION_SECRET = randomBytes(32).toString("hex");

export type LogLine = Record<string, unknown>;

export interface Harness {
	app: App;
	dir: string;
	store: Store;
	config: UltrathinkConfig;
	logs: LogLine[];
}

export interface HarnessOptions {
	config?: Partial<UltrathinkConfig>;
	deps?: Partial<RouterDeps>;
	auth?: Auth;
}

const dirs: string[] = [];
const stores: Store[] = [];

/** A fresh temp directory, removed by closeHarnesses or releaseHarness. */
export function tempDir(): string {
	return makeTempDir("ultrathink-http-test-", dirs);
}

/** The config every harness starts from; `overrides` replaces any field. */
function baseConfig(dir: string, overrides: Partial<UltrathinkConfig> = {}): UltrathinkConfig {
	return {
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
}

/** An App over a real store in a fresh temp directory. The logger keeps every line it writes in `logs`. */
export function harness(options: HarnessOptions = {}): Harness {
	const dir = tempDir();
	const config = baseConfig(dir, options.config);
	const store = openStore(config.dbPath);
	stores.push(store);
	const auth =
		options.auth ??
		createAuth({
			ownerPasswordHash: OWNER_HASH,
			sessionSecret: SESSION_SECRET,
			cookieSecure: true,
		});
	const logs: LogLine[] = [];
	const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) });
	const app = createApp({ config, store, auth, logger, ...options.deps });
	return { app, dir, store, config, logs };
}

/** A POST to `path` with the connector key. `rawBody` goes out exactly as given. */
function mcpRawRequest(
	rawBody: string,
	headers: Record<string, string> = {},
	path = "/mcp",
): Request {
	return new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY, ...headers },
		body: rawBody,
	});
}

/** A POST whose body is the JSON encoding of `body`. */
export function mcpRequest(
	body: unknown,
	headers: Record<string, string> = {},
	path = "/mcp",
): Request {
	return mcpRawRequest(JSON.stringify(body), headers, path);
}

/** Sends a JSON-RPC body to the MCP endpoint of `h`. */
export function rpc(
	h: Harness,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return h.app.handle(mcpRequest(body, headers), PEER);
}

/** Sends `rawBody` to the MCP endpoint of `h`, so a test can send something that is not JSON. */
export function postRaw(
	h: Harness,
	rawBody: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return h.app.handle(mcpRawRequest(rawBody, headers), PEER);
}

/** Closes one harness now and removes its directory, for a test that tears its own harness down before afterAll. */
export function releaseHarness(h: Harness): void {
	h.store.close();
	stores.splice(stores.indexOf(h.store), 1);
	rmSync(h.dir, { recursive: true, force: true });
	dirs.splice(dirs.indexOf(h.dir), 1);
}

/** Closes every store and removes every temp directory the harnesses made. A test file calls it from afterAll. */
export function closeHarnesses(): void {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// reason: already closed
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
