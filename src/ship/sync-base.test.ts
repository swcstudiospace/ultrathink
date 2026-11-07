// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGithub } from "./github.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "ultrathink",
			GIT_AUTHOR_EMAIL: "ultrathink@example.com",
			GIT_COMMITTER_NAME: "ultrathink",
			GIT_COMMITTER_EMAIL: "ultrathink@example.com",
		},
	}).trim();
}

/** Whether `ref` resolves in `cwd`; `rev-parse --verify` exits 0 only when it does. */
function hasRef(cwd: string, ref: string): boolean {
	return spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd }).status === 0;
}

/** Commits a new file on the current branch and returns the new head. */
function commit(repo: string, file: string): string {
	writeFileSync(join(repo, file), file);
	git(repo, "add", file);
	git(repo, "commit", "-q", "-m", file);
	return git(repo, "rev-parse", "HEAD");
}

/** A bare `origin` and a working clone on `main`, with the first commit pushed. `main` is the base branch. */
function fixture(): { origin: string; work: string } {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-sync-base-"));
	roots.push(root);
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	git(root, "init", "-q", "--bare", "-b", "main", origin);
	git(root, "init", "-q", "-b", "main", work);
	git(work, "remote", "add", "origin", origin);
	commit(work, "base.txt");
	git(work, "push", "-q", "origin", "main");
	return { origin, work };
}

describe("syncBase keeps the checkout and moves the base ref", () => {
	test("a checkout on another branch stays put; the base catches up and the merged branch is deleted", () => {
		const { origin, work } = fixture();
		git(work, "checkout", "-q", "-b", "feat");
		const head = commit(work, "feat.txt");
		git(work, "push", "-q", "origin", "feat");
		git(work, "push", "-q", "origin", "feat:main");
		git(work, "checkout", "-q", "-b", "other", "main");
		expect(
			createGithub({ cwd: work }).syncBase({ base: "main", branch: "feat", headSha: head }),
		).toEqual({ ok: true });
		expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("other");
		expect(git(work, "rev-parse", "refs/heads/main")).toBe(
			git(origin, "rev-parse", "refs/heads/main"),
		);
		expect(hasRef(work, "refs/heads/feat")).toBe(false);
	});

	test("a checked-out base is left alone, and the merged branch is still deleted", () => {
		const { origin, work } = fixture();
		git(work, "checkout", "-q", "-b", "feat");
		const head = commit(work, "feat.txt");
		git(work, "push", "-q", "origin", "feat");
		git(work, "checkout", "-q", "main");
		const before = git(work, "rev-parse", "HEAD");
		git(work, "push", "-q", "origin", "feat:main");
		expect(
			createGithub({ cwd: work }).syncBase({ base: "main", branch: "feat", headSha: head }),
		).toEqual({ ok: true });
		expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(git(work, "rev-parse", "HEAD")).toBe(before);
		expect(git(origin, "rev-parse", "refs/heads/main")).toBe(head);
		expect(hasRef(work, "refs/heads/feat")).toBe(false);
	});

	test("a base checked out in another worktree is left alone too, and the merged branch is still deleted", () => {
		const { work } = fixture();
		git(work, "checkout", "-q", "-b", "feat");
		const head = commit(work, "feat.txt");
		git(work, "push", "-q", "origin", "feat");
		git(work, "push", "-q", "origin", "feat:main");
		git(work, "checkout", "-q", "-b", "other", "main");
		const elsewhere = join(work, "..", "elsewhere");
		git(work, "worktree", "add", "-q", elsewhere, "main");
		const before = git(elsewhere, "rev-parse", "HEAD");
		expect(
			createGithub({ cwd: work }).syncBase({ base: "main", branch: "feat", headSha: head }),
		).toEqual({ ok: true });
		expect(git(elsewhere, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(git(elsewhere, "rev-parse", "HEAD")).toBe(before);
		expect(hasRef(work, "refs/heads/feat")).toBe(false);
	});

	test("the merged branch is kept when it is the one checked out, and the base still catches up", () => {
		const { origin, work } = fixture();
		git(work, "checkout", "-q", "-b", "feat");
		const head = commit(work, "feat.txt");
		git(work, "push", "-q", "origin", "feat");
		git(work, "push", "-q", "origin", "feat:main");
		expect(
			createGithub({ cwd: work }).syncBase({ base: "main", branch: "feat", headSha: head }),
		).toEqual({ ok: true });
		expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat");
		expect(git(work, "rev-parse", "refs/heads/main")).toBe(
			git(origin, "rev-parse", "refs/heads/main"),
		);
		expect(hasRef(work, "refs/heads/feat")).toBe(true);
	});

	test("a base with commits origin lacks is refused rather than rewritten, and the branch is kept", () => {
		const { work } = fixture();
		git(work, "checkout", "-q", "-b", "feat");
		const head = commit(work, "feat.txt");
		git(work, "push", "-q", "origin", "feat");
		git(work, "push", "-q", "origin", "feat:main");
		git(work, "checkout", "-q", "main");
		const localMain = commit(work, "local.txt");
		git(work, "checkout", "-q", "-b", "other");
		const result = createGithub({ cwd: work }).syncBase({
			base: "main",
			branch: "feat",
			headSha: head,
		});
		expect(result.ok).toBe(false);
		expect(git(work, "rev-parse", "refs/heads/main")).toBe(localMain);
		expect(hasRef(work, "refs/heads/feat")).toBe(true);
	});

	test("an unmerged branch is never force-deleted: git refuses, the error is reported and the branch is kept", () => {
		const { work } = fixture();
		git(work, "checkout", "-q", "-b", "feat");
		commit(work, "feat.txt");
		git(work, "checkout", "-q", "-b", "other", "main");
		const result = createGithub({ cwd: work }).syncBase({ base: "main", branch: "feat" });
		expect(result.ok).toBe(false);
		expect(hasRef(work, "refs/heads/feat")).toBe(true);
	});
});
