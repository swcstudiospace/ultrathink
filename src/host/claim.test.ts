// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { claimTurn } from "./claim.ts";
import { makeTempDir } from "../../services/ultrathink/test.helpers.ts";

const dirs: string[] = [];

function tempDir(): string {
	return makeTempDir("ultrathink-claim-", dirs);
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claimTurn", () => {
	test("the first hook for a turn wins; a repeat loses; another turn is independent", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
		expect(claimTurn(stateDir, "s1:p2")).toBe(true);
	});

	test("a claim older than 24h is pruned so the key can be claimed again", () => {
		const stateDir = tempDir();
		const now = Date.UTC(2026, 0, 1);
		expect(claimTurn(stateDir, "s1:p1", now)).toBe(true);
		const claims = join(stateDir, "claims");
		const stale = (now - 25 * 60 * 60 * 1000) / 1000;
		for (const name of readdirSync(claims)) utimesSync(join(claims, name), stale, stale);
		expect(claimTurn(stateDir, "s1:p1", now)).toBe(true);
		expect(claimTurn(stateDir, "s1:p1", now)).toBe(false);
	});

	test("an unwritable state dir fails open", () => {
		const blocker = join(tempDir(), "not-a-dir");
		writeFileSync(blocker, "");
		expect(claimTurn(join(blocker, "state"), "s1:p1")).toBe(true);
		expect(claimTurn(join(blocker, "state"), "s1:p1")).toBe(true);
	});

	test.skipIf(process.platform === "win32")(
		"a fresh state dir, its claims dir and claim files are 0700/0700/0600 regardless of umask",
		() => {
			const previous = process.umask(0o022);
			try {
				const stateDir = join(tempDir(), "state");
				expect(claimTurn(stateDir, "s1:p1")).toBe(true);
				const claims = join(stateDir, "claims");
				expect(statSync(stateDir).mode & 0o777).toBe(0o700);
				expect(statSync(claims).mode & 0o777).toBe(0o700);
				const [name] = readdirSync(claims);
				expect(name).toBeDefined();
				expect(statSync(join(claims, name as string)).mode & 0o777).toBe(0o600);
			} finally {
				process.umask(previous);
			}
		},
	);

	function claimFile(stateDir: string, key: string): string {
		return join(stateDir, "claims", createHash("sha256").update(key).digest("hex").slice(0, 32));
	}

	function claimInChild(
		stateDir: string,
		tail: string,
	): { exitCode: number | null; stderr: string } {
		const script = `import { claimTurn, markClaimedTurnsDone } from ${JSON.stringify(join(import.meta.dir, "claim.ts"))};\nconst won = claimTurn(${JSON.stringify(stateDir)}, "s1:p1");\n${tail}\n`;
		const child = Bun.spawnSync(["bun", "--no-env-file", "-e", script], { stderr: "pipe" });
		return { exitCode: child.exitCode, stderr: child.stderr.toString() };
	}

	test("a claim whose owner died without finishing is taken over; the new owner then wins against a repeat", () => {
		const stateDir = tempDir();
		// A real child claims the turn and is killed before its exit handlers run: no completion marker, pid dead.
		const child = claimInChild(stateDir, 'process.kill(process.pid, "SIGKILL");');
		expect(child.exitCode).not.toBe(0);
		expect(readdirSync(join(stateDir, "claims"))).toHaveLength(1);
		expect(JSON.parse(readFileSync(claimFile(stateDir, "s1:p1"), "utf8")).done).toBeUndefined();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
	}, 60_000);

	test("a hook that exited normally leaves a done claim: a later duplicate stays out", () => {
		const stateDir = tempDir();
		const child = claimInChild(stateDir, "markClaimedTurnsDone();\nprocess.exit(won ? 0 : 3);");
		expect(child.stderr).toBe("");
		expect(child.exitCode).toBe(0);
		const body = JSON.parse(readFileSync(claimFile(stateDir, "s1:p1"), "utf8"));
		expect(body.done).toBe(true);
		expect(typeof body.pid).toBe("number");
		expect(typeof body.startTime).toBe("string");
		// Two sequential duplicates after the owner finished: neither plans the turn again.
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
		// A sequential second hook process is also refused.
		expect(
			claimInChild(stateDir, "markClaimedTurnsDone();\nprocess.exit(won ? 3 : 0);").exitCode,
		).toBe(0);
	}, 60_000);

	test("a hook killed by SIGTERM (exit handlers still run) leaves the claim not done: a retried turn takes it over", () => {
		const stateDir = tempDir();
		// Same shape as the hook's child reaper: the signal handler ends the process through `process.exit`.
		const tail = [
			'process.on("SIGTERM", () => process.exit(143));',
			'process.kill(process.pid, "SIGTERM");',
			"setTimeout(() => process.exit(0), 20_000);",
		].join("\n");
		const child = claimInChild(stateDir, tail);
		expect(child.exitCode).toBe(143);
		expect(JSON.parse(readFileSync(claimFile(stateDir, "s1:p1"), "utf8")).done).toBeUndefined();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
	}, 60_000);

	test("a hook that exits without finishing its work leaves the claim not done", () => {
		const stateDir = tempDir();
		const child = claimInChild(stateDir, "process.exit(won ? 0 : 3);");
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(readFileSync(claimFile(stateDir, "s1:p1"), "utf8")).done).toBeUndefined();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
	}, 60_000);

	test("a done claim stays held until the 24h window ends, then the key can be claimed again", () => {
		const stateDir = tempDir();
		expect(claimInChild(stateDir, "markClaimedTurnsDone();\nprocess.exit(0);").exitCode).toBe(0);
		const file = claimFile(stateDir, "s1:p1");
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(file, old, old);
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
	}, 60_000);

	test("a live owner that has not finished holds the claim against concurrent duplicates", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(JSON.parse(readFileSync(claimFile(stateDir, "s1:p1"), "utf8")).done).toBeUndefined();
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
	});

	test("the claim records its owner's pid and start identity", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		const body = JSON.parse(readFileSync(claimFile(stateDir, "s1:p1"), "utf8"));
		expect(body.pid).toBe(process.pid);
		expect(typeof body.startTime).toBe("string");
	});

	test("a live pid that is a different process (recycled pid) loses the claim", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		writeFileSync(
			claimFile(stateDir, "s1:p1"),
			JSON.stringify({ pid: process.pid, startTime: "proc:1" }),
		);
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
	});

	test("a claim file from an older version (no owner record) still wins until it expires", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		writeFileSync(claimFile(stateDir, "s1:p1"), "");
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
	});
});
