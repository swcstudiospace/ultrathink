// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Grok completion for the Ultrathink pre-pass (default model `grok-build-0.1`;
 * reasoning effort is sent only for models that support it).
 *
 * Default transport talks directly to the Grok CLI chat proxy (`/responses`)
 * with the user's existing `grok login` session; the `cli` transport shells
 * out to the Grok Build CLI instead so the same login is reused either way.
 * The `shunt` transport posts Anthropic Messages to a shunt gateway you run
 * (`grok.shuntBaseUrl` + `/v1/messages`) that owns its own upstream auth.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EnsureFreshOptions,
	ensureFreshGrokAuth,
	type GrokAuth,
	GrokAuthError,
	GrokHttpError,
	grokClientVersion,
	grokHeaders,
	isGrokAuthExpired,
} from "./auth.ts";
import {
	DEFAULT_GROK_CONFIG,
	type GrokEffort,
	type GrokTransport,
	grokWireEffort,
} from "./types.ts";
import { abortError } from "../claude/complete.ts";
import { redactSecrets } from "../redact.ts";
import { childFailure, runChild, withTempDir } from "../resilience/child.ts";
import {
	type FailureVerdict,
	isTransientFailure,
	parseRetryAfter,
	RetryExhaustedError,
	unwrapRetryError,
	withRetry,
} from "../resilience/retry.ts";
import type { abortableSleep } from "../resilience/sleep.ts";
import { dropJevKeys } from "../route-defaults.ts";
import { isAbortError } from "../shared.ts";
import { attachReport, readReport } from "../types.ts";

export type Completer = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export interface GrokCallInfo {
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
}
export interface GrokCompleteOptions {
	baseUrl?: string;
	model?: string;
	reasoningEffort?: GrokEffort;
	timeoutMs?: number;
	home?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	transport?: GrokTransport;
	bin?: string;
	/** Unused: the CLI transport always runs in a scratch directory (see `scratchDir`) so headless sessions do not litter the project's `~/.grok/sessions`. */
	cwd?: string;
	/** Test seam for the CLI-driven token refresh; default `ensureFreshGrokAuth`. */
	refresh?: (opts: EnsureFreshOptions) => Promise<GrokAuth | undefined>;
	/** `shunt` transport: base URL of a shunt gateway you run (`/v1/messages` is appended). Required: there is no built-in default. */
	shuntBaseUrl?: string;
	/** `shunt` transport: wire model; overrides `model` because the gateway route pins the effort. Empty = `model`. */
	shuntModel?: string;
	/** `shunt` transport: Anthropic `max_tokens`. */
	shuntMaxTokens?: number;
	/** `http` transport: receives model and token usage from the reply when present. Never throws into the call. */
	onResult?: (info: GrokCallInfo) => void;
	/** `http` transport: `max_output_tokens` (visible output only; positive integer, floored). The CLI transport ignores it. */
	maxOutputTokens?: number;
	/** Child environment for the token refresh and the CLI transport; default is the whole `process.env`. Pass an allowlist when the host holds unrelated secrets. */
	env?: Record<string, string | undefined>;
	/** Budget for the CLI-driven token refresh; default 60 s. */
	refreshTimeoutMs?: number;
	/** Test seam: the wait between retry attempts. */
	retrySleep?: typeof abortableSleep;
	/** Test seam: jitter source for the retry backoff. */
	retryRandom?: () => number;
}

const SHUNT_ANTHROPIC_VERSION = "2023-06-01";

const LOGIN_HINT = "run `grok login`";

export function buildResponsesBody(
	system: string,
	user: string,
	model: string,
	effort?: GrokEffort,
	maxOutputTokens?: number,
): Record<string, unknown> {
	const body: Record<string, unknown> = { model, instructions: system, input: user };
	if (effort) body.reasoning = { effort };
	if (
		typeof maxOutputTokens === "number" &&
		Number.isFinite(maxOutputTokens) &&
		maxOutputTokens >= 1
	)
		body.max_output_tokens = Math.floor(maxOutputTokens);
	body.stream = false;
	return body;
}

/** Shape of a `/responses` reply; each field is still checked at use because it is upstream JSON. */
interface ResponsesReply {
	output?: unknown;
	output_text?: unknown;
}

interface ResponsesOutputItem {
	type?: unknown;
	content?: unknown;
}

interface ResponsesContentBlock {
	type?: unknown;
	text?: unknown;
}

/** Extracts assistant text from a `/responses` reply. */
export function parseResponsesText(json: unknown): string {
	const reply: ResponsesReply = json && typeof json === "object" ? json : {};
	const parts: string[] = [];
	if (Array.isArray(reply.output)) {
		for (const entry of reply.output) {
			if (!entry || typeof entry !== "object") continue;
			const item: ResponsesOutputItem = entry;
			if (item.type !== "message" || !Array.isArray(item.content)) continue;
			for (const raw of item.content) {
				if (!raw || typeof raw !== "object") continue;
				const block: ResponsesContentBlock = raw;
				if (block.type === "output_text" && typeof block.text === "string" && block.text)
					parts.push(block.text);
			}
		}
	}
	if (parts.length === 0 && typeof reply.output_text === "string" && reply.output_text)
		parts.push(reply.output_text);
	const text = parts.join("\n");
	if (!text.trim()) throw new Error("grok returned no text");
	return text;
}

/** Tolerant usage reader for a `/responses` reply; fields are reported only when numeric. */
function readResponsesUsage(json: unknown, requestedModel: string): GrokCallInfo | undefined {
	if (!json || typeof json !== "object") return undefined;
	const reply = json as { usage?: unknown; model?: unknown };
	const usage = reply.usage && typeof reply.usage === "object" ? reply.usage : undefined;
	if (!usage) return undefined;
	const { input_tokens: input, output_tokens: output } = usage as {
		input_tokens?: unknown;
		output_tokens?: unknown;
	};
	const inputTokens = typeof input === "number" ? input : undefined;
	const outputTokens = typeof output === "number" ? output : undefined;
	if (inputTokens === undefined && outputTokens === undefined) return undefined;
	const info: GrokCallInfo = {
		model: typeof reply.model === "string" ? reply.model : requestedModel,
	};
	if (inputTokens !== undefined) info.inputTokens = inputTokens;
	if (outputTokens !== undefined) info.outputTokens = outputTokens;
	return info;
}

function reportUsage(opts: GrokCompleteOptions, json: unknown, model: string): void {
	if (!opts.onResult) return;
	try {
		const info = readResponsesUsage(json, model);
		if (info) opts.onResult(info);
	} catch {
		// reason: usage reporting is best-effort and must never fail a completed call
	}
}

/** Anthropic Messages body for the shunt gateway. No `thinking` param: the route pins the effort. */
export function buildShuntBody(
	system: string,
	user: string,
	model: string,
	maxTokens: number,
): Record<string, unknown> {
	return { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
}

/** Shape of an Anthropic `/v1/messages` reply; each field is still checked at use because it is upstream JSON. */
interface ShuntReply {
	type?: unknown;
	content?: unknown;
	error?: unknown;
}

/** Extracts assistant text from an Anthropic Messages reply, skipping `thinking`/`redacted_thinking` blocks. */
export function parseShuntText(json: unknown): string {
	const reply: ShuntReply = json && typeof json === "object" ? json : {};
	if (reply.type === "error") {
		const err =
			reply.error && typeof reply.error === "object"
				? (reply.error as { type?: unknown; message?: unknown })
				: {};
		const message =
			typeof err.message === "string" ? err.message : JSON.stringify(reply.error ?? null);
		const kind = typeof err.type === "string" ? err.type : "error";
		throw new GrokHttpError(
			`shunt ${kind}: ${redactSecrets(message).slice(0, 500)}`,
			0,
			redactSecrets(message).slice(0, 500),
		);
	}
	const parts: string[] = [];
	if (Array.isArray(reply.content)) {
		for (const raw of reply.content) {
			if (!raw || typeof raw !== "object") continue;
			const block: ResponsesContentBlock = raw;
			if (block.type === "text" && typeof block.text === "string" && block.text)
				parts.push(block.text);
		}
	}
	const text = parts.join("\n");
	if (!text.trim()) throw new Error("grok returned no text");
	return text;
}

const RETRY_POLICY = { maxAttempts: 3, baseMs: 1000, capMs: 8000 };

/** Report cause (and interim marker) for a reply the provider cut short. */
const TRUNCATED_REPLY = "truncated_reply";

/** Replies the provider says it stopped for length. */
const LENGTH_STOPS: readonly unknown[] = ["length", "max_tokens"];

/** Failures a second attempt cannot fix: our own timeout, and an output over the cap. */
const FINAL_TEXT = /^grok (?:timed out after|output exceeded)/;

/** An error for a cut-short reply; the interim report marks it transient for the retry classifier. */
function truncatedReply(message: string): Error {
	const error = new Error(message);
	attachReport(error, { attempts: 1, cause: TRUNCATED_REPLY });
	return error;
}

function classifyAttempt(error: unknown, now?: number): FailureVerdict {
	if (isGrokAuthError(error)) return { transient: false, reason: "grok login failure" };
	const fields =
		typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
	if (fields.code === "ENOENT" || fields.code === "EACCES")
		return { transient: false, reason: "grok CLI cannot be spawned" };
	if (error instanceof Error && FINAL_TEXT.test(error.message))
		return { transient: false, reason: "grok call timed out or overflowed" };
	if (readReport(error)?.cause === TRUNCATED_REPLY)
		return { transient: true, reason: "truncated reply" };
	return isTransientFailure(error, now);
}

function oneLine(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Runs one transport attempt through the retry kernel: same model, `Retry-After` honoured, abort ends the backoff.
 * The root error is rethrown (never the kernel wrapper) with the final report attached.
 */
async function withGrokRetry<T>(attempt: () => Promise<T>, opts: GrokCompleteOptions): Promise<T> {
	try {
		const { value } = await withRetry(attempt, RETRY_POLICY, {
			signal: opts.signal,
			sleep: opts.retrySleep,
			random: opts.retryRandom,
			classify: classifyAttempt,
		});
		return value;
	} catch (error) {
		const root = unwrapRetryError(error);
		if (isAbortError(root)) throw root;
		const attempts = error instanceof RetryExhaustedError ? error.attempts : 1;
		const fields =
			typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {};
		const interim = readReport(root);
		attachReport(root, {
			attempts,
			...(typeof fields.status === "number" && fields.status > 0
				? { httpStatus: fields.status }
				: {}),
			...(typeof fields.retryAfterMs === "number" ? { retryAfterMs: fields.retryAfterMs } : {}),
			cause: interim?.cause === TRUNCATED_REPLY ? TRUNCATED_REPLY : oneLine(root),
		});
		throw root;
	}
}

/** A non-2xx reply as a `GrokHttpError` carrying the server's `Retry-After`. */
function httpError(prefix: string, res: Response, body: string): GrokHttpError {
	const retryAfterMs = parseRetryAfter(res.headers?.get("retry-after"));
	return new GrokHttpError(
		`${prefix} ${res.status}${body ? `: ${body}` : ""}`,
		res.status,
		body,
		retryAfterMs,
	);
}

function isTruncatedJson(json: unknown, field: "status" | "stop_reason"): boolean {
	if (!json || typeof json !== "object") return false;
	const value = (json as Record<string, unknown>)[field];
	return field === "status" ? value === "incomplete" : LENGTH_STOPS.includes(value);
}

/** Shared per-call timeout + caller-abort wiring for the fetch-based transports. */
interface CallGuard {
	signal: AbortSignal;
	/** Maps a fetch rejection to the abort/timeout error the caller expects, else passes it through. */
	wrap: (error: unknown) => unknown;
	release: () => void;
}

function callGuard(opts: GrokCompleteOptions): CallGuard {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GROK_CONFIG.callTimeoutMs;
	const controller = new AbortController();
	let timedOut = false;
	const timer =
		timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, timeoutMs)
			: undefined;
	const onAbort = (): void => controller.abort();
	if (opts.signal?.aborted) controller.abort();
	else opts.signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		wrap: (error: unknown): unknown => {
			if (opts.signal?.aborted) return abortError();
			if (timedOut) return new Error(`grok timed out after ${timeoutMs}ms`);
			return error;
		},
		release: () => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		},
	};
}

const SHUNT_URL_MISSING =
	'grok shunt transport: set grok.shuntBaseUrl (the base URL of your Anthropic-compatible gateway) in ~/.config/ultrathink/config.json, or switch grok.transport to "http"';

async function completeShunt(
	system: string,
	user: string,
	opts: GrokCompleteOptions,
	fallbackModel: string,
): Promise<string> {
	const baseUrl = (opts.shuntBaseUrl?.trim() ?? "").replace(/\/+$/, "");
	if (!baseUrl) throw new Error(SHUNT_URL_MISSING);
	const model = opts.shuntModel?.trim() || fallbackModel;
	const maxTokens =
		typeof opts.shuntMaxTokens === "number" &&
		Number.isInteger(opts.shuntMaxTokens) &&
		opts.shuntMaxTokens > 0
			? opts.shuntMaxTokens
			: DEFAULT_GROK_CONFIG.shuntMaxTokens;
	return withGrokRetry(() => shuntAttempt(system, user, opts, baseUrl, model, maxTokens), opts);
}

async function shuntAttempt(
	system: string,
	user: string,
	opts: GrokCompleteOptions,
	baseUrl: string,
	model: string,
	maxTokens: number,
): Promise<string> {
	const guard = callGuard(opts);
	try {
		let res: Response;
		try {
			res = await (opts.fetch ?? fetch)(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"anthropic-version": SHUNT_ANTHROPIC_VERSION,
					accept: "application/json",
				},
				body: JSON.stringify(buildShuntBody(system, user, model, maxTokens)),
				signal: guard.signal,
			});
		} catch (error) {
			throw guard.wrap(error);
		}
		if (!res.ok) {
			throw httpError("shunt HTTP", res, await errorBody(res, guard));
		}
		const reply: unknown = await res.json();
		if (isTruncatedJson(reply, "stop_reason"))
			throw truncatedReply("grok shunt reply was cut short (max_tokens)");
		return parseShuntText(reply);
	} finally {
		guard.release();
	}
}

/**
 * Reads an error body for the message. A timeout or caller abort while reading is the call's own
 * failure and must not be mistaken for a bad login or an HTTP error; any other read failure leaves
 * the body empty.
 */
async function errorBody(res: Response, guard: CallGuard): Promise<string> {
	try {
		return redactSecrets(await res.text()).slice(0, 500);
	} catch (error) {
		const mapped = guard.wrap(error);
		if (mapped !== error) throw mapped;
		return "";
	}
}

const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;

const MODEL_REFUSAL =
	/requires a grok subscription|unknown model|not available|model.*(?:not found|unsupported)/i;

function completeHttp(
	system: string,
	user: string,
	opts: GrokCompleteOptions,
	model: string,
	effort: GrokEffort | undefined,
): Promise<string> {
	return withGrokRetry(() => httpAttempt(system, user, opts, model, effort), opts);
}

async function httpAttempt(
	system: string,
	user: string,
	opts: GrokCompleteOptions,
	model: string,
	effort: GrokEffort | undefined,
): Promise<string> {
	const refresh = opts.refresh ?? ensureFreshGrokAuth;
	const refreshOpts: EnsureFreshOptions = {
		home: opts.home,
		bin: opts.bin,
		timeoutMs: opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS,
		env: opts.env,
		signal: opts.signal,
	};
	const auth = await refresh(refreshOpts);
	if (opts.signal?.aborted) throw abortError();
	if (!auth) throw new GrokAuthError(`Grok login missing: ${LOGIN_HINT}`);
	if (isGrokAuthExpired(auth)) {
		if (auth.refreshTimedOut)
			throw new Error(
				`grok refresh timed out after ${refreshOpts.timeoutMs}ms and the token is still expired: retry, or ${LOGIN_HINT}`,
			);
		throw new GrokAuthError(`Grok login expired: ${LOGIN_HINT}`);
	}

	const baseUrl = (opts.baseUrl?.trim() || DEFAULT_GROK_CONFIG.baseUrl).replace(/\/+$/, "");
	const guard = callGuard(opts);
	const version = grokClientVersion(opts.home);
	const body = JSON.stringify(
		buildResponsesBody(system, user, model, effort, opts.maxOutputTokens),
	);

	async function send(session: GrokAuth): Promise<Response> {
		try {
			return await (opts.fetch ?? fetch)(`${baseUrl}/responses`, {
				method: "POST",
				headers: {
					...grokHeaders(session, model, version),
					"content-type": "application/json",
					accept: "application/json",
				},
				body,
				signal: guard.signal,
			});
		} catch (error) {
			throw guard.wrap(error);
		}
	}

	try {
		let res = await send(auth);
		if (res.status === 401 || res.status === 403) {
			// The stored token may have been revoked before its expiry; let the CLI refresh it once.
			const refreshed = await refresh({ ...refreshOpts, force: true });
			if (opts.signal?.aborted) throw abortError();
			if (refreshed && refreshed.token !== auth.token && !isGrokAuthExpired(refreshed)) {
				await res.body?.cancel();
				res = await send(refreshed);
			}
		}
		if (res.status === 401 || res.status === 403) {
			const rejected = await errorBody(res, guard);
			// A 403 that names the model or subscription is a per-model refusal, not a bad login.
			if (MODEL_REFUSAL.test(rejected)) {
				throw httpError("grok HTTP", res, rejected);
			}
			throw new GrokAuthError(`Grok login rejected (HTTP ${res.status}): ${LOGIN_HINT}`);
		}
		if (!res.ok) throw httpError("grok HTTP", res, await errorBody(res, guard));
		const reply: unknown = await res.json();
		if (isTruncatedJson(reply, "status"))
			throw truncatedReply("grok reply was cut short (status incomplete)");
		reportUsage(opts, reply, model);
		return parseResponsesText(reply);
	} finally {
		guard.release();
	}
}

/** Tools the Grok CLI still registers under `--tools none`; disallowed by name so a headless call cannot start a tool loop. */
const CLI_DISALLOWED_TOOLS =
	"run_terminal_cmd,search_replace,write_file,read_file,list_dir,grep,web_search,web_fetch,todo_write,task,Agent";

let scratch: string | undefined;

/** Private working directory for headless CLI calls: created once per process with `mkdtemp`, removed on exit. */
function scratchDir(): string {
	if (!scratch) {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-grok-"));
		scratch = dir;
		process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	}
	return scratch;
}

/** Extracts `.text` from `grok --output-format json` stdout; a non-`end_turn` stop (e.g. `cancelled`) is an error, not partial text. */
function parseCliJson(stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error("grok returned no output");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const start = trimmed.lastIndexOf("\n{");
		if (start === -1) throw new Error("grok output is not JSON");
		parsed = JSON.parse(trimmed.slice(start + 1));
	}
	if (!parsed || typeof parsed !== "object") throw new Error("grok output is not an object");
	const fields = parsed as Record<string, unknown>;
	if (LENGTH_STOPS.includes(fields.stopReason) || LENGTH_STOPS.includes(fields.finish_reason))
		throw truncatedReply(`grok cli stopped: ${String(fields.stopReason ?? fields.finish_reason)}`);
	if (fields.stopReason !== undefined && fields.stopReason !== "end_turn") {
		throw new Error(`grok cli stopped: ${String(fields.stopReason)}`);
	}
	if (!("text" in fields)) throw new Error("grok output is not an object");
	const text = fields.text;
	if (typeof text !== "string" || !text.trim()) throw new Error("grok returned no text");
	return text;
}

/** An auth phrase in stderr; a bare `login` or a number such as 14012 is not one. */
const LOGIN_FAILURE =
	/\bgrok\s+login\b|\blogin\s+(?:required|rejected|expired)|\bauthentication\s+(?:required|failed)|unauthori[sz]ed/i;

/** Output cap for the CLI's stdout and stderr. */
const CLI_MAX_BYTES = 4 * 1024 * 1024;

function completeCli(
	system: string,
	user: string,
	opts: GrokCompleteOptions,
	model: string,
	effort: GrokEffort | undefined,
): Promise<string> {
	return withGrokRetry(() => cliAttempt(system, user, opts, model, effort), opts);
}

function cliAttempt(
	system: string,
	user: string,
	opts: GrokCompleteOptions,
	model: string,
	effort: GrokEffort | undefined,
): Promise<string> {
	return withTempDir("ultrathink-grok-", async (dir) => {
		const promptPath = join(dir, "prompt.md");
		writeFileSync(promptPath, user, "utf8");
		const env: Record<string, string | undefined> = {
			...(opts.env ?? process.env),
			GROK_SUBAGENTS: "0",
			GROK_MEMORY: "0",
			GROK_WEB_FETCH: "0",
		};
		if (opts.home?.trim()) env.GROK_HOME = opts.home.trim();
		dropJevKeys(env);
		const timeoutMs = opts.timeoutMs ?? DEFAULT_GROK_CONFIG.callTimeoutMs;
		const result = await runChild({
			cmd: [
				opts.bin?.trim() || DEFAULT_GROK_CONFIG.bin,
				"-m",
				model,
				...(effort ? ["--reasoning-effort", effort] : []),
				"--output-format",
				"json",
				"--tools",
				"none",
				"--disallowed-tools",
				CLI_DISALLOWED_TOOLS,
				"--no-plan",
				"--no-subagents",
				"--disable-web-search",
				"--max-turns",
				"1",
				"--permission-mode",
				"plan",
				"--deny",
				"Bash",
				"--deny",
				"Edit",
				"--deny",
				"Write",
				"--verbatim",
				"--system-prompt-override",
				system,
				"--prompt-file",
				promptPath,
			],
			cwd: scratchDir(),
			env,
			timeoutMs,
			signal: opts.signal,
			maxStdoutBytes: CLI_MAX_BYTES,
			maxStderrBytes: CLI_MAX_BYTES,
		});
		if (result.aborted) throw abortError();
		if (result.timedOut) throw new Error(`grok timed out after ${timeoutMs}ms`);
		if (result.stdoutTruncated) throw new Error("grok output exceeded the 4 MB cap");
		if (result.code !== 0 && !result.stdout.trim()) {
			const failure = childFailure("grok", result, redactSecrets(result.stderr.trim()));
			if (LOGIN_FAILURE.test(failure.message))
				throw new GrokAuthError(`Grok login rejected: ${LOGIN_HINT}`);
			throw failure;
		}
		return parseCliJson(result.stdout);
	});
}

export async function grokComplete(
	system: string,
	user: string,
	opts: GrokCompleteOptions = {},
): Promise<string> {
	if (opts.signal?.aborted) throw abortError();
	const model = opts.model?.trim() || DEFAULT_GROK_CONFIG.model;
	const effort = grokWireEffort(model, opts.reasoningEffort ?? DEFAULT_GROK_CONFIG.reasoningEffort);
	switch (opts.transport) {
		case "shunt":
			return completeShunt(system, user, opts, model);
		case "cli":
			return completeCli(system, user, opts, model, effort);
		default:
			return completeHttp(system, user, opts, model, effort);
	}
}

export function createGrokCompleter(opts: Omit<GrokCompleteOptions, "signal">): Completer {
	return (system, user, signal) => grokComplete(system, user, { ...opts, signal });
}

export function isGrokAuthError(error: unknown): boolean {
	if (error instanceof GrokAuthError) return true;
	return (
		typeof error === "object" && error !== null && "name" in error && error.name === "GrokAuthError"
	);
}
