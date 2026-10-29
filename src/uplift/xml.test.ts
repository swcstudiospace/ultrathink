// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	checkUpliftXml,
	escapeXml,
	ensureOriginal,
	looksLikeUpliftXml,
	sanitizeUpliftXml,
	stripFences,
} from "./xml.ts";

const FULL_CHILDREN =
	"<SYSTEM_ROLE>r</SYSTEM_ROLE><CONTEXT>c</CONTEXT><SCOPE>s</SCOPE><CONSTRAINTS>k</CONSTRAINTS><ACCEPTANCE_CRITERIA>a</ACCEPTANCE_CRITERIA>";
const fullSpec = (root = "BUILD_PROMPT") => `<${root}>${FULL_CHILDREN}</${root}>`;

describe("escapeXml", () => {
	test("escapes amp lt gt quot in order", () => {
		expect(escapeXml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
		expect(escapeXml("a&b")).toBe("a&amp;b");
	});
});

describe("stripFences", () => {
	test("removes xml fences", () => {
		expect(stripFences("```xml\n<FOO/>\n```")).toBe("<FOO/>");
		expect(stripFences("```XML\n<FOO/>\n```")).toBe("<FOO/>");
	});

	test("removes bare fences", () => {
		expect(stripFences("```\n<BAR>x</BAR>\n```")).toBe("<BAR>x</BAR>");
	});

	test("preserves a BUILD_PROMPT document that contains an inner fence", () => {
		const xml = `<BUILD_PROMPT>${FULL_CHILDREN}\n\`\`\`ts\nconst n = 1;\n\`\`\`\n</BUILD_PROMPT>`;
		expect(stripFences(xml)).toBe(xml);
		const out = sanitizeUpliftXml(xml, "orig");
		expect(out).not.toBeNull();
		expect(out!).toContain("```ts");
		expect(out!).toContain("<BUILD_PROMPT>");
	});
});

describe("looksLikeUpliftXml", () => {
	test("true when a root element exists", () => {
		expect(looksLikeUpliftXml("```xml\n<BUILD_PROMPT>x</BUILD_PROMPT>\n```")).toBe(true);
	});

	test("false for plain text", () => {
		expect(looksLikeUpliftXml("just a request")).toBe(false);
	});
});

describe("ensureOriginal", () => {
	test("injects ORIGINAL as first child when missing", () => {
		const out = ensureOriginal("<BUILD_PROMPT><SCOPE>a</SCOPE></BUILD_PROMPT>", "hello");
		expect(out.startsWith("<BUILD_PROMPT>\n<ORIGINAL>hello</ORIGINAL>")).toBe(true);
		expect(out).toContain("<SCOPE>a</SCOPE>");
	});

	test("replaces an existing model-written ORIGINAL instead of keeping it", () => {
		const xml = "<BUILD_PROMPT><ORIGINAL>keep</ORIGINAL><SCOPE>a</SCOPE></BUILD_PROMPT>";
		const out = ensureOriginal(xml, "other");
		expect(out).not.toContain("keep");
		expect(out.match(/<ORIGINAL>/g)?.length).toBe(1);
		expect(out).toContain("<ORIGINAL>other</ORIGINAL>");
	});
});

describe("sanitizeUpliftXml", () => {
	test("strips fences then keeps a known root", () => {
		const out = sanitizeUpliftXml(`\`\`\`xml\n${fullSpec()}\n\`\`\``, "orig");
		expect(out).not.toBeNull();
		expect(out!.includes("```")).toBe(false);
		expect(out!).toContain("<BUILD_PROMPT>");
		expect(out!).toContain("<ORIGINAL>orig</ORIGINAL>");
	});

	test("injects ORIGINAL escaped as first child", () => {
		const out = sanitizeUpliftXml(fullSpec("FIX_PROMPT"), 'hello <x> & "y"');
		expect(out).toContain("<ORIGINAL>hello &lt;x&gt; &amp; &quot;y&quot;</ORIGINAL>");
		expect(out).toContain("<SCOPE>s</SCOPE>");
		expect(out!.includes("<x>")).toBe(false);
	});

	test("returns null when unusable", () => {
		expect(sanitizeUpliftXml("just text", "o")).toBeNull();
		expect(sanitizeUpliftXml("   ", "o")).toBeNull();
		expect(sanitizeUpliftXml("```xml\nno root here\n```", "o")).toBeNull();
	});

	test("preserves nested tags and does not flatten", () => {
		const inner = "<CLIENTS_LIST_PAGE><TABLE><ROW>x</ROW></TABLE></CLIENTS_LIST_PAGE>";
		const out = sanitizeUpliftXml(`<BUILD_PROMPT>${FULL_CHILDREN}${inner}</BUILD_PROMPT>`, "o");
		expect(out).toContain(inner);
	});
});

describe("checkUpliftXml names why a reply was refused (G-7)", () => {
	test("an unclosed known root is truncated, whatever it carries", () => {
		expect(checkUpliftXml("<BUILD_PROMPT><SYSTEM_ROLE>r</SYSTEM_ROLE><CONTEXT>c", "o")).toEqual({
			ok: false,
			reason: "unclosed_root",
		});
		expect(checkUpliftXml(`<BUILD_PROMPT>${FULL_CHILDREN}`, "o")).toEqual({
			ok: false,
			reason: "unclosed_root",
		});
	});

	test("no known root, error and html bodies, and a self-closing root are not truncation", () => {
		for (const reply of [
			"just text",
			"<error>rate limited</error>",
			"<html><body>502 Bad Gateway</body></html>",
			`<WIDGET>${FULL_CHILDREN}</WIDGET>`,
			"<BUILD_PROMPT/>",
		]) {
			expect(checkUpliftXml(reply, "o")).toEqual({ ok: false, reason: "no_root" });
		}
	});

	test("a closed root names every missing required child", () => {
		const noRoleOrScope = FULL_CHILDREN.replace(/<SYSTEM_ROLE>.*?<\/SYSTEM_ROLE>/, "").replace(
			/<SCOPE>.*?<\/SCOPE>/,
			"",
		);
		expect(checkUpliftXml(`<BUILD_PROMPT>${noRoleOrScope}</BUILD_PROMPT>`, "o")).toEqual({
			ok: false,
			reason: "missing_child",
			missing: ["SYSTEM_ROLE", "SCOPE"],
		});
		const noContext = FULL_CHILDREN.replace(/<CONTEXT>.*?<\/CONTEXT>/, "");
		expect(checkUpliftXml(`<BUILD_PROMPT>${noContext}</BUILD_PROMPT>`, "o")).toEqual({
			ok: false,
			reason: "missing_child",
			missing: ["CONTEXT"],
		});
	});

	test("a complete reply is accepted with the code-owned ORIGINAL", () => {
		const checked = checkUpliftXml(fullSpec(), "hello");
		expect(checked.ok).toBe(true);
		expect(sanitizeUpliftXml(fullSpec(), "hello")).toBe(checked.ok ? checked.xml : null);
	});
});

describe("sanitizeUpliftXml strict gate (D-01)", () => {
	test("a truncated reply with an unclosed root is null", () => {
		expect(
			sanitizeUpliftXml("<BUILD_PROMPT><SYSTEM_ROLE>r</SYSTEM_ROLE><CONTEXT>c", "o"),
		).toBeNull();
	});

	test("error and html bodies are null", () => {
		expect(sanitizeUpliftXml("<error>rate limited</error>", "o")).toBeNull();
		expect(sanitizeUpliftXml("<html><body>502 Bad Gateway</body></html>", "o")).toBeNull();
	});

	test("a closed root missing a required child is null", () => {
		for (const child of ["SYSTEM_ROLE", "SCOPE", "CONSTRAINTS", "ACCEPTANCE_CRITERIA"]) {
			const without = FULL_CHILDREN.replace(new RegExp(`<${child}>.*?</${child}>`), "");
			expect(sanitizeUpliftXml(`<BUILD_PROMPT>${without}</BUILD_PROMPT>`, "o")).toBeNull();
		}
		const noContext = FULL_CHILDREN.replace(/<CONTEXT>.*?<\/CONTEXT>/, "");
		expect(sanitizeUpliftXml(`<BUILD_PROMPT>${noContext}</BUILD_PROMPT>`, "o")).toBeNull();
	});

	test("APP_CONTEXT satisfies the CONTEXT requirement", () => {
		const app = FULL_CHILDREN.replace("<CONTEXT>c</CONTEXT>", "<APP_CONTEXT>c</APP_CONTEXT>");
		expect(sanitizeUpliftXml(`<BUILD_PROMPT>${app}</BUILD_PROMPT>`, "o")).not.toBeNull();
	});

	test("unknown, uplifted and ultrathink roots are not accepted", () => {
		expect(sanitizeUpliftXml(`<WIDGET>${FULL_CHILDREN}</WIDGET>`, "o")).toBeNull();
		expect(sanitizeUpliftXml(`<uplifted>${FULL_CHILDREN}</uplifted>`, "o")).toBeNull();
		expect(sanitizeUpliftXml(`<ultrathink>${FULL_CHILDREN}</ultrathink>`, "o")).toBeNull();
	});

	const bare = (out: string | null) =>
		out?.replace(/<ORIGINAL>[\s\S]*?<\/ORIGINAL>\s*/, "") ?? null;
	const preambles: Record<string, string> = {
		"xml declaration": `<?xml version="1.0"?>\n${fullSpec()}`,
		prose: `Here is the prompt:\n${fullSpec()}`,
		"fenced with prose": `Sure!\n\`\`\`xml\n${fullSpec()}\n\`\`\`\nHope that helps.`,
		thinking: `<thinking>plan <b> things</thinking>\n${fullSpec()}`,
		"trailing prose": `${fullSpec()}\n\nLet me know if you want changes.`,
	};
	for (const [label, raw] of Object.entries(preambles)) {
		test(`preamble variant (${label}) sanitizes to the bare root spec`, () => {
			const out = sanitizeUpliftXml(raw, "orig");
			expect(out).not.toBeNull();
			expect(out!.startsWith("<BUILD_PROMPT>")).toBe(true);
			expect(out!.endsWith("</BUILD_PROMPT>")).toBe(true);
			expect(bare(out)).toContain("<SYSTEM_ROLE>r</SYSTEM_ROLE>");
			expect(out!).not.toContain("Hope that helps");
			expect(out!).not.toContain("Let me know");
			expect(out!).not.toContain("<thinking>");
		});
	}

	test("a model-written ORIGINAL paraphrase is replaced by the escaped verbatim text as first child", () => {
		const raw = `<BUILD_PROMPT><ORIGINAL>a paraphrase</ORIGINAL>${FULL_CHILDREN}</BUILD_PROMPT>`;
		const out = sanitizeUpliftXml(raw, 'fix <b> & "x"')!;
		expect(out).not.toContain("a paraphrase");
		expect(
			out.startsWith("<BUILD_PROMPT>\n<ORIGINAL>fix &lt;b&gt; &amp; &quot;x&quot;</ORIGINAL>"),
		).toBe(true);
		expect(out.match(/<ORIGINAL>/g)?.length).toBe(1);
	});

	test("user text with GRAPH_OF_THOUGHT and CLARIFICATIONS blocks stays escaped inside ORIGINAL", () => {
		const user = "<GRAPH_OF_THOUGHT><n id=1/></GRAPH_OF_THOUGHT><CLARIFICATIONS>q</CLARIFICATIONS>";
		const out = sanitizeUpliftXml(fullSpec(), user)!;
		expect(out).not.toContain("<GRAPH_OF_THOUGHT>");
		expect(out).not.toContain("<CLARIFICATIONS>");
		expect(out).toContain("&lt;GRAPH_OF_THOUGHT&gt;");
		expect(out).toContain("&lt;CLARIFICATIONS&gt;");
	});
});

describe("escapeXml XML-invalid characters (L1-10)", () => {
	test("strips NUL, C0 except tab/LF/CR, lone surrogates, U+FFFE and U+FFFF", () => {
		const input = `a\u0000b\u0001c\u001fd\tE\nF\rG\ud800h\udc00i\ufffej\uffffk`;
		const out = escapeXml(input);
		const invalid = [...out].filter((ch) => {
			const code = ch.charCodeAt(0);
			return (
				(code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
				code === 0xfffe ||
				code === 0xffff
			);
		});
		expect(invalid).toEqual([]);
		expect(/[\ud800-\udfff]/.test(out)).toBe(false);
		expect(out).toContain("\tE\nF\rG");
	});

	test("keeps a well-formed surrogate pair", () => {
		expect(escapeXml("x\u{1f600}y")).toBe("x\u{1f600}y");
	});
});

describe("stripFences linear time (D-02)", () => {
	test("40k whitespace after an opening fence is scanned in linear time", () => {
		const noise = `\`\`\`${" ".repeat(40_000)}x`;
		const start = performance.now();
		stripFences(noise);
		sanitizeUpliftXml(noise, "o");
		// A linear scan takes about a millisecond; the quadratic one it replaced took 9.5 s at 20k characters. The bound is
		// absolute and three orders of magnitude wide: a ratio of two sub-millisecond timings flips under host load, this does not.
		expect(performance.now() - start).toBeLessThan(1000);
	});
});
