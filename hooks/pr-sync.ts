#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * PostToolUse hook for Claude Code, Grok Build, and Muse (via
 * hooks/muse-post-tool). Claude's hooks.json matcher pre-filters to `Bash`
 * plus a few PR-creation tool names, but Muse has no matcher and sends every
 * tool call, so the event is filtered here by `isPrCreationTool`: a shell
 * `gh pr create`, or a tool whose name reads as PR creation. On a match for a
 * planned session, tells the agent (via `additionalContext`, the only field
 * the model sees) to invoke ultrathink-sync so the PR URL/number/branch land
 * on the tracked Notion Task row and Linear issues. Never calls Notion or
 * Linear itself. On an error tool result it also runs the failure recall
 * (`runToolResultRecall`, SPE-34394) and adds any lessons it injects to the
 * same output. Silent and fail-open.
 */
import { resolve } from "node:path";
import { isChildInvocation } from "../src/claude/complete.ts";
import {
	isErrorToolResult,
	runToolResultRecall,
	type ToolResultRecall,
} from "../src/claude/hook.ts";
import { defaultStateDir, readSession, sessionRecordPath } from "../src/claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import { detectHost } from "../src/host/detect.ts";
import { isSubagentEnvelope, parseEnvelope, responseText } from "../src/host/envelope.ts";
import { installChildReaper } from "../src/resilience/child.ts";
import { extractPrFromOutput, isPrCreationTool } from "../src/track/pr-detect.ts";

interface HookInput {
	session_id?: string;
	cwd?: string;
	tool_name?: string;
	tool_input?: { command?: string; cmd?: string };
	tool_response?: unknown;
}

/** The PR-creation notice for a planned session's tool result, or undefined when the result is not one. */
function prNotice(
	input: HookInput,
	sessionId: string,
	stateDir: string,
): { systemMessage: string; additionalContext: string } | undefined {
	if (!isPrCreationTool(input.tool_name, input.tool_input?.command ?? input.tool_input?.cmd))
		return undefined;
	const record = readSession(stateDir, sessionId);
	if (!record?.plan) return undefined;

	const pr = extractPrFromOutput(responseText(input.tool_response));
	const prNote = pr ? ` (${pr.url})` : "";
	const stateFile = resolve(sessionRecordPath(stateDir, sessionId));
	const prArg = pr ? ` and prUrl=${pr.url}` : " and the PR URL";
	return {
		systemMessage: `Ultrathink · a pull request was opened for a tracked task${prNote}. Invoke the ultrathink-sync skill now (graphId=${record.plan.graphId}) to write the PR URL/number/branch back onto the Notion Task row and Linear issue.`,
		additionalContext: `Ultrathink: a pull request was opened for the tracked task${prNote}. Invoke the ultrathink-sync skill now with stateFile=${stateFile}${prArg}, so the tracked Notion Task row and Linear issues get the PR URL/number/branch and status. ultrathink-sync only updates existing rows; do not create new Notion rows or Linear issues.`,
	};
}

/**
 * The failure trigger (SPE-34394) for an error tool result: the lessons it injects, or undefined. Off under
 * ULTRATHINK_UPLIFT=0, the kill switch the prompt path honours. A successful result never reaches the planner.
 * Fail-open: a recall failure never costs the PR notice.
 */
async function recallFailure(
	input: HookInput,
	stateDir: string,
): Promise<ToolResultRecall | undefined> {
	if (process.env.ULTRATHINK_UPLIFT === "0") return undefined;
	if (!isErrorToolResult(input)) return undefined;
	const cwd = input.cwd?.trim() || process.cwd();
	try {
		return await runToolResultRecall(input, {
			config: loadConfig(claudeConfigPaths(cwd)),
			stateDir,
			surface: detectHost(),
		});
	} catch {
		// reason: fail-open: a recall failure never costs the PR notice or the tool call
		return undefined;
	}
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let raw: Record<string, unknown>;
	try {
		raw = parseEnvelope(await new Response(Bun.stdin.stream()).text());
	} catch {
		return;
	}
	// A subagent's PR is still caught when the parent turn stops.
	if (isSubagentEnvelope(raw)) return;
	const input = raw as HookInput;
	if (!input.session_id) return;

	const stateDir = defaultStateDir();
	const recalled = await recallFailure(input, stateDir);
	const pr = prNotice(input, input.session_id, stateDir);
	const additionalContext = [pr?.additionalContext, recalled?.additionalContext].filter(
		(text): text is string => Boolean(text),
	);
	if (!pr && additionalContext.length === 0) return;
	// One JSON object per event: the PR notice and any recalled lessons share it.
	await Bun.write(
		Bun.stdout,
		`${JSON.stringify({
			...(pr ? { systemMessage: pr.systemMessage } : {}),
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: additionalContext.join("\n\n"),
			},
		})}\n`,
	);
}

installChildReaper({ signals: true });
main()
	.catch(() => {
		// reason: fail-open: a PostToolUse hook never fails the tool call
	})
	.finally(() => {
		process.exit(0);
	});
