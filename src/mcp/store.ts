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

export function readStore(path: string): CredentialStore {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialStore>;
		if (
			parsed &&
			parsed.version === 1 &&
			parsed.providers &&
			typeof parsed.providers === "object"
		) {
			return { version: 1, providers: parsed.providers };
		}
	} catch {
		// reason: a missing or corrupt store reads as empty, so a corrupt credential file looks like no credentials. Deferred: outside services, see 79-CONTEXT D-03 (root-side B sites).
	}
	return { version: 1, providers: {} };
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

function readOwner(dir: string): string | undefined {
	try {
		return readFileSync(join(dir, OWNER_FILE), "utf8");
	} catch {
		return undefined;
	}
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
		staleMs?: number;
		waitMs?: number;
		pollMs?: number;
		/** Clock for the lock deadline, staleness and heartbeat stamps; defaults to `Date.now`. */
		now?: () => number;
		/** Wait between acquire attempts; defaults to `Bun.sleep`. */
		sleep?: (ms: number) => Promise<void>;
		/** Interval port for the heartbeat that keeps a held lock fresh; defaults to the platform timers. */
		timers?: LockTimers;
	} = {},
): Promise<T> {
	const staleMs = opts.staleMs ?? 60_000;
	const waitMs = opts.waitMs ?? 30_000;
	const pollMs = opts.pollMs ?? 100;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
	const timers: LockTimers = opts.timers ?? {
		setInterval: (fn, ms) => setInterval(fn, ms),
		clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
	};
	const lock = `${path}.lock`;
	const nonce = randomBytes(16).toString("hex");
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = now() + waitMs;
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(join(lock, OWNER_FILE), nonce);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		let judged: { owner: string | undefined; mtimeMs: number } | undefined;
		try {
			const mtimeMs = statSync(lock).mtimeMs;
			if (now() - mtimeMs > staleMs) judged = { owner: readOwner(lock), mtimeMs };
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
			if (readOwner(lock) !== nonce) return;
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
		if (readOwner(lock) === nonce) rmSync(lock, { recursive: true, force: true });
	}
}
