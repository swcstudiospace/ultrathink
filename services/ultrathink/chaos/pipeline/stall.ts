// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/** What the monitor saw when it decided the run was stalled. */
export interface StallInfo {
	/** Real time the counters have not moved, at least the stall window. */
	windowMs: number;
	/** Prompts unfinished at the decision. */
	inflight: number;
	/** CPU the process used over the window, in ms. */
	cpuMs: number;
	/** Worst event-loop lag (a tick later than its interval) seen since the monitor started or last fired. */
	maxLagMs: number;
}

interface StallMonitorOptions {
	/** The window with no progress that makes a stall. */
	stallMs: number;
	/** Real time between samples. */
	sampleMs: number;
	now: () => number;
	/** Process CPU time (user plus system) in ms. */
	cpuMs: () => number;
	/** Prompts finished so far. */
	completed: () => number;
	/** Provider calls made so far. */
	calls: () => number;
	/** Prompts unfinished now. */
	inflight: () => number;
	onStall: (info: StallInfo) => void;
	timers: {
		setInterval(callback: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
}

interface Sample {
	at: number;
	cpuMs: number;
	completed: number;
	calls: number;
}

/** The share of the window the process must have used CPU for to count as progressing. */
const MIN_CPU_SHARE = 0.01;

/**
 * Detects a hang, not slowness. Every `sampleMs` it samples process CPU, finished prompts and provider calls. The run is
 * stalled when prompts are unfinished and, over the last `stallMs` or more, no prompt finished, no provider call was made
 * and the CPU advanced by less than 1 percent of the window. A host so loaded that the run crawls still burns CPU and
 * still finishes prompts, so it never trips this however long it takes. After a stall the window starts over.
 */
export function startStallMonitor(options: StallMonitorOptions): { stop: () => void } {
	const { stallMs, sampleMs, now } = options;
	let samples: Sample[] = [];
	let maxLagMs = 0;
	let last = now();
	const take = (): Sample => ({
		at: now(),
		cpuMs: options.cpuMs(),
		completed: options.completed(),
		calls: options.calls(),
	});
	samples.push(take());

	const tick = (): void => {
		const current = take();
		maxLagMs = Math.max(maxLagMs, current.at - last - sampleMs);
		last = current.at;
		samples.push(current);
		// The window start is the latest sample at least `stallMs` old; anything before it is no longer needed.
		let start = -1;
		for (let i = samples.length - 1; i >= 0; i -= 1) {
			if (current.at - (samples[i]?.at ?? current.at) >= stallMs) {
				start = i;
				break;
			}
		}
		if (start < 0) return;
		samples = samples.slice(start);
		const from = samples[0];
		const inflight = options.inflight();
		if (from === undefined || inflight === 0) return;
		const windowMs = current.at - from.at;
		const cpuMs = current.cpuMs - from.cpuMs;
		if (
			current.completed === from.completed &&
			current.calls === from.calls &&
			cpuMs < MIN_CPU_SHARE * windowMs
		) {
			options.onStall({ windowMs, inflight, cpuMs, maxLagMs });
			samples = [take()];
			maxLagMs = 0;
		}
	};

	const handle = options.timers.setInterval(tick, sampleMs);
	return { stop: () => options.timers.clearInterval(handle) };
}
