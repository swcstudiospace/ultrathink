// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLI_RUNTIME_ENTRIES,
	CLI_RUNTIME_IDS,
	detectLoaded,
	listConnections,
	requestConnection,
} from "./inventory.ts";

const REQUIRED_IDS = [
	"claude",
	"codex",
	"antigravity",
	"opencode",
	"kilo",
	"kimi",
	"copilot",
	"cursor",
	"windsurf",
	"cline",
	"codebuddy",
	"qwen",
	"augment",
	"trae",
	"zcode",
	"pi",
	"hermes",
	"kimi-code",
] as const;

function loadedAll(): Record<string, number> {
	return Object.fromEntries(CLI_RUNTIME_IDS.map((id) => [id, 1]));
}

function withTempRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "inventory-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("CLI inventory", () => {
	test("AC-13 all 18 loaded yields 18 connected lines and the id set equals CLI_RUNTIME_IDS", () => {
		const inventory = listConnections(loadedAll());
		expect(inventory.requiredCount).toBe(18);
		expect(inventory.lines).toHaveLength(18);
		expect(
			inventory.lines.every((line) => line.status === "connected" && line.code === undefined),
		).toBe(true);
		expect(inventory.lines.map((line) => line.runtimeId)).toEqual([...CLI_RUNTIME_IDS]);
		expect([...CLI_RUNTIME_IDS]).toEqual([...REQUIRED_IDS]);
		expect(CLI_RUNTIME_IDS).not.toContain("vscode");
		expect(CLI_RUNTIME_IDS).not.toContain("gemini");
		expect(CLI_RUNTIME_IDS).not.toContain("omp");
		expect(CLI_RUNTIME_IDS).not.toContain("devin-desktop");
	});

	test("AC-14 vscode is excluded and the required count stays 18", () => {
		const inventory = listConnections({ vscode: 4, ...loadedAll() });
		expect(inventory.requiredCount).toBe(18);
		expect(inventory.lines.map((line) => line.runtimeId)).not.toContain("vscode");
		expect(inventory.lines).toHaveLength(18);
		const requested = requestConnection("vscode", { vscode: 4 });
		expect(requested).toEqual({ runtimeId: "vscode", status: "excluded", requiredCount: 18 });
		expect(CLI_RUNTIME_IDS).not.toContain("vscode");
	});

	test("AC-15 gemini returns GSD_RETIRED_RUNTIME and requiredCount 18", () => {
		expect(requestConnection("gemini", { gemini: 3 })).toEqual({
			runtimeId: "gemini",
			status: "retired",
			requiredCount: 18,
			code: "GSD_RETIRED_RUNTIME",
		});
		expect(listConnections({ gemini: 1 }).requiredCount).toBe(18);
		expect(listConnections({ gemini: 1 }).lines.map((line) => line.runtimeId)).not.toContain(
			"gemini",
		);
	});

	test("AC-16 hermes loaded 0 is missing and PLUGIN_AGENT_MISSING", () => {
		const loaded = loadedAll();
		loaded.hermes = 0;
		const line = listConnections(loaded).lines.find((item) => item.runtimeId === "hermes");
		expect(line).toEqual({
			runtimeId: "hermes",
			status: "missing",
			code: "PLUGIN_AGENT_MISSING",
		});
		expect(requestConnection("hermes", { hermes: 0 })).toEqual({
			runtimeId: "hermes",
			status: "missing",
			requiredCount: 18,
			code: "PLUGIN_AGENT_MISSING",
		});
	});

	test("omp is not a success for pi and is not required", () => {
		const fromPi = requestConnection("omp", { pi: 1 });
		expect(fromPi.status).not.toBe("connected");
		expect(fromPi.requiredCount).toBe(18);
		expect(listConnections({ pi: 1, omp: 1 }).lines.map((line) => line.runtimeId)).not.toContain(
			"omp",
		);
		expect(requestConnection("pi", { omp: 1 })).toEqual({
			runtimeId: "pi",
			status: "missing",
			requiredCount: 18,
			code: "PLUGIN_AGENT_MISSING",
		});
		expect(requestConnection("pi", { pi: 1 }).status).toBe("connected");
	});

	test("devin-desktop is not a 19th id", () => {
		const inventory = listConnections({ "devin-desktop": 2, windsurf: 0 });
		expect(inventory.lines).toHaveLength(18);
		expect(inventory.lines.map((line) => line.runtimeId)).not.toContain("devin-desktop");
		expect(inventory.lines.find((line) => line.runtimeId === "windsurf")).toEqual({
			runtimeId: "windsurf",
			status: "missing",
			code: "PLUGIN_AGENT_MISSING",
		});
		expect(requestConnection("devin-desktop", { "devin-desktop": 1 }).status).toBe("excluded");
	});

	test("detectLoaded reports claude connected through adapters/claude-code", () => {
		withTempRoot((root) => {
			mkdirSync(join(root, "adapters", "claude-code"), { recursive: true });
			writeFileSync(join(root, "adapters", "claude-code", "index.ts"), "");
			const loaded = detectLoaded(root);
			expect(loaded.claude).toBe(1);
			expect(requestConnection("claude", loaded).status).toBe("connected");
			expect(listConnections(loaded).lines.find((line) => line.runtimeId === "claude")).toEqual({
				runtimeId: "claude",
				status: "connected",
			});
		});
	});

	test("omp is never in the required set and a pi manifest counts only for pi", () => {
		withTempRoot((root) => {
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ omp: { extensions: ["./omp.ts"] }, pi: { extensions: ["./pi.ts"] } }),
			);
			const loaded = detectLoaded(root);
			expect(CLI_RUNTIME_IDS).not.toContain("omp");
			expect(Object.keys(loaded)).not.toContain("omp");
			expect(loaded.pi).toBe(1);
			expect(requestConnection("omp", loaded).status).toBe("excluded");
			expect(listConnections(loaded).lines.map((line) => line.runtimeId)).not.toContain("omp");
		});
	});

	test("the entry table covers exactly the 18 required ids", () => {
		expect(Object.keys(CLI_RUNTIME_ENTRIES).sort()).toEqual([...CLI_RUNTIME_IDS].sort());
		expect(CLI_RUNTIME_IDS).toHaveLength(18);
	});

	test("gemini stays retired with no entry, and an empty root counts zero for every id", () => {
		withTempRoot((root) => {
			expect(CLI_RUNTIME_ENTRIES).not.toHaveProperty("gemini");
			expect(detectLoaded(root)).not.toHaveProperty("gemini");
			expect(Object.values(detectLoaded(root)).every((count) => count === 0)).toBe(true);
			expect(requestConnection("gemini", { gemini: 1 })).toEqual({
				runtimeId: "gemini",
				status: "retired",
				requiredCount: 18,
				code: "GSD_RETIRED_RUNTIME",
			});
		});
	});
});
