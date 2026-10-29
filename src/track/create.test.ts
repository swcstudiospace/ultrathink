// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { ProgressEvent } from "../host/progress.ts";
import { FIELD_CAPS } from "../resilience/limits.ts";
import type { ThoughtGraph } from "../think/types.ts";
import { createTracking, stepKey, type CreateTrackingDeps, type ToolCaller } from "./create.ts";
import type { TrackingRefs, TrackPlan } from "./types.ts";
import { type Call, failure, statefulLinear, statefulNotion } from "./test.helpers.ts";

const GRAPH: ThoughtGraph = {
	goal: "Ship it",
	nodes: [
		{ id: "n1", title: "Understand", kind: "understand", question: "q1", dependsOn: [] },
		{ id: "n2", title: "Build", kind: "generate", question: "q2", dependsOn: ["n1"] },
		{ id: "n3", title: "Review", kind: "critique", question: "q3", dependsOn: ["n1", "n2"] },
	],
};

function makePlan(): TrackPlan {
	const graphId = "g-1";
	const nodes = GRAPH.nodes;
	return {
		graphId,
		task: {
			graphId,
			item: "Ship it",
			description: "d",
			upliftedPrompt: "u",
			agent: "claude",
			status: "Todo",
			linearState: "Todo",
		},
		issues: nodes.map((node) => ({
			graphId,
			nodeId: node.id,
			item: `[${node.id}] ${node.title}`,
			thought: node.question,
		})),
		subIssues: nodes.flatMap((node) =>
			[1, 2].map((step) => ({
				graphId,
				nodeId: node.id,
				item: `[${node.id}] Step ${step}: s`,
				step,
				thought: "t",
			})),
		),
		linearIssues: nodes.map((node) => ({
			nodeId: node.id,
			title: node.title,
			description: `desc ${node.id}`,
		})),
		linearSubIssues: nodes.flatMap((node) =>
			[1, 2].map((step) => ({
				nodeId: node.id,
				step,
				title: `${node.title} — Step ${step}: s`,
				description: "sd",
			})),
		),
		hitl: { blocking: [], nonBlocking: [] },
	};
}

function fakeLinear(
	opts: { throwOn?: (args: Record<string, unknown>) => boolean; listed?: () => unknown[] } = {},
): ToolCaller & { calls: Call[] } {
	const calls: Call[] = [];
	let counter = 0;
	return {
		calls,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "list_issues") return { issues: opts.listed?.() ?? [] };
			if (opts.throwOn?.(args)) throw new Error("HTTP 500");
			counter++;
			const identifier = `ENG-${counter}`;
			return {
				issue: {
					id: `uuid-${counter}`,
					identifier,
					url: `https://linear.app/org/issue/${identifier}/slug`,
				},
			};
		},
	};
}

function fakeNotion(opts: { rows?: unknown[] } = {}): ToolCaller & { calls: Call[] } {
	const calls: Call[] = [];
	let counter = 0;
	return {
		calls,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "notion-query-data-sources") return { results: opts.rows ?? [] };
			if (name === "notion-fetch") {
				const props = Object.fromEntries(
					[
						"Item",
						"Level",
						"Graph ID",
						"Parent Item",
						"Linear URL",
						"Issue ID",
						"Step",
						"Thought",
					].map((p) => [p, { type: "text" }]),
				);
				return `<data-source>${JSON.stringify({ schema: props })}</data-source>`;
			}
			const pages = args.pages as unknown[];
			const urls = pages.map(() => `https://www.notion.so/page-${++counter}`);
			return { pages: urls.map((url) => ({ url })) };
		},
	};
}

function deps(over: Partial<CreateTrackingDeps>): CreateTrackingDeps {
	return {
		linearTeam: "Acme Engineering",
		notionDataSource: "ds-uuid",
		concurrency: 3,
		budgetMs: 5000,
		now: () => 1,
		// Retries never wait for real time in these tests.
		sleep: async () => undefined,
		random: () => 0,
		...over,
	};
}

describe("createTracking onRef checkpoint (G5)", () => {
	test("is called after each created row with every ref made so far, and a throwing callback never stops tracking", async () => {
		const snapshots: TrackingRefs[] = [];
		const result = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear: fakeLinear(),
				notion: fakeNotion(),
				onRef: (refs) => {
					snapshots.push(structuredClone(refs));
					if (snapshots.length === 1) throw new Error("sink broke");
				},
			}),
		);
		expect(result.status).toBe("complete");
		expect(snapshots.length).toBeGreaterThanOrEqual(
			makePlan().linearIssues.length + makePlan().linearSubIssues.length,
		);
		// The Linear count grows by one row per checkpoint and never shrinks; the last snapshot holds everything.
		const counts = snapshots.map(
			(s) => Object.keys(s.linear.nodes).length + Object.keys(s.linear.steps).length,
		);
		for (let i = 1; i < counts.length; i++)
			expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1] as number);
		expect(snapshots.at(-1)?.linear.nodes).toEqual(result.linear.nodes);
		expect(snapshots.at(-1)?.notion.taskUrl).toBe(result.notion.taskUrl);
		// The first checkpoint already carries exactly one created Linear row.
		expect(counts.find((count) => count > 0)).toBe(1);
	});
});

describe("createTracking", () => {
	test("full success creates every row and reports complete", async () => {
		const linear = fakeLinear();
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(Object.keys(refs.linear.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
		expect(refs.linear.nodes.n1?.title).toBe("[n1] Understand");
		expect(String(linear.calls[0]?.args.description)).toEndWith("ultrathink graph g-1 · node n1");
		const sub = linear.calls.find((call) => call.args.title === "Build — Step 2: s");
		expect(sub?.args.parentId).toBe(refs.linear.nodes.n2?.identifier);
		expect(String(sub?.args.description)).toEndWith("ultrathink graph g-1 · node n2 · step 2");
		expect(refs.notion.taskUrl).toBeDefined();
	});

	test("progress events count up to the plan size", async () => {
		const events: ProgressEvent[] = [];
		await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion: fakeNotion(), progress: (e) => events.push(e) }),
		);
		const track = events.flatMap((e) => (e.type === "track" ? [e] : []));
		expect(track.length).toBeGreaterThan(0);
		for (let i = 1; i < track.length; i++) {
			const [prev, cur] = [track[i - 1], track[i]] as [
				(typeof track)[number],
				(typeof track)[number],
			];
			expect(cur.linear!.nodes[0]).toBeGreaterThanOrEqual(prev.linear!.nodes[0]);
			expect(cur.linear!.steps[0]).toBeGreaterThanOrEqual(prev.linear!.steps[0]);
		}
		const last = track.at(-1);
		expect(last?.linear).toEqual({ nodes: [3, 3], steps: [6, 6] });
		expect(last?.notion).toEqual({ task: true, nodes: [3, 3], steps: [6, 6] });
		expect(track.every((e) => e.error === undefined)).toBe(true);
	});

	test("a failing call emits a track event with the error", async () => {
		const events: ProgressEvent[] = [];
		const linear = fakeLinear({ throwOn: (args) => args.title === "[n2] Build" });
		await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion: fakeNotion(), progress: (e) => events.push(e) }),
		);
		const errored = events.find((e) => e.type === "track" && e.error?.includes("HTTP 500"));
		expect(errored).toBeDefined();
	});

	test("emits one linear issue event per created node and step with its identifier and url", async () => {
		const events: ProgressEvent[] = [];
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion: fakeNotion(), progress: (e) => events.push(e) }),
		);
		const linear = events.filter((e) => e.type === "issue" && e.provider === "linear");
		expect(linear).toHaveLength(9);
		for (const node of GRAPH.nodes) {
			const ref = refs.linear.nodes[node.id]!;
			expect(linear).toContainEqual({
				type: "issue",
				at: expect.any(Number),
				provider: "linear",
				nodeId: node.id,
				identifier: ref.identifier,
				url: ref.url,
			});
			for (const step of [1, 2]) {
				const sub = refs.linear.steps[stepKey(node.id, step)]!;
				expect(linear).toContainEqual({
					type: "issue",
					at: expect.any(Number),
					provider: "linear",
					nodeId: node.id,
					step,
					identifier: sub.identifier,
					url: sub.url,
				});
			}
		}
		const notion = events.filter((e) => e.type === "issue" && e.provider === "notion");
		expect(notion).toHaveLength(9);
		const stepUrl = refs.notion.steps[stepKey("n2", 1)];
		if (stepUrl === undefined) throw new Error("expected a notion step url");
		expect(notion).toContainEqual({
			type: "issue",
			at: expect.any(Number),
			provider: "notion",
			nodeId: "n2",
			step: 1,
			url: stepUrl,
		});
		expect(notion.some((e) => e.type === "issue" && e.url === refs.notion.taskUrl)).toBe(false);
	});

	test("adoption emits issue events for adopted Linear rows", async () => {
		const listed = () => [
			{
				identifier: "ENG-90",
				url: "https://linear.app/org/issue/ENG-90/x",
				title: "[n1] Understand",
				description: "d\n\nultrathink graph g-1 · node n1",
			},
			{
				identifier: "ENG-91",
				url: "https://linear.app/org/issue/ENG-91/x",
				title: "Understand — Step 2: s",
				description: "d\n\nultrathink graph g-1 · node n1 · step 2",
			},
		];
		const existing: TrackingRefs = {
			graphId: "g-1",
			status: "failed",
			linearTeam: "Acme Engineering",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 0,
		};
		const events: ProgressEvent[] = [];
		await createTracking(
			makePlan(),
			GRAPH,
			existing,
			deps({
				linear: fakeLinear({ listed }),
				notion: fakeNotion(),
				progress: (e) => events.push(e),
			}),
		);
		const issues = events.filter((e) => e.type === "issue" && e.provider === "linear");
		expect(issues.slice(0, 2)).toEqual([
			{
				type: "issue",
				at: expect.any(Number),
				provider: "linear",
				nodeId: "n1",
				identifier: "ENG-90",
				url: "https://linear.app/org/issue/ENG-90/x",
			},
			{
				type: "issue",
				at: expect.any(Number),
				provider: "linear",
				nodeId: "n1",
				step: 2,
				identifier: "ENG-91",
				url: "https://linear.app/org/issue/ENG-91/x",
			},
		]);
		expect(issues).toHaveLength(9);
	});

	test("a throwing progress sink does not change the refs", async () => {
		const plain = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion: fakeNotion() }),
		);
		const noisy = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear: fakeLinear(),
				notion: fakeNotion(),
				progress: () => {
					throw new Error("sink down");
				},
			}),
		);
		expect(noisy).toEqual(plain);
	});

	test("levels run in dependency order and blockedBy carries dependency identifiers", async () => {
		const linear = fakeLinear();
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion: fakeNotion() }),
		);
		const nodeCalls = linear.calls.filter((call) => call.args.parentId === undefined);
		expect(nodeCalls.map((call) => call.args.title)).toEqual([
			"[n1] Understand",
			"[n2] Build",
			"[n3] Review",
		]);
		expect(nodeCalls[0]?.args.blockedBy).toBeUndefined();
		expect(nodeCalls[1]?.args.blockedBy).toEqual([refs.linear.nodes.n1?.identifier]);
		expect(nodeCalls[2]?.args.blockedBy).toEqual([
			refs.linear.nodes.n1?.identifier,
			refs.linear.nodes.n2?.identifier,
		]);
	});

	test("existing refs are not recreated", async () => {
		const first = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion: fakeNotion() }),
		);
		const partial: TrackingRefs = structuredClone(first);
		delete partial.linear.steps[stepKey("n3", 2)];
		delete partial.notion.steps[stepKey("n3", 2)];
		const linear = fakeLinear();
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, partial, deps({ linear, notion }));
		expect(refs.status).toBe("complete");
		const saves = linear.calls.filter((call) => call.name === "save_issue");
		expect(saves).toHaveLength(1);
		expect(saves[0]?.args.parentId).toBe(first.linear.nodes.n3?.identifier);
		expect(notion.calls.map((call) => call.name)).toEqual([
			"notion-query-data-sources",
			"notion-fetch",
			"notion-create-pages",
		]);
		expect((notion.calls[2]?.args.pages as unknown[]).length).toBe(1);
		expect(refs.linear.nodes).toEqual(first.linear.nodes);
	});

	test("a failing sub-issue call yields partial with an error naming the key", async () => {
		const linear = fakeLinear({ throwOn: (args) => args.title === "Review — Step 1: s" });
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion: fakeNotion() }),
		);
		expect(refs.status).toBe("partial");
		expect(refs.linear.steps["n3.1"]).toBeUndefined();
		expect(refs.errors).toContain("linear n3.1: HTTP 500");
	});

	test("missing notion caller is partial with login error while Linear completes", async () => {
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear() }));
		expect(refs.status).toBe("partial");
		expect(refs.errors).toContain("notion: login required");
		expect(Object.keys(refs.linear.nodes)).toHaveLength(3);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
	});

	test("Linear-only config makes no Notion calls, reports no Notion progress and is complete", async () => {
		const notion = fakeNotion();
		const events: ProgressEvent[] = [];
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear: fakeLinear(),
				notion,
				notionDataSource: undefined,
				progress: (e) => events.push(e),
			}),
		);
		expect(notion.calls).toEqual([]);
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
		const track = events.flatMap((e) => (e.type === "track" ? [e] : []));
		expect(track.at(-1)?.linear).toEqual({ nodes: [3, 3], steps: [6, 6] });
		expect(track.some((e) => e.notion !== undefined)).toBe(false);
	});

	test("Notion-only config makes no Linear calls, records no team and is complete", async () => {
		const linear = fakeLinear();
		const existing: TrackingRefs = {
			graphId: "g-1",
			status: "failed",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 0,
		};
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			existing,
			deps({ linear, notion: fakeNotion(), linearTeam: undefined }),
		);
		expect(linear.calls).toEqual([]);
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(refs.linearTeam).toBeUndefined();
		expect(Object.keys(refs.notion.steps)).toHaveLength(6);
	});

	test("budget exhaustion resolves promptly with partial refs", async () => {
		let count = 0;
		const linear: ToolCaller = {
			async call(_name, _args, signal) {
				count++;
				if (count === 1)
					return { identifier: "ENG-1", url: "https://linear.app/org/issue/ENG-1/x", id: "u1" };
				const { promise, reject } = Promise.withResolvers<unknown>();
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
				return promise;
			},
		};
		// The budget timer is armed on a test-held port: the test fires it by hand instead of waiting for budgetMs.
		const armed = Promise.withResolvers<() => void>();
		const timers = {
			setTimeout: (fn: () => void) => {
				armed.resolve(fn);
				return {} as NodeJS.Timeout;
			},
			clearTimeout: () => undefined,
		};
		const tracking = createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion: fakeNotion(), budgetMs: 20, timers }),
		);
		const fireBudget = await armed.promise;
		fireBudget();
		const refs = await tracking;
		expect(refs.status).toBe("partial");
		expect(refs.linear.nodes.n1?.identifier).toBe("ENG-1");
		expect(refs.errors.some((error) => error.includes("budget exhausted"))).toBe(true);
	});

	test("budgetMs 0 means no limit: a slow client still completes every row without a budget error", async () => {
		const fast = fakeLinear();
		// Each row stays in flight until the test opens the gate after the first call has entered.
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const linear: ToolCaller = {
			async call(name, args, signal) {
				entered.resolve();
				await gate.promise;
				return fast.call(name, args, signal);
			},
		};
		const tracking = createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion: fakeNotion(), budgetMs: 0 }),
		);
		await entered.promise;
		gate.resolve();
		const refs = await tracking;
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(Object.keys(refs.linear.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
		expect(Object.keys(refs.notion.steps)).toHaveLength(6);
	});

	test("Notion page URLs map to the right node and step keys with parent relations", async () => {
		const notion = fakeNotion();
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion, concurrency: 1 }),
		);
		expect(refs.notion.taskUrl).toBe("https://www.notion.so/page-1");
		expect(refs.notion.nodes).toEqual({
			n1: "https://www.notion.so/page-2",
			n2: "https://www.notion.so/page-3",
			n3: "https://www.notion.so/page-4",
		});
		expect(refs.notion.steps["n1.1"]).toBe("https://www.notion.so/page-5");
		expect(refs.notion.steps["n3.2"]).toBe("https://www.notion.so/page-10");
		const nodePages = notion.calls[2]?.args.pages as Array<{ properties: Record<string, unknown> }>;
		expect(nodePages[1]?.properties["Parent Item"]).toBe(
			JSON.stringify(["https://www.notion.so/page-1"]),
		);
		expect(nodePages[1]?.properties["Issue ID"]).toBe(refs.linear.nodes.n2?.identifier);
		expect(nodePages[1]?.properties.Agent).toBeUndefined();
		const stepPages = notion.calls[3]?.args.pages as Array<{ properties: Record<string, unknown> }>;
		expect(stepPages[5]?.properties["Parent Item"]).toBe(
			JSON.stringify(["https://www.notion.so/page-4"]),
		);
		expect(stepPages[5]?.properties.Step).toBe(2);
	});

	test("re-run adopts a Linear issue created by a lost call instead of saving it again", async () => {
		const plan = makePlan();
		const first = await createTracking(
			plan,
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion: fakeNotion() }),
		);
		const partial: TrackingRefs = structuredClone(first);
		const lost = partial.linear.steps["n2.1"];
		delete partial.linear.steps["n2.1"];
		const listed = () => [
			{
				id: "other",
				identifier: "ENG-99",
				url: "https://linear.app/org/issue/ENG-99/x",
				title: "x",
				description: "ultrathink graph g-10 · node n2 · step 1",
			},
			{
				id: lost?.id,
				identifier: lost?.identifier,
				url: lost?.url,
				title: "Build — Step 1: s",
				description: "sd\n\nultrathink graph g-1 · node n2 · step 1",
			},
		];
		const linear = fakeLinear({ listed });
		const refs = await createTracking(plan, GRAPH, partial, deps({ linear, notion: fakeNotion() }));
		expect(linear.calls.map((call) => call.name)).toEqual(["list_issues"]);
		expect(linear.calls[0]?.args).toEqual({ query: "ultrathink graph g-1", limit: 250 });
		expect(refs.linear.steps["n2.1"]?.identifier).toBe(lost?.identifier);
		expect(refs.status).toBe("complete");
	});

	test("first run skips adoption lookups", async () => {
		const linear = fakeLinear();
		const notion = fakeNotion();
		await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		expect(linear.calls.some((call) => call.name === "list_issues")).toBe(false);
		expect(notion.calls.some((call) => call.name === "notion-query-data-sources")).toBe(false);
	});

	test("re-run adopts Notion rows by Level, Item prefix and Step", async () => {
		const plan = makePlan();
		const first = await createTracking(
			plan,
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion: fakeNotion() }),
		);
		const partial: TrackingRefs = structuredClone(first);
		delete partial.notion.taskUrl;
		partial.notion.nodes = {};
		partial.notion.steps = {};
		const rows = [
			{ url: "https://www.notion.so/t", Level: "Task", Item: "Ship it" },
			...GRAPH.nodes.map((node) => ({
				url: `https://www.notion.so/${node.id}`,
				Level: "Issue",
				Item: `[${node.id}] ${node.title}`,
			})),
			...GRAPH.nodes.flatMap((node) =>
				[1, 2].map((step) => ({
					url: `https://www.notion.so/${node.id}-${step}`,
					Level: "Sub-Issue",
					Item: `[${node.id}] Step ${step}: s`,
					Step: step,
				})),
			),
		];
		const notion = fakeNotion({ rows });
		const refs = await createTracking(plan, GRAPH, partial, deps({ linear: fakeLinear(), notion }));
		expect(notion.calls.map((call) => call.name)).toEqual(["notion-query-data-sources"]);
		const data = (notion.calls[0]?.args.data ?? {}) as Record<string, unknown>;
		expect(data.data_source_urls).toEqual(["collection://ds-uuid"]);
		expect(data.params).toEqual(["g-1"]);
		expect(refs.notion.taskUrl).toBe("https://www.notion.so/t");
		expect(refs.notion.nodes.n2).toBe("https://www.notion.so/n2");
		expect(refs.notion.steps["n3.2"]).toBe("https://www.notion.so/n3-2");
		expect(refs.status).toBe("complete");
	});

	test("create-pages sends allow_async false and maps structured urls in order", async () => {
		const notion = fakeNotion();
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion, concurrency: 1 }),
		);
		const creates = notion.calls.filter((call) => call.name === "notion-create-pages");
		expect(creates.every((call) => call.args.allow_async === false)).toBe(true);
		expect(refs.notion.nodes.n3).toBe("https://www.notion.so/page-4");
	});

	test("the hosted Notion fetch shape (schema JSON inside a text field) keeps every property on created rows", async () => {
		const schema = Object.fromEntries(
			["Item", "Level", "Graph ID", "Agent", "Status", "Thought", "Parent Item", "Step"].map(
				(name) => [name, { name, type: "text" }],
			),
		);
		const text = [
			'<data-source url="{{collection://ds-uuid}}">',
			"Here is the database's configurable state:",
			`<data-source-state>${JSON.stringify({ name: "Agent Task Graph", schema })}</data-source-state>`,
			'<sqlite-table>CREATE TABLE "collection://ds-uuid" ("Item" TEXT, "Level" TEXT)</sqlite-table>',
			"</data-source>",
		].join("\n");
		const calls: Call[] = [];
		let counter = 0;
		const notion: ToolCaller = {
			async call(name, args) {
				calls.push({ name, args });
				if (name === "notion-fetch")
					return {
						metadata: { type: "data_source" },
						title: "Agent Task Graph",
						url: "collection://ds-uuid",
						text,
					};
				return {
					pages: (args.pages as unknown[]).map(() => ({
						url: `https://www.notion.so/page-${++counter}`,
					})),
				};
			},
		};
		await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion, concurrency: 1 }),
		);
		const pages = calls
			.filter((call) => call.name === "notion-create-pages")
			.flatMap((call) => call.args.pages as Array<{ properties: Record<string, unknown> }>);
		expect(pages.length).toBeGreaterThan(0);
		for (const page of pages)
			expect(page.properties).toMatchObject({
				"Graph ID": "g-1",
				Level: expect.any(String),
				Item: expect.any(String),
			});
		expect(pages[0]?.properties).toMatchObject({ Level: "Task", Status: expect.any(String) });
		expect(pages.every((page) => !("metadata" in page.properties))).toBe(true);
	});

	test("a schema read that finds none of the core names sends every property unfiltered, never a partial row", async () => {
		const calls: Call[] = [];
		const notion: ToolCaller = {
			async call(name, args) {
				calls.push({ name, args });
				if (name === "notion-fetch")
					return { metadata: { type: "data_source" }, text: "unparseable schema" };
				return {
					pages: (args.pages as unknown[]).map((_, index) => ({
						url: `https://www.notion.so/q${index}`,
					})),
				};
			},
		};
		await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion, concurrency: 1 }),
		);
		const task = (
			calls.find((call) => call.name === "notion-create-pages")?.args.pages as Array<{
				properties: Record<string, unknown>;
			}>
		)[0];
		expect(task?.properties).toMatchObject({
			Item: expect.any(String),
			Level: "Task",
			"Graph ID": "g-1",
			Status: expect.any(String),
			Agent: expect.any(String),
		});
		const node = (
			calls.filter((call) => call.name === "notion-create-pages")[1]?.args.pages as Array<{
				properties: Record<string, unknown>;
			}>
		)[0];
		expect(node?.properties).toMatchObject({
			Level: "Issue",
			Thought: expect.any(String),
			"Parent Item": expect.any(String),
		});
	});

	test("structured page urls win over urls mentioned elsewhere in the result", async () => {
		const notion: ToolCaller = {
			async call(name, args) {
				if (name === "notion-fetch")
					return { schema: { Item: { type: "title" }, Level: { type: "select" } } };
				const pages = args.pages as unknown[];
				return {
					note: "see https://www.notion.so/unrelated",
					pages: pages.map((_, index) => ({ url: `https://www.notion.so/p${index}` })),
				};
			},
		};
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion }),
		);
		expect(refs.notion.taskUrl).toBe("https://www.notion.so/p0");
		expect(refs.notion.nodes.n2).toBe("https://www.notion.so/p1");
	});

	test("a text create reply with app.notion.com page urls counts every row as created", async () => {
		let counter = 0;
		const notion: ToolCaller = {
			async call(name, args) {
				if (name === "notion-fetch")
					return { schema: { Item: { type: "title" }, Level: { type: "select" } } };
				const pages = args.pages as unknown[];
				return `Created ${pages.length} pages:\n${pages.map(() => `<page url="https://app.notion.com/p/row-${++counter}">`).join("\n")}`;
			},
		};
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion, concurrency: 1 }),
		);
		expect(refs.errors).toEqual([]);
		expect(refs.status).toBe("complete");
		expect(refs.notion.taskUrl).toBe("https://app.notion.com/p/row-1");
		expect(Object.keys(refs.notion.nodes)).toHaveLength(3);
		expect(Object.keys(refs.notion.steps)).toHaveLength(6);
		expect(refs.notion.nodes.n1).toBe("https://app.notion.com/p/row-2");
	});

	test("a node whose dependency failed is still created, without that dependency in blockedBy", async () => {
		const plan = makePlan();
		const failing = fakeLinear({ throwOn: (args) => args.title === "[n2] Build" });
		const first = await createTracking(
			plan,
			GRAPH,
			undefined,
			deps({ linear: failing, notion: fakeNotion() }),
		);
		expect(first.errors.some((error) => error.includes("dependency missing"))).toBe(false);
		expect(first.linear.nodes.n2).toBeUndefined();
		const n3 = failing.calls.find((call) => call.args.title === "[n3] Review");
		expect(n3?.args.blockedBy).toEqual([first.linear.nodes.n1?.identifier]);
		expect(first.linear.nodes.n3).toBeDefined();
		expect(first.errors).toContain("linear n3: blockedBy n2 omitted (dependency not created)");
	});

	test("node ids that are prototype keys are created, tracked and adopted like any other", async () => {
		const graph: ThoughtGraph = {
			goal: "g",
			nodes: [
				{ id: "constructor", title: "A", kind: "understand", question: "q1", dependsOn: [] },
				{
					id: "__proto__",
					title: "B",
					kind: "synthesize",
					question: "q2",
					dependsOn: ["constructor"],
				},
			],
		};
		const plan: TrackPlan = {
			...makePlan(),
			issues: [],
			subIssues: [],
			linearIssues: graph.nodes.map((node) => ({
				nodeId: node.id,
				title: node.title,
				description: `desc ${node.id}`,
			})),
			linearSubIssues: [],
		};
		const linear = fakeLinear();
		const refs = await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear, notionDataSource: undefined }),
		);
		const saves = linear.calls.filter((call) => call.name === "save_issue");
		expect(saves.map((call) => call.args.title)).toEqual(["[constructor] A", "[__proto__] B"]);
		// A non-literal key keeps TypeScript from resolving `constructor` to Object.prototype's member.
		const constructorKey: string = "constructor";
		expect(saves[1]?.args.blockedBy).toEqual([refs.linear.nodes[constructorKey]?.identifier]);
		expect(refs.status).toBe("complete");
		expect(Object.keys(refs.linear.nodes).sort()).toEqual(["__proto__", "constructor"]);
		expect(Object.getPrototypeOf(refs.linear.nodes)).toBeNull();

		const failing = fakeLinear({ throwOn: (args) => args.title === "[constructor] A" });
		const failed = await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear: failing, notionDataSource: undefined }),
		);
		// `constructor` fails (a status-less error is retried up to the attempt cap); `__proto__` is still created, unblocked.
		expect(failing.calls.filter((call) => call.name === "save_issue")).toHaveLength(4);
		expect(failed.status).not.toBe("complete");
		expect(Object.keys(failed.linear.nodes)).toEqual(["__proto__"]);
		expect(failed.errors).toEqual([
			"linear constructor: HTTP 500",
			"linear __proto__: blockedBy constructor omitted (dependency not created)",
		]);

		const listed = () => [
			{
				identifier: "ENG-90",
				url: "https://linear.app/org/issue/ENG-90/x",
				title: "[__proto__] B",
				description: "d\n\nultrathink graph g-1 · node __proto__",
			},
		];
		const adopting = fakeLinear({ listed });
		// The earlier `__proto__` row is lost from the record (a lost response): the re-run finds it by its footer.
		const lost: TrackingRefs = { ...failed, linear: { nodes: {}, steps: {} } };
		const adopted = await createTracking(
			plan,
			graph,
			lost,
			deps({ linear: adopting, notionDataSource: undefined }),
		);
		// biome-ignore lint/suspicious/noProto: reason: this test asserts that a node id named __proto__ is stored as an own key, so the literal accessor is the subject under test. remove when: the node store no longer keys a plain object by node id.
		expect(adopted.linear.nodes["__proto__"]?.identifier).toBe("ENG-90");
		expect(
			adopting.calls.filter((call) => call.name === "save_issue").map((call) => call.args.title),
		).toEqual(["[constructor] A"]);
		expect(adopted.status).toBe("complete");
	});
});

/** A Linear fake that answers like `fakeLinear` unless `fail` returns an error for the call. */
function scriptedLinear(
	fail: (args: Record<string, unknown>, attempt: number) => Error | undefined,
): ToolCaller & { calls: Call[] } {
	const inner = fakeLinear();
	const attempts = new Map<string, number>();
	return {
		calls: inner.calls,
		async call(name, args, signal) {
			if (name !== "save_issue") return inner.call(name, args, signal);
			const key = String(args.title);
			const attempt = (attempts.get(key) ?? 0) + 1;
			attempts.set(key, attempt);
			const error = fail(args, attempt);
			if (error) {
				inner.calls.push({ name, args });
				throw error;
			}
			return inner.call(name, args, signal);
		},
	};
}

function independentNodes(count: number): { plan: TrackPlan; graph: ThoughtGraph } {
	const graph: ThoughtGraph = {
		goal: "Ship it",
		nodes: Array.from({ length: count }, (_, index) => ({
			id: `r${index + 1}`,
			title: `Root ${index + 1}`,
			kind: "generate" as const,
			question: `q${index + 1}`,
			dependsOn: [],
		})),
	};
	const base = makePlan();
	return {
		graph,
		plan: {
			...base,
			issues: graph.nodes.map((node) => ({
				graphId: base.graphId,
				nodeId: node.id,
				item: `[${node.id}] ${node.title}`,
				thought: node.question,
			})),
			subIssues: [],
			linearIssues: graph.nodes.map((node) => ({
				nodeId: node.id,
				title: node.title,
				description: `desc ${node.id}`,
			})),
			linearSubIssues: [],
		},
	};
}

describe("createTracking retry and breaker (TRK-02)", () => {
	test("a 429 with Retry-After is retried through the kernel and every node is still created", async () => {
		const sleeps: number[] = [];
		const linear = scriptedLinear((args, attempt) =>
			args.title === "[n1] Understand" && attempt === 1
				? failure("rate limited", { status: 429, retryAfterMs: 2_000 })
				: undefined,
		);
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear,
				notion: fakeNotion(),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		expect(Object.keys(refs.linear.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(linear.calls.filter((call) => call.args.title === "[n1] Understand")).toHaveLength(2);
		expect(sleeps).toContain(2_000);
		expect(refs.errors).toEqual([]);
	});

	test("a relay rate-limit message carries its Retry-After seconds into the wait", async () => {
		const sleeps: number[] = [];
		const linear = scriptedLinear((_args, attempt) =>
			attempt === 1 ? failure("mcp.linear.app rate limited; retry after 3s") : undefined,
		);
		await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear,
				notion: fakeNotion(),
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(3_000);
	});

	test("an auth or quota error opens a per-provider breaker: one call, one recorded error, Notion unaffected", async () => {
		const { plan, graph } = independentNodes(4);
		const linear = scriptedLinear(() => failure("Forbidden: plan quota", { status: 403 }));
		const notion = fakeNotion();
		const refs = await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear, notion, concurrency: 1 }),
		);
		expect(linear.calls.filter((call) => call.name === "save_issue")).toHaveLength(1);
		expect(refs.errors.filter((error) => error.startsWith("linear"))).toHaveLength(2);
		expect(refs.errors.some((error) => error.includes("breaker"))).toBe(true);
		expect(Object.keys(refs.notion.nodes)).toHaveLength(4);
		expect(refs.notion.taskUrl).toBeDefined();
	});

	test("a quota message without a status is permanent too and is not retried", async () => {
		const { plan, graph } = independentNodes(3);
		const sleeps: number[] = [];
		const linear = scriptedLinear(() =>
			failure("save_issue: usage limit exceeded for this workspace"),
		);
		await createTracking(
			plan,
			graph,
			undefined,
			deps({
				linear,
				concurrency: 1,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		expect(linear.calls.filter((call) => call.name === "save_issue")).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("a transient failure that never clears stops after the attempt cap, then the next node is tried", async () => {
		const { plan, graph } = independentNodes(2);
		const linear = scriptedLinear((args) =>
			args.title === "[r1] Root 1" ? failure("HTTP 503", { status: 503 }) : undefined,
		);
		const refs = await createTracking(plan, graph, undefined, deps({ linear, concurrency: 1 }));
		expect(linear.calls.filter((call) => call.args.title === "[r1] Root 1")).toHaveLength(3);
		expect(refs.linear.nodes.r2).toBeDefined();
		expect(refs.linear.nodes.r1).toBeUndefined();
		expect(refs.errors).toContain("linear r1: HTTP 503");
	});

	test("a node that fails for a node-specific reason does not stop the provider; dependents are created without it", async () => {
		const linear = scriptedLinear((args) =>
			args.title === "[n2] Build" ? failure("HTTP 404", { status: 404 }) : undefined,
		);
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion: fakeNotion() }),
		);
		const n3 = linear.calls.find((call) => call.args.title === "[n3] Review");
		expect(n3?.args.blockedBy).toEqual([refs.linear.nodes.n1?.identifier]);
		// n3's own sub-issues are still attempted; n2's are skipped because its parent was never created.
		expect(
			linear.calls.some((call) => call.args.parentId === refs.linear.nodes.n3?.identifier),
		).toBe(true);
		expect(refs.errors).toContain("linear n2.1: parent missing");
		expect(refs.errors).toContain("linear n3: blockedBy n2 omitted (dependency not created)");
		expect(refs.errors.some((error) => error.includes("dependency missing"))).toBe(false);
	});
});

describe("createTracking provider independence", () => {
	/** Wraps a Notion fake so a test can await the moment its Nth `notion-create-pages` call has been answered. */
	function watched(inner: ToolCaller & { calls: Call[] }) {
		const waiters: Array<{ count: number; done: () => void }> = [];
		const created = () => inner.calls.filter((call) => call.name === "notion-create-pages").length;
		const caller: ToolCaller & { calls: Call[] } = {
			calls: inner.calls,
			async call(name, args, signal) {
				const result = await inner.call(name, args, signal);
				for (const waiter of waiters) if (created() >= waiter.count) waiter.done();
				return result;
			},
		};
		const reached = (count: number): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (created() >= count) resolve();
			else waiters.push({ count, done: resolve });
			return promise;
		};
		return { caller, reached };
	}

	test("Notion rows are created while Linear hangs, without Linear links", async () => {
		const hang: ToolCaller = { call: () => Promise.withResolvers<unknown>().promise };
		const { caller: notion, reached } = watched(fakeNotion());
		const armed = new Map<number, () => void>();
		const linkTimerArmed = Promise.withResolvers<void>();
		const timers = {
			setTimeout: (fn: () => void, ms: number) => {
				armed.set(ms, fn);
				if (ms === 777) linkTimerArmed.resolve();
				return {} as NodeJS.Timeout;
			},
			clearTimeout: () => undefined,
		};
		const tracking = createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: hang, notion, timers, budgetMs: 5_000, linkWaitMs: 777 }),
		);
		// Notion reaches its Linear link wait after the task row; the grace timer is fired by hand.
		await linkTimerArmed.promise;
		armed.get(777)?.();
		await reached(3);
		armed.get(5_000)?.();
		const refs = await tracking;
		expect(refs.notion.taskUrl).toBeDefined();
		expect(Object.keys(refs.notion.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		const nodeCall = notion.calls.find(
			(call) => call.name === "notion-create-pages" && (call.args.pages as unknown[]).length === 3,
		);
		const pages = nodeCall?.args.pages as Array<{ properties: Record<string, unknown> }>;
		expect(pages.every((page) => page.properties["Linear URL"] === undefined)).toBe(true);
	});

	test("Notion rows carry the Linear URLs of rows Linear finished in time", async () => {
		const linear = fakeLinear();
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		const nodeCall = notion.calls.find(
			(call) => call.name === "notion-create-pages" && (call.args.pages as unknown[]).length === 3,
		);
		const pages = nodeCall?.args.pages as Array<{ properties: Record<string, unknown> }>;
		expect(pages.map((page) => page.properties["Linear URL"])).toEqual([
			refs.linear.nodes.n1?.url,
			refs.linear.nodes.n2?.url,
			refs.linear.nodes.n3?.url,
		]);
	});

	test("Notion's task and node rows do not wait for Linear's sub-issues", async () => {
		const gate = Promise.withResolvers<void>();
		const inner = fakeLinear();
		const linear: ToolCaller = {
			async call(name, args, signal) {
				if (name === "save_issue" && args.parentId !== undefined) await gate.promise;
				return inner.call(name, args, signal);
			},
		};
		const { caller: notion, reached } = watched(fakeNotion());
		const tracking = createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		// The task row and the three node rows are out while every Linear sub-issue is still held.
		await reached(2);
		expect(notion.calls.filter((call) => call.name === "notion-create-pages")).toHaveLength(2);
		gate.resolve();
		const refs = await tracking;
		expect(refs.status).toBe("complete");
	});
});

describe("createTracking adoption and credential errors", () => {
	function shell(): TrackingRefs {
		return {
			graphId: "g-1",
			status: "failed",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 1,
		};
	}

	test("a failed Linear adoption lookup is recorded and creates no duplicate rows", async () => {
		const linear: ToolCaller & { calls: Call[] } = {
			calls: [],
			async call(name, args) {
				this.calls.push({ name, args });
				throw failure("list_issues: HTTP 400", { status: 400 });
			},
		};
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, shell(), deps({ linear, notion }));
		expect(refs.errors.some((error) => error.startsWith("linear adopt:"))).toBe(true);
		expect(linear.calls.filter((call) => call.name === "save_issue")).toEqual([]);
		// Notion's own adoption worked, so its rows are still created.
		expect(Object.keys(refs.notion.nodes)).toHaveLength(3);
	});

	test("a failed Notion adoption query is recorded and creates no duplicate rows", async () => {
		const inner = fakeNotion();
		const notion: ToolCaller & { calls: Call[] } = {
			calls: inner.calls,
			async call(name, args, signal) {
				if (name === "notion-query-data-sources") {
					inner.calls.push({ name, args });
					throw failure("query: HTTP 400", { status: 400 });
				}
				return inner.call(name, args, signal);
			},
		};
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			shell(),
			deps({ linear: fakeLinear(), notion }),
		);
		expect(refs.errors.some((error) => error.startsWith("notion adopt:"))).toBe(true);
		expect(notion.calls.filter((call) => call.name === "notion-create-pages")).toEqual([]);
		expect(Object.keys(refs.linear.nodes)).toHaveLength(3);
	});

	test("a credential lookup error is reported as such, distinct from login required", async () => {
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear: fakeLinear(),
				credentialErrors: { notion: "credential store /x/creds.json is unreadable (invalid_json)" },
			}),
		);
		expect(refs.errors).toContain(
			"notion: credential error: credential store /x/creds.json is unreadable (invalid_json)",
		);
		expect(refs.errors).not.toContain("notion: login required");
		const unconfigured = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear() }),
		);
		expect(unconfigured.errors).toContain("notion: login required");
	});
});

describe("createTracking Notion field caps", () => {
	test("over-long Item and Thought values are clipped with a marker", async () => {
		const plan = makePlan();
		const first = plan.issues[0];
		if (!first) throw new Error("plan has no issue");
		first.item = `[n1] ${"T".repeat(500)}`;
		first.thought = "x".repeat(FIELD_CAPS.conclusion + 5_000);
		const sub = plan.subIssues[0];
		if (!sub) throw new Error("plan has no sub-issue");
		sub.thought = "y".repeat(FIELD_CAPS.thinking + 5_000);
		const notion = fakeNotion();
		await createTracking(plan, GRAPH, undefined, deps({ notion }));
		const pages = notion.calls
			.filter((call) => call.name === "notion-create-pages")
			.flatMap((call) => call.args.pages as Array<{ properties: Record<string, string> }>);
		const node = pages.find(
			(page) => page.properties.Level === "Issue" && page.properties.Item?.startsWith("[n1]"),
		);
		expect(node?.properties.Item?.length).toBe(FIELD_CAPS.title);
		expect(node?.properties.Item).toEndWith("…[clipped]");
		expect(node?.properties.Thought?.length).toBe(FIELD_CAPS.conclusion);
		const step = pages.find(
			(page) =>
				page.properties.Level === "Sub-Issue" && page.properties.Step === (1 as unknown as string),
		);
		expect(step?.properties.Thought?.length).toBe(FIELD_CAPS.thinking);
	});
});

describe("createTracking degraded fill marker", () => {
	test("rows of a degraded node say so in the Linear title and the Notion Item and Thought", async () => {
		const linear = fakeLinear();
		const notion = fakeNotion();
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notion, degradedNodes: ["n2"] }),
		);
		const titles = linear.calls
			.filter((call) => call.name === "save_issue")
			.map((call) => call.args.title);
		expect(titles).toContain("[n2] [degraded fill] Build");
		expect(titles).toContain("[n1] Understand");
		expect(refs.linear.nodes.n2?.title).toBe("[n2] [degraded fill] Build");
		const pages = notion.calls
			.filter((call) => call.name === "notion-create-pages")
			.flatMap((call) => call.args.pages as Array<{ properties: Record<string, unknown> }>);
		const row = pages.find(
			(page) =>
				page.properties.Level === "Issue" && String(page.properties.Item).startsWith("[n2]"),
		);
		expect(row?.properties.Item).toBe("[n2] [degraded fill] Build");
		expect(String(row?.properties.Thought)).toStartWith("[degraded fill] ");
		const clean = pages.find(
			(page) =>
				page.properties.Level === "Issue" && String(page.properties.Item).startsWith("[n1]"),
		);
		expect(clean?.properties.Item).toBe("[n1] Understand");
		expect(String(clean?.properties.Thought)).not.toContain("[degraded fill]");
		const steps = pages.filter(
			(page) =>
				page.properties.Level === "Sub-Issue" && String(page.properties.Item).startsWith("[n2]"),
		);
		expect(
			steps.every((page) => String(page.properties.Thought).startsWith("[degraded fill] ")),
		).toBe(true);
	});

	test("a degraded node's Notion row is still adopted by its node id", async () => {
		const notion = fakeNotion({
			rows: [
				{ url: "https://www.notion.so/t", Level: "Task", Item: "Ship it" },
				{ url: "https://www.notion.so/n2", Level: "Issue", Item: "[n2] [degraded fill] Build" },
			],
		});
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			{
				graphId: "g-1",
				status: "failed",
				linear: { nodes: {}, steps: {} },
				notion: { nodes: {}, steps: {} },
				errors: [],
				updatedAt: 1,
			},
			deps({ notion, linearTeam: undefined, degradedNodes: ["n2"] }),
		);
		expect(refs.notion.nodes.n2).toBe("https://www.notion.so/n2");
	});
});

/** A lost reply: the request may have reached the tracker, the answer never came back. */
function timedOut(): Error {
	return failure("request timed out after 30000ms");
}

describe("createTracking lost replies (greptile r1 #2)", () => {
	test("a Linear create whose reply was lost is read back and adopted, not created again", async () => {
		const { plan, graph } = independentNodes(2);
		const linear = statefulLinear({
			afterCreate: (args, attempt) =>
				args.title === "[r1] Root 1" && attempt === 1 ? timedOut() : undefined,
		});
		const refs = await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear, notionDataSource: undefined, concurrency: 1 }),
		);
		expect(linear.rows.map((row) => row.title).sort()).toEqual(["[r1] Root 1", "[r2] Root 2"]);
		expect(linear.calls.filter((call) => call.name === "save_issue")).toHaveLength(2);
		expect(refs.linear.nodes.r1?.identifier).toBe("ENG-1");
		expect(refs.errors).toEqual([]);
		expect(refs.status).toBe("complete");
	});

	test("a 5xx that created nothing is read back, found missing, and then repeated", async () => {
		const { plan, graph } = independentNodes(1);
		let failed = false;
		const inner = statefulLinear();
		const linear: typeof inner = {
			calls: inner.calls,
			rows: inner.rows,
			async call(name, args, signal) {
				if (name === "save_issue" && !failed) {
					failed = true;
					inner.calls.push({ name, args });
					throw failure("HTTP 503", { status: 503 });
				}
				return inner.call(name, args, signal);
			},
		};
		const refs = await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear, notionDataSource: undefined }),
		);
		expect(inner.rows).toHaveLength(1);
		expect(inner.calls.map((call) => call.name)).toEqual([
			"save_issue",
			"list_issues",
			"save_issue",
		]);
		expect(refs.linear.nodes.r1?.identifier).toBe("ENG-1");
	});

	test("a failure known to precede creation is retried without a read-back", async () => {
		const { plan, graph } = independentNodes(1);
		const linear = scriptedLinear((_args, attempt) =>
			attempt === 1 ? failure("rate limited", { status: 429 }) : undefined,
		);
		await createTracking(plan, graph, undefined, deps({ linear, notionDataSource: undefined }));
		expect(linear.calls.some((call) => call.name === "list_issues")).toBe(false);
		expect(linear.calls.filter((call) => call.name === "save_issue")).toHaveLength(2);
		const refused = scriptedLinear((_args, attempt) =>
			attempt === 1
				? failure("connect ECONNREFUSED 127.0.0.1:443", { code: "ECONNREFUSED" })
				: undefined,
		);
		await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear: refused, notionDataSource: undefined }),
		);
		expect(refused.calls.some((call) => call.name === "list_issues")).toBe(false);
		expect(refused.calls.filter((call) => call.name === "save_issue")).toHaveLength(2);
	});

	test("when the read-back itself fails the create is not repeated and the node says why", async () => {
		const { plan, graph } = independentNodes(2);
		const linear = statefulLinear({
			afterCreate: (args) => (args.title === "[r1] Root 1" ? timedOut() : undefined),
			listError: failure("list_issues: HTTP 400", { status: 400 }),
		});
		const refs = await createTracking(
			plan,
			graph,
			undefined,
			deps({ linear, notionDataSource: undefined, concurrency: 1 }),
		);
		expect(linear.rows.filter((row) => row.title === "[r1] Root 1")).toHaveLength(1);
		expect(linear.calls.filter((call) => call.name === "save_issue")).toHaveLength(2);
		expect(refs.linear.nodes.r1).toBeUndefined();
		expect(refs.linear.nodes.r2).toBeDefined();
		expect(
			refs.errors.some((error) => error.startsWith("linear r1:") && error.includes("read-back")),
		).toBe(true);
		expect(refs.status).toBe("partial");
	});

	test("a Notion node batch whose reply was lost is read back and adopted, not created again", async () => {
		const notion = statefulNotion({
			lose: (call) => (call === 2 ? timedOut() : undefined),
		});
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion }),
		);
		expect(notion.rows.filter((row) => row.Level === "Issue")).toHaveLength(3);
		expect(notion.rows.filter((row) => row.Level === "Sub-Issue")).toHaveLength(6);
		expect(Object.keys(refs.notion.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
	});

	test("a Notion batch that persisted only part of its pages creates just the missing ones", async () => {
		const notion = statefulNotion({
			persist: (call) => (call === 2 ? 1 : undefined),
			lose: (call) => (call === 2 ? timedOut() : undefined),
		});
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion }),
		);
		expect(notion.rows.filter((row) => row.Level === "Issue")).toHaveLength(3);
		expect(Object.keys(refs.notion.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(refs.status).toBe("complete");
	});

	test("a Notion read-back that fails does not repeat the create", async () => {
		const notion = statefulNotion({
			lose: (call) => (call === 1 ? timedOut() : undefined),
			queryError: failure("query: HTTP 400", { status: 400 }),
		});
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: fakeLinear(), notion }),
		);
		expect(notion.rows.filter((row) => row.Level === "Task")).toHaveLength(1);
		expect(notion.calls.filter((call) => call.name === "notion-create-pages")).toHaveLength(1);
		expect(refs.notion.taskUrl).toBeUndefined();
		expect(
			refs.errors.some((error) => error.startsWith("notion task:") && error.includes("read-back")),
		).toBe(true);
	});
});

/** The plan of a resend whose model answered with other work for n2 (a new title) and for step 2 of n3 (a new step). */
function replanned(): TrackPlan {
	const plan = makePlan();
	return {
		...plan,
		issues: plan.issues.map((row) =>
			row.nodeId === "n2" ? { ...row, item: "[n2] Rebuild from scratch" } : row,
		),
		subIssues: plan.subIssues.map((row) =>
			row.nodeId === "n3" && row.step === 2 ? { ...row, item: "[n3] Step 2: other work" } : row,
		),
		linearIssues: plan.linearIssues.map((row) =>
			row.nodeId === "n2" ? { ...row, title: "Rebuild from scratch" } : row,
		),
		linearSubIssues: plan.linearSubIssues.map((row) =>
			row.nodeId === "n3" && row.step === 2
				? { ...row, title: "Review — Step 2: other work" }
				: row,
		),
	};
}

describe("createTracking adoption verifies content (greptile r1 #3)", () => {
	test("a resend with other titles for n2 and a step creates fresh rows and leaves the old ones alone", async () => {
		const linear = statefulLinear();
		const notion = statefulNotion();
		const first = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		expect(first.status).toBe("complete");
		const second = await createTracking(
			replanned(),
			GRAPH,
			structuredClone(first),
			deps({ linear, notion }),
		);
		expect(second.status).toBe("complete");
		// Linear: n2 and its steps are new rows (steps hang under the new parent); n3.2 is new; the rest are adopted as they were.
		for (const key of ["n2"])
			expect(second.linear.nodes[key]?.id).not.toBe(first.linear.nodes[key]?.id);
		for (const key of ["n2.1", "n2.2", "n3.2"])
			expect(second.linear.steps[key]?.id).not.toBe(first.linear.steps[key]?.id);
		for (const key of ["n1.1", "n1.2", "n3.1"])
			expect(second.linear.steps[key]?.id).toBe(first.linear.steps[key]?.id);
		expect(second.linear.nodes.n1?.id).toBe(first.linear.nodes.n1?.id);
		expect(second.linear.nodes.n3?.id).toBe(first.linear.nodes.n3?.id);
		expect(second.linear.nodes.n2?.title).toBe("[n2] Rebuild from scratch");
		// The two steps of the new n2 are created under the new parent, none under the old one.
		const reparented = linear.calls.filter(
			(call) => call.args.parentId === second.linear.nodes.n2?.identifier,
		);
		expect(reparented).toHaveLength(2);
		// Notion: the same.
		expect(second.notion.nodes.n2).not.toBe(first.notion.nodes.n2);
		expect(second.notion.steps["n3.2"]).not.toBe(first.notion.steps["n3.2"]);
		expect(second.notion.steps["n2.1"]).not.toBe(first.notion.steps["n2.1"]);
		expect(second.notion.nodes.n1).toBe(first.notion.nodes.n1);
		expect(second.notion.steps["n3.1"]).toBe(first.notion.steps["n3.1"]);
		// Nothing was deleted: the old rows are all still there beside the new ones.
		expect(linear.rows).toHaveLength(9 + 1 + 2 + 1);
		expect(notion.rows).toHaveLength(10 + 1 + 2 + 1);
		// n3 was blocked by the old n2: the new n2 is linked onto the kept n3.
		expect(
			linear.calls.some(
				(call) =>
					call.args.id === first.linear.nodes.n3?.identifier &&
					JSON.stringify(call.args.blockedBy) ===
						JSON.stringify([second.linear.nodes.n2?.identifier]),
			),
		).toBe(true);
	});

	test("an identical resend adopts every row and creates nothing", async () => {
		const linear = statefulLinear();
		const notion = statefulNotion();
		const first = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		const lost: TrackingRefs = {
			...structuredClone(first),
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
		};
		delete lost.notion.taskUrl;
		const resend = await createTracking(makePlan(), GRAPH, lost, deps({ linear, notion }));
		expect(linear.rows).toHaveLength(9);
		expect(notion.rows).toHaveLength(10);
		expect(resend.linear).toEqual(first.linear);
		expect(resend.notion).toEqual(first.notion);
		const kept = await createTracking(
			makePlan(),
			GRAPH,
			structuredClone(first),
			deps({ linear, notion }),
		);
		expect(linear.rows).toHaveLength(9);
		expect(notion.rows).toHaveLength(10);
		expect(kept.status).toBe("complete");
	});

	test("rows adopted by footer are matched on their title: a row of the same node with other work is not taken", async () => {
		const linear = statefulLinear();
		const first = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear, notionDataSource: undefined }),
		);
		const lost: TrackingRefs = { ...structuredClone(first), linear: { nodes: {}, steps: {} } };
		const second = await createTracking(
			replanned(),
			GRAPH,
			lost,
			deps({ linear, notionDataSource: undefined }),
		);
		expect(second.linear.nodes.n2?.id).not.toBe(first.linear.nodes.n2?.id);
		expect(second.linear.nodes.n1?.id).toBe(first.linear.nodes.n1?.id);
		expect(second.linear.steps["n3.2"]?.id).not.toBe(first.linear.steps["n3.2"]?.id);
		expect(second.linear.steps["n3.1"]?.id).toBe(first.linear.steps["n3.1"]?.id);
	});

	test("titles compare trimmed, whitespace-collapsed and case-insensitive", async () => {
		const rows = [
			{
				identifier: "ENG-90",
				url: "https://linear.app/org/issue/ENG-90/x",
				title: "  [N1]   understand ",
				description: "d\n\nultrathink graph g-1 · node n1",
			},
		];
		const linear = fakeLinear({ listed: () => rows });
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			{
				graphId: "g-1",
				status: "failed",
				linear: { nodes: {}, steps: {} },
				notion: { nodes: {}, steps: {} },
				errors: [],
				updatedAt: 1,
			},
			deps({ linear, notionDataSource: undefined }),
		);
		expect(refs.linear.nodes.n1?.identifier).toBe("ENG-90");
		expect(linear.calls.filter((call) => call.args.title === "[n1] Understand")).toHaveLength(0);
	});
});

describe("createTracking missing links are repaired (greptile r1 #12)", () => {
	test("a node created without its failed dependency is linked once that dependency exists", async () => {
		const linear = statefulLinear();
		const failing: ToolCaller & { calls: Call[] } = {
			calls: linear.calls,
			async call(name, args, signal) {
				if (name === "save_issue" && args.title === "[n2] Build")
					throw failure("HTTP 404", { status: 404 });
				return linear.call(name, args, signal);
			},
		};
		const first = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: failing, notionDataSource: undefined }),
		);
		expect(first.linear.nodes.n3).toBeDefined();
		expect(first.linear.nodes.n2).toBeUndefined();
		expect(first.pendingLinks).toEqual({ n3: ["n2"] });
		expect(first.status).toBe("partial");
		const second = await createTracking(
			makePlan(),
			GRAPH,
			structuredClone(first),
			deps({ linear, notionDataSource: undefined }),
		);
		expect(second.linear.nodes.n2).toBeDefined();
		const repair = linear.calls.find((call) => call.args.id === first.linear.nodes.n3?.identifier);
		expect(repair?.args).toEqual({
			id: first.linear.nodes.n3?.identifier,
			blockedBy: [second.linear.nodes.n2?.identifier],
		});
		expect(second.pendingLinks).toBeUndefined();
		expect(second.status).toBe("complete");
		// Nothing is repaired twice: a third run makes no update.
		const before = linear.calls.length;
		await createTracking(
			makePlan(),
			GRAPH,
			structuredClone(second),
			deps({ linear, notionDataSource: undefined }),
		);
		expect(linear.calls.slice(before).filter((call) => call.args.id !== undefined)).toEqual([]);
	});

	test("a repair that fails stays pending, keeps the run partial and is tried again next run", async () => {
		const linear = statefulLinear();
		let n2Down = true;
		let linkDown = true;
		const flaky: ToolCaller & { calls: Call[] } = {
			calls: linear.calls,
			async call(name, args, signal) {
				if (name === "save_issue" && args.title === "[n2] Build" && n2Down)
					throw failure("HTTP 404", { status: 404 });
				if (name === "save_issue" && args.id !== undefined && linkDown)
					throw failure("HTTP 400", { status: 400 });
				return linear.call(name, args, signal);
			},
		};
		const run = (existing: TrackingRefs | undefined) =>
			createTracking(
				makePlan(),
				GRAPH,
				existing === undefined ? undefined : structuredClone(existing),
				deps({ linear: flaky, notionDataSource: undefined }),
			);
		const first = await run(undefined);
		n2Down = false;
		const second = await run(first);
		expect(second.linear.nodes.n2).toBeDefined();
		expect(second.pendingLinks).toEqual({ n3: ["n2"] });
		expect(second.status).toBe("partial");
		expect(second.errors.some((error) => error.startsWith("linear n3"))).toBe(true);
		linkDown = false;
		const third = await run(second);
		expect(third.pendingLinks).toBeUndefined();
		expect(third.status).toBe("complete");
		expect(
			linear.calls.some(
				(call) =>
					call.args.id === third.linear.nodes.n3?.identifier &&
					JSON.stringify(call.args.blockedBy) ===
						JSON.stringify([third.linear.nodes.n2?.identifier]),
			),
		).toBe(true);
	});
});

describe("createTracking children belong to the current parent (greptile r2 #2)", () => {
	const notionOnly = (notion: ToolCaller) => deps({ notion, linearTeam: undefined });
	const parentOf = (
		notion: { rows: Array<{ url: string; "Parent Item"?: string }> },
		url?: string,
	) => notion.rows.find((row) => row.url === url)?.["Parent Item"];

	test("a replacement Issue does not adopt the children of the old one; its failed child create leaves tracking partial", async () => {
		// Calls: 1 task, 2 nodes, 3 steps (first pass); 4 the replacement n2, 5 its children and n3.2 (second pass).
		const notion = statefulNotion({
			refuse: (call) => (call === 5 ? failure("HTTP 400", { status: 400 }) : undefined),
		});
		const first = await createTracking(makePlan(), GRAPH, undefined, notionOnly(notion));
		expect(first.status).toBe("complete");
		const second = await createTracking(
			replanned(),
			GRAPH,
			structuredClone(first),
			notionOnly(notion),
		);
		expect(second.notion.nodes.n2).not.toBe(first.notion.nodes.n2);
		expect(second.notion.steps["n2.1"]).toBeUndefined();
		expect(second.status).toBe("partial");
		// The next run finds the old children by key and title, but they hang under the old Issue: new ones are made.
		const third = await createTracking(
			replanned(),
			GRAPH,
			structuredClone(second),
			notionOnly(notion),
		);
		expect(third.status).toBe("complete");
		for (const key of ["n2.1", "n2.2"]) {
			expect(third.notion.steps[key]).not.toBe(first.notion.steps[key]);
			expect(parentOf(notion, third.notion.steps[key])).toBe(
				JSON.stringify([third.notion.nodes.n2]),
			);
		}
		// A child of a kept Issue is still adopted: n1's children were never touched.
		expect(third.notion.steps["n1.1"]).toBe(first.notion.steps["n1.1"]);
	});

	test("a lost reply on the children of a replacement Issue is not answered with the old Issue's children", async () => {
		// The replacement n2 is call 4; its children are call 5, which makes nothing and then loses its reply.
		const notion = statefulNotion({
			persist: (call) => (call === 5 ? 0 : undefined),
			lose: (call) => (call === 5 ? timedOut() : undefined),
		});
		const first = await createTracking(makePlan(), GRAPH, undefined, notionOnly(notion));
		const second = await createTracking(
			replanned(),
			GRAPH,
			structuredClone(first),
			notionOnly(notion),
		);
		expect(second.status).toBe("complete");
		for (const key of ["n2.1", "n2.2"]) {
			expect(second.notion.steps[key]).not.toBe(first.notion.steps[key]);
			expect(parentOf(notion, second.notion.steps[key])).toBe(
				JSON.stringify([second.notion.nodes.n2]),
			);
		}
	});

	test("Parent Item matches by page id whatever the url form", async () => {
		const id = "0123456789abcdef0123456789abcdef";
		const rows = [
			{ url: `https://www.notion.so/Task-${"a".repeat(32)}`, Level: "Task", Item: "Ship it" },
			{ url: `https://www.notion.so/${id}`, Level: "Issue", Item: "[n1] Understand" },
			{
				url: "https://www.notion.so/child-1",
				Level: "Sub-Issue",
				Item: "[n1] Step 1: s",
				Step: 1,
				"Parent Item": `["https://notion.so/Understand-${id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}"]`,
			},
			{
				url: "https://www.notion.so/child-2",
				Level: "Sub-Issue",
				Item: "[n1] Step 2: s",
				Step: 2,
				"Parent Item": `["https://www.notion.so/${"b".repeat(32)}"]`,
			},
		];
		const refs = await createTracking(
			makePlan(),
			GRAPH,
			{
				graphId: "g-1",
				status: "failed",
				linear: { nodes: {}, steps: {} },
				notion: { nodes: {}, steps: {} },
				errors: [],
				updatedAt: 1,
			},
			deps({ notion: fakeNotion({ rows }), linearTeam: undefined }),
		);
		expect(refs.notion.steps["n1.1"]).toBe("https://www.notion.so/child-1");
		expect(refs.notion.steps["n1.2"]).not.toBe("https://www.notion.so/child-2");
	});
});

describe("createTracking long degraded titles (greptile r2 #3)", () => {
	function longPlan(): TrackPlan {
		const plan = makePlan();
		const item = `[n2] ${"x".repeat(165)}`;
		return {
			...plan,
			issues: plan.issues.map((row) => (row.nodeId === "n2" ? { ...row, item } : row)),
		};
	}
	const options = (notion: ToolCaller) =>
		deps({ notion, linearTeam: undefined, degradedNodes: ["n2"] });

	test("a degraded title over the cap matches itself on the next run: one row, same ref", async () => {
		const notion = statefulNotion();
		const first = await createTracking(longPlan(), GRAPH, undefined, options(notion));
		const second = await createTracking(longPlan(), GRAPH, structuredClone(first), options(notion));
		expect(notion.rows.filter((row) => row.Level === "Issue")).toHaveLength(3);
		expect(notion.rows.filter((row) => row.Level === "Sub-Issue")).toHaveLength(6);
		expect(second.notion.nodes.n2).toBe(first.notion.nodes.n2);
		expect(second.status).toBe("complete");
		const created = notion.calls.filter((call) => call.name === "notion-create-pages").length;
		expect(created).toBe(3);
	});

	test("the same row is adopted from a lost record, and by a run that no longer knows the node is degraded", async () => {
		const notion = statefulNotion();
		const first = await createTracking(longPlan(), GRAPH, undefined, options(notion));
		const lost: TrackingRefs = {
			...structuredClone(first),
			notion: { nodes: {}, steps: {} },
		};
		delete lost.notion.taskUrl;
		const adopted = await createTracking(longPlan(), GRAPH, lost, options(notion));
		expect(adopted.notion.nodes.n2).toBe(first.notion.nodes.n2);
		const clean = await createTracking(
			longPlan(),
			GRAPH,
			structuredClone(first),
			deps({ notion, linearTeam: undefined }),
		);
		expect(clean.notion.nodes.n2).toBe(first.notion.nodes.n2);
		expect(notion.rows.filter((row) => row.Level === "Issue")).toHaveLength(3);
	});
});

describe("createTracking links to a dependency that now exists (greptile r2 #1)", () => {
	test("a record without pending links is repaired when a dependency of an existing issue gets its issue", async () => {
		const linear = statefulLinear();
		const failing: ToolCaller & { calls: Call[] } = {
			calls: linear.calls,
			async call(name, args, signal) {
				if (name === "save_issue" && args.title === "[n2] Build")
					throw failure("HTTP 404", { status: 404 });
				return linear.call(name, args, signal);
			},
		};
		const first = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: failing, notionDataSource: undefined }),
		);
		// A record written before pending links were kept.
		const legacy = structuredClone(first);
		delete legacy.pendingLinks;
		const second = await createTracking(
			makePlan(),
			GRAPH,
			legacy,
			deps({ linear, notionDataSource: undefined }),
		);
		expect(
			linear.calls.some(
				(call) =>
					call.args.id === first.linear.nodes.n3?.identifier &&
					JSON.stringify(call.args.blockedBy) ===
						JSON.stringify([second.linear.nodes.n2?.identifier]),
			),
		).toBe(true);
		expect(second.status).toBe("complete");
		expect(second.pendingLinks).toBeUndefined();
	});
});

describe("createTracking links for adopted nodes (greptile r3 #0)", () => {
	test("a dependent adopted from the tracker gets the link once its dependency gets an issue", async () => {
		const linear = statefulLinear();
		const failing: ToolCaller & { calls: Call[] } = {
			calls: linear.calls,
			async call(name, args, signal) {
				if (name === "save_issue" && args.title === "[n2] Build")
					throw failure("HTTP 404", { status: 404 });
				return linear.call(name, args, signal);
			},
		};
		const first = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: failing, notionDataSource: undefined }),
		);
		expect(first.linear.nodes.n3).toBeDefined();
		expect(first.linear.nodes.n2).toBeUndefined();
		// The record is lost: n3 is found again in the tracker (adopted), n2 is made in this run.
		const lost: TrackingRefs = {
			graphId: "g-1",
			status: "failed",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 1,
		};
		const second = await createTracking(
			makePlan(),
			GRAPH,
			lost,
			deps({ linear, notionDataSource: undefined }),
		);
		expect(second.linear.nodes.n3?.id).toBe(first.linear.nodes.n3?.id);
		expect(
			linear.calls.some(
				(call) =>
					call.args.id === first.linear.nodes.n3?.identifier &&
					JSON.stringify(call.args.blockedBy) ===
						JSON.stringify([second.linear.nodes.n2?.identifier]),
			),
		).toBe(true);
		expect(second.pendingLinks).toBeUndefined();
		expect(second.status).toBe("complete");
	});

	test("an adopted dependent whose link update fails stays pending and the run is partial", async () => {
		const linear = statefulLinear();
		let n2Down = true;
		let linkDown = true;
		const flaky: ToolCaller & { calls: Call[] } = {
			calls: linear.calls,
			async call(name, args, signal) {
				if (name === "save_issue" && args.title === "[n2] Build" && n2Down)
					throw failure("HTTP 404", { status: 404 });
				if (name === "save_issue" && args.id !== undefined && linkDown)
					throw failure("HTTP 400", { status: 400 });
				return linear.call(name, args, signal);
			},
		};
		await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({ linear: flaky, notionDataSource: undefined }),
		);
		n2Down = false;
		const shell = (): TrackingRefs => ({
			graphId: "g-1",
			status: "failed",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 1,
		});
		const second = await createTracking(
			makePlan(),
			GRAPH,
			shell(),
			deps({ linear: flaky, notionDataSource: undefined }),
		);
		expect(second.pendingLinks).toEqual({ n3: ["n2"] });
		expect(second.status).toBe("partial");
		linkDown = false;
		const third = await createTracking(
			makePlan(),
			GRAPH,
			structuredClone(second),
			deps({ linear: flaky, notionDataSource: undefined }),
		);
		expect(third.pendingLinks).toBeUndefined();
		expect(third.status).toBe("complete");
	});
});

describe("createTracking compares Notion pages by id (greptile r3 pre-review)", () => {
	const PAGE = "0123456789abcdef0123456789abcdef";

	test("a ref stored as https://www.notion.so/<id> is recognised against a row url in another form and dropped as stale", async () => {
		const rows = (url: string) => [
			{ url: `https://www.notion.so/Task-${"a".repeat(32)}`, Level: "Task", Item: "Ship it" },
			{ url, Level: "Issue", Item: "[n2] A different title from an older plan" },
		];
		const recorded: TrackingRefs = {
			graphId: "g-1",
			status: "partial",
			linear: { nodes: {}, steps: {} },
			notion: {
				taskUrl: `https://www.notion.so/Task-${"a".repeat(32)}`,
				nodes: { n2: `https://www.notion.so/${PAGE}` },
				steps: {},
			},
			errors: [],
			updatedAt: 1,
		};
		for (const url of [
			`https://notion.so/${PAGE}`,
			`https://www.notion.so/${PAGE}?pvs=4`,
			`https://www.notion.so/Build-${PAGE.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")}`,
		]) {
			const notion = fakeNotion({ rows: rows(url) });
			const refs = await createTracking(
				makePlan(),
				GRAPH,
				structuredClone(recorded),
				deps({ notion, linearTeam: undefined }),
			);
			// The recorded row says other work: the ref is dropped and a fresh Issue is made.
			expect(refs.notion.nodes.n2, url).not.toBe(`https://www.notion.so/${PAGE}`);
			expect(refs.status, url).toBe("complete");
		}
	});
});

describe("createTracking provider branches are independent (greptile r5 #0)", () => {
	test("a Linear lookup that never settles does not hold up Notion: its rows are still made and Linear reports the budget", async () => {
		const hang: ToolCaller = { call: () => Promise.withResolvers<unknown>().promise };
		const notion = statefulNotion();
		const armed = new Map<number, () => void>();
		const linkTimerArmed = Promise.withResolvers<void>();
		const timers = {
			setTimeout: (fn: () => void, ms: number) => {
				armed.set(ms, fn);
				if (ms === 777) linkTimerArmed.resolve();
				return {} as NodeJS.Timeout;
			},
			clearTimeout: () => undefined,
		};
		const shell: TrackingRefs = {
			graphId: "g-1",
			status: "failed",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 1,
		};
		const tracking = createTracking(
			makePlan(),
			GRAPH,
			shell,
			deps({ linear: hang, notion, timers, budgetMs: 5_000, linkWaitMs: 777 }),
		);
		// Notion looked its rows up and created the task without waiting for Linear; it now waits (bounded) for Linear's links.
		await linkTimerArmed.promise;
		expect(notion.rows.filter((row) => row.Level === "Task")).toHaveLength(1);
		armed.get(777)?.();
		// Let Notion finish its rows, then the budget ends the stuck Linear lookup.
		for (let i = 0; i < 50 && notion.rows.length < 10; i++)
			await new Promise((r) => setTimeout(r, 0));
		armed.get(5_000)?.();
		const refs = await tracking;
		expect(notion.rows).toHaveLength(10);
		expect(Object.keys(refs.notion.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(refs.errors.some((error) => error.startsWith("linear adopt:"))).toBe(true);
		expect(Object.keys(refs.linear.nodes)).toEqual([]);
	});
});
