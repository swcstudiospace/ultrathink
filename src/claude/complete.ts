// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * LLM completion for the Claude Code plugin path.
 *
 * Calls headless `claude -p` so the plugin reuses the plan login (claude.ai Max/Pro)
 * the user already has. By default the child env is scrubbed of the variables that
 * outrank that login (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, cloud-provider
 * switches), so inference is drawn from the plan; an API key is only used with
 * `auth: "api-key"`. Tools and settings sources are disabled so the child is a plain
 * completion, and ULTRATHINK_CHILD marks it so the UserPromptSubmit hook does not
 * recurse into itself.
 */

import { dropJevKeys } from "../route-defaults.ts";

export const CHILD_ENV = "ULTRATHINK_CHILD";

export const CLAUDE_AUTH_MODES = ["plan", "api-key"] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

/** Variables that outrank the plan login inside `claude -p` (Anthropic docs, "Authentication precedence"). */
export const PLAN_SCRUBBED_ENV: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
];

/** Copy of `env` without the variables that would override the plan login; the input is not mutated. */
export function planEnv(
	env: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const copy: Record<string, string | undefined> = { ...env };
	for (const name of PLAN_SCRUBBED_ENV) delete copy[name];
	return copy;
}

/** Usage facts read from a `claude -p --output-format json` result; every field is optional. */
export interface ClaudeCallInfo {
	model?: string;
	/** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. */
	inputTokens?: number;
	outputTokens?: number;
}

export interface ClaudeCompleteOptions {
	bin?: string;
	model?: string;
	/** Comma-separated `--setting-sources` value; empty string loads none. */
	settingSources?: string;
	cwd?: string;
	/** Allow extended thinking in the child; off by default because it dominates latency. */
	thinking?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
	/**
	 * `plan` (default) strips the credentials that outrank the plan login from the child env;
	 * `api-key` passes the env through unchanged.
	 */
	auth?: ClaudeAuthMode;
	/** Called once per call whose stdout was parseable JSON, including `is_error` results. */
	onResult?: (info: ClaudeCallInfo) => void;
	/** Output token cap for the reply (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`); floored, ignored unless a positive integer. */
	maxOutputTokens?: number;
}

export type ClaudeCompleter = (
	system: string,
	user: string,
	signal?: AbortSignal,
) => Promise<string>;

export function isChildInvocation(env: Record<string, string | undefined> = process.env): boolean {
	return env[CHILD_ENV] === "1";
}

export function buildClaudeArgs(
	system: string,
	opts: Pick<ClaudeCompleteOptions, "model" | "settingSources"> = {},
): string[] {
	const args = [
		"-p",
		"--tools",
		"",
		"--setting-sources",
		opts.settingSources ?? "",
		"--no-session-persistence",
		"--strict-mcp-config",
		"--exclude-dynamic-system-prompt-sections",
		"--output-format",
		"json",
		"--system-prompt",
		system,
	];
	if (opts.model?.trim()) args.push("--model", opts.model.trim());
	return args;
}

interface ClaudeResultRecord {
	result?: unknown;
	is_error?: unknown;
	subtype?: unknown;
	api_error_status?: unknown;
	usage?: unknown;
	modelUsage?: unknown;
}

/** Parses stdout into the result object; throws like the historical `parseClaudeJson`. */
function parseResultRecord(stdout: string): ClaudeResultRecord {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error("claude returned no output");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Some builds print log lines before the JSON; take the last JSON object.
		const start = trimmed.lastIndexOf("\n{");
		if (start === -1) throw new Error("claude output is not JSON");
		parsed = JSON.parse(trimmed.slice(start + 1));
	}
	if (!parsed || typeof parsed !== "object") throw new Error("claude output is not an object");
	return parsed as ClaudeResultRecord;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readInfo(rec: ClaudeResultRecord): ClaudeCallInfo {
	const info: ClaudeCallInfo = {};
	const usage = rec.usage;
	if (usage && typeof usage === "object") {
		const u = usage as Record<string, unknown>;
		const parts = [
			numberOrUndefined(u.input_tokens),
			numberOrUndefined(u.cache_read_input_tokens),
			numberOrUndefined(u.cache_creation_input_tokens),
		].filter((n): n is number => n !== undefined);
		if (parts.length > 0) info.inputTokens = parts.reduce((a, b) => a + b, 0);
		const output = numberOrUndefined(u.output_tokens);
		if (output !== undefined) info.outputTokens = output;
	}
	const modelUsage = rec.modelUsage;
	if (modelUsage && typeof modelUsage === "object") {
		const model = Object.keys(modelUsage)[0];
		if (model) info.model = model;
	}
	return info;
}

/** Extracts the assistant text and usage facts from `claude -p --output-format json` stdout. */
export function parseClaudeResult(stdout: string): { text: string; info: ClaudeCallInfo } {
	const rec = parseResultRecord(stdout);
	const result = typeof rec.result === "string" ? rec.result : "";
	if (rec.is_error === true)
		throw new ClaudeResultError(
			result || `claude error (${String(rec.subtype ?? "unknown")})`,
			typeof rec.api_error_status === "number" ? rec.api_error_status : undefined,
		);
	return { text: result, info: readInfo(rec) };
}

/** Extracts the assistant text from `claude -p --output-format json` stdout. */
export function parseClaudeJson(stdout: string): string {
	return parseClaudeResult(stdout).text;
}

/** Best-effort usage read; never throws and returns undefined when stdout is not parseable JSON. */
function readInfoQuietly(stdout: string): ClaudeCallInfo | undefined {
	try {
		return readInfo(parseResultRecord(stdout));
	} catch {
		// reason: unparseable output is reported by the strict parse that follows
		return undefined;
	}
}

export function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

/** The CLI reported `is_error: true`; keeps the HTTP-style status the CLI attached, when any. */
export class ClaudeResultError extends Error {
	readonly apiErrorStatus: number | undefined;
	constructor(message: string, apiErrorStatus?: number) {
		super(message);
		this.name = "ClaudeResultError";
		this.apiErrorStatus = apiErrorStatus;
	}
}

async function claudeComplete(
	system: string,
	user: string,
	opts: ClaudeCompleteOptions = {},
): Promise<string> {
	if (opts.signal?.aborted) throw abortError();
	const env: Record<string, string | undefined> = {
		...(opts.env ?? process.env),
		[CHILD_ENV]: "1",
	};
	if (!opts.thinking) env.MAX_THINKING_TOKENS = "0";
	const childEnv = opts.auth === "api-key" ? env : planEnv(env);
	dropJevKeys(childEnv);
	const cap = opts.maxOutputTokens === undefined ? 0 : Math.floor(opts.maxOutputTokens);
	if (Number.isFinite(cap) && cap > 0) childEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(cap);
	return claudeAttempt(system, user, opts, childEnv);
}

async function claudeAttempt(
	system: string,
	user: string,
	opts: ClaudeCompleteOptions,
	env: Record<string, string | undefined>,
): Promise<string> {
	const bin = opts.bin?.trim() || "claude";
	const proc = Bun.spawn([bin, ...buildClaudeArgs(system, opts)], {
		cwd: opts.cwd,
		env,
		stdin: Buffer.from(user, "utf8"),
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	let aborted = false;
	const timer =
		opts.timeoutMs && opts.timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					proc.kill();
				}, opts.timeoutMs)
			: undefined;
	const onAbort = (): void => {
		aborted = true;
		proc.kill();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (aborted) throw abortError();
		if (timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
		if (code !== 0 && !stdout.trim()) throw new Error(stderr.trim() || `claude exited ${code}`);
		if (opts.onResult) {
			const info = readInfoQuietly(stdout);
			if (info) {
				try {
					opts.onResult(info);
				} catch {
					// reason: a reporting hook must never change the completion outcome
				}
			}
		}
		return parseClaudeResult(stdout).text;
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

export function createClaudeCompleter(
	opts: Omit<ClaudeCompleteOptions, "signal">,
): ClaudeCompleter {
	return (system, user, signal) => claudeComplete(system, user, { ...opts, signal });
}
