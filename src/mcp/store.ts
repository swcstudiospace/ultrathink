// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { processIdentity } from "../swarm/lane.ts";
import type { ProviderId } from "./providers.ts";

export interface OAuthClient {
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registeredAt: number;
}

export interface OAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	scope?: string;
}

export type Credential =
	| { kind: "api_key"; apiKey: string; updatedAt: number }
	| {
			kind: "oauth";
			client: OAuthClient;
			tokens?: OAuthTokens;
			needsLogin?: string;
			updatedAt: number;
	  };

export interface CredentialStore {
	version: 1;
	providers: Partial<Record<ProviderId, Credential>>;
}

export function storePath(env: Record<string, string | undefined> = process.env): string {
	if (env.ULTRATHINK_MCP_STORE) return env.ULTRATHINK_MCP_STORE;
	const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
	return join(base, "ultrathink", "mcp-credentials.json");
}

/** Why a strict read refused a store; a short code, never any of the file's content. */
type StoreReadFailure = "invalid_json" | "unsupported_shape" | "unreadable";

/** A strict read found a store it cannot trust. Carries the reason code only: the content may hold secrets. */
export class StoreReadError extends Error {
	constructor(
		readonly code: StoreReadFailure,
		path: string,
		override readonly cause?: unknown,
	) {
		super(`credential store ${path} is unreadable (${code})`);
		this.name = "StoreReadError";
	}
}

/**
 * The credential store. Lenient by default: a missing or corrupt file reads as empty, which is right for a status
 * line or a settings probe. `strict` is for a read that a write follows: only a missing file (ENOENT) is empty, any
 * other failure throws {@link StoreReadError}, so a failed read can never be persisted as an empty store.
 */
export function readStore(path: string, opts: { strict?: boolean } = {}): CredentialStore {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (!opts.strict || (error as NodeJS.ErrnoException).code === "ENOENT") {
			return { version: 1, providers: {} };
		}
		throw new StoreReadError("unreadable", path, error);
	}
	let parsed: Partial<CredentialStore> | null;
	try {
		parsed = JSON.parse(raw) as Partial<CredentialStore> | null;
	} catch (error) {
		if (!opts.strict) return { version: 1, providers: {} };
		throw new StoreReadError("invalid_json", path, error);
	}
	if (parsed && parsed.version === 1 && parsed.providers && typeof parsed.providers === "object") {
		return { version: 1, providers: parsed.providers };
	}
	if (!opts.strict) return { version: 1, providers: {} };
	throw new StoreReadError("unsupported_shape", path);
}

export interface StoreStatus {
	/** False when no file is there: nothing to report. */
	exists: boolean;
	/** True when the file holds a version 1 store; always true when it does not exist. */
	parsable: boolean;
	/** The file's permission bits (`mode & 0o777`); absent when it does not exist. */
	mode?: number;
}

/** Whether the store file is there, parses and who can read it. Never throws and never returns file content, unlike `readStore`, which reads a corrupt store as empty. */
export function storeStatus(path: string): StoreStatus {
	let mode: number;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// reason: no file (or no access to its directory) means no store to judge; the caller reports nothing.
		return { exists: false, parsable: true };
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialStore> | null;
		const valid =
			!!parsed &&
			parsed.version === 1 &&
			!!parsed.providers &&
			typeof parsed.providers === "object";
		return { exists: true, parsable: valid, mode };
	} catch {
		// reason: the failure is the answer: the file exists and does not parse (or cannot be read).
		return { exists: true, parsable: false, mode };
	}
}

export function writeStore(path: string, store: CredentialStore): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(store, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

const OWNER_FILE = "owner";

/** What the owner file holds: who holds the lock (pid and process start identity) and its unique token. */
interface LockOwner {
	pid: number;
	startTime: string;
}

function readOwner(dir: string): string | undefined {
	try {
		return readFileSync(join(dir, OWNER_FILE), "utf8");
	} catch {
		return undefined;
	}
}

/** The holder named by an owner file, or undefined for a legacy bare-token file or any other content. */
function parseOwner(raw: string | undefined): LockOwner | undefined {
	if (raw === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		// reason: a legacy bare-token owner file is not JSON; the lock then ages out by its mtime
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { pid, startTime } = value as Record<string, unknown>;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	if (typeof startTime !== "string") return undefined;
	return { pid, startTime };
}

/** Seams for the holder-liveness check; the defaults read the real process table. */
interface HolderLiveness {
	/** Whether the pid is running (default `process.kill(pid, 0)`; EPERM counts as running). */
	alive?: (pid: number) => boolean;
	/** The process's start identity, undefined when unreadable (default `processIdentity`). */
	identity?: (pid: number) => string | undefined;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** True only when the holder is provably gone: its pid is not running, or the pid now belongs to another process. */
function holderGone(owner: LockOwner, seams: HolderLiveness): boolean {
	if (!(seams.alive ?? pidAlive)(owner.pid)) return true;
	if (owner.startTime === "") return false;
	const current = (seams.identity ?? processIdentity)(owner.pid);
	return current !== undefined && current !== owner.startTime;
}

/**
 * Break a lock judged stale. Renaming first makes the takeover atomic: only one waiter wins the
 * rename, and the renamed dir is removed only if it is still the lock that was judged stale. If
 * the holder heartbeated or a new holder took over in between, the renamed dir is abandoned
 * (never moved back) and the caller simply retries acquiring.
 */
function breakStaleLock(lock: string, owner: string | undefined, mtimeMs: number): void {
	const aside = `${lock}.stale-${randomBytes(6).toString("hex")}`;
	try {
		renameSync(lock, aside);
	} catch {
		return;
	}
	try {
		if (readOwner(aside) === owner && statSync(aside).mtimeMs === mtimeMs) {
			rmSync(aside, { recursive: true, force: true });
		}
	} catch {
		// reason: already gone
	}
}

/** The interval port the lock heartbeat runs on. */
export interface LockTimers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export async function withStoreLock<T>(
	path: string,
	fn: () => Promise<T>,
	opts: {
		/** A lock whose holder cannot be shown dead is taken over once this old (default 60 s); the heartbeat keeps a live one fresh. */
		staleMs?: number;
		/** How long to wait for the lock; at least the stale window by default (65 s), so a stale lock is taken over, not waited out. */
		waitMs?: number;
		pollMs?: number;
		/** Clock for the lock deadline, staleness and heartbeat stamps; defaults to `Date.now`. */
		now?: () => number;
		/** Wait between acquire attempts; defaults to `Bun.sleep`. */
		sleep?: (ms: number) => Promise<void>;
		/** Interval port for the heartbeat that keeps a held lock fresh; defaults to the platform timers. */
		timers?: LockTimers;
		/** Seams for the holder-liveness check. */
		holder?: HolderLiveness;
	} = {},
): Promise<T> {
	const staleMs = opts.staleMs ?? 60_000;
	const waitMs = opts.waitMs ?? staleMs + 5_000;
	const pollMs = opts.pollMs ?? 100;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
	const timers: LockTimers = opts.timers ?? {
		setInterval: (fn, ms) => setInterval(fn, ms),
		clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
	};
	const seams = opts.holder ?? {};
	const lock = `${path}.lock`;
	// The whole owner file is the token: the heartbeat and the release compare it byte for byte.
	const token = JSON.stringify({
		pid: process.pid,
		startTime: processIdentity(process.pid) ?? "",
		token: randomBytes(16).toString("hex"),
	});
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = now() + waitMs;
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, OWNER_FILE), token);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let judged: { owner: string | undefined; mtimeMs: number } | undefined;
		try {
			const mtimeMs = statSync(lock).mtimeMs;
			const raw = readOwner(lock);
			const holder = parseOwner(raw);
			// A holder that is provably gone loses the lock at once; any other lock ages out by its mtime.
			if ((holder !== undefined && holderGone(holder, seams)) || now() - mtimeMs > staleMs) {
				judged = { owner: raw, mtimeMs };
			}
		} catch {
			// reason: the lock vanished between the mkdir and the stat; the loop retries the acquire
			continue;
		}
		if (judged) {
			breakStaleLock(lock, judged.owner, judged.mtimeMs);
			continue;
		}
		if (now() >= deadline) throw new Error(`timed out waiting for credential store lock ${lock}`);
		await sleep(pollMs);
	}
	const heartbeat = timers.setInterval(
		() => {
			if (readOwner(lock) !== token) return;
			try {
				const stamp = new Date(now());
				utimesSync(lock, stamp, stamp);
			} catch {
				// reason: lock vanished; release below handles it
			}
		},
		Math.max(1, Math.floor(staleMs / 3)),
	);
	try {
		return await fn();
	} finally {
		timers.clearInterval(heartbeat);
		if (readOwner(lock) === token) rmSync(lock, { recursive: true, force: true });
	}
}
