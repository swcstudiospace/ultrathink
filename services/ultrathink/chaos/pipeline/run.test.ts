// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { SelectedEngine } from "../../../../src/host/engine.ts";
import { makeTempDir } from "../../test.helpers.ts";
import { appendHistory, readHistory } from "../history.ts";
import type { RunResult } from "../run.ts";
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
});

describe("watchdog and the run's figures", () => {
	test("the budget is printed with the abort count and recorded in the history details", async () => {
		const { historyPath, stateRoot } = paths();
		const notes: string[] = [];

		const result = await runPipeline(tiny(), {
			historyPath,
			stateRoot,
			ompPrompts: 0,
			now: NOW,
			notes: (line) => notes.push(line),
		});

		expect(notes).toContain("watchdog budget 120000 ms, aborts 0");
		expect(
			notes.some((line) =>
				/^probe latency real \d+ ms baseline none ratio n\/a \(virtual \d+ ms\)$/.test(line),
			),
		).toBe(true);
		expect(result.details).toMatchObject({
			watchdogMs: 120000,
			planned: 2,
			skipped: 1,
			aborted: 0,
			"skipped:empty": 1,
		});
		expect(typeof result.details?.probeRealMs).toBe("number");
		const terminal = result.hypotheses.find((hypothesis) => hypothesis.id === "terminal");
		expect(terminal?.observed).toBe("3/3 terminal: 2 planned, 1 skipped (by design), 0 aborted");
	});

	test("the scenario's watchdogMs and the concurrency scaling set the budget", async () => {
		const a = paths();
		const b = paths();
		const notesA: string[] = [];
		const notesB: string[] = [];

		await runPipeline(tiny({ watchdogMs: 7000 }), {
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

		expect(notesA).toContain("watchdog budget 7000 ms, aborts 0");
		expect(notesB).toContain("watchdog budget 400000 ms, aborts 0");
	});

	test("a prompt an injected hang targets is aborted by the watchdog, counted and not a finding", async () => {
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

		expect(notes).toContain("watchdog budget 50 ms, aborts 1");
		expect(result.details).toMatchObject({ aborted: 1, planned: 1 });
		const terminal = result.hypotheses.find((hypothesis) => hypothesis.id === "terminal");
		expect(terminal?.passed).toBe(true);
		expect(terminal?.observed).toBe(
			"3/3 terminal: 1 planned, 1 skipped (by design), 1 aborted (1 allowed)",
		);
	});

	test("the recovery probe is compared on the real clock against a recorded real baseline", async () => {
		const { historyPath, stateRoot } = paths();
		appendHistory(historyPath, { ...record("nominal", 1, 0), details: { probeRealMs: 100 } });
		let tick = 0;
		const realNow = () => {
			tick += 1000;
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
		expect(recovery?.observed).toContain("baseline 100 ms ratio 10");
		expect(slow.details?.probeRealMs).toBe(1000);
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
		const records = [
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
