// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Local ledger of every real Decisions network attempt: the owner compares it with the OpenRouter dashboard's
 * per-model breakdown. Counts, timings and cost only; bodies, prompts and keys never reach the file. Writing and
 * reading never throw: a ledger problem must not change a decision or break the CLI.
 */
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface UsageRecord {
	ts: number;
	point: string;
	rail: "openrouter" | "vercel";
	requestedModel: string;
	servedModel?: string;
	ok: boolean;
	kind?: string;
	status?: number;
	ms: number;
	promptTokens?: number;
	completionTokens?: number;
	costUsd?: number;
	requestId?: string;
}

export interface UsageTotals {
	calls: number;
	failures: number;
	costUsd: number;
}

export interface UsageSummary {
	days: number;
	since: number;
	total: UsageTotals;
	byDay: Record<string, UsageTotals>;
	byModel: Record<string, UsageTotals>;
	failuresByKind: Record<string, number>;
}

export const USAGE_FILE = "decisions-usage.jsonl";
/** One generation of history: the file rolls to `.1` past this size. */
export const USAGE_MAX_BYTES = 1_048_576;
const DAY_MS = 86_400_000;
/** A rotation takes milliseconds; a lock older than this belongs to a crashed process. */
export const LOCK_STALE_MS = 5000;

/** Copies only the declared fields so an over-full caller object cannot leak a body, prompt or key into the file. */
function sanitize(record: UsageRecord): UsageRecord {
	const out: UsageRecord = {
		ts: record.ts,
		point: record.point,
		rail: record.rail,
		requestedModel: record.requestedModel,
		ok: record.ok,
		ms: record.ms,
	};
	if (record.servedModel !== undefined) out.servedModel = record.servedModel;
	if (record.kind !== undefined) out.kind = record.kind;
	if (record.status !== undefined) out.status = record.status;
	if (record.promptTokens !== undefined) out.promptTokens = record.promptTokens;
	if (record.completionTokens !== undefined) out.completionTokens = record.completionTokens;
	if (record.costUsd !== undefined) out.costUsd = record.costUsd;
	if (record.requestId !== undefined) out.requestId = record.requestId;
	return out;
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Takes the rotation lock, replacing one older than LOCK_STALE_MS (a crashed holder must not wedge rotation). */
function takeLock(lockPath: string): number | undefined {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return undefined;
				unlinkSync(lockPath);
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * Roll a full file to `.1`, serialised across hook processes. Without the lock two writers that both saw a full file
 * would rename twice, the second moving the fresh file over `.1` and destroying the retained history. A process that
 * loses the lock does nothing: its append still lands (a single short O_APPEND write is atomic) and the holder rotates.
 * The size is re-checked under the lock so a rotation another process just finished is not repeated.
 */
function rotateIfFull(path: string): void {
	if (fileSize(path) < USAGE_MAX_BYTES) return;
	const lockPath = `${path.slice(0, -".jsonl".length)}.lock`;
	const fd = takeLock(lockPath);
	if (fd === undefined) return;
	try {
		if (fileSize(path) >= USAGE_MAX_BYTES) renameSync(path, `${path}.1`);
	} catch {
		// reason: a failed rename leaves the full file in place; the row is still appended to it
	} finally {
		closeSync(fd);
		try {
			unlinkSync(lockPath);
		} catch {
			// reason: a vanished lock needs no cleanup
		}
	}
}

/** Never throws (read-only directory, full disk, bad state dir: the record is simply dropped). */
export function appendUsage(stateDir: string, record: UsageRecord): void {
	try {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const path = join(stateDir, USAGE_FILE);
		rotateIfFull(path);
		appendFileSync(path, `${JSON.stringify(sanitize(record))}\n`, { mode: 0o600 });
	} catch {
		// reason: the ledger is best effort; it must never affect the decision that produced the record
	}
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalNumber(value: unknown): number | undefined {
	return isFiniteNumber(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function parseLine(line: string): UsageRecord | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (
		!isFiniteNumber(r.ts) ||
		typeof r.point !== "string" ||
		(r.rail !== "openrouter" && r.rail !== "vercel") ||
		typeof r.requestedModel !== "string" ||
		typeof r.ok !== "boolean" ||
		!isFiniteNumber(r.ms)
	) {
		return undefined;
	}
	return sanitize({
		ts: r.ts,
		point: r.point,
		rail: r.rail,
		requestedModel: r.requestedModel,
		servedModel: optionalString(r.servedModel),
		ok: r.ok,
		kind: optionalString(r.kind),
		status: optionalNumber(r.status),
		ms: r.ms,
		promptTokens: optionalNumber(r.promptTokens),
		completionTokens: optionalNumber(r.completionTokens),
		costUsd: optionalNumber(r.costUsd),
		requestId: optionalString(r.requestId),
	});
}

function readRecords(path: string): UsageRecord[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: UsageRecord[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const record = parseLine(line);
		if (record) out.push(record);
	}
	return out;
}

function bump(map: Record<string, UsageTotals>, key: string, record: UsageRecord): void {
	const entry = (map[key] ??= { calls: 0, failures: 0, costUsd: 0 });
	entry.calls++;
	if (!record.ok) entry.failures++;
	entry.costUsd += record.costUsd ?? 0;
}

/** Records from the last `days` days (UTC day buckets, `YYYY-MM-DD`; models keyed by served id, else requested). Never throws. */
export function summarizeUsage(
	stateDir: string,
	opts: { days: number; now: number },
): UsageSummary {
	const since = opts.now - opts.days * DAY_MS;
	const summary: UsageSummary = {
		days: opts.days,
		since,
		total: { calls: 0, failures: 0, costUsd: 0 },
		byDay: {},
		byModel: {},
		failuresByKind: {},
	};
	const path = join(stateDir, USAGE_FILE);
	for (const record of [...readRecords(`${path}.1`), ...readRecords(path)]) {
		if (record.ts < since || record.ts > opts.now) continue;
		summary.total.calls++;
		if (!record.ok) {
			summary.total.failures++;
			const kind = record.kind ?? "unknown";
			summary.failuresByKind[kind] = (summary.failuresByKind[kind] ?? 0) + 1;
		}
		summary.total.costUsd += record.costUsd ?? 0;
		bump(summary.byDay, new Date(record.ts).toISOString().slice(0, 10), record);
		bump(summary.byModel, record.servedModel ?? record.requestedModel, record);
	}
	return summary;
}
