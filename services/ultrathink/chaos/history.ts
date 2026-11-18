// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { HistoryRecord, RunResult } from "./run.ts";

export interface HistoryRead {
	records: HistoryRecord[];
	skipped: number;
}

// Appends one run as a JSON line with seq = highest valid seq + 1 (1 for a new file).
// Corrupt lines do not count toward seq. A file whose last line lacks a newline (a torn write)
// gets one before the new record, so the new record never merges into the torn line.
// The read, seq computation and append run under `<path>.lock`, so runs sharing one file never share a seq.
export function appendHistory(path: string, run: RunResult): HistoryRecord {
	mkdirSync(dirname(path), { recursive: true });
	return withLock(`${path}.lock`, () => {
		const text = readText(path) ?? "";
		const seq =
			parseHistory(text).records.reduce((max, record) => Math.max(max, record.seq), 0) + 1;
		const record: HistoryRecord = { ...run, seq };
		const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
		appendFileSync(path, `${separator}${JSON.stringify(record)}\n`);
		return record;
	});
}

const LOCK_ATTEMPTS = 400;
const LOCK_BACKOFF_MS = 5;
const backoffCell = new Int32Array(new SharedArrayBuffer(4));

// Holds `lockPath` (created O_EXCL) for the duration of `body`, retrying a bounded number of times while another run
// holds it, and removes it on release. Synchronous so the appender stays synchronous.
function withLock<T>(lockPath: string, body: () => T): T {
	for (let attempt = 1; !createLock(lockPath); attempt += 1) {
		if (attempt >= LOCK_ATTEMPTS)
			throw new Error(
				`history is locked by another run: ${lockPath}; remove it if no run is active`,
			);
		Atomics.wait(backoffCell, 0, 0, LOCK_BACKOFF_MS);
	}
	try {
		return body();
	} finally {
		rmSync(lockPath, { force: true });
	}
}

// True when this call created the lock file; false when another holder already has it.
function createLock(lockPath: string): boolean {
	try {
		closeSync(openSync(lockPath, "wx", 0o600));
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

// Reads the history. A missing file is empty. A line that is not JSON or fails the record
// checks is counted in `skipped`; it never throws.
export function readHistory(path: string): HistoryRead {
	return parseHistory(readText(path) ?? "");
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function parseHistory(text: string): HistoryRead {
	const records: HistoryRecord[] = [];
	let skipped = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		const record = parseLine(line);
		if (record) records.push(record);
		else skipped += 1;
	}
	return { records, skipped };
}

function parseLine(line: string): HistoryRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const fields: Record<string, unknown> = { ...value };
	if (typeof fields.templateId !== "string") return undefined;
	if (
		typeof fields.score !== "number" ||
		!Number.isFinite(fields.score) ||
		fields.score < 0 ||
		fields.score > 100
	)
		return undefined;
	if (typeof fields.seq !== "number" || !Number.isSafeInteger(fields.seq) || fields.seq < 1)
		return undefined;
	if (!Array.isArray(fields.hypotheses)) return undefined;
	// The four checks above are the whole contract for a history line; the rest is written by appendHistory.
	return value as HistoryRecord;
}
