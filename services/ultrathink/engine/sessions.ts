// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Read-only listing of the sessions a connector's state directory holds. A session can live in three places, all
 * keyed by the same id: a server job (`jobs/<id>.json`, written by the headless planner), a client-driven journal
 * (`journal/<id>/meta.json`, written by the grok-bot adapter) and a plan record (`sessions/<id>.json`). A session is
 * listed only when a job or a journal supplies its status: a plan record alone cannot be served by ultrathink_result,
 * so it only enriches the goal and counts of a session found elsewhere. Only summaries leave this module: a one-line
 * goal, counts and a status. Prompts, specifications, answers and error text stay on disk.
 */
import { type Dir, lstatSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger, failureLabel, type Logger } from "../obs/log.ts";
import { isFallbackGraph } from "../../../src/think/graph.ts";
import type { ThoughtGraph } from "../../../src/think/types.ts";
import { isSessionId } from "./journal.ts";

type SessionStatus = "running" | "planned" | "failed" | "invalid" | "skipped";

export interface SessionSummary {
	sessionId: string;
	/** Server jobs report running/planned/failed/invalid/skipped; client-driven sessions report running/planned/invalid/skipped. */
	status: SessionStatus;
	mode: "server" | "client";
	/** Milliseconds since the epoch. */
	updatedAt: number;
	/** One line, at most GOAL_MAX_CHARS characters; empty when nothing safe to show exists yet. */
	goal: string;
	/**
	 * Usable graph nodes. Null when the session file was not read (larger than SUMMARY_READ_BYTES): that is not a
	 * count of zero.
	 */
	nodeCount: number | null;
	/**
	 * False only when the session file was read and had no usable graph (missing or the boilerplate fallback).
	 * Null when that file was not read, so an oversized record is not reported as having no graph.
	 */
	hasGraph: boolean | null;
}

/**
 * Who is asking, for scoping a listing. A server job is private to the principal its file names: another principal's
 * lookup never reaches it, and an owner sees every session. A session that names no principal (a job file from before
 * principals, a journal whose first run died before it was stamped, one seeded outside the service) belongs to nobody: an
 * owner sees it, and so does a caller with no principal (stdio), but no other principal does.
 * No caller at all is the stdio and legacy path, and nothing is scoped.
 */
export interface SessionCaller {
	principal: string;
	owner: boolean;
}

export const GOAL_MAX_CHARS = 120;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

/** Directory entries read per directory; a hostile or runaway directory cannot make a listing unbounded. */
const MAX_DIR_ENTRIES = 5000;
const MAX_CANDIDATES = 200;
/** Sessions read per listing, whoever they belong to: the bound on a scan that skips other principals' sessions. */
const MAX_EXAMINED = 1000;
/** Session JSON is parsed up to this size. A larger regular file keeps its mtime but is not read. */
const SUMMARY_READ_BYTES = 32 * 1024 * 1024;
/** Text is cut to this many characters before it is normalised, so a megabyte goal costs nothing. */
const GOAL_SCAN_CHARS = 2048;
const JOB_STATUSES: Record<string, true> = {
	running: true,
	planned: true,
	failed: true,
	invalid: true,
	skipped: true,
};
const JSON_SUFFIX = ".json";

interface Sources {
	id: string;
	jobMtime?: number;
	metaMtime?: number;
	recordMtime?: number;
}

interface RecordView {
	/** Goal of a usable (parsed, non-fallback) graph. */
	graphGoal: string;
	original: string;
	nodeCount: number;
	hasGraph: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function clampLimit(limit: unknown): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** First non-blank line, control characters and runs of whitespace collapsed, cut to GOAL_MAX_CHARS characters. */
function oneLine(value: unknown): string {
	if (typeof value !== "string") return "";
	const head = value.slice(0, GOAL_SCAN_CHARS);
	for (const line of head.split(/[\r\n\u2028\u2029]/)) {
		const text = line
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (text.length === 0) continue;
		if (text.length <= GOAL_MAX_CHARS) return text;
		let cut = text.slice(0, GOAL_MAX_CHARS - 1);
		// Never leave half of a surrogate pair behind.
		const last = cut.charCodeAt(cut.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
		return `${cut.trimEnd()}…`;
	}
	return "";
}

/** Names of a directory, at most MAX_DIR_ENTRIES of them; empty when the directory is missing or unreadable. */
function listNames(dir: string, logger: Logger): string[] {
	const names: string[] = [];
	let handle: Dir | undefined;
	try {
		handle = opendirSync(dir);
		for (
			let entry = handle.readSync();
			entry !== null && names.length < MAX_DIR_ENTRIES;
			entry = handle.readSync()
		)
			names.push(entry.name);
	} catch (error) {
		// reason: A partial listing is still a valid listing; a missing directory is simply empty.
		const label = failureLabel(error);
		if (label !== "ENOENT") logger.error(`listNames: ${label}`);
	} finally {
		try {
			handle?.closeSync();
		} catch {
			// reason: Nothing left to release.
		}
	}
	return names;
}

/** Modification time of a regular file that is not a symlink; undefined for symlinks, other types and stat failures. */
function fileMtime(path: string): number | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) return undefined;
		return Math.trunc(stat.mtimeMs);
	} catch {
		return undefined;
	}
}

function isRealDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

type CappedRead = { readonly kind: "text"; readonly text: string } | { readonly kind: "unread" };

/**
 * UTF-8 of a regular file at most SUMMARY_READ_BYTES long. `unread` when that file is larger, so a caller can avoid
 * treating "not parsed" as "no graph". Symlinks and non-files are undefined.
 */
function readCapped(path: string): CappedRead | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) return undefined;
		if (stat.size > SUMMARY_READ_BYTES) return { kind: "unread" };
		return { kind: "text", text: readFileSync(path, "utf8") };
	} catch {
		return undefined;
	}
}

function parseObject(text: string): Record<string, unknown> | undefined {
	try {
		const raw = JSON.parse(text) as unknown;
		return isObject(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** Every session id found in any of the three places, with the modification time of each file it was found in. */
function scan(stateDir: string, logger: Logger): Sources[] {
	const found = new Map<string, Sources>();
	const entry = (id: string): Sources => {
		let sources = found.get(id);
		if (!sources) {
			sources = { id };
			found.set(id, sources);
		}
		return sources;
	};

	const jobsDir = join(stateDir, "jobs");
	for (const name of listNames(jobsDir, logger)) {
		if (!name.endsWith(JSON_SUFFIX)) continue;
		const id = name.slice(0, -JSON_SUFFIX.length);
		if (!isSessionId(id)) continue;
		const mtime = fileMtime(join(jobsDir, name));
		if (mtime !== undefined) entry(id).jobMtime = mtime;
	}

	const journalRoot = join(stateDir, "journal");
	for (const name of listNames(journalRoot, logger)) {
		if (!isSessionId(name)) continue;
		const dir = join(journalRoot, name);
		if (!isRealDirectory(dir)) continue;
		const mtime = fileMtime(join(dir, "meta.json"));
		if (mtime !== undefined) entry(name).metaMtime = mtime;
	}

	const recordsDir = join(stateDir, "sessions");
	for (const name of listNames(recordsDir, logger)) {
		if (!name.endsWith(JSON_SUFFIX)) continue;
		const id = name.slice(0, -JSON_SUFFIX.length);
		if (!isSessionId(id)) continue;
		const mtime = fileMtime(join(recordsDir, name));
		if (mtime !== undefined) entry(id).recordMtime = mtime;
	}

	return [...found.values()];
}

/** Newest first; the id breaks ties so equal timestamps list the same way on every run. */
function byRecency(a: { id: string; time: number }, b: { id: string; time: number }): number {
	return b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function readRecord(path: string): RecordView | "unread" | undefined {
	const read = readCapped(path);
	if (read === undefined) return undefined;
	// An oversized file was not parsed. Callers must not turn that into nodeCount 0 / hasGraph false.
	if (read.kind === "unread") return "unread";
	let raw: unknown;
	try {
		raw = JSON.parse(read.text) as unknown;
	} catch {
		return undefined;
	}
	if (!isObject(raw) || !isObject(raw.result)) return undefined;
	const view: RecordView = {
		graphGoal: "",
		original:
			typeof raw.result.original === "string" ? raw.result.original.slice(0, GOAL_SCAN_CHARS) : "",
		nodeCount: 0,
		hasGraph: false,
	};
	const graph = raw.graph;
	// Nodes that are not objects mean a hand-edited or foreign file: it has no graph worth summarising.
	if (
		isObject(graph) &&
		typeof graph.goal === "string" &&
		Array.isArray(graph.nodes) &&
		graph.nodes.every(isObject) &&
		!isFallbackGraph(graph as unknown as ThoughtGraph)
	) {
		view.graphGoal = graph.goal.slice(0, GOAL_SCAN_CHARS);
		view.hasGraph = graph.nodes.length > 0;
		view.nodeCount = graph.nodes.length;
	}
	return view;
}

/** Status a client-driven session reports; the same mapping as the planner's result view. */
function clientStatus(status: unknown): SessionStatus {
	return status === "planned" || status === "invalid" || status === "skipped" ? status : "running";
}

/**
 * Whether `caller` may see a session that names `principal`. A session that names none (a job file or journal from before
 * principals, or seeded outside the service) is visible only to an owner and to a caller-less listing (stdio), the same
 * owner-only rule `cancel` applies.
 */
function visibleTo(caller: SessionCaller | undefined, principal: string | undefined): boolean {
	if (caller === undefined || caller.owner) return true;
	return principal !== undefined && principal === caller.principal;
}

/** The principal in a job file or a journal meta; undefined when the file is unreadable or names none. */
function namedPrincipal(path: string): string | undefined {
	const read = readCapped(path);
	if (read === undefined || read.kind !== "text") return undefined;
	const body = parseObject(read.text);
	return body !== undefined && typeof body.principal === "string" ? body.principal : undefined;
}

/**
 * Whether `caller` may read the session `id`: not when its job file or journal names another principal or none. A
 * session with neither file has nothing to read, so an explicit id of one resolves as before (the views report
 * not-found for an id that does not exist).
 */
export function sessionVisibleTo(
	stateDir: string,
	id: string,
	caller: SessionCaller | undefined,
): boolean {
	if (caller === undefined || caller.owner) return true;
	const jobPath = join(stateDir, "jobs", `${id}${JSON_SUFFIX}`);
	if (fileMtime(jobPath) !== undefined) return visibleTo(caller, namedPrincipal(jobPath));
	const metaPath = join(stateDir, "journal", id, "meta.json");
	// Neither file: nothing to read, and the views answer not-found.
	if (fileMtime(metaPath) === undefined) return true;
	return visibleTo(caller, namedPrincipal(metaPath));
}

function summarize(
	stateDir: string,
	sources: Sources,
	caller?: SessionCaller,
): SessionSummary | undefined {
	const { id } = sources;

	let status: SessionStatus | undefined;
	let mode: "server" | "client" = "server";
	let updatedAt = 0;
	let metaOriginal = "";
	/** The principal the winning source (job file or journal meta) names. */
	let scopedTo: string | undefined;

	if (sources.jobMtime !== undefined) {
		const read = readCapped(join(stateDir, "jobs", `${id}${JSON_SUFFIX}`));
		const job = read?.kind === "text" ? parseObject(read.text) : undefined;
		// The shape check mirrors the planner's own: a file it would refuse to serve is not listed as a job.
		if (
			job !== undefined &&
			typeof job.status === "string" &&
			Object.hasOwn(JOB_STATUSES, job.status) &&
			typeof job.updatedAt === "number" &&
			Number.isFinite(job.updatedAt)
		) {
			status = job.status as SessionStatus;
			updatedAt = job.updatedAt;
			scopedTo = typeof job.principal === "string" ? job.principal : undefined;
		}
	}

	if (status === undefined && sources.metaMtime !== undefined) {
		const read = readCapped(join(stateDir, "journal", id, "meta.json"));
		const meta = read?.kind === "text" ? parseObject(read.text) : undefined;
		if (meta !== undefined) {
			status = clientStatus(meta.status);
			mode = "client";
			updatedAt =
				typeof meta.updatedAt === "number" && Number.isFinite(meta.updatedAt)
					? meta.updatedAt
					: sources.metaMtime;
			if (typeof meta.original === "string") metaOriginal = meta.original.slice(0, GOAL_SCAN_CHARS);
			scopedTo = typeof meta.principal === "string" ? meta.principal : undefined;
		}
	}

	// A plan record with no job and no journal cannot be served by ultrathink_result, so it is not listed.
	if (status === undefined) return undefined;
	// Another principal's session is not listed, and never reads as the newest planned session.
	if (!visibleTo(caller, scopedTo)) return undefined;

	let record: RecordView | undefined;
	let recordUnread = false;
	if (sources.recordMtime !== undefined) {
		const loaded = readRecord(join(stateDir, "sessions", `${id}${JSON_SUFFIX}`));
		if (loaded === "unread") recordUnread = true;
		else record = loaded;
	}
	const goal = oneLine(record?.graphGoal) || oneLine(record?.original) || oneLine(metaOriginal);
	return {
		sessionId: id,
		status,
		mode,
		updatedAt: Math.trunc(updatedAt),
		goal,
		nodeCount: recordUnread ? null : (record?.nodeCount ?? 0),
		hasGraph: recordUnread ? null : (record?.hasGraph ?? false),
	};
}

/** Every session found, newest first by file modification time. */
function sourcesByRecency(
	stateDir: string,
	logger: Logger,
): Array<{ id: string; time: number; sources: Sources }> {
	return scan(stateDir, logger)
		.map((sources) => ({
			id: sources.id,
			time: Math.max(sources.jobMtime ?? 0, sources.metaMtime ?? 0, sources.recordMtime ?? 0),
			sources,
		}))
		.sort(byRecency);
}

/**
 * Visits sessions newest first and hands `visit` the summary of each one the caller may see, until `visit` answers
 * true, `wanted` summaries were visited or MAX_EXAMINED sessions were read. Another principal's session is skipped
 * before it counts, so recent activity of others never hides the caller's own sessions.
 */
function walkVisible(
	stateDir: string,
	wanted: number,
	logger: Logger,
	caller: SessionCaller | undefined,
	label: string,
	visit: (summary: SessionSummary) => boolean,
): void {
	let examined = 0;
	let visited = 0;
	for (const { sources } of sourcesByRecency(stateDir, logger)) {
		if (visited >= wanted || examined >= MAX_EXAMINED) return;
		examined++;
		try {
			const summary = summarize(stateDir, sources, caller);
			if (!summary) continue;
			visited++;
			if (visit(summary)) return;
		} catch (error) {
			// reason: One unreadable session never hides the others.
			logger.error(`${label}: ${failureLabel(error)}`);
		}
	}
}

/** Summaries of the `candidates` most recently touched sessions the caller may see, newest first by their own timestamp. */
function collect(
	stateDir: string,
	candidates: number,
	logger: Logger,
	caller?: SessionCaller,
): SessionSummary[] {
	const summaries: SessionSummary[] = [];
	walkVisible(stateDir, candidates, logger, caller, "collect", (summary) => {
		summaries.push(summary);
		return false;
	});
	return summaries
		.map((summary) => ({ id: summary.sessionId, time: summary.updatedAt, summary }))
		.sort(byRecency)
		.map((item) => item.summary);
}

/**
 * The most recent sessions the caller may see, newest first. Never throws: a missing directory, an unreadable or
 * malformed file and a name that is not a session id are all skipped. `limit` is clamped to 1..20 (default 5); at
 * most min(200, limit * 4) visible sessions are parsed, chosen by file modification time among the caller's own, and
 * at most MAX_EXAMINED sessions are read.
 */
export function listSessions(
	stateDir: string,
	options: { limit?: number; logger?: Logger; caller?: SessionCaller } = {},
): SessionSummary[] {
	try {
		const limit = clampLimit(options.limit);
		return collect(
			stateDir,
			Math.min(MAX_CANDIDATES, limit * 4),
			options.logger ?? createLogger(),
			options.caller,
		).slice(0, limit);
	} catch {
		return [];
	}
}

/**
 * Id of the newest session whose plan is finished (status "planned") that the caller may see, or undefined when there
 * is none. Candidates are visited newest first and the walk stops at the first planned one, so a state directory full
 * of unfinished sessions costs reads only until that session; sessions of other principals are skipped, up to
 * MAX_EXAMINED sessions read.
 */
export function newestPlannedSessionId(
	stateDir: string,
	logger: Logger = createLogger(),
	caller?: SessionCaller,
): string | undefined {
	try {
		let found: string | undefined;
		walkVisible(stateDir, MAX_CANDIDATES, logger, caller, "newestPlannedSessionId", (summary) => {
			if (summary.status !== "planned") return false;
			found = summary.sessionId;
			return true;
		});
		return found;
	} catch {
		return undefined;
	}
}
