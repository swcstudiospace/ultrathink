// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Reads the Grok Build CLI OAuth session (`~/.grok/auth.json`) so the plugin can
 * call the CLI chat proxy with the user's existing SuperGrok login.
 *
 * Tokens never leave this module except inside request headers; status objects
 * and error messages are redacted.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { GROK_CLIENT_VERSION_FALLBACK } from "./types.ts";
import { dropJevKeys } from "../route-defaults.ts";
import { readJson } from "../shared.ts";

export interface GrokAuth {
	token: string;
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt?: number;
	email?: string;
	userId?: string;
	issuer?: string;
	clientId?: string;
	/** Set by `ensureFreshGrokAuth` when the CLI refresh timed out and the session is still expired. */
	refreshTimedOut?: boolean;
}

/** Safe to print: never contains the token. */
export interface GrokAuthStatus {
	loggedIn: boolean;
	expired: boolean;
	email?: string;
	/** ISO timestamp. */
	expiresAt?: string;
	home: string;
}

export class GrokAuthError extends Error {
	override name = "GrokAuthError";
}

export class GrokHttpError extends Error {
	override name = "GrokHttpError";
	status: number;
	body: string;
	/** The server's `Retry-After` in milliseconds, clamped by the retry kernel; absent when it sent none. */
	retryAfterMs?: number;

	constructor(message: string, status: number, body: string, retryAfterMs?: number) {
		super(message);
		this.status = status;
		this.body = body;
		if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
	}
}

export function grokHome(
	home?: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return home?.trim() || env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function parseIso(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/** One `auth.json` entry as written by `grok login`; fields are still validated at use. */
interface AuthEntry {
	key?: unknown;
	refresh_token?: unknown;
	expires_at?: unknown;
	email?: unknown;
	user_id?: unknown;
	oidc_issuer?: unknown;
	oidc_client_id?: unknown;
}

export function readGrokAuth(home?: string): GrokAuth | undefined {
	const parsed = readJson(join(grokHome(home), "auth.json"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const first: unknown = Object.values(parsed)[0];
	if (!first || typeof first !== "object") return undefined;
	const entry: AuthEntry = first;
	const token = optionalString(entry.key);
	if (!token) return undefined;
	return {
		token,
		refreshToken: optionalString(entry.refresh_token),
		expiresAt: parseIso(entry.expires_at),
		email: optionalString(entry.email),
		userId: optionalString(entry.user_id),
		issuer: optionalString(entry.oidc_issuer),
		clientId: optionalString(entry.oidc_client_id),
	};
}

export function grokClientVersion(home?: string): string {
	const parsed = readJson(join(grokHome(home), "version.json"));
	if (parsed && typeof parsed === "object" && "version" in parsed) {
		const version = optionalString(parsed.version);
		if (version) return version.trim();
	}
	return GROK_CLIENT_VERSION_FALLBACK;
}

export function isGrokAuthExpired(
	auth: GrokAuth,
	now: number = Date.now(),
	skewMs = 60_000,
): boolean {
	return auth.expiresAt !== undefined && auth.expiresAt - skewMs <= now;
}

function statusFromAuth(auth: GrokAuth | undefined, home: string, now: number): GrokAuthStatus {
	if (!auth) return { loggedIn: false, expired: false, home };
	return {
		loggedIn: true,
		expired: isGrokAuthExpired(auth, now),
		email: auth.email,
		expiresAt: auth.expiresAt === undefined ? undefined : new Date(auth.expiresAt).toISOString(),
		home,
	};
}

export function grokAuthStatus(home?: string, now: number = Date.now()): GrokAuthStatus {
	const resolvedHome = grokHome(home);
	return statusFromAuth(readGrokAuth(resolvedHome), resolvedHome, now);
}

export interface EnsureFreshOptions {
	home?: string;
	/** Grok CLI executable; default `grok` on PATH. */
	bin?: string;
	now?: number;
	skewMs?: number;
	/** Kill the CLI after this long; default 20 s. */
	timeoutMs?: number;
	/** Run the CLI even when the token is not expired (e.g. after an upstream 401). */
	force?: boolean;
	/** Stops waiting for the refresh and kills the CLI once no caller sharing this refresh still waits. */
	signal?: AbortSignal;
	/** Test seam: runs `cmd` with `env`, resolves with the exit code. `signal` aborts when nobody waits for the refresh any more. */
	spawn?: (
		cmd: string[],
		env: Record<string, string | undefined>,
		signal?: AbortSignal,
	) => Promise<number>;
	/** Child environment for the CLI; default is the whole `process.env`. Pass an allowlist when the host holds unrelated secrets. */
	env?: Record<string, string | undefined>;
}

/** Runs the CLI; resolves `true` when the timeout killed it. An abort also kills it. */
async function spawnGrok(
	cmd: string[],
	env: Record<string, string | undefined>,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	let timedOut = false;
	const timer =
		timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, timeoutMs)
			: undefined;
	const onAbort = (): void => proc.kill();
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		await proc.exited;
		return timedOut;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

/** Back-to-back fills inside this window reuse the last refresh instead of spawning `grok models` again. */
const REFRESH_WINDOW_MS = 60_000;

interface RefreshFlight {
	/** Resolves `true` when the refresh timed out; never rejects. */
	done: Promise<boolean>;
	controller: AbortController;
	waiters: number;
	settled: boolean;
}

const inflight = new Map<string, RefreshFlight>();
const refreshedAt = new Map<string, number>();

function startFlight(
	key: string,
	cmd: string[],
	env: Record<string, string | undefined>,
	opts: EnsureFreshOptions,
	now: number,
): RefreshFlight {
	const controller = new AbortController();
	const flight: RefreshFlight = {
		controller,
		waiters: 0,
		settled: false,
		done: Promise.resolve(false),
	};
	flight.done = (async (): Promise<boolean> => {
		let timedOut = false;
		try {
			if (opts.spawn) await opts.spawn(cmd, env, controller.signal);
			else timedOut = await spawnGrok(cmd, env, opts.timeoutMs ?? 20_000, controller.signal);
			if (!timedOut && !controller.signal.aborted) refreshedAt.set(key, now);
		} catch {
			// reason: The CLI is optional here: fall through and report whatever auth.json holds now.
		} finally {
			flight.settled = true;
			inflight.delete(key);
		}
		return timedOut;
	})();
	inflight.set(key, flight);
	return flight;
}

/**
 * Returns the current session, letting the Grok CLI refresh it first when it is
 * expired (or `force` is set) and a refresh token exists. `grok models` makes an
 * authenticated call, and the CLI rewrites `auth.json` itself when the access
 * token needs refreshing; this module never touches the token endpoint or the
 * file. Concurrent callers for one home share a single CLI run, and a finished
 * run is reused for 60 s unless `force` is set. The result may still be expired
 * (`refreshTimedOut` says the CLI ran out of time) — callers decide what that
 * means. Never throws: a failed or missing CLI just leaves the session as it was,
 * and an abort returns the session as it is without waiting for the CLI.
 */
export async function ensureFreshGrokAuth(
	opts: EnsureFreshOptions = {},
): Promise<GrokAuth | undefined> {
	const auth = readGrokAuth(opts.home);
	if (!auth) return undefined;
	if (!opts.force && !isGrokAuthExpired(auth, opts.now, opts.skewMs)) return auth;
	if (!auth.refreshToken) return auth;
	if (opts.signal?.aborted) return auth;

	const key = grokHome(opts.home);
	const now = opts.now ?? Date.now();
	let flight = inflight.get(key);
	if (!flight) {
		const last = refreshedAt.get(key);
		if (!opts.force && last !== undefined && now >= last && now - last < REFRESH_WINDOW_MS)
			return auth;
		const env: Record<string, string | undefined> = { ...(opts.env ?? process.env) };
		const home = opts.home?.trim();
		if (home) env.GROK_HOME = home;
		dropJevKeys(env);
		flight = startFlight(key, [opts.bin?.trim() || "grok", "models"], env, opts, now);
	}

	const shared = flight;
	shared.waiters++;
	const { signal } = opts;
	let onAbort: (() => void) | undefined;
	const outcome = await new Promise<boolean | "aborted">((resolve) => {
		onAbort = () => resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		void shared.done.then(resolve);
	});
	if (onAbort) signal?.removeEventListener("abort", onAbort);
	shared.waiters--;
	if (!shared.settled && shared.waiters === 0) shared.controller.abort();
	const fresh = readGrokAuth(opts.home);
	if (outcome === true && fresh && isGrokAuthExpired(fresh, opts.now, opts.skewMs))
		return { ...fresh, refreshTimedOut: true };
	return fresh;
}

/** `grokAuthStatus` after giving the CLI a chance to refresh an expired session. */
export async function grokAuthStatusFresh(opts: EnsureFreshOptions = {}): Promise<GrokAuthStatus> {
	return statusFromAuth(
		await ensureFreshGrokAuth(opts),
		grokHome(opts.home),
		opts.now ?? Date.now(),
	);
}

export function grokHeaders(
	auth: GrokAuth,
	model: string,
	version: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${auth.token}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-model-override": model,
		"x-grok-client-version": version,
	};
}
