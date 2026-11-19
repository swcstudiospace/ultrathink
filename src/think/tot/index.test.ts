// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CompleteFn,
	generatePrd,
	type PrdRequest,
	renderFallbackPrd,
	runTot,
	validatePrd,
} from "./index.ts";

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
	const dir = mkdtempSync(join(homedir(), prefix));
	made.push(dir);
	return dir;
}

describe("ToT stage end to end", () => {
	test("generates valid PRDs with the selected model and checkpoints them", async () => {
		const complete: CompleteFn = async () =>
			JSON.stringify({
				objective: "Wire the runner.",
				acceptanceCriteria: ["It runs"],
				affectedFiles: [{ path: "src/app.ts" }],
				interfaces: [{ signature: "function runApp(): void", symbol: "runApp" }],
				implementation: [{ language: "ts", code: "runApp();", references: ["runApp"] }],
				testSkeleton: { language: "ts", code: "test('x', () => {});" },
				assumptions: [],
			});
		const requests: PrdRequest[] = [1, 2, 3].map((n) => ({
			key: `n${n}.1`,
			graphId: "ut-g1",
			nodeId: `n${n}`,
			step: 1,
			title: `Step ${n}`,
			thought: `Do thing ${n}`,
		}));
		const manifest = await runTot({
			requests,
			checkpointDir: makeDir("ut-tot-e2e-run-"),
			generate: (request, signal) =>
				generatePrd(request, {
					complete,
					modelId: "m-1",
					signal,
					fallback: (req) => renderFallbackPrd(req),
				}),
		});
		expect(manifest).toMatchObject({ total: 3, generated: 3, failed: 0, fallbacks: 0 });
		for (const record of manifest.records) {
			expect(validatePrd(record.markdown, { key: record.key })).toEqual([]);
		}
	});
});
