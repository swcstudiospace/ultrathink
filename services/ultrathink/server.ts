// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { accessSync, constants, existsSync } from "node:fs";
import pkg from "../../package.json";
import { createAuth } from "./auth/auth.ts";
import { loadChaosBackend } from "./chaos/faults.ts";
import { ConfigError, type TlsFiles, type UltrathinkConfig, loadConfig } from "./config/config.ts";
import { createPlanBackend } from "./engine/plan.ts";
import { createShutdown, installProcessHandlers } from "./lifecycle.ts";
import { ToolDefinitionError, assertToolDefinitions } from "./mcp/definitions.ts";
import { TOOL_DEFINITIONS } from "./mcp/mcp.ts";
import { createLogger } from "./obs/log.ts";
import { type App, createApp } from "./routes/router.ts";
import { identityFromUriSans } from "./security/identity.ts";
import { assertMtlsRuntime, startMtlsServer } from "./security/mtls.ts";
import { openStore } from "./store/store.ts";

// Running plans are aborted and marked interrupted within 5 s of the signal; the rest is draining connections.
const SHUTDOWN_TIMEOUT_MS = 20_000;
// Long polling waits up to 45 s per tool call.
const IDLE_TIMEOUT_SEC = 75;

function loadConfigOrExit(): UltrathinkConfig {
	try {
		return loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}
		throw error;
	}
}

// A tool definition that a strict client would reject stops the service before it opens a socket, with the tool named.
function assertToolDefinitionsOrExit(): void {
	try {
		assertToolDefinitions(TOOL_DEFINITIONS);
	} catch (error) {
		if (error instanceof ToolDefinitionError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}
		throw error;
	}
}

// The TLS files must exist and be readable before any socket opens. A failure names the variable and its path only.
function requireReadableOrExit(name: string, path: string): void {
	if (!existsSync(path)) {
		process.stderr.write(`${name} points to a missing file: ${path}\n`);
		process.exit(1);
	}
	try {
		accessSync(path, constants.R_OK);
	} catch {
		process.stderr.write(`${name} points to an unreadable file: ${path}\n`);
		process.exit(1);
	}
}

interface Listener {
	/** Bun types the bound port as optional; the mTLS listener always reports one. */
	readonly port: number | undefined;
	stop(): Promise<void>;
}

// With TLS configured the listener is mTLS only: the handshake refuses any client that does not chain to the CA, and
// the verified SPIFFE identity (never a header) is the only identity the router sees.
async function startTlsListener(
	tls: TlsFiles,
	config: UltrathinkConfig,
	app: App,
): Promise<Listener> {
	assertMtlsRuntime();
	requireReadableOrExit("ULTRATHINK_TLS_CERT", tls.certFile);
	requireReadableOrExit("ULTRATHINK_TLS_KEY", tls.keyFile);
	requireReadableOrExit("ULTRATHINK_TLS_CLIENT_CA", tls.clientCaFile);
	try {
		return await startMtlsServer(
			{
				port: config.port,
				certFile: tls.certFile,
				keyFile: tls.keyFile,
				clientCaFile: tls.clientCaFile,
				idleTimeoutSec: IDLE_TIMEOUT_SEC,
				maxBodyBytes: config.maxBodyBytes,
			},
			async (req, peer) => {
				const identity = identityFromUriSans(peer.uriSans, config.spiffeTrustDomain);
				return app.handle(req, peer.ip, { spiffeId: identity.ok ? identity.spiffeId : null });
			},
		);
	} catch (error) {
		// A bind failure names the port and the system error code only; the TLS file paths are never printed.
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		process.stderr.write(`mTLS listener could not bind 127.0.0.1:${config.port} (${code})\n`);
		process.exit(1);
	}
}

// Plaintext exists only behind the loopback opt-in, which config.ts requires whenever no TLS files are set.
function startPlaintextListener(config: UltrathinkConfig, app: App): Listener {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: config.port,
		idleTimeout: IDLE_TIMEOUT_SEC,
		maxRequestBodySize: config.maxBodyBytes,
		fetch(req, bunServer) {
			return app.handle(req, bunServer.requestIP(req)?.address ?? "");
		},
	});
}

// A hosted plan with neither timer set has nothing that stops a model call that hangs; the defaults stay 0 by policy, so
// the operator is told instead.
function timeoutWarning(config: UltrathinkConfig): string | undefined {
	if (!config.serverPlanning || config.modelTimeoutMs > 0 || config.planTimeoutMs > 0)
		return undefined;
	return "ULTRATHINK_MODEL_TIMEOUT_MS and ULTRATHINK_PLAN_TIMEOUT_MS are both 0: a model call that hangs is never stopped and keeps its plan slot until the process restarts or the client cancels the plan";
}

// `--check-config` validates the environment and exits before any store, socket or tool-definition work.
if (process.argv.includes("--check-config")) {
	let checked: UltrathinkConfig;
	try {
		checked = loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}
		throw error;
	}
	const warning = timeoutWarning(checked);
	if (warning !== undefined) process.stderr.write(`warning: ${warning}\n`);
	process.stdout.write("config ok\n");
	process.exit(0);
}

const config = loadConfigOrExit();
assertToolDefinitionsOrExit();
const logger = createLogger();
const store = openStore(config.dbPath);
const auth = createAuth({
	ownerPasswordHash: config.ownerPasswordHash,
	sessionSecret: config.sessionSecret,
	previousSessionSecrets: config.sessionSecretPrevious,
	cookieSecure: config.publicOrigin.startsWith("https://"),
});
// Chaos builds the real plan backend around a faulty `claude` seam, so faults land inside the same timed child call
// production uses; off, nothing is built here and the planner makes its own backend.
const chaosBackend = loadChaosBackend(config, (claude) =>
	createPlanBackend({
		model: config.planningModel,
		fallback: config.planFallback ?? "none",
		concurrency: config.planConcurrency ?? 2,
		timeoutMs: config.modelTimeoutMs,
		env: process.env,
		claude,
	}),
);
const app = createApp({
	config,
	store,
	auth,
	logger,
	...(chaosBackend ? { planBackend: chaosBackend } : {}),
});

const listener: Listener =
	config.tls === undefined
		? startPlaintextListener(config, app)
		: await startTlsListener(config.tls, config, app);
app.start();

const shutdown = createShutdown({
	server: { stop: () => listener.stop() },
	app,
	store,
	logger,
	timeoutMs: SHUTDOWN_TIMEOUT_MS + config.drainMs,
	beginDrain: () => app.beginDrain(),
	drainMs: config.drainMs,
	exit: (code) => process.exit(code),
});
installProcessHandlers(shutdown, logger, process);

if (config.legacyEnvIgnored.length > 0) {
	logger.warn("config_ignored_env", {
		names: config.legacyEnvIgnored,
		message:
			"these variables are no longer used by the hosted service; remove them from the environment file",
	});
}

const timeouts = timeoutWarning(config);
if (timeouts !== undefined) logger.warn("timeouts_unset", { message: timeouts });

logger.info("listening", {
	version: pkg.version,
	port: listener.port,
	tls: config.tls !== undefined,
	trustDomain: config.spiffeTrustDomain,
	serverPlanning: config.serverPlanning,
	planningModel: config.planningModel,
	maxConcurrentPlans: config.maxConcurrentPlans,
});
