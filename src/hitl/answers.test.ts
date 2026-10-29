// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { applyAnswers } from "./answers.ts";
import { clarificationsToXml } from "./format.ts";
import type { Clarification } from "./types.ts";

function item(id: string, question: string, extra: Partial<Clarification> = {}): Clarification {
	return {
		id,
		question,
		header: "H",
		why: "w",
		options: [{ label: "A" }, { label: "B" }],
		default: "A",
		blocking: false,
		...extra,
	};
}

const base: Clarification[] = [
	item("q1", "Which database should we use?"),
	item("q2", "Add tests?"),
];

describe("applyAnswers", () => {
	test("matches exact and fuzzy question keys, returns matched, and does not mutate the input", () => {
		const snapshot = JSON.stringify(base);
		const { list, matched } = applyAnswers(
			base,
			{ questions: [{ question: "Which database should we use?", header: "DB", options: [] }] },
			{ answers: { "which database should we use": "Postgres", "add tests": "Yes" } },
			123,
		);
		expect(JSON.stringify(base)).toBe(snapshot);
		expect(list).toHaveLength(2);
		expect(list[0]).toMatchObject({
			id: "q1",
			answer: "Postgres",
			answeredAt: 123,
			source: "user",
		});
		expect(list[1]).toMatchObject({ id: "q2", answer: "Yes", answeredAt: 123, source: "user" });
		expect(matched.map((entry) => entry.id)).toEqual(["q1", "q2"]);
	});

	test("never matches by substring: a longer different question appends instead (L4-08)", () => {
		const open = [item("q1", "Use TypeScript?")];
		const { list, matched } = applyAnswers(
			open,
			undefined,
			{ answers: { "Use TypeScript strict mode?": "Yes" } },
			1,
		);
		expect(list).toHaveLength(2);
		expect(list[0]?.answer).toBeUndefined();
		expect(list[1]).toMatchObject({ question: "Use TypeScript strict mode?", answer: "Yes" });
		expect(matched).toHaveLength(1);
	});

	test("matches an exact id key first", () => {
		const { list } = applyAnswers(base, undefined, { answers: { q2: "Yes" } }, 1);
		expect(list).toHaveLength(2);
		expect(list[1]).toMatchObject({ id: "q2", answer: "Yes" });
	});

	test("never overwrites an answered item and does not re-add it", () => {
		const answeredList = [
			item("q1", "Add tests?", { answer: "No", source: "user", answeredAt: 5 }),
		];
		const { list, matched } = applyAnswers(
			answeredList,
			undefined,
			{ answers: { "add tests": "Yes", q1: "Maybe" } },
			9,
		);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ answer: "No", answeredAt: 5 });
		expect(matched).toEqual([]);
	});

	test("repeated free-form responses reuse one item, newest wins", () => {
		let current: Clarification[] = [];
		for (const text of ["one", "two", "three"]) {
			current = applyAnswers(current, undefined, `${text}`, 1).list;
			current = applyAnswers(current, undefined, { response: text }, 2).list;
		}
		const free = current.filter((entry) => entry.question === "Free-form response");
		expect(free).toHaveLength(1);
		expect(free[0]?.answer).toBe("three");
		expect(current).toHaveLength(1);
	});

	test("new ids are max numeric id plus one over q and k prefixes, never colliding", () => {
		const sparse = [item("q1", "A?"), item("q5", "B?"), item("k7", "C?")];
		const { list } = applyAnswers(sparse, undefined, { answers: { "Brand new?": "x" } }, 1);
		expect(list.at(-1)?.id).toBe("q8");
		expect(new Set(list.map((entry) => entry.id)).size).toBe(list.length);
	});

	test("appends unknown asked questions with input header and options", () => {
		const { list, matched } = applyAnswers(
			base,
			{
				questions: [
					{
						question: "Which color scheme?",
						header: "Theme",
						options: [{ label: "Dark", description: "default" }, { label: "Light" }],
					},
				],
			},
			{ answers: { "Which color scheme?": "Dark" } },
			5,
		);
		expect(list).toHaveLength(3);
		expect(list[2]).toEqual({
			id: "q3",
			question: "Which color scheme?",
			header: "Theme",
			why: "Asked by the agent during execution",
			options: [{ label: "Dark", description: "default" }, { label: "Light" }],
			blocking: false,
			answer: "Dark",
			answeredAt: 5,
			source: "user",
		});
		expect(matched).toEqual([list[2]!]);
	});

	test("appends answer keys that were not in the input either, with the Asked header", () => {
		const { list } = applyAnswers([], undefined, { answers: { "Deploy where?": "Vercel" } }, 1);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			id: "q1",
			question: "Deploy where?",
			header: "Asked",
			options: [],
			answer: "Vercel",
		});
	});

	test("attaches freeform response to the first matched item lacking an answer, else appends", () => {
		const asked = {
			questions: [{ question: "Which database should we use?" }, { question: "Add tests?" }],
		};
		const first = applyAnswers(
			base,
			asked,
			{ answers: { "Add tests?": "No" }, response: "use whatever is cheapest" },
			9,
		);
		expect(first.list[0]?.answer).toBe("use whatever is cheapest");
		expect(first.list[1]?.answer).toBe("No");
		expect(first.matched.map((entry) => entry.id).sort()).toEqual(["q1", "q2"]);

		const second = applyAnswers(base, undefined, { response: "just a note" }, 9);
		expect(second.list).toHaveLength(3);
		expect(second.list[2]).toMatchObject({
			question: "Free-form response",
			answer: "just a note",
			header: "Asked",
		});
		expect(second.matched).toHaveLength(1);
	});

	test("string response attaches to the single unanswered asked question, else appends a free-form item", () => {
		const one = applyAnswers(base, { questions: [{ question: "Add tests?" }] }, "yes please", 2);
		expect(one.list[1]?.answer).toBe("yes please");
		expect(one.matched.map((entry) => entry.id)).toEqual(["q2"]);

		const many = applyAnswers(
			base,
			{ questions: [{ question: "Add tests?" }, { question: "Which database should we use?" }] },
			"hmm",
			2,
		);
		expect(many.list).toHaveLength(3);
		expect(many.list[2]?.question).toBe("Free-form response");
	});

	test("ignores empty responses and blank answers", () => {
		expect(applyAnswers(base, undefined, undefined, 1).matched).toEqual([]);
		expect(applyAnswers(base, undefined, { answers: { "Add tests?": "   " } }, 1).matched).toEqual(
			[],
		);
		expect(applyAnswers(base, undefined, "  ", 1).list).toHaveLength(2);
	});

	test("a user answer to a knowledge-settled item makes it the user's and drops the evidence", () => {
		const settled = item("k1", "Where are records stored?", {
			answer: "In SQLite.",
			source: "knowledge",
			evidence: "docs/storage.md",
		});
		const { list } = applyAnswers(
			[settled],
			undefined,
			{ answers: { "Where are records stored?": "In Postgres" } },
			7,
		);
		expect(list[0]).toMatchObject({
			id: "k1",
			answer: "In Postgres",
			source: "user",
			answeredAt: 7,
		});
		expect(list[0]?.evidence).toBeUndefined();
		const xml = clarificationsToXml(list);
		expect(xml).toContain('<ANSWER source="user">In Postgres</ANSWER>');
		expect(xml).not.toContain("evidence=");
	});
});
