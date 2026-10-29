// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a fresh directory under the OS temp dir with `prefix`, records it in `registry`, and returns it. Each caller
 * keeps its own registry and cleanup hook, so behaviour is unchanged from the per-file copies this replaces.
 */
export function makeTempDir(prefix: string, registry: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	registry.push(dir);
	return dir;
}
