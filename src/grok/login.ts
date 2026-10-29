// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { claudeConfigPaths, userConfigPath } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { isRecord } from "../shared.ts";
import { type GrokAuthStatus, grokAuthStatus } from "./auth.ts";
import { type GrokCheckResult, runGrokCheck } from "./check.ts";
import { dropJevKeys } from "../route-defaults.ts";
import type { GrokConfig } from "./types.ts";

export interface GrokLoginOptions {
	home?: string;
	writeConfig?: boolean;
}

export interface GrokLoginDeps {
	grok: GrokConfig;
	/** Default `process.env`. */
	env?: Record<string, string | undefined>;
	/** Runs with INHERITED stdio (the CLI prints the verification URL and code); test seam. */
	spawn?: (cmd: string[], env: Record<string, string | undefined>) => Promise<number>;
	/** Default: `runGrokCheck` with `grok.home` set to the lane home. */
	check?: (home: string) => Promise<GrokCheckResult>;
	/** Default `grokAuthStatus`. */
	status?: (home?: string) => GrokAuthStatus;
	/** Returns the path written; default sets `grok.home` in the user config. */
	writeUserConfig?: (home: string) => string;
	mkdir?: (path: string) => void;
}

export interface GrokLoginResult {
	ok: boolean;
	exitCode: 0 | 1 | 2;
	text: string;
}

const USAGE = "Usage: ultrathink grok login [--home <absolute dir>] [--write-config]";

async function spawnInherited(
	cmd: string[],
	env: Record<string, string | undefined>,
): Promise<number> {
	const proc = Bun.spawn(cmd, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return proc.exited;
}

/** The lane home holds a refresh token, so it is private to the owner. */
function makePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

/**
 * Sets `grok.home` in a user config file and nothing else: other keys, file mode, indentation
 * and the trailing newline survive, and the write is tmp + rename so a crash cannot truncate
 * the file. Throws (without writing) when the file is not a JSON object.
 */
function writeGrokHome(path: string, home: string): string {
	let root: Record<string, unknown> = {};
	let mode = 0o600;
	let indent: string | number = 2;
	let trailingNewline = true;
	if (existsSync(path)) {
		const raw = readFileSync(path, "utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(`${path} is not valid JSON; fix or remove it, then retry`);
		}
		if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object; fix it, then retry`);
		root = parsed;
		mode = statSync(path).mode & 0o777;
		indent = /^\t/m.test(raw) ? "\t" : (/^( +)\S/m.exec(raw)?.[1]?.length ?? 2);
		trailingNewline = raw.endsWith("\n");
	}
	const grok = root.grok;
	if (grok !== undefined && !isRecord(grok))
		throw new Error(`${path}: "grok" is not an object; fix it, then retry`);
	root.grok = { ...(grok ?? {}), home };
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(root, null, indent)}${trailingNewline ? "\n" : ""}`, {
		mode,
	});
	chmodSync(tmp, mode);
	renameSync(tmp, path);
	return path;
}

/** Every user-layer config file, lowest priority first. A project layer cannot set `grok.home`. */
function userConfigFiles(env: Record<string, string | undefined>): string[] {
	return claudeConfigPaths(process.cwd(), env).filter(
		(source): source is string => typeof source === "string",
	);
}

/** The highest-priority user file that sets `grok.home`; any string counts, as in `mergeGrok`. */
function winningGrokHome(files: readonly string[]): { path: string; value: string } | undefined {
	for (const path of files.toReversed()) {
		if (!existsSync(path)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			// reason: an unreadable or invalid file is skipped by the config loader too
			continue;
		}
		if (isRecord(parsed) && isRecord(parsed.grok) && typeof parsed.grok.home === "string")
			return { path, value: parsed.grok.home.trim() };
	}
	return undefined;
}

/**
 * Signs the dedicated Grok lane in with the OFFICIAL Grok CLI under its own `GROK_HOME`.
 * Ultrathink never reads or refreshes tokens here: xAI rotates refresh tokens, so the lane
 * must not share a login with another app, and `~/.grok` is never touched.
 */
export async function runGrokLogin(
	deps: GrokLoginDeps,
	opts: GrokLoginOptions = {},
): Promise<GrokLoginResult> {
	const env = deps.env ?? process.env;
	const home =
		opts.home?.trim() || deps.grok.home.trim() || join(dirname(userConfigPath(env)), "grok");
	if (!isAbsolute(home)) {
		return {
			ok: false,
			exitCode: 2,
			text: `Grok login: home must be an absolute path (got ${home})\n${USAGE}`,
		};
	}

	const mkdir = deps.mkdir ?? makePrivateDir;
	const spawn = deps.spawn ?? spawnInherited;
	const status = deps.status ?? grokAuthStatus;
	const check =
		deps.check ?? ((lane: string) => runGrokCheck({ grok: { ...deps.grok, home: lane } }));

	const childEnv: Record<string, string | undefined> = { ...env, GROK_HOME: home };
	// The lane must be the plan login, not a pay-per-token key the CLI would prefer.
	delete childEnv.XAI_API_KEY;
	dropJevKeys(childEnv);

	let code: number;
	try {
		mkdir(home);
		code = await spawn([deps.grok.bin.trim() || "grok", "login", "--device-auth"], childEnv);
	} catch (error) {
		const message = redactSecrets(error instanceof Error ? error.message : String(error));
		return { ok: false, exitCode: 1, text: `Grok login: failed to start (${message})` };
	}
	if (code !== 0) {
		return { ok: false, exitCode: 1, text: `Grok login: the Grok CLI exited with code ${code}` };
	}

	const session = status(home);
	if (!session.loggedIn) {
		return {
			ok: false,
			exitCode: 1,
			text: `Grok login: the Grok CLI exited 0 but no session was found in ${home}`,
		};
	}
	const expires = session.expiresAt ? ` · expires ${session.expiresAt}` : "";
	const lines = [`Grok login: ${session.email ?? "signed in"} · home ${home}${expires}`];
	// A failed entitlement check is reported with its fix hint, but the login itself succeeded.
	lines.push((await check(home)).text);

	if (opts.writeConfig) {
		const files = userConfigFiles(env);
		let written: string;
		try {
			// Write where grok.home is already decided, or a later `grok check` keeps the old home.
			written = deps.writeUserConfig
				? deps.writeUserConfig(home)
				: writeGrokHome(winningGrokHome(files)?.path ?? userConfigPath(env), home);
		} catch (error) {
			const message = redactSecrets(error instanceof Error ? error.message : String(error));
			lines.push(`Grok login: config not written (${message})`);
			return { ok: false, exitCode: 1, text: lines.join("\n") };
		}
		lines.push(`Grok login: set grok.home in ${written}`);
		const winner = winningGrokHome(files);
		if (winner?.value !== home) {
			lines.push(
				winner
					? `Grok login: warning · ${winner.path} sets grok.home to ${winner.value || "(empty)"} and overrides the lane home ${home}; change or remove grok.home there`
					: `Grok login: warning · grok.home is still unset after writing ${written}; the lane is not in use`,
			);
			return { ok: false, exitCode: 1, text: lines.join("\n") };
		}
	} else {
		lines.push(`Add this to your user config to use the lane: {"grok":{"home":"${home}"}}`);
	}
	return { ok: true, exitCode: 0, text: lines.join("\n") };
}
