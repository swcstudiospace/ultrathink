// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveStateDir } from "./host/paths.ts";

describe("the bunfig preload isolates the state directory", () => {
	test("ULTRATHINK_STATE_DIR names an existing temp directory outside the operator's state", () => {
		const dir = process.env.ULTRATHINK_STATE_DIR?.trim();
		expect(dir).toBeTruthy();
		if (!dir) return;
		expect(statSync(dir).isDirectory()).toBe(true);
		expect(relative(tmpdir(), dir).startsWith("..")).toBe(false);
		expect(dir.startsWith(join(homedir(), ".claude"))).toBe(false);
		expect(resolveStateDir()).toBe(dir);
	});

	test("failover cooldowns of a test process never reach the real state directory", () => {
		const dir = process.env.ULTRATHINK_STATE_DIR?.trim() ?? "";
		expect(join(resolveStateDir(), "failover-cooldowns.json").startsWith(dir)).toBe(true);
		// The operator's own file is untouched by this process: it is either absent or not under the temp state dir.
		const real = join(homedir(), ".claude", "ultrathink", "failover-cooldowns.json");
		expect(real.startsWith(dir)).toBe(false);
		expect(existsSync(dir)).toBe(true);
	});
});
