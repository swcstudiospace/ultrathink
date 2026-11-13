// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { CAPABILITY_FALLBACKS } from "../../core/src/capabilities/manifest.ts";
import {
	type AdapterEntry,
	type AdapterOutcome,
	type AdapterRunner,
	createHermesAdapter,
	HERMES_ENTRY_PATH,
} from "./index.ts";

const context = { correlationId: "test-correlation" };

function fakeRunner(outcome: () => Promise<AdapterOutcome>): {
	readonly calls: string[][];
	readonly runner: AdapterRunner;
} {
	const calls: string[][] = [];
	return {
		calls,
		runner: {
			run: async (argv) => {
				calls.push([...argv]);
				return outcome();
			},
		},
	};
}

const presentEntry: AdapterEntry = { exists: () => true };
const missingEntry: AdapterEntry = { exists: () => false };

describe("createHermesAdapter", () => {
	test("a known verb runs bin/ultrathink once with only that verb and returns ok", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "engine output" }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-status", {}, context);

		expect(fake.calls).toEqual([["status"]]);
		expect(result).toEqual({ ok: true, value: { stdout: "engine output" } });
	});

	test("an unknown command name returns invalid_input and never runs the engine", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "" }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-nope", {}, context);

		expect(result).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown command: ultrathink-nope" },
		});
		expect(fake.calls).toEqual([]);
	});

	test("hermes-only commands are not wired to bin/ultrathink", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "" }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		for (const name of ["ultrathink-learn", "ultrathink-lessons"]) {
			const result = await adapter.invoke(name, {}, context);
			expect(result.ok).toBe(false);
		}
		expect(fake.calls).toEqual([]);
	});

	test("a runner that throws returns internal and omits the thrown text", async () => {
		const fake = fakeRunner(async () => {
			throw new Error("secret-token-123");
		});
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-on", {}, context);

		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("secret-token-123");
	});

	test("a non-zero exit returns internal and omits stdout", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 2, stdout: "secret-token-456" }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-off", {}, context);

		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("secret-token-456");
	});

	test("successful stdout is returned in full, even when longer than 4096 characters", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "x".repeat(5000) }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-track", {}, context);

		expect(result).toEqual({ ok: true, value: { stdout: "x".repeat(5000) } });
	});

	test("a missing host entry point returns capability_missing and never runs the engine", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "" }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: missingEntry,
			entryPath: HERMES_ENTRY_PATH,
		});

		const result = await adapter.invoke("ultrathink-quick", {}, context);

		expect(result).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host entry point missing" },
		});
		expect(fake.calls).toEqual([]);
	});

	test("list declares exactly the six ultrathink commands, all side-effecting", () => {
		const adapter = createHermesAdapter({
			runner: fakeRunner(async () => ({ exitCode: 0, stdout: "" })).runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
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

	test("a false supports_slash_commands flag returns its fallback and never runs the engine", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "" }));
		for (const capabilities of [{ supports_slash_commands: false }, {}]) {
			const adapter = createHermesAdapter({
				runner: fake.runner,
				entry: presentEntry,
				entryPath: HERMES_ENTRY_PATH,
				capabilities,
			});

			const result = await adapter.invoke("ultrathink-status", {}, context);

			expect(result).toEqual({
				ok: false,
				error: {
					category: "capability_missing",
					message: CAPABILITY_FALLBACKS.supports_slash_commands,
				},
			});
		}
		expect(fake.calls).toEqual([]);
	});

	test("a true supports_slash_commands flag runs the engine unchanged", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "engine output" }));
		const adapter = createHermesAdapter({
			runner: fake.runner,
			entry: presentEntry,
			entryPath: HERMES_ENTRY_PATH,
			capabilities: { supports_slash_commands: true },
		});

		const result = await adapter.invoke("ultrathink-status", {}, context);

		expect(fake.calls).toEqual([["status"]]);
		expect(result).toEqual({ ok: true, value: { stdout: "engine output" } });
	});

	test("a host version below the floor is refused and never runs the engine", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "" }));
		for (const hostVersion of ["v0.23.0", "0.9.0"]) {
			const adapter = createHermesAdapter({
				runner: fake.runner,
				entry: presentEntry,
				entryPath: HERMES_ENTRY_PATH,
				hostVersion,
			});

			const result = await adapter.invoke("ultrathink-status", {}, context);

			expect(result).toEqual({
				ok: false,
				error: { category: "version_mismatch", message: "host version below v0.23.1" },
			});
		}
		expect(fake.calls).toEqual([]);
	});

	test("an unknown host version is refused and never runs the engine", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "" }));
		for (const hostVersion of [null, "unknown", "0.23.1-beta"]) {
			const adapter = createHermesAdapter({
				runner: fake.runner,
				entry: presentEntry,
				entryPath: HERMES_ENTRY_PATH,
				hostVersion,
			});

			const result = await adapter.invoke("ultrathink-status", {}, context);

			expect(result).toEqual({
				ok: false,
				error: { category: "version_mismatch", message: "host version unknown" },
			});
		}
		expect(fake.calls).toEqual([]);
	});

	test("a host version at or above the floor is accepted and unchanged", async () => {
		const fake = fakeRunner(async () => ({ exitCode: 0, stdout: "engine output" }));
		for (const hostVersion of ["v0.23.1", "0.23.1", "0.24.0"]) {
			const adapter = createHermesAdapter({
				runner: fake.runner,
				entry: presentEntry,
				entryPath: HERMES_ENTRY_PATH,
				hostVersion,
			});

			const result = await adapter.invoke("ultrathink-status", {}, context);

			expect(result).toEqual({ ok: true, value: { stdout: "engine output" } });
		}
		expect(fake.calls).toEqual([["status"], ["status"], ["status"]]);
	});
});
