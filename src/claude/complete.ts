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

import { redactSecrets } from "../redact.ts";
import { runChild } from "../resilience/child.ts";
import {
	isTransientFailure,
	RetryExhaustedError,
	type RetrySeams,
	unwrapRetryError,
	withRetry,
} from "../resilience/retry.ts";
import { dropJevKeys } from "../route-defaults.ts";
import { isAbortError } from "../shared.ts";
import { attachReport, readReport } from "../types.ts";

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
	/** Test seams for the retry backoff (sleep, random); production uses the kernel defaults. */
	retrySeams?: RetrySeams;
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
	stop_reason?: unknown;
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
	return withCompletionReport(
		() => claudeAttempt(system, user, opts, childEnv),
		opts.signal,
		opts.retrySeams,
	);
}

/** Output cap for a CLI child's stdout and stderr, the same 4 MB as `net/body`. */
export const CHILD_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

const TRUNCATED_REPLY = "truncated_reply";
const RETRY_POLICY = { maxAttempts: 3, baseMs: 1000, capMs: 8000 } as const;
const TIMEOUT_TEXT = /timed out after \d+ms/;

/** A reply the model cut short or left empty: a failed attempt whose report cause is `truncated_reply`. */
export function truncatedReplyError(message: string): Error {
	const error = new Error(message);
	attachReport(error, { attempts: 1, cause: TRUNCATED_REPLY });
	return error;
}

function classify(error: unknown, now?: number): ReturnType<typeof isTransientFailure> {
	if (isAbortError(error)) return { transient: false, reason: "aborted" };
	const message = error instanceof Error ? error.message : "";
	if (TIMEOUT_TEXT.test(message)) return { transient: false, reason: "timed out" };
	if (readReport(error)?.cause === TRUNCATED_REPLY) {
		return { transient: true, reason: TRUNCATED_REPLY };
	}
	if (error instanceof ClaudeResultError && error.apiErrorStatus !== undefined) {
		return isTransientFailure({ status: error.apiErrorStatus, message }, now);
	}
	return isTransientFailure(error, now);
}

function oneLine(text: string): string {
	return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Runs one completion attempt through the kernel retry (3 attempts, same model). A failure leaves with a
 * `CompletionReport` attached to the ORIGINAL error (never the retry wrapper); an abort leaves bare.
 */
export async function withCompletionReport<T>(
	attempt: () => Promise<T>,
	signal: AbortSignal | undefined,
	seams: RetrySeams | undefined,
): Promise<T> {
	try {
		return (await withRetry(attempt, RETRY_POLICY, { ...seams, signal, classify })).value;
	} catch (error) {
		const root = unwrapRetryError(error);
		if (isAbortError(root)) throw root;
		const attempts = error instanceof RetryExhaustedError ? error.attempts : 1;
		const message = root instanceof Error ? root.message : String(root);
		const truncated = readReport(root)?.cause === TRUNCATED_REPLY;
		const retryAfterMs = isTransientFailure(root).retryAfterMs;
		attachReport(root, {
			attempts,
			...(root instanceof ClaudeResultError && root.apiErrorStatus !== undefined
				? { httpStatus: root.apiErrorStatus }
				: {}),
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
			cause: truncated ? TRUNCATED_REPLY : oneLine(message),
		});
		throw root;
	}
}

async function claudeAttempt(
	system: string,
	user: string,
	opts: ClaudeCompleteOptions,
	env: Record<string, string | undefined>,
): Promise<string> {
	const bin = opts.bin?.trim() || "claude";
	const result = await runChild({
		cmd: [bin, ...buildClaudeArgs(system, opts)],
		cwd: opts.cwd,
		env,
		stdin: user,
		...(opts.timeoutMs && opts.timeoutMs > 0 ? { timeoutMs: opts.timeoutMs } : {}),
		signal: opts.signal,
		maxStdoutBytes: CHILD_OUTPUT_CAP_BYTES,
		maxStderrBytes: CHILD_OUTPUT_CAP_BYTES,
	});
	const { stdout, stderr, code } = result;
	if (result.aborted || opts.signal?.aborted) throw abortError();
	if (result.timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
	if (code !== 0 && !stdout.trim()) {
		throw new Error(redactSecrets(stderr.trim()) || `claude exited ${code}`);
	}
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
	const text = parseClaudeResult(stdout).text;
	if (parseResultRecord(stdout).stop_reason === "max_tokens") {
		throw truncatedReplyError("claude reply was truncated (max_tokens)");
	}
	if (!text) throw truncatedReplyError("claude returned no text");
	return text;
}

export function createClaudeCompleter(
	opts: Omit<ClaudeCompleteOptions, "signal">,
): ClaudeCompleter {
	return (system, user, signal) => claudeComplete(system, user, { ...opts, signal });
}
