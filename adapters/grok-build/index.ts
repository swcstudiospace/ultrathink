// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";

/** Runs `bin/ultrathink` with the given argv. The caller supplies the real process spawner. */
export interface AdapterRunner {
	run(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

/** Existence check for the host entry point. The caller supplies it, so the adapter has no node imports. */
export interface AdapterEntry {
	exists(path: string): boolean;
}

export interface GrokBuildAdapterOptions {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	/** Host entry file that must exist for the commands to run, for Grok Build: `hooks/hooks.json`. */
	readonly entryPath: string;
}

const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

/** Command name (`ultrathink-<verb>`) to the `bin/ultrathink` verb it runs. */
const VERB_BY_COMMAND: ReadonlyMap<string, string> = new Map(
	VERBS.map((verb) => [`ultrathink-${verb}`, verb]),
);

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"internal",
];

/** Accepts any value unchanged: these commands take no arguments and the adapter does not validate them. */
const passthrough: Schema<unknown> = { parse: (value) => value };

function fail(category: ErrorCategory, message: string): CommandResult<unknown> {
	return { ok: false, error: { category, message } };
}

/**
 * CommandPort for Grok Build. Each command runs one `bin/ultrathink <verb>` invocation. A thrown runner or a
 * non-zero exit yields `internal` with a fixed message: the thrown text is never returned, because it may carry
 * secrets.
 */
export function createGrokBuildAdapter(options: GrokBuildAdapterOptions): CommandPort {
	const { runner, entry, entryPath } = options;

	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			return [...VERB_BY_COMMAND.keys()].map(
				(name): CommandDefinition<unknown, unknown> => ({
					name,
					input: passthrough,
					output: passthrough,
					// Every command changes state (sends messages or toggles modes), and the port adds no dedup.
					idempotency: "side-effecting",
					errorCategories: COMMAND_ERRORS,
				}),
			);
		},
		async invoke(name: string): Promise<CommandResult<unknown>> {
			const verb = VERB_BY_COMMAND.get(name);
			if (verb === undefined) return fail("invalid_input", `unknown command: ${name}`);
			if (!entry.exists(entryPath)) return fail("capability_missing", "host entry point missing");

			let outcome: { readonly exitCode: number; readonly stdout: string };
			try {
				outcome = await runner.run([verb]);
			} catch {
				return fail("internal", "command failed");
			}
			if (outcome.exitCode !== 0) return fail("internal", "command failed");
			return { ok: true, value: { stdout: outcome.stdout } };
		},
	};
}
