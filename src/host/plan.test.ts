// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedPlanEnv, quietConfig } from "./omp-test.helpers.ts";
import { planPrompt } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

describe("planPrompt guards (L6-06, L12-06)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ut-plan-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("host omp never scans the session store for a subagent: a nested session file does not skip the plan", async () => {
		const env = isolatedPlanEnv(root);
		const sessions = join(root, "agent", "sessions", "slug", "parent");
		mkdirSync(sessions, { recursive: true });
		writeFileSync(
			join(sessions, "Agent.jsonl"),
			`${JSON.stringify({ type: "session", id: "nested-session-1" })}\n`,
		);
		// The Omp extension already gates subagents with its O(1) check before it plans; planPrompt must not repeat the
		// synchronous glob+stat walk. A throwing selector makes the outcome observable: engine-error, never subagent.
		const response = await planPrompt(
			{
				host: "omp",
				session_id: "nested-session-1",
				prompt: "add a widget immediately",
				cwd: root,
			},
			{ ...env, PI_CODING_AGENT_DIR: join(root, "agent") },
			{
				config: quietConfig(),
				control: {},
				stateDir: join(root, "state"),
				selectEngine: () => {
					throw new Error("selector reached");
				},
			},
		);
		expect(response.skipped).toBe("engine-error");
	});

	test("an engine failure keeps skipped exactly engine-error while the end event names a redacted cause", async () => {
		const env = isolatedPlanEnv(root);
		const events: ProgressEvent[] = [];
		const boom = Object.assign(new TypeError("leaked Bearer sk-live-SECRET1234567890"), {
			code: "ECONNRESET",
		});
		const response = await planPrompt(
			{ host: "omp", session_id: "cause-session-1", prompt: "add a widget immediately", cwd: root },
			env,
			{
				config: quietConfig(),
				control: {},
				stateDir: join(root, "state"),
				selectEngine: () => {
					throw boom;
				},
				progress: (event) => events.push(event),
			},
		);
		expect(response.skipped).toBe("engine-error");
		const end = events.find((event) => event.type === "end");
		expect(end).toMatchObject({
			outcome: "skipped",
			detail: "engine-error (TypeError/ECONNRESET)",
		});
		expect(JSON.stringify(events)).not.toContain("SECRET");
	});
});
