// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnowledgeLookup } from "../greptile/knowledge.ts";
import { moment } from "../test.helpers.ts";
import { projectOf } from "../teach/mapping.ts";
import { teachContext as realTeachContext, type TeachContextOptions } from "../teach/context.ts";
import { openStore, storeDir } from "../teach/store.ts";
import { type AutoSkill, contentHashOf } from "../teach/skill-author.ts";
import { writeGeneratedSkill } from "../teach/skill-store.ts";
import { visibleWidth } from "./omp-paint.ts";
import { RECALL_TYPE } from "./omp-render.ts";
import { RECALL_USAGE } from "./omp.ts";
import { quietConfig, setup } from "./omp-test.helpers.ts";

const RECALL_OFF = "Recall is off: set recall.enabled to use /ultrathink-recall.";

/** Plain text: colours and emphasis are dropped, so each row's visible width is the width it is drawn at. */
const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

/** Yields once to the event loop. The automatic triggers run on promise chains only, so one yield lets them finish. */
async function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

/**
 * Writes one generated skill whose only trigger is `error`, with no scope restriction, then activates it as the store
 * does for an accepted skill. The skill is in the manifest and its SKILL.md is on disk, so the keyed lookup can read it.
 */
async function activeSkillFor(stateDir: string, error: string): Promise<AutoSkill> {
	const at = "2026-11-01T00:00:00.000Z";
	const draft: AutoSkill = {
		name: "eacces-permission-denied",
		description: "Check the owner and mode of the path before retrying the write.",
		applies_when: { task_types: ["bash-run"], scope_globs: [], error_signatures: [error] },
		steps: ["Check the owner and mode of the path before retrying the write."],
		source_ids: ["moment-1"],
		generated_by: "auto",
		generated_at: at,
		content_hash: "",
		version: 1,
		status: "draft",
		signature_hash: "0123456789abcdef0123456789abcdef",
		stale: false,
		warnings: [],
	};
	const skill: AutoSkill = { ...draft, content_hash: contentHashOf(draft) };
	const storeRoot = join(stateDir, "generated-skills");
	expect(await writeGeneratedSkill(storeRoot, skill, at)).toMatchObject({ ok: true });
	// The store never sets `active` (setGeneratedStatus takes draft or disabled), so the fixture edits the manifest directly.
	const manifest = join(storeRoot, "manifest.json");
	const raw = JSON.parse(readFileSync(manifest, "utf8")) as {
		skills: { name: string; status: string }[];
	};
	for (const entry of raw.skills) if (entry.name === skill.name) entry.status = "active";
	writeFileSync(manifest, JSON.stringify(raw));
	return skill;
}

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

	/**
	 * A recall-on prompt answered by an injected knowledge reader: the card holds a lessons panel that gate_off left
	 * empty and a knowledge panel that succeeded. Returns a renderer of the sent card's details at a given width.
	 */
	async function recallOnCard() {
		const lookup: KnowledgeLookup = {
			outcome: "used",
			repo: "acme/widgets",
			docs: ["docs/KB-MARKER-7f3a9c.md"],
			chars: 40,
			ms: 1,
		};
		const harness = setup(undefined, 1_000, {
			stateDir: dir,
			knowledgeReader: () => ({
				start: () => ({
					read: async () => ({
						lookup,
						digest: "### docs/KB-MARKER-7f3a9c.md\nKB-MARKER-7f3a9c body",
					}),
					close: () => undefined,
				}),
			}),
			config: () =>
				quietConfig((config) => {
					// The reader is injected, so no Greptile credential or network is touched. Teachable Moments stays off.
					config.hitl.knowledgeBase = true;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.recall.sources.knowledge = true;
					config.recallSettings.recall.sources.lessons = true;
					config.recallSettings.recall.triggers.explicit = true;
				}),
		});

		await harness.command("ultrathink-recall", "why does the build fail");

		const [entry] = harness.sent;
		expect(entry?.message).toMatchObject({ customType: RECALL_TYPE, display: true });
		const renderFn = harness.renderFns.get(RECALL_TYPE);
		const details = (entry?.message as { details?: unknown } | undefined)?.details;
		return (width: number) =>
			renderFn?.({ content: "", details }, { expanded: false }, PLAIN_THEME)?.render(width) ?? [];
	}

	test("the recall card keeps every row within 60 columns and shows the gate_off and knowledge labels", async () => {
		const renderAt = await recallOnCard();

		const rows = renderAt(60);

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(60);
		const text = rows.join("\n");
		expect(text).toContain("reason: gate_off");
		expect(text).toContain("[SUCCESS]");
	});

	test("the recall card keeps every row within 6 columns", async () => {
		const renderAt = await recallOnCard();

		const rows = renderAt(6);

		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(6);
	});

	test("a second /ultrathink-recall in one session sees the first call's session counters", async () => {
		const { command, sent, emit } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					// Greptile stays off and Teachable Moments stays off: the lessons source answers with its gate.
					config.hitl.knowledgeBase = false;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.recall.sources.lessons = true;
					config.recallSettings.recall.triggers.explicit = true;
					config.recallSettings.recall.budget.perSessionCalls = 1;
				}),
		});

		await command("ultrathink-recall", "why does the build fail");
		// A new turn resets the turn counters; the session counters must still carry the first call.
		emit("turn_start");
		await command("ultrathink-recall", "why does the build fail");

		expect(sent).toHaveLength(2);
		expect(sent[0]?.message).toMatchObject({ content: expect.stringContaining("lessons fired") });
		expect(sent[1]?.message).toMatchObject({
			content: expect.stringContaining("lessons skipped_budget"),
		});
		const second = sent[1]?.message as { details: Record<string, unknown> };
		expect(second.details).not.toHaveProperty("lessons");
	});

	test("with the master switch off, turns, tool errors and the command stay silent", async () => {
		const { command, emit, notices, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					config.recallSettings.panels.informationPanels = true;
					config.recallSettings.recall.sources.lessons = true;
					config.recallSettings.recall.triggers.failure = true;
					config.recallSettings.recall.triggers.scopeChange = true;
				}),
		});
		const repoA = { cwd: "/no/such/repo-a", sessionManager: { getSessionId: () => "s1" } };
		const repoB = { cwd: "/no/such/repo-b", sessionManager: { getSessionId: () => "s1" } };
		const error = {
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "boom" }],
			isError: true,
		};

		emit("turn_start", {}, repoA);
		emit("turn_start", {}, repoB);
		emit("tool_result", error);
		await command("ultrathink-recall", "why does the build fail");
		await settle();

		expect(notices).toEqual([RECALL_OFF]);
		expect(sent).toEqual([]);
	});

	test("a repository change on a new turn sends a scope-change card when the gates are open", async () => {
		const { emit, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					config.hitl.knowledgeBase = false;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.panels.informationPanels = true;
					config.recallSettings.recall.sources.lessons = true;
					config.recallSettings.recall.triggers.scopeChange = true;
				}),
		});
		const repoA = { cwd: "/no/such/repo-a", sessionManager: { getSessionId: () => "s1" } };
		const repoB = { cwd: "/no/such/repo-b", sessionManager: { getSessionId: () => "s1" } };

		// The first turn only records its repository; the second one differs and fires.
		emit("turn_start", {}, repoA);
		emit("turn_start", {}, repoB);
		await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toMatchObject({
			customType: RECALL_TYPE,
			display: true,
			content: "Recall (scopeChange): knowledge skipped_disabled, lessons fired",
		});
	});

	test("a repeated tool error recalls lessons first and teachable moments on its second occurrence", async () => {
		const { emit, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					config.hitl.knowledgeBase = false;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.panels.informationPanels = true;
					config.recallSettings.recall.sources.lessons = true;
					config.recallSettings.recall.sources.moments = true;
					config.recallSettings.recall.triggers.failure = true;
				}),
		});
		const error = {
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "exit 1: boom" }],
			isError: true,
		};

		emit("tool_result", error);
		await settle();
		// The next agent turn: occurrence one spent this turn's routine recall, so occurrence two needs a new turn's budget.
		emit("turn_start");
		emit("tool_result", error);
		await settle();

		expect(sent).toHaveLength(2);
		expect(sent[0]?.message).toMatchObject({
			content: "Recall (failure): lessons fired, skills skipped_disabled",
		});
		expect(sent[1]?.message).toMatchObject({
			content: "Recall (failure): moments fired, skills skipped_disabled",
		});
	});

	test("a repeated tool error's second occurrence injects the teachable moments the store holds for it", async () => {
		const repo = { cwd: "/no/such/repo-moments", sessionManager: { getSessionId: () => "s1" } };
		const { emit, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					config.hitl.knowledgeBase = false;
					config.teach.enabled = true;
					config.teach.recall = true;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.panels.informationPanels = true;
					// Lessons stay off, so occurrence one plans nothing and occurrence two is the moments source alone.
					config.recallSettings.recall.sources.lessons = false;
					config.recallSettings.recall.sources.moments = true;
					config.recallSettings.recall.triggers.failure = true;
				}),
			teachContext: (input: TeachContextOptions) => realTeachContext({ ...input, stateDir: dir }),
		});
		openStore(storeDir(dir)).put(
			moment("m1", { name: "exit 1 boom: rerun the build", project: projectOf(repo.cwd) }),
		);
		const error = {
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "exit 1: boom" }],
			isError: true,
		};

		// The recall chain reads the store between event-loop turns, so each occurrence gets several turns to settle.
		emit("tool_result", error, repo);
		for (let turn = 0; turn < 20; turn += 1) await settle();
		emit("tool_result", error, repo);
		for (let turn = 0; turn < 20; turn += 1) await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toMatchObject({
			content: "Recall (failure): moments fired, skills skipped_disabled",
			details: {
				moments: { items: [{ title: "exit 1 boom: rerun the build", itemStatus: "injected" }] },
			},
		});
	});

	test("a failure whose error matches an active generated skill shows that skill as injected", async () => {
		const repo = { cwd: "/no/such/repo-skills", sessionManager: { getSessionId: () => "s1" } };
		const { emit, sent } = setup(undefined, 1_000, {
			stateDir: dir,
			config: () =>
				quietConfig((config) => {
					config.hitl.knowledgeBase = false;
					config.teach.enabled = true;
					config.teach.recall = true;
					config.recallSettings.recall.enabled = true;
					config.recallSettings.panels.informationPanels = true;
					// Lessons stay off, so the card carries the skills source alone.
					config.recallSettings.recall.sources.lessons = false;
					config.recallSettings.recall.sources.skills = true;
					config.recallSettings.recall.triggers.failure = true;
				}),
			teachContext: (input: TeachContextOptions) => realTeachContext({ ...input, stateDir: dir }),
		});
		const skill = await activeSkillFor(dir, "EACCES: permission denied");
		const error = {
			toolName: "bash",
			input: {},
			content: [{ type: "text", text: "EACCES: permission denied" }],
			isError: true,
		};

		emit("tool_result", error, repo);
		// The skills lookup reads the generated manifest and the skill file from disk, so the card lands after real I/O
		// rather than after a fixed number of event-loop turns. Yield until it lands, bounded well past the lookup's timeout.
		for (let turn = 0; turn < 10_000 && sent.length === 0; turn += 1) await settle();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toMatchObject({
			content: "Recall (failure): lessons skipped_disabled, skills fired",
			details: { skills: { items: [{ title: skill.name, itemStatus: "injected" }] } },
		});
	});
});
