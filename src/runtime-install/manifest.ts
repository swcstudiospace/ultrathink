// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The install manifest: the ledger of everything one install wrote into a runtime's config root. Uninstall acts on
 * this ledger alone, so a manifest read from disk is validated before anything is deleted: every path must stay
 * inside the config root and every installer-owned path must carry the `ultrathink-` prefix.
 */
import { isAbsolute } from "node:path";
import { isRecord } from "../shared.ts";
import type { EditRecord, JsonValue } from "./edits.ts";
import { BACKUP_DIR, type InstallScope, MANAGED_PREFIX } from "./plan.ts";

/** Name of the manifest file inside the manifest directory. */
export const MANIFEST_FILE = "manifest.json";

export interface ManifestFile {
	/** Relative to the config root. */
	readonly path: string;
	/** SHA-256 of the text the install wrote, to tell a later user edit from the installer's own file. */
	readonly sha256: string;
	/** Backup copy of the file that was at `path` before the first install; uninstall puts it back. */
	readonly original?: string;
}

export type ManifestEdit = EditRecord & {
	/** The edit created its file, so undoing the last edit may delete it. */
	readonly createdFile: boolean;
	/** Backup copy of the file as it was before the edit. */
	readonly backup?: string;
};

export interface Manifest {
	readonly schema: 1;
	readonly runtime: string;
	readonly scope: InstallScope;
	readonly cloneRoot: string;
	/** Raised by every change, so a repair of a drifted install still differs from the recorded one. */
	readonly generation: number;
	readonly files: readonly ManifestFile[];
	readonly edits: readonly ManifestEdit[];
	/** Directories the install created, relative to the config root ("." is the root itself). */
	readonly dirs: readonly string[];
}

/**
 * Text form of a manifest. Entries are rebuilt key by key, so the text depends only on the values: an install that
 * changed nothing serializes to the very bytes already on disk, whichever code path built each entry.
 */
export function serializeManifest(manifest: Manifest): string {
	const canonical = {
		schema: manifest.schema,
		runtime: manifest.runtime,
		scope: manifest.scope,
		cloneRoot: manifest.cloneRoot,
		generation: manifest.generation,
		files: manifest.files.map((file) => ({
			path: file.path,
			sha256: file.sha256,
			...(file.original === undefined ? {} : { original: file.original }),
		})),
		edits: manifest.edits.map((edit) => ({
			kind: edit.kind,
			file: edit.file,
			...(edit.kind === "json"
				? {
						key: edit.key,
						value: edit.value,
						...("previous" in edit ? { previous: edit.previous } : {}),
						existing: edit.existing,
					}
				: { id: edit.id }),
			createdFile: edit.createdFile,
			...(edit.backup === undefined ? {} : { backup: edit.backup }),
		})),
		dirs: manifest.dirs,
	};
	return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** A path that stays inside the config root: relative, no empty, `.` or `..` segment, "/" separators. */
export function isSafeRelative(value: unknown): value is string {
	if (typeof value !== "string" || value === "" || isAbsolute(value) || value.includes("\\")) {
		return false;
	}
	return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A safe path with an `ultrathink-` segment: the only kind of file an install may own. */
export function isManagedPath(value: unknown): value is string {
	return isSafeRelative(value) && value.split("/").some((part) => part.startsWith(MANAGED_PREFIX));
}

/** A safe path inside the backup directory. */
export function isBackupPath(value: unknown): value is string {
	return isSafeRelative(value) && value.startsWith(`${BACKUP_DIR}/`);
}

export function parseManifest(text: string, source: string): Manifest {
	const bad = (why: string) => new Error(`${source} is not a valid install manifest: ${why}`);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw bad("it is not JSON");
	}
	if (!isRecord(raw) || raw.schema !== 1) throw bad("unsupported schema");
	const { runtime, scope, cloneRoot, generation } = raw;
	if (
		typeof runtime !== "string" ||
		(scope !== "global" && scope !== "local") ||
		typeof cloneRoot !== "string" ||
		typeof generation !== "number" ||
		!Number.isInteger(generation)
	) {
		throw bad("its header is malformed");
	}
	const files = records(raw.files, bad).map((entry): ManifestFile => {
		const { path, sha256, original } = entry;
		if (!isManagedPath(path) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
			throw bad("a file entry is malformed");
		}
		if (original === undefined) return { path, sha256 };
		if (!isBackupPath(original)) throw bad("a file entry names an invalid backup");
		return { path, sha256, original };
	});
	const edits = records(raw.edits, bad).map((entry) => parseEdit(entry, bad));
	if (!Array.isArray(raw.dirs) || !raw.dirs.every((dir) => dir === "." || isSafeRelative(dir))) {
		throw bad("its directory list is malformed");
	}
	return {
		schema: 1,
		runtime,
		scope,
		cloneRoot,
		generation,
		files,
		edits,
		dirs: raw.dirs as string[],
	};
}

function records(value: unknown, bad: (why: string) => Error): Record<string, unknown>[] {
	if (!Array.isArray(value) || !value.every(isRecord)) throw bad("a list is malformed");
	return value;
}

function parseEdit(entry: Record<string, unknown>, bad: (why: string) => Error): ManifestEdit {
	const { kind, file, createdFile, backup } = entry;
	if (
		!isSafeRelative(file) ||
		typeof createdFile !== "boolean" ||
		(backup !== undefined && !isBackupPath(backup))
	) {
		throw bad("an edit entry is malformed");
	}
	const common = { file, createdFile, ...(backup === undefined ? {} : { backup }) };
	if (kind === "block" && typeof entry.id === "string") return { kind, id: entry.id, ...common };
	const { key, existing } = entry;
	if (
		kind === "json" &&
		Array.isArray(key) &&
		key.length > 0 &&
		key.every((segment) => typeof segment === "string") &&
		typeof existing === "number" &&
		Number.isInteger(existing) &&
		existing >= 0 &&
		existing <= key.length
	) {
		return {
			kind,
			key: key as string[],
			value: entry.value as JsonValue,
			...("previous" in entry ? { previous: entry.previous as JsonValue } : {}),
			existing,
			...common,
		};
	}
	throw bad("an edit entry is malformed");
}
