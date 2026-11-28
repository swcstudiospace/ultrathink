// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { withLockMutation } from "../claude/atomic.ts";
import type {
	AuditRecord,
	ClosedBy,
	HtilEntry,
	OverrideDecision,
	PhaseLoopState,
	RuntimeRepair,
} from "./phase-loop.ts";

export type CheckpointReason = "pause" | "kill";

/** Written by a pause or a catchable kill. The next accepted transition saves without it. */
export interface Checkpoint {
	reason: CheckpointReason;
	/** Caller-supplied time of the checkpoint, ISO 8601. */
	at: string;
}

/** One stored record: the phase state, and a checkpoint when a pause or kill wrote one. */
export interface PhaseLoopRecord extends PhaseLoopState {
	checkpoint?: Checkpoint;
}

/** A record as read from disk. Records written before phase 111 have no humanItems. */
type StoredRecord = Omit<PhaseLoopRecord, "humanItems"> & { humanItems?: HtilEntry[] };

/**
 * Outcome of reading one record. A quarantined record was unparseable or of the wrong shape; it
 * was moved aside under a new name with its bytes intact. `quarantinedAs` is the store's
 * locator for that moved copy.
 */
export type LoadOutcome =
	| { status: "found"; record: PhaseLoopRecord }
	| { status: "absent" }
	| { status: "quarantined"; quarantinedAs: string };

/** Durable home for phase loop records, one per runtime id. */
export interface PhaseLoopStore {
	load(runtimeId: string): LoadOutcome;
	/** Commits the record before returning. Throws when the write fails. */
	save(runtimeId: string, record: PhaseLoopRecord): void;
	/** The SHA-256 hex digest of the current record file, or undefined when it is absent. */
	digest?(runtimeId: string): string | undefined;
	/** Atomically commits only when the current record still has the expected digest; a mismatch returns false. */
	saveIfUnchanged?(
		runtimeId: string,
		record: PhaseLoopRecord,
		expectedDigest: string | undefined,
	): boolean;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Canonical phase order; persisted `phaseOrder` must be a prefix of this list. */
const PHASE_ORDER = ["Discuss", "Plan", "Execute", "Verify", "Ship"] as const;
const LIFECYCLES: Record<string, true> = {
	ready: true,
	discussing: true,
	planning: true,
	executing: true,
	verifying: true,
	"awaiting-decision": true,
	blocked: true,
	paused: true,
	failed: true,
	completed: true,
	"cleaned-up": true,
};
const RECORD_KEYS: Record<string, true> = {
	runtimeId: true,
	phaseOrder: true,
	executeStarts: true,
	shipStarts: true,
	operatorConfirmations: true,
	humanItems: true,
	closedBy: true,
	audits: true,
	overrides: true,
	runtimeSessionId: true,
	runtimeRepair: true,
	schemaVersion: true,
	transitions: true,
	cleanedUpAt: true,
	cleanedUpBy: true,
	checkpoint: true,
};
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Hex of the UTF-8 id: filename-safe, injective, and unable to escape the directory. */
function recordName(runtimeId: string): string {
	return `${Buffer.from(runtimeId, "utf8").toString("hex")}.json`;
}

function isCheckpoint(value: unknown): value is Checkpoint {
	if (typeof value !== "object" || value === null) return false;
	const checkpoint = value as Record<string, unknown>;
	return (
		(checkpoint.reason === "pause" || checkpoint.reason === "kill") &&
		typeof checkpoint.at === "string"
	);
}

function isHtilEntry(value: unknown): value is HtilEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		typeof entry.owner === "string" &&
		(entry.state === "open" || entry.state === "done" || entry.state === "deferred") &&
		(entry.evidenceId === undefined || typeof entry.evidenceId === "string") &&
		(entry.decisionId === undefined || typeof entry.decisionId === "string") &&
		(entry.resolvedBy === undefined || typeof entry.resolvedBy === "string") &&
		(entry.resolvedAt === undefined || typeof entry.resolvedAt === "string") &&
		(entry.afterShip === undefined || entry.afterShip === true)
	);
}

function isClosedBy(value: unknown): value is ClosedBy {
	if (typeof value !== "object" || value === null) return false;
	const closedBy = value as Record<string, unknown>;
	return (
		(closedBy.kind === "audit" || closedBy.kind === "validation" || closedBy.kind === "override") &&
		typeof closedBy.recordId === "string" &&
		typeof closedBy.recordedAt === "string"
	);
}

function isAuditRecord(value: unknown): value is AuditRecord {
	if (typeof value !== "object" || value === null) return false;
	const audit = value as Record<string, unknown>;
	return (
		typeof audit.id === "string" &&
		(audit.kind === "audit" || audit.kind === "validation") &&
		(audit.result === "pass" || audit.result === "fail") &&
		typeof audit.recordedAt === "string"
	);
}

function isOverrideDecision(value: unknown): value is OverrideDecision {
	if (typeof value !== "object" || value === null) return false;
	const decision = value as Record<string, unknown>;
	return (
		typeof decision.decisionId === "string" &&
		typeof decision.owner === "string" &&
		typeof decision.decidedAt === "string" &&
		typeof decision.reason === "string"
	);
}

function isRuntimeRepair(value: unknown): value is RuntimeRepair {
	if (typeof value !== "object" || value === null) return false;
	const repair = value as Record<string, unknown>;
	return typeof repair.reason === "string" && typeof repair.at === "string";
}

function isTransition(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.at === "string" &&
		row.at !== "" &&
		typeof row.from === "string" &&
		LIFECYCLES[row.from] === true &&
		typeof row.event === "string" &&
		row.event !== "" &&
		typeof row.to === "string" &&
		LIFECYCLES[row.to] === true &&
		typeof row.accepted === "boolean" &&
		Array.isArray(row.refusals) &&
		row.refusals.every((item) => typeof item === "string")
	);
}

function isPhaseLoopRecord(value: unknown): value is StoredRecord {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	if (!Object.keys(row).every((key) => RECORD_KEYS[key] === true)) return false;
	return (
		typeof row.runtimeId === "string" &&
		Array.isArray(row.phaseOrder) &&
		row.phaseOrder.every((phase, index) => phase === PHASE_ORDER[index]) &&
		isCount(row.executeStarts) &&
		isCount(row.shipStarts) &&
		isCount(row.operatorConfirmations) &&
		(row.checkpoint === undefined || isCheckpoint(row.checkpoint)) &&
		(row.humanItems === undefined ||
			(Array.isArray(row.humanItems) && row.humanItems.every(isHtilEntry))) &&
		(row.closedBy === undefined || isClosedBy(row.closedBy)) &&
		(row.audits === undefined || (Array.isArray(row.audits) && row.audits.every(isAuditRecord))) &&
		(row.overrides === undefined ||
			(Array.isArray(row.overrides) && row.overrides.every(isOverrideDecision))) &&
		(row.runtimeSessionId === undefined || typeof row.runtimeSessionId === "string") &&
		(row.runtimeRepair === undefined || isRuntimeRepair(row.runtimeRepair)) &&
		(row.schemaVersion === undefined || row.schemaVersion === 1) &&
		(row.transitions === undefined ||
			(Array.isArray(row.transitions) && row.transitions.every(isTransition))) &&
		(row.cleanedUpAt === undefined || typeof row.cleanedUpAt === "string") &&
		(row.cleanedUpBy === undefined || typeof row.cleanedUpBy === "string")
	);
}

/**
 * Unparseable, wrong-shape, or mismatched text yields undefined, which means quarantine. A record
 * without humanItems was written before phase 111 and reads with an empty list.
 */
function parseRecord(text: string, runtimeId: string): PhaseLoopRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isPhaseLoopRecord(value) || value.runtimeId !== runtimeId) return undefined;
	return { ...value, humanItems: value.humanItems ?? [] };
}

function fsyncDirectory(dir: string): void {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function errorCodeOf(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

/** The SHA-256 of the record file's exact bytes, or undefined when the file is absent. */
function digestOfRecord(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
	} catch (error) {
		if (errorCodeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** Atomically replaces one record file with the next record. */
function writeRecord(stateDir: string, target: string, record: PhaseLoopRecord): void {
	const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		const fd = openSync(temp, "wx", FILE_MODE);
		try {
			writeFileSync(fd, `${JSON.stringify(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	fsyncDirectory(stateDir);
}

/** The one file call a store makes that a test can race: moving a corrupt record aside. */
export interface PhaseLoopFs {
	renameSync(from: string, to: string): void;
}

const defaultFs: PhaseLoopFs = { renameSync };

/** Moves a corrupt record aside under a unique name. Its bytes are kept and never overwritten. */
function quarantine(path: string, fs: PhaseLoopFs): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const target = `${path}.corrupt-${stamp}-${randomBytes(4).toString("hex")}`;
	fs.renameSync(path, target);
	return target;
}

/** The outcome for a record that is not at its name: its latest quarantined copy, or absent when there is none. */
function outcomeWithoutRecord(path: string): LoadOutcome {
	const copies = quarantinedCopies(path);
	const latest = copies[copies.length - 1];
	if (latest === undefined) return { status: "absent" };
	return { status: "quarantined", quarantinedAs: latest };
}

/** Quarantined copies of one record path, oldest first. A missing directory has none. */
function quarantinedCopies(path: string): string[] {
	const dir = dirname(path);
	const prefix = `${basename(path)}.corrupt-`;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	return names
		.filter((name) => name.startsWith(prefix))
		.sort()
		.map((name) => join(dir, name));
}

/**
 * One JSON record per runtime id under stateDir. A save writes a temp file in the same
 * directory, fsyncs it, renames it over the record, and fsyncs the directory, so a reader sees
 * the old record or the new one. A filesystem without directory fsync makes save throw.
 * Reads address the record by exact name, so a temp file left by a crash is never read.
 *
 * An unparseable or wrong-shape record is renamed to `<record>.corrupt-<timestamp>-<random>`
 * and reported as quarantined, so it is never silently overwritten. The block is sticky: while
 * a quarantined copy exists and no record is present, every load of that id reports the same
 * copy. A valid record written over the record name, or removal of the copy by an operator,
 * ends it. A missing record with no copy is absent. Any other read failure throws, so a
 * permissions error cannot restart the loop from empty.
 */
export function fileStore(stateDir: string, fs: PhaseLoopFs = defaultFs): PhaseLoopStore {
	return {
		load(runtimeId): LoadOutcome {
			const path = join(stateDir, recordName(runtimeId));
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				return outcomeWithoutRecord(path);
			}
			const record = parseRecord(text, runtimeId);
			if (record) return { status: "found", record };
			try {
				return { status: "quarantined", quarantinedAs: quarantine(path, fs) };
			} catch (error) {
				// reason: a concurrent load moved the record aside first, so its copy is the one this load reports
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				return outcomeWithoutRecord(path);
			}
		},
		save(runtimeId, record) {
			mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });
			const target = join(stateDir, recordName(runtimeId));
			writeRecord(stateDir, target, record);
		},
		digest(runtimeId) {
			return digestOfRecord(join(stateDir, recordName(runtimeId)));
		},
		saveIfUnchanged(runtimeId, record, expectedDigest) {
			mkdirSync(stateDir, { recursive: true, mode: DIR_MODE });
			const target = join(stateDir, recordName(runtimeId));
			const wrote = withLockMutation(target, () => {
				if (digestOfRecord(target) !== expectedDigest) return false;
				writeRecord(stateDir, target, record);
				return true;
			});
			return wrote === true;
		},
	};
}
