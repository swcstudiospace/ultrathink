// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// C1-1 grep gate (graph ut-8d46e86eef-dc3a7555, W6): enforces the planner
// contract — `.planning/STATE.md` / `.planning/ROADMAP.md` may only be
// written through `src/workflow/guarded-write.ts` (SHA-256 CAS + exclusive
// lock, ratified by Phase 112). Any source file that mentions a
// STATE.md/ROADMAP.md write pattern outside that module fails the gate.
// Pure predicate over in-memory file contents: the caller (CLI main below)
// feeds it `git grep` output; tests feed it fixtures.

/** One file's path and text. */
export interface GateFile {
	path: string;
	content: string;
}

/** The one module allowed to write planning files. */
const GUARDED_MODULE = "src/workflow/guarded-write.ts";

/**
 * Patterns that count as a planning-file write. Generous on purpose: the
 * gate's job is to make violations loud, not to parse ASTs.
 */
const WRITE_PATTERNS: RegExp[] = [
	/writeFile(?:Sync)?\s*\([^)]*(?:STATE|ROADMAP)\.md/,
	/pendingFile(?:s)?\s*(?:save|write|persist)\s*\([^)]*(?:STATE|ROADMAP)\.md/,
	/(?:write|save|persist)\w*\s*\([^)]*['"]\.planning\/(?:STATE|ROADMAP)\.md/,
];

export type ForbiddenWritesResult = { ok: true } | { ok: false; reason: string };

/**
 * Pure predicate: rejects when a file whose path is not the guarded module
 * matches any write pattern. The guarded module itself is allowed by
 * construction (`writeGuarded` IS the write path).
 */
export function checkForForbiddenWrites(files: GateFile[]): ForbiddenWritesResult {
	for (const file of files) {
		if (file.path === GUARDED_MODULE) continue;
		for (const pattern of WRITE_PATTERNS) {
			if (pattern.test(file.content)) {
				return {
					ok: false,
					reason: `${file.path} writes a planning file directly (matches ${pattern.source}); use src/workflow/guarded-write.ts`,
				};
			}
		}
	}
	return { ok: true };
}

// CLI mode: `bun run scripts/grep-gate.ts` scans tracked source files
// (candidates matching STATE.md/ROADMAP.md) and exits 1 on a violation.
if (import.meta.main) {
	const proc = Bun.spawnSync([
		"git",
		"grep",
		"-l",
		"--no-index",
		"-E",
		"-e",
		"STATE\\.md",
		"-e",
		"ROADMAP\\.md",
		"--",
		"*.ts",
	]);
	if (proc.success) {
		const paths = new TextDecoder().decode(proc.stdout).trim().split("\n").filter(Boolean);
		const files: GateFile[] = await Promise.all(
			paths.map(async (p: string) => ({ path: p, content: await Bun.file(p).text() })),
		);
		const result = checkForForbiddenWrites(files);
		if (!result.ok) {
			console.error(`grep-gate FAIL: ${result.reason}`);
			process.exit(1);
		}
		console.log(`grep-gate OK: ${paths.length} candidates scanned`);
	}
}
