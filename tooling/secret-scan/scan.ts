// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Credential scan. Scans the given files and directories for credential-shaped strings.
 * Directories are walked recursively; `.git/` and `node_modules/` inside them are skipped.
 * Matched values are never printed; only the pattern name and the first 4 characters appear.
 *
 * Run: bun tooling/secret-scan/scan.ts <path> [path...]
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { SECRET_PATTERNS, type SecretPattern } from "./patterns.ts";

export interface SecretFinding {
	readonly file: string;
	readonly line: number;
	readonly pattern: string;
	readonly preview: string;
}

export interface ScanFailure {
	readonly file: string;
	readonly message: string;
}

export interface ScanReport {
	readonly filesScanned: number;
	readonly findings: readonly SecretFinding[];
	readonly failures: readonly ScanFailure[];
}

const PREVIEW_CHARS = 4;
const SKIPPED_DIRS: readonly string[] = [".git", "node_modules"];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function scanText(
	file: string,
	text: string,
	patterns: readonly SecretPattern[] = SECRET_PATTERNS,
): SecretFinding[] {
	const findings: SecretFinding[] = [];
	const lines = text.split(/\r?\n/);
	lines.forEach((line, index) => {
		for (const { name, pattern, valueGroup } of patterns) {
			const match = pattern.exec(line);
			if (match === null) continue;
			const value = match[valueGroup];
			if (value === undefined) {
				throw new Error(`pattern ${name} has no capture group ${valueGroup}`);
			}
			findings.push({
				file,
				line: index + 1,
				pattern: name,
				preview: `${value.slice(0, PREVIEW_CHARS)}****`,
			});
		}
	});
	return findings;
}

export async function collectFiles(target: string): Promise<string[]> {
	const info = await stat(target);
	if (!info.isDirectory()) return [target];

	const files: string[] = [];
	for await (const rel of new Bun.Glob("**/*").scan({ cwd: target, onlyFiles: true, dot: true })) {
		const segments = rel.split(path.sep);
		if (segments.some((segment) => SKIPPED_DIRS.includes(segment))) continue;
		files.push(path.join(target, rel));
	}
	return files.sort();
}

export async function scanPaths(targets: readonly string[]): Promise<ScanReport> {
	const findings: SecretFinding[] = [];
	const failures: ScanFailure[] = [];
	let filesScanned = 0;

	for (const target of targets) {
		let files: string[];
		try {
			files = await collectFiles(target);
		} catch (error) {
			failures.push({ file: target, message: `cannot read path: ${errorMessage(error)}` });
			continue;
		}
		for (const file of files) {
			let text: string;
			try {
				text = await Bun.file(file).text();
			} catch (error) {
				failures.push({ file, message: `unreadable: ${errorMessage(error)}` });
				continue;
			}
			filesScanned++;
			findings.push(...scanText(file, text));
		}
	}

	return { filesScanned, findings, failures };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	if (argv.length === 0) {
		console.error("usage: bun tooling/secret-scan/scan.ts <path> [path...]");
		return 1;
	}

	const report = await scanPaths(argv);
	for (const failure of report.failures) {
		console.error(`${failure.file}: ${failure.message}`);
	}
	for (const finding of report.findings) {
		console.error(
			`${finding.file}:${finding.line}: ${finding.pattern} matched (preview ${finding.preview})`,
		);
	}
	if (report.findings.length > 0 || report.failures.length > 0) {
		console.error(
			`secret scan: ${report.findings.length} finding(s), ${report.failures.length} failure(s) in ${report.filesScanned} file(s)`,
		);
		return 1;
	}
	console.log(`secret scan: ${report.filesScanned} file(s) clean`);
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
