// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStore, StoreReadError, withStoreLock } from "./store.ts";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-store-"));
	path = join(dir, "creds.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEY = { kind: "api_key" as const, apiKey: "secret-key-1", updatedAt: 1 };

describe("readStore strict", () => {
	test("a missing file is an empty store in both modes", () => {
		expect(readStore(path)).toEqual({ version: 1, providers: {} });
		expect(readStore(path, { strict: true })).toEqual({ version: 1, providers: {} });
	});

	test("unparsable content throws a named error without echoing the content; lenient reads stay empty", () => {
		writeFileSync(path, '{"version":1,"providers":{"linear":{"apiKey":"secret-key-1"');
		expect(readStore(path)).toEqual({ version: 1, providers: {} });
		let thrown: unknown;
		try {
			readStore(path, { strict: true });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(StoreReadError);
		expect((thrown as StoreReadError).message).not.toContain("secret-key-1");
		expect((thrown as StoreReadError).code).toBe("invalid_json");
	});

	test("a newer store version is unreadable in strict mode and empty in lenient mode", () => {
		writeFileSync(path, JSON.stringify({ version: 2, providers: { linear: KEY } }));
		expect(readStore(path)).toEqual({ version: 1, providers: {} });
		expect(() => readStore(path, { strict: true })).toThrow(StoreReadError);
	});

	test("a read failure other than ENOENT throws in strict mode", () => {
		// A directory where the file should be: EISDIR, not ENOENT.
		mkdirSync(path);
		expect(readStore(path)).toEqual({ version: 1, providers: {} });
		expect(() => readStore(path, { strict: true })).toThrow(StoreReadError);
	});
});

describe("withStoreLock holder liveness", () => {
	test("a lock owned by a dead pid is taken at once, without a single poll wait", async () => {
		const lock = `${path}.lock`;
		mkdirSync(lock);
		writeFileSync(
			join(lock, "owner"),
			JSON.stringify({ pid: 2_000_000, startTime: "t0", token: "dead-token" }),
		);
		const now = 1_700_000_000_000;
		let sleeps = 0;
		const value = await withStoreLock(path, async () => "got", {
			now: () => now,
			sleep: async () => {
				sleeps += 1;
			},
			holder: { alive: () => false },
		});
		expect(value).toBe("got");
		expect(sleeps).toBe(0);
	});

	test("a lock whose pid was recycled by another process is dead", async () => {
		const lock = `${path}.lock`;
		mkdirSync(lock);
		writeFileSync(
			join(lock, "owner"),
			JSON.stringify({ pid: 4242, startTime: "old-start", token: "t" }),
		);
		let sleeps = 0;
		const value = await withStoreLock(path, async () => "got", {
			now: () => Date.now(),
			sleep: async () => {
				sleeps += 1;
			},
			holder: { alive: () => true, identity: () => "new-start" },
		});
		expect(value).toBe("got");
		expect(sleeps).toBe(0);
	});

	test("a live holder is never taken before its stale window", async () => {
		const lock = `${path}.lock`;
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), JSON.stringify({ pid: 4242, startTime: "s", token: "t" }));
		const base = statSync(lock).mtimeMs;
		let elapsed = 0;
		const polls: number[] = [];
		await expect(
			withStoreLock(path, async () => "got", {
				staleMs: 10_000,
				waitMs: 3_000,
				pollMs: 1_000,
				now: () => base + elapsed,
				sleep: async (ms) => {
					polls.push(ms);
					elapsed += ms;
				},
				holder: { alive: () => true, identity: () => "s" },
			}),
		).rejects.toThrow("timed out waiting for credential store lock");
		expect(polls.length).toBeGreaterThan(0);
	});

	test("the default wait covers the stale window: an unverifiable holder is taken over instead of timing out", async () => {
		const lock = `${path}.lock`;
		mkdirSync(lock);
		// A legacy bare-token owner file: no pid, so only its age can end it.
		writeFileSync(join(lock, "owner"), "legacy-nonce");
		const base = statSync(lock).mtimeMs;
		let elapsed = 0;
		const value = await withStoreLock(path, async () => "got", {
			now: () => base + elapsed,
			sleep: async (ms) => {
				elapsed += ms * 10;
			},
		});
		expect(value).toBe("got");
		expect(elapsed).toBeGreaterThan(60_000);
	});

	test("the owner file names the holder and the lock is released afterwards", async () => {
		const seen: string[] = [];
		await withStoreLock(path, async () => {
			seen.push(readFileSync(join(`${path}.lock`, "owner"), "utf8"));
		});
		const owner = JSON.parse(seen[0] as string) as { pid: number; token: string };
		expect(owner.pid).toBe(process.pid);
		expect(owner.token.length).toBeGreaterThan(8);
		expect(statSync(`${path}.lock`, { throwIfNoEntry: false })).toBeUndefined();
	});
});
