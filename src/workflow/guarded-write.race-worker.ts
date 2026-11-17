// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Child process for the concurrency test in guarded-write.test.ts.
// Argv: <path> <attempts> <payload>.
// Reads the base hash, prints "ready", then blocks until its stdin closes. The parent closes stdin
// only after every worker has read the base, so all workers hold the same stale hash. Each
// writeGuarded call with that hash is one attempt; stdout gets one line per attempt: OK or the
// error class name.

import { writeSync } from "node:fs";
import { readGuarded, writeGuarded } from "./guarded-write.ts";

const [path, attemptsArg, payload] = process.argv.slice(2);
if (path === undefined || attemptsArg === undefined || payload === undefined) {
	console.error("usage: guarded-write.race-worker.ts <path> <attempts> <payload>");
	process.exit(2);
}
const attempts = Number(attemptsArg);

const baseHash = readGuarded(path).hash;
writeSync(1, "ready\n");
await Bun.stdin.text();

const lines: string[] = [];
for (let attempt = 0; attempt < attempts; attempt++) {
	try {
		writeGuarded(path, baseHash, payload);
		lines.push("OK");
	} catch (error) {
		lines.push(error instanceof Error ? error.name : "UnknownError");
	}
}
writeSync(1, `${lines.join("\n")}\n`);
