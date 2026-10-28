// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Persisted circuit breaker for the Jev rails. A spent account (HTTP 402) or a rejected key (401/403) cannot heal by
 * retrying, so the first such failure opens the breaker: every later call is refused locally, without network I/O,
 * until a cool-down passes and one probe call finds out whether Jev is back. Each hook invocation is its own process,
 * so the state lives in `<stateDir>/decisions-health.json` (owner-only, atomic) and read-modify-write is serialised
 * with the repo's file lock. A missing, empty, corrupt or foreign-version file reads as closed: a broken state file
 * must never keep Jev off, and no method here ever throws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";

export type JevOpenCause = "credits" | "auth";

interface JevHealthState {
	v: 1;
	state: "closed" | "open";
	cause?: JevOpenCause;
	/** Epoch ms the current open spell began. */
	since?: number;
	/** Epoch ms; calls before it are refused without network I/O. */
	nextProbeAt?: number;
	/** Current cool-down (doubles per failed probe, capped). */
	coolDownMs?: number;
	/** Consecutive hard failures. */
	failures: number;
	warnedCause?: JevOpenCause;
	warnedAt?: number;
	lastOkAt?: number;
}

export const COOL_DOWN_BASE_MS = 300_000;
export const COOL_DOWN_MAX_MS = 21_600_000;
/** An open breaker warns again after this long. */
export const REWARN_MS = 86_400_000;
/** The first call after a cool-down claims the probe by pushing the next check this far out, so concurrent processes do not all probe. */
const PROBE_CLAIM_MS = 60_000;
/** Each cool-down is spread by up to this fraction either way, so a fleet of processes does not probe in lockstep. */
const JITTER = 0.2;
/** `Date` cannot format a time beyond this; a larger stored value is corrupt. */
const MAX_TIME_MS = 8.64e15;
const FILE = "decisions-health.json";

type Verdict =
	| { call: true; probe: boolean }
	| { call: false; cause: JevOpenCause; nextProbeAt: number };

export interface JevHealth {
	read(): JevHealthState;
	/** call: false carries the cause and nextProbeAt; probe: true marks the first call after the cool-down. */
	shouldCall(now: number): Verdict;
	recordSuccess(now: number): void;
	/** Only "credits" and "auth" open the breaker; every other kind is ignored here. Returns whether this call opened or re-opened it. */
	recordFailure(kind: string, now: number): { opened: boolean };
	/** The text the visible channels show, or undefined when closed. */
	describe(now: number): string | undefined;
	/** True once per cause entry (and again after REWARN_MS while open); marks it warned and persists. */
	takeWarning(now: number): string | undefined;
}

/** The open shape every method after parsing may rely on: cause and times are present and valid. */
type OpenState = JevHealthState & {
	state: "open";
	cause: JevOpenCause;
	since: number;
	nextProbeAt: number;
};

const CAUSE_PHRASE: Record<JevOpenCause, string> = {
	credits: "OpenRouter reports insufficient credits",
	auth: "OpenRouter rejected the key",
};

function isCause(value: unknown): value is JevOpenCause {
	return value === "credits" || value === "auth";
}

function isOpen(state: JevHealthState): state is OpenState {
	return state.state === "open";
}

function timestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS
		? value
		: undefined;
}

function closed(): JevHealthState {
	return { v: 1, state: "closed", failures: 0 };
}

/** Anything unexpected is closed; an "open" record without a usable cause and next check cannot refuse a call. */
function parseState(raw: unknown): JevHealthState {
	if (typeof raw !== "object" || raw === null) return closed();
	const row = raw as Record<string, unknown>;
	if (row.v !== 1 || (row.state !== "closed" && row.state !== "open")) return closed();
	const failures =
		typeof row.failures === "number" && Number.isInteger(row.failures) && row.failures >= 0
			? row.failures
			: 0;
	const common: JevHealthState = { v: 1, state: "closed", failures };
	const warnedAt = timestamp(row.warnedAt);
	const lastOkAt = timestamp(row.lastOkAt);
	if (isCause(row.warnedCause)) common.warnedCause = row.warnedCause;
	if (warnedAt !== undefined) common.warnedAt = warnedAt;
	if (lastOkAt !== undefined) common.lastOkAt = lastOkAt;
	if (row.state === "closed") return common;
	const nextProbeAt = timestamp(row.nextProbeAt);
	if (!isCause(row.cause) || nextProbeAt === undefined) return closed();
	const coolDownMs = timestamp(row.coolDownMs);
	return {
		...common,
		state: "open",
		cause: row.cause,
		// A hand-built file may omit it; it is only displayed.
		since: timestamp(row.since) ?? nextProbeAt,
		nextProbeAt,
		...(coolDownMs !== undefined && coolDownMs > 0 ? { coolDownMs } : {}),
	};
}

function readState(path: string): JevHealthState {
	try {
		return parseState(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return closed();
	}
}

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isoTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** The error message for a call the breaker refused: one line, `decisions <kind>: <detail>`, well under 200 chars. */
export function unavailableMessage(refused: { cause: JevOpenCause; nextProbeAt: number }): string {
	return `decisions unavailable: ${CAUSE_PHRASE[refused.cause]}; next check ${isoTime(refused.nextProbeAt)}`;
}

function describeOpen(state: OpenState, now: number): string {
	const next =
		state.nextProbeAt <= now
			? "next check: the next decision"
			: `next check ${isoTime(state.nextProbeAt)}`;
	return state.cause === "credits"
		? `Jev unavailable: ${CAUSE_PHRASE.credits} since ${isoDate(state.since)}. Decisions fall back to their defaults until you top up at https://openrouter.ai/settings/credits (${next}).`
		: `Jev unavailable: ${CAUSE_PHRASE.auth} since ${isoDate(state.since)}. Fix: bin/ultrathink-mcp auth set-key openrouter --stdin (${next}).`;
}

function warningDue(state: OpenState, now: number): boolean {
	return (
		state.warnedCause !== state.cause ||
		state.warnedAt === undefined ||
		now - state.warnedAt >= REWARN_MS
	);
}

/** Where the state lives: `mutate` is one read-modify-write that the backing makes exclusive as far as it can. */
interface Backing {
	read(): JevHealthState;
	mutate<T>(change: (state: JevHealthState) => { next?: JevHealthState; result: T }): T;
}

function fileBacking(path: string): Backing {
	return {
		read: () => readState(path),
		// Locked across processes; a failed write is dropped (the call it describes already happened).
		mutate: (change) =>
			withFileLock(path, () => {
				const { next, result } = change(readState(path));
				if (next) {
					try {
						writeFileAtomic(path, `${JSON.stringify(next, null, "\t")}\n`);
					} catch {
						// reason: an unwritable state dir leaves the breaker as it was; it must never block Jev
					}
				}
				return result;
			}),
	};
}

function memoryBacking(): Backing {
	let state = closed();
	return {
		read: () => ({ ...state }),
		mutate: (change) => {
			const { next, result } = change(state);
			if (next) state = next;
			return result;
		},
	};
}

function createHealth(backing: Backing, rng: () => number): JevHealth {
	const { read, mutate } = backing;

	const refusal = (state: OpenState): Verdict => ({
		call: false,
		cause: state.cause,
		nextProbeAt: state.nextProbeAt,
	});

	return {
		read,

		shouldCall(now) {
			const state = read();
			if (!isOpen(state)) return { call: true, probe: false };
			if (now < state.nextProbeAt) return refusal(state);
			// Due: claim the probe under the lock so only one of several waiting processes makes it.
			return mutate<Verdict>((current) => {
				if (!isOpen(current)) return { result: { call: true, probe: false } };
				if (now < current.nextProbeAt) return { result: refusal(current) };
				return {
					next: { ...current, nextProbeAt: now + PROBE_CLAIM_MS },
					result: { call: true, probe: true },
				};
			});
		},

		recordSuccess(now) {
			// A success ends the spell and its warning, so the next spell warns again.
			mutate<undefined>(() => ({ next: { ...closed(), lastOkAt: now }, result: undefined }));
		},

		recordFailure(kind, now) {
			if (!isCause(kind)) return { opened: false };
			const cause = kind;
			return mutate<{ opened: boolean }>((state) => {
				const sameSpell = isOpen(state) && state.cause === cause;
				const coolDownMs = sameSpell
					? Math.min((state.coolDownMs ?? COOL_DOWN_BASE_MS) * 2, COOL_DOWN_MAX_MS)
					: COOL_DOWN_BASE_MS;
				const spread = Math.round(coolDownMs * (1 - JITTER + 2 * JITTER * rng()));
				return {
					next: {
						...state,
						state: "open",
						cause,
						since: sameSpell ? state.since : now,
						nextProbeAt: now + spread,
						coolDownMs,
						failures: state.failures + 1,
					},
					result: { opened: true },
				};
			});
		},

		describe(now) {
			const state = read();
			return isOpen(state) ? describeOpen(state, now) : undefined;
		},

		takeWarning(now) {
			const state = read();
			if (!isOpen(state) || !warningDue(state, now)) return undefined;
			return mutate<string | undefined>((current) => {
				if (!isOpen(current) || !warningDue(current, now)) return { result: undefined };
				return {
					next: { ...current, warnedCause: current.cause, warnedAt: now },
					result: describeOpen(current, now),
				};
			});
		},
	};
}

/** Never throws; reads nothing until a method is called. `rng` (default Math.random) supplies the cool-down jitter. */
export function openJevHealth(stateDir: string, opts: { rng?: () => number } = {}): JevHealth {
	return createHealth(fileBacking(join(stateDir, FILE)), opts.rng ?? Math.random);
}

/**
 * The same state machine with no file at all, for a runtime that was given no state dir: it must touch no disk, so
 * its breaker lives and dies with the process (it still refuses repeat calls inside it).
 */
export function openMemoryJevHealth(opts: { rng?: () => number } = {}): JevHealth {
	return createHealth(memoryBacking(), opts.rng ?? Math.random);
}
