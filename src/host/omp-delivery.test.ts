// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPLIFT } from "../test.helpers.ts";
import { TEST_STATE_DIR_PREFIX } from "../test.state-dir.ts";
import { loadPlan, planKey, savePlan } from "./plan-store.ts";
import { setup } from "./omp-test.helpers.ts";

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

describe("omp delivery when planning does not produce a plan", () => {
	test("a failed planner is relaunched once and the retry plan is delivered inline", async () => {
		const planner = counting((call) => (call === 1 ? "" : UPLIFT("do it")));
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		expect(textOf(await run("do it"))).toBe(UPLIFT("do it"));
		expect(planner.count()).toBe(2);
	});

	test("a planner that fails twice delivers the notice, never nothing", async () => {
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		const text = textOf(await run("do it"));
		expect(text).toBeDefined();
		expect(text).toContain("did not complete");
		expect(planner.count()).toBe(2);
	});

	test("a planner that throws delivers the notice and carries the error into it", async () => {
		const planner = counting(() => new Error("boom"));
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		const text = textOf(await run("do it"));
		expect(text).toContain("did not complete");
		expect(text).toContain("boom");
		expect(planner.count()).toBe(2);
	});

	test("a settled plan that never reached the model is re-delivered from the store once", async () => {
		const root = newRoot();
		savePlan(root, {
			key: KEY,
			text: UPLIFT("do it", "stored"),
			view: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			deliveredAt: undefined,
		});
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: root });
		expect(textOf(await run("do it"))).toBe(UPLIFT("do it", "stored"));
		expect(loadPlan(root, KEY)?.deliveredAt).toBeDefined();
		expect(await run("do it")).toBeUndefined();
	});

	test("a corrupt stored record is treated as absent and the notice runs", async () => {
		const root = newRoot();
		mkdirSync(join(root, "plans"), { recursive: true });
		writeFileSync(join(root, "plans", `${KEY}.json`), "{not json");
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: root });
		const text = textOf(await run("do it"));
		expect(text).toContain("did not complete");
		expect(loadPlan(root, KEY)).toBeUndefined();
	});

	test("a plan delivered inline is not delivered again by a fallback for the same submission", async () => {
		const root = newRoot();
		const delivered = UPLIFT("do it", "delivered inline");
		const first = setup(async () => delivered, 1_000, { stateDir: root });
		expect(textOf(await first.run("do it"))).toBe(delivered);
		expect(loadPlan(root, KEY)?.deliveredAt).toBeDefined();
		// A fresh host has no flight for this submission, so its planner fails and the store is the only fallback.
		const planner = counting(() => "");
		const fallback = setup(planner.plan, 1_000, { stateDir: root });
		const text = textOf(await fallback.run("do it"));
		expect(text).not.toBe(delivered);
		expect(text).toContain("did not complete");
	});

	test("a record saved with a null view loads with that view and re-delivers its text", async () => {
		const root = newRoot();
		const text = UPLIFT("do it", "null view");
		savePlan(root, {
			key: KEY,
			text,
			view: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			deliveredAt: undefined,
		});
		expect(loadPlan(root, KEY)).toMatchObject({ key: KEY, text, view: null });
		const planner = counting(() => "");
		const { run } = setup(planner.plan, 1_000, { stateDir: root });
		expect(textOf(await run("do it"))).toBe(text);
	});

	test("native-unavailable is a planning failure: it is retried once and the notice names the reason", async () => {
		const planner = skipping("native-unavailable");
		const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
		const text = textOf(await run("do it"));
		expect(text).toContain("did not complete");
		expect(text).toContain("native-unavailable");
		expect(planner.count()).toBe(2);
	});

	for (const reason of [
		"child-or-disabled",
		"precheck-disabled",
		"precheck-over-max-chars",
		"slash-command",
		"ultrathink-skill",
		"nested-child",
	]) {
		test(`a deliberate ${reason} skip stays silent and is not retried`, async () => {
			const planner = skipping(reason);
			const { run } = setup(planner.plan, 1_000, { stateDir: newRoot() });
			expect(await run("do it")).toBeUndefined();
			expect(planner.count()).toBe(1);
		});
	}
});
