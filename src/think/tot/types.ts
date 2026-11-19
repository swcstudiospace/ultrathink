// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/** One PRD to write: one CoT Sub Issue (a numbered rationale step of one node). */
export interface PrdRequest {
	readonly key: string /* stepKey nodeId.step */;
	readonly graphId: string;
	readonly nodeId: string;
	readonly step: number;
	readonly title: string;
	readonly thought: string;
}

type PrdStatus = "generated" | "failed" | "skipped";

export interface PrdRecord {
	readonly key: string;
	readonly hash: string /* sha256 hex of markdown */;
	readonly markdown: string;
	readonly status: PrdStatus;
	readonly model: string;
	readonly fallback: boolean;
	readonly attempts: number;
	readonly error?: string;
}

export interface TotManifest {
	readonly total: number;
	readonly generated: number;
	readonly failed: number;
	readonly fallbacks: number;
	readonly records: readonly PrdRecord[];
}

export interface ModelChoice {
	readonly modelId: string;
	readonly provider: string;
	readonly source: "override" | "host-list" | "mapping" | "selected";
	readonly reason: string;
}

export type CompleteFn = (input: {
	readonly system: string;
	readonly user: string;
	readonly modelId: string;
	readonly signal?: AbortSignal;
}) => Promise<string>;

// ---- Internal types of the ToT stage -------------------------------------------------------------------------------

export interface PrdLimits {
	readonly maxLines: number;
	readonly maxChars: number;
}

/** One file the PRD names for the Sub Issue. The repository is not inspected, so this is a proposal. */
export interface PrdFileRef {
	readonly path: string;
	readonly note?: string;
}

/** One code block of the PRD. Code is always illustrative: nothing checks it against the repository. */
export interface PrdCodeBlock {
	readonly language: string;
	readonly code: string;
}

/** The typed content of one PRD; `renderPrd` is the only way it becomes markdown. */
export interface PrdDocument {
	readonly objective: string;
	readonly acceptanceCriteria: readonly string[];
	readonly affectedFiles: readonly PrdFileRef[];
	readonly interfaces: readonly string[];
	readonly implementation: readonly PrdCodeBlock[];
	readonly testSkeleton: PrdCodeBlock;
	readonly assumptions: readonly string[];
}

/** A PRD as a generator hands it over (before the runner decides its status). */
export interface GeneratedPrd {
	readonly markdown: string;
	readonly model: string;
	readonly fallback: boolean;
	/** Model calls spent on this PRD. */
	readonly attempts: number;
	/** Why the fallback was used. */
	readonly error?: string;
}

/** Builds the PRD when the model cannot: returns markdown that passes `validatePrd`. */
export type PrdFallbackFn = (request: PrdRequest, reason: string) => string | Promise<string>;

export type TotProgressKind = "resumed" | "started" | "retry" | "generated" | "failed" | "skipped";

export interface TotProgress {
	readonly kind: TotProgressKind;
	readonly key: string;
	/** Items settled so far (resumed, generated, failed and skipped). */
	readonly done: number;
	readonly total: number;
	readonly attempt?: number;
	readonly error?: string;
}
