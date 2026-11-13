// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type AdapterEntry, type AdapterRunner, createMuseAdapter } from "./index.ts";

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
