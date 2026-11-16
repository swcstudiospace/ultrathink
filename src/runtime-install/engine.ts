// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The data-driven runtime installer. One engine serves every CLI agent in the registry: it converts the Ultrathink
 * skills and commands into the runtime's layout (`convert.ts`), places them where `plan.ts` says, and records every
 * path and keyed edit in a manifest, so uninstall removes exactly what install wrote.
 *
 * Install and uninstall both run on `adapters/install.ts`. The manifest directory is the install's target and each
 * file write, removal or keyed edit is one of its registrations, so a failure at any step reverts the steps already
 * applied and restores the previous manifest. Uninstall is the same transaction into an empty ledger, followed by
 * deleting the manifest directory.
 *
 * Non-destructive rules: only `ultrathink-*` paths and declared keyed edits are ever touched; a file the installer
 * did not write (or the user changed) is copied into `ultrathink-backups/` before it is replaced, and a symbolic
 * link or non-text file at a managed path is refused. `--runtime all` installs only into runtimes whose config
 * root already exists.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { installPlugin, type Registration } from "../../adapters/install.ts";
import { isDirectory } from "../shared.ts";
import { convertArtifact, isManaged } from "./convert.ts";
import { applyEdit, isEmptyConfig, type KeyedEdit, revertEdit } from "./edits.ts";
import {
	isSafeRelative,
	MANIFEST_FILE,
	type Manifest,
	type ManifestEdit,
	type ManifestFile,
	parseManifest,
	serializeManifest,
} from "./manifest.ts";
import {
	BACKUP_DIR,
	COMMAND_SOURCE_DIR,
	type EnvMap,
	type FileOp,
	type InstallPlan,
	type InstallScope,
	isManagedName,
	MANAGED_PREFIX,
	type PlanContext,
	planInstall,
	SKILL_FILE,
	SKILL_SOURCE_DIR,
	type SourceInventory,
} from "./plan.ts";
import type { RuntimeDescriptor } from "./types.ts";

export interface EngineOptions {
	/** The runtime registry the selection is made from. */
	readonly runtimes: readonly RuntimeDescriptor[];
	readonly cloneRoot: string;
	readonly home: string;
	readonly cwd: string;
	readonly env: EnvMap;
	readonly scope: InstallScope;
	/** A registry id, or "all". */
	readonly runtime: string;
	/** Compute and report the changes without writing anything. */
	readonly dryRun?: boolean;
}

export interface InstallOptions extends EngineOptions {
	/**
	 * Keyed edits to apply to config files of the selected runtime; recorded in the manifest and undone on uninstall.
	 * An empty list undoes the edits a previous install recorded; omit it to leave them as they are.
	 */
	readonly edits?: readonly KeyedEdit[];
}

type StepAction = "write" | "remove" | "restore" | "edit" | "unedit";

interface Change {
	readonly action: StepAction | "backup";
	/** Relative to the config root. */
	readonly path: string;
}

type ReportStatus =
	| "installed"
	| "unchanged"
	| "would-install"
	| "removed"
	| "would-remove"
	| "not-installed"
	| "skipped"
	| "failed";

export interface RuntimeReport {
	readonly runtime: string;
	readonly status: ReportStatus;
	readonly configRoot: string | undefined;
	readonly changes: readonly Change[];
	/** Why a runtime was skipped or failed, and anything an install left alone. */
	readonly notes: readonly string[];
}

export interface RuntimeListing {
	readonly runtime: string;
	readonly label: string;
	readonly scopeSupport: RuntimeDescriptor["scope"];
	/** Undefined when the requested scope is not available for the runtime. */
	readonly configRoot: string | undefined;
	readonly detected: boolean;
	readonly installed: boolean;
	readonly files: number;
	/** Installed files that were deleted or changed since the install. */
	readonly missing: number;
	readonly modified: number;
	readonly note?: string;
}

type Outcome<T> =
	| { readonly kind: "unknown-runtime"; readonly message: string }
	| { readonly kind: "done"; readonly items: readonly T[] };

/** One file-level transition: the file must read `before` (undefined = absent) and then reads `after`. */
interface Step {
	readonly path: string;
	readonly target: string;
	readonly before: string | undefined;
	readonly after: string | undefined;
	readonly backup: Backup | undefined;
	readonly action: StepAction;
}

/** A copy of displaced content, kept under `ultrathink-backups/<content hash>/<original path>`. */
interface Backup {
	readonly path: string;
	readonly target: string;
	readonly text: string;
}

interface Prepared {
	readonly steps: readonly Step[];
	readonly files: readonly ManifestFile[];
	readonly edits: readonly ManifestEdit[];
	readonly dirs: readonly string[];
	/** Backup copies that are no longer needed once the steps are applied. */
	readonly spent: readonly string[];
	readonly notes: readonly string[];
}

type Inspected =
	| { readonly state: "absent" }
	| { readonly state: "file"; readonly text: string }
	| { readonly state: "other"; readonly reason: string };

const NO_SOURCES: SourceInventory = { skills: [], commands: [] };

export async function installRuntime(options: InstallOptions): Promise<Outcome<RuntimeReport>> {
	const selected = select(options);
	if (typeof selected === "string") return { kind: "unknown-runtime", message: selected };
	const sources = await listSources(options.cloneRoot);
	const items: RuntimeReport[] = [];
	for (const descriptor of selected) {
		items.push(await installOne(descriptor, options, sources));
	}
	return { kind: "done", items };
}

export async function uninstallRuntime(options: EngineOptions): Promise<Outcome<RuntimeReport>> {
	const selected = select(options);
	if (typeof selected === "string") return { kind: "unknown-runtime", message: selected };
	const items: RuntimeReport[] = [];
	for (const descriptor of selected) {
		items.push(await uninstallOne(descriptor, options));
	}
	return { kind: "done", items };
}

export async function listRuntimes(options: EngineOptions): Promise<Outcome<RuntimeListing>> {
	const selected = select(options);
	if (typeof selected === "string") return { kind: "unknown-runtime", message: selected };
	const items: RuntimeListing[] = [];
	for (const descriptor of selected) {
		items.push(await listOne(descriptor, options));
	}
	return { kind: "done", items };
}

/** The selected descriptors, or the message for an unknown id. */
function select(options: EngineOptions): RuntimeDescriptor[] | string {
	if (options.runtime === "all") return [...options.runtimes];
	const found = options.runtimes.find((descriptor) => descriptor.id === options.runtime);
	if (found !== undefined) return [found];
	const known = options.runtimes.map((descriptor) => descriptor.id).join(", ");
	return `unknown runtime "${options.runtime}"; expected "all" or one of: ${known}`;
}

function planContext(options: EngineOptions, sources: SourceInventory): PlanContext {
	return {
		cloneRoot: options.cloneRoot,
		home: options.home,
		cwd: options.cwd,
		env: options.env,
		scope: options.scope,
		sources,
		exists: isDirectory,
	};
}

function report(
	runtime: string,
	status: ReportStatus,
	configRoot: string | undefined,
	changes: readonly Change[],
	notes: readonly string[],
): RuntimeReport {
	return { runtime, status, configRoot, changes, notes };
}

/** A runtime that cannot be planned fails when it was asked for by id and is skipped under "all". */
function unplannable(options: EngineOptions, id: string, error: string): RuntimeReport {
	return report(id, options.runtime === "all" ? "skipped" : "failed", undefined, [], [error]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function installOne(
	descriptor: RuntimeDescriptor,
	options: InstallOptions,
	sources: SourceInventory,
): Promise<RuntimeReport> {
	const planned = planInstall(descriptor, planContext(options, sources));
	if (!planned.ok) return unplannable(options, descriptor.id, planned.error);
	const { plan } = planned;
	if (options.runtime === "all" && !isDirectory(plan.configRoot)) {
		const note = `not detected: ${plan.configRoot} does not exist`;
		return report(plan.runtime, "skipped", plan.configRoot, [], [note]);
	}
	try {
		return await applyInstall(plan, options);
	} catch (error) {
		return report(plan.runtime, "failed", plan.configRoot, [], [errorMessage(error)]);
	}
}

async function applyInstall(plan: InstallPlan, options: InstallOptions): Promise<RuntimeReport> {
	if (plan.ops.length === 0) {
		throw new Error(`no ultrathink sources under ${options.cloneRoot} fit this runtime's layout`);
	}
	const current = await loadManifest(plan.manifestDir, plan.runtime);
	const converted: { readonly op: FileOp; readonly text: string }[] = [];
	for (const op of plan.ops) {
		const source = await readFile(op.sourcePath, "utf8");
		const input = { text: source, source: op.source, cloneRoot: options.cloneRoot };
		converted.push({ op, text: convertArtifact(input, op.form) });
	}
	const prepared = await prepareInstall(plan, current?.manifest, converted, options.edits);
	const base = {
		schema: 1 as const,
		runtime: plan.runtime,
		scope: plan.scope,
		cloneRoot: options.cloneRoot,
		files: prepared.files,
		edits: prepared.edits,
		dirs: prepared.dirs,
	};
	const generation = current?.manifest.generation ?? 0;
	if (
		current !== undefined &&
		prepared.steps.length === 0 &&
		serializeManifest({ ...base, generation }) === current.text
	) {
		return report(plan.runtime, "unchanged", plan.configRoot, [], prepared.notes);
	}
	const changes = changesOf(prepared.steps);
	if (options.dryRun) {
		return report(plan.runtime, "would-install", plan.configRoot, changes, prepared.notes);
	}
	const result = await installPlugin({
		targetDir: plan.manifestDir,
		files: new Map([[MANIFEST_FILE, serializeManifest({ ...base, generation: generation + 1 })]]),
		requiredFiles: [MANIFEST_FILE],
		registrations: prepared.steps.map(stepRegistration),
	});
	await discardBackups(plan.configRoot, result.ok ? prepared.spent : []);
	const touched = prepared.steps.map((step) => step.path);
	await pruneDirs(plan.configRoot, touched, new Set(prepared.dirs));
	if (!result.ok) {
		const notes = [result.error.message, result.error.nextAction];
		return report(plan.runtime, "failed", plan.configRoot, [], notes);
	}
	return report(plan.runtime, "installed", plan.configRoot, changes, prepared.notes);
}

async function prepareInstall(
	plan: InstallPlan,
	previous: Manifest | undefined,
	converted: readonly { readonly op: FileOp; readonly text: string }[],
	wanted: readonly KeyedEdit[] | undefined,
): Promise<Prepared> {
	const steps: Step[] = [];
	const notes: string[] = [];
	const files: ManifestFile[] = [];
	const recorded = new Map((previous?.files ?? []).map((file) => [file.path, file] as const));

	for (const { op, text } of converted) {
		await refuseManagedLinks(plan.configRoot, op.path);
		const entry = recorded.get(op.path);
		const before = await currentText(op.target, op.path);
		let original = entry?.original;
		let backup: Backup | undefined;
		if (before !== undefined && before !== text && !isOurs(entry, before)) {
			backup = storeBackup(plan.configRoot, op.path, before);
			if (entry === undefined) original = backup.path;
		}
		files.push(manifestFile(op.path, text, original));
		if (before !== text) {
			steps.push({
				path: op.path,
				target: op.target,
				before,
				after: text,
				backup,
				action: "write",
			});
		}
	}

	const desired = new Set(plan.ops.map((op) => op.path));
	const stale = (previous?.files ?? []).filter((file) => !desired.has(file.path));
	const removal = await removalSteps(plan.configRoot, stale, notes);
	const edited =
		wanted === undefined
			? { steps: [], records: [...(previous?.edits ?? [])], spent: [] }
			: await prepareEdits(plan.configRoot, previous?.edits ?? [], wanted, notes);
	const written = [...plan.ops.map((op) => op.path), ...edited.records.map((edit) => edit.file)];
	const dirs = new Set([...(previous?.dirs ?? []), ...createdDirs(plan.configRoot, written)]);
	return {
		steps: [...steps, ...removal.steps, ...edited.steps],
		files,
		edits: edited.records,
		dirs: [...dirs].sort(),
		spent: [...removal.spent, ...edited.spent],
		notes,
	};
}

function manifestFile(path: string, text: string, original: string | undefined): ManifestFile {
	const sha256 = hash(text);
	return original === undefined ? { path, sha256 } : { path, sha256, original };
}

/** Whether `text` at a managed path is the installer's own: the recorded hash, or the marker when nothing is recorded. */
function isOurs(entry: ManifestFile | undefined, text: string): boolean {
	return entry === undefined ? isManaged(text) : hash(text) === entry.sha256;
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function storeBackup(configRoot: string, path: string, text: string): Backup {
	const relative = posix.join(BACKUP_DIR, hash(text).slice(0, 12), path);
	return { path: relative, target: join(configRoot, relative), text };
}

function changesOf(steps: readonly Step[]): Change[] {
	return steps.flatMap((step): Change[] => [
		...(step.backup === undefined ? [] : [{ action: "backup" as const, path: step.backup.path }]),
		{ action: step.action, path: step.path },
	]);
}

/**
 * Steps that take installed files back out: an unmodified file goes (or is replaced by the original that was backed
 * up before the install); a file the user changed is copied to the backup store first.
 */
async function removalSteps(
	configRoot: string,
	entries: readonly ManifestFile[],
	notes: string[],
): Promise<{ readonly steps: Step[]; readonly spent: string[] }> {
	const steps: Step[] = [];
	const spent: string[] = [];
	for (const entry of entries) {
		const target = join(configRoot, entry.path);
		const state = await inspect(target);
		if (state.state === "other") {
			notes.push(`kept ${entry.path}: it ${state.reason}`);
			continue;
		}
		const before = state.state === "file" ? state.text : undefined;
		const original = await readOriginal(configRoot, entry, notes);
		if (before === undefined && original === undefined) continue;
		const backup =
			before !== undefined && hash(before) !== entry.sha256
				? storeBackup(configRoot, entry.path, before)
				: undefined;
		steps.push({
			path: entry.path,
			target,
			before,
			after: original,
			backup,
			action: original === undefined ? "remove" : "restore",
		});
		if (original !== undefined && entry.original !== undefined) spent.push(entry.original);
	}
	return { steps, spent };
}

async function readOriginal(
	configRoot: string,
	entry: ManifestFile,
	notes: string[],
): Promise<string | undefined> {
	if (entry.original === undefined) return undefined;
	const state = await inspect(join(configRoot, entry.original));
	if (state.state === "file") return state.text;
	notes.push(`the original of ${entry.path} is missing from ${entry.original}; not restored`);
	return undefined;
}

/**
 * One step per config file: undo recorded edits that are no longer wanted, then apply the wanted ones. Records of
 * edits that were already in place are carried over, so a reinstall keeps what undoing needs.
 */
async function prepareEdits(
	configRoot: string,
	recorded: readonly ManifestEdit[],
	wanted: readonly KeyedEdit[],
	notes: string[],
): Promise<{ readonly steps: Step[]; readonly records: ManifestEdit[]; readonly spent: string[] }> {
	const steps: Step[] = [];
	const records: ManifestEdit[] = [];
	const spent: string[] = [];
	const files = new Set([...recorded.map((edit) => edit.file), ...wanted.map((edit) => edit.file)]);
	for (const file of [...files].sort()) {
		if (!isSafeRelative(file)) {
			throw new Error(`edit file "${file}" must be a path inside the config root`);
		}
		const target = join(configRoot, file);
		const before = await currentText(target, file);
		const group = planEditGroup(
			file,
			before,
			recorded.filter((edit) => edit.file === file),
			wanted.filter((edit) => edit.file === file),
			notes,
		);
		const kept = new Set(group.records.map(({ record }) => record.backup));
		spent.push(...group.spent.filter((path) => !kept.has(path)));
		const merging = group.records.length > 0 && group.after !== before;
		const backup =
			merging && before !== undefined ? storeBackup(configRoot, file, before) : undefined;
		for (const { record, fresh } of group.records) {
			records.push(fresh && backup !== undefined ? { ...record, backup: backup.path } : record);
		}
		if (group.after === before) continue;
		const action = group.records.length === 0 ? "unedit" : "edit";
		steps.push({ path: file, target, before, after: group.after, backup, action });
	}
	return { steps, records, spent };
}

function planEditGroup(
	file: string,
	before: string | undefined,
	recorded: readonly ManifestEdit[],
	wanted: readonly KeyedEdit[],
	notes: string[],
): {
	readonly after: string | undefined;
	readonly records: readonly { readonly record: ManifestEdit; readonly fresh: boolean }[];
	readonly spent: readonly string[];
} {
	let text = before;
	const spent: string[] = [];
	for (const record of [...recorded].reverse()) {
		if (text === undefined || wanted.some((edit) => sameEdit(edit, record))) continue;
		const reverted = revertEdit(text, record);
		if (reverted === undefined) {
			notes.push(
				`kept the edit of ${describeEdit(record)} in ${file}: it changed since the install`,
			);
			continue;
		}
		text = reverted;
		if (record.backup !== undefined) spent.push(record.backup);
	}
	const created = before === undefined || recorded.some((record) => record.createdFile);
	const records: { record: ManifestEdit; fresh: boolean }[] = [];
	for (const edit of wanted) {
		const prior = recorded.find((record) => sameEdit(edit, record));
		const applied = applyEdit(text, edit);
		text = applied.text;
		if (prior === undefined) {
			records.push({ record: { ...applied.record, createdFile: created }, fresh: true });
		} else if (prior.kind === "json" && applied.record.kind === "json") {
			records.push({ record: { ...prior, value: applied.record.value }, fresh: false });
		} else {
			records.push({ record: prior, fresh: false });
		}
	}
	const emptied = records.length === 0 && created && text !== undefined && isEmptyConfig(text);
	return { after: emptied ? undefined : text, records, spent };
}

function sameEdit(edit: KeyedEdit, record: ManifestEdit): boolean {
	if (edit.file !== record.file) return false;
	if (edit.kind === "block") return record.kind === "block" && edit.id === record.id;
	return record.kind === "json" && JSON.stringify(edit.key) === JSON.stringify(record.key);
}

function describeEdit(record: ManifestEdit): string {
	return record.kind === "json" ? `key ${record.key.join(".")}` : `block ${record.id}`;
}

/** Directories the install will create (below the config root, and the root itself), that its own prefix does not cover. */
function createdDirs(configRoot: string, paths: readonly string[]): string[] {
	const created = new Set<string>();
	if (!isDirectory(configRoot)) created.add(".");
	for (const path of paths) {
		let dir = "";
		for (const segment of posix.dirname(path).split("/")) {
			if (segment === ".") continue;
			dir = dir === "" ? segment : `${dir}/${segment}`;
			if (!segment.startsWith(MANAGED_PREFIX) && !isDirectory(join(configRoot, dir))) {
				created.add(dir);
			}
		}
	}
	return [...created];
}

async function uninstallOne(
	descriptor: RuntimeDescriptor,
	options: EngineOptions,
): Promise<RuntimeReport> {
	const planned = planInstall(descriptor, planContext(options, NO_SOURCES));
	if (!planned.ok) return unplannable(options, descriptor.id, planned.error);
	const { plan } = planned;
	try {
		return await applyUninstall(plan, options);
	} catch (error) {
		return report(plan.runtime, "failed", plan.configRoot, [], [errorMessage(error)]);
	}
}

async function applyUninstall(plan: InstallPlan, options: EngineOptions): Promise<RuntimeReport> {
	const current = await loadManifest(plan.manifestDir, plan.runtime);
	if (current === undefined) return report(plan.runtime, "not-installed", plan.configRoot, [], []);
	const { manifest } = current;
	const notes: string[] = [];
	const removal = await removalSteps(plan.configRoot, manifest.files, notes);
	const edited = await prepareEdits(plan.configRoot, manifest.edits, [], notes);
	const steps = [...removal.steps, ...edited.steps];
	const changes = changesOf(steps);
	if (options.dryRun) return report(plan.runtime, "would-remove", plan.configRoot, changes, notes);

	const emptied: Manifest = {
		...manifest,
		generation: manifest.generation + 1,
		files: [],
		edits: [],
		dirs: [],
	};
	const result = await installPlugin({
		targetDir: plan.manifestDir,
		files: new Map([[MANIFEST_FILE, serializeManifest(emptied)]]),
		requiredFiles: [MANIFEST_FILE],
		registrations: steps.map(stepRegistration),
	});
	if (!result.ok) {
		await discardBackups(plan.configRoot, []);
		const failure = [result.error.message, result.error.nextAction];
		return report(plan.runtime, "failed", plan.configRoot, [], failure);
	}
	await rm(plan.manifestDir, { recursive: true, force: true });
	await discardBackups(plan.configRoot, [...removal.spent, ...edited.spent]);
	const touched = [
		...manifest.files.map((file) => file.path),
		...manifest.edits.map((edit) => edit.file),
	];
	await pruneDirs(plan.configRoot, touched, new Set(manifest.dirs));
	return report(plan.runtime, "removed", plan.configRoot, changes, notes);
}

async function listOne(
	descriptor: RuntimeDescriptor,
	options: EngineOptions,
): Promise<RuntimeListing> {
	const identity = {
		runtime: descriptor.id,
		label: descriptor.label,
		scopeSupport: descriptor.scope,
	};
	const none = { files: 0, missing: 0, modified: 0 };
	const planned = planInstall(descriptor, planContext(options, NO_SOURCES));
	if (!planned.ok) {
		const unavailable = { configRoot: undefined, detected: false, installed: false };
		return { ...identity, ...unavailable, ...none, note: planned.error };
	}
	const { plan } = planned;
	const located = { configRoot: plan.configRoot, detected: isDirectory(plan.configRoot) };
	try {
		const current = await loadManifest(plan.manifestDir, plan.runtime);
		if (current === undefined) return { ...identity, ...located, installed: false, ...none };
		let missing = 0;
		let modified = 0;
		for (const entry of current.manifest.files) {
			const state = await inspect(join(plan.configRoot, entry.path));
			if (state.state === "absent") missing += 1;
			else if (state.state === "other" || hash(state.text) !== entry.sha256) modified += 1;
		}
		return {
			...identity,
			...located,
			installed: true,
			files: current.manifest.files.length,
			missing,
			modified,
		};
	} catch (error) {
		return { ...identity, ...located, installed: false, ...none, note: errorMessage(error) };
	}
}

/** The manifest of an install, or undefined when there is none; a manifest directory that is not one is an error. */
async function loadManifest(
	manifestDir: string,
	runtime: string,
): Promise<{ readonly manifest: Manifest; readonly text: string } | undefined> {
	const info = await lstat(manifestDir).catch(missingAs(undefined));
	if (info === undefined) return undefined;
	if (!info.isDirectory()) throw new Error(`${manifestDir} exists and is not a directory`);
	const file = join(manifestDir, MANIFEST_FILE);
	const state = await inspect(file);
	if (state.state !== "file") {
		throw new Error(`${manifestDir} holds no readable ${MANIFEST_FILE}; move it aside and rerun`);
	}
	const manifest = parseManifest(state.text, file);
	if (manifest.runtime !== runtime) {
		throw new Error(`${file} belongs to runtime "${manifest.runtime}", not "${runtime}"`);
	}
	return { manifest, text: state.text };
}

async function listSources(cloneRoot: string): Promise<SourceInventory> {
	const skills: string[] = [];
	for (const entry of await readEntries(join(cloneRoot, SKILL_SOURCE_DIR))) {
		if (!entry.isDirectory() || !isManagedName(entry.name)) continue;
		const file = join(cloneRoot, SKILL_SOURCE_DIR, entry.name, SKILL_FILE);
		if ((await inspect(file)).state === "file") skills.push(entry.name);
	}
	const commands: string[] = [];
	for (const entry of await readEntries(join(cloneRoot, COMMAND_SOURCE_DIR))) {
		const name = entry.name.slice(0, -".md".length);
		if (entry.isFile() && entry.name.endsWith(".md") && isManagedName(name)) commands.push(name);
	}
	return { skills: skills.sort(), commands: commands.sort() };
}

function readEntries(dir: string): Promise<Dirent[]> {
	return readdir(dir, { withFileTypes: true }).catch(missingAs([]));
}

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** A catch handler that turns a missing path into `value` and rethrows everything else. */
function missingAs<T>(value: T): (error: unknown) => T {
	return (error) => {
		if (isMissing(error)) return value;
		throw error;
	};
}

/** What is at `path`: nothing, a regular UTF-8 text file, or something the installer must not touch. */
async function inspect(path: string): Promise<Inspected> {
	const info = await lstat(path).catch(missingAs(undefined));
	if (info === undefined) return { state: "absent" };
	if (info.isSymbolicLink()) return { state: "other", reason: "is a symbolic link" };
	if (!info.isFile()) return { state: "other", reason: "is not a regular file" };
	const bytes = await readFile(path);
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		return { state: "file", text: decoder.decode(bytes) };
	} catch {
		return { state: "other", reason: "is not valid UTF-8 text" };
	}
}

/** The text at `target` (undefined when absent); anything the installer must not touch is an error. */
async function currentText(target: string, label: string): Promise<string | undefined> {
	const state = await inspect(target);
	if (state.state === "other") {
		throw new Error(`${label} ${state.reason}; move it aside and rerun`);
	}
	return state.state === "file" ? state.text : undefined;
}

/** Refuses to write through a symbolic link at an installer-owned path, which would land in the link's target. */
async function refuseManagedLinks(configRoot: string, path: string): Promise<void> {
	let dir = configRoot;
	for (const segment of path.split("/")) {
		dir = join(dir, segment);
		const info = await lstat(dir).catch(missingAs(undefined));
		if (info === undefined) return;
		if (segment.startsWith(MANAGED_PREFIX) && info.isSymbolicLink()) {
			throw new Error(`${path}: ${segment} is a symbolic link; refusing to write through it`);
		}
	}
}

/** One registration for `installPlugin`: applies the step, or puts the file back as it was. */
function stepRegistration(step: Step): Registration {
	let wroteBackup = false;
	return {
		name: `${step.action} ${step.path}`,
		async apply() {
			await expectText(step, step.before, "changed while the installer ran");
			if (step.backup !== undefined) wroteBackup = await writeBackup(step.backup);
			try {
				await place(step.target, step.after);
			} catch (error) {
				if (wroteBackup && step.backup !== undefined) await rm(step.backup.target, { force: true });
				throw error;
			}
		},
		async revert() {
			await expectText(step, step.after, "changed after the installer wrote it; not restored");
			await place(step.target, step.before);
			if (wroteBackup && step.backup !== undefined) await rm(step.backup.target, { force: true });
		},
	};
}

async function expectText(
	step: Step,
	expected: string | undefined,
	problem: string,
): Promise<void> {
	if ((await currentText(step.target, step.path)) !== expected) {
		throw new Error(`${step.path} ${problem}`);
	}
}

/** Writes `text` to `target`, creating its directories; undefined removes the file. */
async function place(target: string, text: string | undefined): Promise<void> {
	if (text === undefined) {
		await rm(target, { force: true });
		return;
	}
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, text);
}

/** Writes the backup copy unless an identical one is already there; true when it was written. */
async function writeBackup(backup: Backup): Promise<boolean> {
	const state = await inspect(backup.target);
	if (state.state === "file" && state.text === backup.text) return false;
	if (state.state !== "absent") throw new Error(`${backup.path} already exists with other content`);
	await mkdir(dirname(backup.target), { recursive: true });
	await writeFile(backup.target, backup.text);
	return true;
}

/** Deletes backup copies that are no longer needed, then the directories that leaves empty in the backup store. */
async function discardBackups(configRoot: string, paths: readonly string[]): Promise<void> {
	await Promise.all(paths.map((path) => rm(join(configRoot, path), { force: true })));
	await removeEmptyTree(join(configRoot, BACKUP_DIR));
}

/**
 * Removes the directories a step left empty: installer-prefixed ones and the ones the manifest says the install
 * created. Never recursive, so a directory that still holds anything stays.
 */
async function pruneDirs(
	configRoot: string,
	touched: readonly string[],
	created: ReadonlySet<string>,
): Promise<void> {
	const dirs = new Set<string>();
	for (const path of touched) {
		let dir = posix.dirname(path);
		while (dir !== ".") {
			dirs.add(dir);
			dir = posix.dirname(dir);
		}
	}
	const deepestFirst = [...dirs].sort(
		(left, right) => right.split("/").length - left.split("/").length,
	);
	for (const dir of deepestFirst) {
		if (created.has(dir) || posix.basename(dir).startsWith(MANAGED_PREFIX)) {
			await rmdir(join(configRoot, dir)).catch(() => undefined);
		}
	}
	if (created.has(".")) await rmdir(configRoot).catch(() => undefined);
}

async function removeEmptyTree(dir: string): Promise<void> {
	for (const entry of await readEntries(dir)) {
		if (entry.isDirectory()) await removeEmptyTree(join(dir, entry.name));
	}
	await rmdir(dir).catch(() => undefined);
}
