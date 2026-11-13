// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat as statPath,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CategorizedError, ErrorCategory } from "../../core/src/ports/command.ts";
import type {
	ClockPort,
	FileStat,
	FileSystemPort,
	ProcessPort,
	SpawnRequest,
	SpawnResult,
} from "../../core/src/ports/injection.ts";

function categorized(category: ErrorCategory, message: string): CategorizedError {
	return Object.assign(new Error(message), { category });
}

/** Maps a Node error onto a shared category. The message carries the error code only, never file contents. */
function fromNodeError(error: unknown, operation: string, subject: string): CategorizedError {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	const category: ErrorCategory =
		code === "ENOENT" || code === "ENOTDIR"
			? "invalid_input"
			: code === "EACCES" || code === "EPERM"
				? "permission_denied"
				: "internal";
	return categorized(category, `${operation} failed for ${subject}: ${code ?? "unknown error"}`);
}

/** Resolves `path` against `root` and rejects anything whose resolved form lies outside `root`. */
function confine(rootAbsolute: string, path: string): string {
	const target = resolve(rootAbsolute, path);
	const rel = relative(rootAbsolute, target);
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw categorized("permission_denied", `path outside root: ${path}`);
	}
	return target;
}

/** FileSystemPort backed by node:fs/promises. Every path is confined to `root`. */
export function createOmpFileSystem(root: string): FileSystemPort {
	const rootAbsolute = resolve(root);
	return {
		async read(path) {
			const target = confine(rootAbsolute, path);
			try {
				return await readFile(target, "utf8");
			} catch (error) {
				throw fromNodeError(error, "read", path);
			}
		},
		async atomicWrite(path, content) {
			const target = confine(rootAbsolute, path);
			const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
			try {
				await mkdir(dirname(target), { recursive: true });
				await writeFile(temp, content, "utf8");
				await rename(temp, target);
			} catch (error) {
				await rm(temp, { force: true }).catch(() => undefined);
				throw fromNodeError(error, "atomicWrite", path);
			}
		},
		async list(path) {
			const target = confine(rootAbsolute, path);
			try {
				return (await readdir(target)).sort();
			} catch (error) {
				throw fromNodeError(error, "list", path);
			}
		},
		async stat(path) {
			const target = confine(rootAbsolute, path);
			try {
				const info = await statPath(target);
				const result: FileStat = {
					size: info.size,
					mtimeMs: info.mtimeMs,
					isDirectory: info.isDirectory(),
				};
				return result;
			} catch (error) {
				throw fromNodeError(error, "stat", path);
			}
		},
	};
}

/** ClockPort backed by Date.now(). */
export function createOmpClock(): ClockPort {
	return {
		now: () => Date.now(),
	};
}

/**
 * ProcessPort backed by node:child_process execFile.
 * A command runs only when it is a bare name (no path separators) and exactly matches an allowlist entry.
 * Path-qualified commands are rejected even when their basename is allowlisted, so a planted binary
 * such as /tmp/x/git cannot run. Arguments are passed as argv; no shell is ever involved.
 */
export function createOmpProcess(allowlist: readonly string[]): ProcessPort {
	const allowed = new Set(allowlist);
	return {
		spawn(request: SpawnRequest): Promise<SpawnResult> {
			const { command, args, cwd } = request;
			if (basename(command) !== command || !allowed.has(command)) {
				return Promise.reject(
					categorized("permission_denied", `command not allowlisted: ${command}`),
				);
			}
			const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();
			execFile(
				command,
				[...args],
				{ cwd, encoding: "utf8", windowsHide: true },
				(error, stdout, stderr) => {
					if (!error) {
						resolve({ exitCode: 0, stdout, stderr });
						return;
					}
					if (typeof error.code === "number") {
						resolve({ exitCode: error.code, stdout, stderr });
						return;
					}
					reject(fromNodeError(error, "spawn", command));
				},
			);
			return promise;
		},
	};
}
