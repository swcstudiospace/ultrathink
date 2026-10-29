// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * LLM completion for the Muse host path.
 *
 * Calls headless `muse exec` so the plugin reuses whatever login the user already
 * has. Tools are neutered (`--disable-shell --disable-write --disable-web-tools`
 * `--max-model-steps 1`) so the child is a plain completion, and ULTRATHINK_CHILD
 * marks it so hooks do not recurse into themselves. `muse exec` has no
 * `--system-prompt` flag, so the system rides above the user payload in the
 * prompt file. `--provider echo` is the free local test path (it rejects
 * `--model`/`--reasoning-effort`, so the completer omits both there).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	abortError,
	CHILD_ENV,
	CHILD_OUTPUT_CAP_BYTES,
	truncatedReplyError,
	withCompletionReport,
} from "../claude/complete.ts";
import { redactSecrets } from "../redact.ts";
import { runChild, withTempDir } from "../resilience/child.ts";
import type { RetrySeams } from "../resilience/retry.ts";
import { dropJevKeys } from "../route-defaults.ts";
import { CHILD_PROMPT_SENTINEL } from "../uplift/skill.ts";
import type { MuseEffort } from "./types.ts";

type MuseProvider = "meta" | "echo";

export interface MuseCompleteOptions {
	bin?: string;
	/** Empty/whitespace omits `--model`: the CLI session default answers. */
	model?: string;
	reasoningEffort?: MuseEffort;
	/** Default "meta". "echo" is the free local test path (omits model/effort flags). */
	provider?: MuseProvider;
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
	/** Test seams for the retry backoff (sleep, random); production uses the kernel defaults. */
	retrySeams?: RetrySeams;
}

export type MuseCompleter = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export function buildMuseArgs(
	promptFile: string,
	opts: Pick<MuseCompleteOptions, "model" | "reasoningEffort" | "provider"> = {},
): string[] {
	const echo = opts.provider === "echo";
	const args = [
		"exec",
		"--json",
		"--disable-shell",
		"--disable-write",
		"--disable-web-tools",
		"--max-model-steps",
		"1",
	];
	if (echo) {
		args.push("--provider", "echo");
	} else {
		if (opts.model?.trim()) args.push("--model", opts.model.trim());
		args.push("--reasoning-effort", opts.reasoningEffort ?? "high");
	}
	args.push("--prompt-file", promptFile);
	return args;
}

export function buildMusePrompt(system: string, user: string): string {
	return `${CHILD_PROMPT_SENTINEL}\n<system>\n${system}\n</system>\n\n<user_request>\n${user}\n</user_request>`;
}

/** Extracts the assistant text from `muse exec --json` JSONL: the last `run.terminal.completed` line's text. */
export function parseMuseJsonl(stdout: string, stderr: string, code: number): string {
	let terminal: { terminal?: unknown; reason?: unknown; text?: unknown } | undefined;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.startsWith("{")) continue;
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			// reason: a line that is not JSON is skipped; a missing terminal event is reported after the loop
			continue;
		}
		if (!event || typeof event !== "object") continue;
		const rec = event as { payload_type?: unknown; payload?: unknown };
		if (rec.payload_type !== "run.terminal.completed") continue;
		if (!rec.payload || typeof rec.payload !== "object") continue;
		terminal = rec.payload as { terminal?: unknown; reason?: unknown; text?: unknown };
	}
	if (terminal?.terminal === "truncated" || terminal?.reason === "max_tokens") {
		throw truncatedReplyError("muse reply was truncated");
	}
	if (!terminal || terminal.terminal !== "completed") {
		const reason =
			typeof terminal?.reason === "string" && terminal.reason ? `: ${terminal.reason}` : "";
		const detail = stderr.trim() || `muse exited ${code}`;
		throw new Error(redactSecrets(`muse completion failed${reason} (${detail.slice(0, 300)})`));
	}
	if (typeof terminal.text !== "string" || !terminal.text) {
		throw truncatedReplyError("muse returned no text");
	}
	return terminal.text;
}

export async function museComplete(
	system: string,
	user: string,
	opts: MuseCompleteOptions = {},
): Promise<string> {
	if (opts.signal?.aborted) throw abortError();
	const bin = opts.bin?.trim() || "muse";
	const env: Record<string, string | undefined> = {
		...(opts.env ?? process.env),
		[CHILD_ENV]: "1",
	};
	dropJevKeys(env);
	return withCompletionReport(
		() =>
			withTempDir("ultrathink-muse-", async (dir) => {
				const promptFile = join(dir, "prompt.txt");
				try {
					writeFileSync(promptFile, buildMusePrompt(system, user), {
						encoding: "utf8",
						mode: 0o600,
					});
				} catch (error) {
					throw new Error(
						`muse prompt file failed (${error instanceof Error ? error.message : String(error)})`,
					);
				}
				const result = await runChild({
					cmd: [bin, ...buildMuseArgs(promptFile, opts)],
					cwd: opts.cwd,
					env,
					...(opts.timeoutMs && opts.timeoutMs > 0 ? { timeoutMs: opts.timeoutMs } : {}),
					signal: opts.signal,
					maxStdoutBytes: CHILD_OUTPUT_CAP_BYTES,
					maxStderrBytes: CHILD_OUTPUT_CAP_BYTES,
				});
				if (result.aborted || opts.signal?.aborted) throw abortError();
				if (result.timedOut) throw new Error(`muse timed out after ${opts.timeoutMs}ms`);
				return parseMuseJsonl(result.stdout, result.stderr, result.code ?? -1);
			}),
		opts.signal,
		opts.retrySeams,
	);
}

export function createMuseCompleter(opts: Omit<MuseCompleteOptions, "signal">): MuseCompleter {
	return (system, user, signal) => museComplete(system, user, { ...opts, signal });
}
