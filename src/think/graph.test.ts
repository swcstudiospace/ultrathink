// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { FIELD_CAPS } from "../resilience/limits.ts";
import { splitRationaleSteps } from "../track/plan.ts";
import {
	dependencyLevels,
	extractJsonObject,
	extractTag,
	graphSketch,
	graphToXml,
	injectGraphXml,
	isFallbackGraph,
	normalizeGraph,
	parseNodeFill,
	topoSort,
	workflowWaves,
} from "./graph.ts";
import { FALLBACK_GRAPH, MAX_NODES, MIN_NODES, type ThoughtNode } from "./types.ts";

describe("extractJsonObject", () => {
	test("parses fenced json and raw objects", () => {
		expect(extractJsonObject('```json\n{"goal":"g"}\n```')).toEqual({ goal: "g" });
		expect(extractJsonObject('noise {"goal":"g","nodes":[]} trailing')).toEqual({
			goal: "g",
			nodes: [],
		});
		expect(extractJsonObject("not json")).toBeNull();
	});
});

describe("extractTag", () => {
	test("reads inner text case-insensitively", () => {
		expect(extractTag("<THINKING> step </THINKING>", "thinking")).toBe("step");
	});
});

describe("isFallbackGraph", () => {
	test("matches the substituted boilerplate but no real graph", () => {
		expect(isFallbackGraph(FALLBACK_GRAPH)).toBe(true);
		expect(isFallbackGraph(normalizeGraph(null, "goal", MIN_NODES, MAX_NODES))).toBe(true);
		const real = normalizeGraph(
			{
				goal: "Ship it",
				nodes: FALLBACK_GRAPH.nodes.map((node) => ({
					...node,
					question: `${node.question} (task)`,
				})),
			},
			"goal",
			MIN_NODES,
			MAX_NODES,
		);
		expect(isFallbackGraph(real)).toBe(false);
	});
});

describe("normalizeGraph", () => {
	test("pads with fallback when too few nodes", () => {
		const out = normalizeGraph(
			{
				goal: "x",
				nodes: [{ id: "n1", title: "A", kind: "understand", question: "q", depends_on: [] }],
			},
			"goal",
			MIN_NODES,
			MAX_NODES,
		);
		expect(out.goal).toBe(FALLBACK_GRAPH.goal);
		expect(out.nodes.map((node) => node.id)).toEqual(FALLBACK_GRAPH.nodes.map((node) => node.id));
		expect(out.nodes).not.toBe(FALLBACK_GRAPH.nodes);
		expect(out.nodes[0]).not.toBe(FALLBACK_GRAPH.nodes[0]);
		expect(out.nodes[0]?.dependsOn).not.toBe(FALLBACK_GRAPH.nodes[0]?.dependsOn);
	});

	test("clamps to maxNodes and forces last kind synthesize", () => {
		const nodes = Array.from({ length: 10 }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : "generate",
			question: `q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		}));
		const out = normalizeGraph({ goal: "g", nodes }, "goal", 3, 6);
		expect(out.nodes).toHaveLength(6);
		expect(out.nodes.at(-1)?.kind).toBe("synthesize");
		expect(out.goal).toBe("g");
	});

	test("strips unknown and self deps", () => {
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					{
						id: "n1",
						title: "A",
						kind: "understand",
						question: "q1",
						depends_on: ["missing", "n1"],
					},
					{ id: "n2", title: "B", kind: "decompose", question: "q2", dependsOn: ["n1"] },
					{ id: "n3", title: "C", kind: "generate", question: "q3", depends_on: ["n2", "ghost"] },
				],
			},
			"fb",
			3,
			8,
		);
		expect(out.nodes[0]?.dependsOn).toEqual([]);
		expect(out.nodes[1]?.dependsOn).toEqual(["n1"]);
		expect(out.nodes[2]?.dependsOn).toEqual(["n2"]);
		expect(out.nodes[2]?.kind).toBe("synthesize");
	});

	test("prototype keys, ids with spaces or quotes and overlong ids take the positional id, and deps follow the rename", () => {
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					{ id: "constructor", title: "A", kind: "understand", question: "q1", depends_on: [] },
					{
						id: "__proto__",
						title: "B",
						kind: "decompose",
						question: "q2",
						depends_on: ["constructor"],
					},
					{
						id: 'bad id"',
						title: "C",
						kind: "generate",
						question: "q3",
						depends_on: ["__proto__", "constructor"],
					},
					{
						id: "x".repeat(65),
						title: "D",
						kind: "generate",
						question: "q4",
						depends_on: ['bad id"', "keep_this-1"],
					},
					{
						id: "keep_this-1",
						title: "E",
						kind: "critique",
						question: "q5",
						depends_on: ["toString"],
					},
				],
			},
			"fb",
			3,
			8,
		);
		expect(out.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3", "n4", "keep_this-1"]);
		expect(out.nodes[0]?.title).toBe("A");
		expect(out.nodes[1]?.dependsOn).toEqual(["n1"]);
		expect(out.nodes[2]?.dependsOn).toEqual(["n2", "n1"]);
		expect(out.nodes[3]?.dependsOn).toEqual(["n3"]);
		// keep_this-1 is written last and depends on nothing, so it synthesizes the only leaf, n4.
		expect(out.nodes[4]?.dependsOn).toEqual(["n4"]);
		for (const node of out.nodes) expect(Object.hasOwn(Object.prototype, node.id)).toBe(false);
	});

	test("a positional fallback skips valid ids written later in the list, so no node is dropped", () => {
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					{ id: "n2", title: "A", kind: "understand", question: "q1", depends_on: [] },
					{ id: "bad id", title: "B", kind: "decompose", question: "q2", depends_on: ["n2"] },
					{ id: "n3", title: "C", kind: "generate", question: "q3", depends_on: ["bad id"] },
				],
			},
			"fb",
			3,
			8,
		);
		expect(out.nodes.map((node) => node.id)).toEqual(["n2", "n4", "n3"]);
		expect(out.nodes[2]?.dependsOn).toEqual(["n4"]);
	});
});

describe("topoSort", () => {
	test("respects deps", () => {
		const nodes: ThoughtNode[] = [
			{ id: "n3", title: "C", kind: "synthesize", question: "c", dependsOn: ["n1", "n2"] },
			{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: [] },
			{ id: "n2", title: "B", kind: "decompose", question: "b", dependsOn: ["n1"] },
		];
		expect(topoSort(nodes).map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
	});
});

const DIAMOND: ThoughtNode[] = [
	{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: [] },
	{ id: "n2", title: "B", kind: "generate", question: "b", dependsOn: ["n1"] },
	{ id: "n3", title: "C", kind: "critique", question: "c", dependsOn: ["n1"] },
	{ id: "n4", title: "D", kind: "synthesize", question: "d", dependsOn: ["n2", "n3"] },
];

describe("dependencyLevels", () => {
	test("groups nodes so every dependency sits in an earlier level", () => {
		expect(dependencyLevels(DIAMOND).map((level) => level.map((node) => node.id))).toEqual([
			["n1"],
			["n2", "n3"],
			["n4"],
		]);
	});
});

describe("workflowWaves", () => {
	test("diamond graph yields a parallel middle wave", () => {
		expect(workflowWaves({ goal: "g", nodes: DIAMOND })).toEqual([
			{ wave: 1, parallel: false, ids: ["n1"] },
			{ wave: 2, parallel: true, ids: ["n2", "n3"] },
			{ wave: 3, parallel: false, ids: ["n4"] },
		]);
	});

	test("orders unsorted nodes before grouping", () => {
		const shuffled = [DIAMOND[3]!, DIAMOND[2]!, DIAMOND[0]!, DIAMOND[1]!];
		expect(workflowWaves({ goal: "g", nodes: shuffled }).map((wave) => wave.ids)).toEqual([
			["n1"],
			["n3", "n2"],
			["n4"],
		]);
	});
});

describe("graphToXml", () => {
	test("ends with a WORKFLOW block of waves before the root close", () => {
		const xml = graphToXml({ goal: "g", nodes: DIAMOND });
		const workflow = [
			"	<WORKFLOW>",
			'		<WAVE n="1" parallel="false">n1</WAVE>',
			'		<WAVE n="2" parallel="true">n2, n3</WAVE>',
			'		<WAVE n="3" parallel="false">n4</WAVE>',
			"	</WORKFLOW>",
			"</GRAPH_OF_THOUGHT>",
		].join("\n");
		expect(xml.endsWith(workflow)).toBe(true);
		expect(xml.indexOf("<WORKFLOW>")).toBeGreaterThan(xml.lastIndexOf("</NODE>"));
	});
});

const FIVE_STEPS = "1. read\n2. plan\n3. build\n4. test\n5. ship";
const FIVE_STEP_LIST = ["read", "plan", "build", "test", "ship"];
const REJECTED = { ok: false, thinking: "", conclusion: "", steps: [] };

describe("parseNodeFill", () => {
	test("accepts a closed rationale of 5 steps plus a closed conclusion", () => {
		expect(
			parseNodeFill(
				`<node><rationale>${FIVE_STEPS}</rationale><conclusion>do x</conclusion></node>`,
			),
		).toEqual({ ok: true, thinking: FIVE_STEPS, conclusion: "do x", steps: FIVE_STEP_LIST });
	});

	test("still reads the older <thinking> tag and the <answer> tag", () => {
		expect(
			parseNodeFill(`<node><thinking>${FIVE_STEPS}</thinking><answer>do x</answer></node>`),
		).toEqual({ ok: true, thinking: FIVE_STEPS, conclusion: "do x", steps: FIVE_STEP_LIST });
	});

	test("accepts 8 steps and rejects 4 and 9", () => {
		const list = (count: number): string =>
			Array.from({ length: count }, (_, i) => `${i + 1}. s${i + 1}`).join("\n");
		const fill = (count: number): string =>
			`<node><rationale>${list(count)}</rationale><conclusion>c</conclusion></node>`;
		expect(parseNodeFill(fill(8)).ok).toBe(true);
		expect(parseNodeFill(fill(8)).steps).toHaveLength(8);
		expect(parseNodeFill(fill(4))).toEqual(REJECTED);
		expect(parseNodeFill(fill(9))).toEqual(REJECTED);
	});

	test("a refusal, error JSON, truncated markup and free text are all rejected", () => {
		expect(parseNodeFill("I'm sorry, I can't help with that request.")).toEqual(REJECTED);
		expect(parseNodeFill('{"error":{"type":"overloaded_error","message":"Overloaded"}}')).toEqual(
			REJECTED,
		);
		expect(parseNodeFill("<node><rationale>1. a\n2. b\n3. c\n4. d\n5. e")).toEqual(REJECTED);
		expect(parseNodeFill(`<node><rationale>${FIVE_STEPS}</rationale><conclusion>cut off`)).toEqual(
			REJECTED,
		);
		expect(parseNodeFill(`<node><rationale>${FIVE_STEPS}</rationale></node>`)).toEqual(REJECTED);
		expect(parseNodeFill(`<node><conclusion>c</conclusion></node>`)).toEqual(REJECTED);
		expect(parseNodeFill(`${FIVE_STEPS}\nso do it`)).toEqual(REJECTED);
		expect(parseNodeFill("plain answer")).toEqual(REJECTED);
		expect(parseNodeFill("")).toEqual(REJECTED);
	});

	test("a realistic 4,500-character synthesize conclusion ending in Verify: passes the node cap untouched (F-1)", () => {
		let body = "Plan.\nWORKFLOW";
		for (let i = 0; body.length < 4400; i++)
			body += `\nWave ${(i % 3) + 1}: task-${i} — files: src/t${i}.ts — done when: tests pass`;
		const conclusion = `${body}\nVerify: bun test`;
		const fill = parseNodeFill(
			`<node><rationale>${FIVE_STEPS}</rationale><conclusion>${conclusion}</conclusion></node>`,
		);
		expect(fill.ok).toBe(true);
		expect(fill.conclusion).toBe(conclusion);
		expect(fill.conclusion.endsWith("Verify: bun test")).toBe(true);
		const open = `${"Finding.\n".repeat(600)}Open questions:\n- JSON lines or array?`;
		const critique = parseNodeFill(
			`<node><rationale>${FIVE_STEPS}</rationale><conclusion>${open}</conclusion></node>`,
		);
		expect(critique.conclusion).toBe(open);
	});

	test("caps thinking, conclusion and each step at parse", () => {
		const long = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${"x".repeat(2500)}`).join("\n");
		const fill = parseNodeFill(
			`<node><rationale>${long}</rationale><conclusion>${"y".repeat(FIELD_CAPS.conclusion + 1000)}</conclusion></node>`,
		);
		expect(fill.ok).toBe(true);
		expect(fill.thinking.length).toBeLessThanOrEqual(FIELD_CAPS.thinking);
		expect(fill.conclusion.length).toBe(FIELD_CAPS.conclusion);
		expect(fill.conclusion.length).toBeLessThanOrEqual(FIELD_CAPS.conclusion);
		expect(fill.steps).toHaveLength(5);
		for (const step of fill.steps) expect(step.length).toBeLessThanOrEqual(FIELD_CAPS.step);
	});

	test.each([5, 6, 8])(
		"%i steps of 2,500 characters keep every step in the stored rationale (greptile r1 #4)",
		(count) => {
			const long = Array.from(
				{ length: count },
				(_, i) => `${i + 1}. ${String.fromCharCode(97 + i).repeat(2500)}`,
			).join("\n");
			const fill = parseNodeFill(
				`<node><rationale>${long}</rationale><conclusion>c</conclusion></node>`,
			);
			expect(fill.ok).toBe(true);
			expect(fill.steps).toHaveLength(count);
			expect(fill.thinking.length).toBeLessThanOrEqual(FIELD_CAPS.thinking);
			// The stored rationale is what trackers and hosted plans re-split: it must hold exactly the accepted steps.
			const stored = splitRationaleSteps(fill.thinking);
			expect(stored).toHaveLength(count);
			expect(stored).toEqual(fill.steps);
			for (const [i, step] of fill.steps.entries())
				expect(step.startsWith(String.fromCharCode(97 + i))).toBe(true);
		},
	);

	test("a rationale under the cap is stored exactly as written even when one step is over the step cap", () => {
		const text = `1. ${"a".repeat(700)}\n2. b\n3. c\n4. d\n5. e`;
		const fill = parseNodeFill(
			`<node><rationale>${text}</rationale><conclusion>c</conclusion></node>`,
		);
		expect(fill.ok).toBe(true);
		expect(fill.thinking).toBe(text);
		expect(fill.steps[0]!.length).toBe(FIELD_CAPS.step);
	});
});

describe("graph integrity", () => {
	const spec = (id: string, deps: string[], extra: Record<string, unknown> = {}) => ({
		id,
		title: id.toUpperCase(),
		kind: "generate",
		question: `q ${id}`,
		depends_on: deps,
		...extra,
	});
	const levelOf = (nodes: ThoughtNode[]): Map<string, number> => {
		const levels = new Map<string, number>();
		for (const [index, group] of dependencyLevels(topoSort(nodes)).entries()) {
			for (const node of group) levels.set(node.id, index);
		}
		return levels;
	};
	const expectLeveled = (nodes: ThoughtNode[]): void => {
		const levels = levelOf(nodes);
		expect(levels.size).toBe(nodes.length);
		for (const node of nodes) {
			for (const dep of node.dependsOn) {
				expect(levels.get(dep)!).toBeLessThan(levels.get(node.id)!);
			}
		}
	};

	test("a cycle n1-n2-n3-n1 is broken and every node levels after its dependencies (GOT-03)", () => {
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					spec("n1", ["n3"]),
					spec("n2", ["n1"]),
					spec("n3", ["n2"]),
					spec("n4", ["n3"]),
					spec("n5", ["n4"]),
				],
			},
			"fb",
			5,
			8,
		);
		expect(out.nodes[0]?.dependsOn).toEqual([]);
		expectLeveled(out.nodes);
	});

	test("dependencyLevels never places a node before its dependency, even for unordered hostile input", () => {
		const hostile: ThoughtNode[] = [
			{ id: "n3", title: "C", kind: "synthesize", question: "c", dependsOn: ["n1", "n2"] },
			{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: ["n3"] },
			{ id: "n2", title: "B", kind: "generate", question: "b", dependsOn: ["n1"] },
			{ id: "n4", title: "D", kind: "generate", question: "d", dependsOn: ["n4", "ghost"] },
		];
		const forward: ThoughtNode[] = [
			{ id: "n3", title: "C", kind: "synthesize", question: "c", dependsOn: ["n1", "n2"] },
			{ id: "n2", title: "B", kind: "generate", question: "b", dependsOn: ["n1"] },
			{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: [] },
		];
		expect(dependencyLevels(forward).map((group) => group.map((node) => node.id))).toEqual([
			["n1"],
			["n2"],
			["n3"],
		]);
		const flat = dependencyLevels(hostile).flat();
		expect(flat).toHaveLength(hostile.length);
		expect(new Set(flat.map((node) => node.id)).size).toBe(hostile.length);
	});

	test("a forward reference is dropped so the model order stays topological (GOT-03)", () => {
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					spec("n1", ["n2"]),
					spec("n2", []),
					spec("n3", ["n1"]),
					spec("n4", ["n3"]),
					spec("n5", ["n4"]),
				],
			},
			"fb",
			5,
			8,
		);
		expect(out.nodes[0]?.dependsOn).toEqual([]);
		expect(out.nodes[2]?.dependsOn).toEqual(["n1"]);
		expectLeveled(out.nodes);
	});

	test("300 duplicate dependencies collapse to the distinct ones in first-seen order (GOT-04)", () => {
		const deps = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? "n1" : "n2"));
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					spec("n1", []),
					spec("n2", ["n1"]),
					spec("n3", deps),
					spec("n4", ["n3"]),
					spec("n5", ["n4"]),
				],
			},
			"fb",
			5,
			8,
		);
		expect(out.nodes[2]?.dependsOn).toEqual(["n1", "n2"]);
	});

	test("the last node synthesizes and depends on every leaf (GOT-09)", () => {
		const flat = normalizeGraph(
			{ goal: "g", nodes: ["n1", "n2", "n3", "n4", "n5"].map((id) => spec(id, [])) },
			"fb",
			5,
			8,
		);
		expect(flat.nodes[4]?.kind).toBe("synthesize");
		expect(flat.nodes[4]?.dependsOn).toEqual(["n1", "n2", "n3", "n4"]);

		const branched = normalizeGraph(
			{
				goal: "g",
				nodes: [
					spec("n1", []),
					spec("n2", ["n1"]),
					spec("n3", ["n1"]),
					spec("n4", ["n2"]),
					spec("n5", ["n4"]),
				],
			},
			"fb",
			5,
			8,
		);
		// n3 has no dependent, so it is a leaf the synthesis must read; n4 is already covered through n5's own dep.
		expect(branched.nodes[4]?.dependsOn).toEqual(["n4", "n3"]);
	});

	test("oversize title, question and goal are clipped at parse (GOT-04)", () => {
		const out = normalizeGraph(
			{
				goal: "g".repeat(5000),
				nodes: ["n1", "n2", "n3", "n4", "n5"].map((id, i) =>
					spec(id, i === 0 ? [] : [`n${i}`], {
						title: "t".repeat(900),
						question: "q".repeat(5000),
					}),
				),
			},
			"fb",
			5,
			8,
		);
		expect(out.goal.length).toBeLessThanOrEqual(FIELD_CAPS.goal);
		for (const node of out.nodes) {
			expect(node.title.length).toBeLessThanOrEqual(FIELD_CAPS.title);
			expect(node.question.length).toBeLessThanOrEqual(FIELD_CAPS.question);
		}
	});

	test("a degraded node carries degraded=true in the spec XML and a healthy one does not", () => {
		const xml = graphToXml({
			goal: "g",
			nodes: [
				{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: [], degraded: true },
				{ id: "n2", title: "B", kind: "synthesize", question: "b", dependsOn: ["n1"] },
			],
		});
		expect(xml.match(/degraded="true"/g)).toHaveLength(1);
		expect(xml).toMatch(/<NODE id="n1"[^>]*degraded="true"/);
		expect(xml).not.toMatch(/<NODE id="n2"[^>]*degraded/);
	});

	test("graphSketch keeps one line per node whatever the title holds (GOT-10)", () => {
		const sketch = graphSketch({
			goal: "g",
			nodes: [
				{
					id: "n1",
					title: "A\n<injected>\r\n  B",
					kind: "understand",
					question: "a",
					dependsOn: [],
				},
				{ id: "n2", title: "C", kind: "synthesize", question: "c", dependsOn: ["n1"] },
			],
		});
		expect(sketch.split("\n")).toHaveLength(2);
		expect(sketch.split("\n")[0]).toBe("n1  A <injected> B  understand");
	});
});

describe("injectGraphXml dollar sequences", () => {
	const goal = "cost is $& and $$ and $` and $' and $1";
	const graph = { goal, nodes: DIAMOND };

	test("a replaced GRAPH_OF_THOUGHT block keeps every $ sequence byte-identical (GOT-02)", () => {
		const xml =
			"<BUILD_PROMPT><ORIGINAL>x</ORIGINAL><GRAPH_OF_THOUGHT><GOAL>old</GOAL></GRAPH_OF_THOUGHT></BUILD_PROMPT>";
		const out = injectGraphXml(xml, graph);
		expect(out).toBe(`<BUILD_PROMPT><ORIGINAL>x</ORIGINAL>${graphToXml(graph)}</BUILD_PROMPT>`);
	});

	test("a graph wrapped before the root close tag keeps every $ sequence byte-identical (GOT-02)", () => {
		const out = injectGraphXml("<BUILD_PROMPT><ORIGINAL>x</ORIGINAL></BUILD_PROMPT>", graph);
		expect(out).toBe(`<BUILD_PROMPT><ORIGINAL>x</ORIGINAL>\n${graphToXml(graph)}\n</BUILD_PROMPT>`);
	});
});

describe("injectGraphXml", () => {
	test("keeps BUILD_PROMPT root and ORIGINAL", () => {
		const xml = "<BUILD_PROMPT><ORIGINAL>add list</ORIGINAL><SCOPE>ui</SCOPE></BUILD_PROMPT>";
		const out = injectGraphXml(xml, FALLBACK_GRAPH);
		expect(out.startsWith("<BUILD_PROMPT>")).toBe(true);
		expect(out).toContain("<ORIGINAL>add list</ORIGINAL>");
		expect(out).toContain("<SCOPE>ui</SCOPE>");
		expect(out).toContain("<GRAPH_OF_THOUGHT>");
		expect(out).toContain("</GRAPH_OF_THOUGHT>");
		expect(out.endsWith("</BUILD_PROMPT>")).toBe(true);
		expect(out.indexOf("<GRAPH_OF_THOUGHT>")).toBeGreaterThan(out.indexOf("<SCOPE>"));
	});

	test("replaces existing GRAPH_OF_THOUGHT including its WORKFLOW", () => {
		const xml =
			"<BUILD_PROMPT><ORIGINAL>x</ORIGINAL><GRAPH_OF_THOUGHT><GOAL>old</GOAL>" +
			'<WORKFLOW><WAVE n="1" parallel="false">stale</WAVE></WORKFLOW></GRAPH_OF_THOUGHT></BUILD_PROMPT>';
		const out = injectGraphXml(xml, { goal: "new goal", nodes: DIAMOND });
		expect(out).toContain("<GOAL>new goal</GOAL>");
		expect(out.includes("old")).toBe(false);
		expect(out.includes("stale")).toBe(false);
		expect(out.match(/<GRAPH_OF_THOUGHT/g)?.length).toBe(1);
		expect(out.match(/<WORKFLOW>/g)?.length).toBe(1);
		expect(out).toContain('<WAVE n="2" parallel="true">n2, n3</WAVE>');
		expect(out.endsWith("</BUILD_PROMPT>")).toBe(true);
	});
});

describe("graphSketch", () => {
	test("emits compact id title kind deps lines", () => {
		const sketch = graphSketch(FALLBACK_GRAPH);
		expect(sketch).toContain("n1  Understand  understand");
		expect(sketch).toContain("n2  Decompose  decompose  deps=n1");
	});
});
