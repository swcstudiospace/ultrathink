// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPlan, loadPlan, planKey, savePlan, type StoredPlan } from "./plan-store.ts";
import { planGateHash } from "./completion-gate.ts";

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

function setMtime(fileName: string, ms: number): void {
	const time = new Date(ms);
	utimesSync(join(dir, "plans", fileName), time, time);
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

	test("round trips a gate-released plan with its validated identity", () => {
		const text = "# Plan\n- step one";
		const planHash = planGateHash(text);
		const plan = samplePlan({ text, planId: `plan-${planHash.slice(0, 12)}`, planHash });
		savePlan(dir, plan);
		// The identity rides alongside the text, which is never altered.
		expect(loadPlan(dir, plan.key)).toEqual(plan);
	});

	test("savePlan refuses a record with only one identity field", () => {
		const text = "# Plan\n- step one";
		const planHash = planGateHash(text);
		const plan = samplePlan({ text, planId: `plan-${planHash.slice(0, 12)}` });
		expect(() => savePlan(dir, plan)).toThrow("planId and planHash must be provided together");
		expect(loadPlan(dir, plan.key)).toBe("absent");
	});

	test("reads a record whose identity fields are not strings as unreadable", () => {
		const plan = samplePlan();
		writeRaw(
			plan.key,
			JSON.stringify({
				key: plan.key,
				text: plan.text,
				view: plan.view,
				createdAt: plan.createdAt,
				planId: 42,
			}),
		);
		expect(loadPlan(dir, plan.key)).toBe("unreadable");
	});
 
	test("reads a record whose planHash does not match the text as unreadable", () => {
		const plan = samplePlan();
		const planHash = planGateHash(plan.text);
		writeRaw(
			plan.key,
			JSON.stringify({
				key: plan.key,
				text: plan.text,
				view: plan.view,
				createdAt: plan.createdAt,
				planId: `plan-${planHash.slice(0, 12)}`,
				planHash: "0".repeat(64),
			}),
		);
		expect(loadPlan(dir, plan.key)).toBe("unreadable");
	});

	test("reads a record whose planId is not derived from the text hash as unreadable", () => {
		const plan = samplePlan();
		const planHash = planGateHash(plan.text);
		writeRaw(
			plan.key,
			JSON.stringify({
				key: plan.key,
				text: plan.text,
				view: plan.view,
				createdAt: plan.createdAt,
				planId: `plan-${"0".repeat(12)}`,
				planHash,
			}),
		);
		expect(loadPlan(dir, plan.key)).toBe("unreadable");
	});

	test("reads a record with only one identity field as unreadable", () => {
		const plan = samplePlan();
		const planHash = planGateHash(plan.text);
		for (const identity of [{ planId: `plan-${planHash.slice(0, 12)}` }, { planHash }]) {
			writeRaw(
				plan.key,
				JSON.stringify({
					key: plan.key,
					text: plan.text,
					view: plan.view,
					createdAt: plan.createdAt,
					...identity,
				}),
			);
			expect(loadPlan(dir, plan.key)).toBe("unreadable");
		}
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

	test("savePlan removes an orphaned temp file whose writer is dead and is at least a minute old", () => {
		// No process has this pid, so its writer is dead.
		const orphan = `${planKey(input)}.json.tmp-2000000000-0123456789abcdef`;
		writeNamed(orphan, "partial");
		setMtime(orphan, Date.now() - 2 * 60_000);
		const plan = samplePlan();
		savePlan(dir, plan);
		expect(readdirSync(join(dir, "plans"))).not.toContain(orphan);
		expect(loadPlan(dir, plan.key)).toEqual(plan);
	});

	test("savePlan keeps a temp file whose writer is still running, however old", () => {
		const live = `${planKey(input)}.json.tmp-${process.pid}-0123456789abcdef`;
		writeNamed(live, "partial");
		setMtime(live, Date.now() - 2 * 60_000);
		savePlan(dir, samplePlan());
		expect(readdirSync(join(dir, "plans"))).toContain(live);
	});

	test("savePlan keeps a temp file younger than a minute even when its writer is dead", () => {
		const fresh = `${planKey(input)}.json.tmp-2000000000-0123456789abcdef`;
		writeNamed(fresh, "partial");
		savePlan(dir, samplePlan());
		expect(readdirSync(join(dir, "plans"))).toContain(fresh);
	});

	test("savePlan scans at most 200 directory entries per save", () => {
		const stale = new Date(Date.now() - 25 * HOUR_MS).toISOString();
		for (let i = 0; i < 250; i++) {
			const key = planKey({ ...input, prompt: `stale ${i}` });
			writeRaw(key, JSON.stringify({ key, text: "t", view: null, createdAt: stale }));
		}
		savePlan(dir, samplePlan());
		const records = readdirSync(join(dir, "plans")).filter((name) => name.endsWith(".json"));
		// 250 stale records plus the new one. At most 200 entries are scanned, so at most 200 go.
		expect(records.length).toBeGreaterThanOrEqual(51);
		expect(records.length).toBeLessThan(251);
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
