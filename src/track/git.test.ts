// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitRun, parseRepoSlug, resolveBranch, resolveRepoSlug } from "./git.ts";

describe("parseRepoSlug", () => {
	test("parses ssh and https remotes", () => {
		expect(parseRepoSlug("git@github.com:swcstudiospace/plugin.git")).toBe("swcstudiospace/plugin");
		expect(parseRepoSlug("https://github.com/swcstudiospace/plugin.git")).toBe(
			"swcstudiospace/plugin",
		);
		expect(parseRepoSlug("https://github.com/swcstudiospace/plugin")).toBe("swcstudiospace/plugin");
	});

	test("returns undefined for an unparsable or empty remote", () => {
		expect(parseRepoSlug("")).toBeUndefined();
		expect(parseRepoSlug("not a url")).toBeUndefined();
	});
});

describe("resolveRepoSlug", () => {
	test("reads the origin remote via the injected run function", () => {
		const slug = resolveRepoSlug("/repo", () => ({
			stdout: "git@github.com:acme/widgets.git\n",
			code: 0,
		}));
		expect(slug).toBe("acme/widgets");
	});

	test("undefined when git exits non-zero or throws", () => {
		expect(resolveRepoSlug("/repo", () => ({ stdout: "", code: 1 }))).toBeUndefined();
		expect(
			resolveRepoSlug("/repo", () => {
				throw new Error("no git");
			}),
		).toBeUndefined();
	});
});

describe("resolveBranch", () => {
	test("reads the current branch via the injected run function", () => {
		expect(resolveBranch("/repo", () => ({ stdout: "feat/widget\n", code: 0 }))).toBe(
			"feat/widget",
		);
	});

	test("undefined when detached, git exits non-zero, or it throws", () => {
		expect(resolveBranch("/repo", () => ({ stdout: "\n", code: 0 }))).toBeUndefined();
		expect(resolveBranch("/repo", () => ({ stdout: "", code: 1 }))).toBeUndefined();
	});
});

describe("createGitRun (planning path git calls are bounded and memoized)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("a git that sleeps 10 s is killed at the timeout and reads as a failure", () => {
		const dir = mkdtempSync(join(tmpdir(), "ut-git-"));
		dirs.push(dir);
		const fake = join(dir, "git");
		writeFileSync(fake, "#!/bin/sh\nexec sleep 10\n");
		chmodSync(fake, 0o755);
		const run = createGitRun({ timeoutMs: 200 });
		const started = performance.now();
		const result = run([fake, "remote", "get-url", "origin"], dir);
		expect(performance.now() - started).toBeLessThan(8000);
		expect(result.code).not.toBe(0);
		expect(resolveRepoSlug(dir, () => result)).toBeUndefined();
	});

	test("the default timeout is 2 s and reaches the spawn", () => {
		const seen: number[] = [];
		const run = createGitRun({
			spawn: (_cmd, _cwd, timeoutMs) => {
				seen.push(timeoutMs);
				return { stdout: "", code: 0 };
			},
		});
		run(["git", "branch", "--show-current"], "/repo");
		expect(seen).toEqual([2000]);
	});

	test("a repeated call for the same cwd and command spawns once within 5 s, again after", () => {
		let clock = 1000;
		let spawns = 0;
		const run = createGitRun({
			now: () => clock,
			spawn: () => {
				spawns += 1;
				return { stdout: `out${spawns}\n`, code: 0 };
			},
		});
		const remote = ["git", "remote", "get-url", "origin"];
		expect(run(remote, "/repo").stdout).toBe("out1\n");
		clock += 4999;
		expect(run(remote, "/repo").stdout).toBe("out1\n");
		expect(spawns).toBe(1);
		run(["git", "branch", "--show-current"], "/repo");
		run(remote, "/other");
		expect(spawns).toBe(3);
		clock += 1;
		expect(run(remote, "/repo").stdout).toBe("out4\n");
		expect(spawns).toBe(4);
	});

	test("a failed (timed out) call is memoized too, so a slow disk stalls once per window", () => {
		const clock = 0;
		let spawns = 0;
		const run = createGitRun({
			now: () => clock,
			spawn: () => {
				spawns += 1;
				return { stdout: "", code: 1 };
			},
		});
		run(["git", "branch", "--show-current"], "/slow");
		run(["git", "branch", "--show-current"], "/slow");
		expect(spawns).toBe(1);
	});

	test("a spawn that throws is not memoized and propagates to the caller's fail-open catch", () => {
		let spawns = 0;
		const run = createGitRun({
			spawn: () => {
				spawns += 1;
				throw new Error("ENOENT");
			},
		});
		expect(resolveBranch("/repo", run)).toBeUndefined();
		expect(resolveBranch("/repo", run)).toBeUndefined();
		expect(spawns).toBe(2);
	});
});
