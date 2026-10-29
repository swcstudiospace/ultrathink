// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
const SSH_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const HTTPS_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

export function parseRepoSlug(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim();
	if (!trimmed) return undefined;
	const ssh = SSH_RE.exec(trimmed);
	if (ssh) return `${ssh[2]}/${ssh[3]}`;
	const https = HTTPS_RE.exec(trimmed);
	if (https) return `${https[2]}/${https[3]}`;
	return undefined;
}

export type GitRun = (cmd: string[], cwd: string) => { stdout: string; code: number };

/** A git call never blocks the host's event loop longer than this; a killed call reads as a failed one. */
const GIT_TIMEOUT_MS = 2000;
/** A result is reused this long per directory and command, so a planning run spawns each git command at most once. */
const GIT_CACHE_TTL_MS = 5000;
const GIT_CACHE_CAP = 200;

type GitSpawn = (cmd: string[], cwd: string, timeoutMs: number) => { stdout: string; code: number };

const spawnGit: GitSpawn = (cmd, cwd, timeoutMs) => {
	const proc = Bun.spawnSync(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	return { stdout: proc.stdout?.toString() ?? "", code: proc.exitCode ?? 1 };
};

interface GitRunOptions {
	timeoutMs?: number;
	ttlMs?: number;
	now?: () => number;
	spawn?: GitSpawn;
}

/** A synchronous git runner with a spawn timeout and a per-(cwd, command) TTL memo. A throwing spawn is never memoized. */
export function createGitRun(options: GitRunOptions = {}): GitRun {
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
	const ttlMs = options.ttlMs ?? GIT_CACHE_TTL_MS;
	const now = options.now ?? Date.now;
	const spawn = options.spawn ?? spawnGit;
	const cache = new Map<string, { at: number; result: { stdout: string; code: number } }>();
	return (cmd, cwd) => {
		const key = `${cwd}\0${cmd.join("\0")}`;
		const at = now();
		const cached = cache.get(key);
		if (cached && at - cached.at < ttlMs) return cached.result;
		const result = spawn(cmd, cwd, timeoutMs);
		cache.delete(key);
		cache.set(key, { at, result });
		if (cache.size > GIT_CACHE_CAP) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		return result;
	};
}

const defaultGitRun = createGitRun();

export function resolveRepoSlug(root: string, run: GitRun = defaultGitRun): string | undefined {
	try {
		const result = run(["git", "remote", "get-url", "origin"], root);
		if (result.code !== 0) return undefined;
		return parseRepoSlug(result.stdout);
	} catch {
		return undefined;
	}
}

export function resolveBranch(root: string, run: GitRun = defaultGitRun): string | undefined {
	try {
		const result = run(["git", "branch", "--show-current"], root);
		if (result.code !== 0) return undefined;
		const branch = result.stdout.trim();
		return branch || undefined;
	} catch {
		return undefined;
	}
}
