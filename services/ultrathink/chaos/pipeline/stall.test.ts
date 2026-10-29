// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type StallInfo, startStallMonitor } from "./stall.ts";

/** A monitor on a clock, a CPU meter and counters the test moves by hand; `advance` is one sample interval. */
function rig(options: { stallMs?: number; sampleMs?: number } = {}) {
	const state = { at: 0, cpuMs: 0, completed: 0, calls: 0, inflight: 3 };
	const stalls: StallInfo[] = [];
	let tick: (() => void) | undefined;
	let cleared = false;
	const sampleMs = options.sampleMs ?? 5000;
	const monitor = startStallMonitor({
		stallMs: options.stallMs ?? 60_000,
		sampleMs,
		now: () => state.at,
		cpuMs: () => state.cpuMs,
		completed: () => state.completed,
		calls: () => state.calls,
		inflight: () => state.inflight,
		onStall: (info) => stalls.push(info),
		timers: {
			setInterval: (callback) => {
				tick = callback;
				return 1;
			},
			clearInterval: () => {
				cleared = true;
			},
		},
	});
	/** One interval later; `cpuShare` is the CPU the process used, as a share of the interval. */
	const advance = (cpuShare = 0, apply?: () => void): void => {
		state.at += sampleMs;
		state.cpuMs += cpuShare * sampleMs;
		apply?.();
		tick?.();
	};
	return { state, stalls, advance, monitor, cleared: () => cleared };
}

describe("a stall", () => {
	test("is declared once nothing finished, no call was made and the CPU stayed idle for the whole window", () => {
		const r = rig();

		for (let i = 0; i < 11; i += 1) r.advance();
		expect(r.stalls).toEqual([]);
		r.advance();

		expect(r.stalls).toHaveLength(1);
		expect(r.stalls[0]).toMatchObject({ windowMs: 60_000, inflight: 3, cpuMs: 0, maxLagMs: 0 });
	});

	test("starts its window over after it fires, so the next one needs a full window again", () => {
		const r = rig();
		for (let i = 0; i < 12; i += 1) r.advance();

		for (let i = 0; i < 11; i += 1) r.advance();
		expect(r.stalls).toHaveLength(1);
		r.advance();

		expect(r.stalls).toHaveLength(2);
	});

	test("needs unfinished prompts: an idle run with nothing in flight is not stalled", () => {
		const r = rig();
		r.state.inflight = 0;

		for (let i = 0; i < 30; i += 1) r.advance();

		expect(r.stalls).toEqual([]);
	});

	test("a finished prompt anywhere in the window resets it", () => {
		const r = rig();
		for (let i = 0; i < 10; i += 1) r.advance();

		r.advance(0, () => {
			r.state.completed += 1;
		});
		for (let i = 0; i < 11; i += 1) r.advance();
		expect(r.stalls).toEqual([]);
		r.advance();

		expect(r.stalls).toHaveLength(1);
	});

	test("a provider call anywhere in the window resets it", () => {
		const r = rig();
		for (let i = 0; i < 10; i += 1) r.advance();

		r.advance(0, () => {
			r.state.calls += 1;
		});
		for (let i = 0; i < 11; i += 1) r.advance();

		expect(r.stalls).toEqual([]);
	});

	test("the stall window and sample interval are the caller's", () => {
		const r = rig({ stallMs: 3000, sampleMs: 1000 });

		r.advance();
		r.advance();
		expect(r.stalls).toEqual([]);
		r.advance();

		expect(r.stalls).toHaveLength(1);
		expect(r.stalls[0]?.windowMs).toBe(3000);
	});

	test("records the worst event-loop lag: a tick later than its interval", () => {
		const r = rig({ stallMs: 5000, sampleMs: 1000 });
		r.state.at += 4000;

		r.advance();
		for (let i = 0; i < 5; i += 1) r.advance();

		expect(r.stalls[0]?.maxLagMs).toBe(4000);
	});
});

describe("a slow but progressing host", () => {
	test("never trips it, however long the run takes, while the CPU keeps advancing", () => {
		const r = rig();

		// Ten times the window, with the process getting only 2 percent of one CPU and no prompt finishing.
		for (let i = 0; i < 120; i += 1) r.advance(0.02);

		expect(r.stalls).toEqual([]);
	});

	test("a starved clock does not trip it: ticks arrive late but the CPU advanced in proportion", () => {
		const r = rig({ stallMs: 60_000, sampleMs: 5000 });

		for (let i = 0; i < 40; i += 1) {
			// The loop is starved: each sample comes 25 s late, and the process still used 5 percent of that time.
			r.state.at += 20_000;
			r.advance(0.25);
		}

		expect(r.stalls).toEqual([]);
	});

	test("trips below 1 percent of the window and not at 2 percent", () => {
		const under = rig();
		const at = rig();

		for (let i = 0; i < 24; i += 1) {
			under.advance(0.0099);
			at.advance(0.02);
		}

		expect(under.stalls.length).toBeGreaterThan(0);
		expect(at.stalls).toEqual([]);
	});

	test("CPU that stops advancing later is still caught after a full idle window", () => {
		const r = rig();
		for (let i = 0; i < 30; i += 1) r.advance(0.5);
		expect(r.stalls).toEqual([]);

		for (let i = 0; i < 13; i += 1) r.advance(0);

		expect(r.stalls).toHaveLength(1);
	});
});

describe("stop", () => {
	test("clears the interval", () => {
		const r = rig();

		r.monitor.stop();

		expect(r.cleared()).toBe(true);
	});
});
