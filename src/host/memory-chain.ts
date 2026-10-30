// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The only models memory-bank inference (the local `teach observe` distill) may use: Claude Haiku 5.5 first and, only
 * with the user's consent and a signed-in Grok lane, Grok Build second. The owner's rule is absolute (never Sonnet,
 * never grok-4.7, never OpenRouter), so the pair is pinned in code and no config key can change it; `selectEngine`
 * asserts the final candidate list against it and fails closed.
 */
import type { UltrathinkConfig } from "../config.ts";

export interface MemoryChainEntry {
	readonly vendor: "claude" | "grok";
	readonly model: string;
}

/** The only models memory-bank inference may use. Pinned in code on purpose: no config key changes them. */
export const MEMORY_CHAIN: {
	readonly primary: MemoryChainEntry;
	readonly fallback: MemoryChainEntry;
} = {
	primary: { vendor: "claude", model: "claude-haiku-5-5" },
	fallback: { vendor: "grok", model: "grok-build-0.1" },
};

export type MemoryChainViolation = "length" | "order" | "vendor" | "model" | "duplicate";

export class MemoryChainError extends Error {
	override name = "MemoryChainError";
	readonly code = "memory_chain_violation" as const;
	readonly violation: MemoryChainViolation;
	readonly entry?: { vendor: string; model: string };

	constructor(
		violation: MemoryChainViolation,
		message: string,
		entry?: { vendor: string; model: string },
	) {
		super(message);
		this.violation = violation;
		if (entry) this.entry = { vendor: entry.vendor, model: entry.model };
	}
}

function same(
	left: { vendor: string; model: string },
	right: { vendor: string; model: string },
): boolean {
	return left.vendor === right.vendor && left.model === right.model;
}

function show(entry: { vendor: string; model: string }): string {
	return `${entry.vendor}:${entry.model}`;
}

const FIX = `memory-bank inference runs only ${show(MEMORY_CHAIN.primary)}, then (with claude.fallbackToGrok and a Grok login) ${show(MEMORY_CHAIN.fallback)}; no setting changes that`;

/** Accepts exactly `[primary]` or `[primary, fallback]`; anything else throws `MemoryChainError`. */
export function assertMemoryChain(entries: readonly { vendor: string; model: string }[]): void {
	if (entries.length < 1 || entries.length > 2)
		throw new MemoryChainError(
			"length",
			`memory-bank chain has ${entries.length} entries, expected 1 or 2: ${FIX}`,
		);
	const expected = [MEMORY_CHAIN.primary, MEMORY_CHAIN.fallback];
	entries.forEach((entry, index) => {
		const want = expected[index] as MemoryChainEntry;
		if (same(entry, want)) return;
		if (entries.slice(0, index).some((earlier) => same(earlier, entry)))
			throw new MemoryChainError(
				"duplicate",
				`memory-bank chain repeats ${show(entry)}: ${FIX}`,
				entry,
			);
		if (entry.vendor !== "claude" && entry.vendor !== "grok")
			throw new MemoryChainError(
				"vendor",
				`memory-bank chain may not use vendor ${JSON.stringify(entry.vendor)} (${show(entry)}): ${FIX}`,
				entry,
			);
		if (expected.some((known) => same(known, entry)))
			throw new MemoryChainError(
				"order",
				`memory-bank chain has ${show(entry)} at position ${index + 1}, expected ${show(want)}: ${FIX}`,
				entry,
			);
		throw new MemoryChainError(
			"model",
			`memory-bank chain may not use ${show(entry)}: ${FIX}`,
			entry,
		);
	});
}

/**
 * The chain a memory-bank call is configured to try: the primary, plus the fallback iff the user opted into the
 * cross-vendor fallback and Grok is enabled. Pure; `claude.model`, `grok.model`, `grok.fallbackModels`, `models.hosts` and
 * `think.engine` are ignored on purpose.
 */
export function memoryChainFor(
	config: Pick<UltrathinkConfig, "claude" | "grok">,
): readonly MemoryChainEntry[] {
	const fallback = config.claude.fallbackToGrok && config.grok.enabled;
	return fallback ? [MEMORY_CHAIN.primary, MEMORY_CHAIN.fallback] : [MEMORY_CHAIN.primary];
}
