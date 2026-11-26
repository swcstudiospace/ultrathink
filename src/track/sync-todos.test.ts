// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Producer-side `syncTodos(plan)` (SPE-37792): wave todos, completion marker, retry-once. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession, type SessionRecord, updateSession, writeSession } from "../claude/state.ts";
import { isSyncTodosDone, planWaves, syncTodos, waveTodos } from "./sync-todos.ts";
import type { TrackPlan } from "./types.ts";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-sync-todos-"));
	dirs.push(dir);
	return dir;
}

function plan(overrides: Partial<TrackPlan> = {}): TrackPlan {
	return {
		graphId: "ut-test-sync",
		task: {
			graphId: "ut-test-sync",
			item: "Fix the login redirect",
			description: "desc",
			upliftedPrompt: "prompt",
			agent: "claude-code",
			status: "Todo",
			linearState: "Todo",
		},
		issues: [
			{ graphId: "ut-test-sync", nodeId: "n1", item: "First", thought: "t" },
			{ graphId: "ut-test-sync", nodeId: "n2", item: "Second", thought: "t" },
			{ graphId: "ut-test-sync", nodeId: "n3", item: "Third", thought: "t" },
		],
		subIssues: [],
		linearIssues: [],
		linearSubIssues: [],
		hitl: { blocking: [], nonBlocking: [] },
		...overrides,
	};
}

function seedRecord(dir: string, graphId = "ut-test-sync"): void {
	const record: SessionRecord = {
		sessionId: "s1",
		at: 0,
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
		plan: plan({ graphId }),
	};
	writeSession(dir, record);
}

describe("planWaves", () => {
	test("groups nodes by dependency depth with parallel flag", () => {
		const waves = planWaves(plan({ dependencies: { n2: ["n1"], n3: ["n1"] } }));
		expect(waves).toEqual([
			{ wave: 1, parallel: false, ids: ["n1"] },
			{ wave: 2, parallel: true, ids: ["n2", "n3"] },
		]);
	});

	test("no dependencies means a single parallel wave", () => {
		const waves = planWaves(plan());
		expect(waves).toEqual([{ wave: 1, parallel: true, ids: ["n1", "n2", "n3"] }]);
	});

	test("unknown and cyclic dependencies degrade to wave 1 and never hang", () => {
		const waves = planWaves(plan({ dependencies: { n1: ["missing"], n2: ["n2"], n3: ["n1"] } }));
		const ids = waves.flatMap((wave) => wave.ids);
		expect(ids.sort()).toEqual(["n1", "n2", "n3"]);
	});
});

describe("waveTodos", () => {
	test("first wave in progress, later waves pending, activeForm names the wave", () => {
		const todos = waveTodos([
			{ wave: 1, parallel: false, ids: ["n1"] },
			{ wave: 2, parallel: true, ids: ["n2", "n3"] },
		]);
		expect(todos).toEqual([
			{ content: "Wave 1: n1", status: "in_progress", activeForm: "Wave 1 n1" },
			{ content: "Wave 2: n2, n3 (parallel)", status: "pending", activeForm: "Wave 2 n2, n3" },
		]);
	});
});

describe("syncTodos", () => {
	test("persists wave todos and marks the invocation done in session state", () => {
		const dir = stateDir();
		seedRecord(dir);
		const result = syncTodos(plan({ dependencies: { n2: ["n1"], n3: ["n1"] } }), {
			stateDir: dir,
			sessionId: "s1",
			now: () => 42,
		});
		expect(result.ok).toBe(true);
		expect(result.attempts).toBe(1);
		expect(result.waves).toHaveLength(2);
		expect(result.todos).toHaveLength(2);
		const persisted = readSession(dir, "s1");
		expect(persisted?.recall?.lastTodos).toEqual(result.todos);
		expect(persisted?.syncTodos).toEqual({
			graphId: "ut-test-sync",
			at: 42,
			waveCount: 2,
			todoCount: 2,
			attempts: 1,
		});
		expect(isSyncTodosDone(persisted, "ut-test-sync")).toBe(true);
		expect(isSyncTodosDone(persisted, "other-graph")).toBe(false);
	});

	test("retries once on a failing write and succeeds on the second attempt", () => {
		const dir = stateDir();
		seedRecord(dir);
		let calls = 0;
		const result = syncTodos(plan({ dependencies: { n2: ["n1"], n3: ["n1"] } }), {
			stateDir: dir,
			sessionId: "s1",
			now: () => 42,
			update: ((d: string, id: string, mutate: never, lock: never) => {
				calls++;
				if (calls === 1) throw new Error("boom");
				return updateSession(d, id, mutate, lock);
			}) as never,
		});
		expect(calls).toBe(2);
		expect(result.ok).toBe(true);
		expect(result.attempts).toBe(2);
		const persisted = readSession(dir, "s1");
		expect(persisted?.syncTodos?.attempts).toBe(2);
		expect(persisted?.recall?.lastTodos).toEqual(result.todos);
	});

	test("a failing write twice logs and reports, never throws", () => {
		const dir = stateDir();
		seedRecord(dir);
		const logs: string[] = [];
		const result = syncTodos(plan(), {
			stateDir: dir,
			sessionId: "s1",
			log: (message) => logs.push(message),
			update: (() => {
				throw new Error("disk down");
			}) as never,
		});
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(2);
		expect(result.error).toBe("disk down");
		expect(logs).toHaveLength(2);
		expect(isSyncTodosDone(readSession(dir, "s1"), "ut-test-sync")).toBe(false);
	});

	test("a missing session record fails without throwing", () => {
		const dir = stateDir();
		const result = syncTodos(plan(), { stateDir: dir, sessionId: "ghost" });
		expect(result.ok).toBe(false);
		expect(result.error).toContain("session record missing");
	});

	test("a record holding another plan is left untouched", () => {
		const dir = stateDir();
		seedRecord(dir, "ut-other");
		const result = syncTodos(plan(), { stateDir: dir, sessionId: "s1" });
		expect(result.ok).toBe(false);
		const persisted = readSession(dir, "s1");
		expect(persisted?.plan?.graphId).toBe("ut-other");
		expect(persisted?.syncTodos).toBeUndefined();
		expect(persisted?.recall?.lastTodos).toBeUndefined();
	});
});
