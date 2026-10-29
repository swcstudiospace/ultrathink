// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildModule from "./child.ts";
import { type ChildResult, runChild, withTempDir } from "./child.ts";

const POSIX = process.platform !== "win32";
const SLOW = 30_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-child-test-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function sh(script: string): string[] {
	return ["sh", "-c", script];
}

// The fixtures are real OS processes: polling a marker file (or a pid) is the only way to learn
// that a child reached a known state, and fake timers cannot drive another process. Assertions
// never depend on how long a poll took, only on the observed state.
async function pollUntil(done: () => boolean): Promise<void> {
	for (let i = 0; i < 1500 && !done(); i++) await Bun.sleep(10);
}

/** Poll for a marker file the fixture writes once its signal disposition is installed. */
async function waitForFile(path: string): Promise<void> {
	await pollUntil(() => existsSync(path));
	expect(existsSync(path)).toBe(true);
}

/** A fresh module instance (own live-group set and reaper state) via a cache-busting query. */
async function freshChild(tag: string): Promise<typeof ChildModule> {
	// reason: the reaper keeps module-level state, so each test needs its own module instance
	return (await import(`./child.ts?${tag}`)) as typeof ChildModule;
}

/** True while the pid is a live, non-zombie process. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return true;
	}
}

async function waitDead(pid: number): Promise<boolean> {
	await pollUntil(() => !alive(pid));
	return !alive(pid);
}

describe("runChild basics", () => {
	test("surfaces exit codes and stdout/stderr text", async () => {
		const ok = await runChild({ cmd: ["true"] });
		expect(ok).toMatchObject({
			code: 0,
			signal: null,
			stdout: "",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			timedOut: false,
			aborted: false,
		});
		const bad = await runChild({ cmd: ["false"] });
		expect(bad.code).toBe(1);
		const both = await runChild({ cmd: sh("printf out; printf err >&2; exit 3") });
		expect(both).toMatchObject({ code: 3, stdout: "out", stderr: "err" });
	});

	test("reports a terminating signal", async () => {
		const out = await runChild({ cmd: sh("kill -9 $$") });
		expect(out.code).toBeNull();
		expect(out.signal).toBe("SIGKILL");
	});

	test("pipes stdin and honours cwd and an explicit env", async () => {
		const cat = await runChild({ cmd: ["cat"], stdin: "héllo\n" });
		expect(cat.stdout).toBe("héllo\n");
		const pwd = await runChild({ cmd: ["pwd", "-P"], cwd: dir });
		expect(pwd.stdout.trim()).toBe(realpathSync(dir));
		const env = await runChild({
			cmd: sh('printf "%s|%s" "${KEEP-unset}" "${DROP-unset}"'),
			env: { PATH: process.env.PATH, KEEP: "yes", DROP: undefined },
		});
		expect(env.stdout).toBe("yes|unset");
	});
});

describe("runChild output caps", () => {
	test("drops stdout beyond maxStdoutBytes and flags it", async () => {
		const out = await runChild({
			cmd: sh("head -c 200000 /dev/zero | tr '\\000' x"),
			maxStdoutBytes: 1000,
		});
		expect(out.code).toBe(0);
		expect(out.stdoutTruncated).toBe(true);
		expect(out.stdout).toBe("x".repeat(1000));
		expect(out.stderrTruncated).toBe(false);
	});

	test("drops stderr beyond maxStderrBytes and flags it", async () => {
		const out = await runChild({
			cmd: sh("head -c 50000 /dev/zero | tr '\\000' e >&2"),
			maxStderrBytes: 64,
		});
		expect(out.stderrTruncated).toBe(true);
		expect(out.stderr).toBe("e".repeat(64));
		expect(out.stdoutTruncated).toBe(false);
	});

	test("output exactly at the cap is not flagged", async () => {
		const out = await runChild({ cmd: sh("printf aaaa"), maxStdoutBytes: 4 });
		expect(out.stdout).toBe("aaaa");
		expect(out.stdoutTruncated).toBe(false);
	});
});

describe("runChild lifecycle", () => {
	test("an already-aborted signal settles aborted without leaving a child", async () => {
		const out = await runChild({ cmd: ["sleep", "120"], signal: AbortSignal.abort() });
		expect(out.aborted).toBe(true);
		expect(out.timedOut).toBe(false);
		expect(out.stdout).toBe("");
	});

	test(
		"a timeout terminates the child and sets timedOut",
		async () => {
			const out = await runChild({ cmd: ["sleep", "120"], timeoutMs: 50, graceMs: 200 });
			expect(out.timedOut).toBe(true);
			expect(out.aborted).toBe(false);
			expect(out.code).toBeNull();
			expect(out.signal).not.toBeNull();
		},
		SLOW,
	);

	test(
		"an abort terminates the child and sets aborted",
		async () => {
			const marker = join(dir, "term-armed");
			const ctl = new AbortController();
			const run = runChild({
				cmd: sh(`: > '${marker}'; exec sleep 120`),
				signal: ctl.signal,
				graceMs: 200,
			});
			await waitForFile(marker);
			ctl.abort();
			const out = await run;
			expect(out.aborted).toBe(true);
			expect(out.timedOut).toBe(false);
			expect(out.signal).not.toBeNull();
		},
		SLOW,
	);

	test.skipIf(!POSIX)(
		"a child that traps SIGTERM is escalated to SIGKILL after graceMs",
		async () => {
			const marker = join(dir, "armed");
			const ctl = new AbortController();
			const run = runChild({
				cmd: sh(`trap '' TERM; : > '${marker}'; sleep 120`),
				signal: ctl.signal,
				graceMs: 200,
			});
			await waitForFile(marker);
			ctl.abort();
			const out = await run;
			expect(out.aborted).toBe(true);
			expect(out.signal).toBe("SIGKILL");
		},
		SLOW,
	);

	test.skipIf(!POSIX)(
		"a timeout also escalates a SIGTERM-ignoring child",
		async () => {
			const out = await runChild({
				cmd: sh("trap '' TERM; sleep 120"),
				timeoutMs: 300,
				graceMs: 200,
			});
			expect(out.timedOut).toBe(true);
			expect(out.signal).toBe("SIGKILL");
		},
		SLOW,
	);

	test.skipIf(!POSIX)(
		"a grandchild holding the pipe cannot hang the call and is killed with the group",
		async () => {
			const out: ChildResult = await runChild({
				cmd: sh("sleep 120 & echo $!; exit 0"),
				drainMs: 100,
			});
			expect(out.code).toBe(0);
			const pid = Number(out.stdout.trim());
			expect(Number.isInteger(pid) && pid > 1).toBe(true);
			expect(await waitDead(pid)).toBe(true);
		},
		SLOW,
	);

	test.skipIf(!POSIX)(
		"abort kills the whole group, grandchildren included",
		async () => {
			const marker = join(dir, "grand");
			const pidFile = join(dir, "grand.pid");
			const ctl = new AbortController();
			const run = runChild({
				cmd: sh(
					`trap '' TERM; (trap '' TERM; echo $$ > '${pidFile}'; : > '${marker}'; sleep 120) & wait`,
				),
				signal: ctl.signal,
				graceMs: 200,
				drainMs: 100,
			});
			await waitForFile(marker);
			const pid = Number(readFileSync(pidFile, "utf8").trim());
			ctl.abort();
			const out = await run;
			expect(out.aborted).toBe(true);
			expect(await waitDead(pid)).toBe(true);
		},
		SLOW,
	);
});

describe("runChild spawn failure", () => {
	test("rejects with the original error keeping its code", async () => {
		const error = await runChild({ cmd: ["/nonexistent/ultrathink-no-such-binary"] }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
	});

	test("an empty command rejects instead of spawning", async () => {
		await expect(runChild({ cmd: [] })).rejects.toThrow();
	});

	test.skipIf(!POSIX)("registers no process group for a failed spawn", async () => {
		const fresh = await freshChild("spawn-failure");
		const before = process.listeners("exit");
		fresh.installChildReaper();
		const handlers = process.listeners("exit").filter((fn) => !before.includes(fn));
		try {
			await fresh
				.runChild({ cmd: ["/nonexistent/ultrathink-no-such-binary"] })
				.catch(() => undefined);
			const kill = spyOn(process, "kill").mockImplementation(() => true);
			try {
				for (const handler of handlers) (handler as () => void)();
				expect(kill).not.toHaveBeenCalled();
			} finally {
				kill.mockRestore();
			}
		} finally {
			for (const handler of handlers) process.off("exit", handler as () => void);
		}
	});
});

describe("installChildReaper", () => {
	test.skipIf(!POSIX)("is idempotent and adds the signal handlers only on request", async () => {
		const fresh = await freshChild("reaper-idempotent");
		const exit0 = process.listeners("exit");
		const term0 = process.listeners("SIGTERM");
		const int0 = process.listeners("SIGINT");
		try {
			fresh.installChildReaper();
			fresh.installChildReaper();
			fresh.installChildReaper({});
			expect(process.listeners("exit").length).toBe(exit0.length + 1);
			expect(process.listeners("SIGTERM").length).toBe(term0.length);
			expect(process.listeners("SIGINT").length).toBe(int0.length);

			fresh.installChildReaper({ signals: true });
			fresh.installChildReaper({ signals: true });
			fresh.installChildReaper();
			expect(process.listeners("exit").length).toBe(exit0.length + 1);
			expect(process.listeners("SIGTERM").length).toBe(term0.length + 1);
			expect(process.listeners("SIGINT").length).toBe(int0.length + 1);
		} finally {
			for (const fn of process.listeners("exit"))
				if (!exit0.includes(fn)) process.off("exit", fn as () => void);
			for (const fn of process.listeners("SIGTERM")) {
				if (!term0.includes(fn)) process.off("SIGTERM", fn as () => void);
			}
			for (const fn of process.listeners("SIGINT")) {
				if (!int0.includes(fn)) process.off("SIGINT", fn as () => void);
			}
		}
	});

	test.skipIf(!POSIX)(
		"the exit handler SIGKILLs a live child group synchronously",
		async () => {
			const fresh = await freshChild("reaper-kill");
			const before = process.listeners("exit");
			fresh.installChildReaper();
			const handlers = process.listeners("exit").filter((fn) => !before.includes(fn));
			expect(handlers.length).toBe(1);
			try {
				const marker = join(dir, "reaper-armed");
				const run = fresh.runChild({ cmd: sh(`: > '${marker}'; exec sleep 120`) });
				await waitForFile(marker);
				for (const handler of handlers) (handler as () => void)();
				const out = await run;
				expect(out.signal).toBe("SIGKILL");
			} finally {
				for (const handler of handlers) process.off("exit", handler as () => void);
			}
		},
		SLOW,
	);
});

describe("withTempDir", () => {
	const PREFIX = "ultrathink-withtempdir-test-";

	test("creates a private directory and removes it after success", async () => {
		let seen = "";
		const value = await withTempDir(PREFIX, async (path) => {
			seen = path;
			expect(path.startsWith(join(tmpdir(), PREFIX))).toBe(true);
			expect(existsSync(path)).toBe(true);
			if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o700);
			return 42;
		});
		expect(value).toBe(42);
		expect(existsSync(seen)).toBe(false);
	});

	test("removes the directory with its contents when the callback rejects", async () => {
		let seen = "";
		const boom = new Error("boom");
		await expect(
			withTempDir(PREFIX, async (path) => {
				seen = path;
				await Bun.write(join(path, "prompt.txt"), "secret prompt");
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(existsSync(seen)).toBe(false);
	});

	test("removes the directory when the callback throws synchronously", async () => {
		let seen = "";
		const boom = new Error("sync boom");
		await expect(
			withTempDir(PREFIX, (path) => {
				seen = path;
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(existsSync(seen)).toBe(false);
	});

	test("removes the directory when the child inside it is aborted", async () => {
		let seen = "";
		const out = await withTempDir(PREFIX, async (path) => {
			seen = path;
			return runChild({ cmd: ["sleep", "120"], signal: AbortSignal.abort() });
		});
		expect(out.aborted).toBe(true);
		expect(existsSync(seen)).toBe(false);
	});

	test("a spawn failure inside the callback leaves no temp directory", async () => {
		let seen = "";
		const error = await withTempDir(PREFIX, async (path) => {
			seen = path;
			await Bun.write(join(path, "prompt.txt"), "secret prompt");
			return runChild({ cmd: ["/nonexistent/ultrathink-no-such-binary"] });
		}).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
		expect(seen).not.toBe("");
		expect(existsSync(seen)).toBe(false);
	});
});
