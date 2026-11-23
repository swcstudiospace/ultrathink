// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../redact.ts";
import {
	HOLD_STATUS_PREFIX,
	WAIT_BOUND_MS,
	countSecretScanMatches,
	deliverUplift,
	holdStatus,
	isCompleteUplift,
} from "./uplift-gate.ts";

const ORIGINAL = "ship the widget";

function closedRoot(root: string, contextTag = "CONTEXT"): string {
	return `<${root}>
<ORIGINAL>${ORIGINAL}</ORIGINAL>
<SYSTEM_ROLE>role</SYSTEM_ROLE>
<SCOPE>scope</SCOPE>
<CONSTRAINTS>constraints</CONSTRAINTS>
<ACCEPTANCE_CRITERIA>criteria</ACCEPTANCE_CRITERIA>
<${contextTag}>context</${contextTag}>
</${root}>`;
}

const COMPLETE = closedRoot("BUILD_PROMPT");

describe("deliverUplift", () => {
	test("AC-1: a complete uplift at 300000 ms delivers one work turn and zero timeout failures", () => {
		expect(isCompleteUplift(COMPLETE)).toBe(true);
		expect(
			deliverUplift({
				plannable: true,
				primarySession: true,
				arrivedAtMs: 300_000,
				xml: COMPLETE,
				secretScanMatches: 0,
			}),
		).toEqual({
			delivered: 1,
			workTurns: 1,
			timeoutFailureEvents: 0,
			secretScanMatches: 0,
		});
	});

	test("AC-2: a complete uplift at the inclusive bound delivers one work turn and zero timeout failures", () => {
		expect(WAIT_BOUND_MS).toBe(600_000);
		expect(
			deliverUplift({
				plannable: true,
				primarySession: true,
				arrivedAtMs: 600_000,
				xml: COMPLETE,
				secretScanMatches: 0,
			}),
		).toEqual({
			delivered: 1,
			workTurns: 1,
			timeoutFailureEvents: 0,
			secretScanMatches: 0,
		});
	});

	test("AC-3: no complete uplift at 600001 ms is UPLIFT_WAIT_EXCEEDED and not a timeout failure", () => {
		const result = deliverUplift({
			plannable: true,
			primarySession: true,
			arrivedAtMs: 600_001,
			secretScanMatches: 0,
		});
		expect(result.delivered).toBe(0);
		expect(result.workTurns).toBe(0);
		expect(result.timeoutFailureEvents).toBe(0);
		expect(result.code).toBe("UPLIFT_WAIT_EXCEEDED");
	});

	test("AC-4: a non-plannable prompt delivers nothing and waits in this function", () => {
		expect(
			deliverUplift({
				plannable: false,
				primarySession: true,
				arrivedAtMs: 0,
				xml: COMPLETE,
				secretScanMatches: 0,
			}),
		).toEqual({
			delivered: 0,
			workTurns: 0,
			timeoutFailureEvents: 0,
			secretScanMatches: 0,
		});
	});

	test("a secret-scan match refuses delivery and does not echo secret text", () => {
		const secret = "sk-live-abcdefghijklmnopqrstuvwxyz012345";
		const xml = COMPLETE.replace("context", secret);
		expect(countSecretScanMatches(xml)).toBe(1);
		expect(redactSecrets(xml)).not.toBe(xml);
		const result = deliverUplift({
			plannable: true,
			primarySession: true,
			arrivedAtMs: 1,
			xml,
			secretScanMatches: countSecretScanMatches(xml),
		});
		expect(result.delivered).toBe(0);
		expect(result.workTurns).toBe(0);
		expect(result.code).toBeUndefined();
		expect(result.secretScanMatches).toBe(0);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	test("incomplete xml before the bound delivers nothing and has no wait code", () => {
		expect(
			deliverUplift({
				plannable: true,
				primarySession: true,
				arrivedAtMs: 1,
				xml: "<BUILD_PROMPT><SCOPE>only</SCOPE>",
				secretScanMatches: 0,
			}),
		).toEqual({
			delivered: 0,
			workTurns: 0,
			timeoutFailureEvents: 0,
			secretScanMatches: 0,
		});
	});
});

describe("isCompleteUplift", () => {
	test("AC-5: a closed known root with the required children is complete", () => {
		for (const root of [
			"BUILD_PROMPT",
			"FIX_PROMPT",
			"RESEARCH_PROMPT",
			"CHANGE_PROMPT",
			"UPLIFTED_PROMPT",
		]) {
			expect(isCompleteUplift(closedRoot(root))).toBe(true);
		}
		expect(isCompleteUplift(closedRoot("BUILD_PROMPT", "APP_CONTEXT"))).toBe(true);
	});

	test("AC-5: an unclosed root, a missing child, or an unknown root is not complete", () => {
		expect(isCompleteUplift(closedRoot("BUILD_PROMPT").replace("</BUILD_PROMPT>", ""))).toBe(false);
		expect(
			isCompleteUplift(closedRoot("BUILD_PROMPT").replace(/<SCOPE>[\s\S]*?<\/SCOPE>\n/, "")),
		).toBe(false);
		expect(isCompleteUplift(closedRoot("NOTE"))).toBe(false);
	});
});

describe("holdStatus", () => {
	test("names elapsed seconds and waiting or failed without authorizing tools", () => {
		const waiting = holdStatus(300_000, false);
		const failed = holdStatus(600_001, true);
		for (const text of [waiting, failed]) {
			expect(text.startsWith(HOLD_STATUS_PREFIX)).toBe(true);
			expect(text.length).toBeLessThanOrEqual(200);
			expect(text).not.toMatch(/\bread\b/i);
			expect(text).not.toMatch(/\bedit/i);
			expect(text).not.toMatch(/\bcommand/i);
			expect(text).not.toContain("read and investigate");
		}
		expect(waiting).toContain("waiting");
		expect(waiting).toContain("300");
		expect(failed).toContain("failed");
		expect(failed).toContain("600");
		expect(isCompleteUplift(waiting)).toBe(false);
		expect(isCompleteUplift(failed)).toBe(false);
	});
});
