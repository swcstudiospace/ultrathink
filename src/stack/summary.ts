// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one-line stack summary `status` prints: `Stack: 3 ready · 1 off · 1 missing (run ultrathink stack)`.
 *
 * It is synchronous and offline. It reads the environment, the config and the credential store, and checks one
 * path with `existsSync`; it never opens a socket, makes a request, spawns a process or calls a probe (it imports
 * only the two pure env helpers of `realm.ts`, never `probeRealm`). The line
 * carries counts only: no member name, URL, path or key material. Contacting a member is `ultrathink stack`.
 *
 * Readiness per member, each from the member's own offline helper:
 * - substrate: ready iff `resolveSubstrate(env, config.substrate.url)` returns a target (false for
 *   `SUBSTRATE_DISABLED=1` or no URL), else off.
 * - swarm: ready iff `resolveSwarmRoot(env)` returns `{ root }` (an absolute checkout holding
 *   `hooks/autonomous_run.py`), else missing.
 * - realm: off iff `isOptedOut(env)` of `realm.ts` (`ULTRATHINK_REALM` trims and lowercases to `off`); else ready
 *   iff Realm's config file exists, at the path `resolveConfigPath` of `realm.ts` derives (an absolute
 *   `XDG_CONFIG_HOME` wins, else an absolute `HOME`, else no path); else missing. Existence only: the file is not
 *   read and the daemon is not dialled.
 * - decisions: off iff `decisionsKilled(env)` (`ULTRATHINK_DECISIONS=0`), else ready iff
 *   `resolveDecisionsKeys(config.decisions, storePath(env), env).key` is set, else missing.
 * - hindsight: from `resolveHindsight(config.hindsight, env, ...).readiness`: `ready` is ready, `off` is off,
 *   `unready` is missing. The resolver only reads files; it builds a client but does not call it.
 */

import { existsSync } from "node:fs";
import type { UltrathinkConfig } from "../config.ts";
import { decisionsKilled, resolveDecisionsKeys } from "../decisions/gate.ts";
import { resolveHindsight } from "../hindsight/settings.ts";
import { storePath } from "../mcp/store.ts";
import { resolveSubstrate } from "../substrate/brief.ts";
import { resolveSwarmRoot } from "../swarm/teams.ts";
import { isOptedOut, resolveConfigPath } from "./realm.ts";

type Readiness = "ready" | "off" | "missing";

type Env = Record<string, string | undefined>;

function realmReadiness(env: Env, existsPath: (path: string) => boolean): Readiness {
	if (isOptedOut(env)) return "off";
	const configPath = resolveConfigPath(env);
	return configPath !== undefined && existsPath(configPath) ? "ready" : "missing";
}

function hindsightReadiness(config: UltrathinkConfig, env: Env): Readiness {
	const { readiness } = resolveHindsight(config.hindsight, env, {
		storePath: storePath(env),
		gateway: config.gateway,
	});
	if (readiness.state === "ready") return "ready";
	return readiness.state === "off" ? "off" : "missing";
}

function decisionsReadiness(config: UltrathinkConfig, env: Env): Readiness {
	if (decisionsKilled(env)) return "off";
	return resolveDecisionsKeys(config.decisions, storePath(env), env).key ? "ready" : "missing";
}

/** One member's readiness; a helper that throws counts as missing so the line still renders. */
function guarded(read: () => Readiness): Readiness {
	try {
		return read();
	} catch {
		return "missing";
	}
}

/*
 * Three vocabularies, one place. This line speaks the offline words `ready`, `off` and `missing`; the `ultrathink
 * stack` report and the doctor `stack` section speak the probe statuses `connected`, `disabled`, `unavailable`,
 * `misconfigured` and `degraded` (`ConnectionStatus`). The offline words never say whether a link ANSWERS: that is
 * only learned by probing, so `ready` means "configured", not "connected", and `unavailable` / `degraded` have no
 * offline word.
 *
 *   offline word | what it means here                         | probe status the same state gets
 *   -------------+---------------------------------------------+--------------------------------------------
 *   ready        | the member's own config helper resolves     | connected, degraded or unavailable (decided by
 *                | (a target, a root, a key, a config file)    | the probe's request; the line cannot tell)
 *   off          | explicit kill switch or opt-out, OR no      | disabled
 *                | Substrate URL (see below)                   |
 *   missing      | not set up and not switched off             | misconfigured, or disabled for swarm (autoRun off,
 *                |                                             | no root) and realm (not installed or configured)
 *
 * What produces `off`, per member:
 * - kill switch or opt-out (the user said no): substrate `SUBSTRATE_DISABLED=1`; realm `ULTRATHINK_REALM=off`;
 *   decisions `ULTRATHINK_DECISIONS=0`; hindsight `ULTRATHINK_HINDSIGHT=0` (readiness `off`, reason `killed`) or
 *   `hindsight.enabled` not set (readiness `off`, reason `disabled`: Hindsight is opt-in).
 * - no URL configured (nothing was asked for): substrate only, `resolveSubstrate` returns no target, so a fresh
 *   install without a Substrate URL reads `off`, and its probe says `disabled` ("no Substrate URL configured").
 *
 * What produces `missing` (a member that should work but lacks a piece): swarm has no valid root (no root set, or
 *   the root fails `resolveSwarmRoot`; the offline line has no `off` for swarm, so a swarm the probe calls `disabled`
 *   reads `missing` here); realm has no config file at the derived path (its probe says `disabled`, "not installed
 *   or not configured"); decisions has no Jev key; hindsight is
 *   opted in but its URL, key or gateway token is absent or refused (readiness `unready`). A helper that throws
 *   also counts as `missing`.
 */
/** The offline stack summary line for `status`. Never throws, never does network, socket or process I/O. */
export function stackSummaryLine(
	config: UltrathinkConfig,
	env: Env,
	deps: { existsPath?: (path: string) => boolean } = {},
): string {
	const existsPath = deps.existsPath ?? existsSync;
	const states: Readiness[] = [
		guarded(() => (resolveSubstrate(env, config.substrate.url) ? "ready" : "off")),
		guarded(() => ("root" in resolveSwarmRoot(env) ? "ready" : "missing")),
		guarded(() => realmReadiness(env, existsPath)),
		guarded(() => decisionsReadiness(config, env)),
		guarded(() => hindsightReadiness(config, env)),
	];
	const count = (wanted: Readiness): number => states.filter((state) => state === wanted).length;
	const parts = (["ready", "off", "missing"] as const)
		.map((bucket) => ({ bucket, n: count(bucket) }))
		.filter(({ n }) => n > 0)
		.map(({ bucket, n }) => `${n} ${bucket}`);
	return `Stack: ${parts.join(" · ")} (run ultrathink stack)`;
}
