// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Durable store for completed Omp plans, so a plan whose delivery was lost can be delivered again. One JSON record per
 * plan lives at `<stateDir>/plans/<key>.json`. A record is written atomically through a temp file and rename, deleted
 * when a delivery claims it, and pruned by savePlan once it is older than 24 hours. Plan text can carry user prompt
 * text, so nothing in this module logs record contents.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface StoredPlan {
	key: string;
	text: string;
	view: unknown;
	createdAt: string;
}

// Keys become file names, so only url-safe characters are accepted. planKey output always matches.
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;

export function planKey(input: {
	sessionId: string;
	submission: string;
	prompt: string;
	cwd: string;
}): string {
	const canonical = JSON.stringify({
		sessionId: input.sessionId,
		submission: input.submission,
		prompt: input.prompt,
		cwd: input.cwd,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

export function savePlan(stateDir: string, plan: StoredPlan): void {
	if (!KEY_PATTERN.test(plan.key)) throw new Error("plan key must be url-safe");
	const dir = join(stateDir, "plans");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	pruneExpired(stateDir, dir, Date.now());
	const finalPath = recordPath(stateDir, plan.key);
	// Temp names end in `.tmp-*`, so they never match a `<key>.json` record name.
	const tmpPath = join(
		dir,
		`${plan.key}.json.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
	const record = JSON.stringify({
		key: plan.key,
		text: plan.text,
		view: plan.view,
		createdAt: plan.createdAt,
	});
	try {
		writeFileSync(tmpPath, record, { mode: 0o600, flag: "wx" });
		renameSync(tmpPath, finalPath);
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
}

export function loadPlan(stateDir: string, key: string): StoredPlan | "absent" | "unreadable" {
	if (!KEY_PATTERN.test(key)) return "absent";
	let raw: string;
	try {
		raw = readFileSync(recordPath(stateDir, key), "utf8");
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "absent"
			: "unreadable";
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "unreadable";
	}
	return parseRecord(parsed, key) ?? "unreadable";
}

export function claimPlan(stateDir: string, key: string): "claimed" | "lost" | "unwritable" {
	if (!KEY_PATTERN.test(key)) return "lost";
	try {
		unlinkSync(recordPath(stateDir, key));
		return "claimed";
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT"
			? "lost"
			: "unwritable";
	}
}

// The record file name is the on-disk contract: `<stateDir>/plans/<key>.json`.
function recordPath(stateDir: string, key: string): string {
	return join(stateDir, "plans", `${key}.json`);
}

// Best-effort housekeeping: removes only files named `<key>.json` whose record parses and is older than the limit.
// Unparseable records stay. A failed listing or removal is skipped so it never blocks the save that calls this.
function pruneExpired(stateDir: string, dir: string, now: number): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// The directory cannot be listed, so nothing is pruned on this save.
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const key = name.slice(0, -".json".length);
		if (!KEY_PATTERN.test(key)) continue;
		const record = loadPlan(stateDir, key);
		if (typeof record === "string") continue;
		const createdMs = Date.parse(record.createdAt);
		if (Number.isNaN(createdMs) || now - createdMs <= MAX_RECORD_AGE_MS) continue;
		try {
			rmSync(join(dir, name), { force: true });
		} catch {
			// This stale record stays until a later save can remove it; the new record is still written.
			continue;
		}
	}
}

function parseRecord(value: unknown, expectedKey: string): StoredPlan | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const key = "key" in value ? value.key : undefined;
	const text = "text" in value ? value.text : undefined;
	const createdAt = "createdAt" in value ? value.createdAt : undefined;
	if (typeof key !== "string" || typeof text !== "string" || typeof createdAt !== "string")
		return undefined;
	if (key !== expectedKey || !("view" in value)) return undefined;
	return { key, text, view: value.view, createdAt };
}
