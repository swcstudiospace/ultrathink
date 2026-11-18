// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The append-only audit log of the generated-skill store: one JSON object per line in `audit.ndjson` at the store root.
 * A record names one decision (create, update, reject, disable or delete) with the skill's identity and provenance. It
 * never holds skill text: each line is built from the named fields below, so no other property reaches the file.
 *
 * Appends run under the file lock and are synchronous, because the lock is released as soon as its callback returns.
 * A failed append is returned as an outcome, never thrown, so the caller decides what a missing record means.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../claude/atomic.ts";

const AUDIT_FILE = "audit.ndjson";

type AuditAction = "create" | "update" | "reject" | "disable" | "delete";
export type QualificationBy = "user-confirmed" | "recurrence" | "resolved-root-cause";
export type MatchBy = "signature-hash" | "task-scope" | "similarity";

/** One audited decision. Only `ts`, `action` and `name` are always present; the rest apply to some actions. */
export interface AuditRecord {
	/** ISO 8601 UTC. */
	ts: string;
	action: AuditAction;
	name: string;
	version?: number;
	content_hash?: string;
	source_ids?: string[];
	qualification_by?: QualificationBy;
	match_by?: MatchBy;
	/** Why a candidate was refused. A kind and field name, never the text that failed. */
	reject_kind?: string;
	reject_field?: string;
}

/** The result of one append: recorded, or the short reason it was not. Never skill text. */
export type AuditOutcome = { ok: true } | { ok: false; detail: string };

/** Appends one record to the store's audit log. Never throws: a failure comes back as `{ ok: false, detail }`. */
export function appendAudit(storeDir: string, record: AuditRecord): AuditOutcome {
	try {
		const line = `${JSON.stringify(auditLineOf(record))}\n`;
		mkdirSync(storeDir, { recursive: true, mode: 0o700 });
		const path = join(storeDir, AUDIT_FILE);
		withFileLock(path, () => appendFileSync(path, line, { encoding: "utf8", mode: 0o600 }));
		return { ok: true };
	} catch (error) {
		return { ok: false, detail: errorCodeOf(error) };
	}
}

/** Picks the audited fields by name. `undefined` fields are dropped by `JSON.stringify`. */
function auditLineOf(record: AuditRecord): AuditRecord {
	return {
		ts: record.ts,
		action: record.action,
		name: record.name,
		version: record.version,
		content_hash: record.content_hash,
		source_ids: record.source_ids === undefined ? undefined : [...record.source_ids],
		qualification_by: record.qualification_by,
		match_by: record.match_by,
		reject_kind: record.reject_kind,
		reject_field: record.reject_field,
	};
}

function errorCodeOf(error: unknown): string {
	if (error instanceof Error && "code" in error && typeof error.code === "string")
		return error.code;
	return "append_failed";
}
