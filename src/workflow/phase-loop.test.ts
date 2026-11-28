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
	type PhaseLoopState,
	confirmShip,
	deriveLifecycle,
	escalateHtilEntry,
	FsmError,
	FSM_SCHEMA_VERSION,
	nextEvents,
	open,
	type OverrideDecision,
	PhaseLoopCorruptError,
	type PhaseName,
	phaseLoopStatus,
	recordAudit,
	resolve,
	type RuntimeConnectedCheck,
	resetPhaseLoopStateForTests,
	repairRuntimeMarker,
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

	/** A store whose first CAS loses to a concurrent writer that has already recorded through Execute. */
	function concurrentOnceStore(stateDir: string): { store: PhaseLoopStore; saves: () => number } {
		const inner = fileStore(stateDir);
		let first = true;
		let saves = 0;
		const store: PhaseLoopStore = {
			load: (runtimeId) => inner.load(runtimeId),
			save: (runtimeId, record) => {
				inner.save(runtimeId, record);
			},
			digest: (runtimeId) => inner.digest?.(runtimeId),
			saveIfUnchanged: (runtimeId, record, expectedDigest) => {
				saves += 1;
				if (first) {
					first = false;
					inner.save(runtimeId, {
						runtimeId,
						phaseOrder: ["Discuss", "Plan", "Execute"],
						executeStarts: 1,
						shipStarts: 0,
						operatorConfirmations: 0,
						humanItems: [],
						runtimeSessionId: runtimeId,
					});
					return false;
				}
				return inner.saveIfUnchanged?.(runtimeId, record, expectedDigest) ?? false;
			},
		};
		return { store, saves: () => saves };
	}

	test("a repeated accepted event is refused instead of committed twice", () => {
		const { store, saves } = countingStore(dir);
		step("claude", "Discuss", store);
		const repeated = attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store);
		expect(repeated).toMatchObject({
			accepted: false,
			refusals: ["Discuss is not the next phase"],
		});
		expect(saves()).toBe(1);
		expect(storedRecord(dir, "claude")?.phaseOrder).toEqual(["Discuss"]);
	});

	test("a lost CAS race reloads and refuses the duplicate instead of applying it twice", () => {
		const physical = fileStore(dir);
		step("claude", "Discuss", physical);
		step("claude", "Plan", physical);
		const { store, saves } = concurrentOnceStore(dir);
		const result = attemptPhase("claude", { phase: "Execute", ...READY }, CONNECTED, store);
		expect(result).toMatchObject({
			accepted: false,
			refusals: ["Execute is not the next phase"],
		});
		expect(saves()).toBe(1);
		const stored = storedRecord(dir, "claude");
		expect(stored?.phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
		expect(stored?.executeStarts).toBe(1);
	});

	test("a store save failure is classified as transient with the original cause", () => {
		const cause = new Error("disk full");
		const store: PhaseLoopStore = {
			load: () => ({ status: "absent" }),
			save: () => {
				throw cause;
			},
		};
		const error = captureError(() =>
			attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store),
		);
		expect(error).toBeInstanceOf(FsmError);
		const fsmError = error as FsmError;
		expect(fsmError.kind).toBe("transient");
		expect(fsmError.state).toBe("discussing");
		expect(fsmError.event).toBe("attempt(Discuss)");
		expect(fsmError.legalEvents).toEqual(["attempt(Plan)"]);
		expect(fsmError.message).toContain("disk full");
		expect(fsmError.cause).toBe(cause);
	});

	test("checkpoint and cleanup save failures are classified as transient", () => {
		const cause = new Error("write failed");
		const saveFails: PhaseLoopStore = {
			load: () => ({ status: "absent" }),
			save: () => {
				throw cause;
			},
		};
		const checkpointError = captureError(() =>
			checkpointPhaseLoop(saveFails, "claude", "pause", AT),
		);
		expect(checkpointError).toBeInstanceOf(FsmError);
		expect((checkpointError as FsmError).kind).toBe("transient");
		expect((checkpointError as FsmError).cause).toBe(cause);

		const completed: PhaseLoopRecord = {
			runtimeId: "claude",
			phaseOrder: ["Discuss", "Plan", "Execute", "Verify", "Ship"],
			executeStarts: 1,
			shipStarts: 1,
			operatorConfirmations: 1,
			humanItems: [],
			closedBy: { kind: "audit", recordId: "audit-1", recordedAt: AT },
			schemaVersion: FSM_SCHEMA_VERSION,
		};
		const cleanupStore: PhaseLoopStore = {
			load: () => ({ status: "found", record: completed }),
			save: () => {
				throw cause;
			},
		};
		const cleanupError = captureError(() =>
			cleanupPhaseLoop(cleanupStore, "claude", "alice", AT, {
				actor: "alice",
				reason: "merge completed",
				allowedActors: ["alice"],
			}),
		);
		expect(cleanupError).toBeInstanceOf(FsmError);
		expect((cleanupError as FsmError).kind).toBe("transient");
		expect((cleanupError as FsmError).cause).toBe(cause);
	});

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
			{ id: "h1", owner: "alice", state: "open", severity: "normal" },
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
		recordAudit("claude", { ...PASSING_AUDIT, id: "decision-2" }, store);
		open("claude", { id: "h1", owner: "alice" }, store);
		const deferred = resolve(
			"claude",
			"h1",
			{ state: "deferred", decisionId: "decision-2" },
			store,
		);
		expect(deferred.accepted).toBe(true);
		expect(deferred.state.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "deferred", decisionId: "decision-2", severity: "normal" },
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
		expect(refused.state.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "open", severity: "normal" },
		]);
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
		const done = resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: "alice", resolvedAt: AT },
			store,
		);
		expect(done.accepted).toBe(true);
		expect(done.state.humanItems).toEqual([
			{
				id: "h1",
				owner: "alice",
				state: "done",
				evidenceId: "e1",
				resolvedBy: "alice",
				resolvedAt: AT,
				severity: "normal",
			},
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
		resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: "alice", resolvedAt: AT },
			store,
		);
		resetPhaseLoopStateForTests();
		const restored = restorePhaseLoop(fileStore(dir), "claude");
		expect(restored.state.humanItems).toEqual([
			{
				id: "h1",
				owner: "alice",
				state: "done",
				evidenceId: "e1",
				resolvedBy: "alice",
				resolvedAt: AT,
				severity: "normal",
			},
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
			{ id: "h1", owner: "alice", state: "open", severity: "normal" },
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
				severity: "normal",
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
			{ id: "h2", owner: "alice", state: "open", severity: "normal", afterShip: true },
		]);
		expect(storedRecord(dir, "claude")?.audits).toEqual([PASSING_AUDIT]);
		const cleared = resolve(
			"claude",
			"h2",
			{ state: "done", evidenceId: "e2", resolvedBy: "alice", resolvedAt: AT },
			store,
		);
		expect(cleared.accepted).toBe(true);
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{
				id: "h2",
				owner: "alice",
				state: "done",
				evidenceId: "e2",
				resolvedBy: "alice",
				resolvedAt: AT,
				severity: "normal",
				afterShip: true,
			},
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

	test("P4 open with at sets createdAt and severity SLA dueAt (critical 4h, high 24h, normal 72h)", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		expect(
			open("claude", { id: "hc", owner: "alice" }, store, { severity: "critical" }, { at: AT })
				.accepted,
		).toBe(true);
		expect(
			open("claude", { id: "hh", owner: "alice" }, store, { severity: "high" }, { at: AT })
				.accepted,
		).toBe(true);
		expect(open("claude", { id: "hn", owner: "alice" }, store, {}, { at: AT }).accepted).toBe(true);
		expect(open("claude", { id: "hx", owner: "alice" }, store).accepted).toBe(true);
		const items = storedRecord(dir, "claude")?.humanItems ?? [];
		expect(items.find((i) => i.id === "hc")).toMatchObject({
			createdAt: AT,
			severity: "critical",
			dueAt: "2026-11-17T14:00:00.000Z",
		});
		expect(items.find((i) => i.id === "hh")).toMatchObject({
			createdAt: AT,
			severity: "high",
			dueAt: "2026-11-18T10:00:00.000Z",
		});
		expect(items.find((i) => i.id === "hn")).toMatchObject({
			createdAt: AT,
			severity: "normal",
			dueAt: "2026-11-20T10:00:00.000Z",
		});
		expect(items.find((i) => i.id === "hx")).toMatchObject({ severity: "normal" });
		expect(items.find((i) => i.id === "hx")?.createdAt).toBeUndefined();
		expect(items.find((i) => i.id === "hx")?.dueAt).toBeUndefined();
	});

	test("P4 done needs resolvedBy and resolvedAt; missing either is refused and stays open", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		expect(resolve("claude", "h1", { state: "done", evidenceId: "e1" }, store).refusals).toEqual([
			"done HTIL entry h1 needs resolvedBy",
		]);
		expect(
			resolve("claude", "h1", { state: "done", evidenceId: "e1", resolvedBy: "alice" }, store)
				.refusals,
		).toEqual(["done HTIL entry h1 needs resolvedAt"]);
		expect(storedRecord(dir, "claude")?.humanItems).toEqual([
			{ id: "h1", owner: "alice", state: "open", severity: "normal" },
		]);
		const done = resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: "alice", resolvedAt: AT },
			store,
		);
		expect(done.accepted).toBe(true);
		expect(done.state.humanItems[0]).toMatchObject({
			state: "done",
			resolvedBy: "alice",
			resolvedAt: AT,
		});
	});

	test("P4 deferred needs a recorded decision; audit id and override decisionId are accepted", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		const unknown = resolve("claude", "h1", { state: "deferred", decisionId: "nope" }, store);
		expect(unknown.accepted).toBe(false);
		expect(unknown.refusals[0]).toContain("recorded decision");
		expect(unknown.refusals[0]).toContain("nope");
		expect(unknown.state.humanItems[0]?.state).toBe("open");
		expect(
			resolve("claude", "h1", { state: "deferred", decisionId: "audit-1" }, store).accepted,
		).toBe(true);
		expect(storedRecord(dir, "claude")?.humanItems[0]?.state).toBe("deferred");
		// Override decisionId on a Ship-closed loop's reconcile entry.
		const { store: store2 } = countingStore(dir);
		reachVerify("bob", store2);
		expect(
			confirmShip("bob", { afterVerify: true, override: OWNER_OVERRIDE }, CONNECTED, store2)
				.accepted,
		).toBe(true);
		open("bob", { id: "h2", owner: "alice" }, store2, { afterShip: true });
		expect(
			resolve("bob", "h2", { state: "deferred", decisionId: "decision-1" }, store2).accepted,
		).toBe(true);
	});

	test("P4 escalation moves owner, counts, logs transition, and refuses bad targets", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store, { severity: "high" }, { at: AT });
		expect(escalateHtilEntry("claude", "missing", "bob", store).refusals).toEqual([
			"HTIL entry missing does not exist",
		]);
		expect(escalateHtilEntry("claude", "h1", " ", store).accepted).toBe(false);
		expect(escalateHtilEntry("claude", "h1", "alice", store).refusals).toEqual([
			"HTIL entry h1 target owner is the same as its current owner",
		]);
		const first = escalateHtilEntry("claude", "h1", "bob", store, { at: AT });
		expect(first.accepted).toBe(true);
		expect(first.state.humanItems[0]).toMatchObject({
			owner: "bob",
			escalatedTo: "bob",
			escalationCount: 1,
		});
		expect(first.state.transitions?.map((t) => t.event)).toContain("escalate(HTIL h1)");
		const second = escalateHtilEntry("claude", "h1", "carol", store, { at: AT });
		expect(second.state.humanItems[0]).toMatchObject({
			owner: "carol",
			escalatedTo: "carol",
			escalationCount: 2,
		});
		resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: "carol", resolvedAt: AT },
			store,
		);
		expect(escalateHtilEntry("claude", "h1", "dave", store).refusals).toEqual([
			"HTIL entry h1 is already done",
		]);
	});

	test("P4 escalation on a closed loop is refused", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		recordPassing("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store);
		resolve(
			"claude",
			"h1",
			{ state: "done", evidenceId: "e1", resolvedBy: "alice", resolvedAt: AT },
			store,
		);
		expect(confirmShip("claude", passing(), CONNECTED, store).accepted).toBe(true);
		expect(escalateHtilEntry("claude", "h1", "bob", store).accepted).toBe(false);
	});

	test("P4 status overdue lists open entries past dueAt, skips legacy entries without dueAt", () => {
		const { store } = countingStore(dir);
		reachVerify("claude", store);
		open("claude", { id: "h1", owner: "alice" }, store, { severity: "high" }, { at: AT });
		const state = storedRecord(dir, "claude") as unknown as PhaseLoopState;
		const before = phaseLoopStatus(state, undefined, "2026-11-18T09:59:59.000Z");
		expect(before.signals.overdue).toBeUndefined();
		const after = phaseLoopStatus(state, undefined, "2026-11-18T10:00:01.000Z");
		expect(after.signals.overdue).toEqual([
			{ entryId: "h1", owner: "alice", severity: "high", dueAt: "2026-11-18T10:00:00.000Z" },
		]);
		expect(after.nextEvents).toEqual(["resolve(HTIL)", "escalate(HTIL)"]);
		const legacy: PhaseLoopState = {
			runtimeId: "legacy",
			phaseOrder: ["Discuss"],
			executeStarts: 0,
			shipStarts: 0,
			operatorConfirmations: 0,
			humanItems: [{ id: "old", owner: "alice", state: "open" }],
		};
		expect(
			phaseLoopStatus(legacy, undefined, "2027-01-01T00:00:00.000Z").signals.overdue,
		).toBeUndefined();
		expect(phaseLoopStatus(legacy).lifecycle).toBe("awaiting-decision");
	});

	test("P4 legacy entry without escalation fields escalates from count zero", () => {
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
				humanItems: [{ id: "old", owner: "alice", state: "open" }],
			}),
		);
		const escalated = escalateHtilEntry("claude", "old", "bob", store, { at: AT });
		expect(escalated.accepted).toBe(true);
		expect(escalated.state.humanItems[0]).toMatchObject({
			owner: "bob",
			escalatedTo: "bob",
			escalationCount: 1,
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
		expect(status.nextEvents).toEqual(["resolve(HTIL)", "escalate(HTIL)"]);
		resolve(id, "h1", { state: "done", evidenceId: "e1", resolvedBy: "alice", resolvedAt: AT });
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

	test("P3 refused attempt without recordRefusals leaves the persisted store unchanged", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-p3-unchanged-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store, { at: AT });
			const file = readdirSync(dir).find((name) => name.endsWith(".json"));
			if (file === undefined) throw new Error("no record file");
			const before = readFileSync(join(dir, file), "utf8");
			const refused = attemptPhase("claude", { phase: "Execute", ...READY }, CONNECTED, store, {
				at: AT,
			});
			expect(refused.accepted).toBe(false);
			expect(readFileSync(join(dir, file), "utf8")).toBe(before);
			expect(localRecord(dir, "claude")?.transitions).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("P3 refused attempt with at + recordRefusals persists seq/source/traceId/refusalCodes without moving counters", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-p3-refused-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store, { at: AT });
			const refused = attemptPhase("claude", { phase: "Execute", ...READY }, CONNECTED, store, {
				at: AT,
				recordRefusals: true,
				source: "omp",
				traceId: "trace-1",
			});
			expect(refused.accepted).toBe(false);
			const stored = localRecord(dir, "claude");
			expect(stored?.phaseOrder).toEqual(["Discuss"]);
			expect(stored?.executeStarts).toBe(0);
			expect(stored?.transitions).toHaveLength(2);
			expect(stored?.transitions?.at(-1)).toMatchObject({
				event: "attempt(Execute)",
				accepted: false,
				seq: 2,
				source: "omp",
				traceId: "trace-1",
				refusalCodes: ["Execute is not the next phase"],
				refusals: ["Execute is not the next phase"],
			});
			expect(stored?.transitionSeq).toBe(2);
			expect(stored?.transitionStats).toEqual({ attempts: 2, accepted: 1, refused: 1 });
			expect(refused.state.transitions?.at(-1)).toMatchObject({ seq: 2, source: "omp" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("P3 60 timestamped attempts keep the ring at 50 while status totals reach 60", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-p3-sixty-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			const stamp = (index: number) => `2026-11-17T10:00:${String(index).padStart(2, "0")}.000Z`;
			attemptPhase("claude", { phase: "Discuss", ...READY }, CONNECTED, store, { at: stamp(0) });
			for (let index = 1; index < 60; index++) {
				attemptPhase("claude", { phase: "Execute", ...READY }, CONNECTED, store, {
					at: stamp(index),
					recordRefusals: true,
					source: "direct",
				});
			}
			const stored = localRecord(dir, "claude");
			expect(stored?.transitions?.length).toBeLessThanOrEqual(50);
			expect(stored?.transitions).toHaveLength(50);
			expect(stored?.transitionSeq).toBe(60);
			expect(stored?.transitionStats).toEqual({ attempts: 60, accepted: 1, refused: 59 });
			const status = phaseLoopStatus(stored as PhaseLoopState);
			expect(status.transitionMetrics).toEqual({ attempts: 60, accepted: 1, refused: 59 });
			expect(status.recentTransitions).toHaveLength(5);
			expect(status.recentTransitions.at(-1)).toMatchObject({ seq: 60, accepted: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("P3 snapshot deep-copies transition refusals arrays", () => {
		const id = "claude";
		const first = attemptPhase(id, { phase: "Discuss", ...READY }, CONNECTED, undefined, {
			at: AT,
		}).state;
		(first.transitions?.[0]?.refusals as string[] | undefined)?.push("tampered");
		const second = attemptPhase(id, { phase: "Plan", ...READY }, CONNECTED, undefined, {
			at: AT,
		}).state;
		expect(second.transitions?.[0]?.refusals).toEqual([]);
	});

	test("P3 legacy transitions migrate counters on the next recorded attempt", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-p3-legacy-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			store.save("legacy", {
				runtimeId: "legacy",
				phaseOrder: ["Discuss"],
				executeStarts: 0,
				shipStarts: 0,
				operatorConfirmations: 0,
				humanItems: [],
				runtimeSessionId: "legacy",
				transitions: [
					{
						at: AT,
						from: "ready",
						event: "attempt(Discuss)",
						to: "discussing",
						accepted: true,
						refusals: [],
					},
					{
						at: AT,
						from: "discussing",
						event: "attempt(Execute)",
						to: "discussing",
						accepted: false,
						refusals: ["Execute is not the next phase"],
					},
				],
			});
			const legacyStatus = phaseLoopStatus(localRecord(dir, "legacy") as PhaseLoopState);
			expect(legacyStatus.transitionMetrics).toEqual({ attempts: 2, accepted: 1, refused: 1 });
			attemptPhase("legacy", { phase: "Plan", ...READY }, CONNECTED, store, { at: AT });
			const stored = localRecord(dir, "legacy");
			expect(stored?.transitionStats).toEqual({ attempts: 3, accepted: 2, refused: 1 });
			expect(stored?.transitionSeq).toBe(3);
			expect(stored?.transitions?.at(-1)).toMatchObject({ event: "attempt(Plan)", seq: 3 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("P3 repairRuntimeMarker sets the marker and records a repairRuntime transition", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-p3-repair-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			const seed = (runtimeId: string, extra?: Partial<PhaseLoopRecord>): void =>
				store.save(runtimeId, {
					runtimeId,
					phaseOrder: ["Discuss"],
					executeStarts: 0,
					shipStarts: 0,
					operatorConfirmations: 0,
					humanItems: [],
					...extra,
				});
			seed("legacy");
			const repaired = repairRuntimeMarker(store, "legacy", {
				reason: "owner confirmed the session",
				at: AT,
			});
			expect(repaired.accepted).toBe(true);
			const stored = localRecord(dir, "legacy");
			expect(stored?.runtimeSessionId).toBe("legacy");
			expect(stored?.runtimeRepair).toEqual({ reason: "owner confirmed the session", at: AT });
			expect(stored?.schemaVersion).toBe(FSM_SCHEMA_VERSION);
			expect(stored?.transitions?.at(-1)).toMatchObject({
				event: "repairRuntime",
				accepted: true,
				at: AT,
			});
			const again = repairRuntimeMarker(store, "legacy", { reason: "second", at: AT });
			expect(again.accepted).toBe(false);
			expect(again.refusals.join(" ")).toContain("already");
			expect(localRecord(dir, "legacy")?.runtimeRepair?.reason).toBe("owner confirmed the session");
			seed("blank-reason");
			const blankReason = repairRuntimeMarker(store, "blank-reason", { reason: "  ", at: AT });
			expect(blankReason.accepted).toBe(false);
			expect(blankReason.refusals.join(" ")).toContain("reason");
			expect(localRecord(dir, "blank-reason")?.runtimeSessionId).toBeUndefined();
			seed("blank-at");
			const blankAt = repairRuntimeMarker(store, "blank-at", { reason: "owner", at: "" });
			expect(blankAt.accepted).toBe(false);
			expect(blankAt.refusals.join(" ")).toContain("at");
			expect(localRecord(dir, "blank-at")?.runtimeSessionId).toBeUndefined();
			seed("cleaned", { cleanedUpAt: AT, cleanedUpBy: "alice" });
			const cleaned = repairRuntimeMarker(store, "cleaned", { reason: "owner", at: AT });
			expect(cleaned.accepted).toBe(false);
			expect(cleaned.refusals.join(" ")).toContain("cleaned-up");
			expect(localRecord(dir, "cleaned")?.runtimeSessionId).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
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
					cleanupPhaseLoop(store, "claude", "alice", AT, {
						actor: "alice",
						reason: "merge completed",
						allowedActors: ["alice"],
					});
				} catch (error) {
					return error;
				}
				return undefined;
			})();
			expect(early).toBeInstanceOf(FsmError);
			expect((early as FsmError).kind).toBe("guard");
			recordPassing("claude", store);
			confirmShip("claude", passing(), CONNECTED, store);
			cleanupPhaseLoop(store, "claude", "alice", AT, {
				actor: "alice",
				reason: "merge completed",
				allowedActors: ["alice"],
			});
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
	test("status derives transition metrics, duplicate accepted events and stuck signals", () => {
		const row: PhaseLoopState = {
			runtimeId: "claude",
			phaseOrder: ["Discuss"],
			executeStarts: 0,
			shipStarts: 0,
			operatorConfirmations: 0,
			humanItems: [],
			transitions: [
				{
					at: AT,
					from: "ready",
					event: "attempt(Discuss)",
					to: "discussing",
					accepted: true,
					refusals: [],
				},
				{
					at: AT,
					from: "ready",
					event: "attempt(Discuss)",
					to: "discussing",
					accepted: true,
					refusals: [],
				},
			],
		};
		const status = phaseLoopStatus(row, undefined, "2026-11-20T10:00:00.000Z");
		expect(status.transitionMetrics).toEqual({ attempts: 2, accepted: 2, refused: 0 });
		expect(status.recentTransitions).toHaveLength(2);
		expect(status.signals).toEqual({
			duplicateAccepted: { event: "attempt(Discuss)", count: 2, at: AT },
			stuck: { lifecycle: "discussing", since: AT },
		});
	});

	test("cleanup validates actor authorization and records the reason", () => {
		const root = mkdtempSync(join(tmpdir(), "phase-loop-cleanup-auth-"));
		try {
			const dir = join(root, "state");
			const store = fileStore(dir);
			for (const phase of ["Discuss", "Plan", "Execute", "Verify"] as const) {
				attemptPhase("claude", { phase, ...READY }, CONNECTED, store);
			}
			recordPassing("claude", store);
			confirmShip("claude", passing(), CONNECTED, store);
			const captureError = (run: () => unknown): unknown => {
				try {
					run();
				} catch (error) {
					return error;
				}
				return undefined;
			};
			const unauthorized = captureError(() =>
				cleanupPhaseLoop(store, "claude", "maillory", AT, {
					actor: "maillory",
					reason: "cleanup",
					allowedActors: ["alice"],
				}),
			);
			expect(unauthorized).toBeInstanceOf(FsmError);
			expect((unauthorized as FsmError).kind).toBe("guard");
			expect((unauthorized as FsmError).message).toContain("cleanup actor is not authorized");
			const blankReason = captureError(() =>
				cleanupPhaseLoop(store, "claude", "alice", AT, {
					actor: "alice",
					reason: "   ",
					allowedActors: ["alice"],
				}),
			);
			expect(blankReason).toBeInstanceOf(FsmError);
			expect((blankReason as FsmError).message).toContain("cleanup needs a reason");
			cleanupPhaseLoop(store, "claude", "alice", AT, {
				actor: "alice",
				reason: "merge completed",
				allowedActors: ["alice"],
			});
			const cleaned = localRecord(dir, "claude");
			expect(cleaned?.cleanedUpBy).toBe("alice");
			expect(cleaned?.cleanedUpReason).toBe("merge completed");
			expect(cleaned?.transitions?.at(-1)).toMatchObject({
				event: "cleanup",
				accepted: true,
				at: AT,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
