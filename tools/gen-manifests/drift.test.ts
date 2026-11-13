// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildGenerated } from "./generate.ts";

const SOURCE_PATH = fileURLToPath(
	new URL("../../plugin/source/plugin.source.yaml", import.meta.url),
);
const GENERATED_PATH = fileURLToPath(new URL("../../plugin/generated", import.meta.url));

// Regenerates every verified manifest into outDir. generate.ts hardcodes its output to the repo tree and does not
// export main(), so this uses the exported buildGenerated() with the same source file and the same file layout.
function regenerate(outDir: string): void {
	const source: unknown = parse(readFileSync(SOURCE_PATH, "utf8"));
	for (const [id, content] of buildGenerated(source)) {
		mkdirSync(join(outDir, id), { recursive: true });
		writeFileSync(join(outDir, id, "manifest.json"), content);
	}
}

function readTree(root: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	for (const rel of readdirSync(root, { recursive: true, encoding: "utf8" })) {
		const full = join(root, rel);
		if (statSync(full).isFile()) files.set(rel, readFileSync(full));
	}
	return files;
}

// Mirrors the CI "Manifest drift" step (`git diff --exit-code -- plugin/generated` plus
// `git status --porcelain -- plugin/generated`): returns every path that is missing on either side or whose bytes differ.
function driftedFiles(committed: string, regenerated: string): string[] {
	const left = readTree(committed);
	const right = readTree(regenerated);
	const paths = new Set([...left.keys(), ...right.keys()]);
	return [...paths].sort().filter((rel) => {
		const a = left.get(rel);
		const b = right.get(rel);
		return a === undefined || b === undefined || !a.equals(b);
	});
}

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "ultrathink-manifest-drift-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function committedCopy(): string {
	const dir = join(scratch, "committed");
	cpSync(GENERATED_PATH, dir, { recursive: true });
	return dir;
}

function regeneratedDir(): string {
	const dir = join(scratch, "regenerated");
	mkdirSync(dir);
	regenerate(dir);
	return dir;
}

describe("manifest drift check (mirrors the CI 'Manifest drift' step)", () => {
	test("an unmodified copy of plugin/generated reports no drift", () => {
		expect(driftedFiles(committedCopy(), regeneratedDir())).toEqual([]);
	});

	test("a seeded content divergence in one manifest is reported by its path", () => {
		const committed = committedCopy();
		const target = join(committed, "omp", "manifest.json");
		const original = readFileSync(target, "utf8");
		const manifest = JSON.parse(original) as Record<string, unknown>;
		manifest.description = "seeded divergence";
		const seeded = `${JSON.stringify(manifest, null, 2)}\n`;
		expect(seeded).not.toBe(original);
		writeFileSync(target, seeded);

		expect(driftedFiles(committed, regeneratedDir())).toEqual([join("omp", "manifest.json")]);
	});

	test("a stale manifest for a host that is no longer verified is reported by its path", () => {
		const committed = committedCopy();
		mkdirSync(join(committed, "grok-build"));
		writeFileSync(join(committed, "grok-build", "manifest.json"), "{}\n");

		expect(driftedFiles(committed, regeneratedDir())).toEqual([
			join("grok-build", "manifest.json"),
		]);
	});
});
