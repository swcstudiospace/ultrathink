// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { convertArtifact, isManaged } from "./convert.ts";
import type { ArtifactForm } from "./plan.ts";
import { isRecord } from "../shared.ts";

const SOURCE = "skills/ultrathink-plan/SKILL.md";
const ROOT = "/src/ultrathink";

function tomlTable(text: string): Record<string, unknown> {
	const parsed: unknown = Bun.TOML.parse(text);
	if (!isRecord(parsed)) throw new Error("the TOML document is not a table");
	return parsed;
}

function convert(text: string, form: ArtifactForm, cloneRoot = ROOT): string {
	return convertArtifact({ text, source: SOURCE, cloneRoot }, form);
}

const SKILL =
	"---\nname: ultrathink-plan\ndescription: Plan things.\n---\n\n# Plan\n\nRun `$ARGUMENTS`.\n";
const MARKER = `<!-- ultrathink-managed source="${SOURCE}" root="${ROOT}" -->`;

describe("skill and markdown forms", () => {
	test("keep the frontmatter and body byte for byte and add the marker between them", () => {
		const expected = `---\nname: ultrathink-plan\ndescription: Plan things.\n---\n${MARKER}\n\n# Plan\n\nRun \`$ARGUMENTS\`.\n`;
		expect(convert(SKILL, "skill")).toBe(expected);
		expect(convert(SKILL, "markdown")).toBe(expected);
	});

	test("a file without frontmatter starts with the marker", () => {
		expect(convert("# Plan\n", "markdown")).toBe(`${MARKER}\n# Plan\n`);
	});

	test("frontmatter with CRLF line endings is still recognised", () => {
		const text = "---\r\nname: x\r\n---\r\nbody\r\n";
		expect(convert(text, "skill")).toBe(`---\r\nname: x\r\n---\r\n${MARKER}\nbody\r\n`);
	});

	test("frontmatter that ends the file gets the marker on its own line", () => {
		expect(convert("---\nname: x\n---", "skill")).toBe(`---\nname: x\n---\n${MARKER}\n`);
	});

	test("an empty frontmatter block is a frontmatter block", () => {
		expect(convert("---\n---\nbody\n", "skill")).toBe(`---\n---\n${MARKER}\nbody\n`);
	});

	test("a dashed rule that does not start the file is body text", () => {
		const text = "intro\n---\nname: x\n---\n";
		expect(convert(text, "skill")).toBe(`${MARKER}\n${text}`);
	});

	test("the clone path cannot close the comment it sits in", () => {
		const out = convert(SKILL, "skill", "/odd/--><!--/x");
		const markerLine = out.split("\n").find((line) => line.includes("ultrathink-managed")) ?? "";
		expect(markerLine.match(/-->/g)).toHaveLength(1);
		expect(markerLine).toEndWith(" -->");
		expect(markerLine).toContain("\\u003c");
		expect(markerLine).toContain("\\u003e");
	});
});

describe("toml form", () => {
	test("wraps the body in a literal prompt and lifts the description", () => {
		expect(convert(SKILL, "toml")).toBe(
			[
				`# ultrathink-managed source="${SOURCE}" root="${ROOT}"`,
				'description = "Plan things."',
				"prompt = '''# Plan",
				"",
				"Run `$ARGUMENTS`.",
				"'''",
				"",
			].join("\n"),
		);
	});

	test("reads quoted descriptions and escapes them for TOML", () => {
		const double = convert('---\ndescription: "Say \\"hi\\": a \\\\ b"\n---\nx\n', "toml");
		expect(double).toContain('description = "Say \\"hi\\": a \\\\ b"');
		const single = convert("---\ndescription: 'it''s fine'\n---\nx\n", "toml");
		expect(single).toContain('description = "it\'s fine"');
	});

	test("omits the description when there is none or it is a block scalar", () => {
		expect(convert("---\nname: x\n---\nbody\n", "toml")).not.toContain("description");
		expect(convert("---\ndescription: >\n  folded\n---\nbody\n", "toml")).not.toContain(
			"description",
		);
		expect(convert("---\ndescription:\n---\nbody\n", "toml")).not.toContain("description");
		expect(convert("body only\n", "toml")).toBe(
			`# ultrathink-managed source="${SOURCE}" root="${ROOT}"\nprompt = '''body only\n'''\n`,
		);
	});

	test("trims leading blank lines and ends the body with a newline", () => {
		const out = convert("---\ndescription: d\n---\n\n\n  first\nlast", "toml");
		expect(out).toEndWith("prompt = '''  first\nlast\n'''\n");
	});

	test("an empty body is an empty prompt", () => {
		const out = convert("---\ndescription: d\n---\n", "toml");
		expect(out).toEndWith("prompt = ''''''\n");
		expect(tomlTable(out).prompt).toBe("");
	});

	test("falls back to an escaped basic string when the body has a triple quote or control characters", () => {
		const triple = convert("---\ndescription: d\n---\nit's '''quoted''' \\ \"x\"\n", "toml");
		expect(triple).toEndWith('prompt = """it\'s \'\'\'quoted\'\'\' \\\\ \\"x\\"\n"""\n');
		const control = convert("---\ndescription: d\n---\na\u0001b\r\nc\u007f\n", "toml");
		expect(control).toEndWith('prompt = """a\\u0001b\\u000d\nc\\u007f\n"""\n');
	});

	test("a TOML document parses back to the same description and prompt", () => {
		const body = "# Title\n\nLine with 'quotes', \"double\" and \\ backslash.\n";
		const out = convert(`---\ndescription: Hello there\n---\n\n${body}`, "toml");
		const parsed = tomlTable(out);
		expect(parsed.description).toBe("Hello there");
		expect(parsed.prompt).toBe(body);
		// Bun 1.2.x rejects the \uXXXX escapes that TOML 1.0 allows in multi-line basic strings, so this round trip runs only
		// where the parser implements them (verified on Bun 1.4). The exact escaped output is pinned by the test above on every Bun.
		const [bunMajor = 0, bunMinor = 0] = Bun.version.split(".").map(Number);
		if (bunMajor > 1 || bunMinor >= 4) {
			const escaped = convert("---\ndescription: d\n---\nit's '''x''' \u0001\n", "toml");
			expect(tomlTable(escaped).prompt).toBe("it's '''x''' \u0001\n");
		}
	});

	test("placeholders are copied verbatim", () => {
		expect(convert("---\ndescription: d\n---\nrun $ARGUMENTS {{args}}\n", "toml")).toContain(
			"run $ARGUMENTS {{args}}",
		);
	});
});

describe("isManaged", () => {
	test("recognises the marker line of every form", () => {
		for (const form of ["skill", "markdown", "toml"] as const) {
			expect(isManaged(convert(SKILL, form))).toBe(true);
		}
	});

	test("does not take prose or another tool's file for a managed one", () => {
		expect(isManaged("# My notes\nSee ultrathink-managed files.\n")).toBe(false);
		expect(isManaged("<!-- gsd-managed -->\n")).toBe(false);
		expect(isManaged("")).toBe(false);
	});
});
