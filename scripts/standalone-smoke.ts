#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/standalone-smoke.ts — proves the stdio connector (bin/ultrathink-connector) runs outside Omp from a clean
 * environment: no keys, no network, no `claude` binary, no files in the user's home.
 *
 * The child gets an environment of exactly PATH, BUN, HOME, ULTRATHINK_STATE_DIR and ULTRATHINK_LOG_LEVEL, with HOME
 * and the state directory pointing into a fresh temp directory. The script sends the audit recipe's five JSON-RPC
 * lines, closes stdin and checks the replies, the exit code, the files left behind and the log. A second case leaves
 * ULTRATHINK_STATE_DIR out; a third keeps stdin open and ends the connector with SIGTERM.
 *
 * The check functions are exported so scripts/standalone-smoke.test.ts runs the very checks the CLI prints: the
 * permanent test and the command a stranger runs cannot drift apart. stdout carries only the PASS/FAIL report.
 * The CLI is `bun scripts/standalone-smoke.ts`. With `--service` it starts the hosted service (services/ultrathink/
 * server.ts) on loopback with throwaway secrets and runs the HTTP and MCP checklist, the SIGTERM drain and a sweep
 * that no generated secret reaches a response, a log line or the report.
 */
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import pkg from "../package.json";
import { detectHost } from "../src/host/detect.ts";
import { stateDirForHost } from "../src/host/paths.ts";

interface SmokeCheck {
	name: string;
	ok: boolean;
	detail: string;
}

interface StdioSmokeOptions {
	/** Leave ULTRATHINK_STATE_DIR out of the child's environment: the connector picks its own directory. */
	omitStateDir?: boolean;
	/** The child is killed after this long; the result then says timedOut. */
	timeoutMs?: number;
}

export interface StdioSmokeResult {
	/** Every non-empty line the connector wrote to stdout. */
	replies: string[];
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	omitStateDir: boolean;
	homeDir: string;
	stateDir: string;
	/** The names of the variables the child was started with, sorted. */
	childEnvKeys: string[];
	/** Removes every directory the run created. */
	cleanup: () => void;
}

interface StdioSignalResult {
	/** The first stdout line the connector wrote before it was signalled; empty when none arrived. */
	firstReply: string;
	stderr: string;
	/** The connector's exit code; -1 when it had not exited by the deadline and was killed. */
	exitCode: number;
	timedOut: boolean;
	/** How long the connector took to exit after SIGTERM. */
	exitMs: number;
	cleanup: () => void;
}

const REPO_ROOT = join(import.meta.dir, "..");
const CONNECTOR = join(REPO_ROOT, "bin", "ultrathink-connector");
const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "ultrathink";
const DEFAULT_TIMEOUT_MS = 45_000;
const EXPECTED_TOOLS = [
	"ultrathink_answer",
	"ultrathink_command",
	"ultrathink_graph",
	"ultrathink_pending",
	"ultrathink_plan",
	"ultrathink_result",
	"ultrathink_sessions",
	"ultrathink_show",
	"ultrathink_status",
];
/** Text that only a request carries: a connector that logs any of it logs what the client sent. */
const REQUEST_TEXT = ["notifications/initialized", '"jsonrpc"', "clientInfo"];
const USAGE = "usage: bun scripts/standalone-smoke.ts [--service]";

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "smoke", version: "0" },
	},
};
const REQUEST_LINES: string[] = [
	INITIALIZE,
	{ jsonrpc: "2.0", method: "notifications/initialized" },
	{ jsonrpc: "2.0", id: 2, method: "tools/list" },
	{
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "ultrathink_sessions", arguments: {} },
	},
	{
		jsonrpc: "2.0",
		id: 4,
		method: "tools/call",
		params: { name: "ultrathink_command", arguments: { command: "help" } },
	},
].map((message) => JSON.stringify(message));

function expectedEnvKeys(omitStateDir: boolean): string[] {
	const keys = ["PATH", "BUN", "HOME", "ULTRATHINK_STATE_DIR", "ULTRATHINK_LOG_LEVEL"];
	return keys.filter((key) => !(omitStateDir && key === "ULTRATHINK_STATE_DIR")).sort();
}

/**
 * The child's whole environment. Bun.spawn replaces the parent's environment with `env` (it does not merge: Bun 1.4.0
 * ran `env` inside a spawn given `{ A: "1" }` and printed A and the shell's own PWD, nothing inherited), so no
 * `/usr/bin/env -i` prefix is needed and the key set below is exactly what the child starts with.
 */
function buildCleanEnv(homeDir: string, stateDir: string | undefined): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		BUN: Bun.which("bun") ?? process.execPath,
		HOME: homeDir,
		ULTRATHINK_LOG_LEVEL: "info",
	};
	if (stateDir !== undefined) env.ULTRATHINK_STATE_DIR = stateDir;
	const keys = Object.keys(env).sort();
	const expected = expectedEnvKeys(stateDir === undefined);
	if (keys.join(",") !== expected.join(",")) {
		throw new Error(`clean env has keys ${keys.join(",")}, expected ${expected.join(",")}`);
	}
	return env;
}

/**
 * The connector's state directory when ULTRATHINK_STATE_DIR is not set and HOME is `homeDir`: the host's state
 * directory plus "connector", from the same functions the connector uses. Those read the process's own home
 * directory, so the result is re-rooted from that home to `homeDir`.
 */
export function stateDirForCleanEnv(homeDir: string): string {
	const env = buildCleanEnv(homeDir, undefined);
	const hostState = stateDirForHost(detectHost(env), env);
	const fromHome = relative(homedir(), hostState);
	if (fromHome === "" || fromHome.startsWith("..") || isAbsolute(fromHome)) {
		throw new Error(`state directory ${hostState} is not under the home directory ${homedir()}`);
	}
	return join(homeDir, fromHome, "connector");
}

/** Every file and directory under `dir`, as absolute paths, without following symlinks. */
export function listTree(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		found.push(path);
		if (entry.isDirectory()) found.push(...listTree(path));
	}
	return found;
}

interface Room {
	root: string;
	homeDir: string;
	stateDir: string;
	cleanup: () => void;
}

/** A fresh temp directory holding an empty HOME; the state directory is left for the connector to create. */
function makeRoom(omitStateDir: boolean): Room {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-smoke-"));
	const homeDir = join(root, "home");
	mkdirSync(homeDir);
	const stateDir = omitStateDir ? stateDirForCleanEnv(homeDir) : join(root, "state");
	return { root, homeDir, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The one place the connector is started: the real script, in `cwd`, with `env` as its entire environment. */
function spawnConnector(env: Record<string, string>, cwd: string) {
	return Bun.spawn([CONNECTOR], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
}

/** Runs the connector through the audit recipe: five request lines, stdin closed, replies and exit collected. */
export async function runStdioSmoke(opts: StdioSmokeOptions = {}): Promise<StdioSmokeResult> {
	const omitStateDir = opts.omitStateDir === true;
	const room = makeRoom(omitStateDir);
	const env = buildCleanEnv(room.homeDir, omitStateDir ? undefined : room.stateDir);
	const proc = spawnConnector(env, room.root);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	try {
		proc.stdin.write(`${REQUEST_LINES.join("\n")}\n`);
		await proc.stdin.end();
	} catch {
		// reason: the child already exited; its exit code and reply count report the failure.
		proc.kill("SIGKILL");
	}
	const exitCode = await proc.exited;
	clearTimeout(timer);
	const stdoutText = await stdout;
	return {
		replies: stdoutText.split("\n").filter((line) => line !== ""),
		stdout: stdoutText,
		stderr: await stderr,
		exitCode,
		timedOut,
		omitStateDir,
		homeDir: room.homeDir,
		stateDir: room.stateDir,
		childEnvKeys: Object.keys(env).sort(),
		cleanup: room.cleanup,
	};
}

/** Reads `stream` until its first newline; undefined when none arrives in time. */
async function firstLine(
	stream: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string | undefined> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const { promise: deadline, resolve } = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => resolve(undefined), timeoutMs);
	let text = "";
	try {
		for (;;) {
			const chunk = await Promise.race([reader.read(), deadline]);
			if (chunk === undefined || chunk.done) return undefined;
			text += decoder.decode(chunk.value, { stream: true });
			const newline = text.indexOf("\n");
			if (newline !== -1) return text.slice(0, newline);
		}
	} finally {
		clearTimeout(timer);
	}
}

/** Starts the connector with stdin open, takes one reply, sends SIGTERM and waits for the exit. */
export async function runStdioSignalSmoke(
	opts: { timeoutMs?: number } = {},
): Promise<StdioSignalResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const room = makeRoom(false);
	const proc = spawnConnector(buildCleanEnv(room.homeDir, room.stateDir), room.root);
	const stderr = new Response(proc.stderr).text();
	proc.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
	await proc.stdin.flush();
	const firstReply = (await firstLine(proc.stdout, timeoutMs)) ?? "";
	const signalledAt = Date.now();
	proc.kill("SIGTERM");
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	const exitCode = await proc.exited;
	clearTimeout(timer);
	const exitMs = Date.now() - signalledAt;
	return {
		firstReply,
		stderr: await stderr,
		exitCode: timedOut ? -1 : exitCode,
		timedOut,
		exitMs,
		cleanup: room.cleanup,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseLine(line: string | undefined): Record<string, unknown> | undefined {
	if (line === undefined) return undefined;
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/** The `event` of every stderr line that is a JSON log record. */
function logEvents(stderr: string): string[] {
	const events: string[] = [];
	for (const line of stderr.split("\n")) {
		const event = parseLine(line)?.event;
		if (typeof event === "string") events.push(event);
	}
	return events;
}

/** Tool names from a tools/list reply, sorted: the server answers in its own order, EXPECTED_TOOLS is alphabetical. */
function toolNames(reply: Record<string, unknown> | undefined): string[] {
	const tools = asRecord(reply?.result)?.tools;
	if (!Array.isArray(tools)) return [];
	return tools
		.flatMap((tool) => {
			const name = asRecord(tool)?.name;
			return typeof name === "string" ? [name] : [];
		})
		.sort();
}

/** A tool reply for request `id` that is a result (no protocol error) with isError false. */
function succeeded(reply: Record<string, unknown> | undefined, id: number): boolean {
	const isError = asRecord(reply?.result)?.isError;
	return reply?.id === id && reply.error === undefined && isError === false;
}

function check(name: string, ok: boolean, detail: string): SmokeCheck {
	return { name, ok, detail };
}

function stateDirCheck(stateDir: string): SmokeCheck {
	try {
		const info = statSync(stateDir);
		const mode = info.mode & 0o777;
		return check(
			"state dir is mode 0700",
			info.isDirectory() && mode === 0o700,
			`${stateDir} mode ${mode.toString(8)}`,
		);
	} catch {
		return check("state dir is mode 0700", false, `${stateDir} does not exist`);
	}
}

/**
 * Every path under `homeDir` that is neither inside `<homeDir>/.bun` (Bun's own cache) nor the state directory, one of
 * its ancestors or inside it. Observed on Bun 1.4.0: a connector run with a fresh empty HOME makes Bun write its
 * runtime transpiler cache to `$HOME/.bun/install/cache/@t@/*.pile` (about 100 files), so HOME is not left empty by
 * Bun itself; the audit recipe's "empty HOME" prediction came from reading code, not from running it.
 */
export function strayHomeEntries(homeDir: string, stateDir: string): string[] {
	const bunDir = join(homeDir, ".bun");
	return listTree(homeDir).filter((entry) => {
		const inBunCache = entry === bunDir || entry.startsWith(`${bunDir}${sep}`);
		const inState = entry === stateDir || entry.startsWith(`${stateDir}${sep}`);
		const onTheWay = stateDir.startsWith(`${entry}${sep}`);
		return !(inBunCache || inState || onTheWay);
	});
}

function homeCheck(result: StdioSmokeResult): SmokeCheck {
	const name = "no files outside the state dir and Bun's own cache";
	const stray = strayHomeEntries(result.homeDir, result.stateDir);
	// With no override the state directory is under HOME and the connector must have created it there.
	const stateMissing = result.omitStateDir && !listTree(result.homeDir).includes(result.stateDir);
	return check(
		name,
		stray.length === 0 && !stateMissing,
		stray.length > 0
			? `unexpected: ${stray.join(", ")}`
			: stateMissing
				? `${result.stateDir} was not created`
				: "only the state dir and Bun's cache",
	);
}

/** Every check of one stdio run; the CLI prints them and the test asserts that they all pass. */
export function evaluateStdioSmoke(
	result: StdioSmokeResult,
	expectedVersion: string,
): SmokeCheck[] {
	const replies = result.replies.map((line) => parseLine(line));
	const init = asRecord(replies[0]?.result);
	const serverInfo = asRecord(init?.serverInfo);
	const names = toolNames(replies[1]);
	const events = logEvents(result.stderr);
	const requestText = REQUEST_TEXT.filter((text) => result.stderr.includes(text));
	const expectedKeys = expectedEnvKeys(result.omitStateDir);
	return [
		check(
			"child env is exactly the clean set",
			result.childEnvKeys.join(",") === expectedKeys.join(","),
			result.childEnvKeys.join(","),
		),
		check(
			"exit code 0",
			result.exitCode === 0 && !result.timedOut,
			`exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
		),
		check("exactly 4 reply lines", result.replies.length === 4, `${result.replies.length} lines`),
		check(
			"initialize reply",
			replies[0]?.id === 1 &&
				replies[0]?.error === undefined &&
				init?.protocolVersion === PROTOCOL_VERSION &&
				serverInfo?.name === SERVER_NAME &&
				serverInfo?.version === expectedVersion,
			`protocol ${String(init?.protocolVersion)}, server ${String(serverInfo?.name)} ${String(serverInfo?.version)}`,
		),
		check(
			"tools/list is the 9 client-driven tools",
			replies[1]?.id === 2 &&
				names.join(",") === EXPECTED_TOOLS.join(",") &&
				!names.includes("ultrathink_uplift"),
			names.join(","),
		),
		check("ultrathink_sessions isError false", succeeded(replies[2], 3), "tools/call id 3"),
		check("ultrathink_command help isError false", succeeded(replies[3], 4), "tools/call id 4"),
		homeCheck(result),
		stateDirCheck(result.stateDir),
		check("stderr logs started", events.includes("started"), `${events.length} log events`),
		check(
			"stderr carries no request text",
			requestText.length === 0,
			requestText.length === 0 ? "none found" : `found: ${requestText.join(", ")}`,
		),
	];
}

/** Every check of the signal run. */
export function evaluateSignalSmoke(result: StdioSignalResult): SmokeCheck[] {
	const reply = parseLine(result.firstReply);
	return [
		check(
			"connector answered before the signal",
			reply?.id === 1 && asRecord(reply.result)?.protocolVersion === PROTOCOL_VERSION,
			result.firstReply === "" ? "no reply" : "initialize reply",
		),
		check(
			"SIGTERM exits 0",
			result.exitCode === 0 && !result.timedOut,
			`exit ${result.exitCode} after ${result.exitMs} ms`,
		),
		check(
			"stderr logs the signal",
			logEvents(result.stderr).includes("signal"),
			`${logEvents(result.stderr).length} log events`,
		),
	];
}

/** One PASS or FAIL line per check, under a heading. */
export function formatSmokeReport(title: string, checks: SmokeCheck[]): string {
	const lines = checks.map(
		(item) => `${item.ok ? "PASS" : "FAIL"} ${item.name}${item.ok ? "" : `: ${item.detail}`}`,
	);
	return [`# ${title}`, ...lines, ""].join("\n");
}

/** Variables the service reads from its environment file; the other names the child gets are not secret. */
const SERVICE_SECRET_NAMES = [
	"ULTRATHINK_OWNER_PASSWORD_HASH",
	"ULTRATHINK_SESSION_SECRET",
	"ULTRATHINK_CONNECTOR_KEY",
] as const;
const SERVICE_ENTRY = join(REPO_ROOT, "services", "ultrathink", "server.ts");
const BUN_BIN = Bun.which("bun") ?? process.execPath;
const OWNER_PASSWORD = "smoke-owner-password";
const WRONG_KEY = "wrong-value";
/** The numbers behind the throwaway secrets: hex characters of the session secret and of the connector key. */
const SESSION_SECRET_LENGTH = 48;
const CONNECTOR_KEY_LENGTH = 40;
/** The range services/ultrathink/config/config.ts accepts for ULTRATHINK_PORT. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const HEALTH_WAIT_MS = 30_000;
const DRAIN_OBSERVE_MS = 4000;
const DRAIN_EXIT_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const CHECK_CONFIG_TIMEOUT_MS = 30_000;
const CHECK_CONFIG_PROBE_MS = 15_000;
/** The two strings phase 93 (CONF-02) documents for `--check-config`. */
const CONFIG_OK = "config ok";
/** The documented keys of GET /readyz `checks`, sorted. */
const READY_CHECKS = ["draining", "integrity", "oauth", "planner", "stateDir", "store"];

export interface ServiceSmokeOptions {
	/** How long the service may take to answer /healthz after it starts. */
	healthTimeoutMs?: number;
	/** How long the service may take to exit after SIGTERM. */
	exitTimeoutMs?: number;
}

export interface ServiceSmokeResult {
	checks: SmokeCheck[];
	/** Only the lengths: the secret values never leave this module. */
	secrets: { keyLength: number; secretLength: number };
	/** The service's exit code after SIGTERM; -1 when it never started or had to be killed. */
	exitCode: number;
	port: number;
	/** The PASS/FAIL lines the CLI prints. */
	report: string;
}

export interface CheckConfigResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** stdout and stderr together: the flag's block may use either stream. */
	output: string;
	timedOut: boolean;
	/** The service went on to listen, so it does not know the flag. It was killed. */
	listened: boolean;
}

interface ServiceSecrets {
	ownerHash: string;
	sessionSecret: string;
	connectorKey: string;
}

interface ServiceRoom {
	root: string;
	homeDir: string;
	stateDir: string;
	envFile: string;
	secrets: ServiceSecrets;
	cleanup: () => void;
}

/**
 * True when no text contains any secret. A secret shorter than 8 characters is refused: an empty or tiny needle would
 * match everything or nothing useful, which is a bug in the caller, not a pass.
 */
export function secretsAbsent(texts: readonly string[], secrets: readonly string[]): boolean {
	for (const secret of secrets) {
		if (secret.length < 8) throw new Error("a secret to sweep for must be at least 8 characters");
	}
	return !texts.some((text) => secrets.some((secret) => text.includes(secret)));
}

/** An unused loopback port, from the kernel: bind port 0, read it, release it. */
function pickPort(): number {
	const listener = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data: () => undefined },
	});
	const port = listener.port;
	listener.stop(true);
	return port;
}

function parseEnvFile(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) values[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return values;
}

/** A temp directory with HOME, a 0700 state directory and a 0600 env file of fresh throwaway secrets. */
async function makeServiceRoom(): Promise<ServiceRoom> {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-smoke-service-"));
	const cleanup = (): void => rmSync(root, { recursive: true, force: true });
	try {
		const homeDir = join(root, "home");
		const stateDir = join(root, "state");
		mkdirSync(homeDir);
		mkdirSync(stateDir, { mode: 0o700 });
		const secrets: ServiceSecrets = {
			ownerHash: await Bun.password.hash(OWNER_PASSWORD, { algorithm: "argon2id" }),
			sessionSecret: randomBytes(SESSION_SECRET_LENGTH / 2).toString("hex"),
			connectorKey: randomBytes(CONNECTOR_KEY_LENGTH / 2).toString("hex"),
		};
		const envFile = join(root, "ultrathink.env");
		const lines = [
			`ULTRATHINK_OWNER_PASSWORD_HASH=${secrets.ownerHash}`,
			`ULTRATHINK_SESSION_SECRET=${secrets.sessionSecret}`,
			`ULTRATHINK_CONNECTOR_KEY=${secrets.connectorKey}`,
		];
		writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(envFile, 0o600);
		return { root, homeDir, stateDir, envFile, secrets, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

/**
 * The service's whole environment: the secrets come from the env file (the file is what a deployment would carry),
 * everything else is fixed here. Bun.spawn replaces the parent's environment, so nothing else reaches the child.
 */
function serviceEnv(room: ServiceRoom, port: number): Record<string, string> {
	const fromFile = parseEnvFile(readFileSync(room.envFile, "utf8"));
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: room.homeDir,
		ULTRATHINK_STATE_DIR: room.stateDir,
		ULTRATHINK_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
		ULTRATHINK_PORT: String(port),
		ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
	};
	for (const name of SERVICE_SECRET_NAMES) {
		const value = fromFile[name];
		if (value === undefined) throw new Error(`the env file lacks ${name}`);
		env[name] = value;
	}
	return env;
}

/** The one place the hosted service is started: the real entry file, in the repo root, with `env` as its environment. */
function spawnService(args: string[], env: Record<string, string>) {
	return Bun.spawn([BUN_BIN, SERVICE_ENTRY, ...args], {
		cwd: REPO_ROOT,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

/** Reads `stream` to its end; `onText` sees the whole text so far after each chunk. */
async function readAll(
	stream: ReadableStream<Uint8Array>,
	onText?: (text: string) => void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
		onText?.(text);
	}
	return text + decoder.decode();
}

interface HttpReply {
	status: number;
	headers: Headers;
	text: string;
}

async function httpRequest(url: string, init: RequestInit = {}): Promise<HttpReply> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
	return { status: response.status, headers: response.headers, text: await response.text() };
}

/** A check whose body may throw (a refused connection, a timeout): that is a failed check, not a crashed smoke. */
async function attempt(
	name: string,
	run: () => Promise<{ ok: boolean; detail: string }>,
): Promise<SmokeCheck> {
	try {
		const outcome = await run();
		return check(name, outcome.ok, outcome.detail);
	} catch (error) {
		return check(name, false, `threw: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function preflightChecks(room: ServiceRoom, port: number): SmokeCheck[] {
	const checks: SmokeCheck[] = [];
	const mode = statSync(room.envFile).mode & 0o777;
	checks.push(
		check("env file is mode 0600", mode === 0o600, `mode ${mode.toString(8)}`),
		check(
			"owner hash comes from Bun.password.hash (argon2id)",
			room.secrets.ownerHash.startsWith("$argon2id$"),
			`${room.secrets.ownerHash.length} characters`,
		),
		check(
			`session secret is ${SESSION_SECRET_LENGTH} hex characters`,
			/^[0-9a-f]+$/.test(room.secrets.sessionSecret) &&
				room.secrets.sessionSecret.length === SESSION_SECRET_LENGTH,
			`${room.secrets.sessionSecret.length} characters`,
		),
		check(
			`connector key is ${CONNECTOR_KEY_LENGTH} hex characters`,
			/^[0-9a-f]+$/.test(room.secrets.connectorKey) &&
				room.secrets.connectorKey.length === CONNECTOR_KEY_LENGTH,
			`${room.secrets.connectorKey.length} characters`,
		),
		check(
			`port is within ${MIN_PORT}-${MAX_PORT}`,
			Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT,
			`port ${port}`,
		),
	);
	return checks;
}

/**
 * Starts the real hosted service on loopback with throwaway secrets, runs the HTTP and MCP checklist, ends it with
 * SIGTERM and checks the drain and the exit code. Every HTTP response, every log line and the report itself are swept
 * for the generated secrets.
 */
export async function runServiceSmoke(opts: ServiceSmokeOptions = {}): Promise<ServiceSmokeResult> {
	const healthTimeoutMs = opts.healthTimeoutMs ?? HEALTH_WAIT_MS;
	const exitTimeoutMs = opts.exitTimeoutMs ?? DRAIN_EXIT_MS;
	const room = await makeServiceRoom();
	const port = pickPort();
	const checks = preflightChecks(room, port);
	const secretValues = [
		room.secrets.ownerHash,
		room.secrets.sessionSecret,
		room.secrets.connectorKey,
		OWNER_PASSWORD,
	];
	const lengths = {
		keyLength: room.secrets.connectorKey.length,
		secretLength: room.secrets.sessionSecret.length,
	};
	const finish = (exitCode: number, report: string): ServiceSmokeResult => ({
		checks,
		secrets: lengths,
		exitCode,
		port,
		report,
	});
	// A throwaway-secret or port fault stops here, before any process starts.
	if (checks.some((item) => !item.ok)) {
		room.cleanup();
		return finish(-1, formatSmokeReport("hosted service", checks));
	}

	let env: Record<string, string>;
	try {
		env = serviceEnv(room, port);
	} catch (error) {
		room.cleanup();
		throw error;
	}
	const proc = spawnService([], env);
	// Set by the exit handler; an object so the loop below sees the update.
	const state: { exited?: number } = {};
	void proc.exited.then((code) => {
		state.exited = code;
	});
	const stdout = readAll(proc.stdout);
	const stderr = readAll(proc.stderr);
	const base = `http://127.0.0.1:${port}`;
	/** Every response body and header, kept for the secret sweep. */
	const seen: string[] = [];
	const request = async (path: string, init: RequestInit = {}): Promise<HttpReply> => {
		const reply = await httpRequest(`${base}${path}`, init);
		seen.push(
			reply.text,
			...Array.from(reply.headers.entries(), ([name, value]) => `${name}: ${value}`),
		);
		return reply;
	};
	const mcp = (key: string | undefined, message: object): Promise<HttpReply> =>
		request("/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"mcp-protocol-version": PROTOCOL_VERSION,
				...(key === undefined ? {} : { "x-connector-key": key }),
			},
			body: JSON.stringify(message),
		});

	let serviceExit = -1;
	try {
		const deadline = Date.now() + healthTimeoutMs;
		let healthy = false;
		while (!healthy && state.exited === undefined && Date.now() < deadline) {
			try {
				healthy = (await request("/healthz")).status === 200;
			} catch {
				// reason: the service is still starting; the loop retries until the deadline.
				healthy = false;
			}
			if (!healthy) await Bun.sleep(100);
		}
		const startupDetail =
			state.exited === undefined ? "no answer in time" : `exited ${state.exited} while starting`;
		checks.push(check("service answers /healthz 200", healthy, healthy ? "up" : startupDetail));

		if (healthy) {
			const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };
			checks.push(
				await attempt("POST /mcp without a key is 401", async () => {
					const reply = await mcp(undefined, list);
					return { ok: reply.status === 401, detail: `status ${reply.status}` };
				}),
				await attempt("POST /mcp with a wrong key is 401", async () => {
					const reply = await mcp(WRONG_KEY, list);
					return { ok: reply.status === 401, detail: `status ${reply.status}` };
				}),
				await attempt("GET /mcp is 405 with Allow: POST", async () => {
					const reply = await request("/mcp");
					const allow = reply.headers.get("allow") ?? "";
					const methods = allow.split(",").map((method) => method.trim());
					return {
						ok: reply.status === 405 && methods.includes("POST"),
						detail: `status ${reply.status}, Allow "${allow}"`,
					};
				}),
				await attempt("GET /readyz is 200 with the documented checks", async () => {
					const reply = await request("/readyz");
					const body = parseLine(reply.text);
					const readyChecks = asRecord(body?.checks);
					const keys = Object.keys(readyChecks ?? {}).sort();
					const allPass = Object.values(readyChecks ?? {}).every((value) => value === true);
					return {
						ok:
							reply.status === 200 &&
							body?.status === "ready" &&
							keys.join(",") === READY_CHECKS.join(",") &&
							allPass,
						detail: `status ${reply.status}, checks ${keys.join(",")}`,
					};
				}),
				await attempt("MCP initialize with the connector key", async () => {
					const reply = await mcp(room.secrets.connectorKey, INITIALIZE);
					const result = asRecord(parseLine(reply.text)?.result);
					const info = asRecord(result?.serverInfo);
					return {
						ok:
							reply.status === 200 &&
							info?.name === SERVER_NAME &&
							result?.protocolVersion === PROTOCOL_VERSION,
						detail: `status ${reply.status}, server ${String(info?.name)}`,
					};
				}),
				await attempt("MCP tools/list shows the 9 client-driven tools, no uplift", async () => {
					const reply = await mcp(room.secrets.connectorKey, list);
					const names = toolNames(parseLine(reply.text));
					return {
						ok:
							reply.status === 200 &&
							names.join(",") === EXPECTED_TOOLS.join(",") &&
							!names.includes("ultrathink_uplift"),
						detail: `status ${reply.status}, ${names.length} tools`,
					};
				}),
				await attempt("MCP tools/call ultrathink_sessions succeeds", async () => {
					const reply = await mcp(room.secrets.connectorKey, {
						jsonrpc: "2.0",
						id: 3,
						method: "tools/call",
						params: { name: "ultrathink_sessions", arguments: {} },
					});
					return {
						ok: reply.status === 200 && succeeded(parseLine(reply.text), 3),
						detail: `status ${reply.status}`,
					};
				}),
			);

			proc.kill("SIGTERM");
			checks.push(
				await attempt("SIGTERM: /readyz fails while /healthz stays 200", async () => {
					const until = Date.now() + DRAIN_OBSERVE_MS;
					let readyStatus = 200;
					while (readyStatus === 200 && Date.now() < until) {
						readyStatus = (await request("/readyz")).status;
						if (readyStatus === 200) await Bun.sleep(50);
					}
					const healthStatus = readyStatus === 200 ? 0 : (await request("/healthz")).status;
					return {
						ok: readyStatus !== 200 && healthStatus === 200,
						detail: `readyz ${readyStatus}, healthz ${healthStatus}`,
					};
				}),
			);
			let killedByTimer = false;
			const timer = setTimeout(() => {
				killedByTimer = true;
				proc.kill("SIGKILL");
			}, exitTimeoutMs);
			serviceExit = await proc.exited;
			clearTimeout(timer);
			checks.push(
				check(
					"SIGTERM drains and the service exits 0",
					serviceExit === 0 && !killedByTimer,
					killedByTimer ? `still running after ${exitTimeoutMs} ms` : `exit ${serviceExit}`,
				),
			);
		}
	} finally {
		if (state.exited === undefined) {
			proc.kill("SIGKILL");
			await proc.exited;
		}
		room.cleanup();
	}

	const logText = [await stdout, await stderr];
	const preSweep = formatSmokeReport("hosted service", checks);
	checks.push(
		check(
			"SECRET-SWEEP http responses",
			secretsAbsent(seen, secretValues),
			`${seen.length} bodies and headers`,
		),
		check(
			"SECRET-SWEEP service logs",
			secretsAbsent(logText, secretValues),
			`${logText.join("").split("\n").length} lines`,
		),
		check("SECRET-SWEEP report", secretsAbsent([preSweep], secretValues), "report lines"),
	);
	return finish(serviceExit, formatSmokeReport("hosted service", checks));
}

/**
 * Runs `server.ts --check-config` on a valid environment with `overrides` applied (undefined removes a variable).
 * A service that does not know the flag starts listening instead: that is noticed in its log and it is killed.
 */
export async function runCheckConfig(
	overrides: Record<string, string | undefined> = {},
	timeoutMs: number = CHECK_CONFIG_TIMEOUT_MS,
): Promise<CheckConfigResult> {
	const room = await makeServiceRoom();
	try {
		const env = serviceEnv(room, pickPort());
		for (const [name, value] of Object.entries(overrides)) {
			if (value === undefined) delete env[name];
			else env[name] = value;
		}
		const proc = spawnService(["--check-config"], env);
		let timedOut = false;
		let listened = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, timeoutMs);
		const stdout = readAll(proc.stdout, (text) => {
			if (text.includes('"listening"')) {
				listened = true;
				proc.kill("SIGKILL");
			}
		});
		const stderr = readAll(proc.stderr);
		const exitCode = await proc.exited;
		clearTimeout(timer);
		const out = await stdout;
		const err = await stderr;
		return { exitCode, stdout: out, stderr: err, output: `${out}${err}`, timedOut, listened };
	} finally {
		room.cleanup();
	}
}

/**
 * Whether the hosted service knows `--check-config` (phase 93): true only when it exits 0 and says "config ok" on a
 * valid environment. Never throws; a timeout, a spawn error or a service that starts listening instead is false.
 */
export async function supportsCheckConfig(): Promise<boolean> {
	try {
		const result = await runCheckConfig({}, CHECK_CONFIG_PROBE_MS);
		return (
			!result.timedOut &&
			!result.listened &&
			result.exitCode === 0 &&
			result.output.includes(CONFIG_OK)
		);
	} catch {
		// reason: a probe that cannot run means the flag cannot be relied on.
		return false;
	}
}

async function runCli(argv: string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--service") {
		const result = await runServiceSmoke();
		process.stdout.write(result.report);
		return result.checks.every((item) => item.ok) && result.exitCode === 0 ? 0 : 1;
	}
	if (argv.length > 0) {
		process.stderr.write(`${USAGE}\n`);
		return 2;
	}
	let failed = false;
	const report = (title: string, checks: SmokeCheck[]): void => {
		process.stdout.write(formatSmokeReport(title, checks));
		if (checks.some((item) => !item.ok)) failed = true;
	};
	for (const omitStateDir of [false, true]) {
		const result = await runStdioSmoke({ omitStateDir });
		try {
			report(
				omitStateDir ? "stdio, no ULTRATHINK_STATE_DIR" : "stdio, clean room",
				evaluateStdioSmoke(result, pkg.version),
			);
		} finally {
			result.cleanup();
		}
	}
	const signal = await runStdioSignalSmoke();
	try {
		report("stdio, SIGTERM", evaluateSignalSmoke(signal));
	} finally {
		signal.cleanup();
	}
	return failed ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await runCli(process.argv.slice(2)));
}
