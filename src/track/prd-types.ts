// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { RetryPolicy } from "../resilience/retry.ts";
import type { abortableSleep } from "../resilience/sleep.ts";
import type { ToolCaller } from "./create.ts";
import type { IssueRef } from "./types.ts";

export type TrackerName = "linear" | "notion";

/** What one tracker did for one PRD in this run. */
export type SyncOutcome = "created" | "updated" | "skipped" | "failed" | "pending";

/** The ledger's view of one tracker for one PRD. `synced` + `lastHash === hash` means nothing is owed. */
export type LedgerStatus = "pending" | "synced" | "failed";

export interface LedgerTracker {
	status: LedgerStatus;
	/** Hash of the PRD last written to this tracker. */
	lastHash?: string;
	/** Tracker calls spent on this PRD over every run (cumulative). */
	attempts: number;
	/** Secret-free failure class, e.g. `rate-limit`, `server`, `auth`, `missing-sub-issue`. Never an error message. */
	errorClass?: string;
	url?: string;
	/** Linear: the linked document holding an over-threshold PRD. */
	docId?: string;
	docUrl?: string;
	updatedAt: number;
}

export interface LedgerEntry {
	key: string;
	/** Hash of the PRD as last written locally. */
	hash: string;
	/** Local copy of the (secret-redacted) PRD, written before any network call. */
	localPath: string;
	linearIssueId?: string;
	notionPageId?: string;
	/** Notion block ids appended by a write that has not finished; removed by the next run. */
	notionStagedIds?: string[];
	linear: LedgerTracker;
	notion: LedgerTracker;
}

export interface PrdLedger {
	version: 1;
	graphId: string;
	entries: LedgerEntry[];
}

export interface TrackerResult {
	outcome: SyncOutcome;
	url?: string;
	/** Tracker calls made for this PRD in this run. */
	attempts: number;
	/** Why nothing was written: `not-configured`, `unchanged`, `prd-failed`, `aborted`... */
	reason?: string;
	errorClass?: string;
	/** Short, secret-redacted failure text. */
	error?: string;
}

export interface KeyReport {
	key: string;
	/** `failed` if any tracker failed or the PRD itself failed; else `pending` if any is pending; else `synced`. */
	state: "synced" | "pending" | "failed";
	/** True when the secret scan masked something in the PRD before it was stored or uploaded. */
	redacted: boolean;
	linear: TrackerResult;
	notion: TrackerResult;
}

export interface SyncSummary {
	total: number;
	synced: number;
	pending: number;
	failed: number;
}

export interface SyncReport {
	graphId: string;
	keys: readonly KeyReport[];
	summary: SyncSummary;
	ledgerPath: string;
}

export interface NotionBlockTools {
	/** Lists a block's children (`block_id`, `page_size`, `start_cursor`). */
	list: string;
	/** Appends children (`block_id`, `children`). */
	append: string;
	/** Deletes (archives) a block (`block_id`). */
	remove: string;
}

export interface SyncDeps {
	/** Graph the PRDs belong to; scopes the ledger and the local PRD copies. */
	graphId: string;
	/** Existing tracker rows (CoT made them). Sub Issues are never created here. */
	refs?: {
		linear: { steps: Record<string, IssueRef> };
		notion: { steps: Record<string, string> };
	};
	/** Linear caller; unset = Linear not configured (skipped). */
	linear?: ToolCaller;
	/** Notion caller; unset = Notion not configured (skipped). */
	notion?: ToolCaller;
	/** State dir holding the ledger and PRD copies; default `resolveStateDir()`. */
	stateDir?: string;
	/** A PRD longer than this many characters goes to a linked Linear document (default 50_000, UNVERIFIED). */
	linearInlineLimit?: number;
	/** Bounded concurrency per tracker (default linear 4, notion 3). */
	concurrency?: { linear?: number; notion?: number };
	/** Retry only trackers whose ledger status is pending or failed; a synced one is left alone whatever its hash. */
	resume?: boolean;
	retryPolicy?: RetryPolicy;
	/** Notion tool names; defaults follow the official Notion REST block-children API (UNVERIFIED for the hosted MCP). */
	notionTools?: Partial<NotionBlockTools>;
	signal?: AbortSignal;
	sleep?: typeof abortableSleep;
	random?: () => number;
	now?: () => number;
	log?: (message: string) => void;
}
