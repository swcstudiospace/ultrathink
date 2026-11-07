// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armSkipOnce, type ControlState, readSkipOnce } from "../claude/state.ts";
import { isolatedPlanEnv, quietConfig } from "./omp-test.helpers.ts";
import { planPrompt, wouldSkipPlanning } from "./plan.ts";
import { readPlanCarrier, writePlanCarrier } from "./carrier.ts";
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

	test("a prompt over uplift.maxChars is skipped before an engine is selected, and the summary names the limit", async () => {
		const config = quietConfig();
		config.uplift.maxChars = 10;
		const response = await planPrompt(
			{
				host: "omp",
				session_id: "over-limit-session",
				prompt: "add a widget immediately",
				cwd: root,
			},
			isolatedPlanEnv(root),
			{
				config,
				control: {},
				stateDir: join(root, "state"),
				selectEngine: () => {
					throw new Error("selector reached");
				},
			},
		);
		expect(response.skipped).toBe("precheck-over-max-chars");
		expect(response.summary).toContain("uplift.maxChars");
	});

	test("a precheck skip clears the session's plan carrier, so a turn without a plan never inherits the previous prompt's", async () => {
		const env = isolatedPlanEnv(root);
		const stateDir = join(root, "state");
		writePlanCarrier({
			host: "omp",
			stateDir,
			sessionId: "carrier-session",
			context: "plan of the last prompt",
		});
		expect(readPlanCarrier(stateDir, "carrier-session")?.context).toBe("plan of the last prompt");
		const response = await planPrompt(
			{ host: "omp", session_id: "carrier-session", prompt: "ok", cwd: root },
			env,
			{
				config: quietConfig(),
				control: {},
				stateDir,
				selectEngine: () => {
					throw new Error("selector reached");
				},
			},
		);
		expect(response.skipped).toBe("precheck-trivial");
		expect(readPlanCarrier(stateDir, "carrier-session")).toBeUndefined();
	});

	test("an engine failure clears the session's carrier too: a turn that plans nothing inherits nothing", async () => {
		const env = isolatedPlanEnv(root);
		const stateDir = join(root, "state");
		writePlanCarrier({
			host: "omp",
			stateDir,
			sessionId: "engine-session",
			context: "plan of the last prompt",
		});
		const response = await planPrompt(
			{ host: "omp", session_id: "engine-session", prompt: "add a widget immediately", cwd: root },
			env,
			{
				config: quietConfig(),
				control: {},
				stateDir,
				selectEngine: () => {
					throw new Error("engine down");
				},
			},
		);
		expect(response.skipped).toBe("engine-error");
		expect(readPlanCarrier(stateDir, "engine-session")).toBeUndefined();
	});

	test("a cancelled turn leaves the carrier alone: a newer prompt in the session may already own it", async () => {
		const env = isolatedPlanEnv(root);
		const stateDir = join(root, "state");
		writePlanCarrier({
			host: "omp",
			stateDir,
			sessionId: "cancel-session",
			context: "plan of the last prompt",
		});
		const controller = new AbortController();
		controller.abort();
		const response = await planPrompt(
			{ host: "omp", session_id: "cancel-session", prompt: "add a widget immediately", cwd: root },
			env,
			{
				config: quietConfig(),
				control: {},
				stateDir,
				signal: controller.signal,
				selectEngine: () => {
					throw new Error("selector reached");
				},
			},
		);
		expect(response.skipped).toBe("aborted");
		expect(readPlanCarrier(stateDir, "cancel-session")?.context).toBe("plan of the last prompt");
	});
});

describe("wouldSkipPlanning (the Omp follow-up precheck)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ut-would-skip-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const wouldSkip = (prompt: string, control: ControlState = {}): boolean =>
		wouldSkipPlanning(
			{ host: "omp", session_id: "follow-up-session", prompt, cwd: root },
			{ env: isolatedPlanEnv(root), config: quietConfig(), control, stateDir: join(root, "state") },
		);

	test.each(["/ultrathink-status", "continue", "ok"])(
		"a follow-up the planner skips (%s) reports skip, so it keeps a running plan alive",
		(prompt) => {
			expect(wouldSkip(prompt)).toBe(true);
		},
	);

	test("a plannable follow-up reports that it would plan", () => {
		expect(wouldSkip("add a widget immediately")).toBe(false);
	});

	test("planning turned off skips even a plannable follow-up", () => {
		expect(wouldSkip("add a widget immediately", { enabled: false })).toBe(true);
	});

	test("a follow-up over uplift.maxChars reports skip: it would run unplanned, so a running plan is kept", () => {
		const config = quietConfig();
		config.uplift.maxChars = 10;
		expect(
			wouldSkipPlanning(
				{
					host: "omp",
					session_id: "follow-up-session",
					prompt: "add a widget immediately",
					cwd: root,
				},
				{ env: isolatedPlanEnv(root), config, control: {}, stateDir: join(root, "state") },
			),
		).toBe(true);
	});

	test("an armed skip is neither consumed nor a skip here: the flight starts and the real run consumes it", () => {
		const stateDir = join(root, "state");
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		armSkipOnce(stateDir, "follow-up-session");
		expect(wouldSkip("add a widget immediately")).toBe(false);
		expect(readSkipOnce(stateDir, "follow-up-session")).toBe(true);
	});

	test("an unreadable control fails open: the prompt counts as plannable", () => {
		const control = {
			get enabled(): boolean {
				throw new Error("unreadable control");
			},
		} as ControlState;
		expect(wouldSkip("add a widget immediately", control)).toBe(false);
	});
});
