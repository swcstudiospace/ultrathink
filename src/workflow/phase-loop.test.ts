// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, type PhaseLoopRecord, type PhaseLoopStore } from "./phase-loop-store.ts";
import {
	attemptPhase,
	checkpointPhaseLoop,
	confirmShip,
	PhaseLoopCorruptError,
	type PhaseName,
	type RuntimeConnectedCheck,
	resetPhaseLoopStateForTests,
	restorePhaseLoop,
} from "./phase-loop.ts";

const READY = { completeUpliftCount: 1, unansweredBlockingClarifications: 0 };
const CONNECTED: RuntimeConnectedCheck = () => true;
const DISCONNECTED: RuntimeConnectedCheck = () => false;
const AT = "2026-11-17T10:00:00.000Z";

/** Returns values[index]; throws when it is missing, so an indexed read stays a string. */
function nth(values: readonly string[], index: number): string {
	const value = values[index];
	if (value === undefined) throw new Error(`no value at index ${index}`);
	return value;
}

function through(runtimeId: string, phase: PhaseName) {
	return attemptPhase(runtimeId, { phase, ...READY }, CONNECTED);
}

describe("phase loop", () => {
	beforeEach(() => {
		resetPhaseLoopStateForTests();
	});

	test("AC-17 Execute starts only after 1 complete uplift and 0 unanswered clarifications; Ship stays 0 until confirmation", () => {
		const runtimeId = "claude";
		expect(through(runtimeId, "Discuss").phaseOrder).toEqual(["Discuss"]);
		expect(through(runtimeId, "Plan").phaseOrder).toEqual(["Discuss", "Plan"]);
		const blocked = attemptPhase(
			runtimeId,
			{ phase: "Execute", completeUpliftCount: 0, unansweredBlockingClarifications: 0 },
			CONNECTED,
		);
		expect(blocked.executeStarts).toBe(0);
		expect(blocked.shipStarts).toBe(0);
		expect(blocked.phaseOrder).toEqual(["Discuss", "Plan"]);
		const started = through(runtimeId, "Execute");
		expect(started.executeStarts).toBe(1);
		expect(started.shipStarts).toBe(0);
		expect(started.operatorConfirmations).toBe(0);
		const refusedShip = attemptPhase(runtimeId, { phase: "Ship", ...READY }, CONNECTED);
		expect(refusedShip.shipStarts).toBe(0);
		expect(refusedShip.phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
		expect(confirmShip(runtimeId, { afterVerify: false }, CONNECTED).shipStarts).toBe(0);
	});

	test("AC-18 one unanswered clarification => executeStarts 0", () => {
		const runtimeId = "cursor";
		through(runtimeId, "Discuss");
		through(runtimeId, "Plan");
		const held = attemptPhase(
			runtimeId,
			{ phase: "Execute", completeUpliftCount: 1, unansweredBlockingClarifications: 1 },
			CONNECTED,
		);
		expect(held.executeStarts).toBe(0);
		expect(held.phaseOrder).toEqual(["Discuss", "Plan"]);
	});

	test("AC-19 after Verify with 0 confirmations, shipStarts 0 and phaseOrder is Discuss, Plan, Execute, Verify", () => {
		const runtimeId = "pi";
		through(runtimeId, "Discuss");
		through(runtimeId, "Plan");
		through(runtimeId, "Execute");
		const verified = through(runtimeId, "Verify");
		expect(verified.shipStarts).toBe(0);
		expect(verified.operatorConfirmations).toBe(0);
		expect(verified.executeStarts).toBe(1);
		expect(verified.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify"]);
		const notYetShipped = attemptPhase(runtimeId, { phase: "Ship", ...READY }, CONNECTED);
		expect(notYetShipped.shipStarts).toBe(0);
		expect(notYetShipped.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify"]);
	});

	test("AC-20 one confirmation after Verify => shipStarts 1", () => {
		const runtimeId = "hermes";
		expect(confirmShip(runtimeId, { afterVerify: true }, CONNECTED).shipStarts).toBe(0);
		through(runtimeId, "Discuss");
		through(runtimeId, "Plan");
		through(runtimeId, "Execute");
		through(runtimeId, "Verify");
		const confirmed = confirmShip(runtimeId, { afterVerify: true }, CONNECTED);
		expect(confirmed.shipStarts).toBe(1);
		expect(confirmed.operatorConfirmations).toBe(1);
		expect(confirmed.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify", "Ship"]);
		const verifyAt = confirmed.phaseOrder.indexOf("Verify");
		const shipAt = confirmed.phaseOrder.indexOf("Ship");
		expect(shipAt).toBeGreaterThan(verifyAt);
	});

	test("Execute is refused on an unconnected runtime and accepted once it is connected", () => {
		const runtimeId = "claude";
		through(runtimeId, "Discuss");
		through(runtimeId, "Plan");
		const refused = attemptPhase(runtimeId, { phase: "Execute", ...READY }, DISCONNECTED);
		expect(refused.executeStarts).toBe(0);
		expect(refused.phaseOrder).toEqual(["Discuss", "Plan"]);
		const started = attemptPhase(runtimeId, { phase: "Execute", ...READY }, CONNECTED);
		expect(started.executeStarts).toBe(1);
		expect(started.phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
	});
});

describe("phase loop persistence (LIFE-01, LIFE-04)", () => {
	let root: string;
	let dir: string;

	beforeEach(() => {
		resetPhaseLoopStateForTests();
		root = mkdtempSync(join(tmpdir(), "phase-loop-"));
		dir = join(root, "state");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Wraps the file store and counts saves, so a test can prove a call wrote nothing. */
	function countingStore(stateDir: string): { store: PhaseLoopStore; saves: () => number } {
		const inner = fileStore(stateDir);
		let count = 0;
		const store: PhaseLoopStore = {
			load: (runtimeId) => inner.load(runtimeId),
			save: (runtimeId, record) => {
				count += 1;
				inner.save(runtimeId, record);
			},
		};
		return { store, saves: () => count };
	}

	function storedRecord(stateDir: string, runtimeId: string): PhaseLoopRecord | undefined {
		const outcome = fileStore(stateDir).load(runtimeId);
		return outcome.status === "found" ? outcome.record : undefined;
	}

	function recordFiles(): string[] {
		return readdirSync(dir).filter((name) => name.endsWith(".json"));
	}

	function step(runtimeId: string, phase: PhaseName, store: PhaseLoopStore) {
		return attemptPhase(runtimeId, { phase, ...READY }, CONNECTED, store);
	}

	/** Returns what `run` threw, or undefined when it did not throw. */
	function captureError(run: () => unknown): unknown {
		try {
			run();
		} catch (error) {
			return error;
		}
		return undefined;
	}

	test("an accepted transition is committed to the store before the call returns", () => {
		const { store, saves } = countingStore(dir);
		const returned = step("claude", "Discuss", store);
		expect(saves()).toBe(1);
		expect(storedRecord(dir, "claude")).toEqual(returned);
	});

	test("each accepted transition commits once, counter changes included", () => {
		const { store, saves } = countingStore(dir);
		step("claude", "Discuss", store);
		step("claude", "Plan", store);
		const execute = step("claude", "Execute", store);
		expect(saves()).toBe(3);
		expect(execute.executeStarts).toBe(1);
		expect(storedRecord(dir, "claude")).toEqual(execute);
	});

	test("a refused attempt writes nothing", () => {
		const { store, saves } = countingStore(dir);
		step("claude", "Discuss", store);
		const before = saves();
		attemptPhase(
			"claude",
			{ phase: "Execute", completeUpliftCount: 0, unansweredBlockingClarifications: 0 },
			CONNECTED,
			store,
		);
		attemptPhase("claude", { phase: "Execute", ...READY }, DISCONNECTED, store);
		step("claude", "Verify", store);
		step("claude", "Ship", store);
		confirmShip("claude", { afterVerify: false }, CONNECTED, store);
		attemptPhase("fresh", { phase: "Execute", ...READY }, CONNECTED, store);
		expect(saves()).toBe(before);
		expect(storedRecord(dir, "claude")?.phaseOrder).toEqual(["Discuss"]);
		expect(storedRecord(dir, "fresh")).toBeUndefined();
	});

	test("a restart restores the same phase order and counts from the store", () => {
		const { store } = countingStore(dir);
		step("claude", "Discuss", store);
		step("claude", "Plan", store);
		step("claude", "Execute", store);
		const verified = step("claude", "Verify", store);
		resetPhaseLoopStateForTests();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.restored).toBe(true);
		expect(restored.quarantined).toBe(false);
		expect(restored.state).toEqual(verified);
		expect(restored.state.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify"]);
		expect(restored.state.executeStarts).toBe(1);
		expect(restored.state.shipStarts).toBe(0);
		expect(restored.state.operatorConfirmations).toBe(0);
		const shipped = confirmShip("claude", { afterVerify: true }, CONNECTED, fileStore(dir));
		expect(shipped.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify", "Ship"]);
		expect(shipped.shipStarts).toBe(1);
		expect(shipped.operatorConfirmations).toBe(1);
	});

	test("resume with no checkpoint reports restored false and the empty state", () => {
		expect(restorePhaseLoop(fileStore(dir), "claude")).toEqual({
			restored: false,
			quarantined: false,
			state: {
				runtimeId: "claude",
				phaseOrder: [],
				executeStarts: 0,
				shipStarts: 0,
				operatorConfirmations: 0,
			},
		});
	});

	test("a checkpoint writes its reason and time with the current state", () => {
		const { store } = countingStore(dir);
		const discussed = step("claude", "Discuss", store);
		checkpointPhaseLoop(store, "claude", "pause", AT);
		expect(storedRecord(dir, "claude")).toEqual({
			...discussed,
			checkpoint: { reason: "pause", at: AT },
		});
	});

	test("a restore after a checkpoint reports its reason and time", () => {
		const { store } = countingStore(dir);
		step("claude", "Discuss", store);
		step("claude", "Plan", store);
		checkpointPhaseLoop(store, "claude", "kill", AT);
		resetPhaseLoopStateForTests();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.restored).toBe(true);
		expect(restored.checkpoint).toEqual({ reason: "kill", at: AT });
		expect(restored.state.phaseOrder).toEqual(["Discuss", "Plan"]);
	});

	test("a checkpoint with no prior record restores the empty state with its reason and time", () => {
		const { store } = countingStore(dir);
		checkpointPhaseLoop(store, "claude", "pause", AT);
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.restored).toBe(true);
		expect(restored.state.phaseOrder).toEqual([]);
		expect(restored.checkpoint).toEqual({ reason: "pause", at: AT });
	});

	test("a transition after a checkpoint clears the checkpoint field", () => {
		const { store } = countingStore(dir);
		step("claude", "Discuss", store);
		checkpointPhaseLoop(store, "claude", "pause", AT);
		const refused = step("claude", "Verify", store);
		expect(refused.phaseOrder).toEqual(["Discuss"]);
		expect(storedRecord(dir, "claude")?.checkpoint).toEqual({ reason: "pause", at: AT });
		const planned = step("claude", "Plan", store);
		expect(planned.phaseOrder).toEqual(["Discuss", "Plan"]);
		expect(storedRecord(dir, "claude")?.checkpoint).toBeUndefined();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.checkpoint).toBeUndefined();
		expect(restored.state.phaseOrder).toEqual(["Discuss", "Plan"]);
	});

	test("a transition on a corrupt record throws PhaseLoopCorruptError and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		step("claude", "Discuss", store);
		writeFileSync(join(dir, nth(recordFiles(), 0)), "{not json");
		const before = saves();
		const thrown = captureError(() => step("claude", "Plan", store));
		expect(thrown).toBeInstanceOf(PhaseLoopCorruptError);
		const error = thrown as PhaseLoopCorruptError;
		expect(error.runtimeId).toBe("claude");
		expect(readFileSync(error.quarantinedAs, "utf8")).toBe("{not json");
		expect(recordFiles()).toEqual([]);
		expect(saves()).toBe(before);
		const again = captureError(() => step("claude", "Discuss", store));
		expect(again).toBeInstanceOf(PhaseLoopCorruptError);
		expect((again as PhaseLoopCorruptError).quarantinedAs).toBe(error.quarantinedAs);
		expect(recordFiles()).toEqual([]);
		expect(saves()).toBe(before);
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.quarantined).toBe(true);
		expect(restored.restored).toBe(false);
		expect(restored.quarantinedAs).toBe(error.quarantinedAs);
	});

	test("a checkpoint over a corrupt record throws PhaseLoopCorruptError and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		step("claude", "Discuss", store);
		writeFileSync(join(dir, nth(recordFiles(), 0)), "{not json");
		const before = saves();
		expect(captureError(() => checkpointPhaseLoop(store, "claude", "pause", AT))).toBeInstanceOf(
			PhaseLoopCorruptError,
		);
		expect(saves()).toBe(before);
		expect(recordFiles()).toEqual([]);
	});
});
