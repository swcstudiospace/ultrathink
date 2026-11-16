// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type CompleteFn,
	clearProjectFactsCache,
	generatePrd,
	getProjectFacts,
	type PrdRequest,
	renderFallbackPrd,
	runTot,
	validatePrd,
} from "./index.ts";

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

describe("ToT stage end to end", () => {
	test("inspects the project once, writes grounded PRDs, and checkpoints them", async () => {
		const project = makeDir("ut-tot-e2e-project-");
		for (const [path, content] of [
			["src/app.ts", "export function runApp() {}\n"],
			[".env", "API_KEY=do-not-leak\n"],
		] as const) {
			mkdirSync(dirname(join(project, path)), { recursive: true });
			writeFileSync(join(project, path), content);
		}
		const facts = await getProjectFacts(project);
		expect(await getProjectFacts(project)).toBe(facts);

		const complete: CompleteFn = async ({ user }) => {
			expect(user).not.toContain("do-not-leak");
			return JSON.stringify({
				objective: "Wire the runner.",
				acceptanceCriteria: ["It runs"],
				affectedFiles: [{ path: "src/app.ts" }, { path: ".env" }],
				interfaces: [{ signature: "function runApp(): void", symbol: "runApp" }],
				implementation: [{ language: "ts", code: "runApp();", references: ["runApp"] }],
				testSkeleton: { language: "ts", code: "test('x', () => {});" },
				assumptions: [],
			});
		};
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
					facts,
					signal,
					fallback: (req) => renderFallbackPrd(req),
				}),
		});
		expect(manifest).toMatchObject({ total: 3, generated: 3, failed: 0, fallbacks: 0 });
		for (const record of manifest.records) {
			expect(validatePrd(record.markdown, { key: record.key })).toEqual([]);
			expect(record.markdown).toContain("- `src/app.ts` [verified]");
			// .env is on the deny-list, so it can never be verified.
			expect(record.markdown).toContain("- `.env` [assumption]");
			expect(record.markdown).toContain("```ts verified\nrunApp();\n```");
		}
	});
});
