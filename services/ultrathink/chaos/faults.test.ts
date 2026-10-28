// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlanBackend, type PlanCallHooks, PlanCompleterError } from "../engine/plan.ts";
import {
	createFaultyBackend,
	type FaultPlan,
	type FaultStep,
	loadChaosBackend,
	parseFaultPlan,
} from "./faults.ts";

const REPLY = "INNER-REPLY-MARK";

interface Recorded {
	backend: PlanBackend;
	calls: Array<{
		system: string;
		user: string;
		signal: AbortSignal | undefined;
		hooks: PlanCallHooks | undefined;
	}>;
}

/** An inner backend that records calls and answers with a fixed reply. */
function recordingInner(reply: string = REPLY): Recorded {
	const calls: Recorded["calls"] = [];
	return {
		calls,
		backend: {
			label: "plan:claude-haiku-5-5",
			ready: () => ({ ok: true, detail: "inner ready" }),
			async complete(system, user, signal, hooks) {
				calls.push({ system, user, signal, hooks });
				return reply;
			},
		},
	};
}

function plan(...steps: FaultStep[]): FaultPlan {
	return { steps };
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

/** Resolves only when the signal aborts, so a test never waits on wall-clock time. */
const untilSignal = async (_ms: number, signal?: AbortSignal): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted === true) {
		return;
	}
	signal?.addEventListener("abort", () => resolve(), { once: true });
	await promise;
};

describe("createFaultyBackend step sequencing", () => {
	test("status 503 x2 then pass fails twice as upstream, then returns the inner reply; inner is called once", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan(
				{ count: 2, fault: { kind: "status", status: 503 } },
				{ count: 1, fault: { kind: "pass" } },
			),
			inner.backend,
		);
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("upstream");
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("upstream");
		expect(await faulty.complete("s", "u")).toBe(REPLY);
		expect(inner.calls).toHaveLength(1);
	});

	test("exhausted plans pass through to the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "status", status: 500 } }),
			inner.backend,
		);
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("upstream");
		expect(await faulty.complete("s", "u")).toBe(REPLY);
		expect(await faulty.complete("s", "u")).toBe(REPLY);
		expect(inner.calls).toHaveLength(2);
	});

	test("a forever step never advances and never reaches the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: "forever", fault: { kind: "status", status: 502 } }),
			inner.backend,
		);
		for (let call = 0; call < 5; call += 1) {
			expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("upstream");
		}
		expect(inner.calls).toHaveLength(0);
	});

	test("steps advance across fault kinds in order", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan(
				{ count: 1, fault: { kind: "status", status: 429 } },
				{ count: 1, fault: { kind: "reset" } },
				{ count: 1, fault: { kind: "pass" } },
			),
			inner.backend,
		);
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("rate_limited");
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("upstream");
		expect(await faulty.complete("s", "u")).toBe(REPLY);
		expect(inner.calls).toHaveLength(1);
	});

	test("concurrent calls consume units in call order", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "status", status: 503 } }),
			inner.backend,
		);
		const first = faulty.complete("s", "u");
		const second = faulty.complete("s", "u");
		expect((await planErrorOf(first)).code).toBe("upstream");
		expect(await second).toBe(REPLY);
	});

	test("the caller's plan object is copied, so later mutation has no effect", async () => {
		const inner = recordingInner();
		const steps: FaultStep[] = [{ count: 1, fault: { kind: "status", status: 500 } }];
		const faulty = createFaultyBackend({ steps }, inner.backend);
		steps.push({ count: "forever", fault: { kind: "status", status: 599 } });
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("upstream");
		expect(await faulty.complete("s", "u")).toBe(REPLY);
	});
});

describe("createFaultyBackend fault kinds", () => {
	const mapping: Array<{
		status: number;
		code: PlanCompleterError["code"];
		failure: PlanCompleterError["failure"];
	}> = [
		{ status: 401, code: "auth", failure: "auth" },
		{ status: 403, code: "auth", failure: "auth" },
		{ status: 429, code: "rate_limited", failure: "rate-limit" },
		{ status: 400, code: "upstream", failure: "other" },
		{ status: 500, code: "upstream", failure: "unavailable" },
		{ status: 503, code: "upstream", failure: "unavailable" },
		{ status: 599, code: "upstream", failure: "unavailable" },
	];

	for (const entry of mapping) {
		test(`status ${entry.status} throws a ${entry.code} plan error of class ${entry.failure} and skips the inner backend`, async () => {
			const inner = recordingInner();
			const faulty = createFaultyBackend(
				plan({ count: 1, fault: { kind: "status", status: entry.status } }),
				inner.backend,
			);
			const error = await planErrorOf(faulty.complete("s", "u"));
			expect(error.code).toBe(entry.code);
			expect(error.failure).toBe(entry.failure);
			expect(inner.calls).toHaveLength(0);
		});
	}

	test("reset throws an upstream plan error and does not call the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(plan({ count: 1, fault: { kind: "reset" } }), inner.backend);
		const error = await planErrorOf(faulty.complete("s", "u"));
		expect(error.code).toBe("upstream");
		expect(error.failure).toBe("network");
		expect(inner.calls).toHaveLength(0);
	});

	test("label and ready delegate to the inner backend", () => {
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "reset" } }),
			recordingInner().backend,
		);
		expect(faulty.label).toBe("plan:claude-haiku-5-5");
		expect(faulty.ready()).toEqual({ ok: true, detail: "inner ready" });
	});

	test("pass forwards the prompt, the signal and the hooks to the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(plan({ count: 1, fault: { kind: "pass" } }), inner.backend);
		const controller = new AbortController();
		const hooks: PlanCallHooks = { maxOutputTokens: 7 };
		expect(await faulty.complete("sys", "usr", controller.signal, hooks)).toBe(REPLY);
		expect(inner.calls).toEqual([{ system: "sys", user: "usr", signal: controller.signal, hooks }]);
	});

	test("blackhole with neither a signal nor a timeout rejects at once and does not call the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "blackhole" } }),
			inner.backend,
		);
		const error = await rejectionOf(faulty.complete("s", "u"));
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(PlanCompleterError);
		expect((error as Error).message).toContain("timeoutMs");
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole rejects with an aborted plan error when the caller's signal aborts", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "blackhole" } }),
			inner.backend,
		);
		const controller = new AbortController();
		const pending = faulty.complete("s", "u", controller.signal);
		controller.abort();
		const error = await planErrorOf(pending);
		expect(error.code).toBe("aborted");
		expect(error.failure).toBe("aborted");
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole with an already-aborted signal rejects with an aborted plan error", async () => {
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "blackhole" } }),
			recordingInner().backend,
		);
		const controller = new AbortController();
		controller.abort();
		expect((await planErrorOf(faulty.complete("s", "u", controller.signal))).code).toBe("aborted");
	});

	test("blackhole with a backend timeout waits through the injected sleep, then rejects as a timeout", async () => {
		const inner = recordingInner();
		const sleeps: Array<{ ms: number; signal: AbortSignal | undefined }> = [];
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "blackhole" } }),
			inner.backend,
			{
				timeoutMs: 50,
				sleep: async (ms, signal) => {
					sleeps.push({ ms, signal });
				},
			},
		);
		const controller = new AbortController();
		const error = await planErrorOf(faulty.complete("s", "u", controller.signal));
		expect(error.code).toBe("timeout");
		expect(error.failure).toBe("timeout");
		expect(sleeps).toEqual([{ ms: 50, signal: controller.signal }]);
		expect(inner.calls).toHaveLength(0);
	});

	test("blackhole with a backend timeout needs no signal", async () => {
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "blackhole" } }),
			recordingInner().backend,
			{ timeoutMs: 50, sleep: async () => undefined },
		);
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("timeout");
	});

	test("a caller abort that lands before the backend timeout is aborted, not a timeout", async () => {
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "blackhole" } }),
			recordingInner().backend,
			{ timeoutMs: 60_000, sleep: untilSignal },
		);
		const controller = new AbortController();
		const pending = faulty.complete("s", "u", controller.signal);
		controller.abort();
		expect((await planErrorOf(pending)).code).toBe("aborted");
	});

	test("blackhole under a 20 ms backend timeout is a timeout on the real clock", async () => {
		const faulty = createFaultyBackend(
			plan({ count: "forever", fault: { kind: "blackhole" } }),
			recordingInner().backend,
			{ timeoutMs: 20 },
		);
		expect((await planErrorOf(faulty.complete("s", "u"))).code).toBe("timeout");
	});

	test("latency waits through the injected sleep with the fault's ms and then forwards to the inner backend", async () => {
		const inner = recordingInner();
		const sleeps: Array<{ ms: number; signal: AbortSignal | undefined }> = [];
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "latency", ms: 250 } }),
			inner.backend,
			{
				sleep: async (ms, signal) => {
					sleeps.push({ ms, signal });
				},
			},
		);
		const controller = new AbortController();
		expect(await faulty.complete("s", "u", controller.signal)).toBe(REPLY);
		expect(sleeps).toEqual([{ ms: 250, signal: controller.signal }]);
		expect(inner.calls).toHaveLength(1);
	});

	test("latency aborted by the caller rejects with an aborted plan error and does not call the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "latency", ms: 60_000 } }),
			inner.backend,
			{ sleep: untilSignal },
		);
		const controller = new AbortController();
		const pending = faulty.complete("s", "u", controller.signal);
		controller.abort();
		expect((await planErrorOf(pending)).code).toBe("aborted");
		expect(inner.calls).toHaveLength(0);
	});

	test("latency with an already-aborted signal rejects with an aborted plan error without calling the inner backend", async () => {
		const inner = recordingInner();
		const faulty = createFaultyBackend(
			plan({ count: 1, fault: { kind: "latency", ms: 0 } }),
			inner.backend,
			{ sleep: async () => undefined },
		);
		const controller = new AbortController();
		controller.abort();
		expect((await planErrorOf(faulty.complete("s", "u", controller.signal))).code).toBe("aborted");
		expect(inner.calls).toHaveLength(0);
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
	const inner = recordingInner().backend;

	test("returns undefined when chaosEnabled is not true, even with a path set", () => {
		expect(
			loadChaosBackend({ chaosEnabled: false, chaosPlanPath: "/plans/a.json" }, inner, unreadable),
		).toBeUndefined();
		expect(loadChaosBackend({ chaosPlanPath: "/plans/a.json" }, inner, unreadable)).toBeUndefined();
	});

	test("returns undefined when chaos is off and no path is set", () => {
		expect(loadChaosBackend({}, inner, unreadable)).toBeUndefined();
	});

	test("throws when chaos is enabled without a plan path", () => {
		expect(() => loadChaosBackend({ chaosEnabled: true }, inner, unreadable)).toThrow(
			"no fault plan path",
		);
	});

	describe("with a real temp directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "chaos-faults-"));
		afterAll(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		test("reads a valid plan file and returns a backend that applies its first step", async () => {
			const path = join(dir, "valid.json");
			writeFileSync(
				path,
				JSON.stringify({ steps: [{ count: 1, fault: { kind: "status", status: 503 } }] }),
			);
			const faulty = loadChaosBackend({ chaosEnabled: true, chaosPlanPath: path }, inner);
			expect(faulty?.label).toBe(inner.label);
			expect(faulty).toBeDefined();
			expect((await planErrorOf((faulty as PlanBackend).complete("s", "u"))).code).toBe("upstream");
		});

		test("a missing file throws an Error naming the path and the reason", () => {
			const path = join(dir, "missing.json");
			let thrown: unknown;
			try {
				loadChaosBackend({ chaosEnabled: true, chaosPlanPath: path }, inner);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toContain(path);
			expect((thrown as Error).message).toContain("ENOENT");
		});
	});

	test("modelTimeoutMs becomes the blackhole timeout", async () => {
		const readText = (): string =>
			JSON.stringify({ steps: [{ count: "forever", fault: { kind: "blackhole" } }] });
		const faulty = loadChaosBackend(
			{ chaosEnabled: true, chaosPlanPath: "/plans/hole.json", modelTimeoutMs: 20 },
			inner,
			readText,
		);
		expect(faulty).toBeDefined();
		expect((await planErrorOf((faulty as PlanBackend).complete("s", "u"))).code).toBe("timeout");
	});

	test("a plan with status 200 throws an Error naming the field and not the plan contents", () => {
		const readText = (): string =>
			JSON.stringify({ steps: [{ count: 1, fault: { kind: "status", status: 200 } }] });
		let thrown: unknown;
		try {
			loadChaosBackend({ chaosEnabled: true, chaosPlanPath: "/plans/bad.json" }, inner, readText);
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
				{ chaosEnabled: true, chaosPlanPath: "/plans/broken.json" },
				inner,
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
