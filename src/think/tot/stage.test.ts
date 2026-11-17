// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../../config.ts";
import { ROUTE_DEFAULT_MODELS } from "../../route-defaults.ts";
import type { ToolCaller } from "../../track/create.ts";
import type { IssueRef, TrackingRefs, TrackPlan } from "../../track/types.ts";
import type { PrdRequest, ProjectFacts } from "./index.ts";
import {
	injectPrdXml,
	type PrdOutcome,
	runTotStage,
	type TotSeams,
	totEnabled,
	totRequests,
} from "./stage.ts";

type StageInput = Parameters<typeof runTotStage>[0];

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(homedir(), prefix));
	made.push(dir);
	return dir;
}

const FACTS: ProjectFacts = {
	root: "/repo",
	files: new Set(["src/app.ts"]),
	dirs: new Set(["src"]),
	symbols: new Map([["runApp", ["src/app.ts"]]]),
	truncated: false,
	denied: 0,
};

function plan(steps: number): TrackPlan {
	const subIssues = Array.from({ length: steps }, (_, i) => ({
		graphId: "ut-g1",
		nodeId: "n1",
		item: `[n1] Step ${i + 1}: do ${i + 1}`,
		step: i + 1,
		thought: `Do thing ${i + 1}`,
	}));
	return {
		graphId: "ut-g1",
		task: {
			graphId: "ut-g1",
			item: "task",
			description: "task",
			upliftedPrompt: "task",
			agent: "test",
			status: "open",
			linearState: "Todo",
		},
		issues: [{ graphId: "ut-g1", nodeId: "n1", item: "[n1] Node", thought: "t" }],
		subIssues,
		linearIssues: [{ nodeId: "n1", title: "Node", description: "d" }],
		linearSubIssues: subIssues.map((sub) => ({
			nodeId: "n1",
			step: sub.step,
			title: `Node — Step ${sub.step}`,
			description: sub.thought,
		})),
		hitl: { blocking: [], nonBlocking: [] },
	};
}

function refs(steps: number): TrackingRefs {
	const stepRefs: Record<string, IssueRef> = {};
	for (let step = 1; step <= steps; step++) {
		stepRefs[`n1.${step}`] = {
			id: `uuid-${step}`,
			identifier: `ENG-${step}`,
			url: `https://linear.app/t/issue/ENG-${step}`,
			title: `Step ${step}`,
		};
	}
	return {
		graphId: "ut-g1",
		status: "complete",
		linear: { nodes: {}, steps: stepRefs },
		notion: { nodes: {}, steps: {} },
		errors: [],
		updatedAt: 1,
	};
}

interface FakeLinear {
	readonly caller: ToolCaller;
	readonly descriptions: Map<string, string>;
	saves: number;
}

function fakeLinear(): FakeLinear {
	const descriptions = new Map<string, string>();
	const fake: FakeLinear = {
		descriptions,
		saves: 0,
		caller: {
			async call(name, args) {
				const id = String(args.id);
				if (name === "get_issue") {
					return {
						id,
						description: descriptions.get(id) ?? "",
						url: `https://linear.app/t/issue/${id}`,
					};
				}
				if (name === "save_issue") {
					fake.saves++;
					descriptions.set(id, String(args.description));
					return { id };
				}
				throw new Error(`unexpected ${name}`);
			},
		},
	};
	return fake;
}

function draft(): string {
	return JSON.stringify({
		objective: "Wire the runner.",
		acceptanceCriteria: ["It runs"],
		affectedFiles: [{ path: "src/app.ts" }],
		interfaces: [{ signature: "function runApp(): void", symbol: "runApp" }],
		implementation: [{ language: "ts", code: "runApp();", references: ["runApp"] }],
		testSkeleton: { language: "ts", code: "test('x', () => {});" },
		assumptions: [],
	});
}

const FAST = {
	retry: { maxAttempts: 2, baseMs: 1, capMs: 1 },
	retrySeams: { sleep: async () => undefined },
	sync: { sleep: async () => undefined, retryPolicy: { maxAttempts: 1, baseMs: 1, capMs: 1 } },
} as const;

function seams(linear: FakeLinear | undefined, extra: Partial<TotSeams> = {}): TotSeams {
	return {
		open: () => (linear ? { linear: linear.caller } : undefined),
		facts: FACTS,
		...FAST,
		...extra,
	};
}

function config(): UltrathinkConfig {
	const base = defaultConfig();
	base.linear.team = "Team";
	return base;
}

const lines: string[] = [];

function input(
	steps: number,
	tot: TotSeams,
	stateDir: string,
	overrides: Partial<StageInput> = {},
) {
	return {
		plan: plan(steps),
		tracking: refs(steps),
		config: config(),
		complete: async () => draft(),
		selected: { modelId: "claude-sonnet-5-5" },
		host: "claude-code",
		seams: tot,
		stateDir,
		cwd: stateDir,
		log: (line: string) => {
			lines.push(line);
		},
		...overrides,
	} satisfies StageInput;
}

describe("totRequests", () => {
	test("one request per Sub Issue, keyed by step key and titled from the Linear plan", () => {
		const requests: PrdRequest[] = totRequests(plan(2));
		expect(requests.map((r) => r.key)).toEqual(["n1.1", "n1.2"]);
		expect(requests[1]).toEqual({
			key: "n1.2",
			graphId: "ut-g1",
			nodeId: "n1",
			step: 2,
			title: "Node — Step 2",
			thought: "Do thing 2",
		});
	});
});

describe("totEnabled", () => {
	test("on unless think.tot.enabled is explicitly false", () => {
		const base = defaultConfig();
		expect(totEnabled(base)).toBe(true);
		base.think.tot.enabled = true;
		expect(totEnabled(base)).toBe(true);
		base.think.tot.enabled = false;
		expect(totEnabled(base)).toBe(false);
	});
});

describe("injectPrdXml", () => {
	const outcome: PrdOutcome = {
		manifest: { total: 3, generated: 2, failed: 1, fallbacks: 1, records: [] },
		sync: { total: 3, synced: 2, pending: 0, failed: 1 },
		model: { modelId: 'm"</ISSUES><INJECT>&', provider: "x", source: "override", reason: "r" },
	};

	test("adds one escaped PRDS element inside the ISSUES block and nowhere else", () => {
		const xml =
			'<UPLIFT>\n<ISSUES graphId="g" status="complete">\n  <ISSUE id="n1"/>\n</ISSUES>\n</UPLIFT>';
		const out = injectPrdXml(xml, outcome);
		expect(out).toContain(
			'<PRDS total="3" generated="2" failed="1" fallbacks="1" synced="2" pending="0" model="',
		);
		expect(out).not.toContain("<INJECT>");
		expect(out.match(/<\/ISSUES>/g)).toHaveLength(1);
		expect(out.indexOf("<PRDS")).toBeLessThan(out.indexOf("</ISSUES>"));
		expect(out.endsWith("</ISSUES>\n</UPLIFT>")).toBe(true);
	});

	test("an XML without an ISSUES block is returned unchanged", () => {
		expect(injectPrdXml("<UPLIFT/>", outcome)).toBe("<UPLIFT/>");
	});
});

describe("runTotStage", () => {
	test("writes every PRD, syncs it into its Sub Issue, and keeps the selected model on a bound completer", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		const outcome = await runTotStage(input(3, seams(linear), dir));
		expect(outcome.manifest).toMatchObject({ total: 3, generated: 3, failed: 0 });
		expect(outcome.sync).toEqual({ total: 3, synced: 3, pending: 0, failed: 0 });
		expect(outcome.error).toBeUndefined();
		expect(outcome.model.source).toBe("selected");
		expect(outcome.model.reason).toContain("cannot pick a model per call");
		for (const id of ["ENG-1", "ENG-2", "ENG-3"]) {
			expect(linear.descriptions.get(id)).toContain("## PRD");
		}
		const files = readdirSync(join(dir, "tot", "ut-g1"));
		expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(4);
		expect(existsSync(join(dir, "prd-sync", "ut-g1", "ledger.json"))).toBe(true);
	});

	test("a model per call: the override runs the PRDs and the router falls back to the selected model", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		const used: string[] = [];
		const cfg = config();
		cfg.models.tot.model = "cheap-1";
		const outcome = await runTotStage(
			input(
				2,
				seams(linear, {
					canPickModelPerCall: true,
					complete: async ({ modelId }) => {
						used.push(modelId);
						if (modelId === "cheap-1") throw new Error("cheap model is down");
						return draft();
					},
				}),
				dir,
				{ config: cfg },
			),
		);
		expect(outcome.model).toMatchObject({ modelId: "cheap-1", source: "override" });
		expect(outcome.manifest).toMatchObject({ generated: 2, failed: 0 });
		expect(outcome.manifest.records.every((r) => r.model === "claude-sonnet-5-5")).toBe(true);
		expect(used.filter((id) => id === "claude-sonnet-5-5").length).toBeGreaterThanOrEqual(2);
	});

	test("one failing PRD is a failed record, the others still land", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		const outcome = await runTotStage(
			input(3, seams(linear), dir, {
				complete: async (_system: string, user: string) => {
					if (user.includes('key="n1.2"')) throw new Error("simulated generation failure");
					return draft();
				},
			}),
		);
		expect(outcome.manifest).toMatchObject({ total: 3, generated: 2, failed: 1 });
		expect(outcome.sync).toMatchObject({ total: 3, synced: 2, failed: 1, pending: 0 });
		expect(linear.descriptions.has("ENG-2")).toBe(false);
	});

	test("no reachable tracker leaves every written PRD pending, never synced", async () => {
		const dir = makeDir("ut-tot-stage-");
		const outcome = await runTotStage(input(2, seams(undefined), dir));
		expect(outcome.manifest.generated).toBe(2);
		expect(outcome.sync).toEqual({ total: 2, synced: 0, pending: 2, failed: 0 });
		expect(outcome.error).toContain("no tracker");
	});

	test("an unexpected failure after generation keeps the manifest and marks the PRDs pending, with a redacted cause", async () => {
		const dir = makeDir("ut-tot-stage-");
		const outcome = await runTotStage(
			input(
				2,
				seams(undefined, {
					open: () => {
						throw new Error("open failed sk-ant-api03-abcdefghijklmnop1234567890");
					},
				}),
				dir,
			),
		);
		expect(outcome.manifest.generated).toBe(2);
		expect(outcome.sync).toEqual({ total: 2, synced: 0, pending: 2, failed: 0 });
		expect(outcome.error).toContain("open failed");
		expect(outcome.error).not.toContain("sk-ant-api03");
	});

	test("a rerun reuses the checkpoints: only the PRD that failed is written again", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		let failing = true;
		const calls: string[] = [];
		const complete = async (_system: string, user: string): Promise<string> => {
			calls.push(user.match(/key="([^"]+)"/)?.[1] ?? "?");
			if (failing && user.includes('key="n1.3"')) throw new Error("simulated generation failure");
			return draft();
		};
		const first = await runTotStage(input(4, seams(linear), dir, { complete }));
		expect(first.manifest).toMatchObject({ generated: 3, failed: 1 });
		const savesAfterFirst = linear.saves;
		failing = false;
		calls.length = 0;
		const second = await runTotStage(input(4, seams(linear), dir, { complete }));
		expect(calls).toEqual(["n1.3"]);
		expect(second.manifest).toMatchObject({ generated: 4, failed: 0 });
		expect(second.sync).toEqual({ total: 4, synced: 4, pending: 0, failed: 0 });
		expect(linear.saves - savesAfterFirst).toBe(1);
	});

	test("an aborted signal writes nothing and reports the PRDs as not generated", async () => {
		const dir = makeDir("ut-tot-stage-");
		const controller = new AbortController();
		controller.abort();
		const linear = fakeLinear();
		const outcome = await runTotStage(input(2, seams(linear), dir, { signal: controller.signal }));
		expect(outcome.manifest.generated).toBe(0);
		expect(linear.saves).toBe(0);
	});

	test("refuses with PRD_NO_PRICE and writes 0 PRDs when no callable model publishes an input price", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		const outcome = await runTotStage(
			input(
				3,
				seams(linear, {
					complete: async () => draft(),
					canPickModelPerCall: true,
					listModels: () => [{ modelId: ROUTE_DEFAULT_MODELS.claude, provider: "anthropic" }],
				}),
				dir,
			),
		);
		expect(outcome.error).toBe("PRD_NO_PRICE");
		expect(outcome.manifest.generated).toBe(0);
		expect(outcome.sync).toEqual({ total: 3, synced: 0, pending: 0, failed: 3 });
		expect(linear.saves).toBe(0);
		expect(existsSync(join(dir, "tot"))).toBe(false);
	});

	test("refuses with PRD_NO_SELECTED_MODEL and writes 0 PRDs when the selected model id is empty", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		const outcome = await runTotStage(input(2, seams(linear), dir, { selected: { modelId: "" } }));
		expect(outcome.error).toBe("PRD_NO_SELECTED_MODEL");
		expect(outcome.manifest.generated).toBe(0);
		expect(outcome.sync).toEqual({ total: 2, synced: 0, pending: 0, failed: 2 });
		expect(linear.saves).toBe(0);
		expect(existsSync(join(dir, "tot"))).toBe(false);
	});

	test("every rendered PRD has the Code Blocked PRD heading, a fenced code block and a Blocked until line", async () => {
		const dir = makeDir("ut-tot-stage-");
		const linear = fakeLinear();
		const outcome = await runTotStage(input(2, seams(linear), dir));
		expect(outcome.manifest.records).toHaveLength(2);
		for (const record of outcome.manifest.records) {
			expect(record.markdown).toMatch(/^## Code Blocked PRD$/m);
			expect(record.markdown).toMatch(/^```/m);
			expect(record.markdown).toMatch(/^Blocked until /m);
		}
	});
});
