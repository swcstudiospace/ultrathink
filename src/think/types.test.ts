// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	FALLBACK_GRAPH,
	isNodeKind,
	isThinkEngine,
	isThinkReasoningCeiling,
	MAX_NODES,
	MAX_STEPS,
	MIN_NODES,
	MIN_STEPS,
	NODE_KINDS,
	THINK_ENGINES,
	THINK_REASONING_CEILINGS,
} from "./types.ts";

describe("think vocabulary (ADR-0006)", () => {
	test("node and step windows keep their contract values", () => {
		expect(MIN_NODES).toBe(6);
		expect(MAX_NODES).toBe(8);
		expect(MIN_STEPS).toBe(5);
		expect(MAX_STEPS).toBe(8);
	});

	test("guards accept the declared vocabularies and reject anything else", () => {
		for (const kind of NODE_KINDS) expect(isNodeKind(kind)).toBe(true);
		expect(isNodeKind("random")).toBe(false);
		expect(isNodeKind(undefined)).toBe(false);
		expect(isNodeKind(null)).toBe(false);

		for (const engine of THINK_ENGINES) expect(isThinkEngine(engine)).toBe(true);
		expect(isThinkEngine("gpt")).toBe(false);
		expect(isThinkEngine(42)).toBe(false);

		for (const ceiling of THINK_REASONING_CEILINGS)
			expect(isThinkReasoningCeiling(ceiling)).toBe(true);
		expect(isThinkReasoningCeiling("ultra")).toBe(false);
		expect(isThinkReasoningCeiling({})).toBe(false);
	});

	test("fallback graph carries six nodes and is frozen against mutation", () => {
		expect(FALLBACK_GRAPH.nodes).toHaveLength(MIN_NODES);
		expect(Object.isFrozen(FALLBACK_GRAPH)).toBe(true);
		expect(Object.isFrozen(FALLBACK_GRAPH.nodes)).toBe(true);
		for (const node of FALLBACK_GRAPH.nodes) {
			expect(Object.isFrozen(node)).toBe(true);
			expect(Object.isFrozen(node.dependsOn)).toBe(true);
		}
	});
});
