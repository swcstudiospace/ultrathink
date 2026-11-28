// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { BLOAT_LIMIT, BLOAT_LINE_LIMIT, checkPlanSet, type PlanCheckResult } from "./plan-check.ts";

/**
 * Fixture strings only — never read from .planning/.
 * (a) 107/108-style: lean 8-block XML contract, 82-113 lines.
 * (b) 109-113-style: retro stub with 0 XML blocks.
 * (c) Deliberately truncated contract.
 * (d) 101-106-style: full contract carrying ledger tables (accept).
 * Plus a non-ledger bloat case (reject).
 */

const CONTRACT = `---
phase: "107"
plan: "01"
checkpoint_sha: a62c2a51f0e1d2c3b4a5968778695a4b3c2d1e0f
type: execute
wave: 1
files_modified:
  - scripts/plan-check.ts
---

<objective>
Implement the plan-check linter as a pure predicate.
</objective>

<execution_context>
@/root/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@src/plan-check-fixture.ts
@README.md#plans
See src/plan-check-fixture.ts for the existing shape.
</context>

<tasks>

<task type="auto">
  <name>Implement the predicate</name>
  <files>scripts/plan-check.ts</files>
  <action>Code checkPlanSet(md) against the C-1..C-6 contract.</action>
  <verify>\`bun test scripts/plan-check.test.ts\`</verify>
  <done>Predicate returns Pass for the contract fixture.</done>
</task>

<task type="auto">
  <name>Add unit tests</name>
  <files>scripts/plan-check.test.ts</files>
  <action>Cover accept, stub, truncated, and ledger cases.</action>
  <verify>\`bun test scripts/plan-check.test.ts\`</verify>
  <done>All fixture cases pass.</done>
</task>

</tasks>

<budget>
max_tokens: 60000
output_tokens: 20000
wall_clock_minutes: 30
</budget>

<output>
scripts/plan-check.ts and scripts/plan-check.test.ts
</output>

<verification>
\`bun test scripts/plan-check.test.ts\` exits 0 with 4+ cases passing.
</verification>

<acceptance>
- \`bun test scripts/plan-check.test.ts\` exits 0
- contract fixture returns ok: true
- stub fixture returns ok: false
</acceptance>
`;

const STUB = `---
phase: "109"
plan: "01"
checkpoint: a62c2a51f0e1d2c3b4a5968778695a4b3c2d1e0f
---

# Phase 109 retro

We shipped the plan. It went fine. Notes:

- The linter idea came up in discussion.
- Follow up later if time permits.
- No tasks were written down for this retro.
`;

const TRUNCATED = CONTRACT.slice(0, CONTRACT.indexOf("</tasks>"));

const ledgerRows = Array.from({ length: 460 }, (_, i) => `| entry-${i} | item | done |`).join("\n");
const WITH_LEDGER = `${CONTRACT}
## Ledger

| id | item | status |
| --- | --- | --- |
${ledgerRows}
`;

const BLOAT = `${CONTRACT}

${Array.from({ length: 500 }, (_, i) => `Filler paragraph ${i}: prose that is not a ledger table and inflates the plan.`).join("\n\n")}
`;

describe("checkPlanSet", () => {
	test("accepts a 107/108-style 8-block contract", () => {
		expect(checkPlanSet(CONTRACT)).toEqual({ ok: true });
	});

	test("rejects a 109-113-style zero-block stub", () => {
		const result = checkPlanSet(STUB);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("0 blocks");
	});

	test("rejects a deliberately truncated fixture", () => {
		const result = checkPlanSet(TRUNCATED);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reason).toMatch(/truncated|missing|no tasks|budget|acceptance|context/i);
	});

	test("accepts a 101-106-style full contract including ledger tables", () => {
		expect(WITH_LEDGER.split("\n").length).toBeGreaterThan(290);
		expect(checkPlanSet(WITH_LEDGER)).toEqual({ ok: true });
	});

	test("rejects non-ledger bloat over the line limit", () => {
		const result = checkPlanSet(BLOAT);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("bloat");
	});

	test("rejects a plan with no frontmatter", () => {
		const result = checkPlanSet(
			"# no frontmatter\n\n<acceptance>\n`bun test && echo ok`\n</acceptance>\n",
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("frontmatter");
	});
});

describe("checkPlanSet hardening", () => {
	test("BLOAT_LIMIT keeps the 520-line contract", () => {
		expect(BLOAT_LIMIT).toBe(520);
		expect(BLOAT_LINE_LIMIT).toBe(BLOAT_LIMIT);
	});

	test("non-string input rejects as missing frontmatter instead of throwing", () => {
		expect(checkPlanSet(undefined as unknown as string)).toEqual({
			ok: false,
			reason: "missing frontmatter: phase/plan ids",
		});
		expect(checkPlanSet(null as unknown as string)).toEqual({
			ok: false,
			reason: "missing frontmatter: phase/plan ids",
		});
	});

	test("onDecision observes the verdict exactly once without changing it", () => {
		const seen: PlanCheckResult[] = [];
		const result = checkPlanSet(CONTRACT, { onDecision: (r) => seen.push(r) });
		expect(result).toEqual({ ok: true });
		expect(seen).toEqual([{ ok: true }]);
	});
});
