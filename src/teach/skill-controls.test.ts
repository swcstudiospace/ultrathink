// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteGeneratedSkill, runSkillsCommand } from "./skill-controls.ts";
import { type AutoSkill, contentHashOf } from "./skill-author.ts";
import { setGeneratedStatus, writeGeneratedSkill } from "./skill-store.ts";

const NOW = "2026-11-17T10:00:00.000Z";
const SKILL = "tsc-value-import-of-types";
const USAGE = "Usage: /ultrathink-skills [list | disable <name> | delete <name>]";

function skillFixture(overrides: Partial<AutoSkill> = {}): AutoSkill {
	const draft: AutoSkill = {
		name: SKILL,
		description: "Use import type for type-only imports in typescript-build runs.",
		applies_when: {
			task_types: ["typescript-build"],
			scope_globs: ["src/**"],
			error_signatures: ["tsc rejects value imports of types"],
		},
		steps: ["Change the import to import type for symbols that are only types."],
		source_ids: ["moment-1"],
		generated_by: "auto",
		generated_at: NOW,
		content_hash: "",
		version: 1,
		status: "draft",
		signature_hash: "0123456789abcdef0123456789abcdef",
		stale: false,
		warnings: [],
		...overrides,
	};
	return { ...draft, content_hash: contentHashOf(draft) };
}

let root: string;
let storeDir: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "skill-controls-test-"));
	storeDir = join(root, "store");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const run = (argText: string) => runSkillsCommand(argText, { storeDir });
const auditRecords = async () =>
	(await readFile(join(storeDir, "audit.ndjson"), "utf8"))
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("/ultrathink-skills", () => {
	test("listing an empty store says there are no generated skills", async () => {
		expect(await run("")).toBe("No generated skills.");
		expect(await run("list")).toBe("No generated skills.");
	});

	test("listing shows a written generated skill with its status and version", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await run("list")).toBe(`${SKILL} · draft · v1`);
	});

	test("disable marks the skill disabled and the list shows it", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await run(`disable ${SKILL}`)).toBe(`disabled ${SKILL}`);
		expect(await run("list")).toBe(`${SKILL} · disabled · v1`);
	});

	test("delete removes the skill's directory and its entry", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await run(`delete ${SKILL}`)).toBe(`deleted ${SKILL}`);
		expect(existsSync(join(storeDir, SKILL))).toBe(false);
		expect(await run("list")).toBe("No generated skills.");
	});

	test("delete of a name the manifest does not list is refused with its reason", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await run("delete never-written")).toBe("not_found: no generated skill with that name");
		expect(await run("list")).toBe(`${SKILL} · draft · v1`);
	});

	test("an unknown subcommand, a missing name, or an enable or generate request returns the usage line", async () => {
		expect(await run("frobnicate")).toBe(USAGE);
		expect(await run("disable")).toBe(USAGE);
		expect(await run("delete a b")).toBe(USAGE);
		expect(await run(`enable ${SKILL}`)).toBe(USAGE);
		expect(await run(`generate ${SKILL}`)).toBe(USAGE);
	});

	test("promote makes a draft active, and its audit record names who confirmed it", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await promoteGeneratedSkill(storeDir, SKILL, { confirmedBy: "alice" })).toMatchObject({
			ok: true,
			changed: true,
			entry: { name: SKILL, status: "active" },
		});
		expect(await run("list")).toBe(`${SKILL} · active · v1`);
		expect(await readFile(join(storeDir, SKILL, "SKILL.md"), "utf8")).toContain("status: active\n");
		expect(await auditRecords()).toMatchObject([
			{ action: "create", name: SKILL },
			{ action: "promote", name: SKILL, confirmedBy: "alice" },
		]);
	});

	test("promoting an active skill succeeds, changes nothing and writes no record", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		await promoteGeneratedSkill(storeDir, SKILL, { confirmedBy: "alice" });
		const before = await auditRecords();

		expect(await promoteGeneratedSkill(storeDir, SKILL, { confirmedBy: "bob" })).toMatchObject({
			ok: true,
			changed: false,
			entry: { status: "active" },
		});
		expect(await auditRecords()).toEqual(before);
		expect(await run("list")).toBe(`${SKILL} · active · v1`);
	});

	test("a disabled skill is refused promotion with its reason and stays disabled", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		await run(`disable ${SKILL}`);

		expect(await promoteGeneratedSkill(storeDir, SKILL, { confirmedBy: "alice" })).toMatchObject({
			ok: false,
			reason: "wrong_status",
		});
		expect(await run("list")).toBe(`${SKILL} · disabled · v1`);
	});

	test("promoting a name the manifest does not list is refused with its reason", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(
			await promoteGeneratedSkill(storeDir, "never-written", { confirmedBy: "alice" }),
		).toMatchObject({ ok: false, reason: "not_found" });
		expect(await run("list")).toBe(`${SKILL} · draft · v1`);
	});

	test("promotion needs a non-blank confirmedBy name", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await promoteGeneratedSkill(storeDir, SKILL, { confirmedBy: "  " })).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(await run("list")).toBe(`${SKILL} · draft · v1`);
	});

	test("the general status setter refuses active, and the skill stays draft", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(await setGeneratedStatus(storeDir, SKILL, "active" as unknown as "draft")).toMatchObject(
			{
				ok: false,
				reason: "invalid_input",
			},
		);
		expect(await run("list")).toBe(`${SKILL} · draft · v1`);
	});

	test("regenerating an active skill writes it as draft, which needs a fresh promotion", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		await promoteGeneratedSkill(storeDir, SKILL, { confirmedBy: "alice" });

		const result = await writeGeneratedSkill(
			storeDir,
			skillFixture({ steps: ["Import the type."] }),
			NOW,
		);

		expect(result).toMatchObject({ ok: true, entry: { status: "draft", version: 2 } });
		expect(await readFile(join(storeDir, SKILL, "SKILL.md"), "utf8")).toContain("status: draft\n");
		expect(await run("list")).toBe(`${SKILL} · draft · v2`);
	});
});
