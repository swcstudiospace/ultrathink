// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Record and reason types of one Greptile knowledge-base lookup. The reader writes them, the hook stores them on the
 * session record and the Knowledge surface reads them, so every non-used outcome carries a closed reason code and the
 * stage ladder says how far the lookup got.
 */

/** `used`: a digest was built; `none`: nothing matched or nothing to read; `off`: the gate or credential is absent; `error`: the lookup failed. */
export type KnowledgeOutcome = "used" | "none" | "off" | "error";

/** Why a lookup did not produce a digest. Closed: add a value here, never a free-form string. */
const KNOWLEDGE_REASONS = [
	"disabled",
	"no_credential",
	"needs_login",
	"tenant_required",
	"repo_unresolved",
	"namespace_not_found",
	"no_documents",
	"routing_table_missing",
	"no_route_match",
	"document_read_failed",
	"timeout",
	"transport_error",
	"shape_mismatch",
	"breaker_open",
	"aborted",
] as const;
export type KnowledgeReason = (typeof KNOWLEDGE_REASONS)[number];

/** The stage ladder, in the order a lookup runs them. A stage appears only when it ran. */
const KNOWLEDGE_STAGE_NAMES = [
	"gate",
	"credential",
	"repo",
	"namespace",
	"document_list",
	"index_read",
	"routing_entries_parsed",
	"lexical_match",
	"document_reads",
	"digest",
] as const;
export type KnowledgeStageName = (typeof KNOWLEDGE_STAGE_NAMES)[number];

/** One stage's counts. `errorClass` is the reason it failed, or null. `scores` is set on lexical_match only. */
export interface KnowledgeStage {
	name: KnowledgeStageName;
	inCount: number;
	outCount: number;
	durationMs: number;
	errorClass: KnowledgeReason | null;
	/** Top three positive entry scores, highest first (lexical_match only). Unbounded log-IDF overlap, not 0 to 1. */
	scores?: number[];
}

/** What one knowledge-base lookup did, for the session record, the summary, the activity card and the debug log. */
export interface KnowledgeLookup {
	outcome: KnowledgeOutcome;
	/** Set on every non-used outcome. */
	reasonCode?: KnowledgeReason;
	/** owner/repo looked up. */
	repo?: string;
	namespaceId?: string;
	/** sectionVersions.docs of the knowledge base read. */
	version?: string;
	/** Paths read, index.md first; [] unless outcome is "used". */
	docs: string[];
	/** Digest length. */
	chars: number;
	/** Elapsed from start() to read() resolving. */
	ms: number;
	/** One line (<= 200 chars), set unless outcome is "used". */
	reason?: string;
	/** Set by the planner: questions settled from the knowledge base. */
	settled?: number;
	/** Stage ladder of this lookup, in run order. */
	stages?: KnowledgeStage[];
}
