// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig } from "../config.ts";
import { DEFAULT_MUSE_CONFIG } from "./types.ts";

describe("muse call timeout default", () => {
	test("default muse config arms a child timeout", () => {
		expect(DEFAULT_MUSE_CONFIG.callTimeoutMs).toBe(300_000);
		expect(defaultConfig().muse.callTimeoutMs).toBeGreaterThan(0);
	});

	test("an explicit 0 from the user config is preserved as no timer", () => {
		expect(mergeConfig({ muse: { callTimeoutMs: 0 } }, defaultConfig()).muse.callTimeoutMs).toBe(0);
	});

	test("a project layer's 0 cannot remove the bound the earlier layer set", () => {
		expect(
			mergeConfig({ muse: { callTimeoutMs: 0 } }, defaultConfig(), { project: true }).muse
				.callTimeoutMs,
		).toBe(300_000);
	});
});
