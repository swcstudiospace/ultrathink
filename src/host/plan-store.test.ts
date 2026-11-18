// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPlan, loadPlan, planKey, savePlan, type StoredPlan } from "./plan-store.ts";

const input = {
	sessionId: "session-1",
	submission: "submission-1",
	prompt: "write the plan",
	cwd: "/work/repo",
};
// Taken at load so savePlan's 24-hour prune never ages out a record this run saved; a fixed date does, at midnight UTC.
const CREATED_AT = new Date().toISOString();
const HOUR_MS = 60 * 60 * 1000;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-plan-store-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function samplePlan(overrides: Partial<StoredPlan> = {}): StoredPlan {
	return {
		key: planKey(input),
		text: "# Plan\n- step one",
		view: { title: "Plan", items: [1, "two"] },
		createdAt: CREATED_AT,
		...overrides,
	};
}

function recordFile(key: string): string {
	return join(dir, "plans", `${key}.json`);
}

// Writes `<key>.json`, the only name loadPlan reads.
function writeRaw(key: string, content: string): void {
	writeNamed(`${key}.json`, content);
}

// Writes an arbitrary file name inside the plans directory, for leftovers that must not be read as records.
function writeNamed(fileName: string, content: string): void {
	mkdirSync(join(dir, "plans"), { recursive: true });
	writeFileSync(join(dir, "plans", fileName), content);
}

describe("planKey", () => {
	test("is a stable sha256 hex digest", () => {
		const key = planKey(input);
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(planKey({ ...input })).toBe(key);
	});

	test("changes when any input field changes", () => {
		const key = planKey(input);
		expect(planKey({ ...input, sessionId: "session-2" })).not.toBe(key);
		expect(planKey({ ...input, submission: "submission-2" })).not.toBe(key);
		expect(planKey({ ...input, prompt: "write another plan" })).not.toBe(key);
		expect(planKey({ ...input, cwd: "/work/other" })).not.toBe(key);
	});
});

describe("savePlan and loadPlan", () => {
	test("round trips a plan", () => {
		const plan = samplePlan();
		savePlan(dir, plan);
		expect(loadPlan(dir, plan.key)).toEqual(plan);
	});

	test("returns 'absent' for a missing key", () => {
		expect(loadPlan(dir, planKey(input))).toBe("absent");
	});

	test("savePlan throws when the state directory cannot hold the plans directory", () => {
		const blocker = join(dir, "not-a-directory");
		writeFileSync(blocker, "file");
		expect(() => savePlan(blocker, samplePlan())).toThrow();
	});

	test("does not shadow the real record with a leftover temp file", () => {
		const plan = samplePlan();
		writeRaw(plan.key, "");
		writeNamed(`${plan.key}.json.tmp-1-deadbeef`, "{garbage");
		savePlan(dir, plan);
		expect(loadPlan(dir, plan.key)).toEqual(plan);
		expect(readdirSync(join(dir, "plans")).filter((name) => name.includes(".tmp-"))).toEqual([
			`${plan.key}.json.tmp-1-deadbeef`,
		]);
	});

	test("leftover temp file alone is not a record", () => {
		const key = planKey(input);
		writeNamed(`${key}.json.tmp-1-deadbeef`, JSON.stringify(samplePlan()));
		expect(loadPlan(dir, key)).toBe("absent");
	});

	test("rejects keys that could escape the plans directory", () => {
		expect(loadPlan(dir, "../escape")).toBe("absent");
		expect(loadPlan(dir, "")).toBe("absent");
		expect(() => savePlan(dir, samplePlan({ key: "../escape" }))).toThrow();
	});

	test("returns 'unreadable' for corrupt JSON without throwing", () => {
		const key = planKey(input);
		writeRaw(key, "{not json");
		expect(() => loadPlan(dir, key)).not.toThrow();
		expect(loadPlan(dir, key)).toBe("unreadable");
	});

	test("returns 'unreadable' for shape-invalid JSON", () => {
		const key = planKey(input);
		const invalid = [
			"null",
			"[]",
			"42",
			JSON.stringify({ key, text: 3, view: null, createdAt: CREATED_AT }),
			JSON.stringify({ key, text: "t", view: null, createdAt: 7 }),
			JSON.stringify({ key, text: "t", createdAt: CREATED_AT }),
			JSON.stringify({ key: "other-key", text: "t", view: null, createdAt: CREATED_AT }),
		];
		for (const content of invalid) {
			writeRaw(key, content);
			expect(loadPlan(dir, key)).toBe("unreadable");
		}
	});

	test("savePlan removes a record older than 24 hours and keeps a fresh one", () => {
		const staleKey = planKey(input);
		const freshKey = planKey({ ...input, prompt: "fresh prompt" });
		savePlan(dir, samplePlan({ createdAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() }));
		const fresh = samplePlan({ key: freshKey, createdAt: new Date().toISOString() });
		savePlan(dir, fresh);
		expect(loadPlan(dir, staleKey)).toBe("absent");
		expect(loadPlan(dir, freshKey)).toEqual(fresh);
	});

	test("savePlan writes the new record and does not throw when a stale record cannot be removed", () => {
		// A directory at a record path is never parsed as a record, so prune skips it and the removal cannot fail
		// through this path. The point is that the save proceeds and does not throw.
		const blockedKey = planKey({ ...input, prompt: "blocked prompt" });
		mkdirSync(recordFile(blockedKey), { recursive: true });
		const plan = samplePlan();
		expect(() => savePlan(dir, plan)).not.toThrow();
		expect(loadPlan(dir, plan.key)).toEqual(plan);
		expect(statSync(recordFile(blockedKey)).isDirectory()).toBe(true);
	});

	test("savePlan leaves unparseable records and non-record files alone", () => {
		writeNamed("corrupt.json", "{not json");
		writeNamed("notes.txt", "keep");
		const plan = samplePlan();
		savePlan(dir, plan);
		expect(readdirSync(join(dir, "plans")).sort()).toEqual(
			["corrupt.json", "notes.txt", `${plan.key}.json`].sort(),
		);
	});
});

describe("claimPlan", () => {
	test("returns 'claimed' once, then 'lost', and the record is gone", () => {
		const plan = samplePlan();
		savePlan(dir, plan);
		expect(claimPlan(dir, plan.key)).toBe("claimed");
		expect(claimPlan(dir, plan.key)).toBe("lost");
		expect(loadPlan(dir, plan.key)).toBe("absent");
	});

	test("returns 'lost' for an absent key", () => {
		expect(claimPlan(dir, planKey(input))).toBe("lost");
	});

	test("claiming one key leaves another key's record untouched", () => {
		const claimed = samplePlan();
		const other = samplePlan({ key: planKey({ ...input, prompt: "other prompt" }) });
		savePlan(dir, claimed);
		savePlan(dir, other);
		expect(claimPlan(dir, claimed.key)).toBe("claimed");
		expect(loadPlan(dir, other.key)).toEqual(other);
	});

	test("returns 'unwritable' when the record cannot be removed", () => {
		// A directory at the record path cannot be unlinked: EISDIR on Linux, EPERM on macOS. Neither is ENOENT.
		const key = planKey(input);
		mkdirSync(recordFile(key), { recursive: true });
		expect(claimPlan(dir, key)).toBe("unwritable");
		expect(statSync(recordFile(key)).isDirectory()).toBe(true);
	});
});

describe.skipIf(process.platform === "win32")("file modes", () => {
	test("plans directory is 0o700 and record is 0o600", () => {
		const plan = samplePlan();
		savePlan(dir, plan);
		expect(statSync(join(dir, "plans")).mode & 0o777).toBe(0o700);
		expect(statSync(recordFile(plan.key)).mode & 0o777).toBe(0o600);
	});
});
