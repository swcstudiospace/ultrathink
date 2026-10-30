// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Standalone import-graph guard (STAND-03). Every entry point that must run without Omp is checked two independent
 * ways: Bun.build must bundle it with nothing external, and a transitive import scan of its real source files must
 * never reach src/host/omp.ts (or any other Omp-named src/host file) or any @oh-my-pi/* package. A failure
 * prints the full import chain to the offender.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The ten standalone entries, relative to the repo root. */
const STANDALONE_ENTRIES: readonly string[] = [
	"services/ultrathink/stdio/main.ts",
	"services/ultrathink/server.ts",
	"hooks/uplift.ts",
	"hooks/answers.ts",
	"hooks/pr-sync.ts",
	"hooks/flow-eval.ts",
	"hooks/stop.ts",
	"hooks/engine.ts",
	"src/uplift/commands.ts",
	"src/mcp/cli.ts",
];

/** Any src/host/omp*.ts file: the Omp extension and its UI helpers. No standalone entry may reach one. */
const OMP_HOST_PATH = /(^|\/)src\/host\/omp[^/]*\.ts$/;
const OMP_PACKAGE_PREFIX = "@oh-my-pi/";
const OMP_NODE_MODULES = "node_modules/@oh-my-pi";
/** Below this many visited files a scan is treated as silently empty rather than as a pass. */
const MIN_VISITED_FILES = 5;
const SCANNABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

interface ScanResult {
	/** Repo-relative POSIX paths of every file reached, mapped to the file that first imported it (null for the entry). */
	readonly visited: Map<string, string | null>;
	/** Import chains ending at a forbidden file or specifier. */
	readonly forbidden: string[];
	/** Relative specifiers no resolver rule could place, with the chain that reached them. */
	readonly unresolved: string[];
}

/** Literal path, .ts, .tsx, .js stripped to .ts, then a directory's index.ts and index.tsx. */
function resolveRelative(importerDir: string, specifier: string): string | null {
	const base = resolve(importerDir, specifier);
	const candidates = [base, `${base}.ts`, `${base}.tsx`];
	if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
	candidates.push(join(base, "index.ts"), join(base, "index.tsx"));
	return (
		candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
	);
}

function chainTo(visited: Map<string, string | null>, path: string): string[] {
	const chain: string[] = [];
	for (let at: string | null | undefined = path; at; at = visited.get(at)) chain.unshift(at);
	return chain;
}

function scanGraph(entry: string, root: string = REPO_ROOT): ScanResult {
	const visited = new Map<string, string | null>();
	const forbidden: string[] = [];
	const unresolved: string[] = [];
	const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
	const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });

	const visit = (repoPath: string, importer: string | null): void => {
		if (visited.has(repoPath)) return;
		visited.set(repoPath, importer);
		if (OMP_HOST_PATH.test(repoPath) || repoPath.includes(OMP_NODE_MODULES)) {
			forbidden.push(chainTo(visited, repoPath).join(" -> "));
			return;
		}
		if (repoPath.includes("node_modules/")) return;
		if (!SCANNABLE_EXTENSIONS.some((extension) => repoPath.endsWith(extension))) return;

		const absolute = join(root, repoPath);
		const transpiler = repoPath.endsWith("x") ? tsxTranspiler : tsTranspiler;
		// Bun's transpiler rejects a leading shebang; blank the line so line numbers stay stable.
		const source = readFileSync(absolute, "utf8").replace(/^#![^\n]*/, "");
		const specifiers = transpiler.scanImports(source).map((item) => item.path);
		for (const specifier of specifiers) {
			if (specifier.startsWith(OMP_PACKAGE_PREFIX)) {
				forbidden.push(`${chainTo(visited, repoPath).join(" -> ")} -> ${specifier}`);
				continue;
			}
			const isRelative =
				specifier === "." ||
				specifier === ".." ||
				specifier.startsWith("./") ||
				specifier.startsWith("../");
			if (!isRelative) continue;
			const resolved = resolveRelative(dirname(absolute), specifier);
			if (resolved === null) {
				unresolved.push(
					`${chainTo(visited, repoPath).join(" -> ")} -> ${specifier} (unresolvable)`,
				);
				continue;
			}
			visit(relative(root, resolved).split(sep).join("/"), repoPath);
		}
	};

	visit(entry, null);
	return { visited, forbidden, unresolved };
}

describe("standalone entries never reach Omp", () => {
	for (const entry of STANDALONE_ENTRIES) {
		describe(entry, () => {
			test("bundles with Bun.build and nothing external", async () => {
				const result = await Bun.build({
					entrypoints: [join(REPO_ROOT, entry)],
					target: "bun",
					external: [],
					throw: false,
				});
				if (!result.success) {
					throw new Error(`Bun.build failed:\n${result.logs.map((log) => log.message).join("\n")}`);
				}
				expect(result.success).toBe(true);
			}, 120_000);

			test("transitive import scan finds no Omp file or @oh-my-pi package", () => {
				const scan = scanGraph(entry);
				expect(scan.unresolved).toEqual([]);
				expect(scan.forbidden).toEqual([]);
				expect(scan.visited.size).toBeGreaterThan(MIN_VISITED_FILES);
			});
		});
	}
});

describe("scanGraph itself", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	/** Writes a fixture graph (repo-relative path -> source) into a fresh temp dir and returns its root. */
	function fixture(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "standalone-graph-"));
		roots.push(root);
		for (const [path, source] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), source);
		}
		return root;
	}

	test("fails when a helper imports an @oh-my-pi package, naming the chain", () => {
		const root = fixture({
			"entry.ts": 'import { x } from "./helper.ts";\nexport const y = x;\n',
			"helper.ts": 'import { ai } from "@oh-my-pi/pi-ai";\nexport const x = ai;\n',
		});
		const scan = scanGraph("entry.ts", root);
		expect(scan.forbidden).toEqual(["entry.ts -> helper.ts -> @oh-my-pi/pi-ai"]);
		expect(scan.unresolved).toEqual([]);
	});

	test("passes when the graph only reaches a non-Omp host helper", () => {
		const root = fixture({
			"entry.ts": 'import { id } from "./src/host/session-id.ts";\nexport const y = id;\n',
			"src/host/session-id.ts":
				'import { join } from "node:path";\nexport const id = join("a", "b");\n',
		});
		const scan = scanGraph("entry.ts", root);
		expect(scan.forbidden).toEqual([]);
		expect(scan.unresolved).toEqual([]);
		expect([...scan.visited.keys()]).toEqual(["entry.ts", "src/host/session-id.ts"]);
	});

	test("fails on src/host/omp.ts and on an Omp-named helper that is not on the allow-list", () => {
		const root = fixture({
			"entry.ts": 'import "./src/host/omp.ts";\nimport "./src/host/omp-extra.ts";\n',
			"src/host/omp.ts": "export const a = 1;\n",
			"src/host/omp-extra.ts": "export const b = 2;\n",
		});
		expect(scanGraph("entry.ts", root).forbidden).toEqual([
			"entry.ts -> src/host/omp.ts",
			"entry.ts -> src/host/omp-extra.ts",
		]);
	});

	test("fails on an unresolvable relative specifier instead of passing silently", () => {
		const root = fixture({ "entry.ts": 'import "./missing.ts";\n' });
		expect(scanGraph("entry.ts", root).unresolved).toEqual([
			"entry.ts -> ./missing.ts (unresolvable)",
		]);
	});
});
