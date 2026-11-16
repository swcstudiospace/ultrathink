// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Synchronous filesystem access for core.
 * It is synchronous because the Omp hook paths that use it are synchronous; async paths use `FileSystemPort`.
 */
export interface SyncFileSystemPort {
	existsSync(path: string): boolean;
	readFileSync(path: string): string;
}
