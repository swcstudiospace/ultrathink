// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileStore, type PhaseLoopRecord } from "./phase-loop-store.ts";

const STATE: PhaseLoopRecord = {
	runtimeId: "claude",
	phaseOrder: ["Discuss", "Plan", "Execute"],
	executeStarts: 1,
	shipStarts: 0,
	operatorConfirmations: 0,
};

/** Returns values[index]; throws when it is missing, so an indexed read stays a string. */
function nth(values: readonly string[], index: number): string {
	const value = values[index];
	if (value === undefined) throw new Error(`no value at index ${index}`);
	return value;
}

describe("file phase loop store", () => {
	let root: string;
	let stateDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "phase-loop-store-"));
		stateDir = join(root, "state");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function recordFiles(): string[] {
		return readdirSync(stateDir).filter((name) => name.endsWith(".json"));
	}

	test("round trip returns the saved record", () => {
		fileStore(stateDir).save("claude", STATE);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record: STATE });
	});

	test("a record with a checkpoint round trips", () => {
		const record: PhaseLoopRecord = {
			...STATE,
			checkpoint: { reason: "kill", at: "2026-11-17T10:00:00.000Z" },
		};
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("a second save replaces the first and leaves no temp file behind", () => {
		const store = fileStore(stateDir);
		store.save("claude", STATE);
		store.save("claude", { ...STATE, executeStarts: 2 });
		const outcome = store.load("claude");
		expect(outcome.status === "found" && outcome.record.executeStarts).toBe(2);
		expect(readdirSync(stateDir)).toHaveLength(1);
	});

	test("a missing record is absent, including before the directory exists", () => {
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "absent" });
		fileStore(stateDir).save("claude", STATE);
		expect(fileStore(stateDir).load("other")).toEqual({ status: "absent" });
	});

	test("a corrupt record is quarantined: renamed aside, bytes kept, and the block is sticky", () => {
		const store = fileStore(stateDir);
		store.save("claude", STATE);
		const record = nth(recordFiles(), 0);
		writeFileSync(join(stateDir, record), "{not json");
		const outcome = store.load("claude");
		expect(outcome.status).toBe("quarantined");
		if (outcome.status !== "quarantined") throw new Error("expected a quarantined record");
		expect(readFileSync(outcome.quarantinedAs, "utf8")).toBe("{not json");
		expect(basename(outcome.quarantinedAs).startsWith(`${record}.corrupt-`)).toBe(true);
		expect(recordFiles()).toEqual([]);
		expect(store.load("claude")).toEqual({
			status: "quarantined",
			quarantinedAs: outcome.quarantinedAs,
		});
		expect(fileStore(stateDir).load("other")).toEqual({ status: "absent" });
	});

	test("a valid record written over a quarantined one is found, and the copy stays", () => {
		const store = fileStore(stateDir);
		store.save("claude", STATE);
		writeFileSync(join(stateDir, nth(recordFiles(), 0)), "{not json");
		const outcome = store.load("claude");
		if (outcome.status !== "quarantined") throw new Error("expected a quarantined record");
		store.save("claude", STATE);
		expect(store.load("claude")).toEqual({ status: "found", record: STATE });
		expect(readFileSync(outcome.quarantinedAs, "utf8")).toBe("{not json");
	});

	test("two quarantines of the same record keep both copies", () => {
		const store = fileStore(stateDir);
		const quarantined: string[] = [];
		for (let i = 0; i < 2; i++) {
			store.save("claude", STATE);
			writeFileSync(join(stateDir, nth(recordFiles(), 0)), `{not json ${i}`);
			const outcome = store.load("claude");
			if (outcome.status !== "quarantined") throw new Error("expected a quarantined record");
			quarantined.push(outcome.quarantinedAs);
		}
		const [first, second] = [nth(quarantined, 0), nth(quarantined, 1)];
		expect(first).not.toBe(second);
		expect(readFileSync(first, "utf8")).toBe("{not json 0");
		expect(readFileSync(second, "utf8")).toBe("{not json 1");
	});

	test("valid JSON of the wrong shape is quarantined, including a malformed checkpoint", () => {
		const store = fileStore(stateDir);
		const wrongShapes = [
			JSON.stringify({ runtimeId: "claude" }),
			JSON.stringify({ ...STATE, checkpoint: { reason: "sleep", at: "x" } }),
		];
		for (const bytes of wrongShapes) {
			store.save("claude", STATE);
			writeFileSync(join(stateDir, nth(recordFiles(), 0)), bytes);
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("a temp file left by a crash does not replace the record", () => {
		fileStore(stateDir).save("claude", STATE);
		const record = nth(recordFiles(), 0);
		writeFileSync(
			join(stateDir, `${record}.4242.deadbeef.tmp`),
			JSON.stringify({ ...STATE, executeStarts: 9 }),
		);
		writeFileSync(join(stateDir, `${record}.4243.partial.tmp`), '{"runtimeId":"clau');
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record: STATE });
	});

	test("the directory is created 0o700 and the record is written 0o600", () => {
		fileStore(stateDir).save("claude", STATE);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(stateDir, nth(recordFiles(), 0))).mode & 0o777).toBe(0o600);
	});

	test("save throws when the directory cannot be written", () => {
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "a file, not a directory");
		expect(() => fileStore(join(blocker, "state")).save("claude", STATE)).toThrow();
	});

	test("load throws on an I/O failure other than a missing file", () => {
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "a file, not a directory");
		expect(() => fileStore(join(blocker, "state")).load("claude")).toThrow();
	});
});
