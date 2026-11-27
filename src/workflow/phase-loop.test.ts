// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, type PhaseLoopRecord, type PhaseLoopStore } from "./phase-loop-store.ts";
import {
	attemptPhase,
	type AuditRecord,
	checkpointPhaseLoop,
	cleanupPhaseLoop,
	confirmShip,
	deriveLifecycle,
	FsmError,
	FSM_SCHEMA_VERSION,
	nextEvents,
	open,
	type OverrideDecision,
	PhaseLoopCorruptError,
	type PhaseName,
	phaseLoopStatus,
	recordAudit,
	type RuntimeConnectedCheck,
	resetPhaseLoopStateForTests,
	resolve,
	restorePhaseLoop,
	type ShipConfirmationInput,
} from "./phase-loop.ts";

const READY = { completeUpliftCount: 1, unansweredBlockingClarifications: 0 };
const CONNECTED: RuntimeConnectedCheck = () => true;
const DISCONNECTED: RuntimeConnectedCheck = () => false;
const AT = "2026-11-17T10:00:00.000Z";
const PASSING_AUDIT: AuditRecord = { id: "audit-1", kind: "audit", result: "pass", recordedAt: AT };
const OWNER_OVERRIDE: OverrideDecision = {
	decisionId: "decision-1",
	owner: "alice",
	decidedAt: AT,
	reason: "ship without a passing audit",
};

/** A close input that cites the passing audit. */
function passing(): ShipConfirmationInput {
	return { afterVerify: true, audit: PASSING_AUDIT, auditId: PASSING_AUDIT.id };
}
/** Records the passing audit in the loop's ledger, so a close citing it is not missing. */
function recordPassing(runtimeId: string, store?: PhaseLoopStore): void {
	recordAudit(runtimeId, PASSING_AUDIT, store);
}

/** Returns values[index]; throws when it is missing, so an indexed read stays a string. */
function nth(values: readonly string[], index: number): string {
	const value = values[index];
	if (value === undefined) throw new Error(`no value at index ${index}`);
	return value;
}

function through(runtimeId: string, phase: PhaseName) {
	return attemptPhase(runtimeId, { phase, ...READY }, CONNECTED).state;
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
		).state;
		expect(blocked.executeStarts).toBe(0);
		expect(blocked.shipStarts).toBe(0);
		expect(blocked.phaseOrder).toEqual(["Discuss", "Plan"]);
		const started = through(runtimeId, "Execute");
		expect(started.executeStarts).toBe(1);
		expect(started.shipStarts).toBe(0);
		expect(started.operatorConfirmations).toBe(0);
		const refusedShip = attemptPhase(runtimeId, { phase: "Ship", ...READY }, CONNECTED).state;
		expect(refusedShip.shipStarts).toBe(0);
		expect(refusedShip.phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
		expect(confirmShip(runtimeId, { afterVerify: false }, CONNECTED).state.shipStarts).toBe(0);
	});

	test("AC-18 one unanswered clarification => executeStarts 0", () => {
		const runtimeId = "cursor";
		through(runtimeId, "Discuss");
		through(runtimeId, "Plan");
		const held = attemptPhase(
			runtimeId,
			{ phase: "Execute", completeUpliftCount: 1, unansweredBlockingClarifications: 1 },
			CONNECTED,
		).state;
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
		const notYetShipped = attemptPhase(runtimeId, { phase: "Ship", ...READY }, CONNECTED).state;
		expect(notYetShipped.shipStarts).toBe(0);
		expect(notYetShipped.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify"]);
	});

	test("AC-20 one confirmation after Verify with a passing audit => shipStarts 1", () => {
		const runtimeId = "hermes";
		recordPassing(runtimeId);
		expect(confirmShip(runtimeId, passing(), CONNECTED).state.shipStarts).toBe(0);
		through(runtimeId, "Discuss");
		through(runtimeId, "Plan");
		through(runtimeId, "Execute");
		through(runtimeId, "Verify");
		const confirmed = confirmShip(runtimeId, passing(), CONNECTED).state;
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
		const refused = attemptPhase(runtimeId, { phase: "Execute", ...READY }, DISCONNECTED).state;
		expect(refused.executeStarts).toBe(0);
		expect(refused.phaseOrder).toEqual(["Discuss", "Plan"]);
		const started = attemptPhase(runtimeId, { phase: "Execute", ...READY }, CONNECTED).state;
		expect(started.executeStarts).toBe(1);
		expect(started.phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
	});

	test("a refused attempt names each refusal reason and leaves the state unchanged", () => {
		const runtimeId = "claude";
		const discussed = attemptPhase(runtimeId, { phase: "Discuss", ...READY }, CONNECTED);
		expect(discussed).toMatchObject({ accepted: true, refusals: [] });
		const planned = attemptPhase(runtimeId, { phase: "Plan", ...READY }, CONNECTED);
		expect(planned.state.phaseOrder).toEqual(["Discuss", "Plan"]);
		const unmet = attemptPhase(
			runtimeId,
			{ phase: "Execute", completeUpliftCount: 0, unansweredBlockingClarifications: 1 },
			CONNECTED,
		);
		expect(unmet.accepted).toBe(false);
		expect(unmet.refusals).toEqual(["Execute gates are unmet"]);
		expect(unmet.state.phaseOrder).toEqual(["Discuss", "Plan"]);
		const disconnected = attemptPhase(runtimeId, { phase: "Execute", ...READY }, DISCONNECTED);
		expect(disconnected.refusals).toEqual(["runtime is not connected"]);
		const shipped = attemptPhase(runtimeId, { phase: "Ship", ...READY }, CONNECTED);
		expect(shipped.refusals).toEqual(["Ship starts only through confirmShip"]);
		expect(shipped.state.shipStarts).toBe(0);
	});
});

describe("phase loop persistence and close gates (LIFE-01, LIFE-02, LIFE-04, LIFE-05)", () => {
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
		return attemptPhase(runtimeId, { phase, ...READY }, CONNECTED, store).state;
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

	test("a refused attempt writes no runtime marker; an accepted connected attempt writes it", () => {
		const { store, saves } = countingStore(dir);
		const refused = attemptPhase("claude", { phase: "Discuss", ...READY }, DISCONNECTED, store);
		expect(refused).toMatchObject({ accepted: false, refusals: ["runtime is not connected"] });
		expect(refused.state.runtimeSessionId).toBeUndefined();
		expect(saves()).toBe(0);
		expect(storedRecord(dir, "claude")).toBeUndefined();
		const accepted = attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store);
		expect(accepted.state.runtimeSessionId).toBe("claude");
		expect(storedRecord(dir, "claude")?.runtimeSessionId).toBe("claude");
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
		recordPassing("claude", fileStore(dir));
		const shipped = confirmShip("claude", passing(), CONNECTED, fileStore(dir)).state;
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
				humanItems: [],
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

	/** Runs Discuss through Verify on a store, each as an accepted attempt. */
	function reachVerify(runtimeId: string, store: PhaseLoopStore): void {
		for (const phase of ["Discuss", "Plan", "Execute", "Verify"] as const) {
			step(runtimeId, phase, store);
		}
	}

	test("a close without an audit is refused, names the reason, and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		reachVerify("claude", store);
		const before = saves();
		const refused = confirmShip("claude", { afterVerify: true }, CONNECTED, store);
		expect(refused.accepted).toBe(false);
		expect(refused.refusals).toEqual(["no passing audit or override"]);
		expect(refused.state.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify"]);
		expect(saves()).toBe(before);
		expect(storedRecord(dir, "claude")?.phaseOrder).toEqual([
			"Discuss",
			"Plan",
			"Execute",
			"Verify",
		]);
	});

	test("a failed audit refuses the close", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		const failed = confirmShip(
			"claude",
			{ afterVerify: true, audit: { ...PASSING_AUDIT, result: "fail" }, auditId: "audit-1" },
			CONNECTED,
			store,
		);
		expect(failed.accepted).toBe(false);
		expect(failed.refusals).toEqual(["no passing audit or override", "audit audit-1 did not pass"]);
		expect(failed.state.phaseOrder).not.toContain("Ship");
	});

	test("a passing audit with a matching id accepts the close, and a second close is refused", () => {
		const { store, saves } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		const closed = confirmShip("claude", passing(), CONNECTED, store);
		expect(closed.accepted).toBe(true);
		expect(closed.refusals).toEqual([]);
		expect(closed.state.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify", "Ship"]);
		expect(closed.state.shipStarts).toBe(1);
		expect(storedRecord(dir, "claude")).toEqual(closed.state);
		const before = saves();
		const again = confirmShip("claude", passing(), CONNECTED, store);
		expect(again.accepted).toBe(false);
		expect(again.refusals).toEqual(["Verify is not the last recorded phase"]);
		expect(saves()).toBe(before);
	});

	test("a passing audit with a mismatched id refuses the close", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		const mismatched = confirmShip(
			"claude",
			{ afterVerify: true, audit: PASSING_AUDIT, auditId: "audit-2" },
			CONNECTED,
			store,
		);
		expect(mismatched.accepted).toBe(false);
		expect(mismatched.refusals).toEqual([
			"no passing audit or override",
			"audit audit-1 does not match cited audit-2",
		]);
	});

	test("a passing audit that was never recorded refuses the close and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		reachVerify("claude", store);
		const before = saves();
		const refused = confirmShip("claude", passing(), CONNECTED, store);
		expect(refused.accepted).toBe(false);
		expect(refused.refusals).toEqual([
			"no passing audit or override",
			"audit audit-1 is not recorded",
		]);
		expect(refused.state.phaseOrder).not.toContain("Ship");
		expect(saves()).toBe(before);
		expect(storedRecord(dir, "claude")?.audits).toBeUndefined();
	});

	test("a recorded audit re-recorded as a fail is stale and refuses a close citing the old pass", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		recordAudit("claude", { ...PASSING_AUDIT, result: "fail" }, store);
		const refused = confirmShip("claude", passing(), CONNECTED, store);
		expect(refused.accepted).toBe(false);
		expect(refused.refusals).toEqual([
			"no passing audit or override",
			"audit audit-1 did not pass",
		]);
		expect(refused.state.phaseOrder).not.toContain("Ship");
	});

	test("a presented audit that differs from the recorded one is stale and refuses the close", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordAudit("claude", { ...PASSING_AUDIT, recordedAt: "2026-11-18T10:00:00.000Z" }, store);
		const refused = confirmShip("claude", passing(), CONNECTED, store);
		expect(refused.accepted).toBe(false);
		expect(refused.refusals).toEqual([
			"no passing audit or override",
			"audit audit-1 is stale; it does not match the recorded audit",
		]);
		expect(refused.state.phaseOrder).not.toContain("Ship");
	});

	test("an override needs a complete owner decision; a complete one closes without an audit", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		const blankOwner = confirmShip(
			"claude",
			{ afterVerify: true, override: { ...OWNER_OVERRIDE, owner: "" } },
			CONNECTED,
			store,
		);
		expect(blankOwner.accepted).toBe(false);
		expect(blankOwner.refusals).toEqual([
			"no passing audit or override",
			"override is missing an owner decision field",
		]);
		const overridden = confirmShip(
			"claude",
			{ afterVerify: true, override: OWNER_OVERRIDE },
			CONNECTED,
			store,
		);
		expect(overridden.accepted).toBe(true);
		expect(overridden.state.phaseOrder).toContain("Ship");
	});

	test("an open HTIL entry blocks the close and the refusal names its id", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		expect(open("claude", { id: "h1", owner: "alice" }, store).accepted).toBe(true);
		const blocked = confirmShip("claude", passing(), CONNECTED, store);
		expect(blocked.accepted).toBe(false);
		expect(blocked.refusals).toEqual(["open HTIL entry h1"]);
		expect(blocked.state.phaseOrder).not.toContain("Ship");
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "open" },
		]);
	});

	test("a duplicate or ownerless HTIL entry is refused and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		reachVerify("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		const before = saves();
		expect(open("claude", { id: "h1", owner: "bob" }, store).refusals).toEqual([
			"HTIL entry h1 already exists",
		]);
		expect(open("claude", { id: "h2", owner: " " }, store).refusals).toEqual([
			"HTIL entry h2 needs an owner",
		]);
		expect(saves()).toBe(before);
	});

	test("a deferred entry with a decisionId lets the close pass", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		const deferred = resolve(
			"claude",
			"h1",
			{ state: "deferred", decisionId: "decision-2" },
			store,
		);
		expect(deferred.accepted).toBe(true);
		expect(deferred.state.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "deferred", decisionId: "decision-2" },
		]);
		const closed = confirmShip("claude", passing(), CONNECTED, store);
		expect(closed.accepted).toBe(true);
		expect(closed.state.phaseOrder).toContain("Ship");
	});

	test("a deferred entry without a decisionId is refused and stays open", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		const refused = resolve("claude", "h1", { state: "deferred", decisionId: "" }, store);
		expect(refused.accepted).toBe(false);
		expect(refused.refusals).toEqual(["deferred HTIL entry h1 needs decisionId"]);
		expect(refused.state.humanItems).toEqual([{ id: "h1", owner: "alice", state: "open" }]);
		expect(confirmShip("claude", passing(), CONNECTED, store).refusals).toEqual([
			"open HTIL entry h1",
		]);
	});

	test("a done entry needs evidenceId, is resolved only once, and then closes", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		expect(resolve("claude", "h1", { state: "done", evidenceId: " " }, store).refusals).toEqual([
			"done HTIL entry h1 needs evidenceId",
		]);
		expect(resolve("claude", "h9", { state: "done", evidenceId: "e9" }, store).refusals).toEqual([
			"HTIL entry h9 does not exist",
		]);
		const done = resolve("claude", "h1", { state: "done", evidenceId: "e1" }, store);
		expect(done.accepted).toBe(true);
		expect(done.state.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "done", evidenceId: "e1" },
		]);
		expect(resolve("claude", "h1", { state: "done", evidenceId: "e2" }, store).refusals).toEqual([
			"HTIL entry h1 is already done",
		]);
		expect(confirmShip("claude", passing(), CONNECTED, store).accepted).toBe(true);
	});

	test("humanItems persist across a restart", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		resolve("claude", "h1", { state: "done", evidenceId: "e1" }, store);
		resetPhaseLoopStateForTests();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.state.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "done", evidenceId: "e1" },
		]);
		recordPassing("claude", fileStore(dir));
		expect(confirmShip("claude", passing(), CONNECTED, fileStore(dir)).accepted).toBe(true);
	});

	test("an old record without humanItems restores with an empty list", () => {
		const { store } = countingStore(dir);
		step("claude", "Discuss", store);
		writeFileSync(
			join(dir, nth(recordFiles(), 0)),
			JSON.stringify({
				runtimeId: "claude",
				phaseOrder: ["Discuss"],
				executeStarts: 0,
				shipStarts: 0,
				operatorConfirmations: 0,
			}),
		);
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.restored).toBe(true);
		expect(restored.state.humanItems).toEqual([]);
	});

	test("open and resolve over a corrupt record throw PhaseLoopCorruptError and write nothing", () => {
		const { store, saves } = countingStore(dir);
		step("claude", "Discuss", store);
		writeFileSync(join(dir, nth(recordFiles(), 0)), "{not json");
		const before = saves();
		expect(captureError(() => open("claude", { id: "h1", owner: "alice" }, store))).toBeInstanceOf(
			PhaseLoopCorruptError,
		);
		expect(
			captureError(() => resolve("claude", "h1", { state: "done", evidenceId: "e1" }, store)),
		).toBeInstanceOf(PhaseLoopCorruptError);
		expect(saves()).toBe(before);
		expect(recordFiles()).toEqual([]);
	});

	test("an accepted audit close sets closedBy with kind audit and the audit's id", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		const closed = confirmShip("claude", passing(), CONNECTED, store);
		expect(closed.accepted).toBe(true);
		expect(closed.state.closedBy).toEqual({ kind: "audit", recordId: "audit-1", recordedAt: AT });
		expect(storedRecord(dir, "claude")?.closedBy).toEqual(closed.state.closedBy);
	});

	test("an accepted override close sets closedBy with kind override and the decisionId", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		const closed = confirmShip(
			"claude",
			{ afterVerify: true, override: OWNER_OVERRIDE },
			CONNECTED,
			store,
		);
		expect(closed.accepted).toBe(true);
		expect(closed.state.closedBy).toEqual({
			kind: "override",
			recordId: "decision-1",
			recordedAt: AT,
		});
	});

	test("a refused close leaves closedBy undefined", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		const refused = confirmShip("claude", { afterVerify: true }, CONNECTED, store);
		expect(refused.accepted).toBe(false);
		expect(refused.state.closedBy).toBeUndefined();
		expect(storedRecord(dir, "claude")?.closedBy).toBeUndefined();
	});

	test("closedBy survives a restart", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		confirmShip("claude", passing(), CONNECTED, store);
		resetPhaseLoopStateForTests();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.restored).toBe(true);
		expect(restored.state.closedBy).toEqual({ kind: "audit", recordId: "audit-1", recordedAt: AT });
	});

	test("recording an audit again under the same id replaces it, and the record survives a restart", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordAudit("claude", { ...PASSING_AUDIT, result: "fail" }, store);
		expect(recordAudit("claude", PASSING_AUDIT, store).accepted).toBe(true);
		expect(storedRecord(dir, "claude")?.audits).toEqual([PASSING_AUDIT]);
		resetPhaseLoopStateForTests();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.state.audits).toEqual([PASSING_AUDIT]);
		expect(confirmShip("claude", passing(), CONNECTED, fileStore(dir)).accepted).toBe(true);
	});

	test("an audit with a blank id is refused and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		reachVerify("claude", store);
		const before = saves();
		expect(recordAudit("claude", { ...PASSING_AUDIT, id: " " }, store).refusals).toEqual([
			"audit record needs an id",
		]);
		expect(saves()).toBe(before);
		expect(storedRecord(dir, "claude")?.audits).toBeUndefined();
	});

	test("an accepted override close keeps its decision and reason; a refused one keeps none", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		const refused = confirmShip(
			"claude",
			{ afterVerify: true, override: { ...OWNER_OVERRIDE, reason: "" } },
			CONNECTED,
			store,
		);
		expect(refused.accepted).toBe(false);
		expect(storedRecord(dir, "claude")?.overrides).toBeUndefined();
		const closed = confirmShip(
			"claude",
			{ afterVerify: true, override: OWNER_OVERRIDE },
			CONNECTED,
			store,
		);
		expect(closed.accepted).toBe(true);
		expect(storedRecord(dir, "claude")?.overrides).toEqual([OWNER_OVERRIDE]);
	});

	test("a done entry records who resolved it and when; a blank resolver is refused", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		const blankResolver = resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: " " },
			store,
		);
		expect(blankResolver.refusals).toEqual(["done HTIL entry h1 needs resolvedBy"]);
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "open" },
		]);
		const done = resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: "alice", resolvedAt: AT },
			store,
		);
		expect(done.accepted).toBe(true);
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{
				id: "h1",
				owner: "alice",
				state: "done",
				evidenceId: "e1",
				resolvedBy: "alice",
				resolvedAt: AT,
			},
		]);
	});

	test("after Ship is recorded, open is refused unless it is the merge gate's reconcile, resolve is refused unless the entry has that origin, and recordAudit is refused and writes nothing", () => {
		const { store, saves } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		expect(confirmShip("claude", passing(), CONNECTED, store).accepted).toBe(true);
		expect(open("claude", { id: "h2", owner: "alice" }, store).refusals).toEqual([
			"loop is closed by Ship; HTIL entry h2 is not recorded",
		]);
		const reconcile = open("claude", { id: "h2", owner: "alice" }, store, { afterShip: true });
		expect(reconcile.accepted).toBe(true);
		const before = saves();
		expect(resolve("claude", "h1", { state: "done", evidenceId: "e1" }, store).refusals).toEqual([
			"loop is closed by Ship; HTIL entry h1 is not resolved",
		]);
		expect(recordAudit("claude", { ...PASSING_AUDIT, id: "audit-2" }, store).refusals).toEqual([
			"loop is closed by Ship; audit audit-2 is not recorded",
		]);
		expect(saves()).toBe(before);
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{ id: "h2", owner: "alice", state: "open", afterShip: true },
		]);
		expect(storedRecord(dir, "claude")?.audits).toEqual([PASSING_AUDIT]);
		const cleared = resolve("claude", "h2", { state: "done", evidenceId: "e2" }, store);
		expect(cleared.accepted).toBe(true);
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{ id: "h2", owner: "alice", state: "done", evidenceId: "e2", afterShip: true },
		]);
	});

	test("after Ship, a failing re-record of the audit the close cites is refused and the pass stands", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordAudit("claude", PASSING_AUDIT, store);
		expect(confirmShip("claude", passing(), CONNECTED, store).accepted).toBe(true);
		const replaced = recordAudit("claude", { ...PASSING_AUDIT, result: "fail" }, store);
		expect(replaced.accepted).toBe(false);
		expect(storedRecord(dir, "claude")?.audits).toEqual([PASSING_AUDIT]);
		expect(storedRecord(dir, "claude")?.closedBy).toEqual({
			kind: "audit",
			recordId: "audit-1",
			recordedAt: AT,
		});
	});
});

describe("FSM lifecycle, status, audit trail and cleanup", () => {
	beforeEach(() => {
		resetPhaseLoopStateForTests();
	});

	function localRecord(stateDir: string, runtimeId: string): PhaseLoopRecord | undefined {
		const outcome = fileStore(stateDir).load(runtimeId);
		return outcome.status === "found" ? outcome.record : undefined;
	}

	test("T2 full lifecycle drives ready->discussing->planning->executing->verifying->completed in order", () => {
		const id = "claude";
		expect(
			phaseLoopStatus(attemptPhase(id, { phase: "Discuss", ...READY }, CONNECTED).state).lifecycle,
		).toBe("discussing");
		through(id, "Plan");
		through(id, "Execute");
		through(id, "Verify");
		recordPassing(id);
		confirmShip(id, passing(), CONNECTED);
		const state = attemptPhase(id, { phase: "Discuss", ...READY }, CONNECTED).state;
		expect(state.phaseOrder).toEqual(["Discuss", "Plan", "Execute", "Verify", "Ship"]);
		expect(deriveLifecycle(state)).toBe("completed");
	});

	test("T3 illegal transition names state, event and legal events and leaves state unchanged", () => {
		const id = "claude";
		const before = attemptPhase(id, { phase: "Discuss", ...READY }, CONNECTED).state;
		const refused = attemptPhase(id, { phase: "Execute", ...READY }, CONNECTED);
		expect(refused.accepted).toBe(false);
		expect(refused.refusals.length).toBeGreaterThan(0);
		expect(refused.state.phaseOrder).toEqual(before.phaseOrder);
		expect(nextEvents(deriveLifecycle(before))).toEqual(["attempt(Plan)"]);
	});

	test("T4 awaiting-decision blocks close until HTIL resolves; status names blocker and next events", () => {
		const id = "claude";
		through(id, "Discuss");
		through(id, "Plan");
		open(id, { id: "h1", owner: "alice" });
		const waiting = attemptPhase(id, { phase: "Execute", ...READY }, CONNECTED).state;
		const status = phaseLoopStatus(waiting);
		expect(status.lifecycle).toBe("awaiting-decision");
		expect(status.blocker).toEqual({ id: "h1", owner: "alice" });
		expect(status.nextEvents).toEqual(["resolve(HTIL)"]);
		resolve(id, "h1", { state: "done", evidenceId: "e1" });
		const after = attemptPhase(id, { phase: "Execute", ...READY }, CONNECTED).state;
		expect(deriveLifecycle(after)).toBe("executing");
	});

	test("T4 paused is derived from the stored checkpoint and resumes via restore", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-paused-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store);
			checkpointPhaseLoop(store, "claude", "pause", AT);
			const restored = restorePhaseLoop(store, "claude");
			expect(phaseLoopStatus(restored.state, restored.checkpoint).lifecycle).toBe("paused");
			expect(restored.restored).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("T5 schema version migrates on first accepted transition; legacy record loads unchanged", () => {
		const id = "claude";
		expect(attemptPhase(id, { phase: "Discuss", ...READY }, CONNECTED).state.schemaVersion).toBe(
			FSM_SCHEMA_VERSION,
		);
		const root = mkdtempSync(join(tmpdir(), "phase-loop-legacy-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store);
			const record = localRecord(dir, "claude");
			expect(record?.schemaVersion).toBe(FSM_SCHEMA_VERSION);
			// A legacy record without schemaVersion parses and migrates on next accepted transition.
			const legacy: PhaseLoopRecord = {
				runtimeId: "legacy",
				phaseOrder: ["Discuss"],
				executeStarts: 0,
				shipStarts: 0,
				operatorConfirmations: 0,
				humanItems: [],
			};
			store.save("legacy", legacy);
			expect(restorePhaseLoop(store, "legacy").restored).toBe(true);
			expect(
				attemptPhase("legacy", { phase: "Plan", ...READY }, CONNECTED, store).state.schemaVersion,
			).toBe(FSM_SCHEMA_VERSION);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("T6 accepted attempts with a timestamp append a bounded transition audit trail; refusals record nothing", () => {
		const id = "claude";
		attemptPhase(id, { phase: "Discuss", ...READY }, CONNECTED, undefined, { at: AT });
		const refused = attemptPhase(id, { phase: "Execute", ...READY }, CONNECTED, undefined, {
			at: AT,
		});
		expect(refused.accepted).toBe(false);
		const state = attemptPhase(id, { phase: "Plan", ...READY }, CONNECTED, undefined, {
			at: AT,
		}).state;
		expect(state.transitions?.map((item) => item.event)).toEqual([
			"attempt(Discuss)",
			"attempt(Plan)",
		]);
		expect(state.transitions?.[0]).toMatchObject({
			at: AT,
			from: "ready",
			to: "discussing",
			accepted: true,
		});
	});

	test("terminal completed accepts no phase events; cleanup requires completed+audited and is itself terminal", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-cleanup-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			for (const phase of ["Discuss", "Plan", "Execute", "Verify"] as const) {
				attemptPhase("claude", { phase, ...READY }, CONNECTED, store);
			}
			// Guard: not completed yet.
			const early = (() => {
				try {
					cleanupPhaseLoop(store, "claude", "alice", AT);
				} catch (error) {
					return error;
				}
				return undefined;
			})();
			expect(early).toBeInstanceOf(FsmError);
			expect((early as FsmError).kind).toBe("guard");
			recordPassing("claude", store);
			confirmShip("claude", passing(), CONNECTED, store);
			cleanupPhaseLoop(store, "claude", "alice", AT);
			const cleaned = localRecord(dir, "claude");
			expect(cleaned?.cleanedUpBy).toBe("alice");
			expect(deriveLifecycle(cleaned as never)).toBe("cleaned-up");
			expect(nextEvents("cleaned-up")).toEqual([]);
			// Second cleanup is a rejection; no phase events accepted after cleanup.
			expect(
				attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store).accepted,
			).toBe(false);
			expect(recordAudit("claude", PASSING_AUDIT, store).accepted).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
