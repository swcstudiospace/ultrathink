// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AutoSkill, contentHashOf } from "./skill-author.ts";
import {
	listGenerated,
	removeGeneratedSkill,
	setGeneratedStatus,
	writeGeneratedSkill,
} from "./skill-store.ts";

const NOW = "2026-11-17T10:00:00.000Z";
const LATER = "2026-11-18T10:00:00.000Z";
const SKILL = "tsc-value-import-of-types";

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
	root = await mkdtemp(join(tmpdir(), "skill-store-test-"));
	storeDir = join(root, "store");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function skillMd(name: string): Promise<string> {
	return readFile(join(storeDir, name, "SKILL.md"), "utf8");
}

async function manifestSkills(): Promise<Array<Record<string, unknown>>> {
	const raw: { skills: Array<Record<string, unknown>> } = JSON.parse(
		await readFile(join(storeDir, "manifest.json"), "utf8"),
	);
	return raw.skills;
}

describe("generated skill store", () => {
	test("writing a skill creates SKILL.md and a manifest entry carrying the generated marker", async () => {
		const skill = skillFixture();
		const result = await writeGeneratedSkill(storeDir, skill, NOW);

		expect(result).toEqual({
			ok: true,
			action: "created",
			audit: { ok: true },
			entry: {
				name: SKILL,
				status: "draft",
				generated_by: "auto",
				version: 1,
				content_hash: skill.content_hash,
				generated_at: NOW,
				source_ids: ["moment-1"],
				stale: false,
				description: skill.description,
				applies_when: skill.applies_when,
				signature_hash: skill.signature_hash,
			},
		});
		const text = await skillMd(SKILL);
		expect(text).toContain(`name: ${SKILL}\n`);
		expect(text).toContain("generated_by: auto\n");
		expect(text).toContain("1. Change the import to import type");
		expect(await manifestSkills()).toMatchObject([
			{ name: SKILL, generated_by: "auto", version: 1 },
		]);
	});

	test("a second write of the same name replaces the skill and bumps its version", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		const revised = skillFixture({ steps: ["Import the type with import type."] });

		const result = await writeGeneratedSkill(storeDir, revised, LATER);

		expect(result).toMatchObject({
			ok: true,
			entry: { version: 2, content_hash: revised.content_hash, generated_at: LATER },
		});
		const text = await skillMd(SKILL);
		expect(text).toContain("version: 2\n");
		expect(text).toContain("1. Import the type with import type.");
		expect(text).not.toContain("Change the import");
	});

	test("a regenerated skill keeps the status a user set", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		await setGeneratedStatus(storeDir, SKILL, "disabled");

		const result = await writeGeneratedSkill(
			storeDir,
			skillFixture({ steps: ["Import the type."] }),
			LATER,
		);

		expect(result).toMatchObject({ ok: true, entry: { status: "disabled", version: 2 } });
		expect(await skillMd(SKILL)).toContain("status: disabled\n");
	});

	test("a schema 2 manifest with an active entry loads, and the entry keeps status active", async () => {
		await mkdir(storeDir, { recursive: true });
		await writeFile(
			join(storeDir, "manifest.json"),
			JSON.stringify({
				schema: 2,
				skills: [
					{
						name: SKILL,
						status: "active",
						generated_by: "auto",
						version: 1,
						content_hash: "a".repeat(64),
						generated_at: NOW,
						source_ids: ["moment-1"],
						stale: false,
						description: "Use import type for type-only imports.",
						applies_when: {
							task_types: ["typescript-build"],
							scope_globs: ["src/**"],
							error_signatures: ["tsc rejects value imports of types"],
						},
						signature_hash: "0123456789abcdef0123456789abcdef",
					},
				],
			}),
		);

		expect(await listGenerated(storeDir)).toMatchObject({
			ok: true,
			entries: [{ name: SKILL, status: "active" }],
		});
	});

	test("a user-authored directory is never overwritten or removed", async () => {
		const dir = join(storeDir, "hand-written");
		await mkdir(dir, { recursive: true });
		const original = "---\nname: hand-written\n---\nMine.\n";
		await writeFile(join(dir, "SKILL.md"), original);

		expect(
			await writeGeneratedSkill(storeDir, skillFixture({ name: "hand-written" }), NOW),
		).toMatchObject({
			ok: false,
			reason: "user_authored",
		});
		expect(await removeGeneratedSkill(storeDir, "hand-written")).toMatchObject({
			ok: false,
			reason: "user_authored",
		});
		expect(await setGeneratedStatus(storeDir, "hand-written", "disabled")).toMatchObject({
			ok: false,
			reason: "user_authored",
		});
		expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(original);
	});

	test.each(["../escape", "nested/skill", "nested\\skill", "..", "."])(
		"the name %p is rejected and nothing is written",
		async (name) => {
			expect(await writeGeneratedSkill(storeDir, skillFixture({ name }), NOW)).toMatchObject({
				ok: false,
				reason: "invalid_name",
			});
			expect(await removeGeneratedSkill(storeDir, name)).toMatchObject({
				ok: false,
				reason: "invalid_name",
			});
			expect(await setGeneratedStatus(storeDir, name, "disabled")).toMatchObject({
				ok: false,
				reason: "invalid_name",
			});
			expect(await readdir(root)).toEqual([]);
		},
	);

	test("a status change persists to the manifest and to the frontmatter", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		const result = await setGeneratedStatus(storeDir, SKILL, "disabled");

		expect(result).toMatchObject({ ok: true, entry: { status: "disabled", version: 1 } });
		expect(await manifestSkills()).toMatchObject([{ name: SKILL, status: "disabled" }]);
		const text = await skillMd(SKILL);
		expect(text).toContain("status: disabled\n");
		expect(text).not.toContain("status: draft");
		expect(text).toContain("1. Change the import to import type");
	});

	test("a SKILL.md without a status line is reported and the manifest is left unchanged", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		const withoutStatus = (await skillMd(SKILL)).replace(/^status: draft\n/m, "");
		await writeFile(join(storeDir, SKILL, "SKILL.md"), withoutStatus);

		expect(await setGeneratedStatus(storeDir, SKILL, "disabled")).toMatchObject({
			ok: false,
			reason: "skill_corrupt",
		});
		expect(await manifestSkills()).toMatchObject([{ name: SKILL, status: "draft" }]);
	});

	test("removal deletes only the named generated skill", async () => {
		await writeGeneratedSkill(storeDir, skillFixture({ name: "first-skill" }), NOW);
		await writeGeneratedSkill(storeDir, skillFixture({ name: "second-skill" }), NOW);

		expect(await removeGeneratedSkill(storeDir, "first-skill")).toEqual({
			ok: true,
			name: "first-skill",
			audit: { ok: true },
		});

		expect(existsSync(join(storeDir, "first-skill"))).toBe(false);
		expect(existsSync(join(storeDir, "second-skill", "SKILL.md"))).toBe(true);
		expect(await listGenerated(storeDir)).toMatchObject({
			ok: true,
			entries: [{ name: "second-skill" }],
		});
	});

	test("removal refuses a generated directory that holds a file the store did not write", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		await writeFile(join(storeDir, SKILL, "notes.md"), "mine");

		expect(await removeGeneratedSkill(storeDir, SKILL)).toMatchObject({
			ok: false,
			reason: "user_authored",
		});

		expect(existsSync(join(storeDir, SKILL, "SKILL.md"))).toBe(true);
		expect(existsSync(join(storeDir, SKILL, "notes.md"))).toBe(true);
		expect(await listGenerated(storeDir)).toMatchObject({ ok: true, entries: [{ name: SKILL }] });
	});

	test("a corrupt manifest is a typed error and is left unchanged", async () => {
		await mkdir(storeDir, { recursive: true });
		const corrupt = '{"schema": 1, "skills": [';
		await writeFile(join(storeDir, "manifest.json"), corrupt);

		expect(await writeGeneratedSkill(storeDir, skillFixture(), NOW)).toMatchObject({
			ok: false,
			reason: "manifest_corrupt",
		});
		expect(await setGeneratedStatus(storeDir, SKILL, "disabled")).toMatchObject({
			ok: false,
			reason: "manifest_corrupt",
		});
		expect(await removeGeneratedSkill(storeDir, SKILL)).toMatchObject({
			ok: false,
			reason: "manifest_corrupt",
		});
		expect(await listGenerated(storeDir)).toMatchObject({ ok: false, reason: "manifest_corrupt" });
		expect(await readFile(join(storeDir, "manifest.json"), "utf8")).toBe(corrupt);
		expect(existsSync(join(storeDir, SKILL))).toBe(false);
	});

	test("a missing manifest lists as empty", async () => {
		expect(await listGenerated(storeDir)).toEqual({ ok: true, entries: [] });
	});

	test("a description spanning lines is rejected before anything is written", async () => {
		const skill = skillFixture({ description: "Use import type.\nstatus: disabled" });

		expect(await writeGeneratedSkill(storeDir, skill, NOW)).toMatchObject({
			ok: false,
			reason: "invalid_input",
		});
		expect(existsSync(storeDir)).toBe(false);
	});

	test("no temporary file remains after a successful write", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		await writeGeneratedSkill(
			storeDir,
			skillFixture({ steps: ["Import the type with import type."] }),
			LATER,
		);
		await setGeneratedStatus(storeDir, SKILL, "disabled");

		expect((await readdir(storeDir)).sort()).toEqual(["audit.ndjson", "manifest.json", SKILL]);
		expect(await readdir(join(storeDir, SKILL))).toEqual(["SKILL.md"]);
	});

	async function auditLines(): Promise<Array<Record<string, unknown>>> {
		const text = await readFile(join(storeDir, "audit.ndjson"), "utf8");
		return text
			.split("\n")
			.filter((line) => line !== "")
			.map((line): Record<string, unknown> => JSON.parse(line));
	}

	test("a schema 2 entry round-trips with its description, applies_when and signature hash", async () => {
		const skill = skillFixture();
		await writeGeneratedSkill(storeDir, skill, NOW);

		expect(JSON.parse(await readFile(join(storeDir, "manifest.json"), "utf8"))).toMatchObject({
			schema: 2,
		});
		expect(await listGenerated(storeDir)).toEqual({
			ok: true,
			entries: [
				{
					name: SKILL,
					status: "draft",
					generated_by: "auto",
					version: 1,
					content_hash: skill.content_hash,
					generated_at: NOW,
					source_ids: ["moment-1"],
					stale: false,
					description: skill.description,
					applies_when: skill.applies_when,
					signature_hash: skill.signature_hash,
				},
			],
		});
	});

	test("a schema 2 entry missing its applies_when is a corrupt manifest, left unchanged", async () => {
		await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		const path = join(storeDir, "manifest.json");
		const manifest = JSON.parse(await readFile(path, "utf8"));
		delete manifest.skills[0].applies_when;
		const edited = JSON.stringify(manifest);
		await writeFile(path, edited);

		expect(await listGenerated(storeDir)).toMatchObject({ ok: false, reason: "manifest_corrupt" });
		expect(
			await writeGeneratedSkill(
				storeDir,
				skillFixture({ steps: ["Import the type with import type."] }),
				LATER,
			),
		).toMatchObject({ ok: false, reason: "manifest_corrupt" });
		expect(await readFile(path, "utf8")).toBe(edited);
	});

	test("a schema 1 manifest is rejected with a clear error and is never replaced", async () => {
		await mkdir(storeDir, { recursive: true });
		const schema1 = JSON.stringify({ schema: 1, skills: [] });
		await writeFile(join(storeDir, "manifest.json"), schema1);

		expect(await listGenerated(storeDir)).toEqual({
			ok: false,
			reason: "manifest_corrupt",
			detail: "manifest.json is schema 1; expected schema 2",
		});
		expect(await writeGeneratedSkill(storeDir, skillFixture(), NOW)).toMatchObject({
			ok: false,
			reason: "manifest_corrupt",
		});
		expect(await readFile(join(storeDir, "manifest.json"), "utf8")).toBe(schema1);
	});

	test("each create, update, disable and delete appends exactly one audit line", async () => {
		const created = await writeGeneratedSkill(storeDir, skillFixture(), NOW);
		expect(created).toMatchObject({ ok: true, action: "created", audit: { ok: true } });
		expect(await auditLines()).toMatchObject([{ action: "create", name: SKILL, version: 1 }]);

		const revised = skillFixture({ steps: ["Import the type with import type."] });
		const updated = await writeGeneratedSkill(storeDir, revised, LATER);
		expect(updated).toMatchObject({ ok: true, action: "updated", audit: { ok: true } });
		expect(await auditLines()).toMatchObject([
			{ action: "create" },
			{ action: "update", name: SKILL, version: 2, content_hash: revised.content_hash },
		]);

		expect(await setGeneratedStatus(storeDir, SKILL, "disabled")).toMatchObject({
			ok: true,
			audit: { ok: true },
		});
		expect(await removeGeneratedSkill(storeDir, SKILL)).toMatchObject({
			ok: true,
			audit: { ok: true },
		});
		expect(await auditLines()).toMatchObject([
			{ action: "create" },
			{ action: "update" },
			{ action: "disable", name: SKILL, version: 2 },
			{ action: "delete", name: SKILL, version: 2 },
		]);
	});

	test("no audit line carries the skill text", async () => {
		const skill = skillFixture({ steps: ["Import the type with import type."] });
		await writeGeneratedSkill(storeDir, skill, NOW, { qualification_by: "recurrence" });
		await setGeneratedStatus(storeDir, SKILL, "disabled");
		await removeGeneratedSkill(storeDir, SKILL);

		const text = await readFile(join(storeDir, "audit.ndjson"), "utf8");
		expect(text).not.toContain("Import the type with import type.");
		expect(text).not.toContain(skill.description);
		expect(text).not.toContain("tsc rejects value imports of types");
		expect(await auditLines()).toMatchObject([
			{ action: "create", qualification_by: "recurrence" },
			{ action: "disable" },
			{ action: "delete" },
		]);
	});

	test("a failed audit append is reported and the written skill stays in place", async () => {
		await mkdir(join(storeDir, "audit.ndjson"), { recursive: true });

		const result = await writeGeneratedSkill(storeDir, skillFixture(), NOW);

		expect(result).toMatchObject({
			ok: true,
			action: "created",
			audit: { ok: false, detail: "EISDIR" },
		});
		expect(await skillMd(SKILL)).toContain(`name: ${SKILL}\n`);
		expect(await listGenerated(storeDir)).toMatchObject({
			ok: true,
			entries: [{ name: SKILL, version: 1 }],
		});
	});
});
