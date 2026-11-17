// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeLookup } from "../greptile/knowledge.ts";
import { RECALL_TYPE } from "./omp-render.ts";
import { RECALL_USAGE } from "./omp.ts";
import { quietConfig, setup } from "./omp-test.helpers.ts";

const RECALL_OFF = "Recall is off: set recall.enabled to use /ultrathink-recall.";

describe("/ultrathink-recall and /ultrathink-skills", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "recall-commands-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("both commands are registered", () => {
		const { commands } = setup(undefined, 1_000, { stateDir: dir });

		expect(commands.has("ultrathink-recall")).toBe(true);
		expect(commands.has("ultrathink-skills")).toBe(true);
	});

	test("/ultrathink-skills with no arguments says there are no generated skills", async () => {
		const { command, notices } = setup(undefined, 1_000, { stateDir: dir });

		await command("ultrathink-skills", "");

		expect(notices).toEqual(["No generated skills."]);
	});

	test("/ultrathink-recall with no query shows its usage and sends nothing", async () => {
		const { command, notices, sent } = setup(undefined, 1_000, { stateDir: dir });

		await command("ultrathink-recall", "");

		expect(notices).toEqual([RECALL_USAGE]);
		expect(sent).toEqual([]);
	});

	test("/ultrathink-recall with recall off says so and sends nothing", async () => {
		const { command, notices, sent } = setup(undefined, 1_000, { stateDir: dir });

		await command("ultrathink-recall", "why does the build fail");

		expect(notices).toEqual([RECALL_OFF]);
		expect(sent).toEqual([]);
	});

	test("/ultrathink-recall with recall on sends the panels as a display-only card without a turn", async () => {
		const { command, notices, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					// Greptile stays off: no credential store or network is touched. Teachable Moments stays off too,
					// so the lessons source answers with its gate instead of reading the local store.
					config.hitl.knowledgeBase = false;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.recall.sources.lessons = true;
					config.recallSettings.recall.triggers.explicit = true;
				}),
		});

		await command("ultrathink-recall", "why does the build fail");

		expect(notices).toEqual([]);
		expect(sent).toHaveLength(1);
		const [entry] = sent;
		expect(entry?.message).toMatchObject({
			customType: RECALL_TYPE,
			display: true,
			details: { lessons: { status: "empty", reason: "gate_off" } },
		});
		expect(entry?.options).toEqual({ triggerTurn: false });
	});

	test("the explicit recall card carries the knowledge lines the reader returned", async () => {
		const marker = "KB-MARKER-7f3a9c";
		const lookup: KnowledgeLookup = {
			outcome: "used",
			repo: "acme/widgets",
			docs: [`docs/${marker}.md`],
			chars: 40,
			ms: 1,
		};
		const reads: string[] = [];
		const { command, notices, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			knowledgeReader: () => ({
				start: () => ({
					read: async (topic: string) => {
						reads.push(topic);
						return { lookup, digest: `### docs/${marker}.md\n${marker} body` };
					},
					close: () => undefined,
				}),
			}),
			config: () =>
				quietConfig((config) => {
					// The reader is injected, so no Greptile credential or network is touched. Teachable Moments stays
					// off, as in the test above, so the lessons source answers with its gate.
					config.hitl.knowledgeBase = true;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.recall.sources.knowledge = true;
					config.recallSettings.recall.triggers.explicit = true;
				}),
		});

		await command("ultrathink-recall", "why does the build fail");

		expect(notices).toEqual([]);
		expect(reads).toEqual(["why does the build fail"]);
		expect(sent).toHaveLength(1);
		// The card lists the lookup's document paths, so the marker is checked on the item title.
		const [entry] = sent;
		expect(entry?.message).toMatchObject({
			customType: RECALL_TYPE,
			display: true,
			details: {
				knowledge: {
					status: "success",
					items: [{ title: expect.stringContaining(marker) }],
				},
			},
		});
	});
});
