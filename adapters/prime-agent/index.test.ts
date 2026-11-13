// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	type AdapterEntry,
	type AdapterRunner,
	createPrimeAgentAdapter,
	PRIME_AGENT_ENTRY_PATH,
} from "./index.ts";

const context = { correlationId: "test-correlation" };

type Reply = { readonly exitCode: number; readonly stdout: string } | Error;

function fakeRunner(reply: Reply): { readonly runner: AdapterRunner; readonly calls: string[][] } {
	const calls: string[][] = [];
	const runner: AdapterRunner = {
		async run(argv) {
			calls.push([...argv]);
			if (reply instanceof Error) throw reply;
			return reply;
		},
	};
	return { runner, calls };
}

const presentEntry: AdapterEntry = { exists: () => true };
const missingEntry: AdapterEntry = { exists: () => false };

describe("createPrimeAgentAdapter", () => {
	test("lists the six ultrathink commands as side-effecting", () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "" });
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: presentEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const definitions = adapter.list();
		expect(definitions.map((definition) => definition.name)).toEqual([
			"ultrathink-quick",
			"ultrathink-skip",
			"ultrathink-off",
			"ultrathink-on",
			"ultrathink-track",
			"ultrathink-status",
		]);
		for (const definition of definitions) expect(definition.idempotency).toBe("side-effecting");
	});

	test("valid: a known command runs the engine once with its verb and returns ok", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ok\n" });
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: presentEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const result = await adapter.invoke("ultrathink-quick", {}, context);
		expect(result).toEqual({ ok: true, value: { stdout: "ok\n" } });
		expect(calls).toEqual([["quick"]]);
	});

	test("valid: stdout is returned in full when longer than 4096 characters", async () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "x".repeat(5000) });
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: presentEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const result = await adapter.invoke("ultrathink-status", {}, context);
		expect(result).toEqual({ ok: true, value: { stdout: "x".repeat(5000) } });
	});

	test("invalid: an unknown command name returns invalid_input and never runs the engine", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "" });
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: presentEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const result = await adapter.invoke("ultrathink-nope", {}, context);
		expect(result).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown command: ultrathink-nope" },
		});
		expect(calls).toEqual([]);
	});

	test("core error: a throwing runner returns internal without the thrown text", async () => {
		const { runner } = fakeRunner(new Error("secret-token-abc123 leaked"));
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: presentEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const result = await adapter.invoke("ultrathink-on", {}, context);
		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("secret-token-abc123");
	});

	test("core error: a non-zero exit returns internal without the engine output", async () => {
		const { runner } = fakeRunner({ exitCode: 1, stdout: "stderr-secret-xyz" });
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: presentEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const result = await adapter.invoke("ultrathink-off", {}, context);
		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("stderr-secret-xyz");
	});

	test("host-unsupported: a missing entry point returns capability_missing and skips the runner", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ok" });
		const adapter = createPrimeAgentAdapter({
			runner,
			entry: missingEntry,
			entryPath: PRIME_AGENT_ENTRY_PATH,
		});
		const result = await adapter.invoke("ultrathink-track", {}, context);
		expect(result).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host entry point missing" },
		});
		expect(calls).toEqual([]);
	});
});
