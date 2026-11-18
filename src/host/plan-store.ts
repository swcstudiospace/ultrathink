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
	opendirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errorCode } from "../claude/atomic.ts";

export interface StoredPlan {
	key: string;
	text: string;
	view: unknown;
	createdAt: string;
}

// Keys become file names, so only url-safe characters are accepted. planKey output always matches.
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_RECORD_AGE_MS = 24 * 60 * 60 * 1000;
const PRUNE_SCAN_LIMIT = 200;
// A temp file savePlan writes before its rename: `<key>.json.tmp-<pid>-<16 hex>`.
const ORPHAN_TEMP = /^.+\.json\.tmp-(\d+)-[0-9a-f]{16}$/;
// A dead writer's temp file must also be this old (ms) before it goes, mirroring claude/atomic.ts.
const ORPHAN_MIN_AGE_MS = 60_000;

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
		return errorCode(error) === "ENOENT" ? "absent" : "unreadable";
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
		return errorCode(error) === "ENOENT" ? "lost" : "unwritable";
	}
}

// The record file name is the on-disk contract: `<stateDir>/plans/<key>.json`.
function recordPath(stateDir: string, key: string): string {
	return join(stateDir, "plans", `${key}.json`);
}

// Best-effort housekeeping: removes only files named `<key>.json` whose record parses and is older than the limit.
// Unparseable records stay. Crashed-write temp files go once their writer is dead and they are at least a minute old.
// At most PRUNE_SCAN_LIMIT entries are scanned per save. A failed listing or removal never blocks the save
// that calls this.
function pruneExpired(stateDir: string, dir: string, now: number): void {
	try {
		const handle = opendirSync(dir);
		try {
			for (let scanned = 0; scanned < PRUNE_SCAN_LIMIT; scanned++) {
				const entry = handle.readSync();
				if (!entry) break;
				pruneEntry(stateDir, dir, entry.name, now);
			}
		} finally {
			handle.closeSync();
		}
	} catch {
		// The directory cannot be listed, so nothing is pruned on this save.
	}
}

function pruneEntry(stateDir: string, dir: string, name: string, now: number): void {
	const orphan = ORPHAN_TEMP.exec(name);
	if (orphan) {
		pruneOrphanTemp(join(dir, name), Number(orphan[1]), now);
		return;
	}
	if (!name.endsWith(".json")) return;
	const key = name.slice(0, -".json".length);
	if (!KEY_PATTERN.test(key)) return;
	const record = loadPlan(stateDir, key);
	if (typeof record === "string") return;
	const createdMs = Date.parse(record.createdAt);
	if (Number.isNaN(createdMs) || now - createdMs <= MAX_RECORD_AGE_MS) return;
	try {
		rmSync(join(dir, name), { force: true });
	} catch {
		// This stale record stays until a later save can remove it; the new record is still written.
	}
}

function pruneOrphanTemp(path: string, pid: number, now: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pidAlive(pid)) return;
	try {
		if (now - statSync(path).mtimeMs >= ORPHAN_MIN_AGE_MS) unlinkSync(path);
	} catch {
		// reason: a sibling writer may have removed it first
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists under another user: alive.
		return errorCode(error) !== "ESRCH";
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
