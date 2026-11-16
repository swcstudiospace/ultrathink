// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { Dirent } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import type { InspectLimits, ProjectFacts } from "./types.ts";

/**
 * Bounded, read-only project inspector. It lists file names and reads declared symbol names, nothing else: file
 * contents never leave this module, symlinks are never followed, and nothing on the deny-list is listed or opened.
 * The facts are built once per root and limits (`getProjectFacts`) and shared by every PRD of a run.
 */

const DEFAULT_INSPECT_LIMITS: InspectLimits = {
	maxDepth: 6,
	maxFiles: 2000,
	maxFileBytes: 64 * 1024,
	maxSymbols: 4000,
};

/** At most this many declaring files are kept per symbol name. */
const MAX_FILES_PER_SYMBOL = 5;

const SOURCE_EXTENSIONS: readonly string[] = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".kt",
	".cs",
	".swift",
	".rb",
	".php",
	".c",
	".h",
	".cpp",
	".hpp",
	".sh",
];

/** Files that are listed (their names are facts) but whose content is never read. */
const LISTED_ONLY_EXTENSIONS: readonly string[] = [
	".json",
	".md",
	".yaml",
	".yml",
	".toml",
	".sql",
	".css",
	".html",
];

/** The extension allowlist: anything else is not inspected at all. */
export const INSPECT_EXTENSIONS: readonly string[] = [
	...SOURCE_EXTENSIONS,
	...LISTED_ONLY_EXTENSIONS,
];

const EXTENSION_SET: ReadonlySet<string> = new Set(INSPECT_EXTENSIONS);
const SOURCE_SET: ReadonlySet<string> = new Set(SOURCE_EXTENSIONS);

/** Directories never entered: VCS state, dependencies, key stores and secret folders. */
const DENIED_DIR_NAMES: ReadonlySet<string> = new Set([
	".git",
	"node_modules",
	".ssh",
	".aws",
	".gnupg",
	".gcloud",
	".kube",
	".terraform",
	".venv",
	"__pycache__",
]);

/** A name part that marks a credential file or folder: `secrets`, `credentials.json`, `my-token.ts`, `.secret`. */
const SECRETISH_NAME = /(?:^|[._-])(?:secrets?|credentials?|tokens?)(?:$|[._-])/i;
const DENIED_FILE_NAME =
	/^\.env|\.(?:pem|key|p12|pfx|jks|keystore|ppk|tfstate)$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.(?:npmrc|netrc|pypirc|dockercfg)$|^service-account/i;

/** Whether one path segment (a directory or file name) is on the deny-list. */
export function isDeniedName(name: string, isDirectory: boolean): boolean {
	if (isDirectory && DENIED_DIR_NAMES.has(name)) return true;
	return DENIED_FILE_NAME.test(name) || SECRETISH_NAME.test(name);
}

/** Whether any segment of the repository-relative path is on the deny-list. */
export function isDeniedPath(relativePath: string): boolean {
	const segments = relativePath.split(/[\\/]+/).filter(Boolean);
	return segments.some((segment, index) => isDeniedName(segment, index < segments.length - 1));
}

const IDENT = /^[A-Za-z_$][\w$?!]{0,79}$/;

interface SymbolRule {
	readonly extensions: readonly string[];
	readonly patterns: readonly RegExp[];
}

const SYMBOL_RULES: readonly SymbolRule[] = [
	{
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		patterns: [
			/^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:abstract[ \t]+)?(?:async[ \t]+)?(?:function\*?|class|interface|type|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm,
			/^[ \t]*export[ \t]+(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)/gm,
		],
	},
	{ extensions: [".py"], patterns: [/^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)/gm] },
	{
		extensions: [".go"],
		patterns: [/^func[ \t]+(?:\([^)\n]*\)[ \t]*)?([A-Za-z_]\w*)/gm, /^type[ \t]+([A-Za-z_]\w*)/gm],
	},
	{
		extensions: [".rs"],
		patterns: [
			/^[ \t]*(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:async[ \t]+)?(?:fn|struct|enum|trait|type|mod)[ \t]+([A-Za-z_]\w*)/gm,
		],
	},
	{
		extensions: [".java", ".kt", ".cs", ".swift"],
		patterns: [
			/^[ \t]*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|export)[ \t]+)*(?:class|interface|enum|struct|record|object|protocol)[ \t]+([A-Za-z_]\w*)/gm,
		],
	},
	{
		extensions: [".rb"],
		patterns: [/^[ \t]*(?:def|class|module)[ \t]+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm],
	},
];

const RULES_BY_EXTENSION: ReadonlyMap<string, readonly RegExp[]> = new Map(
	SYMBOL_RULES.flatMap((rule) => rule.extensions.map((ext) => [ext, rule.patterns] as const)),
);

/** Declared symbol names found in `text` (a source file's head). Pure; used by the walk and by tests. */
export function extractSymbols(text: string, extension: string): string[] {
	const patterns = RULES_BY_EXTENSION.get(extension);
	if (patterns === undefined) return [];
	const names = new Set<string>();
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
			const name = match[1];
			if (name !== undefined && IDENT.test(name)) names.add(name);
		}
	}
	return [...names];
}

async function readHead(path: string, maxBytes: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

function byName(a: Dirent, b: Dirent): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function addAncestors(dirs: Set<string>, relative: string): void {
	for (
		let slash = relative.lastIndexOf("/");
		slash > 0;
		slash = relative.lastIndexOf("/", slash - 1)
	) {
		const dir = relative.slice(0, slash);
		if (dirs.has(dir)) return;
		dirs.add(dir);
	}
}

/**
 * Walks `root` breadth-first (shallow files win when a limit bites) and returns the facts. Never throws for an
 * unreadable entry: it is skipped. Throws only when `root` itself cannot be resolved.
 */
export async function inspectProject(
	root: string,
	limits: Partial<InspectLimits> = {},
): Promise<ProjectFacts> {
	const bounds: InspectLimits = { ...DEFAULT_INSPECT_LIMITS, ...limits };
	const absolute = await realpath(root);
	const files = new Set<string>();
	const dirs = new Set<string>();
	const symbols = new Map<string, string[]>();
	let truncated = false;
	let denied = 0;
	let queue: { abs: string; rel: string }[] = [{ abs: absolute, rel: "" }];
	for (let depth = 0; queue.length > 0; depth++) {
		if (depth > bounds.maxDepth) {
			truncated = true;
			break;
		}
		const next: { abs: string; rel: string }[] = [];
		for (const dir of queue) {
			let entries: Dirent[];
			try {
				entries = await readdir(dir.abs, { withFileTypes: true });
			} catch {
				// reason: an unreadable directory is simply not part of the facts
				continue;
			}
			entries.sort(byName);
			for (const entry of entries) {
				if (entry.isSymbolicLink()) continue;
				const isDir = entry.isDirectory();
				if (isDeniedName(entry.name, isDir)) {
					denied++;
					continue;
				}
				const rel = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
				const abs = join(dir.abs, entry.name);
				if (isDir) {
					next.push({ abs, rel });
					continue;
				}
				const extension = extname(entry.name).toLowerCase();
				if (!entry.isFile() || !EXTENSION_SET.has(extension)) continue;
				if (files.size >= bounds.maxFiles) {
					truncated = true;
					continue;
				}
				files.add(rel);
				addAncestors(dirs, rel);
				if (!SOURCE_SET.has(extension)) continue;
				if (symbols.size >= bounds.maxSymbols) {
					truncated = true;
					continue;
				}
				let head: string;
				try {
					head = await readHead(abs, bounds.maxFileBytes);
				} catch {
					// reason: an unreadable source file still counts as a file, with no symbols
					continue;
				}
				for (const name of extractSymbols(head, extension)) {
					const declaring = symbols.get(name);
					if (declaring === undefined) {
						if (symbols.size < bounds.maxSymbols) symbols.set(name, [rel]);
						else truncated = true;
					} else if (declaring.length < MAX_FILES_PER_SYMBOL) declaring.push(rel);
				}
			}
		}
		queue = next;
	}
	return { root: absolute, files, dirs, symbols, truncated, denied };
}

const cache = new Map<string, Promise<ProjectFacts>>();

/** The shared facts for `root`: one walk per root and limits, concurrent callers share the same promise. */
export async function getProjectFacts(
	root: string,
	limits: Partial<InspectLimits> = {},
): Promise<ProjectFacts> {
	const bounds: InspectLimits = { ...DEFAULT_INSPECT_LIMITS, ...limits };
	const key = `${await realpath(root)}\u0000${bounds.maxDepth}:${bounds.maxFiles}:${bounds.maxFileBytes}:${bounds.maxSymbols}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const pending = inspectProject(root, bounds);
	cache.set(key, pending);
	pending.catch(() => cache.delete(key));
	return pending;
}

export function clearProjectFactsCache(): void {
	cache.clear();
}

/** Normalizes a model-written path: POSIX separators, no leading `./`, no trailing `/`; undefined when absolute or escaping the root. */
export function normalizeRelativePath(raw: string): string | undefined {
	const cleaned = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (cleaned === "" || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return undefined;
	const parts = cleaned.split("/");
	if (parts.some((part) => part === ".." || part === "." || part === "")) return undefined;
	return parts.join("/");
}

/** Whether `path` names an inspected file or a directory holding one. */
export function hasPath(facts: ProjectFacts, path: string): boolean {
	const normalized = normalizeRelativePath(path);
	return normalized !== undefined && (facts.files.has(normalized) || facts.dirs.has(normalized));
}

/** Whether a symbol of exactly this name is declared in an inspected file. */
export function hasSymbol(facts: ProjectFacts, name: string): boolean {
	return facts.symbols.has(name.trim());
}

const WORD = /[A-Za-z][A-Za-z0-9]{2,}/g;

function words(text: string): string[] {
	return [...new Set((text.toLowerCase().match(WORD) ?? []).slice(0, 200))];
}

/** A bounded, relevance-ordered excerpt of the facts for a prompt: the paths and symbols that share words with `text`. */
export function selectRelevantFacts(
	facts: ProjectFacts,
	text: string,
	caps: { readonly maxFiles: number; readonly maxSymbols: number } = {
		maxFiles: 80,
		maxSymbols: 60,
	},
): { files: string[]; symbols: string[] } {
	const terms = words(text);
	const score = (value: string): number => {
		const lower = value.toLowerCase();
		let total = 0;
		for (const term of terms) if (lower.includes(term)) total++;
		return total;
	};
	const rankedFiles = [...facts.files]
		.map((path) => ({ path, score: score(path), depth: path.split("/").length }))
		.sort((a, b) => b.score - a.score || a.depth - b.depth || (a.path < b.path ? -1 : 1));
	const matching = rankedFiles.filter((file) => file.score > 0);
	const shallow = rankedFiles.filter((file) => file.score === 0 && file.depth <= 2);
	const files = [...matching, ...shallow].slice(0, caps.maxFiles).map((file) => file.path);
	const symbols = [...facts.symbols.keys()]
		.map((name) => ({ name, score: score(name) }))
		.filter((symbol) => symbol.score > 0)
		.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
		.slice(0, caps.maxSymbols)
		.map((symbol) => symbol.name);
	return { files, symbols };
}
