// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { HOST_VERSION_FLOORS } from "../version-floor.ts";
import { type OmpCommandHandler, createOmpCommandPort } from "./commands.ts";

/** Omp version recorded in docs/plugin-research/host-contracts.md ("Host versions used"). The live version is not read. */
const RECORDED_OMP_VERSION = "18.19.0";

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

describe("createOmpCommandPort dispatch", () => {
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
			{ observedVersion: RECORDED_OMP_VERSION },
		);

		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
	});
});

describe("createOmpCommandPort version floor", () => {
	test("(a) a version at the floor routes commands unchanged", async () => {
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

	test("(b) a version below the floor is refused: no command listed, handler never called", async () => {
		const calls: string[] = [];
		const port = createOmpCommandPort(recordingHandlers(calls), { observedVersion: "18.18.9" });

		expect(port.list()).toEqual([]);
		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: false,
			error: { category: "internal", message: "omp version below minimum 18.19.0" },
		});
		expect(calls).toEqual([]);
	});

	test("(c) a null (unreadable) version is refused fail-closed", async () => {
		const calls: string[] = [];
		const port = createOmpCommandPort(recordingHandlers(calls), { observedVersion: null });

		expect(port.list()).toEqual([]);
		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: false,
			error: { category: "internal", message: "omp version unknown; minimum 18.19.0" },
		});
		expect(calls).toEqual([]);
	});

	test("(c) a version that is not dotted numeric is refused fail-closed", async () => {
		const calls: string[] = [];
		for (const observedVersion of ["unknown", "1.x", ""]) {
			const port = createOmpCommandPort(recordingHandlers(calls), { observedVersion });

			expect(port.list()).toEqual([]);
			expect(await port.invoke("ultrathink-status", input, context)).toEqual({
				ok: false,
				error: { category: "internal", message: "omp version unknown; minimum 18.19.0" },
			});
		}
		expect(calls).toEqual([]);
	});

	test("(d) a dispatched command under a refused version shows the refusal", async () => {
		const calls: string[] = [];
		const port = createOmpCommandPort(recordingHandlers(calls), { observedVersion: null });

		expect(await port.invoke("ultrathink-status", input, context)).toEqual({
			ok: false,
			error: { category: "internal", message: "omp version unknown; minimum 18.19.0" },
		});
		expect(calls).toEqual([]);
	});
});
