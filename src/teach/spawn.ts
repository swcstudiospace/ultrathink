// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Hands a `TeachDigest` to a detached `teach observe` process. A host's Stop or agent_end handler has seconds, and the
 * distiller needs up to 90, so the host writes the digest to a private inbox file and starts the CLI without waiting
 * for it. The CLI deletes the file once read; files left behind by a crash are pruned after 24 hours.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TeachDigest } from "./types.ts";

const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INBOX_FILE = /^(\d+)-[0-9a-f]{8}\.json(?:\.tmp)?$/;
/** The detached supervisor: it starts the observe command and records a failed exit. */
const SUPERVISOR = join(import.meta.dir, "launch-supervisor.ts");
/** bin/run-bun passes --no-env-file, so a cloned repository's .env never reaches the supervisor. */
const RUN_BUN = join(import.meta.dir, "..", "..", "bin", "run-bun");

export interface SpawnObserveOptions {
	repoRoot: string;
	env: NodeJS.ProcessEnv;
	stateDir: string;
	host: string;
	/** Test seam; defaults to a detached, unref'd `node:child_process` spawn with ignored stdio. */
	spawn?: (
		cmd: string,
		args: string[],
		opts: { env: NodeJS.ProcessEnv; cwd: string },
	) => DetachedLaunch | void;
}

function inboxDir(stateDir: string): string {
	return join(stateDir, "teach", "inbox");
}

/** A detached launch: its pid, undefined when the launcher did not start. */
interface DetachedLaunch {
	pid: number | undefined;
}

/** Starts a detached child with ignored stdio and returns at once, without waiting for it. */
function startDetached(
	cmd: string,
	args: string[],
	opts: { env: NodeJS.ProcessEnv; cwd: string },
): DetachedLaunch {
	const child = nodeSpawn(cmd, args, {
		cwd: opts.cwd,
		env: opts.env,
		detached: true,
		stdio: "ignore",
	});
	// A missing launcher is reported asynchronously as an 'error' event; without a listener it would crash the host.
	child.on("error", () => {
		// reason: a launcher that never started has no pid, and the caller reports that
	});
	child.unref();
	return { pid: child.pid };
}

/** Removes inbox files older than 24 hours. Foreign file names are left alone; failures are ignored. */
function pruneInbox(dir: string, now: number): void {
	try {
		for (const name of readdirSync(dir)) {
			const match = INBOX_FILE.exec(name);
			if (match && now - Number(match[1]) > INBOX_MAX_AGE_MS)
				rmSync(join(dir, name), { force: true });
		}
	} catch {
		// reason: best effort: no inbox yet, or unreadable
	}
}

export function writeInbox(
	digest: TeachDigest,
	stateDir: string,
	now: () => number = Date.now,
): string {
	const dir = inboxDir(stateDir);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// reason: a directory we do not own keeps its mode
	}
	const path = join(dir, `${now()}-${randomBytes(4).toString("hex")}.json`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(digest), { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

/**
 * Starts the supervisor of one `teach observe` run and returns at once; it never waits for the run or its log lock.
 * `spawned` is false when the inbox file or the supervisor could not be started. Never throws.
 */
export function spawnObserveDetached(
	digest: TeachDigest,
	options: SpawnObserveOptions,
): { spawned: boolean; reason?: string } {
	let path: string | undefined;
	try {
		pruneInbox(inboxDir(options.stateDir), Date.now());
		path = writeInbox(digest, options.stateDir);
		const cwd = existsSync(digest.cwd) ? digest.cwd : options.repoRoot;
		const childEnv: NodeJS.ProcessEnv = {
			...options.env,
			ULTRATHINK_HOST: options.host,
			ULTRATHINK_STATE_DIR: options.stateDir,
		};
		// The supervisor starts the observe command and records a failed exit. The host waits for neither.
		const task = JSON.stringify({
			stateDir: options.stateDir,
			sessionId: digest.sessionId,
			command: join(options.repoRoot, "bin", "ultrathink"),
			args: ["teach", "observe", "--file", path],
		});
		const launch = (options.spawn ?? startDetached)(RUN_BUN, [SUPERVISOR, task], {
			env: childEnv,
			cwd,
		});
		if (launch && launch.pid === undefined) throw new Error("launcher did not start");
		return { spawned: true };
	} catch (error) {
		if (path) {
			try {
				rmSync(path, { force: true });
			} catch {
				// reason: the 24 hour prune collects it
			}
		}
		return {
			spawned: false,
			reason: error instanceof Error ? error.message.slice(0, 200) : "spawn failed",
		};
	}
}
