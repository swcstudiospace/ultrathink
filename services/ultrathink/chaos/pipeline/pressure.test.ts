// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type Pressure, type PressureSpec, runPressureCommand, startPressure } from "./pressure.ts";

interface FakeWorker {
	messages: unknown[];
	terminated: boolean;
	postMessage(message: unknown): void;
	terminate(): Promise<number>;
}

function fakeWorker(): FakeWorker {
	const worker: FakeWorker = {
		messages: [],
		terminated: false,
		postMessage: (message) => {
			worker.messages.push(message);
		},
		terminate: async () => {
			worker.terminated = true;
			return 0;
		},
	};
	return worker;
}

/** A clock and a CPU meter the test moves by hand. */
function meters() {
	const state = { wall: 1000, user: 0, system: 0 };
	return {
		state,
		now: () => state.wall,
		cpuNow: () => ({ user: state.user, system: state.system }),
	};
}

describe("achieved", () => {
	test("is process CPU time over wall time since the helper started", async () => {
		const m = meters();
		const pressure = startPressure({ workers: 0 }, { now: m.now, cpuNow: m.cpuNow });

		m.state.wall = 1500;
		m.state.user = 200_000;
		m.state.system = 50_000;

		expect(pressure.achieved()).toMatchObject({
			cpuMs: 250,
			wallMs: 500,
			ratio: 0.5,
			stallMaxMs: 0,
		});
		await pressure.stop();
	});

	test("counts only the CPU used after the start", async () => {
		const m = meters();
		m.state.user = 9_000_000;
		const pressure = startPressure({ workers: 0 }, { now: m.now, cpuNow: m.cpuNow });

		m.state.wall = 2000;
		m.state.user = 9_100_000;

		expect(pressure.achieved()).toMatchObject({ cpuMs: 100, wallMs: 1000, ratio: 0.1 });
		await pressure.stop();
	});

	test("a zero wall time reads as ratio 0, never NaN", async () => {
		const m = meters();
		const pressure = startPressure({ workers: 0 }, { now: m.now, cpuNow: m.cpuNow });

		expect(pressure.achieved()).toEqual({ cpuMs: 0, wallMs: 0, ratio: 0, stallMaxMs: 0 });
		await pressure.stop();
	});

	test("a ratio above the worker count is reported as measured, not clamped", async () => {
		const m = meters();
		const pressure = startPressure({ workers: 0 }, { now: m.now, cpuNow: m.cpuNow });

		m.state.wall = 1100;
		m.state.user = 400_000;

		expect(pressure.achieved().ratio).toBe(4);
		await pressure.stop();
	});
});

describe("workers: 0", () => {
	test("is a no-op: no worker, no timer, no ballast, and stop resolves", async () => {
		const spawned: FakeWorker[] = [];
		const intervals: unknown[] = [];
		const pressure = startPressure(
			{ workers: 0, memMB: 0 },
			{
				spawnWorker: () => {
					const worker = fakeWorker();
					spawned.push(worker);
					return worker;
				},
				timers: {
					setInterval: () => {
						intervals.push(1);
						return 1;
					},
					clearInterval: () => undefined,
				},
			},
		);

		await pressure.stop();
		await pressure.stop();

		expect(spawned).toEqual([]);
		expect(intervals).toEqual([]);
	});
});

describe("workers", () => {
	test("each worker gets the duty, the deadline and the stop flag, and stop terminates them all once", async () => {
		const spawned: FakeWorker[] = [];
		const pressure = startPressure(
			{ workers: 3, duty: 0.5, maxMs: 777 },
			{
				spawnWorker: () => {
					const worker = fakeWorker();
					spawned.push(worker);
					return worker;
				},
				timers: { setInterval: () => 1, clearInterval: () => undefined },
			},
		);

		expect(spawned).toHaveLength(3);
		for (const worker of spawned) {
			expect(worker.messages).toHaveLength(1);
			expect(worker.messages[0]).toMatchObject({ duty: 0.5, maxMs: 777 });
		}
		await pressure.stop();
		await pressure.stop();

		expect(spawned.every((worker) => worker.terminated)).toBe(true);
		const flag = spawned[0]?.messages[0] as { sab: SharedArrayBuffer };
		expect(Atomics.load(new Int32Array(flag.sab), 1)).toBe(1);
	});

	test("the default duty is a full spin and the default deadline is 30 seconds", async () => {
		const spawned: FakeWorker[] = [];
		const pressure = startPressure(
			{ workers: 1 },
			{
				spawnWorker: () => {
					const worker = fakeWorker();
					spawned.push(worker);
					return worker;
				},
				timers: { setInterval: () => 1, clearInterval: () => undefined },
			},
		);

		expect(spawned[0]?.messages[0]).toMatchObject({ duty: 1, maxMs: 30_000 });
		await pressure.stop();
	});

	test("an out-of-range duty is clamped into 0..1", async () => {
		const spawned: FakeWorker[] = [];
		const pressure = startPressure(
			{ workers: 2, duty: 7 },
			{
				spawnWorker: () => {
					const worker = fakeWorker();
					spawned.push(worker);
					return worker;
				},
				timers: { setInterval: () => 1, clearInterval: () => undefined },
			},
		);

		expect(spawned[0]?.messages[0]).toMatchObject({ duty: 1 });
		await pressure.stop();
	});

	test("the event-loop stall sampler keeps the worst timer drift", async () => {
		const m = meters();
		const ticks: Array<() => void> = [];
		let cleared = false;
		const pressure = startPressure(
			{ workers: 1 },
			{
				now: m.now,
				cpuNow: m.cpuNow,
				spawnWorker: fakeWorker,
				timers: {
					setInterval: (tick) => {
						ticks.push(tick);
						return 1;
					},
					clearInterval: () => {
						cleared = true;
					},
				},
			},
		);

		m.state.wall += 10;
		ticks[0]?.();
		m.state.wall += 10 + 35;
		ticks[0]?.();
		m.state.wall += 10 + 5;
		ticks[0]?.();

		expect(pressure.achieved().stallMaxMs).toBe(35);
		await pressure.stop();
		expect(cleared).toBe(true);
	});

	test("the memory ballast is allocated and touched while pressure runs and released on stop", async () => {
		const pressure = startPressure({ workers: 0, memMB: 1 });
		const before = pressure.ballastBytes();

		await pressure.stop();

		expect(before).toBe(1024 * 1024);
		expect(pressure.ballastBytes()).toBe(0);
	});
});

describe("a short live run", () => {
	test("real workers at duty 0.5 burn CPU and stop cleanly", async () => {
		const pressure = startPressure({ workers: 1, duty: 0.5, maxMs: 100 });

		const reading = pressure.achieved();
		await pressure.stop();
		const after = pressure.achieved();

		expect(reading.wallMs).toBeGreaterThanOrEqual(0);
		expect(after.ratio).toBeGreaterThan(0);
		expect(after.cpuMs).toBeGreaterThan(0);
	});
});

describe("runPressureCommand", () => {
	function rig(ratio: number, options: { sleep?: (ms: number) => Promise<void> } = {}) {
		const events: string[] = [];
		const out: string[] = [];
		const err: string[] = [];
		const asked: PressureSpec[] = [];
		const start = (spec: PressureSpec): Pressure => {
			asked.push(spec);
			events.push("start");
			return {
				achieved: () => ({ cpuMs: ratio * 2000, wallMs: 2000, ratio, stallMaxMs: 0 }),
				stop: async () => {
					events.push("stop");
				},
				ballastBytes: () => 0,
			};
		};
		const deps = {
			startPressure: start,
			stdout: (text: string) => out.push(text),
			stderr: (text: string) => err.push(text),
			sleep:
				options.sleep ??
				(async (ms: number) => {
					events.push(`sleep ${ms}`);
				}),
		};
		return { deps, events, out: () => out.join(""), err: () => err.join(""), asked };
	}

	test("holds the pressure for the requested seconds on the injected sleep, stops it, prints the reading and exits 0", async () => {
		const r = rig(1.5);

		const code = await runPressureCommand({ workers: 4, seconds: 3, memoryMb: 64 }, r.deps);

		expect(code).toBe(0);
		expect(r.events).toEqual(["start", "sleep 3000", "stop"]);
		expect(r.asked).toHaveLength(1);
		expect(r.asked[0]).toMatchObject({ workers: 4, duty: 1, memMB: 64 });
		expect(r.asked[0]?.maxMs).toBeGreaterThan(3000);
		expect(r.out()).toBe("pressure held 3s: cpuMs 3000 wallMs 2000 ratio 1.5\n");
		expect(r.err()).toBe("");
	});

	test("an omitted memory ballast asks for none", async () => {
		const r = rig(1);

		await runPressureCommand({ workers: 1, seconds: 1 }, r.deps);

		expect(r.asked[0]?.memMB).toBe(0);
	});

	test("a ratio below the default floor of 0.5 exits 2 with pressure not applied, after the reading", async () => {
		const r = rig(0.2);

		const code = await runPressureCommand({ workers: 2, seconds: 5 }, r.deps);

		expect(code).toBe(2);
		expect(r.out()).toContain("ratio 0.2");
		expect(r.err()).toContain("pressure not applied");
		expect(r.err()).toContain("0.5");
		expect(r.events.at(-1)).toBe("stop");
	});

	test("the floor is configurable and a ratio exactly at it passes", async () => {
		const atFloor = rig(0.25);
		const under = rig(0.25);

		expect(await runPressureCommand({ workers: 1, seconds: 1, floor: 0.25 }, atFloor.deps)).toBe(0);
		expect(await runPressureCommand({ workers: 1, seconds: 1, floor: 0.3 }, under.deps)).toBe(2);
		expect(under.err()).toContain("0.3");
	});

	test("the helper is stopped even when the hold is interrupted, and the failure propagates", async () => {
		const r = rig(1, {
			sleep: async () => {
				throw new Error("hold interrupted");
			},
		});

		await expect(runPressureCommand({ workers: 1, seconds: 1 }, r.deps)).rejects.toThrow(
			"hold interrupted",
		);
		expect(r.events).toEqual(["start", "stop"]);
	});

	test("rejects workers or seconds out of range before starting anything", async () => {
		const r = rig(1);

		await expect(runPressureCommand({ workers: 0, seconds: 1 }, r.deps)).rejects.toThrow(
			RangeError,
		);
		await expect(runPressureCommand({ workers: 1, seconds: 0 }, r.deps)).rejects.toThrow(
			RangeError,
		);
		await expect(runPressureCommand({ workers: 1, seconds: 3601 }, r.deps)).rejects.toThrow(
			RangeError,
		);
		await expect(runPressureCommand({ workers: 1, seconds: 1, floor: -1 }, r.deps)).rejects.toThrow(
			RangeError,
		);
		expect(r.events).toEqual([]);
	});
});
