// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export interface FileStat {
	readonly size: number;
	readonly mtimeMs: number;
	readonly isDirectory: boolean;
}

/**
 * Filesystem access for core.
 * Relative paths resolve against the project root. Adapters MUST reject any path whose normalized form
 * escapes its allowed roots (project root, plugin state dir) with a `permission_denied` CategorizedError.
 * Writes are limited to those roots. `atomicWrite` MUST write a temp file and rename it into place.
 */
export interface FileSystemPort {
	read(path: string): Promise<string>;
	atomicWrite(path: string, content: string): Promise<void>;
	list(path: string): Promise<readonly string[]>;
	stat(path: string): Promise<FileStat>;
}

export interface ClockPort {
	now(): number;
}

export interface SpawnRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

export interface SpawnResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Process spawning for core.
 * `command` MUST be in the adapter's allowlist; a disallowed command rejects with `permission_denied`.
 * `args` is passed as an argv array. No shell interpolation is ever performed.
 */
export interface ProcessPort {
	spawn(request: SpawnRequest): Promise<SpawnResult>;
}
