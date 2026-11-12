// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Core boundary check. Fails when any .ts module under core/ imports a host SDK,
 * a host module, or anything that resolves outside core/.
 *
 * Run: bun tooling/boundary/check-core-boundary.ts
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

export interface BoundaryViolation {
	readonly file: string;
	readonly line: number;
	readonly specifier: string;
	readonly reason: string;
}

export interface BoundaryFailure {
	readonly file: string;
	readonly message: string;
}

export interface BoundaryReport {
	readonly filesScanned: number;
	readonly violations: readonly BoundaryViolation[];
	readonly failures: readonly BoundaryFailure[];
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CORE_DIR = path.join(REPO_ROOT, "core");

const FORBIDDEN_BARE_PREFIXES: readonly string[] = [
	"@oh-my-pi",
	"@anthropic",
	"hermes",
	"prime-agent",
];
const FORBIDDEN_REPO_DIRS: readonly string[] = [
	"src/host",
	"src/claude",
	"src/grok",
	"src/muse",
	"src/cursor",
];

// Group 1 is the quote character, group 2 is the specifier.
const SPECIFIER_PATTERNS: readonly RegExp[] = [
	// import ... from "x", import type ... from "x", export ... from "x", export * from "x"
	/\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"`\n]+)\1/g,
	// side-effect import: import "x"
	/\bimport\s*(['"])([^'"`\n]+)\1/g,
	// dynamic import("x") and require("x")
	/\b(?:import|require)\s*\(\s*(['"])([^'"`\n]+)\1\s*\)/g,
];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toRepoRelative(absolute: string): string {
	return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

function isInside(dir: string, target: string): boolean {
	const rel = path.relative(dir, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (text.charCodeAt(i) === 10) line++;
	}
	return line;
}

export function extractSpecifiers(text: string): { line: number; specifier: string }[] {
	const seen = new Set<string>();
	const found: { line: number; specifier: string }[] = [];
	for (const pattern of SPECIFIER_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const specifier = match[2];
			if (specifier === undefined || match.index === undefined) {
				throw new Error(`specifier pattern ${pattern.source} matched without its capture groups`);
			}
			const line = lineOf(text, match.index);
			const key = `${line}\u0000${specifier}`;
			if (seen.has(key)) continue;
			seen.add(key);
			found.push({ line, specifier });
		}
	}
	return found;
}

/** Returns a reason string when the specifier breaks the boundary, otherwise undefined. */
function classify(fileAbsolute: string, specifier: string): string | undefined {
	if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
		const resolved = path.resolve(path.dirname(fileAbsolute), specifier);
		if (isInside(CORE_DIR, resolved)) return undefined;
		const repoRelative = toRepoRelative(resolved);
		const hostDir = FORBIDDEN_REPO_DIRS.find(
			(dir) => repoRelative === dir || repoRelative.startsWith(`${dir}/`),
		);
		return hostDir !== undefined
			? `resolves into host module ${hostDir}/`
			: `resolves outside core/ (${repoRelative})`;
	}
	if (FORBIDDEN_BARE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
		return "host SDK or host module package";
	}
	if (FORBIDDEN_REPO_DIRS.some((dir) => specifier === dir || specifier.startsWith(`${dir}/`))) {
		return "bare specifier names a host module directory";
	}
	return undefined;
}

export async function checkCoreBoundary(coreDir: string = CORE_DIR): Promise<BoundaryReport> {
	const violations: BoundaryViolation[] = [];
	const failures: BoundaryFailure[] = [];

	let info: Stats | undefined;
	try {
		info = await stat(coreDir);
	} catch (error) {
		failures.push({
			file: toRepoRelative(coreDir),
			message: `core/ is missing or unreadable: ${errorMessage(error)}`,
		});
		return { filesScanned: 0, violations, failures };
	}
	if (!info.isDirectory()) {
		failures.push({
			file: toRepoRelative(coreDir),
			message: "core/ exists but is not a directory",
		});
		return { filesScanned: 0, violations, failures };
	}

	const files: string[] = [];
	try {
		for await (const rel of new Bun.Glob("**/*.ts").scan({ cwd: coreDir, onlyFiles: true })) {
			files.push(path.join(coreDir, rel));
		}
	} catch (error) {
		failures.push({
			file: toRepoRelative(coreDir),
			message: `cannot walk core/: ${errorMessage(error)}`,
		});
	}
	files.sort();

	for (const file of files) {
		const displayed = toRepoRelative(file);
		let text: string;
		try {
			text = await Bun.file(file).text();
		} catch (error) {
			failures.push({ file: displayed, message: `unreadable: ${errorMessage(error)}` });
			continue;
		}
		for (const { line, specifier } of extractSpecifiers(text)) {
			const reason = classify(file, specifier);
			if (reason !== undefined) {
				violations.push({ file: displayed, line, specifier, reason });
			}
		}
	}

	return { filesScanned: files.length, violations, failures };
}

export async function main(): Promise<number> {
	const report = await checkCoreBoundary();
	for (const failure of report.failures) {
		console.error(`${failure.file}: ${failure.message}`);
	}
	for (const violation of report.violations) {
		console.error(
			`${violation.file}:${violation.line}: forbidden import "${violation.specifier}" (${violation.reason})`,
		);
	}
	if (report.violations.length > 0 || report.failures.length > 0) {
		console.error(
			`core boundary: ${report.violations.length} violation(s), ${report.failures.length} failure(s) in ${report.filesScanned} file(s)`,
		);
		return 1;
	}
	console.log(
		`core boundary: ${report.filesScanned} file(s) under core/ import only core/ modules`,
	);
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
