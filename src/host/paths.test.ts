// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { resolveStateDir, resolveStateDirDetail } from "./paths.ts";

/** The Claude default for an env with no host markers and no override. */
const defaultDir = resolveStateDirDetail({}).dir;

describe("resolveStateDirDetail", () => {
	test("accepts an absolute path inside the home directory", () => {
		const dir = join(homedir(), "proj", "state");
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: dir })).toEqual({ dir });
		expect(resolveStateDir({ ULTRATHINK_STATE_DIR: dir })).toBe(dir);
	});

	test("refuses a path outside home and returns the host default", () => {
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: "/tmp/x" })).toEqual({
			dir: defaultDir,
			rejected: { value: "/tmp/x", reason: "outside-home" },
		});
		expect(resolveStateDir({ ULTRATHINK_STATE_DIR: "/tmp/x" })).toBe(defaultDir);
	});

	test("refuses an empty or whitespace-only value", () => {
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: "" })).toEqual({
			dir: defaultDir,
			rejected: { value: "", reason: "empty" },
		});
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: "   " })).toEqual({
			dir: defaultDir,
			rejected: { value: "", reason: "empty" },
		});
	});

	test("refuses a relative path", () => {
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: "relative/state" })).toEqual({
			dir: defaultDir,
			rejected: { value: "relative/state", reason: "relative" },
		});
	});

	test("refuses the home directory itself, with or without a trailing separator", () => {
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: homedir() })).toEqual({
			dir: defaultDir,
			rejected: { value: homedir(), reason: "home-directory" },
		});
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: `${homedir()}${sep}` })).toEqual({
			dir: defaultDir,
			rejected: { value: `${homedir()}${sep}`, reason: "home-directory" },
		});
	});

	test("refuses a planning-tree path even inside home", () => {
		const dir = join(homedir(), "proj", ".planning", "state");
		expect(resolveStateDirDetail({ ULTRATHINK_STATE_DIR: dir })).toEqual({
			dir: defaultDir,
			rejected: { value: dir, reason: "planning-path" },
		});
	});

	test("unset returns the host default with no rejection", () => {
		const unset = resolveStateDirDetail({});
		expect(unset).toEqual({ dir: defaultDir });
		expect("rejected" in unset).toBe(false);
		const undef = resolveStateDirDetail({ ULTRATHINK_STATE_DIR: undefined });
		expect(undef).toEqual({ dir: defaultDir });
		expect("rejected" in undef).toBe(false);
	});
});
