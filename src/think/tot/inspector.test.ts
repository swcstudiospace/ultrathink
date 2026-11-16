// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	clearProjectFactsCache,
	extractSymbols,
	getProjectFacts,
	hasPath,
	hasSymbol,
	INSPECT_EXTENSIONS,
	inspectProject,
	isDeniedName,
	isDeniedPath,
	normalizeRelativePath,
	selectRelevantFacts,
} from "./inspector.ts";

const made: string[] = [];

afterEach(() => {
	clearProjectFactsCache();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(homedir(), prefix));
	made.push(dir);
	return dir;
}

function put(root: string, relative: string, content: string): void {
	const path = join(root, relative);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

/** A project with source, docs, and every kind of file the deny-list must never touch. */
function fixture(): string {
	const root = makeDir("ut-tot-inspect-");
	put(
		root,
		"src/app.ts",
		"export function runApp() {}\nexport class Widget {}\nexport const VALUE = 1;\n",
	);
	put(root, "src/util/helpers.py", "def helper():\n    pass\nclass Thing:\n    pass\n");
	put(root, "README.md", "# project\n");
	put(root, "notes.txt", "not an allowed extension\n");
	put(root, ".env", "SECRET_KEY=abc123\n");
	put(root, ".env.local", "TOKEN=zzz\n");
	put(root, "config/server.pem", "-----BEGIN PRIVATE KEY-----\n");
	put(root, "deploy/id_rsa", "private\n");
	put(root, "credentials.json", '{"password":"x"}\n');
	put(root, "src/api.key", "k\n");
	put(root, "secrets/db.ts", "export function leakedFromSecrets() {}\n");
	put(root, "src/tokens.ts", "export function leakedFromTokens() {}\n");
	put(root, "node_modules/pkg/index.ts", "export function leakedFromModules() {}\n");
	put(root, ".git/config", "[core]\n");
	return root;
}

describe("deny-list", () => {
	test("denies env files, keys, credentials, secrets, tokens, VCS and dependencies", () => {
		for (const path of [
			".env",
			".env.production",
			"a/b/server.pem",
			"deploy/id_rsa",
			"x/credentials.json",
			"secrets/x.ts",
			"src/tokens.ts",
			"src/my-secret.yml",
			"a/b/token.json",
			"node_modules/a/b.ts",
			".git/HEAD",
			"src/api.key",
			".npmrc",
		]) {
			expect(isDeniedPath(path)).toBe(true);
		}
	});

	test("keeps ordinary files that merely resemble secret words", () => {
		for (const path of ["src/app.ts", "src/tokenizer.ts", "docs/secretary.md", "src/keyboard.ts"]) {
			expect(isDeniedPath(path)).toBe(false);
		}
		expect(isDeniedName("node_modules", false)).toBe(false);
		expect(isDeniedName("node_modules", true)).toBe(true);
	});

	test("the allowlist holds no key or env extension", () => {
		for (const extension of INSPECT_EXTENSIONS) {
			expect([".pem", ".key", ".env", ".p12"]).not.toContain(extension);
		}
	});
});

describe("extractSymbols", () => {
	test("reads declarations per language", () => {
		expect(
			extractSymbols(
				"export async function a() {}\nexport default class B {}\ninterface C {}\nexport type D = 1;\nexport const E = 1;\n// function ignored() {}\n",
				".ts",
			).sort(),
		).toEqual(["B", "C", "D", "E", "a"]);
		expect(
			extractSymbols("def f():\n  pass\nasync def g():\n  pass\nclass H:\n  pass\n", ".py").sort(),
		).toEqual(["H", "f", "g"]);
		expect(
			extractSymbols("func (s *S) M() {}\nfunc F() {}\ntype T struct{}\n", ".go").sort(),
		).toEqual(["F", "M", "T"]);
		expect(
			extractSymbols("pub fn run() {}\npub(crate) struct S;\nenum E {}\n", ".rs").sort(),
		).toEqual(["E", "S", "run"]);
		expect(extractSymbols("export function x() {}", ".md")).toEqual([]);
	});
});

describe("inspectProject", () => {
	test("lists allowed files, reads symbols, and never touches the deny-list", async () => {
		const root = fixture();
		const outside = makeDir("ut-tot-outside-");
		put(outside, "outside.ts", "export function leakedViaLink() {}\n");
		symlinkSync(join(outside, "outside.ts"), join(root, "src/linked.ts"));
		const facts = await inspectProject(root);
		expect([...facts.files].sort()).toEqual(["README.md", "src/app.ts", "src/util/helpers.py"]);
		expect([...facts.dirs].sort()).toEqual(["src", "src/util"]);
		expect([...facts.symbols.keys()].sort()).toEqual([
			"Thing",
			"VALUE",
			"Widget",
			"helper",
			"runApp",
		]);
		expect(facts.symbols.get("runApp")).toEqual(["src/app.ts"]);
		expect(facts.denied).toBeGreaterThanOrEqual(10);
		expect(facts.truncated).toBe(false);
		const everything = JSON.stringify([...facts.files, ...facts.dirs, ...facts.symbols.keys()]);
		for (const leaked of [
			"leakedFrom",
			"leakedViaLink",
			".env",
			"id_rsa",
			"server.pem",
			"SECRET_KEY",
			"abc123",
		]) {
			expect(everything).not.toContain(leaked);
		}
	});

	test("honours the depth limit", async () => {
		const root = makeDir("ut-tot-depth-");
		put(root, "top.ts", "export const top = 1;\n");
		put(root, "a/x.ts", "export const x = 1;\n");
		put(root, "a/b/c.ts", "export const c = 1;\n");
		const facts = await inspectProject(root, { maxDepth: 1 });
		expect(facts.files.has("a/x.ts")).toBe(true);
		expect(facts.files.has("a/b/c.ts")).toBe(false);
		expect(facts.truncated).toBe(true);
	});

	test("honours the file-count limit, shallow files first", async () => {
		const root = makeDir("ut-tot-count-");
		put(root, "one.ts", "export const one = 1;\n");
		put(root, "two.ts", "export const two = 1;\n");
		put(root, "deep/three.ts", "export const three = 1;\n");
		const facts = await inspectProject(root, { maxFiles: 2 });
		expect([...facts.files].sort()).toEqual(["one.ts", "two.ts"]);
		expect(facts.truncated).toBe(true);
	});

	test("reads only the head of a large source file", async () => {
		const root = makeDir("ut-tot-bytes-");
		put(root, "big.ts", `export const early = 1;\n${" ".repeat(200)}\nexport const late = 2;\n`);
		const facts = await inspectProject(root, { maxFileBytes: 64 });
		expect(facts.symbols.has("early")).toBe(true);
		expect(facts.symbols.has("late")).toBe(false);
	});

	test("honours the symbol limit", async () => {
		const root = makeDir("ut-tot-symbols-");
		put(root, "many.ts", "export const a1 = 1;\nexport const a2 = 1;\nexport const a3 = 1;\n");
		const facts = await inspectProject(root, { maxSymbols: 2 });
		expect(facts.symbols.size).toBe(2);
		expect(facts.truncated).toBe(true);
	});

	test("rejects a root that does not exist", async () => {
		await expect(inspectProject(join(homedir(), "ut-tot-no-such-dir-xyz"))).rejects.toBeDefined();
	});
});

describe("getProjectFacts", () => {
	test("builds the facts once per root and limits, and shares them", async () => {
		const root = fixture();
		const [first, second] = await Promise.all([getProjectFacts(root), getProjectFacts(root)]);
		expect(first).toBe(second);
		expect(await getProjectFacts(root)).toBe(first);
		expect(await getProjectFacts(root, { maxFiles: 1 })).not.toBe(first);
		clearProjectFactsCache();
		expect(await getProjectFacts(root)).not.toBe(first);
	});

	test("does not cache a failure", async () => {
		const missing = join(homedir(), "ut-tot-missing-root-xyz");
		await expect(getProjectFacts(missing)).rejects.toBeDefined();
		mkdirSync(missing, { recursive: true });
		made.push(missing);
		put(missing, "a.ts", "export const a = 1;\n");
		expect((await getProjectFacts(missing)).files.has("a.ts")).toBe(true);
	});
});

describe("lookups", () => {
	test("normalizeRelativePath keeps repository-relative paths only", () => {
		expect(normalizeRelativePath("./src/app.ts")).toBe("src/app.ts");
		expect(normalizeRelativePath("src\\app.ts")).toBe("src/app.ts");
		expect(normalizeRelativePath("src/")).toBe("src");
		for (const bad of ["", "/etc/passwd", "../x.ts", "a/../b.ts", "C:\\x.ts", "a//b.ts"]) {
			expect(normalizeRelativePath(bad)).toBeUndefined();
		}
	});

	test("hasPath and hasSymbol answer from the facts", async () => {
		const facts = await inspectProject(fixture());
		expect(hasPath(facts, "src/app.ts")).toBe(true);
		expect(hasPath(facts, "./src/app.ts")).toBe(true);
		expect(hasPath(facts, "src")).toBe(true);
		expect(hasPath(facts, "src/missing.ts")).toBe(false);
		expect(hasPath(facts, ".env")).toBe(false);
		expect(hasPath(facts, "../etc/passwd")).toBe(false);
		expect(hasSymbol(facts, "runApp")).toBe(true);
		expect(hasSymbol(facts, "ghost")).toBe(false);
	});

	test("selectRelevantFacts ranks by shared words and stays bounded", async () => {
		const facts = await inspectProject(fixture());
		const picked = selectRelevantFacts(facts, "the helpers module and runApp", {
			maxFiles: 2,
			maxSymbols: 1,
		});
		expect(picked.files[0]).toBe("src/util/helpers.py");
		expect(picked.files.length).toBeLessThanOrEqual(2);
		expect(picked.symbols).toEqual(["runApp"]);
	});
});
