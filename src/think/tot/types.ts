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

/** Whether a reference was found in the repository (`verified`) or is a proposal the repository does not show (`assumption`). */
type RefTag = "verified" | "assumption";

/** What the project inspector learned. Names and paths only: file contents are never kept. */
export interface ProjectFacts {
	/** Absolute root the facts describe. */
	readonly root: string;
	/** Repository-relative POSIX paths of every inspected file. */
	readonly files: ReadonlySet<string>;
	/** Repository-relative POSIX paths of every directory that holds an inspected file ("" is the root and is not listed). */
	readonly dirs: ReadonlySet<string>;
	/** Declared symbol name -> files declaring it (at most `MAX_FILES_PER_SYMBOL`). */
	readonly symbols: ReadonlyMap<string, readonly string[]>;
	/** True when a depth, file-count or symbol-count limit cut the walk short. */
	readonly truncated: boolean;
	/** Entries skipped by the deny-list (never listed, never read). */
	readonly denied: number;
}

export interface InspectLimits {
	readonly maxDepth: number;
	readonly maxFiles: number;
	readonly maxFileBytes: number;
	readonly maxSymbols: number;
}

export interface PrdLimits {
	readonly maxLines: number;
	readonly maxChars: number;
}

export interface PrdFileRef {
	readonly path: string;
	readonly tag: RefTag;
	readonly note?: string;
}

export interface PrdInterfaceRef {
	readonly signature: string;
	readonly tag: RefTag;
}

export interface PrdCodeBlock {
	readonly language: string;
	readonly code: string;
	/** True only when every repository reference the block relies on was found in the project facts. */
	readonly verified: boolean;
}

/** The typed content of one PRD; `renderPrd` is the only way it becomes markdown. */
export interface PrdDocument {
	readonly objective: string;
	readonly acceptanceCriteria: readonly string[];
	readonly affectedFiles: readonly PrdFileRef[];
	readonly interfaces: readonly PrdInterfaceRef[];
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
