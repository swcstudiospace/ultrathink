// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { selectEngine } from "../../../../src/host/engine.ts";
import type { HostId } from "../../../../src/host/types.ts";
import { appendHistory, readHistory } from "../history.ts";
import type { HistoryRecord, RunResult } from "../run.ts";
import { scoreRun } from "../score.ts";
import {
	type DriveDeps,
	expectedPlanned,
	type PromptOutcome,
	runProbes,
	runPrompts,
	stallBudgetMs,
	watchdogBudgetMs,
} from "./drive.ts";
import { checkInvariants, createJudge, median, snapshotResources } from "./oracle.ts";
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
	/** Probe time on the scripted clock of the baseline run; defaults to the latest recorded one of `scenario.baselineOf`. */
	baselineMs?: number;
	/** Probe time on the real clock of the baseline run; defaults like `baselineMs`. */
	baselineRealMs?: number;
	/** Real clock in ms for the probe and per-prompt wall time; default `performance.now`. */
	realNow?: () => number;
	/** Livelock ceiling in real ms; defaults to the scenario's `watchdogMs`, else the concurrency-scaled default. */
	watchdogMs?: number;
	/** Stall window of the hang detector in real ms; defaults to the scenario's `stallMs`, else 60000. */
	stallMs?: number;
	/** Test seams of the hang detector: sample interval, process CPU in ms, its clock and its interval timers. */
	sampleMs?: number;
	cpuMs?: DriveDeps["cpuMs"];
	stallNow?: DriveDeps["stallNow"];
	intervalTimers?: DriveDeps["intervalTimers"];
	/** One-minute load average at the start of the run; default `os.loadavg()[0]`. */
	loadAvg?: () => number;
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
/** Probe prompts sent after the load: the recovery figure is the median of their real latencies. A live engine gets one (every call spends tokens). */
const PROBE_COUNT = 5;

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

interface Baseline {
	/** Probe time on the scripted provider's clock. */
	virtualMs?: number;
	/** Probe time on the real clock. */
	realMs?: number;
	/** One-minute load average when the baseline run started. */
	loadAvg1?: number;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The recovery probe times of the latest recorded pipeline run of `id`: what a later run's probe is compared with. The
 * real-clock figure is `details.probeRealMs` (the median of the probe batch, or the single probe of an older record); a run recorded before it existed carries only a numeric `recovery`
 * observation, read as the scripted-clock figure. A run with neither is passed over.
 */
export function baselineFromHistory(records: HistoryRecord[], id: string): Baseline | undefined {
	const runs = records
		.filter((record) => record.templateId === id && record.driver === "pipeline")
		.sort((a, b) => b.seq - a.seq);
	for (const run of runs) {
		const realMs = finite(run.details?.probeRealMs);
		const loadAvg1 = finite(run.details?.loadAvg1);
		const virtualMs =
			finite(run.details?.probeVirtualMs) ??
			finite(run.hypotheses.find((hypothesis) => hypothesis.id === "recovery")?.observed);
		if (realMs !== undefined || virtualMs !== undefined) {
			return {
				...(virtualMs === undefined ? {} : { virtualMs }),
				...(realMs === undefined ? {} : { realMs }),
				...(loadAvg1 === undefined ? {} : { loadAvg1 }),
			};
		}
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

/** Outcome counts by status, with a `skipped:<reason>` count per skip reason. */
function countStatuses(outcomes: Array<PromptOutcome | undefined>): {
	planned: number;
	skipped: number;
	aborted: number;
	stalled: number;
	ceiling: number;
	reasons: Record<string, number>;
} {
	const counts = {
		planned: 0,
		skipped: 0,
		aborted: 0,
		stalled: 0,
		ceiling: 0,
		reasons: {} as Record<string, number>,
	};
	for (const outcome of outcomes) {
		const terminal = outcome?.terminal;
		if (terminal === "planned") counts.planned += 1;
		else if (terminal === "aborted") {
			counts.aborted += 1;
			if (outcome?.abortKind === "stalled") counts.stalled += 1;
			else if (outcome?.abortKind === "ceiling") counts.ceiling += 1;
		} else if (terminal?.startsWith("skipped:")) {
			counts.skipped += 1;
			counts.reasons[terminal] = (counts.reasons[terminal] ?? 0) + 1;
		}
	}
	return counts;
}

/** Whether two load averages differ by more than a factor of 2, loads under 1 counted as 1 (an idle host is idle). */
function loadDiffers(a: number, b: number): boolean {
	const high = Math.max(a, b, 1);
	const low = Math.max(Math.min(a, b), 1);
	return high / low > 2;
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
	const watchdogMs = watchdogBudgetMs(scenario, deps);
	const stallMs = stallBudgetMs(scenario, deps);
	const loadNow = Math.round((deps.loadAvg ?? (() => loadavg()[0] ?? 0))() * 100) / 100;
	const judge = createJudge({
		minNodes: nodeRange[0],
		maxNodes: nodeRange[1],
		...(scenario.allowAborts === undefined ? {} : { allowAborts: scenario.allowAborts }),
		...(real ? { real } : {}),
	});
	const samples: HeapSample[] = [];
	const traceEvery = deps.traceEvery ?? 100;
	const engineSelector = real ? (deps.engineSelector ?? selectEngine) : undefined;
	const drive: DriveDeps = {
		provider,
		sleep: clock.sleep,
		now: clock.now,
		...(deps.realNow ? { realNow: deps.realNow } : {}),
		watchdogMs,
		stallMs,
		...(deps.sampleMs === undefined ? {} : { sampleMs: deps.sampleMs }),
		...(deps.cpuMs ? { cpuMs: deps.cpuMs } : {}),
		...(deps.stallNow ? { stallNow: deps.stallNow } : {}),
		...(deps.intervalTimers ? { intervalTimers: deps.intervalTimers } : {}),
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
		const probes = await runProbes(scenario, drive, real ? 1 : PROBE_COUNT);
		const probe = probes[0];
		if (probe === undefined) throw new Error("the probe batch is empty");
		const capped = provider.capped();
		const recorded =
			scenario.baselineOf === undefined
				? undefined
				: baselineFromHistory(readHistory(deps.historyPath).records, scenario.baselineOf);
		const baselineMs = deps.baselineMs ?? recorded?.virtualMs;
		let baselineRealMs = deps.baselineRealMs ?? recorded?.realMs;
		// A latency ratio is only meaningful when the baseline was measured under comparable load: a probe on a host twice as
		// busy (or half as busy) than the baseline's would measure the host. The scripted-clock comparison stays.
		if (
			baselineRealMs !== undefined &&
			recorded?.loadAvg1 !== undefined &&
			loadDiffers(recorded.loadAvg1, loadNow)
		) {
			deps.notes?.(
				`recovery latency comparison skipped: load differed (baseline ${recorded.loadAvg1}, now ${loadNow})`,
			);
			baselineRealMs = undefined;
		}
		const hypotheses: RunResult["hypotheses"] = checkInvariants(report, {
			stateRoot,
			historyPath: deps.historyPath,
			baseline,
			probe,
			probes,
			...(baselineMs === undefined ? {} : { baselineMs }),
			...(baselineRealMs === undefined ? {} : { baselineRealMs }),
			expectedPrompts: scenario.prompts.count,
			// A live engine's prompts are not the corpus' planned share (the call cap skips some), so only the mock run expects it.
			...(real ? {} : { expectedPlanned: expectedPlanned(scenario) }),
			...(scenario.allowAborts === undefined ? {} : { allowAborts: scenario.allowAborts }),
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
		const statuses = countStatuses(report.outcomes);
		deps.notes?.(
			`stall watchdog ${stallMs} ms, ceiling ${watchdogMs} ms, stall aborts ${statuses.stalled}, ceiling aborts ${statuses.ceiling}`,
		);
		const recoveryObserved = hypotheses.find(
			(hypothesis) => hypothesis.id === "recovery",
		)?.observed;
		if (typeof recoveryObserved === "string") deps.notes?.(recoveryObserved);
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
			details: {
				stallMs,
				watchdogMs,
				loadAvg1: loadNow,
				planned: statuses.planned,
				skipped: statuses.skipped,
				aborted: statuses.aborted,
				stallAborts: statuses.stalled,
				ceilingAborts: statuses.ceiling,
				...statuses.reasons,
				probeVirtualMs: Math.round(median(probes.map((entry) => entry.ms))),
				// The median real latency of the batch is the recovery figure and the next run's baseline; all of them are kept.
				probeRealMs: Math.round(median(probes.map((entry) => entry.realMs))),
				probeRealMsAll: probes.map((entry) => Math.round(entry.realMs)),
			},
		};
		return appendHistory(deps.historyPath, result);
	} finally {
		await pressure?.stop();
		if (ownRoot) rmSync(stateRoot, { recursive: true, force: true });
	}
}
