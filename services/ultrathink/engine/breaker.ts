// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Upstream circuit breaker for the planner's model calls (Refs SPE-17437).
 *
 * Pure state machine, no I/O, no logging and no timers: time comes from the
 * injected `now` clock and every transition is reported through
 * `onTransition` so the integrator can wire logs and metrics.
 *
 * States:
 * - `closed`: calls flow. Every success and failure of the last `windowMs`
 *   is counted (an `ignored` outcome is neither). The breaker opens on the
 *   failure that leaves the window with at least `failureThreshold` failures
 *   AND at least `minCalls` calls (default `min(10, failureThreshold)`, so a
 *   streak of `failureThreshold` failures always opens it) AND a failure rate
 *   of at least `failureRate`, so a few failures among many successes never
 *   open it. A success resets the
 *   consecutive-failure count.
 * - `open`: `tryAcquire` refuses with the remaining `retryAfterMs` until
 *   `openMs` has elapsed since `openedAt`; the first `tryAcquire` after that
 *   moves to `half_open` and hands out a probe slot.
 * - `half_open`: at most `halfOpenMaxCalls` probes in flight; extra callers
 *   are refused with `retryAfterMs = HALF_OPEN_RETRY_MS` so they back off
 *   briefly instead of hammering. A probe released with `success` closes the
 *   breaker and resets both counters and the window; `failure` re-opens it
 *   with a fresh `openedAt`; `ignored` only frees the slot.
 *
 * `peek()` answers what `tryAcquire` would answer without taking a probe or
 * moving the state, so a caller can refuse work before it creates anything.
 *
 * `state()` and `snapshot()` are pure reads of the stored state: an open
 * breaker whose `openMs` has elapsed still reports `open` until a caller asks
 * for a probe slot via `tryAcquire`, which is the only place the
 * open -> half_open transition happens (so `onTransition` fires exactly once,
 * for the request that gets the probe).
 *
 * Fail-open semantics belong to the caller: this module only refuses slots.
 * The planner maps a refusal to `upstream_unavailable` and the service keeps
 * serving every non-planning tool while the upstream is cut off. Nothing here
 * throws after construction; `onTransition` exceptions are swallowed.
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
	/** Failures inside the window below which the breaker never opens; `>= 1`. */
	failureThreshold: number;
	/** Rolling window of counted calls while closed, in ms. */
	windowMs: number;
	/** Time the breaker stays open before allowing a probe, in ms. */
	openMs: number;
	/** Probes allowed in flight while half-open; default 1. */
	halfOpenMaxCalls?: number;
	/** Calls the window must hold before its failure rate counts; default the smaller of 10 and `failureThreshold`. */
	minCalls?: number;
	/** Share of the window's calls that failed, `0..1`, at which the breaker opens; default 0.5. */
	failureRate?: number;
	/** Clock in ms; default `Date.now`. */
	now?: () => number;
	/** Called after each state change, in order; a throwing hook is ignored. */
	onTransition?: (from: BreakerState, to: BreakerState) => void;
}

/** Result of one `release` on an acquired slot. */
export type ReleaseOutcome = "success" | "failure" | "ignored";

export type Acquire =
	| { ok: true; release: (outcome: ReleaseOutcome) => void }
	| { ok: false; state: "open"; retryAfterMs: number };

interface CircuitBreakerSnapshot {
	state: BreakerState;
	/**
	 * Failures in the current window while closed; frozen at the count that
	 * opened the breaker while open/half-open (a failed probe adds one); 0
	 * after a successful probe closes it.
	 */
	failures: number;
	/** Failures since the last success; 0 after a success and after a probe closes the breaker. */
	consecutiveFailures: number;
	/** Clock value of the last close -> open or half_open -> open transition. */
	openedAt?: number;
	/** State transitions since construction. */
	transitions: number;
}

export interface CircuitBreaker {
	state(): BreakerState;
	/** Never throws. Call `release` exactly once per `{ ok: true }` result; extra calls are no-ops. */
	tryAcquire(): Acquire;
	/** What `tryAcquire` would answer now, without taking a probe or moving the state. Never throws. */
	peek(): { ok: true } | { ok: false; retryAfterMs: number };
	/** Counters for metrics. */
	snapshot(): CircuitBreakerSnapshot;
}

/** `retryAfterMs` handed to callers refused because every half-open probe slot is taken. */
export const HALF_OPEN_RETRY_MS = 1000;
const DEFAULT_MIN_CALLS = 10;
const DEFAULT_FAILURE_RATE = 0.5;

function requirePositiveInteger(name: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`circuit breaker: ${name} must be a positive safe integer`);
	}
	return value;
}

/** Build a breaker; throws `RangeError` on invalid options, never afterwards. */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
	const failureThreshold = requirePositiveInteger("failureThreshold", options.failureThreshold);
	const windowMs = requirePositiveInteger("windowMs", options.windowMs);
	const openMs = requirePositiveInteger("openMs", options.openMs);
	const halfOpenMaxCalls =
		options.halfOpenMaxCalls === undefined
			? 1
			: requirePositiveInteger("halfOpenMaxCalls", options.halfOpenMaxCalls);
	if (options.now !== undefined && typeof options.now !== "function") {
		throw new RangeError("circuit breaker: now must be a function");
	}
	if (options.onTransition !== undefined && typeof options.onTransition !== "function") {
		throw new RangeError("circuit breaker: onTransition must be a function");
	}
	// A streak of failures equal to the configured threshold must still open it, so the sample the rate needs is never
	// larger than the threshold.
	const minCalls =
		options.minCalls === undefined
			? Math.min(DEFAULT_MIN_CALLS, failureThreshold)
			: requirePositiveInteger("minCalls", options.minCalls);
	const failureRate = options.failureRate ?? DEFAULT_FAILURE_RATE;
	if (typeof failureRate !== "number" || !(failureRate >= 0 && failureRate <= 1)) {
		throw new RangeError("circuit breaker: failureRate must be a number from 0 to 1");
	}
	const now = options.now ?? Date.now;
	const onTransition = options.onTransition;

	let state: BreakerState = "closed";
	/** Counted calls inside the window, oldest first: when each ended and whether it failed. */
	let calls: Array<{ at: number; failed: boolean }> = [];
	let failures = 0;
	let consecutiveFailures = 0;
	let openedAt: number | undefined;
	let transitions = 0;
	/** Increments on every transition; stale probe releases compare against it. */
	let generation = 0;
	let inFlight = 0;

	function transition(to: BreakerState): void {
		const from = state;
		state = to;
		transitions += 1;
		generation += 1;
		inFlight = 0;
		if (onTransition !== undefined) {
			try {
				onTransition(from, to);
			} catch {
				// reason: Hooks must not affect the request path.
			}
		}
	}

	function open(t: number): void {
		openedAt = t;
		transition("open");
	}

	/** Drops the calls that left the window and recounts the failures that remain. */
	function trim(t: number): void {
		let keep = 0;
		while (keep < calls.length && t - (calls[keep] as { at: number }).at >= windowMs) keep += 1;
		if (keep > 0) calls = calls.slice(keep);
		failures = calls.reduce((count, call) => count + (call.failed ? 1 : 0), 0);
	}

	function recordClosedCall(t: number, failed: boolean): void {
		calls.push({ at: t, failed });
		consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
		trim(t);
		if (
			failed &&
			failures >= failureThreshold &&
			calls.length >= minCalls &&
			failures / calls.length >= failureRate
		) {
			open(t);
		}
	}

	function resetCounters(): void {
		calls = [];
		failures = 0;
		consecutiveFailures = 0;
	}

	function closedAcquire(): Acquire {
		const admitted = generation;
		let released = false;
		return {
			ok: true,
			release: (outcome) => {
				if (released) {
					return;
				}
				released = true;
				// A slot admitted before the last transition is stale: a result from before the breaker opened
				// and closed again must not count against the new healthy period.
				if (outcome !== "ignored" && state === "closed" && admitted === generation) {
					recordClosedCall(now(), outcome === "failure");
				}
			},
		};
	}

	function probeAcquire(): Acquire {
		const probeGeneration = generation;
		inFlight += 1;
		let released = false;
		return {
			ok: true,
			release: (outcome) => {
				if (released) {
					return;
				}
				released = true;
				if (probeGeneration !== generation) {
					// Another probe already moved the breaker on; this result is stale.
					return;
				}
				inFlight -= 1;
				if (outcome === "success") {
					resetCounters();
					transition("closed");
				} else if (outcome === "failure") {
					failures += 1;
					consecutiveFailures += 1;
					open(now());
				}
			},
		};
	}

	/** The open breaker's remaining wait, or undefined once `openMs` has elapsed (a probe may be let through). */
	function openWait(): number | undefined {
		const elapsed = now() - (openedAt as number);
		return elapsed < openMs ? Math.min(openMs, Math.max(1, openMs - elapsed)) : undefined;
	}

	return {
		state: () => state,
		peek: () => {
			if (state === "open") {
				const wait = openWait();
				return wait === undefined ? { ok: true } : { ok: false, retryAfterMs: wait };
			}
			if (state === "half_open" && inFlight >= halfOpenMaxCalls)
				return { ok: false, retryAfterMs: HALF_OPEN_RETRY_MS };
			return { ok: true };
		},
		tryAcquire: () => {
			if (state === "open") {
				const wait = openWait();
				if (wait !== undefined) return { ok: false, state: "open", retryAfterMs: wait };
				transition("half_open");
			}
			if (state === "half_open") {
				if (inFlight >= halfOpenMaxCalls) {
					return { ok: false, state: "open", retryAfterMs: HALF_OPEN_RETRY_MS };
				}
				return probeAcquire();
			}
			return closedAcquire();
		},
		snapshot: () => ({
			state,
			failures,
			consecutiveFailures,
			...(openedAt === undefined ? {} : { openedAt }),
			transitions,
		}),
	};
}
