// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ultrathink-adapter [--raw] <host> <verb> [extra args...]: runs one host adapter command.
 * Extra args are passed unchanged, in order, to `bin/ultrathink <verb> <extra args...>`.
 * Default output is one JSON line: {"ok":true,"stdout":"..."} or {"ok":false,"error":{...}}.
 * With --raw, a success prints only the child's stdout; a failure prints the error message to
 * stderr and exits with the child's exit code when it had one, otherwise 1.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommandPort, ErrorCategory } from "../core/src/ports/command.ts";
import { createClaudeCodeAdapter } from "./claude-code/index.ts";
import { createGrokBuildAdapter } from "./grok-build/index.ts";
import { createHermesAdapter } from "./hermes/index.ts";
import { createMuseAdapter } from "./muse/index.ts";
import { createPrimeAgentAdapter } from "./prime-agent/index.ts";

/** Environment a host adds to the current process env for its engine child. */
type HostEnv = Readonly<Record<string, string>>;

/** Runs `bin/ultrathink` with the given argv; `env` entries are merged over the current process env. */
interface AdapterRunner {
	run(
		argv: readonly string[],
		env?: HostEnv,
	): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

/** Reports whether a host entry point exists, relative to the repo root. */
interface AdapterEntry {
	exists(path: string): boolean;
}

export interface AdapterCliDeps {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
}

type AdapterCliOutput =
	| { readonly ok: true; readonly stdout: string }
	| {
			readonly ok: false;
			readonly error: { readonly category: ErrorCategory; readonly message: string };
	  };

export interface AdapterCliResult {
	/** True when `--raw` was given: the caller prints bare stdout or the bare error message. */
	readonly raw: boolean;
	/** Process exit code: 0 on success, the child's code under --raw on a child failure, else 1. */
	readonly exitCode: number;
	readonly output: AdapterCliOutput;
}

type AdapterFactory = (options: {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	readonly entryPath: string;
}) => CommandPort;

interface HostSpec {
	readonly create: AdapterFactory;
	readonly entryPath: string;
	readonly env?: HostEnv;
}

const HOSTS: Record<string, HostSpec> = {
	"claude-code": { create: createClaudeCodeAdapter, entryPath: "hooks/hooks.json" },
	"grok-build": { create: createGrokBuildAdapter, entryPath: "hooks/hooks.json" },
	muse: { create: createMuseAdapter, entryPath: "hooks/muse-prompt" },
	hermes: { create: createHermesAdapter, entryPath: "hosts/hermes/bridge.py" },
	"prime-agent": {
		create: createPrimeAgentAdapter,
		entryPath: "hosts/prime-agent/SKILL.md",
		env: { ULTRATHINK_HOST: "prime-agent" },
	},
};

const VERBS: readonly string[] = ["quick", "skip", "off", "on", "track", "status"];

const RAW_FLAG = "--raw";

const CONTEXT = { correlationId: "ultrathink-adapter" };

const REPO_ROOT = resolve(import.meta.dir, "..");

const failure = (
	raw: boolean,
	category: ErrorCategory,
	message: string,
	childExitCode?: number,
): AdapterCliResult => ({
	raw,
	exitCode: raw && childExitCode !== undefined && childExitCode !== 0 ? childExitCode : 1,
	output: { ok: false, error: { category, message } },
});

/**
 * Pure dispatch: strips `--raw`, validates host and verb, builds the host adapter with a runner
 * that appends the extra args, and invokes the verb. Performs no I/O of its own.
 */
export async function runAdapterCli(
	argv: readonly string[],
	deps: AdapterCliDeps,
): Promise<AdapterCliResult> {
	const raw = argv.includes(RAW_FLAG);
	const [hostName, verb, ...extra] = argv.filter((arg) => arg !== RAW_FLAG);
	if (hostName === undefined || verb === undefined)
		return failure(
			raw,
			"invalid_input",
			"usage: ultrathink-adapter [--raw] <host> <verb> [args...]",
		);
	// Own-property check: a name such as `__proto__` must not resolve through the prototype.
	const host = Object.hasOwn(HOSTS, hostName) ? HOSTS[hostName] : undefined;
	if (host === undefined) return failure(raw, "invalid_input", `unknown host: ${hostName}`);
	if (!VERBS.includes(verb)) return failure(raw, "invalid_input", `unknown verb: ${verb}`);

	// The adapter invokes `bin/ultrathink <verb>`; extra args are appended here so the adapter
	// modules never see them. The last child result is kept for the --raw exit code.
	const last: { child?: { readonly exitCode: number; readonly stdout: string } } = {};
	const runner: AdapterRunner = {
		async run(childArgv) {
			last.child = await deps.runner.run([...childArgv, ...extra], host.env);
			return last.child;
		},
	};
	const port = host.create({ runner, entry: deps.entry, entryPath: host.entryPath });
	const result = await port.invoke(`ultrathink-${verb}`, undefined, CONTEXT);
	if (!result.ok)
		return failure(raw, result.error.category, result.error.message, last.child?.exitCode);
	const value: unknown = result.value;
	const stdout =
		typeof value === "object" && value !== null && "stdout" in value ? value.stdout : undefined;
	if (typeof stdout !== "string") return failure(raw, "internal", "command returned no stdout");
	return { raw, exitCode: 0, output: { ok: true, stdout } };
}

/**
 * What to print for a result. Envelope mode prints one JSON line on stdout. Raw mode prints only
 * the child's stdout on success, and only the error message on stderr on failure.
 */
export function renderResult(result: AdapterCliResult): {
	readonly stdout: string;
	readonly stderr: string;
} {
	if (!result.raw) return { stdout: `${JSON.stringify(result.output)}\n`, stderr: "" };
	if (result.output.ok) return { stdout: result.output.stdout, stderr: "" };
	return { stdout: "", stderr: `${result.output.error.message}\n` };
}

/**
 * Real runner: spawns the engine binary with an argv array (no shell). A non-zero exit resolves
 * with its code; a spawn failure, signal or output overflow rejects, and the adapter maps it to
 * `internal`. The child runs with the current process env plus the host's `env` entries.
 */
function createProcessRunner(binPath: string): AdapterRunner {
	return {
		run(argv, env) {
			const { promise, resolve, reject } = Promise.withResolvers<{
				readonly exitCode: number;
				readonly stdout: string;
			}>();
			execFile(
				binPath,
				[...argv],
				{ encoding: "utf8", env: { ...process.env, ...env } },
				(error, stdout) => {
					if (error === null) {
						resolve({ exitCode: 0, stdout });
						return;
					}
					if (typeof error.code === "number") {
						resolve({ exitCode: error.code, stdout });
						return;
					}
					reject(error);
				},
			);
			return promise;
		},
	};
}

/** Real entry check: a host entry point exists when its path resolves under the repo root. */
function createRepoEntry(root: string): AdapterEntry {
	return { exists: (path) => existsSync(join(root, path)) };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const deps: AdapterCliDeps = {
		runner: createProcessRunner(join(REPO_ROOT, "bin", "ultrathink")),
		entry: createRepoEntry(REPO_ROOT),
	};
	const result = await runAdapterCli(argv, deps);
	const { stdout, stderr } = renderResult(result);
	if (stdout !== "") process.stdout.write(stdout);
	if (stderr !== "") process.stderr.write(stderr);
	return result.exitCode;
}

if (import.meta.main) {
	process.exitCode = await main();
}
