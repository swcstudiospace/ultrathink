// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig } from "../config.ts";
import {
	assertMemoryChain,
	MEMORY_CHAIN,
	type MemoryChainEntry,
	MemoryChainError,
	type MemoryChainViolation,
	memoryChainFor,
} from "./memory-chain.ts";

const PRIMARY: MemoryChainEntry = { vendor: "claude", model: "claude-haiku-5-5" };
const FALLBACK: MemoryChainEntry = { vendor: "grok", model: "grok-build-0.1" };

function violationOf(entries: readonly { vendor: string; model: string }[]): MemoryChainViolation {
	try {
		assertMemoryChain(entries);
	} catch (error) {
		if (error instanceof MemoryChainError) return error.violation;
		throw error;
	}
	throw new Error("expected a MemoryChainError");
}

describe("MEMORY_CHAIN", () => {
	test("pins Haiku 5.5 then Grok Build", () => {
		expect(MEMORY_CHAIN.primary).toEqual(PRIMARY);
		expect(MEMORY_CHAIN.fallback).toEqual(FALLBACK);
	});
});

describe("assertMemoryChain", () => {
	test("accepts exactly [primary] or [primary, fallback]", () => {
		expect(() => assertMemoryChain([PRIMARY])).not.toThrow();
		expect(() => assertMemoryChain([PRIMARY, FALLBACK])).not.toThrow();
	});

	test.each([
		["Sonnet as the only entry", [{ vendor: "claude", model: "claude-sonnet-5-5" }], "model"],
		[
			"Sonnet ahead of the fallback",
			[{ vendor: "claude", model: "claude-sonnet-5-5" }, FALLBACK],
			"model",
		],
		["an unknown Claude model", [{ vendor: "claude", model: "claude-haiku-9" }], "model"],
		["the Haiku alias instead of the pinned id", [{ vendor: "claude", model: "haiku" }], "model"],
		["grok-4.7 as the fallback", [PRIMARY, { vendor: "grok", model: "grok-4.7" }], "model"],
		["grok-4.6 as the fallback", [PRIMARY, { vendor: "grok", model: "grok-4.6" }], "model"],
		[
			"OpenRouter as the fallback",
			[PRIMARY, { vendor: "openrouter", model: "x-ai/grok-4.7" }],
			"vendor",
		],
		[
			"OpenRouter as the only entry",
			[{ vendor: "openrouter", model: "claude-haiku-5-5" }],
			"vendor",
		],
		["the reversed pair", [FALLBACK, PRIMARY], "order"],
		["the fallback alone", [FALLBACK], "order"],
		["a duplicated primary", [PRIMARY, PRIMARY], "duplicate"],
		["three entries", [PRIMARY, FALLBACK, FALLBACK], "length"],
		["an empty list", [], "length"],
	] as const)("rejects %s", (_name, entries, violation) => {
		expect(violationOf(entries)).toBe(violation);
	});

	test("the error names the offending entry and the fix, and carries a stable code", () => {
		try {
			assertMemoryChain([{ vendor: "claude", model: "claude-sonnet-5-5" }]);
			throw new Error("expected a MemoryChainError");
		} catch (error) {
			expect(error).toBeInstanceOf(MemoryChainError);
			const failure = error as MemoryChainError;
			expect(failure.name).toBe("MemoryChainError");
			expect(failure.code).toBe("memory_chain_violation");
			expect(failure.entry).toEqual({ vendor: "claude", model: "claude-sonnet-5-5" });
			expect(failure.message).toContain("claude:claude-sonnet-5-5");
			expect(failure.message).toContain("claude:claude-haiku-5-5");
		}
	});
});

describe("memoryChainFor", () => {
	const consent = { claude: { fallbackToGrok: true }, grok: { enabled: true } };

	test("is the primary alone by default", () => {
		expect(memoryChainFor(defaultConfig())).toEqual([PRIMARY]);
	});

	test("adds the fallback only with fallbackToGrok on, Grok enabled and a non-shunt transport", () => {
		const base = defaultConfig();
		const on = mergeConfig(consent, base);
		expect(memoryChainFor(on)).toEqual([PRIMARY, FALLBACK]);
		expect(memoryChainFor({ ...on, grok: { ...on.grok, enabled: false } })).toEqual([PRIMARY]);
		expect(memoryChainFor({ ...on, grok: { ...on.grok, transport: "shunt" } })).toEqual([PRIMARY]);
		expect(memoryChainFor({ ...on, claude: { ...on.claude, fallbackToGrok: false } })).toEqual([
			PRIMARY,
		]);
		expect(memoryChainFor({ ...on, grok: { ...on.grok, transport: "cli" } })).toEqual([
			PRIMARY,
			FALLBACK,
		]);
	});

	test("ignores every model setting", () => {
		const on = mergeConfig(consent, defaultConfig());
		const adversarial = {
			...on,
			claude: { ...on.claude, model: "claude-sonnet-5-5" },
			grok: { ...on.grok, model: "grok-4.7", fallbackModels: ["grok-4.7", "grok-4.6"] },
		};
		expect(memoryChainFor(adversarial)).toEqual([PRIMARY, FALLBACK]);
		expect(() => assertMemoryChain(memoryChainFor(adversarial))).not.toThrow();
	});
});
