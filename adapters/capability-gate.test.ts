// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { CAPABILITY_FALLBACKS } from "../core/src/capabilities/manifest.ts";
import { gateCapabilities } from "./capability-gate.ts";
import { type HostId, HOST_VERSION_FLOORS, checkVersionFloor } from "./version-floor.ts";

describe("gateCapabilities", () => {
	test("a false flag returns the documented fallback", () => {
		expect(gateCapabilities(["supports_subagents"], { supports_subagents: false })).toEqual([
			{
				flag: "supports_subagents",
				enabled: false,
				fallback: CAPABILITY_FALLBACKS.supports_subagents,
			},
		]);
	});

	test("a true flag passes with no fallback", () => {
		expect(gateCapabilities(["supports_hooks"], { supports_hooks: true })).toEqual([
			{ flag: "supports_hooks", enabled: true, fallback: null },
		]);
	});

	test("an undeclared flag is disabled and returns its fallback, in request order", () => {
		expect(
			gateCapabilities(["supports_skills", "supports_hooks"], { supports_hooks: true }),
		).toEqual([
			{
				flag: "supports_skills",
				enabled: false,
				fallback: CAPABILITY_FALLBACKS.supports_skills,
			},
			{ flag: "supports_hooks", enabled: true, fallback: null },
		]);
	});
});

describe("checkVersionFloor", () => {
	test("records the observed version of each host as its floor", () => {
		expect(HOST_VERSION_FLOORS).toEqual({
			"claude-code": "2.1.322",
			"grok-build": "1.0.77",
			muse: "1.4.14",
			hermes: "v0.23.1",
			"prime-agent": "0.10.2",
			omp: "18.19.0",
		});
	});

	test("a version below the floor is refused", () => {
		expect(checkVersionFloor("claude-code", "2.1.321")).toEqual({
			ok: false,
			reason: "below_floor",
			floor: "2.1.322",
			observed: "2.1.321",
		});
	});

	test("an equal version passes", () => {
		expect(checkVersionFloor("omp", "18.19.0")).toEqual({
			ok: true,
			floor: "18.19.0",
			observed: "18.19.0",
		});
		expect(checkVersionFloor("hermes", "0.23.1")).toEqual({
			ok: true,
			floor: "v0.23.1",
			observed: "0.23.1",
		});
	});

	test("every recorded floor passes against itself", () => {
		for (const hostId of Object.keys(HOST_VERSION_FLOORS) as HostId[]) {
			expect(checkVersionFloor(hostId, HOST_VERSION_FLOORS[hostId]).ok).toBe(true);
		}
	});

	test("an unknown observed version is refused", () => {
		for (const observed of [null, "unknown", "", "1.x", "2.1.322-beta"]) {
			expect(checkVersionFloor("claude-code", observed)).toMatchObject({
				ok: false,
				reason: "unknown_version",
				floor: "2.1.322",
				observed,
			});
		}
	});

	test("components compare numerically, not as text", () => {
		expect(checkVersionFloor("claude-code", "2.1.1000").ok).toBe(true);
		expect(checkVersionFloor("claude-code", "2.1").ok).toBe(false);
	});
});
