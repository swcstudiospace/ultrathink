// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitUntil } from "../test.helpers.ts";
import { readRuns } from "./runlog.ts";
import { spawnObserveDetached, writeInbox } from "./spawn.ts";
import type { TeachDigest } from "./types.ts";

let root: string;
let stateDir: string;
let repoRoot: string;
let sessionCwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "teach-spawn-"));
	stateDir = join(root, "state");
	repoRoot = join(root, "repo");
	sessionCwd = join(root, "session");
	mkdirSync(repoRoot);
	mkdirSync(sessionCwd);
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function digest(overrides: Partial<TeachDigest> = {}): TeachDigest {
	return {
		host: "omp",
		sessionId: "s1",
		cwd: sessionCwd,
		at: "2026-10-02T10:00:00.000Z",
		turns: [
			{ role: "user", text: "go" },
			{ role: "assistant", text: "done" },
		],
		toolCalls: 4,
		...overrides,
	};
}

const inbox = (): string => join(stateDir, "teach", "inbox");

interface SupervisorTask {
	stateDir: string;
	sessionId: string;
	command: string;
	args: string[];
}

/** The JSON task the supervisor is handed: its arguments are [supervisor path, task]. */
function launched(args: string[]): SupervisorTask {
	return JSON.parse(args[1] ?? "{}");
}

/** Starts each launch in the foreground, so a test can await the supervisor's exit. */
function foreground(exits: Promise<number>[]) {
	return (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
		const proc = Bun.spawn([cmd, ...args], {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "ignore", "ignore"],
		});
		exits.push(proc.exited);
		return { pid: proc.pid };
	};
}

describe("writeInbox", () => {
	test("writes a private, atomically-named file under <stateDir>/teach/inbox", () => {
		const path = writeInbox(digest(), stateDir, () => 1_790_000_000_000);
		expect(path.startsWith(`${inbox()}/`)).toBe(true);
		expect(path.slice(inbox().length + 1)).toMatch(/^1790000000000-[0-9a-f]{8}\.json$/);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(inbox()).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(digest());
		expect(readdirSync(inbox()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("two writes in the same millisecond get different files", () => {
		const a = writeInbox(digest(), stateDir, () => 5);
		const b = writeInbox(digest(), stateDir, () => 5);
		expect(a).not.toBe(b);
		expect(readdirSync(inbox())).toHaveLength(2);
	});
});

describe("spawnObserveDetached", () => {
	test("starts the supervisor through bin/run-bun with the observe command, inbox file, host and state dir", () => {
		const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
		const env = {
			PATH: "/usr/bin",
			KEEP: "1",
			ULTRATHINK_HOST: "stale",
			ULTRATHINK_STATE_DIR: "/stale",
		};
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env,
			stateDir,
			host: "omp",
			spawn: (cmd, args, opts) => {
				calls.push({ cmd, args, ...opts });
			},
		});
		expect(result).toEqual({ spawned: true });
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.cmd.endsWith(join("bin", "run-bun"))).toBe(true);
		expect(call?.args[0]?.endsWith("launch-supervisor.ts")).toBe(true);
		const task = launched(call?.args ?? []);
		expect(task).toMatchObject({
			stateDir,
			sessionId: "s1",
			command: join(repoRoot, "bin", "ultrathink"),
		});
		expect(task.args.slice(0, 3)).toEqual(["teach", "observe", "--file"]);
		const file = task.args[3] ?? "";
		expect(file.startsWith(`${inbox()}/`)).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(digest());
		expect(call?.env).toMatchObject({
			PATH: "/usr/bin",
			KEEP: "1",
			ULTRATHINK_HOST: "omp",
			ULTRATHINK_STATE_DIR: stateDir,
		});
		expect(call?.cwd).toBe(sessionCwd);
		expect(env.ULTRATHINK_HOST).toBe("stale");
	});

	test("hands the detached worker the Jev key variables unchanged (it asks Jev itself) along with the rest of the host env", () => {
		const calls: { env: NodeJS.ProcessEnv }[] = [];
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: {
				PATH: "/usr/bin",
				KEEP: "1",
				ULTRATHINK_OPENROUTER_KEY: "sk-or-v1-CANARYCANARYCANARY1234",
				OPENROUTER_API_KEY: "sk-or-v1-CANARYCANARYCANARY5678",
				AI_GATEWAY_API_KEY: "vck_CANARYCANARYCANARY9012",
			},
			stateDir,
			host: "omp",
			spawn: (_cmd, _args, opts) => {
				calls.push({ env: opts.env });
			},
		});
		expect(result).toEqual({ spawned: true });
		expect(calls).toHaveLength(1);
		const childEnv = calls[0]?.env ?? {};
		expect(childEnv.ULTRATHINK_OPENROUTER_KEY).toBe("sk-or-v1-CANARYCANARYCANARY1234");
		expect(childEnv.OPENROUTER_API_KEY).toBe("sk-or-v1-CANARYCANARYCANARY5678");
		expect(childEnv.AI_GATEWAY_API_KEY).toBe("vck_CANARYCANARYCANARY9012");
		expect(childEnv.PATH).toBe("/usr/bin");
		expect(childEnv.KEEP).toBe("1");
		expect(childEnv.ULTRATHINK_HOST).toBe("omp");
	});

	test("runs in the repository root when the session directory no longer exists", () => {
		let cwd = "";
		spawnObserveDetached(digest({ cwd: join(root, "gone") }), {
			repoRoot,
			env: {},
			stateDir,
			host: "omp",
			spawn: (_cmd, _args, opts) => {
				cwd = opts.cwd;
			},
		});
		expect(cwd).toBe(repoRoot);
	});

	test("a failing spawn reports the reason, removes the inbox file and does not throw", () => {
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: {},
			stateDir,
			host: "omp",
			spawn: () => {
				throw new Error("EACCES: nope");
			},
		});
		expect(result.spawned).toBe(false);
		expect(result.reason).toContain("EACCES");
		expect(readdirSync(inbox())).toEqual([]);
	});

	test("an unwritable state directory reports spawned:false", () => {
		writeFileSync(join(root, "blocker"), "");
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: {},
			stateDir: join(root, "blocker"),
			host: "omp",
			spawn: () => {
				// reason: test double; the detached launch is not wanted here
			},
		});
		expect(result.spawned).toBe(false);
		expect(result.reason).toBeTruthy();
	});

	test("prunes inbox files older than 24 hours and leaves fresh and foreign files alone", () => {
		const now = 1_790_000_000_000;
		setSystemTime(new Date(now));
		try {
			mkdirSync(inbox(), { recursive: true });
			const old = join(inbox(), "1000-aaaaaaaa.json");
			const oldTmp = join(inbox(), "1000-bbbbbbbb.json.tmp");
			const fresh = join(inbox(), `${now - 60_000}-cccccccc.json`);
			const foreign = join(inbox(), "notes.txt");
			for (const path of [old, oldTmp, fresh, foreign]) writeFileSync(path, "{}");
			spawnObserveDetached(digest(), {
				repoRoot,
				env: {},
				stateDir,
				host: "omp",
				spawn: () => {
					// reason: test double; only the inbox prune is under test, so no process is started
				},
			});
			expect(existsSync(old)).toBe(false);
			expect(existsSync(oldTmp)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
			expect(existsSync(foreign)).toBe(true);
			expect(readdirSync(inbox())).toHaveLength(3);
		} finally {
			setSystemTime();
		}
	});

	test("the real launcher receives the file, host, state dir and session cwd", async () => {
		const dir = mkdtempSync(join(tmpdir(), "teach-launcher-"));
		try {
			const marker = join(dir, "marker.txt");
			mkdirSync(join(repoRoot, "bin"));
			const launcher = join(repoRoot, "bin", "ultrathink");
			writeFileSync(
				launcher,
				`#!/bin/sh\nprintf '%s|%s|%s|%s' "$*" "$ULTRATHINK_HOST" "$ULTRATHINK_STATE_DIR" "$(pwd -P)" > "${marker}"\n`,
			);
			chmodSync(launcher, 0o755);
			const exits: Promise<number>[] = [];
			const result = spawnObserveDetached(digest(), {
				repoRoot,
				env: { ...process.env },
				stateDir,
				host: "omp",
				spawn: foreground(exits),
			});
			expect(result).toEqual({ spawned: true });
			expect(await Promise.all(exits)).toEqual([0]);
			const [argv, host, state, cwd] = readFileSync(marker, "utf8").split("|");
			expect(argv?.startsWith("teach observe --file ")).toBe(true);
			expect(argv?.slice("teach observe --file ".length).startsWith(`${inbox()}/`)).toBe(true);
			expect(host).toBe("omp");
			expect(state).toBe(stateDir);
			expect(cwd).toBe(realpathSync(sessionCwd));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a launch whose command cannot start is recorded with a null exit code, and spawned stays true", async () => {
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: { ...process.env },
			stateDir,
			host: "omp",
		});
		expect(result).toEqual({ spawned: true });
		await waitUntil(() => readRuns(stateDir).length > 0, { name: "a launch-exit run record" });
		expect(readRuns(stateDir)).toEqual([
			{
				at: expect.any(Number),
				sessionId: "s1",
				outcome: "skipped",
				captured: 0,
				skipped: "launch exited",
				exitCode: null,
			},
		]);
	});

	test("a launch that exits non-zero is recorded with its exit code by the supervisor", async () => {
		mkdirSync(join(repoRoot, "bin"));
		const launcher = join(repoRoot, "bin", "ultrathink");
		writeFileSync(launcher, "#!/bin/sh\nexit 3\n");
		chmodSync(launcher, 0o755);
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: { ...process.env },
			stateDir,
			host: "omp",
		});
		expect(result).toEqual({ spawned: true });
		await waitUntil(() => readRuns(stateDir).some((run) => run.exitCode === 3), {
			name: "a run record with exit code 3",
		});
		expect(readRuns(stateDir)).toEqual([
			{
				at: expect.any(Number),
				sessionId: "s1",
				outcome: "skipped",
				captured: 0,
				skipped: "launch exited",
				exitCode: 3,
			},
		]);
	});

	test("the record is written after the hook process that started the launch has exited", async () => {
		mkdirSync(join(repoRoot, "bin"));
		const launcher = join(repoRoot, "bin", "ultrathink");
		writeFileSync(launcher, "#!/bin/sh\nsleep 0.3\nexit 3\n");
		chmodSync(launcher, 0o755);
		const hook = join(root, "hook.ts");
		writeFileSync(
			hook,
			[
				`import { spawnObserveDetached } from ${JSON.stringify(join(import.meta.dir, "spawn.ts"))};`,
				"const input = JSON.parse(process.argv[2] ?? '{}');",
				"const result = spawnObserveDetached(",
				"  { host: 'omp', sessionId: 's1', cwd: input.cwd, at: '2026-10-02T10:00:00.000Z', turns: [], toolCalls: 0 },",
				"  { repoRoot: input.repoRoot, env: { ...process.env }, stateDir: input.stateDir, host: 'omp' },",
				");",
				"process.exit(result.spawned ? 0 : 2);",
			].join("\n"),
		);
		const hookRun = Bun.spawn(
			[process.execPath, hook, JSON.stringify({ repoRoot, stateDir, cwd: sessionCwd })],
			{ env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] },
		);
		expect(await hookRun.exited).toBe(0);
		await waitUntil(() => readRuns(stateDir).length > 0, { name: "a launch-exit run record" });
		expect(readRuns(stateDir)).toEqual([
			{
				at: expect.any(Number),
				sessionId: "s1",
				outcome: "skipped",
				captured: 0,
				skipped: "launch exited",
				exitCode: 3,
			},
		]);
	});

	test("a launch that exits zero writes no run record", async () => {
		mkdirSync(join(repoRoot, "bin"));
		const launcher = join(repoRoot, "bin", "ultrathink");
		const marker = join(root, "ran.txt");
		writeFileSync(launcher, `#!/bin/sh\nprintf ran > "${marker}"\nexit 0\n`);
		chmodSync(launcher, 0o755);
		const exits: Promise<number>[] = [];
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: { ...process.env },
			stateDir,
			host: "omp",
			spawn: foreground(exits),
		});
		expect(result).toEqual({ spawned: true });
		expect(await Promise.all(exits)).toEqual([0]);
		expect(readFileSync(marker, "utf8")).toBe("ran");
		expect(readRuns(stateDir)).toEqual([]);
	});

	test("returns spawned true at once, before the observe command has run", async () => {
		mkdirSync(join(repoRoot, "bin"));
		const launcher = join(repoRoot, "bin", "ultrathink");
		const marker = join(root, "ran.txt");
		writeFileSync(launcher, `#!/bin/sh\nsleep 0.3\nprintf ran > "${marker}"\n`);
		chmodSync(launcher, 0o755);
		const result = spawnObserveDetached(digest(), {
			repoRoot,
			env: { ...process.env },
			stateDir,
			host: "omp",
		});
		expect(result).toEqual({ spawned: true });
		expect(existsSync(marker)).toBe(false);
		await waitUntil(() => existsSync(marker), { name: "the observe command to run" });
	});
});
