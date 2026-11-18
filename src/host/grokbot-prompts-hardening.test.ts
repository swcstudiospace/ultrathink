// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import { buildCloudPrompt, type UnitDispatch, validateCloudPrompt } from "./grokbot-prompts.ts";

const ORIGINAL = "Build a CSV to JSON converter.";
const STEPS = [
	"1. Read the parser.",
	"2. Write the parser.",
	"3. Wire the CLI.",
	"4. Add the tests.",
	"5. Document the flags.",
].join("\n");

function record(): SessionRecord {
	return {
		sessionId: "s1",
		at: 0,
		plan: { graphId: "g-harden" },
		graph: {
			goal: ORIGINAL,
			nodes: [
				{
					id: "n3",
					title: "Parser",
					kind: "generate",
					question: "How is the CSV parsed?",
					dependsOn: [],
					thinking: STEPS,
					conclusion: "Stream the parser.",
				},
			],
		},
		result: { xml: "<GRAPH_OF_THOUGHT/>", original: ORIGINAL },
	} as unknown as SessionRecord;
}

const base = { unit: "n3", mode: "new" as const, repo: "o/r", branch: "b" };

describe("desk rules are never silently dropped", () => {
	test("eleven desk rules are rejected, not truncated to ten", () => {
		const rules = Array.from({ length: 11 }, (_, i) => `rule ${i + 1}`);
		expect(() => buildCloudPrompt(record(), { ...base, rules })).toThrow(
			"DESK_RULES must have 1-10 rules (got 11)",
		);
	});

	test("ten desk rules are all kept in the prompt", () => {
		const rules = Array.from({ length: 10 }, (_, i) => `rule ${i + 1}`);
		const xml = buildCloudPrompt(record(), { ...base, rules });
		expect(xml.match(/<RULE>/g)?.length).toBe(10);
		for (const rule of rules) expect(xml).toContain(`<RULE>${rule}</RULE>`);
	});
});

describe("secret-like text is rejected through the shared redaction shapes", () => {
	test.each([
		["a Notion integration key", `ntn_${"Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z"}`],
		["a Bearer token", "Bearer 0123456789abcdefXYZ"],
		[
			"a JWT",
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		],
	])("%s in a note is rejected as secret-like", (_label, secret) => {
		const dispatch: UnitDispatch = { ...base, notes: [`leaked ${secret} in the log`] };
		const xml = buildCloudPrompt(record(), dispatch);
		expect(xml).toContain(secret);
		const check = validateCloudPrompt(xml, dispatch, ORIGINAL);
		expect(check.ok).toBe(false);
		expect(check.errors.join()).toMatch(/secret-like/);
	});

	test("a prompt without secret shapes raises no secret-like error", () => {
		const xml = buildCloudPrompt(record(), base);
		expect(validateCloudPrompt(xml, base, ORIGINAL).errors.join()).not.toMatch(/secret-like/);
	});
});
