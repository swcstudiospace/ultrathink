// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Collects the policy input document that policy/*.rego evaluates (the shared input contract in
// .planning/phases/75-policy-as-code-governance/PLAN.md). Static mode reads the repository; --live also fetches
// a running server and records the response headers as they arrived. It writes JSON to stdout and never writes
// anything else.

import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { SECURITY_HEADERS } from "../services/ultrathink/routes/router.ts";
// Local copy: this script runs in a harness tree without src/ (see policy/check.test.ts or deploy/ultrathink-release.test.ts), so it cannot import src/shared.ts.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LIVE_TIMEOUT_MS = 10_000;
const DEFAULT_ROOT = resolve(import.meta.dir, "..");
const USAGE =
	"usage: bun policy/collect.ts [--root <dir>] [--live <url> [--live-ca <file>] [--live-cert <file> --live-key <file>]]";

/** `permissions` as written: the shorthand string, a scope map, or null when the key is absent. */
export type Permissions = string | Record<string, string> | null;

export interface WorkflowJob {
	permissions: Permissions;
	/** Every `uses` reference of the job: the job-level reusable-workflow ref first, then each step's, in file order. */
	uses: string[];
}

export interface Workflow {
	file: string;
	/** Parsed event names. Comments never appear here. */
	on: string[];
	permissions: Permissions;
	jobs: Record<string, WorkflowJob>;
}

/** Section name, then setting name, then every value assigned to it in file order. */
export type UnitSections = Record<string, Record<string, string[]>>;

export interface UnitFile {
	file: string;
	sections: UnitSections;
}

/** One scanned file that references OpenRouter: its root-relative posix path and the reference kinds found in it. */
export interface SourceScan {
	file: string;
	refs: string[];
}

export interface PolicyInput {
	source: "static" | "live";
	/** The `SECURITY_HEADERS` export of services/ultrathink/routes/router.ts, in its own case. */
	expected: Record<string, string>;
	/** Static mode: `expected`, lowercased. Live mode: the response headers, lowercased, with absent names absent. */
	headers: Record<string, string>;
	workflows: Workflow[];
	units: UnitFile[];
	/** Non-test source and config files that reference OpenRouter, sorted by file. Files without a reference are absent. */
	sources: SourceScan[];
}

export interface CollectOptions {
	root?: string;
	live?: string;
	liveTls?: LiveTlsFiles;
}

function expectString(value: unknown, where: string): string {
	if (typeof value !== "string") throw new Error(`${where}: expected a string`);
	return value;
}

function normalizePermissions(value: unknown, where: string): Permissions {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		const scopes: Record<string, string> = {};
		for (const [scope, level] of Object.entries(value))
			scopes[scope] = expectString(level, `${where}.${scope}`);
		return scopes;
	}
	throw new Error(`${where}: permissions must be a string or a map`);
}

function normalizeEvents(value: unknown, where: string): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value))
		return value.map((event, index) => expectString(event, `${where}[${index}]`));
	if (isRecord(value)) return Object.keys(value);
	throw new Error(`${where}: on must be an event name, a list or a map`);
}

export function parseWorkflow(text: string, file: string): Workflow {
	let doc: unknown;
	try {
		doc = parseYaml(text);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(doc)) throw new Error(`${file}: workflow must be a mapping`);
	const jobsRaw = doc.jobs ?? {};
	if (!isRecord(jobsRaw)) throw new Error(`${file}: jobs must be a mapping`);

	const jobs: Record<string, WorkflowJob> = {};
	for (const [id, job] of Object.entries(jobsRaw)) {
		const where = `${file} job ${id}`;
		if (!isRecord(job)) throw new Error(`${where}: job must be a mapping`);
		const uses: string[] = [];
		if (job.uses !== undefined) uses.push(expectString(job.uses, `${where}.uses`));
		if (job.steps !== undefined) {
			if (!Array.isArray(job.steps)) throw new Error(`${where}: steps must be a list`);
			for (const step of job.steps) {
				if (isRecord(step) && step.uses !== undefined)
					uses.push(expectString(step.uses, `${where} step uses`));
			}
		}
		jobs[id] = { permissions: normalizePermissions(job.permissions, `${where}.permissions`), uses };
	}

	return {
		file,
		on: normalizeEvents(doc.on, `${file}.on`),
		permissions: normalizePermissions(doc.permissions, `${file}.permissions`),
		jobs,
	};
}

/** Logical lines: comments and blank lines dropped, a trailing backslash joins the next line (systemd rule). */
function logicalLines(text: string): { line: number; text: string }[] {
	const out: { line: number; text: string }[] = [];
	let buffer: string | undefined;
	let start = 0;
	const physical = text.split("\n");
	for (let index = 0; index < physical.length; index++) {
		const trimmed = (physical[index] ?? "").trim();
		if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
		if (buffer === undefined) {
			buffer = "";
			start = index + 1;
		}
		if (trimmed.endsWith("\\")) {
			buffer += `${trimmed.slice(0, -1)} `;
			continue;
		}
		out.push({ line: start, text: `${buffer}${trimmed}`.trim() });
		buffer = undefined;
	}
	if (buffer !== undefined) out.push({ line: start, text: buffer.trim() });
	return out;
}

const SECTION_HEADER = /^\[([^\]]+)\]$/;

/**
 * A systemd unit INI file. Repeated settings are all kept, in file order. A value is split on whitespace, as systemd
 * splits list-valued settings, so `RestrictAddressFamilies=AF_INET AF_INET6` yields two entries. An empty value
 * (`CapabilityBoundingSet=`) yields `[""]`. Malformed lines fail the parse rather than being skipped.
 */
export function parseUnitFile(text: string, file: string): UnitSections {
	const sections: UnitSections = {};
	let current: Record<string, string[]> | undefined;
	for (const { line, text: content } of logicalLines(text)) {
		const header = SECTION_HEADER.exec(content);
		if (header) {
			current = sections[header[1] ?? ""] ??= {};
			continue;
		}
		const eq = content.indexOf("=");
		if (eq <= 0) throw new Error(`${file}:${line}: expected [Section] or Key=Value`);
		if (current === undefined)
			throw new Error(`${file}:${line}: setting appears before any [Section]`);
		const key = content.slice(0, eq).trim();
		const value = content.slice(eq + 1).trim();
		const entries = value === "" ? [""] : value.split(/\s+/);
		(current[key] ??= []).push(...entries);
	}
	return sections;
}

function lowercaseKeys(source: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) out[name.toLowerCase()] = value;
	return out;
}

/** PEM files for an https --live probe: the CA that signed the server, and the client certificate and key it presents. */
export interface LiveTlsFiles {
	ca?: string;
	cert?: string;
	key?: string;
}

function liveTlsOptions(files: LiveTlsFiles): { ca?: string; cert?: string; key?: string } {
	if ((files.cert === undefined) !== (files.key === undefined)) {
		throw new Error("--live-cert and --live-key must be given together");
	}
	return {
		ca: files.ca === undefined ? undefined : readFileSync(files.ca, "utf8"),
		cert: files.cert === undefined ? undefined : readFileSync(files.cert, "utf8"),
		key: files.key === undefined ? undefined : readFileSync(files.key, "utf8"),
	};
}

/**
 * GET the URL and return its response headers, lowercased. Absent headers stay absent. An https URL is verified against
 * `files.ca` and presents `files.cert` and `files.key`; without them, the system trust store applies. TLS files are
 * refused for an http URL, where they would be silently ignored.
 */
export async function fetchLiveHeaders(
	url: string,
	files: LiveTlsFiles = {},
): Promise<Record<string, string>> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`--live is not a valid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`--live must be an http or https URL: ${url}`);
	}
	const hasTlsFiles = files.ca !== undefined || files.cert !== undefined || files.key !== undefined;
	if (parsed.protocol === "http:" && hasTlsFiles) {
		throw new Error(`--live-ca, --live-cert and --live-key need an https --live URL: ${url}`);
	}
	const tls = parsed.protocol === "https:" ? liveTlsOptions(files) : undefined;
	const response = await fetch(parsed, {
		method: "GET",
		signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
		tls,
	});
	await response.body?.cancel();
	const headers: Record<string, string> = {};
	response.headers.forEach((value, name) => {
		headers[name.toLowerCase()] = value;
	});
	return headers;
}

// Reference kinds, in the order they are reported. `provider` is the quoted provider id: bare words in prose and labels
// ("OpenRouter") are deliberately not references, only code that names the host, the key variable, the provider id or
// the removed hosted-planner symbols.
const OPENROUTER_REFS: readonly { kind: string; pattern: RegExp }[] = [
	{ kind: "host", pattern: /openrouter\.ai/ },
	{ kind: "env", pattern: /\bOPENROUTER_API_KEY\b/ },
	{ kind: "provider", pattern: /["'`]openrouter["'`]/ },
	{
		kind: "symbol",
		pattern:
			/\b(?:OpenRouterFetch|OpenRouterError|OpenRouterCompleter\w*|createOpenRouterCompleter|openRouterApiKey|openRouterBaseUrl|ULTRATHINK_OPENROUTER\w*)\b/,
	},
];

const SOURCE_DIRS = [
	"src",
	"hooks",
	"services",
	"scripts",
	"plugins",
	"hosts",
	"deploy",
	"bin",
	".github",
];
// Workflows are YAML, so .yml and .yaml are scanned as well: a key reference in CI is the likeliest leak.
const SOURCE_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".sh",
	".service",
	".timer",
	".json",
	".yml",
	".yaml",
];
// Dependencies, VCS data and prose never configure a model route; tests may name OpenRouter freely.
const SKIPPED_DIRS = ["node_modules", ".git", "docs"];
const TEST_FILE = /\.test\.tsx?$/;
// Comment syntax is per language. `//` and `/* */` belong to the C-style languages only: in shell, YAML and unit files
// `//` is part of a URL. `#` starts a comment in shell, YAML and unit files, but in TypeScript it opens a private class
// member (`#url = "https://openrouter.ai/..."`), so a `#` line is never dropped there; JSON has no comments at all.
const C_STYLE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const HASH_COMMENT_LINE = /^\s*#/;

/**
 * Drops trailing `//` comments and `/* ... *\/` blocks, including multi-line ones. Quotes are tracked so the `//` in
 * "https://openrouter.ai" stays code. A quote left open at a line end is dropped, except a template literal, which
 * spans lines; a regex literal holding a quote can therefore leave a comment unstripped, which only over-reports.
 */
function stripCStyleComments(lines: string[]): string[] {
	let inBlock = false;
	let quote = "";
	return lines.map((line) => {
		let kept = "";
		let i = 0;
		while (i < line.length) {
			const char = line.charAt(i);
			if (inBlock) {
				if (line.startsWith("*/", i)) {
					inBlock = false;
					i += 2;
				} else {
					i += 1;
				}
				continue;
			}
			if (quote !== "") {
				kept += char;
				if (char === "\\") {
					kept += line.charAt(i + 1);
					i += 2;
					continue;
				}
				if (char === quote) quote = "";
				i += 1;
				continue;
			}
			if (line.startsWith("//", i)) break;
			if (line.startsWith("/*", i)) {
				inBlock = true;
				i += 2;
				continue;
			}
			if (char === '"' || char === "'" || char === "`") quote = char;
			kept += char;
			i += 1;
		}
		if (quote !== "`") quote = "";
		return kept;
	});
}

function stripComments(text: string, extension: string): string {
	const lines = text.split("\n");
	if (C_STYLE_EXTENSIONS.includes(extension)) {
		// A shebang is the one `#` line a C-style file may start with.
		if (lines[0]?.startsWith("#!")) lines[0] = "";
		return stripCStyleComments(lines).join("\n");
	}
	if (extension === ".json") return text;
	return lines.filter((line) => !HASH_COMMENT_LINE.test(line)).join("\n");
}

/** Scannable files under `dir` (root-relative posix paths). Extensionless files count only under bin/. */
function walkSources(root: string, dir: string, out: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(join(root, dir), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const relative = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.includes(entry.name)) walkSources(root, relative, out);
			continue;
		}
		if (!entry.isFile() || TEST_FILE.test(entry.name)) continue;
		const extension = extname(entry.name);
		if (SOURCE_EXTENSIONS.includes(extension) || (extension === "" && relative.startsWith("bin/")))
			out.push(relative);
	}
}

/**
 * The OpenRouter references in the non-test files of the tree, against the allow-list in openrouter.rego. Only the
 * resolved `--root` is read, so a fixture root without src/ or services/ yields an empty list.
 */
function scanSources(root: string): SourceScan[] {
	const files: string[] = [];
	for (const dir of SOURCE_DIRS) walkSources(root, dir, files);
	if (statSync(join(root, "package.json"), { throwIfNoEntry: false })?.isFile())
		files.push("package.json");

	const scans: SourceScan[] = [];
	for (const file of files.sort()) {
		const text = stripComments(readFileSync(join(root, file), "utf8"), extname(file));
		const refs = OPENROUTER_REFS.filter(({ pattern }) => pattern.test(text)).map(
			({ kind }) => kind,
		);
		if (refs.length > 0) scans.push({ file, refs });
	}
	return scans;
}

export async function collect(options: CollectOptions = {}): Promise<PolicyInput> {
	const root = resolve(options.root ?? DEFAULT_ROOT);
	if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`--root is not a directory: ${root}`);
	}

	const workflowNames = readdirSync(join(root, ".github/workflows"))
		.filter((name) => /\.ya?ml$/.test(name))
		.sort();
	const workflows = workflowNames.map((name) => {
		const file = `.github/workflows/${name}`;
		return parseWorkflow(readFileSync(join(root, file), "utf8"), file);
	});

	const unitNames = readdirSync(join(root, "deploy"))
		.filter((name) => /^ultrathink-.+\.(service|timer)$/.test(name))
		.sort();
	const units = unitNames.map((name) => {
		const file = `deploy/${name}`;
		return { file, sections: parseUnitFile(readFileSync(join(root, file), "utf8"), file) };
	});

	const expected: Record<string, string> = { ...SECURITY_HEADERS };
	const sources = scanSources(root);
	if (options.live === undefined) {
		return {
			source: "static",
			expected,
			headers: lowercaseKeys(expected),
			workflows,
			units,
			sources,
		};
	}
	return {
		source: "live",
		expected,
		headers: await fetchLiveHeaders(options.live, options.liveTls),
		workflows,
		units,
		sources,
	};
}

export async function main(argv: readonly string[]): Promise<number> {
	let values: {
		root?: string;
		live?: string;
		"live-ca"?: string;
		"live-cert"?: string;
		"live-key"?: string;
		help?: boolean;
	};
	try {
		({ values } = parseArgs({
			args: [...argv],
			options: {
				root: { type: "string" },
				live: { type: "string" },
				"live-ca": { type: "string" },
				"live-cert": { type: "string" },
				"live-key": { type: "string" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch (error) {
		process.stderr.write(
			`collect: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
		);
		return 2;
	}
	if (values.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	try {
		const input = await collect({
			root: values.root,
			live: values.live,
			liveTls: { ca: values["live-ca"], cert: values["live-cert"], key: values["live-key"] },
		});
		process.stdout.write(`${JSON.stringify(input, null, 2)}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`collect: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
}

if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
