// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";

/** Runs the engine CLI (`bin/ultrathink`) with the given arguments. The caller supplies the real process runner. */
export interface AdapterRunner {
	run(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

/** Reports whether a host entry point exists. The caller supplies the real existence check. */
export interface AdapterEntry {
	exists(path: string): boolean;
}

export interface PrimeAgentAdapterOptions {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	readonly entryPath: string;
}

/** Prime-Agent host entry point: the skill manifest that wires the commands into the host. */
export const PRIME_AGENT_ENTRY_PATH = "hosts/prime-agent/SKILL.md";

/** Engine CLI verbs accepted by `bin/ultrathink`. Each one backs one `ultrathink-<verb>` command. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

/** Command name to engine verb. */
const COMMANDS = new Map<string, string>(
	VERBS.map((verb) => [`ultrathink-${verb}`, verb] as const),
);

/** Maximum characters of engine stdout returned to the host. */
const STDOUT_LIMIT = 4096;

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"internal",
];

/** Accepts any input unchanged: these commands take no arguments that the adapter forwards. */
const passthrough: Schema<unknown> = { parse: (value) => value };

interface CommandOutput {
	readonly stdout: string;
}

const outputSchema: Schema<CommandOutput> = {
	parse(value: unknown): CommandOutput {
		if (typeof value !== "object" || value === null || !("stdout" in value))
			throw new TypeError("invalid command output");
		const { stdout } = value;
		if (typeof stdout !== "string") throw new TypeError("invalid command output");
		return { stdout };
	},
};

/**
 * CommandPort over the Prime-Agent skill commands. Each command runs `bin/ultrathink <verb>` once and
 * returns its stdout. The adapter holds no engine logic. Failures carry fixed messages: thrown text and
 * stderr are never returned, because they may carry secrets.
 */
export function createPrimeAgentAdapter(options: PrimeAgentAdapterOptions): CommandPort {
	const { runner, entry, entryPath } = options;
	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			return [...COMMANDS.keys()].map((name) => ({
				name,
				input: passthrough,
				output: outputSchema,
				// Every command changes engine state or sends messages, and the port adds no dedup: none is idempotent.
				idempotency: "side-effecting",
				errorCategories: COMMAND_ERRORS,
			}));
		},
		async invoke(name: string): Promise<CommandResult<unknown>> {
			const verb = COMMANDS.get(name);
			if (verb === undefined)
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${name}` },
				};
			try {
				if (!entry.exists(entryPath))
					return {
						ok: false,
						error: { category: "capability_missing", message: "host entry point missing" },
					};
				const result = await runner.run([verb]);
				if (result.exitCode !== 0)
					return { ok: false, error: { category: "internal", message: "command failed" } };
				return { ok: true, value: { stdout: result.stdout.slice(0, STDOUT_LIMIT) } };
			} catch {
				return { ok: false, error: { category: "internal", message: "command failed" } };
			}
		},
	};
}
