// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import type { SelectedEngine } from "../../../../src/host/engine.ts";
import { yieldTurn } from "../../../../src/test.helpers.ts";
import { makeTempDir } from "../../test.helpers.ts";
import { nonceFor, runPrompts, runProbe } from "./drive.ts";
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
		// Three attempts per fill and one repair attempt each, all on the injected clock.
		expect(outcome?.calls.fill).toBe(nodes.length * 4);
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
		expect(over?.record?.result.fallbackReason).toBe("input_over_limit");
		expect(over?.degraded).toContain("uplift");
		expect(over?.calls.uplift ?? 0).toBe(0);
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
		// Three native attempts, each inside three think attempts, on virtual time.
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

describe("runProbe", () => {
	test("a clean probe prompt plans from the model after the faults are quiesced", async () => {
		const scenario = tiny();
		const { deps, provider } = rig(scenario);
		await runPrompts(scenario, deps);
		provider.quiesce();

		const probe = await runProbe(scenario, deps);

		expect(probe.promptId).toBe(4);
		expect(probe.nonce).toBe(nonceOf(7, 4));
		expect(probe.terminal).toBe("planned");
		expect(probe.record?.result.source).toBe("llm");
		expect(probe.degraded).toEqual([]);
		expect(probe.ms).toBeGreaterThanOrEqual(0);
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
