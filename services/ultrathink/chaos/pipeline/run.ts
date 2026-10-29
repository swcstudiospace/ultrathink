// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { selectEngine } from "../../../../src/host/engine.ts";
import type { HostId } from "../../../../src/host/types.ts";
import { appendHistory, readHistory } from "../history.ts";
import type { HistoryRecord, RunResult } from "../run.ts";
import { scoreRun } from "../score.ts";
import { type DriveDeps, runProbe, runPrompts } from "./drive.ts";
import { checkInvariants, createJudge, snapshotResources } from "./oracle.ts";
import {
	type Pressure,
	type PressureSpec,
	startPressure as startRealPressure,
} from "./pressure.ts";
import { createScriptedProvider, createVirtualClock, type Rule } from "./provider.ts";
import type { Scenario } from "./scenario.ts";

interface PipelineDeps {
	historyPath: string;
	/** Faults added after the scenario's own. */
	providerRules?: Rule[];
	/** Start CPU and memory pressure for the run (CLI `--pressure`). */
	pressure?: boolean;
	/** The achieved CPU ratio the run needs to count its pressure as applied. Default 0.5. */
	pressureFloor?: number;
	/** Test seam; defaults to the real Bun-worker helper. */
	startPressure?: (spec: PressureSpec) => Pressure;
	/** The opt-in live engine: both `requested` (`--provider real`) and `envFlag === "1"` (ULTRATHINK_CHAOS_REAL) are needed. */
	real?: { requested: boolean; envFlag: string | undefined; maxCalls: number };
	/** Resolves the engine on the real path; defaults to `selectEngine`. */
	engineSelector?: typeof selectEngine;
	/** Host named to the selector on the real path. Default "claude-code": a CLI has no Omp runtime. */
	host?: HostId;
	/** Probe time of the baseline run; defaults to the latest recorded one of `scenario.baselineOf`. */
	baselineMs?: number;
	stateRoot?: string;
	/** Prompts that take the Omp planner path. Default: a quarter of the batch, at most 10. */
	ompPrompts?: number;
	/** Timestamps of the recorded run. Default: the wall clock. */
	now?: () => Date;
	/** Print `prompts, heapUsed, rss` after a forced full collection every `traceEvery` completed prompts, then the fitted slope. */
	traceHeap?: (line: string) => void;
	/** Prompts between heap samples. Default 100. */
	traceEvery?: number;
	/** One line of run information for the operator (calls made on the real path). */
	notes?: (line: string) => void;
}

/** Scenarios whose size would spend real credentials at load; the real path never runs them. */
const REFUSED_REAL = ["stress", "spike"];
const DEFAULT_PRESSURE_FLOOR = 0.5;
// The helper's workers stop themselves; a long scenario needs them to outlive the default 30 s.
const PRESSURE_MAX_MS = 15 * 60_000;
const MAX_OMP_PROMPTS = 10;

function guardReal(scenario: Scenario, real: PipelineDeps["real"]): void {
	if (!real?.requested) return;
	if (real.envFlag !== "1") {
		throw new Error(
			"--provider real needs ULTRATHINK_CHAOS_REAL=1 in the environment; no engine was called",
		);
	}
	if (REFUSED_REAL.includes(scenario.id)) {
		throw new Error(
			`--provider real refuses the ${scenario.id} scenario: it would spend credentials at load; no engine was called`,
		);
	}
}

/**
 * The recovery probe time of the latest recorded pipeline run of `id`: what a later run's probe is compared with. A
 * run that recorded none, or a non-numeric observation, is passed over.
 */
export function baselineFromHistory(records: HistoryRecord[], id: string): number | undefined {
	const runs = records
		.filter((record) => record.templateId === id && record.driver === "pipeline")
		.sort((a, b) => b.seq - a.seq);
	for (const run of runs) {
		const observed = run.hypotheses.find((hypothesis) => hypothesis.id === "recovery")?.observed;
		if (typeof observed === "number" && Number.isFinite(observed)) return observed;
	}
	return undefined;
}

interface HeapSample {
	prompts: number;
	heapUsedBytes: number;
}

/** Least-squares slope of the sampled heap against completed prompts, in KiB per prompt; undefined below two samples. */
export function heapSlopeKiBPerPrompt(samples: HeapSample[]): number | undefined {
	const n = samples.length;
	if (n < 2) return undefined;
	const meanX = samples.reduce((sum, sample) => sum + sample.prompts, 0) / n;
	const meanY = samples.reduce((sum, sample) => sum + sample.heapUsedBytes, 0) / n;
	let numerator = 0;
	let denominator = 0;
	for (const sample of samples) {
		numerator += (sample.prompts - meanX) * (sample.heapUsedBytes - meanY);
		denominator += (sample.prompts - meanX) ** 2;
	}
	return denominator === 0 ? undefined : numerator / denominator / 1024;
}

function mib(bytes: number): number {
	return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function pressureSpecOf(scenario: Scenario): PressureSpec {
	const { cpuWorkers, duty, memMB } = scenario.pressure;
	if (cpuWorkers > 0) return { workers: cpuWorkers, duty, memMB, maxMs: PRESSURE_MAX_MS };
	return { workers: availableParallelism(), duty: 1, memMB, maxMs: PRESSURE_MAX_MS };
}

/**
 * Runs one scenario: pressure (when asked), the concurrent drive through the real hook and Omp planner paths, a probe
 * after the load, the ten-invariant oracle, then the existing scoring and history. A pressure that was asked for but not
 * achieved fails the run with `pressure-not-applied`: the host's real figure counts, not the request.
 */
export async function runPipeline(scenario: Scenario, deps: PipelineDeps): Promise<HistoryRecord> {
	guardReal(scenario, deps.real);
	const real = deps.real?.requested === true;
	const wallNow = deps.now ?? (() => new Date());
	const startedAt = wallNow().toISOString();
	const ownRoot = deps.stateRoot === undefined;
	const stateRoot = deps.stateRoot ?? mkdtempSync(join(tmpdir(), "chaos-pipeline-"));
	const clock = createVirtualClock();
	const config = scenario.config;
	const nodeRange: [number, number] = [config.thinkMinNodes ?? 5, config.thinkMaxNodes ?? 8];
	const provider = createScriptedProvider([...scenario.faults, ...(deps.providerRules ?? [])], {
		sleep: clock.sleep,
		now: clock.now,
		seed: scenario.seed,
		nodeRange,
		...(real && deps.real ? { maxCalls: deps.real.maxCalls } : {}),
	});
	const judge = createJudge({
		minNodes: nodeRange[0],
		maxNodes: nodeRange[1],
		...(real ? { real } : {}),
	});
	const samples: HeapSample[] = [];
	const traceEvery = deps.traceEvery ?? 100;
	const engineSelector = real ? (deps.engineSelector ?? selectEngine) : undefined;
	const drive: DriveDeps = {
		provider,
		sleep: clock.sleep,
		now: clock.now,
		stateRoot,
		ompPrompts: deps.ompPrompts ?? Math.min(MAX_OMP_PROMPTS, Math.ceil(scenario.prompts.count / 4)),
		// Each prompt is judged as it completes and then reduced to its verdict, so the run holds no records to the end.
		judge,
		compact: true,
		...(deps.traceHeap
			? {
					onPromptDone: (completed: number) => {
						if (completed % traceEvery !== 0) return;
						Bun.gc(true);
						const memory = process.memoryUsage();
						samples.push({ prompts: completed, heapUsedBytes: memory.heapUsed });
						deps.traceHeap?.(
							`heap prompts=${completed} heapUsed=${mib(memory.heapUsed)} MiB rss=${mib(memory.rss)} MiB`,
						);
					},
				}
			: {}),
		...(engineSelector ? { engineSelector, host: deps.host ?? "claude-code" } : {}),
	};

	const pressure = deps.pressure
		? (deps.startPressure ?? startRealPressure)(pressureSpecOf(scenario))
		: undefined;
	try {
		const baseline = snapshotResources(stateRoot);
		const report = await runPrompts(scenario, drive);
		const achieved = pressure?.achieved();
		const slope = heapSlopeKiBPerPrompt(samples);
		if (slope !== undefined) {
			deps.traceHeap?.(
				`heap slope: ${Math.round(slope * 100) / 100} KiB/prompt over ${samples.length} samples`,
			);
		}
		provider.quiesce();
		const probe = await runProbe(scenario, drive);
		const capped = provider.capped();
		const baselineMs =
			deps.baselineMs ??
			(scenario.baselineOf === undefined
				? undefined
				: baselineFromHistory(readHistory(deps.historyPath).records, scenario.baselineOf));
		const hypotheses: RunResult["hypotheses"] = checkInvariants(report, {
			stateRoot,
			historyPath: deps.historyPath,
			baseline,
			probe,
			...(baselineMs === undefined ? {} : { baselineMs }),
			expectedPrompts: scenario.prompts.count,
			// A capped real run could not send its probe, so recovery cannot be judged.
			invariants: scenario.invariants.filter((id) => !(capped && id === "recovery")),
			minNodes: nodeRange[0],
			maxNodes: nodeRange[1],
			...(scenario.resourceSlackMiB === undefined
				? {}
				: { resourceSlackMiB: scenario.resourceSlackMiB }),
			maxInflight: scenario.prompts.concurrency * (config.claudeConcurrency ?? 3),
			...(real ? { real } : {}),
		});
		if (achieved !== undefined) {
			const floor = deps.pressureFloor ?? DEFAULT_PRESSURE_FLOOR;
			const ratio = Math.round(achieved.ratio * 1000) / 1000;
			hypotheses.push(
				achieved.ratio >= floor
					? { id: "pressure", passed: true, observed: ratio }
					: {
							id: "pressure",
							passed: false,
							observed: ratio,
							reason: `pressure-not-applied: achieved CPU ratio ${ratio} is below the floor ${floor}`,
						},
			);
		}
		if (real && deps.real) {
			deps.notes?.(
				`calls made: ${provider.calls().length} (cap ${deps.real.maxCalls}${capped ? ", reached" : ""})`,
			);
		}
		const result: RunResult = {
			templateId: scenario.id,
			driver: "pipeline",
			startedAt,
			finishedAt: wallNow().toISOString(),
			settled: "not_configured",
			hypotheses,
			passed: hypotheses.every((hypothesis) => hypothesis.passed),
			score: scoreRun(hypotheses),
			rollback: "skipped:not_requested",
		};
		return appendHistory(deps.historyPath, result);
	} finally {
		await pressure?.stop();
		if (ownRoot) rmSync(stateRoot, { recursive: true, force: true });
	}
}
