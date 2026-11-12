// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type AdapterEntry, type AdapterRunner, createGrokBuildAdapter } from "./index.ts";

const ENTRY_PATH = "hooks/hooks.json";
const CONTEXT = { correlationId: "test" };

function fakeRunner(outcome: { exitCode: number; stdout: string } | Error) {
	const calls: string[][] = [];
	const runner: AdapterRunner = {
		async run(argv) {
			calls.push([...argv]);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	};
	return { runner, calls };
}

const presentEntry: AdapterEntry = { exists: () => true };
const missingEntry: AdapterEntry = { exists: () => false };

describe("grok-build adapter", () => {
	test("lists the six ultrathink commands as side-effecting", () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "" });
		const port = createGrokBuildAdapter({ runner, entry: presentEntry, entryPath: ENTRY_PATH });
		expect(port.list().map((definition) => definition.name)).toEqual([
			"ultrathink-quick",
			"ultrathink-skip",
			"ultrathink-off",
			"ultrathink-on",
			"ultrathink-track",
			"ultrathink-status",
		]);
		expect(port.list().every((definition) => definition.idempotency === "side-effecting")).toBe(
			true,
		);
	});

	test("valid: a known command runs its verb once and returns the full stdout", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "x".repeat(5000) });
		const port = createGrokBuildAdapter({ runner, entry: presentEntry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-quick", undefined, CONTEXT);

		expect(calls).toEqual([["quick"]]);
		expect(result).toEqual({ ok: true, value: { stdout: "x".repeat(5000) } });
	});

	test("invalid: an unknown command returns invalid_input and never runs", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "" });
		const port = createGrokBuildAdapter({ runner, entry: presentEntry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-learn", undefined, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown command: ultrathink-learn" },
		});
		expect(calls).toEqual([]);
	});

	test("core error: a throwing runner returns internal without its text", async () => {
		const { runner } = fakeRunner(new Error("secret-token leaked"));
		const port = createGrokBuildAdapter({ runner, entry: presentEntry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-on", undefined, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("secret-token");
	});

	test("core error: a non-zero exit returns internal", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 2, stdout: "boom" });
		const port = createGrokBuildAdapter({ runner, entry: presentEntry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-off", undefined, CONTEXT);

		expect(calls).toEqual([["off"]]);
		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
	});

	test("host-unsupported: a missing entry point returns capability_missing and never runs", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "" });
		const port = createGrokBuildAdapter({ runner, entry: missingEntry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-status", undefined, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host entry point missing" },
		});
		expect(calls).toEqual([]);
	});
});
