// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The store of auto-generated skills (Linear SPE-34396, step 6): one directory per skill holding `SKILL.md`, and a
 * `manifest.json` at the store root listing every generated skill. The manifest is the ownership record: a directory the
 * manifest does not list is user-authored and is never written or removed here.
 *
 * Every mutation writes the manifest before the skill file it describes. A directory this store creates is therefore
 * always listed, and a failure between the two writes leaves a listed skill that a retry repairs; it never leaves an
 * unlisted directory that would later read as user-authored. Files are written through a temporary file in the same
 * directory and a rename, so a reader sees the old or the new content, never a mix.
 *
 * Each mutation runs under the manifest's file lock, so concurrent writers take turns and never drop each other's entries.
 *
 * Each successful create, update, promote, disable and delete also appends one record to `audit.ndjson` at the store root
 * (see `skill-audit.ts`). A failed append is reported in the result and never undoes the mutation.
 */
import { randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "../claude/atomic.ts";
import { isRecord } from "../shared.ts";
import {
	appendAudit,
	type AuditOutcome,
	type AuditRecord,
	type MatchBy,
	type QualificationBy,
} from "./skill-audit.ts";
import { type AutoSkill, contentHashOf } from "./skill-author.ts";

const MANIFEST = "manifest.json";
const SKILL_FILE = "SKILL.md";
const MANIFEST_SCHEMA = 2;
/** Kebab-case, the same shape `skill-author` gives names. Excludes separators and dot segments by construction. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
/** A YAML plain scalar is written bare only when no YAML syntax character can change its meaning. */
const PLAIN_SCALAR_RE = /^[A-Za-z0-9][^#:"'\\]*$/;

export type GeneratedStatus = AutoSkill["status"];

/** Every status a manifest entry may hold. Only promoteGeneratedSkill sets `active`; the general setter refuses it. */
type ManifestStatus = GeneratedStatus | "active";

/** One generated skill as the manifest records it. */
interface GeneratedEntry {
	name: string;
	status: ManifestStatus;
	generated_by: "auto";
	version: number;
	content_hash: string;
	/** ISO 8601 UTC: the time the store wrote this version. */
	generated_at: string;
	source_ids: string[];
	stale: boolean;
	description: string;
	applies_when: AutoSkill["applies_when"];
	/** Optional: a manifest may omit it. When present it is the exact-match key for merges. */
	signature_hash?: string;
}

type StoreReason =
	| "invalid_name"
	| "invalid_input"
	| "user_authored"
	| "not_found"
	| "wrong_status"
	| "unsafe_path"
	| "manifest_corrupt"
	| "skill_corrupt"
	| "io_error";

interface StoreFailure {
	ok: false;
	reason: StoreReason;
	/** A short explanation: the failing field or rule, or the error code. Never skill text. */
	detail: string;
}

type WriteAction = "created" | "updated";
/** What the pipeline decided before the write; the audit record names it. Empty when the caller decided nothing. */
export interface WriteProvenance {
	qualification_by?: QualificationBy;
	match_by?: MatchBy;
}
export type WriteResult =
	| { ok: true; action: WriteAction; entry: GeneratedEntry; audit: AuditOutcome }
	| StoreFailure;
export type StatusResult = { ok: true; entry: GeneratedEntry; audit: AuditOutcome } | StoreFailure;
export type PromoteResult =
	| { ok: true; changed: false; entry: GeneratedEntry }
	| { ok: true; changed: true; entry: GeneratedEntry; audit: AuditOutcome }
	| StoreFailure;
export type RemoveResult = { ok: true; name: string; audit: AuditOutcome } | StoreFailure;
export type ListResult = { ok: true; entries: GeneratedEntry[] } | StoreFailure;

/** Internal: carries a typed reason through the helpers to the exported functions, which return it as a `StoreFailure`. */
class StoreError extends Error {
	constructor(
		readonly reason: StoreReason,
		readonly detail: string,
	) {
		super(detail);
	}
}

const SLUG_RULE = "kebab-case, 1 to 64 characters";

/**
 * Writes or replaces the generated skill `skill.name` under `storeDir`. A new skill starts at its record's version. An
 * existing generated skill gets the next version and returns to draft, because changed content needs a fresh
 * confirmation; a disabled one stays disabled. `nowIso` becomes the entry's `generated_at`, and the audit record's time.
 * `provenance` is the decision the audit record names.
 */
export async function writeGeneratedSkill(
	storeDir: string,
	skill: AutoSkill,
	nowIso: string,
	provenance: WriteProvenance = {},
): Promise<WriteResult> {
	try {
		requireSlug(skill.name);
		const problem = inputProblem(skill, nowIso);
		if (problem !== undefined) throw new StoreError("invalid_input", `${problem} is invalid`);
		const { action, entry } = underManifestLock(storeDir, true, () =>
			writeSkill(storeDir, skill, nowIso),
		);
		const audit = appendAudit(storeDir, {
			ts: nowIso,
			action: action === "created" ? "create" : "update",
			...auditFieldsOf(entry),
			...provenance,
		});
		return { ok: true, action, entry, audit };
	} catch (error) {
		return failureOf(error);
	}
}

/** Sets a generated skill to draft or disabled, in the manifest and the `status:` line of its frontmatter. Only promoteGeneratedSkill sets active. */
export async function setGeneratedStatus(
	storeDir: string,
	name: string,
	status: GeneratedStatus,
): Promise<StatusResult> {
	try {
		requireSlug(name);
		const entry = underManifestLock(storeDir, false, () => setStatus(storeDir, name, status));
		const audit = appendAudit(storeDir, {
			ts: new Date().toISOString(),
			action: status === "disabled" ? "disable" : "update",
			...auditFieldsOf(entry),
		});
		return { ok: true, entry, audit };
	} catch (error) {
		return failureOf(error);
	}
}

/**
 * Promotes a draft generated skill to active. `confirmedBy` names who confirmed it and goes in the audit record. An
 * active skill is already promoted: the call succeeds, changes nothing and writes no record. A disabled skill is refused.
 */
export async function promoteGeneratedSkill(
	storeDir: string,
	name: string,
	confirmedBy: string,
): Promise<PromoteResult> {
	try {
		requireSlug(name);
		if (!isSingleLine(confirmedBy)) throw new StoreError("invalid_input", "confirmedBy is invalid");
		const outcome = underManifestLock(storeDir, false, () => promoteStatus(storeDir, name));
		if (!outcome.changed) return { ok: true, changed: false, entry: outcome.entry };
		const audit = appendAudit(storeDir, {
			ts: new Date().toISOString(),
			action: "promote",
			confirmedBy,
			...auditFieldsOf(outcome.entry),
		});
		return { ok: true, changed: true, entry: outcome.entry, audit };
	} catch (error) {
		return failureOf(error);
	}
}

/** Removes a generated skill: its `SKILL.md`, its directory and its manifest entry. Nothing else is touched. */
export async function removeGeneratedSkill(storeDir: string, name: string): Promise<RemoveResult> {
	try {
		requireSlug(name);
		const entry = underManifestLock(storeDir, false, () => removeSkill(storeDir, name));
		const audit = appendAudit(storeDir, {
			ts: new Date().toISOString(),
			action: "delete",
			...auditFieldsOf(entry),
		});
		return { ok: true, name, audit };
	} catch (error) {
		return failureOf(error);
	}
}

/** The manifest's entries in the order they were written. A missing manifest lists as empty. */
export async function listGenerated(storeDir: string): Promise<ListResult> {
	try {
		return { ok: true, entries: readManifest(storeDir) };
	} catch (error) {
		return failureOf(error);
	}
}

/**
 * Runs one manifest read-modify-write under the manifest's file lock, so overlapping writers take turns instead of
 * each dropping the other's entries. The lock is held across the read as well as the write. A lock still held past
 * the wait throws rather than running the mutation unlocked.
 */
function underManifestLock<T>(storeDir: string, createParent: boolean, fn: () => T): T {
	return withFileLock(join(storeDir, MANIFEST), fn, { createParent, onTimeout: "throw" });
}

/** Throws invalid_name before any lock or directory is created, so a rejected name writes nothing. */
function requireSlug(name: string): void {
	if (!isSlug(name)) throw new StoreError("invalid_name", SLUG_RULE);
}

function writeSkill(
	storeDir: string,
	skill: AutoSkill,
	nowIso: string,
): { action: WriteAction; entry: GeneratedEntry } {
	const entries = readManifest(storeDir);
	assertOwnedOrAbsent(storeDir, skill.name, entries);
	const prior = entries.find((entry) => entry.name === skill.name);
	const entry: GeneratedEntry = {
		name: skill.name,
		status: statusOnWrite(prior, skill),
		generated_by: "auto",
		version: prior === undefined ? skill.version : Math.max(prior.version + 1, skill.version),
		content_hash: contentHashOf(skill),
		generated_at: nowIso,
		source_ids: [...skill.source_ids],
		stale: skill.stale,
		description: skill.description,
		applies_when: {
			task_types: [...skill.applies_when.task_types],
			scope_globs: [...skill.applies_when.scope_globs],
			error_signatures: [...skill.applies_when.error_signatures],
		},
		signature_hash: skill.signature_hash,
	};

	writeManifest(storeDir, [...entries.filter((other) => other.name !== entry.name), entry]);
	const dir = join(storeDir, skill.name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeAtomic(join(dir, SKILL_FILE), renderSkill(skill, entry));
	return { action: prior === undefined ? "created" : "updated", entry };
}

/** The status a generation writes. A changed skill needs a fresh confirmation before it is active, so a disabled one
 * stays disabled and any other returns to draft. */
function statusOnWrite(prior: GeneratedEntry | undefined, skill: AutoSkill): GeneratedStatus {
	if (prior === undefined) return skill.status;
	return prior.status === "disabled" ? "disabled" : "draft";
}

/** The named manifest entry and the manifest it came from. Throws when the name is user-authored or absent. */
function priorEntry(
	storeDir: string,
	name: string,
): { entries: GeneratedEntry[]; prior: GeneratedEntry } {
	const entries = readManifest(storeDir);
	assertOwnedOrAbsent(storeDir, name, entries);
	const prior = entries.find((entry) => entry.name === name);
	if (prior === undefined) throw new StoreError("not_found", "no generated skill with that name");
	return { entries, prior };
}

/** Sets a draft or disabled status. Only `promoteStatus` sets `active`. */
function setStatus(storeDir: string, name: string, status: ManifestStatus): GeneratedEntry {
	if (status !== "draft" && status !== "disabled") {
		throw new StoreError(
			"invalid_input",
			"status must be draft or disabled; only promotion sets active",
		);
	}
	const { entries, prior } = priorEntry(storeDir, name);
	return writeStatus(storeDir, name, entries, prior, status);
}

/** Promotes a draft to active. An active skill is already promoted and changes nothing; a disabled one is refused. */
function promoteStatus(
	storeDir: string,
	name: string,
): { changed: boolean; entry: GeneratedEntry } {
	const { entries, prior } = priorEntry(storeDir, name);
	if (prior.status === "active") return { changed: false, entry: prior };
	if (prior.status !== "draft")
		throw new StoreError("wrong_status", "only a draft skill can be promoted");
	return { changed: true, entry: writeStatus(storeDir, name, entries, prior, "active") };
}

/** Writes `status` to the manifest entry and to the `status:` line of its SKILL.md. The manifest goes first. */
function writeStatus(
	storeDir: string,
	name: string,
	entries: GeneratedEntry[],
	prior: GeneratedEntry,
	status: ManifestStatus,
): GeneratedEntry {
	const file = join(storeDir, name, SKILL_FILE);
	assertRegularFile(file);
	const updated = withFrontmatterStatus(readFileSync(file, "utf8"), status);
	if (updated === undefined) {
		throw new StoreError("skill_corrupt", "SKILL.md has no status line in its frontmatter");
	}

	const entry: GeneratedEntry = { ...prior, status };
	writeManifest(storeDir, [...entries.filter((other) => other.name !== entry.name), entry]);
	writeAtomic(file, updated);
	return entry;
}

function removeSkill(storeDir: string, name: string): GeneratedEntry {
	const entries = readManifest(storeDir);
	assertOwnedOrAbsent(storeDir, name, entries);
	const removed = entries.find((entry) => entry.name === name);
	if (removed === undefined) {
		throw new StoreError("not_found", "no generated skill with that name");
	}

	const dir = join(storeDir, name);
	if (lstatIfPresent(dir) !== undefined) {
		// Only `SKILL.md` is the store's: anything else in the directory was put there by someone else and stays.
		const children = readdirSync(dir, { withFileTypes: true });
		if (children.some((child) => child.name !== SKILL_FILE || !child.isFile())) {
			throw new StoreError("user_authored", "skill directory holds files the store did not write");
		}
		rmSync(join(dir, SKILL_FILE), { force: true });
		rmdirSync(dir);
	}
	writeManifest(
		storeDir,
		entries.filter((entry) => entry.name !== name),
	);
	return removed;
}

/** The manifest's entries. Missing manifest: none. Unreadable, unparseable or off-schema: `manifest_corrupt`, never replaced. */
function readManifest(storeDir: string): GeneratedEntry[] {
	const path = join(storeDir, MANIFEST);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return [];
		throw error;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new StoreError("manifest_corrupt", "manifest.json is not valid JSON");
	}
	if (isRecord(raw) && raw.schema === 1) {
		throw new StoreError("manifest_corrupt", "manifest.json is schema 1; expected schema 2");
	}
	if (!isRecord(raw) || raw.schema !== MANIFEST_SCHEMA || !Array.isArray(raw.skills)) {
		throw new StoreError("manifest_corrupt", "manifest.json does not match schema 2");
	}
	const entries: GeneratedEntry[] = [];
	for (const item of raw.skills) {
		const entry = parseEntry(item);
		if (entry === undefined)
			throw new StoreError("manifest_corrupt", "manifest.json has an invalid entry");
		if (entries.some((seen) => seen.name === entry.name)) {
			throw new StoreError("manifest_corrupt", "manifest.json lists a skill twice");
		}
		entries.push(entry);
	}
	return entries;
}

function parseEntry(raw: unknown): GeneratedEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const {
		name,
		status,
		version,
		content_hash,
		generated_at,
		source_ids,
		stale,
		description,
		applies_when,
		signature_hash,
	} = raw;
	if (!isSlug(name) || !isStatus(status) || raw.generated_by !== "auto") return undefined;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
	if (typeof content_hash !== "string" || !HEX64_RE.test(content_hash)) return undefined;
	if (typeof generated_at !== "string" || !ISO_UTC_RE.test(generated_at)) return undefined;
	if (!isStringList(source_ids) || typeof stale !== "boolean") return undefined;
	if (!isSingleLine(description) || !isAppliesWhen(applies_when)) return undefined;
	if (
		signature_hash !== undefined &&
		(typeof signature_hash !== "string" || !HEX32_RE.test(signature_hash))
	) {
		return undefined;
	}
	return {
		name,
		status,
		generated_by: "auto",
		version,
		content_hash,
		generated_at,
		source_ids,
		stale,
		description,
		applies_when,
		...(typeof signature_hash === "string" ? { signature_hash } : {}),
	};
}

function writeManifest(storeDir: string, entries: readonly GeneratedEntry[]): void {
	mkdirSync(storeDir, { recursive: true, mode: 0o700 });
	const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const body = `${JSON.stringify({ schema: MANIFEST_SCHEMA, skills: sorted }, null, "\t")}\n`;
	writeAtomic(join(storeDir, MANIFEST), body);
}

/** Temp file in the same directory, then rename. The temp file is removed when either step fails. */
function writeAtomic(path: string, content: string): void {
	const temp = join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	);
	let renamed = false;
	try {
		writeFileSync(temp, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
		renameSync(temp, path);
		renamed = true;
	} finally {
		if (!renamed) rmSync(temp, { force: true });
	}
}

/** Refuses a skill path that is not a plain directory, or a plain directory the manifest does not list. */
function assertOwnedOrAbsent(
	storeDir: string,
	name: string,
	entries: readonly GeneratedEntry[],
): void {
	const stat = lstatIfPresent(join(storeDir, name));
	if (stat === undefined) return;
	if (!stat.isDirectory())
		throw new StoreError("unsafe_path", "skill path is not a plain directory");
	if (!entries.some((entry) => entry.name === name)) {
		throw new StoreError("user_authored", "directory is not listed in the manifest");
	}
}

function assertRegularFile(path: string): void {
	const stat = lstatIfPresent(path);
	if (stat === undefined) throw new StoreError("skill_corrupt", "SKILL.md is missing");
	if (!stat.isFile()) throw new StoreError("unsafe_path", "SKILL.md is not a regular file");
}

function lstatIfPresent(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** Returns the status line replaced inside the frontmatter, or undefined when the frontmatter has none. */
function withFrontmatterStatus(text: string, status: ManifestStatus): string | undefined {
	const lines = text.split("\n");
	if (lines[0] !== "---") return undefined;
	const close = lines.indexOf("---", 1);
	if (close === -1) return undefined;
	const index = lines.findIndex((line, i) => i > 0 && i < close && line.startsWith("status:"));
	if (index === -1) return undefined;
	lines[index] = `status: ${status}`;
	return lines.join("\n");
}

/** The first field that breaks the store's contract, or undefined. Name is checked by the caller first. */
function inputProblem(skill: AutoSkill, nowIso: string): string | undefined {
	if (!ISO_UTC_RE.test(nowIso)) return "nowIso";
	if (skill.generated_by !== "auto") return "generated_by";
	if (!isStatus(skill.status)) return "status";
	if (!isSingleLine(skill.description)) return "description";
	if (!isSingleLineList(skill.steps)) return "steps";
	if (!isAppliesWhen(skill.applies_when)) return "applies_when";
	if (!HEX32_RE.test(skill.signature_hash)) return "signature_hash";
	if (!isSingleLineList(skill.source_ids)) return "source_ids";
	if (!Number.isInteger(skill.version) || skill.version < 1) return "version";
	if (typeof skill.stale !== "boolean") return "stale";
	if (skill.content_hash !== contentHashOf(skill)) return "content_hash";
	return undefined;
}

function renderSkill(skill: AutoSkill, entry: GeneratedEntry): string {
	const description =
		PLAIN_SCALAR_RE.test(skill.description) && !/\s$/.test(skill.description)
			? skill.description
			: JSON.stringify(skill.description);
	const frontmatter = [
		"---",
		`name: ${skill.name}`,
		`description: ${description}`,
		`status: ${entry.status}`,
		`generated_by: ${entry.generated_by}`,
		`version: ${entry.version}`,
		"---",
	];
	const when = skill.applies_when;
	const sections: Array<[heading: string, lines: string[]]> = [
		[
			"Applies when",
			[
				...when.task_types.map((type) => `- task type: ${type}`),
				...when.scope_globs.map((glob) => `- scope: ${glob}`),
				...when.error_signatures.map((signature) => `- error: ${signature}`),
			],
		],
		["Steps", skill.steps.map((step, i) => `${i + 1}. ${step}`)],
		["Sources", skill.source_ids.map((id) => `- ${id}`)],
	];
	const body = sections.map(([heading, lines]) => `## ${heading}\n\n${lines.join("\n")}`);
	return `${[...frontmatter, "", ...body].join("\n")}\n`;
}

function auditFieldsOf(
	entry: GeneratedEntry,
): Pick<AuditRecord, "name" | "version" | "content_hash" | "source_ids"> {
	return {
		name: entry.name,
		version: entry.version,
		content_hash: entry.content_hash,
		source_ids: [...entry.source_ids],
	};
}

function isSlug(name: unknown): name is string {
	return typeof name === "string" && NAME_RE.test(name);
}

function isStatus(value: unknown): value is ManifestStatus {
	return value === "draft" || value === "active" || value === "disabled";
}

function isSingleLine(text: unknown): text is string {
	return typeof text === "string" && text.trim() !== "" && !LINE_BREAK_RE.test(text);
}

function isSingleLineList(items: unknown): items is string[] {
	return Array.isArray(items) && items.every(isSingleLine);
}

function isStringList(items: unknown): items is string[] {
	return Array.isArray(items) && items.every((item) => typeof item === "string");
}

function isAppliesWhen(value: unknown): value is AutoSkill["applies_when"] {
	if (!isRecord(value)) return false;
	return (
		isSingleLineList(value.task_types) &&
		isSingleLineList(value.scope_globs) &&
		isSingleLineList(value.error_signatures)
	);
}

function errnoOf(error: unknown): string | undefined {
	if (error instanceof Error && "code" in error && typeof error.code === "string")
		return error.code;
	return undefined;
}

/** Typed failures become results; any other error is a bug and propagates. */
function failureOf(error: unknown): StoreFailure {
	if (error instanceof StoreError) return { ok: false, reason: error.reason, detail: error.detail };
	const code = errnoOf(error);
	if (code !== undefined) return { ok: false, reason: "io_error", detail: code };
	throw error;
}
