// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../test.helpers.ts";
import { claimAttempt, createCallGate, GATE_DIR_ENV, GATE_REFUSAL } from "./gate.ts";

const roots: string[] = [];
const gates: Array<{ dispose(): void }> = [];

afterEach(() => {
	for (const gate of gates.splice(0)) gate.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A stand-in for `claude` that records each run and echoes its stdin and arguments. */
function fakeClaude(): { bin: string; runs: () => number } {
	const dir = makeTempDir("gate-bin-", roots);
	const log = join(dir, "runs.log");
	const bin = join(dir, "claude");
	writeFileSync(log, "");
	writeFileSync(
		bin,
		`#!/bin/sh\nprintf x >> ${JSON.stringify(log)}\ncat\nprintf ' args=%s' "$*"\nexit 3\n`,
	);
	chmodSync(bin, 0o755);
	return { bin, runs: () => readFileSync(log, "utf8").length };
}

function runShim(
	shim: string,
	env: Record<string, string | undefined>,
	stdin = "",
): { code: number | null; stdout: string; stderr: string } {
	const child = Bun.spawnSync([shim, "-p", "--model", "m"], {
		env: { ...process.env, ...env },
		stdin: Buffer.from(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

describe("claimAttempt", () => {
	test("grants exactly `cap` slots, then refuses and records the refusal", () => {
		const gate = createCallGate({ cap: 2, bin: "claude" });
		gates.push(gate);

		expect(gate.refused()).toBe(false);
		expect(claimAttempt(gate.dir, gate.cap)).toBe(true);
		expect(claimAttempt(gate.dir, gate.cap)).toBe(true);
		expect(gate.refused()).toBe(false);
		expect(claimAttempt(gate.dir, gate.cap)).toBe(false);
		expect(claimAttempt(gate.dir, gate.cap)).toBe(false);
		expect(gate.used()).toBe(2);
		expect(gate.refused()).toBe(true);
	});

	test("install points the process at the gate and undoes it", () => {
		const gate = createCallGate({ cap: 1, bin: "claude" });
		gates.push(gate);
		const before = process.env[GATE_DIR_ENV];

		const restore = gate.install();
		expect(process.env[GATE_DIR_ENV]).toBe(gate.dir);
		restore();

		expect(process.env[GATE_DIR_ENV]).toBe(before);
	});
});

describe("the gate shim", () => {
	test("runs the real binary through with its arguments, stdin and exit code while slots remain", () => {
		const fake = fakeClaude();
		const gate = createCallGate({ cap: 1, bin: fake.bin });
		gates.push(gate);

		const result = runShim(gate.shim, { [GATE_DIR_ENV]: gate.dir }, "hello");

		expect(result.stdout).toBe("hello args=-p --model m");
		expect(result.code).toBe(3);
		expect(fake.runs()).toBe(1);
		expect(gate.used()).toBe(1);
	});

	test("a request past the cap is refused as a usage limit and never reaches the real binary", () => {
		const fake = fakeClaude();
		const gate = createCallGate({ cap: 1, bin: fake.bin });
		gates.push(gate);
		runShim(gate.shim, { [GATE_DIR_ENV]: gate.dir });

		const refused = runShim(gate.shim, { [GATE_DIR_ENV]: gate.dir });

		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(GATE_REFUSAL);
		expect(refused.stderr).toMatch(/usage limit/);
		expect(fake.runs()).toBe(1);
		expect(gate.refused()).toBe(true);
	});

	test("without a readable gate it fails closed instead of calling the real binary", () => {
		const fake = fakeClaude();
		const gate = createCallGate({ cap: 1, bin: fake.bin });
		gates.push(gate);

		const unset = runShim(gate.shim, { [GATE_DIR_ENV]: undefined });
		const missing = runShim(gate.shim, { [GATE_DIR_ENV]: join(gate.dir, "nowhere") });

		expect(unset.code).toBe(2);
		expect(missing.code).toBe(2);
		expect(fake.runs()).toBe(0);
	});
});
