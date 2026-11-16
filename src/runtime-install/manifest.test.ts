// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	isBackupPath,
	isManagedPath,
	isSafeRelative,
	parseManifest,
	serializeManifest,
} from "./manifest.ts";

const SHA = "a".repeat(64);

/** A manifest as plain JSON, loose enough for the tests to break it on purpose. */
interface Draft {
	schema: number;
	runtime: string;
	scope: string;
	cloneRoot: string;
	generation: number;
	files: { path: string; sha256: string; original?: string }[];
	edits: Record<string, unknown>[];
	dirs: string[];
}

function valid(): Draft {
	return {
		schema: 1,
		runtime: "codex",
		scope: "global",
		cloneRoot: "/src/ultrathink",
		generation: 2,
		files: [
			{
				path: "skills/ultrathink-plan/SKILL.md",
				sha256: SHA,
				original: "ultrathink-backups/0123456789ab/skills/ultrathink-plan/SKILL.md",
			},
			{ path: "commands/ultrathink-off.md", sha256: SHA },
		],
		edits: [
			{
				kind: "json",
				file: "settings.json",
				key: ["hooks", "ultrathink"],
				value: { command: "ut" },
				previous: null,
				existing: 1,
				createdFile: false,
				backup: "ultrathink-backups/0123456789ab/settings.json",
			},
			{ kind: "block", file: "config.toml", id: "hooks", createdFile: true },
		],
		dirs: [".", "skills"],
	};
}

/** The text of a valid manifest after `change` ran on a fresh draft. */
function mutated(change: (draft: Draft) => void): string {
	const draft = valid();
	change(draft);
	return JSON.stringify(draft);
}

describe("parseManifest and serializeManifest", () => {
	test("round-trip a manifest, with the same bytes on every pass", () => {
		const parsed = parseManifest(JSON.stringify(valid()), "m");
		expect(JSON.parse(serializeManifest(parsed))).toEqual(valid());
		const text = serializeManifest(parsed);
		expect(serializeManifest(parseManifest(text, "m"))).toBe(text);
	});

	test("serialization does not depend on the order keys were built in", () => {
		const first = parseManifest(JSON.stringify(valid()), "m");
		const shuffled = {
			dirs: [".", "skills"],
			edits: valid().edits.map((edit) => Object.fromEntries(Object.entries(edit).reverse())),
			files: valid().files.map((file) => Object.fromEntries(Object.entries(file).reverse())),
			generation: 2,
			cloneRoot: "/src/ultrathink",
			scope: "global",
			runtime: "codex",
			schema: 1,
		};
		expect(serializeManifest(parseManifest(JSON.stringify(shuffled), "m"))).toBe(
			serializeManifest(first),
		);
	});

	test("reject what it cannot trust", () => {
		const bad: Record<string, string> = {
			"not json": "{nope",
			"another schema": mutated((draft) => {
				draft.schema = 2;
			}),
			"a bad header": mutated((draft) => {
				draft.generation = 1.5;
			}),
			"a bad scope": mutated((draft) => {
				draft.scope = "everywhere";
			}),
			"a path above the root": mutated((draft) => {
				draft.files[1] = { path: "../ultrathink-x", sha256: SHA };
			}),
			"an absolute path": mutated((draft) => {
				draft.files[1] = { path: "/etc/ultrathink-x", sha256: SHA };
			}),
			"a path that is not the installer's": mutated((draft) => {
				draft.files[1] = { path: "skills/other/SKILL.md", sha256: SHA };
			}),
			"a bad hash": mutated((draft) => {
				draft.files[1] = { path: "commands/ultrathink-off.md", sha256: "xyz" };
			}),
			"a backup outside the store": mutated((draft) => {
				draft.files[0] = {
					path: "skills/ultrathink-plan/SKILL.md",
					sha256: SHA,
					original: "skills/x",
				};
			}),
			"an edit outside the root": mutated((draft) => {
				draft.edits[1] = { kind: "block", file: "../c.toml", id: "x", createdFile: true };
			}),
			"an unknown edit kind": mutated((draft) => {
				draft.edits[1] = { kind: "xml", file: "c.xml", createdFile: true };
			}),
			"a json edit without a key": mutated((draft) => {
				draft.edits[0] = { ...draft.edits[0], key: [] };
			}),
			"a json edit with an impossible depth": mutated((draft) => {
				draft.edits[0] = { ...draft.edits[0], existing: 3 };
			}),
			"a directory above the root": mutated((draft) => {
				draft.dirs = ["..", "skills"];
			}),
			"a list that is not a list": JSON.stringify({ ...valid(), files: "none" }),
		};
		for (const [name, text] of Object.entries(bad)) {
			expect(() => parseManifest(text, "manifest.json"), name).toThrow(
				"manifest.json is not a valid install manifest",
			);
		}
	});
});

describe("path checks", () => {
	test("safe relative paths stay inside the root", () => {
		for (const path of ["a", "a/b.md", ".hidden/x"]) expect(isSafeRelative(path)).toBe(true);
		for (const path of [
			"",
			".",
			"..",
			"../a",
			"a/../b",
			"/a",
			"a//b",
			"a/",
			"a\\b",
			3,
			undefined,
		]) {
			expect(isSafeRelative(path)).toBe(false);
		}
	});

	test("managed paths carry an ultrathink- segment and backup paths live in the store", () => {
		expect(isManagedPath("skills/ultrathink-plan/SKILL.md")).toBe(true);
		expect(isManagedPath("commands/ultrathink-off.md")).toBe(true);
		expect(isManagedPath("skills/gsd-plan/SKILL.md")).toBe(false);
		expect(isManagedPath("../ultrathink-x")).toBe(false);
		expect(isBackupPath("ultrathink-backups/ab/settings.json")).toBe(true);
		expect(isBackupPath("ultrathink-backups")).toBe(false);
		expect(isBackupPath("ultrathink-backups/../x")).toBe(false);
		expect(isBackupPath("other/ab/x")).toBe(false);
	});
});
