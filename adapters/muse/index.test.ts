// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createMuseSubject } from "../../conformance/muse-subject.ts";
import { CAPABILITY_FALLBACKS } from "../../core/src/capabilities/manifest.ts";
import {
	type AdapterEntry,
	type AdapterRunner,
	MUSE_DECLARED_CAPABILITIES,
	MUSE_RECORDED_VERSION,
	createMuseAdapter,
} from "./index.ts";

const ENTRY_PATH = "hooks/muse-prompt";
const CONTEXT = { correlationId: "test" };
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

interface RunnerOutcome {
	readonly exitCode: number;
	readonly stdout: string;
}

/** Fake runner: records each argv and either returns `outcome` or throws it. */
function fakeRunner(outcome: RunnerOutcome | Error): { runner: AdapterRunner; argvs: string[][] } {
	const argvs: string[][] = [];
	const runner: AdapterRunner = {
		async run(argv) {
			argvs.push([...argv]);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	};
	return { runner, argvs };
}

/** Fake entry check: reports `present` for every path and records the paths asked about. */
function fakeEntry(present: boolean): { entry: AdapterEntry; paths: string[] } {
	const paths: string[] = [];
	const entry: AdapterEntry = {
		exists(path) {
			paths.push(path);
			return present;
		},
	};
	return { entry, paths };
}

describe("createMuseAdapter", () => {
	for (const verb of VERBS) {
		test(`ultrathink-${verb} runs bin/ultrathink ${verb} once and returns its stdout`, async () => {
			const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: `ran ${verb}` });
			const { entry, paths } = fakeEntry(true);
			const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

			const result = await port.invoke(`ultrathink-${verb}`, {}, CONTEXT);

			expect(result).toEqual({ ok: true, value: { stdout: `ran ${verb}` } });
			expect(argvs).toEqual([[verb]]);
			expect(paths).toEqual([ENTRY_PATH]);
		});
	}

	test("an unknown name returns invalid_input and runs nothing", async () => {
		const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-learn", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "invalid_input", message: "unknown command: ultrathink-learn" },
		});
		expect(argvs).toEqual([]);
	});

	test("a runner that throws returns internal without the thrown text", async () => {
		const { runner, argvs } = fakeRunner(new Error("token sk-secret-123 leaked"));
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-status", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("sk-secret-123");
		expect(argvs).toEqual([["status"]]);
	});

	test("a non-zero exit returns internal without the engine output", async () => {
		const { runner } = fakeRunner({ exitCode: 2, stdout: "token sk-secret-456" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-on", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "internal", message: "command failed" },
		});
		expect(JSON.stringify(result)).not.toContain("sk-secret-456");
	});

	test("a missing entry point returns capability_missing and does not run the engine", async () => {
		const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "ok" });
		const { entry, paths } = fakeEntry(false);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-track", {}, CONTEXT);

		expect(result).toEqual({
			ok: false,
			error: { category: "capability_missing", message: "host entry point missing" },
		});
		expect(paths).toEqual([ENTRY_PATH]);
		expect(argvs).toEqual([]);
	});

	test("stdout is returned in full, beyond 4096 characters", async () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "x".repeat(5000) });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		const result = await port.invoke("ultrathink-quick", {}, CONTEXT);

		expect(result).toEqual({ ok: true, value: { stdout: "x".repeat(5000) } });
	});

	test("list declares the six verb commands, all side-effecting", () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		const definitions = port.list();

		expect(definitions.map((definition) => definition.name)).toEqual(
			VERBS.map((verb) => `ultrathink-${verb}`),
		);
		for (const definition of definitions) {
			expect(definition.idempotency).toBe("side-effecting");
		}
	});
});

describe("createMuseAdapter capability gate", () => {
	test("a declared-false slash-command flag runs the verb and returns its fallback", async () => {
		const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "ran status" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({
			runner,
			entry,
			entryPath: ENTRY_PATH,
			declared: { ...MUSE_DECLARED_CAPABILITIES, supports_slash_commands: false },
		});

		const result = await port.invoke("ultrathink-status", {}, CONTEXT);

		expect(result).toEqual({
			ok: true,
			value: {
				stdout: "ran status",
				fallbacks: [CAPABILITY_FALLBACKS.supports_slash_commands],
			},
		});
		expect(argvs).toEqual([["status"]]);
	});

	test("a declared-true slash-command flag returns only stdout", async () => {
		const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "ran on" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({
			runner,
			entry,
			entryPath: ENTRY_PATH,
			declared: { ...MUSE_DECLARED_CAPABILITIES, supports_slash_commands: true },
		});

		const result = await port.invoke("ultrathink-on", {}, CONTEXT);

		expect(result).toEqual({ ok: true, value: { stdout: "ran on" } });
		expect(argvs).toEqual([["on"]]);
	});

	test("a false flag the adapter does not request leaves the result unchanged", async () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "ran quick" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({
			runner,
			entry,
			entryPath: ENTRY_PATH,
			declared: {
				...MUSE_DECLARED_CAPABILITIES,
				supports_hooks: false,
				supports_subagents: false,
			},
		});

		const result = await port.invoke("ultrathink-quick", {}, CONTEXT);

		expect(result).toEqual({ ok: true, value: { stdout: "ran quick" } });
	});

	test("the declared flags match the muse conformance subject", () => {
		expect(MUSE_DECLARED_CAPABILITIES).toEqual(createMuseSubject().capabilities);
	});
});

describe("createMuseAdapter version floor", () => {
	for (const observedVersion of ["1.4.13", "1.3.99", "1.4"]) {
		test(`observed version ${observedVersion} is refused before anything runs`, async () => {
			const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "" });
			const { entry, paths } = fakeEntry(true);
			const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH, observedVersion });

			const result = await port.invoke("ultrathink-status", {}, CONTEXT);

			expect(result).toEqual({
				ok: false,
				error: {
					category: "version_mismatch",
					message: `host version is below the minimum ${MUSE_RECORDED_VERSION}`,
				},
			});
			expect(argvs).toEqual([]);
			expect(paths).toEqual([]);
		});
	}

	for (const observedVersion of [null, "", "unknown", "1.x", "1.4.14-beta"]) {
		test(`observed version ${JSON.stringify(observedVersion)} is unknown and refused`, async () => {
			const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "" });
			const { entry } = fakeEntry(true);
			const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH, observedVersion });

			const result = await port.invoke("ultrathink-on", {}, CONTEXT);

			expect(result).toEqual({
				ok: false,
				error: {
					category: "version_mismatch",
					message: `host version is unknown; minimum is ${MUSE_RECORDED_VERSION}`,
				},
			});
			expect(argvs).toEqual([]);
		});
	}

	for (const observedVersion of [MUSE_RECORDED_VERSION, "1.4.15", "1.4.18"]) {
		test(`observed version ${observedVersion} at or above the floor runs the verb unchanged`, async () => {
			const { runner, argvs } = fakeRunner({ exitCode: 0, stdout: "ran track" });
			const { entry } = fakeEntry(true);
			const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH, observedVersion });

			const result = await port.invoke("ultrathink-track", {}, CONTEXT);

			expect(result).toEqual({ ok: true, value: { stdout: "ran track" } });
			expect(argvs).toEqual([["track"]]);
		});
	}

	test("the version refusal category is declared by every command", () => {
		const { runner } = fakeRunner({ exitCode: 0, stdout: "" });
		const { entry } = fakeEntry(true);
		const port = createMuseAdapter({ runner, entry, entryPath: ENTRY_PATH });

		for (const definition of port.list()) {
			expect(definition.errorCategories).toContain("version_mismatch");
		}
	});
});
