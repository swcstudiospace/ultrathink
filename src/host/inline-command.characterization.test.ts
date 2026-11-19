// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Characterization of the inline command replies. These snapshots pin the text a control command prints inline today:
 * `hitl last` (formatHitlEcho, the clarification echo) and `think last` (graphSketch, the thought-graph sketch). A later
 * change to their wording, clipping or layout shows up as a snapshot diff.
 */
import { describe, expect, test } from "bun:test";
import { formatHitlEcho } from "../hitl/format.ts";
import type { Clarification } from "../hitl/types.ts";
import { graphSketch } from "../think/graph.ts";
import type { ThoughtGraph } from "../think/types.ts";

const answered: Clarification = {
	id: "q1",
	question: "Which store should hold the sessions table?",
	header: "Storage",
	why: "The sessions table needs a durable store.",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
	default: "Postgres",
	blocking: true,
	answer: "SQLite",
	source: "user",
};

const assumed: Clarification = {
	id: "q2",
	question: "Keep the old   login\nendpoint during the migration?",
	header: "Compatibility",
	why: "Clients still call the old endpoint.",
	options: [{ label: "Yes, keep it" }, { label: "No, remove it" }],
	blocking: false,
	answer: "Yes, keep it",
	source: "assumed",
};

const knowledgeSettled: Clarification = {
	id: "q3",
	question: "Which login provider should the flow use?",
	header: "Provider",
	why: "The flow needs one provider.",
	options: [{ label: "Greptile" }, { label: "Local" }],
	blocking: false,
	answer: "Local",
	source: "knowledge",
	evidence: "auth/login.md",
};

const unanswered: Clarification = {
	id: "q4",
	question: "Which region should the deployment target?",
	header: "Region",
	why: "The deployment needs a region.",
	options: [{ label: "eu" }, { label: "us" }],
	default: "eu",
	blocking: true,
};

const graph: ThoughtGraph = {
	goal: "Ship the login flow behind a flag",
	nodes: [
		{
			id: "n1",
			title: "Understand   the current\nlogin path",
			kind: "understand",
			question: "How does login work today?",
			dependsOn: [],
		},
		{
			id: "n2",
			title: "Decompose the rollout",
			kind: "decompose",
			question: "What are the rollout steps?",
			dependsOn: ["n1"],
		},
		{
			id: "n3",
			title: "Synthesize the plan",
			kind: "synthesize",
			question: "How do the steps fit together?",
			dependsOn: ["n1", "n2"],
		},
	],
};

describe("inline command: hitl last (formatHitlEcho)", () => {
	test("no clarifications recorded", () => {
		expect(formatHitlEcho([])).toMatchSnapshot();
	});

	test("answered clarification shows its options, default and answer", () => {
		expect(formatHitlEcho([answered])).toMatchSnapshot();
	});

	test("assumed and knowledge-settled answers carry their source suffix", () => {
		expect(formatHitlEcho([assumed, knowledgeSettled])).toMatchSnapshot();
	});

	test("an unanswered blocking clarification shows its options and default only", () => {
		expect(formatHitlEcho([unanswered])).toMatchSnapshot();
	});

	test("all clarifications print in list order, one block each", () => {
		expect(formatHitlEcho([answered, assumed, knowledgeSettled, unanswered])).toMatchSnapshot();
	});
});

describe("inline command: think last (graphSketch)", () => {
	test("empty graph prints nothing", () => {
		expect(graphSketch({ goal: "Nothing to plan", nodes: [] })).toMatchSnapshot();
	});

	test("nodes print their id, collapsed title, kind and dependencies", () => {
		expect(graphSketch(graph)).toMatchSnapshot();
	});
});
