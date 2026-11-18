// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LockTimeoutError } from "../claude/atomic.ts";
import {
	createJournalCompleter,
	journalDir,
	listPending,
	readMeta,
	runGrokbotPlan,
	storeAnswer,
} from "./grokbot.ts";

const PROMPT =
	"Build a small TypeScript CLI that converts CSV files to JSON with streaming support, tests and a README.";
const OTHER_PROMPT =
	"Build a small Rust service that mirrors S3 buckets into a local cache with retries and metrics.";
/** A planner request whose system prompt is none of the known stage constants. */
const UNKNOWN_SYSTEM = "You are a desk helper for a planner stage this host does not recognise.";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-grokbot-session-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testEnv = (root: string): Record<string, string | undefined> => ({
	HOME: root,
	XDG_CONFIG_HOME: join(root, "xdg"),
	ULTRATHINK_DECISIONS: "0",
	PATH: process.env.PATH,
});

/** A lock wait that gives up at once: the holder is a live process, so the lock is never taken. */
const heldLockWait = {
	timeoutMs: 0,
	onTimeout: "throw" as const,
	staleMs: Number.MAX_SAFE_INTEGER,
	liveness: { killAlive: () => true },
};

describe("grok-bot session hardening", () => {
	test("two plans for one session with different prompts cannot both record their original", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const dir = journalDir(stateDir, "s1");
		// A live holder keeps the session lock: the plan with another prompt must not record its original before it holds the lock.
		const lock = join(stateDir, "sessions", "s1.json.lock");
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: "", token: "held" }));
		await expect(
			runGrokbotPlan({
				sessionId: "s1",
				prompt: OTHER_PROMPT,
				cwd: root,
				stateDir,
				env: testEnv(root),
				debounceMs: 5,
				lock: heldLockWait,
			}),
		).rejects.toBeInstanceOf(LockTimeoutError);
		expect(readMeta(dir)).toBeUndefined();
		rmSync(lock, { force: true });
		await runGrokbotPlan({
			sessionId: "s1",
			prompt: PROMPT,
			cwd: root,
			stateDir,
			env: testEnv(root),
			debounceMs: 5,
		});
		expect(readMeta(dir)?.original).toBe(PROMPT);
		await expect(
			runGrokbotPlan({
				sessionId: "s1",
				prompt: OTHER_PROMPT,
				cwd: root,
				stateDir,
				env: testEnv(root),
				debounceMs: 5,
			}),
		).rejects.toThrow(/different original prompt/);
		expect(readMeta(dir)?.original).toBe(PROMPT);
	});

	test("an answer for an unrecognised stage is rejected and never stored", async () => {
		const root = tmp();
		const dir = journalDir(join(root, "state"), "s1");
		await expect(
			createJournalCompleter({ dir }).complete(UNKNOWN_SYSTEM, "payload"),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		const [request] = listPending(dir);
		expect(request?.stage).toBe("other");
		const refused = storeAnswer(dir, request!.key, "a free-text answer");
		expect(refused.ok).toBe(false);
		expect(refused.errors.join()).toMatch(/unrecognised request/);
		expect(existsSync(join(dir, "answers"))).toBe(false);
		expect(listPending(dir)).toHaveLength(1);
	});

	test("a stored answer for an unrecognised stage is not replayed", async () => {
		const root = tmp();
		const dir = journalDir(join(root, "state"), "s1");
		await expect(
			createJournalCompleter({ dir }).complete(UNKNOWN_SYSTEM, "payload"),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		const [request] = listPending(dir);
		mkdirSync(join(dir, "answers"), { recursive: true });
		writeFileSync(join(dir, "answers", `${request!.key}.txt`), "a stale answer");
		const journal = createJournalCompleter({ dir });
		await expect(journal.complete(UNKNOWN_SYSTEM, "payload")).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(journal.replayed()).toBe(0);
		expect(journal.missed()).toHaveLength(1);
	});
});
