// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createGrokBuildSubject } from "../../conformance/grok-build-subject.ts";
import { CAPABILITY_FALLBACKS } from "../../core/src/capabilities/manifest.ts";
import {
	type AdapterEntry,
	type AdapterRunner,
	GROK_BUILD_DECLARED_FLAGS,
	createGrokBuildAdapter,
} from "./index.ts";

const ENTRY_PATH = "hooks/hooks.json";
const CONTEXT = { correlationId: "test" };
const COMMAND_NAMES = [
	"ultrathink-quick",
	"ultrathink-skip",
	"ultrathink-off",
	"ultrathink-on",
	"ultrathink-track",
	"ultrathink-status",
];

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
		expect(port.list().map((definition) => definition.name)).toEqual(COMMAND_NAMES);
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

	test("declared flags match conformance/grok-build-subject.ts", () => {
		expect(GROK_BUILD_DECLARED_FLAGS).toEqual(createGrokBuildSubject().capabilities);
	});

	test("capability: every requested flag true runs every verb unchanged", async () => {
		for (const name of COMMAND_NAMES) {
			const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
			const port = createGrokBuildAdapter({
				runner,
				entry: presentEntry,
				entryPath: ENTRY_PATH,
				declared: { ...GROK_BUILD_DECLARED_FLAGS, supports_hooks: true },
			});

			const result = await port.invoke(name, undefined, CONTEXT);

			expect(calls).toHaveLength(1);
			expect(result).toEqual({ ok: true, value: { stdout: "ran" } });
		}
	});

	test("capability: a false hooks flag returns its fallback and never runs the verb", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
		const port = createGrokBuildAdapter({
			runner,
			entry: presentEntry,
			entryPath: ENTRY_PATH,
			declared: { ...GROK_BUILD_DECLARED_FLAGS, supports_hooks: false },
		});

		const result = await port.invoke("ultrathink-on", undefined, CONTEXT);

		expect(result).toEqual({ ok: true, value: { stdout: CAPABILITY_FALLBACKS.supports_hooks } });
		expect(calls).toEqual([]);
	});

	test("capability: a false slash-command flag returns its fallback for every command", async () => {
		for (const name of COMMAND_NAMES) {
			const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
			const port = createGrokBuildAdapter({
				runner,
				entry: presentEntry,
				entryPath: ENTRY_PATH,
				declared: { ...GROK_BUILD_DECLARED_FLAGS, supports_slash_commands: false },
			});

			const result = await port.invoke(name, undefined, CONTEXT);

			expect(result).toEqual({
				ok: true,
				value: { stdout: CAPABILITY_FALLBACKS.supports_slash_commands },
			});
			expect(calls).toEqual([]);
		}
	});

	test("capability: both requested flags false return both fallbacks, one per line", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
		const port = createGrokBuildAdapter({
			runner,
			entry: presentEntry,
			entryPath: ENTRY_PATH,
			declared: {
				...GROK_BUILD_DECLARED_FLAGS,
				supports_slash_commands: false,
				supports_hooks: false,
			},
		});

		const result = await port.invoke("ultrathink-track", undefined, CONTEXT);

		expect(result).toEqual({
			ok: true,
			value: {
				stdout: `${CAPABILITY_FALLBACKS.supports_slash_commands}\n${CAPABILITY_FALLBACKS.supports_hooks}`,
			},
		});
		expect(calls).toEqual([]);
	});

	test("version: a version below the floor is refused and never runs", async () => {
		const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
		const port = createGrokBuildAdapter({
			runner,
			entry: presentEntry,
			entryPath: ENTRY_PATH,
			observedVersion: "1.0.76",
		});

		const result = await port.invoke("ultrathink-quick", undefined, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host version below minimum 1.0.77" },
		});
		expect(calls).toEqual([]);
	});

	test("version: an unknown or unparseable version is refused and never runs", async () => {
		for (const observedVersion of [null, "dev", "1.0.x"]) {
			const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
			const port = createGrokBuildAdapter({
				runner,
				entry: presentEntry,
				entryPath: ENTRY_PATH,
				observedVersion,
			});

			const result = await port.invoke("ultrathink-quick", undefined, CONTEXT);

			expect(result).toEqual({
				ok: false,
				error: {
					category: "capability_missing",
					message: "host version unknown; minimum 1.0.77",
				},
			});
			expect(calls).toEqual([]);
		}
	});

	test("version: the floor and newer versions run unchanged", async () => {
		for (const observedVersion of ["1.0.77", "1.0.78", "1.1.0", "v2.0.0"]) {
			const { runner, calls } = fakeRunner({ exitCode: 0, stdout: "ran" });
			const port = createGrokBuildAdapter({
				runner,
				entry: presentEntry,
				entryPath: ENTRY_PATH,
				observedVersion,
			});

			const result = await port.invoke("ultrathink-quick", undefined, CONTEXT);

			expect(calls).toEqual([["quick"]]);
			expect(result).toEqual({ ok: true, value: { stdout: "ran" } });
		}
	});
});
