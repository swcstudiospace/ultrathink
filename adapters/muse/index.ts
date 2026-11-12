// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";

/** Spawns `bin/ultrathink` with the given argv. The caller supplies the real runner; this adapter imports no Node APIs. */
export interface AdapterRunner {
	run(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

/** Answers whether a host entry point exists. The caller supplies the real check. */
export interface AdapterEntry {
	exists(path: string): boolean;
}

export interface MuseAdapterOptions {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	/** Host entry point checked before every run: `hooks/muse-prompt`. */
	readonly entryPath: string;
}

/** `bin/ultrathink` verbs this host exposes as `ultrathink-<verb>` commands. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

type Verb = (typeof VERBS)[number];

/** Command name to engine verb. A Map, so a name such as `__proto__` is never a lookup hit. */
const COMMANDS: ReadonlyMap<string, Verb> = new Map(
	VERBS.map((verb): [string, Verb] => [`ultrathink-${verb}`, verb]),
);

/** Longest stdout returned to the host, in characters. */
const STDOUT_LIMIT = 4096;

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"internal",
];

/** Accepts any value unchanged: the engine verbs take no arguments, so inputs are not validated here. */
const passthrough: Schema<unknown> = { parse: (value) => value };

const internalFailure = (): CommandResult<unknown> => ({
	ok: false,
	error: { category: "internal", message: "command failed" },
});

/**
 * CommandPort for Muse. Each command runs `bin/ultrathink <verb>` once through the runner.
 * A thrown error or a non-zero exit yields `internal` with a fixed message: the thrown text and
 * the engine's output are never returned on failure, because they may carry secrets.
 */
export function createMuseAdapter(options: MuseAdapterOptions): CommandPort {
	const { runner, entry, entryPath } = options;
	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			return [...COMMANDS.keys()].map((name) => ({
				name,
				input: passthrough,
				output: passthrough,
				// Every verb sends messages or changes engine state, so repeating one is not safe.
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
				if (result.exitCode !== 0) return internalFailure();
				return { ok: true, value: { stdout: result.stdout.slice(0, STDOUT_LIMIT) } };
			} catch {
				return internalFailure();
			}
		},
	};
}
