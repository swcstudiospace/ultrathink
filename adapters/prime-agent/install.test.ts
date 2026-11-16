// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installPrimeAgentSkill } from "./install.ts";

let base: string;
let sourceDir: string;
let skillsDir: string;
let target: string;

beforeEach(async () => {
	base = await mkdtemp(join(tmpdir(), "prime-agent-install-test-"));
	sourceDir = join(base, "repo");
	skillsDir = join(base, "skills");
	target = join(skillsDir, "ultrathink");
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

/** Writes files under the repo's hosts/prime-agent directory, keyed by path relative to it. */
async function writeSource(files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) {
		const destination = join(sourceDir, "hosts", "prime-agent", path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, content);
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

describe("installPrimeAgentSkill", () => {
	test("fresh install writes SKILL.md and command skills and reports installed", async () => {
		await writeSource({
			"SKILL.md": "# ultrathink",
			"commands/ultrathink-off/SKILL.md": "off",
		});

		expect(await installPrimeAgentSkill({ skillsDir, sourceDir })).toEqual({
			ok: true,
			status: "installed",
		});
		expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("# ultrathink");
		expect(await readFile(join(target, "commands/ultrathink-off/SKILL.md"), "utf8")).toBe("off");
	});

	test("repeat install with identical sources is unchanged", async () => {
		await writeSource({
			"SKILL.md": "# ultrathink",
			"commands/ultrathink-off/SKILL.md": "off",
		});
		await installPrimeAgentSkill({ skillsDir, sourceDir });

		expect(await installPrimeAgentSkill({ skillsDir, sourceDir })).toEqual({
			ok: true,
			status: "unchanged",
		});
	});

	test("source without SKILL.md fails with install_failed and leaves no target", async () => {
		await writeSource({ "commands/ultrathink-off/SKILL.md": "off" });

		expect(await installPrimeAgentSkill({ skillsDir, sourceDir })).toMatchObject({
			ok: false,
			error: { category: "install_failed", message: expect.stringContaining("SKILL.md") },
		});
		expect(await exists(target)).toBe(false);
		expect(await readdir(skillsDir).catch(() => [])).toEqual([]);
	});

	test("installs only commands/ultrathink-* directories that contain SKILL.md", async () => {
		await writeSource({
			"SKILL.md": "# ultrathink",
			"commands/ultrathink-off/SKILL.md": "off",
			"commands/ultrathink-empty/README.md": "no skill file",
			"commands/other/SKILL.md": "not an ultrathink command",
		});

		expect(await installPrimeAgentSkill({ skillsDir, sourceDir })).toEqual({
			ok: true,
			status: "installed",
		});
		expect(await exists(join(target, "commands/ultrathink-off/SKILL.md"))).toBe(true);
		expect(await exists(join(target, "commands/ultrathink-empty"))).toBe(false);
		expect(await exists(join(target, "commands/other"))).toBe(false);
	});

	test("a changed source replaces the install and drops removed commands", async () => {
		await writeSource({
			"SKILL.md": "v1",
			"commands/ultrathink-off/SKILL.md": "off",
			"commands/ultrathink-on/SKILL.md": "on",
		});
		await installPrimeAgentSkill({ skillsDir, sourceDir });
		await rm(sourceDir, { recursive: true, force: true });
		await writeSource({ "SKILL.md": "v2", "commands/ultrathink-off/SKILL.md": "off" });

		expect(await installPrimeAgentSkill({ skillsDir, sourceDir })).toEqual({
			ok: true,
			status: "installed",
		});
		expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("v2");
		expect(await exists(join(target, "commands/ultrathink-on"))).toBe(false);
	});
});
