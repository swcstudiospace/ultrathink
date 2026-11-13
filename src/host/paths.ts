// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * State directories are host-scoped and never land inside `.planning/`.
 *
 * An explicit `ULTRATHINK_STATE_DIR` wins only when it is an absolute path that
 * resolves (lexically, no symlink resolution) inside the user's home directory,
 * is not the home directory itself, and does not point into a planning tree.
 * Anything else falls back to the host default, and `resolveStateDirDetail`
 * reports the refused value and why, so the fallback is never silent.
 *
 * Test isolation uses a scratch directory inside the home directory (src/test.setup.ts). No env override widens the rule.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { detectHost } from "./detect.ts";
import type { HostId } from "./types.ts";

export function isPlanningPath(dir: string): boolean {
	const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	return norm === ".planning" || norm.endsWith("/.planning") || norm.includes("/.planning/");
}

export function stateDirForHost(
	host: HostId,
	env: Record<string, string | undefined> = process.env,
): string {
	switch (host) {
		case "grok-build": {
			const data = env.GROK_PLUGIN_DATA?.trim();
			if (data) return join(data, "ultrathink");
			const home = env.GROK_HOME?.trim() || join(homedir(), ".grok");
			return join(home, "plugin-data", "ultrathink");
		}
		case "hermes": {
			const home = env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
			return join(home, "ultrathink");
		}
		case "muse": {
			const config = env.XDG_CONFIG_HOME?.trim();
			const home = config ? join(config, "muse") : join(homedir(), ".config", "muse");
			return join(home, "ultrathink");
		}
		case "omp": {
			const home = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
			return join(home, "ultrathink");
		}
		case "prime-agent": {
			const home = env.PRIME_AGENT_CODING_AGENT_DIR?.trim() || join(homedir(), ".prime", "agent");
			return join(home, "ultrathink");
		}
		case "claude-code": {
			const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
			return join(home, "ultrathink");
		}
		case "cursor":
			return join(homedir(), ".cursor", "ultrathink");
	}
}

type StateDirRejectionReason =
	| "empty"
	| "relative"
	| "outside-home"
	| "home-directory"
	| "planning-path";

export interface StateDirDetail {
	dir: string;
	rejected?: { value: string; reason: StateDirRejectionReason };
}

/** True when `path` is `root` itself or lies below it. Both arguments must be resolved. */
function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Resolves the state directory and says why an explicit `ULTRATHINK_STATE_DIR` was refused. An unset variable
 * returns the host default with no rejection. See the header for the test-only root.
 */
export function resolveStateDirDetail(
	env: Record<string, string | undefined> = process.env,
): StateDirDetail {
	const host = detectHost(env);
	const fallback = stateDirForHost(host, env);
	const raw = env.ULTRATHINK_STATE_DIR;
	if (raw === undefined) return { dir: fallback };
	const override = raw.trim();
	const refuse = (reason: StateDirRejectionReason) => ({
		dir: fallback,
		rejected: { value: override, reason },
	});
	if (!override) return refuse("empty");
	if (!isAbsolute(override)) return refuse("relative");

	const path = resolve(override);
	const home = resolve(homedir());
	if (path === home) return refuse("home-directory");

	const permitted = isWithin(home, path);
	if (!permitted) return refuse("outside-home");

	if (isPlanningPath(override)) return refuse("planning-path");
	return { dir: override };
}

export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
	return resolveStateDirDetail(env).dir;
}
