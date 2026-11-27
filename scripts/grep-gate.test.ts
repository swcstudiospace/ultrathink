// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { checkForForbiddenWrites } from "./grep-gate.ts";

const GUARDED = "// src/workflow/guarded-write.ts content (fake)\n// writeGuarded writes STATE.md through the CAS lock\n";

describe("checkForForbiddenWrites", () => {
	test("a violating fixture is rejected and named", () => {
		const result = checkForForbiddenWrites([
			{
				path: "src/planner/write.ts",
				content: `function save() {\n\twriteFileSync(".planning/STATE.md", "x");\n}\n`,
			},
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("src/planner/write.ts");
	});

	test("a clean fixture passes", () => {
		const result = checkForForbiddenWrites([
			{
				path: "src/track/gateway.ts",
				content: `// Planning artifacts remain local/gitignored.\n// The writer is src/workflow/guarded-write.ts.\n`,
			},
		]);
		expect(result).toEqual({ ok: true });
	});

	test("the guarded module itself is allowed", () => {
		const result = checkForForbiddenWrites([{ path: "src/workflow/guarded-write.ts", content: GUARDED }]);
		expect(result).toEqual({ ok: true });
	});

	test("reads of planning files are not writes and pass", () => {
		const result = checkForForbiddenWrites([
			{
				path: "src/host/plan.ts",
				content: `const state = await readFile(".planning/STATE.md", "utf8");\n`,
			},
		]);
		expect(result).toEqual({ ok: true });
	});
});
