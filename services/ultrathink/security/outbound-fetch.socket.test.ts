// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
	createOutboundFetchGuard,
	createPinnedRequest,
	type GuardedFetch,
	type OutboundFetchDeps,
	runningRuntimeVersion,
} from "./outbound-fetch.ts";

// A public IP literal: the guard validates it and dials it with no DNS lookup. The local server stands in for it.
const PUBLIC = "93.184.216.34";
const TARGET = `https://${PUBLIC}/meta.json`;
const POLICY = { timeoutMs: 5000, maxBytes: 4096, maxInflight: 4 };
const SILENT_TIMEOUT_MS = 300;
const BODY = '{"issuer":"https://client.example"}';
const encoder = new TextEncoder();
const RESPONSE = [
	"HTTP/1.1 200 OK",
	"Content-Type: application/json",
	`Content-Length: ${encoder.encode(BODY).byteLength}`,
	"Connection: close",
	"",
	BODY,
].join("\r\n");
const LEAF_EXT = `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${PUBLIC}\n`;

interface ArmedTimer {
	readonly run: () => void;
	readonly delayMs: number;
}

let dir = "";
let ca = "";
let server: tls.Server;
let serverPort = 0;
let silent = false;
let onRequest: (() => void) | undefined;
const served = new Set<tls.TLSSocket>();

function openssl(args: string[]): void {
	execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

/** The TCP port a listener bound to, failing the test if it is not a TCP listener. */
function boundPort(listener: net.Server): number {
	const address = listener.address();
	if (address === null || typeof address === "string") throw new Error("not a TCP listener");
	return address.port;
}

/** Records a socket's close as a promise, so a socket that never closes makes the test fail by timeout. */
function recordClose(socket: net.Socket, closes: Promise<void>[]): void {
	const { promise, resolve } = Promise.withResolvers<void>();
	socket.once("close", () => resolve());
	closes.push(promise);
}

/**
 * The guard over the real pinned request. Only the destination is rewritten: the guard has already validated
 * PUBLIC before the connect wrappers run, and they dial 127.0.0.1 on the local server's port. The TLS wrapper adds
 * the test CA. The deadline is the one timer the guard arms; it is collected in `timers` and fired by the test. The
 * clock is pinned, so only that timer can end an operation by deadline.
 */
function realSocketGuard(
	timeoutMs: number,
	closes: Promise<void>[],
	timers: Set<ArmedTimer>,
): GuardedFetch {
	const deps: OutboundFetchDeps = {
		createResolver: () => {
			throw new Error("DNS must not run for an IP-literal target");
		},
		startRequest: createPinnedRequest({
			connectTcp: (options) => {
				const socket = net.connect({ ...options, host: "127.0.0.1", port: serverPort });
				// Documented shim: the peer pin compares the socket's remoteAddress with the validated literal, and
				// the real peer is 127.0.0.1, which the guard refuses. The bytes and the TLS session stay real.
				Object.defineProperty(socket, "remoteAddress", { value: PUBLIC, configurable: true });
				recordClose(socket, closes);
				return socket;
			},
			connectTls: (options) => {
				const socket = tls.connect({ ...options, ca });
				recordClose(socket, closes);
				return socket;
			},
		}),
		now: () => 0,
		schedule: (run, delayMs) => {
			const timer = { run, delayMs };
			timers.add(timer);
			return () => {
				timers.delete(timer);
			};
		},
		runtimeVersion: runningRuntimeVersion,
	};
	return createOutboundFetchGuard({ ...POLICY, timeoutMs }, deps);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "outbound-socket-test-"));
	openssl([
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:P-256",
		"-nodes",
		"-keyout",
		"ca.key",
		"-out",
		"ca.pem",
		"-days",
		"2",
		"-subj",
		"/CN=outbound-socket-test-ca",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
		"-addext",
		"keyUsage=critical,keyCertSign,cRLSign",
	]);
	writeFileSync(join(dir, "leaf.ext"), LEAF_EXT);
	openssl([
		"req",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:P-256",
		"-nodes",
		"-keyout",
		"leaf.key",
		"-out",
		"leaf.csr",
		"-subj",
		`/CN=${PUBLIC}`,
	]);
	openssl([
		"x509",
		"-req",
		"-in",
		"leaf.csr",
		"-CA",
		"ca.pem",
		"-CAkey",
		"ca.key",
		"-CAcreateserial",
		"-out",
		"leaf.pem",
		"-days",
		"2",
		"-extfile",
		"leaf.ext",
	]);
	ca = readFileSync(join(dir, "ca.pem"), "utf8");
	const leafCert = readFileSync(join(dir, "leaf.pem"), "utf8");
	const leafKey = readFileSync(join(dir, "leaf.key"), "utf8");
	server = tls.createServer({ key: leafKey, cert: leafCert }, (socket) => {
		served.add(socket);
		socket.on("close", () => served.delete(socket));
		socket.on("error", () => {
			// reason: a client that times out and aborts is expected; the error is not asserted
		});
		socket.once("data", () => {
			onRequest?.();
			if (!silent) socket.end(RESPONSE);
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	serverPort = boundPort(server);
});

afterAll(async () => {
	for (const socket of served) socket.destroy();
	const closing = Promise.withResolvers<void>();
	server.close(() => closing.resolve());
	await closing.promise;
	rmSync(dir, { recursive: true, force: true });
});

test("delivers the body the local TLS server sends through the real sockets", async () => {
	const closes: Promise<void>[] = [];
	const result = await realSocketGuard(POLICY.timeoutMs, closes, new Set())(TARGET);
	expect(result).toEqual({ ok: true, text: BODY, headers: {} });
});

test("closes both real sockets and completes the guard result without hanging", async () => {
	const closes: Promise<void>[] = [];
	const result = await realSocketGuard(POLICY.timeoutMs, closes, new Set())(TARGET);
	expect(result.ok).toBe(true);
	expect(closes).toHaveLength(2);
	await Promise.all(closes);
});

test("ends a server that never responds with TIMEOUT when the short policy deadline fires", async () => {
	const closes: Promise<void>[] = [];
	const timers = new Set<ArmedTimer>();
	const sawRequest = Promise.withResolvers<void>();
	silent = true;
	onRequest = () => sawRequest.resolve();
	try {
		const result = realSocketGuard(SILENT_TIMEOUT_MS, closes, timers)(TARGET);
		// The request reaching the silent server is the signal to fire the armed deadline by hand.
		await sawRequest.promise;
		const deadline = [...timers][0];
		expect(timers.size).toBe(1);
		expect(deadline?.delayMs).toBe(SILENT_TIMEOUT_MS);
		deadline?.run();
		expect(await result).toEqual({ ok: false, code: "TIMEOUT" });
		await Promise.all(closes);
	} finally {
		silent = false;
		onRequest = undefined;
	}
});
