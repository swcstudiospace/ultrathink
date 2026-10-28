// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink stack`: one line per USSR Stack member with its state, a secret-free reason and a fix line.
 *
 * Without `--live` every probe is free and read-only. `--live` additionally runs the Decisions check. Every reason
 * and fix crosses `redactSecrets` before it is printed, in text and in JSON, whatever a probe returned.
 */

import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { detectHost } from "../host/detect.ts";
import { resolveStateDir } from "../host/paths.ts";
import type { HostId } from "../host/types.ts";
import { redactSecrets } from "../redact.ts";
import { probeStack } from "./index.ts";
import {
	STACK_MEMBERS,
	type StackConnection,
	type StackMember,
	type StackProbe,
	type StackProbeContext,
} from "./types.ts";

const USAGE_LINE =
	"Usage: ultrathink stack [--live] [--json] [--strict] [--only <member>]... [--timeout <ms>]";

/** The one line of the help text that states what `--live` costs; docs/environment.md is rendered from it. */
export const STACK_LIVE_COST_LINE =
	"--live also runs the Decisions check (spends one request; moves the rail breaker and writes a usage row exactly like `decisions check`)";

const USAGE = [
	USAGE_LINE,
	`  members: ${STACK_MEMBERS.join(", ")}`,
	"  --live             also run the checks that cost a request",
	"  --json             print { members, generatedAt } as one JSON object",
	"  --strict           exit 1 when any member is misconfigured or unavailable",
	"  --only <member>    report only that member; repeat to report several",
	"  --timeout <ms>     per-probe limit, an integer from 1 to 15000 (default 3000)",
	STACK_LIVE_COST_LINE,
].join("\n");

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TIMEOUT_MS = 15_000;

/** Test seams; production passes none. */
export interface StackCommandDeps {
	probes?: Partial<Record<StackMember, StackProbe>>;
	config?: UltrathinkConfig;
	stateDir?: string;
	host?: HostId;
	fetch?: typeof fetch;
	now?: () => number;
}

interface Options {
	live: boolean;
	json: boolean;
	strict: boolean;
	only: StackMember[];
	timeoutMs: number;
}

function isStackMember(value: string): value is StackMember {
	return (STACK_MEMBERS as readonly string[]).includes(value);
}

/** The parsed flags, `help`, or `undefined` for a usage error. */
function parseArgs(args: string[]): Options | "help" | undefined {
	const options: Options = {
		live: false,
		json: false,
		strict: false,
		only: [],
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
	let timeoutSeen = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") return "help";
		if (arg === "--live") options.live = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--strict") options.strict = true;
		else if (arg === "--only") {
			const value = args[++index];
			if (value === undefined || !isStackMember(value)) return undefined;
			if (!options.only.includes(value)) options.only.push(value);
		} else if (arg === "--timeout") {
			const value = args[++index];
			if (timeoutSeen || value === undefined || !/^\d+$/.test(value)) return undefined;
			const ms = Number(value);
			if (ms < 1 || ms > MAX_TIMEOUT_MS) return undefined;
			options.timeoutMs = ms;
			timeoutSeen = true;
		} else return undefined;
	}
	return options;
}

/** A copy of the connection whose free text has passed `redactSecrets`. */
function redacted(connection: StackConnection): StackConnection {
	const { reason, fix, affects, ...rest } = connection;
	return {
		...rest,
		reason: redactSecrets(reason),
		...(fix === undefined ? {} : { fix: redactSecrets(fix) }),
		...(affects === undefined ? {} : { affects: affects.map((item) => redactSecrets(item)) }),
	};
}

function renderText(members: readonly StackConnection[]): string {
	const lines: string[] = [];
	for (const connection of members) {
		lines.push(`${connection.member}  ${connection.status}  ${connection.reason}`);
		if (connection.fix) lines.push(`  fix: ${connection.fix}`);
	}
	return lines.join("\n");
}

/** Runs `ultrathink stack`. Exit 0, except 1 for `--strict` with a misconfigured or unavailable member, 2 for usage. */
export async function runStackCommand(
	args: string[],
	input: { cwd: string; env?: Record<string, string | undefined> },
	deps?: StackCommandDeps,
): Promise<{ output: string; exitCode: number }> {
	const parsed = parseArgs(args);
	if (parsed === "help") return { output: USAGE, exitCode: 0 };
	if (parsed === undefined) return { output: USAGE_LINE, exitCode: 2 };
	const env = input.env ?? process.env;
	const ctx: StackProbeContext = {
		env,
		config: deps?.config ?? loadConfig(claudeConfigPaths(input.cwd, env)),
		cwd: input.cwd,
		stateDir: deps?.stateDir ?? resolveStateDir(env),
		host: deps?.host ?? detectHost(env),
		live: parsed.live,
		timeoutMs: parsed.timeoutMs,
		...(deps?.fetch ? { fetch: deps.fetch } : {}),
		...(deps?.now ? { now: deps.now } : {}),
	};
	const report = await probeStack(ctx, {
		...(parsed.only.length > 0 ? { only: parsed.only } : {}),
		...(deps?.probes ? { probes: deps.probes } : {}),
	});
	const members = report.members.map(redacted);
	const output = parsed.json
		? JSON.stringify({ members, generatedAt: report.generatedAt })
		: renderText(members);
	const failing = members.some(
		(connection) => connection.status === "misconfigured" || connection.status === "unavailable",
	);
	return { output, exitCode: parsed.strict && failing ? 1 : 0 };
}

/** The `bin/ultrathink stack` entry: `runStackCommand` with its result shaped like the other thin dispatchers. */
export async function dispatchStack(
	argv: string[],
	input: { cwd: string; env?: Record<string, string | undefined> },
	deps?: StackCommandDeps,
): Promise<{ code: number; text: string }> {
	const { output, exitCode } = await runStackCommand(argv, input, deps);
	return { code: exitCode, text: output };
}
