// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { fallbackUplift } from "./fallback.ts";
import { UPLIFT_SYSTEM_PROMPT } from "./prompt.ts";
import { runUplift } from "./run.ts";

const children =
	"<SYSTEM_ROLE>r</SYSTEM_ROLE><CONTEXT>c</CONTEXT><SCOPE>list</SCOPE><CONSTRAINTS>k</CONSTRAINTS><ACCEPTANCE_CRITERIA>a</ACCEPTANCE_CRITERIA>";

describe("runUplift", () => {
	test("llm success uses sanitized model xml", async () => {
		const original = "add a clients list page";
		let system = "";
		let user = "";
		const result = await runUplift({
			original,
			conversation: "User: earlier",
			complete: async (nextSystem, nextUser) => {
				system = nextSystem;
				user = nextUser;
				return `<BUILD_PROMPT>${children}</BUILD_PROMPT>`;
			},
		});
		expect(system).toBe(UPLIFT_SYSTEM_PROMPT);
		expect(user).toContain(original);
		expect(user).toContain("User: earlier");
		expect(result.source).toBe("llm");
		expect(result.original).toBe(original);
		expect(result.root).toBe("BUILD_PROMPT");
		expect(result.xml).toContain("<BUILD_PROMPT>");
		expect(result.xml).toContain(`<ORIGINAL>${original}</ORIGINAL>`);
		expect(result.xml).toContain("<SCOPE>list</SCOPE>");
	});

	test("llm empty uses fallback", async () => {
		let called = 0;
		const original = "hi";
		const result = await runUplift({
			original,
			complete: async () => {
				called += 1;
				return "   ";
			},
		});
		expect(called).toBe(1);
		expect(result.source).toBe("fallback");
		expect(result.root).toBe("UPLIFTED_PROMPT");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("unusable llm xml uses fallback", async () => {
		const original = "hi";
		const result = await runUplift({
			original,
			complete: async () => "not xml at all",
		});
		expect(result.source).toBe("fallback");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("llm throw uses fallback", async () => {
		const original = "hi";
		const result = await runUplift({
			original,
			complete: async () => {
				throw new Error("boom");
			},
		});
		expect(result.source).toBe("fallback");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("AbortError is rethrown", async () => {
		const err = new Error("Aborted");
		err.name = "AbortError";
		let reached = false;
		try {
			await runUplift({
				original: "hi",
				complete: async () => {
					throw err;
				},
			});
		} catch (caught) {
			// reason: the caught error is asserted below, so the rethrow is checked rather than hidden
			reached = true;
			expect(caught).toBe(err);
		}
		expect(reached).toBe(true);
	});

	test("over maxChars uses fallback without calling complete", async () => {
		let called = 0;
		const original = "x".repeat(10);
		const result = await runUplift({
			original,
			maxChars: 5,
			complete: async () => {
				called += 1;
				return "<BUILD_PROMPT>nope</BUILD_PROMPT>";
			},
		});
		expect(called).toBe(0);
		expect(result.source).toBe("fallback");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("equal to maxChars still calls complete", async () => {
		let called = 0;
		const original = "hello";
		const result = await runUplift({
			original,
			maxChars: original.length,
			complete: async () => {
				called += 1;
				return `<RESEARCH_PROMPT>${children}</RESEARCH_PROMPT>`;
			},
		});
		expect(called).toBe(1);
		expect(result.source).toBe("llm");
		expect(result.root).toBe("RESEARCH_PROMPT");
	});

	test("plans a prompt of 60,001 characters with the default config", async () => {
		let called = 0;
		const original = "x".repeat(60_001);
		const result = await runUplift({
			original,
			complete: async () => {
				called += 1;
				return `<RESEARCH_PROMPT>${children}</RESEARCH_PROMPT>`;
			},
		});
		expect(called).toBe(1);
		expect(result.source).toBe("llm");
		expect(result.fallbackReason).toBeUndefined();
		expect(result.root).toBe("RESEARCH_PROMPT");
	});

	test("an explicit positive maxChars cap skips a longer prompt with input_over_limit", async () => {
		let called = 0;
		const original = "x".repeat(101);
		const result = await runUplift({
			original,
			maxChars: 100,
			complete: async () => {
				called += 1;
				return `<RESEARCH_PROMPT>${children}</RESEARCH_PROMPT>`;
			},
		});
		expect(called).toBe(0);
		expect(result.source).toBe("fallback");
		expect(result.fallbackReason).toBe("input_over_limit");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("records provider_error:429 when the completer throws an HTTP 429", async () => {
		let called = 0;
		const original = "add a clients list page";
		const result = await runUplift({
			original,
			complete: async () => {
				called += 1;
				throw Object.assign(new Error("rate limited"), { status: 429 });
			},
			report: () => ({ attempts: 1, httpStatus: 429 }),
		});
		expect(called).toBe(1);
		expect(result.source).toBe("fallback");
		expect(result.fallbackReason).toBe("provider_error:429");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("an unclosed known root falls back with truncated_reply; error and html bodies stay unparseable_reply (G-7)", async () => {
		const original = "add a clients list page";
		const cases: [string, string][] = [
			["<UPLIFTED_PROMPT><SYSTEM_ROLE>r</SYSTEM_ROLE><CONTEXT>c", "truncated_reply"],
			["<BUILD_PROMPT><SYSTEM_ROLE>r</SYSTEM_ROLE><SCOPE>s</SCOPE", "truncated_reply"],
			["<error>rate limited</error>", "unparseable_reply"],
			["<html><body>502 Bad Gateway</body></html>", "unparseable_reply"],
			["<UPLIFTED_PROMPT><SYSTEM_ROLE>r</SYSTEM_ROLE></UPLIFTED_PROMPT>", "unparseable_reply"],
		];
		for (const [reply, reason] of cases) {
			const result = await runUplift({ original, complete: async () => reply });
			expect(result.source).toBe("fallback");
			expect(result.fallbackReason).toBe(reason);
			expect(result.rawReplyChars).toBe(reply.length);
			expect(result.xml).toBe(fallbackUplift(original));
		}
	});

	test("records unparseable_reply when the completion has no root element", async () => {
		const original = "add a clients list page";
		const reply = "Sorry, I cannot turn that into a prompt.";
		const result = await runUplift({
			original,
			complete: async () => reply,
		});
		expect(result.source).toBe("fallback");
		expect(result.fallbackReason).toBe("unparseable_reply");
		expect(result.rawReplyChars).toBe(reply.length);
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("a non-string reply falls back engine_error with attempts from the report", async () => {
		const original = "add a clients list page";
		const result = await runUplift({
			original,
			complete: async () => ({ text: "<BUILD_PROMPT/>" }) as unknown as string,
			report: () => ({ attempts: 3 }),
		});
		expect(result.source).toBe("fallback");
		expect(result.fallbackReason).toBe("engine_error");
		expect(result.attempts).toBe(3);
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("a throwing report() still falls back and never escapes", async () => {
		const original = "add a clients list page";
		const ok = await runUplift({
			original,
			complete: async () => "Sorry, no.",
			report: () => {
				throw new Error("report broke");
			},
		});
		expect(ok.source).toBe("fallback");
		expect(ok.fallbackReason).toBe("unparseable_reply");
		expect(ok.attempts).toBe(1);
		const failed = await runUplift({
			original,
			complete: async () => {
				throw Object.assign(new Error("boom"), { status: 500 });
			},
			report: () => {
				throw new Error("report broke");
			},
		});
		expect(failed.source).toBe("fallback");
		expect(failed.fallbackReason).toBe("provider_error");
		expect(failed.attempts).toBe(1);
	});

	test("input_over_limit records zero attempts and the 200000 default gate applies", async () => {
		const result = await runUplift({
			original: "x".repeat(200_001),
			maxChars: 200_000,
			complete: async () => "never",
		});
		expect(result.fallbackReason).toBe("input_over_limit");
		expect(result.attempts).toBe(0);
	});

	test("an AbortError-shaped non-Error object is rethrown", async () => {
		const abort = { name: "AbortError", message: "aborted" };
		await expect(
			runUplift({
				original: "x",
				complete: async () => {
					throw abort;
				},
			}),
		).rejects.toBe(abort);
	});
});
