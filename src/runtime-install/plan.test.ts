// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { isManagedName, type PlanContext, planInstall } from "./plan.ts";
import { runtime } from "./test.fixtures.ts";
import type { RuntimeDescriptor } from "./types.ts";

const HOME = "/home/user";
const CWD = "/work/project";

function context(overrides: Partial<PlanContext> = {}): PlanContext {
	return {
		cloneRoot: "/src/ultrathink",
		home: HOME,
		cwd: CWD,
		env: {},
		scope: "global",
		sources: { skills: ["ultrathink-plan", "ultrathink-teach"], commands: ["ultrathink-off"] },
		exists: () => false,
		...overrides,
	};
}

function planOf(descriptor: RuntimeDescriptor, overrides: Partial<PlanContext> = {}) {
	const result = planInstall(descriptor, context(overrides));
	if (!result.ok) throw new Error(result.error);
	return result.plan;
}

function errorOf(descriptor: RuntimeDescriptor, overrides: Partial<PlanContext> = {}): string {
	const result = planInstall(descriptor, context(overrides));
	if (result.ok) throw new Error("expected the plan to fail");
	return result.error;
}

describe("config root", () => {
	const descriptor = runtime({
		id: "fx",
		configRoot: { env: ["FX_A", "FX_B"], defaults: ["~/.fx-one", "~/.fx-two", "./.fx"] },
	});

	test("the first set env var wins, empty values are skipped", () => {
		expect(planOf(descriptor, { env: { FX_A: "  ", FX_B: "/data/fx" } }).configRoot).toBe(
			"/data/fx",
		);
		expect(planOf(descriptor, { env: { FX_A: "/data/a", FX_B: "/data/b" } }).configRoot).toBe(
			"/data/a",
		);
	});

	test("env values expand ~ and resolve a relative path against the workspace", () => {
		expect(planOf(descriptor, { env: { FX_A: "~/cfg/fx" } }).configRoot).toBe("/home/user/cfg/fx");
		expect(planOf(descriptor, { env: { FX_A: "rel/fx" } }).configRoot).toBe("/work/project/rel/fx");
	});

	test("without env the first default that exists is used, else the first default", () => {
		expect(planOf(descriptor).configRoot).toBe("/home/user/.fx-one");
		const exists = (path: string) => path === "/home/user/.fx-two";
		expect(planOf(descriptor, { exists }).configRoot).toBe("/home/user/.fx-two");
	});

	test("a workspace-relative default is never a global root", () => {
		const onlyLocal = runtime({ id: "fx", configRoot: { env: [], defaults: ["./.fx"] } });
		expect(errorOf(onlyLocal)).toBe("fx declares no global config root");
	});

	test("local scope uses the first workspace default below the workspace and ignores env", () => {
		const plan = planOf(descriptor, { scope: "local", env: { FX_A: "/data/a" } });
		expect(plan.configRoot).toBe("/work/project/.fx");
		expect(plan.scope).toBe("local");
	});

	test("local scope needs a workspace default", () => {
		const noLocal = runtime({ id: "fx", configRoot: { env: [], defaults: ["~/.fx"] } });
		expect(errorOf(noLocal, { scope: "local" })).toBe("fx declares no workspace config root");
	});

	test("a runtime that supports one scope refuses the other", () => {
		const globalOnly = runtime({ id: "fx", scope: "global" });
		const workspaceOnly = runtime({
			id: "fx",
			scope: "workspace",
			configRoot: { env: [], defaults: ["./.fx"] },
		});
		expect(errorOf(globalOnly, { scope: "local" })).toBe(
			"fx installs globally only; run without --local",
		);
		expect(errorOf(workspaceOnly)).toBe("fx installs into a workspace only; run with --local");
	});

	test("a default that is not ~, absolute or relative is rejected", () => {
		for (const entry of ["~other/x", ""]) {
			const bad = runtime({ id: "fx", configRoot: { env: [], defaults: [entry] } });
			expect(errorOf(bad)).toBe(`fx: unsupported config root "${entry}"`);
		}
	});

	test("an absolute default is used as written", () => {
		const absolute = runtime({ id: "fx", configRoot: { env: [], defaults: ["/opt/fx"] } });
		expect(planOf(absolute).configRoot).toBe("/opt/fx");
	});
});

describe("layouts", () => {
	test("skills puts each skill in its own directory and ignores commands", () => {
		const plan = planOf(runtime({ id: "fx" }));
		expect(plan.runtime).toBe("fx");
		expect(plan.manifestDir).toBe("/home/user/.fx/ultrathink-runtime");
		expect(plan.ops).toEqual([
			{
				form: "skill",
				source: "skills/ultrathink-plan/SKILL.md",
				sourcePath: "/src/ultrathink/skills/ultrathink-plan/SKILL.md",
				path: "skills/ultrathink-plan/SKILL.md",
				target: "/home/user/.fx/skills/ultrathink-plan/SKILL.md",
			},
			{
				form: "skill",
				source: "skills/ultrathink-teach/SKILL.md",
				sourcePath: "/src/ultrathink/skills/ultrathink-teach/SKILL.md",
				path: "skills/ultrathink-teach/SKILL.md",
				target: "/home/user/.fx/skills/ultrathink-teach/SKILL.md",
			},
		]);
	});

	test("skills+commands adds the commands in the descriptor's suffix form", () => {
		const markdown = planOf(
			runtime({ id: "fx", layout: "skills+commands", commandsDir: "command" }),
		);
		expect(markdown.ops.map((op) => [op.form, op.path])).toEqual([
			["markdown", "command/ultrathink-off.md"],
			["skill", "skills/ultrathink-plan/SKILL.md"],
			["skill", "skills/ultrathink-teach/SKILL.md"],
		]);
		const toml = planOf(
			runtime({
				id: "fx",
				layout: "skills+commands",
				commandsDir: "command",
				commandSuffix: ".toml",
			}),
		);
		expect(toml.ops.map((op) => [op.form, op.path, op.source])).toContainEqual([
			"toml",
			"command/ultrathink-off.toml",
			"commands/ultrathink-off.md",
		]);
	});

	test("commands and workflows have no skills surface, so skills become commands", () => {
		for (const layout of ["commands", "workflows"] as const) {
			const plan = planOf(
				runtime({
					id: "fx",
					layout,
					skillsDir: undefined,
					commandsDir: "wf",
					commandSuffix: ".md",
				}),
			);
			expect(plan.ops.map((op) => [op.form, op.source, op.path])).toEqual([
				["markdown", "commands/ultrathink-off.md", "wf/ultrathink-off.md"],
				["markdown", "skills/ultrathink-plan/SKILL.md", "wf/ultrathink-plan.md"],
				["markdown", "skills/ultrathink-teach/SKILL.md", "wf/ultrathink-teach.md"],
			]);
		}
	});

	test("directories are normalized and sources are sorted by destination", () => {
		const plan = planOf(runtime({ id: "fx", skillsDir: "./deep//skills/" }), {
			sources: { skills: ["ultrathink-b", "ultrathink-a"], commands: [] },
		});
		expect(plan.ops.map((op) => op.path)).toEqual([
			"deep/skills/ultrathink-a/SKILL.md",
			"deep/skills/ultrathink-b/SKILL.md",
		]);
	});

	test("a layout needs the directory it writes to, and it must stay inside the config root", () => {
		expect(errorOf(runtime({ id: "fx", skillsDir: undefined }))).toBe(
			"fx: its layout needs skillsDir",
		);
		expect(errorOf(runtime({ id: "fx", layout: "workflows", commandsDir: undefined }))).toBe(
			"fx: its layout needs commandsDir",
		);
		for (const dir of ["../up", "/abs", ".", "", "a\\b", ".."]) {
			expect(errorOf(runtime({ id: "fx", skillsDir: dir }))).toContain("must be a relative path");
		}
	});

	test("only ultrathink-* names are planned", () => {
		for (const name of [
			"gsd-help",
			"ultrathink-",
			"ultrathink-Plan",
			"ultrathink-runtime",
			"ultrathink-backups",
		]) {
			expect(errorOf(runtime({ id: "fx" }), { sources: { skills: [name], commands: [] } })).toBe(
				`source "${name}" is not an ultrathink-* artifact name`,
			);
		}
	});

	test("two sources may not land on one path", () => {
		const descriptor = runtime({
			id: "fx",
			layout: "commands",
			skillsDir: undefined,
			commandsDir: "c",
		});
		const message = errorOf(descriptor, {
			sources: { skills: ["ultrathink-plan"], commands: ["ultrathink-plan"] },
		});
		expect(message).toContain("both install to c/ultrathink-plan.md");
	});

	test("no sources give an empty plan", () => {
		expect(planOf(runtime({ id: "fx" }), { sources: { skills: [], commands: [] } }).ops).toEqual(
			[],
		);
	});
});

describe("isManagedName", () => {
	test("accepts ultrathink-<kebab> and refuses the installer's own directories", () => {
		for (const name of ["ultrathink-plan", "ultrathink-teach-admin", "ultrathink-a1"]) {
			expect(isManagedName(name)).toBe(true);
		}
		for (const name of [
			"ultrathink",
			"ultrathink-",
			"ultrathink--x",
			"Ultrathink-plan",
			"gsd-plan",
			"ultrathink-runtime",
			"ultrathink-backups",
			"ultrathink-a/b",
			"ultrathink-..",
		]) {
			expect(isManagedName(name)).toBe(false);
		}
	});
});
