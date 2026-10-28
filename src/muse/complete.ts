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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../grok/auth.ts";
import { abortError, CHILD_ENV } from "../claude/complete.ts";
import { JEV_KEY_ENV_NAMES } from "../route-defaults.ts";
import { CHILD_PROMPT_SENTINEL } from "../uplift/skill.ts";
import type { MuseEffort } from "./types.ts";

type MuseProvider = "meta" | "echo";

/** Minimal timer port: the platform `setTimeout`/`clearTimeout` by default, or a test double. */
type TimerPort = {
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
};

const platformTimers: TimerPort = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

export interface MuseCompleteOptions {
	bin?: string;
	/** Empty/whitespace omits `--model`: the CLI session default answers. */
	model?: string;
	reasoningEffort?: MuseEffort;
	/** Default "meta". "echo" is the free local test path (omits model/effort flags). */
	provider?: MuseProvider;
	cwd?: string;
	timeoutMs?: number;
	/** Timer port for the timeout kill timer; defaults to the platform timers. */
	timers?: TimerPort;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
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
	if (!terminal || terminal.terminal !== "completed") {
		const reason =
			typeof terminal?.reason === "string" && terminal.reason ? `: ${terminal.reason}` : "";
		const detail = stderr.trim() || `muse exited ${code}`;
		throw new Error(redactSecrets(`muse completion failed${reason} (${detail.slice(0, 300)})`));
	}
	if (typeof terminal.text !== "string" || !terminal.text) throw new Error("muse returned no text");
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
	for (const name of JEV_KEY_ENV_NAMES) delete env[name];
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-"));
	const promptFile = join(dir, "prompt.txt");
	try {
		writeFileSync(promptFile, buildMusePrompt(system, user), { encoding: "utf8", mode: 0o600 });
	} catch (error) {
		rmSync(dir, { recursive: true, force: true });
		throw new Error(
			`muse prompt file failed (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const proc = Bun.spawn([bin, ...buildMuseArgs(promptFile, opts)], {
		cwd: opts.cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	let aborted = false;
	const timers = opts.timers ?? platformTimers;
	const timer =
		opts.timeoutMs && opts.timeoutMs > 0
			? timers.setTimeout(() => {
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
		if (timedOut) throw new Error(`muse timed out after ${opts.timeoutMs}ms`);
		return parseMuseJsonl(stdout, stderr, code);
	} finally {
		if (timer) timers.clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		rmSync(dir, { recursive: true, force: true });
	}
}

export function createMuseCompleter(opts: Omit<MuseCompleteOptions, "signal">): MuseCompleter {
	return (system, user, signal) => museComplete(system, user, { ...opts, signal });
}
