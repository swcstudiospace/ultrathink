#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * PostToolUse hook: score a gsd-autonomous skill or phase command through Jev, on the rail
 * `resolveDecisionsKeys` picks (OpenRouter or the Vercel AI Gateway). With no key, or with
 * ULTRATHINK_DECISIONS=0, it prints nothing and writes nothing. Otherwise it writes a sidecar record and
 * additionalContext reports the score or the error, naming the rail that decided.
 * It does not rewrite artifacts and does not clear a human pause.
 */
import { join } from "node:path";
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir } from "../src/claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import {
	appendFlowScore,
	evaluateFlowOutput,
	flowHash,
	isGsdFlowCommand,
	lookupFlowScore,
	type FlowEvalInput,
	type FlowRecord,
} from "../src/decisions/flow.ts";
import { decisionsKilled } from "../src/decisions/gate.ts";
import type { DecisionsConfig } from "../src/decisions/types.ts";
import { parseEnvelope, responseText } from "../src/host/envelope.ts";
import { storePath as defaultStorePath } from "../src/mcp/store.ts";

export interface HookInput {
	session_id?: string;
	tool_name?: string;
	tool_input?: { command?: string; cmd?: string; skill?: string; args?: string };
	tool_response?: unknown;
	cwd?: string;
}

function commandOf(input: HookInput): string {
	const skill = input.tool_input?.skill;
	if (skill) return `${skill} ${input.tool_input?.args ?? ""}`.trim();
	return input.tool_input?.command ?? input.tool_input?.cmd ?? "";
}

/** The additionalContext note for a record, or undefined when nothing decided (inactive): then there is nothing to say. */
export function formatFlowNote(record: FlowRecord): string | undefined {
	if (record.state === "inactive") return undefined;
	if (record.state === "success") {
		return `Jev · ${record.decision} · confidence ${record.confidence} · ${record.provider} · ${record.model}${record.requestId ? ` · ${record.requestId}` : ""}. This does not clear a human pause.`;
	}
	if (record.state === "empty") return "Jev · skipped · empty output. Not an approval.";
	return `Jev · error · ${record.errorClass ?? "unknown"} · retries ${record.retryCount}. Not an approval. Do not mark this output Jev-approved.`;
}

export interface FlowHookDeps {
	env: Record<string, string | undefined>;
	stateDir: string;
	storePath: string;
	/** The `decisions` config; read only once a GSD flow command is seen. */
	config: () => DecisionsConfig;
	evaluate: (input: FlowEvalInput) => Promise<FlowRecord>;
	lookup: (path: string, hash: string) => FlowRecord | undefined;
	append: (path: string, record: FlowRecord) => void;
	log: (line: string) => void;
}

/**
 * One hook run. Silent (no stdout line, no record appended) when the kill switch is set, the call is not a GSD flow
 * command, or the evaluation is inactive (no key on the picked rail).
 */
export async function evaluateFlowHook(input: HookInput, deps: FlowHookDeps): Promise<void> {
	if (decisionsKilled(deps.env)) return;
	const command = commandOf(input);
	if (!isGsdFlowCommand(input.tool_name, command)) return;
	const output = responseText(input.tool_response);
	const subject = `${input.session_id ?? "unknown"}:${command}`;
	const logPath = join(deps.stateDir, "flow-decisions.jsonl");
	const cached = deps.lookup(logPath, flowHash(output));
	const record =
		cached ??
		(await deps.evaluate({
			subject,
			output,
			command,
			config: deps.config(),
			env: deps.env,
			storePath: deps.storePath,
			stateDir: deps.stateDir,
		}));
	const note = formatFlowNote(record);
	if (note === undefined) return;
	if (!cached) deps.append(logPath, record);
	deps.log(JSON.stringify({ additionalContext: note }));
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	if (decisionsKilled(process.env)) return;
	let raw: Record<string, unknown>;
	try {
		raw = parseEnvelope(await new Response(Bun.stdin.stream()).text());
	} catch {
		return;
	}
	const input = raw as HookInput;
	await evaluateFlowHook(input, {
		env: process.env,
		stateDir: defaultStateDir(),
		storePath: defaultStorePath(process.env),
		config: () => loadConfig(claudeConfigPaths(input.cwd ?? process.cwd(), process.env)).decisions,
		evaluate: evaluateFlowOutput,
		lookup: lookupFlowScore,
		append: appendFlowScore,
		log: (line) => console.log(line),
	});
}

if (import.meta.main) main().catch(() => process.exit(0));
