// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Local ledger of every real Decisions network attempt: the owner compares it with the OpenRouter dashboard's
 * per-model breakdown. Counts, timings and cost only; bodies, prompts and keys never reach the file. Writing and
 * reading never throw: a ledger problem must not change a decision or break the CLI.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
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

/** Never throws (read-only directory, full disk, bad state dir: the record is simply dropped). */
export function appendUsage(stateDir: string, record: UsageRecord): void {
	try {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		const path = join(stateDir, USAGE_FILE);
		if (existsSync(path) && statSync(path).size >= USAGE_MAX_BYTES) renameSync(path, `${path}.1`);
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
