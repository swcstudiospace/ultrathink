// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Swarm teams — the core behind `/ultrathink-swarm`: fan several concurrent AgentSwarm orchestrator lanes out
 * of one Omp command. Each lane is a detached `hooks/autonomous_run.py` process whose `SWARM_DIR` points at a
 * per-lane state directory, so the Task Store (SQLite plus `kickoffs/` locks) never contends across lanes.
 * Parsing and planning are pure and return `{ reason }` values instead of throwing; the effects — fs and
 * process starts — are injectable so tests never spawn a real process. This module composes with, and never
 * modifies, the AgentSwarm runtime checked out at `ULTRATHINK_SWARM_ROOT`.
 */
import {
	execFile as nodeExecFile,
	execFileSync as nodeExecFileSync,
	spawn as nodeSpawn,
} from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { buildBlock, type PstackInput } from "../cursor/pstack.ts";
import { dropJevKeys } from "../route-defaults.ts";
import { isRecord } from "../shared.ts";
import { type ClassifyVerdict, preflightClassify } from "./classify.ts";
import {
	briefDigest,
	capRefusal,
	findDuplicate,
	type LaneFileFs,
	type LaneRecord,
	type LaneVerdict,
	laneBriefWithGraphId,
	liveLanes,
	type PidAlive,
	readLaneFile,
	START_TIME_TOLERANCE_MS,
	STOP_HINT,
	verifyLaneProcess,
	writeLaneFile,
} from "./lane.ts";

/** Hard ceiling on lanes per command, whatever the environment asks for. */
export const TEAMS_MAX_LANES = 6;

/** How long one lane's `orch_status.py` probe may run before it counts as a failed probe. */
export const ORCH_STATUS_TIMEOUT_MS = 10_000;

/** How many lanes `laneStatus` probes at once; the host must never block on a serial fan-out. */
export const LANE_STATUS_CONCURRENCY = 4;

/** How many historical lanes discovery reports at most (most recent by directory mtime). */
export const MAX_DISCOVERED_LANES = 24;

/** Task states that need a human; any of these in a lane's Task Store makes the lane row `attention`. */
const ATTENTION_TASK_STATES: Record<string, true> = {
	FAILED: true,
	ESCALATED: true,
	BLOCKED: true,
};

/** The grace between SIGTERM and SIGKILL when `SWARM_AUTONOMOUS_RUN_GRACE_S` is unset: Swarm's own default. */
export const STOP_GRACE_DEFAULT_MS = 15_000;

/** The poll interval of the SIGTERM grace: how often a stopping lane is re-verified before the full grace. */
export const STOP_POLL_MS = 250;

/** The user-visible refusal for a brief Swarm's own classifier would silently drop. */
export const SKIP_REFUSAL = "Swarm would skip this brief (not SDLC work)";

/** The note for a brief that spawned because the classifier could not answer. */
export const CLASSIFIER_UNAVAILABLE_NOTE = "classifier unavailable — spawned without preflight";

/** One-line user help for `/ultrathink-swarm`; the reply when parsing finds nothing usable. */
export const TEAMS_USAGE =
	"/ultrathink-swarm usage: `/ultrathink-swarm <brief>|<brief>|…` spawns one AgentSwarm orchestrator lane per " +
	`brief (up to ${TEAMS_MAX_LANES} per command). Swarm drops briefs its classifier does not read as SDLC work, so ` +
	"those are refused up front. `/ultrathink-swarm status` reports each lane as planning, running, skipped, " +
	"plan-failed, done, attention or not-planned; `/ultrathink-swarm stop [laneId|all]` ends a lane's process group. " +
	"A lane's real output is autonomous.log, events.jsonl and results/ in its state dir " +
	"(<state dir>/swarm/<lane>/); run.log there is only the wrapper's own stdout. ULTRATHINK_SWARM_MAX_LANES " +
	`(default 3, cap ${TEAMS_MAX_LANES}) bounds live lanes across all commands, and a brief already running in the ` +
	"same repository is refused; two lanes in one repository share one working tree and its branches. Lanes are " +
	"detached on purpose: ending the Omp session does not stop them. Configuration is env-only: " +
	"ULTRATHINK_SWARM_ROOT (or SWARM_ROOT) names the absolute agent-swarm checkout (required).";

/** The sync fs surface this module needs; injectable so tests never touch real state outside a tmpdir. */
export interface TeamsFs extends LaneFileFs {
	mkdirSync(path: string, options: { recursive: true; mode: number }): void;
	openSync(path: string, flags: string, mode: number): number;
	closeSync(fd: number): void;
	readdirSync(path: string): string[];
	statSync(path: string): { mtimeMs: number };
}

const defaultFs = {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readdirSync,
	statSync,
	readFileSync,
	renameSync,
	writeFileSync,
} satisfies TeamsFs;

/** A copy of `env` without the Jev key variables: the environment every child Ultrathink starts here gets. */
function scrubbedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string | undefined> {
	const copy: Record<string, string | undefined> = { ...env };
	dropJevKeys(copy);
	return copy;
}

/** Why lanes cannot run. `reason` never carries the configured value; `got` does, for the user who typed it. */
export interface SwarmRootFailure {
	reason: string;
	/** The raw configured value; only a path-shape failure sets it. Reports and probes must never read it. */
	got?: string;
}

/** A usable swarm checkout, or why lanes cannot run. */
export type SwarmRoot = { root: string } | SwarmRootFailure;

/** What the command argument parses into. */
export type LaneArgs =
	| { kind: "status" }
	| { kind: "stop"; target: string }
	| { kind: "spawn"; briefs: string[] }
	| { kind: "usage"; reason: string };

/** One planned lane: display brief, runtime brief (with skills block), and the exact process contract. */
export interface LanePlan {
	id: string;
	/** The brief as the user typed it, for display. */
	brief: string;
	/** What actually goes to `--brief`: the brief plus the pstack orchestrate block when one resolved. */
	laneBrief: string;
	/** The Graph ID embedded as the lane brief's first line, when the caller had a well-formed one. */
	graphId?: string;
	cwd: string;
	stateDir: string;
	argv: string[];
	env: Record<string, string>;
}

/** One lane that was handed to the spawner: running, or the reason it never started. */
export interface LaneHandle {
	laneId: string;
	pid?: number;
	stateDir: string;
	logPath: string;
	/** Present only when this lane failed to start; sibling lanes are unaffected. */
	error?: string;
	/** A non-fatal remark about a lane that did start (for example, `lane.json` could not be written). */
	note?: string;
}

/** A lane addressable by status: its display id and the state directory that identifies it. */
export interface LaneRef {
	/** The lane state directory's full basename (`<sha8(brief)>-<i>-<nonce>`), so repeated lanes stay distinct. */
	laneId: string;
	stateDir: string;
}

/** What discovery found under one state directory, plus what its recency bound hid. */
export interface LaneDiscovery {
	/** The bounded lanes, ordered by lane index (then nonce). */
	lanes: LaneRef[];
	/** Older matching lanes beyond the {@link MAX_DISCOVERED_LANES} bound; they may still be running. */
	omitted: number;
}

/** What a lane is really doing, read from its own files (never inferred from the spawn). */
export type LaneState =
	| "planning"
	| "running"
	| "skipped"
	| "plan-failed"
	| "done"
	| "attention"
	| "not-planned";

/**
 * One lane's status: the state word and a summary line from the lane's own files, or why the probe failed.
 * `logPath` always names the lane's `run.log` (the wrapper's stdout); the lane's real output is
 * `autonomous.log`, `events.jsonl` and `results/` beside it.
 */
export type LaneStatusRow =
	| {
			laneId: string;
			logPath: string;
			state: LaneState;
			summary: string;
			/** Task total from `orch_status`; 0 while no plan exists. */
			total: number;
			byState: Record<string, number>;
			/** `total` once `orch_status` reports `complete: true`, else 0; never re-derived from task states. */
			done: number;
			graphId?: string;
			detail?: string;
	  }
	| { laneId: string; logPath: string; error: string };

/** Process start seam; the default is a detached, unref'd `node:child_process` spawn. */
export type LaneSpawnFn = (
	cmd: string,
	args: readonly string[],
	opts: {
		cwd: string;
		env: Record<string, string>;
		detached: true;
		stdio: readonly ["ignore", number, number];
	},
) => { pid?: number };

/** Async probe seam for `orch_status.py`; injectable so status tests never run python. */
export type OrchStatusSpawn = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout?: string | null; stderr?: string | null; error?: Error | null }>;

/** One lane's Task Store probe result: stdout to parse, or why the probe failed. */
export type LaneStatusProbe = (stateDir: string) => Promise<{ stdout: string } | { error: string }>;

/**
 * Validate the swarm root: `ULTRATHINK_SWARM_ROOT`, or `SWARM_ROOT` when that is unset or empty. It must be
 * absolute, an existing directory, and contain `hooks/autonomous_run.py`. A non-empty `ULTRATHINK_SWARM_ROOT`
 * always wins. This is the only root lookup: the spawn path and the probe both call it. Anything unusable is a
 * {@link SwarmRootFailure}: its `reason` is safe to print anywhere; a value that is not even an absolute path
 * (it may be a mistyped credential) is held back in `got`, which only the spawn reply to that user prints.
 */
export function resolveSwarmRoot(env: NodeJS.ProcessEnv, fs: TeamsFs = defaultFs): SwarmRoot {
	const primary = (env.ULTRATHINK_SWARM_ROOT ?? "").trim();
	const raw = primary || (env.SWARM_ROOT ?? "").trim();
	if (!raw)
		return {
			reason:
				"ULTRATHINK_SWARM_ROOT (or SWARM_ROOT fallback) is not set — point one of them at an absolute agent-swarm checkout",
		};
	const name = primary ? "ULTRATHINK_SWARM_ROOT" : "SWARM_ROOT";
	if (!raw.startsWith("/")) return { reason: `${name} must be an absolute path`, got: raw };
	const runner = join(raw, "hooks", "autonomous_run.py");
	if (!fs.existsSync(raw) || !fs.existsSync(runner)) {
		return { reason: `${raw} is not an agent-swarm checkout (missing ${runner})` };
	}
	return { root: raw };
}

/** The failure as the user who typed the value reads it: `reason`, then `, got <value>` when the value was held back. */
export function swarmRootMessage(failure: SwarmRootFailure): string {
	return failure.got === undefined ? failure.reason : `${failure.reason}, got ${failure.got}`;
}

/** The effective per-command lane limit: `ULTRATHINK_SWARM_MAX_LANES` (default 3), clamped to 1..6. */
export function maxLanes(env: NodeJS.ProcessEnv): number {
	const parsed = Number.parseInt(env.ULTRATHINK_SWARM_MAX_LANES ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return 3;
	return Math.min(parsed, TEAMS_MAX_LANES);
}

/**
 * Parse `stop`, `stop <laneId>` and `stop all`; a bare `stop` means every live lane. Anything with more
 * words is not a stop command (a brief may legitimately begin with the word "stop") and yields a usage.
 */
export function parseStopArgs(
	input: string,
): { kind: "stop"; target: string } | { kind: "usage"; reason: string } {
	const words = (input ?? "")
		.trim()
		.split(/\s+/)
		.filter((word) => word !== "");
	if (words[0] !== "stop") return { kind: "usage", reason: "not a stop command" };
	if (words.length === 1) return { kind: "stop", target: "all" };
	if (words.length === 2) return { kind: "stop", target: words[1]! };
	return { kind: "usage", reason: "stop takes one lane id or `all`" };
}

/**
 * Split the command argument into `status`, `stop`, a spawn plan, or a usage reply. Briefs are separated by
 * `|`, trimmed, and emptied ones dropped; more briefs than the lane limit (never more than the hard cap) is a
 * usage with the reason, never a partial spawn.
 */
export function parseLaneArgs(input: string, opts: { maxLanes?: number } = {}): LaneArgs {
	const text = (input ?? "").trim();
	if (text === "status") return { kind: "status" };
	const stop = parseStopArgs(text);
	if (stop.kind === "stop") return stop;
	const briefs = text
		.split("|")
		.map((brief) => brief.trim())
		.filter((brief) => brief.length > 0);
	if (briefs.length === 0) return { kind: "usage", reason: "no lane briefs given" };
	const limit = Math.min(Math.max(opts.maxLanes ?? 3, 1), TEAMS_MAX_LANES);
	if (briefs.length > limit) {
		return {
			kind: "usage",
			reason: `${briefs.length} briefs exceed the ${limit}-lane limit (ULTRATHINK_SWARM_MAX_LANES, cap ${TEAMS_MAX_LANES})`,
		};
	}
	return { kind: "spawn", briefs };
}

/** SDLC verbs whose first-word match lets a plain prompt auto-run; multi-word verbs like "write tests"/"set up" match on the first word. */
const SDLC_VERBS: Record<string, true> = {
	build: true,
	implement: true,
	add: true,
	create: true,
	fix: true,
	refactor: true,
	migrate: true,
	deploy: true,
	release: true,
	ship: true,
	scaffold: true,
	upgrade: true,
	integrate: true,
	write: true,
	set: true,
};

/** Politeness prefixes stripped before first-word matching; each needs its trailing space. */
const SDLC_PREFIXES: readonly string[] = ["sudo ", "please ", "hey "];

/**
 * Whether a plain prompt reads as SDLC work the swarm may auto-run. Slash commands are explicit and never
 * auto-run; otherwise the first word — lower-cased, ignoring a leading "sudo ", "please " or "hey " — must be
 * an SDLC verb. Questions and chatter never match.
 */
export function isSdlcPrompt(prompt: string): boolean {
	const trimmed = prompt.trim();
	if (trimmed.startsWith("/")) return false;
	let rest = trimmed;
	for (;;) {
		const lower = rest.toLowerCase();
		const prefix = SDLC_PREFIXES.find((candidate) => lower.startsWith(candidate));
		if (prefix === undefined) break;
		rest = rest.slice(prefix.length);
	}
	return SDLC_VERBS[rest.split(/\s+/, 1)[0]?.toLowerCase() ?? ""] === true;
}

/** sha256 of the brief, first 8 hex characters: stable per brief, short enough for a directory name. */
const sha8 = (brief: string): string =>
	createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 8);

export interface PlanLanesOptions {
	cwd: string;
	/** The host state directory; each lane gets `<stateDir>/swarm/<sha8(brief)>-<i>-<nonce>`. */
	stateDir: string;
	swarmRoot: string;
	/** Parent env snapshot; the lane env merges it under the lane's own overrides (SWARM_DIR, cap), minus the Jev keys. */
	env?: NodeJS.ProcessEnv;
	/** A pstack resolution (or a stand-in); when absent or unresolved the skills block is dropped. */
	pstack?: PstackInput;
	/** Invocation clock feeding the state-directory nonce; defaults to `Date.now`. */
	now?: () => number;
	/** The Ultrathink Graph ID of the planned prompt; it becomes the lane brief's first line. A malformed id is ignored. */
	graphId?: string;
}

/**
 * Plan one lane per brief, 1-based: id `lane-i`, a per-invocation state directory (hash, index, nonce — so
 * repeated runs of the same briefs never share state), the runner argv, and the lane env: the parent env
 * merged under the lane's own overrides, so `PATH`/`HOME` and friends survive while `SWARM_DIR` and the cap
 * stay lane-local. The Jev keys never reach a lane (`dropJevKeys` on the lane's own copy). The lane brief is
 * `Graph ID: <id>` first (when given), then the brief, then the pstack block, so Swarm's `graph_id_in_text`
 * finds the id on the first line.
 */
export function planLanes(briefs: readonly string[], opts: PlanLanesOptions): LanePlan[] {
	const built = opts.pstack ? buildBlock("orchestrate", opts.pstack) : undefined;
	// Lanes never fail because of skills: an unresolved block is dropped silently.
	const skills = built && !("reason" in built) ? built.block : undefined;
	const cap = opts.env?.SWARM_AUTONOMOUS_RUN_CAP_S?.trim();
	const parentEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(opts.env ?? {})) {
		if (value !== undefined) parentEnv[key] = value;
	}
	// One nonce per invocation: base36 timestamp plus a few random hex digits so two invocations in the
	// same millisecond still land in distinct directories.
	const nonce = `${(opts.now ?? Date.now)().toString(36)}${randomBytes(2).toString("hex")}`;
	return briefs.map((brief, index) => {
		const i = index + 1;
		const stateDir = join(opts.stateDir, "swarm", `${sha8(brief)}-${i}-${nonce}`);
		const bound = laneBriefWithGraphId(brief, opts.graphId);
		const laneBrief = skills ? `${bound}\n\n${skills}` : bound;
		const env: Record<string, string> = {
			...parentEnv,
			SWARM_DIR: stateDir,
			...(cap ? { SWARM_AUTONOMOUS_RUN_CAP_S: cap } : {}),
		};
		dropJevKeys(env);
		const plan: LanePlan = {
			id: `lane-${i}`,
			brief,
			laneBrief,
			cwd: opts.cwd,
			stateDir,
			argv: [
				"python3",
				join(opts.swarmRoot, "hooks", "autonomous_run.py"),
				"--runtime",
				"omp",
				"--cwd",
				opts.cwd,
				"--brief",
				laneBrief,
			],
			env,
		};
		if (opts.graphId !== undefined && bound !== brief) plan.graphId = opts.graphId;
		return plan;
	});
}

function startLaneDetached(
	cmd: string,
	args: readonly string[],
	opts: {
		cwd: string;
		env: Record<string, string>;
		detached: true;
		stdio: readonly ["ignore", number, number];
	},
): { pid?: number } {
	const child = nodeSpawn(cmd, args, {
		cwd: opts.cwd,
		env: opts.env,
		detached: true,
		stdio: opts.stdio as ["ignore", number, number],
	});
	// A missing launcher reports asynchronously as an 'error' event; without a listener it would crash the host.
	child.on("error", () => {
		// reason: the launch failure is seen by the caller through the missing pid; the listener only stops the crash
	});
	child.unref();
	return { pid: child.pid };
}

/** Record the lane's identity in `lane.json`; a failure never fails the spawn, it becomes a handle note. */
function recordLane(lane: LanePlan, pid: number, fs: LaneFileFs): string | undefined {
	try {
		writeLaneFile(
			lane.stateDir,
			{
				laneId: basename(lane.stateDir),
				pid,
				graphId: lane.graphId,
				briefDigest: briefDigest(lane.brief),
				cwd: lane.cwd,
				startedAt: new Date().toISOString(),
			},
			fs,
		);
		return undefined;
	} catch (error) {
		const why = error instanceof Error ? error.message.slice(0, 120) : "write failed";
		return `lane.json not written (${why}); status, stop and the live-lane cap cannot see this lane`;
	}
}

/**
 * Start every planned lane detached, each with `stdout`/`stderr` appended to `<stateDir>/run.log`, and record
 * `<stateDir>/lane.json` right after a successful start. One lane failing to start becomes an error row for
 * that lane alone; the sibling lanes always spawn.
 */
export function spawnLanes(
	plan: readonly LanePlan[],
	spawnFn: LaneSpawnFn = startLaneDetached,
	fs: TeamsFs = defaultFs,
): LaneHandle[] {
	return plan.map((lane) => {
		const logPath = join(lane.stateDir, "run.log");
		try {
			fs.mkdirSync(lane.stateDir, { recursive: true, mode: 0o700 });
			const log = fs.openSync(logPath, "a", 0o600);
			try {
				const child = spawnFn(lane.argv[0]!, lane.argv.slice(1), {
					cwd: lane.cwd,
					env: lane.env,
					detached: true,
					stdio: ["ignore", log, log],
				});
				if (!child.pid)
					return {
						laneId: lane.id,
						stateDir: lane.stateDir,
						logPath,
						error: "spawned without a pid",
					};
				const note = recordLane(lane, child.pid, fs);
				return {
					laneId: lane.id,
					pid: child.pid,
					stateDir: lane.stateDir,
					logPath,
					...(note === undefined ? {} : { note }),
				};
			} finally {
				try {
					fs.closeSync(log);
				} catch {
					// reason: the fd is the OS's to reap either way
				}
			}
		} catch (error) {
			return {
				laneId: lane.id,
				stateDir: lane.stateDir,
				logPath,
				error: error instanceof Error ? error.message.slice(0, 200) : "spawn failed",
			};
		}
	});
}

/** Lane state directories are `<sha8(brief)>-<i>-<nonce>`; the nonce is base36 alphanumerics. */
const LANE_DIR_PATTERN = /^([0-9a-f]{8})-(\d+)-([0-9a-z]+)$/;

/** Every lane directory under `<stateDir>/swarm`, unbounded and unordered; empty when the directory is absent. */
function scanLaneDirs(
	stateDir: string,
	fs: TeamsFs,
): Array<{ laneId: string; stateDir: string; index: number; nonce: string; mtimeMs: number }> {
	const swarmDir = join(stateDir, "swarm");
	let names: string[] = [];
	try {
		names = fs.readdirSync(swarmDir);
	} catch {
		return [];
	}
	const lanes: Array<{
		laneId: string;
		stateDir: string;
		index: number;
		nonce: string;
		mtimeMs: number;
	}> = [];
	for (const name of names) {
		const match = LANE_DIR_PATTERN.exec(name);
		if (!match) continue;
		const full = join(swarmDir, name);
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(full).mtimeMs;
		} catch {
			// reason: an entry that vanished mid-scan still counts, just as the oldest
		}
		lanes.push({
			laneId: name,
			stateDir: full,
			index: Number.parseInt(match[2]!, 10),
			nonce: match[3]!,
			mtimeMs,
		});
	}
	return lanes;
}

/**
 * Discover recently spawned lanes under a host state directory: every `swarm/<sha8>-<i>-<nonce>`
 * subdirectory becomes a lane labelled by its full basename, ordered by lane index (then nonce). Discovery
 * is bounded to the {@link MAX_DISCOVERED_LANES} most recent directories by mtime, so history never floods
 * a status reply; the count of older lanes it hid is returned as `omitted`, because those lanes may still
 * be running and must not disappear silently.
 */
export function laneDirs(stateDir: string, fs: TeamsFs = defaultFs): LaneDiscovery {
	const lanes = scanLaneDirs(stateDir, fs);
	lanes.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const kept = lanes.slice(0, MAX_DISCOVERED_LANES);
	return {
		lanes: kept
			.sort((a, b) => a.index - b.index || a.nonce.localeCompare(b.nonce))
			.map(({ laneId, stateDir: dir }) => ({ laneId, stateDir: dir })),
		omitted: lanes.length - kept.length,
	};
}

/** Default liveness: signal 0. EPERM means the pid exists under another user, so it is alive (and never ours). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Parse `ps -o etime=` (`[[dd-]hh:]mm:ss`) into elapsed seconds; undefined when it is not that shape. */
export function parseEtimeSeconds(raw: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw.trim());
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match;
	return (
		((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)
	);
}

function psElapsedSeconds(pid: number): number | undefined {
	try {
		const out = nodeExecFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2_000,
			env: scrubbedEnv(process.env),
			stdio: ["ignore", "pipe", "ignore"],
		});
		return parseEtimeSeconds(out);
	} catch {
		return undefined;
	}
}

/**
 * The non-Linux recycled-pid gate: the pid must be alive AND its process start (now minus `ps` elapsed time)
 * must sit within {@link START_TIME_TOLERANCE_MS} of the lane's recorded `startedAt`. A dead pid or a start
 * outside the tolerance is a `mismatch`; an unreadable start time (or an unparseable `startedAt`) is `unknown`.
 */
export function signalAliveMatchingStart(
	pid: number,
	startedAt: string,
	deps: {
		alive?: PidAlive;
		etimeSeconds?: (pid: number) => number | undefined;
		now?: () => number;
	} = {},
): LaneVerdict {
	if (!(deps.alive ?? pidAlive)(pid)) return "mismatch";
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return "unknown";
	const elapsed = (deps.etimeSeconds ?? psElapsedSeconds)(pid);
	if (elapsed === undefined) return "unknown";
	const processStart = (deps.now ?? Date.now)() - elapsed * 1000;
	return Math.abs(processStart - started) <= START_TIME_TOLERANCE_MS ? "match" : "mismatch";
}

/** The recycled-pid gate seam: what a lane's recorded pid is, as a {@link LaneVerdict}. */
export type LaneVerify = (record: LaneRecord) => LaneVerdict;

/** The recycled-pid gate every default path uses: `verifyLaneProcess` with the start-time-aware fallback. */
function defaultVerify(record: LaneRecord): LaneVerdict {
	return verifyLaneProcess(record, { signalAlive: signalAliveMatchingStart });
}

/**
 * A lane is live when its recorded pid is alive and not provably someone else's: an `unknown` verdict (an
 * unreadable /proc) keeps the lane counted and listed, because a running lane must never be forgotten for
 * want of a readable file. Only `mismatch` (a recycled pid) frees it. Never throws.
 */
function isLaneLive(record: LaneRecord, isAlive: PidAlive, verify: LaneVerify): boolean {
	try {
		return isAlive(record.pid) && verify(record) !== "mismatch";
	} catch {
		return false;
	}
}

/** The Swarm classifier seam: the exact lane text in, Swarm's own verdict out. */
export type LaneClassify = (text: string) => Promise<ClassifyVerdict>;

/** A {@link LaneClassify} bound to a swarm checkout; this is what the host uses unless a test injects another. */
export function swarmClassifier(swarmRoot: string): LaneClassify {
	return (text) => preflightClassify(text, { swarmRoot });
}

/**
 * Preflight every plan on its exact final `laneBrief` (brief plus pstack block). `sdlc` keeps the plan, `skip`
 * refuses it with {@link SKIP_REFUSAL}, and `unknown` (the classifier could not answer, or threw) keeps the
 * plan and adds {@link CLASSIFIER_UNAVAILABLE_NOTE} once. Never throws.
 */
export async function filterSpawnable(
	plans: LanePlan[],
	classify: LaneClassify,
): Promise<{
	spawn: LanePlan[];
	refused: Array<{ laneId: string; reason: string }>;
	notes: string[];
}> {
	const verdicts = await Promise.all(
		plans.map(async (plan): Promise<ClassifyVerdict> => {
			try {
				return await classify(plan.laneBrief);
			} catch {
				return { kind: "unknown", reason: "classifier could not start" };
			}
		}),
	);
	const spawn: LanePlan[] = [];
	const refused: Array<{ laneId: string; reason: string }> = [];
	const notes: string[] = [];
	for (const [index, plan] of plans.entries()) {
		const verdict = verdicts[index]!;
		if (verdict.kind === "skip") {
			refused.push({ laneId: plan.id, reason: SKIP_REFUSAL });
			continue;
		}
		spawn.push(plan);
		if (verdict.kind === "unknown" && !notes.includes(CLASSIFIER_UNAVAILABLE_NOTE))
			notes.push(CLASSIFIER_UNAVAILABLE_NOTE);
	}
	return { spawn, refused, notes };
}

/**
 * Refuse plans before spawn: a brief already running in this cwd (`already running as <laneId>`), and
 * everything past the live-lane cap. The live set is every lane dir under `stateDir` whose `lane.json` parses,
 * whose pid is alive and that `verify` still attributes to the lane; dead pids, recycled pids and missing or
 * malformed `lane.json` are not counted. The cap counts live lanes across all commands, not per command.
 */
export function refuseDuplicatesAndOverCap(
	plans: readonly LanePlan[],
	stateDir: string,
	cwd: string,
	cap: number,
	isAlive: PidAlive,
	verify: LaneVerify = defaultVerify,
	fs: TeamsFs = defaultFs,
): { spawn: LanePlan[]; refused: Array<{ laneId: string; reason: string }> } {
	const live = liveLanes(scanLaneDirs(stateDir, fs), isAlive, fs).filter((record) =>
		isLaneLive(record, isAlive, verify),
	);
	const spawn: LanePlan[] = [];
	const refused: Array<{ laneId: string; reason: string }> = [];
	for (const plan of plans) {
		const duplicate = findDuplicate(cwd, briefDigest(plan.brief), live);
		if (duplicate !== undefined) {
			refused.push({
				laneId: plan.id,
				reason: `already running as ${duplicate.laneId} (pid ${duplicate.pid}) in ${cwd}; ${STOP_HINT} to replace it`,
			});
			continue;
		}
		if (live.length + spawn.length >= cap) {
			refused.push({
				laneId: plan.id,
				reason:
					live.length >= cap
						? capRefusal(live, cap)
						: `Swarm lane cap reached: ${live.length} live plus ${spawn.length} starting lane(s), limit ${cap} (ULTRATHINK_SWARM_MAX_LANES); ${STOP_HINT}.`,
			});
			continue;
		}
		spawn.push(plan);
	}
	return { spawn, refused };
}

/**
 * Grace between SIGTERM and SIGKILL: Swarm's own `SWARM_AUTONOMOUS_RUN_GRACE_S` (seconds) when it is a finite
 * number >= 0, else exactly 15 s. Unset or blank means the default; no other cap applies.
 */
export function stopGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.SWARM_AUTONOMOUS_RUN_GRACE_S?.trim();
	if (!raw) return STOP_GRACE_DEFAULT_MS;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : STOP_GRACE_DEFAULT_MS;
}

/**
 * Turn a `stop` target into lanes. `all` is every live, verified lane (nothing live is a reason); a lane id
 * matches exactly, else by unique prefix, and is returned even when finished so `stopLanes` can say so.
 */
export function resolveStopTargets(
	target: string,
	lanes: readonly LaneRef[],
	deps: { isAlive?: PidAlive; verify?: LaneVerify; fs?: LaneFileFs } = {},
): { targets: LaneRef[] } | { reason: string } {
	if (target === "all") {
		const live = lanes.filter((lane) => {
			const record = readLaneFile(lane.stateDir, deps.fs);
			return (
				record !== undefined &&
				isLaneLive(record, deps.isAlive ?? pidAlive, deps.verify ?? defaultVerify)
			);
		});
		return live.length === 0 ? { reason: "no live swarm lanes to stop" } : { targets: live };
	}
	const exact = lanes.filter((lane) => lane.laneId === target);
	const matches = exact.length > 0 ? exact : lanes.filter((lane) => lane.laneId.startsWith(target));
	if (matches.length === 1) return { targets: matches };
	const shown = oneLine(target, 60);
	if (matches.length === 0) return { reason: `no swarm lane matches ${shown}` };
	return {
		reason: `${shown} matches ${matches.length} lanes (${matches.map((lane) => lane.laneId).join(", ")}); give a longer id`,
	};
}

/**
 * Stop lanes: for each, verify the recorded pid still belongs to the lane, SIGTERM its process group
 * (`kill(-pid)`; lanes are group leaders because they spawn detached), then poll the same verification every
 * {@link STOP_POLL_MS} through `waitMs` until the lane is gone or the grace elapses, and SIGKILL the group
 * when the lane is still verifiably the lane. Every signal is preceded by a fresh verification with nothing
 * awaited in between: a `mismatch` (a recycled pid) is reported and never signalled, and so is an `unknown`
 * (an unreadable /proc), which is reported as unverifiable rather than as gone. A missing record is reported.
 * Lanes stop concurrently; one line per lane comes back in target order.
 */
export async function stopLanes(
	targets: readonly LaneRef[],
	opts: {
		kill: (pid: number, signal: string) => void;
		waitMs: (ms: number) => Promise<void>;
		readCmdline?: (pid: number) => string | undefined;
		readStat?: (pid: number) => string | undefined;
		readBootTimeSec?: () => number | undefined;
		signalAlive?: (pid: number, startedAt: string) => LaneVerdict;
		isAlive?: PidAlive;
		platform?: string;
		graceMs?: number;
		env?: NodeJS.ProcessEnv;
		fs?: LaneFileFs;
	},
): Promise<string[]> {
	const graceMs = opts.graceMs ?? stopGraceMs(opts.env ?? process.env);
	const isAlive = opts.isAlive ?? pidAlive;
	/** A fresh look at the recorded pid: `gone` when it is not alive, else the verification (a throw is `unknown`). */
	const check = (record: LaneRecord): LaneVerdict | "gone" => {
		try {
			if (!isAlive(record.pid)) return "gone";
			return verifyLaneProcess(record, {
				readCmdline: opts.readCmdline,
				readStat: opts.readStat,
				readBootTimeSec: opts.readBootTimeSec,
				signalAlive: opts.signalAlive ?? signalAliveMatchingStart,
				platform: opts.platform,
			});
		} catch {
			return "unknown";
		}
	};
	const signal = (pid: number, name: string): string | undefined => {
		try {
			opts.kill(-pid, name);
			return undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return "gone";
			return error instanceof Error ? error.message.slice(0, 120) : "signal failed";
		}
	};
	const stopOne = async (lane: LaneRef): Promise<string> => {
		const record = readLaneFile(lane.stateDir, opts.fs);
		if (record === undefined) return `${lane.laneId}: not-planned, nothing to stop`;
		const refusal = (verdict: "mismatch" | "unknown"): string =>
			verdict === "mismatch"
				? `${lane.laneId}: pid ${record.pid} no longer belongs to the lane — ignored`
				: `${lane.laneId}: could not verify pid ${record.pid}; not signalled`;
		const first = check(record);
		if (first === "gone") return `${lane.laneId}: already exited`;
		if (first !== "match") return refusal(first);
		const term = signal(record.pid, "SIGTERM");
		if (term === "gone") return `${lane.laneId}: already exited`;
		if (term !== undefined) return `${lane.laneId}: could not stop pid ${record.pid} (${term})`;
		// Poll instead of sleeping the whole grace: a lane that exits on SIGTERM must not be waited on.
		for (let waited = 0; waited < graceMs; ) {
			const step = Math.min(STOP_POLL_MS, graceMs - waited);
			await opts.waitMs(step);
			waited += step;
			const now = check(record);
			if (now === "gone" || now === "mismatch") return `${lane.laneId}: stopped (SIGTERM)`;
		}
		const last = check(record);
		if (last === "gone" || last === "mismatch") return `${lane.laneId}: stopped (SIGTERM)`;
		if (last === "unknown") return refusal(last);
		const kill = signal(record.pid, "SIGKILL");
		if (kill === "gone") return `${lane.laneId}: stopped (SIGTERM)`;
		if (kill !== undefined) return `${lane.laneId}: could not kill pid ${record.pid} (${kill})`;
		return `${lane.laneId}: stopped (SIGKILL after ${graceMs} ms)`;
	};
	return Promise.all(targets.map(stopOne));
}

/** Untrusted lane-written text rendered as data: control characters and runs of whitespace become one space. */
function oneLine(text: string, max: number): string {
	return text
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

/** What a lane's own `autonomous.log` says (written once, at the end of the run). */
type LaneLog =
	| { kind: "duplicate"; digest: string }
	| { kind: "plan-failed"; code?: string; message?: string }
	| { kind: "ran"; runRc?: number }
	| { kind: "unreadable" };

/** Parse `autonomous.log`: the plain `skip duplicate <digest>` line, or the JSON record. Never throws. */
function parseLaneLog(text: string): LaneLog {
	const trimmed = text.trim();
	const lastLine = trimmed.split("\n").at(-1)?.trim() ?? "";
	const duplicate = /^skip duplicate (\S+)$/.exec(lastLine);
	if (duplicate) return { kind: "duplicate", digest: duplicate[1]! };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { kind: "unreadable" };
	}
	if (!isRecord(parsed)) return { kind: "unreadable" };
	const error = parsed.error;
	if (parsed.skipped_run === true || (error !== undefined && error !== null)) {
		const fromRecord = isRecord(error);
		const code = fromRecord && typeof error.code === "string" ? error.code : undefined;
		const message = fromRecord
			? typeof error.message === "string"
				? error.message
				: undefined
			: typeof error === "string"
				? error
				: undefined;
		return { kind: "plan-failed", code, message };
	}
	return { kind: "ran", runRc: typeof parsed.run_rc === "number" ? parsed.run_rc : undefined };
}

/** A lane-local file read: undefined when absent or unreadable. */
function readText(path: string, fs: LaneFileFs): string | undefined {
	try {
		return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/** `orch_status` per-state counts, when the body carries a well-formed `counts` object. */
function readCounts(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const counts: Record<string, number> = {};
	for (const [state, count] of Object.entries(value)) {
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return undefined;
		counts[oneLine(state, 40)] = count;
	}
	return counts;
}

/** Which fields a lane status probe may use beyond the Task Store probe itself. */
interface LaneProbeDeps {
	/** Whether a recorded pid is alive; defaults to signal 0. */
	isAlive?: PidAlive;
	/** The recycled-pid gate; defaults to the `autonomous_run.py` cmdline and start-time check (start time alone off Linux). */
	verify?: LaneVerify;
	fs?: TeamsFs;
}

/**
 * Report every lane's real state through `runFn` (the injected `orch_status.py` probe) plus the lane's own
 * files: `lane.json` (liveness), `latest_correlation` and `autonomous.log`. Probes run concurrently but at
 * most {@link LANE_STATUS_CONCURRENCY} at a time, rows come back in input order, and every failure (a failed
 * probe, bad JSON, a throwing one) is an error row for that lane alone. Done-ness is only ever what
 * `orch_status` reports as `complete`.
 */
export async function laneStatus(
	lanes: readonly LaneRef[],
	runFn: LaneStatusProbe,
	deps: LaneProbeDeps = {},
): Promise<LaneStatusRow[]> {
	const results = new Array<LaneStatusRow>(lanes.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			if (index >= lanes.length) return;
			next += 1;
			results[index] = await probeLane(lanes[index]!, runFn, deps);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(LANE_STATUS_CONCURRENCY, lanes.length) }, () => worker()),
	);
	return results;
}

/**
 * Probe one lane and fold its files and Task Store into one of seven states; every failure mode stays
 * lane-local. Order: live pid with no plan yet is `planning`; live and unfinished is `running`; a finished
 * lane is `skipped` (duplicate), `plan-failed` (its log), `done` (`complete`), or `attention`; no plan and no
 * process is `not-planned`.
 */
async function probeLane(
	lane: LaneRef,
	runFn: LaneStatusProbe,
	deps: LaneProbeDeps,
): Promise<LaneStatusRow> {
	const fs = deps.fs ?? defaultFs;
	const logPath = join(lane.stateDir, "run.log");
	const record = readLaneFile(lane.stateDir, fs);
	const live =
		record !== undefined &&
		isLaneLive(record, deps.isAlive ?? pidAlive, deps.verify ?? defaultVerify);
	const correlation = (readText(join(lane.stateDir, "latest_correlation"), fs) ?? "").trim();
	const logText = readText(join(lane.stateDir, "autonomous.log"), fs);
	const log = logText === undefined || logText.trim() === "" ? undefined : parseLaneLog(logText);
	const graphId = record?.graphId === undefined ? undefined : oneLine(record.graphId, 80);
	const errorRow = (error: string): LaneStatusRow => ({ laneId: lane.laneId, logPath, error });
	const row = (
		state: LaneState,
		text: string,
		extra: {
			total?: number;
			byState?: Record<string, number>;
			done?: number;
			detail?: string;
		} = {},
	): LaneStatusRow => ({
		laneId: lane.laneId,
		logPath,
		state,
		summary: `${lane.laneId}: ${state} — ${text}`,
		total: extra.total ?? 0,
		byState: extra.byState ?? {},
		done: extra.done ?? 0,
		...(graphId === undefined ? {} : { graphId }),
		...(extra.detail === undefined ? {} : { detail: extra.detail }),
	});

	if (live && correlation === "")
		return row("planning", "waiting for the plan (no correlation yet)");
	if (!live && log?.kind === "duplicate") {
		const digest = oneLine(log.digest, 16);
		return row("skipped", `duplicate of an earlier run (digest ${digest})`, {
			detail: `skip duplicate ${digest}`,
		});
	}
	if (!live && log?.kind === "plan-failed") {
		const message = log.message === undefined ? undefined : oneLine(log.message, 120);
		const code = log.code === undefined ? undefined : oneLine(log.code, 60);
		const why = code ?? message ?? "no error code recorded";
		return row(
			"plan-failed",
			message !== undefined && code !== undefined ? `${code}: ${message}` : why,
			{
				detail: why,
			},
		);
	}
	if (correlation === "") {
		return row(
			"not-planned",
			log?.kind === "unreadable"
				? "no plan and no running process; autonomous.log is unreadable"
				: "no plan, no running process, no log",
		);
	}

	let probe: { stdout: string } | { error: string };
	try {
		probe = await runFn(lane.stateDir);
	} catch (error) {
		return errorRow(error instanceof Error ? error.message.slice(0, 200) : "status probe failed");
	}
	if ("error" in probe) return errorRow(probe.error);
	let parsed: unknown;
	try {
		parsed = JSON.parse(probe.stdout) as unknown;
	} catch {
		return errorRow("unreadable status output (not JSON)");
	}
	if (isRecord(parsed) && isRecord(parsed.error)) {
		const code = typeof parsed.error.code === "string" ? oneLine(parsed.error.code, 60) : "unknown";
		const message =
			typeof parsed.error.message === "string" ? oneLine(parsed.error.message, 160) : "";
		return errorRow(`orch_status refused (${code})${message ? `: ${message}` : ""}`);
	}
	const tasks = isRecord(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : undefined;
	let byState = isRecord(parsed) ? readCounts(parsed.counts) : undefined;
	if (byState === undefined && tasks !== undefined) {
		byState = {};
		for (const task of tasks) {
			let state = "UNKNOWN";
			if (isRecord(task) && typeof task.state === "string") state = oneLine(task.state, 40);
			byState[state] = (byState[state] ?? 0) + 1;
		}
	}
	if (byState === undefined || !isRecord(parsed)) return errorRow("status output had no task list");
	const total = Object.values(byState).reduce((sum, count) => sum + count, 0);
	const counts = Object.entries(byState)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	const complete = parsed.complete === true;
	const progress =
		total === 0 ? "no tasks yet" : `${total} task${total === 1 ? "" : "s"} — ${counts}`;
	if (live && !complete) return row("running", progress, { total, byState });
	if (complete) return row("done", progress, { total, byState, done: total });
	const reasons: string[] = [];
	for (const [state, count] of Object.entries(byState)) {
		if (Object.hasOwn(ATTENTION_TASK_STATES, state) && count > 0) reasons.push(`${count} ${state}`);
	}
	if (Array.isArray(parsed.escalated) && parsed.escalated.length > 0 && !("ESCALATED" in byState))
		reasons.push(`${parsed.escalated.length} ESCALATED`);
	const runRc = log?.kind === "ran" ? log.runRc : undefined;
	if (runRc !== undefined && runRc !== 0 && runRc !== 1)
		reasons.push(`run exited with code ${runRc}`);
	if (reasons.length === 0) reasons.push("no live lane process and the tasks are unfinished");
	return row("attention", `${reasons.join(", ")} (${progress})`, {
		total,
		byState,
		detail: reasons.join(", "),
	});
}

const execFileP = promisify(nodeExecFile);

/**
 * Default probe seam: promisified `execFile`, so a slow or hung `orch_status.py` never blocks the host's
 * hot path. A non-zero exit still surfaces whatever the probe printed, in `stdout`/`stderr`.
 */
const defaultStatusSpawn: OrchStatusSpawn = async (cmd, args, opts) => {
	try {
		const { stdout, stderr } = await execFileP(cmd, args as string[], {
			...opts,
			encoding: "utf8",
		});
		return { stdout, stderr };
	} catch (error) {
		const err = error as (Error & { stdout?: unknown; stderr?: unknown }) | undefined;
		return {
			stdout: typeof err?.stdout === "string" ? err.stdout : "",
			stderr:
				(typeof err?.stderr === "string" ? err.stderr : "") || (err?.message ?? String(error)),
		};
	}
};

/**
 * Build the default probe for {@link laneStatus}: `orch_status.py --json --repo <cwd>` against the lane's
 * `SWARM_DIR`, capped at {@link ORCH_STATUS_TIMEOUT_MS}, run off the hot path through an injected async
 * seam. A probe that exits non-zero but printed JSON still reads; only missing output or a hard error is a
 * failure.
 */
export function orchStatusRunner(
	opts: { swarmRoot: string; cwd: string; env?: NodeJS.ProcessEnv },
	spawnFn: OrchStatusSpawn = defaultStatusSpawn,
): LaneStatusProbe {
	return async (stateDir) => {
		try {
			const result = await spawnFn(
				"python3",
				[join(opts.swarmRoot, "scripts", "orch_status.py"), "--json", "--repo", opts.cwd],
				{
					cwd: opts.cwd,
					env: { ...scrubbedEnv(opts.env), SWARM_DIR: stateDir },
					timeout: ORCH_STATUS_TIMEOUT_MS,
				},
			);
			if (typeof result.stdout === "string" && result.stdout.trim())
				return { stdout: result.stdout };
			const raw = result.error ? result.error.message : (result.stderr ?? "");
			const detail = raw.replace(/\s+/g, " ").trim().slice(0, 200) || "no output";
			return { error: `orch_status.py probe failed: ${detail}` };
		} catch (error) {
			return {
				error: `orch_status.py probe failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	};
}

/** The spawn reply: how many lanes started, where each one's state and log live, and any failed lane. */
export function formatLaneHandles(handles: readonly LaneHandle[]): string {
	if (handles.length === 0) return "No swarm lanes spawned.";
	const started = handles.filter((handle) => !handle.error).length;
	const lines = handles.map((handle) =>
		handle.error
			? `${handle.laneId}: failed to start — ${handle.error}`
			: `${handle.laneId}: pid ${handle.pid} · ${handle.stateDir}\n    log ${handle.logPath}${handle.note ? `\n    note ${handle.note}` : ""}`,
	);
	return [`Swarm lanes: ${started}/${handles.length} spawned`, ...lines].join("\n");
}

/**
 * The status reply: one summary per lane labelled by its state directory, with the log path; errors in
 * place of counts. When discovery hid older lanes behind its recency bound, a trailing line names the
 * omitted count instead of letting running lanes vanish from the report.
 */
export function formatLaneStatusText(rows: readonly LaneStatusRow[], omitted = 0): string {
	if (rows.length === 0 && omitted === 0)
		return "No swarm lanes found under this state directory yet.";
	const lines = rows.map((row) =>
		"error" in row
			? `${row.laneId}: ${row.error}\n    log ${row.logPath}`
			: `${row.summary}${row.graphId ? `\n    graph ${row.graphId}` : ""}\n    log ${row.logPath}`,
	);
	if (omitted > 0)
		lines.push(
			`${omitted} older lane${omitted === 1 ? "" : "s"} not shown — raise ULTRATHINK_SWARM_MAX_LANES-scoped discovery or prune <stateDir>/swarm`,
		);
	return lines.join("\n");
}

/** One GenUI card lane: the planned brief, where its state and log live, and how (or whether) it started. */
export interface SwarmLaneCard {
	laneId: string;
	brief: string;
	stateDir: string;
	logPath: string;
	pid?: number;
	error?: string;
}

/** The spawn reply as a card snapshot: how many lanes started out of how many planned, one card per lane. */
export interface SwarmSpawnCardSnapshot {
	spawned: number;
	total: number;
	lanes: SwarmLaneCard[];
}

/** One status card lane: the lane's own summary line, state and counts, or the probe error in their place; both carry the run log path. */
export type SwarmStatusLane =
	| {
			laneId: string;
			summary: string;
			logPath: string;
			done: number;
			total: number;
			state?: LaneState;
			graphId?: string;
	  }
	| { laneId: string; summary: string; logPath: string; error: string };

/** The status reply as a card snapshot, plus how many discovered lanes the recency bound hid. */
export interface SwarmStatusCardSnapshot {
	lanes: SwarmStatusLane[];
	omitted: number;
}

/**
 * Project spawn results into a card snapshot: each handle joins its plan by position, so the lane card
 * carries the plan's display brief plus the handle's state dir, log path, pid, or start error. A plain
 * projection — text sanitization stays at render time, and nothing here touches fs or env.
 */
export function toSwarmSpawnCard(
	handles: readonly LaneHandle[],
	plans: readonly LanePlan[],
): SwarmSpawnCardSnapshot {
	return {
		spawned: handles.filter((handle) => handle.pid !== undefined).length,
		total: plans.length,
		lanes: handles.map((handle, i) => ({
			laneId: handle.laneId,
			brief: plans[i]?.brief ?? handle.laneId,
			stateDir: handle.stateDir,
			logPath: handle.logPath,
			...(handle.pid === undefined ? {} : { pid: handle.pid }),
			...(handle.error === undefined ? {} : { error: handle.error }),
		})),
	};
}

/**
 * Project status rows into a card snapshot: a probed lane keeps its own summary and counts; a failed probe
 * becomes a bare error lane with empty counts; every lane carries its run log path, and the discovery
 * bound's omitted count passes through untouched.
 */
export function toSwarmStatusCard(
	rows: readonly LaneStatusRow[],
	omitted: number,
): SwarmStatusCardSnapshot {
	return {
		lanes: rows.map((row) =>
			"error" in row
				? { laneId: row.laneId, summary: "", logPath: row.logPath, error: row.error }
				: {
						laneId: row.laneId,
						summary: row.summary,
						logPath: row.logPath,
						done: row.done,
						total: row.total,
						state: row.state,
						...(row.graphId === undefined ? {} : { graphId: row.graphId }),
					},
		),
		omitted,
	};
}
