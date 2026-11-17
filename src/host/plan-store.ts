// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Durable store for completed Omp plans, so a plan whose delivery was lost can be delivered again. One JSON record per
 * plan lives at `<stateDir>/plans/<key>.json` and is written atomically through a temp file and rename. Plan text can
 * carry user prompt text, so nothing in this module logs record contents.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredPlan {
	key: string;
	text: string;
	view: unknown;
	createdAt: string;
	deliveredAt: string | undefined;
}

// Keys become file names, so only url-safe characters are accepted. planKey output always matches.
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

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
	writeRecord(stateDir, plan);
}

export function loadPlan(stateDir: string, key: string): StoredPlan | undefined {
	return readRecord(stateDir, key);
}

export function markDelivered(stateDir: string, key: string, at: string): boolean {
	const plan = readRecord(stateDir, key);
	if (plan === undefined || plan.deliveredAt !== undefined) return false;
	try {
		writeRecord(stateDir, { ...plan, deliveredAt: at });
		return true;
	} catch {
		// Write failed, so the plan stays undelivered and the caller can retry later.
		return false;
	}
}

// The record file name is the on-disk contract: `<stateDir>/plans/<key>.json`.
function recordPath(stateDir: string, key: string): string {
	return join(stateDir, "plans", `${key}.json`);
}

function writeRecord(stateDir: string, plan: StoredPlan): void {
	if (!KEY_PATTERN.test(plan.key)) throw new Error("plan key must be url-safe");
	const dir = join(stateDir, "plans");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const finalPath = recordPath(stateDir, plan.key);
	// Temp names end in `.tmp-*`, so they never match a `<key>.json` record name.
	const tmpPath = join(
		dir,
		`${plan.key}.json.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
	try {
		writeFileSync(tmpPath, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
		renameSync(tmpPath, finalPath);
	} catch (error) {
		rmSync(tmpPath, { force: true });
		throw error;
	}
}

function readRecord(stateDir: string, key: string): StoredPlan | undefined {
	if (!KEY_PATTERN.test(key)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(recordPath(stateDir, key), "utf8");
	} catch {
		// Missing or unreadable record: there is nothing to deliver.
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Corrupt record: treated as absent.
		return undefined;
	}
	return parseRecord(parsed, key);
}

function parseRecord(value: unknown, expectedKey: string): StoredPlan | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const key = "key" in value ? value.key : undefined;
	const text = "text" in value ? value.text : undefined;
	const createdAt = "createdAt" in value ? value.createdAt : undefined;
	const deliveredAt = "deliveredAt" in value ? value.deliveredAt : undefined;
	if (typeof key !== "string" || typeof text !== "string" || typeof createdAt !== "string")
		return undefined;
	if (key !== expectedKey) return undefined;
	if (deliveredAt !== undefined && typeof deliveredAt !== "string") return undefined;
	if (!("view" in value)) return undefined;
	return { key, text, view: value.view, createdAt, deliveredAt };
}
