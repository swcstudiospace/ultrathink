// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import {
	PLAN_TYPE,
	deliveryOutcomeRows,
	forceInjectedPromptRows,
	forceStopDrainRows,
	orderGateRows,
	raceCheckRows,
	registerUltrathinkRenderers,
} from "./omp-render.ts";
import { buildPlanView, type PlanView } from "./view.ts";
import type { Paint } from "./omp-paint.ts";

type Renderer = Parameters<
	Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]
>[1];

/** Plain-text theme: each colour is a visible tag so rows can be compared as plain text. */
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</>`,
	bg: (color: string, text: string) => `<bg:${color}>${text}</>`,
	bold: (text: string) => `**${text}**`,
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	icon: {},
	status: {},
};

const paint = theme as unknown as Paint;

const renderers: Record<string, Renderer> = {};
registerUltrathinkRenderers({
	registerMessageRenderer: (type, renderer) => void (renderers[type] = renderer),
});
const renderPlan = renderers[PLAN_TYPE] as Renderer;

const base: PlanView = {
	root: "BUILD_PROMPT",
	source: "llm",
	elapsedMs: 65_000,
	nodes: [{ id: "n1", title: "Race fix", kind: "task", wave: 0, dependsOn: [], steps: [] }],
	waves: [["n1"]],
	clarifications: [],
};

/** The expanded plan card's rows for `details`; throws when the renderer declines the view. */
function expandedRows(details: unknown, width = 100): string[] {
	const card = renderPlan({ content: "plan", details }, { expanded: true }, theme);
	if (card === undefined) throw new Error("plan renderer declined the view");
	return [...card.render(width)];
}

describe("SCR-ForceInjectedPrompt", () => {
	test("absent evidence renders no rows (empty state)", () => {
		expect(forceInjectedPromptRows(base, paint)).toEqual([]);
		expect(expandedRows(base).join("\n")).not.toContain("[injected]");
	});

	test("landed prompt renders char count, one TODO entry and one retry line per failure", () => {
		const view: PlanView = {
			...base,
			forceInjected: {
				charCount: 1204,
				todoEntry: "ship force-injection",
				retryLog: ["session busy, retry 1/3"],
			},
		};
		const text = forceInjectedPromptRows(view, paint).join("\n");
		expect(text).toContain("[injected]");
		expect(text).toContain("1204 chars landed · 100%");
		expect(text).toContain("1 updated · ship force-injection");
		expect(text).toContain("[retrying] session busy, retry 1/3");
		expect(text).not.toContain("truncated");
		expect(expandedRows(view).join("\n")).toContain("1204 chars landed");
	});

	test("landed prompt without retry evidence renders no retry line", () => {
		const view: PlanView = {
			...base,
			forceInjected: { charCount: 12, todoEntry: "t", retryLog: [] },
		};
		const rows = forceInjectedPromptRows(view, paint);
		expect(rows).toHaveLength(2);
		expect(rows.join("\n")).not.toContain("[retrying]");
	});
});

describe("SCR-DeliveryOutcome", () => {
	test("absent outcome renders no rows (empty state)", () => {
		expect(deliveryOutcomeRows(base, paint)).toEqual([]);
	});

	test("each closed-set state renders as one named word with its reason", () => {
		for (const state of [
			"injected",
			"retrying",
			"drained",
			"timed-out",
			"dropped-with-reason",
		] as const) {
			const view: PlanView = {
				...base,
				deliveryOutcome: { state, reason: "budget exhausted" },
			};
			const text = deliveryOutcomeRows(view, paint).join("\n");
			expect(text).toContain(`[${state}]`);
			expect(text).toContain("reason: budget exhausted");
		}
	});

	test("dropped-with-reason names the reason in words", () => {
		const view: PlanView = {
			...base,
			deliveryOutcome: { state: "dropped-with-reason", reason: "retry budget ended" },
		};
		expect(deliveryOutcomeRows(view, paint).join("\n")).toContain("reason: retry budget ended");
	});
});

describe("SCR-ForceStopDrain", () => {
	test("absent drain renders no rows (empty state)", () => {
		expect(forceStopDrainRows(base, paint)).toEqual([]);
	});

	test("drained renders elapsed seconds within the 30s bound", () => {
		const view: PlanView = {
			...base,
			forceStop: { state: "drained", elapsedS: 4 },
		};
		const text = forceStopDrainRows(view, paint).join("\n");
		expect(text).toContain("[drained]");
		expect(text).toContain("elapsed:4s within 30s bound");
	});

	test("timed-out renders the elapsed bound in words", () => {
		const view: PlanView = {
			...base,
			forceStop: { state: "timed-out", elapsedS: 30 },
		};
		expect(forceStopDrainRows(view, paint).join("\n")).toContain("[timed-out]");
	});

	test("manual-override renders its one logged reason and never a bare bypass", () => {
		const view: PlanView = {
			...base,
			forceStop: { state: "manual-override", elapsedS: 0, reason: "operator override" },
		};
		const text = forceStopDrainRows(view, paint).join("\n");
		expect(text).toContain("[manual-override]");
		expect(text).toContain("reason: operator override");
	});
});

describe("SCR-OrderGate", () => {
	test("absent gate renders no rows (empty state)", () => {
		expect(orderGateRows(base, paint)).toEqual([]);
	});

	test("held gate renders the uplift → injection confirmed → dispatch banner and the held reason", () => {
		const view: PlanView = {
			...base,
			orderGate: { allowed: false, heldReasons: ["injection not confirmed"] },
		};
		const text = orderGateRows(view, paint).join("\n");
		expect(text).toContain("uplift → injection confirmed → dispatch");
		expect(text).toContain("0 dispatch before injection confirmed");
		expect(text).toContain("[held] injection not confirmed");
	});

	test("confirmed gate renders the confirmation timestamp at or before lane start", () => {
		const view: PlanView = {
			...base,
			orderGate: {
				allowed: true,
				heldReasons: [],
				confirmedAt: "2026-11-23T20:24:00.000Z",
			},
		};
		const text = orderGateRows(view, paint).join("\n");
		expect(text).toContain("dispatch allowed");
		expect(text).toContain("at 2026-11-23T20:24:00.000Z · at or before lane start");
	});

	test("the expanded plan card carries the race sections as words", () => {
		const view: PlanView = {
			...base,
			forceInjected: { charCount: 99, todoEntry: "todo", retryLog: [] },
			deliveryOutcome: { state: "injected" },
			forceStop: { state: "drained", elapsedS: 1 },
			orderGate: { allowed: true, heldReasons: [], confirmedAt: "now" },
			raceChecks: {
				midFlight: { injectedPrompts: 1, lostPlans: 0 },
				newPrompt: { drainedOrchestrations: 1, landedPrompts: 1, drops: 0 },
			},
		};
		const text = expandedRows(view).join("\n");
		expect(text).toContain("[injected]");
		expect(text).toContain("[drained]");
		expect(text).toContain("injection confirmed → dispatch");
		// colour is never the only signal: every state is a bracketed word
		expect(text).toContain("[injected]");
	});
});

describe("SCR-RaceChecks", () => {
	test("absent checks render no rows (empty state)", () => {
		expect(raceCheckRows(base, paint)).toEqual([]);
	});

	test("both scenario lines render as words with the asserted counts", () => {
		const view: PlanView = {
			...base,
			raceChecks: {
				midFlight: { injectedPrompts: 1, lostPlans: 0 },
				newPrompt: { drainedOrchestrations: 1, landedPrompts: 1, drops: 0 },
			},
		};
		const text = raceCheckRows(view, paint).join("\n");
		expect(text).toContain("1 injected · 0 lost");
		expect(text).toContain("1 drained · 1 landed · 0 drops");
	});
});

describe("race projections from the record (defensive, 0 guessing)", () => {
	const recordWith = (extra: Record<string, unknown>) =>
		({
			sessionId: "s1",
			at: 1,
			result: { xml: "<x/>", original: "add", root: "BUILD_PROMPT", source: "llm" },
			graph: { goal: "g", nodes: [] },
			clarifications: [],
			plan: undefined,
			...extra,
		}) as unknown as SessionRecord;

	test("all five race fields project from a well-formed record", () => {
		const view = buildPlanView(
			recordWith({
				forceInjected: { charCount: 5, todoEntry: "t", retryLog: ["r1"] },
				deliveryOutcome: { state: "injected" },
				forceStop: { state: "drained", elapsedS: 2 },
				orderGate: { allowed: true, heldReasons: [], confirmedAt: "now" },
				raceChecks: {
					midFlight: { injectedPrompts: 1, lostPlans: 0 },
					newPrompt: { drainedOrchestrations: 1, landedPrompts: 1, drops: 0 },
				},
			}),
			0,
		);
		expect(view.forceInjected?.charCount).toBe(5);
		expect(view.deliveryOutcome?.state).toBe("injected");
		expect(view.forceStop?.state).toBe("drained");
		expect(view.orderGate?.allowed).toBe(true);
		expect(view.raceChecks?.newPrompt.drops).toBe(0);
	});

	test("malformed race fields project to nothing, never guessed", () => {
		const view = buildPlanView(
			recordWith({
				forceInjected: { charCount: -1, todoEntry: "" },
				deliveryOutcome: { state: "unknown-state" },
				forceStop: { state: "manual-override", elapsedS: 0 },
				orderGate: { allowed: "yes" },
				raceChecks: { midFlight: { injectedPrompts: 1 } },
			}),
			0,
		);
		expect(view).not.toHaveProperty("forceInjected");
		expect(view).not.toHaveProperty("deliveryOutcome");
		// kill-switch bypass without its one logged reason never projects
		expect(view).not.toHaveProperty("forceStop");
		expect(view).not.toHaveProperty("orderGate");
		expect(view).not.toHaveProperty("raceChecks");
	});

	test("dropped-with-reason without a reason never projects", () => {
		const view = buildPlanView(
			recordWith({ deliveryOutcome: { state: "dropped-with-reason" } }),
			0,
		);
		expect(view).not.toHaveProperty("deliveryOutcome");
	});
});
