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
	/** Why the uplift fell back: `provider_error:<http status>`, `provider_error`, `empty_reply`, `truncated_reply`, `unparseable_reply`, or, on older records only, `input_over_limit`. Absent for `llm`. */
	fallbackReason?: string;
	/** Characters in the raw model reply; 0 when there was no reply. */
	rawReplyChars?: number;
	/** Completion attempts made for the uplift call, transient retries included. */
	attempts?: number;
}

/** The `cause` of the report for a reply the model cut off at its token limit: the reply failed, the provider did not. */
export const TRUNCATED_REPLY = "truncated_reply";

export interface UpliftState {
	enabled: boolean;
	skipOnce: boolean;
	skipTrivial: boolean;
	/** uplift.maxChars: a prompt longer than this is skipped before any provider call; absent or 0 means no limit. */
	maxChars?: number;
}

export type UpliftDecision =
	| { action: "skip" }
	| { action: "passthrough"; text: string }
	| { action: "uplift"; text: string };
