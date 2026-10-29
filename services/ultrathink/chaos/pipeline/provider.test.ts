// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { isTransientFailure } from "../../../../src/resilience/retry.ts";
import { isFallbackGraph, normalizeGraph, parseNodeFill } from "../../../../src/think/graph.ts";
import { normalizeClarifications } from "../../../../src/hitl/pipeline.ts";
import { isAbortError } from "../../../../src/shared.ts";
import { yieldTurn } from "../../../../src/test.helpers.ts";
import { sanitizeUpliftXml } from "../../../../src/uplift/xml.ts";
import {
	asCompleteSimple,
	createScriptedProvider,
	createVirtualClock,
	type Rule,
} from "./provider.ts";

const SYSTEM = "system prompt";

function upliftPayload(nonce: string, original = "add a widget"): string {
	return `<user_request>\n${original}\n${nonce}\n</user_request>`;
}

function graphPayload(nonce: string): string {
	return `add a widget\n${nonce}\n\n<BUILD_PROMPT><SCOPE>x</SCOPE></BUILD_PROMPT>`;
}

function fillPayload(nonce: string, node = "n3"): string {
	return `<original>add a widget\n${nonce}</original>\n<current_node id="${node}" kind="generate" title="T">Q</current_node>`;
}

function clarifyPayload(nonce: string): string {
	return `<spec>\n<BUILD_PROMPT>add a widget ${nonce}</BUILD_PROMPT>\n</spec>`;
}

/** An injected sleep that records its waits and resolves at once. */
function recordingSleep(): {
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	waits: number[];
} {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms, signal) => {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			waits.push(ms);
		},
	};
}

function statusOf(error: unknown): unknown {
	return typeof error === "object" && error !== null && "status" in error
		? error.status
		: undefined;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

describe("ok replies", () => {
	test("each stage gets a stage-correct valid reply carrying the calling nonce", async () => {
		const provider = createScriptedProvider([], { sleep: recordingSleep().sleep });
		const nonce = "pl-3-000004";

		const uplift = await provider.complete(SYSTEM, upliftPayload(nonce));
		const graph = await provider.complete(SYSTEM, graphPayload(nonce));
		const fill = await provider.complete(SYSTEM, fillPayload(nonce, "n2"));
		const clarify = await provider.complete(SYSTEM, clarifyPayload(nonce));

		const xml = sanitizeUpliftXml(uplift, "add a widget");
		expect(xml).not.toBeNull();
		expect(xml).toContain(nonce);
		const parsed: unknown = JSON.parse(graph);
		const normalized = normalizeGraph(parsed, "add a widget", 5, 8);
		expect(isFallbackGraph(normalized)).toBe(false);
		expect(normalized.goal).toContain(nonce);
		expect(normalized.nodes.length).toBeGreaterThanOrEqual(5);
		expect(normalized.nodes.length).toBeLessThanOrEqual(8);
		const nodeFill = parseNodeFill(fill);
		expect(nodeFill.ok).toBe(true);
		expect(nodeFill.steps.length).toBeGreaterThanOrEqual(5);
		expect(nodeFill.steps.length).toBeLessThanOrEqual(8);
		expect(nodeFill.conclusion).toContain(nonce);
		expect(nodeFill.conclusion).toContain("n2");
		const questions = normalizeClarifications(JSON.parse(clarify), 4);
		expect(questions).toHaveLength(1);
		expect(questions[0]?.question).toContain(nonce);
	});

	test("the node count and step count vary with the seed and the prompt index inside the bounds", async () => {
		const provider = createScriptedProvider([], { seed: 9, nodeRange: [5, 8] });
		const counts = new Set<number>();
		const steps = new Set<number>();
		for (let index = 0; index < 24; index += 1) {
			const nonce = `pl-9-${String(index).padStart(6, "0")}`;
			const graph = normalizeGraph(
				JSON.parse(await provider.complete(SYSTEM, graphPayload(nonce))),
				"x",
				5,
				8,
			);
			counts.add(graph.nodes.length);
			steps.add(parseNodeFill(await provider.complete(SYSTEM, fillPayload(nonce))).steps.length);
		}

		expect([...counts].every((count) => count >= 5 && count <= 8)).toBe(true);
		expect(counts.size).toBeGreaterThan(1);
		expect([...steps].every((count) => count >= 5 && count <= 8)).toBe(true);
		expect(steps.size).toBeGreaterThan(1);
		const again = createScriptedProvider([], { seed: 9, nodeRange: [5, 8] });
		expect(await again.complete(SYSTEM, graphPayload("pl-9-000003"))).toBe(
			await provider.complete(SYSTEM, graphPayload("pl-9-000003")),
		);
	});

	test("the node range seam bounds the graph the provider writes", async () => {
		const provider = createScriptedProvider([], { nodeRange: [6, 6] });

		const raw: unknown = JSON.parse(await provider.complete(SYSTEM, graphPayload("pl-1-000001")));

		expect(normalizeGraph(raw, "x", 6, 6).nodes).toHaveLength(6);
	});
});

describe("effects", () => {
	test("delay waits on the injected sleep, then applies the after effect", async () => {
		const { sleep, waits } = recordingSleep();
		const rules: Rule[] = [
			{ stage: "fill", effect: { kind: "delay", ms: 250, after: { kind: "error", status: 503 } } },
		];
		const provider = createScriptedProvider(rules, { sleep });

		const error = await rejection(provider.complete(SYSTEM, fillPayload("pl-1-000000")));

		expect(waits).toEqual([250]);
		expect(statusOf(error)).toBe(503);
	});

	test("a delay with no follow-up ends in an ok reply", async () => {
		const { sleep, waits } = recordingSleep();
		const provider = createScriptedProvider(
			[{ stage: "uplift", effect: { kind: "delay", ms: 40 } }],
			{ sleep },
		);

		const reply = await provider.complete(SYSTEM, upliftPayload("pl-1-000000"));

		expect(waits).toEqual([40]);
		expect(sanitizeUpliftXml(reply, "add a widget")).not.toBeNull();
	});

	test("a delay is cut short by an abort", async () => {
		const clock = createVirtualClock();
		const provider = createScriptedProvider(
			[{ stage: "graph", effect: { kind: "delay", ms: 5000 } }],
			{ sleep: clock.sleep, now: clock.now },
		);
		const controller = new AbortController();

		const pending = provider.complete(SYSTEM, graphPayload("pl-1-000000"), controller.signal);
		controller.abort();

		expect(isAbortError(await rejection(pending))).toBe(true);
		expect(clock.now()).toBe(0);
		expect(provider.inflight().now).toBe(0);
		expect(provider.calls()[0]?.outcome).toBe("aborted");
	});

	test("error carries status 429 and the retry hint in the vocabulary the kernel classifies", async () => {
		const provider = createScriptedProvider([
			{
				stage: "fill",
				effect: { kind: "error", status: 429, retryAfterSec: 2, message: "slow down" },
			},
		]);

		const error = await rejection(provider.complete(SYSTEM, fillPayload("pl-1-000000")));

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("slow down");
		expect(error).toMatchObject({
			status: 429,
			apiErrorStatus: 429,
			retryAfterSec: 2,
			retryAfter: 2,
		});
		expect(isTransientFailure(error)).toMatchObject({
			transient: true,
			status: 429,
			retryAfterMs: 2000,
		});
		expect(provider.report("pl-1-000000")).toEqual({
			attempts: 1,
			httpStatus: 429,
			retryAfterMs: 2000,
			cause: "slow down",
		});
	});

	test("an error without a status is a plain provider fault", async () => {
		const provider = createScriptedProvider([{ stage: "uplift", effect: { kind: "error" } }]);

		const error = await rejection(provider.complete(SYSTEM, upliftPayload("pl-1-000000")));

		expect((error as Error).message).toBe("provider fault");
		expect(statusOf(error)).toBeUndefined();
	});

	test("network errors carry the socket code", async () => {
		const provider = createScriptedProvider([
			{ stage: "uplift", effect: { kind: "network", code: "ECONNRESET" } },
			{ stage: "graph", effect: { kind: "network", code: "ETIMEDOUT" } },
		]);

		const reset = await rejection(provider.complete(SYSTEM, upliftPayload("pl-1-000000")));
		const timeout = await rejection(provider.complete(SYSTEM, graphPayload("pl-1-000000")));

		expect(reset).toMatchObject({ code: "ECONNRESET" });
		expect(timeout).toMatchObject({ code: "ETIMEDOUT" });
		expect((reset as Error).message).toContain("ECONNRESET");
	});

	test("empty, truncate and garbage replace the reply text", async () => {
		const provider = createScriptedProvider([
			{ stage: "uplift", effect: { kind: "empty" } },
			{ stage: "graph", effect: { kind: "truncate", at: 12 } },
			{ stage: "fill", effect: { kind: "garbage", text: "I cannot help with that" } },
		]);
		const whole = createScriptedProvider([]);

		expect(await provider.complete(SYSTEM, upliftPayload("pl-1-000000"))).toBe("");
		const cut = await provider.complete(SYSTEM, graphPayload("pl-1-000000"));
		expect(cut).toHaveLength(12);
		expect(cut).toBe((await whole.complete(SYSTEM, graphPayload("pl-1-000000"))).slice(0, 12));
		expect(await provider.complete(SYSTEM, fillPayload("pl-1-000000"))).toBe(
			"I cannot help with that",
		);
	});

	test("hang resolves only on abort and rejects with an AbortError", async () => {
		const provider = createScriptedProvider([{ stage: "clarify", effect: { kind: "hang" } }]);
		const controller = new AbortController();

		let settled = false;
		const pending = provider
			.complete(SYSTEM, clarifyPayload("pl-1-000000"), controller.signal)
			.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
		await yieldTurn();
		expect(settled).toBe(false);
		expect(provider.inflight()).toEqual({ now: 1, peak: 1 });

		controller.abort();
		await pending;

		expect(settled).toBe(true);
		expect(provider.inflight()).toEqual({ now: 0, peak: 1 });
	});

	test("a call whose signal is already aborted rejects at once and a hang never arms", async () => {
		const provider = createScriptedProvider([{ stage: "clarify", effect: { kind: "hang" } }]);
		const controller = new AbortController();
		controller.abort();

		const error = await rejection(
			provider.complete(SYSTEM, clarifyPayload("pl-1-000000"), controller.signal),
		);

		expect(isAbortError(error)).toBe(true);
		expect(provider.calls()).toHaveLength(1);
		expect(provider.inflight().now).toBe(0);
	});
});

describe("rule matching and counters", () => {
	test("rules match by stage, node, prompt index or nonce and nth, and count down", async () => {
		const provider = createScriptedProvider([
			{ stage: "fill", node: "n2", promptId: 1, effect: { kind: "empty" }, count: 2 },
			{ stage: "fill", promptId: "pl-5-000003", nth: 2, effect: { kind: "garbage", text: "g" } },
			{ stage: "graph", nth: [2, 3], effect: { kind: "empty" }, count: "forever" },
		]);

		// Node n2 of prompt index 1 fails twice (count 2), then recovers; other nodes and prompts are untouched.
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000001", "n2"))).toBe("");
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000001", "n1"))).not.toBe("");
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000000", "n2"))).not.toBe("");
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000001", "n2"))).toBe("");
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000001", "n2"))).not.toBe("");
		// The nonce selector with nth 2: the second fill call of that prompt only.
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000003", "n1"))).not.toBe("garbage");
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000003", "n1"))).toBe("g");
		expect(await provider.complete(SYSTEM, fillPayload("pl-5-000003", "n1"))).not.toBe("g");
		// nth range 2..3 on graph, forever: calls 1 and 4 pass for the same prompt.
		const graphs = [];
		for (let i = 0; i < 4; i += 1)
			graphs.push(await provider.complete(SYSTEM, graphPayload("pl-5-000007")));
		expect(graphs.map((reply) => reply === "")).toEqual([false, true, true, false]);
	});

	test("every matches the prompts whose index is a multiple, and the first matching rule wins", async () => {
		const provider = createScriptedProvider([
			{ stage: "uplift", every: 4, effect: { kind: "empty" }, count: "forever" },
			{ stage: "uplift", effect: { kind: "garbage", text: "second" }, count: "forever" },
		]);

		const replies: string[] = [];
		for (let index = 0; index < 5; index += 1) {
			replies.push(
				await provider.complete(SYSTEM, upliftPayload(`pl-2-${String(index).padStart(6, "0")}`)),
			);
		}

		expect(replies).toEqual(["", "second", "second", "second", ""]);
	});

	test("quiesce stops every rule", async () => {
		const provider = createScriptedProvider([
			{ stage: "uplift", effect: { kind: "empty" }, count: "forever" },
		]);
		expect(await provider.complete(SYSTEM, upliftPayload("pl-1-000000"))).toBe("");

		provider.quiesce();

		expect(await provider.complete(SYSTEM, upliftPayload("pl-1-000001"))).not.toBe("");
	});

	test("counts are attributed per stage and per prompt, with the node and ordinal", async () => {
		const provider = createScriptedProvider([]);
		await provider.complete(SYSTEM, upliftPayload("pl-1-000000"));
		await provider.complete(SYSTEM, graphPayload("pl-1-000000"));
		await provider.complete(SYSTEM, fillPayload("pl-1-000000", "n1"));
		await provider.complete(SYSTEM, fillPayload("pl-1-000000", "n2"));
		await provider.complete(SYSTEM, upliftPayload("pl-1-000001"));

		expect(provider.byStage("fill")).toHaveLength(2);
		expect(provider.byStage("uplift")).toHaveLength(2);
		expect(provider.byStage("clarify")).toHaveLength(0);
		expect(provider.byPrompt("pl-1-000000").map((call) => call.stage)).toEqual([
			"uplift",
			"graph",
			"fill",
			"fill",
		]);
		expect(provider.byPrompt("pl-1-000001")).toHaveLength(1);
		const fills = provider.byPrompt("pl-1-000000").filter((call) => call.stage === "fill");
		expect(fills.map((call) => [call.node, call.ordinal])).toEqual([
			["n1", 1],
			["n2", 2],
		]);
		expect(provider.calls().map((call) => call.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(provider.calls().every((call) => call.outcome === "ok")).toBe(true);
	});

	test("peak in-flight counts overlapping calls and never goes below zero", async () => {
		const gates: Array<() => void> = [];
		const sleep = (): Promise<void> => new Promise((resolve) => gates.push(resolve));
		const provider = createScriptedProvider(
			[{ stage: "fill", effect: { kind: "delay", ms: 10 }, count: "forever" }],
			{ sleep },
		);

		const calls = [0, 1, 2].map((index) =>
			provider.complete(SYSTEM, fillPayload(`pl-1-${String(index).padStart(6, "0")}`)),
		);
		await yieldTurn();
		expect(provider.inflight()).toEqual({ now: 3, peak: 3 });
		for (const release of gates.splice(0)) release();
		await Promise.all(calls);

		expect(provider.inflight()).toEqual({ now: 0, peak: 3 });
	});

	test("a call with no nonce is attributed to a running index and every foreign nonce is logged", async () => {
		const provider = createScriptedProvider([]);

		await provider.complete(SYSTEM, "<user_request>\nhello\n</user_request>");
		await provider.complete(
			SYSTEM,
			`${graphPayload("pl-1-000000")} and pl-1-000009 and pl-1-000010`,
		);

		const [first, second] = provider.calls();
		expect(first?.key).toBe("call-1");
		expect(first?.index).toBeUndefined();
		expect(second?.key).toBe("pl-1-000000");
		expect(second?.index).toBe(0);
		expect(second?.foreign).toEqual(["pl-1-000009", "pl-1-000010"]);
		expect(first?.foreign).toEqual([]);
	});

	test("every call is stamped with the injected clock", async () => {
		const clock = createVirtualClock(1000);
		const provider = createScriptedProvider(
			[{ stage: "uplift", effect: { kind: "delay", ms: 300 } }],
			{ sleep: clock.sleep, now: clock.now },
		);

		await provider.complete(SYSTEM, upliftPayload("pl-1-000000"));

		const [call] = provider.calls();
		expect(call?.startedAt).toBe(1000);
		expect(call?.endedAt).toBe(1300);
	});
});

describe("wrap and the call cap", () => {
	test("wrap delegates an ok effect to the inner completer and still applies faults", async () => {
		const seen: string[] = [];
		const provider = createScriptedProvider([{ stage: "graph", effect: { kind: "empty" } }]);
		const inner = provider.wrap(async (_system, user) => {
			seen.push(user);
			return "inner reply";
		});

		expect(await inner(SYSTEM, graphPayload("pl-1-000000"))).toBe("");
		expect(await inner(SYSTEM, graphPayload("pl-1-000000"))).toBe("inner reply");
		expect(seen).toHaveLength(1);
		expect(provider.byStage("graph")).toHaveLength(2);
	});

	test("maxCalls refuses further calls without reaching the inner completer", async () => {
		let reached = 0;
		const provider = createScriptedProvider([], { maxCalls: 2 });
		const inner = provider.wrap(async () => {
			reached += 1;
			return "inner reply";
		});

		await inner(SYSTEM, upliftPayload("pl-1-000000"));
		await inner(SYSTEM, upliftPayload("pl-1-000001"));
		const error = await rejection(inner(SYSTEM, upliftPayload("pl-1-000002")));

		expect(reached).toBe(2);
		expect((error as Error).message).toContain("max-calls");
		expect(provider.capped()).toBe(true);
		expect(provider.calls()).toHaveLength(2);
	});
});

describe("asCompleteSimple", () => {
	function context(user: string) {
		return { systemPrompt: [SYSTEM], messages: [{ role: "user", content: user, timestamp: 0 }] };
	}

	test("answers the native call shape with a text block of the scripted reply", async () => {
		const provider = createScriptedProvider([]);
		const complete = asCompleteSimple(provider);

		const message = await complete(
			{} as never,
			context(upliftPayload("pl-1-000000")) as never,
			undefined,
		);

		expect(message.stopReason).toBe("stop");
		const block = message.content[0];
		expect(block?.type).toBe("text");
		const text = block?.type === "text" ? block.text : "";
		expect(sanitizeUpliftXml(text, "add a widget")).not.toBeNull();
		expect(provider.byStage("uplift")).toHaveLength(1);
	});

	test("a scripted failure rejects with its status and reports the Retry-After header", async () => {
		const provider = createScriptedProvider([
			{ stage: "fill", effect: { kind: "error", status: 429, retryAfterSec: 3 } },
		]);
		const complete = asCompleteSimple(provider);
		const responses: Array<{ status: number; headers: Record<string, string> }> = [];

		const error = await rejection(
			complete(
				{} as never,
				context(fillPayload("pl-1-000000")) as never,
				{
					onResponse: (response: { status: number; headers: Record<string, string> }) => {
						responses.push(response);
					},
				} as never,
			),
		);

		expect(statusOf(error)).toBe(429);
		expect(responses).toEqual([{ status: 429, headers: { "retry-after": "3" } }]);
	});

	test("the signal reaches the provider so a hang ends on abort", async () => {
		const provider = createScriptedProvider([{ stage: "graph", effect: { kind: "hang" } }]);
		const complete = asCompleteSimple(provider);
		const controller = new AbortController();

		const pending = rejection(
			complete(
				{} as never,
				context(graphPayload("pl-1-000000")) as never,
				{ signal: controller.signal } as never,
			),
		);
		controller.abort();

		expect(isAbortError(await pending)).toBe(true);
	});
});

describe("createVirtualClock", () => {
	test("sleep advances the clock when it wakes, and an abort leaves it untouched", async () => {
		const clock = createVirtualClock(10);

		await clock.sleep(90);
		expect(clock.now()).toBe(100);

		const controller = new AbortController();
		const pending = rejection(clock.sleep(1000, controller.signal));
		controller.abort();
		expect(isAbortError(await pending)).toBe(true);
		expect(clock.now()).toBe(100);

		const aborted = new AbortController();
		aborted.abort();
		expect(isAbortError(await rejection(clock.sleep(5, aborted.signal)))).toBe(true);
		expect(clock.now()).toBe(100);
	});

	test("a non-positive wait still yields once", async () => {
		const clock = createVirtualClock();

		await clock.sleep(0);
		await clock.sleep(-5);

		expect(clock.now()).toBe(0);
	});
});
