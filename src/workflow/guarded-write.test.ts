// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ABSENT,
	ConcurrentWriteError,
	hashContent,
	LockHeldError,
	readGuarded,
	withGuardedLock,
	writeGuarded,
} from "./guarded-write.ts";

/** Returns the error a call throws, or fails the test when it does not throw. */
function thrownBy(call: () => unknown): unknown {
	try {
		call();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

/** Sets the file's modification time to `ageMs` in the past. */
function backdate(file: string, ageMs: number): void {
	const when = new Date(Date.now() - ageMs);
	utimesSync(file, when, when);
}

/** The content a race worker writes: its tag repeated, so a torn or interleaved write is visible. */
function payload(tag: string): string {
	return `${tag}\n`.repeat(16_384);
}

/** Reads a worker's stdout to the end. `ready` resolves once the worker prints its ready line, or when stdout closes. */
function readWorkerOutput(stream: ReadableStream<Uint8Array>): {
	ready: Promise<void>;
	output: Promise<string>;
} {
	const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
	const output = (async () => {
		const decoder = new TextDecoder();
		let text = "";
		for await (const chunk of stream) {
			text += decoder.decode(chunk, { stream: true });
			if (text.includes("ready\n")) markReady();
		}
		markReady();
		return text + decoder.decode();
	})();
	return { ready, output };
}

describe("guarded writer", () => {
	let root: string;
	let path: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "guarded-write-"));
		path = join(root, "STATE.md");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("a read followed by a write with the same hash replaces the file", () => {
		writeGuarded(path, ABSENT, "base\n");
		const { text, hash } = readGuarded(path);
		const next = "updated\n";

		const result = writeGuarded(path, hash, next);

		expect(readFileSync(path, "utf8")).toBe(next);
		expect(result.hash).toBe(hashContent(next));
		expect(existsSync(`${path}.lock`)).toBe(false);
		expect(text).toBe("base\n");
	});

	test("a second writer from the same base hash fails and leaves the first writer's text", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeGuarded(path, base, "first\n");
		const firstHash = hashContent("first\n");

		const error = thrownBy(() => writeGuarded(path, base, "second\n"));

		expect(error).toBeInstanceOf(ConcurrentWriteError);
		expect((error as ConcurrentWriteError).message).toContain(base);
		expect((error as ConcurrentWriteError).message).toContain(firstHash);
		expect(readFileSync(path, "utf8")).toBe("first\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
		expect(readdirSync(root)).toEqual(["STATE.md"]);
	});

	test("a pre-existing lock file makes the write throw and is left in place", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeFileSync(`${path}.lock`, "held");

		const error = thrownBy(() => writeGuarded(path, base, "next\n", { lockWaitMs: 50 }));

		expect(error).toBeInstanceOf(LockHeldError);
		expect((error as LockHeldError).message).toContain(`${path}.lock`);
		expect(readFileSync(path, "utf8")).toBe("base\n");
		expect(readFileSync(`${path}.lock`, "utf8")).toBe("held");
	});

	test("a lock left by a dead holder is taken over and the write lands", async () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"]);
		await child.exited;
		writeFileSync(`${path}.lock`, String(child.pid));

		writeGuarded(path, base, "next\n", { lockWaitMs: 1_000 });

		expect(readFileSync(path, "utf8")).toBe("next\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("a lock held by a live pid refuses with LockHeldError after the wait budget", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeFileSync(`${path}.lock`, String(process.pid));

		const error = thrownBy(() => writeGuarded(path, base, "next\n", { lockWaitMs: 50 }));

		expect(error).toBeInstanceOf(LockHeldError);
		expect(readFileSync(path, "utf8")).toBe("base\n");
		expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
	});

	test("a lock older than 60 seconds is taken over even when its holder pid is alive", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeFileSync(`${path}.lock`, String(process.pid));
		backdate(`${path}.lock`, 61_000);

		writeGuarded(path, base, "next\n", { lockWaitMs: 1_000 });

		expect(readFileSync(path, "utf8")).toBe("next\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("a lock 5 seconds old with a live pid still refuses after the wait budget", () => {
		writeGuarded(path, ABSENT, "base\n");
		const base = readGuarded(path).hash;
		writeFileSync(`${path}.lock`, String(process.pid));
		backdate(`${path}.lock`, 5_000);

		const error = thrownBy(() => writeGuarded(path, base, "next\n", { lockWaitMs: 50 }));

		expect(error).toBeInstanceOf(LockHeldError);
		expect(readFileSync(path, "utf8")).toBe("base\n");
		expect(readFileSync(`${path}.lock`, "utf8")).toBe(String(process.pid));
	});

	test("a nested withGuardedLock on a path this process holds runs without waiting", () => {
		const lock = `${path}.lock`;
		let inner = false;
		withGuardedLock(path, () => {
			withGuardedLock(
				path,
				() => {
					inner = true;
				},
				{ lockWaitMs: 5_000 },
			);
			expect(existsSync(lock)).toBe(true);
		});

		expect(inner).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	test("release does not delete a lock now held by another pid", () => {
		withGuardedLock(path, () => {
			writeFileSync(`${path}.lock`, "99999999");
		});
		expect(readFileSync(`${path}.lock`, "utf8")).toBe("99999999");
	});

	test("a missing file reads as ABSENT; creating it succeeds once and a second create fails", () => {
		expect(readGuarded(path)).toEqual({ text: "", hash: ABSENT });

		writeGuarded(path, ABSENT, "created\n");
		expect(readFileSync(path, "utf8")).toBe("created\n");

		const error = thrownBy(() => writeGuarded(path, ABSENT, "again\n"));

		expect(error).toBeInstanceOf(ConcurrentWriteError);
		expect(readFileSync(path, "utf8")).toBe("created\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("a stale hash fails even when the new content equals the current content", () => {
		writeGuarded(path, ABSENT, "old\n");
		const staleHash = readGuarded(path).hash;
		writeGuarded(path, staleHash, "same\n");

		const error = thrownBy(() => writeGuarded(path, staleHash, "same\n"));

		expect(error).toBeInstanceOf(ConcurrentWriteError);
		expect(readFileSync(path, "utf8")).toBe("same\n");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("simultaneous writers from one base hash: one commits whole content, the rest fail, no lock remains", async () => {
		// Without the lock, writers that pass the hash check before any rename would all report OK; holding every worker at the same stale base before any write makes those checks overlap.
		writeGuarded(path, ABSENT, "base\n");
		const worker = fileURLToPath(new URL("./guarded-write.race-worker.ts", import.meta.url));
		const attempts = 50;
		const workers = ["A", "B", "C", "D"].map((tag) => {
			const proc = Bun.spawn([process.execPath, worker, path, String(attempts), payload(tag)], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "inherit",
			});
			return { tag, proc, ...readWorkerOutput(proc.stdout) };
		});
		await Promise.all(workers.map((w) => w.ready));
		for (const w of workers) w.proc.stdin.end();

		const runs = await Promise.all(
			workers.map(async (w) => ({
				tag: w.tag,
				exitCode: await w.proc.exited,
				lines: (await w.output).split("\n").filter((line) => line !== "" && line !== "ready"),
			})),
		);
		for (const run of runs) {
			expect({ tag: run.tag, exitCode: run.exitCode }).toEqual({ tag: run.tag, exitCode: 0 });
			expect(run.lines).toHaveLength(attempts);
		}

		const winners = runs.flatMap((run) =>
			run.lines.filter((line) => line === "OK").map(() => run.tag),
		);
		const failures = runs.flatMap((run) => run.lines.filter((line) => line !== "OK"));
		expect(failures.length).toBeGreaterThan(0);
		expect(
			failures.filter((line) => line !== "ConcurrentWriteError" && line !== "LockHeldError"),
		).toEqual([]);
		expect(winners).toHaveLength(1);
		expect(readFileSync(path, "utf8")).toBe(payload(winners[0] ?? ""));
		expect(existsSync(`${path}.lock`)).toBe(false);
	}, 30_000);
});
