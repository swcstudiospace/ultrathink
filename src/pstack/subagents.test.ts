// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSubagentRoster, resolveSubagentFleet, type SubagentFleet } from "./subagents.ts";

const SIX = ["how", "architect", "arena", "tdd", "interrogate", "no-comments"];

let homeDir = "";
let fullHomeDir = "";
let partialHomeDir = "";

function mkFleetHome(names: readonly string[]): string {
	const home = mkdtempSync(join(tmpdir(), "fleet-"));
	const pluginDir = join(
		home,
		".cursor",
		"plugins",
		"cache",
		"cursor-public",
		"pstack",
		"pstack@1.2.0",
	);
	mkdirSync(join(pluginDir, ".cursor-plugin"), { recursive: true });
	writeFileSync(
		join(pluginDir, ".cursor-plugin", "plugin.json"),
		JSON.stringify({ name: "pstack", version: "1.2.0" }),
	);
	writeFileSync(join(pluginDir, ".cache-complete"), "");
	for (const name of names) {
		mkdirSync(join(pluginDir, "skills", name), { recursive: true });
		writeFileSync(join(pluginDir, "skills", name, "SKILL.md"), `# ${name}\n`);
	}
	return home;
}

function fleetOrThrow(fleet: SubagentFleet): Extract<SubagentFleet, { ok: true }> {
	if (!fleet.ok) throw new Error(fleet.reason);
	return fleet;
}

beforeAll(() => {
	homeDir = mkdtempSync(join(tmpdir(), "fleet-empty-"));
	fullHomeDir = mkFleetHome(SIX);
	partialHomeDir = mkFleetHome(["tdd"]);
});

afterAll(() => {
	for (const dir of [homeDir, fullHomeDir, partialHomeDir]) {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveSubagentFleet", () => {
	test("forced off wins over enabled", () => {
		expect(resolveSubagentFleet({ enabled: true, homeDir: fullHomeDir, forcedOff: true })).toEqual({
			ok: false,
			reason: "pstack bridge forced off (ULTRATHINK_PSTACK=0)",
		});
	});

	test("disabled when not enabled", () => {
		expect(resolveSubagentFleet({ enabled: false, homeDir: fullHomeDir })).toEqual({
			ok: false,
			reason: "pstack bridge disabled",
		});
	});

	test("missing cache dir passes through the resolution reason", () => {
		expect(resolveSubagentFleet({ enabled: true, homeDir })).toEqual({
			ok: false,
			reason: "pstack cache directory not found",
		});
	});

	test("fixture cache resolves six skills and the roster names all absolute paths plus stage routing", () => {
		const fleet = fleetOrThrow(resolveSubagentFleet({ enabled: true, homeDir: fullHomeDir }));
		expect(fleet.version).toBe("1.2.0");
		expect(fleet.skills).toHaveLength(6);
		const roster = renderSubagentRoster(fleet);
		if (roster === null) throw new Error("roster null");
		expect(roster).toContain("## PSTACK subagent fleet");
		for (const { name, path } of fleet.skills) {
			expect(path.startsWith("/")).toBe(true);
			expect(roster).toContain(path);
			expect(roster).toContain(name);
		}
		expect(roster).toContain("- [execute] tdd");
		expect(roster).toContain("- [discuss] how");
		expect(roster).toContain(
			"The GSD phase loop still sequences the waves (TodoWrite, .planning artifacts, verify gate); the fleet only changes how each unit runs. Absent this section, spawn generic Task subagents.",
		);
	});

	test("partial cache resolves only the present skill", () => {
		const fleet = fleetOrThrow(resolveSubagentFleet({ enabled: true, homeDir: partialHomeDir }));
		expect(fleet.skills).toHaveLength(1);
		expect(fleet.skills[0]!.name).toBe("tdd");
		expect(fleet.skills[0]!.stage).toBe("execute");
	});
});

describe("renderSubagentRoster", () => {
	test("null for failure fleets", () => {
		expect(renderSubagentRoster({ ok: false, reason: "x" })).toBeNull();
	});

	test("cap too small fails open with null", () => {
		const fleet = fleetOrThrow(resolveSubagentFleet({ enabled: true, homeDir: fullHomeDir }));
		expect(renderSubagentRoster(fleet, 10)).toBeNull();
	});
});
