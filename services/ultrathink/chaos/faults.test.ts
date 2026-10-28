// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeCompleteOptions } from "../../../src/claude/complete.ts";
import { createPlanBackend, type PlanBackend, PlanCompleterError } from "../engine/plan.ts";
import {
	createFaultyClaude,
	type FaultPlan,
	type FaultStep,
	type FaultyClaudeFactory,
	loadChaosBackend,
	parseFaultPlan,
} from "./faults.ts";

const REPLY = "INNER-REPLY-MARK";
const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "chaos-faults-"));
	roots.push(dir);
	return dir;
}

function plan(...steps: FaultStep[]): FaultPlan {
	return { steps };
}

interface BaseCall {
	bin: string | undefined;
	timeoutMs: number | undefined;
	model: string | undefined;
}

/** A `claude` seam that records what the faulty wrapper hands down and answers at once, with no child process. */
function recordingBase(): { base: FaultyClaudeFactory; calls: BaseCall[] } {
	const calls: BaseCall[] = [];
	return {
		calls,
		base: (opts: Omit<ClaudeCompleteOptions, "signal">) => async () => {
			calls.push({ bin: opts.bin, timeoutMs: opts.timeoutMs, model: opts.model });
			return REPLY;
		},
	};
}

function backendOver(factory: FaultyClaudeFactory, timeoutMs = 5000): PlanBackend {
	return createPlanBackend({
		model: "claude-haiku-5-5",
		fallback: "none",
		concurrency: 2,
		timeoutMs,
		env: { PATH: CHILD_PATH },
		which: () => "claude",
		claude: factory,
	});
}

/** A backend over the faulty seam with a fake base: no child process runs. */
function fakeBackend(faults: FaultPlan): { backend: PlanBackend; calls: BaseCall[] } {
	const { base, calls } = recordingBase();
	const factory = createFaultyClaude(faults, { dir: tempDir(), base });
	return { backend: backendOver(factory), calls };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

/** The rejection as a plan error; fails the test when the call rejected with anything else. */
async function planErrorOf(promise: Promise<unknown>): Promise<PlanCompleterError> {
	const error = await rejectionOf(promise);
	expect(error).toBeInstanceOf(PlanCompleterError);
	return error as PlanCompleterError;
}

function parseErrorOf(json: unknown): unknown {
	try {
		parseFaultPlan(json);
	} catch (error) {
		return error;
	}
	throw new Error("expected parseFaultPlan to throw");
}

describe("createFaultyClaude step sequencing", () => {
	test("status 503 x2 then pass fails twice as upstream, then returns the inner reply; the real child runs once", async () => {
		const { backend, calls } = fakeBackend(
			plan(
				{ count: 2, fault: { kind: "status", status: 503 } },
				{ count: 1, fault: { kind: "pass" } },
			),
		);
		expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("upstream");
		expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("upstream");
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(calls).toHaveLength(1);
	});

	test("exhausted plans pass through to the real child", async () => {
		const { backend, calls } = fakeBackend(
			plan({ count: 1, fault: { kind: "status", status: 500 } }),
		);
		expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("upstream");
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(calls).toHaveLength(2);
	});

	test("a forever step never advances and never reaches the real child", async () => {
		const { backend, calls } = fakeBackend(
			plan({ count: "forever", fault: { kind: "status", status: 502 } }),
		);
		for (let call = 0; call < 5; call += 1) {
			expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("upstream");
		}
		expect(calls).toHaveLength(0);
	});

	test("steps advance across fault kinds in order", async () => {
		const { backend, calls } = fakeBackend(
			plan(
				{ count: 1, fault: { kind: "status", status: 429 } },
				{ count: 1, fault: { kind: "reset" } },
				{ count: 1, fault: { kind: "pass" } },
			),
		);
		expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("rate_limited");
		expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("upstream");
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(calls).toHaveLength(1);
	});

	test("concurrent calls consume units in call order", async () => {
		const { backend } = fakeBackend(plan({ count: 1, fault: { kind: "status", status: 503 } }));
		const first = backend.complete("s", "u");
		const second = backend.complete("s", "u");
		expect((await planErrorOf(first)).code).toBe("upstream");
		expect(await second).toBe(REPLY);
	});

	test("the caller's plan object is copied, so later mutation has no effect", async () => {
		const steps: FaultStep[] = [{ count: 1, fault: { kind: "status", status: 500 } }];
		const { backend } = fakeBackend({ steps });
		steps.push({ count: "forever", fault: { kind: "status", status: 599 } });
		expect((await planErrorOf(backend.complete("s", "u"))).code).toBe("upstream");
		expect(await backend.complete("s", "u")).toBe(REPLY);
	});
});

describe("createFaultyClaude fault kinds", () => {
	const mapping: Array<{
		status: number;
		code: PlanCompleterError["code"];
		failure: PlanCompleterError["failure"];
	}> = [
		{ status: 401, code: "auth", failure: "auth" },
		{ status: 403, code: "auth", failure: "auth" },
		{ status: 402, code: "rate_limited", failure: "billing" },
		{ status: 429, code: "rate_limited", failure: "rate-limit" },
		{ status: 400, code: "upstream", failure: "other" },
		{ status: 500, code: "upstream", failure: "overloaded" },
		{ status: 503, code: "upstream", failure: "overloaded" },
		{ status: 599, code: "upstream", failure: "overloaded" },
	];

	for (const entry of mapping) {
		test(`status ${entry.status} reaches the planner as ${entry.code} of class ${entry.failure} and skips the real child`, async () => {
			const { backend, calls } = fakeBackend(
				plan({ count: 1, fault: { kind: "status", status: entry.status } }),
			);
			const error = await planErrorOf(backend.complete("s", "u"));
			expect(error.code).toBe(entry.code);
			expect(error.failure).toBe(entry.failure);
			expect(calls).toHaveLength(0);
		});
	}

	test("reset reaches the planner as an upstream network failure and skips the real child", async () => {
		const { backend, calls } = fakeBackend(plan({ count: 1, fault: { kind: "reset" } }));
		const error = await planErrorOf(backend.complete("s", "u"));
		expect(error.code).toBe("upstream");
		expect(error.failure).toBe("network");
		expect(calls).toHaveLength(0);
	});

	test("pass hands the backend's own options and the real binary name to the base completer", async () => {
		const { backend, calls } = fakeBackend(plan({ count: 1, fault: { kind: "pass" } }));
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(calls).toEqual([{ bin: "claude", timeoutMs: 5000, model: "claude-haiku-5-5" }]);
	});

	test("pass uses the configured real binary", async () => {
		const { base, calls } = recordingBase();
		const factory = createFaultyClaude(plan({ count: 1, fault: { kind: "pass" } }), {
			dir: tempDir(),
			bin: "/opt/real-claude",
			base,
		});
		expect(await backendOver(factory).complete("s", "u")).toBe(REPLY);
		expect(calls[0]?.bin).toBe("/opt/real-claude");
	});
});

/**
 * The delay faults are shims run by the real completer, so these tests spawn real children and read the real
 * `timeoutMs` kill and the caller's signal. `real` records each start in a marker file, which is how a test proves the
 * real binary was (or was not) reached.
 *
 * The two `Bun.sleep` waits are the rare genuine delays: the kill and the shell live in a real child process that
 * fake timers cannot advance, and each wait observes an absence (nothing settled, no start) that has no event.
 */
describe("createFaultyClaude delay faults inside the timed call", () => {
	function realBinary(dir: string): { bin: string; starts: () => number } {
		const marker = join(dir, "starts");
		const bin = join(dir, "real.sh");
		writeFileSync(bin, `#!/bin/sh\necho started >> '${marker}'\necho '{"result":"${REPLY}"}'\n`, {
			mode: 0o700,
		});
		return {
			bin,
			starts: () =>
				existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0,
		};
	}

	function realBackend(
		faults: FaultPlan,
		timeoutMs: number,
	): { backend: PlanBackend; starts: () => number } {
		const dir = tempDir();
		const real = realBinary(dir);
		const shims = join(dir, "shims");
		mkdirSync(shims);
		const factory = createFaultyClaude(faults, { dir: shims, bin: real.bin });
		return { backend: backendOver(factory, timeoutMs), starts: real.starts };
	}

	test("a pass runs the real binary", async () => {
		const { backend, starts } = realBackend(plan({ count: 1, fault: { kind: "pass" } }), 5000);
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(starts()).toBe(1);
	});

	test("latency 250 ms under a 50 ms deadline times out by the real kill and never reaches the real binary", async () => {
		const { backend, starts } = realBackend(
			plan({ count: 1, fault: { kind: "latency", ms: 250 } }),
			50,
		);
		const error = await planErrorOf(backend.complete("s", "u"));
		expect(error.code).toBe("timeout");
		expect(error.failure).toBe("timeout");
		// Past the whole delay, a leaked shell would have started the real binary by now.
		await Bun.sleep(400);
		expect(starts()).toBe(0);
	});

	test("latency inside the deadline delays, then runs the real binary once", async () => {
		const { backend, starts } = realBackend(
			plan({ count: 1, fault: { kind: "latency", ms: 30 } }),
			5000,
		);
		const began = performance.now();
		expect(await backend.complete("s", "u")).toBe(REPLY);
		expect(performance.now() - began).toBeGreaterThanOrEqual(25);
		expect(starts()).toBe(1);
	});

	test("blackhole under a 50 ms deadline rejects with the real timeout because the child was killed", async () => {
		const { backend, starts } = realBackend(
			plan({ count: "forever", fault: { kind: "blackhole" } }),
			50,
		);
		const error = await planErrorOf(backend.complete("s", "u"));
		expect(error.code).toBe("timeout");
		expect(error.failure).toBe("timeout");
		expect(starts()).toBe(0);
	});

	test("a blackhole with no deadline never answers on its own and ends only by the caller's signal", async () => {
		const { backend } = realBackend(plan({ count: "forever", fault: { kind: "blackhole" } }), 0);
		const controller = new AbortController();
		const outcome = backend.complete("s", "u", controller.signal).then(
			() => "answered",
			(error: unknown) => error,
		);
		// The guard is the test's own clock: a blackhole that timed itself out would settle first.
		const first = await Promise.race([outcome, Bun.sleep(300).then(() => "still pending")]);
		expect(first).toBe("still pending");
		controller.abort();
		const error = await outcome;
		expect(error).toBeInstanceOf(PlanCompleterError);
		expect((error as PlanCompleterError).code).toBe("aborted");
	});

	test("an already-aborted signal ends a delay fault without a timeout", async () => {
		const { backend, starts } = realBackend(
			plan({ count: 1, fault: { kind: "latency", ms: 60_000 } }),
			0,
		);
		const controller = new AbortController();
		controller.abort();
		expect((await planErrorOf(backend.complete("s", "u", controller.signal))).code).toBe("aborted");
		expect(starts()).toBe(0);
	});
});

describe("parseFaultPlan", () => {
	test("accepts the documented example", () => {
		const parsed = parseFaultPlan({
			steps: [{ count: 3, fault: { kind: "status", status: 503 } }],
		});
		expect(parsed).toEqual({ steps: [{ count: 3, fault: { kind: "status", status: 503 } }] });
	});

	test("accepts every fault kind and the range boundaries", () => {
		const parsed = parseFaultPlan({
			steps: [
				{ count: 1, fault: { kind: "pass" } },
				{ count: 1, fault: { kind: "status", status: 400 } },
				{ count: 1, fault: { kind: "status", status: 599 } },
				{ count: 1, fault: { kind: "reset" } },
				{ count: 1, fault: { kind: "blackhole" } },
				{ count: 1, fault: { kind: "latency", ms: 0 } },
				{ count: Number.MAX_SAFE_INTEGER, fault: { kind: "latency", ms: 60000 } },
				{ count: "forever", fault: { kind: "pass" } },
			],
		});
		expect(parsed.steps).toHaveLength(8);
		expect(parsed.steps[7]).toEqual({ count: "forever", fault: { kind: "pass" } });
	});

	test("returns a fresh plan rather than the caller's object", () => {
		const input = { steps: [{ count: 1, fault: { kind: "reset" } }] };
		const parsed = parseFaultPlan(input);
		expect(parsed).not.toBe(input);
		expect(parsed.steps[0]).not.toBe(input.steps[0]);
	});

	const invalid: Array<{
		label: string;
		json: unknown;
		error: new (message?: string) => Error;
		path: string;
	}> = [
		{ label: "empty steps", json: { steps: [] }, error: RangeError, path: "steps" },
		{
			label: "more than 100 steps",
			json: { steps: Array.from({ length: 101 }, () => ({ count: 1, fault: { kind: "pass" } })) },
			error: RangeError,
			path: "steps",
		},
		{
			label: "count 0",
			json: { steps: [{ count: 0, fault: { kind: "pass" } }] },
			error: RangeError,
			path: "steps[0].count",
		},
		{
			label: "count 1.5",
			json: { steps: [{ count: 1.5, fault: { kind: "pass" } }] },
			error: TypeError,
			path: "steps[0].count",
		},
		{
			label: "count above the safe integer range",
			json: { steps: [{ count: 2 ** 60, fault: { kind: "pass" } }] },
			error: RangeError,
			path: "steps[0].count",
		},
		{
			label: "count as a string other than forever",
			json: { steps: [{ count: "3", fault: { kind: "pass" } }] },
			error: TypeError,
			path: "steps[0].count",
		},
		{
			label: "forever before the last step",
			json: {
				steps: [
					{ count: "forever", fault: { kind: "pass" } },
					{ count: 1, fault: { kind: "pass" } },
				],
			},
			error: RangeError,
			path: "steps[0].count",
		},
		{
			label: "status 200",
			json: { steps: [{ count: 1, fault: { kind: "status", status: 200 } }] },
			error: RangeError,
			path: "steps[0].fault.status",
		},
		{
			label: "status 600",
			json: { steps: [{ count: 1, fault: { kind: "status", status: 600 } }] },
			error: RangeError,
			path: "steps[0].fault.status",
		},
		{
			label: "status 503.5",
			json: { steps: [{ count: 1, fault: { kind: "status", status: 503.5 } }] },
			error: TypeError,
			path: "steps[0].fault.status",
		},
		{
			label: "status missing",
			json: { steps: [{ count: 1, fault: { kind: "status" } }] },
			error: TypeError,
			path: "steps[0].fault.status",
		},
		{
			label: "an unknown field on a status fault",
			json: { steps: [{ count: 1, fault: { kind: "status", status: 429, headers: {} } }] },
			error: TypeError,
			path: "steps[0].fault.headers",
		},
		{
			label: "latency ms -1",
			json: { steps: [{ count: 1, fault: { kind: "latency", ms: -1 } }] },
			error: RangeError,
			path: "steps[0].fault.ms",
		},
		{
			label: "latency ms above 60000",
			json: { steps: [{ count: 1, fault: { kind: "latency", ms: 60001 } }] },
			error: RangeError,
			path: "steps[0].fault.ms",
		},
		{
			label: "latency ms missing",
			json: { steps: [{ count: 1, fault: { kind: "latency" } }] },
			error: TypeError,
			path: "steps[0].fault.ms",
		},
		{
			label: "unknown fault kind",
			json: { steps: [{ count: 1, fault: { kind: "explode" } }] },
			error: TypeError,
			path: "steps[0].fault.kind",
		},
		{
			label: "fault without kind",
			json: { steps: [{ count: 1, fault: {} }] },
			error: TypeError,
			path: "steps[0].fault.kind",
		},
		{
			label: "unknown field on a fault",
			json: { steps: [{ count: 1, fault: { kind: "reset", status: 500 } }] },
			error: TypeError,
			path: "steps[0].fault.status",
		},
		{
			label: "unknown field on a step",
			json: { steps: [{ count: 1, fault: { kind: "pass" }, note: "x" }] },
			error: TypeError,
			path: "steps[0].note",
		},
		{
			label: "unknown field on the plan",
			json: { steps: [{ count: 1, fault: { kind: "pass" } }], extra: true },
			error: TypeError,
			path: "plan.extra",
		},
		{ label: "steps not an array", json: { steps: { count: 1 } }, error: TypeError, path: "steps" },
		{ label: "steps missing", json: {}, error: TypeError, path: "steps" },
		{ label: "step not an object", json: { steps: [42] }, error: TypeError, path: "steps[0]" },
		{ label: "plan null", json: null, error: TypeError, path: "plan" },
		{ label: "plan an array", json: [], error: TypeError, path: "plan" },
		{ label: "plan a string", json: "steps", error: TypeError, path: "plan" },
	];

	for (const entry of invalid) {
		test(`rejects ${entry.label} and names ${entry.path}`, () => {
			const error = parseErrorOf(entry.json);
			expect(error).toBeInstanceOf(entry.error);
			expect((error as Error).message).toContain(entry.path);
		});
	}
});

describe("loadChaosBackend", () => {
	const unreadable = (): string => {
		throw new Error("must not read the plan");
	};
	const neverBuilt = (): PlanBackend => {
		throw new Error("must not build the backend");
	};

	test("returns undefined when chaosEnabled is not true, even with a path set, and builds nothing", () => {
		const stateDir = tempDir();
		expect(
			loadChaosBackend(
				{ chaosEnabled: false, chaosPlanPath: "/plans/a.json", stateDir },
				neverBuilt,
				unreadable,
			),
		).toBeUndefined();
		expect(
			loadChaosBackend({ chaosPlanPath: "/plans/a.json", stateDir }, neverBuilt, unreadable),
		).toBeUndefined();
		expect(existsSync(join(stateDir, "chaos-shims"))).toBe(false);
	});

	test("returns undefined when chaos is off and no path is set", () => {
		expect(loadChaosBackend({ stateDir: tempDir() }, neverBuilt, unreadable)).toBeUndefined();
	});

	test("throws when chaos is enabled without a plan path", () => {
		expect(() =>
			loadChaosBackend({ chaosEnabled: true, stateDir: tempDir() }, neverBuilt, unreadable),
		).toThrow("no fault plan path");
	});

	test("reads a valid plan file, hands the faulty seam to the builder and returns its backend", async () => {
		const stateDir = tempDir();
		const path = join(stateDir, "valid.json");
		writeFileSync(
			path,
			JSON.stringify({ steps: [{ count: 1, fault: { kind: "status", status: 503 } }] }),
		);
		let built: PlanBackend | undefined;
		const faulty = loadChaosBackend(
			{ chaosEnabled: true, chaosPlanPath: path, stateDir },
			(claude) => {
				built = backendOver(claude);
				return built;
			},
		);
		expect(faulty).toBe(built);
		expect(existsSync(join(stateDir, "chaos-shims"))).toBe(true);
		expect((await planErrorOf((faulty as PlanBackend).complete("s", "u"))).code).toBe("upstream");
	});

	test("a missing file throws an Error naming the path and the reason, and builds nothing", () => {
		const stateDir = tempDir();
		const path = join(stateDir, "missing.json");
		let thrown: unknown;
		try {
			loadChaosBackend({ chaosEnabled: true, chaosPlanPath: path, stateDir }, neverBuilt);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain(path);
		expect((thrown as Error).message).toContain("ENOENT");
	});

	test("a plan with status 200 throws an Error naming the field and not the plan contents", () => {
		const readText = (): string =>
			JSON.stringify({ steps: [{ count: 1, fault: { kind: "status", status: 200 } }] });
		let thrown: unknown;
		try {
			loadChaosBackend(
				{ chaosEnabled: true, chaosPlanPath: "/plans/bad.json", stateDir: tempDir() },
				neverBuilt,
				readText,
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("/plans/bad.json");
		expect(message).toContain("steps[0].fault.status");
		expect(message).not.toContain('"kind"');
		expect(message).not.toContain('steps":[');
	});

	test("invalid JSON throws an Error that does not echo the file text", () => {
		const readText = (): string => "{not json SECRET-PLAN-MARK";
		let thrown: unknown;
		try {
			loadChaosBackend(
				{ chaosEnabled: true, chaosPlanPath: "/plans/broken.json", stateDir: tempDir() },
				neverBuilt,
				readText,
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("/plans/broken.json");
		expect((thrown as Error).message).not.toContain("SECRET-PLAN-MARK");
	});
});
