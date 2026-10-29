// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "../swarm/lane.ts";
import {
	LockTimeoutError,
	updateJsonAtomic,
	withFileLock,
	withLockMutation,
	writeFileAtomic,
} from "./atomic.ts";
import { readSession, type SessionRecord, sessionPath, writeSession } from "./state.ts";

const WORKER = join(import.meta.dir, "atomic.worker.ts");
const POSIX = process.platform !== "win32";
// Fixed fixture clock: lock ages are written relative to it, never to the wall clock.
const NOW = 1_700_000_000_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-atomic-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Names in `path` that are neither the target nor a lock: temporary files and aside locks must never be left behind. */
function leftovers(path: string): string[] {
	return readdirSync(path).filter(
		(name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.endsWith(".stale"),
	);
}

describe("writeFileAtomic", () => {
	test("writes the file, creates missing directories and leaves nothing else behind", () => {
		const target = join(dir, "a", "b", "state.json");
		writeFileAtomic(target, '{"x":1}\n');
		expect(readFileSync(target, "utf8")).toBe('{"x":1}\n');
		expect(readdirSync(join(dir, "a", "b"))).toEqual(["state.json"]);
		writeFileAtomic(target, new TextEncoder().encode("bytes"));
		expect(readFileSync(target, "utf8")).toBe("bytes");
		expect(readdirSync(join(dir, "a", "b"))).toEqual(["state.json"]);
	});

	test.skipIf(!POSIX)("the file is owner-only and a directory it creates is 0700", () => {
		const target = join(dir, "private", "state.json");
		writeFileAtomic(target, "{}");
		expect(statSync(target).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
	});

	test.skipIf(!POSIX)("a world-readable file is replaced by an owner-only one", () => {
		const target = join(dir, "old.json");
		writeFileSync(target, "old", { mode: 0o644 });
		writeFileAtomic(target, "new");
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	test.skipIf(!POSIX)("honors an explicit mode and dirMode", () => {
		// Pinned to the hardened-shell umask so the result never depends on the invoking shell.
		const previous = process.umask(0o077);
		try {
			const target = join(dir, "shared", "state.json");
			writeFileAtomic(target, "{}", { mode: 0o640, dirMode: 0o750 });
			expect(statSync(target).mode & 0o777).toBe(0o640);
			expect(statSync(join(dir, "shared")).mode & 0o777).toBe(0o750);
		} finally {
			process.umask(previous);
		}
	});

	test.skipIf(!POSIX)("honors an explicit mode and dirMode under umask 022", () => {
		const previous = process.umask(0o022);
		try {
			const target = join(dir, "shared", "state.json");
			writeFileAtomic(target, "{}", { mode: 0o640, dirMode: 0o750 });
			expect(statSync(target).mode & 0o777).toBe(0o640);
			expect(statSync(join(dir, "shared")).mode & 0o777).toBe(0o750);
		} finally {
			process.umask(previous);
		}
	});

	test.skipIf(!POSIX).each([
		["077", 0o077],
		["000", 0o000],
		["027", 0o027],
	] as const)(
		"explicit modes survive process umask %s, including intermediate directories",
		(_label, mask) => {
			const previous = process.umask(mask);
			try {
				const target = join(dir, "u", "v", "state.json");
				writeFileAtomic(target, "{}", { mode: 0o640, dirMode: 0o750 });
				expect(statSync(target).mode & 0o777).toBe(0o640);
				expect(statSync(join(dir, "u", "v")).mode & 0o777).toBe(0o750);
				expect(statSync(join(dir, "u")).mode & 0o777).toBe(0o750);
			} finally {
				process.umask(previous);
			}
		},
	);

	test.skipIf(!POSIX)("owner-only defaults hold under a umask that strips owner bits", () => {
		const previous = process.umask(0o277);
		try {
			const target = join(dir, "d", "state.json");
			writeFileAtomic(target, "{}");
			expect(statSync(target).mode & 0o777).toBe(0o600);
			expect(statSync(join(dir, "d")).mode & 0o777).toBe(0o700);
		} finally {
			process.umask(previous);
		}
	});

	test.skipIf(!POSIX)("an existing directory is never re-moded", () => {
		const shared = join(dir, "existing");
		mkdirSync(shared, { mode: 0o755 });
		chmodSync(shared, 0o755);
		writeFileAtomic(join(shared, "state.json"), "{}");
		expect(statSync(shared).mode & 0o777).toBe(0o755);
	});

	test("a failing rename keeps the previous content, removes the temporary file and rethrows", () => {
		const target = join(dir, "state.json");
		writeFileAtomic(target, "previous");
		expect(() =>
			writeFileAtomic(target, "replacement", {
				fs: {
					renameSync: () => {
						throw new Error("rename refused");
					},
				},
			}),
		).toThrow("rename refused");
		expect(readFileSync(target, "utf8")).toBe("previous");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	test("a failing write removes the temporary file and leaves no target behind", () => {
		const target = join(dir, "state.json");
		expect(() =>
			writeFileAtomic(target, "data", {
				fs: {
					fsyncSync: () => {
						throw new Error("disk full");
					},
				},
			}),
		).toThrow("disk full");
		expect(readdirSync(dir)).toEqual([]);
	});

	test("a large value replaces a small one entirely", () => {
		const target = join(dir, "state.json");
		writeFileAtomic(target, "small");
		const large = "x".repeat(2_000_000);
		writeFileAtomic(target, large);
		expect(readFileSync(target, "utf8")).toBe(large);
		writeFileAtomic(target, "small again");
		expect(readFileSync(target, "utf8")).toBe("small again");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});
});

describe("withFileLock", () => {
	test("runs the callback, returns its value and releases the lock", () => {
		const target = join(dir, "state.json");
		let during = false;
		const value = withFileLock(target, () => {
			during = existsSync(`${target}.lock`);
			return 42;
		});
		expect(value).toBe(42);
		expect(during).toBe(true);
		expect(existsSync(`${target}.lock`)).toBe(false);
	});

	test.skipIf(!POSIX)("the lock file is owner-only", () => {
		const target = join(dir, "state.json");
		let mode = 0;
		withFileLock(target, () => {
			mode = statSync(`${target}.lock`).mode & 0o777;
		});
		expect(mode).toBe(0o600);
	});

	test("a lock left by a crashed process is reclaimed", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		writeFileSync(lock, "dead-process-token");
		const old = new Date(NOW - 60_000);
		utimesSync(lock, old, old);
		const logs: string[] = [];
		const sleeps: number[] = [];
		let ran = false;
		withFileLock(
			target,
			() => {
				ran = true;
				expect(readFileSync(lock, "utf8")).not.toBe("dead-process-token");
			},
			{ now: () => NOW, log: (message) => logs.push(message), sleep: (ms) => sleeps.push(ms) },
		);
		expect(ran).toBe(true);
		expect(sleeps).toEqual([]);
		expect(logs).toEqual([]);
		expect(leftovers(dir)).toEqual([]);
	});

	test("a crashed mutation owner is reclaimed before the protected record is updated", () => {
		const target = join(dir, "state.json");
		const guard = `${target}.lock.guard`;
		writeFileAtomic(target, "0");
		writeFileAtomic(join(guard, `2147483647.${"a".repeat(32)}`), "");
		const logs: string[] = [];
		withFileLock(
			target,
			() => writeFileAtomic(target, String(Number(readFileSync(target, "utf8")) + 1)),
			{
				log: (message) => logs.push(message),
			},
		);
		expect(readFileSync(target, "utf8")).toBe("1");
		expect(logs).toEqual([]);
		expect(existsSync(guard)).toBe(false);
		expect(leftovers(dir)).toEqual([]);
	});

	test("a live mutation owner stays intact when the generic lock times out and writes unlocked", () => {
		const target = join(dir, "state.json");
		const guard = `${target}.lock.guard`;
		const owner = `${process.pid}.${"b".repeat(32)}`;
		writeFileAtomic(target, "0");
		writeFileAtomic(join(guard, owner), "");
		const logs: string[] = [];
		withFileLock(
			target,
			() => writeFileAtomic(target, String(Number(readFileSync(target, "utf8")) + 1)),
			{
				timeoutMs: 0,
				log: (message) => logs.push(message),
			},
		);
		expect(readFileSync(target, "utf8")).toBe("1");
		expect(readdirSync(guard)).toEqual([owner]);
		expect(logs).toHaveLength(1);
	});

	test("a fresh held lock is waited on, then the callback runs unlocked and the timeout is logged", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		writeFileSync(lock, "other-process-token");
		let clock = NOW;
		const start = clock;
		const sleeps: number[] = [];
		const logs: string[] = [];
		let ran = false;
		const result = withFileLock(
			target,
			() => {
				ran = true;
				return "done";
			},
			{
				timeoutMs: 500,
				pollMs: 100,
				now: () => clock,
				sleep: (ms) => {
					sleeps.push(ms);
					clock += ms;
				},
				log: (message) => logs.push(message),
			},
		);
		expect(result).toBe("done");
		expect(ran).toBe(true);
		expect(sleeps.length).toBeGreaterThan(0);
		expect(sleeps.every((ms) => ms >= 100)).toBe(true);
		expect(clock - start).toBeGreaterThanOrEqual(500);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("state.json.lock");
		// The other holder's lock is not ours to remove.
		expect(readFileSync(lock, "utf8")).toBe("other-process-token");
	});

	test("a lock released while waiting is taken", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		writeFileSync(lock, "other-process-token");
		const logs: string[] = [];
		let held = false;
		withFileLock(
			target,
			() => {
				held = readFileSync(lock, "utf8") !== "other-process-token";
			},
			{
				sleep: () => rmSync(lock),
				log: (message) => logs.push(message),
			},
		);
		expect(held).toBe(true);
		expect(logs).toEqual([]);
		expect(existsSync(lock)).toBe(false);
	});

	test("a callback that throws still releases the lock and the error propagates", () => {
		const target = join(dir, "state.json");
		expect(() =>
			withFileLock(target, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(existsSync(`${target}.lock`)).toBe(false);
	});

	test("a lock replaced by someone else during the callback is not deleted by us", () => {
		const target = join(dir, "state.json");
		const lock = `${target}.lock`;
		withFileLock(target, () => {
			rmSync(lock);
			writeFileSync(lock, "successor-token");
		});
		expect(readFileSync(lock, "utf8")).toBe("successor-token");
	});

	test.skipIf(!POSIX)("lock and guard modes survive a umask that strips owner bits", () => {
		const target = join(dir, "state.json");
		const previous = process.umask(0o277);
		let lockMode = 0;
		let guardMode: number | undefined;
		try {
			withFileLock(target, () => {
				lockMode = statSync(`${target}.lock`).mode & 0o777;
			});
			guardMode = withLockMutation(`${target}.lock`, () => {
				return statSync(`${target}.lock.guard`).mode & 0o777;
			});
		} finally {
			process.umask(previous);
		}
		expect(lockMode).toBe(0o600);
		expect(guardMode).toBe(0o700);
	});

	test("the lock file records the holder pid, its start identity and a token", () => {
		const target = join(dir, "state.json");
		let holder: unknown;
		withFileLock(target, () => {
			holder = JSON.parse(readFileSync(`${target}.lock`, "utf8"));
		});
		expect(holder).toEqual({
			pid: process.pid,
			startTime: processIdentity(process.pid),
			token: expect.stringMatching(/^[a-f0-9]{32}$/),
		});
	});

	describe("liveness", () => {
		const plant = (target: string, holder: unknown, ageMs: number): string => {
			const lock = `${target}.lock`;
			writeFileSync(lock, typeof holder === "string" ? holder : JSON.stringify(holder));
			const mtime = new Date(NOW - ageMs);
			utimesSync(lock, mtime, mtime);
			return lock;
		};
		const clockOptions = (state: { clock: number; sleeps: number[]; logs: string[] }) => ({
			timeoutMs: 500,
			pollMs: 100,
			now: () => state.clock,
			sleep: (ms: number) => {
				state.sleeps.push(ms);
				state.clock += ms;
			},
			log: (message: string) => state.logs.push(message),
		});

		test("a live holder with a stale mtime is never taken: we wait, then run unlocked", () => {
			const target = join(dir, "state.json");
			const startTime = processIdentity(process.pid);
			expect(startTime).toBeDefined();
			const holder = { pid: process.pid, startTime, token: "live-holder" };
			const lock = plant(target, holder, 60_000);
			const state = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			let ran = false;
			withFileLock(
				target,
				() => {
					ran = true;
					expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(holder);
				},
				clockOptions(state),
			);
			expect(ran).toBe(true);
			expect(state.sleeps.length).toBeGreaterThan(0);
			expect(state.clock - NOW).toBeGreaterThanOrEqual(500);
			expect(state.logs).toHaveLength(1);
			expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(holder);
		});

		test('onTimeout "throw" refuses to run when a live holder keeps the lock', () => {
			const target = join(dir, "state.json");
			const holder = { pid: process.pid, startTime: processIdentity(process.pid), token: "live" };
			const lock = plant(target, holder, 60_000);
			const state = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			let ran = false;
			expect(() =>
				withFileLock(
					target,
					() => {
						ran = true;
					},
					{ ...clockOptions(state), onTimeout: "throw" },
				),
			).toThrow(LockTimeoutError);
			expect(ran).toBe(false);
			expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(holder);
		});

		test("a dead holder is reclaimed at once whatever the mtime", () => {
			const target = join(dir, "state.json");
			const lock = plant(
				target,
				{ pid: 2_147_483_647, startTime: "proc:1", token: "dead-holder" },
				0,
			);
			const state = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			let token: unknown;
			withFileLock(
				target,
				() => {
					token = (JSON.parse(readFileSync(lock, "utf8")) as { token: string }).token;
				},
				clockOptions(state),
			);
			expect(token).not.toBe("dead-holder");
			expect(state.sleeps).toEqual([]);
			expect(state.logs).toEqual([]);
			expect(leftovers(dir)).toEqual([]);
		});

		test("a recycled pid (same pid, different start identity) is reclaimed at once", () => {
			const target = join(dir, "state.json");
			const lock = plant(
				target,
				{ pid: process.pid, startTime: "proc:0-not-this-process", token: "recycled" },
				0,
			);
			const state = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			let token: unknown;
			withFileLock(
				target,
				() => {
					token = (JSON.parse(readFileSync(lock, "utf8")) as { token: string }).token;
				},
				clockOptions(state),
			);
			expect(token).not.toBe("recycled");
			expect(state.sleeps).toEqual([]);
		});

		test("injected seams decide liveness deterministically", () => {
			const target = join(dir, "state.json");
			const holder = { pid: 4242, startTime: "proc:77", token: "seam-holder" };
			const lock = plant(target, holder, 60_000);
			const state = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, {
				...clockOptions(state),
				liveness: {
					platform: "linux",
					killAlive: (pid) => pid === 4242,
					readStat: (pid) => (pid === 4242 ? `4242 (x) S ${"0 ".repeat(18)}77 0` : undefined),
				},
			});
			// pid alive and identity proc:77 matches, so the stale mtime does not matter.
			expect(state.sleeps.length).toBeGreaterThan(0);
			expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(holder);
			const dead = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, {
				...clockOptions(dead),
				liveness: { platform: "linux", killAlive: () => false },
			});
			expect(dead.sleeps).toEqual([]);
			expect(existsSync(lock)).toBe(false);
		});

		test("an unreadable holder identity degrades to the mtime rule", () => {
			const target = join(dir, "state.json");
			const holder = { pid: process.pid, startTime: "proc:1", token: "unknown" };
			const lock = plant(target, holder, 60_000);
			const old = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, {
				...clockOptions(old),
				liveness: { platform: "linux", readStat: () => undefined },
			});
			// Identity unknown: the 60 s old lock is reclaimed by age, exactly like a legacy lock.
			expect(old.sleeps).toEqual([]);
			expect(existsSync(lock)).toBe(false);
			plant(target, holder, 0);
			const fresh = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, {
				...clockOptions(fresh),
				liveness: { platform: "linux", readStat: () => undefined },
			});
			expect(fresh.sleeps.length).toBeGreaterThan(0);
			expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(holder);
		});

		test("a legacy bare-token lock is reclaimed by age and waited on when fresh", () => {
			const target = join(dir, "state.json");
			const lock = plant(target, "legacy-token", 60_000);
			const old = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, clockOptions(old));
			expect(old.sleeps).toEqual([]);
			expect(existsSync(lock)).toBe(false);
			plant(target, "legacy-token", 0);
			const fresh = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, clockOptions(fresh));
			expect(fresh.sleeps.length).toBeGreaterThan(0);
			expect(readFileSync(lock, "utf8")).toBe("legacy-token");
		});

		test("a malformed JSON holder record falls back to the mtime rule, never to instant reclaim", () => {
			const target = join(dir, "state.json");
			const lock = plant(target, '{"pid": "x"', 0);
			const state = { clock: NOW, sleeps: [] as number[], logs: [] as string[] };
			withFileLock(target, () => undefined, clockOptions(state));
			expect(state.sleeps.length).toBeGreaterThan(0);
			expect(readFileSync(lock, "utf8")).toBe('{"pid": "x"');
		});

		test("release removes only our own JSON record", () => {
			const target = join(dir, "state.json");
			const lock = `${target}.lock`;
			const successor = { pid: process.pid, startTime: processIdentity(process.pid), token: "s" };
			withFileLock(target, () => {
				rmSync(lock);
				writeFileSync(lock, JSON.stringify(successor));
			});
			expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(successor);
		});
	});

	test("a lock that cannot be created degrades to running the callback unlocked", () => {
		const target = join(dir, "no-such-dir", "state.json");
		const logs: string[] = [];
		const value = withFileLock(target, () => "ran", { log: (message) => logs.push(message) });
		expect(value).toBe("ran");
		expect(logs).toHaveLength(1);
		expect(existsSync(join(dir, "no-such-dir"))).toBe(false);
	});
});

describe("updateJsonAtomic", () => {
	type Counter = { n: number };
	const bump = (current: unknown): Counter => ({
		n: ((current as Counter | undefined)?.n ?? 0) + 1,
	});

	test("sequential increments both survive and a missing file starts from `initial`", () => {
		const target = join(dir, "counter.json");
		expect(updateJsonAtomic(target, bump)).toBe(true);
		expect(updateJsonAtomic(target, bump)).toBe(true);
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ n: 2 });
		expect(readFileSync(target, "utf8")).toBe('{\n  "n": 2\n}\n');
		const seeded = join(dir, "seeded.json");
		expect(updateJsonAtomic(seeded, bump, { initial: { n: 10 } })).toBe(true);
		expect(JSON.parse(readFileSync(seeded, "utf8"))).toEqual({ n: 11 });
		expect(leftovers(dir)).toEqual([]);
	});

	test("a racer between the read and the write triggers a re-read and re-apply that keeps both updates", () => {
		const target = join(dir, "counter.json");
		writeFileAtomic(target, '{"n":0}\n');
		let calls = 0;
		const result = updateJsonAtomic(target, (current) => {
			calls++;
			if (calls === 1) writeFileAtomic(target, '{"n":10}\n');
			return bump(current);
		});
		expect(result).toBe(true);
		expect(calls).toBe(2);
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ n: 11 });
	});

	test("five consecutive races return false and never overwrite the racer", () => {
		const target = join(dir, "counter.json");
		writeFileAtomic(target, '{"n":0}\n');
		let calls = 0;
		const result = updateJsonAtomic(target, (current) => {
			calls++;
			writeFileAtomic(target, `{"n":${100 + calls}}\n`);
			return bump(current);
		});
		expect(result).toBe(false);
		expect(calls).toBe(5);
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ n: 105 });
	});

	test("apply returning undefined writes nothing", () => {
		const target = join(dir, "counter.json");
		writeFileAtomic(target, '{"n":3}\n');
		const old = new Date(NOW - 5_000);
		utimesSync(target, old, old);
		const before = statSync(target);
		expect(updateJsonAtomic(target, () => undefined)).toBe(false);
		const after = statSync(target);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.ino).toBe(before.ino);
		expect(readFileSync(target, "utf8")).toBe('{"n":3}\n');
	});

	test("unparseable content reaches apply as the raw text and the helper does not throw", () => {
		const target = join(dir, "broken.json");
		writeFileAtomic(target, "{not json");
		const seen: unknown[] = [];
		expect(
			updateJsonAtomic(target, (current) => {
				seen.push(current);
				return { n: 1 };
			}),
		).toBe(true);
		expect(seen).toEqual(["{not json"]);
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ n: 1 });
	});

	test.skipIf(!POSIX)("the written file is owner-only", () => {
		const target = join(dir, "sub", "counter.json");
		updateJsonAtomic(target, bump);
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});
});

describe("concurrent updates through updateSession", () => {
	test("8 processes x 25 increments of one session field end at exactly 200", async () => {
		const stateDir = join(dir, "state");
		const record: SessionRecord & { counter: number } = {
			sessionId: "race",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
			counter: 0,
		};
		writeSession(stateDir, record);
		const workers = Array.from({ length: 8 }, () =>
			Bun.spawn([process.execPath, WORKER, stateDir, "race", "25"], {
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		const exits = await Promise.all(workers.map((worker) => worker.exited));
		const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
		expect(errors.join("")).toBe("");
		expect(exits).toEqual(Array<number>(8).fill(0));

		const parsed: unknown = JSON.parse(readFileSync(sessionPath(stateDir, "race"), "utf8"));
		expect(parsed).toMatchObject({ sessionId: "race", counter: 200 });
		expect(readSession(stateDir, "race")).toMatchObject({ counter: 200 });
		expect(leftovers(join(stateDir, "sessions"))).toEqual([]);
		expect(leftovers(stateDir)).toEqual([]);
	}, 60_000);

	test("a delayed stale recovery cannot open a live successor's critical section to another writer", async () => {
		const stateDir = join(dir, "state");
		const record: SessionRecord & { counter: number } = {
			sessionId: "stale-race",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
			counter: 0,
		};
		writeSession(stateDir, record);
		const lock = `${sessionPath(stateDir, record.sessionId)}.lock`;
		writeFileSync(lock, "dead-process-token");
		const old = new Date(NOW - 120_000);
		utimesSync(lock, old, old);
		const events = join(dir, "events");
		const signal = (name: string): void => writeFileAtomic(join(events, name), "");
		signal("start");
		const observed = new Set<string>();
		const waiters = new Set<{
			names: string[];
			resolve: (name: string) => void;
			reject: (error: Error) => void;
		}>();
		const readers: Promise<void>[] = [];
		let failure: Error | undefined;
		const notify = (): void => {
			for (const waiter of waiters) {
				const name = waiter.names.find((candidate) => observed.has(candidate));
				if (name) {
					waiters.delete(waiter);
					waiter.resolve(name);
				}
			}
		};
		const waitFor = (names: string[]): Promise<string> =>
			new Promise((resolve, reject) => {
				if (failure) return reject(failure);
				waiters.add({ names, resolve, reject });
				notify();
			});
		const spawn = (actor: string) => {
			const worker = Bun.spawn(
				[
					process.execPath,
					join(import.meta.dir, "atomic.recovery.worker.ts"),
					stateDir,
					record.sessionId,
					events,
					actor,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			// Consume explicit worker messages: filesystem notification delivery is not a barrier.
			readers.push(
				(async () => {
					try {
						const decoder = new TextDecoder();
						let buffer = "";
						for await (const chunk of worker.stdout) {
							buffer += decoder.decode(chunk, { stream: true });
							let end: number;
							while ((end = buffer.indexOf("\n")) !== -1) {
								observed.add(buffer.slice(0, end));
								buffer = buffer.slice(end + 1);
								notify();
							}
						}
						if (waiters.size)
							throw new Error(
								`${actor} exited before the next barrier; observed: ${[...observed].join(", ")}`,
							);
					} catch (error) {
						failure = error instanceof Error ? error : new Error(String(error));
						for (const waiter of waiters) waiter.reject(failure);
						waiters.clear();
					}
				})(),
			);
			return worker;
		};
		const workers = [spawn("delayed")];
		try {
			await waitFor(["snapshot"]);
			workers.push(spawn("first"), spawn("second"));
			await Promise.all([waitFor(["first.attempting"]), waitFor(["second.attempting"])]);
			// Observe the obsolete snapshot being applied, not a particular acquisition winner.
			// Force a successor to claim the now-empty guard before delayed attempts its late rmdir.
			await waitFor(["first.entered", "second.entered", "first.guarded", "second.guarded"]);
			signal("snapshot-go");
			if ((await waitFor(["moved", "released-owner"])) === "moved") {
				await waitFor(["first.overlap", "second.overlap"]);
			} else {
				await waitFor(["first.claimed", "second.claimed"]);
				signal("released-owner-go");
				await waitFor(["recovered"]);
				signal("claimed-go");
				await waitFor(["first.entered", "second.entered"]);
			}
			signal("rename-go");
			signal("body-go");
			signal("recovered-go");
			const exits = await Promise.all(workers.map((worker) => worker.exited));
			const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
			expect(errors.join("")).toBe("");
			expect(exits).toEqual([0, 0, 0]);
			expect(readSession(stateDir, record.sessionId)).toMatchObject({ counter: 3 });
			expect(readdirSync(events).filter((name) => name.endsWith(".overlap"))).toEqual([]);
			expect(leftovers(join(stateDir, "sessions"))).toEqual([]);
		} finally {
			signal("snapshot-go");
			signal("rename-go");
			signal("body-go");
			signal("recovered-go");
			signal("released-owner-go");
			signal("claimed-go");
			for (const worker of workers) if (worker.exitCode === null) worker.kill();
			await Promise.allSettled(workers.map((worker) => worker.exited));
			await Promise.all(readers);
		}
	}, 60_000);
});
