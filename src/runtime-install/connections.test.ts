// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	type ConnectionRuntimeId,
	CONNECTION_RUNTIME_IDS,
	REQUIRED_CONNECTION_COUNT,
	listConnections,
	requestConnection,
} from "./connections.ts";

const EXPECTED_IDS: ConnectionRuntimeId[] = [
	"claude",
	"antigravity",
	"augment",
	"cline",
	"codebuddy",
	"codex",
	"copilot",
	"cursor",
	"hermes",
	"kimi",
	"kimi-code",
	"kilo",
	"opencode",
	"pi",
	"qwen",
	"trae",
	"windsurf",
	"zcode",
];

function loadedAll(): Record<string, number> {
	return Object.fromEntries(CONNECTION_RUNTIME_IDS.map((id) => [id, 1]));
}

describe("connection inventory", () => {
	test("the registry is exactly the 18 GSD-Core ids and the inventory mirrors it", () => {
		expect(REQUIRED_CONNECTION_COUNT).toBe(18);
		expect([...CONNECTION_RUNTIME_IDS]).toEqual(EXPECTED_IDS);

		const inventory = listConnections(loadedAll());
		expect(inventory.requiredCount).toBe(18);
		expect(inventory.lines).toHaveLength(18);
		expect(inventory.lines.map((line) => line.runtime)).toEqual(EXPECTED_IDS);
		expect(inventory.lines.every((line) => line.status === "connected")).toBe(true);
		expect(inventory.lines.every((line) => line.code === undefined)).toBe(true);
	});

	test("vscode is excluded from scoring and the required count stays 18", () => {
		const inventory = listConnections({ vscode: 4, ...loadedAll() });
		expect(inventory.requiredCount).toBe(18);
		expect(inventory.lines).toHaveLength(18);
		expect(inventory.lines.map((line) => line.runtime)).not.toContain("vscode");
		expect(requestConnection("vscode", { vscode: 4 })).toEqual({
			runtime: "vscode",
			status: "excluded",
			requiredCount: 18,
		});
	});

	test("gemini returns GSD_RETIRED_RUNTIME and the required set stays 18", () => {
		expect(requestConnection("gemini", { gemini: 3 })).toEqual({
			runtime: "gemini",
			status: "retired",
			requiredCount: 18,
			code: "GSD_RETIRED_RUNTIME",
		});
		const inventory = listConnections({ gemini: 1 });
		expect(inventory.requiredCount).toBe(18);
		expect(inventory.lines).toHaveLength(18);
		expect(inventory.lines.map((line) => line.runtime)).not.toContain("gemini");
	});

	test("hermes with no Ultrathink entries is missing with PLUGIN_AGENT_MISSING", () => {
		const fromZero = listConnections({ ...loadedAll(), hermes: 0 });
		expect(fromZero.lines.find((line) => line.runtime === "hermes")).toEqual({
			runtime: "hermes",
			status: "missing",
			code: "PLUGIN_AGENT_MISSING",
		});
		expect(requestConnection("hermes", { hermes: 0 })).toEqual({
			runtime: "hermes",
			status: "missing",
			requiredCount: 18,
			code: "PLUGIN_AGENT_MISSING",
		});

		const fromNothing = listConnections({});
		expect(fromNothing.lines.find((line) => line.runtime === "hermes")).toEqual({
			runtime: "hermes",
			status: "missing",
			code: "PLUGIN_AGENT_MISSING",
		});
	});

	test("a connected entry reports connected", () => {
		const loaded = { claude: 1 };
		expect(requestConnection("claude", loaded)).toEqual({
			runtime: "claude",
			status: "connected",
			requiredCount: 18,
		});
		expect(listConnections(loaded).lines.find((line) => line.runtime === "claude")).toEqual({
			runtime: "claude",
			status: "connected",
		});
	});
});
