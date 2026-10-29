// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { isAbortError } from "../shared.ts";
import { abortableSleep } from "./sleep.ts";

/** Consecutive successes that win back one unit of the limit. */
const SUCCESSES_PER_STEP = 3;
/** Longest single cooldown nap, so a cooldown that grows while waiting is noticed. */
const COOLDOWN_HOP_MS = 1000;

interface Waiter {
	signal: AbortSignal | undefined;
	grant: () => void;
	fail: (error: unknown) => void;
}

/**
 * Per-flight concurrency limiter, additive increase and multiplicative decrease. A transient failure halves the limit
 * (floor 1) and may start a cooldown shared by every caller; three successes in a row give one unit back, up to `max`.
 * The limit never drops below one, and the cooldown comes from an already clamped `Retry-After`, so a flight always
 * progresses.
 */
export class FlightThrottle {
	readonly #max: number;
	readonly #now: () => number;
	readonly #sleep: typeof abortableSleep;
	readonly #queue: Waiter[] = [];
	#limit: number;
	#inflight = 0;
	#streak = 0;
	#cooldownUntil = 0;
	#draining = false;

	constructor(opts: { max: number; now?: () => number; sleep?: typeof abortableSleep }) {
		this.#max = Math.max(1, Math.floor(opts.max));
		this.#limit = this.#max;
		this.#now = opts.now ?? Date.now;
		this.#sleep = opts.sleep ?? abortableSleep;
	}

	get limit(): number {
		return this.#limit;
	}

	noteFailure(i?: { retryAfterMs?: number }): void {
		this.#limit = Math.max(1, Math.floor(this.#limit / 2));
		this.#streak = 0;
		if (i?.retryAfterMs !== undefined && i.retryAfterMs > 0) {
			this.#cooldownUntil = Math.max(this.#cooldownUntil, this.#now() + i.retryAfterMs);
		}
	}

	noteSuccess(): void {
		this.#streak += 1;
		if (this.#streak < SUCCESSES_PER_STEP) return;
		this.#streak = 0;
		this.#limit = Math.min(this.#max, this.#limit + 1);
		void this.#drain();
	}

	/** Waits FIFO for a free slot and for the cooldown; resolves to an idempotent release. Rejects `AbortError` on abort. */
	async acquire(signal?: AbortSignal): Promise<() => void> {
		// An aborted signal makes the one sleep that raises the kernel's AbortError reject, without arming a timer.
		if (signal?.aborted) await abortableSleep(0, signal);
		const { promise, resolve, reject } = Promise.withResolvers<() => void>();
		const waiter: Waiter = {
			signal,
			grant: () => {
				signal?.removeEventListener("abort", onAbort);
				this.#inflight += 1;
				let released = false;
				resolve(() => {
					if (released) return;
					released = true;
					this.#inflight -= 1;
					void this.#drain();
				});
			},
			fail: (error) => {
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		};
		const onAbort = (): void => {
			const at = this.#queue.indexOf(waiter);
			if (at >= 0) this.#queue.splice(at, 1);
			signal?.removeEventListener("abort", onAbort);
			// The signal is aborted, so this sleep rejects at once with the kernel's AbortError and arms no timer.
			abortableSleep(0, signal).catch(reject);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#queue.push(waiter);
		void this.#drain();
		return promise;
	}

	/** One loop at a time hands slots to the queue head in order, napping through a cooldown. Never rejects. */
	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			for (let head = this.#queue[0]; head; head = this.#queue[0]) {
				if (this.#inflight >= this.#limit) return;
				const remaining = this.#cooldownUntil - this.#now();
				if (remaining > 0) {
					try {
						await this.#sleep(Math.min(remaining, COOLDOWN_HOP_MS), head.signal);
					} catch (error) {
						// An aborted head leaves the queue now, so the next head takes over instead of this loop spinning on it.
						const aborted = isAbortError(error);
						if (this.#queue[0] === head) this.#queue.shift();
						if (!aborted) head.fail(error);
					}
					continue;
				}
				this.#queue.shift();
				head.grant();
			}
		} finally {
			this.#draining = false;
		}
	}
}
