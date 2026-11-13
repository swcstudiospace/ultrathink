// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type AdapterEntry, type AdapterRunner, createClaudeCodeAdapter } from "./index.ts";

const ENTRY_PATH = "hooks/hooks.json";
const CONTEXT = { correlationId: "test" };

type Outcome = { readonly exitCode: number; readonly stdout: string } | Error;

function fakeRunner(outcome: Outcome): AdapterRunner & { readonly calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		async run(argv) {
			calls.push([...argv]);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	};
}

function fakeEntry(present: boolean): AdapterEntry {
	return { exists: (path) => present && path === ENTRY_PATH };
}

describe("createClaudeCodeAdapter", () => {
	test("lists one side-effecting command per engine verb", () => {
		const adapter = createClaudeCodeAdapter({
			runner: fakeRunner({ exitCode: 0, stdout: "" }),
			entry: fakeEntry(true),
			entryPath: ENTRY_PATH,
		});
		const names = adapter.list().map((definition) => definition.name);
		expect(names).toEqual([
			"ultrathink-quick",
			"ultrathink-skip",
			"ultrathink-off",
			"ultrathink-on",
			"ultrathink-track",
			"ultrathink-status",
		]);
		for (const definition of adapter.list()) {
			expect(definition.idempotency).toBe("side-effecting");
		}
	});

	test("valid: a known command runs its verb once and returns stdout", async () => {
		const runner = fakeRunner({ exitCode: 0, stdout: "quick ok\n" });
		const adapter = createClaudeCodeAdapter({
			runner,
			entry: fakeEntry(true),
			entryPath: ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-quick", {}, CONTEXT);

		expect(runner.calls).toEqual([["quick"]]);
		expect(result).toEqual({ ok: true, value: { stdout: "quick ok\n" } });
	});

	test("valid: stdout is returned in full without truncation", async () => {
		const stdout = "x".repeat(5000);
		const runner = fakeRunner({ exitCode: 0, stdout });
		const adapter = createClaudeCodeAdapter({
			runner,
			entry: fakeEntry(true),
			entryPath: ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-status", {}, CONTEXT);

		expect(result).toEqual({ ok: true, value: { stdout } });
	});

	test("invalid: an unknown name returns invalid_input without running", async () => {
		const runner = fakeRunner({ exitCode: 0, stdout: "" });
		const adapter = createClaudeCodeAdapter({
			runner,
			entry: fakeEntry(true),
			entryPath: ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-learn", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown command: ultrathink-learn" },
		});
		expect(runner.calls).toEqual([]);
	});

	test("core error: a throwing runner returns internal without the thrown text", async () => {
		const runner = fakeRunner(new Error("token=sk-secret-123"));
		const adapter = createClaudeCodeAdapter({
			runner,
			entry: fakeEntry(true),
			entryPath: ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-on", {}, CONTEXT);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.category).toBe("internal");
		expect(result.error.message).toBe("command failed");
		expect(result.error.message).not.toContain("sk-secret-123");
	});

	test("core error: a non-zero exit returns internal without stdout", async () => {
		const runner = fakeRunner({ exitCode: 2, stdout: "leaked detail" });
		const adapter = createClaudeCodeAdapter({
			runner,
			entry: fakeEntry(true),
			entryPath: ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-off", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(runner.calls).toEqual([["off"]]);
	});

	test("host-unsupported: a missing entry point returns capability_missing without running", async () => {
		const runner = fakeRunner({ exitCode: 0, stdout: "" });
		const adapter = createClaudeCodeAdapter({
			runner,
			entry: fakeEntry(false),
			entryPath: ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-skip", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host entry point missing" },
		});
		expect(runner.calls).toEqual([]);
	});
});
