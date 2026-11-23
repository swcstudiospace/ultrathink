// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Primary-session uplift gate (ADR-0001). Pure: no timers, no host I/O.
 * Completeness is `checkUpliftXml` (ROOT_TAGS and required children). This module does not keep a second tag list.
 * Restructured for SESSION_START_FIX: exports GatePhase, deliverUplift accepts currentPhase to refuse in GENERATING.
 */
import { redactSecrets } from "../redact.ts";
import { checkUpliftXml } from "../uplift/xml.ts";

/** Inclusive bound. 600001 ms with no complete uplift is `UPLIFT_WAIT_EXCEEDED`, not a planner timeout. */
export const WAIT_BOUND_MS = 600_000;

/** Prefix of operator status. Callers build the rest with `holdStatus`. */
export const HOLD_STATUS_PREFIX = "Ultrathink gate status: ";

const WAIT_EXCEEDED_MS = WAIT_BOUND_MS + 1;

export type UpliftWaitCode = "UPLIFT_WAIT_EXCEEDED";

/** Session initiation gate phases (n2/GoT/SESSION_START_FIX/US-1). GENERATING held for entire GoT+CoT+ToT+PRD; complete XML (incl sub-PRDs) emitted only at XML_COMPLETE transition; explicit WAITING (long/hybrid 5-10min per ADR-0001, no signals/triggers/handoffs); only to ISSUED on explicit issuance. */
export type GatePhase = "GENERATING" | "XML_COMPLETE" | "WAITING" | "ISSUED";

export interface DeliverUpliftInput {
	plannable: boolean;
	primarySession: boolean;
	arrivedAtMs: number;
	xml?: string;
	secretScanMatches: number;
	/** Current gate phase for enforcement (restructure). */
	currentPhase?: GatePhase;
}

export interface DeliverUpliftResult {
	delivered: 0 | 1;
	workTurns: number;
	timeoutFailureEvents: 0;
	secretScanMatches: 0;
	code?: UpliftWaitCode;
}

function originalChildText(xml: string): string {
	const open = xml.search(/<ORIGINAL\b[^>]*>/i);
	if (open === -1) return "";
	const start = xml.indexOf(">", open);
	if (start === -1) return "";
	const close = xml.toLowerCase().indexOf("</original>", start + 1);
	if (close === -1) return "";
	return xml.slice(start + 1, close);
}

/** One closed uplift root with the required children, as `checkUpliftXml` already defines it. */
export function isCompleteUplift(xml: string): boolean {
	if (typeof xml !== "string" || xml.trim() === "") return false;
	return checkUpliftXml(xml, originalChildText(xml)).ok === true;
}

/**
 * A difference after `redactSecrets` is one match. There is no separate count export in `src/redact.ts`.
 * The count is never the secret text.
 */
export function countSecretScanMatches(text: string): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	return redactSecrets(text) === text ? 0 : 1;
}

const REFUSED: DeliverUpliftResult = {
	delivered: 0,
	workTurns: 0,
	timeoutFailureEvents: 0,
	secretScanMatches: 0,
};
/**
 * Whether one uplift may enter agent context. Wait is not this function's job.
 * `secretScanMatches` on the result is always 0 so a match count cannot carry secret text.
 * Restructured per SESSION_START_FIX: honors currentPhase; during GENERATING refuses non-complete (enforce full stages before any emit of complete XML).
 */
export function deliverUplift(input: DeliverUpliftInput): DeliverUpliftResult {
	if (!input.plannable || !input.primarySession) return REFUSED;
	if (input.secretScanMatches > 0) return REFUSED;
	const xml = input.xml;
	const complete = typeof xml === "string" && isCompleteUplift(xml);
	const arrivedAtMs = input.arrivedAtMs;
	// Restructured: refuse incomplete during GENERATING (full stages); only complete XML allowed to proceed toward ISSUED.
	// Caller manages XML_COMPLETE -> WAITING -> explicit ISSUED.
	if (input.currentPhase === "GENERATING" && !complete) {
		return REFUSED;
	}
	if (
		complete &&
		arrivedAtMs >= 0 &&
		arrivedAtMs <= WAIT_BOUND_MS &&
		input.secretScanMatches === 0
	) {
		return {
			delivered: 1,
			workTurns: 1,
			timeoutFailureEvents: 0,
			secretScanMatches: 0,
		};
	}
	if (arrivedAtMs >= WAIT_EXCEEDED_MS && !complete) {
		return { ...REFUSED, code: "UPLIFT_WAIT_EXCEEDED" };
	}
	return REFUSED;
}

/**
 * Plain operator status, at most 200 characters. Includes the elapsed seconds as an integer and
 * `waiting` or `failed`, so color is not the only signal. Does not authorize reads, edits, or commands.
 */
export function holdStatus(elapsedMs: number, failed: boolean): string {
	const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.trunc(elapsedMs / 1000)) : 0;
	const word = failed ? "failed" : "waiting";
	const text = `${HOLD_STATUS_PREFIX}${word} ${seconds} seconds. This note is not a plan and does not start work.`;
	return text.length > 200 ? text.slice(0, 200) : text;
}
