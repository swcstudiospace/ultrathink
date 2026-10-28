// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { ENV_REGISTRY, type EnvVarDef } from "../src/env-registry.ts";
import { readCommittedEnvDocs, renderEnvDocs } from "./render-env-docs.ts";

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";

function entry(over: Partial<EnvVarDef> & Pick<EnvVarDef, "name">): EnvVarDef {
	return {
		secret: false,
		kind: "string",
		scope: "plugin",
		description: "A test variable.",
		family: "test",
		...over,
	};
}

/** The table rows of one `## <title>` section, without the header and divider. */
function tableRows(text: string, title: string): string[] {
	const start = text.indexOf(`## ${title}\n`);
	if (start < 0) return [];
	const rest = text.slice(start + 1);
	const next = rest.indexOf("\n## ");
	const section = next < 0 ? rest : rest.slice(0, next);
	return section.split("\n").filter((line) => line.startsWith("| `"));
}

describe("renderEnvDocs", () => {
	test("docs/environment.md is exactly what the registry renders", () => {
		// A stale or missing file fails here; regenerate with `bun scripts/render-env-docs.ts`.
		expect(readCommittedEnvDocs()).toBe(renderEnvDocs());
	});

	test("every registry entry has exactly one row, under the table of its own scope", () => {
		const text = renderEnvDocs();
		const titles = {
			plugin: "Plugin variables",
			service: "Hosted service variables",
			stack: "Stack variables",
		} as const;
		for (const [scope, title] of Object.entries(titles)) {
			const rows = tableRows(text, title);
			const expected = ENV_REGISTRY.filter((candidate) => candidate.scope === scope);
			expect(rows).toHaveLength(expected.length);
			for (const [index, candidate] of expected.entries())
				expect(rows[index]).toStartWith(`| \`${candidate.name}\` |`);
		}
		const total = Object.values(titles).reduce(
			(sum, title) => sum + tableRows(text, title).length,
			0,
		);
		expect(total).toBe(ENV_REGISTRY.length);
	});

	test("the scopes render in the fixed order plugin, service, stack", () => {
		const text = renderEnvDocs();
		const order = ["## Plugin variables", "## Hosted service variables", "## Stack variables"].map(
			(heading) => text.indexOf(heading),
		);
		expect(order.every((position) => position >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("a row shows aliases, the secret flag, the default and the accepted range of its entry", () => {
		const text = renderEnvDocs([
			entry({
				name: "T_URL",
				kind: "url",
				aliases: ["T_URL_ALT", "T_URL_OLD"],
				default: "https://example.test",
				description: "Where it goes.",
			}),
			entry({ name: "T_KEY", secret: true }),
			entry({ name: "T_COUNT", kind: "int", min: 1, max: 6 }),
			entry({ name: "T_FLOOR", kind: "int", min: 0 }),
			entry({ name: "T_MODE", kind: "enum", values: ["a", "b"] }),
			entry({ name: "T_OFF", kind: "bool01", disableValue: "0" }),
		]);
		const rows = tableRows(text, "Plugin variables");
		expect(rows).toEqual([
			"| `T_URL` | `T_URL_ALT`, `T_URL_OLD` | no | url | `https://example.test` | Where it goes. |",
			"| `T_KEY` | — | yes | string | — | A test variable. |",
			"| `T_COUNT` | — | no | int (1 to 6) | — | A test variable. |",
			"| `T_FLOOR` | — | no | int (at least 0) | — | A test variable. |",
			"| `T_MODE` | — | no | enum (one of a, b) | — | A test variable. |",
			"| `T_OFF` | — | no | bool01 (disabled by 0) | — | A test variable. |",
		]);
	});

	test("a pipe or a newline in a description cannot break the table", () => {
		const text = renderEnvDocs([entry({ name: "T_ONE", description: "Either a|b\nor c." })]);
		const [row] = tableRows(text, "Plugin variables");
		expect(row).toBe("| `T_ONE` | — | no | string | — | Either a\\|b or c. |");
	});

	test("an empty scope renders an empty table, and the output ends in exactly one newline", () => {
		const text = renderEnvDocs([entry({ name: "T_ONLY", scope: "stack" })]);
		expect(tableRows(text, "Plugin variables")).toEqual([]);
		expect(tableRows(text, "Hosted service variables")).toEqual([]);
		expect(tableRows(text, "Stack variables")).toHaveLength(1);
		expect(text.endsWith("|\n")).toBe(true);
		expect(text.endsWith("\n\n")).toBe(false);
	});

	test("the output is deterministic and is built from the registry alone, never from the environment", () => {
		const saved = process.env.ULTRATHINK_PORT;
		process.env.ULTRATHINK_PORT = CANARY;
		try {
			expect(renderEnvDocs()).toBe(renderEnvDocs());
			expect(renderEnvDocs()).not.toContain("CANARY");
		} finally {
			if (saved === undefined) delete process.env.ULTRATHINK_PORT;
			else process.env.ULTRATHINK_PORT = saved;
		}
	});
});
