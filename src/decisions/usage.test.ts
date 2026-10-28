// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendUsage,
	summarizeUsage,
	USAGE_FILE,
	USAGE_MAX_BYTES,
	type UsageRecord,
} from "./usage.ts";

const SENTINEL_KEY = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const SENTINEL_PROMPT = "UT-SENTINEL-PROMPT: refactor the billing module";
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 86_400_000;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-usage-"));
	dirs.push(dir);
	return dir;
}

function record(over: Partial<UsageRecord> = {}): UsageRecord {
	return {
		ts: NOW,
		point: "plan",
		rail: "openrouter",
		requestedModel: "~typesafe/jev-latest",
		ok: true,
		ms: 10,
		...over,
	};
}

describe("appendUsage", () => {
	test("appends one JSON line per record to a 0600 file", () => {
		const dir = tempDir();
		appendUsage(dir, record({ costUsd: 0.1 }));
		appendUsage(dir, record({ ok: false, kind: "credits", status: 402 }));
		const path = join(dir, USAGE_FILE);
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string)).toMatchObject({ point: "plan", costUsd: 0.1 });
		expect(JSON.parse(lines[1] as string)).toMatchObject({ kind: "credits", status: 402 });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("creates a missing state directory", () => {
		const dir = join(tempDir(), "nested", "state");
		appendUsage(dir, record());
		expect(existsSync(join(dir, USAGE_FILE))).toBe(true);
	});

	test("persists only the declared fields: a planted key, prompt and body never reach the file", () => {
		const dir = tempDir();
		const polluted = {
			...record({ requestId: "gen-abc" }),
			apiKey: SENTINEL_KEY,
			prompt: SENTINEL_PROMPT,
			body: { state: { message: SENTINEL_PROMPT } },
			authorization: `Bearer ${SENTINEL_KEY}`,
		} as UsageRecord;
		appendUsage(dir, polluted);
		const text = readFileSync(join(dir, USAGE_FILE), "utf8");
		expect(text).not.toContain(SENTINEL_KEY);
		expect(text).not.toContain(SENTINEL_PROMPT);
		expect(text).not.toContain("Bearer");
		expect(JSON.parse(text)).toEqual(record({ requestId: "gen-abc" }));
	});

	test("rolls to .1 past 1 MiB, keeping a single older generation", () => {
		const dir = tempDir();
		const path = join(dir, USAGE_FILE);
		writeFileSync(path, `${"x".repeat(USAGE_MAX_BYTES)}\n`);
		appendUsage(dir, record({ point: "ship" }));
		expect(readFileSync(`${path}.1`, "utf8")).toStartWith("xxxx");
		const fresh = readFileSync(path, "utf8");
		expect(fresh.trimEnd().split("\n")).toHaveLength(1);
		expect(JSON.parse(fresh)).toMatchObject({ point: "ship" });
		// A second roll replaces .1 rather than adding a generation.
		writeFileSync(path, `${"y".repeat(USAGE_MAX_BYTES)}\n`);
		appendUsage(dir, record());
		expect(readFileSync(`${path}.1`, "utf8")).toStartWith("yyyy");
		expect(existsSync(`${path}.2`)).toBe(false);
	});

	test("never throws when the path cannot be written", () => {
		const dir = tempDir();
		// A regular file where the state directory should be: mkdir and open both fail.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		expect(() => appendUsage(join(blocker, "state"), record())).not.toThrow();
		const readOnly = join(dir, "ro");
		appendUsage(readOnly, record());
		chmodSync(readOnly, 0o500);
		expect(() => appendUsage(readOnly, record())).not.toThrow();
	});
});

describe("summarizeUsage", () => {
	test("buckets by UTC day and by served model (requested when unserved), counts failures by kind and sums cost", () => {
		const dir = tempDir();
		const served = "typesafe/jev-1.13-20260917";
		appendUsage(dir, record({ ts: NOW - 1000, servedModel: served, costUsd: 0.25 }));
		appendUsage(dir, record({ ts: NOW - 2000, servedModel: served, costUsd: 0.5 }));
		appendUsage(dir, record({ ts: NOW - DAY, ok: false, kind: "credits", status: 402 }));
		appendUsage(dir, record({ ts: NOW - DAY - 5, ok: false, kind: "credits" }));
		appendUsage(dir, record({ ts: NOW - 3 * DAY, ok: false }));
		const summary = summarizeUsage(dir, { days: 7, now: NOW });
		expect(summary.days).toBe(7);
		expect(summary.since).toBe(NOW - 7 * DAY);
		expect(summary.total).toEqual({ calls: 5, failures: 3, costUsd: 0.75 });
		expect(summary.byDay).toEqual({
			"2026-10-28": { calls: 2, failures: 0, costUsd: 0.75 },
			"2026-10-27": { calls: 2, failures: 2, costUsd: 0 },
			"2026-10-25": { calls: 1, failures: 1, costUsd: 0 },
		});
		expect(summary.byModel).toEqual({
			[served]: { calls: 2, failures: 0, costUsd: 0.75 },
			"~typesafe/jev-latest": { calls: 3, failures: 3, costUsd: 0 },
		});
		expect(summary.failuresByKind).toEqual({ credits: 2, unknown: 1 });
	});

	test("the window excludes older records and reads the rolled .1 generation too", () => {
		const dir = tempDir();
		const path = join(dir, USAGE_FILE);
		writeFileSync(`${path}.1`, `${JSON.stringify(record({ ts: NOW - 2 * DAY }))}\n`);
		appendUsage(dir, record({ ts: NOW - 40 * DAY }));
		appendUsage(dir, record({ ts: NOW - 1000 }));
		expect(summarizeUsage(dir, { days: 7, now: NOW }).total.calls).toBe(2);
		expect(summarizeUsage(dir, { days: 1, now: NOW }).total.calls).toBe(1);
		expect(summarizeUsage(dir, { days: 90, now: NOW }).total.calls).toBe(3);
	});

	test("skips corrupt and malformed lines and keeps the good ones", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, USAGE_FILE),
			[
				"{not json",
				"",
				"null",
				'"a string"',
				JSON.stringify({ ts: "yesterday", point: "plan" }),
				JSON.stringify({ ...record(), rail: "other" }),
				JSON.stringify(record({ costUsd: 0.5 })),
				'{"ts":1',
			].join("\n"),
		);
		const summary = summarizeUsage(dir, { days: 7, now: NOW });
		expect(summary.total).toEqual({ calls: 1, failures: 0, costUsd: 0.5 });
	});

	test("a missing ledger or an unreadable directory summarizes to zero without throwing", () => {
		const dir = tempDir();
		const empty = { days: 7, now: NOW };
		for (const target of [dir, join(dir, "missing"), join(dir, USAGE_FILE, "deeper")]) {
			expect(summarizeUsage(target, empty)).toEqual({
				days: 7,
				since: NOW - 7 * DAY,
				total: { calls: 0, failures: 0, costUsd: 0 },
				byDay: {},
				byModel: {},
				failuresByKind: {},
			});
		}
	});
});
