#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude Code PostCompact hook: a compaction removes the context an injected recall item sat in, so this session's
 * recall dedupe epoch resets (runCompactionReset, SPE-34394). Subagent compactions leave the main session's context
 * alone and are skipped, as the other hooks skip subagents. Silent and fail-open: it always exits 0 and never blocks the host.
 */
import { isChildInvocation } from "../src/claude/complete.ts";
import { type CompactionInput, runCompactionReset } from "../src/claude/hook.ts";
import { defaultStateDir } from "../src/claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import { isSubagentEnvelope, parseEnvelope } from "../src/host/envelope.ts";
import { installChildReaper } from "../src/resilience/child.ts";

interface PostCompactInput extends CompactionInput {
	cwd?: unknown;
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	const envelope = parseEnvelope(await new Response(Bun.stdin.stream()).text());
	if (isSubagentEnvelope(envelope)) return;
	const input = envelope as PostCompactInput;
	const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : process.cwd();
	runCompactionReset(input, {
		config: loadConfig(claudeConfigPaths(cwd)),
		stateDir: defaultStateDir(),
	});
}

installChildReaper({ signals: true });
main()
	.catch(() => {
		// reason: fail-open: a PostCompact hook never blocks the host
	})
	.finally(() => {
		process.exit(0);
	});
