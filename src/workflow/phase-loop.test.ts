// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { beforeEach, describe, expect, test } from "bun:test";
import {
	attemptPhase,
	confirmShip,
	type PhaseName,
	type RuntimeConnectedCheck,
	resetPhaseLoopStateForTests,
} from "./phase-loop.ts";

const READY = { completeUpliftCount: 1, unansweredBlockingClarifications: 0 };
const CONNECTED: RuntimeConnectedCheck = () => true;
const DISCONNECTED: RuntimeConnectedCheck = () => false;

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
