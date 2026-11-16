// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { findRuntime, RUNTIMES } from "./runtimes.ts";

const EXPECTED_IDS = [
	"kimi",
	"kimi-code",
	"kilo",
	"opencode",
	"pi",
	"codex",
	"copilot",
	"antigravity",
	"windsurf",
	"augment",
	"trae",
	"qwen",
	"codebuddy",
	"cline",
	"zcode",
];

describe("RUNTIMES", () => {
	test("contains exactly the 15 expected agents", () => {
		expect([...RUNTIMES.map((r) => r.id)].sort()).toEqual([...EXPECTED_IDS].sort());
	});

	test("ids are unique and kebab-case", () => {
		const ids = RUNTIMES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
	});

	test("gsdFlag is unique and matches --id form", () => {
		const flags = RUNTIMES.map((r) => r.gsdFlag);
		expect(new Set(flags).size).toBe(flags.length);
		for (const r of RUNTIMES) expect(r.gsdFlag).toBe(`--${r.id}`);
	});

	test("every descriptor cites at least one source", () => {
		for (const r of RUNTIMES) {
			expect(r.sources.length).toBeGreaterThan(0);
			for (const s of r.sources) expect(s.trim().length).toBeGreaterThan(0);
		}
	});

	test("no descriptor claims gating yes without a source", () => {
		for (const r of RUNTIMES) {
			if (r.gating === "yes") expect(r.sources.length).toBeGreaterThan(0);
		}
	});

	test("windsurf is workspace-scope with workflows layout", () => {
		const windsurf = findRuntime("windsurf");
		expect(windsurf?.scope).toBe("workspace");
		expect(windsurf?.layout).toBe("workflows");
	});

	test("scope both declares a workspace-relative default; scope global declares none", () => {
		for (const r of RUNTIMES) {
			const hasLocal = r.configRoot.defaults.some((d) => d.startsWith("./"));
			if (r.scope === "both" || r.scope === "workspace") expect(hasLocal).toBe(true);
			if (r.scope === "global") expect(hasLocal).toBe(false);
		}
		expect(findRuntime("cline")?.scope).toBe("global");
	});

	test("layouts have the directories they need", () => {
		for (const r of RUNTIMES) {
			if (r.layout === "skills" || r.layout === "skills+commands") expect(r.skillsDir).toBeTruthy();
			if (r.layout === "commands" || r.layout === "skills+commands" || r.layout === "workflows") {
				expect(r.commandsDir).toBeTruthy();
			}
			expect(r.configRoot.defaults.length).toBeGreaterThan(0);
		}
	});
});

describe("findRuntime", () => {
	test("returns the descriptor for a known id", () => {
		expect(findRuntime("codex")?.gsdFlag).toBe("--codex");
	});

	test("returns undefined for unknown ids", () => {
		expect(findRuntime("claude-code")).toBeUndefined();
		expect(findRuntime("nope")).toBeUndefined();
	});
});
