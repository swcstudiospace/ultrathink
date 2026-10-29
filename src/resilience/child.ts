// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One child-process runner for every completer: the child leads its own process group, abort and
 * timeout terminate the whole group (SIGTERM, then SIGKILL after a grace), pipes are drained for a
 * bounded time so a grandchild holding one cannot hang the call, and output is capped in memory.
 * `installChildReaper` kills live groups when the parent exits; `withTempDir` owns a private
 * directory for a call and always removes it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

export interface ChildResult {
	code: number | null;
	signal: string | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	timedOut: boolean;
	aborted: boolean;
}

export interface RunChildOptions {
	cmd: string[];
	cwd?: string;
	/** Complete child environment (not merged with `process.env`); undefined values are dropped. */
	env?: Record<string, string | undefined>;
	stdin?: string;
	/** 0 or undefined means no timer: planning calls have no default deadline. */
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Wait between SIGTERM and SIGKILL. Default 3000. */
	graceMs?: number;
	/** How long to keep reading pipes after the child exits. Default 2000. */
	drainMs?: number;
	/** Default 8 MiB. */
	maxStdoutBytes?: number;
	/** Default 256 KiB. */
	maxStderrBytes?: number;
}

const DEFAULT_GRACE_MS = 3000;
const DEFAULT_DRAIN_MS = 2000;
const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

/** Process-group ids (== child pids) of every child that has not settled yet. */
const liveGroups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		// A negative pid addresses the whole group; Windows has no groups, so the child alone.
		process.kill(process.platform === "win32" ? pid : -pid, signal);
	} catch {
		// reason: the group is already gone (ESRCH) or not ours; there is nothing left to kill
	}
}

/** Collects up to `cap` bytes and drops the rest, flagging it. Never buffers past the cap. */
class CappedBuffer {
	readonly #chunks: Buffer[] = [];
	#bytes = 0;
	truncated = false;

	constructor(readonly cap: number) {}

	push(chunk: Buffer): void {
		const room = this.cap - this.#bytes;
		if (chunk.length <= room) {
			this.#chunks.push(chunk);
			this.#bytes += chunk.length;
			return;
		}
		this.truncated = true;
		if (room <= 0) return;
		this.#chunks.push(chunk.subarray(0, room));
		this.#bytes += room;
	}

	text(): string {
		return Buffer.concat(this.#chunks).toString("utf8");
	}
}

function childEnv(env: Record<string, string | undefined>): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
	return clean;
}

export function runChild(opts: RunChildOptions): Promise<ChildResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ChildResult>();
	const [bin, ...args] = opts.cmd;
	if (bin === undefined) {
		reject(new Error("runChild: empty command"));
		return promise;
	}
	const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
	const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;
	const out = new CappedBuffer(opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES);
	const err = new CappedBuffer(opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES);
	const { signal } = opts;

	if (signal?.aborted) {
		resolve({
			code: null,
			signal: null,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			timedOut: false,
			aborted: true,
		});
		return promise;
	}

	let child: ChildProcess;
	try {
		child = spawn(bin, args, {
			cwd: opts.cwd,
			env: opts.env ? childEnv(opts.env) : process.env,
			detached: true,
			stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
	} catch (error) {
		reject(error);
		return promise;
	}

	const pid = child.pid;
	if (pid !== undefined) liveGroups.add(pid);

	let settled = false;
	let exited = false;
	let timedOut = false;
	let aborted = false;
	let code: number | null = null;
	let exitSignal: string | null = null;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	let drainTimer: ReturnType<typeof setTimeout> | undefined;

	const cleanup = (): void => {
		clearTimeout(timeoutTimer);
		clearTimeout(graceTimer);
		clearTimeout(drainTimer);
		signal?.removeEventListener("abort", onAbort);
		if (pid !== undefined) liveGroups.delete(pid);
	};

	const settle = (): void => {
		if (settled) return;
		settled = true;
		cleanup();
		// A group must never outlive the call: reap any grandchild still holding a pipe or running.
		if (pid !== undefined) killGroup(pid, "SIGKILL");
		child.stdin?.destroy();
		child.stdout?.destroy();
		child.stderr?.destroy();
		resolve({
			code,
			signal: exitSignal,
			stdout: out.text(),
			stderr: err.text(),
			stdoutTruncated: out.truncated,
			stderrTruncated: err.truncated,
			timedOut: timedOut && !aborted,
			aborted,
		});
	};

	const terminate = (): void => {
		if (pid === undefined) return;
		killGroup(pid, "SIGTERM");
		graceTimer ??= setTimeout(() => killGroup(pid, "SIGKILL"), graceMs);
	};

	function onAbort(): void {
		if (exited || settled) return;
		aborted = true;
		terminate();
	}

	child.on("error", (error) => {
		if (settled) return;
		if (pid !== undefined) return; // reason: a post-spawn error (kill failure) never changes the outcome
		settled = true;
		cleanup();
		reject(error);
	});
	child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
	child.stdin?.on("error", () => {
		// reason: the child may exit without reading stdin (EPIPE); its exit status is the outcome
	});
	child.on("exit", (exitCode, exitedBySignal) => {
		if (settled) return;
		exited = true;
		code = exitCode;
		exitSignal = exitedBySignal;
		clearTimeout(timeoutTimer);
		drainTimer = setTimeout(settle, drainMs);
	});
	child.on("close", (closeCode, closedBySignal) => {
		if (settled) return;
		if (!exited) {
			code = closeCode;
			exitSignal = closedBySignal;
		}
		settle();
	});

	if (pid !== undefined) {
		if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, opts.timeoutMs);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	}
	if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
	return promise;
}

function killAllGroups(): void {
	for (const pid of liveGroups) killGroup(pid, "SIGKILL");
}

let exitReaperInstalled = false;
let signalReaperInstalled = false;

/**
 * Kill every live child group when this process dies. The synchronous `exit` handler is always
 * registered. With `signals: true` SIGTERM and SIGINT also kill the groups and then exit with the
 * conventional 128 + signal number (an explicit exit rather than re-raising, so the result does
 * not depend on whether the runtime restores the default disposition once a listener is removed).
 * Only short-lived hook entrypoints pass `signals: true`; the Omp extension never does.
 * Idempotent: each handler is registered at most once per process.
 */
export function installChildReaper(opts?: { signals?: boolean }): void {
	if (!exitReaperInstalled) {
		exitReaperInstalled = true;
		process.on("exit", killAllGroups);
	}
	if (opts?.signals && !signalReaperInstalled) {
		signalReaperInstalled = true;
		for (const name of ["SIGTERM", "SIGINT"] as const) {
			process.on(name, () => {
				killAllGroups();
				process.exit(128 + (osConstants.signals[name] ?? 0));
			});
		}
	}
}

/** Run `fn` inside a private (0700) directory under `os.tmpdir()`, removed on every path. */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	try {
		await chmod(dir, 0o700);
		return await fn(dir);
	} finally {
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			// reason: cleanup is best effort and must not mask the callback's own result or error
		}
	}
}
