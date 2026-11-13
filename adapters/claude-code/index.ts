// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";

/** Runs `bin/ultrathink` with the given argv. The caller supplies the real process spawn. */
export interface AdapterRunner {
	run(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

/** Reports whether the host entry point exists. The caller supplies the real existence check. */
export interface AdapterEntry {
	exists(path: string): boolean;
}

export interface ClaudeCodeAdapterOptions {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	readonly entryPath: string;
}

/** Engine verbs accepted by `bin/ultrathink`. Each one is exposed as `ultrathink-<verb>`. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

const COMMANDS: ReadonlyMap<string, string> = new Map(
	VERBS.map((verb) => [`ultrathink-${verb}`, verb]),
);

/** The adapter forwards arguments only as argv verbs, so it accepts any input value unchanged. */
const passthrough: Schema<unknown> = { parse: (value) => value };

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"internal",
];

/**
 * CommandPort for the Claude Code host. Each command runs one `bin/ultrathink <verb>` invocation and
 * returns its stdout. A thrown runner error or a non-zero exit yields `internal` with a fixed message,
 * because the thrown text or stderr may carry secrets.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): CommandPort {
	const { runner, entry, entryPath } = options;

	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			return [...COMMANDS.keys()].map((name) => ({
				name,
				input: passthrough,
				output: passthrough,
				// Every command sends messages or changes engine state, so repeating one is not safe.
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
			if (!entry.exists(entryPath))
				return {
					ok: false,
					error: { category: "capability_missing", message: "host entry point missing" },
				};
			try {
				const result = await runner.run([verb]);
				if (result.exitCode !== 0)
					return { ok: false, error: { category: "internal", message: "command failed" } };
				return { ok: true, value: { stdout: result.stdout } };
			} catch {
				return { ok: false, error: { category: "internal", message: "command failed" } };
			}
		},
	};
}
