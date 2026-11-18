// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat as statPath,
	writeFile,
} from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/** Kill deadline for one allowlisted child. A hung child must not block its caller indefinitely. */
const DEFAULT_SPAWN_TIMEOUT_MS = 300_000;
/** Cap on stdout and stderr of one child; matches the execFile default, made explicit. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Resolves a bare command name to an absolute path using the PATH in effect now.
 * Relative PATH entries are skipped so they cannot resolve against a child's cwd.
 */
function resolveOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, name);
		try {
			if (statSync(candidate).isFile()) {
				accessSync(candidate, constants.X_OK);
				return candidate;
			}
		} catch {
			// Not executable in this directory; keep searching.
		}
	}
	return undefined;
}

/**
 * ProcessPort backed by node:child_process execFile.
 * A command runs only when it is a bare name (no path separators) and exactly matches an allowlist entry.
 * Path-qualified commands are rejected even when their basename is allowlisted, so a planted binary
 * such as /tmp/x/git cannot run. Each allowlisted name is resolved to an absolute path once, at
 * construction, against the PATH in effect then, and that path is spawned; a binary planted on PATH
 * later cannot take its place. The PATH in effect at construction is trusted.
 * Each child is killed after `timeoutMs` and its output is capped at MAX_OUTPUT_BYTES.
 * Arguments are passed as argv; no shell is ever involved.
 */
export function createOmpProcess(
	allowlist: readonly string[],
	options: { readonly timeoutMs?: number } = {},
): ProcessPort {
	const allowed = new Set(allowlist);
	const timeout = options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
	const executables = new Map<string, string>();
	for (const name of allowlist) {
		const found = resolveOnPath(name);
		if (found !== undefined) executables.set(name, found);
	}
	return {
		spawn(request: SpawnRequest): Promise<SpawnResult> {
			const { command, args, cwd } = request;
			if (basename(command) !== command || !allowed.has(command)) {
				return Promise.reject(
					categorized("permission_denied", `command not allowlisted: ${command}`),
				);
			}
			const executable = executables.get(command);
			if (executable === undefined) {
				return Promise.reject(categorized("invalid_input", `spawn failed for ${command}: ENOENT`));
			}
			const { promise, resolve, reject } = Promise.withResolvers<SpawnResult>();
			execFile(
				executable,
				[...args],
				{ cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: MAX_OUTPUT_BYTES },
				(error, stdout, stderr) => {
					if (!error) {
						resolve({ exitCode: 0, stdout, stderr });
						return;
					}
					if (typeof error.code === "number") {
						resolve({ exitCode: error.code, stdout, stderr });
						return;
					}
					// execFile sets `killed` both on timeout and on maxBuffer overflow; only the former is a timeout.
					if (error.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						reject(categorized("internal", `spawn timed out for ${command} after ${timeout} ms`));
						return;
					}
					reject(fromNodeError(error, "spawn", command));
				},
			);
			return promise;
		},
	};
}
