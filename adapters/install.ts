// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Host-neutral plugin install engine. Files are staged in a sibling directory of the target,
 * required files are checked, the staging directory is renamed into place, and registrations are
 * applied in order. Any failure reverts applied registrations in reverse order, removes the new
 * install, and restores the previous target directory. Installing identical files again is a no-op.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

const INSTALL_RECORD_FILE = ".ultrathink-install.json";

export interface Registration {
	readonly name: string;
	apply(): Promise<void>;
	revert(): Promise<void>;
}

export interface InstallOptions {
	readonly targetDir: string;
	readonly files: ReadonlyMap<string, string>;
	readonly requiredFiles: readonly string[];
	readonly registrations?: readonly Registration[];
}

interface InstallError {
	readonly category: "install_failed";
	readonly message: string;
	readonly nextAction: string;
}

export type InstallResult =
	| { readonly ok: true; readonly status: "installed" | "unchanged" }
	| { readonly ok: false; readonly error: InstallError };

type Entry = readonly [path: string, content: string];

interface Journal {
	staging: string | undefined;
	backup: string | undefined;
	swapped: boolean;
	readonly applied: Registration[];
}

const PATH_ACTION =
	"Use relative paths inside the plugin directory with no '..' segments, then rerun the install.";
const RETRY_ACTION =
	"Fix the reported error and rerun the install; the previous installation was left in place.";
const INSPECT_ACTION =
	"Inspect the reported revert failures and the target directory before rerunning the install.";

export async function installPlugin(options: InstallOptions): Promise<InstallResult> {
	const pathProblem = findUnsafePath(options);
	if (pathProblem !== undefined) {
		return {
			ok: false,
			error: { category: "install_failed", message: pathProblem, nextAction: PATH_ACTION },
		};
	}

	const target = resolve(options.targetDir);
	const entries = [...options.files.entries()].sort(([left], [right]) =>
		compareCodeUnits(left, right),
	);
	const hash = contentHash(entries);
	const journal: Journal = { staging: undefined, backup: undefined, swapped: false, applied: [] };

	try {
		if (await recordMatches(target, hash)) return { ok: true, status: "unchanged" };

		await mkdir(dirname(target), { recursive: true });
		const staging = join(
			dirname(target),
			`.${basename(target)}.staging-${randomBytes(6).toString("hex")}`,
		);
		journal.staging = staging;
		await stageFiles(staging, entries, hash);
		await validateRequired(staging, options.requiredFiles);

		if (await pathExists(target)) {
			const backup = join(
				dirname(target),
				`.${basename(target)}.backup-${randomBytes(6).toString("hex")}`,
			);
			await rename(target, backup);
			journal.backup = backup;
		}
		await rename(staging, target);
		journal.swapped = true;
		journal.staging = undefined;

		for (const registration of options.registrations ?? []) {
			await registration.apply();
			journal.applied.push(registration);
		}
	} catch (error) {
		return rollback(target, journal, error);
	}

	if (journal.backup !== undefined) {
		// The new install is live here; a leftover backup sibling is clutter, not a failed install.
		await rm(journal.backup, { recursive: true, force: true }).catch(() => undefined);
	}
	return { ok: true, status: "installed" };
}

function findUnsafePath(options: InstallOptions): string | undefined {
	for (const path of options.files.keys()) {
		if (path === INSTALL_RECORD_FILE)
			return `file ${JSON.stringify(path)} is reserved for the install record`;
		const reason = unsafePathReason(path);
		if (reason !== undefined) return `unsafe file path ${JSON.stringify(path)}: ${reason}`;
	}
	for (const path of options.requiredFiles) {
		const reason = unsafePathReason(path);
		if (reason !== undefined) return `unsafe required file path ${JSON.stringify(path)}: ${reason}`;
	}
	return undefined;
}

function unsafePathReason(path: string): string | undefined {
	if (path.length === 0) return "empty path";
	if (isAbsolute(path) || win32.isAbsolute(path)) return "absolute paths are not allowed";
	if (path.split(/[\\/]/).includes("..")) return "'..' segments are not allowed";
	return undefined;
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

function contentHash(entries: readonly Entry[]): string {
	const hash = createHash("sha256");
	for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`);
	return hash.digest("hex");
}

async function recordMatches(target: string, hash: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(join(target, INSTALL_RECORD_FILE), "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return false;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return (
			typeof parsed === "object" && parsed !== null && "hash" in parsed && parsed.hash === hash
		);
	} catch {
		// A corrupt record cannot prove the installed content matches, so reinstall.
		return false;
	}
}

async function stageFiles(staging: string, entries: readonly Entry[], hash: string): Promise<void> {
	await mkdir(staging);
	for (const [path, content] of entries) {
		const destination = join(staging, path);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, content);
	}
	const record = { hash, files: entries.map(([path]) => path) };
	await writeFile(join(staging, INSTALL_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

async function validateRequired(staging: string, required: readonly string[]): Promise<void> {
	for (const path of required) {
		const isFile = await stat(join(staging, path)).then(
			(info) => info.isFile(),
			(error: unknown) => {
				if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return false;
				throw error;
			},
		);
		if (!isFile) throw new Error(`required file is missing or not a regular file: ${path}`);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
}

async function rollback(target: string, journal: Journal, error: unknown): Promise<InstallResult> {
	const problems: string[] = [];
	for (const registration of [...journal.applied].reverse()) {
		await attempt(problems, `revert of "${registration.name}"`, () => registration.revert());
	}
	if (journal.swapped) {
		await attempt(problems, "removing the new install", () =>
			rm(target, { recursive: true, force: true }),
		);
	}
	if (journal.backup !== undefined) {
		const backup = journal.backup;
		await attempt(problems, `restoring the previous install from ${backup}`, () =>
			rename(backup, target),
		);
	}
	if (journal.staging !== undefined) {
		const staging = journal.staging;
		await attempt(problems, "removing the staging directory", () =>
			rm(staging, { recursive: true, force: true }),
		);
	}
	return {
		ok: false,
		error: {
			category: "install_failed",
			message: [error instanceof Error ? error.message : String(error), ...problems].join("; "),
			nextAction: problems.length === 0 ? RETRY_ACTION : INSPECT_ACTION,
		},
	};
}

async function attempt(
	problems: string[],
	description: string,
	step: () => Promise<void>,
): Promise<void> {
	try {
		await step();
	} catch (error) {
		problems.push(
			`${description} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
