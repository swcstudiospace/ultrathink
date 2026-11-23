// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Effort } from "@oh-my-pi/pi-ai";
import { readSession } from "../claude/state.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import {
	createNativeEngineSelector,
	gateStalled,
	persistSessionAnswer,
	restoreSessionAnswer,
	sessionAnswerPath,
} from "./omp.ts";
import type { OmpPlan, OmpPlanRequest } from "./omp.ts";
import type { PlanView } from "./view.ts";
import type { ModelResolution } from "./engine.ts";
import {
	fakeModel,
	fakeRuntime,
	flush,
	isolatedPlanEnv,
	quietConfig,
	recorder,
	reply,
	runChildLifetimeScenario,
	setup,
	stageAnswer,
	tuiCtx,
	userText,
} from "./omp-test.helpers.ts";
import type { OmpTestHarness } from "./omp-test.helpers.ts";
import { planPrompt } from "./plan.ts";
import type { PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

/** Timers the test fires by hand: the race and flight-limit timers arm here instead of on the real clock. */
type ManualTimers = {
	timers: {
		setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
		clearTimeout(handle: NodeJS.Timeout | undefined): void;
	};
	/** Runs the oldest pending timer of `ms`, waiting until the code has armed one. */
	fire: (ms: number) => Promise<void>;
	/** Timers armed and neither fired nor cleared. */
	pending: () => number;
};

function manualTimers(): ManualTimers {
	const armed: Array<{ ms: number; run: () => void; handle: NodeJS.Timeout }> = [];
	const live = new Set<NodeJS.Timeout>();
	const waiting: Array<() => void> = [];
	const timers: ManualTimers["timers"] = {
		setTimeout: (run, ms) => {
			// reason: the port's handle is opaque; the test tracks it by identity and never reads it
			const handle = {} as NodeJS.Timeout;
			armed.push({ ms, run, handle });
			live.add(handle);
			for (const wake of waiting.splice(0)) wake();
			return handle;
		},
		clearTimeout: (handle) => {
			if (handle) live.delete(handle);
		},
	};
	const fire = async (ms: number): Promise<void> => {
		const entry = armed.find((candidate) => live.has(candidate.handle) && candidate.ms === ms);
		if (!entry) {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			await promise;
			return fire(ms);
		}
		live.delete(entry.handle);
		entry.run();
	};
	return { timers, fire, pending: () => live.size };
}

describe("flight lifecycle (D-12)", () => {
	const aside = (content: string) => ({
		message: { customType: "ultrathink-plan", content, display: true, attribution: "agent" },
		options: { deliverAs: "aside" },
	});

	/** A planner whose every flight waits on its own gate and keeps its request and lifetime. */
	function gated() {
		const runs: Array<{
			request: OmpPlanRequest;
			signal: AbortSignal;
			gate: PromiseWithResolvers<string>;
		}> = [];
		const plan = (request: OmpPlanRequest, signal: AbortSignal) => {
			const gate = Promise.withResolvers<string>();
			runs.push({ request, signal, gate });
			return gate.promise;
		};
		return { plan, runs };
	}

	test("the inline race only defers delivery: the flight keeps running and its plan lands as an aside", async () => {
		const planner = gated();
		const { run, sent } = setup(planner.plan, 1);
		expect(await run()).toBeUndefined();
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		planner.runs[0]?.gate.resolve("PLAN");
		await flush();
		expect(sent).toEqual([aside("PLAN")]);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
	});

	test("gate on: an uplift final before the race ends is NOT delivered early; the turn starts at once and only the complete plan follows", async () => {
		const gate = Promise.withResolvers<string>();
		const { run, sent } = setup((request) => {
			request.onUplift?.({ context: "<UPLIFT>u</UPLIFT>" });
			return gate.promise;
		}, 1);
		const held = await run();
		expect(held).toBeUndefined();
		expect(JSON.stringify(held) ?? "").not.toContain("<UPLIFT>");
		const finalPlan =
			"<UPLIFT>u</UPLIFT>\n<CLARIFICATIONS>q</CLARIFICATIONS>\n<GRAPH_OF_THOUGHT>g</GRAPH_OF_THOUGHT>";
		gate.resolve(finalPlan);
		await flush();
		expect(sent).toEqual([aside(finalPlan)]);
	});

	test("gate on: an early uplift whose final plan is empty ends with one advisory aside, never the early text", async () => {
		const gate = Promise.withResolvers<string>();
		const { run, sent } = setup((request) => {
			request.onUplift?.({ context: "<UPLIFT>u</UPLIFT>" });
			return gate.promise;
		}, 1);
		expect(await run()).toBeUndefined();
		gate.resolve("");
		// Up to 3 automatic relaunches settle before the one aside lands; they are microtask-only, so drain until it arrives.
		for (let i = 0; i < 500 && sent.length === 0; i++) await Promise.resolve();
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
		expect(sent).not.toEqual([
			aside(
				gateStalled("the rest of the plan could not be built; the uplifted prompt above stands"),
			),
		]);
	});

	test("gate off: an uplift final before the race ends goes inline now; the whole final plan follows as the one aside", async () => {
		const gate = Promise.withResolvers<string>();
		const { run, sent } = setup(
			(request) => {
				request.onUplift?.({ context: "<UPLIFT>u</UPLIFT>" });
				return gate.promise;
			},
			1,
			{ gate: { enabled: false } },
		);
		expect(await run()).toEqual({
			message: expect.objectContaining({
				customType: "ultrathink-plan",
				content: expect.stringContaining("<UPLIFT>u</UPLIFT>"),
			}),
		});
		const finalPlan =
			"<UPLIFT>u</UPLIFT>\n<CLARIFICATIONS>q</CLARIFICATIONS>\n<GRAPH_OF_THOUGHT>g</GRAPH_OF_THOUGHT>";
		gate.resolve(finalPlan);
		await flush();
		expect(sent).toEqual([aside(finalPlan)]);
	});

	test("gate off: an early uplift whose final plan is empty is released by one advisory aside", async () => {
		const gate = Promise.withResolvers<string>();
		const { run, sent } = setup(
			(request) => {
				request.onUplift?.({ context: "<UPLIFT>u</UPLIFT>" });
				return gate.promise;
			},
			1,
			{ gate: { enabled: false } },
		);
		expect(await run()).toEqual({
			message: expect.objectContaining({ customType: "ultrathink-plan" }),
		});
		gate.resolve("");
		// Up to 3 automatic relaunches settle before the one aside lands; they are microtask-only, so drain until it arrives.
		for (let i = 0; i < 500 && sent.length === 0; i++) await Promise.resolve();
		expect(sent).toEqual([
			aside(
				gateStalled("the rest of the plan could not be built; the uplifted prompt above stands"),
			),
		]);
		expect(sent).not.toEqual([aside(gateStalled("the planner produced no plan"))]);
	});

	test("ULTRATHINK_GATE=off in the environment restores the advisory race", async () => {
		const gate = Promise.withResolvers<string>();
		const { run } = setup(() => gate.promise, 1, {
			env: { read: () => ({ ...process.env, ULTRATHINK_GATE: "off" }) },
		});
		expect(await run()).toBeUndefined();
	});

	test("an activity card is delivered nextTurn with triggerTurn false, so it never steers a running turn or starts one; the aside still carries the plan", async () => {
		// Default delivery (no deliverAs) calls agent.steer while the session streams, which injects into the running turn.
		let progress: ((event: ProgressEvent) => void) | undefined;
		const gate = Promise.withResolvers<string>();
		const { run, sent } = setup((_request, _signal, onEvent) => {
			progress = onEvent;
			return gate.promise;
		}, 1);
		expect(await run()).toBeUndefined();
		progress?.({
			type: "activity",
			at: 2,
			notice: {
				v: 1,
				kind: "resource",
				title: "RAGFlow",
				source: "ragflow",
				outcome: "none",
				count: 0,
			},
		});
		gate.resolve("PLAN");
		await flush();
		expect(sent).toEqual([
			{
				message: expect.objectContaining({ customType: "ultrathink-activity" }),
				options: { deliverAs: "nextTurn", triggerTurn: false },
			},
			aside("PLAN"),
		]);
	});

	test("the deadline releases a deferred prompt even when the native completer never settles", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const never = Promise.withResolvers<AssistantMessage>();
		const called = Promise.withResolvers<void>();
		const rec = recorder(() => {
			called.resolve();
			return never.promise;
		});
		const manual = manualTimers();
		const stopped = Promise.withResolvers<void>();
		let request: OmpPlanRequest | undefined;
		let signal: AbortSignal | undefined;
		const { run, sent } = setup(
			async (flightRequest, flightSignal) => {
				request = flightRequest;
				signal = flightSignal;
				flightSignal.addEventListener("abort", () => stopped.resolve(), { once: true });
				const selected = await createNativeEngineSelector(flightRequest, flightSignal, {
					completeSimple: rec.complete,
					providerDefaults: {},
					...(flightRequest.isCurrent ? { isCurrent: flightRequest.isCurrent } : {}),
				})(
					{
						host: "omp",
						override: { provider: "", model: "" },
						providerDefaults: {},
						engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
					},
					flightSignal,
				);
				if ("skipped" in selected) throw new Error(`unexpected skip: ${selected.skipped}`);
				return { context: await selected.complete("SYSTEM", "USER", flightSignal) };
			},
			1,
			{ maxRunMs: 20, timers: manual.timers },
			{ model: live, ...runtime },
		);
		const racing = run();
		await manual.fire(1);
		// The race expires before the deadline: the turn starts at once and the deadline releases the flight.
		expect(await racing).toBeUndefined();
		await called.promise;
		expect(rec.calls).toHaveLength(1);
		// The deadline is fired by hand once the call is in flight: no real clock decides whether the call was made.
		await manual.fire(20);
		await stopped.promise;
		await flush();
		expect(signal?.aborted).toBe(true);
		expect(request?.isCurrent?.()).toBe(false);
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
		expect(await run()).toBeUndefined();
		expect(rec.calls).toHaveLength(1);
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
	}, 10_000);

	test("deadline delivery and timeout state ignore synchronous abort progress, late progress and a late plan", async () => {
		const t = tuiCtx();
		const gate = Promise.withResolvers<OmpPlan>();
		const stopped = Promise.withResolvers<void>();
		let progress: ((event: ProgressEvent) => void) | undefined;
		const { run, sent, emit } = setup(
			(_request, signal, onEvent) => {
				progress = onEvent;
				onEvent?.({ type: "begin", at: 1, sessionId: "s1", engine: "initial" });
				signal.addEventListener(
					"abort",
					() => {
						onEvent?.({ type: "end", at: 2, outcome: "planned" });
						stopped.resolve();
					},
					{ once: true },
				);
				return gate.promise;
			},
			1,
			{ maxRunMs: 20, now: () => 5_000 },
			t.ctx,
		);
		emit("session_start");
		expect(await run()).toBeUndefined();
		const pendingLine = t.line();
		await stopped.promise;
		await flush();
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
		const timeoutLine = t.line();
		expect(timeoutLine).not.toBe(pendingLine);
		progress?.({ type: "begin", at: 3, sessionId: "s1", engine: "late" });
		progress?.({ type: "stage", at: 4, stage: "think", phase: "start" });
		progress?.({ type: "end", at: 5, outcome: "planned" });
		gate.resolve({ context: "LATE PLAN" });
		await flush();
		expect(t.line()).toBe(timeoutLine);
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
		expect(await run()).toBeUndefined();
	}, 1_000);

	test("a deadline before the inline race returns one advisory result without waiting for the planner", async () => {
		const planner = gated();
		const { run, sent } = setup(planner.plan, 500, { maxRunMs: 5 });
		expect(await run()).toEqual({
			message: aside(gateStalled("the planner produced no plan")).message,
		});
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
		expect(await run()).toBeUndefined();
		planner.runs[0]?.gate.resolve("LATE PLAN");
		await flush();
		expect(sent).toEqual([]);
		expect(planner.runs).toHaveLength(1);
	}, 1_000);

	test("a superseded noncooperative flight cannot send an advisory note at its deadline", async () => {
		const planner = gated();
		const { run, sent } = setup(planner.plan, 1, { maxRunMs: 20 });
		expect(await run("A")).toBeUndefined();
		expect(await run("B")).toBeUndefined();
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		const current = planner.runs[1]!;
		// The newer flight's deadline follows the old one, without a sleep or polling loop.
		if (!current.signal.aborted)
			await new Promise<void>((resolve) =>
				current.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		await flush();
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
		for (const entry of planner.runs) entry.gate.resolve(`LATE ${entry.request.prompt}`);
		await flush();
		expect(sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
	}, 1_000);

	test("a follow-up the planner would skip does not cancel the plan still being built", async () => {
		const planner = gated();
		const { run, sent, emit } = setup(planner.plan, 1);
		await run("Build the big feature with a full graph of thought");
		for (const followUp of ["continue", "ok", "/ultrathink-status"]) {
			emit("turn_start");
			expect(await run(followUp)).toBeUndefined();
		}
		expect(planner.runs).toHaveLength(1);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		planner.runs[0]?.gate.resolve("PLAN A");
		await flush();
		expect(sent).toEqual([aside("PLAN A")]);
	});

	test("a plannable follow-up still supersedes the running plan", async () => {
		const planner = gated();
		const { run, emit } = setup(planner.plan, 1);
		await run("Build the big feature with a full graph of thought");
		emit("turn_start");
		await run("Now also refactor the billing module to remove the legacy invoice path");
		expect(planner.runs.map((entry) => entry.signal.aborted)).toEqual([true, false]);
	});

	test("a newer prompt cancels the superseded flight; its late plan is dropped", async () => {
		const planner = gated();
		const { run, sent, emit } = setup(planner.plan, 1);
		await run("A");
		emit("turn_start");
		await run("B");
		expect(planner.runs.map((entry) => [entry.request.prompt, entry.signal.aborted])).toEqual([
			["A", true],
			["B", false],
		]);
		planner.runs[0]?.gate.resolve("PLAN A");
		await flush();
		expect(sent).toEqual([]);
		planner.runs[1]?.gate.resolve("PLAN B");
		await flush();
		expect(sent).toEqual([aside("PLAN B")]);
	});

	test("same-prompt reentry on an unchanged target reuses the one flight, even through a fresh but equal Model object", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live], { current: () => live });
		const planner = gated();
		const { run } = setup(planner.plan, 1, {}, { ...runtime });
		expect(await run()).toBeUndefined();
		live = { ...live };
		expect(await run()).toBeUndefined();
		expect(planner.runs).toHaveLength(1);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
	});

	for (const [before, after] of [
		["low" as Effort, "high" as Effort],
		["off", undefined],
		[undefined, "low" as Effort],
	] as const) {
		test(`thinking-level reentry ${before} to ${after} cancels and suppresses the old flight`, async () => {
			let level: OmpPlanRequest["thinkingLevel"] = before;
			const planner = gated();
			const { run, sent } = setup(planner.plan, 1, {}, {}, { getThinkingLevel: () => level });
			expect(await run()).toBeUndefined();
			expect(await run()).toBeUndefined();
			expect(planner.runs).toHaveLength(1);
			expect(planner.runs[0]?.request.thinkingLevel).toBe(before);
			level = after;
			expect(await run()).toBeUndefined();
			expect(planner.runs).toHaveLength(2);
			expect(planner.runs[0]?.request.thinkingLevel).toBe(before);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
			expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
			expect(planner.runs[1]?.request.thinkingLevel).toBe(after);
			expect(planner.runs[1]?.signal.aborted).toBe(false);
			planner.runs[0]?.gate.resolve("OLD EFFORT PLAN");
			await flush();
			expect(sent).toEqual([]);
			planner.runs[1]?.gate.resolve("NEW EFFORT PLAN");
			await flush();
			expect(sent).toEqual([aside("NEW EFFORT PLAN")]);
		});
	}

	test("a changed thinking level invalidates a settled inline plan", async () => {
		let level = "low" as Effort;
		const requests: OmpPlanRequest[] = [];
		const { run, sent } = setup(
			async (request) => {
				requests.push(request);
				return `PLAN ${request.thinkingLevel}`;
			},
			1_000,
			{},
			{},
			{ getThinkingLevel: () => level },
		);
		expect(await run()).toMatchObject({ message: { content: "PLAN low" } });
		expect(await run()).toMatchObject({ message: { content: "PLAN low" } });
		level = "high" as Effort;
		expect(await run()).toMatchObject({ message: { content: "PLAN high" } });
		expect(requests.map((request) => request.thinkingLevel)).toEqual([
			"low" as Effort,
			"high" as Effort,
		]);
		expect(sent).toEqual([]);
	});

	test("same-prompt reentry after a model switch cancels and suppresses the old flight and plans on the new model", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([], { current: () => live });
		const planner = gated();
		const { run, sent } = setup(planner.plan, 1, {}, { ...runtime });
		await run();
		live = fakeModel("anthropic", "opus-x");
		expect(await run()).toBeUndefined();
		expect(
			planner.runs.map((entry) => [entry.request.model?.provider, entry.signal.aborted]),
		).toEqual([
			["acme", true],
			["anthropic", false],
		]);
		planner.runs[0]?.gate.resolve("OLD PLAN");
		await flush();
		expect(sent).toEqual([]);
		planner.runs[1]?.gate.resolve("NEW PLAN");
		await flush();
		expect(sent).toEqual([aside("NEW PLAN")]);
	});

	test("the whole Model counts: the same id behind another endpoint or header resolver is another target", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([], { current: () => live });
		const planner = gated();
		const { run } = setup(planner.plan, 1, {}, { ...runtime });
		await run();
		live = { ...live, baseUrl: "https://SECRET-OTHER.invalid/v1" };
		await run();
		expect(planner.runs).toHaveLength(2);
		live = { ...live, resolveHeaders: async () => ({}) };
		await run();
		expect(planner.runs).toHaveLength(3);
		expect(planner.runs.map((entry) => entry.signal.aborted)).toEqual([true, true, false]);
	});

	test("a model switch seen at delivery suppresses both the plan and the no-plan note", async () => {
		for (const answer of ["PLAN", ""]) {
			let live = fakeModel("acme", "sol-1");
			const { runtime } = fakeRuntime([], { current: () => live });
			const planner = gated();
			const { run, sent } = setup(planner.plan, 1, {}, { ...runtime });
			await run();
			live = fakeModel("acme", "sol-2");
			planner.runs[0]?.gate.resolve(answer);
			await flush();
			expect(sent).toEqual([]);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
		}
	});

	test("a changed native override replans the same prompt", async () => {
		let override = { provider: "", model: "" };
		const planner = gated();
		const { run } = setup(planner.plan, 1, {
			config: () =>
				quietConfig((config) => {
					config.models.hosts.omp = override;
				}),
		});
		await run();
		await run();
		expect(planner.runs).toHaveLength(1);
		override = { provider: "acme", model: "opus" };
		await run();
		expect(planner.runs).toHaveLength(2);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[1]?.request.config?.models.hosts.omp).toEqual(override);
	});

	test("an alias the flight resolved is revalidated at reentry: a new target replans", async () => {
		const live = fakeModel("acme", "sol-1");
		let slow = fakeModel("acme", "slow-1");
		const { runtime } = fakeRuntime([live], {
			current: () => live,
			aliases: { "@slow": () => slow },
		});
		const signals: AbortSignal[] = [];
		const gate = Promise.withResolvers<string>();
		const { run } = setup(
			(request, signal) => {
				request.native?.models.resolve("@slow");
				signals.push(signal);
				return gate.promise;
			},
			1,
			{},
			{ ...runtime },
		);
		await run();
		await run();
		expect(signals).toHaveLength(1);
		slow = fakeModel("acme", "slow-2");
		await run();
		expect(signals).toHaveLength(2);
		expect(signals[0]?.aborted).toBe(true);
	});

	test("session switch and shutdown cancel the in-flight flight; nothing is delivered", async () => {
		for (const event of ["session_switch", "session_shutdown"]) {
			const planner = gated();
			const { run, sent, emit } = setup(planner.plan, 1);
			await run();
			emit(event);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
			planner.runs[0]?.gate.resolve("PLAN");
			await flush();
			expect(sent).toEqual([]);
		}
	});

	test("the flight is registered before the planner's first callback", async () => {
		const t = tuiCtx();
		const { run, emit } = setup(
			async (_request, _signal, onEvent) => {
				onEvent?.({ type: "end", at: 1, outcome: "skipped", detail: "precheck-trivial" });
				return { context: "", skipped: "precheck-trivial" };
			},
			1_000,
			{},
			t.ctx,
		);
		emit("session_start");
		expect(await run()).toBeUndefined();
		await flush();
		expect(t.line()).toContain("skipped · precheck-trivial");
	});

	test("isCurrent is the flight's validity: false once its live model changes or a newer prompt replaces it", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([], { current: () => live });
		const planner = gated();
		const { run, emit } = setup(planner.plan, 1, {}, { ...runtime });
		await run("A");
		const first = planner.runs[0]?.request.isCurrent;
		expect(first?.()).toBe(true);
		live = fakeModel("acme", "sol-2");
		expect(first?.()).toBe(false);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		emit("turn_start");
		await run("B");
		const second = planner.runs[1]?.request.isCurrent;
		expect(second?.()).toBe(true);
		emit("turn_start");
		await run("C");
		expect(second?.()).toBe(false);
	});

	for (const event of [
		"agent_start",
		"agent_end",
		"turn_start",
		"turn_end",
		"tool_execution_start",
		"tool_execution_end",
	] as const) {
		for (const change of ["model", "session", "unchanged"] as const) {
			test(`${event} observes ${change} during an uplift-only flight paused on evidence after its final completion (REV15-006)`, async () => {
				const root = mkdtempSync(join(tmpdir(), "ut-omp-observe-"));
				const stateDir = join(root, "state");
				const live = fakeModel("acme", "sol-1");
				const { runtime } = fakeRuntime([live], { current: () => live });
				const config = quietConfig((value) => {
					value.think.enabled = value.hitl.enabled = false;
					value.track.enabled = true;
					value.linear.team = "Team";
				});
				const lookup = Promise.withResolvers<GroundOutcome>();
				const uplifted = Promise.withResolvers<void>();
				const completed = Promise.withResolvers<PlanResponse>();
				const empty: GroundOutcome = { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
				const rec = recorder((call) =>
					reply([{ type: "text", text: stageAnswer(userText(call)).text }]),
				);
				let lifetime: AbortSignal | undefined;
				let lookupSignal: AbortSignal | undefined;
				let tracks = 0;
				let level = "low" as Effort;
				let levelReads = 0;
				const events: ProgressEvent[] = [];
				const { run, emit, sent } = setup(
					async (request, signal, onEvent) => {
						lifetime = signal;
						const response = await planPrompt(
							{
								host: "omp",
								session_id: request.sessionId,
								prompt: request.prompt,
								cwd: request.cwd,
							},
							isolatedPlanEnv(root),
							{
								config: request.config!,
								control: request.control!,
								stateDir,
								signal,
								native: createNativeEngineSelector(request, signal, {
									completeSimple: rec.complete,
									providerDefaults: {},
									isCurrent: request.isCurrent!,
								}),
								ground: ({ signal: evidenceSignal }) => {
									lookupSignal = evidenceSignal;
									return lookup.promise;
								},
								createTracker: () => async () => {
									tracks++;
									return undefined;
								},
								progress: (entry) => {
									events.push(entry);
									onEvent?.(entry);
									if (entry.type === "stage" && entry.stage === "uplift" && entry.phase === "end")
										uplifted.resolve();
								},
							},
						);
						completed.resolve(response);
						return response;
					},
					1,
					{ stateDir, config: () => config },
					{ cwd: root, model: live, ...runtime },
					{
						getThinkingLevel: () => {
							levelReads++;
							return level;
						},
					},
				);
				try {
					expect(await run("add a widget")).toBeUndefined();
					await uplifted.promise;
					expect(rec.calls).toHaveLength(1);
					expect(lookupSignal?.aborted).toBe(false);
					expect(tracks).toBe(0);
					expect(existsSync(stateDir)).toBe(false);
					// A real lifecycle observation has a fresh context; its Model beats the older runtime.current().
					// Thinking is intentionally changed too: AD-5 observes that setting only at reentry.
					level = "high" as Effort;
					emit(
						event,
						{},
						{
							cwd: root,
							...runtime,
							model: change === "model" ? fakeModel("acme", "sol-2") : { ...live },
							sessionManager: { getSessionId: () => (change === "session" ? "s2" : "s1") },
						},
					);
					const abortedAtObservation = lifetime?.aborted;
					const lookupAbortedAtObservation = lookupSignal?.aborted;
					lookup.resolve(empty);
					const response = await completed.promise;
					await flush();
					const invalid = change !== "unchanged";
					expect(tracks).toBe(invalid ? 0 : 1);
					expect(abortedAtObservation).toBe(invalid);
					expect(lookupAbortedAtObservation).toBe(invalid);
					expect(levelReads).toBe(1);
					expect(rec.calls).toHaveLength(1);
					for (const path of ["sessions/s1.json", "sessions/s1.xml", "last.json"])
						expect(existsSync(join(stateDir, path))).toBe(!invalid);
					expect(
						existsSync(stateDir) &&
							readdirSync(stateDir).some((name) => name.startsWith("last-plan.s1")),
					).toBe(!invalid);
					if (invalid) {
						expect(response).toMatchObject({ context: "", skipped: "aborted" });
						expect(
							events.filter(
								(entry) =>
									entry.type === "stage" && (entry.stage === "track" || entry.stage === "state"),
							),
						).toEqual([]);
						expect(sent).toEqual([]);
					} else {
						expect(response.skipped).toBeUndefined();
						expect(response.context).toContain("<BUILD_PROMPT>");
						expect(readSession(stateDir, "s1")?.modelResolution?.modelId).toBe("sol-1");
						expect(sent).toHaveLength(2);
						expect(sent[0]).toMatchObject({ message: { customType: "ultrathink-activity" } });
						expect(sent[1]).toMatchObject({
							message: { content: response.context, customType: "ultrathink-plan" },
							options: { deliverAs: "aside" },
						});
					}
				} finally {
					lookup.resolve(empty);
					emit("session_shutdown");
					rmSync(root, { recursive: true, force: true });
				}
			});
		}
	}
	// Phase 27: unbounded default lifetime. The elapsed proof lives in the child scenario; the matrix
	// here pins cancellation release, handoff ordering, and positive-deadline compatibility.

	/** A stale-but-wellformed selection record for late-resolution delivery suppression. */
	const STALE_RESOLUTION: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		api: "acme-chat",
		provider: "acme",
		modelId: "stale-9",
		modelKnown: true,
		label: "omp-native:acme/stale-9 [detected]",
	};

	/** Drains microtasks until the gated planner records its first run. */
	async function untilStarted(planner: { runs: unknown[] }): Promise<void> {
		for (let i = 0; i < 200 && planner.runs.length === 0; i++) await Promise.resolve();
		expect(planner.runs.length).toBeGreaterThan(0);
	}

	test("unbounded omitted outer survives fired 600001ms with one real plan aside", async () => {
		expect(await runChildLifetimeScenario({ cancelHung: false })).toEqual({
			planAsides: 1,
			nativeCalls: 9,
		});
	}, 120_000);
	const OUTER_CASES: Array<{ name: string; extra: { maxRunMs?: number } }> = [
		{ name: "omitted", extra: {} },
		{ name: "zero", extra: { maxRunMs: 0 } },
	];

	for (const outer of OUTER_CASES) {
		test(`cancel-matrix pre-handoff triggers release silently (${outer.name} outer)`, async () => {
			// Newer prompt as a new turn.
			{
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const startedAt = Date.now();
				const oldPromise = h.run("A");
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				h.emit("turn_start");
				const nextPromise = h.run("B");
				expect(await oldPromise).toBeUndefined();
				expect(Date.now() - startedAt).toBeLessThan(10_000);
				expect(oldGateSettled).toBe(false);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
				expect(planner.runs.map((entry) => entry.request.prompt)).toEqual(["A", "B"]);
				expect(planner.runs[1]?.signal.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Identical resend as a new turn still supersedes.
			{
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const oldPromise = h.run("A");
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				h.emit("turn_start");
				const nextPromise = h.run("A");
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs[1]?.signal.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Accepted quick message: arming alone cancels nothing, the matching run does.
			{
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const oldPromise = h.run("hello");
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				h.command("ultrathink-quick", "hello");
				expect(h.userMessages).toEqual(["hello"]);
				expect(planner.runs[0]?.signal.aborted).toBe(false);
				h.emit("turn_start");
				expect(await h.run("hello")).toBeUndefined();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				await flush();
			}
			// Whole-model, endpoint, and header-resolver identity changes.
			for (const label of ["whole-model", "endpoint", "header-resolver"] as const) {
				let live = fakeModel("acme", "sol-1");
				const { runtime } = fakeRuntime([], { current: () => live });
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, { ...runtime }, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				live =
					label === "whole-model"
						? fakeModel("acme", "sol-2")
						: { ...live, baseUrl: "https://SECRET-OTHER.invalid/v1" };
				if (label === "header-resolver") live = { ...live, resolveHeaders: async () => ({}) };
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[1]?.signal.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Thinking-level change.
			{
				let level: OmpPlanRequest["thinkingLevel"] = "low" as Effort;
				const planner = gated();
				const h = setup(
					planner.plan,
					1_000,
					outer.extra,
					{},
					{ getThinkingLevel: () => level },
					true,
				);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				level = "high" as Effort;
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Native override change.
			{
				let override = { provider: "", model: "" };
				const planner = gated();
				const h = setup(
					planner.plan,
					1_000,
					{
						...outer.extra,
						config: () =>
							quietConfig((config) => {
								config.models.hosts.omp = override;
							}),
					},
					{},
					{},
					true,
				);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				override = { provider: "acme", model: "opus" };
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs[1]?.request.config?.models.hosts.omp).toEqual(override);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Effective engine intent change from auto to a named engine.
			{
				let engine: "auto" | "claude" = "auto";
				const planner = gated();
				const h = setup(
					planner.plan,
					1_000,
					{
						...outer.extra,
						config: () =>
							quietConfig((config) => {
								config.think.engine = engine;
							}),
					},
					{},
					{},
					true,
				);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				engine = "claude";
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Named legacy target change under a named engine.
			{
				let model = "m1";
				const planner = gated();
				const h = setup(
					planner.plan,
					1_000,
					{
						...outer.extra,
						config: () =>
							quietConfig((config) => {
								config.think.engine = "claude";
								config.claude.model = model;
							}),
					},
					{},
					{},
					true,
				);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				model = "m2";
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Resolved alias target change.
			{
				const live = fakeModel("acme", "sol-1");
				let slow = fakeModel("acme", "slow-1");
				const { runtime } = fakeRuntime([live], {
					current: () => live,
					aliases: { "@slow": () => slow },
				});
				const signals: AbortSignal[] = [];
				let calls = 0;
				const gate = Promise.withResolvers<string>();
				const h = setup(
					(request, signal) => {
						signals.push(signal);
						calls++;
						request.native?.models.resolve("@slow");
						return gate.promise;
					},
					1_000,
					outer.extra,
					{ ...runtime },
					{},
					true,
				);
				const oldPromise = h.run();
				for (let i = 0; i < 200 && calls === 0; i++) await Promise.resolve();
				expect(calls).toBe(1);
				let oldGateSettled = false;
				void gate.promise.then(() => {
					oldGateSettled = true;
				});
				slow = fakeModel("acme", "slow-2");
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(calls).toBe(2);
				expect(signals[0]?.aborted).toBe(true);
				expect(signals[1]?.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Session switch and shutdown.
			for (const event of ["session_switch", "session_shutdown"] as const) {
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => {
					oldGateSettled = true;
				});
				h.emit(event);
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				await flush();
			}
		}, 10_000);
	}
	for (const outer of OUTER_CASES) {
		test(`cancel-matrix post-handoff triggers suppress late effects (${outer.name} outer)`, async () => {
			// Newer prompt: the old pending flight stays silent while the successor delivers once.
			{
				const planner = gated();
				const h = setup(planner.plan, 10, outer.extra);
				expect(await h.run("A")).toBeUndefined();
				expect(h.sent).toEqual([]);
				h.emit("turn_start");
				const nextPromise = h.run("B");
				await flush();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				planner.runs[0]?.gate.resolve("LATE A");
				await flush();
				expect(h.sent).toEqual([]);
				expect(await nextPromise).toBeUndefined();
				planner.runs[1]?.gate.resolve("PLAN B");
				await flush();
				expect(h.sent).toEqual([aside("PLAN B")]);
				await flush();
				expect(h.sent).toEqual([aside("PLAN B")]);
				h.emit("session_shutdown");
				await flush();
			}
			// Accepted quick message after pending cancels the old flight with no delivery.
			{
				const planner = gated();
				const h = setup(planner.plan, 10, outer.extra);
				expect(await h.run("takeoff")).toBeUndefined();
				h.command("ultrathink-quick", "takeoff");
				h.emit("turn_start");
				expect(await h.run("takeoff")).toBeUndefined();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				planner.runs[0]?.gate.resolve("LATE TAKEOFF");
				await flush();
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				await flush();
			}
			// Live-model switch after pending: late progress and the late plan stay silent while the successor delivers once.
			{
				let live = fakeModel("acme", "sol-1");
				const { runtime } = fakeRuntime([], { current: () => live });
				const seen: Array<((event: ProgressEvent) => void) | undefined> = [];
				const planner = gated();
				const h = setup(
					(request, signal, onEvent) => {
						seen.push(onEvent);
						return planner.plan(request, signal);
					},
					10,
					outer.extra,
					{ ...runtime },
				);
				expect(await h.run()).toBeUndefined();
				live = fakeModel("acme", "sol-2");
				const nextPromise = h.run();
				await flush();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(seen).toHaveLength(2);
				seen[0]?.({
					type: "begin",
					at: 3,
					sessionId: "s1",
					engine: "late",
					modelResolution: STALE_RESOLUTION,
				});
				seen[0]?.({ type: "stage", at: 4, stage: "think", phase: "start" });
				seen[0]?.({ type: "end", at: 5, outcome: "planned", modelResolution: STALE_RESOLUTION });
				planner.runs[0]?.gate.resolve("LATE PLAN");
				await flush();
				expect(await nextPromise).toBeUndefined();
				planner.runs[1]?.gate.resolve("PLAN B");
				await flush();
				expect(h.sent).toEqual([aside("PLAN B")]);
				h.emit("session_shutdown");
				await flush();
			}
			// Double cancel: two supersessions still deliver only the latest plan.
			{
				const planner = gated();
				const h = setup(planner.plan, 10, outer.extra);
				expect(await h.run("A")).toBeUndefined();
				h.emit("turn_start");
				const runB = h.run("B");
				await flush();
				h.emit("turn_start");
				const runC = h.run("C");
				await flush();
				expect(planner.runs.map((entry) => entry.signal.aborted)).toEqual([true, true, false]);
				expect(await runB).toBeUndefined();
				planner.runs[0]?.gate.resolve("LATE A");
				planner.runs[1]?.gate.resolve("LATE B");
				await flush();
				expect(h.sent).toEqual([]);
				expect(await runC).toBeUndefined();
				planner.runs[2]?.gate.resolve("PLAN C");
				await flush();
				expect(h.sent).toEqual([aside("PLAN C")]);
				h.emit("session_shutdown");
				await flush();
			}
			// Shutdown after pending: a late rejection settles nothing and sends nothing.
			{
				const gate = Promise.withResolvers<string>();
				let progress: ((event: ProgressEvent) => void) | undefined;
				const h = setup(
					(_request, _signal, onEvent) => {
						progress = onEvent;
						return gate.promise;
					},
					10,
					outer.extra,
				);
				expect(await h.run()).toBeUndefined();
				h.emit("session_shutdown");
				progress?.({ type: "stage", at: 9, stage: "think", phase: "start" });
				gate.reject(new Error("late boom"));
				await flush();
				expect(h.sent).toEqual([]);
			}
		}, 10_000);
	}
	test("cancel-matrix post-handoff late progress, results, and rejections stay silent while the successor delivers once", async () => {
		const t = tuiCtx();
		const planner = gated();
		const seen: Array<((event: ProgressEvent) => void) | undefined> = [];
		const h = setup(
			(request, signal, onEvent) => {
				seen.push(onEvent);
				return planner.plan(request, signal);
			},
			10,
			{},
			t.ctx,
		);
		h.emit("session_start");
		expect(await h.run("A")).toBeUndefined();
		h.emit("turn_start");
		const nextPromise = h.run("B");
		expect(await nextPromise).toBeUndefined();
		const successorLine = t.line();
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(seen).toHaveLength(2);
		seen[0]?.({
			type: "begin",
			at: 3,
			sessionId: "s1",
			engine: "late",
			modelResolution: STALE_RESOLUTION,
		});
		seen[0]?.({ type: "stage", at: 4, stage: "think", phase: "start" });
		seen[0]?.({ type: "end", at: 5, outcome: "planned", modelResolution: STALE_RESOLUTION });
		planner.runs[0]?.gate.resolve("LATE A");
		await flush();
		expect(t.line()).toBe(successorLine);
		expect(h.sent).toEqual([]);
		planner.runs[1]?.gate.resolve("PLAN B");
		await flush();
		expect(h.sent).toEqual([aside("PLAN B")]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("cancel-matrix reentrant abort events admit no new planner and schedule no later no-plan", async () => {
		const planner = gated();
		const manual = manualTimers();
		const h = setup(
			(request, signal, onEvent) => {
				if (request.prompt === "A") {
					// Noncooperative old flight: its abort listener synchronously replays its own
					// begin/stage/end through its own sink while its provider gate never settles.
					signal.addEventListener(
						"abort",
						() => {
							onEvent?.({ type: "begin", at: 1, sessionId: "s1", engine: "old" });
							onEvent?.({ type: "stage", at: 2, stage: "think", phase: "start" });
							onEvent?.({ type: "end", at: 3, outcome: "planned" });
						},
						{ once: true },
					);
				}
				return planner.plan(request, signal);
			},
			5,
			{ maxRunMs: 40, timers: manual.timers },
		);
		const oldPromise = h.run("A");
		await untilStarted(planner);
		h.emit("turn_start");
		const nextPromise = h.run("B");
		expect(planner.runs[1]?.request.isCurrent?.()).toBe(true);
		planner.runs[1]?.gate.resolve("PLAN B");
		expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
		expect(planner.runs).toHaveLength(2);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[1]?.signal.aborted).toBe(false);
		expect(planner.runs[1]?.request.isCurrent?.()).toBe(false);
		planner.runs[0]?.gate.resolve("LATE A");
		await flush();
		expect(await oldPromise).toBeUndefined();
		// No flight deadline or race timer is left armed, so no stray timer can admit a planner or deliver a note.
		expect(manual.pending()).toBe(0);
		expect(h.sent).toEqual([]);
		expect(planner.runs).toHaveLength(2);
		expect(planner.runs[1]?.signal.aborted).toBe(false);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("cancel-matrix reentrant host cancel during startup admits no planner and schedules no later no-plan", async () => {
		for (const event of ["session_switch", "session_shutdown"] as const) {
			let h!: OmpTestHarness;
			const planner = gated();
			const manual = manualTimers();
			h = setup(
				(request, signal) => {
					if (request.prompt === "A") {
						// Reentrant startup guard (G2): cancelling A runs this listener synchronously
						// inside B's start, so the host cancel below hits B before its planner/timer.
						signal.addEventListener(
							"abort",
							() => {
								h.emit(event);
							},
							{ once: true },
						);
					}
					return planner.plan(request, signal);
				},
				5,
				{ maxRunMs: 40, timers: manual.timers },
			);
			const oldPromise = h.run("A");
			await untilStarted(planner);
			let oldGateSettled = false;
			void planner.runs[0]?.gate.promise.then(() => {
				oldGateSettled = true;
			});
			h.emit("turn_start");
			const nextPromise = h.run("B");
			expect(await oldPromise).toBeUndefined();
			expect(await nextPromise).toBeUndefined();
			expect(oldGateSettled).toBe(false);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
			expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
			expect(planner.runs).toHaveLength(1);
			await flush();
			expect(planner.runs).toHaveLength(1);
			// The cancelled new flight left no deadline or race timer armed, so none can admit a planner later.
			expect(manual.pending()).toBe(0);
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		}
	}, 10_000);

	test("cancel-matrix cancelled-then-resumed work writes no tracker, state, or carrier rows", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-omp-cancel-fx-"));
		try {
			const stateDir = join(root, "state");
			const live = fakeModel("acme", "sol-1");
			const { runtime } = fakeRuntime([live], { current: () => live });
			const config = quietConfig((value) => {
				value.think.enabled = value.hitl.enabled = false;
				value.track.enabled = true;
				value.linear.team = "Team";
			});
			const lookup = Promise.withResolvers<GroundOutcome>();
			const empty: GroundOutcome = { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
			const firstCall = Promise.withResolvers<void>();
			const rec = recorder((call) => {
				firstCall.resolve();
				return reply([{ type: "text", text: stageAnswer(userText(call)).text }]);
			});
			let tracks = 0;
			const events: ProgressEvent[] = [];
			const oldCompleted = Promise.withResolvers<PlanResponse>();
			// The race is held on the manual timer port and never fired: this test pins cancellation, and the flight's
			// outcome (or the cancel) settles the race first, which clears the timer. Firing it by hand would return the
			// pending note before turn_start, which is valid but not this test's outcome.
			const manual = manualTimers();
			const h = setup(
				async (request, signal, onEvent) => {
					if (request.prompt === "add a widget immediately") return { context: "PLAN B" };
					const response = await planPrompt(
						{
							host: "omp",
							session_id: request.sessionId,
							prompt: request.prompt,
							cwd: request.cwd,
						},
						isolatedPlanEnv(root),
						{
							config: request.config!,
							control: request.control!,
							stateDir,
							signal,
							native: createNativeEngineSelector(request, signal, {
								completeSimple: rec.complete,
								providerDefaults: {},
								isCurrent: request.isCurrent!,
							}),
							ground: () => lookup.promise,
							createTracker: () => async () => {
								tracks++;
								return undefined;
							},
							progress: (entry) => {
								events.push(entry);
								onEvent?.(entry);
							},
						},
					);
					oldCompleted.resolve(response);
					return response;
				},
				60_000,
				{ stateDir, config: () => config, timers: manual.timers },
				{ cwd: root, model: live, ...runtime },
			);
			const oldPromise = h.run("add a widget");
			// The planner reaches its first model call only after a real event-loop turn on Bun 1.2, so await that call itself.
			await firstCall.promise;
			expect(rec.calls).toHaveLength(1);
			h.emit("turn_start");
			const nextPromise = h.run("add a widget immediately");
			expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
			lookup.resolve(empty);
			expect(await oldCompleted.promise).toMatchObject({ context: "", skipped: "aborted" });
			expect(await oldPromise).toBeUndefined();
			await flush();
			expect(tracks).toBe(0);
			expect(
				events.filter(
					(entry) => entry.type === "stage" && (entry.stage === "track" || entry.stage === "state"),
				),
			).toEqual([]);
			for (const path of ["sessions/s1.json", "sessions/s1.xml", "last.json"])
				expect(existsSync(join(stateDir, path))).toBe(false);
			expect(
				existsSync(stateDir)
					? readdirSync(stateDir).filter((name) => name.startsWith("last-plan.s1"))
					: [],
			).toEqual([]);
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);

	test("cancel-matrix empty results retry up to three times, stay quiet before the handoff, and send one did-not-complete aside after", async () => {
		{
			let calls = 0;
			const h = setup(
				async () => {
					calls++;
					return "";
				},
				50,
				{},
			);
			// hardened: explicit notice instead of silence; the empty planner is relaunched up to three times (omp-delivery.test.ts)
			expect(await h.run()).toEqual({
				message: {
					customType: "ultrathink-plan",
					content: gateStalled("the planner produced no plan"),
					display: true,
					attribution: "agent",
				},
			});
			expect(calls).toBe(4);
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		}
		{
			const planner = gated();
			const h = setup(planner.plan, 1, {});
			expect(await h.run()).toBeUndefined();
			planner.runs[0]?.gate.resolve("");
			await flush();
			// hardened: a failed planner is relaunched up to three times; the last relaunch's empty plan carries the notice (omp-delivery.test.ts)
			expect(h.sent).toEqual([]);
			expect(planner.runs).toHaveLength(2);
			planner.runs[1]?.gate.resolve("");
			await flush();
			expect(h.sent).toEqual([]);
			expect(planner.runs).toHaveLength(3);
			planner.runs[2]?.gate.resolve("");
			await flush();
			expect(h.sent).toEqual([]);
			expect(planner.runs).toHaveLength(4);
			planner.runs[3]?.gate.resolve("");
			await flush();
			expect(h.sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
			expect(await h.run()).toBeUndefined();
			expect(planner.runs).toHaveLength(4);
			await flush();
			expect(h.sent).toEqual([aside(gateStalled("the planner produced no plan"))]);
			h.emit("session_shutdown");
			await flush();
		}
		{
			const planner = gated();
			const h = setup(planner.plan, 1, {});
			const oldPromise = h.run("A");
			await untilStarted(planner);
			h.emit("turn_start");
			const nextPromise = h.run("B");
			planner.runs[1]?.gate.resolve("PLAN B");
			expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
			planner.runs[0]?.gate.resolve("");
			await flush();
			expect(await oldPromise).toBeUndefined();
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		}
	}, 10_000);
	test("handoff-ordering completion before the race returns one inline plan with no aside", async () => {
		const planner = gated();
		const h = setup(planner.plan, 50, {});
		const promise = h.run();
		await untilStarted(planner);
		planner.runs[0]?.gate.resolve("PLAN");
		expect(await promise).toMatchObject({ message: { content: "PLAN" } });
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		expect(h.sent).toEqual([]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("handoff-ordering coincident provider-first clears race and returns inline with no aside", async () => {
		const result = await runChildLifetimeScenario({
			cancelHung: false,
			handoffOrder: "provider-first",
		});
		expect(result.planAsides).toBe(0);
		expect(result.nativeCalls).toBe(0);
		const handoff = result.handoff;
		expect(handoff?.order).toBe("provider-first");
		expect(handoff?.dueMs).toBe(25_000);
		expect(handoff?.raceDue).toBe(25_000);
		expect(handoff?.providerDue).toBe(25_000);
		expect(handoff?.raceDue).toBe(handoff?.providerDue);
		expect(handoff?.providerSeq).toBeLessThan(handoff?.raceSeq ?? Number.POSITIVE_INFINITY);
		expect(handoff?.providerFired).toBe(true);
		expect(handoff?.raceFired).toBe(false);
		expect(handoff?.raceCleared).toBe(true);
		expect(handoff?.firedRoles).toEqual(["provider"]);
		expect(handoff?.pending).toBe(false);
		expect(handoff?.inlineContent).toBe("PLAN");
		expect(handoff?.asideContent).toBeNull();
		expect(handoff?.asideCustomType).toBeNull();
		expect(handoff?.asideDeliverAs).toBeNull();
	}, 120_000);

	test("handoff-ordering coincident race-first dispatches race then starts the turn at once; the coincident plan follows as one aside", async () => {
		const result = await runChildLifetimeScenario({
			cancelHung: false,
			handoffOrder: "race-first",
		});
		expect(result.planAsides).toBe(1);
		expect(result.nativeCalls).toBe(0);
		const handoff = result.handoff;
		expect(handoff?.order).toBe("race-first");
		expect(handoff?.dueMs).toBe(25_000);
		expect(handoff?.raceDue).toBe(25_000);
		expect(handoff?.providerDue).toBe(25_000);
		expect(handoff?.raceDue).toBe(handoff?.providerDue);
		expect(handoff?.raceSeq).toBeLessThan(handoff?.providerSeq ?? Number.POSITIVE_INFINITY);
		expect(handoff?.raceFired).toBe(true);
		expect(handoff?.providerFired).toBe(true);
		expect(handoff?.raceCleared).toBe(false);
		expect(handoff?.firedRoles).toEqual(["race", "provider"]);
		expect(handoff?.pending).toBe(true);
		expect(handoff?.inlineContent).toBeNull();
		expect(handoff?.asideContent).toBe("PLAN");
		expect(handoff?.asideCustomType).toBe("ultrathink-plan");
		expect(handoff?.asideDeliverAs).toBe("aside");
	}, 120_000);

	test("handoff-ordering completion after starting at once delivers exactly one aside", async () => {
		const planner = gated();
		const h = setup(planner.plan, 1, {});
		expect(await h.run()).toBeUndefined();
		planner.runs[0]?.gate.resolve("PLAN");
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		expect(await h.run()).toBeUndefined();
		expect(planner.runs).toHaveLength(1);
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("handoff-ordering resolve-then-reenter in the same tick after starting at once keeps one aside", async () => {
		const planner = gated();
		const h = setup(planner.plan, 1, {});
		expect(await h.run()).toBeUndefined();
		planner.runs[0]?.gate.resolve("PLAN");
		expect(await h.run()).toBeUndefined();
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);
	test("positive deadline early completion survives advancement unchanged", async () => {
		const t = tuiCtx();
		let calls = 0;
		let signal: AbortSignal | undefined;
		const manual = manualTimers();
		const h = setup(
			(_request, captured) => {
				calls++;
				signal = captured;
				return Promise.resolve("PLAN");
			},
			5,
			{ maxRunMs: 40, timers: manual.timers },
			t.ctx,
		);
		h.emit("session_start");
		expect(await h.run()).toMatchObject({ message: { content: "PLAN" } });
		expect(calls).toBe(1);
		const line = t.line();
		// The bar's remount, armed by session_start, is the only timer left: fire it so the count isolates the deadline.
		await manual.fire(0);
		expect(manual.pending()).toBe(0);
		await flush();
		expect(t.line()).toBe(line);
		expect(h.sent).toEqual([]);
		expect(signal?.aborted).toBe(false);
		expect(await h.run()).toMatchObject({ message: { content: "PLAN" } });
		expect(calls).toBe(1);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("positive deadline early failure survives advancement unchanged", async () => {
		const t = tuiCtx();
		let calls = 0;
		let signal: AbortSignal | undefined;
		const manual = manualTimers();
		const h = setup(
			(_request, captured) => {
				calls++;
				signal = captured;
				return Promise.reject(new Error("boom"));
			},
			5,
			{ maxRunMs: 40, timers: manual.timers },
			t.ctx,
		);
		h.emit("session_start");
		// hardened: explicit notice instead of silence (omp-delivery.test.ts)
		expect(await h.run()).toEqual({
			message: {
				customType: "ultrathink-plan",
				content: gateStalled("the planner failed: boom"),
				display: true,
				attribution: "agent",
			},
		});
		// hardened: relaunched up to three times before the notice (omp-delivery.test.ts)
		expect(calls).toBe(4);
		const line = t.line();
		// The bar's remount, armed by session_start, is the only timer left: fire it so the count isolates the deadline.
		await manual.fire(0);
		expect(manual.pending()).toBe(0);
		await flush();
		expect(t.line()).toBe(line);
		expect(h.sent).toEqual([]);
		expect(signal?.aborted).toBe(false);
		expect(await h.run()).toBeUndefined();
		// hardened: relaunched up to three times before the notice (omp-delivery.test.ts)
		expect(calls).toBe(4);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("positive deadline early cancellation survives advancement unchanged", async () => {
		const planner = gated();
		const manual = manualTimers();
		const h = setup(planner.plan, 5, { maxRunMs: 40, timers: manual.timers });
		const oldPromise = h.run("A");
		await untilStarted(planner);
		h.emit("turn_start");
		const nextPromise = h.run("B");
		planner.runs[1]?.gate.resolve("PLAN B");
		expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
		planner.runs[0]?.gate.resolve("LATE A");
		await flush();
		expect(await oldPromise).toBeUndefined();
		expect(manual.pending()).toBe(0);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[1]?.signal.aborted).toBe(false);
		expect(h.sent).toEqual([]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("positive deadline provider winning before expiry delivers once with no late no-plan", async () => {
		const planner = gated();
		const manual = manualTimers();
		const h = setup(planner.plan, 1_000, { maxRunMs: 60, timers: manual.timers });
		const promise = h.run();
		await untilStarted(planner);
		planner.runs[0]?.gate.resolve("PLAN");
		expect(await promise).toMatchObject({ message: { content: "PLAN" } });
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		expect(manual.pending()).toBe(0);
		await flush();
		expect(h.sent).toEqual([]);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		expect(planner.runs).toHaveLength(1);
		expect(await h.run()).toMatchObject({ message: { content: "PLAN" } });
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("explicit zero mirrors omitted beyond cutoff", async () => {
		expect(await runChildLifetimeScenario({ maxRunMs: 0, cancelHung: false })).toEqual({
			planAsides: 1,
			nativeCalls: 9,
		});
	}, 120_000);

	test("local native lifetime smoke", async () => {
		expect(await runChildLifetimeScenario({ cancelHung: false })).toEqual({
			planAsides: 1,
			nativeCalls: 9,
		});
		expect(await runChildLifetimeScenario({ cancelHung: true })).toEqual({
			planAsides: 0,
			nativeCalls: 1,
		});
	}, 180_000);

	test("the race timer is armed before the planner's synchronous prefix can run (L6-06)", async () => {
		const manual = manualTimers();
		let pendingAtPlan = -1;
		const { run } = setup(
			() => {
				pendingAtPlan = manual.pending();
				return new Promise<string>(() => undefined);
			},
			1,
			{ timers: manual.timers },
		);
		const racing = run();
		expect(pendingAtPlan).toBeGreaterThanOrEqual(1);
		await manual.fire(1);
		// The race expires: the turn starts at once and the plan follows as the one aside.
		expect(await racing).toBeUndefined();
	});

	test("a rejected aside reads aside-failed, never delivered, and the plan stays deliverable (L6-09)", async () => {
		const t = tuiCtx();
		const gate = Promise.withResolvers<string>();
		// reason: the harness types its API extras as the thinking-level getter only; a rejecting sendMessage replaces its recorder
		const rejecting = {
			sendMessage: () => Promise.reject(new Error("refused")),
		} as unknown as Parameters<typeof setup>[4];
		const { run, emit } = setup(() => gate.promise, 1, {}, t.ctx, rejecting);
		emit("session_start");
		expect(await run()).toBeUndefined();
		gate.resolve("PLAN");
		await flush();
		expect(t.line()).toContain("skipped · aside failed");
		expect(t.line()).not.toContain("delivered");
		// The same submission's next before_agent_start still delivers the plan, inline.
		expect(await run()).toMatchObject({ message: { content: "PLAN" } });
	});
});

/** The Omp completion gate: prompts proceed at once, the plan arrives inline-if-ready else as an aside, validation is advisory-only. */
describe("completion gate (Omp before_agent_start)", () => {
	const SPEC =
		"<SYSTEM_ROLE>r</SYSTEM_ROLE><CONTEXT>c</CONTEXT><SCOPE>s</SCOPE><CONSTRAINTS>k</CONSTRAINTS><ACCEPTANCE_CRITERIA>a</ACCEPTANCE_CRITERIA>";
	/** A complete plan context: a closed spec root with a graph of `nodes` nodes. */
	const planXml = (nodes: number): string =>
		`Ultrathink plan\n<BUILD_PROMPT>${SPEC}<GRAPH_OF_THOUGHT>${Array.from(
			{ length: nodes },
			(_, i) => `<NODE id="n${i + 1}" kind="task" title="t"></NODE>`,
		).join("")}</GRAPH_OF_THOUGHT></BUILD_PROMPT>`;
	const viewOf = (nodes: number): PlanView => ({
		root: "BUILD_PROMPT",
		source: "llm",
		elapsedMs: 1,
		nodes: Array.from({ length: nodes }, (_, i) => ({
			id: `n${i + 1}`,
			title: "t",
			kind: "task",
			wave: 0,
			dependsOn: [],
			steps: [],
		})),
		waves: [Array.from({ length: nodes }, (_, i) => `n${i + 1}`)],
		clarifications: [],
	});
	const planMsg = (content: string, view?: PlanView) => ({
		message: {
			customType: "ultrathink-plan",
			content,
			display: true,
			attribution: "agent",
			...(view ? { details: view } : {}),
		},
	});
	const aside = (content: string) => ({ ...planMsg(content), options: { deliverAs: "aside" } });

	/** A planner whose every flight waits on its own gate and keeps its signal. */
	function slow() {
		const runs: Array<{ signal: AbortSignal; gate: PromiseWithResolvers<string | OmpPlan> }> = [];
		const plan = (_request: OmpPlanRequest, signal: AbortSignal) => {
			const gate = Promise.withResolvers<string | OmpPlan>();
			runs.push({ signal, gate });
			return gate.promise;
		};
		return { plan, runs };
	}

	/** A host with a real modal dialog: each `confirm` stays open until answered or its signal aborts. */
	function dialogCtx(close: "open" | "at-once" = "open") {
		const dialogs: Array<{
			title: string;
			message: string;
			signal: AbortSignal | undefined;
			answer: (value: boolean) => void;
		}> = [];
		const notices: Array<{ text: string; level: string | undefined }> = [];
		const ui = {
			confirm: (title: string, message: string, options?: { signal?: AbortSignal }) => {
				if (close === "at-once") return Promise.resolve(false);
				const { promise, resolve } = Promise.withResolvers<boolean>();
				dialogs.push({ title, message, signal: options?.signal, answer: resolve });
				options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
				return promise;
			},
			notify: (text: string, level?: string) => {
				notices.push({ text, level });
			},
		};
		return { ctx: { hasUI: true, mode: "tui", ui }, dialogs, notices };
	}

	async function until(condition: () => boolean): Promise<void> {
		for (let i = 0; i < 500 && !condition(); i++) await Promise.resolve();
		expect(condition()).toBe(true);
	}

	test("a plan slower than the race starts the turn at once with 0 STOP texts; the complete plan follows as the one aside", async () => {
		const planner = slow();
		const manual = manualTimers();
		const { run, sent } = setup(planner.plan, 1, { timers: manual.timers });
		const running = run();
		await manual.fire(1);
		// No confirm dialog is ever shown and no STOP text is returned: the turn starts at once.
		const started = await running;
		expect(started).toBeUndefined();
		expect(sent).toEqual([]);
		// The planner keeps running; the complete plan is the one aside.
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		planner.runs[0]?.gate.resolve(planXml(2));
		await flush();
		expect(sent).toEqual([aside(planXml(2))]);
	});

	test("a slow plan: the handler returns at once with no dialog, however long planning takes, then the complete plan arrives as the one aside", async () => {
		const planner = slow();
		const manual = manualTimers();
		const host = dialogCtx();
		let clock = 0;
		const { run, sent } = setup(
			planner.plan,
			1,
			{ timers: manual.timers, now: () => clock },
			host.ctx,
		);
		let returned = false;
		const running = Promise.resolve(run()).then((value) => {
			returned = true;
			return value;
		});
		await manual.fire(1);
		// No confirm dialog is ever shown: the handler returns at once.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(host.dialogs).toEqual([]);
		clock += 5 * 60_000;
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(returned).toBe(true);
		expect(await running).toBeUndefined();
		expect(sent).toEqual([]);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		clock += 10 * 60_000;
		planner.runs[0]?.gate.resolve(planXml(2));
		await flush();
		expect(sent).toEqual([aside(planXml(2))]);
	});

	test("there is no Yes path that starts without the plan: the turn starts at once and the flight is not cancelled", async () => {
		const planner = slow();
		const manual = manualTimers();
		const host = dialogCtx();
		const { run, sent } = setup(planner.plan, 1, { timers: manual.timers }, host.ctx);
		let returned = false;
		const running = Promise.resolve(run()).then((value) => {
			returned = true;
			return value;
		});
		await manual.fire(1);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(host.dialogs).toEqual([]);
		expect(returned).toBe(true);
		expect(await running).toBeUndefined();
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		planner.runs[0]?.gate.resolve(planXml(2));
		await flush();
		expect(sent).toEqual([aside(planXml(2))]);
	});

	test("on a dialog-capable host the handler still returns at once: it never falls back to a STOP message", async () => {
		const planner = slow();
		const manual = manualTimers();
		const host = dialogCtx("at-once");
		const { run, sent } = setup(planner.plan, 1, { timers: manual.timers }, host.ctx);
		let returned = false;
		const running = Promise.resolve(run()).then((value) => {
			returned = true;
			return value;
		});
		await manual.fire(1);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(returned).toBe(true);
		expect(await running).toBeUndefined();
		expect(host.dialogs).toEqual([]);
		planner.runs[0]?.gate.resolve(planXml(1));
		await flush();
		expect(sent).toEqual([aside(planXml(1))]);
	});

	test("a newer prompt supersedes the deferred flight: the old turn already started and no dialog was shown", async () => {
		const planner = slow();
		const manual = manualTimers();
		const host = dialogCtx();
		const h = setup(planner.plan, 1, { timers: manual.timers }, host.ctx);
		const first = Promise.resolve(h.run("A"));
		await manual.fire(1);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(host.dialogs).toEqual([]);
		expect(await first).toBeUndefined();
		h.emit("turn_start");
		const second = Promise.resolve(h.run("B"));
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		await manual.fire(1);
		await until(() => planner.runs.length === 2);
		expect(host.dialogs).toEqual([]);
		expect(await second).toBeUndefined();
		planner.runs[1]?.gate.resolve(planXml(1));
		await flush();
		expect(h.sent).toEqual([aside(planXml(1))]);
	});

	test("a failed planner fails open: the turn starts at once with 1 advisory note, never held for a plan that will never come", async () => {
		const { run, sent } = setup(() => Promise.reject(new Error("provider down")), 1_000);
		expect(await run()).toEqual({
			message: {
				customType: "ultrathink-plan",
				content: gateStalled("the planner failed: provider down"),
				display: true,
				attribution: "agent",
			},
		});
		expect(sent).toEqual([]);
	});

	test("a partial plan (fewer nodes than planned) advises and continues: 1 advisory note, no release, and a later prompt never releases it", async () => {
		const view = viewOf(2);
		const { run, sent, emit } = setup(async () => ({ context: planXml(1), view }), 1_000);
		const advisory =
			"Plan note: 1 of 2 nodes. Warning: incomplete-verdict refresh pending. Planning continues automatically under autonomous mode.";
		// Advisory: the prompt-turn message names the shortfall, never the plan text.
		expect(await run()).toEqual(planMsg(advisory));
		await flush();
		expect(sent).toEqual([]);
		expect(JSON.stringify(sent)).not.toContain("SYSTEM_ROLE");
		// A later prompt is a new submission: it advises again, it never releases the partial plan.
		emit("turn_start");
		expect(await run("next")).toEqual(planMsg(advisory));
		await flush();
		expect(sent).toEqual([]);
	});

	test("a cut-off plan is unusable: it yields 1 advisory note and is never injected, and a later prompt does not start with it", async () => {
		const cut = planXml(2).replace("</BUILD_PROMPT>", "");
		const { run, sent, emit } = setup(async () => cut, 1_000);
		const advisory = await run();
		expect(advisory).toEqual({
			message: expect.objectContaining({
				customType: "ultrathink-plan",
				content: gateStalled("plan unusable: the uplift XML root is never closed"),
			}),
		});
		expect(JSON.stringify(advisory)).not.toContain("SYSTEM_ROLE");
		emit("turn_start");
		expect(await run("proceed")).toEqual(advisory);
		expect(sent).toEqual([]);
	});

	test("a partial plan never opens a confirmation: it advises and continues with 0 blocked turns and no dialog", async () => {
		const view = viewOf(2);
		const host = dialogCtx();
		const { run, sent } = setup(async () => ({ context: planXml(1), view }), 1_000, {}, host.ctx);
		const advisory =
			"Plan note: 1 of 2 nodes. Warning: incomplete-verdict refresh pending. Planning continues automatically under autonomous mode.";
		const result = await run();
		expect(result).toEqual(planMsg(advisory));
		expect(advisory).not.toMatch(/\b(STOP|confirm|proceed)\b/i);
		await flush();
		expect(sent).toEqual([]);
		expect(host.dialogs).toEqual([]);
		expect(host.notices).toEqual([]);
	});

	test("AC-71..AC-73: a partial plan that finishes after the turn started advices as the one aside", async () => {
		const planner = slow();
		const host = dialogCtx();
		const view = viewOf(2);
		const { run, sent } = setup(planner.plan, 1, {}, host.ctx);
		expect(await run()).toBeUndefined();
		const advisory =
			"Plan note: 1 of 2 nodes. Warning: incomplete-verdict refresh pending. Planning continues automatically under autonomous mode.";
		planner.runs[0]?.gate.resolve({ context: planXml(1), view });
		await flush();
		expect(sent).toEqual([{ ...planMsg(advisory, view), options: { deliverAs: "aside" } }]);
		expect(JSON.stringify(sent)).not.toMatch(/STOP|confirm|proceed/i);
		expect(host.dialogs).toEqual([]);
	});

	test("the inactivity watchdog fails loudly: the planner is stopped, the user is told, and the turn already started", async () => {
		const planner = slow();
		const race = manualTimers();
		const dog = manualTimers();
		const host = dialogCtx();
		const { run, sent } = setup(
			planner.plan,
			1,
			{ timers: race.timers, gate: { timers: dog.timers } },
			host.ctx,
		);
		const running = Promise.resolve(run());
		await race.fire(1);
		// The handler returned at once, with no dialog shown, and the flight continues in the background.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		expect(host.dialogs).toEqual([]);
		expect(await running).toBeUndefined();
		// The default window is 30 minutes of silence.
		await dog.fire(30 * 60_000);
		const reason = "planning stalled: no progress for 30 min";
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(host.notices).toEqual([{ text: gateStalled(reason), level: "error" }]);
		await flush();
		expect(sent).toEqual([
			{
				message: { content: gateStalled(reason), display: true },
				options: { triggerTurn: false },
			},
			aside(gateStalled(reason)),
		]);
	});

	test("a zero window disables the watchdog: no gate timer is armed", async () => {
		const planner = slow();
		const dog = manualTimers();
		const { run } = setup(planner.plan, 1, { gate: { timers: dog.timers, inactivityMs: 0 } });
		await run();
		expect(dog.pending()).toBe(0);
	});

	/** The 3 settled clarifications (Q1 both transcripts, Q2 shared-state equivalence, Q3 pause-until-completed). */
	const settledClarifications = () => [
		{
			id: "q1",
			question: "Include both transcripts?",
			blocking: true,
			answer: "yes: both transcripts",
		},
		{
			id: "q2",
			question: "Compare over shared state?",
			blocking: true,
			answer: "shared-state equivalence",
		},
		{
			id: "q3",
			question: "Pause until completed?",
			blocking: true,
			answer: "pause until completed",
		},
	];

	test("AC-68: a settled proceed answer persists as ANSWER + kickedOff before delivery", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ac68-"));
		try {
			const stateDir = join(root, "state");
			const settled: PlanView = { ...viewOf(2), clarifications: settledClarifications() };
			const { run } = setup(async () => ({ context: planXml(2), view: settled }), 1_000, {
				stateDir,
			});
			expect(await run()).toEqual(planMsg(planXml(2), settled));
			const file = join(stateDir, "session-answers", "s1.json");
			expect(existsSync(file)).toBe(true);
			const record = JSON.parse(readFileSync(file, "utf8"));
			expect(record.sessionId).toBe("s1");
			expect(record.kickedOff).toBe(true);
			expect(record.answers).toEqual([
				{ questionId: "q1", answer: "yes: both transcripts" },
				{ questionId: "q2", answer: "shared-state equivalence" },
				{ questionId: "q3", answer: "pause until completed" },
			]);
			expect(record.stepBeforeKickoff).toBe(1);
			expect(typeof record.correlationId).toBe("string");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("AC-69: the ordering record is written before the delivery completes", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ac69-"));
		try {
			const stateDir = join(root, "state");
			const settled: PlanView = { ...viewOf(2), clarifications: settledClarifications() };
			const { run } = setup(async () => ({ context: planXml(2), view: settled }), 1_000, {
				stateDir,
			});
			const before = Date.now();
			expect(await run()).toEqual(planMsg(planXml(2), settled));
			const after = Date.now();
			// No flush needed: the write happened synchronously inside delivery, before run() returned.
			const file = join(stateDir, "session-answers", "s1.json");
			expect(existsSync(file)).toBe(true);
			const record = JSON.parse(readFileSync(file, "utf8"));
			const persistedAt = Date.parse(record.persistedAt);
			expect(persistedAt).toBeGreaterThanOrEqual(before - 1_000);
			expect(persistedAt).toBeLessThanOrEqual(after + 1_000);
			expect(record.stepBeforeKickoff).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("AC-70: reload restores kickedOff + the 3 ANSWER with 0 re-ask", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ac70-"));
		try {
			const stateDir = join(root, "state");
			const settled: PlanView = { ...viewOf(2), clarifications: settledClarifications() };
			const first = setup(async () => ({ context: planXml(2), view: settled }), 1_000, {
				stateDir,
			});
			expect(await first.run()).toEqual(planMsg(planXml(2), settled));
			// Reload: a fresh extension instance over the same state dir, planning a view with
			// the same 3 clarifications still open. Nothing is re-asked: no dialog opens and the
			// delivered view carries the restored answers.
			const host = dialogCtx();
			const openView: PlanView = {
				...viewOf(2),
				clarifications: settledClarifications().map((item) => ({ ...item, answer: undefined })),
			};
			const reloaded = setup(
				async () => ({ context: planXml(2), view: openView }),
				1_000,
				{ stateDir },
				host.ctx,
			);
			const result = (await reloaded.run()) as { message: { details: PlanView } };
			expect(result.message.details.clarifications).toEqual(settledClarifications());
			expect(host.dialogs).toEqual([]);
			const file = join(stateDir, "session-answers", "s1.json");
			const record = JSON.parse(readFileSync(file, "utf8"));
			expect(record.kickedOff).toBe(true);
			expect(record.answers).toHaveLength(3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

/** SessionAnswer persistence (W2, M-2026-007): the write/read path of SC-UltrathinkSessionAnswer 1.0.0. */
describe("session answer persistence (W2)", () => {
	const answers = [
		{ questionId: "q1", answer: "yes: both transcripts" },
		{ questionId: "q2", answer: "shared-state equivalence" },
		{ questionId: "q3", answer: "pause until completed" },
	];

	test("persist then restore round-trips kickedOff with all 3 answers", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ans-rt-"));
		try {
			const stored = persistSessionAnswer(root, {
				sessionId: "s1",
				correlationId: "corr-1",
				answers,
				kickedOff: true,
			});
			expect(stored.answers).toEqual(answers);
			expect(stored.kickedOff).toBe(true);
			expect(stored.stepBeforeKickoff).toBe(1);
			expect(stored.persistedAt).toBeTruthy();
			expect(sessionAnswerPath(root, "s1")).toBe(join(root, "session-answers", "s1.json"));
			expect(restoreSessionAnswer(root, "s1")).toEqual(stored);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a missing session restores as undefined: never a guess", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ans-missing-"));
		try {
			expect(restoreSessionAnswer(root, "never-written")).toBeUndefined();
			expect(restoreSessionAnswer(root, "")).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a torn or schema-failing record restores as undefined, never coerced", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ans-torn-"));
		try {
			const path = sessionAnswerPath(root, "s1");
			// Torn file: not JSON.
			mkdirSync(join(root, "session-answers"), { recursive: true });
			writeFileSync(path, "{torn", "utf8");
			expect(restoreSessionAnswer(root, "s1")).toBeUndefined();
			// Unknown key: rejected by the closed schema.
			writeFileSync(
				path,
				JSON.stringify({
					sessionId: "s1",
					correlationId: "corr",
					answers,
					kickedOff: true,
					persistedAt: new Date().toISOString(),
					stepBeforeKickoff: 1,
					extra: "nope",
				}),
				"utf8",
			);
			expect(restoreSessionAnswer(root, "s1")).toBeUndefined();
			// Wrong kickoff step: rejected, never coerced.
			writeFileSync(
				path,
				JSON.stringify({
					sessionId: "s1",
					correlationId: "corr",
					answers,
					kickedOff: true,
					persistedAt: new Date().toISOString(),
					stepBeforeKickoff: 2,
				}),
				"utf8",
			);
			expect(restoreSessionAnswer(root, "s1")).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("invalid input throws without carrying answer text", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ans-invalid-"));
		try {
			expect(() =>
				persistSessionAnswer(root, { sessionId: "", correlationId: "c", answers, kickedOff: true }),
			).toThrow("sessionId must be a non-empty string");
			expect(() =>
				persistSessionAnswer(root, {
					sessionId: "s1",
					correlationId: "",
					answers,
					kickedOff: true,
				}),
			).toThrow("correlationId must be a non-empty string");
			expect(() =>
				persistSessionAnswer(root, {
					sessionId: "s1",
					correlationId: "c",
					answers: [],
					kickedOff: true,
				}),
			).toThrow("answers must hold at least one settled answer");
			expect(() =>
				persistSessionAnswer(root, {
					sessionId: "s1",
					correlationId: "c",
					answers: [{ questionId: "q9", answer: "" }],
					kickedOff: true,
				}),
			).toThrow("every answer must carry a non-empty questionId and answer");
			expect(existsSync(sessionAnswerPath(root, "s1"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a host session id round-trips through its stem", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-ans-stem-"));
		try {
			persistSessionAnswer(root, {
				sessionId: "Claude-A/sub x",
				correlationId: "c",
				answers,
				kickedOff: true,
			});
			expect(restoreSessionAnswer(root, "Claude-A/sub x")?.answers).toEqual(answers);
			expect(restoreSessionAnswer(root, "claude-a-sub x")).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
