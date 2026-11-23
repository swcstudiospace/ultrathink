// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	createCodeBlockedPrd,
	getCodeBlockedPrd,
	selectCheapest,
	type ModelPrice,
} from "./code-blocked-prd.ts";

const AC8: ModelPrice[] = [
	{ modelId: "alpha", callable: true, inputUsdPerMillion: 0.5 },
	{ modelId: "beta", callable: true, inputUsdPerMillion: 1 },
	{ modelId: "gamma", callable: true, inputUsdPerMillion: 3 },
	{ modelId: "delta", callable: true, inputUsdPerMillion: 0.5 },
];

describe("selectCheapest (AC-8)", () => {
	test("alpha wins the 0.50 tie with delta by code point", () => {
		expect(selectCheapest(AC8)).toBe("alpha");
	});

	test("ignores callable false and a missing price, and keeps price 0", () => {
		expect(
			selectCheapest([
				{ modelId: "cheap-off", callable: false, inputUsdPerMillion: 0 },
				{ modelId: "unpriced", callable: true },
				{ modelId: "zero", callable: true, inputUsdPerMillion: 0 },
				{ modelId: "one", callable: true, inputUsdPerMillion: 1 },
			]),
		).toBe("zero");
	});
});

describe("Code Blocked PRD", () => {
	test("AC-6: 3 steps and Tree-of-Thought not finished keeps count 0", () => {
		const graphId = "g-ac6";
		const nodeId = "n-ac6";
		expect(getCodeBlockedPrd(graphId, nodeId)).toEqual({ count: 0, secretScanMatches: 0 });
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 3,
			selectedModelId: "session-selected",
			treeOfThoughtFinished: false,
			prices: AC8,
		});
		expect(created.count).toBe(0);
		expect(created.code).toBeUndefined();
		expect(created.secretScanMatches).toBe(0);
		expect(getCodeBlockedPrd(graphId, nodeId).count).toBe(0);
	});

	test("AC-7: finished Tree-of-Thought attaches 1 PRD with cotStepCount 3", () => {
		const graphId = "g-ac7";
		const nodeId = "n-ac7";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 3,
			selectedModelId: "alpha",
			treeOfThoughtFinished: true,
			prices: AC8,
		});
		expect(created.count).toBe(1);
		expect(created.cotStepCount).toBe(3);
		expect(getCodeBlockedPrd(graphId, nodeId)).toEqual(created);
	});

	test("AC-8: recorded Tree-of-Thought model is alpha", () => {
		const created = createCodeBlockedPrd({
			graphId: "g-ac8",
			nodeId: "n-ac8",
			cotStepCount: 3,
			selectedModelId: "beta",
			treeOfThoughtFinished: true,
			prices: AC8,
		});
		expect(created.count).toBe(1);
		expect(created.treeModelId).toBe("alpha");
	});

	test("AC-9: session-selected for graph and CoT, cheaper model for the tree", () => {
		const created = createCodeBlockedPrd({
			graphId: "g-ac9",
			nodeId: "n-ac9",
			cotStepCount: 3,
			selectedModelId: "session-selected",
			treeOfThoughtFinished: true,
			prices: [
				{ modelId: "session-selected", callable: true, inputUsdPerMillion: 2 },
				{ modelId: "alpha", callable: true, inputUsdPerMillion: 0.5 },
			],
		});
		expect(created.graphModelId).toBe("session-selected");
		expect(created.cotModelId).toBe("session-selected");
		expect(created.treeModelId).not.toBe("session-selected");
		expect(created.treeModelId).toBe("alpha");
	});

	test("selected model that is also cheapest is recorded as the tree model", () => {
		const created = createCodeBlockedPrd({
			graphId: "g-same",
			nodeId: "n-same",
			cotStepCount: 1,
			selectedModelId: "alpha",
			treeOfThoughtFinished: true,
			prices: AC8,
		});
		expect(created.treeModelId).toBe("alpha");
		expect(created.treeModelId).toBe(created.selectedModelId);
	});

	test("AC-10: no callable published price writes 0 PRDs and PRD_NO_PRICE", () => {
		const graphId = "g-ac10";
		const nodeId = "n-ac10";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 3,
			selectedModelId: "session-selected",
			treeOfThoughtFinished: true,
			prices: [
				{ modelId: "off", callable: false, inputUsdPerMillion: 0.1 },
				{ modelId: "bare", callable: true },
			],
		});
		expect(created).toEqual({ count: 0, secretScanMatches: 0, code: "PRD_NO_PRICE" });
		expect(getCodeBlockedPrd(graphId, nodeId).count).toBe(0);
	});

	test("AC-11: empty selected model writes 0 PRDs and PRD_NO_SELECTED_MODEL", () => {
		const graphId = "g-ac11";
		const nodeId = "n-ac11";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 3,
			selectedModelId: "",
			treeOfThoughtFinished: true,
			prices: AC8,
		});
		expect(created).toEqual({
			count: 0,
			secretScanMatches: 0,
			code: "PRD_NO_SELECTED_MODEL",
		});
		expect(getCodeBlockedPrd(graphId, nodeId).count).toBe(0);
	});

	test("AC-12: heading, one fence, and a Blocked until line", () => {
		const created = createCodeBlockedPrd({
			graphId: "g-ac12",
			nodeId: "n-ac12",
			cotStepCount: 3,
			selectedModelId: "session-selected",
			treeOfThoughtFinished: true,
			prices: AC8,
		});
		expect(created.heading).toBe("Code Blocked PRD");
		expect(created.fencedCodeBlocks).toBeGreaterThanOrEqual(1);
		expect(created.blockedUntilLines).toBeGreaterThanOrEqual(1);
	});

	test("a secret-shaped model id is not attached and is not echoed", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz";
		const graphId = "g-secret";
		const nodeId = "n-secret";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 1,
			selectedModelId: secret,
			treeOfThoughtFinished: true,
			prices: [{ modelId: "alpha", callable: true, inputUsdPerMillion: 0.5 }],
		});
		expect(created).toEqual({ count: 0, secretScanMatches: 0, code: "PRD_SECRET_SCAN_MATCH" });
		expect(JSON.stringify(created).includes(secret)).toBe(false);
		expect(getCodeBlockedPrd(graphId, nodeId).count).toBe(0);
	});

	test("fullBody with a secret-shaped token yields PRD_SECRET_SCAN_MATCH and stores nothing", () => {
		const secret = "sk-abcdefghijklmnopqrstuvwxyz";
		const graphId = "g-scan";
		const nodeId = "n-scan";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 1,
			selectedModelId: "alpha",
			treeOfThoughtFinished: true,
			prices: AC8,
			fullBody: `Code Blocked PRD\n\nBlocked until: sub-issue step 1\n\nUse ${secret} for the call\n\n\`\`\`\n// change\n\`\`\``,
			step: 1,
		});
		expect(created).toEqual({ count: 0, secretScanMatches: 0, code: "PRD_SECRET_SCAN_MATCH" });
		expect(JSON.stringify(created).includes(secret)).toBe(false);
		const stored = getCodeBlockedPrd(graphId, nodeId, 1);
		expect(stored.count).toBe(0);
		expect(stored.body).toBeUndefined();
		expect(JSON.stringify(stored).includes(secret)).toBe(false);
	});

	test("fullBody with no priced model writes 0 PRDs and PRD_NO_PRICE", () => {
		const graphId = "g-no-price-body";
		const nodeId = "n-no-price-body";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 1,
			selectedModelId: "alpha",
			treeOfThoughtFinished: true,
			prices: [],
			fullBody: "Code Blocked PRD\n\nBlocked until: sub-issue step 1\n\n```\n// change\n```",
		});
		expect(created).toEqual({ count: 0, secretScanMatches: 0, code: "PRD_NO_PRICE" });
		expect(getCodeBlockedPrd(graphId, nodeId).count).toBe(0);
	});

	test("fullBody with two callable priced models attaches 1 PRD with the cheaper tree model", () => {
		const graphId = "g-body-cheapest";
		const nodeId = "n-body-cheapest";
		const created = createCodeBlockedPrd({
			graphId,
			nodeId,
			cotStepCount: 1,
			selectedModelId: "session-selected",
			treeOfThoughtFinished: true,
			prices: [
				{ modelId: "pricey", callable: true, inputUsdPerMillion: 3 },
				{ modelId: "cheap", callable: true, inputUsdPerMillion: 0.5 },
			],
			fullBody: "Code Blocked PRD\n\nBlocked until: sub-issue step 1\n\n```\n// change\n```",
		});
		expect(created.count).toBe(1);
		expect(created.treeModelId).toBe("cheap");
		expect(getCodeBlockedPrd(graphId, nodeId).treeModelId).toBe("cheap");
	});
});
