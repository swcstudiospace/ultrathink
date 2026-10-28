// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Covers /ultrathink-swarm's core: parsing, lane planning (ids, hashing, parent-env merging, per-invocation
// nonced state dirs, pstack block), detached spawning through an injected spawner, discovery bounded by
// mtime, and tolerant per-lane status aggregation through an async injected probe with bounded concurrency.
// No test spawns a real process, no real wall-clock timers, and real fs touches only tmpdirs.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ClassifyVerdict } from "./classify.ts";
import {
	briefDigest,
	type LaneRecord,
	type LaneVerdict,
	type PidAlive,
	readLaneFile,
	verifyLaneProcess,
	writeLaneFile,
} from "./lane.ts";
import {
	CLASSIFIER_UNAVAILABLE_NOTE,
	filterSpawnable,
	type LaneHandle,
	type LanePlan,
	type LaneRef,
	type LaneState,
	formatLaneHandles,
	formatLaneStatusText,
	isSdlcPrompt,
	allLaneDirs,
	laneDirs,
	laneStatus,
	type LaneStatusRow,
	type LaneVerify,
	liveLaneSnapshot,
	maxLanes,
	LANE_STATUS_CONCURRENCY,
	MAX_DISCOVERED_LANES,
	ORCH_STATUS_TIMEOUT_MS,
	orchStatusRunner,
	parseEtimeSeconds,
	parseLaneArgs,
	parseStopArgs,
	pidAlive,
	planLanes,
	type PlanLanesOptions,
	refuseDuplicatesAndOverCap as decideLaneSpawn,
	resolveStopTargets,
	resolveSwarmRoot,
	swarmRootMessage,
	signalAliveMatchingStart,
	SKIP_REFUSAL,
	spawnGuarded,
	spawnLanes,
	STOP_GRACE_DEFAULT_MS,
	STOP_POLL_MS,
	stopGraceMs,
	stopLanes,
	swarmClassifier,
	type TeamsFs,
	TEAMS_MAX_LANES,
	TEAMS_USAGE,
	toSwarmSpawnCard,
	toSwarmStatusCard,
} from "./teams.ts";

const sha8 = (brief: string): string =>
	createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 8);

/** A fs seam over real syscalls; tests only ever point it at tmpdir paths. */
const realFs: TeamsFs = {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readdirSync,
	statSync,
	readFileSync,
	renameSync,
	writeFileSync,
};

/** The guard as the tests below use it: snapshot the live lanes of `stateDir`, then decide (what spawnGuarded does under the lane lock). */
function refuseDuplicatesAndOverCap(
	plans: readonly LanePlan[],
	stateDir: string,
	cwd: string,
	cap: number,
	isAlive: PidAlive,
	verify?: LaneVerify,
	fs?: TeamsFs,
): { spawn: LanePlan[]; refused: Array<{ laneId: string; reason: string }> } {
	return decideLaneSpawn(plans, cwd, cap, liveLaneSnapshot(stateDir, isAlive, verify, fs));
}

const tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tmpdir removed after the test. */
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

/** A lane state dir with exactly the files given; the lane's own `lane.json` pid defaults to 111. */
function fixtureLane(
	root: string,
	name: string,
	files: {
		correlation?: string;
		log?: string;
		record?: Partial<LaneRecord>;
		rawLaneJson?: string;
	} = {},
): LaneRef {
	const stateDir = join(root, name);
	mkdirSync(stateDir, { recursive: true });
	if (files.correlation !== undefined)
		writeFileSync(join(stateDir, "latest_correlation"), files.correlation);
	if (files.log !== undefined) writeFileSync(join(stateDir, "autonomous.log"), files.log);
	if (files.record !== undefined) {
		writeLaneFile(stateDir, {
			laneId: name,
			pid: 111,
			briefDigest: briefDigest("some brief"),
			cwd: "/repo",
			startedAt: "2026-10-28T00:00:00.000Z",
			...files.record,
		});
	}
	if (files.rawLaneJson !== undefined)
		writeFileSync(join(stateDir, "lane.json"), files.rawLaneJson);
	return { laneId: name, stateDir };
}

/** Pid 111 is the one live lane; pid 222 is a dead one. Every live pid passes the recycled-pid gate. */
const PROBE_DEPS = { isAlive: (pid: number) => pid === 111, verify: (): LaneVerdict => "match" };

/** `fixtureLane`'s default `startedAt`; the injected /proc readers below start every process exactly then. */
const LANE_STARTED_AT = "2026-10-28T00:00:00.000Z";

/** An arbitrary boot time 5000 s before the lane's start, in whole seconds like `/proc/stat` `btime`. */
const BOOT_SEC = Date.parse(LANE_STARTED_AT) / 1000 - 5_000;

const RUNNER_CMDLINE =
	"python3\u0000/opt/agent-swarm/hooks/autonomous_run.py\u0000--runtime\u0000omp";

/** A `/proc/<pid>/stat` line for a process that started `offsetMs` after the lane's recorded start. */
function procStat(pid: number, offsetMs = 0): string {
	const ticks = Math.round((5_000_000 + offsetMs) / 10);
	return `${pid} (python3) S ${new Array(18).fill("0").join(" ")} ${ticks} 0 0\n`;
}

const failIfProbed = async (): Promise<{ stdout: string }> => {
	throw new Error("the Task Store probe must not run for this lane");
};

/** An `orch_status.py --json` reply. */
const orchReply = (body: Record<string, unknown>) => async (): Promise<{ stdout: string }> => ({
	stdout: JSON.stringify({ status: "ok", ...body }),
});

function okRow(row: LaneStatusRow | undefined) {
	if (!row || "error" in row) throw new Error(`expected a status row, got ${JSON.stringify(row)}`);
	return row;
}

const baseOpts = (stateDir: string, env: NodeJS.ProcessEnv = {}): PlanLanesOptions => ({
	cwd: "/repo",
	stateDir,
	swarmRoot: "/opt/agent-swarm",
	env,
});

/** Spawner that records every start request; optionally fails one lane (the one whose dir is `…-2-<nonce>`). */
function recordingSpawner(failLane2: boolean) {
	const calls: Array<{
		cmd: string;
		args: readonly string[];
		env: Record<string, string>;
		detached: boolean;
		stdio: readonly unknown[];
		cwd: string;
	}> = [];
	const fn = (
		cmd: string,
		args: readonly string[],
		opts: {
			cwd: string;
			env: Record<string, string>;
			detached: true;
			stdio: readonly ["ignore", number, number];
		},
	) => {
		calls.push({
			cmd,
			args,
			env: opts.env,
			detached: opts.detached,
			stdio: opts.stdio,
			cwd: opts.cwd,
		});
		if (failLane2 && /-2-[0-9a-z]+$/.test(opts.env.SWARM_DIR ?? "")) throw new Error("boom");
		return { pid: 1000 + calls.length };
	};
	return { calls, fn };
}

describe("resolveSwarmRoot", () => {
	const makeRoot = (): string => {
		const root = tmp("teams-root-");
		mkdirSync(join(root, "hooks"), { recursive: true });
		writeFileSync(join(root, "hooks", "autonomous_run.py"), "# runner\n");
		return root;
	};

	test("refuses a missing, relative, or incomplete root with a reason", () => {
		expect(resolveSwarmRoot({})).toHaveProperty("reason");
		const relative = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: "relative/path" });
		if (!("reason" in relative)) throw new Error("expected a refusal");
		expect(relative.reason).toContain("absolute");
		const bare = tmp("teams-bare-");
		const incomplete = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: bare });
		if (!("reason" in incomplete)) throw new Error("expected a refusal");
		expect(incomplete.reason).toContain("autonomous_run.py");
	});

	test("a value that is not an absolute path is held back in `got`, never in the reason", () => {
		const canary = "sk-or-v1-CANARYCANARYCANARY1234";
		const relative = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: canary });
		expect(relative).toEqual({
			reason: "ULTRATHINK_SWARM_ROOT must be an absolute path",
			got: canary,
		});
		if (!("reason" in relative)) throw new Error("expected a refusal");
		expect(relative.reason).not.toContain("CANARY");
		// Only the spawn reply to the user who typed it appends the value, byte-identical to the old text.
		expect(swarmRootMessage(relative)).toBe(
			`ULTRATHINK_SWARM_ROOT must be an absolute path, got ${canary}`,
		);
		// Failures that never carry a raw value have no `got` at all.
		const unset = resolveSwarmRoot({});
		expect(unset).not.toHaveProperty("got");
		const missing = resolveSwarmRoot({ SWARM_ROOT: "/nonexistent/agent-swarm-checkout" }, realFs);
		expect(missing).not.toHaveProperty("got");
		if (!("reason" in unset)) throw new Error("expected a refusal");
		expect(swarmRootMessage(unset)).toBe(unset.reason);
	});

	test("accepts a checkout containing hooks/autonomous_run.py", () => {
		const root = makeRoot();
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: root }, realFs)).toEqual({ root });
	});

	// D-12 (fails on the old resolver, which never read SWARM_ROOT).
	test("SWARM_ROOT is used only when ULTRATHINK_SWARM_ROOT is unset or empty", () => {
		const root = makeRoot();
		expect(resolveSwarmRoot({ SWARM_ROOT: root }, realFs)).toEqual({ root });
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: "", SWARM_ROOT: root }, realFs)).toEqual({
			root,
		});
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: "   ", SWARM_ROOT: root }, realFs)).toEqual({
			root,
		});
	});

	test("a non-empty ULTRATHINK_SWARM_ROOT always wins, even over a valid SWARM_ROOT", () => {
		const good = makeRoot();
		const bare = tmp("teams-bare-");
		const result = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: bare, SWARM_ROOT: good }, realFs);
		if (!("reason" in result)) throw new Error("the invalid primary root must not fall back");
		expect(result.reason).toContain(bare);
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: good, SWARM_ROOT: bare }, realFs)).toEqual({
			root: good,
		});
	});

	test("the unset reason names both variables; failures name the effective root", () => {
		const unset = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: " ", SWARM_ROOT: "" });
		if (!("reason" in unset)) throw new Error("expected a refusal");
		expect(unset.reason).toContain("ULTRATHINK_SWARM_ROOT");
		expect(unset.reason).toContain("SWARM_ROOT");
		const relative = resolveSwarmRoot({ SWARM_ROOT: "rel/checkout" });
		if (!("reason" in relative)) throw new Error("expected a refusal");
		expect(swarmRootMessage(relative)).toBe(
			"SWARM_ROOT must be an absolute path, got rel/checkout",
		);
		const missing = resolveSwarmRoot({ SWARM_ROOT: "/nonexistent/agent-swarm-checkout" }, realFs);
		if (!("reason" in missing)) throw new Error("expected a refusal");
		expect(missing.reason).toContain("/nonexistent/agent-swarm-checkout");
	});
});

describe("parseLaneArgs", () => {
	test("status subcommand", () => {
		expect(parseLaneArgs("status")).toEqual({ kind: "status" });
		expect(parseLaneArgs("  status  ")).toEqual({ kind: "status" });
	});

	test("empty input is a usage with a reason", () => {
		expect(parseLaneArgs("   ")).toEqual({
			kind: "usage",
			reason: expect.stringContaining("no lane briefs"),
		});
	});

	test("splits briefs on |, trims each, drops empties", () => {
		expect(parseLaneArgs("fix the parser |  add tests  | |  ")).toEqual({
			kind: "spawn",
			briefs: ["fix the parser", "add tests"],
		});
	});

	test("more briefs than the lane limit is a usage, never a partial spawn", () => {
		const seven = "a|b|c|d|e|f|g";
		expect(parseLaneArgs(seven).kind).toBe("usage");
		// The default limit is 3; raising it admits more, but never past the hard cap.
		expect(parseLaneArgs("a|b|c|d").kind).toBe("usage");
		expect(parseLaneArgs("a|b|c|d", { maxLanes: 4 })).toEqual({
			kind: "spawn",
			briefs: ["a", "b", "c", "d"],
		});
		expect(parseLaneArgs("a|b|c|d|e|f", { maxLanes: TEAMS_MAX_LANES }).kind).toBe("spawn");
		expect(parseLaneArgs(seven, { maxLanes: TEAMS_MAX_LANES }).kind).toBe("usage");
	});

	test("maxLanes reads ULTRATHINK_SWARM_MAX_LANES, defaults to 3, clamps to 1..6", () => {
		expect(maxLanes({})).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "5" })).toBe(5);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "0" })).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "junk" })).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "99" })).toBe(TEAMS_MAX_LANES);
	});

	test("stop, stop <laneId> and stop all parse to a stop with its target", () => {
		expect(parseLaneArgs("stop")).toEqual({ kind: "stop", target: "all" });
		expect(parseLaneArgs("stop all")).toEqual({ kind: "stop", target: "all" });
		expect(parseLaneArgs("  stop   abcd1234-1-m9x ")).toEqual({
			kind: "stop",
			target: "abcd1234-1-m9x",
		});
		expect(parseStopArgs("stop lane-2")).toEqual({ kind: "stop", target: "lane-2" });
	});

	test("a multi-word brief that begins with the word stop is still a spawn", () => {
		expect(parseLaneArgs("stop the flaky test from timing out | add a retry")).toEqual({
			kind: "spawn",
			briefs: ["stop the flaky test from timing out", "add a retry"],
		});
		expect(parseStopArgs("stop a b").kind).toBe("usage");
		expect(parseStopArgs("status").kind).toBe("usage");
	});

	test("maxLanes clamps to 1..6 and treats absent, 0 and negative as the default 3", () => {
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "1" })).toBe(1);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "-4" })).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "6" })).toBe(6);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "7" })).toBe(6);
	});
});

describe("planLanes", () => {
	const dirName = (stateDir: string): string => basename(stateDir);

	test("plans 1-based ids and per-brief hashed, nonced state directories", () => {
		const plan = planLanes(["first brief", "second brief"], baseOpts("/state/host"));
		expect(plan.map((lane) => lane.id)).toEqual(["lane-1", "lane-2"]);
		// Directory shape: <sha8(brief)>-<i>-<nonce>.
		expect(dirName(plan[0]!.stateDir)).toMatch(new RegExp(`^${sha8("first brief")}-1-[0-9a-z]+$`));
		expect(dirName(plan[1]!.stateDir)).toMatch(new RegExp(`^${sha8("second brief")}-2-[0-9a-z]+$`));
		// Hashing is stable per brief and distinct across briefs.
		expect(dirName(plan[0]!.stateDir).startsWith(sha8("first brief"))).toBe(true);
		expect(plan[0]!.stateDir).not.toBe(plan[1]!.stateDir);
		// One nonce per invocation: lanes of the same run share it, so repeated briefs stay distinct by index.
		expect(dirName(plan[0]!.stateDir).split("-")[2]).toBe(dirName(plan[1]!.stateDir).split("-")[2]);
		const [dupA, dupB] = planLanes(["same brief", "same brief"], baseOpts("/state/host"));
		expect(dupA!.stateDir).not.toBe(dupB!.stateDir);
	});

	test("repeated invocations never share a state directory", () => {
		const first = planLanes(["same brief"], baseOpts("/state/host"))[0]!;
		const second = planLanes(["same brief"], baseOpts("/state/host"))[0]!;
		expect(first.stateDir).not.toBe(second.stateDir);
	});

	test("the nonce carries the injected clock", () => {
		const [lane] = planLanes(["same brief"], { ...baseOpts("/state/host"), now: () => 12345 });
		const stamp = (12345).toString(36);
		expect(dirName(lane!.stateDir)).toMatch(
			new RegExp(`^${sha8("same brief")}-1-${stamp}[0-9a-f]{4}$`),
		);
	});

	test("lane env merges the parent environment; lane keys win", () => {
		const parent = {
			PATH: "/usr/bin:/bin",
			HOME: "/root",
			SWARM_DIR: "/parent/dir",
			SWARM_AUTONOMOUS_RUN_CAP_S: "45",
			EMPTY: undefined,
		};
		const [lane] = planLanes(["do it"], baseOpts("/state/host", parent));
		// Parent basics survive into the lane.
		expect(lane!.env.PATH).toBe("/usr/bin:/bin");
		expect(lane!.env.HOME).toBe("/root");
		// The lane's own keys override the parent.
		expect(lane!.env.SWARM_DIR).toBe(lane!.stateDir);
		expect(lane!.env.SWARM_AUTONOMOUS_RUN_CAP_S).toBe("45");
		// Undefined parent values are dropped, never stringified.
		expect("EMPTY" in lane!.env).toBe(false);
	});

	test("without a parent env the lane env is just the lane's own keys", () => {
		const [lane] = planLanes(["do it"], baseOpts("/state/host"));
		expect(lane!.env).toEqual({ SWARM_DIR: lane!.stateDir });
	});

	test("argv is the runner contract", () => {
		const [lane] = planLanes(["do it"], baseOpts("/state/host"));
		expect(lane!.argv).toEqual([
			"python3",
			join("/opt/agent-swarm", "hooks", "autonomous_run.py"),
			"--runtime",
			"omp",
			"--cwd",
			"/repo",
			"--brief",
			"do it",
		]);
		expect(lane!.cwd).toBe("/repo");
	});

	test("passes SWARM_AUTONOMOUS_RUN_CAP_S through when set", () => {
		const [lane] = planLanes(
			["do it"],
			baseOpts("/state/host", { SWARM_AUTONOMOUS_RUN_CAP_S: "1800" }),
		);
		expect(lane!.env.SWARM_AUTONOMOUS_RUN_CAP_S).toBe("1800");
	});

	test("appends a resolved pstack orchestrate block to the brief, drops an unresolved one silently", () => {
		const skillsDir = mkdtempSync(join(tmpdir(), "teams-pstack-"));
		for (const name of ["how", "architect", "arena", "tdd", "interrogate", "no-comments"]) {
			mkdirSync(join(skillsDir, name), { recursive: true });
			writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name}\n`);
		}
		const [withSkills] = planLanes(["build it"], { ...baseOpts("/s"), pstack: { skillsDir } });
		expect(withSkills!.laneBrief).toContain("build it");
		expect(withSkills!.laneBrief).toContain("pstack alongside GSD (orchestrate");
		expect(withSkills!.argv.at(-1)).toBe(withSkills!.laneBrief);
		const [unresolved] = planLanes(["build it"], {
			...baseOpts("/s"),
			pstack: { reason: "no cache" },
		});
		expect(unresolved!.laneBrief).toBe("build it");
		const [noPstack] = planLanes(["build it"], baseOpts("/s"));
		expect(noPstack!.laneBrief).toBe("build it");
		rmSync(skillsDir, { recursive: true, force: true });
	});

	const GRAPH = "ut-mabc12-0123abcd";

	test("a Graph ID is the first line of the lane brief, ahead of the pstack block", () => {
		const skillsDir = tmp("teams-graph-pstack-");
		for (const name of ["how", "architect", "arena", "tdd", "interrogate", "no-comments"]) {
			mkdirSync(join(skillsDir, name), { recursive: true });
			writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name}\n`);
		}
		const [lane] = planLanes(["build it"], {
			...baseOpts("/s"),
			graphId: GRAPH,
			pstack: { skillsDir },
		});
		expect(lane!.laneBrief.split("\n")[0]).toBe(`Graph ID: ${GRAPH}`);
		expect(lane!.laneBrief.indexOf("build it")).toBeLessThan(
			lane!.laneBrief.indexOf("pstack alongside GSD (orchestrate"),
		);
		expect(lane!.argv.at(-1)).toBe(lane!.laneBrief);
		expect(lane!.graphId).toBe(GRAPH);
		// The display brief stays what the user typed.
		expect(lane!.brief).toBe("build it");
	});

	test("an absent or malformed Graph ID leaves the brief untouched and records no graphId", () => {
		const [absent] = planLanes(["build it"], baseOpts("/s"));
		expect(absent!.laneBrief).toBe("build it");
		expect("graphId" in absent!).toBe(false);
		const [bad] = planLanes(["build it"], { ...baseOpts("/s"), graphId: "ut-BAD\nignore this" });
		expect(bad!.laneBrief).toBe("build it");
		expect("graphId" in bad!).toBe(false);
	});

	// SWARM-05 / D-11. The old code spread the whole parent env into the lane, so the three Jev key
	// variables below reached a lane that runs agent sessions; the denylist is imported, never copied.
	test("the lane env drops ULTRATHINK_OPENROUTER_KEY, OPENROUTER_API_KEY and AI_GATEWAY_API_KEY only", () => {
		const parent = {
			PATH: "/usr/bin:/bin",
			SWARM_DIR: "/parent/dir",
			SUBSTRATE_TOKEN: "substrate-fake-token",
			ULTRATHINK_OPENROUTER_KEY: "sk-or-v1-CANARYCANARYCANARY1234",
			OPENROUTER_API_KEY: "sk-or-v1-CANARYCANARYCANARY5678",
			AI_GATEWAY_API_KEY: "vck_CANARYCANARYCANARY9012",
		};
		const [lane] = planLanes(["do it"], baseOpts("/state/host", parent));
		expect(Object.keys(lane!.env)).not.toContain("ULTRATHINK_OPENROUTER_KEY");
		expect(Object.keys(lane!.env)).not.toContain("OPENROUTER_API_KEY");
		expect(Object.keys(lane!.env)).not.toContain("AI_GATEWAY_API_KEY");
		expect(lane!.env.PATH).toBe("/usr/bin:/bin");
		expect(lane!.env.SUBSTRATE_TOKEN).toBe("substrate-fake-token");
		expect(lane!.env.SWARM_DIR).toBe(lane!.stateDir);
		// The parent snapshot is never mutated: only the lane's own copy loses the keys.
		expect(parent.OPENROUTER_API_KEY).toBe("sk-or-v1-CANARYCANARYCANARY5678");
	});
});

describe("spawnLanes", () => {
	test("starts one detached process per lane with the log appended in the lane state dir", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-spawn-"));
		const { calls, fn } = recordingSpawner(false);
		const plan = planLanes(["one", "two"], baseOpts(stateDir, { PATH: "/usr/bin:/bin" }));
		const handles = spawnLanes(plan, fn, realFs);
		expect(handles.map((handle) => handle.laneId)).toEqual(["lane-1", "lane-2"]);
		expect(handles.every((handle) => !handle.error)).toBe(true);
		expect(calls.length).toBe(2);
		expect(calls[0]!.cmd).toBe("python3");
		expect(calls[0]!.args[0]).toBe(join("/opt/agent-swarm", "hooks", "autonomous_run.py"));
		// The child env carries the parent basics plus the lane's own SWARM_DIR.
		expect(calls[0]!.env.PATH).toBe("/usr/bin:/bin");
		expect(calls[0]!.env.SWARM_DIR).toBe(plan[0]!.stateDir);
		expect(calls[0]!.detached).toBe(true);
		expect(calls[0]!.cwd).toBe("/repo");
		// stdout/stderr are file descriptors onto the lane's log.
		expect(typeof calls[0]!.stdio[1]).toBe("number");
		expect(handles[0]!.logPath).toBe(join(plan[0]!.stateDir, "run.log"));
		expect(existsSync(handles[0]!.logPath)).toBe(true);
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("one failing lane is an error row for that lane alone; siblings still spawn", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-fail-"));
		const { calls, fn } = recordingSpawner(true);
		const handles = spawnLanes(planLanes(["a", "b", "c"], baseOpts(stateDir)), fn, realFs);
		expect(calls.length).toBe(3);
		expect(handles[1]).toMatchObject({ laneId: "lane-2", error: "boom" });
		expect(handles[0]).toMatchObject({ laneId: "lane-1", pid: 1001 });
		expect(handles[2]!.pid).toBeDefined();
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("a spawner that returns no pid is an error row", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-nopid-"));
		const handles = spawnLanes(planLanes(["only"], baseOpts(stateDir)), () => ({}), realFs);
		expect(handles[0]).toMatchObject({ laneId: "lane-1", error: expect.stringContaining("pid") });
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("the spawner receives an env without the Jev keys", () => {
		const stateDir = tmp("teams-jev-");
		const { calls, fn } = recordingSpawner(false);
		const plan = planLanes(
			["one"],
			baseOpts(stateDir, {
				PATH: "/usr/bin",
				OPENROUTER_API_KEY: "sk-or-v1-CANARYCANARYCANARY1234",
				AI_GATEWAY_API_KEY: "vck_CANARYCANARYCANARY9012",
				ULTRATHINK_OPENROUTER_KEY: "sk-or-v1-CANARYCANARYCANARY5678",
			}),
		);
		spawnLanes(plan, fn, realFs);
		expect(JSON.stringify(calls[0]!.env)).not.toContain("CANARY");
		expect(calls[0]!.env.PATH).toBe("/usr/bin");
	});

	test("a started lane gets lane.json with its identity, graphId, brief digest and pid", () => {
		const stateDir = tmp("teams-lanejson-");
		const { fn } = recordingSpawner(false);
		const plan = planLanes(["Fix  the bug"], {
			...baseOpts(stateDir),
			graphId: "ut-mabc12-0123abcd",
		});
		const handles = spawnLanes(plan, fn, realFs);
		expect(handles[0]!.pid).toBe(1001);
		const record = readLaneFile(plan[0]!.stateDir);
		expect(record).toMatchObject({
			laneId: basename(plan[0]!.stateDir),
			pid: 1001,
			graphId: "ut-mabc12-0123abcd",
			briefDigest: briefDigest("fix the bug"),
			cwd: "/repo",
		});
		expect(Number.isNaN(Date.parse(record!.startedAt))).toBe(false);
	});

	test("a lane that fails to start gets no lane.json", () => {
		const stateDir = tmp("teams-nolanejson-");
		const plan = planLanes(["only"], baseOpts(stateDir));
		spawnLanes(plan, () => ({}), realFs);
		expect(readLaneFile(plan[0]!.stateDir)).toBeUndefined();
	});

	test("a lane.json write failure does not fail the spawn; it becomes a handle note", () => {
		const stateDir = tmp("teams-lanejson-fail-");
		const { fn } = recordingSpawner(false);
		const failingFs: TeamsFs = {
			...realFs,
			writeFileSync: () => {
				throw new Error("disk full");
			},
		};
		const handles = spawnLanes(planLanes(["only"], baseOpts(stateDir)), fn, failingFs);
		expect(handles[0]!.error).toBeUndefined();
		expect(handles[0]!.pid).toBe(1001);
		expect(handles[0]!.note).toContain("disk full");
		expect(formatLaneHandles(handles)).toContain("note lane.json not written");
	});

	test("the lane state dir is created 0700 and run.log 0600, like lane.json", () => {
		const stateDir = tmp("teams-modes-");
		const { fn } = recordingSpawner(false);
		const plan = planLanes(["only"], baseOpts(stateDir));
		const handles = spawnLanes(plan, fn, realFs);
		expect(statSync(plan[0]!.stateDir).mode & 0o777).toBe(0o700);
		expect(statSync(handles[0]!.logPath).mode & 0o777).toBe(0o600);
	});
});

describe("laneStatus", () => {
	test("aggregates task counts from orch_status; DONE tasks alone never make a lane done", async () => {
		const root = tmp("teams-status-");
		const x1 = fixtureLane(root, "x-1", { correlation: "c1" });
		const x2 = fixtureLane(root, "x-2", { correlation: "c2" });
		const probes: Record<string, { stdout: string } | { error: string }> = {
			"x-1": {
				stdout: JSON.stringify({
					tasks: [
						{ id: "T-1", state: "DONE" },
						{ task_id: "T-2", state: "RUNNING" },
						{ id: "T-3", state: "DONE" },
					],
				}),
			},
			"x-2": { error: "timed out" },
		};
		const results = await laneStatus([x1, x2], async (stateDir) => {
			const probe = probes[basename(stateDir)];
			if (!probe) throw new Error("unexpected probe");
			return probe;
		});
		// Old probeLane counted DONE/APPROVED/CANCELLED itself (done: 2); now only `complete` counts.
		expect(results[0]).toMatchObject({
			laneId: "x-1",
			logPath: join(x1.stateDir, "run.log"),
			total: 3,
			done: 0,
			byState: { DONE: 2, RUNNING: 1 },
		});
		expect(okRow(results[0]).summary).toContain("x-1: ");
		expect(okRow(results[0]).summary).toContain("3 tasks");
		expect(results[1]).toEqual({
			laneId: "x-2",
			logPath: join(x2.stateDir, "run.log"),
			error: "timed out",
		});
	});

	test("bad JSON, missing task lists and throwing probes are error rows", async () => {
		const root = tmp("teams-status-bad-");
		const lanes = ["y-1", "y-2", "y-3"].map((name) =>
			fixtureLane(root, name, { correlation: "c" }),
		);
		const probes: Record<string, { stdout: string }> = {
			"y-1": { stdout: "not json {" },
			"y-2": { stdout: JSON.stringify({ nope: true }) },
		};
		const results = await laneStatus(lanes, async (stateDir) => {
			const probe = probes[basename(stateDir)];
			if (!probe) throw new Error("probe exploded");
			return probe;
		});
		expect(results[0]).toEqual({
			laneId: "y-1",
			logPath: join(lanes[0]!.stateDir, "run.log"),
			error: expect.stringContaining("not JSON"),
		});
		expect(results[1]).toEqual({
			laneId: "y-2",
			logPath: join(lanes[1]!.stateDir, "run.log"),
			error: expect.stringContaining("no task list"),
		});
		expect(results[2]).toEqual({
			laneId: "y-3",
			logPath: join(lanes[2]!.stateDir, "run.log"),
			error: "probe exploded",
		});
	});

	test("an empty task store on a live lane is running with nothing to do, not an error", async () => {
		const root = tmp("teams-status-empty-");
		const lane = fixtureLane(root, "z-1", { correlation: "c", record: { pid: 111 } });
		const results = await laneStatus([lane], orchReply({ tasks: [] }), PROBE_DEPS);
		expect(results[0]).toMatchObject({
			laneId: "z-1",
			logPath: join(lane.stateDir, "run.log"),
			state: "running",
			total: 0,
			done: 0,
		});
		expect(okRow(results[0]).summary).toContain("no tasks yet");
	});

	test("probes overlap up to the concurrency cap and rows keep input order", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let started = 0;
		const root = tmp("teams-status-conc-");
		const lanes = Array.from({ length: 8 }, (_, index) =>
			fixtureLane(root, `lane-${index + 1}`, { correlation: "c" }),
		);
		// Each probe parks on its own gate; the test releases them — no real timers anywhere.
		const gates = lanes.map(() => Promise.withResolvers<void>());
		const rows = laneStatus(lanes, async (stateDir) => {
			const gate = gates[Number(stateDir.split("-").pop()) - 1]!;
			started += 1;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await gate.promise;
			inFlight -= 1;
			return { stdout: JSON.stringify({ tasks: [{ id: "T-1", state: "DONE" }] }) };
		});
		// The cap is LANE_STATUS_CONCURRENCY: exactly that many probes can be parked at once. Drain
		// microtasks to let any illegally scheduled extra worker start — started must stay at the cap.
		for (let tick = 0; tick < 25; tick += 1) await Promise.resolve();
		expect(started).toBe(LANE_STATUS_CONCURRENCY);
		for (const gate of gates) gate.resolve();
		expect((await rows).map((row) => row.laneId)).toEqual(lanes.map((entry) => entry.laneId));
		expect(maxInFlight).toBe(LANE_STATUS_CONCURRENCY);
	});

	describe("seven row states from real lane files", () => {
		// Each test names what the pre-change probeLane did instead: it only ran orch_status and counted
		// DONE/APPROVED/CANCELLED itself, so it had no state at all and never read the lane's own files.

		test("planning: a live pid with no correlation yet (old: ran the probe, error row or counts)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "plan-1", { record: { pid: 111 } });
			const [row] = await laneStatus([lane], failIfProbed, PROBE_DEPS);
			expect(okRow(row).state).toBe("planning" satisfies LaneState);
		});

		test("running: a live pid with unfinished tasks (old: no state word, 'done' from DONE_STATES)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "run-1", {
				correlation: "corr-1",
				record: { pid: 111 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ tasks: [], counts: { DONE: 1, RUNNING: 2 }, escalated: [], complete: false }),
				PROBE_DEPS,
			);
			const ok = okRow(row);
			expect(ok.state).toBe("running" satisfies LaneState);
			expect(ok.total).toBe(3);
			expect(ok.done).toBe(0);
			expect(ok.summary).toContain("running");
			expect(ok.summary).toContain("2 RUNNING");
		});

		test("skipped: the plain `skip duplicate <digest>` log (old: probed a Task Store that never exists)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "skip-1", {
				log: "skip duplicate 9f2c41ab77\n",
				record: { pid: 222 },
			});
			const [row] = await laneStatus([lane], failIfProbed, PROBE_DEPS);
			const ok = okRow(row);
			expect(ok.state).toBe("skipped" satisfies LaneState);
			expect(ok.summary).toContain("9f2c41ab77");
		});

		test("plan-failed: skipped_run in the log shows error.code (old: 'no tasks yet' or 'no task list')", async () => {
			const log = JSON.stringify({
				brief: "x",
				skipped_run: true,
				plan_err: "key sk-or-v1-CANARYCANARYCANARY1234 leaked into stderr",
				error: { code: "E_CONTRACT", message: "no kickoff contract" },
			});
			const lane = fixtureLane(tmp("teams-st-"), "pf-1", { log, record: { pid: 222 } });
			const [row] = await laneStatus([lane], failIfProbed, PROBE_DEPS);
			const ok = okRow(row);
			expect(ok.state).toBe("plan-failed" satisfies LaneState);
			expect(ok.summary).toContain("E_CONTRACT");
			expect(ok.detail).toBe("E_CONTRACT");
			// T-91-03-02: only the error code and message render; the log's raw stderr never does.
			expect(formatLaneStatusText([ok])).not.toContain("CANARY");
		});

		test("plan-failed also covers an exception log {error: string}", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "pf-2", {
				log: JSON.stringify({ error: "OSError: disk full" }),
				record: { pid: 222 },
			});
			const [row] = await laneStatus([lane], failIfProbed, PROBE_DEPS);
			expect(okRow(row).state).toBe("plan-failed" satisfies LaneState);
			expect(okRow(row).summary).toContain("OSError: disk full");
		});

		test("done: only orch_status complete:true counts (old: derived from DONE/APPROVED/CANCELLED)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "done-1", {
				correlation: "corr-1",
				log: JSON.stringify({ plan_rc: 0, run_rc: 0 }),
				record: { pid: 222, graphId: "ut-mabc12-0123abcd" },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ tasks: [], counts: { DONE: 2 }, escalated: [], complete: true }),
				PROBE_DEPS,
			);
			const ok = okRow(row);
			expect(ok.state).toBe("done" satisfies LaneState);
			expect(ok.done).toBe(2);
			expect(ok.total).toBe(2);
			expect(ok.graphId).toBe("ut-mabc12-0123abcd");
			expect(formatLaneStatusText([ok])).toContain("graph ut-mabc12-0123abcd");
		});

		test("APPROVED tasks without complete are not done (old DONE_STATES counted them)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "appr-1", {
				correlation: "corr-1",
				record: { pid: 222 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ counts: { APPROVED: 2 }, escalated: [], complete: false }),
				PROBE_DEPS,
			);
			expect(okRow(row).state).not.toBe("done");
			expect(okRow(row).done).toBe(0);
		});

		test("attention: FAILED, ESCALATED or BLOCKED tasks (old: counted as plain counts)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "att-1", {
				correlation: "corr-1",
				record: { pid: 222 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ counts: { DONE: 1, FAILED: 1, BLOCKED: 2 }, escalated: [], complete: false }),
				PROBE_DEPS,
			);
			const ok = okRow(row);
			expect(ok.state).toBe("attention" satisfies LaneState);
			expect(ok.detail).toContain("1 FAILED");
			expect(ok.detail).toContain("2 BLOCKED");
		});

		test("attention: run_rc outside 0 and 1; run_rc 1 alone is not an attention reason", async () => {
			const mk = (name: string, runRc: number) =>
				fixtureLane(tmp("teams-st-"), name, {
					correlation: "corr-1",
					log: JSON.stringify({ plan_rc: 0, run_rc: runRc }),
					record: { pid: 222 },
				});
			const body = orchReply({ counts: { IN_PROGRESS: 1 }, escalated: [], complete: false });
			const [bad] = await laneStatus([mk("att-2", 3)], body, PROBE_DEPS);
			expect(okRow(bad).state).toBe("attention" satisfies LaneState);
			expect(okRow(bad).detail).toContain("run exited with code 3");
			const [ordinary] = await laneStatus([mk("att-3", 1)], body, PROBE_DEPS);
			expect(okRow(ordinary).detail).not.toContain("run exited");
		});

		test("attention: unfinished tasks with no live process (the run ended)", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "att-4", {
				correlation: "corr-1",
				record: { pid: 222 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ counts: { IN_PROGRESS: 1 }, escalated: [], complete: false }),
				PROBE_DEPS,
			);
			expect(okRow(row).state).toBe("attention" satisfies LaneState);
			expect(okRow(row).detail).toContain("no live lane process");
		});

		test("a recycled pid is not a live lane: incomplete tasks read attention, never running", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "rec-1", {
				correlation: "corr-1",
				record: { pid: 111 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ counts: { IN_PROGRESS: 1 }, escalated: [], complete: false }),
				{ isAlive: () => true, verify: (): LaneVerdict => "mismatch" },
			);
			expect(okRow(row).state).toBe("attention" satisfies LaneState);
		});

		test("attention: a live lane with a FAILED or BLOCKED task is attention, not running", async () => {
			// Pre-fix: a live process returned `running` before the task states were read.
			const lane = fixtureLane(tmp("teams-st-"), "att-live-1", {
				correlation: "corr-1",
				record: { pid: 111 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({
					counts: { RUNNING: 1, FAILED: 1, BLOCKED: 2 },
					escalated: [],
					complete: false,
				}),
				PROBE_DEPS,
			);
			const ok = okRow(row);
			expect(ok.state).toBe("attention" satisfies LaneState);
			expect(ok.detail).toContain("1 FAILED");
			expect(ok.detail).toContain("2 BLOCKED");
			expect(ok.detail).toContain("process still running");
			expect(ok.summary).toContain("process still running");
			expect(ok.total).toBe(4);
		});

		test("attention: a live lane with a non-empty escalated list is attention", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "att-live-2", {
				correlation: "corr-1",
				record: { pid: 111 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ counts: { RUNNING: 2 }, escalated: ["T-7"], complete: false }),
				PROBE_DEPS,
			);
			expect(okRow(row).state).toBe("attention" satisfies LaneState);
			expect(okRow(row).detail).toBe("1 ESCALATED, process still running");
		});

		test("a complete lane stays done even with a live pid and failed tasks on record", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "att-live-3", {
				correlation: "corr-1",
				record: { pid: 111 },
			});
			const [row] = await laneStatus(
				[lane],
				orchReply({ counts: { DONE: 2, FAILED: 1 }, escalated: [], complete: true }),
				PROBE_DEPS,
			);
			expect(okRow(row).state).toBe("done" satisfies LaneState);
		});

		test("not-planned: no correlation, no process, no log (old: probed and reported 'no task list')", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "np-1", { record: { pid: 222 } });
			const [row] = await laneStatus([lane], failIfProbed, PROBE_DEPS);
			expect(okRow(row).state).toBe("not-planned" satisfies LaneState);
			const bare = fixtureLane(tmp("teams-st-"), "np-2");
			const [bareRow] = await laneStatus([bare], failIfProbed, PROBE_DEPS);
			expect(okRow(bareRow).state).toBe("not-planned" satisfies LaneState);
		});

		test("an orch_status exit-2 {error} body shows error.code and message, never not-planned", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "err-1", {
				correlation: "corr-1",
				record: { pid: 222 },
			});
			const [row] = await laneStatus(
				[lane],
				async () => ({
					stdout: JSON.stringify({
						agent: "A01",
						script: "orch_status",
						status: "error",
						error: { code: "E_CONTRACT", message: "workspace has no task store" },
					}),
				}),
				PROBE_DEPS,
			);
			if (!row || !("error" in row)) throw new Error("expected an error row");
			expect(row.error).toContain("E_CONTRACT");
			expect(row.error).toContain("workspace has no task store");
			expect(row.error).not.toContain("not-planned");
			expect(row.error).not.toContain("no task list");
		});

		test("corrupt lane.json and a corrupt autonomous.log never throw and read not-planned", async () => {
			const lane = fixtureLane(tmp("teams-st-"), "bad-1", {
				rawLaneJson: "{not json",
				log: "<<<garbage",
			});
			const [row] = await laneStatus([lane], failIfProbed, PROBE_DEPS);
			const ok = okRow(row);
			expect(ok.state).toBe("not-planned" satisfies LaneState);
			expect(ok.summary).toContain("unreadable");
		});
	});
});

describe("orchStatusRunner", () => {
	test("probes orch_status.py with the lane SWARM_DIR and a 10s cap", async () => {
		const seen: Array<{
			cmd: string;
			args: readonly string[];
			opts: { env: NodeJS.ProcessEnv; timeout: number };
		}> = [];
		const runner = orchStatusRunner(
			{ swarmRoot: "/opt/agent-swarm", cwd: "/repo", env: { ULTRATHINK_HOST: "omp" } },
			async (cmd, args, opts) => {
				seen.push({ cmd, args, opts });
				return { stdout: JSON.stringify({ tasks: [] }) };
			},
		);
		expect(await runner("/lane/dir")).toEqual({ stdout: JSON.stringify({ tasks: [] }) });
		expect(seen[0]!.cmd).toBe("python3");
		expect(seen[0]!.args).toEqual([
			join("/opt/agent-swarm", "scripts", "orch_status.py"),
			"--json",
			"--repo",
			"/repo",
		]);
		expect(seen[0]!.opts.env.SWARM_DIR).toBe("/lane/dir");
		expect(seen[0]!.opts.env.ULTRATHINK_HOST).toBe("omp");
		expect(seen[0]!.opts.timeout).toBe(ORCH_STATUS_TIMEOUT_MS);
	});

	test("the probe env carries none of the Jev key variables and the caller's env is untouched", async () => {
		const parent: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			OPENROUTER_API_KEY: "sk-or-v1-CANARYCANARYCANARY1234",
			AI_GATEWAY_API_KEY: "vck_CANARYCANARYCANARY9012",
			ULTRATHINK_OPENROUTER_KEY: "sk-or-v1-CANARYCANARYCANARY5678",
		};
		let seen: NodeJS.ProcessEnv | undefined;
		const runner = orchStatusRunner(
			{ swarmRoot: "/opt/agent-swarm", cwd: "/repo", env: parent },
			async (_cmd, _args, opts) => {
				seen = opts.env;
				return { stdout: JSON.stringify({ tasks: [] }) };
			},
		);
		await runner("/lane/dir");
		expect(seen?.PATH).toBe("/usr/bin");
		expect(seen?.SWARM_DIR).toBe("/lane/dir");
		expect(JSON.stringify(seen)).not.toContain("CANARY");
		for (const name of ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ULTRATHINK_OPENROUTER_KEY"]) {
			expect(seen).not.toHaveProperty(name);
			expect(parent[name]).toContain("CANARY");
		}
	});

	test("a non-zero exit that still printed JSON reads as stdout", async () => {
		const runner = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, async () => ({
			stdout: JSON.stringify({ tasks: [] }),
			error: new Error("exited with code 1"),
		}));
		expect(await runner("/lane/dir")).toEqual({ stdout: JSON.stringify({ tasks: [] }) });
	});

	test("missing stdout is an error carrying the failure detail", async () => {
		const stderrProbe = orchStatusRunner(
			{ swarmRoot: "/opt/agent-swarm", cwd: "/repo" },
			async () => ({
				stdout: "",
				stderr: "traceback (line 1)\n    boom",
			}),
		);
		const stderrResult = await stderrProbe("/lane/dir");
		expect("error" in stderrResult && stderrResult.error).toContain("boom");
		const errorProbe = orchStatusRunner(
			{ swarmRoot: "/opt/agent-swarm", cwd: "/repo" },
			async () => ({
				error: new Error("spawn python3 ENOENT"),
			}),
		);
		const errorResult = await errorProbe("/lane/dir");
		expect("error" in errorResult && errorResult.error).toContain("ENOENT");
	});

	test("a throwing probe seam is a failure, not a crash", async () => {
		const runner = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, async () => {
			throw new Error("kaboom");
		});
		const result = await runner("/lane/dir");
		expect("error" in result && result.error).toContain("kaboom");
	});
});

describe("laneDirs", () => {
	test("discovers nonced lane directories, labels them by full basename, ignores strangers", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-dirs-"));
		mkdirSync(join(stateDir, "swarm", `${sha8("a")}-1-m0a`), { recursive: true });
		mkdirSync(join(stateDir, "swarm", `${sha8("b")}-2-m0b`), { recursive: true });
		// Pre-nonce shape and non-lane entries are ignored.
		mkdirSync(join(stateDir, "swarm", "abcd1234-1"), { recursive: true });
		mkdirSync(join(stateDir, "swarm", "zzzzzzzz-3-m0c"), { recursive: true });
		writeFileSync(join(stateDir, "swarm", "stray.txt"), "x");
		const lanes = laneDirs(stateDir, realFs).lanes;
		expect(lanes.map((entry) => entry.laneId)).toEqual([
			`${sha8("a")}-1-m0a`,
			`${sha8("b")}-2-m0b`,
		]);
		expect(lanes[0]!.stateDir).toBe(join(stateDir, "swarm", `${sha8("a")}-1-m0a`));
		// A state directory without swarm lanes discovers nothing.
		expect(laneDirs(join(stateDir, "empty"), realFs)).toEqual({ lanes: [], omitted: 0 });
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("bounds discovery to the most recent lanes by mtime, ordered by index then nonce", () => {
		const entries: Record<string, { mtimeMs: number }> = {};
		for (let i = 1; i <= 30; i += 1) entries[`abcd1234-${i}-m${i.toString(36)}`] = { mtimeMs: i };
		// A relabelled (re-spawned) lane keeps its index but jumps the recency queue.
		entries["abcd1234-2-mzz"] = { mtimeMs: 999 };
		const fakeFs: TeamsFs = {
			existsSync: () => false,
			mkdirSync: () => {
				// reason: test double, the fake directory needs no creation
			},
			openSync: () => 0,
			closeSync,
			readdirSync: () => Object.keys(entries),
			statSync: (path: string) => {
				const entry = entries[basename(path)];
				if (!entry) throw new Error(`vanished: ${path}`);
				return entry;
			},
			readFileSync,
			renameSync,
			writeFileSync,
		};
		const discovery = laneDirs("/state", fakeFs);
		const lanes = discovery.lanes;
		expect(lanes.length).toBe(MAX_DISCOVERED_LANES);
		// 31 matching lanes minus the kept 24: the hidden older lanes are counted, never silent.
		expect(discovery.omitted).toBe(7);
		const ids = lanes.map((entry) => entry.laneId);
		expect(ids).not.toContain("abcd1234-1-m1"); // oldest dropped
		expect(ids).not.toContain("abcd1234-7-m7");
		expect(ids).toContain("abcd1234-30-mu");
		expect(ids).toContain("abcd1234-2-mzz"); // recent despite its low index
		// Within the kept set, labels order by lane index then nonce.
		const keys = ids.map((id) => {
			const parts = id.split("-");
			return { index: Number(parts[1]), nonce: parts[2]! };
		});
		for (let i = 1; i < keys.length; i += 1) {
			expect(keys[i]!.index).toBeGreaterThanOrEqual(keys[i - 1]!.index);
			if (keys[i]!.index === keys[i - 1]!.index)
				expect(keys[i]!.nonce >= keys[i - 1]!.nonce).toBe(true);
		}
	});

	test("allLaneDirs is never bounded by recency: every lane stays reachable, ordered by index then nonce", () => {
		const entries: Record<string, { mtimeMs: number }> = {};
		for (let i = 1; i <= MAX_DISCOVERED_LANES + 6; i += 1)
			entries[`abcd1234-${i}-m${i.toString(36)}`] = { mtimeMs: i };
		const fakeFs: TeamsFs = {
			existsSync: () => false,
			mkdirSync: () => {
				// reason: test double, the fake directory needs no creation
			},
			openSync: () => 0,
			closeSync,
			readdirSync: () => Object.keys(entries),
			statSync: (path: string) => {
				const entry = entries[basename(path)];
				if (!entry) throw new Error(`vanished: ${path}`);
				return entry;
			},
			readFileSync,
			renameSync,
			writeFileSync,
		};
		const all = allLaneDirs("/state", fakeFs);
		expect(all).toHaveLength(MAX_DISCOVERED_LANES + 6);
		// The oldest lane is the one the bounded listing hides; stop must still reach it.
		expect(all.map((entry) => entry.laneId)).toContain("abcd1234-1-m1");
		expect(laneDirs("/state", fakeFs).lanes.map((entry) => entry.laneId)).not.toContain(
			"abcd1234-1-m1",
		);
		expect(all.map((entry) => entry.laneId)[0]).toBe("abcd1234-1-m1");
		const target = resolveStopTargets("abcd1234-1-m1", all);
		expect(target).toEqual({ targets: [all[0]!] });
	});
});

describe("display formatting", () => {
	test("formatLaneHandles shows started counts, pids, log paths and failed lanes", () => {
		const handles: LaneHandle[] = [
			{ laneId: "lane-1", pid: 7, stateDir: "/s/ab-1", logPath: "/s/ab-1/run.log" },
			{ laneId: "lane-2", stateDir: "/s/cd-2", logPath: "/s/cd-2/run.log", error: "boom" },
		];
		const text = formatLaneHandles(handles);
		expect(text).toContain("1/2 spawned");
		expect(text).toContain("lane-1: pid 7");
		expect(text).toContain("log /s/ab-1/run.log");
		expect(text).toContain("lane-2: failed to start — boom");
		expect(formatLaneHandles([])).toContain("No swarm lanes");
	});

	test("formatLaneStatusText joins summaries, names errors, and shows each lane's log", () => {
		const rows: LaneStatusRow[] = [
			{
				laneId: "abcd1234-1-m9x",
				logPath: "/s/abcd1234-1-m9x/run.log",
				state: "done",
				total: 2,
				byState: { DONE: 2 },
				done: 2,
				summary: "abcd1234-1-m9x: done — 2 tasks — 2 DONE",
			},
			{ laneId: "ef567890-2-m9y", logPath: "/s/ef567890-2-m9y/run.log", error: "timed out" },
		];
		const text = formatLaneStatusText(rows);
		expect(text).toContain("abcd1234-1-m9x: done — 2 tasks — 2 DONE");
		expect(text).toContain("log /s/abcd1234-1-m9x/run.log");
		expect(text).toContain("ef567890-2-m9y: timed out");
		expect(text).toContain("log /s/ef567890-2-m9y/run.log");
		expect(formatLaneStatusText([])).toContain("No swarm lanes");
	});

	test("formatLaneStatusText ends with the omitted count when discovery hid older lanes", () => {
		const rows: LaneStatusRow[] = [
			{
				laneId: "abcd1234-1-m9x",
				logPath: "/s/abcd1234-1-m9x/run.log",
				state: "running",
				total: 1,
				byState: { RUNNING: 1 },
				done: 0,
				summary: "abcd1234-1-m9x: running — 1 task — 1 RUNNING",
			},
		];
		const text = formatLaneStatusText(rows, 3);
		expect(text).toContain("abcd1234-1-m9x: running — 1 task — 1 RUNNING");
		// The omitted count is a final line, after every probed lane.
		expect(text.split("\n").at(-1)).toMatch(
			/^3 older lanes not shown — raise .* prune <stateDir>\/swarm$/,
		);
		// Singular lanes read naturally, and no bound means no trailing line.
		expect(formatLaneStatusText(rows, 1)).toContain("1 older lane not shown");
		expect(formatLaneStatusText(rows)).not.toContain("not shown");
		// A hidden count is still reported even with zero probed rows.
		expect(formatLaneStatusText([], 2)).toContain("2 older lanes not shown");
	});

	test("TEAMS_USAGE documents the command surface and the real lane output", () => {
		expect(TEAMS_USAGE).toContain("/ultrathink-swarm");
		expect(TEAMS_USAGE).toContain("ULTRATHINK_SWARM_ROOT");
		expect(TEAMS_USAGE).toContain("ULTRATHINK_SWARM_MAX_LANES");
		expect(TEAMS_USAGE).toContain("status");
		// D-04: the lane's real output is autonomous.log, events.jsonl and results/; run.log is the wrapper's stdout.
		expect(TEAMS_USAGE).toContain("autonomous.log");
		expect(TEAMS_USAGE).toContain("events.jsonl");
		expect(TEAMS_USAGE).toContain("results/");
		expect(TEAMS_USAGE).toMatch(/run\.log[^.]*wrapper's own stdout/);
		expect(TEAMS_USAGE).toContain("stop [laneId|all]");
		expect(TEAMS_USAGE).toContain("does not stop them");
		expect(TEAMS_USAGE).toContain("same repository");
	});
});

describe("toSwarmSpawnCard", () => {
	const plans: LanePlan[] = [
		{
			id: "lane-1",
			brief: "fix the gate",
			laneBrief: "fix the gate + pstack block",
			cwd: "/repo",
			stateDir: "/s/aa11bb22-1-x1",
			argv: [],
			env: {},
		},
		{
			id: "lane-2",
			brief: "write the docs",
			laneBrief: "write the docs + pstack block",
			cwd: "/repo",
			stateDir: "/s/cc33dd44-2-x2",
			argv: [],
			env: {},
		},
	];
	const handles: LaneHandle[] = [
		{
			laneId: "aa11bb22-1-x1",
			pid: 4242,
			stateDir: "/s/aa11bb22-1-x1",
			logPath: "/s/aa11bb22-1-x1/run.log",
		},
		{
			laneId: "cc33dd44-2-x2",
			stateDir: "/s/cc33dd44-2-x2",
			logPath: "/s/cc33dd44-2-x2/run.log",
			error: "boom",
		},
	];

	test("joins briefs by position and carries each handle's pid, log, and start error", () => {
		const card = toSwarmSpawnCard(handles, plans);
		expect(card.total).toBe(2);
		expect(card.lanes).toEqual([
			{
				laneId: "aa11bb22-1-x1",
				brief: "fix the gate",
				stateDir: "/s/aa11bb22-1-x1",
				logPath: "/s/aa11bb22-1-x1/run.log",
				pid: 4242,
			},
			{
				laneId: "cc33dd44-2-x2",
				brief: "write the docs",
				stateDir: "/s/cc33dd44-2-x2",
				logPath: "/s/cc33dd44-2-x2/run.log",
				error: "boom",
			},
		]);
		// Cards carry exactly the frozen keys: no pid on a failed lane, no error on a started one.
		expect(Object.keys(card.lanes[0]!).sort()).toEqual([
			"brief",
			"laneId",
			"logPath",
			"pid",
			"stateDir",
		]);
		expect(Object.keys(card.lanes[1]!).sort()).toEqual([
			"brief",
			"error",
			"laneId",
			"logPath",
			"stateDir",
		]);
	});

	test("spawned counts only lanes that actually started", () => {
		expect(toSwarmSpawnCard(handles, plans).spawned).toBe(1);
		const started = toSwarmSpawnCard(
			[
				{
					laneId: "aa11bb22-1-x1",
					pid: 7,
					stateDir: "/s/aa11bb22-1-x1",
					logPath: "/s/aa11bb22-1-x1/run.log",
				},
			],
			plans,
		);
		expect(started.spawned).toBe(1);
		const failed = toSwarmSpawnCard(
			[
				{
					laneId: "aa11bb22-1-x1",
					stateDir: "/s/aa11bb22-1-x1",
					logPath: "/s/aa11bb22-1-x1/run.log",
					error: "no pid",
				},
			],
			plans,
		);
		expect(failed.spawned).toBe(0);
		expect(failed.lanes[0]!.brief).toBe("fix the gate");
	});

	test("projects real planLanes + spawnLanes output without any real process", () => {
		const dir = mkdtempSync(join(tmpdir(), "teams-card-"));
		const briefs = ["alpha task", "beta task", "gamma task"];
		const plans = planLanes(briefs, baseOpts(dir));
		const spawner = recordingSpawner(true); // the second lane fails to start
		const handles = spawnLanes(plans, spawner.fn, realFs);
		const card = toSwarmSpawnCard(handles, plans);
		expect(card.total).toBe(3);
		expect(card.spawned).toBe(2);
		// Briefs join by position, and every log path is the handle's own run log.
		expect(card.lanes.map((lane) => lane.brief)).toEqual(briefs);
		for (const lane of card.lanes) expect(lane.logPath).toBe(join(lane.stateDir, "run.log"));
		expect(card.lanes[1]!.error).toBe("boom");
		expect("pid" in card.lanes[1]!).toBe(false);
	});

	test("empty handles and plans produce an empty lanes array, never undefined fields", () => {
		expect(toSwarmSpawnCard([], [])).toEqual({ spawned: 0, total: 0, lanes: [] });
	});
});

describe("toSwarmStatusCard", () => {
	test("maps success rows to counts and error rows to bare error lanes, both with the run log path", () => {
		const rows: LaneStatusRow[] = [
			{
				laneId: "aa11bb22-1-x1",
				logPath: "/s/aa11bb22-1-x1/run.log",
				state: "done",
				total: 3,
				byState: { DONE: 3 },
				done: 3,
				graphId: "ut-mabc12-0123abcd",
				summary: "aa11bb22-1-x1: done — 3 tasks — 3 DONE",
			},
			{ laneId: "cc33dd44-2-x2", logPath: "/s/cc33dd44-2-x2/run.log", error: "probe timed out" },
		];
		const card = toSwarmStatusCard(rows, 2);
		expect(card.omitted).toBe(2);
		expect(card.lanes).toEqual([
			{
				laneId: "aa11bb22-1-x1",
				summary: "aa11bb22-1-x1: done — 3 tasks — 3 DONE",
				logPath: "/s/aa11bb22-1-x1/run.log",
				done: 3,
				total: 3,
				state: "done",
				graphId: "ut-mabc12-0123abcd",
			},
			{
				laneId: "cc33dd44-2-x2",
				summary: "",
				logPath: "/s/cc33dd44-2-x2/run.log",
				error: "probe timed out",
			},
		]);
		// A probed lane carries no error key; a failed probe lane carries none of the counts.
		expect("error" in card.lanes[0]!).toBe(false);
		expect("done" in card.lanes[1]!).toBe(false);
		expect(card.lanes[1]!.summary).toBe("");
	});

	test("omitted passes through even with no rows, and lanes is always an array", () => {
		expect(toSwarmStatusCard([], 5)).toEqual({ lanes: [], omitted: 5 });
		expect(toSwarmStatusCard([], 0)).toEqual({ lanes: [], omitted: 0 });
	});
});

describe("isSdlcPrompt", () => {
	test("slash commands are explicit and never auto-run", () => {
		expect(isSdlcPrompt("/ultrathink-swarm x")).toBe(false);
		expect(isSdlcPrompt("/gsd-autonomous")).toBe(false);
	});

	test("SDLC-verb openers auto-run, across whitespace and politeness prefixes", () => {
		expect(isSdlcPrompt("build a health endpoint")).toBe(true);
		expect(isSdlcPrompt("  fix the login bug")).toBe(true);
		expect(isSdlcPrompt("please refactor the parser")).toBe(true);
		expect(isSdlcPrompt("hey deploy to staging")).toBe(true);
	});

	test("questions, chatter and non-verb openers never auto-run", () => {
		expect(isSdlcPrompt("what is this file")).toBe(false);
		expect(isSdlcPrompt("")).toBe(false);
		expect(isSdlcPrompt("sudo rm -rf /")).toBe(false);
	});
});

describe("filterSpawnable", () => {
	const plans = (): LanePlan[] =>
		planLanes(["build a", "tell me a joke", "build c"], baseOpts("/s"));
	const verdictFor =
		(by: Record<string, ClassifyVerdict>) =>
		async (text: string): Promise<ClassifyVerdict> =>
			by[text] ?? { kind: "unknown", reason: "no stub" };

	test("sdlc keeps the plan, skip refuses it with the exact user string", async () => {
		const all = plans();
		const result = await filterSpawnable(
			all,
			verdictFor({
				"build a": { kind: "sdlc" },
				"tell me a joke": { kind: "skip" },
				"build c": { kind: "sdlc" },
			}),
		);
		expect(result.spawn.map((plan) => plan.id)).toEqual(["lane-1", "lane-3"]);
		expect(result.refused).toEqual([
			{ laneId: "lane-2", reason: "Swarm would skip this brief (not SDLC work)" },
		]);
		expect(result.notes).toEqual([]);
		expect(SKIP_REFUSAL).toBe("Swarm would skip this brief (not SDLC work)");
	});

	test("unknown spawns with the classifier-unavailable note and is never the skip refusal", async () => {
		const result = await filterSpawnable(
			plans(),
			async (): Promise<ClassifyVerdict> => ({ kind: "unknown", reason: "python3 not found" }),
		);
		expect(result.spawn).toHaveLength(3);
		expect(result.refused).toEqual([]);
		expect(result.notes).toEqual(["classifier unavailable — spawned without preflight"]);
		expect(result.notes).toEqual([CLASSIFIER_UNAVAILABLE_NOTE]);
		expect(JSON.stringify(result)).not.toContain("would skip");
	});

	test("a throwing classifier is unknown, not a crash", async () => {
		const result = await filterSpawnable(plans(), async () => {
			throw new Error("boom");
		});
		expect(result.spawn).toHaveLength(3);
		expect(result.notes).toEqual([CLASSIFIER_UNAVAILABLE_NOTE]);
	});

	test("the classifier sees the exact final lane text: Graph ID first, then brief, then pstack block", async () => {
		const skillsDir = tmp("teams-filter-pstack-");
		for (const name of ["how", "architect", "arena", "tdd", "interrogate", "no-comments"]) {
			mkdirSync(join(skillsDir, name), { recursive: true });
			writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name}\n`);
		}
		const planned = planLanes(["build a"], {
			...baseOpts("/s"),
			graphId: "ut-mabc12-0123abcd",
			pstack: { skillsDir },
		});
		const seen: string[] = [];
		await filterSpawnable(planned, async (text) => {
			seen.push(text);
			return { kind: "sdlc" };
		});
		expect(seen).toEqual([planned[0]!.laneBrief]);
		expect(seen[0]!.startsWith("Graph ID: ut-mabc12-0123abcd\n\nbuild a")).toBe(true);
		expect(seen[0]).toContain("pstack alongside GSD (orchestrate");
	});
});

describe("refuseDuplicatesAndOverCap", () => {
	const RUNNER = RUNNER_CMDLINE;
	const cmdlines: Record<number, string> = {
		100: RUNNER,
		101: RUNNER,
		300: "bash\u0000-lc\u0000sleep 99",
	};
	const alive = (pid: number): boolean => pid === 100 || pid === 101 || pid === 300;
	const verify = (record: LaneRecord): LaneVerdict =>
		verifyLaneProcess(record, {
			platform: "linux",
			readCmdline: (pid) => cmdlines[pid],
			readStat: (pid) => procStat(pid),
			readBootTimeSec: () => BOOT_SEC,
		});

	/** `<root>/swarm/<name>` lanes: live (100), dead (200), recycled (300), missing and corrupt lane.json. */
	function stateWithLanes(): string {
		const root = tmp("teams-cap-");
		const swarm = join(root, "swarm");
		fixtureLane(swarm, "aaaaaaaa-1-n1", {
			record: { pid: 100, briefDigest: briefDigest("fix the bug"), cwd: "/repo" },
		});
		fixtureLane(swarm, "aaaaaaaa-2-n1", { record: { pid: 200 } });
		fixtureLane(swarm, "aaaaaaaa-3-n1", { record: { pid: 300 } });
		fixtureLane(swarm, "aaaaaaaa-4-n1");
		fixtureLane(swarm, "aaaaaaaa-5-n1", { rawLaneJson: "{corrupt" });
		return root;
	}

	const plan = (...briefs: string[]): LanePlan[] => planLanes(briefs, baseOpts("/state"));

	test("counts only the live lane: dead, recycled, missing and malformed lane.json are free", () => {
		const root = stateWithLanes();
		// Cap 2 with one live lane leaves one slot; had the four non-live lanes counted, it would be full.
		const result = refuseDuplicatesAndOverCap(
			plan("write docs"),
			root,
			"/repo",
			2,
			alive,
			verify,
			realFs,
		);
		expect(result.refused).toEqual([]);
		expect(result.spawn).toHaveLength(1);
	});

	test("the cap spans commands: a second command while one lane lives is refused with the live list and stop hint", () => {
		const root = stateWithLanes();
		const result = refuseDuplicatesAndOverCap(
			plan("write docs"),
			root,
			"/repo",
			1,
			alive,
			verify,
			realFs,
		);
		expect(result.spawn).toEqual([]);
		expect(result.refused).toHaveLength(1);
		const reason = result.refused[0]!.reason;
		expect(reason).toContain("aaaaaaaa-1-n1");
		expect(reason).toContain("pid 100");
		expect(reason).toContain("stop a lane");
	});

	test("within one command, lanes past the remaining slots are refused and earlier ones spawn", () => {
		const root = stateWithLanes();
		const result = refuseDuplicatesAndOverCap(
			plan("write docs", "add tests", "fix lint"),
			root,
			"/repo",
			3,
			alive,
			verify,
			realFs,
		);
		expect(result.spawn.map((entry) => entry.brief)).toEqual(["write docs", "add tests"]);
		expect(result.refused.map((entry) => entry.laneId)).toEqual(["lane-3"]);
		expect(result.refused[0]!.reason).toContain("stop a lane");
	});

	test("the same normalized brief in the same cwd is refused with already running as <laneId>", () => {
		const root = stateWithLanes();
		const result = refuseDuplicatesAndOverCap(
			plan("Fix  THE bug"),
			root,
			"/repo",
			5,
			alive,
			verify,
			realFs,
		);
		expect(result.spawn).toEqual([]);
		expect(result.refused[0]!.reason).toContain("already running as aaaaaaaa-1-n1");
		expect(result.refused[0]!.reason).toContain("stop a lane");
		// Another repository's cwd is a different lane identity.
		const elsewhere = refuseDuplicatesAndOverCap(
			plan("Fix  THE bug"),
			root,
			"/other",
			5,
			alive,
			verify,
			realFs,
		);
		expect(elsewhere.refused).toEqual([]);
	});

	test("a dead lane running the same brief does not block a respawn", () => {
		const root = tmp("teams-dup-dead-");
		fixtureLane(join(root, "swarm"), "aaaaaaaa-1-n1", {
			record: { pid: 200, briefDigest: briefDigest("fix the bug") },
		});
		const result = refuseDuplicatesAndOverCap(
			plan("fix the bug"),
			root,
			"/repo",
			3,
			alive,
			verify,
			realFs,
		);
		expect(result.refused).toEqual([]);
	});

	test("an absent state dir has no live lanes", () => {
		const result = refuseDuplicatesAndOverCap(
			plan("a"),
			join(tmp("teams-cap-empty-"), "none"),
			"/repo",
			1,
			alive,
			verify,
			realFs,
		);
		expect(result.spawn).toHaveLength(1);
	});

	test("a lane whose /proc identity is unreadable still counts toward the cap and duplicates", () => {
		const root = stateWithLanes();
		const unreadable = (record: LaneRecord): LaneVerdict =>
			verifyLaneProcess(record, { platform: "linux", readCmdline: () => undefined });
		const result = refuseDuplicatesAndOverCap(
			plan("Fix  THE bug", "write docs"),
			root,
			"/repo",
			1,
			alive,
			unreadable,
			realFs,
		);
		expect(result.spawn).toEqual([]);
		expect(result.refused[0]!.reason).toContain("already running as aaaaaaaa-1-n1");
		expect(result.refused[1]!.reason).toContain("pid 100");
	});

	test("equivalent briefs in one command: the later one is refused as a duplicate of the earlier and costs no slot", () => {
		const root = stateWithLanes();
		// Cap 3 with one live lane leaves two slots. "Build X" and "build   x" normalize alike (the pre-fix
		// code spawned both and pushed "write docs" out of the cap).
		const result = refuseDuplicatesAndOverCap(
			plan("Build X", "build   x", "write docs"),
			root,
			"/repo",
			3,
			alive,
			verify,
			realFs,
		);
		expect(result.spawn.map((entry) => entry.brief)).toEqual(["Build X", "write docs"]);
		expect(result.refused).toEqual([
			{ laneId: "lane-2", reason: "duplicate of lane-1 in this command" },
		]);
	});

	test("a brief refused by the cap is not an earlier lane: its twin is refused by the cap too, not as a duplicate", () => {
		const root = stateWithLanes();
		const result = refuseDuplicatesAndOverCap(
			plan("add tests", "write docs", "Write  DOCS"),
			root,
			"/repo",
			2,
			alive,
			verify,
			realFs,
		);
		expect(result.spawn.map((entry) => entry.brief)).toEqual(["add tests"]);
		expect(result.refused.map((entry) => entry.laneId)).toEqual(["lane-2", "lane-3"]);
		for (const refusal of result.refused) expect(refusal.reason).toContain("lane cap reached");
	});
});

describe("spawnGuarded", () => {
	const noneAlive = (): boolean => false;
	const plans = (briefs: string[]): LanePlan[] => planLanes(briefs, baseOpts("/state"));
	const handleFor = (lane: LanePlan): LaneHandle => ({
		laneId: lane.id,
		pid: 1,
		stateDir: lane.stateDir,
		logPath: join(lane.stateDir, "run.log"),
	});

	test("the spawner runs while the lane lock directory exists and the lock is released afterwards", () => {
		const root = tmp("teams-guarded-lock-");
		const lock = join(root, "swarm", ".lane-lock");
		const seen: boolean[] = [];
		const result = spawnGuarded(plans(["write docs"]), {
			stateDir: root,
			cwd: "/repo",
			cap: 3,
			isAlive: noneAlive,
			spawn: (list) => {
				seen.push(existsSync(lock));
				return list.map(handleFor);
			},
		});
		expect(seen).toEqual([true]);
		expect(existsSync(lock)).toBe(false);
		expect(result.handles.map((handle) => handle.laneId)).toEqual(["lane-1"]);
	});

	test("the lock is released when the spawner throws", () => {
		const root = tmp("teams-guarded-throw-");
		expect(() =>
			spawnGuarded(plans(["write docs"]), {
				stateDir: root,
				cwd: "/repo",
				cap: 3,
				isAlive: noneAlive,
				spawn: () => {
					throw new Error("spawn failed");
				},
			}),
		).toThrow("spawn failed");
		expect(existsSync(join(root, "swarm", ".lane-lock"))).toBe(false);
	});

	test("a repeated brief and the cap are refused as refuseDuplicatesAndOverCap refuses them; only survivors spawn, in order", () => {
		const root = tmp("teams-guarded-refuse-");
		const input = plans(["Build X", "build   x", "write docs", "add tests"]);
		const expected = refuseDuplicatesAndOverCap(input, root, "/repo", 2, noneAlive);
		const spawned: string[][] = [];
		const result = spawnGuarded(input, {
			stateDir: root,
			cwd: "/repo",
			cap: 2,
			isAlive: noneAlive,
			spawn: (list) => {
				spawned.push(list.map((lane) => lane.brief));
				return list.map(handleFor);
			},
		});
		expect(result.spawn.map((lane) => lane.brief)).toEqual(["Build X", "write docs"]);
		expect(result.spawn).toEqual(expected.spawn);
		expect(result.refused).toEqual(expected.refused);
		expect(result.refused.map((entry) => entry.laneId)).toEqual(["lane-2", "lane-4"]);
		expect(result.refused[0]!.reason).toBe("duplicate of lane-1 in this command");
		expect(result.refused[1]!.reason).toContain("lane cap reached");
		expect(spawned).toEqual([["Build X", "write docs"]]);
		expect(result.handles.map((handle) => handle.laneId)).toEqual(["lane-1", "lane-3"]);
	});

	test("no survivors: the spawner is never called and there are no handles", () => {
		const root = tmp("teams-guarded-none-");
		let calls = 0;
		const result = spawnGuarded(plans(["write docs"]), {
			stateDir: root,
			cwd: "/repo",
			cap: 0,
			isAlive: noneAlive,
			spawn: (list) => {
				calls += 1;
				return list.map(handleFor);
			},
		});
		expect(calls).toBe(0);
		expect(result.handles).toEqual([]);
		expect(result.spawn).toEqual([]);
		expect(result.refused.map((entry) => entry.laneId)).toEqual(["lane-1"]);
		expect(existsSync(join(root, "swarm", ".lane-lock"))).toBe(false);
	});

	test("a lock held by another holder past the wait fails open: the lane still spawns and the other lock is left alone", () => {
		const root = tmp("teams-guarded-open-");
		const lock = join(root, "swarm", ".lane-lock");
		mkdirSync(lock, { recursive: true });
		let clock = 0;
		const slept: number[] = [];
		const spawned: string[] = [];
		const result = spawnGuarded(plans(["write docs"]), {
			stateDir: root,
			cwd: "/repo",
			cap: 3,
			isAlive: noneAlive,
			spawn: (list) => {
				spawned.push(...list.map((lane) => lane.brief));
				return list.map(handleFor);
			},
			lock: {
				now: () => clock,
				sleep: (ms) => {
					slept.push(ms);
					clock += ms;
				},
				waitMs: 50,
				staleMs: 1_000_000,
			},
		});
		expect(slept.length).toBeGreaterThan(0);
		expect(spawned).toEqual(["write docs"]);
		expect(result.handles).toHaveLength(1);
		expect(existsSync(lock)).toBe(true);
	});
});

describe("stopLanes", () => {
	interface Proc {
		cmdline: string | undefined;
		alive: boolean;
		startOffsetMs: number;
		statReadable: boolean;
	}

	/**
	 * One lane (pid 4242) over injected /proc readers: `proc` decides what the pid looks like, `onWait` lets a
	 * test change it while the grace is polled, and `events` records every verification and signal in order.
	 */
	function harness(
		init: Partial<Proc> = {},
		env: NodeJS.ProcessEnv = {},
		onWait: (proc: Proc, waits: readonly number[]) => void = () => undefined,
	) {
		const proc: Proc = {
			cmdline: RUNNER_CMDLINE,
			alive: true,
			startOffsetMs: 0,
			statReadable: true,
			...init,
		};
		const root = tmp("teams-stop-");
		const lane = fixtureLane(root, "aaaaaaaa-1-n1", { record: { pid: 4242 } });
		const kills: Array<[number, string]> = [];
		const waits: number[] = [];
		const events: string[] = [];
		const run = (targets: LaneRef[] = [lane]) =>
			stopLanes(targets, {
				platform: "linux",
				isAlive: () => proc.alive,
				readCmdline: () => {
					events.push("verify");
					return proc.cmdline;
				},
				readStat: (pid) => (proc.statReadable ? procStat(pid, proc.startOffsetMs) : undefined),
				readBootTimeSec: () => BOOT_SEC,
				kill: (pid, signal) => {
					events.push(`kill ${signal}`);
					kills.push([pid, signal]);
				},
				waitMs: async (ms) => {
					waits.push(ms);
					onWait(proc, waits);
				},
				env,
			});
		return { lane, proc, kills, waits, events, run, root };
	}

	const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

	test("SIGTERMs the process group and returns as soon as the lane is gone, not after the full grace", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "2" }, (proc, waits) => {
			if (waits.length === 2) proc.alive = false;
		});
		const lines = await h.run();
		// Exactly one negative-pid SIGTERM (process-group kill); two polls of 250 ms, not one 2000 ms sleep.
		expect(h.kills).toEqual([[-4242, "SIGTERM"]]);
		expect(h.waits).toEqual([STOP_POLL_MS, STOP_POLL_MS]);
		expect(lines).toEqual([`${h.lane.laneId}: stopped (SIGTERM)`]);
	});

	test("a lane still alive after the grace gets SIGKILL on the group; the default grace is exactly 15000 ms", async () => {
		const h = harness();
		const lines = await h.run();
		expect(h.kills).toEqual([
			[-4242, "SIGTERM"],
			[-4242, "SIGKILL"],
		]);
		// Polled in 250 ms steps that add up to Swarm's own grace: no min() or other shortening of it.
		expect(new Set(h.waits)).toEqual(new Set([STOP_POLL_MS]));
		expect(sum(h.waits)).toBe(STOP_GRACE_DEFAULT_MS);
		expect(lines[0]).toContain("SIGKILL after 15000 ms");
	});

	test("a configured grace longer than the default is waited in full", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "90" });
		await h.run();
		expect(sum(h.waits)).toBe(90000);
	});

	test("a grace that is not a multiple of the poll interval ends with a short final wait", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "0.6" });
		await h.run();
		expect(h.waits).toEqual([250, 250, 100]);
	});

	test("a zero grace waits not at all, and each signal is preceded by a fresh verification", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "0" });
		await h.run();
		expect(h.waits).toEqual([]);
		expect(h.events).toEqual(["verify", "kill SIGTERM", "verify", "kill SIGKILL"]);
	});

	test("with a grace to poll, the SIGKILL still follows a verification made after the last wait", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "0.5" });
		await h.run();
		expect(h.events.at(-1)).toBe("kill SIGKILL");
		expect(h.events.at(-2)).toBe("verify");
		expect(h.events[0]).toBe("verify");
		expect(h.events[1]).toBe("kill SIGTERM");
	});

	test("a recycled pid is ignored with a note and never signalled", async () => {
		const h = harness({ cmdline: "bash\u0000-lc\u0000sleep 99" });
		const lines = await h.run();
		expect(h.kills).toEqual([]);
		expect(h.waits).toEqual([]);
		expect(lines).toEqual([`${h.lane.laneId}: pid 4242 no longer belongs to the lane — ignored`]);
	});

	test("a process that started long after the lane did is a recycled pid and is never signalled", async () => {
		const h = harness({ startOffsetMs: 60_000 });
		const lines = await h.run();
		expect(h.kills).toEqual([]);
		expect(lines).toEqual([`${h.lane.laneId}: pid 4242 no longer belongs to the lane — ignored`]);
	});

	test("an unreadable cmdline is reported as unverifiable, never signalled and never called gone", async () => {
		const h = harness({ cmdline: undefined });
		const lines = await h.run();
		expect(h.kills).toEqual([]);
		expect(h.waits).toEqual([]);
		expect(lines).toEqual([`${h.lane.laneId}: could not verify pid 4242; not signalled`]);
	});

	test("an unreadable stat is unverifiable too, even with a matching cmdline", async () => {
		const h = harness({ statReadable: false });
		const lines = await h.run();
		expect(h.kills).toEqual([]);
		expect(lines).toEqual([`${h.lane.laneId}: could not verify pid 4242; not signalled`]);
	});

	test("a dead pid is reported as already exited and never signalled", async () => {
		const h = harness({ alive: false, cmdline: undefined });
		const lines = await h.run();
		expect(h.kills).toEqual([]);
		expect(lines).toEqual([`${h.lane.laneId}: already exited`]);
	});

	test("a pid recycled during the grace is never SIGKILLed and the wait ends early", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "2" }, (proc) => {
			proc.cmdline = "bash\u0000-lc\u0000sleep 99";
		});
		const lines = await h.run();
		expect(h.kills).toEqual([[-4242, "SIGTERM"]]);
		expect(h.waits).toEqual([STOP_POLL_MS]);
		expect(lines).toEqual([`${h.lane.laneId}: stopped (SIGTERM)`]);
	});

	test("a lane that cannot be verified when the grace ends is not SIGKILLed and not reported as stopped", async () => {
		const h = harness({}, { SWARM_AUTONOMOUS_RUN_GRACE_S: "1" }, (proc, waits) => {
			if (sum(waits) >= 1000) proc.cmdline = undefined;
		});
		const lines = await h.run();
		expect(h.kills).toEqual([[-4242, "SIGTERM"]]);
		expect(lines).toEqual([`${h.lane.laneId}: could not verify pid 4242; not signalled`]);
	});

	test("a lane without lane.json has nothing to stop and is never signalled", async () => {
		const h = harness();
		const bare = fixtureLane(h.root, "aaaaaaaa-2-n1");
		const lines = await h.run([bare]);
		expect(h.kills).toEqual([]);
		expect(lines).toEqual(["aaaaaaaa-2-n1: not-planned, nothing to stop"]);
	});

	test("an ESRCH on SIGTERM is reported as already exited", async () => {
		const root = tmp("teams-stop-esrch-");
		const lane = fixtureLane(root, "aaaaaaaa-1-n1", { record: { pid: 4242 } });
		const lines = await stopLanes([lane], {
			platform: "linux",
			isAlive: () => true,
			readCmdline: () => RUNNER_CMDLINE,
			readStat: (pid) => procStat(pid),
			readBootTimeSec: () => BOOT_SEC,
			kill: () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
			waitMs: async () => {
				throw new Error("must not wait");
			},
		});
		expect(lines).toEqual(["aaaaaaaa-1-n1: already exited"]);
	});

	test("stopGraceMs: Swarm's SWARM_AUTONOMOUS_RUN_GRACE_S in seconds, 15 s when unset or unusable", () => {
		expect(stopGraceMs({})).toBe(15000);
		expect(stopGraceMs({ SWARM_AUTONOMOUS_RUN_GRACE_S: "" })).toBe(15000);
		expect(stopGraceMs({ SWARM_AUTONOMOUS_RUN_GRACE_S: "junk" })).toBe(15000);
		expect(stopGraceMs({ SWARM_AUTONOMOUS_RUN_GRACE_S: "-3" })).toBe(15000);
		expect(stopGraceMs({ SWARM_AUTONOMOUS_RUN_GRACE_S: "0" })).toBe(0);
		expect(stopGraceMs({ SWARM_AUTONOMOUS_RUN_GRACE_S: "2.5" })).toBe(2500);
		expect(stopGraceMs({ SWARM_AUTONOMOUS_RUN_GRACE_S: "600" })).toBe(600000);
	});
});

describe("resolveStopTargets", () => {
	const root = (): string => tmp("teams-resolve-");
	const deps = { isAlive: (pid: number) => pid === 100, verify: (): LaneVerdict => "match" };

	test("all means every live lane; none live is a reason", () => {
		const dir = root();
		const live = fixtureLane(dir, "aaaaaaaa-1-n1", { record: { pid: 100 } });
		const dead = fixtureLane(dir, "aaaaaaaa-2-n1", { record: { pid: 200 } });
		const bare = fixtureLane(dir, "aaaaaaaa-3-n1");
		expect(resolveStopTargets("all", [live, dead, bare], deps)).toEqual({ targets: [live] });
		expect(resolveStopTargets("all", [dead, bare], deps)).toEqual({
			reason: "no live swarm lanes to stop",
		});
	});

	test("a lane that cannot be verified stays a stop target; a provably recycled pid does not", () => {
		const dir = root();
		const lane = fixtureLane(dir, "aaaaaaaa-1-n1", { record: { pid: 100 } });
		const alive = { isAlive: () => true };
		expect(resolveStopTargets("all", [lane], { ...alive, verify: () => "unknown" })).toEqual({
			targets: [lane],
		});
		expect(resolveStopTargets("all", [lane], { ...alive, verify: () => "mismatch" })).toEqual({
			reason: "no live swarm lanes to stop",
		});
	});

	test("a lane id matches exactly, else by unique prefix; ambiguity and unknown ids are reasons", () => {
		const dir = root();
		const one = fixtureLane(dir, "aaaaaaaa-1-n1");
		const two = fixtureLane(dir, "aaaaaaaa-2-n1");
		const other = fixtureLane(dir, "bbbbbbbb-1-n1");
		expect(resolveStopTargets("aaaaaaaa-1-n1", [one, two, other])).toEqual({ targets: [one] });
		expect(resolveStopTargets("bbbb", [one, two, other])).toEqual({ targets: [other] });
		const ambiguous = resolveStopTargets("aaaaaaaa", [one, two, other]);
		if (!("reason" in ambiguous)) throw new Error("expected a reason");
		expect(ambiguous.reason).toContain("matches 2 lanes");
		expect(resolveStopTargets("zzzz", [one])).toEqual({ reason: "no swarm lane matches zzzz" });
	});
});

describe("start-time-aware pid check (non-Linux recycled-pid gate)", () => {
	const startedAt = "2026-10-28T10:00:00.000Z";
	const now = () => Date.parse(startedAt) + 60_000;

	test("parseEtimeSeconds reads ps etime in all three shapes", () => {
		expect(parseEtimeSeconds("00:07")).toBe(7);
		expect(parseEtimeSeconds(" 01:02:03\n")).toBe(3723);
		expect(parseEtimeSeconds("2-01:02:03")).toBe(176523);
		expect(parseEtimeSeconds("garbage")).toBeUndefined();
	});

	test("a pid whose process started when the lane did is ours; a younger or older one is recycled", () => {
		const alive = () => true;
		const at = (etimeSeconds: () => number | undefined) =>
			signalAliveMatchingStart(7, startedAt, { alive, now, etimeSeconds });
		expect(at(() => 60)).toBe("match");
		expect(at(() => 5)).toBe("mismatch");
		expect(at(() => 3600)).toBe("mismatch");
		expect(
			signalAliveMatchingStart(7, startedAt, { alive: () => false, now, etimeSeconds: () => 60 }),
		).toBe("mismatch");
	});

	test("an unreadable start time or an unparseable startedAt is unknown, not a mismatch", () => {
		const alive = () => true;
		expect(
			signalAliveMatchingStart(7, startedAt, { alive, now, etimeSeconds: () => undefined }),
		).toBe("unknown");
		expect(signalAliveMatchingStart(7, "not a date", { alive, now, etimeSeconds: () => 60 })).toBe(
			"unknown",
		);
	});
});

describe("pidAlive", () => {
	test("this process is alive; a pid beyond any pid_max is not", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(pidAlive(2 ** 30)).toBe(false);
	});
});

describe("swarmClassifier", () => {
	test("a checkout that cannot be run is unknown, never a skip, and never throws", async () => {
		const verdict = await swarmClassifier("/nonexistent/agent-swarm-checkout")("build a thing");
		expect(verdict.kind).toBe("unknown");
	});
});

describe("laneStatus with an unverifiable lane", () => {
	test("a live pid whose identity cannot be read is still planning, not forgotten", async () => {
		const lane = fixtureLane(tmp("teams-unk-"), "unk-1", { record: { pid: 111 } });
		const [row] = await laneStatus([lane], failIfProbed, {
			isAlive: () => true,
			verify: (): LaneVerdict => "unknown",
		});
		expect(okRow(row).state).toBe("planning" satisfies LaneState);
	});
});
