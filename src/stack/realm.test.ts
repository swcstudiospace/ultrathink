// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import { HOSTS, type HostId } from "../host/types.ts";
import {
	type ProbeRealmRawOpts,
	probeRealm,
	probeRealmRaw,
	type RealmDeps,
	type RealmHint,
	type RealmProbe,
	realmHint,
	realmHostClass,
} from "./realm.ts";
import type { StackConnection, StackProbeContext } from "./types.ts";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const PROBED_AT = new Date(T0).toISOString();
const TRANSITION_AT = "2026-10-28T11:59:00.000Z";
const CWD = "/work/space";
const UID = process.getuid?.() ?? 0;
const STATUS_LINE = `${JSON.stringify({ id: 1, method: "status" })}\n`;
const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
const CANARY_URL = "https://canary.invalid/CANARYANDA5678";

type PresentProbe = Extract<RealmProbe, { kind: "present" }>;
type RealmState = PresentProbe["state"];
type RealmMode = PresentProbe["mode"];

const cleanups: Array<() => void | Promise<void>> = [];
/** Every call the never-spawn seams received; no socket-path test may ever add to it. */
const spawnAttempts: string[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	// The never-spawns rule: the realm CLI fallback is reachable only when no socket path can be derived.
	expect(spawnAttempts.splice(0)).toEqual([]);
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-realm-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Seams that record and throw: a probe that reached for PATH or a process fails the afterEach check. */
const spyDeps: Partial<RealmDeps> = {
	lookupOnPath: (name) => {
		spawnAttempts.push(`lookupOnPath:${name}`);
		throw new Error("PATH lookup must not happen on the socket path");
	},
	runCli: (file, args) => {
		spawnAttempts.push(`runCli:${file} ${args.join(" ")}`);
		throw new Error("spawn must not happen on the socket path");
	},
};

function boom(seam: string): never {
	throw new Error(`seam touched: ${seam}`);
}

/** Every seam throws: proves a code path performed no filesystem, socket, PATH or process access. */
const THROWING: RealmDeps = {
	readConfigFile: () => boom("readConfigFile"),
	statPath: () => boom("statPath"),
	getuid: () => boom("getuid"),
	lookupOnPath: () => boom("lookupOnPath"),
	dial: () => boom("dial"),
	runCli: () => boom("runCli"),
	readdir: () => boom("readdir"),
	readSessionFile: () => boom("readSessionFile"),
};

function raw(
	env: Record<string, string | undefined>,
	over: ProbeRealmRawOpts = {},
): Promise<RealmProbe> {
	return probeRealmRaw(env, {
		cwd: CWD,
		now: () => T0,
		...over,
		deps: { ...spyDeps, ...over.deps },
	});
}

function ctx(
	env: Record<string, string | undefined>,
	over: Partial<StackProbeContext> = {},
): StackProbeContext {
	return {
		env,
		config: defaultConfig(),
		cwd: CWD,
		stateDir: "/unused",
		host: "omp",
		live: false,
		timeoutMs: 1500,
		now: () => T0,
		...over,
	};
}

/** A Realm status reply built the way Realm's displayStatus maps a snapshot. */
function statusReply(state: RealmState, mode: RealmMode, reason = "ok"): string {
	const disconnected =
		state === "unbound" || state === "connecting" || state === "stopping" || state === "error";
	const fixed: Record<string, string> = {
		unbound: "no workspace",
		connecting: "connecting",
		stopping: "stopping",
	};
	const displayReason = fixed[state] ?? reason;
	return JSON.stringify({
		id: 1,
		result: {
			snapshot: { state, reason, lastTransitionAt: TRANSITION_AT },
			display: {
				label: disconnected ? "realm disconnected" : "realm active",
				degraded: state === "degraded",
				reason: displayReason,
				lastTransitionAt: TRANSITION_AT,
			},
			mode,
		},
	});
}

interface FakeOpts {
	/** The one NDJSON line to answer with (a newline is appended). */
	reply?: string;
	/** Wait this long after the request line before answering. */
	delayMs?: number;
	sockMode?: number;
	runMode?: number;
	/** Skip listening: the run directory exists but nothing serves the socket path. */
	noListen?: boolean;
}

interface FakeRealm {
	stateDir: string;
	socketPath: string;
	/** The bytes received on each connection, in connection order. */
	received: () => string[];
	connections: () => number;
	/** Resolves once every accepted connection has closed. */
	settled: () => Promise<void>;
}

async function startFake(opts: FakeOpts = {}): Promise<FakeRealm> {
	const stateDir = tempDir();
	const runDir = join(stateDir, "run");
	const socketPath = join(runDir, "control.sock");
	mkdirSync(runDir, { mode: 0o700 });
	chmodSync(runDir, opts.runMode ?? 0o700);
	const received: string[] = [];
	const sockets: Socket[] = [];
	let connections = 0;
	const closes: Array<Promise<void>> = [];
	const serverErrors: string[] = [];
	if (!opts.noListen) {
		const server: Server = createServer((socket) => {
			const index = connections;
			connections += 1;
			received.push("");
			sockets.push(socket);
			const closedSignal = Promise.withResolvers<void>();
			closes.push(closedSignal.promise);
			let replied = false;
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => {
				const soFar = (received[index] ?? "") + chunk;
				received[index] = soFar;
				if (replied || !soFar.includes("\n")) return;
				replied = true;
				// A real timer on purpose: the slow-reply tests exercise the probe's own wall-clock budget.
				setTimeout(() => {
					if (!socket.destroyed) socket.end(`${opts.reply ?? ""}\n`);
				}, opts.delayMs ?? 0);
			});
			socket.on("error", (error) => serverErrors.push(error.message));
			socket.on("close", () => closedSignal.resolve());
		});
		const listening = Promise.withResolvers<void>();
		server.listen(socketPath, () => listening.resolve());
		await listening.promise;
		chmodSync(socketPath, opts.sockMode ?? 0o600);
		cleanups.push(async () => {
			for (const socket of sockets) socket.destroy();
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			await done.promise;
		});
	}
	return {
		stateDir,
		socketPath,
		received: () => [...received],
		connections: () => connections,
		settled: async () => {
			await Promise.all(closes);
		},
	};
}

/** Writes Realm's config under a temp HOME and returns an env that resolves it (no XDG_CONFIG_HOME). */
function homeEnv(config?: unknown, extra: Record<string, string> = {}): Record<string, string> {
	const home = tempDir();
	if (config !== undefined) {
		mkdirSync(join(home, ".config", "realm"), { recursive: true });
		writeFileSync(
			join(home, ".config", "realm", "config.json"),
			typeof config === "string" ? config : JSON.stringify(config),
		);
	}
	return { HOME: home, ...extra };
}

function configPathOf(env: Record<string, string>): string {
	return join(env.HOME ?? "", ".config", "realm", "config.json");
}

async function expectOneStatusRequest(fake: FakeRealm): Promise<void> {
	await fake.settled();
	expect(fake.received()).toEqual([STATUS_LINE]);
	expect(fake.connections()).toBe(1);
}

async function expectNothingSent(fake: FakeRealm): Promise<void> {
	// The probe returned before this runs and a dial would have been accepted by now, so no wait is needed.
	expect(fake.connections()).toBe(0);
	expect(fake.received()).toEqual([]);
}

function writeSessions(stateDir: string, files: Record<string, unknown>): void {
	const dir = join(stateDir, "sessions");
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
	}
}

function oneLine(connection: StackConnection): void {
	expect(connection.reason).not.toMatch(/[\r\n]/);
	expect(connection.reason.length).toBeGreaterThan(0);
}

describe("realm probe report matrix (fake NDJSON control socket)", () => {
	// Each assertion fails on an implementation that skips field validation or the status-only exchange: a
	// validator that checks only `state` would report the mode-permissive case in the adversarial block as present.
	test("absent: no config path, nothing on PATH, no socket", async () => {
		const probe = await raw({}, { deps: { lookupOnPath: () => undefined } });
		expect(probe).toEqual({ kind: "absent" });
		const conn = await probeRealm(ctx({ PATH: "" }));
		expect(conn).toMatchObject({
			member: "realm",
			status: "disabled",
			reason: "Realm not installed or not configured",
			via: "none",
		});
		expect(conn.fix).toBeUndefined();
		expect(conn.affects).toBeUndefined();
	});

	test("absent: an absolute HOME with no config file and nothing on PATH", async () => {
		const env = homeEnv();
		expect(await raw(env, { deps: { lookupOnPath: () => undefined } })).toEqual({ kind: "absent" });
	});

	test("daemon-down: a config names a state dir with no run directory and no socket", async () => {
		const stateDir = tempDir();
		const env = homeEnv({ stateDir });
		expect(await raw(env)).toEqual({ kind: "daemon-down", stateDir });
		const conn = await probeRealm(ctx(env));
		expect(conn).toMatchObject({
			status: "unavailable",
			reason: `Realm daemon is not running (state dir ${stateDir})`,
			fix: "realm up",
			via: "socket",
		});
	});

	test("daemon-down: a run directory but no socket", async () => {
		const fake = await startFake({ noListen: true });
		expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toEqual({
			kind: "daemon-down",
			stateDir: fake.stateDir,
		});
	});

	test("active-advisory: present with advisory mode maps to degraded affecting containment", async () => {
		const fake = await startFake({ reply: statusReply("active", "advisory", "bound") });
		const env = homeEnv({ stateDir: fake.stateDir });
		expect(await raw(env)).toEqual({
			kind: "present",
			stateDir: fake.stateDir,
			state: "active",
			label: "realm active",
			degraded: false,
			reason: "bound",
			mode: "advisory",
			lastTransitionAt: TRANSITION_AT,
			workspaceMatches: "unknown",
			via: "socket",
			probedAt: PROBED_AT,
		});
		await expectOneStatusRequest(fake);
		const second = await startFake({ reply: statusReply("active", "advisory", "bound") });
		const conn = await probeRealm(ctx(homeEnv({ stateDir: second.stateDir })));
		expect(conn).toEqual({
			member: "realm",
			status: "degraded",
			reason: "Realm active, advisory mode: writes are not contained",
			affects: ["containment"],
			latencyMs: 0,
			via: "socket",
		});
		await expectOneStatusRequest(second);
	});

	test("active-enforcing: fail-closed maps to connected", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed", "bound") });
		const env = homeEnv({ stateDir: fake.stateDir });
		const probe = await raw(env);
		expect(probe).toMatchObject({
			kind: "present",
			state: "active",
			mode: "fail-closed",
			via: "socket",
		});
		await expectOneStatusRequest(fake);
		const second = await startFake({ reply: statusReply("active", "fail-closed", "bound") });
		const conn = await probeRealm(ctx(homeEnv({ stateDir: second.stateDir })));
		expect(conn).toEqual({
			member: "realm",
			status: "connected",
			reason: "Realm enforcing",
			latencyMs: 0,
			via: "socket",
		});
		await expectOneStatusRequest(second);
	});

	test("degraded: the active label with the degraded flag maps to degraded and names fail-closed blocking", async () => {
		const fake = await startFake({ reply: statusReply("degraded", "fail-closed", "podman gone") });
		const probe = await raw(homeEnv({ stateDir: fake.stateDir }));
		expect(probe).toMatchObject({
			kind: "present",
			state: "degraded",
			label: "realm active",
			degraded: true,
			reason: "podman gone",
		});
		await expectOneStatusRequest(fake);
		const second = await startFake({
			reply: statusReply("degraded", "fail-closed", "podman gone"),
		});
		const conn = await probeRealm(ctx(homeEnv({ stateDir: second.stateDir })));
		expect(conn).toMatchObject({
			status: "degraded",
			reason: "Realm degraded (podman gone): fail-closed blocks host writes",
			via: "socket",
		});
		await expectOneStatusRequest(second);
	});

	test("degraded in advisory mode never claims fail-closed blocking", async () => {
		const fake = await startFake({ reply: statusReply("degraded", "advisory", "podman gone") });
		const conn = await probeRealm(ctx(homeEnv({ stateDir: fake.stateDir })));
		expect(conn.status).toBe("degraded");
		expect(conn.reason).toBe(
			"Realm degraded (podman gone): advisory mode, writes are not contained",
		);
		await expectOneStatusRequest(fake);
	});

	const remaining: Array<[RealmState, string]> = [
		["unbound", "no workspace"],
		["connecting", "connecting"],
		["error", "OPENSHELL_START_FAILED"],
		["stopping", "stopping"],
	];
	for (const [state, displayReason] of remaining) {
		test(`${state}: present, maps to unavailable naming the state`, async () => {
			const fake = await startFake({
				reply: statusReply(state, "fail-closed", "OPENSHELL_START_FAILED"),
			});
			const env = homeEnv({ stateDir: fake.stateDir });
			const probe = await raw(env);
			expect(probe).toMatchObject({
				kind: "present",
				state,
				label: "realm disconnected",
				degraded: false,
				reason: displayReason,
			});
			await expectOneStatusRequest(fake);
			const second = await startFake({
				reply: statusReply(state, "fail-closed", "OPENSHELL_START_FAILED"),
			});
			const conn = await probeRealm(ctx(homeEnv({ stateDir: second.stateDir })));
			expect(conn).toMatchObject({
				status: "unavailable",
				reason: `Realm ${state}: ${displayReason}`,
				via: "socket",
			});
			await expectOneStatusRequest(second);
		});
	}

	test("a stale socket nobody serves reads as daemon-down", async () => {
		const fake = await startFake({ noListen: true });
		// Nothing listens at the path: the stat seam vouches for a trusted socket inode, and the dial is refused.
		const probe = await raw(homeEnv({ stateDir: fake.stateDir }), {
			deps: {
				statPath: (path) =>
					path.endsWith("control.sock")
						? { isDirectory: false, isSocket: true, uid: UID, mode: 0o140600 }
						: { isDirectory: true, isSocket: false, uid: UID, mode: 0o40700 },
			},
		});
		expect(probe).toEqual({ kind: "daemon-down", stateDir: fake.stateDir });
	});
});

describe("realm probe refusals, timeouts, identity and secrecy", () => {
	// GATE-02 bar: each refusal test fails on an implementation that skips its check; for example trusting a
	// wide-mode socket returns `present` instead of unknown/untrusted-socket, and the server would see a request.
	test("a non-JSON reply is unknown/schema", async () => {
		const fake = await startFake({ reply: "this is not json" });
		expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toEqual({
			kind: "unknown",
			why: "schema",
		});
		await expectOneStatusRequest(fake);
	});

	const good = JSON.parse(statusReply("active", "fail-closed", "ok")) as {
		id: number;
		result: {
			snapshot: Record<string, unknown>;
			display: Record<string, unknown>;
			mode: unknown;
		};
	};
	const variants: Array<[string, unknown]> = [
		["mode outside the two modes", { ...good, result: { ...good.result, mode: "permissive" } }],
		[
			"state outside the six",
			{
				...good,
				result: { ...good.result, snapshot: { ...good.result.snapshot, state: "paused" } },
			},
		],
		[
			"label outside the two",
			{
				...good,
				result: { ...good.result, display: { ...good.result.display, label: "realm asleep" } },
			},
		],
		[
			"degraded not a boolean",
			{ ...good, result: { ...good.result, display: { ...good.result.display, degraded: "no" } } },
		],
		[
			"lastTransitionAt not a string",
			{
				...good,
				result: { ...good.result, snapshot: { ...good.result.snapshot, lastTransitionAt: 5 } },
			},
		],
		["a reply id that is not 1", { ...good, id: 2 }],
		["an error member", { ...good, error: { code: "SCHEMA_INVALID" } }],
		["a missing result", { id: 1 }],
	];
	for (const [name, body] of variants) {
		test(`wrong shape (${name}) is unknown/schema, never present`, async () => {
			const fake = await startFake({ reply: JSON.stringify(body) });
			expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toEqual({
				kind: "unknown",
				why: "schema",
			});
			await expectOneStatusRequest(fake);
		});
	}

	test("a reply line over 1 MiB is unknown/schema", async () => {
		const fake = await startFake({ reply: "a".repeat(1_048_577) });
		expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toEqual({
			kind: "unknown",
			why: "schema",
		});
	});

	test("a slow reply past the budget is unknown/timeout", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed"), delayMs: 400 });
		const env = homeEnv({ stateDir: fake.stateDir });
		expect(await raw(env, { timeoutMs: 50 })).toEqual({ kind: "unknown", why: "timeout" });
		const conn = await probeRealm(ctx(env, { timeoutMs: 50 }));
		expect(conn).toMatchObject({
			status: "unavailable",
			reason: "Realm did not answer within 50 ms",
		});
	});

	test("the budget is capped at 1.5 s whatever the caller asks, and the reason names the budget used", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed"), delayMs: 1700 });
		const env = homeEnv({ stateDir: fake.stateDir });
		const started = Date.now();
		const [probe, conn] = await Promise.all([
			raw(env, { timeoutMs: 60_000 }),
			probeRealm(ctx(env, { timeoutMs: 60_000 })),
		]);
		expect(probe).toEqual({ kind: "unknown", why: "timeout" });
		expect(conn).toMatchObject({
			status: "unavailable",
			reason: "Realm did not answer within 1500 ms",
		});
		expect(Date.now() - started).toBeLessThan(2500);
	});

	test("a socket with permission bits wider than 0600 is refused with nothing sent", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed"), sockMode: 0o666 });
		const env = homeEnv({ stateDir: fake.stateDir });
		expect(await raw(env)).toEqual({ kind: "unknown", why: "untrusted-socket" });
		const conn = await probeRealm(ctx(env));
		expect(conn).toMatchObject({
			status: "unavailable",
			reason: "Realm control socket failed the trust check (owner, mode or path)",
		});
		await expectNothingSent(fake);
	});

	test("a socket with narrower bits than 0600 is refused too (exactly 0600)", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed"), sockMode: 0o400 });
		expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toEqual({
			kind: "unknown",
			why: "untrusted-socket",
		});
		await expectNothingSent(fake);
	});

	test("a run directory wider than 0700 is refused with nothing sent", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed"), runMode: 0o755 });
		expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toEqual({
			kind: "unknown",
			why: "untrusted-socket",
		});
		await expectNothingSent(fake);
	});

	test("a socket owned by a different uid than getuid is refused with nothing sent", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed") });
		// The wrong-owner case without root or chown: the stat seam reports uid 4242, getuid reports 1000.
		const probe = await raw(homeEnv({ stateDir: fake.stateDir }), {
			deps: {
				getuid: () => 1000,
				statPath: (path) =>
					path.endsWith("control.sock")
						? { isDirectory: false, isSocket: true, uid: 4242, mode: 0o140600 }
						: { isDirectory: true, isSocket: false, uid: 1000, mode: 0o40700 },
			},
		});
		expect(probe).toEqual({ kind: "unknown", why: "untrusted-socket" });
		await expectNothingSent(fake);
	});

	test("a run directory owned by a different uid is refused with nothing sent", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed") });
		const probe = await raw(homeEnv({ stateDir: fake.stateDir }), {
			deps: {
				getuid: () => 1000,
				statPath: (path) =>
					path.endsWith("control.sock")
						? { isDirectory: false, isSocket: true, uid: 1000, mode: 0o140600 }
						: { isDirectory: true, isSocket: false, uid: 4242, mode: 0o40700 },
			},
		});
		expect(probe).toEqual({ kind: "unknown", why: "untrusted-socket" });
		await expectNothingSent(fake);
	});

	test("an unavailable getuid is untrusted, not trusted by default", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed") });
		const probe = await raw(homeEnv({ stateDir: fake.stateDir }), {
			deps: { getuid: () => undefined },
		});
		expect(probe).toEqual({ kind: "unknown", why: "untrusted-socket" });
		await expectNothingSent(fake);
	});

	test("a symlink standing in for the socket is refused (lstat, never stat)", async () => {
		const fake = await startFake({ reply: statusReply("active", "fail-closed") });
		const linkState = tempDir();
		mkdirSync(join(linkState, "run"), { mode: 0o700 });
		chmodSync(join(linkState, "run"), 0o700);
		symlinkSync(fake.socketPath, join(linkState, "run", "control.sock"));
		expect(await raw(homeEnv({ stateDir: linkState }))).toEqual({
			kind: "unknown",
			why: "untrusted-socket",
		});
		await expectNothingSent(fake);
	});

	test("a regular file standing in for the socket is refused", async () => {
		const stateDir = tempDir();
		mkdirSync(join(stateDir, "run"), { mode: 0o700 });
		chmodSync(join(stateDir, "run"), 0o700);
		writeFileSync(join(stateDir, "run", "control.sock"), "");
		chmodSync(join(stateDir, "run", "control.sock"), 0o600);
		expect(await raw(homeEnv({ stateDir }))).toEqual({ kind: "unknown", why: "untrusted-socket" });
	});

	test("a relative stateDir in the config is untrusted without touching the filesystem", async () => {
		const probe = await raw(homeEnv({ stateDir: "relative/state" }), {
			deps: { statPath: () => boom("statPath"), getuid: () => boom("getuid") },
		});
		expect(probe).toEqual({ kind: "unknown", why: "untrusted-socket" });
	});

	test("a config over 65536 bytes is misconfigured naming the path; the raw probe says io", async () => {
		const env = homeEnv(`{"stateDir":"/x","pad":"${"a".repeat(70_000)}"}`);
		expect(await raw(env)).toEqual({ kind: "unknown", why: "io" });
		const conn = await probeRealm(ctx(env));
		expect(conn).toMatchObject({
			status: "misconfigured",
			reason: `Realm config ${configPathOf(env)} is unparsable, over 64 KiB or lacks stateDir`,
			via: "config",
		});
		oneLine(conn);
	});

	test("a config that is not JSON, or lacks a string stateDir, is misconfigured", async () => {
		for (const body of ["{not json", "[]", '{"stateDir":5}', '{"image":"x"}', '{"stateDir":""}']) {
			const env = homeEnv(body);
			expect(await raw(env)).toEqual({ kind: "unknown", why: "io" });
			expect(await probeRealm(ctx(env))).toMatchObject({ status: "misconfigured", via: "config" });
		}
	});

	test("an absolute XDG_CONFIG_HOME wins over HOME; a relative one is ignored", async () => {
		const stateDir = tempDir();
		const xdg = tempDir();
		mkdirSync(join(xdg, "realm"), { recursive: true });
		writeFileSync(join(xdg, "realm", "config.json"), JSON.stringify({ stateDir }));
		const home = homeEnv({ stateDir: "/nowhere/else" });
		expect(await raw({ ...home, XDG_CONFIG_HOME: xdg })).toEqual({ kind: "daemon-down", stateDir });
		expect(await raw({ ...home, XDG_CONFIG_HOME: "relative/xdg" })).toEqual({
			kind: "daemon-down",
			stateDir: "/nowhere/else",
		});
	});

	test("ULTRATHINK_REALM=off short-circuits before any filesystem, socket or PATH access", async () => {
		const env = homeEnv({ stateDir: "/never/read" }, { ULTRATHINK_REALM: "off" });
		expect(await probeRealmRaw(env, { cwd: CWD, now: () => T0, deps: THROWING })).toEqual({
			kind: "unknown",
			why: "disabled",
		});
		expect(await probeRealmRaw({ ...env, ULTRATHINK_REALM: " Off " }, { deps: THROWING })).toEqual({
			kind: "unknown",
			why: "disabled",
		});
		const conn = await probeRealm(ctx(env));
		expect(conn).toMatchObject({
			member: "realm",
			status: "disabled",
			reason: "Realm probe switched off by ULTRATHINK_REALM=off",
			fix: "unset ULTRATHINK_REALM",
			via: "none",
		});
	});

	test("any other ULTRATHINK_REALM value does not opt out", async () => {
		const stateDir = tempDir();
		const env = homeEnv({ stateDir }, { ULTRATHINK_REALM: "on" });
		expect(await raw(env)).toEqual({ kind: "daemon-down", stateDir });
	});

	test("a throwing seam never escapes the raw probe: it answers unknown/io", async () => {
		const env = homeEnv({ stateDir: "/x" });
		expect(await probeRealmRaw(env, { deps: THROWING })).toEqual({ kind: "unknown", why: "io" });
	});

	describe("realm status CLI fallback (fake runner only)", () => {
		const statusStdout = `${JSON.stringify({
			snapshot: { state: "active", reason: "bound", lastTransitionAt: TRANSITION_AT },
			display: {
				label: "realm active",
				degraded: false,
				reason: "bound",
				lastTransitionAt: TRANSITION_AT,
			},
			mode: "fail-closed",
		})}\n`;

		test("JSON stdout is validated like a socket reply and reports via cli, sending only `status`", async () => {
			const calls: string[][] = [];
			const probe = await raw(
				{ HOME: "relative", PATH: "/fake/bin" },
				{
					deps: {
						lookupOnPath: (name) => (name === "realm" ? "/fake/bin/realm" : undefined),
						runCli: async (file, args, childEnv) => {
							calls.push([file, ...args, ...Object.keys(childEnv)]);
							return { kind: "output", stdout: statusStdout };
						},
					},
				},
			);
			expect(probe).toEqual({
				kind: "present",
				stateDir: "",
				state: "active",
				label: "realm active",
				degraded: false,
				reason: "bound",
				mode: "fail-closed",
				lastTransitionAt: TRANSITION_AT,
				workspaceMatches: "unknown",
				via: "cli",
				probedAt: PROBED_AT,
			});
			// Only PATH and HOME reach the child (no secrets from the caller's env), and the only argument is status.
			expect(calls).toEqual([["/fake/bin/realm", "status", "PATH", "HOME"]]);
		});

		test("the literal single line `disconnected` is daemon-down", async () => {
			const probe = await raw(
				{},
				{
					deps: {
						lookupOnPath: () => "/fake/bin/realm",
						runCli: async () => ({ kind: "output", stdout: "disconnected\n" }),
					},
				},
			);
			expect(probe).toEqual({ kind: "daemon-down", stateDir: "" });
		});

		test("stdout that is neither JSON status nor `disconnected` is unknown/schema", async () => {
			for (const stdout of ["garbage\n", '{"mode":"permissive"}\n', ""]) {
				const probe = await raw(
					{},
					{
						deps: {
							lookupOnPath: () => "/fake/bin/realm",
							runCli: async () => ({ kind: "output", stdout }),
						},
					},
				);
				expect(probe).toEqual({ kind: "unknown", why: "schema" });
			}
		});

		test("a runner that never resolves is unknown/timeout within the budget", async () => {
			const never = Promise.withResolvers<never>();
			const started = Date.now();
			const probe = await raw(
				{},
				{
					timeoutMs: 50,
					deps: { lookupOnPath: () => "/fake/bin/realm", runCli: () => never.promise },
				},
			);
			expect(probe).toEqual({ kind: "unknown", why: "timeout" });
			expect(Date.now() - started).toBeLessThan(1000);
		});

		test("a runner failure is unknown/io", async () => {
			const probe = await raw(
				{},
				{ deps: { lookupOnPath: () => "/fake/bin/realm", runCli: async () => ({ kind: "io" }) } },
			);
			expect(probe).toEqual({ kind: "unknown", why: "io" });
		});

		test("the fallback runs when HOME is absolute but the config file is missing", async () => {
			const calls: string[] = [];
			const probe = await raw(homeEnv(), {
				deps: {
					lookupOnPath: () => "/fake/bin/realm",
					runCli: async (_file, args) => {
						calls.push(args.join(" "));
						return { kind: "output", stdout: "disconnected\n" };
					},
				},
			});
			expect(probe).toEqual({ kind: "daemon-down", stateDir: "" });
			expect(calls).toEqual(["status"]);
		});

		test("the CLI child runs in a fixed neutral directory, never the caller's cwd", async () => {
			const seen: string[] = [];
			const probe = await raw(homeEnv(), {
				cwd: "/caller/work/dir",
				deps: {
					lookupOnPath: () => "/fake/bin/realm",
					runCli: async (_file, _args, _env, _timeoutMs, cwd) => {
						seen.push(cwd);
						return { kind: "output", stdout: "disconnected\n" };
					},
				},
			});
			expect(probe).toEqual({ kind: "daemon-down", stateDir: "" });
			expect(seen).toEqual([tmpdir()]);
		});
	});

	describe("workspace match from session files", () => {
		test("a session whose workspaceRoot equals cwd gives true", async () => {
			const fake = await startFake({ reply: statusReply("active", "fail-closed") });
			writeSessions(fake.stateDir, {
				"a.json": { workspaceRoot: "/elsewhere" },
				"b.json": { workspaceRoot: CWD },
			});
			const probe = await raw(homeEnv({ stateDir: fake.stateDir }));
			expect(probe).toMatchObject({ kind: "present", workspaceMatches: true });
			await expectOneStatusRequest(fake);
		});

		test("readable sessions that all name other roots give false", async () => {
			const fake = await startFake({ reply: statusReply("active", "fail-closed") });
			writeSessions(fake.stateDir, {
				"a.json": { workspaceRoot: "/elsewhere" },
				"b.json": { workspaceRoot: "/other" },
			});
			expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toMatchObject({
				kind: "present",
				workspaceMatches: false,
			});
		});

		test("an empty sessions dir, or no sessions dir, gives unknown", async () => {
			const fake = await startFake({ reply: statusReply("active", "fail-closed") });
			writeSessions(fake.stateDir, {});
			expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toMatchObject({
				kind: "present",
				workspaceMatches: "unknown",
			});
			const bare = await startFake({ reply: statusReply("active", "fail-closed") });
			expect(await raw(homeEnv({ stateDir: bare.stateDir }))).toMatchObject({
				workspaceMatches: "unknown",
			});
		});

		test("with no cwd the match is unknown", async () => {
			const fake = await startFake({ reply: statusReply("active", "fail-closed") });
			writeSessions(fake.stateDir, { "a.json": { workspaceRoot: CWD } });
			const probe = await probeRealmRaw(homeEnv({ stateDir: fake.stateDir }), {
				now: () => T0,
				deps: spyDeps,
			});
			expect(probe).toMatchObject({ workspaceMatches: "unknown" });
		});

		test("at most 16 session files are read, so a match in the 20th is never seen", async () => {
			const fake = await startFake({ reply: statusReply("active", "fail-closed") });
			const files: Record<string, unknown> = {};
			for (let i = 0; i < 20; i += 1) {
				files[`s${String(i).padStart(2, "0")}.json`] = {
					workspaceRoot: i === 19 ? CWD : `/other/${String(i)}`,
				};
			}
			writeSessions(fake.stateDir, files);
			const reads: string[] = [];
			const probe = await raw(homeEnv({ stateDir: fake.stateDir }), {
				deps: {
					readSessionFile: (path) => {
						reads.push(path);
						return readFileSync(path, "utf8");
					},
				},
			});
			expect(reads).toHaveLength(16);
			expect(probe).toMatchObject({ kind: "present", workspaceMatches: false });
		});

		test("a session file over 64 KiB is skipped and never read whole", async () => {
			const fake = await startFake({ reply: statusReply("active", "fail-closed") });
			writeSessions(fake.stateDir, {
				"big.json": `{"workspaceRoot":"${CWD}","pad":"${"a".repeat(70_000)}"}`,
			});
			expect(await raw(homeEnv({ stateDir: fake.stateDir }))).toMatchObject({
				kind: "present",
				workspaceMatches: "unknown",
			});
		});
	});

	describe("secrecy", () => {
		test("planted canaries in ignored config fields and session files never reach any output", async () => {
			const daemonReason = "podman gone";
			const fake = await startFake({ reply: statusReply("degraded", "fail-closed", daemonReason) });
			writeSessions(fake.stateDir, {
				"a.json": { workspaceRoot: CWD, token: CANARY, andaUrl: CANARY_URL },
				"b.json": { workspaceRoot: "/other", apiKey: CANARY },
			});
			const env = homeEnv(
				{
					stateDir: fake.stateDir,
					image: CANARY,
					andaUrl: CANARY_URL,
					token: CANARY,
					nested: { key: CANARY },
				},
				{ OPENROUTER_API_KEY: CANARY },
			);
			const probe = await raw(env);
			const conn = await probeRealm(ctx(env));
			expect(probe).toMatchObject({ kind: "present", workspaceMatches: true });
			for (const output of [JSON.stringify(probe), JSON.stringify(conn)]) {
				expect(output).not.toContain(CANARY);
				expect(output).not.toContain("CANARYANDA5678");
				expect(output).not.toContain("CANARYCANARY");
			}
			oneLine(conn);
		});

		test("a misconfigured report carries a path, never a config value", async () => {
			const env = homeEnv(`{"stateDir":5,"image":"${CANARY}"}`);
			const conn = await probeRealm(ctx(env));
			expect(conn.status).toBe("misconfigured");
			expect(JSON.stringify(conn)).not.toContain(CANARY);
		});

		test("a multi-line daemon reason is flattened to one bounded line", async () => {
			const fake = await startFake({
				reply: statusReply(
					"error",
					"fail-closed",
					`first\nsecond\r\nthird\u0000${"x".repeat(500)}`,
				),
			});
			const conn = await probeRealm(ctx(homeEnv({ stateDir: fake.stateDir })));
			oneLine(conn);
			expect(conn.status).toBe("unavailable");
			expect(conn.reason.length).toBeLessThan(300);
		});

		test("C1 control characters in a daemon reason are collapsed like the C0 ones", async () => {
			const fake = await startFake({
				reply: statusReply("error", "fail-closed", "before\u0085middle\u009bcsi\u0080after"),
			});
			const conn = await probeRealm(ctx(homeEnv({ stateDir: fake.stateDir })));
			expect(conn.reason).toBe("Realm error: before middle csi after");
			expect(conn.reason).not.toMatch(/[\u0080-\u009f]/);
		});

		test("every reason across the matrix is a single line", async () => {
			const envs = [
				homeEnv({ stateDir: tempDir() }),
				homeEnv("{broken"),
				homeEnv({ stateDir: "rel" }),
				homeEnv({}, { ULTRATHINK_REALM: "off" }),
				{ PATH: "" },
			];
			for (const env of envs) oneLine(await probeRealm(ctx(env)));
		});
	});
});

describe("realmHostClass and realmHint", () => {
	const MCP_HOSTS: HostId[] = ["claude-code", "grok-build", "hermes", "muse", "prime-agent"];

	function present(state: RealmState, mode: RealmMode): RealmProbe {
		return {
			kind: "present",
			stateDir: "/state",
			state,
			label: state === "active" || state === "degraded" ? "realm active" : "realm disconnected",
			degraded: state === "degraded",
			reason: "r",
			mode,
			lastTransitionAt: TRANSITION_AT,
			workspaceMatches: "unknown",
			via: "socket",
			probedAt: PROBED_AT,
		};
	}

	const MCP_ENFORCING =
		"Realm is enforcing: route tool calls through Realm if the realm server's tools are available; if write or edit is refused with a REALM_* code, run /realm-retry or stop and report; do not work around it with bash.";
	const EXTENSION_ENFORCING =
		"Realm is enforcing: if write or edit is refused with a REALM_* code, run /realm-retry or stop and report; do not work around it with bash.";
	const ADVISORY =
		"Realm is active in advisory mode and does not contain writes: if write or edit is refused with a REALM_* code, run /realm-retry or stop and report; do not work around it with bash.";

	test("host classes: omp is extension, five hosts are mcp, cursor is none, and the table is total", () => {
		expect(realmHostClass("omp")).toBe("extension");
		for (const host of MCP_HOSTS) expect(realmHostClass(host)).toBe("mcp");
		expect(realmHostClass("cursor")).toBe("none");
		expect(new Set(HOSTS.map(realmHostClass))).toEqual(new Set(["extension", "mcp", "none"]));
	});

	test("enforcing realm routes only the five mcp-class hosts", () => {
		for (const probe of [present("active", "fail-closed"), present("degraded", "fail-closed")]) {
			for (const host of MCP_HOSTS) {
				const hint = realmHint(probe, host);
				expect(hint.enforcement).toBe("enforcing");
				expect(hint.routeThroughRealm).toBe(true);
				expect(hint.instruction).toBe(MCP_ENFORCING);
				expect(hint.instruction).toContain("if the realm server's tools are available");
			}
		}
	});

	test("omp gets the /realm-retry instruction without routing", () => {
		const hint = realmHint(present("active", "fail-closed"), "omp");
		expect(hint).toEqual({
			enforcement: "enforcing",
			routeThroughRealm: false,
			instruction: EXTENSION_ENFORCING,
		});
		expect(hint.instruction).toContain("/realm-retry");
		expect(hint.instruction).not.toContain("realm server's tools");
	});

	test("cursor never routes and has no instruction, even when enforcing", () => {
		for (const probe of [present("active", "fail-closed"), present("active", "advisory")]) {
			const hint = realmHint(probe, "cursor");
			expect(hint.routeThroughRealm).toBe(false);
			expect(hint.instruction).toBeNull();
		}
		expect(realmHint(present("active", "fail-closed"), "cursor").enforcement).toBe("enforcing");
	});

	test("an advisory probe never routes and says writes are not contained", () => {
		for (const probe of [present("active", "advisory"), present("degraded", "advisory")]) {
			for (const host of MCP_HOSTS) {
				expect(realmHint(probe, host)).toEqual({
					enforcement: "advisory",
					routeThroughRealm: false,
					instruction: ADVISORY,
				});
			}
			expect(realmHint(probe, "omp")).toEqual({
				enforcement: "advisory",
				routeThroughRealm: false,
				instruction: ADVISORY,
			});
		}
	});

	test("absent, daemon-down, unknown and the other states give enforcement none with no instruction", () => {
		const none: RealmProbe[] = [
			{ kind: "absent" },
			{ kind: "daemon-down", stateDir: "/state" },
			{ kind: "unknown", why: "timeout" },
			{ kind: "unknown", why: "disabled" },
			{ kind: "unknown", why: "untrusted-socket" },
			present("unbound", "fail-closed"),
			present("connecting", "fail-closed"),
			present("error", "fail-closed"),
			present("stopping", "advisory"),
		];
		for (const probe of none) {
			for (const host of HOSTS) {
				const expected: RealmHint = {
					enforcement: "none",
					routeThroughRealm: false,
					instruction: null,
				};
				expect(realmHint(probe, host)).toEqual(expected);
			}
		}
	});

	test("realmHint is pure: the probe is not mutated and repeated calls agree", () => {
		const probe = Object.freeze(present("active", "fail-closed"));
		const before = structuredClone(probe);
		const first = realmHint(probe, "hermes");
		const second = realmHint(probe, "hermes");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(probe).toEqual(before);
	});
});
