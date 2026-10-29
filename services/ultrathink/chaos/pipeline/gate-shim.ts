#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Stands in for the `claude` binary on the live chaos run (see gate.ts): takes one slot of the call gate, then runs the
 * real binary with the same arguments and streams. A request past the cap is refused before anything is sent.
 */
import {
	claimAttempt,
	GATE_DIR_ENV,
	GATE_REFUSAL,
	type GateSettings,
	readGateSettings,
} from "./gate.ts";

async function main(): Promise<number> {
	const dir = process.env[GATE_DIR_ENV];
	if (dir === undefined || dir === "") {
		process.stderr.write("chaos gate: ULTRATHINK_CHAOS_GATE_DIR is not set, no request was made\n");
		return 2;
	}
	let settings: GateSettings;
	let granted: boolean;
	try {
		settings = readGateSettings(dir);
		granted = claimAttempt(dir, settings.cap);
	} catch (error) {
		// Fail closed: a gate that cannot count must not let a request through.
		process.stderr.write(
			`chaos gate: ${error instanceof Error ? error.message : String(error)}, no request was made\n`,
		);
		return 2;
	}
	if (!granted) {
		process.stderr.write(`${GATE_REFUSAL}\n`);
		return 1;
	}
	const child = Bun.spawn([settings.bin, ...process.argv.slice(2)], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return (await child.exited) ?? 1;
}

if (import.meta.main) process.exit(await main());
