// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Pending composition (SPE-38126, n5): arm at trigger, gate blocks spawn pre-uplift, full order executes post-uplift, failures preserve the prompt. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";

import type { BriefResult } from "../substrate/brief.ts";
import { GatedFinalHopInjector } from "../host/uplift-delivery.ts";
import { PENDING_GATE_HELD_REASON, PendingStore } from "../track/pending.ts";
import { UPLIFT, graphJson } from "../test.helpers.ts";
import { instantThink } from "../think/test.helpers.ts";
import {
	cancelPending,
	completePendingComposition,
	queuePendingInput,
	runPromptSubmit,
	type HookDeps,
	type PromptSubmitInput,
} from "./hook.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-pending-"));
	dirs.push(dir);
	return join(dir, "ultrathink");
}

function trackedConfig(): UltrathinkConfig {
	const config = defaultConfig();
	config.linear.team = "Team";
	config.notion.dataSourceUrl = "collection://ds";
	return config;
}

const NO_BRIEF: BriefResult = { text: "", state: "none" };

function baseDeps(overrides: Partial<HookDeps> = {}): HookDeps {
	return {
		config: trackedConfig(),
		control: {},
		complete: smartComplete(),
		engine: "claude:claude-haiku-5-5",
		stateDir: stateDir(),
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => NO_BRIEF,
		realmProbe: async () => ({ kind: "absent" }),
		emit: async () => true,
		now: () => 1_000,
		log: () => {
			// reason: test log sink; assertions read the pending, not the log
		},
		think: instantThink,
		decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
		...overrides,
	};
}

/** Dispatches by payload content so one fake handles uplift, graph, fills and clarify calls correctly. */
function smartComplete(
	onUplift?: (user: string) => void,
): (system: string, user: string) => Promise<string> {
	return async (_system, user) => {
		if (user.includes("<user_request>")) {
			onUplift?.(user);
			return UPLIFT("add a widget");
		}
		if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		return graphJson(6);
	};
}

const input: PromptSubmitInput = { session_id: "s1", cwd: "/repo", prompt: "add a widget" };

function okInjector(capture?: { promptText?: string; replaceKey?: string }): GatedFinalHopInjector {
	return new GatedFinalHopInjector({
		deterministic: async (delivery) => {
			if (capture) {
				capture.promptText = delivery.promptText;
				capture.replaceKey = delivery.replaceKey;
			}
			return true;
		},
		out: async () => false,
	});
}

function failingInjector(): GatedFinalHopInjector {
	return new GatedFinalHopInjector({
		deterministic: async () => false,
		out: async () => false,
	});
}

describe("pending composition through runPromptSubmit", () => {
	test("schedule is armed at trigger, the gate blocks spawn pre-uplift, and the full order executes post-uplift", async () => {
		const store = new PendingStore();
		const capture: { promptText?: string; replaceKey?: string } = {};
		const seamCalls: Array<{ sessionId: string; invocationId: string }> = [];
		const gateSeenDuringUplift: Array<{ substantive: boolean; readOnly: boolean }> = [];
		const gateReasonDuringUplift: string[] = [];
		const deps = baseDeps({
			pendingStore: store,
			pendingInjector: okInjector(capture),
			pendingForceStopSeam: {
				forceStop: (forceStopInput) => {
					seamCalls.push(forceStopInput);
				},
			},
			pendingSessionKind: "managed",
			complete: smartComplete(() => {
				gateSeenDuringUplift.push({
					substantive: store.gateFor("s1", "substantive").allowed,
					readOnly: store.gateFor("s1", "read-only").allowed,
				});
				gateReasonDuringUplift.push(store.gateFor("s1", "substantive").reason);
			}),
		});
		const result = await runPromptSubmit(input, deps);
		expect(result.output).toBeDefined();

		// Armed before uplift ran: during the uplift call the substantive gate already held.
		expect(gateSeenDuringUplift.length).toBeGreaterThan(0);
		for (const seen of gateSeenDuringUplift) {
			expect(seen.substantive).toBe(false);
			expect(seen.readOnly).toBe(true);
		}
		expect(gateReasonDuringUplift).toEqual([PENDING_GATE_HELD_REASON]);

		const pending = store.get("s1")!;
		expect(pending.state).toBe("HandedOff");
		expect(pending.transitions.map((t) => t.to)).toEqual([
			"Invoked",
			"UpliftPending",
			"SwarmGated",
			"PlanReady",
			"Injecting",
			"Injected",
			"TODOsSynced",
			"ForceStoppedOrFinishedOff",
			"HandedOff",
		]);
		// The injected prompt is the uplifted one, under the invocation's idempotent key.
		expect(capture.replaceKey).toBe(pending.invocationId);
		expect(capture.promptText).toContain("BUILD_PROMPT");
		expect(pending.upliftedPrompt).toContain("BUILD_PROMPT");
		// Force-stop seam fired exactly once with the invocation identity.
		expect(seamCalls).toEqual([{ sessionId: "s1", invocationId: pending.invocationId }]);
		// Gate released for the uplifted context.
		expect(store.gatePasses("s1")).toBe(true);
	});

	test("injector failure keeps the prompt and never falls back to an un-uplifted run", async () => {
		const store = new PendingStore();
		const deps = baseDeps({
			pendingStore: store,
			pendingInjector: failingInjector(),
			pendingForceStopSeam: {
				forceStop: () => {
					// reason: this failure path never reaches the seam; the pending fails at inject first
				},
			},
			pendingSessionKind: "managed",
		});
		const result = await runPromptSubmit(input, deps);
		// The prompt still went through as the uplifted context.
		expect(result.output).toBeDefined();
		const context = result.output?.hookSpecificOutput.additionalContext ?? "";
		expect(context).toContain("Prompt Uplift");
		expect(context).not.toBe("add a widget");

		const pending = store.get("s1")!;
		expect(pending.state).toBe("Failed");
		// The uplifted prompt is retained on the failed pending; nothing was injected.
		expect(pending.upliftedPrompt).toContain("BUILD_PROMPT");
		expect(pending.injected).toBe(false);
		expect(pending.injectionAttemptCount).toBe(1);
		// Failed is non-blocking: the session is gated no longer.
		expect(store.gatePasses("s1")).toBe(true);
	});

	test("absent injector fails stage-specifically and absent seam keeps the fail-closed missingPrimitive path", async () => {
		const store = new PendingStore();
		const deps = baseDeps({ pendingStore: store });
		await runPromptSubmit(input, deps);
		const pending = store.get("s1")!;
		expect(pending.state).toBe("Failed");
		expect(pending.lastReason).toContain("inject");

		// With an injector but no force-stop seam: TODOs sync, then the fail-closed path holds at TODOsSynced.
		const store2 = new PendingStore();
		const deps2 = baseDeps({
			pendingStore: store2,
			pendingInjector: okInjector(),
			pendingSessionKind: "managed",
		});
		await runPromptSubmit(input, deps2);
		const pending2 = store2.get("s1")!;
		expect(pending2.state).toBe("TODOsSynced");
		expect(pending2.injected).toBe(true);
		expect(store2.gatePasses("s1")).toBe(true);
	});

	test("non-uplift prompts arm nothing", async () => {
		const store = new PendingStore();
		const deps = baseDeps({ pendingStore: store });
		const result = await runPromptSubmit({ ...input, prompt: "ok" }, deps);
		expect(result.skipped).toBe("skip");
		expect(store.get("s1")).toBeUndefined();
		expect(store.gatePasses("s1")).toBe(true);
	});

	test("queued input is held while pending, then dropped on cancellation", async () => {
		const store = new PendingStore();
		const dir = stateDir();
		const outcome = await completePendingComposition({
			store,
			sessionId: "s1",
			identity: { invocationId: "missing", epoch: 1 },
			promptText: "prompt",
			todos: [{ content: "a step", status: "pending" }],
			graphId: "ut-x-y",
			stateDir: dir,
		});
		// No pending: pass-through, touches nothing.
		expect(outcome.stage).toBe("pass-through");
		expect(store.get("s1")).toBeUndefined();

		const pending = store.create("s1", "raw input", 1000);
		expect(queuePendingInput(store, "s1", "follow-up during wait")).toBe(1);
		expect(queuePendingInput(store, "other", "no session")).toBeUndefined();
		expect(pending.queuedInputs).toEqual(["follow-up during wait"]);
		cancelPending(store, "s1", "test cancellation");
		expect(pending.state).toBe("Cancelled");
		expect(pending.queuedInputs).toEqual([]);
		expect(store.gatePasses("s1")).toBe(true);
	});
});
