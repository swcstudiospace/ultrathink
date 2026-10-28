// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Realm seam: a read-only probe that says whether Realm is absent, down, advisory, enforcing or degraded.
 *
 * The probe never starts anything. It reads the `stateDir` field of Realm's config file, checks that the
 * control socket is trustworthy (owner, mode, no symlink) BEFORE connecting, then sends one `status` request
 * and validates the reply field by field the way Realm's own client does. It never calls `up`, `mcp`, `acp`
 * or `retry`, caches nothing across calls, and is bounded by a hard 1.5 s total budget. The `realm status`
 * CLI fallback runs only when no socket path can be derived.
 *
 * Only `stateDir` is read from the config and only `workspaceRoot` from session files; every other field
 * (including `image` and `andaUrl`) is ignored and never copied into a report or a reason.
 */

import { spawn } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { HostId } from "../host/types.ts";
import type { StackConnection, StackProbe, StackProbeContext } from "./types.ts";

/** What the probe found. `unknown` always names why; nothing here carries a secret. */
export type RealmProbe =
	| { kind: "absent" }
	| { kind: "unknown"; why: "timeout" | "schema" | "io" | "disabled" | "untrusted-socket" }
	| { kind: "daemon-down"; stateDir: string }
	| {
			kind: "present";
			stateDir: string;
			state: "unbound" | "connecting" | "active" | "degraded" | "error" | "stopping";
			label: "realm active" | "realm disconnected";
			degraded: boolean;
			reason: string;
			mode: "advisory" | "fail-closed";
			lastTransitionAt: string;
			workspaceMatches: boolean | "unknown";
			via: "socket" | "cli";
			probedAt: string;
	  };

/** What a host should be told about Realm; computed by the pure {@link realmHint}. */
export interface RealmHint {
	enforcement: "none" | "advisory" | "enforcing";
	routeThroughRealm: boolean;
	instruction: string | null;
}

/** One lstat observation; the identity fields the trust rule needs, nothing else. */
interface PathStat {
	isDirectory: boolean;
	isSocket: boolean;
	uid: number;
	mode: number;
}

type ConfigFileRead = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; text: string };

type DialResult =
	| { kind: "line"; line: string }
	| { kind: "timeout" }
	| { kind: "refused" }
	| { kind: "oversize" }
	| { kind: "io" };

type CliResult = { kind: "output"; stdout: string } | { kind: "timeout" } | { kind: "io" };

/** Every side effect of the probe, injectable so tests never need root, a daemon or a real PATH. */
export interface RealmDeps {
	/** Missing file is `missing`; over-cap, non-regular or unreadable is `invalid`. */
	readConfigFile: (path: string) => ConfigFileRead;
	/** lstat-based (never follows a symlink); `undefined` when the path does not exist. Throws on other errors. */
	statPath: (path: string) => PathStat | undefined;
	getuid: () => number | undefined;
	lookupOnPath: (name: string, env: Record<string, string | undefined>) => string | undefined;
	/** Sends exactly one line and returns exactly one reply line. */
	dial: (
		socketPath: string,
		line: string,
		timeoutMs: number,
		maxBytes: number,
	) => Promise<DialResult>;
	/** Runs the `realm` binary with `status` only; never any other argument. */
	runCli: (
		file: string,
		args: readonly string[],
		env: Record<string, string>,
		timeoutMs: number,
		/** The child's working directory: a fixed neutral directory, never the caller's. */
		cwd: string,
	) => Promise<CliResult>;
	readdir: (path: string) => string[];
	/** The file text, or `undefined` when it is unreadable, not a regular file or over the cap. */
	readSessionFile: (path: string, maxBytes: number) => string | undefined;
}

export interface ProbeRealmRawOpts {
	/** The plan's working directory, compared with each session's `workspaceRoot`. */
	cwd?: string;
	/** Clamped to 1500; the whole probe never exceeds that. */
	timeoutMs?: number;
	now?: () => number;
	deps?: Partial<RealmDeps>;
}

const MAX_BUDGET_MS = 1500;
const MAX_CONFIG_BYTES = 65536;
const MAX_SESSION_BYTES = 65536;
const MAX_SESSION_FILES = 16;
const MAX_REPLY_BYTES = 1_048_576;
const STATUS_REQUEST = `${JSON.stringify({ id: 1, method: "status" })}\n`;
const OPT_OUT_VARIABLE = "ULTRATHINK_REALM";

const STATES = ["unbound", "connecting", "active", "degraded", "error", "stopping"] as const;
const LABELS = ["realm active", "realm disconnected"] as const;
const MODES = ["advisory", "fail-closed"] as const;

type RealmState = (typeof STATES)[number];
type RealmLabel = (typeof LABELS)[number];
type RealmMode = (typeof MODES)[number];
type PresentProbe = Extract<RealmProbe, { kind: "present" }>;

interface ParsedStatus {
	state: RealmState;
	label: RealmLabel;
	degraded: boolean;
	reason: string;
	mode: RealmMode;
	lastTransitionAt: string;
}

interface Detection {
	probe: RealmProbe;
	/** Set only when the config file exists but is unparsable, over 64 KiB or lacks a string stateDir. */
	configIssue?: string;
	/** The budget the probe actually ran under: the caller's timeout clamped to MAX_BUDGET_MS. */
	budgetMs: number;
}

/** What the detection steps return; {@link detect} adds the budget. */
type Detected = Omit<Detection, "budgetMs">;

/**
 * The wire shapes below name only the fields the probe reads. Every field is `unknown` until a typeof, enum or
 * `Array.isArray` check narrows it; any other field a peer sends is never named, so it is ignored.
 */
interface ErrnoWire {
	code?: unknown;
}

interface ConfigWire {
	stateDir?: unknown;
}

interface SessionWire {
	workspaceRoot?: unknown;
}

interface ReplyWire {
	id?: unknown;
	result?: unknown;
}

interface StatusWire {
	mode?: unknown;
	snapshot?: unknown;
	display?: unknown;
}

interface SnapshotWire {
	state?: unknown;
	reason?: unknown;
	lastTransitionAt?: unknown;
}

interface DisplayWire {
	label?: unknown;
	degraded?: unknown;
	reason?: unknown;
	lastTransitionAt?: unknown;
}

/** The value as `T` when it is a plain object (not null, not an array), else `undefined`. */
function asWire<T extends object>(value: unknown): T | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as T)
		: undefined;
}

function errorCode(error: unknown): string | undefined {
	const code = asWire<ErrnoWire>(error)?.code;
	return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean {
	const code = errorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Reads at most `max` bytes; `undefined` when the file is longer. Opens only what the caller stat-checked. */
function readCapped(path: string, max: number): string | undefined {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.allocUnsafe(max + 1);
		let len = 0;
		while (len < buf.length) {
			const n = readSync(fd, buf, len, buf.length - len, null);
			if (n === 0) break;
			len += n;
		}
		return len > max ? undefined : buf.toString("utf8", 0, len);
	} finally {
		closeSync(fd);
	}
}

function readConfigFileDefault(path: string): ConfigFileRead {
	try {
		const stats = statSync(path);
		if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return { kind: "invalid" };
		const text = readCapped(path, MAX_CONFIG_BYTES);
		return text === undefined ? { kind: "invalid" } : { kind: "ok", text };
	} catch (error) {
		return isMissing(error) ? { kind: "missing" } : { kind: "invalid" };
	}
}

function statPathDefault(path: string): PathStat | undefined {
	try {
		const stats = lstatSync(path);
		return {
			isDirectory: stats.isDirectory(),
			isSocket: stats.isSocket(),
			uid: stats.uid,
			mode: stats.mode,
		};
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

function getuidDefault(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function lookupOnPathDefault(
	name: string,
	env: Record<string, string | undefined>,
): string | undefined {
	const pathValue = env.PATH;
	if (pathValue === undefined) return undefined;
	for (const dir of pathValue.split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, name);
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here or not executable: keep looking.
		}
	}
	return undefined;
}

function dialDefault(
	socketPath: string,
	line: string,
	timeoutMs: number,
	maxBytes: number,
): Promise<DialResult> {
	const { promise, resolve: resolvePromise } = Promise.withResolvers<DialResult>();
	let settled = false;
	let received = Buffer.alloc(0);
	const socket = createConnection({ path: socketPath });
	const finish = (result: DialResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.destroy();
		resolvePromise(result);
	};
	const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
	socket.on("connect", () => {
		socket.write(line);
	});
	socket.on("data", (chunk: Buffer) => {
		received = Buffer.concat([received, chunk]);
		const newline = received.indexOf(0x0a);
		if (newline === -1) {
			if (received.length > maxBytes) finish({ kind: "oversize" });
			return;
		}
		if (newline > maxBytes) {
			finish({ kind: "oversize" });
			return;
		}
		finish({ kind: "line", line: received.toString("utf8", 0, newline) });
	});
	socket.on("error", (error) => {
		const code = errorCode(error);
		finish(code === "ENOENT" || code === "ECONNREFUSED" ? { kind: "refused" } : { kind: "io" });
	});
	socket.on("close", () => finish({ kind: "io" }));
	return promise;
}

function runCliDefault(
	file: string,
	args: readonly string[],
	env: Record<string, string>,
	timeoutMs: number,
	cwd: string,
): Promise<CliResult> {
	const { promise, resolve: resolvePromise } = Promise.withResolvers<CliResult>();
	let settled = false;
	const chunks: Buffer[] = [];
	let total = 0;
	const child = spawn(file, [...args], {
		cwd,
		stdio: ["ignore", "pipe", "ignore"],
		env,
		shell: false,
	});
	const finish = (result: CliResult): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		child.kill("SIGKILL");
		resolvePromise(result);
	};
	const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
	child.stdout.on("data", (chunk: Buffer) => {
		total += chunk.length;
		if (total > MAX_REPLY_BYTES) {
			finish({ kind: "io" });
			return;
		}
		chunks.push(chunk);
	});
	child.on("error", () => finish({ kind: "io" }));
	child.on("close", (code) => {
		finish(
			code === 0
				? { kind: "output", stdout: Buffer.concat(chunks).toString("utf8") }
				: { kind: "io" },
		);
	});
	return promise;
}

function readSessionFileDefault(path: string, maxBytes: number): string | undefined {
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.size > maxBytes) return undefined;
		return readCapped(path, maxBytes);
	} catch {
		return undefined;
	}
}

const DEFAULT_DEPS: RealmDeps = {
	readConfigFile: readConfigFileDefault,
	statPath: statPathDefault,
	getuid: getuidDefault,
	lookupOnPath: lookupOnPathDefault,
	dial: dialDefault,
	runCli: runCliDefault,
	readdir: (path) => readdirSync(path),
	readSessionFile: readSessionFileDefault,
};

/** Realm's resolveConfigPath: an absolute XDG_CONFIG_HOME wins, else an absolute HOME, else no path. */
export function resolveConfigPath(env: Record<string, string | undefined>): string | undefined {
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg !== undefined && isAbsolute(xdg)) return join(xdg, "realm", "config.json");
	const home = env.HOME;
	if (home !== undefined && isAbsolute(home)) return join(home, ".config", "realm", "config.json");
	return undefined;
}

/** `ULTRATHINK_REALM` trims and lowercases to `off`: the user's opt-out. */
export function isOptedOut(env: Record<string, string | undefined>): boolean {
	return (env[OPT_OUT_VARIABLE] ?? "").trim().toLowerCase() === "off";
}

/** Takes ONLY `stateDir`; every other field is dropped on the floor. */
function stateDirOf(text: string): string | undefined {
	if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const stateDir = asWire<ConfigWire>(parsed)?.stateDir;
	return typeof stateDir === "string" && stateDir.length > 0 ? stateDir : undefined;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** Field-by-field validation mirroring Realm's isDaemonStatus: mode, snapshot and display. */
function parseStatus(value: unknown): ParsedStatus | undefined {
	const wire = asWire<StatusWire>(value);
	if (wire === undefined) return undefined;
	const mode = wire.mode;
	const snapshot = asWire<SnapshotWire>(wire.snapshot);
	const display = asWire<DisplayWire>(wire.display);
	if (!isOneOf(MODES, mode) || snapshot === undefined || display === undefined) return undefined;
	const state = snapshot.state;
	const label = display.label;
	if (!isOneOf(STATES, state) || !isOneOf(LABELS, label)) return undefined;
	const snapshotReason = snapshot.reason;
	const lastTransitionAt = snapshot.lastTransitionAt;
	const degraded = display.degraded;
	const displayReason = display.reason;
	const displayTransitionAt = display.lastTransitionAt;
	if (typeof snapshotReason !== "string" || typeof lastTransitionAt !== "string") return undefined;
	if (
		typeof degraded !== "boolean" ||
		typeof displayReason !== "string" ||
		typeof displayTransitionAt !== "string"
	) {
		return undefined;
	}
	return { state, label, degraded, reason: displayReason, mode, lastTransitionAt };
}

function parseReplyLine(line: string): ParsedStatus | undefined {
	let reply: unknown;
	try {
		reply = JSON.parse(line);
	} catch {
		return undefined;
	}
	const wire = asWire<ReplyWire>(reply);
	if (wire === undefined || wire.id !== 1 || "error" in wire) return undefined;
	return parseStatus(wire.result);
}

/** `true` on a match, `false` when some file was readable and none matched, `unknown` when none was readable. */
function scanSessions(
	stateDir: string,
	cwd: string | undefined,
	deps: RealmDeps,
): boolean | "unknown" {
	if (cwd === undefined || cwd.length === 0) return "unknown";
	const dir = join(stateDir, "sessions");
	let names: string[];
	try {
		names = deps
			.readdir(dir)
			.filter((name) => name.endsWith(".json"))
			.sort()
			.slice(0, MAX_SESSION_FILES);
	} catch {
		return "unknown";
	}
	const want = resolve(cwd);
	let readable = 0;
	for (const name of names) {
		let text: string | undefined;
		try {
			text = deps.readSessionFile(join(dir, name), MAX_SESSION_BYTES);
		} catch {
			text = undefined;
		}
		if (text === undefined) continue;
		readable += 1;
		try {
			const parsed: unknown = JSON.parse(text);
			const root = asWire<SessionWire>(parsed)?.workspaceRoot;
			if (typeof root === "string" && root.length > 0 && resolve(root) === want) return true;
		} catch {
			// An unparsable session file counts as read but never matches.
		}
	}
	return readable === 0 ? "unknown" : false;
}

function presentFrom(
	status: ParsedStatus,
	stateDir: string,
	workspaceMatches: boolean | "unknown",
	via: "socket" | "cli",
	probedAt: string,
): PresentProbe {
	return {
		kind: "present",
		stateDir,
		state: status.state,
		label: status.label,
		degraded: status.degraded,
		reason: status.reason,
		mode: status.mode,
		lastTransitionAt: status.lastTransitionAt,
		workspaceMatches,
		via,
		probedAt,
	};
}

/** The trust rule: absolute path, lstat'd 0700 run dir and 0600 socket, both owned by the current uid. */
function checkTrust(
	stateDir: string,
	deps: RealmDeps,
): { kind: "trusted"; socketPath: string } | { kind: "down" } | { kind: "untrusted" } {
	if (!isAbsolute(stateDir)) return { kind: "untrusted" };
	const uid = deps.getuid();
	if (uid === undefined) return { kind: "untrusted" };
	const runDir = join(stateDir, "run");
	const socketPath = join(runDir, "control.sock");
	const run = deps.statPath(runDir);
	if (run === undefined) return { kind: "down" };
	if (!run.isDirectory || run.uid !== uid || (run.mode & 0o7777) !== 0o700) {
		return { kind: "untrusted" };
	}
	const sock = deps.statPath(socketPath);
	if (sock === undefined) return { kind: "down" };
	if (!sock.isSocket || sock.uid !== uid || (sock.mode & 0o7777) !== 0o600) {
		return { kind: "untrusted" };
	}
	return { kind: "trusted", socketPath };
}

function cliEnv(env: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME"]) {
		const value = env[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

async function viaCli(
	env: Record<string, string | undefined>,
	deps: RealmDeps,
	remainingMs: number,
	probedAt: string,
): Promise<RealmProbe> {
	const binary = deps.lookupOnPath("realm", env);
	if (binary === undefined) return { kind: "absent" };
	const result = await deps.runCli(binary, ["status"], cliEnv(env), remainingMs, tmpdir());
	if (result.kind === "timeout") return { kind: "unknown", why: "timeout" };
	if (result.kind === "io") return { kind: "unknown", why: "io" };
	const out = result.stdout.trim();
	// The CLI does not report its state directory, so a CLI-derived report carries an empty stateDir.
	if (out === "disconnected") return { kind: "daemon-down", stateDir: "" };
	const status = parseStatus(parseJson(out));
	return status === undefined
		? { kind: "unknown", why: "schema" }
		: presentFrom(status, "", "unknown", "cli", probedAt);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function viaSocket(
	stateDir: string,
	opts: ProbeRealmRawOpts,
	deps: RealmDeps,
	remainingMs: number,
	probedAt: string,
): Promise<RealmProbe> {
	const trust = checkTrust(stateDir, deps);
	if (trust.kind === "untrusted") return { kind: "unknown", why: "untrusted-socket" };
	if (trust.kind === "down") return { kind: "daemon-down", stateDir };
	const reply = await deps.dial(trust.socketPath, STATUS_REQUEST, remainingMs, MAX_REPLY_BYTES);
	switch (reply.kind) {
		case "refused":
			return { kind: "daemon-down", stateDir };
		case "timeout":
			return { kind: "unknown", why: "timeout" };
		case "io":
			return { kind: "unknown", why: "io" };
		case "oversize":
			return { kind: "unknown", why: "schema" };
		case "line": {
			// Skipping this field validation would report a wrong-enum reply as present; tests pin that.
			const status = parseReplyLine(reply.line);
			if (status === undefined) return { kind: "unknown", why: "schema" };
			const workspaceMatches = scanSessions(stateDir, opts.cwd, deps);
			return presentFrom(status, stateDir, workspaceMatches, "socket", probedAt);
		}
	}
}

function budgetOf(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return MAX_BUDGET_MS;
	return Math.max(1, Math.min(timeoutMs, MAX_BUDGET_MS));
}

async function detectInner(
	env: Record<string, string | undefined>,
	opts: ProbeRealmRawOpts,
	deps: RealmDeps,
	budget: number,
): Promise<Detected> {
	if (isOptedOut(env)) return { probe: { kind: "unknown", why: "disabled" } };
	const startedAt = Date.now();
	const remaining = (): number => Math.max(1, budget - (Date.now() - startedAt));
	const nowMs = (opts.now ?? Date.now)();
	const probedAt = new Date(nowMs).toISOString();
	const configPath = resolveConfigPath(env);
	let stateDir: string | undefined;
	if (configPath !== undefined) {
		const read = deps.readConfigFile(configPath);
		if (read.kind === "invalid") {
			return { probe: { kind: "unknown", why: "io" }, configIssue: configPath };
		}
		if (read.kind === "ok") {
			stateDir = stateDirOf(read.text);
			if (stateDir === undefined) {
				return { probe: { kind: "unknown", why: "io" }, configIssue: configPath };
			}
		}
	}
	if (stateDir === undefined) return { probe: await viaCli(env, deps, remaining(), probedAt) };
	return { probe: await viaSocket(stateDir, opts, deps, remaining(), probedAt) };
}

async function detect(
	env: Record<string, string | undefined>,
	opts: ProbeRealmRawOpts,
): Promise<Detection> {
	const budget = budgetOf(opts.timeoutMs);
	const deps: RealmDeps = { ...DEFAULT_DEPS, ...opts.deps };
	const deadline = Promise.withResolvers<Detected>();
	const timer = setTimeout(
		() => deadline.resolve({ probe: { kind: "unknown", why: "timeout" } }),
		budget,
	);
	const work = detectInner(env, opts, deps, budget).catch(
		(): Detected => ({ probe: { kind: "unknown", why: "io" } }),
	);
	try {
		// The budget never exceeds MAX_BUDGET_MS, so a caller asking for more is cut here first: the stack
		// aggregator's own guard (`ctx.timeoutMs`) fires later and its generic message is never shown for this leg.
		return { ...(await Promise.race([work, deadline.promise])), budgetMs: budget };
	} finally {
		clearTimeout(timer);
	}
}

/** The raw, typed probe. Never throws, never spawns except the `realm status` fallback, sends only `status`. */
export async function probeRealmRaw(
	env: Record<string, string | undefined>,
	opts: ProbeRealmRawOpts = {},
): Promise<RealmProbe> {
	try {
		return (await detect(env, opts)).probe;
	} catch {
		return { kind: "unknown", why: "io" };
	}
}

/** Host class: how Realm reaches the host. Omp through its extension, five hosts through an MCP entry. */
export function realmHostClass(host: HostId): "extension" | "mcp" | "none" {
	switch (host) {
		case "omp":
			return "extension";
		case "claude-code":
		case "grok-build":
		case "hermes":
		case "muse":
		case "prime-agent":
			return "mcp";
		case "cursor":
			return "none";
	}
}

const RETRY_TAIL =
	"if write or edit is refused with a REALM_* code, run /realm-retry or stop and report; do not work around it with bash.";
const ENFORCING_MCP = `Realm is enforcing: route tool calls through Realm if the realm server's tools are available; ${RETRY_TAIL}`;
const ENFORCING_EXTENSION = `Realm is enforcing: ${RETRY_TAIL}`;
const ADVISORY = `Realm is active in advisory mode and does not contain writes: ${RETRY_TAIL}`;

function enforcementOf(probe: RealmProbe): RealmHint["enforcement"] {
	if (probe.kind !== "present") return "none";
	if (probe.state !== "active" && probe.state !== "degraded") return "none";
	return probe.mode === "fail-closed" ? "enforcing" : "advisory";
}

/** Pure: what to tell a host about Realm. Routing applies only to mcp-class hosts with an enforcing realm. */
export function realmHint(probe: RealmProbe, host: HostId): RealmHint {
	const enforcement = enforcementOf(probe);
	const hostClass = realmHostClass(host);
	if (enforcement === "none" || hostClass === "none") {
		return { enforcement, routeThroughRealm: false, instruction: null };
	}
	if (enforcement === "advisory") {
		return { enforcement, routeThroughRealm: false, instruction: ADVISORY };
	}
	return hostClass === "mcp"
		? { enforcement, routeThroughRealm: true, instruction: ENFORCING_MCP }
		: { enforcement, routeThroughRealm: false, instruction: ENFORCING_EXTENSION };
}

/** One line, control characters collapsed, bounded: daemon text never breaks the one-line reason rule. */
function oneLine(text: string): string {
	const flat = text
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

function fromPresent(
	probe: PresentProbe,
): Pick<StackConnection, "status" | "reason" | "affects" | "fix"> {
	if (probe.state === "active") {
		return probe.mode === "fail-closed"
			? { status: "connected", reason: "Realm enforcing" }
			: {
					status: "degraded",
					reason: "Realm active, advisory mode: writes are not contained",
					affects: ["containment"],
				};
	}
	if (probe.state === "degraded") {
		const tail =
			probe.mode === "fail-closed"
				? "fail-closed blocks host writes"
				: "advisory mode, writes are not contained";
		return { status: "degraded", reason: `Realm degraded (${oneLine(probe.reason)}): ${tail}` };
	}
	return { status: "unavailable", reason: `Realm ${probe.state}: ${oneLine(probe.reason)}` };
}

function fromUnknown(
	why: Extract<RealmProbe, { kind: "unknown" }>["why"],
	budgetMs: number,
): Pick<StackConnection, "status" | "reason" | "fix"> {
	switch (why) {
		case "timeout":
			// The budget this probe actually used (the caller's value clamped to MAX_BUDGET_MS), never the caller's own.
			return {
				status: "unavailable",
				reason: `Realm did not answer within ${budgetMs} ms`,
			};
		case "schema":
			return { status: "unavailable", reason: "Realm returned an unexpected reply" };
		case "io":
			return { status: "unavailable", reason: "Realm state could not be read" };
		case "untrusted-socket":
			return {
				status: "unavailable",
				reason: "Realm control socket failed the trust check (owner, mode or path)",
			};
		case "disabled":
			return {
				status: "disabled",
				reason: `Realm probe switched off by ${OPT_OUT_VARIABLE}=off`,
				fix: `unset ${OPT_OUT_VARIABLE}`,
			};
	}
}

function mapDetection(detection: Detection, latencyMs: number): StackConnection {
	const { probe, configIssue } = detection;
	const base = { member: "realm" as const, latencyMs };
	if (configIssue !== undefined) {
		return {
			...base,
			status: "misconfigured",
			reason: `Realm config ${configIssue} is unparsable, over 64 KiB or lacks stateDir`,
			via: "config",
		};
	}
	switch (probe.kind) {
		case "absent":
			return {
				...base,
				status: "disabled",
				reason: "Realm not installed or not configured",
				via: "none",
			};
		case "unknown": {
			const mapped = fromUnknown(probe.why, detection.budgetMs);
			return { ...base, ...mapped, via: probe.why === "disabled" ? "none" : "socket" };
		}
		case "daemon-down":
			return {
				...base,
				status: "unavailable",
				reason:
					probe.stateDir === ""
						? "Realm daemon is not running"
						: `Realm daemon is not running (state dir ${probe.stateDir})`,
				fix: "realm up",
				via: probe.stateDir === "" ? "cli" : "socket",
			};
		case "present":
			return { ...base, ...fromPresent(probe), via: probe.via };
	}
}

/** The Realm link for `ultrathink stack`: read-only, never throws, bounded by 1.5 s. */
export const probeRealm: StackProbe = async (ctx: StackProbeContext): Promise<StackConnection> => {
	const now = ctx.now ?? Date.now;
	try {
		const startedAt = now();
		const detection = await detect(ctx.env, {
			cwd: ctx.cwd,
			timeoutMs: ctx.timeoutMs,
			now: ctx.now,
		});
		const elapsed = now() - startedAt;
		return mapDetection(detection, Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0);
	} catch {
		return {
			member: "realm",
			status: "unavailable",
			reason: "Realm probe failed unexpectedly",
			latencyMs: 0,
			via: "none",
		};
	}
};
