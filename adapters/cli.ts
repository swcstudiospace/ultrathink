// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ultrathink-adapter [--raw] <host> <verb> [extra args...]: runs one host adapter command.
 * Extra args are passed unchanged, in order, to `bin/ultrathink <verb> <extra args...>`.
 * Default output is one JSON line: {"ok":true,"stdout":"..."} or {"ok":false,"error":{...}}.
 * With --raw, a success prints only the child's stdout; a failure prints the error message to
 * stderr and exits with the child's exit code when it had one, otherwise 1.
 * ultrathink-adapter install prime-agent --source <abs path> --skills-dir <abs path>: installs the
 * Prime-Agent skill and prints the InstallResult as one JSON line (see runInstallVerb).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CommandPort, ErrorCategory } from "../core/src/ports/command.ts";
import { createClaudeCodeAdapter } from "./claude-code/index.ts";
import { createGrokBuildAdapter } from "./grok-build/index.ts";
import { createHermesAdapter } from "./hermes/index.ts";
import { createMuseAdapter } from "./muse/index.ts";
import { createPrimeAgentAdapter } from "./prime-agent/index.ts";
import { installPrimeAgentSkill } from "./prime-agent/install.ts";

/** Environment a host adds on top of the inherited parent env for its engine child. */
type HostEnv = Readonly<Record<string, string>>;

/** Runs `bin/ultrathink` with the given argv; `env` entries are merged over the child environment. */
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

/**
 * Reads the output of `<command> --version`. Resolves null when the binary is absent, exits non-zero,
 * or times out; the CLI then refuses that host fail closed.
 */
type VersionReader = (command: string) => Promise<string | null>;

export interface AdapterCliDeps {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	readonly readVersion: VersionReader;
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
	readonly observedVersion: string | null;
}) => CommandPort;

interface HostSpec {
	readonly create: AdapterFactory;
	readonly entryPath: string;
	readonly versionCommand: string;
	readonly env?: HostEnv;
}

const HOSTS: Record<string, HostSpec> = {
	"claude-code": {
		create: createClaudeCodeAdapter,
		entryPath: "hooks/hooks.json",
		versionCommand: "claude",
	},
	"grok-build": {
		create: createGrokBuildAdapter,
		entryPath: "hooks/hooks.json",
		versionCommand: "grok",
	},
	muse: { create: createMuseAdapter, entryPath: "hooks/muse-prompt", versionCommand: "muse" },
	hermes: {
		// Hermes names its version option `hostVersion`.
		create: ({ observedVersion, ...options }) =>
			createHermesAdapter({ ...options, hostVersion: observedVersion }),
		entryPath: "hosts/hermes/bridge.py",
		versionCommand: "hermes",
	},
	"prime-agent": {
		create: createPrimeAgentAdapter,
		entryPath: "hosts/prime-agent/SKILL.md",
		versionCommand: "prime-agent",
		env: { ULTRATHINK_HOST: "prime-agent" },
	},
};

const VERBS: readonly string[] = ["quick", "skip", "off", "on", "track", "status"];

const RAW_FLAG = "--raw";

/** Longest stdout the JSON envelope carries. `--raw` prints stdout in full. */
const ENVELOPE_STDOUT_LIMIT = 4096;

/** Longest a host `--version` call may run before the host counts as unreadable. */
const VERSION_TIMEOUT_MS = 5000;

/** First dotted-number run in a host's `--version` output, e.g. `2.1.322` in `claude 2.1.322 (Claude Code)`. */
const VERSION_RUN = /\d+(?:\.\d+)+/;

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
 * Dispatch: strips `--raw`, validates host and verb, reads the host version, builds the host adapter
 * with a runner that appends the extra args, and invokes the verb. Its I/O goes only through `deps`.
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
	const observedVersion = await readObservedVersion(deps.readVersion, host.versionCommand);
	const port = host.create({
		runner,
		entry: deps.entry,
		entryPath: host.entryPath,
		observedVersion,
	});
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
 * What to print for a result. Envelope mode prints one JSON line on stdout, with stdout cut to
 * `ENVELOPE_STDOUT_LIMIT` characters. Raw mode prints only the child's full stdout on success, and
 * only the error message on stderr on failure.
 */
export function renderResult(result: AdapterCliResult): {
	readonly stdout: string;
	readonly stderr: string;
} {
	if (!result.raw) {
		const output: AdapterCliOutput = result.output.ok
			? { ok: true, stdout: result.output.stdout.slice(0, ENVELOPE_STDOUT_LIMIT) }
			: result.output;
		return { stdout: `${JSON.stringify(output)}\n`, stderr: "" };
	}
	if (result.output.ok) return { stdout: result.output.stdout, stderr: "" };
	return { stdout: "", stderr: `${result.output.error.message}\n` };
}

/** Output of the install verb: the exit code and the text for each stream. */
export interface InstallCliResult {
	readonly exitCode: 0 | 1 | 2;
	readonly stdout: string;
	readonly stderr: string;
}

/** The one-line usage message for install; a usage error appends its reason after a colon. */
const INSTALL_USAGE =
	"usage: ultrathink-adapter install prime-agent --source <abs path> --skills-dir <abs path>";

/** The only host the install verb installs; the other hosts have no installer. */
const INSTALL_TARGET = "prime-agent";

const installUsage = (reason: string): InstallCliResult => ({
	exitCode: 2,
	stdout: "",
	stderr: `${INSTALL_USAGE}: ${reason}\n`,
});

/**
 * Runs `install prime-agent --source <repo root> --skills-dir <dir>`. `args` is argv after the verb.
 * Both flags take a value that must be an absolute path. Prints the InstallResult as one JSON line:
 * exit 0 when installed or unchanged, 1 on install_failed, 2 on a usage error (one line on stderr).
 */
export async function runInstallVerb(args: readonly string[]): Promise<InstallCliResult> {
	const [target, ...rest] = args;
	if (target !== INSTALL_TARGET)
		return installUsage(
			target === undefined ? "missing install target" : `unknown install target: ${target}`,
		);
	const values: Partial<Record<"--source" | "--skills-dir", string>> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		const value = rest[i + 1];
		if (flag !== "--source" && flag !== "--skills-dir")
			return installUsage(`unknown argument: ${flag}`);
		if (value === undefined || value.startsWith("--")) return installUsage(`${flag} needs a value`);
		if (values[flag] !== undefined) return installUsage(`${flag} given twice`);
		values[flag] = value;
	}
	const source = values["--source"];
	const skillsDir = values["--skills-dir"];
	if (source === undefined) return installUsage("--source is required");
	if (skillsDir === undefined) return installUsage("--skills-dir is required");
	if (!isAbsolute(source)) return installUsage("--source must be an absolute path");
	if (!isAbsolute(skillsDir)) return installUsage("--skills-dir must be an absolute path");
	const result = await installPrimeAgentSkill({ sourceDir: source, skillsDir });
	return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: "" };
}

/** Parent variables the engine child may inherit, by exact name. */
const INHERITED_ENV_NAMES: Readonly<Record<string, true>> = {
	PATH: true,
	HOME: true,
	USER: true,
	LANG: true,
	LC_ALL: true,
	LC_CTYPE: true,
	TERM: true,
	TMPDIR: true,
	SHELL: true,
	BUN: true,
	BUN_INSTALL: true,
	ANTHROPIC_API_KEY: true,
	OPENROUTER_API_KEY: true,
	AI_GATEWAY_API_KEY: true,
	SUBSTRATE_TOKEN: true,
	RAGFLOW_API_KEY: true,
	HINDSIGHT_API_KEY: true,
	PRIME_AGENT_CODING_AGENT_DIR: true,
	CLAUDE_CONFIG_DIR: true,
	CLAUDE_PLUGIN_ROOT: true,
	CLAUDE_SESSION_ID: true,
};

/** Parent variables with this prefix are always inherited by the engine child. */
const INHERITED_ENV_PREFIX = "ULTRATHINK_";

/**
 * Environment for the engine child: parent variables on the allowlist (exact names, or the
 * `ULTRATHINK_` prefix), with undefined values dropped, then the host's `hostEnv` entries on top.
 * Pure: reads only its arguments.
 */
export function childEnvironment(
	parent: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
	hostEnv: HostEnv = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(parent)) {
		if (value === undefined) continue;
		if (Object.hasOwn(INHERITED_ENV_NAMES, name) || name.startsWith(INHERITED_ENV_PREFIX)) {
			env[name] = value;
		}
	}
	return { ...env, ...hostEnv };
}

/**
 * Real runner: spawns the engine binary with an argv array (no shell). A non-zero exit resolves
 * with its code; a spawn failure, signal or output overflow rejects, and the adapter maps it to
 * `internal`. The child env is `childEnvironment(process.env, env)`.
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
				{ encoding: "utf8", env: childEnvironment(process.env, env) },
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

/** Version text a host CLI prints, read through the injected reader; null when unreadable. */
async function readObservedVersion(read: VersionReader, command: string): Promise<string | null> {
	try {
		const text = await read(command);
		return text === null ? null : (VERSION_RUN.exec(text)?.[0] ?? null);
	} catch {
		return null;
	}
}

/**
 * Real reader: spawns `<command> --version` with an argv array (no shell) and resolves its stdout.
 * Resolves null on a spawn failure, non-zero exit or timeout.
 */
function createVersionReader(): VersionReader {
	return (command) => {
		const { promise, resolve } = Promise.withResolvers<string | null>();
		execFile(
			command,
			["--version"],
			{ encoding: "utf8", timeout: VERSION_TIMEOUT_MS },
			(error, stdout) => resolve(error === null ? stdout : null),
		);
		return promise;
	};
}

/** Real entry check: a host entry point exists when its path resolves under the repo root. */
function createRepoEntry(root: string): AdapterEntry {
	return { exists: (path) => existsSync(join(root, path)) };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	if (argv[0] === "install") {
		const install = await runInstallVerb(argv.slice(1));
		if (install.stdout !== "") process.stdout.write(install.stdout);
		if (install.stderr !== "") process.stderr.write(install.stderr);
		return install.exitCode;
	}
	const deps: AdapterCliDeps = {
		runner: createProcessRunner(join(REPO_ROOT, "bin", "ultrathink")),
		entry: createRepoEntry(REPO_ROOT),
		readVersion: createVersionReader(),
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
