// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../test.helpers.ts";
import { loadTemplates } from "../schema.ts";
import { INVARIANT_IDS, parseScenario, parseScenarios } from "./scenario.ts";

const SCENARIOS = join(import.meta.dir, "scenarios");
const EXPERIMENTS = join(import.meta.dir, "..", "experiments");
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function valid(): Record<string, unknown> {
	return {
		id: "tiny-run",
		title: "A tiny scenario",
		failureMode: "pipeline-load",
		seed: 7,
		prompts: { count: 4, concurrency: 2 },
		invariants: [...INVARIANT_IDS],
	};
}

function messageOf(build: () => unknown): string {
	try {
		build();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "";
}

describe("parseScenario", () => {
	test("accepts a minimal scenario and fills the defaults", () => {
		const scenario = parseScenario(valid(), "tiny.json");

		expect(scenario.id).toBe("tiny-run");
		expect(scenario.faults).toEqual([]);
		expect(scenario.pressure).toEqual({ cpuWorkers: 0, duty: 0, memMB: 0 });
		expect(scenario.config).toEqual({});
		expect(scenario.baselineOf).toBeUndefined();
	});

	test("rejects an unknown key with a TypeError naming the path", () => {
		const input = { ...valid(), bogus: 1 };

		expect(() => parseScenario(input, "tiny.json")).toThrow(TypeError);
		expect(messageOf(() => parseScenario(input, "tiny.json"))).toBe(
			"tiny.json: bogus is not a known field",
		);
	});

	test("rejects an unknown nested key", () => {
		const input = { ...valid(), prompts: { count: 4, concurrency: 2, extra: true } };

		expect(messageOf(() => parseScenario(input, "tiny.json"))).toBe(
			"tiny.json: prompts.extra is not a known field",
		);
	});

	test("rejects an out-of-range prompts.count with a RangeError", () => {
		for (const count of [0, 5001]) {
			const input = { ...valid(), prompts: { count, concurrency: 2 } };

			expect(() => parseScenario(input, "tiny.json")).toThrow(RangeError);
			expect(messageOf(() => parseScenario(input, "tiny.json"))).toBe(
				"tiny.json: prompts.count must be between 1 and 5000",
			);
		}
	});

	test("rejects an out-of-range concurrency", () => {
		const input = { ...valid(), prompts: { count: 4, concurrency: 129 } };

		expect(messageOf(() => parseScenario(input, "tiny.json"))).toBe(
			"tiny.json: prompts.concurrency must be between 1 and 128",
		);
	});

	test("rejects a bad rule stage", () => {
		const input = {
			...valid(),
			faults: [{ stage: "summarize", effect: { kind: "empty" } }],
		};

		expect(() => parseScenario(input, "tiny.json")).toThrow(TypeError);
		expect(messageOf(() => parseScenario(input, "tiny.json"))).toBe(
			"tiny.json: faults[0].stage must be one of uplift, graph, fill, clarify",
		);
	});

	test("rejects a bad effect kind, an out-of-range status and an unknown invariant", () => {
		const effect = { ...valid(), faults: [{ stage: "fill", effect: { kind: "explode" } }] };
		const status = {
			...valid(),
			faults: [{ stage: "fill", effect: { kind: "error", status: 200 } }],
		};
		const invariant = { ...valid(), invariants: ["terminal", "vibes"] };

		expect(messageOf(() => parseScenario(effect, "tiny.json"))).toContain(
			"faults[0].effect.kind must be one of",
		);
		expect(messageOf(() => parseScenario(status, "tiny.json"))).toBe(
			"tiny.json: faults[0].effect.status must be between 400 and 599",
		);
		expect(messageOf(() => parseScenario(invariant, "tiny.json"))).toContain(
			"invariants[1] must be one of",
		);
	});

	test("accepts every effect, the selectors and a nested delay", () => {
		const scenario = parseScenario(
			{
				...valid(),
				faults: [
					{ stage: "uplift", promptId: 0, effect: { kind: "ok" } },
					{ stage: "graph", promptId: "pl-7-000001", effect: { kind: "garbage", text: "nope" } },
					{ stage: "fill", node: "n2", nth: [1, 2], count: "forever", effect: { kind: "empty" } },
					{ stage: "fill", every: 4, effect: { kind: "error", status: 429, retryAfterSec: 2 } },
					{ stage: "fill", effect: { kind: "network", code: "ECONNRESET" } },
					{ stage: "fill", effect: { kind: "truncate", at: 10 } },
					{ stage: "clarify", effect: { kind: "hang" } },
					{
						stage: "uplift",
						count: 3,
						effect: { kind: "delay", ms: 500, after: { kind: "error", status: 503 } },
					},
				],
			},
			"tiny.json",
		);

		expect(scenario.faults).toHaveLength(8);
		expect(scenario.faults[7]?.effect).toEqual({
			kind: "delay",
			ms: 500,
			after: { kind: "error", status: 503 },
		});
	});

	test("accepts resourceSlackMiB and range-checks it", () => {
		expect(parseScenario({ ...valid(), resourceSlackMiB: 128 }, "tiny.json").resourceSlackMiB).toBe(
			128,
		);
		expect(parseScenario(valid(), "tiny.json").resourceSlackMiB).toBeUndefined();
		for (const resourceSlackMiB of [0, 4097]) {
			expect(messageOf(() => parseScenario({ ...valid(), resourceSlackMiB }, "tiny.json"))).toBe(
				"tiny.json: resourceSlackMiB must be between 1 and 4096",
			);
		}
	});

	test("accepts watchdogMs and allowAborts and range-checks them", () => {
		const scenario = parseScenario(
			{ ...valid(), watchdogMs: 30000, allowAborts: true },
			"tiny.json",
		);

		expect(scenario.watchdogMs).toBe(30000);
		expect(scenario.allowAborts).toBe(true);
		expect(parseScenario(valid(), "tiny.json").watchdogMs).toBeUndefined();
		expect(parseScenario(valid(), "tiny.json").allowAborts).toBeUndefined();
		for (const watchdogMs of [999, 3_600_001]) {
			expect(messageOf(() => parseScenario({ ...valid(), watchdogMs }, "tiny.json"))).toBe(
				"tiny.json: watchdogMs must be between 1000 and 3600000",
			);
		}
		expect(messageOf(() => parseScenario({ ...valid(), allowAborts: "yes" }, "tiny.json"))).toBe(
			"tiny.json: allowAborts must be true or false",
		);
	});

	test("rejects a prompt id that is not a fixed-width nonce", () => {
		const input = {
			...valid(),
			faults: [{ stage: "fill", promptId: "pl-7-1", effect: { kind: "empty" } }],
		};

		expect(messageOf(() => parseScenario(input, "tiny.json"))).toContain(
			"faults[0].promptId must match",
		);
	});

	test("rejects a config whose node bounds are inverted", () => {
		const input = { ...valid(), config: { thinkMinNodes: 8, thinkMaxNodes: 5 } };

		expect(messageOf(() => parseScenario(input, "tiny.json"))).toBe(
			"tiny.json: config.thinkMinNodes must not exceed config.thinkMaxNodes",
		);
	});

	test("no rejection message echoes the offending value", () => {
		const sentinel = "SENTINEL VALUE 4242!";
		const inputs: unknown[] = [
			{ ...valid(), id: sentinel },
			{ ...valid(), title: 987654321 },
			{ ...valid(), failureMode: sentinel },
			{ ...valid(), seed: sentinel },
			{ ...valid(), prompts: { count: 987654321, concurrency: 2 } },
			{ ...valid(), prompts: { count: 4, concurrency: sentinel } },
			{ ...valid(), prompts: { count: 4, concurrency: 2, corpus: [sentinel, 5] } },
			{ ...valid(), faults: [{ stage: sentinel, effect: { kind: "empty" } }] },
			{ ...valid(), faults: [{ stage: "fill", node: sentinel, effect: { kind: "empty" } }] },
			{ ...valid(), faults: [{ stage: "fill", promptId: sentinel, effect: { kind: "empty" } }] },
			{ ...valid(), faults: [{ stage: "fill", effect: { kind: sentinel } }] },
			{ ...valid(), faults: [{ stage: "fill", count: sentinel, effect: { kind: "empty" } }] },
			{ ...valid(), faults: [{ stage: "fill", effect: { kind: "error", status: 987654321 } }] },
			{ ...valid(), pressure: { cpuWorkers: 987654321, duty: 0, memMB: 0 } },
			{ ...valid(), config: { hitl: sentinel } },
			{ ...valid(), invariants: [sentinel] },
			{ ...valid(), baselineOf: sentinel },
		];

		for (const input of inputs) {
			const message = messageOf(() => parseScenario(input, "tiny.json"));
			expect(message).not.toBe("");
			expect(message).not.toContain(sentinel);
			expect(message).not.toContain("987654321");
		}
	});

	test("rejects a non-object document and a non-safe-integer seed", () => {
		expect(messageOf(() => parseScenario([], "tiny.json"))).toBe(
			"tiny.json: scenario must be an object",
		);
		expect(messageOf(() => parseScenario({ ...valid(), seed: 2 ** 60 }, "tiny.json"))).toContain(
			"seed must be",
		);
	});
});

describe("parseScenarios", () => {
	test("reads the five fixtures in file-name order with the D-05 sizes", () => {
		const scenarios = parseScenarios(SCENARIOS);

		expect(scenarios.map((scenario) => scenario.id)).toEqual([
			"nominal",
			"recovery",
			"smoke",
			"spike",
			"stress",
		]);
		const sizes = Object.fromEntries(
			scenarios.map((s) => [s.id, [s.prompts.count, s.prompts.concurrency]]),
		);
		expect(sizes).toEqual({
			smoke: [50, 5],
			nominal: [500, 25],
			stress: [2000, 100],
			spike: [1000, 100],
			recovery: [5, 1],
		});
		for (const scenario of scenarios) {
			expect(scenario.failureMode).toBe("pipeline-load");
			expect(scenario.invariants).toEqual([...INVARIANT_IDS]);
			expect(Number.isSafeInteger(scenario.seed)).toBe(true);
		}
	});

	test("the faulted scenarios carry deterministic fill rules and the recovery points at nominal", () => {
		const byId = new Map(parseScenarios(SCENARIOS).map((scenario) => [scenario.id, scenario]));

		expect(byId.get("smoke")?.faults).toEqual([]);
		expect(byId.get("nominal")?.faults).toEqual([]);
		expect(byId.get("recovery")?.baselineOf).toBe("nominal");
		const stress = byId.get("stress")?.faults ?? [];
		expect(stress.some((rule) => rule.stage === "fill" && rule.every === 4)).toBe(true);
		const withRetryAfter = stress.some(
			(rule) => rule.effect.kind === "error" && rule.effect.retryAfterSec !== undefined,
		);
		expect(withRetryAfter).toBe(true);
		expect((byId.get("spike")?.faults ?? []).length).toBeGreaterThan(0);
	});

	test("reads only .json files, in order, and rejects a duplicate id with the file name", () => {
		const dir = makeTempDir("pipeline-scenarios-", roots);
		writeFileSync(join(dir, "b.json"), JSON.stringify(valid()));
		writeFileSync(join(dir, "a.json"), JSON.stringify({ ...valid(), id: "alpha-run" }));
		writeFileSync(join(dir, "notes.txt"), "ignored");

		expect(parseScenarios(dir).map((scenario) => scenario.id)).toEqual(["alpha-run", "tiny-run"]);

		writeFileSync(join(dir, "c.json"), JSON.stringify(valid()));
		expect(() => parseScenarios(dir)).toThrow(/c\.json: id "tiny-run" duplicates .*b\.json/);
	});

	test("rejects a file that is not JSON by name, without echoing the content", () => {
		const dir = makeTempDir("pipeline-scenarios-", roots);
		writeFileSync(join(dir, "broken.json"), "{ SENTINEL-CONTENT");

		const message = messageOf(() => parseScenarios(dir));

		expect(message).toContain("broken.json: not valid JSON");
		expect(message).not.toContain("SENTINEL-CONTENT");
	});
});

describe("experiments pin", () => {
	test("the hosted-service experiments directory still holds exactly seven templates", () => {
		expect(loadTemplates(EXPERIMENTS)).toHaveLength(7);
		expect(readdirSync(EXPERIMENTS).filter((name) => name.endsWith(".json"))).toHaveLength(7);
	});
});
