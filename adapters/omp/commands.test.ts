// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type OmpCommandHandler, createOmpCommandPort } from "./commands.ts";

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

describe("createOmpCommandPort", () => {
	test("lists and routes commands unchanged", async () => {
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
