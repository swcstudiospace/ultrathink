// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLIFT } from "../test.helpers.ts";
import { TEST_STATE_DIR_PREFIX } from "../test.state-dir.ts";
import { loadPlan, planKey, savePlan } from "./plan-store.ts";
import { flush, setup } from "./omp-test.helpers.ts";

const roots: string[] = [];
const newRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), TEST_STATE_DIR_PREFIX));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The model-facing text of a before_agent_start result; undefined when the handler returned nothing. */
const textOf = (result: unknown): string | undefined => {
	if (typeof result !== "object" || result === null || !("message" in result)) return undefined;
	const { message } = result;
	if (typeof message === "string") return message;
	if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
	return typeof message.content === "string" ? message.content : undefined;
};

/** A planner whose answer depends on the call number; an Error answer rejects the call. */
const counting = (answer: (call: number) => string | Error) => {
	let calls = 0;
	const plan = async (): Promise<string> => {
		calls++;
		const reply = answer(calls);
		if (reply instanceof Error) throw reply;
		return reply;
	};
	return { plan, count: () => calls };
};

/** A planner that makes a skip: no plan, and the reason the planner reports. */
const skipping = (reason: string) => {
	let calls = 0;
	const plan = async () => {
		calls++;
		return { context: "", skipped: reason };
	};
	return { plan, count: () => calls };
};

/** The record key the prompt "do it" in session "s1" at cwd "/repo" is stored under. */
const KEY = planKey({ sessionId: "s1", submission: "0", prompt: "do it", cwd: "/repo" });
/** A record written after the extension instance starts; only such records are recovered. */
const LATER = new Date(Date.now() + 60_000).toISOString();

describe("omp delivery when planning does not produce a plan", () => {
	test("a failed planner is relaunched up to three times and the retry plan is delivered inline", async () => {
		const planner = counting((call) => (call === 1 ? "" : UPLIFT("do it")));
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		expect(textOf(await run("do it"))).toBe(UPLIFT("do it"));
		expect(planner.count()).toBe(2);
	});

	test("a planner that fails three times delivers the notice, never nothing", async () => {
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		const text = textOf(await run("do it"));
		expect(text).toBeDefined();
		expect(text).toContain("stopped planning");
		expect(planner.count()).toBe(4);
	});

	test("a planner that throws delivers the notice and carries the error into it after three relaunches", async () => {
		const planner = counting(() => new Error("boom"));
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		const text = textOf(await run("do it"));
		expect(text).toContain("stopped planning");
		expect(text).toContain("boom");
		expect(planner.count()).toBe(4);
	});

	test("a stored plan that never reached the model is re-delivered once", async () => {
		const root = newRoot();
		savePlan(root, { key: KEY, text: UPLIFT("do it", "stored"), view: null, createdAt: LATER });
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: root });
		expect(textOf(await run("do it"))).toBe(UPLIFT("do it", "stored"));
		expect(loadPlan(root, KEY)).toBe("absent");
		expect(await run("do it")).toBeUndefined();
	});

	test("a plan delivered inline is claimed, so a fresh host's fallback does not deliver it again", async () => {
		const root = newRoot();
		const delivered = UPLIFT("do it", "delivered inline");
		const first = setup(async () => delivered, 1_000, { stateDir: root });
		expect(textOf(await first.run("do it"))).toBe(delivered);
		expect(loadPlan(root, KEY)).toBe("absent");
		// A fresh host has no flight for this submission, so its planner fails and the store is the only fallback.
		const fallback = setup(counting(() => "").plan, 1_000, { stateDir: root });
		const text = textOf(await fallback.run("do it"));
		expect(text).not.toBe(delivered);
		expect(text).toContain("stopped planning");
	});

	test("a record saved with a null view loads with that view and re-delivers its text", async () => {
		const root = newRoot();
		const text = UPLIFT("do it", "null view");
		savePlan(root, { key: KEY, text, view: null, createdAt: LATER });
		expect(loadPlan(root, KEY)).toMatchObject({ key: KEY, text, view: null });
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: root });
		expect(textOf(await run("do it"))).toBe(text);
	});

	test("a corrupt stored record warns that it could not be read and does not block a valid one", async () => {
		const root = newRoot();
		mkdirSync(join(root, "plans"), { recursive: true });
		writeFileSync(join(root, "plans", `${KEY}.json`), "{not json");
		const corrupt = setup(counting(() => "").plan, 1_000, { stateDir: root });
		const warned = textOf(await corrupt.run("do it"));
		expect(warned).toContain("could not read the stored plan");
		expect(loadPlan(root, KEY)).toBe("unreadable");
		// Control: a valid record under another key, in the same store, is still recovered.
		const otherKey = planKey({
			sessionId: "s1",
			submission: "0",
			prompt: "other prompt",
			cwd: "/repo",
		});
		savePlan(root, {
			key: otherKey,
			text: UPLIFT("other prompt", "control"),
			view: null,
			createdAt: LATER,
		});
		const control = setup(counting(() => "").plan, 1_000, { stateDir: root });
		expect(textOf(await control.run("other prompt"))).toBe(UPLIFT("other prompt", "control"));
	});

	test("a stored plan is not recovered by another session", async () => {
		const root = newRoot();
		savePlan(root, {
			key: KEY,
			text: UPLIFT("do it", "other session"),
			view: null,
			createdAt: LATER,
		});
		const planner = counting(() => "");
		const { run } = setup(
			planner.plan,
			1_000,
			{ stateDir: root },
			{
				sessionManager: { getSessionId: () => "s2" },
			},
		);
		expect(textOf(await run("do it"))).toContain("stopped planning");
		expect(typeof loadPlan(root, KEY)).toBe("object");
	});

	test("a session with no id never touches the store", async () => {
		const root = newRoot();
		const emptyKey = planKey({ sessionId: "", submission: "0", prompt: "do it", cwd: "/repo" });
		savePlan(root, { key: emptyKey, text: UPLIFT("do it", "empty"), view: null, createdAt: LATER });
		const planner = counting(() => "");
		const { run } = setup(
			planner.plan,
			1_000,
			{ stateDir: root },
			{
				sessionManager: { getSessionId: () => "" },
			},
		);
		expect(textOf(await run("do it"))).toContain("stopped planning");
		expect(typeof loadPlan(root, emptyKey)).toBe("object");
		expect(existsSync(join(root, "plans", `${emptyKey}.json`))).toBe(true);
	});

	test("an internal failure in the handler is reported redacted and never leaks the secret", async () => {
		const root = newRoot();
		const { run } = setup(
			counting(() => "").plan,
			1_000,
			{ stateDir: root },
			{
				sessionManager: {
					getSessionId: () => {
						throw new Error("Bearer abcdefghijklmnop0123 rejected");
					},
				},
			},
		);
		const text = textOf(await run("do it"));
		expect(text).toContain("[redacted]");
		expect(text).not.toContain("abcdefghijklmnop0123");
	});

	test("a relaunch is refused once the flight's own budget is spent", async () => {
		const root = newRoot();
		let clockAt = 0;
		let calls = 0;
		const planner = async (): Promise<string> => {
			calls++;
			clockAt += 200;
			return "";
		};
		const { run } = setup(planner, 1_000, {
			stateDir: root,
			maxRunMs: 100,
			clock: { now: () => clockAt },
		});
		expect(textOf(await run("do it"))).toContain("stopped planning");
		expect(calls).toBe(1);
	});

	test("native-unavailable is a planning failure: after three relaunches the notice names the reason", async () => {
		const planner = skipping("native-unavailable");
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		const text = textOf(await run("do it"));
		expect(text).toContain("stopped planning");
		expect(text).toContain("native-unavailable");
		expect(planner.count()).toBe(4);
	});

	test("a deferred deliberate skip that outlasts the race sends no aside", async () => {
		const gate = Promise.withResolvers<{ context: string; skipped: string }>();
		const { run, sent } = setup(() => gate.promise, 1, { stateDir: newRoot() });
		await run("do it");
		gate.resolve({ context: "", skipped: "slash-command" });
		await flush();
		expect(sent).toEqual([]);
	});

	for (const reason of [
		"child-or-disabled",
		"parent-session",
		"cron",
		"empty",
		"ultrathink-command",
		"skill-preamble",
		"aborted",
		"slash-command",
		"ultrathink-skill",
		"nested-child",
		"precheck-trivial",
		"precheck-disabled",
		"precheck-over-max-chars",
	]) {
		test(`a deliberate ${reason} skip stays silent and is not retried`, async () => {
			const planner = skipping(reason);
			const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
			expect(await run("do it")).toBeUndefined();
			expect(planner.count()).toBe(1);
		});
	}
});
