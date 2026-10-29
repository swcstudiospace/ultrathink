// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * On-disk state for the ultrathink Claude Code plugin. Hooks are one-shot
 * processes, so this lives under ~/.claude/ultrathink instead of in-session.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type LockOptions,
	errorCode,
	withFileLock,
	withLockMutation,
	writeFileAtomic,
} from "./atomic.ts";
import type { DecisionRecord } from "../decisions/types.ts";
import type { Clarification } from "../hitl/types.ts";
import { THINK_ENGINES, type ThinkEngine, type ThoughtGraph } from "../think/types.ts";
import type { TrackingRefs, TrackPlan } from "../track/types.ts";
import type { UpliftResult } from "../types.ts";
import type { SkillInvocation } from "../uplift/skill.ts";
import type { ModelResolution } from "../host/engine.ts";
import { resolveStateDir } from "../host/paths.ts";
import type { ShipState } from "../ship/types.ts";
import { readJson } from "../shared.ts";
import type { KnowledgeLookup } from "../greptile/knowledge.ts";
import type { DocsLookup } from "../ragflow/types.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";

export interface ControlState {
	enabled?: boolean;
	thinkEnabled?: boolean;
	hitlEnabled?: boolean;
	/** Create Linear/Notion rows; overrides `track.enabled` from config. `false` also stops kickoff from creating them. */
	trackEnabled?: boolean;
	engine?: ThinkEngine;
}

export interface SessionRecord {
	sessionId: string;
	at: number;
	/** Thinking engine label: the selected route and its wire model, e.g. "claude:<model>", "<model>@<effort>" or "<shuntModel or model>@shunt". */
	engine?: string;
	/**
	 * Safe selection record (UT-Planning-ModelSelection §6) of the engine that planned this prompt: allowlisted and
	 * display-safe, never a Model, endpoint or credential. Set only on a real persisted plan; absent on older records.
	 */
	modelResolution?: ModelResolution;
	/** First engine error message (redacted), when a plan call threw; explains a fallback source. */
	engineError?: string;
	/** A successful failover this prompt, e.g. "claude:<model> → grok:<model> (plan-limit)"; not an error. */
	engineFailover?: string;
	/** Stages that fell back or failed, in run order: "uplift", "graph", "fill:<nodeId>", "think", "clarify". Absent when every stage used LLM output. */
	degraded?: string[];
	/** Host that planned this prompt. Absent on records written before multi-host support. */
	host?: string;
	result: UpliftResult;
	graph?: ThoughtGraph;
	clarifications?: Clarification[];
	plan?: TrackPlan;
	/**
	 * How many plans this session had before this one (0 for the first). It is part of the graph id, so a re-plan of the
	 * same prompt gets rows of its own instead of adopting an earlier plan's.
	 */
	generation?: number;
	/**
	 * Set true once ultrathink-kickoff has run for the plan in this record. Plan-scoped: the record holds the session's
	 * latest plan, so the next planned prompt writes a new graph with kickedOff and synced false again.
	 */
	kickedOff?: boolean;
	/** Set true once ultrathink-sync has run at least once for the plan in this record (plan-scoped, like kickedOff). */
	synced?: boolean;
	/** Tracker rows the planner created (Linear issues/sub-issues, Notion rows). */
	tracking?: TrackingRefs;
	/** The skill the user invoked; the plan covers its instruction, the skill owns the workflow. */
	skill?: { name: string; summary?: string; source: SkillInvocation["source"] };
	/** Ship lifecycle (assess -> PR -> review -> merge) after a GSD skill run. */
	ship?: ShipState;
	/** Greptile knowledge-base lookup the planner ran before the HITL clarify step. */
	knowledge?: KnowledgeLookup;
	/** Teachable Moments lessons lookup the planner ran (no lesson text). Absent on older records and when none ran. */
	lessons?: LessonsLookup;
	/** Teachable Moments skills lookup the planner ran (skill names only). Absent on older records and when none ran. */
	skills?: SkillsLookup;
	/** RAGFlow grounding lookup the planner ran (no document text). Absent on older records and when none ran. */
	docs?: DocsLookup;
	/** Jev decisions made while planning this prompt (plan, knowledge, blocking), in call order. Absent on older records and when none ran. */
	decisions?: DecisionRecord[];
	/** Repos of the files this session's edit/write tools changed (omp), sorted and unique. Attribution only; never changes the label. */
	workRepos?: string[];
	/**
	 * Set when an edited repo differs from the plan's labelled repo (`plan.task.repo`; null when the plan has none).
	 * `edited` is the full `workRepos` at that point, so a warning fires once per distinct edited set.
	 */
	repoMismatch?: { labelled: string | null; edited: string[] } | null;
}

export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
	return resolveStateDir(env);
}

/** Owner-only and atomic: a crash mid-write leaves the previous file, never a truncated one. */
function writeJson(path: string, value: unknown): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function controlPath(dir: string): string {
	return join(dir, "control.json");
}

/**
 * The toggles in control.json. A missing file is `{}`. A file whose content is not a JSON object is corrupt: the
 * flight reads `{}` (nothing is guessed from a torn file), the bad file is renamed to `control.json.corrupt-<epochMs>`
 * so it is never mistaken for state again, and `log` is told where it went. The next `writeControl` therefore
 * persists only the toggles it is asked for, never an accidental wipe made by a read failure. A file that cannot be
 * read at all (permissions, I/O) is reported and read as `{}` but left in place: it may read fine next time. With
 * `strict` (the read inside `writeControl`'s lock) such a failure throws instead, so a write never builds on `{}`.
 */
export function readControl(
	dir: string,
	opts: { log?: (message: string) => void; strict?: boolean } = {},
): ControlState {
	const path = controlPath(dir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			if (opts.strict)
				throw new Error(
					`control.json could not be read (${errorCode(error) ?? String(error)}); nothing was written, so the other toggles are kept. Fix ${path} and retry`,
					{ cause: error },
				);
			opts.log?.(`control.json unreadable, using no toggles for this prompt: ${String(error)}`);
		}
		return {};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// reason: a torn or hand-damaged file is quarantined below
		raw = undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		quarantineControl(path, opts.log);
		return {};
	}
	const rec = raw as Record<string, unknown>;
	const out: ControlState = {};
	if (typeof rec.enabled === "boolean") out.enabled = rec.enabled;
	if (typeof rec.thinkEnabled === "boolean") out.thinkEnabled = rec.thinkEnabled;
	if (typeof rec.hitlEnabled === "boolean") out.hitlEnabled = rec.hitlEnabled;
	if (typeof rec.trackEnabled === "boolean") out.trackEnabled = rec.trackEnabled;
	if (THINK_ENGINES.includes(rec.engine as ThinkEngine)) out.engine = rec.engine as ThinkEngine;
	return out;
}

/** Renames a corrupt control.json aside and says where it went; a failed rename is reported, never thrown. */
function quarantineControl(path: string, log: ((message: string) => void) | undefined): void {
	const stem = `${path}.corrupt-${Date.now()}`;
	let target = stem;
	// Several corrupt files in one millisecond must not overwrite each other's quarantine.
	for (let n = 1; existsSync(target); n++) target = `${stem}-${n}`;
	try {
		renameSync(path, target);
		log?.(
			`control.json was corrupt: moved to ${basename(target)}; this prompt runs with no toggles, so re-apply any /ultrathink on|off|think|hitl|track|engine setting`,
		);
	} catch (error) {
		log?.(`control.json is corrupt and could not be moved aside: ${String(error)}`);
	}
}

/**
 * Merges `patch` into control.json under the file's lock, so two toggles never undo each other. A held lock is waited
 * for up to 30 s and then reported as a `LockTimeoutError`: a toggle is never written without the lock, because that is
 * how a concurrent toggle is lost. A hook path that prefers an unlocked write over a failure passes
 * `{ onTimeout: "run-unlocked" }`.
 */
export function writeControl(dir: string, patch: ControlState, lock?: LockOptions): ControlState {
	// The lock file lives next to control.json, so the directory must exist before the lock is taken.
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// reason: writeJson reports the same failure below
	}
	return withFileLock(
		controlPath(dir),
		() => {
			const next = { ...readControl(dir, { log: lock?.log, strict: true }), ...patch };
			writeJson(controlPath(dir), next);
			return next;
		},
		{ timeoutMs: 30_000, onTimeout: "throw", ...lock },
	);
}

/** A plain session id keeps its name: lowercase, letters, digits, `_`, `.`, `-`, at most 120 characters. */
const PLAIN_SESSION_ID_RE = /^[a-z0-9_.-]{1,120}$/;

/**
 * The file-name stem of a session id. Host ids are case-sensitive and may hold characters a file name cannot, and macOS
 * and Windows ignore case: `Claude-A` and `claude-a` would then share one record and one skip flag. A plain id keeps its
 * name; any other id gets a readable lowercase slug plus a hash of the exact id after `~`, which a plain id never holds.
 * Every stem is lowercase, and distinct ids get distinct stems.
 */
function safeSessionId(id: string): string {
	if (PLAIN_SESSION_ID_RE.test(id)) return id;
	const slug = Array.from(id, (char) => (/[A-Za-z0-9_.-]/.test(char) ? char.toLowerCase() : "_"))
		.join("")
		.slice(0, 80);
	return `${slug}~${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/**
 * The host's session id, trimmed, or undefined when it names no session: blank, or Prime Agent's `unknown` placeholder
 * for a kernel with no session. Such a prompt gets its own turn id, never a record or skip flag shared by every prompt.
 */
export function hostSessionId(id: string | undefined): string | undefined {
	const trimmed = id?.trim();
	return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

export function sessionPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${safeSessionId(sessionId)}.json`);
}

/**
 * Where earlier builds wrote this id's record: the id with characters a file name cannot hold replaced by `_`, its case
 * kept. Only read as a fallback; a record found there is used only when its stored sessionId is this id, since on a
 * case-insensitive file system `Claude-A.json` is also `claude-a.json`.
 */
export function legacySessionPath(dir: string, sessionId: string): string {
	return join(
		dir,
		"sessions",
		`${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unknown"}.json`,
	);
}

/**
 * The file that holds this session's record: its current name, or the earlier name when only that file exists and names
 * this id. Otherwise the current name, which may not exist yet.
 */
export function sessionRecordPath(dir: string, sessionId: string): string {
	const current = sessionPath(dir, sessionId);
	if (existsSync(current)) return current;
	const legacy = legacySessionPath(dir, sessionId);
	if (legacy !== current && existsSync(legacy)) {
		const raw = readJson(legacy) as { sessionId?: unknown } | undefined;
		if (raw && typeof raw === "object" && raw.sessionId === sessionId) return legacy;
	}
	return current;
}

/** A fresh id for a turn whose host gave no session id: unique to that prompt, so no turn reads or writes another's state. */
export function newTurnSessionId(): string {
	return `turn-${randomUUID()}`;
}

const TURN_SESSION_RE = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTurnSessionId(id: string): boolean {
	return TURN_SESSION_RE.test(id);
}

/**
 * Path of a session's armed /ultrathink-skip. A flag file beside the session's record, not part of it: a session can be
 * skipped before its first plan writes a record. The `.skip` suffix keeps it out of the `sessions/*.json` record count.
 */
export function skipOncePath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${safeSessionId(sessionId)}.skip`);
}

export function readSkipOnce(dir: string, sessionId: string): boolean {
	return existsSync(skipOncePath(dir, sessionId));
}

export function armSkipOnce(dir: string, sessionId: string): void {
	// The session's record lock, which prune holds while it decides on and deletes a stale flag: an arm never lands between
	// that decision and its delete. A lock that cannot be taken runs unlocked, as every session write does.
	withFileLock(sessionPath(dir, sessionId), () =>
		writeFileAtomic(skipOncePath(dir, sessionId), "skip\n"),
	);
}

/** Clears the session's armed skip; an already clear session is left as it is. */
export function clearSkipOnce(dir: string, sessionId: string): void {
	try {
		unlinkSync(skipOncePath(dir, sessionId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** `engineFailover` is only ever a string; a hand-edited or corrupt record loses a non-string value. */
function dropBadFailover(record: SessionRecord): SessionRecord {
	if (record.engineFailover !== undefined && typeof record.engineFailover !== "string")
		delete record.engineFailover;
	return record;
}

export function readSession(dir: string, sessionId: string): SessionRecord | undefined {
	const raw = readJson(sessionRecordPath(dir, sessionId));
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Partial<SessionRecord>;
	// A file names its session: on a case-insensitive file system another id's record can share this file's name.
	if (rec.sessionId !== sessionId || !rec.result || typeof rec.result !== "object")
		return undefined;
	return dropBadFailover(rec as SessionRecord);
}

const LAST_LOCK_WAIT_MS = 5;
/** How long a refresh waits for a live holder, by the wall clock: a loaded host stretches attempts, not this. */
const LAST_LOCK_DEADLINE_MS = 3_000;
const LAST_LOCK_STALE_MS = 5_000;
const LAST_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** Seams of {@link withLastLock}: a clock and a blocking sleep (default: `Date.now`, `Atomics.wait`). */
export interface LastLockOptions {
	now?: () => number;
	sleep?: (ms: number) => void;
}

/** True for a live PID, a fresh empty lock, or an existing lock that cannot be safely inspected. */
export function lastLockHeld(lockPath: string): boolean {
	let text: string;
	try {
		text = readFileSync(lockPath, "utf8").trim();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	if (!text) {
		try {
			return Date.now() - statSync(lockPath).mtimeMs <= LAST_LOCK_STALE_MS;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ENOENT";
		}
	}
	const pid = Number(text);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Exclusive lock for `last.json`. A busy lock does not run `body`: replacing the current plan is worse than
 * leaving the previous copy, so this does not degrade to an unlocked write the way `withFileLock` does.
 * Returns false when the lock cannot be taken within 3 s of wall-clock time. A dead pid is reclaimed immediately and
 * an empty lock after 5s; a live pid stays protected regardless of the lock's age.
 */
export function withLastLock(
	lastPath: string,
	body: () => void,
	opts: LastLockOptions = {},
): boolean {
	const lockPath = `${lastPath}.lock`;
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => void Atomics.wait(LAST_LOCK_SLEEP, 0, 0, ms));
	const deadline = now() + LAST_LOCK_DEADLINE_MS;
	let fd: number | undefined;
	for (let waiting = true; waiting && fd === undefined; ) {
		try {
			fd = withLockMutation(lockPath, () => {
				if (lastLockHeld(lockPath)) return undefined;
				try {
					unlinkSync(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const opened = openSync(lockPath, "wx", 0o600);
				try {
					writeFileSync(opened, String(process.pid));
					return opened;
				} catch (error) {
					closeSync(opened);
					unlinkSync(lockPath);
					throw error;
				}
			});
		} catch {
			return false;
		}
		if (fd !== undefined) break;
		waiting = now() < deadline;
		if (waiting) sleep(LAST_LOCK_WAIT_MS);
	}
	if (fd === undefined) return false;
	const ownedFd = fd;
	try {
		body();
		return true;
	} finally {
		try {
			// Mark the opened inode complete even if another mutator temporarily owns the pathname.
			// A live host PID must not keep a finished writer held, and a successor inode is untouched.
			writeSync(ownedFd, "!", 0, "utf8");
		} catch {
			// reason: Still attempt guarded removal when the completion marker could not be written.
		}
		try {
			withLockMutation(lockPath, () => {
				const owned = fstatSync(ownedFd);
				const current = statSync(lockPath);
				if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath);
			});
		} catch {
			// reason: The next acquisition or orphan sweep can remove the completed marker under the guard.
		} finally {
			try {
				closeSync(ownedFd);
			} catch {
				/* reason: do not replace a body error with a cleanup error */
			}
		}
	}
}

export function lastRefreshMessage(lastPath: string): string {
	return `could not refresh ${lastPath}; the session was saved, but ctl last may still show the previous plan`;
}

/** Writes `record` to `path` and mirrors it to last.json. Returns a warning when `last.json` could not be refreshed (busy lock or failed write); the record file is still saved. */
function saveSessionFile(dir: string, path: string, record: SessionRecord): string | undefined {
	writeJson(path, record);
	const last = join(dir, "last.json");
	try {
		if (!withLastLock(last, () => writeJson(last, record))) return lastRefreshMessage(last);
	} catch {
		// reason: the session file is saved; a failed mirror must not drop the plan pointer the caller holds
		return lastRefreshMessage(last);
	}
	return undefined;
}

/** Writes the session. Returns a warning when `last.json` could not be refreshed; the session file is still saved. */
export function writeSession(dir: string, record: SessionRecord): string | undefined {
	return saveSessionFile(dir, sessionPath(dir, record.sessionId), record);
}

/**
 * Locked read-mutate-write of one session record (the record file and last.json). Returns the written record, or
 * undefined without writing when the record is missing or `mutate` returns undefined. `mutate` receives the path
 * readers resolve for this id (`sessionRecordPath`), so any sidecar it writes beside the JSON pairs with it. The
 * record is written back to that same path: a record still under its earlier name keeps its JSON beside its XML, and
 * never splits onto the new name. `mutate` must not write the record file itself. Without `lock` a held lock is waited for 2 s and
 * then the update runs unlocked, which can lose a concurrent update; that is reported in one line on stderr unless
 * `lock.log` takes it. A production caller passes its process kind's policy instead: `HOOK_LOCK` (hook entrypoints),
 * `CLI_LOCK` (a writer that must not lose an update) or `OMP_LOCK` (the TUI process).
 */
export function updateSession(
	dir: string,
	sessionId: string,
	mutate: (record: SessionRecord, recordPath: string) => SessionRecord | undefined,
	lock?: LockOptions,
): SessionRecord | undefined {
	const lockTarget = sessionPath(dir, sessionId);
	// No sessions directory, no record to update: nothing to lock, and no lock file could be made there to report.
	if (!existsSync(dirname(lockTarget))) return undefined;
	return withFileLock(
		lockTarget,
		() => {
			const recordPath = sessionRecordPath(dir, sessionId);
			const record = readSession(dir, sessionId);
			if (!record) return undefined;
			const next = mutate(record, recordPath);
			if (!next) return undefined;
			saveSessionFile(dir, recordPath, next);
			return next;
		},
		{ log: logUnlockedWrite, ...lock },
	);
}

function logUnlockedWrite(message: string): void {
	process.stderr.write(`[ultrathink] ${message}\n`);
}

/**
 * Lock policy of a writer outside every hook (the ultrathink-mcp and grok-bot CLIs): wait up to 30 s for a live holder, then
 * fail with a `LockTimeoutError` rather than write unlocked. A hook prefers an unlocked write over a failure and keeps the
 * default; a CLI has nobody waiting on a deadline, and an unlocked write is how a concurrent update is lost.
 */
export const CLI_LOCK: LockOptions = { timeoutMs: 30_000, onTimeout: "throw" };

/**
 * Lock policy of a hook entrypoint (its own short-lived process: `hooks/answers.ts`, `hooks/stop.ts`, `hooks/engine.ts`):
 * wait up to 15 s, then run unlocked with one logged line. A live holder's lock is never taken, so a long wait only costs
 * time when someone really holds it, and a cold worker on a loaded host no longer misses a 2 s window and loses an update.
 */
export const HOOK_LOCK: LockOptions = { timeoutMs: 15_000 };

/**
 * Lock policy of the Omp extension, which runs in the TUI process and blocks its event loop while it waits: keep the 2 s
 * bound, because freezing the TUI for 15 s is worse than the rare logged lost update.
 */
export const OMP_LOCK: LockOptions = { timeoutMs: 2_000 };

/** The node ids whose fill degraded, from the `fill:<id>` tokens of a record's `degraded` list; the tracker marks their rows. */
export function degradedNodeIds(record: Pick<SessionRecord, "degraded"> | undefined): string[] {
	return (record?.degraded ?? [])
		.filter((token) => token.startsWith("fill:"))
		.map((token) => token.slice("fill:".length));
}

/** A checkpoint's refs: everything the record already holds stays, the live refs are added over it. Never fewer refs. */
function mergeTrackingRefs(prior: TrackingRefs | undefined, live: TrackingRefs): TrackingRefs {
	const taskUrl = live.notion.taskUrl ?? prior?.notion.taskUrl;
	const linearTeam = live.linearTeam ?? prior?.linearTeam;
	// The live run owns the links still to make (it starts from the record's and removes the ones it made).
	const pendingLinks = live.pendingLinks ?? prior?.pendingLinks;
	return {
		graphId: live.graphId,
		status: "partial",
		...(linearTeam ? { linearTeam } : {}),
		linear: {
			nodes: { ...prior?.linear.nodes, ...live.linear.nodes },
			steps: { ...prior?.linear.steps, ...live.linear.steps },
		},
		notion: {
			...(taskUrl ? { taskUrl } : {}),
			nodes: { ...prior?.notion.nodes, ...live.notion.nodes },
			steps: { ...prior?.notion.steps, ...live.notion.steps },
		},
		...(pendingLinks && Object.keys(pendingLinks).length > 0 ? { pendingLinks } : {}),
		errors: [...live.errors],
		updatedAt: live.updatedAt,
	};
}

/**
 * The record mutation behind every tracking checkpoint (the `onRef` of `createTracking`): the live refs are merged over the
 * refs the record holds, so a flight killed between two rows keeps the rows made so far. Run it under the record's lock
 * (`updateSession`, or the CLI's locked update). A record that now holds another plan's graph is left alone.
 */
export function trackingCheckpoint(
	graphId: string,
	live: TrackingRefs,
): (record: SessionRecord) => SessionRecord | undefined {
	return (current) =>
		current.plan?.graphId === graphId
			? {
					...current,
					tracking: mergeTrackingRefs(
						current.tracking?.graphId === graphId ? current.tracking : undefined,
						live,
					),
				}
			: undefined;
}

export function readLast(dir: string): SessionRecord | undefined {
	const raw = readJson(join(dir, "last.json"));
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Partial<SessionRecord>;
	if (!rec.result || typeof rec.result !== "object") return undefined;
	return dropBadFailover(rec as SessionRecord);
}
