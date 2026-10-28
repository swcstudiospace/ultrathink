// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	briefDigest,
	capRefusal,
	findDuplicate,
	type LaneFileFs,
	type LaneRecord,
	laneBriefWithGraphId,
	liveLanes,
	readLaneFile,
	type LaneVerdict,
	parseStatStartTicks,
	START_TIME_TOLERANCE_MS,
	verifyLaneProcess,
	writeLaneFile,
} from "./lane.ts";

const tmpDirs: string[] = [];

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-lane-"));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<LaneRecord> = {}): LaneRecord {
	return {
		laneId: "abcd1234-0-n0nce",
		pid: 4242,
		graphId: "ut-mabc123-0123abcd",
		briefDigest: briefDigest("build x"),
		cwd: "/work/repo",
		startedAt: "2026-10-28T10:00:00.000Z",
		...overrides,
	};
}

describe("briefDigest", () => {
	test("normalizes case and whitespace so equivalent briefs collide", () => {
		expect(briefDigest("Build  X")).toBe(briefDigest("build x"));
		expect(briefDigest("  build\n\tx  ")).toBe(briefDigest("build x"));
		expect(briefDigest("build x")).not.toBe(briefDigest("build y"));
		expect(briefDigest("build x")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("laneBriefWithGraphId", () => {
	test("puts the Graph ID on the first line followed by a blank line", () => {
		const out = laneBriefWithGraphId("ship the thing", "ut-mabc123-0123abcd");
		expect(out).toBe("Graph ID: ut-mabc123-0123abcd\n\nship the thing");
		expect(out.split("\n")[0]).toBe("Graph ID: ut-mabc123-0123abcd");
	});

	test("returns the brief unchanged for an absent or malformed id", () => {
		expect(laneBriefWithGraphId("ship", undefined)).toBe("ship");
		for (const bad of [
			"",
			"ut-mabc123-0123abc",
			"ut-mabc123-0123ABCD",
			"ut-mabc123-0123abcd\nextra",
			"xut-mabc123-0123abcd",
			"ut--0123abcd",
			"Graph ID: injected",
		]) {
			expect(laneBriefWithGraphId("ship", bad)).toBe("ship");
		}
	});
});

describe("lane.json write and read", () => {
	test("round-trips all six keys at mode 0600 and leaves no tmp file", () => {
		const dir = tmp();
		const rec = record();
		writeLaneFile(dir, rec);
		const path = join(dir, "lane.json");
		expect(readLaneFile(dir)).toEqual(rec);
		expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(
			["briefDigest", "cwd", "graphId", "laneId", "pid", "startedAt"].sort(),
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).filter((name) => name.startsWith("lane.json.tmp-"))).toEqual([]);
	});

	test("omits graphId when the lane has none", () => {
		const dir = tmp();
		const { graphId: _graphId, ...rest } = record();
		writeLaneFile(dir, rest);
		expect(Object.keys(JSON.parse(readFileSync(join(dir, "lane.json"), "utf8"))).sort()).toEqual(
			["briefDigest", "cwd", "laneId", "pid", "startedAt"].sort(),
		);
		expect(readLaneFile(dir)).toEqual(rest);
	});

	test("never writes lane.json directly: tmp file at 0600 first, then rename onto it", () => {
		const dir = tmp();
		const calls: string[] = [];
		const fs: LaneFileFs = {
			writeFileSync(path, data, options) {
				const rel = path.slice(dir.length + 1).replace(/\d+$/, "N");
				calls.push(`write ${rel} ${options.mode.toString(8)}`);
				writeFileSync(path, data, options);
			},
			renameSync(from, to) {
				calls.push(
					`rename ${from.slice(dir.length + 1).replace(/\d+$/, "N")} ${to.slice(dir.length + 1)}`,
				);
				renameSync(from, to);
			},
			readFileSync,
			existsSync,
		};
		writeLaneFile(dir, record(), fs);
		expect(calls).toEqual(["write lane.json.tmp-N 600", "rename lane.json.tmp-N lane.json"]);
	});

	test("overwrites a previous lane.json whole", () => {
		const dir = tmp();
		writeLaneFile(dir, record({ pid: 1 }));
		writeLaneFile(dir, record({ pid: 2 }));
		expect(readLaneFile(dir)?.pid).toBe(2);
	});

	test("reads missing, corrupt and wrong-shape files as undefined", () => {
		const dir = tmp();
		expect(readLaneFile(dir)).toBeUndefined();
		writeFileSync(join(dir, "lane.json"), "{ not json");
		expect(readLaneFile(dir)).toBeUndefined();
		for (const body of [
			"[]",
			"null",
			JSON.stringify({ ...record(), pid: "4242" }),
			JSON.stringify({ ...record(), pid: 0 }),
			JSON.stringify({ ...record(), pid: 1.5 }),
			JSON.stringify({ ...record(), laneId: "" }),
			JSON.stringify({ ...record(), cwd: 7 }),
			JSON.stringify({ ...record(), graphId: 7 }),
		]) {
			writeFileSync(join(dir, "lane.json"), body);
			expect(readLaneFile(dir)).toBeUndefined();
		}
	});

	test("stores facts only: no env or key material is added to the record", () => {
		const dir = tmp();
		const canary = "sk-or-fake-CANARYCANARYCANARY1234";
		const prior = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = canary;
		try {
			writeLaneFile(dir, record({ cwd: "/work/sk-or-fake" }));
		} finally {
			if (prior === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = prior;
		}
		const text = readFileSync(join(dir, "lane.json"), "utf8");
		expect(text).not.toContain(canary);
		expect(text.match(/sk-or-fake/g)?.length).toBe(1);
		expect(readLaneFile(dir)?.cwd).toBe("/work/sk-or-fake");
	});
});

describe("liveLanes", () => {
	test("keeps only live lanes; dead pid, missing and corrupt lane.json are not live", () => {
		const root = tmp();
		const lane = (name: string): string => {
			const dir = join(root, name);
			mkdirSync(dir, { recursive: true });
			return dir;
		};
		const live = lane("live");
		const dead = lane("dead");
		const missing = lane("missing");
		const corrupt = lane("corrupt");
		writeLaneFile(live, record({ laneId: "live", pid: 100 }));
		writeLaneFile(dead, record({ laneId: "dead", pid: 200 }));
		writeFileSync(join(corrupt, "lane.json"), "{ truncated");
		const alive = (pid: number): boolean => pid === 100;
		const result = liveLanes(
			[live, dead, missing, corrupt, join(root, "absent")].map((stateDir) => ({ stateDir })),
			alive,
		);
		expect(result.map((r) => r.laneId)).toEqual(["live"]);
	});

	test("an empty lane list has no live lanes", () => {
		expect(liveLanes([], () => true)).toEqual([]);
	});
});

describe("findDuplicate", () => {
	const live = [record({ laneId: "a" }), record({ laneId: "b", cwd: "/other", briefDigest: "ff" })];

	test("matches the same cwd and digest", () => {
		expect(findDuplicate("/work/repo", briefDigest("build x"), live)?.laneId).toBe("a");
		expect(findDuplicate("/other", "ff", live)?.laneId).toBe("b");
	});

	test("rejects a different cwd", () => {
		expect(findDuplicate("/elsewhere", briefDigest("build x"), live)).toBeUndefined();
	});

	test("rejects a different digest", () => {
		expect(findDuplicate("/work/repo", briefDigest("build y"), live)).toBeUndefined();
	});

	test("finds nothing among no live lanes", () => {
		expect(findDuplicate("/work/repo", briefDigest("build x"), [])).toBeUndefined();
	});
});

/** A `/proc/<pid>/stat` line whose field 22 (start, in clock ticks since boot) is `startTicks`. */
function procStat(pid: number, startTicks: number, comm = "python3"): string {
	return `${pid} (${comm}) S ${new Array(18).fill("0").join(" ")} ${startTicks} 0 0\n`;
}

describe("parseStatStartTicks", () => {
	test("reads field 22 even when the command name holds spaces and parentheses", () => {
		expect(parseStatStartTicks(procStat(9, 123456))).toBe(123456);
		expect(parseStatStartTicks(procStat(9, 777, "evil) S 1 (x"))).toBe(777);
	});

	test("a line that is not a stat line has no start", () => {
		expect(parseStatStartTicks("")).toBeUndefined();
		expect(parseStatStartTicks("no parenthesis here")).toBeUndefined();
		expect(parseStatStartTicks("1 (a) S 0 0")).toBeUndefined();
		expect(parseStatStartTicks(procStat(9, 5).replace(" 5 ", " x5 "))).toBeUndefined();
	});
});

describe("verifyLaneProcess", () => {
	const RUNNER = "python3\0/swarm/hooks/autonomous_run.py\0--runtime\0omp";
	const startedAt = "2026-10-28T10:00:00.000Z";
	const BOOT_SEC = Date.parse(startedAt) / 1000 - 5_000;
	/** The ticks (100 Hz) after boot at which a process started `offsetMs` after the lane's recorded start. */
	const ticksAt = (offsetMs: number): number =>
		Math.round(((5_000 * 1000 + offsetMs) / 1000) * 100);
	const linux = (
		cmdline: string | undefined,
		stat: string | undefined,
		boot: number | undefined,
	) => ({
		platform: "linux",
		readCmdline: () => cmdline,
		readStat: () => stat,
		readBootTimeSec: () => boot,
	});

	test("linux: match only when the cmdline names autonomous_run.py and the start time agrees", () => {
		const rec = record({ pid: 77, startedAt });
		const asked: number[] = [];
		const opts = {
			platform: "linux",
			readCmdline: (pid: number) => {
				asked.push(pid);
				return RUNNER;
			},
			readStat: (pid: number) => procStat(pid, ticksAt(0)),
			readBootTimeSec: () => BOOT_SEC,
		};
		expect(verifyLaneProcess(rec, opts)).toBe("match");
		expect(asked).toEqual([77]);
	});

	test("linux: a readable cmdline without the runner marker is a mismatch, never unknown", () => {
		const rec = record({ startedAt });
		const verdict = verifyLaneProcess(
			rec,
			linux("python3\0/other/script.py", procStat(rec.pid, ticksAt(0)), BOOT_SEC),
		);
		expect(verdict).toBe("mismatch");
	});

	test("linux: an unreadable cmdline, stat or boot time, or a bad startedAt, is unknown (not a mismatch)", () => {
		const rec = record({ startedAt });
		const stat = procStat(rec.pid, ticksAt(0));
		expect(verifyLaneProcess(rec, linux(undefined, stat, BOOT_SEC))).toBe("unknown");
		expect(verifyLaneProcess(rec, linux(RUNNER, undefined, BOOT_SEC))).toBe("unknown");
		expect(verifyLaneProcess(rec, linux(RUNNER, "garbled", BOOT_SEC))).toBe("unknown");
		expect(verifyLaneProcess(rec, linux(RUNNER, stat, undefined))).toBe("unknown");
		expect(verifyLaneProcess(rec, linux(RUNNER, stat, Number.NaN))).toBe("unknown");
		const stale = { ...rec, startedAt: "not a date" };
		expect(verifyLaneProcess(stale, linux(RUNNER, stat, BOOT_SEC))).toBe("unknown");
	});

	test("linux: a process that started outside the tolerance of the record is a recycled pid", () => {
		const rec = record({ startedAt });
		const at = (offsetMs: number) =>
			verifyLaneProcess(rec, linux(RUNNER, procStat(rec.pid, ticksAt(offsetMs)), BOOT_SEC));
		expect(at(0)).toBe("match");
		expect(at(-START_TIME_TOLERANCE_MS)).toBe("match");
		expect(at(START_TIME_TOLERANCE_MS)).toBe("match");
		expect(at(START_TIME_TOLERANCE_MS + 1_000)).toBe("mismatch");
		expect(at(-(START_TIME_TOLERANCE_MS + 1_000))).toBe("mismatch");
		expect(at(3_600_000)).toBe("mismatch");
	});

	test("linux: never consults signalAlive", () => {
		const rec = record({ startedAt });
		const verdict = verifyLaneProcess(rec, {
			...linux(RUNNER, procStat(rec.pid, ticksAt(0)), BOOT_SEC),
			signalAlive: () => {
				throw new Error("must not be called");
			},
		});
		expect(verdict).toBe("match");
	});

	test("fallback platform: follows the start-time-aware signalAlive, all three answers", () => {
		const rec = record({ pid: 55, startedAt });
		const seen: Array<[number, string]> = [];
		const probe =
			(verdict: LaneVerdict) =>
			(pid: number, at: string): LaneVerdict => {
				seen.push([pid, at]);
				return verdict;
			};
		for (const verdict of ["match", "mismatch", "unknown"] as const) {
			expect(verifyLaneProcess(rec, { platform: "darwin", signalAlive: probe(verdict) })).toBe(
				verdict,
			);
		}
		expect(seen).toEqual([
			[55, startedAt],
			[55, startedAt],
			[55, startedAt],
		]);
	});

	test("fallback platform: a live pid with a start mismatch is a recycled pid", () => {
		const rec = record({ pid: 55, startedAt });
		const pidIsAlive = (pid: number): boolean => pid === 55;
		const liveStart = "2026-10-28T11:30:00.000Z";
		const startAware = (pid: number, at: string): LaneVerdict =>
			pidIsAlive(pid) && at === liveStart ? "match" : "mismatch";
		expect(verifyLaneProcess(rec, { platform: "darwin", signalAlive: startAware })).toBe(
			"mismatch",
		);
		const matching = { ...rec, startedAt: liveStart };
		expect(verifyLaneProcess(matching, { platform: "darwin", signalAlive: startAware })).toBe(
			"match",
		);
	});
});

describe("capRefusal", () => {
	test("names every live lane, the cap and the stop hint", () => {
		const text = capRefusal(
			[record({ laneId: "lane-one", pid: 11 }), record({ laneId: "lane-two", pid: 12 })],
			2,
		);
		expect(text).toContain("lane-one");
		expect(text).toContain("lane-two");
		expect(text).toContain("stop");
		expect(text).toContain("/ultrathink-swarm stop [laneId|all]");
		expect(text).toContain("ULTRATHINK_SWARM_MAX_LANES");
		expect(text).toContain("limit 2");
	});
});
