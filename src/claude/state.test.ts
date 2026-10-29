// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import type { DecisionRecord } from "../decisions/types.ts";
import { shipNudge } from "../ship/nudge.ts";
import { DEFAULT_SHIP_CONFIG } from "../ship/types.ts";
import type { ModelResolution } from "../host/engine.ts";
import { main as mcpMain } from "../mcp/cli.ts";
import type { TrackingRefs } from "../track/types.ts";
import { LockTimeoutError, type LockOptions, writeFileAtomic } from "./atomic.ts";
import {
	CLI_LOCK,
	controlPath,
	defaultStateDir,
	degradedNodeIds,
	legacySessionPath,
	readControl,
	readLast,
	readSession,
	type SessionRecord,
	sessionPath,
	sessionRecordPath,
	trackingCheckpoint,
	updateSession,
	writeControl,
	writeSession,
	withLastLock,
} from "./state.ts";

const ANSWERS_HOOK = join(import.meta.dir, "..", "..", "hooks", "answers.ts");

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-state-"));
	dirs.push(dir);
	return join(dir, "ultrathink");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("defaultStateDir", () => {
	test("prefers ULTRATHINK_STATE_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
		expect(defaultStateDir({ ULTRATHINK_STATE_DIR: "/x" })).toBe("/x");
		expect(defaultStateDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", "ultrathink"));
		expect(defaultStateDir({}).endsWith(join(".claude", "ultrathink"))).toBe(true);
	});
});

describe("control state", () => {
	test("missing file is empty; write merges and persists", () => {
		const dir = tempDir();
		expect(readControl(dir)).toEqual({});
		expect(writeControl(dir, { enabled: false })).toEqual({ enabled: false });
		expect(writeControl(dir, { hitlEnabled: true })).toEqual({ enabled: false, hitlEnabled: true });
		expect(readControl(dir)).toEqual({ enabled: false, hitlEnabled: true });
	});

	test("hitlEnabled and engine persist; unknown engine values are dropped", () => {
		const dir = tempDir();
		writeControl(dir, { hitlEnabled: false, engine: "claude" });
		expect(readControl(dir)).toEqual({ hitlEnabled: false, engine: "claude" });
		writeControl(dir, { engine: "bogus" as unknown as "grok" });
		expect(readControl(dir).engine).toBeUndefined();
		expect(readControl(dir).hitlEnabled).toBe(false);
	});

	test("trackEnabled persists; a hand-edited non-boolean value is dropped", () => {
		const dir = tempDir();
		writeControl(dir, { trackEnabled: false });
		expect(readControl(dir)).toEqual({ trackEnabled: false });
		writeFileSync(controlPath(dir), JSON.stringify({ trackEnabled: "off", hitlEnabled: true }));
		expect(readControl(dir)).toEqual({ hitlEnabled: true });
	});
});

describe("session records", () => {
	test("round-trips and mirrors to last.json; ids are sanitized", () => {
		const dir = tempDir();
		const record = {
			sessionId: "abc/../evil",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" as const },
		};
		writeSession(dir, record);
		expect(existsSync(sessionPath(dir, "abc/../evil"))).toBe(true);
		expect(sessionPath(dir, "abc/../evil")).toMatch(/abc_\.\._evil~[0-9a-f]{16}\.json$/);
		expect(readSession(dir, "abc/../evil")).toEqual(record);
		expect(readLast(dir)).toEqual(record);
		expect(readSession(dir, "nope")).toBeUndefined();
	});

	test("a record saved under the earlier file name is read back for its own id; a file naming another id is not", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const saved = {
			sessionId: "Claude-A",
			at: 1,
			result: { xml: "<X/>", original: "old answers", root: "X", source: "llm" as const },
		};
		writeFileSync(legacySessionPath(dir, "Claude-A"), JSON.stringify(saved));
		expect(legacySessionPath(dir, "Claude-A")).not.toBe(sessionPath(dir, "Claude-A"));
		expect(sessionRecordPath(dir, "Claude-A")).toBe(legacySessionPath(dir, "Claude-A"));
		expect(readSession(dir, "Claude-A")).toEqual(saved);
		// On a case-insensitive file system the earlier name of `claude-a` is the same file, but it records another id.
		writeFileSync(
			legacySessionPath(dir, "claude-a"),
			JSON.stringify({ ...saved, sessionId: "Claude-A" }),
		);
		expect(readSession(dir, "claude-a")).toBeUndefined();
		// A replan writes the current name, and from then on that record is the one read.
		const replanned = { ...saved, at: 2 };
		writeSession(dir, replanned);
		expect(sessionRecordPath(dir, "Claude-A")).toBe(sessionPath(dir, "Claude-A"));
		expect(readSession(dir, "Claude-A")).toEqual(replanned);
	});

	test("round-trips a record carrying a track plan and kickoff/sync flags", () => {
		const dir = tempDir();
		const record = {
			sessionId: "s1",
			at: 2,
			engine: "claude:sonnet",
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" as const },
			plan: {
				graphId: "ut-1",
				task: {
					graphId: "ut-1",
					item: "x",
					description: "x",
					upliftedPrompt: "<X/>",
					agent: "claude-code",
					status: "Planning",
					linearState: "Todo",
				},
				issues: [],
				subIssues: [],
				linearIssues: [],
				linearSubIssues: [],
				hitl: { blocking: [], nonBlocking: [] },
			},
			kickedOff: true,
			synced: false,
		};
		writeSession(dir, record);
		expect(readSession(dir, "s1")).toEqual(record);
	});
});

describe("session records and Jev decisions", () => {
	/** A record as written before Decisions existed: a GSD skill run with a plan and an unfinished ship phase, no `decisions`. */
	const OLD_RECORD: SessionRecord = {
		sessionId: "old-1",
		at: 1_759_000_000_000,
		engine: "claude:sonnet",
		host: "claude-code",
		result: {
			xml: "<BUILD_PROMPT/>",
			original: "run the phase",
			root: "BUILD_PROMPT",
			source: "llm",
		},
		plan: {
			graphId: "ut-old",
			task: {
				graphId: "ut-old",
				item: "run the phase",
				description: "run the phase",
				upliftedPrompt: "<BUILD_PROMPT/>",
				agent: "claude-code",
				status: "Planning",
				linearState: "Todo",
			},
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
			hitl: { blocking: [], nonBlocking: [] },
		},
		kickedOff: true,
		synced: false,
		skill: { name: "gsd-execute-phase", source: "slash" },
		ship: { phase: "needs-fixes", rounds: [], updatedAt: 5 },
	};
	const nudgeInput = (record: SessionRecord) => ({
		record,
		config: { ...DEFAULT_SHIP_CONFIG, enabled: true },
		precheck: { ok: true, branch: "feat/x", base: "main", ahead: 2 },
		statePath: "/s/old-1.json",
		env: {},
	});
	/** Writes raw JSON the way the pre-Decisions writer did (tab-indented, trailing newline), bypassing writeSession. */
	function writeRaw(dir: string, sessionId: string, value: unknown): void {
		const text = `${JSON.stringify(value, null, "\t")}\n`;
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, sessionId), text);
		writeFileSync(join(dir, "last.json"), text);
	}

	test("a record written before Decisions loads with every field intact and the ship nudge decides as today (AC-3.15)", () => {
		const dir = tempDir();
		writeRaw(dir, "old-1", OLD_RECORD);
		const loaded = readSession(dir, "old-1");
		expect(loaded).toEqual(OLD_RECORD);
		expect(readLast(dir)).toEqual(OLD_RECORD);
		expect(loaded && "decisions" in loaded).toBe(false);
		const today = shipNudge(nudgeInput(OLD_RECORD));
		expect(today?.decision).toBe("block");
		expect(shipNudge(nudgeInput(loaded as SessionRecord))).toEqual(today);
	});

	test("round-trips a planned record carrying its Jev decisions in call order", () => {
		const dir = tempDir();
		const decisions: DecisionRecord[] = [
			{
				point: "plan",
				outcome: "ok",
				model: "typesafe/jev-1.13-20260917",
				id: "gen-dec-test",
				p: 0.97,
				probabilities: { plan_worthy: 0.97 },
				threshold: 0.2,
				action: "plan",
				latencyMs: 412,
				attempts: 1,
				cost: 0.000019,
				at: 1_759_000_000_500,
			},
			{
				point: "knowledge",
				outcome: "error",
				model: "~typesafe/jev-latest",
				probabilities: {},
				threshold: 0.8,
				action: "fail-open",
				latencyMs: 3000,
				attempts: 2,
				error: "timeout",
				at: 1_759_000_003_600,
			},
		];
		const record: SessionRecord = { ...OLD_RECORD, sessionId: "new-1", decisions };
		writeSession(dir, record);
		expect(readSession(dir, "new-1")).toEqual(record);
		expect(readLast(dir)?.decisions).toEqual(decisions);
	});

	test("a malformed decisions value does not break loading the rest of the record or the ship nudge", () => {
		for (const decisions of ["oops", 7, { point: "plan" }, [null, { bogus: true }], null]) {
			const dir = tempDir();
			writeRaw(dir, "old-1", { ...OLD_RECORD, decisions });
			const loaded = readSession(dir, "old-1");
			expect(loaded).toBeDefined();
			const { decisions: _ignored, ...rest } = loaded as SessionRecord;
			expect(rest).toEqual(OLD_RECORD);
			expect(shipNudge(nudgeInput(loaded as SessionRecord))?.decision).toBe("block");
		}
	});
});

describe("session records and lessons/docs lookups", () => {
	const base: SessionRecord = {
		sessionId: "lk-1",
		at: 3,
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
	};

	test("both lookups round-trip through the session file and last.json", () => {
		const dir = tempDir();
		const record: SessionRecord = {
			...base,
			lessons: {
				outcome: "used",
				count: 2,
				ids: ["a1", "b2"],
				chars: 640,
				ms: 31,
				source: "hindsight",
			},
			docs: { status: "error", count: 0, chars: 0, ms: 9, datasets: 2, reason: "auth" },
		};
		writeSession(dir, record);
		expect(readSession(dir, "lk-1")).toEqual(record);
		expect(readLast(dir)).toEqual(record);
	});

	test("a record written before they existed reads back without them", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(
			sessionPath(dir, "old-2"),
			JSON.stringify({
				sessionId: "old-2",
				at: 1,
				engine: "claude:sonnet",
				result: base.result,
				knowledge: { outcome: "none", docs: [], chars: 0, ms: 1 },
			}),
		);
		const record = readSession(dir, "old-2");
		expect(record?.sessionId).toBe("old-2");
		expect(record?.knowledge?.outcome).toBe("none");
		expect(record).not.toHaveProperty("lessons");
		expect(record).not.toHaveProperty("docs");
		writeSession(dir, record as SessionRecord);
		expect(readSession(dir, "old-2")).toEqual(record);
	});
});

describe("session records and the model resolution record", () => {
	const base: SessionRecord = {
		sessionId: "mr-1",
		at: 4,
		engine: "claude:<model>",
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
	};
	const resolution: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		api: "acme-chat",
		providerType: "acme",
		provider: "acme",
		modelId: "sol-1",
		modelKnown: true,
		label: "omp-native:acme/sol-1 [detected]",
	};

	test("the safe record round-trips through the session file and last.json, exactly as given", () => {
		const dir = tempDir();
		const record: SessionRecord = { ...base, modelResolution: resolution };
		writeSession(dir, record);
		expect(readSession(dir, "mr-1")).toEqual(record);
		expect(readLast(dir)).toEqual(record);
		expect(Object.keys(readSession(dir, "mr-1")?.modelResolution ?? {}).sort()).toEqual(
			Object.keys(resolution).sort(),
		);
	});

	test("a record written before it existed reads back without it and stays valid", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(
			sessionPath(dir, "old-3"),
			JSON.stringify({ sessionId: "old-3", at: 1, engine: "claude:<model>", result: base.result }),
		);
		const record = readSession(dir, "old-3");
		expect(record?.sessionId).toBe("old-3");
		expect(record).not.toHaveProperty("modelResolution");
		writeSession(dir, record as SessionRecord);
		expect(readSession(dir, "old-3")).toEqual(record);
	});

	test("control engine values are unchanged: a resolution record is never control state", () => {
		const dir = tempDir();
		for (const engine of ["auto", "claude", "grok", "muse"] as const) {
			writeControl(dir, { engine });
			expect(readControl(dir).engine).toBe(engine);
		}
		writeFileSync(
			controlPath(dir),
			JSON.stringify({ engine: "omp-native", modelResolution: resolution }),
		);
		expect(readControl(dir)).toEqual({});
	});
});

describe("private, atomic state files", () => {
	const record: SessionRecord = {
		sessionId: "p1",
		at: 5,
		result: { xml: "<X/>", original: "a verbatim prompt", root: "X", source: "llm" },
	};

	test.skipIf(process.platform === "win32")(
		"session, last and control files are 0600 in 0700 directories",
		() => {
			const dir = tempDir();
			writeSession(dir, record);
			writeControl(dir, { enabled: true });
			for (const path of [sessionPath(dir, "p1"), join(dir, "last.json"), controlPath(dir)])
				expect(statSync(path).mode & 0o777).toBe(0o600);
			for (const path of [dir, join(dir, "sessions")])
				expect(statSync(path).mode & 0o777).toBe(0o700);
		},
	);

	test.skipIf(process.platform === "win32")(
		"a 0644 file written by an older version is 0600 after its next rewrite",
		() => {
			const dir = tempDir();
			mkdirSync(join(dir, "sessions"), { recursive: true });
			writeFileSync(sessionPath(dir, "p1"), JSON.stringify(record), { mode: 0o644 });
			writeSession(dir, record);
			expect(statSync(sessionPath(dir, "p1")).mode & 0o777).toBe(0o600);
		},
	);

	test("writes keep the tab-indented JSON format and leave no temporary or lock files", () => {
		const dir = tempDir();
		writeSession(dir, record);
		writeControl(dir, { enabled: false });
		expect(readFileSync(sessionPath(dir, "p1"), "utf8")).toBe(
			`${JSON.stringify(record, null, "\t")}\n`,
		);
		expect(readFileSync(controlPath(dir), "utf8")).toBe('{\n\t"enabled": false\n}\n');
		for (const where of [dir, join(dir, "sessions")]) {
			expect(
				readdirSync(where).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")),
			).toEqual([]);
		}
	});

	test("a truncated session file reads as missing and the next writeSession replaces it whole", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, "p1"), '{"sessionId":"p1","at":5,"resu');
		expect(readSession(dir, "p1")).toBeUndefined();
		writeSession(dir, record);
		expect(readSession(dir, "p1")).toEqual(record);
	});
});

describe("updateSession", () => {
	const record: SessionRecord = {
		sessionId: "u1",
		at: 1,
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
	};

	test("returns the mutated record, writing the session file and last.json", () => {
		const dir = tempDir();
		writeSession(dir, record);
		const next = updateSession(dir, "u1", (current) => ({ ...current, kickedOff: true }));
		expect(next).toEqual({ ...record, kickedOff: true });
		expect(readSession(dir, "u1")).toEqual({ ...record, kickedOff: true });
		expect(readLast(dir)).toEqual({ ...record, kickedOff: true });
		expect(existsSync(`${sessionPath(dir, "u1")}.lock`)).toBe(false);
	});

	test("a missing record is undefined, mutate is not called and nothing is written", () => {
		const dir = tempDir();
		let called = false;
		expect(
			updateSession(dir, "nope", (current) => {
				called = true;
				return current;
			}),
		).toBeUndefined();
		expect(called).toBe(false);
		expect(existsSync(sessionPath(dir, "nope"))).toBe(false);
		expect(existsSync(join(dir, "last.json"))).toBe(false);
	});

	test("a mutate that returns undefined leaves the record as it was", () => {
		const dir = tempDir();
		writeSession(dir, record);
		const before = readFileSync(sessionPath(dir, "u1"), "utf8");
		expect(updateSession(dir, "u1", () => undefined)).toBeUndefined();
		expect(readFileSync(sessionPath(dir, "u1"), "utf8")).toBe(before);
	});

	test("a throwing mutate propagates and releases the lock", () => {
		const dir = tempDir();
		writeSession(dir, record);
		expect(() =>
			updateSession(dir, "u1", () => {
				throw new Error("bad mutate");
			}),
		).toThrow("bad mutate");
		expect(existsSync(`${sessionPath(dir, "u1")}.lock`)).toBe(false);
		expect(readSession(dir, "u1")).toEqual(record);
	});
});

describe("updateSession under a held lock (D-07: no silent overwrite)", () => {
	const record: SessionRecord = {
		sessionId: "u1",
		at: 1,
		result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
	};
	/** Clock and liveness seams that make a live holder time out at once, without waiting. */
	function starved(): LockOptions {
		let clock = 0;
		return {
			now: () => clock,
			sleep: (ms) => {
				clock += ms;
			},
			staleMs: Number.MAX_SAFE_INTEGER,
			liveness: { killAlive: () => true },
		};
	}

	test("with the throw policy a holder past the timeout makes the second update fail loudly instead of being overwritten; a retry loses no field", () => {
		const dir = tempDir();
		writeSession(dir, record);
		let caught: unknown;
		updateSession(dir, "u1", (current) => {
			// A second writer arrives while this one holds the lock, and the holder outlives its timeout.
			try {
				updateSession(dir, "u1", (inner) => ({ ...inner, synced: true }), {
					...starved(),
					...CLI_LOCK,
				});
			} catch (error) {
				caught = error;
			}
			return { ...current, kickedOff: true };
		});
		expect(caught).toBeInstanceOf(LockTimeoutError);
		expect(readSession(dir, "u1")).toEqual({ ...record, kickedOff: true });
		// The failed writer retries once the lock is free: both fields survive.
		updateSession(dir, "u1", (current) => ({ ...current, synced: true }), CLI_LOCK);
		expect(readSession(dir, "u1")).toEqual({ ...record, kickedOff: true, synced: true });
	});

	test("the hook policy still writes unlocked after the timeout and says so in one line through the injected log", () => {
		const dir = tempDir();
		writeSession(dir, record);
		const lines: string[] = [];
		let returned: SessionRecord | undefined;
		updateSession(dir, "u1", (current) => {
			returned = updateSession(dir, "u1", (inner) => ({ ...inner, synced: true }), {
				...starved(),
				log: (line) => lines.push(line),
			});
			return { ...current, kickedOff: true };
		});
		expect(returned?.synced).toBe(true);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("writing unlocked");
	});

	test("without an injected log the unlocked write is still visible on stderr", () => {
		const dir = tempDir();
		writeSession(dir, record);
		const written: string[] = [];
		const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write);
		try {
			updateSession(dir, "u1", (current) => {
				updateSession(dir, "u1", (inner) => ({ ...inner, synced: true }), starved());
				return { ...current, kickedOff: true };
			});
		} finally {
			spy.mockRestore();
		}
		expect(written.filter((line) => line.includes("writing unlocked"))).toHaveLength(1);
	});
});

describe("tracking checkpoints and degraded nodes", () => {
	const tracking = (graphId: string, node: string): TrackingRefs => ({
		graphId,
		status: "partial",
		linear: {
			nodes: {
				[node]: { id: node, identifier: node, url: `https://linear.app/${node}`, title: node },
			},
			steps: {},
		},
		notion: { nodes: {}, steps: {} },
		errors: [],
		updatedAt: 5,
	});
	const planned = (graphId: string): SessionRecord =>
		({
			sessionId: "t1",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
			plan: { graphId, task: { graphId } },
		}) as unknown as SessionRecord;

	test("degradedNodeIds reads the fill:<id> tokens of the record's degraded list and nothing else", () => {
		expect(degradedNodeIds(undefined)).toEqual([]);
		expect(
			degradedNodeIds({ degraded: ["uplift", "fill:n2", "graph", "fill:n5", "clarify"] }),
		).toEqual(["n2", "n5"]);
	});

	test("a checkpoint merges the live refs over what the record already holds, never fewer", () => {
		const prior = trackingCheckpoint("g1", tracking("g1", "n1"))(planned("g1"));
		expect(Object.keys(prior?.tracking?.linear.nodes ?? {})).toEqual(["n1"]);
		const next = trackingCheckpoint("g1", tracking("g1", "n2"))(prior as SessionRecord);
		expect(Object.keys(next?.tracking?.linear.nodes ?? {}).sort()).toEqual(["n1", "n2"]);
		expect(next?.tracking?.status).toBe("partial");
	});

	test("a checkpoint for a graph the record no longer holds changes nothing", () => {
		expect(trackingCheckpoint("old", tracking("old", "n1"))(planned("new"))).toBeUndefined();
	});
});

describe("strict last-lock completion", () => {
	test("a completed live writer can be replaced after a competing mutation guard is freed", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const last = join(dir, "last.json");
		const guard = `${last}.lock.guard`;
		const owner = `${process.pid}.${"a".repeat(32)}`;
		const before: SessionRecord = {
			sessionId: "before",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
		};
		const after: SessionRecord = { ...before, sessionId: "after" };
		expect(
			withLastLock(last, () => {
				writeFileSync(last, JSON.stringify(before));
				mkdirSync(guard, { mode: 0o700 });
				writeFileSync(join(guard, owner), "", { mode: 0o600 });
			}),
		).toBe(true);
		expect(writeSession(dir, after)).toBeDefined();
		expect(readSession(dir, "after")).toEqual(after);
		expect(readLast(dir)).toEqual(before);
		rmSync(guard, { recursive: true });
		expect(writeSession(dir, after)).toBeUndefined();
		expect(readLast(dir)).toEqual(after);
		expect(existsSync(`${last}.lock`)).toBe(false);
	});

	test("finishing an old inode cannot release a successor with the same live PID", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const last = join(dir, "last.json");
		const lock = `${last}.lock`;
		const before: SessionRecord = {
			sessionId: "before",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
		};
		expect(
			withLastLock(last, () => {
				writeFileSync(last, JSON.stringify(before));
				rmSync(lock);
				writeFileSync(lock, String(process.pid), { mode: 0o600 });
			}),
		).toBe(true);
		expect(withLastLock(last, () => writeFileSync(last, '{"sessionId":"incorrect"}'))).toBe(false);
		expect(readLast(dir)).toEqual(before);
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
	});
});

describe("the HITL answers hook", () => {
	test("folds the user's answers into the session record and spec file, keeping other fields, owner-only", async () => {
		const dir = tempDir();
		const record: SessionRecord = {
			sessionId: "h1",
			at: 1,
			kickedOff: true,
			result: {
				xml: "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>",
				original: "x",
				root: "BUILD_PROMPT",
				source: "llm",
			},
		};
		writeSession(dir, record);
		const envelope = {
			session_id: "h1",
			tool_name: "AskUserQuestion",
			tool_input: {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [{ label: "Postgres" }, { label: "SQLite" }],
					},
				],
			},
			tool_response: { answers: { "Which database?": "Postgres" } },
		};
		const proc = Bun.spawn([process.execPath, ANSWERS_HOOK], {
			cwd: join(dir, ".."),
			env: { PATH: process.env.PATH, HOME: dir, ULTRATHINK_STATE_DIR: dir },
			stdin: new TextEncoder().encode(JSON.stringify(envelope)),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ systemMessage: "HITL · 1 answer(s) recorded" });

		const saved = readSession(dir, "h1");
		expect(saved?.kickedOff).toBe(true);
		expect(saved?.clarifications).toHaveLength(1);
		expect(saved?.clarifications?.[0]).toMatchObject({
			question: "Which database?",
			answer: "Postgres",
			source: "user",
		});
		expect(saved?.result.xml).toContain("Postgres");
		const specPath = sessionPath(dir, "h1").replace(/\.json$/, ".xml");
		expect(readFileSync(specPath, "utf8")).toBe(`${saved?.result.xml}\n`);
		expect(readLast(dir)?.clarifications).toHaveLength(1);
		if (process.platform !== "win32") {
			expect(statSync(specPath).mode & 0o777).toBe(0o600);
			expect(statSync(sessionPath(dir, "h1")).mode & 0o777).toBe(0o600);
		}
	});

	test("a session with no record is left alone and the hook stays silent", async () => {
		const dir = tempDir();
		const proc = Bun.spawn([process.execPath, ANSWERS_HOOK], {
			cwd: join(dir, ".."),
			env: { PATH: process.env.PATH, HOME: dir, ULTRATHINK_STATE_DIR: dir },
			stdin: new TextEncoder().encode(
				JSON.stringify({
					session_id: "ghost",
					tool_name: "AskUserQuestion",
					tool_input: {},
					tool_response: { answers: { Q: "a" } },
				}),
			),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		expect(stdout).toBe("");
		expect(existsSync(sessionPath(dir, "ghost"))).toBe(false);
	});
});

describe("a legacy-only session record through the answers hook", () => {
	test("the answer and a later write through the original stateFile stay in one JSON/XML pair", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const sessionId = "Claude-A";
		const legacy = legacySessionPath(dir, sessionId);
		const legacyXml = legacy.replace(/\.json$/, ".xml");
		const xml = "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>";
		writeFileSync(
			legacy,
			JSON.stringify({
				sessionId,
				at: 1,
				kickedOff: false,
				result: { xml, original: "x", root: "BUILD_PROMPT", source: "llm" },
			}),
		);
		writeFileSync(legacyXml, `${xml}\n`);
		expect(sessionRecordPath(dir, sessionId)).toBe(legacy);

		const envelope = {
			session_id: sessionId,
			tool_name: "AskUserQuestion",
			tool_input: {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [{ label: "Postgres" }, { label: "SQLite" }],
					},
				],
			},
			tool_response: { answers: { "Which database?": "Postgres" } },
		};
		const proc = Bun.spawn([process.execPath, ANSWERS_HOOK], {
			cwd: join(dir, ".."),
			env: { PATH: process.env.PATH, HOME: dir, ULTRATHINK_STATE_DIR: dir },
			stdin: new TextEncoder().encode(JSON.stringify(envelope)),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ systemMessage: "HITL · 1 answer(s) recorded" });

		// The answer stays in the legacy pair: the readers keep selecting it and the new name is never created.
		expect(sessionRecordPath(dir, sessionId)).toBe(legacy);
		expect(existsSync(sessionPath(dir, sessionId))).toBe(false);
		const answered = readSession(dir, sessionId);
		expect(answered?.clarifications?.[0]).toMatchObject({
			question: "Which database?",
			answer: "Postgres",
		});
		expect(answered?.result.xml).toContain("Postgres");
		expect(readFileSync(legacyXml, "utf8")).toBe(`${answered?.result.xml}\n`);

		// A command holding the original stateFile (the legacy JSON) writes into that same record and XML pair.
		expect(await mcpMain(["session", "mark", "--state", legacy, "kicked-off"])).toBe(0);
		expect(sessionRecordPath(dir, sessionId)).toBe(legacy);
		expect(existsSync(sessionPath(dir, sessionId))).toBe(false);
		const marked = readSession(dir, sessionId);
		expect(marked?.kickedOff).toBe(true);
		expect(marked?.clarifications?.[0]).toMatchObject({
			question: "Which database?",
			answer: "Postgres",
		});
		expect(readFileSync(legacyXml, "utf8")).toBe(`${marked?.result.xml}\n`);
	});
});

/** The pid of a child that has already exited: nothing runs under it. */
function deadPid(): number {
	return Bun.spawnSync(["true"]).pid;
}

describe("control state under load and corruption", () => {
	test("two processes toggling different keys concurrently both keep every toggle", async () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const stateUrl = JSON.stringify(join(import.meta.dir, "state.ts"));
		const worker = (key: string) =>
			Bun.spawn(
				[
					"bun",
					"--no-env-file",
					"-e",
					`import { writeControl } from ${stateUrl};\n` +
						`for (let i = 0; i < 25; i++) writeControl(${JSON.stringify(dir)}, { ${key}: i % 2 === 0 }, { timeoutMs: 120_000 });\n`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
		const children = [worker("enabled"), worker("hitlEnabled"), worker("trackEnabled")];
		for (const child of children) expect(await child.exited).toBe(0);
		const control = readControl(dir);
		expect(Object.keys(control).sort()).toEqual(["enabled", "hitlEnabled", "trackEnabled"]);
	}, 120_000);

	test("a lock held past the default wait is waited for (up to 30 s) and never bypassed by an unlocked write", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		writeControl(dir, { enabled: false });
		// A live holder that never lets go: pid alive, start identity unverifiable, never stale.
		writeFileSync(
			`${controlPath(dir)}.lock`,
			JSON.stringify({ pid: process.pid, startTime: "", token: "held" }),
		);
		let clock = 0;
		let slept = 0;
		let caught: unknown;
		try {
			writeControl(
				dir,
				{ hitlEnabled: true },
				{
					now: () => clock,
					sleep: (ms) => {
						slept += ms;
						clock += ms;
					},
					staleMs: Number.MAX_SAFE_INTEGER,
					liveness: { killAlive: () => true },
				},
			);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(LockTimeoutError);
		expect(slept).toBeGreaterThanOrEqual(30_000);
		expect(readControl(dir)).toEqual({ enabled: false });
	});

	test("a corrupt control.json reads as {} for this flight, is quarantined, and the next write persists only deliberate toggles", () => {
		const dir = tempDir();
		writeControl(dir, { enabled: false, hitlEnabled: true });
		writeFileSync(controlPath(dir), '{\n\t"enabled": fal');
		const lines: string[] = [];
		expect(readControl(dir, { log: (line) => lines.push(line) })).toEqual({});
		const quarantined = readdirSync(dir).filter((name) => name.startsWith("control.json.corrupt-"));
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0]).toMatch(/^control\.json\.corrupt-\d+/);
		expect(readFileSync(join(dir, quarantined[0] as string), "utf8")).toBe('{\n\t"enabled": fal');
		expect(existsSync(controlPath(dir))).toBe(false);
		expect(lines.join("\n")).toContain(quarantined[0] as string);
		// Nothing was persisted by the read, and the next write holds only what it was asked to toggle.
		expect(writeControl(dir, { trackEnabled: false })).toEqual({ trackEnabled: false });
		expect(JSON.parse(readFileSync(controlPath(dir), "utf8"))).toEqual({ trackEnabled: false });
		expect(readdirSync(dir).filter((name) => name.startsWith("control.json.corrupt-"))).toEqual(
			quarantined,
		);
	});

	test("a control.json that parses to a non-object is corrupt too; a missing one is {} with no quarantine", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		expect(readControl(dir)).toEqual({});
		expect(readdirSync(dir)).toEqual([]);
		for (const text of ["[]", "null", "7", ""]) {
			writeFileSync(controlPath(dir), text);
			expect(readControl(dir)).toEqual({});
			expect(existsSync(controlPath(dir))).toBe(false);
		}
		expect(
			readdirSync(dir).filter((name) => name.startsWith("control.json.corrupt-")),
		).toHaveLength(4);
	});

	test("a corrupt config layer keeps the lower layers' values for the flight and is never written back", () => {
		const root = mkdtempSync(join(tmpdir(), "ultrathink-config-layer-"));
		dirs.push(root);
		const home = join(root, "home");
		const cwd = join(root, "cwd");
		mkdirSync(join(cwd, ".claude"), { recursive: true });
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(
			join(home, ".claude", "ultrathink.json"),
			JSON.stringify({ track: { enabled: false } }),
		);
		const broken = join(cwd, ".claude", "ultrathink.json");
		writeFileSync(broken, '{"track": {"enabled": tr');
		const env = { CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: join(home, "xdg") };
		const config = loadConfig(claudeConfigPaths(cwd, env));
		expect(config.track.enabled).toBe(false);
		expect(readFileSync(broken, "utf8")).toBe('{"track": {"enabled": tr');
	});
});

describe("last.json refresh waits by wall clock", () => {
	test("a live holder that lets go after 1 s of waiting does not cost the refresh", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const last = join(dir, "last.json");
		const lock = `${last}.lock`;
		writeFileSync(lock, String(process.pid), { mode: 0o600 });
		let clock = 0;
		const refreshed = withLastLock(last, () => writeFileSync(last, '{"ok":true}'), {
			now: () => clock,
			sleep: (ms) => {
				clock += ms;
				if (clock >= 1_000) rmSync(lock, { force: true });
			},
		});
		expect(refreshed).toBe(true);
		expect(readFileSync(last, "utf8")).toBe('{"ok":true}');
	});

	test("a live holder that never lets go gives up only after 3 s", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const last = join(dir, "last.json");
		writeFileSync(`${last}.lock`, String(process.pid), { mode: 0o600 });
		let clock = 0;
		const refreshed = withLastLock(last, () => writeFileSync(last, "{}"), {
			now: () => clock,
			sleep: (ms) => {
				clock += ms;
			},
		});
		expect(refreshed).toBe(false);
		expect(clock).toBeGreaterThanOrEqual(3_000);
		expect(existsSync(last)).toBe(false);
	});
});

describe("writeFileAtomic orphan temp sweep", () => {
	function plant(dir: string, name: string, ageSeconds?: number): string {
		const path = join(dir, name);
		writeFileSync(path, "partial");
		if (ageSeconds !== undefined) {
			const at = Date.now() / 1000 - ageSeconds;
			utimesSync(path, at, at);
		}
		return path;
	}

	test("a write removes old temp files of dead pids and keeps a live pid's, a young one and other files", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const dead = deadPid();
		const orphan = plant(dir, `.control.json.${dead}.deadbeef.tmp`, 600);
		const live = plant(dir, `.control.json.${process.pid}.cafebabe.tmp`, 600);
		const young = plant(dir, `.control.json.${dead}.0badf00d.tmp`, 1);
		const unrelated = plant(dir, `.notes.${dead}.tmp.txt`, 600);
		const plain = plant(dir, "other.json", 600);
		writeFileAtomic(join(dir, "control.json"), "{}");
		expect(existsSync(orphan)).toBe(false);
		for (const kept of [live, young, unrelated, plain]) expect(existsSync(kept)).toBe(true);
		expect(readFileSync(join(dir, "control.json"), "utf8")).toBe("{}");
	});

	test("a temp entry that cannot be unlinked never fails the write", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		// A directory with an orphan's name: unlink on it throws, and the sweep must swallow that.
		const trap = join(dir, `.control.json.${deadPid()}.deadbeef.tmp`);
		mkdirSync(trap);
		const at = Date.now() / 1000 - 600;
		utimesSync(trap, at, at);
		writeFileAtomic(join(dir, "control.json"), "{}");
		expect(readFileSync(join(dir, "control.json"), "utf8")).toBe("{}");
		expect(existsSync(trap)).toBe(true);
	});
});

describe("a failing last.json refresh keeps the session saved", () => {
	test("last.json being a directory returns the refresh note; the session file is written", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "last.json"), { recursive: true });
		const record: SessionRecord = {
			sessionId: "g1",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
		};
		const note = writeSession(dir, record);
		expect(note).toContain("could not refresh");
		expect(note).toContain("last.json");
		expect(readSession(dir, "g1")).toEqual(record);
	});

	test("updateSession on such a store still returns the mutated record", () => {
		const dir = tempDir();
		const record: SessionRecord = {
			sessionId: "g1b",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
		};
		writeSession(dir, record);
		rmSync(join(dir, "last.json"), { force: true });
		mkdirSync(join(dir, "last.json"));
		const next = updateSession(dir, "g1b", (current) => ({ ...current, at: 2 }));
		expect(next?.at).toBe(2);
		expect(readSession(dir, "g1b")?.at).toBe(2);
	});
});

describe("writeControl never builds on an unreadable control.json", () => {
	test("a control.json that cannot be read aborts the write, names the cause and changes nothing", () => {
		const dir = tempDir();
		writeControl(dir, { enabled: false, hitlEnabled: true });
		const text = readFileSync(controlPath(dir), "utf8");
		// A directory in place of the file reads with EISDIR, a non-ENOENT failure that also works as root.
		rmSync(controlPath(dir));
		mkdirSync(controlPath(dir));
		expect(() => writeControl(dir, { trackEnabled: false })).toThrow(
			/could not be read.*nothing was written/,
		);
		expect(statSync(controlPath(dir)).isDirectory()).toBe(true);
		rmSync(controlPath(dir), { recursive: true });
		writeFileSync(controlPath(dir), text);
		expect(readControl(dir)).toEqual({ enabled: false, hitlEnabled: true });
		expect(writeControl(dir, { trackEnabled: false })).toEqual({
			enabled: false,
			hitlEnabled: true,
			trackEnabled: false,
		});
	});

	test("a missing control.json is still empty: the first write creates it", () => {
		const dir = tempDir();
		expect(writeControl(dir, { thinkEnabled: true })).toEqual({ thinkEnabled: true });
	});
});
