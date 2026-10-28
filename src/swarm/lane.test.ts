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
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	briefDigest,
	capRefusal,
	findDuplicate,
	LANE_LOCK_BUSY,
	type LaneFileFs,
	type LaneLockResult,
	type LaneRecord,
	laneBriefWithGraphId,
	liveLanes,
	readLaneFile,
	type LaneVerdict,
	parseStatStartTicks,
	processIdentity,
	START_TIME_TOLERANCE_MS,
	verifyLaneProcess,
	withLaneLock,
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

describe("processIdentity", () => {
	test("Linux: the start ticks of /proc/<pid>/stat, even with spaces and parentheses in the process name", () => {
		const reads: number[] = [];
		const readStat = (pid: number): string | undefined => {
			reads.push(pid);
			return procStat(pid, 424242, "my) S 1 (app");
		};
		expect(processIdentity(77, { platform: "linux", readStat })).toBe("proc:424242");
		expect(reads).toEqual([77]);
	});

	test("Linux: an unreadable or malformed stat is an unknown identity and never falls back to ps", () => {
		const runPs = (): string | undefined => {
			throw new Error("ps must not run on Linux");
		};
		expect(
			processIdentity(77, { platform: "linux", readStat: () => undefined, runPs }),
		).toBeUndefined();
		expect(
			processIdentity(77, { platform: "linux", readStat: () => "garbage", runPs }),
		).toBeUndefined();
	});

	test("elsewhere: the trimmed, single-spaced `ps -o lstart=` output", () => {
		const pids: number[] = [];
		const runPs = (pid: number): string | undefined => {
			pids.push(pid);
			return "  Tue Oct  28 10:00:00 2026\n";
		};
		expect(processIdentity(31, { platform: "darwin", runPs })).toBe("ps:Tue Oct 28 10:00:00 2026");
		expect(pids).toEqual([31]);
	});

	test("elsewhere: a failed or empty ps is an unknown identity", () => {
		expect(processIdentity(31, { platform: "darwin", runPs: () => undefined })).toBeUndefined();
		expect(processIdentity(31, { platform: "darwin", runPs: () => "  \n" })).toBeUndefined();
	});

	test("the real default reads this process on Linux", () => {
		if (process.platform !== "linux") return;
		expect(processIdentity(process.pid)).toMatch(/^proc:\d+$/);
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

describe("withLaneLock", () => {
	const lockPath = (stateDir: string): string => join(stateDir, "swarm", ".lane-lock");
	const DEAD_PID = 999_999;
	const LIVE_PID = 4242;
	/** Liveness seam: every pid but DEAD_PID is alive. */
	const isAlive = (pid: number): boolean => pid !== DEAD_PID;

	/** A fake clock (starting at the real time, so lock mtimes compare sanely) whose sleep advances it. */
	function fakeClock() {
		let t = Date.now();
		const sleeps: number[] = [];
		return {
			sleeps,
			now: () => t,
			sleep: (ms: number) => {
				sleeps.push(ms);
				t += ms;
			},
		};
	}

	/** Another holder's lock: the directory, its owner file and an age in ms. */
	function heldBy(stateDir: string, owner: number | string | undefined, ageMs = 0): void {
		mkdirSync(lockPath(stateDir), { recursive: true });
		if (owner !== undefined) writeFileSync(join(lockPath(stateDir), "owner"), String(owner));
		const when = (Date.now() - ageMs) / 1000;
		utimesSync(lockPath(stateDir), when, when);
	}

	test("returns fn's value as held, records this process as owner while it runs, and releases the lock", () => {
		const stateDir = tmp();
		let owner = "";
		const result = withLaneLock(
			stateDir,
			() => {
				owner = readFileSync(join(lockPath(stateDir), "owner"), "utf8");
				return 7;
			},
			{ identityOf: (pid) => `proc:${pid}:start` },
		);
		expect(result).toEqual({ held: true, value: 7 });
		expect(owner).toBe(`${process.pid} proc:${process.pid}:start`);
		expect(existsSync(lockPath(stateDir))).toBe(false);
	});

	test("a throwing fn propagates and the lock is still released", () => {
		const stateDir = tmp();
		expect(() =>
			withLaneLock(stateDir, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(lockPath(stateDir))).toBe(false);
	});

	test("a lock held by another live process is awaited, then taken once it is released", () => {
		const stateDir = tmp();
		heldBy(stateDir, LIVE_PID);
		const clock = fakeClock();
		let sawLock = false;
		const result = withLaneLock(
			stateDir,
			() => {
				sawLock =
					readFileSync(join(lockPath(stateDir), "owner"), "utf8") === `${process.pid} proc:1`;
				return "ok";
			},
			{
				now: clock.now,
				isAlive,
				identityOf: () => "proc:1",
				sleep: (ms) => {
					clock.sleep(ms);
					// The other process finishes during its third wait.
					if (clock.sleeps.length === 3) rmSync(lockPath(stateDir), { recursive: true });
				},
			},
		);
		expect(clock.sleeps).toHaveLength(3);
		expect(result).toEqual({ held: true, value: "ok" });
		expect(sawLock).toBe(true);
		expect(existsSync(lockPath(stateDir))).toBe(false);
	});

	/** A takeover mutex another waiter holds: `<lock>.takeover` and its age in ms. */
	function takeoverHeld(stateDir: string, ageMs = 0): string {
		const path = `${lockPath(stateDir)}.takeover`;
		mkdirSync(path, { recursive: true });
		const when = (Date.now() - ageMs) / 1000;
		utimesSync(path, when, when);
		return path;
	}

	test("a lock that stays busy fails closed: fn never runs, the reason names the holder and its lock, and the lock is untouched", () => {
		const stateDir = tmp();
		heldBy(stateDir, LIVE_PID);
		const clock = fakeClock();
		let ran = 0;
		const result = withLaneLock(stateDir, () => ++ran, {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			waitMs: 100,
		});
		expect(result).toEqual({
			held: false,
			reason: `${LANE_LOCK_BUSY} (held by process ${LIVE_PID}; if that process is gone, remove ${lockPath(stateDir)})`,
		});
		expect(ran).toBe(0);
		expect(clock.sleeps.length).toBeGreaterThan(0);
		expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(110);
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(String(LIVE_PID));
	});

	test("the busy reason is the documented one-line refusal", () => {
		expect(LANE_LOCK_BUSY).toBe(
			"another ultrathink process is starting lanes (lane lock busy); try again in a moment",
		);
	});

	test("a lock whose owner pid is dead belongs to a crashed holder: taken over at once, without waiting", () => {
		const stateDir = tmp();
		heldBy(stateDir, DEAD_PID);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
		});
		expect(result).toEqual({ held: true, value: true });
		expect(ran).toBe(true);
		expect(clock.sleeps).toEqual([]);
		// the lock is released and neither a tombstone nor the takeover mutex is left behind
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([]);
	});

	test("a live owner is never taken over, however old its lock is", () => {
		const stateDir = tmp();
		heldBy(stateDir, LIVE_PID, 10 * 365 * 24 * 3_600_000);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			waitMs: 50,
		});
		expect(result.held).toBe(false);
		if (result.held) return;
		expect(result.reason.startsWith(LANE_LOCK_BUSY)).toBe(true);
		expect(result.reason).toContain(`held by process ${LIVE_PID}`);
		expect(ran).toBe(false);
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(String(LIVE_PID));
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([".lane-lock"]);
	});

	test("an owner whose pid is alive but whose start time changed is a recycled pid: recovered at once, fn runs", () => {
		const stateDir = tmp();
		heldBy(stateDir, `${LIVE_PID} proc:100`);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			identityOf: (pid) => (pid === LIVE_PID ? "proc:999" : "proc:1"),
		});
		expect(result).toEqual({ held: true, value: true });
		expect(ran).toBe(true);
		expect(clock.sleeps).toEqual([]);
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([]);
	});

	test("an owner with the same start time is the original holder: busy, never taken over", () => {
		const stateDir = tmp();
		heldBy(stateDir, `${LIVE_PID} proc:100`, 10 * 365 * 24 * 3_600_000);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			identityOf: () => "proc:100",
			waitMs: 50,
		});
		expect(result.held).toBe(false);
		if (result.held) return;
		expect(result.reason).toContain(`held by process ${LIVE_PID}`);
		expect(ran).toBe(false);
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(`${LIVE_PID} proc:100`);
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([".lane-lock"]);
	});

	test("an owner whose current start time cannot be read stays busy rather than risk two holders", () => {
		const stateDir = tmp();
		heldBy(stateDir, `${LIVE_PID} proc:100`);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			identityOf: () => undefined,
			waitMs: 50,
		});
		expect(result.held).toBe(false);
		expect(ran).toBe(false);
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(`${LIVE_PID} proc:100`);
	});

	test("an owner that recorded no start time (`-`) stays busy while its pid is alive", () => {
		const stateDir = tmp();
		heldBy(stateDir, `${LIVE_PID} -`);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			identityOf: () => "proc:7",
			waitMs: 50,
		});
		expect(result.held).toBe(false);
		expect(ran).toBe(false);
	});

	test("an old-format owner file (pid only) is judged by liveness alone, whatever the current start time", () => {
		const live = tmp();
		heldBy(live, LIVE_PID);
		const clock = fakeClock();
		let ranLive = false;
		const refused = withLaneLock(live, () => (ranLive = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			identityOf: () => "proc:7",
			waitMs: 50,
		});
		expect(refused.held).toBe(false);
		expect(ranLive).toBe(false);

		const dead = tmp();
		heldBy(dead, DEAD_PID);
		expect(withLaneLock(dead, () => 1, { isAlive, identityOf: () => "proc:7" })).toEqual({
			held: true,
			value: 1,
		});
	});

	test("an ownerless lock is busy while younger than 2 s and recovered once older", () => {
		const young = tmp();
		heldBy(young, undefined, 1_000);
		const clock = fakeClock();
		let ranYoung = false;
		const refused = withLaneLock(young, () => (ranYoung = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			waitMs: 30,
		});
		expect(refused).toEqual({ held: false, reason: LANE_LOCK_BUSY });
		expect(ranYoung).toBe(false);
		expect(existsSync(lockPath(young))).toBe(true);

		const old = tmp();
		heldBy(old, undefined, 3_000);
		const oldClock = fakeClock();
		expect(
			withLaneLock(old, () => 1, { now: oldClock.now, sleep: oldClock.sleep, isAlive }),
		).toEqual({ held: true, value: 1 });
		expect(oldClock.sleeps).toEqual([]);
		expect(readdirSync(join(old, "swarm"))).toEqual([]);
	});

	test("the ownerless age is a seam", () => {
		const stateDir = tmp();
		heldBy(stateDir, undefined, 1_000);
		const clock = fakeClock();
		expect(
			withLaneLock(stateDir, () => 1, {
				now: clock.now,
				sleep: clock.sleep,
				isAlive,
				ownerlessMs: 500,
			}),
		).toEqual({ held: true, value: 1 });
	});

	test("a second waiter that reads the owner after the first created a fresh lock does not remove it", () => {
		const stateDir = tmp();
		heldBy(stateDir, DEAD_PID);
		const clock = fakeClock();
		const renames: string[] = [];
		let swapped = false;
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			waitMs: 30,
			isAlive: (pid) => {
				if (pid === DEAD_PID && !swapped) {
					swapped = true;
					// The first waiter wins the recovery before this one acts on what it just saw, and holds a fresh lock.
					rmSync(lockPath(stateDir), { recursive: true, force: true });
					heldBy(stateDir, LIVE_PID);
					return false;
				}
				return isAlive(pid);
			},
			fs: {
				renameSync: (from, to) => {
					renames.push(from);
					renameSync(from, to);
				},
			},
		});
		expect(renames).toEqual([]);
		expect(ran).toBe(false);
		expect(result.held).toBe(false);
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(String(LIVE_PID));
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([".lane-lock"]);
	});

	test("two waiters on one dead lock: exactly one recovers it, and the other never runs while it holds the lock", () => {
		const stateDir = tmp();
		heldBy(stateDir, DEAD_PID);
		const removals: string[] = [];
		const fsSeam = {
			renameSync: (from: string, to: string) => {
				removals.push(from);
				renameSync(from, to);
			},
		};
		let inside = 0;
		let maxInside = 0;
		let secondRan = false;
		const seen: { second?: LaneLockResult<boolean> } = {};
		const first = withLaneLock(
			stateDir,
			() => {
				inside++;
				maxInside = Math.max(maxInside, inside);
				// The second waiter arrives while the first holds the recovered lock.
				const clock = fakeClock();
				seen.second = withLaneLock(
					stateDir,
					() => {
						inside++;
						maxInside = Math.max(maxInside, inside);
						secondRan = true;
						inside--;
						return true;
					},
					{ now: clock.now, sleep: clock.sleep, isAlive, waitMs: 30, fs: fsSeam },
				);
				inside--;
				return true;
			},
			{ isAlive, fs: fsSeam },
		);
		expect(first).toEqual({ held: true, value: true });
		expect(seen.second?.held).toBe(false);
		expect(secondRan).toBe(false);
		expect(maxInside).toBe(1);
		expect(removals).toHaveLength(1);
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([]);
	});

	test("a takeover mutex held by a live recoverer makes the other waiter wait, and the dead lock is left alone", () => {
		const stateDir = tmp();
		heldBy(stateDir, DEAD_PID);
		const mutex = takeoverHeld(stateDir, 1_000);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
			waitMs: 50,
		});
		expect(result.held).toBe(false);
		if (result.held) return;
		expect(result.reason.startsWith(LANE_LOCK_BUSY)).toBe(true);
		expect(ran).toBe(false);
		expect(clock.sleeps.length).toBeGreaterThan(0);
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(String(DEAD_PID));
		expect(existsSync(mutex)).toBe(true);
	});

	test("a takeover mutex older than 5 s belongs to a crashed recoverer: it is cleared and recovery proceeds", () => {
		const stateDir = tmp();
		heldBy(stateDir, DEAD_PID);
		takeoverHeld(stateDir, 6_000);
		const clock = fakeClock();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			now: clock.now,
			sleep: clock.sleep,
			isAlive,
		});
		expect(result).toEqual({ held: true, value: true });
		expect(ran).toBe(true);
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([]);
	});

	test("a state directory that cannot be created fails closed with the error code and no path", () => {
		const stateDir = tmp();
		writeFileSync(join(stateDir, "swarm"), "not a directory");
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true));
		expect(ran).toBe(false);
		expect(result.held).toBe(false);
		if (result.held) return;
		expect(result.reason).toMatch(/^cannot take the lane lock \([A-Z]+\)$/);
		expect(result.reason).not.toContain(stateDir);
	});

	test("a lock directory that cannot be created for a reason other than EEXIST fails closed with that code", () => {
		const stateDir = tmp();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			fs: {
				mkdirSync: (path, options) => {
					if (path.endsWith(".lane-lock"))
						throw Object.assign(new Error(`denied ${path}`), { code: "EACCES" });
					mkdirSync(path, options);
				},
			},
		});
		expect(result).toEqual({ held: false, reason: "cannot take the lane lock (EACCES)" });
		expect(ran).toBe(false);
	});

	test("a takeover that fails for a reason other than ENOENT fails closed instead of looping, and frees the mutex", () => {
		const stateDir = tmp();
		heldBy(stateDir, DEAD_PID);
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			isAlive,
			fs: {
				renameSync: () => {
					throw Object.assign(new Error("denied"), { code: "EPERM" });
				},
			},
		});
		expect(result).toEqual({ held: false, reason: "cannot take the lane lock (EPERM)" });
		expect(ran).toBe(false);
		expect(readdirSync(join(stateDir, "swarm"))).toEqual([".lane-lock"]);
	});

	test("a failed owner write fails closed and removes the unstamped lock: a lock without an owner would be recoverable from a live holder", () => {
		const stateDir = tmp();
		let ran = false;
		const result = withLaneLock(stateDir, () => (ran = true), {
			fs: {
				writeFileSync: () => {
					throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
				},
			},
		});
		expect(result).toEqual({ held: false, reason: "cannot take the lane lock (ENOSPC)" });
		expect(ran).toBe(false);
		expect(existsSync(lockPath(stateDir))).toBe(false);
	});

	test("release leaves a lock whose owner names another process alone", () => {
		const stateDir = tmp();
		const result = withLaneLock(stateDir, () => {
			// Another process now holds the lock directory at the same path.
			rmSync(lockPath(stateDir), { recursive: true, force: true });
			heldBy(stateDir, LIVE_PID);
			return "ran";
		});
		expect(result).toEqual({ held: true, value: "ran" });
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(String(LIVE_PID));
	});

	test("release leaves a lock whose owner names this pid but a different start time (a successor in a recycled pid)", () => {
		const stateDir = tmp();
		const result = withLaneLock(
			stateDir,
			() => {
				rmSync(lockPath(stateDir), { recursive: true, force: true });
				heldBy(stateDir, `${process.pid} proc:successor`);
				return "ran";
			},
			{ identityOf: () => "proc:original" },
		);
		expect(result).toEqual({ held: true, value: "ran" });
		expect(readFileSync(join(lockPath(stateDir), "owner"), "utf8")).toBe(
			`${process.pid} proc:successor`,
		);
	});

	test("release leaves a lock without a readable owner alone", () => {
		const stateDir = tmp();
		withLaneLock(stateDir, () => {
			rmSync(join(lockPath(stateDir), "owner"));
			return 1;
		});
		expect(existsSync(lockPath(stateDir))).toBe(true);
	});

	test("a refused call never releases the lock it did not take", () => {
		const stateDir = tmp();
		heldBy(stateDir, LIVE_PID);
		const clock = fakeClock();
		withLaneLock(stateDir, () => 1, { now: clock.now, sleep: clock.sleep, isAlive, waitMs: 20 });
		expect(existsSync(lockPath(stateDir))).toBe(true);
	});
});
