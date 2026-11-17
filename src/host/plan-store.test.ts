// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, markDelivered, planKey, savePlan, type StoredPlan } from "./plan-store.ts";

const input = {
	sessionId: "session-1",
	submission: "submission-1",
	prompt: "write the plan",
	cwd: "/work/repo",
};
const CREATED_AT = "2026-11-17T00:00:00.000Z";

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
		deliveredAt: undefined,
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

	test("returns undefined for a missing key", () => {
		expect(loadPlan(dir, planKey(input))).toBeUndefined();
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
		expect(loadPlan(dir, key)).toBeUndefined();
	});

	test("rejects keys that could escape the plans directory", () => {
		expect(loadPlan(dir, "../escape")).toBeUndefined();
		expect(loadPlan(dir, "")).toBeUndefined();
		expect(() => savePlan(dir, samplePlan({ key: "../escape" }))).toThrow();
	});

	test("returns undefined for corrupt JSON without throwing", () => {
		const key = planKey(input);
		writeRaw(key, "{not json");
		expect(() => loadPlan(dir, key)).not.toThrow();
		expect(loadPlan(dir, key)).toBeUndefined();
	});

	test("returns undefined for shape-invalid JSON", () => {
		const key = planKey(input);
		const invalid = [
			"null",
			"[]",
			"42",
			JSON.stringify({ key, text: 3, view: null, createdAt: CREATED_AT }),
			JSON.stringify({ key, text: "t", view: null, createdAt: 7 }),
			JSON.stringify({ key, text: "t", createdAt: CREATED_AT }),
			JSON.stringify({ key, text: "t", view: null, createdAt: CREATED_AT, deliveredAt: 5 }),
			JSON.stringify({ key: "other-key", text: "t", view: null, createdAt: CREATED_AT }),
		];
		for (const content of invalid) {
			writeRaw(key, content);
			expect(loadPlan(dir, key)).toBeUndefined();
		}
	});
});

describe("markDelivered", () => {
	test("first call sets deliveredAt and returns true; second call returns false and keeps the first value", () => {
		const plan = samplePlan();
		savePlan(dir, plan);

		expect(markDelivered(dir, plan.key, "2026-11-17T01:00:00.000Z")).toBe(true);
		expect(markDelivered(dir, plan.key, "2026-11-17T02:00:00.000Z")).toBe(false);

		expect(loadPlan(dir, plan.key)).toEqual({ ...plan, deliveredAt: "2026-11-17T01:00:00.000Z" });
	});

	test("returns false for a missing key", () => {
		expect(markDelivered(dir, planKey(input), CREATED_AT)).toBe(false);
	});

	test("returns false for a corrupt record and leaves it untouched", () => {
		const key = planKey(input);
		writeRaw(key, "{not json");
		expect(markDelivered(dir, key, CREATED_AT)).toBe(false);
		expect(loadPlan(dir, key)).toBeUndefined();
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
