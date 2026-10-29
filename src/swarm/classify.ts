// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Swarm preflight — ask AgentSwarm's own classifier whether it would accept a lane brief before spawning.
 *
 * `hooks/autonomous_run.py` imports `swarm.signal_detector.classify` and silently drops any brief that does
 * not classify as `"sdlc"` (it still exits 0). This module runs the same classification, on the exact text
 * the lane will send, through `python3 -c` with the Swarm checkout as the working directory (the cwd is the
 * `swarm.*` import context, mirroring the sys.path insertion `autonomous_run.py` performs). The child runs
 * with the parent environment minus the Jev key variables (`dropJevKeys`), because it executes code from the
 * Swarm checkout. Only the exit code is read (0 accepts, 2 skips, anything else means the classifier could not
 * answer), plus a check of stderr for an import error; no output text is ever kept in a verdict. Leaf module:
 * it imports nothing from `teams.ts`.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { dropJevKeys } from "../route-defaults.ts";

/** The preflight verdict: Swarm would run it, Swarm would drop it, or the classifier could not answer. */
export type ClassifyVerdict =
	| { kind: "sdlc" }
	| { kind: "skip" }
	| { kind: "unknown"; reason: string };

/** What one classifier process reported. Exactly the fields the verdict needs; output is never echoed. */
export interface ClassifyRun {
	/** The process exit code, when it exited normally. */
	exitCode?: number | null;
	/** The spawn error code (for example `ENOENT` when python3 is not installed). */
	errorCode?: string;
	/** True when the hard timeout killed the process. */
	timedOut?: boolean;
	/** The captured stderr, when the seam has it; read only for ModuleNotFoundError or ImportError, never echoed. */
	stderr?: string;
}

/** Process seam; the default is an async `node:child_process.execFile`. Injectable so unit tests run no python. */
export type ClassifySpawn = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; timeout: number; env: Record<string, string | undefined> },
) => Promise<ClassifyRun>;

/** D-01 hard cap on how long the classifier may run before the verdict is `unknown`. */
export const CLASSIFY_TIMEOUT_MS = 5_000;

/** The exit code that means "Swarm would skip this text". */
const SKIP_EXIT_CODE = 2;

/** A Python import failure on stderr: the one signal that makes an exit code mean "could not import the detector". */
const IMPORT_ERROR_RE = /\b(?:ModuleNotFoundError|ImportError)\b/;

/** The program: accept (exit 0) only on the exact `"sdlc"` label, otherwise exit 2. An import error exits 1. */
const CLASSIFY_PROGRAM =
	'import sys; from swarm.signal_detector import classify; sys.exit(0 if classify(sys.argv[1]) == "sdlc" else 2)';

/**
 * The argv for `python3`: `-c <program> <text>`. The text rides as the last element, so Python sees it as
 * `sys.argv[1]` verbatim. Exported so tests pin the import path and comparison without running python.
 */
export function buildClassifyArgv(text: string): string[] {
	return ["-c", CLASSIFY_PROGRAM, text];
}

/** Default runner: async `execFile`, so a slow classifier never blocks the host. Never throws; stderr is kept only so the verdict can tell an import failure from another exit. */
const defaultClassifySpawn: ClassifySpawn = (cmd, args, opts) => {
	const { promise, resolve } = Promise.withResolvers<ClassifyRun>();
	nodeExecFile(
		cmd,
		args as string[],
		{ cwd: opts.cwd, timeout: opts.timeout, encoding: "utf8", env: opts.env },
		(error, _stdout, stderr) => {
			if (!error) {
				resolve({ exitCode: 0 });
				return;
			}
			const err = error as Error & { code?: unknown; killed?: unknown };
			if (err.killed === true) {
				resolve({ timedOut: true });
				return;
			}
			if (typeof err.code === "number") {
				resolve({ exitCode: err.code, stderr: typeof stderr === "string" ? stderr : "" });
				return;
			}
			resolve({ errorCode: typeof err.code === "string" ? err.code : "UNKNOWN" });
		},
	);
	return promise;
};

/**
 * Ask Swarm's own classifier about `text` (the display brief plus the pstack block, already joined by the
 * caller). `sdlc` spawns, `skip` refuses, and every other outcome is `unknown` with a fixed, secret-free
 * reason: the text is never echoed into a verdict. Never throws.
 */
export async function preflightClassify(
	text: string,
	opts: {
		swarmRoot: string;
		timeoutMs?: number;
		spawn?: ClassifySpawn;
		/** The parent environment the child's is built from; default `process.env`. Injectable for tests. */
		env?: Readonly<Record<string, string | undefined>>;
	},
): Promise<ClassifyVerdict> {
	const spawn = opts.spawn ?? defaultClassifySpawn;
	const childEnv: Record<string, string | undefined> = { ...(opts.env ?? process.env) };
	dropJevKeys(childEnv);
	let run: ClassifyRun;
	try {
		run = await spawn("python3", buildClassifyArgv(text), {
			cwd: opts.swarmRoot,
			timeout: opts.timeoutMs ?? CLASSIFY_TIMEOUT_MS,
			env: childEnv,
		});
	} catch {
		return { kind: "unknown", reason: "classifier could not start" };
	}
	if (run.timedOut) return { kind: "unknown", reason: "classifier timed out" };
	if (run.errorCode === "ENOENT") return { kind: "unknown", reason: "python3 not found" };
	if (run.errorCode !== undefined) return { kind: "unknown", reason: "classifier could not start" };
	if (run.exitCode === 0) return { kind: "sdlc" };
	if (run.exitCode === SKIP_EXIT_CODE) return { kind: "skip" };
	if (typeof run.exitCode === "number") {
		// Only the exception class is read from stderr; no stderr text ever reaches a reason.
		return IMPORT_ERROR_RE.test(run.stderr ?? "")
			? { kind: "unknown", reason: "classifier import failed" }
			: { kind: "unknown", reason: `classifier exited with code ${run.exitCode}` };
	}
	return { kind: "unknown", reason: "classifier returned no result" };
}
