// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileStore, type PhaseLoopRecord } from "./phase-loop-store.ts";

const STATE: PhaseLoopRecord = {
	runtimeId: "claude",
	phaseOrder: ["Discuss", "Plan", "Execute"],
	executeStarts: 1,
	shipStarts: 0,
	operatorConfirmations: 0,
	humanItems: [],
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

	test("two concurrent quarantines of one corrupt record both report the copy that won the rename", () => {
		const store = fileStore(stateDir);
		store.save("claude", STATE);
		const corrupt = join(stateDir, nth(recordFiles(), 0));
		writeFileSync(corrupt, "{not json");
		const winner = `${corrupt}.corrupt-winner`;
		// The other load's rename wins: it moves the record aside, then this load's rename finds nothing at the path.
		const losing = fileStore(stateDir, {
			renameSync(from) {
				renameSync(from, winner);
				throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}'`), {
					code: "ENOENT",
				});
			},
		});
		expect(losing.load("claude")).toEqual({ status: "quarantined", quarantinedAs: winner });
		expect(store.load("claude")).toEqual({ status: "quarantined", quarantinedAs: winner });
		expect(readFileSync(winner, "utf8")).toBe("{not json");
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

	test("unsupported schema versions quarantine the record", () => {
		const store = fileStore(stateDir);
		for (const schemaVersion of [0, 2, "1"]) {
			store.save("claude", STATE);
			writeFileSync(
				join(stateDir, nth(recordFiles(), 0)),
				JSON.stringify({ ...STATE, schemaVersion }),
			);
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("out-of-order or non-prefix phaseOrder records quarantine", () => {
		const store = fileStore(stateDir);
		const phaseOrders: string[][] = [
			["Plan"],
			["Discuss", "Ship"],
			["Verify", "Discuss"],
			["Discuss", "Plan", "Execute", "Verify", "Ship", "Discuss"],
		];
		for (const phaseOrder of phaseOrders) {
			store.save("claude", STATE);
			writeFileSync(
				join(stateDir, nth(recordFiles(), 0)),
				JSON.stringify({ ...STATE, phaseOrder }),
			);
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("unknown top-level fields and invalid transition lifecycles quarantine", () => {
		const store = fileStore(stateDir);
		const at = "2026-11-17T10:00:00.000Z";
		const malformed: unknown[] = [
			{ ...STATE, futureField: true },
			{
				...STATE,
				transitions: [
					{
						at,
						from: "staging",
						event: "attempt(Plan)",
						to: "planning",
						accepted: true,
						refusals: [],
					},
				],
			},
		];
		for (const record of malformed) {
			store.save("claude", STATE);
			writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify(record));
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("saveIfUnchanged only writes over the digest it was read from", () => {
		const store = fileStore(stateDir);
		store.save("claude", STATE);
		const digest = store.digest?.("claude");
		if (digest === undefined || store.saveIfUnchanged === undefined)
			throw new Error("fileStore provides digest and saveIfUnchanged");
		store.save("claude", { ...STATE, executeStarts: 9 });
		expect(store.saveIfUnchanged("claude", { ...STATE, executeStarts: 2 }, digest)).toBe(false);
		const current = store.load("claude");
		expect(current.status === "found" && current.record.executeStarts).toBe(9);
		const freshDigest = store.digest?.("claude");
		if (freshDigest === undefined) throw new Error("fileStore digest is present");
		expect(store.saveIfUnchanged("claude", { ...STATE, executeStarts: 2 }, freshDigest)).toBe(true);
		const saved = store.load("claude");
		expect(saved.status === "found" && saved.record.executeStarts).toBe(2);
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

	test("humanItems round trip in every state", () => {
		const record: PhaseLoopRecord = {
			...STATE,
			humanItems: [
				{ id: "h1", owner: "alice", state: "open" },
				{ id: "h2", owner: "bob", state: "done", evidenceId: "e1" },
				{ id: "h3", owner: "carol", state: "deferred", decisionId: "d1" },
			],
		};
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("a record without humanItems, written before phase 111, loads with an empty list", () => {
		fileStore(stateDir).save("claude", STATE);
		writeFileSync(
			join(stateDir, nth(recordFiles(), 0)),
			JSON.stringify({
				runtimeId: "claude",
				phaseOrder: ["Discuss", "Plan", "Execute"],
				executeStarts: 1,
				shipStarts: 0,
				operatorConfirmations: 0,
			}),
		);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record: STATE });
	});

	test("malformed HTIL entries quarantine the record", () => {
		const store = fileStore(stateDir);
		const malformed: unknown[] = [
			"none",
			[{ id: "h1", owner: "alice", state: "pending" }],
			[{ id: 3, owner: "alice", state: "open" }],
			[{ id: "h1", owner: "alice", state: "done", evidenceId: 7 }],
			[{ id: "h1", owner: "alice", state: "open", decisionId: null }],
		];
		for (const humanItems of malformed) {
			store.save("claude", STATE);
			writeFileSync(
				join(stateDir, nth(recordFiles(), 0)),
				JSON.stringify({ ...STATE, humanItems }),
			);
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("a closedBy record round trips", () => {
		const record: PhaseLoopRecord = {
			...STATE,
			closedBy: { kind: "override", recordId: "d1", recordedAt: "2026-11-17T10:00:00.000Z" },
		};
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("a malformed closedBy quarantines the record", () => {
		const store = fileStore(stateDir);
		const at = "2026-11-17T10:00:00.000Z";
		const malformed: unknown[] = [
			null,
			{ kind: "pass", recordId: "audit-1", recordedAt: at },
			{ kind: "audit", recordId: 7, recordedAt: at },
			{ kind: "audit", recordId: "audit-1" },
		];
		for (const closedBy of malformed) {
			store.save("claude", STATE);
			writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify({ ...STATE, closedBy }));
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("audits, overrides, and resolution metadata round trip", () => {
		const at = "2026-11-17T10:00:00.000Z";
		const record: PhaseLoopRecord = {
			...STATE,
			humanItems: [
				{
					id: "h1",
					owner: "alice",
					state: "done",
					evidenceId: "e1",
					resolvedBy: "alice",
					resolvedAt: at,
				},
			],
			audits: [{ id: "review:abc", kind: "validation", result: "pass", recordedAt: at }],
			overrides: [{ decisionId: "override:abc", owner: "alice", decidedAt: at, reason: "ship" }],
		};
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("malformed audits or overrides quarantine the record", () => {
		const store = fileStore(stateDir);
		const at = "2026-11-17T10:00:00.000Z";
		const malformed: Record<string, unknown>[] = [
			{ audits: [{ id: "review:abc", kind: "validation", result: "maybe", recordedAt: at }] },
			{ audits: [{ id: 7, kind: "audit", result: "pass", recordedAt: at }] },
			{ audits: "none" },
			{ overrides: [{ decisionId: "d1", owner: "alice", decidedAt: at }] },
		];
		for (const fields of malformed) {
			store.save("claude", STATE);
			writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify({ ...STATE, ...fields }));
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("P3 transition counters and transition provenance round trip", () => {
		const at = "2026-11-17T10:00:00.000Z";
		const record = {
			...STATE,
			transitionSeq: 3,
			transitionStats: { attempts: 3, accepted: 2, refused: 1 },
			transitions: [
				{
					at,
					from: "ready",
					event: "attempt(Discuss)",
					to: "discussing",
					accepted: true,
					refusals: [],
					seq: 1,
					source: "omp",
					traceId: "trace-1",
					refusalCodes: [],
				},
				{
					at,
					from: "discussing",
					event: "attempt(Plan)",
					to: "planning",
					accepted: true,
					refusals: [],
					seq: 2,
					source: "direct",
				},
				{
					at,
					from: "planning",
					event: "attempt(Execute)",
					to: "planning",
					accepted: false,
					refusals: ["not connected"],
					seq: 3,
					source: "ship",
					traceId: "trace-3",
					refusalCodes: ["not-connected"],
				},
			],
			cleanedUpReason: "done",
		} as PhaseLoopRecord;
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("legacy transitions without P3 fields load unchanged", () => {
		const at = "2026-11-17T10:00:00.000Z";
		const legacy: PhaseLoopRecord = {
			...STATE,
			schemaVersion: 1,
			transitions: [
				{
					at,
					from: "ready",
					event: "attempt(Discuss)",
					to: "discussing",
					accepted: true,
					refusals: [],
				},
			],
		};
		fileStore(stateDir).save("claude", STATE);
		writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify(legacy));
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record: legacy });
	});

	test("partial P3 fields round trip", () => {
		const at = "2026-11-17T10:00:00.000Z";
		const base = {
			at,
			from: "ready",
			event: "attempt(Discuss)",
			to: "discussing",
			accepted: true,
			refusals: [] as string[],
		};
		const cases: Record<string, unknown>[] = [
			{ transitionSeq: 0 },
			{ transitionStats: { attempts: 0, accepted: 0, refused: 0 } },
			{ transitions: [{ ...base, seq: 0, source: "omp", traceId: "t", refusalCodes: ["a"] }] },
			{ transitionSeq: 2, transitionStats: { attempts: 2, accepted: 1, refused: 1 } },
		];
		for (const fields of cases) {
			const record = { ...STATE, ...fields } as PhaseLoopRecord;
			fileStore(stateDir).save("claude", record);
			expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
		}
	});

	test("malformed P3 fields quarantine the record", () => {
		const store = fileStore(stateDir);
		const at = "2026-11-17T10:00:00.000Z";
		const base = {
			at,
			from: "ready",
			event: "attempt(Discuss)",
			to: "discussing",
			accepted: true,
			refusals: [] as string[],
		};
		const malformed: Record<string, unknown>[] = [
			{ futureField: true, transitionSeq: 1 },
			{ transitionSeq: -1 },
			{ transitionSeq: 1.5 },
			{ transitionSeq: "3" },
			{ transitionStats: null },
			{ transitionStats: { attempts: -1, accepted: 0, refused: 0 } },
			{ transitionStats: { attempts: 2, accepted: 1, refused: 0 } },
			{ transitionStats: { attempts: 1, accepted: 1 } },
			{ transitionStats: { attempts: 3, accepted: 2, refused: 1 }, transitionSeq: 2 },
			{
				transitionStats: { attempts: 1, accepted: 1, refused: 0 },
				transitions: [base, { ...base, seq: 2 }],
			},
			{ transitions: [{ ...base, seq: -1 }] },
			{ transitions: [{ ...base, seq: 0.5 }] },
			{ transitions: [{ ...base, source: "cli" }] },
			{ transitions: [{ ...base, traceId: "" }] },
			{ transitions: [{ ...base, traceId: "   " }] },
			{ transitions: [{ ...base, refusalCodes: "x" }] },
			{ transitions: [{ ...base, refusalCodes: [7] }] },
			{ transitions: [{ ...base, refusalCodes: [""] }] },
			{ transitions: [{ ...base, seq: 5 }], transitionSeq: 3 },
		];
		for (const fields of malformed) {
			store.save("claude", STATE);
			writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify({ ...STATE, ...fields }));
			expect(store.load("claude").status).toBe("quarantined");
		}
	});
	test("P4 HTIL fields round trip", () => {
		const record = {
			...STATE,
			humanItems: [
				{
					id: "h1",
					owner: "alice",
					state: "open",
					createdAt: "2026-11-17T10:00:00.000Z",
					dueAt: "2026-11-17T14:00:00.000Z",
					severity: "critical",
					escalatedTo: "bob",
					escalationCount: 2,
				},
				{
					id: "h2",
					owner: "carol",
					state: "open",
					createdAt: "2026-11-17T10:00:00.000Z",
					dueAt: "2026-11-18T10:00:00.000Z",
					severity: "high",
					escalationCount: 0,
				},
			],
		} as PhaseLoopRecord;
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("legacy HTIL entries without P4 fields load unchanged", () => {
		const legacy: PhaseLoopRecord = {
			...STATE,
			humanItems: [{ id: "h1", owner: "alice", state: "done", evidenceId: "e1" }],
		};
		fileStore(stateDir).save("claude", STATE);
		writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify(legacy));
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record: legacy });
	});

	test("malformed P4 HTIL fields quarantine the record", () => {
		const store = fileStore(stateDir);
		const at = "2026-11-17T10:00:00.000Z";
		const open = { id: "h1", owner: "alice", state: "open" };
		const malformed: unknown[] = [
			[{ ...open, createdAt: 123 }],
			[{ ...open, createdAt: "" }],
			[{ ...open, createdAt: "not-a-date" }],
			[{ ...open, dueAt: null }],
			[{ ...open, dueAt: "not-a-date" }],
			[{ ...open, severity: "urgent" }],
			[{ ...open, severity: "LOW" }],
			[{ ...open, severity: 1 }],
			[{ ...open, escalatedTo: "" }],
			[{ ...open, escalatedTo: "   " }],
			[{ ...open, escalatedTo: 7 }],
			[{ ...open, escalationCount: -1 }],
			[{ ...open, escalationCount: 1.5 }],
			[{ ...open, escalationCount: "2" }],
			[{ ...open, futureField: true }],
			[{ ...open, createdAt: at, severity: "normal", escalationCount: null }],
		];
		for (const humanItems of malformed) {
			store.save("claude", STATE);
			writeFileSync(
				join(stateDir, nth(recordFiles(), 0)),
				JSON.stringify({ ...STATE, humanItems }),
			);
			expect(store.load("claude").status).toBe("quarantined");
		}
	});
	test("override decisions with quorum, expiry, and revocation fields round trip", () => {
		const at = "2026-11-17T10:00:00.000Z";
		const record: PhaseLoopRecord = {
			...STATE,
			overrides: [
				{
					decisionId: "override:abc",
					owner: "alice",
					decidedAt: at,
					reason: "ship",
					expiresAt: "2026-11-18T00:00:00.000Z",
					quorumRequired: 2,
					approvals: ["alice", "bob"],
				},
				{
					decisionId: "override:revoked",
					owner: "alice",
					decidedAt: at,
					reason: "stale",
					revokedAt: at,
					revokedBy: "alice",
					revokeReason: "superseded",
				},
			],
		};
		fileStore(stateDir).save("claude", record);
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record });
	});

	test("a legacy override without new fields loads unchanged", () => {
		const legacy = {
			...STATE,
			overrides: [
				{ decisionId: "d1", owner: "alice", decidedAt: "2026-11-17T10:00:00.000Z", reason: "ship" },
			],
		};
		fileStore(stateDir).save("claude", STATE);
		writeFileSync(join(stateDir, nth(recordFiles(), 0)), JSON.stringify(legacy));
		expect(fileStore(stateDir).load("claude")).toEqual({ status: "found", record: legacy });
	});

	test("malformed quorum, expiry, or revocation fields quarantine the record", () => {
		const store = fileStore(stateDir);
		const at = "2026-11-17T10:00:00.000Z";
		const base = { decisionId: "d1", owner: "alice", decidedAt: at, reason: "ship" };
		const malformed: unknown[] = [
			{ ...base, expiresAt: 7 },
			{ ...base, expiresAt: "" },
			{ ...base, expiresAt: "not-a-date" },
			{ ...base, quorumRequired: 0 },
			{ ...base, quorumRequired: -2 },
			{ ...base, quorumRequired: 1.5 },
			{ ...base, quorumRequired: "2" },
			{ ...base, approvals: "alice" },
			{ ...base, approvals: ["alice", 7] },
			{ ...base, approvals: ["alice", " "] },
			{ ...base, approvals: [""] },
			{ ...base, revokedAt: at },
			{ ...base, revokedBy: "alice" },
			{ ...base, revokeReason: "stale" },
			{ ...base, revokedAt: at, revokedBy: "alice" },
			{ ...base, revokedAt: "not-a-date", revokedBy: "alice", revokeReason: "stale" },
			{ ...base, revokedAt: at, revokedBy: " ", revokeReason: "stale" },
			{ ...base, revokedAt: at, revokedBy: "alice", revokeReason: "" },
		];
		for (const override of malformed) {
			store.save("claude", STATE);
			writeFileSync(
				join(stateDir, nth(recordFiles(), 0)),
				JSON.stringify({ ...STATE, overrides: [override] }),
			);
			expect(store.load("claude").status).toBe("quarantined");
		}
	});

	test("per-record saves leave other records alone and no guard residue", () => {
		const store = fileStore(stateDir);
		const a: PhaseLoopRecord = { ...STATE, runtimeId: "a" };
		const b: PhaseLoopRecord = { ...STATE, runtimeId: "b" };
		store.save("a", a);
		store.save("b", b);
		store.save("a", { ...a, executeStarts: 2 });
		expect(store.load("a")).toEqual({ status: "found", record: { ...a, executeStarts: 2 } });
		expect(store.load("b")).toEqual({ status: "found", record: b });
		expect(
			readdirSync(stateDir).filter((name) => name.includes("guard") || name.includes("lock")),
		).toEqual([]);
	});

	test("saveIfUnchanged refuses a stale digest and commits a fresh one", () => {
		const store = fileStore(stateDir);
		store.save("claude", STATE);
		const digest = store.digest?.("claude");
		expect(store.saveIfUnchanged?.("claude", { ...STATE, executeStarts: 2 }, "stale")).toBe(false);
		expect(store.saveIfUnchanged?.("claude", { ...STATE, executeStarts: 2 }, digest)).toBe(true);
		expect(store.load("claude")).toEqual({
			status: "found",
			record: { ...STATE, executeStarts: 2 },
		});
	});
});
