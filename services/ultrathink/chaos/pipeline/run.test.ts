// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeCompleter } from "../../../../src/claude/complete.ts";
import type { SelectedEngine } from "../../../../src/host/engine.ts";
import { makeTempDir } from "../../test.helpers.ts";
import { appendHistory, readHistory } from "../history.ts";
import type { HistoryRecord, RunResult } from "../run.ts";
import { createScriptedProvider } from "./provider.ts";
import type { Pressure } from "./pressure.ts";
import { baselineFromHistory, heapSlopeKiBPerPrompt, runPipeline } from "./run.ts";
import { INVARIANT_IDS, type Scenario } from "./scenario.ts";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tiny(overrides: Partial<Scenario> = {}): Scenario {
	return {
		id: "tiny-run",
		title: "tiny",
		failureMode: "pipeline-load",
		seed: 9,
		prompts: {
			count: 3,
			concurrency: 2,
			corpus: ["add a retry wrapper to the http client", "", "scaffold a new cli command"],
		},
		faults: [],
		pressure: { cpuWorkers: 0, duty: 0, memMB: 0 },
		config: {},
		invariants: [...INVARIANT_IDS],
		...overrides,
	};
}

function paths() {
	const dir = makeTempDir("pipeline-run-", roots);
	return { historyPath: join(dir, "history.jsonl"), stateRoot: join(dir, "state") };
}

const NOW = () => new Date("2026-10-29T00:00:00.000Z");

function record(
	templateId: string,
	seq: number,
	recoveryMs: number | undefined,
	driver: RunResult["driver"] = "pipeline",
) {
	return {
		templateId,
		driver,
		startedAt: "2026-10-29T00:00:00.000Z",
		finishedAt: "2026-10-29T00:00:01.000Z",
		settled: "not_configured" as const,
		hypotheses:
			recoveryMs === undefined
				? [{ id: "terminal", passed: true, observed: "1/1" }]
				: [{ id: "recovery", passed: true, observed: recoveryMs }],
		passed: true,
		score: 100,
		rollback: "skipped:not_requested" as const,
		seq,
	};
}

function stubEngine(): SelectedEngine {
	const inner = createScriptedProvider([]);
	return {
		label: "chaos:stub",
		complete: inner.complete,
		error: () => undefined,
		resolution: {
			version: "1.0.0",
			state: "detected",
			host: "omp",
			source: "ctx.model",
			reason: "live-model",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			modelKnown: true,
			label: "chaos:stub [detected]",
		} as unknown as SelectedEngine["resolution"],
	};
}

describe("runPipeline", () => {
	test("a clean tiny run scores 100, records pipeline history and stays on the mock provider without the flag", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 1,
			now: NOW,
			notes: (line) => notes.push(line),
			real: { requested: false, envFlag: "1", maxCalls: 40 },
		});

		expect(result).toMatchObject({
			templateId: "tiny-run",
			driver: "pipeline",
			settled: "not_configured",
			passed: true,
			score: 100,
			rollback: "skipped:not_requested",
			seq: 1,
			startedAt: "2026-10-29T00:00:00.000Z",
			finishedAt: "2026-10-29T00:00:00.000Z",
		});
		expect(result.hypotheses.map((hypothesis) => hypothesis.id)).toEqual([...INVARIANT_IDS]);
		expect(result.hypotheses.every((hypothesis) => hypothesis.passed)).toBe(true);
		const history = readHistory(historyPath);
		expect(history.skipped).toBe(0);
		expect(history.records).toHaveLength(1);
		expect(history.records[0]?.templateId).toBe("tiny-run");
		expect(notes.some((line) => line.includes("calls made"))).toBe(false);
	});

	test("a leaking provider scores below 100 and the failing hypothesis names the leak", async () => {
		const { historyPath, stateRoot } = paths();
		const leak =
			"<node><rationale>\n1. a\n2. b\n3. c\n4. d\n5. e\n</rationale><conclusion>leak pl-9-000009 here</conclusion></node>";

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			providerRules: [
				{ stage: "fill", promptId: 0, effect: { kind: "garbage", text: leak }, count: "forever" },
			],
		});

		expect(result.passed).toBe(false);
		expect(result.score).toBeLessThan(100);
		const failed = result.hypotheses.filter((hypothesis) => !hypothesis.passed);
		// A scripted reply that is a valid fill by shape but not from an ok call is also a fill the oracle cannot vouch for.
		expect(failed.map((hypothesis) => hypothesis.id)).toEqual(["degraded", "isolation"]);
		expect(failed.find((hypothesis) => hypothesis.id === "isolation")?.reason).toContain(
			"pl-9-000009",
		);
		expect(readHistory(historyPath).records[0]?.score).toBe(result.score);
	});

	test("the scenario's own faults apply and the run still scores 100 when the pipeline degrades honestly", async () => {
		const { historyPath, stateRoot } = paths();
		const scenario = tiny({
			faults: [
				{
					stage: "fill",
					promptId: 0,
					effect: { kind: "error", status: 429, retryAfterSec: 1 },
					count: "forever",
				},
			],
		});

		const result = await runPipeline(scenario, { historyPath, stateRoot, ompPrompts: 0, now: NOW });

		expect(result.score).toBe(100);
	});
});

describe("pressure", () => {
	function stubPressure(ratio: number): {
		start: () => Pressure;
		stopped: () => boolean;
		spec: () => unknown;
	} {
		let stopped = false;
		let spec: unknown;
		return {
			start: () => ({
				achieved: () => ({ cpuMs: ratio * 1000, wallMs: 1000, ratio, stallMaxMs: 0 }),
				stop: async () => {
					stopped = true;
				},
				ballastBytes: () => 0,
			}),
			stopped: () => stopped,
			spec: () => spec,
		};
	}

	test("achieved pressure at or above the floor adds a passing hypothesis and the helper is stopped", async () => {
		const { historyPath, stateRoot } = paths();
		const stub = stubPressure(2);
		let asked: unknown;

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			pressure: true,
			startPressure: (spec) => {
				asked = spec;
				return stub.start();
			},
		});

		const pressure = result.hypotheses.at(-1);
		expect(pressure).toMatchObject({ id: "pressure", passed: true, observed: 2 });
		expect(result.score).toBe(100);
		expect(stub.stopped()).toBe(true);
		expect(asked).toMatchObject({ duty: 1 });
		expect((asked as { workers: number }).workers).toBeGreaterThan(0);
	});

	test("pressure below the floor fails the run with pressure-not-applied", async () => {
		const { historyPath, stateRoot } = paths();
		const stub = stubPressure(0.1);

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			pressure: true,
			pressureFloor: 0.5,
			startPressure: () => stub.start(),
		});

		const pressure = result.hypotheses.at(-1);
		expect(pressure?.id).toBe("pressure");
		expect(pressure?.passed).toBe(false);
		expect(pressure?.reason).toContain("pressure-not-applied");
		expect(result.passed).toBe(false);
		expect(result.score).toBeLessThan(100);
		expect(stub.stopped()).toBe(true);
	});

	test("the scenario's own pressure settings are what is asked for", async () => {
		const { historyPath, stateRoot } = paths();
		const stub = stubPressure(5);
		let asked: unknown;

		await runPipeline(tiny({ pressure: { cpuWorkers: 3, duty: 0.25, memMB: 8 } }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			pressure: true,
			startPressure: (spec) => {
				asked = spec;
				return stub.start();
			},
		});

		expect(asked).toMatchObject({ workers: 3, duty: 0.25, memMB: 8 });
	});

	test("no pressure is started unless it is asked for", async () => {
		const { historyPath, stateRoot } = paths();
		let started = false;

		const result = await runPipeline(tiny({ pressure: { cpuWorkers: 3, duty: 1, memMB: 0 } }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			startPressure: () => {
				started = true;
				return stubPressure(9).start();
			},
		});

		expect(started).toBe(false);
		expect(result.hypotheses.some((hypothesis) => hypothesis.id === "pressure")).toBe(false);
	});
});

describe("the real-provider guard", () => {
	test("--provider real without the environment flag is refused before anything runs", async () => {
		const { historyPath, stateRoot } = paths();

		await expect(
			runPipeline(tiny(), {
				historyPath,
				stateRoot,
				real: { requested: true, envFlag: undefined, maxCalls: 40 },
				engineSelector: async () => {
					throw new Error("the engine must not be selected");
				},
			}),
		).rejects.toThrow("ULTRATHINK_CHAOS_REAL=1");
		expect(readHistory(historyPath).records).toHaveLength(0);
	});

	test("anything but the exact value 1 is refused", async () => {
		const { historyPath, stateRoot } = paths();

		for (const envFlag of ["", "0", "true", "yes"]) {
			await expect(
				runPipeline(tiny(), {
					historyPath,
					stateRoot,
					real: { requested: true, envFlag, maxCalls: 40 },
				}),
			).rejects.toThrow("ULTRATHINK_CHAOS_REAL=1");
		}
	});

	test("the stress and spike scenarios are refused even with both gates", async () => {
		const { historyPath, stateRoot } = paths();

		for (const id of ["stress", "spike"]) {
			await expect(
				runPipeline(tiny({ id }), {
					historyPath,
					stateRoot,
					real: { requested: true, envFlag: "1", maxCalls: 40 },
					engineSelector: async () => stubEngine(),
				}),
			).rejects.toThrow(`refuses the ${id} scenario`);
		}
	});

	test("a stub engine serves the run, the cap stops it and the calls made are reported", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];
		let selections = 0;

		const result = await runPipeline(
			tiny({ prompts: { count: 4, concurrency: 1, corpus: ["add a widget"] } }),
			{
				historyPath,
				stateRoot,
				now: NOW,
				notes: (line) => notes.push(line),
				real: { requested: true, envFlag: "1", maxCalls: 9 },
				engineSelector: async () => {
					selections += 1;
					return stubEngine();
				},
			},
		);

		expect(selections).toBeGreaterThan(0);
		expect(notes).toContain("calls made: 9 (cap 9, reached)");
		// The probe could not run after the cap, so recovery is not judged; every other invariant is.
		expect(result.hypotheses.map((hypothesis) => hypothesis.id)).not.toContain("recovery");
		expect(result.hypotheses.length).toBe(INVARIANT_IDS.length - 1);
		expect(readHistory(historyPath).records).toHaveLength(1);
	});

	test("under the cap the run reports how many calls it made and keeps the probe", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];

		const result = await runPipeline(
			tiny({ prompts: { count: 1, concurrency: 1, corpus: ["add a widget"] } }),
			{
				historyPath,
				stateRoot,
				now: NOW,
				notes: (line) => notes.push(line),
				real: { requested: true, envFlag: "1", maxCalls: 100 },
				engineSelector: async () => stubEngine(),
			},
		);

		expect(notes.some((line) => /^calls made: \d+ \(cap 100\)$/.test(line))).toBe(true);
		expect(result.hypotheses.map((hypothesis) => hypothesis.id)).toContain("recovery");
	});

	test("retries inside one engine call never send more real requests than the cap", async () => {
		const { historyPath, stateRoot } = paths();
		const bin = join(makeTempDir("pipeline-run-bin-", roots), "bin");
		mkdirSync(bin, { recursive: true });
		const log = join(bin, "runs.log");
		writeFileSync(log, "");
		// A `claude` that fails transiently on every run: the real completer retries it up to three times per call.
		writeFileSync(
			join(bin, "claude"),
			`#!/bin/sh\nprintf x >> ${JSON.stringify(log)}\necho "upstream overloaded" >&2\nexit 1\n`,
		);
		chmodSync(join(bin, "claude"), 0o755);
		const previousPath = process.env.PATH;
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		try {
			const notes: string[] = [];
			await runPipeline(tiny({ prompts: { count: 2, concurrency: 1, corpus: ["add a widget"] } }), {
				historyPath,
				stateRoot,
				now: NOW,
				notes: (line) => notes.push(line),
				real: { requested: true, envFlag: "1", maxCalls: 2 },
				engineSelector: async (config) => ({
					...stubEngine(),
					complete: createClaudeCompleter({
						bin: config.claude.bin,
						timeoutMs: 30_000,
						retrySeams: { sleep: async () => undefined, random: () => 0 },
					}),
				}),
			});
			expect(readFileSync(log, "utf8").length).toBeLessThanOrEqual(2);
			expect(notes.some((line) => /^calls made: \d+ \(cap 2(, reached)?\)$/.test(line))).toBe(true);
		} finally {
			process.env.PATH = previousPath;
		}
	}, 120_000);
});

/** Hand-driven stall sampler: `advance` moves its clock one sample and runs the registered tick. */
function stallRig(sampleMs = 1000) {
	const state = { at: 0, cpuMs: 0 };
	let tick: (() => void) | undefined;
	return {
		seams: {
			sampleMs,
			stallNow: () => state.at,
			cpuMs: () => state.cpuMs,
			intervalTimers: {
				setInterval: (callback: () => void) => {
					tick = callback;
					return 1;
				},
				clearInterval: () => undefined,
			},
		},
		advance: (cpuShare = 0) => {
			state.at += sampleMs;
			state.cpuMs += cpuShare * sampleMs;
			tick?.();
		},
	};
}

function macrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 2);
	return promise;
}

describe("the stall watchdog and the run's figures", () => {
	test("the budgets are printed with the abort counts and recorded in the history details", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			notes: (line) => notes.push(line),
		});

		expect(notes).toContain(
			"stall watchdog 60000 ms, ceiling 900000 ms, stall aborts 0, ceiling aborts 0",
		);
		expect(
			notes.some((line) =>
				/^probe latency real median \d+ ms of 5 \(min \d+, max \d+\) baseline none ratio n\/a bound n\/a$/.test(
					line,
				),
			),
		).toBe(true);
		expect(result.details).toMatchObject({
			stallMs: 60000,
			watchdogMs: 900000,
			stallAborts: 0,
			ceilingAborts: 0,
			planned: 2,
			skipped: 1,
			aborted: 0,
			"skipped:empty": 1,
		});
		expect(typeof result.details?.probeRealMs).toBe("number");
		const terminal = result.hypotheses.find((hypothesis) => hypothesis.id === "terminal");
		expect(terminal?.observed).toBe(
			"3/3 terminal: 2 planned, 1 skipped (by design), 0 aborted, stall aborts 0, ceiling aborts 0",
		);
		expect(typeof result.details?.loadAvg1).toBe("number");
	});

	test("the scenario's stallMs and watchdogMs and the concurrency scaling set the budgets", async () => {
		const a = paths();
		const b = paths();
		const notesA: string[] = [];
		const notesB: string[] = [];

		await runPipeline(tiny({ watchdogMs: 7000, stallMs: 4000 }), {
			historyPath: a.historyPath,
			stateRoot: a.stateRoot,
			ompPrompts: 0,
			notes: (line) => notesA.push(line),
		});
		await runPipeline(tiny({ prompts: { count: 2, concurrency: 100, corpus: ["add a widget"] } }), {
			historyPath: b.historyPath,
			stateRoot: b.stateRoot,
			ompPrompts: 0,
			notes: (line) => notesB.push(line),
		});

		expect(notesA).toContain(
			"stall watchdog 4000 ms, ceiling 7000 ms, stall aborts 0, ceiling aborts 0",
		);
		expect(notesB).toContain(
			"stall watchdog 60000 ms, ceiling 900000 ms, stall aborts 0, ceiling aborts 0",
		);
	});

	test("the ceiling scales with concurrency above 112 slots: 8 s per slot", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];

		await runPipeline(tiny({ prompts: { count: 2, concurrency: 128, corpus: ["add a widget"] } }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			notes: (line) => notes.push(line),
		});

		expect(notes).toContain(
			"stall watchdog 60000 ms, ceiling 1024000 ms, stall aborts 0, ceiling aborts 0",
		);
	});

	test("a prompt blocked on an injected hang with no CPU progress is aborted as stalled and passes the oracle", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];
		const rig = stallRig();

		const running = runPipeline(tiny({ stallMs: 3000 }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			...rig.seams,
			notes: (line) => notes.push(line),
			providerRules: [{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" }],
		});
		let done = false;
		void running.finally(() => {
			done = true;
		});
		for (let i = 0; i < 60 && !done; i += 1) {
			await macrotask();
			rig.advance(0);
		}
		const result = await running;

		expect(notes).toContain(
			"stall watchdog 3000 ms, ceiling 900000 ms, stall aborts 1, ceiling aborts 0",
		);
		expect(result.details).toMatchObject({
			aborted: 1,
			stallAborts: 1,
			ceilingAborts: 0,
			planned: 1,
		});
		const terminal = result.hypotheses.find((hypothesis) => hypothesis.id === "terminal");
		expect(terminal?.passed).toBe(true);
		expect(terminal?.observed).toBe(
			"3/3 terminal: 1 planned, 1 skipped (by design), 1 aborted (1 allowed), stall aborts 1, ceiling aborts 0",
		);
		expect(result.passed).toBe(true);
	});

	test("a hang-targeted prompt whose CPU keeps advancing is not stalled; the ceiling still ends it and is counted", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];
		const rig = stallRig();

		const running = runPipeline(tiny({ stallMs: 3000 }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			watchdogMs: 80,
			...rig.seams,
			notes: (line) => notes.push(line),
			providerRules: [{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" }],
		});
		let done = false;
		void running.finally(() => {
			done = true;
		});
		for (let i = 0; i < 400 && !done; i += 1) {
			await macrotask();
			rig.advance(0.5);
		}
		const result = await running;

		expect(notes).toContain(
			"stall watchdog 3000 ms, ceiling 80 ms, stall aborts 0, ceiling aborts 1",
		);
		expect(result.details).toMatchObject({ aborted: 1, stallAborts: 0, ceilingAborts: 1 });
		expect(result.passed).toBe(true);
	});

	test("a prompt an injected hang targets is aborted by the ceiling, counted and not a finding", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			watchdogMs: 50,
			notes: (line) => notes.push(line),
			providerRules: [{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" }],
		});

		expect(notes).toContain(
			"stall watchdog 60000 ms, ceiling 50 ms, stall aborts 0, ceiling aborts 1",
		);
		expect(result.details).toMatchObject({ aborted: 1, planned: 1 });
		const terminal = result.hypotheses.find((hypothesis) => hypothesis.id === "terminal");
		expect(terminal?.passed).toBe(true);
		expect(terminal?.observed).toBe(
			"3/3 terminal: 1 planned, 1 skipped (by design), 1 aborted (1 allowed), stall aborts 0, ceiling aborts 1",
		);
	});

	test("the recovery probe is compared on the real clock against a recorded real baseline", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, { ...record("nominal", 1, 0), details: { probeRealMs: 100 } });
		let tick = 0;
		const realNow = () => {
			tick += 3000;
			return tick;
		};

		const slow = await runPipeline(tiny({ baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			realNow,
		});

		const recovery = slow.hypotheses.find((hypothesis) => hypothesis.id === "recovery");
		expect(recovery?.passed).toBe(false);
		expect(recovery?.reason).toContain("of real time");
		expect(recovery?.observed).toBe(
			"probe latency real median 3000 ms of 5 (min 3000, max 3000) baseline 100 ms ratio 30 bound 1000 ms",
		);
		expect(slow.details?.probeRealMs).toBe(3000);
		expect(slow.details?.probeRealMsAll).toEqual([3000, 3000, 3000, 3000, 3000]);
	});

	test("a baseline measured under a very different load is not compared on real time; the note says so and nothing fails on it", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, {
			...record("nominal", 1, 0),
			details: { probeRealMs: 100, loadAvg1: 2 },
		});
		let tick = 0;
		const notes: string[] = [];

		const result = await runPipeline(tiny({ baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			realNow: () => {
				tick += 1000;
				return tick;
			},
			loadAvg: () => 20,
			notes: (line) => notes.push(line),
		});

		expect(notes).toContain(
			"recovery latency comparison skipped: load differed (baseline 2, now 20)",
		);
		const recovery = result.hypotheses.find((hypothesis) => hypothesis.id === "recovery");
		expect(recovery?.passed).toBe(true);
		expect(recovery?.observed).toContain("baseline none ratio n/a");
		expect(result.details?.loadAvg1).toBe(20);
	});

	/** A real clock whose k-th prompt takes `durations[k]` ms: the batch prompt first, then the probes in order. */
	function scriptedClock(durations: number[]): () => number {
		let calls = 0;
		let time = 0;
		return () => {
			calls += 1;
			if (calls % 2 === 0) time += durations[calls / 2 - 1] ?? 0;
			return time;
		};
	}

	const ONE = { prompts: { count: 1, concurrency: 1, corpus: ["add a widget"] } };

	test("a single noisy probe among five does not fail the run: the median is what is compared and recorded", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, { ...record("nominal", 1, 0), details: { probeRealMs: 100 } });

		const result = await runPipeline(tiny({ ...ONE, baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			realNow: scriptedClock([100, 100, 900, 100, 100, 100]),
		});

		const recovery = result.hypotheses.find((hypothesis) => hypothesis.id === "recovery");
		expect(recovery?.passed).toBe(true);
		expect(recovery?.observed).toBe(
			"probe latency real median 100 ms of 5 (min 100, max 900) baseline 100 ms ratio 1 bound 1000 ms",
		);
		expect(result.details?.probeRealMs).toBe(100);
		expect(result.details?.probeRealMsAll).toEqual([100, 900, 100, 100, 100]);
		expect(result.passed).toBe(true);
	});

	test("a real regression (every probe 3x over the 1 s floor) fails the run", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, { ...record("nominal", 1, 0), details: { probeRealMs: 1000 } });

		const result = await runPipeline(tiny({ ...ONE, baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			realNow: scriptedClock([100, 3000, 3000, 3000, 3000, 3000]),
		});

		const recovery = result.hypotheses.find((hypothesis) => hypothesis.id === "recovery");
		expect(recovery?.passed).toBe(false);
		expect(recovery?.reason).toContain("probe median 3000 ms of real time");
		expect(recovery?.reason).toContain("over the bound 1500 ms");
		expect(result.passed).toBe(false);
	});

	test("a sub-second batch passes even when the baseline was 95 ms", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, { ...record("nominal", 1, 0), details: { probeRealMs: 95 } });

		const result = await runPipeline(tiny({ ...ONE, baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			realNow: scriptedClock([100, 800, 800, 800, 800, 800]),
		});

		expect(result.hypotheses.find((hypothesis) => hypothesis.id === "recovery")?.passed).toBe(true);
	});

	test("a baseline under a load within a factor of 2 is compared on real time", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, {
			...record("nominal", 1, 0),
			details: { probeRealMs: 100, loadAvg1: 10 },
		});
		let tick = 0;
		const notes: string[] = [];

		const result = await runPipeline(tiny({ baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			realNow: () => {
				tick += 3000;
				return tick;
			},
			loadAvg: () => 20,
			notes: (line) => notes.push(line),
		});

		expect(notes.some((line) => line.includes("comparison skipped"))).toBe(false);
		expect(result.hypotheses.find((hypothesis) => hypothesis.id === "recovery")?.passed).toBe(
			false,
		);
	});

	test("loads under 1 count as 1: an idle baseline and a quiet host are comparable", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, {
			...record("nominal", 1, 0),
			details: { probeRealMs: 100, loadAvg1: 0.1 },
		});
		const notes: string[] = [];

		await runPipeline(tiny({ baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			loadAvg: () => 1.9,
			notes: (line) => notes.push(line),
		});

		expect(notes.some((line) => line.includes("comparison skipped"))).toBe(false);
	});

	test("a record with the median and all five figures yields the median; one without probeRealMsAll (old) still yields a baseline", () => {
		const modern = {
			...record("nominal", 2, undefined),
			details: { probeRealMs: 120, probeRealMsAll: [80, 120, 90, 500, 130] },
		};
		const old = { ...record("nominal", 1, undefined), details: { probeRealMs: 95 } };

		expect(baselineFromHistory([modern], "nominal")).toEqual({ realMs: 120 });
		expect(baselineFromHistory([old], "nominal")).toEqual({ realMs: 95 });
		expect(baselineFromHistory([old, modern], "nominal")).toEqual({ realMs: 120 });
	});

	test("a recorded loadAvg1 is read back as part of the baseline", () => {
		const records = [
			{ ...record("nominal", 1, undefined), details: { probeRealMs: 90, loadAvg1: 12.5 } },
		];

		expect(baselineFromHistory(records, "nominal")).toEqual({ realMs: 90, loadAvg1: 12.5 });
	});
});

describe("heap tracing", () => {
	test("the slope is a least-squares fit in KiB per prompt, undefined below two samples", () => {
		const KIB = 1024;

		expect(heapSlopeKiBPerPrompt([])).toBeUndefined();
		expect(heapSlopeKiBPerPrompt([{ prompts: 100, heapUsedBytes: 5 }])).toBeUndefined();
		expect(
			heapSlopeKiBPerPrompt([
				{ prompts: 100, heapUsedBytes: 1000 * KIB },
				{ prompts: 200, heapUsedBytes: 1100 * KIB },
				{ prompts: 300, heapUsedBytes: 1200 * KIB },
			]),
		).toBeCloseTo(1, 6);
		expect(
			heapSlopeKiBPerPrompt([
				{ prompts: 100, heapUsedBytes: 7 * KIB },
				{ prompts: 200, heapUsedBytes: 7 * KIB },
			]),
		).toBe(0);
		expect(
			heapSlopeKiBPerPrompt([
				{ prompts: 100, heapUsedBytes: 7 },
				{ prompts: 100, heapUsedBytes: 9 },
			]),
		).toBeUndefined();
	});

	test("a traced run prints a sample line every traceEvery prompts and the fitted slope", async () => {
		const { historyPath, stateRoot } = paths();
		const lines: string[] = [];

		await runPipeline(tiny({ prompts: { count: 4, concurrency: 2, corpus: ["add a widget"] } }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			traceHeap: (line) => lines.push(line),
			traceEvery: 1,
		});

		const samples = lines.filter((line) =>
			/^heap prompts=\d+ heapUsed=[\d.]+ MiB rss=[\d.]+ MiB$/.test(line),
		);
		expect(samples.map((line) => line.split(" ")[1])).toEqual([
			"prompts=1",
			"prompts=2",
			"prompts=3",
			"prompts=4",
		]);
		expect(lines.at(-1)).toMatch(/^heap slope: -?[\d.]+ KiB\/prompt over 4 samples$/);
	});

	test("without traceHeap nothing is sampled", async () => {
		const { historyPath, stateRoot } = paths();

		const result = await runPipeline(tiny(), { historyPath, stateRoot, ompPrompts: 0, now: NOW });

		expect(result.passed).toBe(true);
	});
});

describe("baselineFromHistory", () => {
	test("is the recovery observation of the latest pipeline run of that scenario", () => {
		const records = [
			record("nominal", 1, 40),
			record("nominal", 3, 80),
			record("nominal", 2, 60),
			record("smoke", 4, 5),
			record("nominal", 5, undefined),
			record("nominal", 6, 7, "inprocess"),
		];

		expect(baselineFromHistory(records, "nominal")).toEqual({ virtualMs: 80 });
		expect(baselineFromHistory(records, "smoke")).toEqual({ virtualMs: 5 });
		expect(baselineFromHistory(records, "missing")).toBeUndefined();
	});

	test("the real-clock figure comes from the run's details and wins over the old numeric observation", () => {
		const records: HistoryRecord[] = [
			{ ...record("nominal", 1, 5), details: { probeRealMs: 90, probeVirtualMs: 3 } },
			{ ...record("nominal", 2, undefined), details: { probeRealMs: 120 } },
		];

		expect(baselineFromHistory(records, "nominal")).toEqual({ realMs: 120 });
		expect(baselineFromHistory(records.slice(0, 1), "nominal")).toEqual({
			realMs: 90,
			virtualMs: 3,
		});
	});

	test("a baseline that is not a finite number is ignored", () => {
		const bad = {
			...record("nominal", 1, 0),
			hypotheses: [{ id: "recovery", passed: true, observed: "fast" }],
		};

		expect(baselineFromHistory([bad], "nominal")).toBeUndefined();
	});

	test("a scenario with baselineOf reads the baseline from the history file it appends to", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, record("nominal", 1, 0));

		const result = await runPipeline(tiny({ baselineOf: "nominal" }), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
		});

		const recovery = result.hypotheses.find((hypothesis) => hypothesis.id === "recovery");
		expect(recovery?.passed).toBe(true);
		expect(readHistory(historyPath).records).toHaveLength(2);
	});
});
