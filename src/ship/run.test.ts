// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultRun } from "./run.ts";

describe("defaultRun", () => {
	test("a child that outlives its deadline is a failure with a reason, never a clean exit 1 with empty stderr", () => {
		const result = defaultRun(["sleep", "5"], { timeoutMs: 100 });
		expect(result.exitCode).not.toBe(0);
		expect(result.exitCode).not.toBe(1);
		expect(result.stderr.trim()).not.toBe("");
	});

	test("a child killed by a signal is a failure with a reason, never a clean exit 1 with empty stderr", () => {
		const result = defaultRun(["sh", "-c", "kill -9 $$"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.exitCode).not.toBe(1);
		expect(result.stderr.trim()).not.toBe("");
	});
});
