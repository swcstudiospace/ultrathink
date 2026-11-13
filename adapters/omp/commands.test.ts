// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { HOST_VERSION_FLOORS } from "../version-floor.ts";
import { type OmpCommandHandler, createOmpCommandPort } from "./commands.ts";

/** Omp runtime package version (`VERSION` from @oh-my-pi/pi-utils), which is the Omp version floor. */
const RECORDED_OMP_VERSION = "18.14.0";

const input = { args: "now", ctx: {} };
const context = { correlationId: "test" };

function recordingHandlers(calls: string[]): ReadonlyMap<string, OmpCommandHandler> {
	return new Map<string, OmpCommandHandler>([
		[
			"ultrathink-status",
			(args) => {
				calls.push(args);
				return "status";
			},
		],
	]);
}

describe("createOmpCommandPort without an observed version", () => {
	test("lists and routes commands unchanged when no version is supplied", async () => {
		const calls: string[] = [];
		const port = createOmpCommandPort(recordingHandlers(calls));

		expect(port.list().map((definition) => definition.name)).toEqual(["ultrathink-status"]);
		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: true,
			value: "status",
		});
		expect(calls).toEqual(["now"]);
	});

	test("a handler that throws still yields the fixed message, not its text", async () => {
		const port = createOmpCommandPort(
			new Map<string, OmpCommandHandler>([
				[
					"ultrathink-status",
					() => {
						throw new Error("token=abc");
					},
				],
			]),
		);

		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
	});
});

describe("createOmpCommandPort version floor", () => {
	test("the recorded version, which equals the floor, routes commands unchanged", async () => {
		expect(HOST_VERSION_FLOORS.omp).toBe(RECORDED_OMP_VERSION);
		const calls: string[] = [];
		const port = createOmpCommandPort(recordingHandlers(calls), {
			observedVersion: RECORDED_OMP_VERSION,
		});

		expect(port.list().map((definition) => definition.name)).toEqual(["ultrathink-status"]);
		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: true,
			value: "status",
		});
		expect(calls).toEqual(["now"]);
	});

	test("a version above the floor routes commands unchanged", async () => {
		const port = createOmpCommandPort(recordingHandlers([]), { observedVersion: "18.20.0" });

		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: true,
			value: "status",
		});
	});

	test("a version below the floor is refused: no command listed, handler never called", async () => {
		const calls: string[] = [];
		const port = createOmpCommandPort(recordingHandlers(calls), { observedVersion: "18.13.9" });

		expect(port.list()).toEqual([]);
		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: false,
			error: { category: "internal", message: "omp version below minimum 18.14.0" },
		});
		expect(calls).toEqual([]);
	});

	test("an unknown version is refused fail-closed", async () => {
		const calls: string[] = [];
		for (const observedVersion of [null, "unknown", "1.x"]) {
			const port = createOmpCommandPort(recordingHandlers(calls), { observedVersion });

			expect(port.list()).toEqual([]);
			expect(await port.invoke("ultrathink-status", input, context)).toEqual({
				ok: false,
				error: { category: "internal", message: "omp version unknown; minimum 18.14.0" },
			});
		}
		expect(calls).toEqual([]);
	});
});
