// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import type { SelectedEngine } from "../../../../src/host/engine.ts";
import { yieldTurn } from "../../../../src/test.helpers.ts";
import { makeTempDir } from "../../test.helpers.ts";
import {
	defaultWatchdogMs,
	expectedPlanned,
	nonceFor,
	runProbes,
	runPrompts,
	stallBudgetMs,
	watchdogBudgetMs,
} from "./drive.ts";
import { createJudge } from "./oracle.ts";
import {
	createScriptedProvider,
	createVirtualClock,
	type Rule,
	type ScriptedProvider,
} from "./provider.ts";
import type { Scenario } from "./scenario.ts";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const CORPUS = [
	"add a retry wrapper to the http client",
	"",
	"write a changelog entry for the release",
	"scaffold a new cli command",
];

function tiny(overrides: Partial<Scenario> = {}): Scenario {
	return {
		id: "tiny-run",
		title: "tiny",
		failureMode: "pipeline-load",
		seed: 7,
		prompts: { count: 4, concurrency: 2, corpus: CORPUS },
		faults: [
			{
				stage: "fill",
				promptId: 2,
				effect: { kind: "error", status: 429, retryAfterSec: 1 },
				count: "forever",
			},
			{
				stage: "graph",
				promptId: 3,
				effect: { kind: "garbage", text: "not json at all" },
				count: "forever",
			},
		],
		pressure: { cpuWorkers: 0, duty: 0, memMB: 0 },
		config: {},
		invariants: ["terminal"],
		...overrides,
	};
}

function rig(
	scenario: Scenario,
	rules: Rule[] = scenario.faults,
	seams: { maxCalls?: number } = {},
) {
	const clock = createVirtualClock();
	const provider = createScriptedProvider(rules, {
		sleep: clock.sleep,
		now: clock.now,
		seed: scenario.seed,
		...seams,
	});
	const stateRoot = makeTempDir("pipeline-drive-", roots);
	return {
		clock,
		provider,
		stateRoot,
		deps: { provider, sleep: clock.sleep, now: clock.now, stateRoot, ompPrompts: 0 },
	};
}

function nonceOf(seed: number, index: number): string {
	return `pl-${seed}-${String(index).padStart(6, "0")}`;
}

describe("runPrompts through the real hook", () => {
	test("every prompt of the tiny scenario ends in a terminal status", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		const report = await runPrompts(scenario, deps);

		expect(report.outcomes.map((outcome) => outcome.terminal)).toEqual([
			"planned",
			"skipped:empty",
			"planned",
			"planned",
		]);
		expect(report.outcomes.map((outcome) => outcome.promptId)).toEqual([0, 1, 2, 3]);
		expect(report.outcomes.every((outcome) => outcome.path === "hook")).toBe(true);
		expect(report.outcomes.every((outcome) => outcome.error === undefined)).toBe(true);
		expect(Number.isNaN(Date.parse(report.startedAt))).toBe(false);
		expect(Number.isNaN(Date.parse(report.finishedAt))).toBe(false);
	});

	test("the clean prompt plans from the model and records per-stage calls", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		const [clean] = (await runPrompts(scenario, deps)).outcomes;

		expect(clean?.record?.result.source).toBe("llm");
		expect(clean?.record?.result.original).toBe(CORPUS[0]?.concat(`\n${nonceOf(7, 0)}`));
		expect(clean?.degraded).toEqual([]);
		const nodes = clean?.record?.graph?.nodes.length ?? 0;
		expect(nodes).toBeGreaterThanOrEqual(5);
		expect(clean?.calls).toEqual({ uplift: 1, graph: 1, fill: nodes, clarify: 1 });
		expect(clean?.specXml).toContain(nonceOf(7, 0));
		expect(clean?.context).toContain(nonceOf(7, 0));
		expect(clean?.state?.bad).toEqual([]);
		expect(clean?.state?.stale).toEqual([]);
		expect(clean?.state?.files).toBeGreaterThan(0);
	});

	test("an empty prompt is a skip with its reason and no calls", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		const outcome = (await runPrompts(scenario, deps)).outcomes[1];

		expect(outcome?.terminal).toBe("skipped:empty");
		expect(outcome?.record).toBeUndefined();
		expect(outcome?.calls).toEqual({});
		expect(outcome?.degraded).toEqual([]);
	});

	test("an injected 429 on every fill degrades each node and is retried inside the budget", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		const outcome = (await runPrompts(scenario, deps)).outcomes[2];

		const nodes = outcome?.record?.graph?.nodes ?? [];
		expect(outcome?.record?.result.source).toBe("llm");
		expect(outcome?.degraded).toEqual(nodes.map((node) => `fill:${node.id}`));
		// The hook path's completer attaches no report, so each fill is tried three times; the repair pass is skipped
		// because no fill succeeded.
		expect(outcome?.calls.fill).toBe(nodes.length * 3);
		expect(outcome?.context).toContain("Planning degraded");
	});

	test("a garbage graph is recorded as degraded graph and the plan still ships", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		const outcome = (await runPrompts(scenario, deps)).outcomes[3];

		expect(outcome?.terminal).toBe("planned");
		expect(outcome?.degraded).toContain("graph");
		expect(outcome?.rows).toEqual([]);
	});

	test("no prompt sees another prompt's nonce, in its record, spec, context, rows or completer payloads", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		const report = await runPrompts(scenario, deps);

		for (const outcome of report.outcomes) {
			if (outcome.record === undefined) continue;
			const mine = nonceOf(7, outcome.promptId);
			const haystack = [
				JSON.stringify(outcome.record),
				outcome.specXml,
				outcome.context,
				...outcome.rows,
			].join("\n");
			expect(haystack).toContain(mine);
			for (const other of [0, 1, 2, 3].filter((index) => index !== outcome.promptId)) {
				expect(haystack).not.toContain(nonceOf(7, other));
			}
		}
		expect(report.calls.every((call) => call.foreign.length === 0)).toBe(true);
		expect(report.peakInflight).toBeGreaterThan(0);
	});

	test("the tracker stub sees the plan rows of a tracked prompt and tracking can be turned off", async () => {
		const tracked = tiny({ faults: [] });
		const off = tiny({ faults: [], config: { track: false } });

		const on = (await runPrompts(tracked, rig(tracked).deps)).outcomes[0];
		const none = (await runPrompts(off, rig(off).deps)).outcomes[0];

		expect(on?.rows.length).toBe(1);
		expect(on?.rows[0]).toContain(nonceOf(7, 0));
		expect(none?.rows).toEqual([]);
	});

	test("temp state directories are removed, also when a prompt ends aborted", async () => {
		const scenario = tiny();
		const { deps, stateRoot } = rig(scenario);

		await runPrompts(scenario, deps);

		expect(readdirSync(stateRoot)).toEqual([]);
	});

	test("a hung stage ends aborted when the watchdog fires and never rejects the batch", async () => {
		const scenario = tiny({
			prompts: { count: 2, concurrency: 2, corpus: ["add a thing", "add another thing"] },
			faults: [{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" }],
		});
		const { deps, provider, stateRoot } = rig(scenario);
		const pending: Array<() => void> = [];
		const timers = {
			setTimeout: (callback: () => void) => {
				pending.push(callback);
				return pending.length as unknown as NodeJS.Timeout;
			},
			clearTimeout: () => undefined,
		};

		const running = runPrompts(scenario, { ...deps, timers, watchdogMs: 5000 });
		for (let i = 0; i < 200 && provider.inflight().now < 1; i += 1) await yieldTurn();
		expect(provider.byPrompt(nonceOf(7, 0)).at(-1)?.outcome).toBe("pending");
		for (const fire of pending) fire();
		const report = await running;

		expect(report.outcomes[0]?.terminal).toBe("aborted");
		expect(report.outcomes[1]?.terminal).toBe("planned");
		const [call] = provider.byPrompt(nonceOf(7, 0)).filter((entry) => entry.stage === "graph");
		expect(call?.chain).toEqual(["hang"]);
		expect(provider.byPrompt(nonceOf(7, 0)).at(-1)?.outcome).toBe("aborted");
		expect(readdirSync(stateRoot)).toEqual([]);
	});
});

describe("the generated corpus", () => {
	test("sixteen varied prompts cover every kind and end terminal", async () => {
		const scenario = tiny({ prompts: { count: 16, concurrency: 4 }, faults: [] });
		const { deps } = rig(scenario);

		const report = await runPrompts(scenario, deps);

		const terminals = report.outcomes.map((outcome) => outcome.terminal);
		expect(terminals.filter((terminal) => terminal === "skipped:empty")).toHaveLength(2);
		expect(
			terminals.every((terminal) => terminal === "planned" || terminal === "skipped:empty"),
		).toBe(true);
		expect(report.outcomes.every((outcome) => outcome.error === undefined)).toBe(true);
		const lengths = report.outcomes.map((outcome) => outcome.expected.length);
		expect(Math.max(...lengths)).toBeGreaterThan(200_000);
		expect(lengths.filter((length) => length > 190_000 && length <= 200_000)).toHaveLength(1);
		for (const outcome of report.outcomes) {
			if (outcome.record === undefined) continue;
			expect(outcome.record.result.original).toBe(outcome.expected);
		}
		const over = report.outcomes.find((outcome) => outcome.expected.length > 200_000);
		expect(over?.record?.result.fallbackReason).not.toBe("input_over_limit");
		expect(over?.degraded ?? []).not.toContain("uplift");
		expect(over?.calls.uplift ?? 0).toBeGreaterThan(0);
		const surrogate = report.outcomes.find((outcome) =>
			/[\ud800-\udbff](?![\udc00-\udfff])/.test(outcome.expected),
		);
		expect(surrogate?.record?.result.original).toBe(surrogate?.expected);
	});

	test("the same scenario and seed give the same outcomes", async () => {
		const scenario = tiny({ prompts: { count: 8, concurrency: 3 }, faults: [] });

		const a = await runPrompts(scenario, rig(scenario).deps);
		const b = await runPrompts(scenario, rig(scenario).deps);

		const shape = (report: typeof a) =>
			report.outcomes.map((outcome) => [outcome.terminal, outcome.degraded, outcome.calls]);
		expect(shape(a)).toEqual(shape(b));
	});
});

describe("the Omp planner path", () => {
	test("a bounded subset runs through planPrompt with the native planner and the same provider", async () => {
		const scenario = tiny({ faults: [] });
		const { deps, provider } = rig(scenario);

		const report = await runPrompts(scenario, { ...deps, ompPrompts: 2 });

		expect(report.outcomes.map((outcome) => outcome.path)).toEqual(["omp", "hook", "omp", "hook"]);
		const omp = report.outcomes[0];
		expect(omp?.terminal).toBe("planned");
		expect(omp?.record?.result.source).toBe("llm");
		expect(omp?.record?.host).toBe("omp");
		expect(omp?.degraded).toEqual([]);
		expect(omp?.calls.uplift).toBe(1);
		expect(omp?.context).toContain(nonceOf(7, 0));
		expect(provider.byPrompt(nonceOf(7, 0)).length).toBe(
			Object.values(omp?.calls ?? {}).reduce((a, b) => a + b, 0),
		);
	});

	test("an Omp prompt whose fills fail with 429 retries on the injected clock and degrades", async () => {
		const scenario = tiny({
			prompts: { count: 1, concurrency: 1, corpus: ["add a retry wrapper"] },
			faults: [
				{
					stage: "fill",
					effect: { kind: "error", status: 429, retryAfterSec: 1 },
					count: "forever",
				},
			],
		});
		const { deps, clock } = rig(scenario);

		const outcome = (await runPrompts(scenario, { ...deps, ompPrompts: 1 })).outcomes[0];

		expect(outcome?.path).toBe("omp");
		expect(outcome?.terminal).toBe("planned");
		expect((outcome?.degraded ?? []).some((token) => token.startsWith("fill:"))).toBe(true);
		// Three native attempts per fill (the native completer attaches its report, so the fill layer does not retry), on virtual time.
		expect(outcome?.calls.fill).toBeGreaterThanOrEqual(9);
		expect(clock.now()).toBeGreaterThan(0);
	});

	test("a whitespace prompt is skipped by the planner with its reason", async () => {
		const scenario = tiny({
			prompts: { count: 1, concurrency: 1, corpus: ["   \n\t "] },
			faults: [],
		});
		const { deps } = rig(scenario);

		const outcome = (await runPrompts(scenario, { ...deps, ompPrompts: 1 })).outcomes[0];

		expect(outcome?.path).toBe("omp");
		expect(outcome?.terminal).toBe("skipped:empty");
	});

	test("an injected engine selector serves every prompt, faults still apply and the cap stops dispatch", async () => {
		const scenario = tiny({
			prompts: { count: 6, concurrency: 1, corpus: ["add a widget"] },
			faults: [],
		});
		const { deps, provider } = rig(scenario, [], { maxCalls: 12 });
		let selections = 0;
		const engineSelector = async (): Promise<SelectedEngine> => {
			selections += 1;
			return stubEngine(provider);
		};

		const report = await runPrompts(scenario, { ...deps, engineSelector: engineSelector as never });

		expect(selections).toBeGreaterThan(0);
		expect(report.outcomes.every((outcome) => outcome.path === "omp")).toBe(true);
		expect(provider.capped()).toBe(true);
		expect(provider.calls()).toHaveLength(12);
		const skipped = report.outcomes.filter((outcome) => outcome.terminal === "skipped:max-calls");
		expect(skipped.length).toBeGreaterThan(0);
		expect(report.outcomes.length).toBe(6);
	});

	test("a throwing engine selector becomes an explicit skip, not a rejected batch", async () => {
		const scenario = tiny({
			prompts: { count: 2, concurrency: 1, corpus: ["add a widget"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		const engineSelector = async (): Promise<SelectedEngine> => {
			throw new Error("selector broke");
		};

		const report = await runPrompts(scenario, { ...deps, engineSelector: engineSelector as never });

		expect(report.outcomes.map((outcome) => outcome.terminal)).toEqual([
			"skipped:engine-error",
			"skipped:engine-error",
		]);
	});
});

describe("watchdog budget", () => {
	test("the livelock ceiling scales with concurrency: the larger of 900 s and 8 s per slot", () => {
		expect(defaultWatchdogMs(5)).toBe(900_000);
		expect(defaultWatchdogMs(100)).toBe(900_000);
		expect(defaultWatchdogMs(112)).toBe(900_000);
		expect(defaultWatchdogMs(128)).toBe(1_024_000);
	});

	test("the stall window: the caller's, else the scenario's, else 60 s", () => {
		expect(stallBudgetMs(tiny({ stallMs: 9000 }), { stallMs: 1234 })).toBe(1234);
		expect(stallBudgetMs(tiny({ stallMs: 9000 }), {})).toBe(9000);
		expect(stallBudgetMs(tiny(), {})).toBe(60_000);
	});

	test("the caller's budget wins over the scenario's, which wins over the default", () => {
		const scenario = tiny({ watchdogMs: 9000, prompts: { count: 1, concurrency: 100 } });

		expect(watchdogBudgetMs(scenario, { watchdogMs: 1234 })).toBe(1234);
		expect(watchdogBudgetMs(scenario, {})).toBe(9000);
		expect(watchdogBudgetMs(tiny({ prompts: { count: 1, concurrency: 100 } }), {})).toBe(900_000);
	});
});

/** Hand-driven stall sampler: `advance` moves its clock one sample and runs the registered tick. */
function stallRig(sampleMs = 5000) {
	const state = { at: 0, cpuMs: 0 };
	let tick: (() => void) | undefined;
	return {
		seams: {
			sampleMs,
			stallMs: 60_000,
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

async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 2000 && !condition(); i += 1) await macrotask();
	expect(condition()).toBe(true);
}

/** A provider whose `delay` effect waits on a gate the test opens (abort-aware): a prompt blocked with no `hang` injected. */
function gatedProvider(scenario: Scenario) {
	const gate = Promise.withResolvers<void>();
	const sleep = (_ms: number, signal?: AbortSignal): Promise<void> => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const aborted = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		if (signal?.aborted) aborted();
		signal?.addEventListener("abort", aborted, { once: true });
		void gate.promise.then(resolve);
		return promise;
	};
	const provider = createScriptedProvider(
		[{ stage: "graph", promptId: 0, effect: { kind: "delay", ms: 10 }, count: "forever" }],
		{ sleep, seed: scenario.seed },
	);
	return { provider, release: () => gate.resolve() };
}

describe("the stall watchdog", () => {
	test("aborts a prompt blocked on an injected hang with no CPU progress, as stalled, and the judge accepts it", async () => {
		const scenario = tiny({
			prompts: { count: 2, concurrency: 2, corpus: ["add a thing", "add another thing"] },
			faults: [{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" }],
		});
		const { deps, provider, stateRoot } = rig(scenario);
		const stall = stallRig();

		let done = 0;
		const running = runPrompts(scenario, {
			...deps,
			...stall.seams,
			judge: createJudge({}),
			onPromptDone: () => (done += 1),
		});
		await waitFor(() => done === 1);
		for (let i = 0; i < 15; i += 1) {
			stall.advance(0);
			await macrotask();
		}
		const report = await running;

		const [aborted, planned] = report.outcomes;
		expect(aborted?.terminal).toBe("aborted");
		expect(aborted?.abortKind).toBe("stalled");
		expect(aborted?.abortReason).toMatch(
			/^stalled: no CPU progress for 60 s with 1 prompts in flight \(0 ms CPU, 1 prompts done, \d+ provider calls, max loop lag 0 ms\)$/,
		);
		expect(aborted?.verdict).toMatchObject({ allowedAbort: true, terminal: [] });
		expect(planned?.terminal).toBe("planned");
		expect(planned?.abortKind).toBeUndefined();
		expect(provider.byPrompt(nonceOf(7, 0)).at(-1)?.outcome).toBe("aborted");
		expect(readdirSync(stateRoot)).toEqual([]);
	});

	test("the same stall without an injected hang is a finding that says stalled and names the numbers", async () => {
		const scenario = tiny({
			prompts: { count: 2, concurrency: 2, corpus: ["add a thing", "add another thing"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		const { provider } = gatedProvider(scenario);
		const stall = stallRig();

		let done = 0;
		const running = runPrompts(scenario, {
			...deps,
			provider,
			...stall.seams,
			judge: createJudge({}),
			onPromptDone: () => (done += 1),
		});
		await waitFor(() => done === 1);
		for (let i = 0; i < 15; i += 1) {
			stall.advance(0);
			await macrotask();
		}
		const report = await running;

		const aborted = report.outcomes[0];
		expect(aborted?.abortKind).toBe("stalled");
		expect(aborted?.verdict?.allowedAbort).toBe(false);
		expect(aborted?.verdict?.terminal[0]).toMatch(
			/^prompt 0: aborted \(stalled: no CPU progress for 60 s with 1 prompts in flight .*\) and no injected hang targeted it$/,
		);
	});

	test("a slow prompt whose CPU keeps advancing for ten stall windows is never aborted", async () => {
		const scenario = tiny({
			prompts: { count: 1, concurrency: 1, corpus: ["add a thing"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		const { provider, release } = gatedProvider(scenario);
		const stall = stallRig();

		const running = runPrompts(scenario, { ...deps, provider, ...stall.seams });
		await waitFor(() => provider.inflight().now === 1);
		// Ten windows of 12 samples each; the process gets 3 percent of one CPU and nothing finishes.
		for (let i = 0; i < 120; i += 1) {
			stall.advance(0.03);
			await macrotask();
			expect(provider.byPrompt(nonceOf(7, 0)).at(-1)?.outcome).toBe("pending");
		}
		release();
		const report = await running;

		expect(report.outcomes[0]?.terminal).toBe("planned");
		expect(report.outcomes[0]?.abortKind).toBeUndefined();
	});

	test("the stall abort carries over to every unfinished prompt and the batch still ends", async () => {
		const scenario = tiny({
			prompts: { count: 3, concurrency: 3, corpus: ["add a", "add b", "add c"] },
			faults: [
				{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" },
				{ stage: "graph", promptId: 1, effect: { kind: "hang" }, count: "forever" },
			],
		});
		const { deps } = rig(scenario);
		const stall = stallRig();

		let done = 0;
		const running = runPrompts(scenario, {
			...deps,
			...stall.seams,
			onPromptDone: () => (done += 1),
		});
		await waitFor(() => done === 1);
		for (let i = 0; i < 15; i += 1) {
			stall.advance(0);
			await macrotask();
		}
		const report = await running;

		expect(report.outcomes.map((outcome) => outcome.terminal)).toEqual([
			"aborted",
			"aborted",
			"planned",
		]);
		expect(report.outcomes.slice(0, 2).every((outcome) => outcome.abortKind === "stalled")).toBe(
			true,
		);
		expect(report.outcomes[0]?.abortReason).toContain("with 2 prompts in flight");
	});

	test("the ceiling is a separate abort: it says ceiling and is not stalled", async () => {
		const scenario = tiny({
			prompts: { count: 1, concurrency: 1, corpus: ["add a thing"] },
			faults: [{ stage: "graph", promptId: 0, effect: { kind: "hang" }, count: "forever" }],
		});
		const { deps, provider } = rig(scenario);
		const pending: Array<() => void> = [];
		const timers = {
			setTimeout: (callback: () => void) => {
				pending.push(callback);
				return pending.length as unknown as NodeJS.Timeout;
			},
			clearTimeout: () => undefined,
		};

		const running = runPrompts(scenario, {
			...deps,
			timers,
			watchdogMs: 777_000,
			judge: createJudge({}),
		});
		await waitFor(() => provider.inflight().now === 1);
		for (const fire of pending) fire();
		const report = await running;

		expect(report.outcomes[0]?.abortKind).toBe("ceiling");
		expect(report.outcomes[0]?.abortReason).toBe("ceiling: still running after 777000 ms");
	});

	test("without a stall the sampler is stopped when the batch ends", async () => {
		const scenario = tiny({
			prompts: { count: 1, concurrency: 1, corpus: ["add a thing"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		let cleared = 0;

		await runPrompts(scenario, {
			...deps,
			intervalTimers: { setInterval: () => 1, clearInterval: () => (cleared += 1) },
		});

		expect(cleared).toBe(1);
	});
});

describe("expected planned share", () => {
	test("the generated cycle skips 2 of every 16 prompts", () => {
		const of = (count: number) => expectedPlanned(tiny({ prompts: { count, concurrency: 1 } }));

		expect(of(16)).toBe(14);
		expect(of(2000)).toBe(1750);
		expect(of(500)).toBe(436);
		expect(of(1)).toBe(0);
		expect(of(3)).toBe(1);
	});

	test("a corpus plans every non-blank entry in the cycle", () => {
		expect(expectedPlanned(tiny())).toBe(3);
		expect(
			expectedPlanned(tiny({ prompts: { count: 7, concurrency: 1, corpus: ["a", " ", "b"] } })),
		).toBe(5);
	});

	test("matches what the driver really plans for one full cycle", async () => {
		const scenario = tiny({ prompts: { count: 16, concurrency: 4 }, faults: [] });
		const { deps } = rig(scenario);

		const report = await runPrompts(scenario, deps);

		expect(report.outcomes.filter((outcome) => outcome.terminal === "planned")).toHaveLength(
			expectedPlanned(scenario),
		);
	});
});

describe("event-loop turns", () => {
	test("the batch yields a macrotask between prompts, so timers and the watchdog are not starved by the harness", async () => {
		const scenario = tiny({
			prompts: { count: 8, concurrency: 4, corpus: ["add a widget"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		let turned = false;
		setTimeout(() => {
			turned = true;
		}, 0);
		const seen: boolean[] = [];

		await runPrompts(scenario, {
			...deps,
			ompPrompts: 0,
			onPromptDone: () => seen.push(turned),
		});

		// A prompt that finished while the timer was due but never ran would mean the loop did not turn once in the batch.
		expect(seen.at(-1)).toBe(true);
		expect(seen.indexOf(true)).toBeLessThan(seen.length - 1);
	});
});

describe("real-clock timing", () => {
	test("each prompt records its time on the injected real clock, apart from the scripted one", async () => {
		const scenario = tiny({
			prompts: { count: 2, concurrency: 1, corpus: ["add a widget"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		let tick = 0;

		const report = await runPrompts(scenario, {
			...deps,
			realNow: () => {
				tick += 250;
				return tick;
			},
		});

		expect(report.outcomes.map((outcome) => outcome.realMs)).toEqual([250, 250]);
		expect(report.outcomes.every((outcome) => outcome.ms === 0)).toBe(true);
	});
});

describe("nonces", () => {
	test("are fixed width, so no nonce is a prefix of another", () => {
		const nonces = [0, 9, 10, 165, 99999].map((index) => nonceFor(12, index));

		expect(nonces).toEqual([
			"pl-12-000000",
			"pl-12-000009",
			"pl-12-000010",
			"pl-12-000165",
			"pl-12-099999",
		]);
		for (const a of nonces) {
			for (const b of nonces) if (a !== b) expect(b.startsWith(a)).toBe(false);
		}
	});

	test("the outcome nonce is the fixed-width one", async () => {
		const scenario = tiny({ prompts: { count: 2, concurrency: 1, corpus: ["add a widget"] } });
		const { deps } = rig(scenario);

		const report = await runPrompts(scenario, deps);

		expect(report.outcomes.map((outcome) => outcome.nonce)).toEqual(["pl-7-000000", "pl-7-000001"]);
	});
});

describe("judging and compacting", () => {
	test("a judge runs on each prompt as it completes and compact drops the heavy fields", async () => {
		const scenario = tiny({ faults: [] });
		const { deps } = rig(scenario);
		const done: number[] = [];

		const report = await runPrompts(scenario, {
			...deps,
			judge: createJudge({}),
			compact: true,
			onPromptDone: (completed) => done.push(completed),
		});

		expect(done).toEqual([1, 2, 3, 4]);
		for (const outcome of report.outcomes) {
			expect(outcome.verdict).toBeDefined();
			expect(outcome.record).toBeUndefined();
			expect(outcome.specXml).toBeUndefined();
			expect(outcome.context).toBe("");
			expect(outcome.rows).toEqual([]);
			expect(outcome.expected).toBe("");
			expect(outcome.state).toBeDefined();
		}
		expect(report.outcomes[0]?.verdict).toMatchObject({
			planned: true,
			terminal: [],
			isolation: [],
		});
		expect(report.outcomes[1]?.verdict?.planned).toBe(false);
	});

	test("without compact the judged outcome keeps its record", async () => {
		const scenario = tiny({ faults: [] });
		const { deps } = rig(scenario);

		const report = await runPrompts(scenario, { ...deps, judge: createJudge({}) });

		expect(report.outcomes[0]?.verdict).toBeDefined();
		expect(report.outcomes[0]?.record).toBeDefined();
	});
});

describe("runProbes", () => {
	test("a batch of clean probe prompts plans from the model after the faults are quiesced, one after the other", async () => {
		const scenario = tiny();
		const { deps, provider } = rig(scenario);
		await runPrompts(scenario, deps);
		provider.quiesce();
		const before = provider.inflight().peak;

		const probes = await runProbes(scenario, deps, 5);

		expect(probes.map((probe) => probe.promptId)).toEqual([4, 5, 6, 7, 8]);
		expect(probes.map((probe) => probe.nonce)).toEqual(
			[4, 5, 6, 7, 8].map((index) => nonceOf(7, index)),
		);
		for (const probe of probes) {
			expect(probe.terminal).toBe("planned");
			expect(probe.record?.result.source).toBe("llm");
			expect(probe.degraded).toEqual([]);
			expect(probe.ms).toBeGreaterThanOrEqual(0);
			expect(probe.realMs).toBeGreaterThanOrEqual(0);
		}
		// Sequential: the batch never raised the peak of calls in flight above the run's own.
		expect(provider.inflight().peak).toBe(before);
	});

	test("each probe records its own real-clock time", async () => {
		const scenario = tiny({
			prompts: { count: 1, concurrency: 1, corpus: ["add a widget"] },
			faults: [],
		});
		const { deps } = rig(scenario);
		let tick = 0;

		const probes = await runProbes(
			scenario,
			{
				...deps,
				realNow: () => {
					tick += 100;
					return tick;
				},
			},
			3,
		);

		expect(probes.map((probe) => probe.realMs)).toEqual([100, 100, 100]);
	});

	test("a count of zero is an empty batch", async () => {
		const scenario = tiny();
		const { deps } = rig(scenario);

		expect(await runProbes(scenario, deps, 0)).toEqual([]);
	});
});

function stubEngine(provider: ScriptedProvider): SelectedEngine {
	// The inner scripted provider writes the valid replies; the outer one counts, caps and injects the faults.
	const inner = createScriptedProvider([]);
	return {
		label: "chaos:stub",
		complete: provider.wrap(inner.complete),
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
