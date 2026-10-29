// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export const ROOT_TAGS = [
	"BUILD_PROMPT",
	"FIX_PROMPT",
	"RESEARCH_PROMPT",
	"CHANGE_PROMPT",
	"UPLIFTED_PROMPT",
] as const;

export interface UpliftResult {
	xml: string;
	original: string;
	root: string;
	source: "llm" | "fallback";
	/** Why the uplift fell back: `provider_error:<http status>`, `provider_error`, `empty_reply`, `truncated_reply`, `unparseable_reply` or `input_over_limit`. Absent for `llm`. */
	fallbackReason?: string;
	/** Characters in the raw model reply; 0 when there was no reply. */
	rawReplyChars?: number;
	/** Completion attempts made for the uplift call, transient retries included. */
	attempts?: number;
}

/** What a completer reports about its most recent call: attempts, HTTP status, the server's retry hint and a redacted cause, never the reply text. */
export interface CompletionReport {
	attempts: number;
	httpStatus?: number;
	/** Milliseconds the provider asked us to wait (Retry-After), clamped by the retry kernel. */
	retryAfterMs?: number;
	/** Redacted, single-line cause of the last failure, at most 200 characters. */
	cause?: string;
}

const REPORT_KEY = Symbol.for("ultrathink.completionReport");

/**
 * Attaches a completion report to the error a completer throws, so the stage that catches it can say why the call failed.
 * Non-enumerable, so message snapshots and JSON stay clean; `Symbol.for` so two loaded copies of this module agree.
 */
export function attachReport(error: unknown, report: CompletionReport): void {
	if (typeof error !== "object" || error === null) return;
	try {
		Object.defineProperty(error, REPORT_KEY, {
			value: report,
			enumerable: false,
			configurable: true,
			writable: true,
		});
	} catch {
		// reason: a frozen or exotic error object cannot carry the report; the caller keeps its own bookkeeping
	}
}

/** How many `cause` links `readReport` follows: a wrapper (`PlanCompleterError`, `FailoverError`, `RetryExhaustedError`) may sit a few levels above the error the completer reported on. */
const REPORT_CAUSE_DEPTH = 4;

function ownReport(error: object): CompletionReport | undefined {
	const value = (error as Record<symbol, unknown>)[REPORT_KEY];
	if (typeof value !== "object" || value === null) return undefined;
	const report = value as Partial<CompletionReport>;
	return typeof report.attempts === "number" && Number.isFinite(report.attempts)
		? (report as CompletionReport)
		: undefined;
}

/**
 * The report attached by `attachReport` to the error or, failing that, to the nearest of its `cause` chain (at most four
 * levels), or `undefined` when there is none or it is not shaped like one. Never throws.
 */
export function readReport(error: unknown): CompletionReport | undefined {
	let current: unknown = error;
	for (let depth = 0; depth <= REPORT_CAUSE_DEPTH; depth++) {
		if (typeof current !== "object" || current === null) return undefined;
		try {
			const report = ownReport(current);
			if (report !== undefined) return report;
			current = Reflect.get(current, "cause");
		} catch {
			// reason: a hostile getter must not turn error reporting into a second failure
			return undefined;
		}
	}
	return undefined;
}

export interface UpliftState {
	enabled: boolean;
	skipOnce: boolean;
	skipTrivial: boolean;
}

export type UpliftDecision =
	| { action: "skip" }
	| { action: "passthrough"; text: string }
	| { action: "uplift"; text: string };
