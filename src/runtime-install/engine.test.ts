// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { KeyedEdit } from "./edits.ts";
import {
	type EngineOptions,
	type InstallOptions,
	installRuntime,
	listRuntimes,
	uninstallRuntime,
} from "./engine.ts";
import { PLAN_SOURCE, put, REGISTRY, scratchTree } from "./test.fixtures.ts";

let scratch: string;
let home: string;
let clone: string;
let cwd: string;

beforeEach(() => {
	({ scratch, home, clone, cwd } = scratchTree());
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function options(overrides: Partial<InstallOptions> = {}): InstallOptions {
	return {
		runtimes: REGISTRY,
		cloneRoot: clone,
		home,
		cwd,
		env: {},
		scope: "global",
		runtime: "fx-skills",
		dryRun: false,
		...overrides,
	};
}

/** The items of a finished run; an unknown-runtime outcome fails the test. */
function done<T>(
	outcome:
		| { readonly kind: "unknown-runtime"; readonly message: string }
		| { readonly kind: "done"; readonly items: readonly T[] },
): readonly T[] {
	if (outcome.kind !== "done") throw new Error(outcome.message);
	return outcome.items;
}

async function install(overrides: Partial<InstallOptions> = {}) {
	return done(await installRuntime(options(overrides)));
}

async function uninstall(overrides: Partial<EngineOptions> = {}) {
	return done(await uninstallRuntime(options(overrides)));
}

/** Every path under `dir` (relative) with its text; directories map to "<dir>". */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(dir)) return out;
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const key = relative(dir, path);
			if (entry.isDirectory()) {
				out[key] = "<dir>";
				walk(path);
			} else if (entry.isSymbolicLink()) {
				out[key] = "<link>";
			} else {
				out[key] = readFileSync(path, "utf8");
			}
		}
	};
	walk(dir);
	return out;
}

interface ManifestView {
	readonly generation: number;
	readonly files: { path: string; sha256: string; original?: string }[];
	readonly edits: { kind: string; file: string; backup?: string }[];
	readonly dirs: string[];
}

function manifestOf(root: string): ManifestView {
	return JSON.parse(readFileSync(join(root, "ultrathink-runtime", "manifest.json"), "utf8"));
}

function summary(changes: readonly { action: string; path: string }[]): string[] {
	return changes.map((change) => `${change.action} ${change.path}`);
}

const SKILLS_ROOT = () => join(home, ".fx-skills");

describe("installRuntime", () => {
	test("writes the converted skills and a manifest and leaves other files alone", async () => {
		const root = SKILLS_ROOT();
		put(join(root, "skills/gsd-help/SKILL.md"), "gsd skill\n");
		put(join(root, "settings.json"), '{"theme":"dark"}\n');
		const before = snapshot(root);

		const [item] = await install();

		expect(item?.status).toBe("installed");
		expect(item?.configRoot).toBe(root);
		expect(summary(item?.changes ?? [])).toEqual([
			"write skills/ultrathink-plan/SKILL.md",
			"write skills/ultrathink-teach/SKILL.md",
		]);
		const plan = readFileSync(join(root, "skills/ultrathink-plan/SKILL.md"), "utf8");
		expect(plan).toStartWith("---\nname: ultrathink-plan\ndescription: Plan things.\n---\n");
		expect(plan).toContain('<!-- ultrathink-managed source="skills/ultrathink-plan/SKILL.md"');
		expect(plan).toEndWith("\n# Plan\n\nBody.\n");
		const after = snapshot(root);
		for (const [path, text] of Object.entries(before)) expect(after[path]).toBe(text);
		expect(
			Object.keys(after)
				.filter((path) => path.includes("ultrathink"))
				.sort(),
		).toEqual([
			"skills/ultrathink-plan",
			"skills/ultrathink-plan/SKILL.md",
			"skills/ultrathink-teach",
			"skills/ultrathink-teach/SKILL.md",
			"ultrathink-runtime",
			"ultrathink-runtime/.ultrathink-install.json",
			"ultrathink-runtime/manifest.json",
		]);
		const manifest = manifestOf(root);
		expect(manifest.files.map((file) => file.path)).toEqual([
			"skills/ultrathink-plan/SKILL.md",
			"skills/ultrathink-teach/SKILL.md",
		]);
		expect(manifest.edits).toEqual([]);
	});

	test("only ultrathink-* sources that have their file are installed", async () => {
		await install();
		expect(existsSync(join(SKILLS_ROOT(), "skills/other-skill"))).toBe(false);
		expect(existsSync(join(SKILLS_ROOT(), "skills/ultrathink-empty"))).toBe(false);
	});

	test("installing again is a no-op", async () => {
		await install();
		const before = snapshot(home);
		const [item] = await install();
		expect(item?.status).toBe("unchanged");
		expect(item?.changes).toEqual([]);
		expect(snapshot(home)).toEqual(before);
		expect(manifestOf(SKILLS_ROOT()).generation).toBe(1);
	});

	test("changed sources are written again and the manifest moves on", async () => {
		await install();
		put(join(clone, "skills/ultrathink-plan/SKILL.md"), PLAN_SOURCE.replace("Body.", "New body."));
		const [item] = await install();
		expect(item?.status).toBe("installed");
		expect(summary(item?.changes ?? [])).toEqual(["write skills/ultrathink-plan/SKILL.md"]);
		expect(readFileSync(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"), "utf8")).toContain(
			"New body.",
		);
		expect(manifestOf(SKILLS_ROOT()).generation).toBe(2);
	});

	test("a deleted installed file is repaired by the next install", async () => {
		await install();
		const file = join(SKILLS_ROOT(), "skills/ultrathink-teach/SKILL.md");
		rmSync(file);
		const [item] = await install();
		expect(item?.status).toBe("installed");
		expect(summary(item?.changes ?? [])).toEqual(["write skills/ultrathink-teach/SKILL.md"]);
		expect(existsSync(file)).toBe(true);
	});

	test("a file the user edited is backed up before it is replaced", async () => {
		await install();
		const file = join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md");
		writeFileSync(file, "my own edit\n");
		const [item] = await install();
		const backup = item?.changes.find((change) => change.action === "backup");
		expect(backup?.path).toMatch(
			/^ultrathink-backups\/[0-9a-f]{12}\/skills\/ultrathink-plan\/SKILL\.md$/,
		);
		expect(readFileSync(join(SKILLS_ROOT(), backup?.path ?? "missing"), "utf8")).toBe(
			"my own edit\n",
		);
		expect(readFileSync(file, "utf8")).toContain("ultrathink-managed");
	});

	test("backup copies are created owner-only (0600 file, 0700 dirs)", async () => {
		const file = join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md");
		put(file, "mine\n");
		chmodSync(file, 0o600);
		await install();
		const original = manifestOf(SKILLS_ROOT()).files[0]?.original ?? "missing";
		expect(statSync(join(SKILLS_ROOT(), original)).mode & 0o777).toBe(0o600);
		expect(statSync(join(SKILLS_ROOT(), "ultrathink-backups")).mode & 0o777).toBe(0o700);
	});

	test("an untracked file at a managed path is backed up, and uninstall puts it back", async () => {
		const file = join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md");
		put(file, "mine\n");
		const [item] = await install();
		expect(summary(item?.changes ?? [])).toEqual([
			expect.stringMatching(
				/^backup ultrathink-backups\/[0-9a-f]{12}\/skills\/ultrathink-plan\/SKILL\.md$/,
			),
			"write skills/ultrathink-plan/SKILL.md",
			"write skills/ultrathink-teach/SKILL.md",
		]);
		expect(manifestOf(SKILLS_ROOT()).files[0]?.original).toMatch(/^ultrathink-backups\//);

		const [removed] = await uninstall();
		expect(removed?.status).toBe("removed");
		expect(summary(removed?.changes ?? [])).toEqual([
			"restore skills/ultrathink-plan/SKILL.md",
			"remove skills/ultrathink-teach/SKILL.md",
		]);
		expect(readFileSync(file, "utf8")).toBe("mine\n");
		const leftovers = Object.keys(snapshot(SKILLS_ROOT())).filter(
			(path) => path.includes("ultrathink-") && !path.startsWith("skills/ultrathink-plan"),
		);
		expect(leftovers).toEqual([]);
	});

	test("an untracked file that carries the marker is replaced without a backup", async () => {
		put(
			join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"),
			'---\nname: x\n---\n<!-- ultrathink-managed source="old" -->\nold\n',
		);
		const [item] = await install();
		expect(item?.changes.some((change) => change.action === "backup")).toBe(false);
		expect(existsSync(join(SKILLS_ROOT(), "ultrathink-backups"))).toBe(false);
	});

	test("a skill removed from the clone is removed from the runtime", async () => {
		await install();
		rmSync(join(clone, "skills/ultrathink-teach"), { recursive: true });
		const [item] = await install();
		expect(summary(item?.changes ?? [])).toEqual(["remove skills/ultrathink-teach/SKILL.md"]);
		expect(existsSync(join(SKILLS_ROOT(), "skills/ultrathink-teach"))).toBe(false);
		expect(manifestOf(SKILLS_ROOT()).files.map((file) => file.path)).toEqual([
			"skills/ultrathink-plan/SKILL.md",
		]);
	});

	test("an install into an empty clone fails with nothing written", async () => {
		rmSync(join(clone, "skills"), { recursive: true });
		rmSync(join(clone, "commands"), { recursive: true });
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("no ultrathink sources");
		expect(snapshot(home)).toEqual({});
	});
});

describe("layouts", () => {
	test("skills+commands installs both surfaces", async () => {
		const [item] = await install({ runtime: "fx-both" });
		expect(item?.status).toBe("installed");
		expect(summary(item?.changes ?? [])).toEqual([
			"write commands/ultrathink-off.md",
			"write commands/ultrathink-on.md",
			"write skills/ultrathink-plan/SKILL.md",
			"write skills/ultrathink-teach/SKILL.md",
		]);
	});

	test("a TOML commands layout wraps commands and skills in prompt files", async () => {
		await install({ runtime: "fx-toml" });
		const root = join(home, ".fx-toml");
		expect(readdirSync(join(root, "prompts")).sort()).toEqual([
			"ultrathink-off.toml",
			"ultrathink-on.toml",
			"ultrathink-plan.toml",
			"ultrathink-teach.toml",
		]);
		const off = readFileSync(join(root, "prompts/ultrathink-off.toml"), "utf8");
		expect(off).toContain('description = "Turn it off"');
		expect(off).toContain("prompt = '''Run off $ARGUMENTS\n'''");
	});

	test("a workspace-only workflows layout installs below the workspace with --local", async () => {
		const [item] = await install({ runtime: "fx-wf", scope: "local" });
		expect(item?.status).toBe("installed");
		expect(item?.configRoot).toBe(join(cwd, ".fx-wf"));
		expect(readdirSync(join(cwd, ".fx-wf/workflows")).sort()).toEqual([
			"ultrathink-off.md",
			"ultrathink-on.md",
			"ultrathink-plan.md",
			"ultrathink-teach.md",
		]);
		expect(existsSync(join(home, ".fx-wf"))).toBe(false);
	});

	test("the env var of a runtime moves its config root", async () => {
		const elsewhere = join(scratch, "elsewhere");
		const [item] = await install({ runtime: "fx-global", env: { FX_GLOBAL_DIR: elsewhere } });
		expect(item?.configRoot).toBe(elsewhere);
		expect(existsSync(join(elsewhere, "skills/ultrathink-plan/SKILL.md"))).toBe(true);
		expect(existsSync(join(home, ".fx-global"))).toBe(false);
	});
});

describe("selection", () => {
	test("an unknown runtime is an error for every command", async () => {
		for (const run of [installRuntime, uninstallRuntime, listRuntimes]) {
			const outcome = await run(options({ runtime: "nope" }));
			expect(outcome.kind).toBe("unknown-runtime");
			if (outcome.kind === "unknown-runtime") {
				expect(outcome.message).toContain('unknown runtime "nope"');
				expect(outcome.message).toContain("fx-skills, fx-both, fx-toml, fx-wf, fx-global");
			}
		}
		expect(snapshot(home)).toEqual({});
	});

	test("all installs only where the config root already exists", async () => {
		mkdirSync(join(home, ".fx-both"));
		const items = await install({ runtime: "all" });
		const byId = Object.fromEntries(items.map((item) => [item.runtime, item]));
		expect(byId["fx-both"]?.status).toBe("installed");
		expect(byId["fx-skills"]?.status).toBe("skipped");
		expect(byId["fx-skills"]?.notes[0]).toContain("not detected");
		expect(byId["fx-wf"]?.status).toBe("skipped");
		expect(byId["fx-wf"]?.notes[0]).toContain("workspace only");
		expect(existsSync(join(home, ".fx-skills"))).toBe(false);
		expect(existsSync(join(home, ".fx-toml"))).toBe(false);
	});

	test("a scope the runtime does not support fails when it was asked for by id", async () => {
		const [global] = await install({ runtime: "fx-wf", scope: "global" });
		expect(global?.status).toBe("failed");
		expect(global?.notes[0]).toContain("workspace only");
		const [local] = await install({ runtime: "fx-global", scope: "local" });
		expect(local?.status).toBe("failed");
		expect(local?.notes[0]).toContain("globally only");
	});

	test("uninstall all reports runtimes that were never installed", async () => {
		await install();
		const items = await uninstall({ runtime: "all" });
		const byId = Object.fromEntries(items.map((item) => [item.runtime, item.status]));
		expect(byId).toEqual({
			"fx-skills": "removed",
			"fx-both": "not-installed",
			"fx-toml": "not-installed",
			"fx-wf": "skipped",
			"fx-global": "not-installed",
		});
	});
});

describe("uninstall", () => {
	test("removes exactly what install wrote, including directories it created", async () => {
		await install();
		expect(existsSync(SKILLS_ROOT())).toBe(true);
		const [item] = await uninstall();
		expect(item?.status).toBe("removed");
		expect(existsSync(SKILLS_ROOT())).toBe(false);
		expect(snapshot(home)).toEqual({});
	});

	test("leaves a config root and the files in it as they were", async () => {
		const root = SKILLS_ROOT();
		put(join(root, "skills/gsd-help/SKILL.md"), "gsd skill\n");
		put(join(root, "settings.json"), "{}\n");
		const before = snapshot(root);
		await install();
		await uninstall();
		expect(snapshot(root)).toEqual(before);
	});

	test("a file the user edited is saved to the backup store before it is removed", async () => {
		await install();
		const file = join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md");
		writeFileSync(file, "my notes\n");
		const [item] = await uninstall();
		const backup = item?.changes.find((change) => change.action === "backup");
		expect(readFileSync(join(SKILLS_ROOT(), backup?.path ?? "missing"), "utf8")).toBe("my notes\n");
		expect(existsSync(file)).toBe(false);
		expect(existsSync(join(SKILLS_ROOT(), "ultrathink-runtime"))).toBe(false);
	});

	test("without a manifest there is nothing to do", async () => {
		mkdirSync(SKILLS_ROOT(), { recursive: true });
		put(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"), "not tracked\n");
		const [item] = await uninstall();
		expect(item?.status).toBe("not-installed");
		expect(readFileSync(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"), "utf8")).toBe(
			"not tracked\n",
		);
	});

	test("never touches a path the manifest does not list", async () => {
		await install();
		put(join(SKILLS_ROOT(), "skills/ultrathink-mine/SKILL.md"), "user skill with our prefix\n");
		await uninstall();
		expect(readFileSync(join(SKILLS_ROOT(), "skills/ultrathink-mine/SKILL.md"), "utf8")).toBe(
			"user skill with our prefix\n",
		);
	});
});

describe("dry run", () => {
	test("install writes nothing, not even the config root", async () => {
		const [item] = await install({ dryRun: true });
		expect(item?.status).toBe("would-install");
		expect(summary(item?.changes ?? [])).toEqual([
			"write skills/ultrathink-plan/SKILL.md",
			"write skills/ultrathink-teach/SKILL.md",
		]);
		expect(snapshot(home)).toEqual({});
	});

	test("install over a conflict reports the backup and still writes nothing", async () => {
		put(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"), "mine\n");
		const before = snapshot(home);
		const [item] = await install({ dryRun: true });
		expect(item?.changes.some((change) => change.action === "backup")).toBe(true);
		expect(snapshot(home)).toEqual(before);
	});

	test("uninstall leaves the install in place", async () => {
		await install();
		const before = snapshot(home);
		const [item] = await uninstall({ dryRun: true });
		expect(item?.status).toBe("would-remove");
		expect(summary(item?.changes ?? [])).toEqual([
			"remove skills/ultrathink-plan/SKILL.md",
			"remove skills/ultrathink-teach/SKILL.md",
		]);
		expect(snapshot(home)).toEqual(before);
	});
});

describe("refusals and rollback", () => {
	test("a symbolic link at a managed path is never written through", async () => {
		const precious = join(scratch, "precious");
		put(join(precious, "SKILL.md"), "precious\n");
		mkdirSync(join(SKILLS_ROOT(), "skills"), { recursive: true });
		symlinkSync(precious, join(SKILLS_ROOT(), "skills/ultrathink-plan"));
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("symbolic link");
		expect(readFileSync(join(precious, "SKILL.md"), "utf8")).toBe("precious\n");
		expect(existsSync(join(SKILLS_ROOT(), "skills/ultrathink-teach"))).toBe(false);
		expect(existsSync(join(SKILLS_ROOT(), "ultrathink-runtime"))).toBe(false);
	});

	test("a failure while writing reverts the files already written", async () => {
		// A regular file where the second skill's directory must go: mkdir fails after the first skill was written.
		put(join(SKILLS_ROOT(), "skills/ultrathink-teach"), "in the way\n");
		const before = snapshot(SKILLS_ROOT());
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(snapshot(SKILLS_ROOT())).toEqual(before);
	});

	test("a rollback also takes back the backup copies it made", async () => {
		put(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"), "mine\n");
		put(join(SKILLS_ROOT(), "skills/ultrathink-teach"), "in the way\n");
		const before = snapshot(SKILLS_ROOT());
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(snapshot(SKILLS_ROOT())).toEqual(before);
	});

	test("a symbolic link at the backup store is refused and nothing is written through it", async () => {
		const outside = join(scratch, "outside");
		mkdirSync(outside);
		const file = join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md");
		put(file, "mine\n");
		symlinkSync(outside, join(SKILLS_ROOT(), "ultrathink-backups"));
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("refusing to write through it");
		expect(readdirSync(outside)).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("mine\n");
	});

	test("a managed file over 16 MiB is refused without being read", async () => {
		const file = join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md");
		put(file, "");
		truncateSync(file, 16 * 1024 * 1024 + 1);
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("is larger than 16 MiB");
		expect(statSync(file).size).toBe(16 * 1024 * 1024 + 1);
	});

	test("a config root that is a file makes the install fail and is left alone", async () => {
		put(join(home, ".fx-skills"), "a file where the root should be\n");
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(readFileSync(join(home, ".fx-skills"), "utf8")).toBe(
			"a file where the root should be\n",
		);
	});

	test("a foreign file named like the manifest directory is refused", async () => {
		put(join(SKILLS_ROOT(), "ultrathink-runtime"), "a file\n");
		const [item] = await install();
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("not a directory");
		expect(readFileSync(join(SKILLS_ROOT(), "ultrathink-runtime"), "utf8")).toBe("a file\n");
	});

	test("a corrupt manifest stops install and uninstall without touching anything", async () => {
		await install();
		writeFileSync(join(SKILLS_ROOT(), "ultrathink-runtime/manifest.json"), "{not json");
		const before = snapshot(home);
		for (const item of [...(await install()), ...(await uninstall())]) {
			expect(item.status).toBe("failed");
			expect(item.notes.join(" ")).toContain("not a valid install manifest");
		}
		expect(snapshot(home)).toEqual(before);
	});

	test("a manifest that names a path outside the config root is rejected", async () => {
		await install();
		const victim = join(scratch, "victim.txt");
		writeFileSync(victim, "keep\n");
		const path = join(SKILLS_ROOT(), "ultrathink-runtime/manifest.json");
		const manifest = JSON.parse(readFileSync(path, "utf8"));
		manifest.files.push({ path: "../../../victim-ultrathink-x", sha256: "0".repeat(64) });
		writeFileSync(path, JSON.stringify(manifest));
		const [item] = await uninstall();
		expect(item?.status).toBe("failed");
		expect(readFileSync(victim, "utf8")).toBe("keep\n");
		expect(existsSync(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"))).toBe(true);
	});

	test("a manifest of another runtime is rejected", async () => {
		await install();
		const path = join(SKILLS_ROOT(), "ultrathink-runtime/manifest.json");
		writeFileSync(path, readFileSync(path, "utf8").replace('"fx-skills"', '"fx-both"'));
		const [item] = await uninstall();
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain('belongs to runtime "fx-both"');
	});
});

describe("keyed edits", () => {
	const settings = `${JSON.stringify({ theme: "dark", hooks: { gsd: { command: "gsd" } } }, null, 2)}\n`;
	const edits: KeyedEdit[] = [
		{ kind: "json", file: "settings.json", key: ["hooks", "ultrathink"], value: { command: "ut" } },
		{ kind: "block", file: "config.toml", id: "hooks", body: '[[hooks]]\ncommand = "ut"' },
	];

	test("are applied with a backup, recorded, and undone exactly by uninstall", async () => {
		const root = SKILLS_ROOT();
		put(join(root, "settings.json"), settings);

		const [item] = await install({ edits });
		expect(item?.status).toBe("installed");
		expect(summary(item?.changes ?? [])).toEqual(
			expect.arrayContaining([
				"edit config.toml",
				"edit settings.json",
				expect.stringMatching(/^backup ultrathink-backups\/[0-9a-f]{12}\/settings\.json$/),
			]),
		);
		expect(JSON.parse(readFileSync(join(root, "settings.json"), "utf8"))).toEqual({
			theme: "dark",
			hooks: { gsd: { command: "gsd" }, ultrathink: { command: "ut" } },
		});
		expect(readFileSync(join(root, "config.toml"), "utf8")).toBe(
			'# BEGIN ultrathink-managed:hooks\n[[hooks]]\ncommand = "ut"\n# END ultrathink-managed:hooks\n',
		);
		const manifest = manifestOf(root);
		expect(manifest.edits.map((edit) => `${edit.kind} ${edit.file}`)).toEqual([
			"block config.toml",
			"json settings.json",
		]);
		const backups = manifest.edits.map((edit) => edit.backup).filter((path) => path !== undefined);
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(root, backups[0] ?? "missing"), "utf8")).toBe(settings);

		const [again] = await install({ edits });
		expect(again?.status).toBe("unchanged");

		const [removed] = await uninstall();
		expect(removed?.status).toBe("removed");
		expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(settings);
		expect(existsSync(join(root, "config.toml"))).toBe(false);
		expect(Object.keys(snapshot(root)).filter((path) => path.includes("ultrathink"))).toEqual([]);
	});

	test("place replaces a config through a temp file, keeps its mode, and leaves no temp file", async () => {
		const root = SKILLS_ROOT();
		const file = join(root, "settings.json");
		put(file, settings);
		chmodSync(file, 0o640);
		const inode = statSync(file).ino;
		await install({ edits: [edits[0] as KeyedEdit] });
		expect(statSync(file).ino).not.toBe(inode);
		expect(statSync(file).mode & 0o777).toBe(0o640);
		expect(Object.keys(snapshot(root)).filter((path) => path.endsWith(".tmp"))).toEqual([]);
	});

	test("an install that passes no edits leaves recorded ones alone, an empty list removes them", async () => {
		const root = SKILLS_ROOT();
		put(join(root, "settings.json"), settings);
		await install({ edits });
		const [kept] = await install();
		expect(kept?.status).toBe("unchanged");
		expect(readFileSync(join(root, "config.toml"), "utf8")).toContain(
			"BEGIN ultrathink-managed:hooks",
		);

		const [cleared] = await install({ edits: [] });
		expect(cleared?.status).toBe("installed");
		expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(settings);
		expect(existsSync(join(root, "config.toml"))).toBe(false);
		expect(manifestOf(root).edits).toEqual([]);
	});

	test("an edit the user changed is left in place and reported on uninstall", async () => {
		const root = SKILLS_ROOT();
		put(join(root, "settings.json"), settings);
		await install({ edits: [edits[0] as KeyedEdit] });
		const file = join(root, "settings.json");
		const changed = readFileSync(file, "utf8").replace('"ut"', '"mine"');
		writeFileSync(file, changed);

		const [item] = await uninstall();
		expect(item?.status).toBe("removed");
		expect(item?.notes.join(" ")).toContain(
			"kept the edit of key hooks.ultrathink in settings.json",
		);
		expect(readFileSync(file, "utf8")).toBe(changed);
	});

	test("a config file that is not plain JSON is refused and nothing is written", async () => {
		const root = SKILLS_ROOT();
		put(join(root, "settings.json"), "// comment\n{}\n");
		const before = snapshot(root);
		const [item] = await install({ edits });
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("not plain JSON");
		expect(snapshot(root)).toEqual(before);
	});

	test("an edit path outside the config root is refused", async () => {
		const [item] = await install({
			edits: [{ kind: "block", file: "../escape.toml", id: "x", body: "x" }],
		});
		expect(item?.status).toBe("failed");
		expect(item?.notes.join(" ")).toContain("inside the config root");
		expect(existsSync(join(home, "escape.toml"))).toBe(false);
	});
});

describe("listRuntimes", () => {
	test("reports detection, install state and drift", async () => {
		mkdirSync(join(home, ".fx-both"));
		await install();
		rmSync(join(SKILLS_ROOT(), "skills/ultrathink-teach/SKILL.md"));
		writeFileSync(join(SKILLS_ROOT(), "skills/ultrathink-plan/SKILL.md"), "edited\n");

		const items = done(await listRuntimes(options({ runtime: "all" })));
		const byId = Object.fromEntries(items.map((item) => [item.runtime, item]));
		expect(byId["fx-skills"]).toMatchObject({
			configRoot: SKILLS_ROOT(),
			detected: true,
			installed: true,
			files: 2,
			missing: 1,
			modified: 1,
		});
		expect(byId["fx-both"]).toMatchObject({ detected: true, installed: false, files: 0 });
		expect(byId["fx-toml"]).toMatchObject({ detected: false, installed: false });
		expect(byId["fx-wf"]).toMatchObject({ configRoot: undefined, installed: false });
		expect(byId["fx-wf"]?.note).toContain("workspace only");
		expect(byId["fx-wf"]?.scopeSupport).toBe("workspace");
	});

	test("reports an unreadable manifest as a note", async () => {
		await install();
		writeFileSync(join(SKILLS_ROOT(), "ultrathink-runtime/manifest.json"), "nope");
		const [item] = done(await listRuntimes(options()));
		expect(item?.installed).toBe(false);
		expect(item?.note).toContain("not a valid install manifest");
	});
});
