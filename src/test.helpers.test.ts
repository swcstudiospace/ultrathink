import { describe, expect, test } from "bun:test";
import { waitUntil } from "./test.helpers.ts";

/** A fake clock whose sleep advances time and records every requested interval. */
function fakeClock() {
	const sleeps: number[] = [];
	let at = 0;
	return {
		sleeps,
		now: () => at,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			at += ms;
		},
	};
}

describe("waitUntil", () => {
	test("resolves as soon as the predicate turns true", async () => {
		const clock = fakeClock();
		let calls = 0;
		await waitUntil(
			() => {
				calls += 1;
				return calls >= 3;
			},
			{ ...clock, intervalMs: 7, timeoutMs: 1000 },
		);
		expect(calls).toBe(3);
		expect(clock.sleeps).toEqual([7, 7]);
	});

	test("accepts an async predicate and resolves without sleeping when already true", async () => {
		const clock = fakeClock();
		await waitUntil(async () => true, { ...clock });
		expect(clock.sleeps).toEqual([]);
	});

	test("polls every 10 ms by default", async () => {
		const clock = fakeClock();
		let calls = 0;
		await waitUntil(() => ++calls > 2, { ...clock });
		expect(clock.sleeps).toEqual([10, 10]);
	});

	test("rejects after the timeout naming the predicate", async () => {
		const clock = fakeClock();
		const never = () => false;
		const error = await waitUntil(never, {
			...clock,
			intervalMs: 10,
			timeoutMs: 35,
			name: "the marker file",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("the marker file");
		expect((error as Error).message).toContain("35");
	});

	test("names the predicate function when no name is given", async () => {
		const clock = fakeClock();
		function markerWritten() {
			return false;
		}
		const error = await waitUntil(markerWritten, { ...clock, timeoutMs: 20 }).catch(
			(caught: unknown) => caught,
		);
		expect((error as Error).message).toContain("markerWritten");
	});

	test("checks once more at the deadline so a late success is not lost", async () => {
		const clock = fakeClock();
		await waitUntil(() => clock.now() >= 30, { ...clock, intervalMs: 10, timeoutMs: 30 });
		expect(clock.now()).toBe(30);
	});
});
