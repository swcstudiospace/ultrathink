// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";

/** Outcome of one `bin/ultrathink` run. */
export interface AdapterOutcome {
	readonly exitCode: number;
	readonly stdout: string;
}

/** Runs `bin/ultrathink` with the given argv. The caller supplies the real runner that spawns the engine CLI. */
export interface AdapterRunner {
	run(argv: readonly string[]): Promise<AdapterOutcome>;
}

/** Reports whether a host entry point exists. The caller supplies the real existence check. */
export interface AdapterEntry {
	exists(path: string): boolean;
}

export interface HermesAdapterOptions {
	readonly runner: AdapterRunner;
	readonly entry: AdapterEntry;
	readonly entryPath: string;
}

/** Host entry point that Hermes loads. Callers pass it as `entryPath`. */
export const HERMES_ENTRY_PATH = "hosts/hermes/bridge.py";

/** Verbs accepted by `bin/ultrathink`. Each one is exposed to Hermes as `ultrathink-<verb>`. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

/** Upper bound on the stdout returned to the host, in characters. */
const STDOUT_LIMIT = 4096;

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"internal",
];

/** Accepts any value unchanged: the adapter forwards only the verb, so no input shape is enforced here. */
const passthrough: Schema<unknown> = { parse: (value) => value };

const COMMAND_VERBS: ReadonlyMap<string, string> = new Map(
	VERBS.map((verb) => [`ultrathink-${verb}`, verb] as const),
);

function failure(category: ErrorCategory, message: string): CommandResult<unknown> {
	return { ok: false, error: { category, message } };
}

/**
 * CommandPort over the Hermes host. Each command runs `bin/ultrathink <verb>` once. The adapter holds no
 * engine logic. Runner failures and non-zero exits both return `internal` with a fixed message, because the
 * thrown text may carry secrets.
 */
export function createHermesAdapter(options: HermesAdapterOptions): CommandPort {
	const { runner, entry, entryPath } = options;
	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			return [...COMMAND_VERBS.keys()].map((name) => ({
				name,
				input: passthrough,
				output: passthrough,
				// Every command runs the engine, which sends messages or changes state. The adapter adds no dedup.
				idempotency: "side-effecting",
				errorCategories: COMMAND_ERRORS,
			}));
		},
		async invoke(name: string): Promise<CommandResult<unknown>> {
			const verb = COMMAND_VERBS.get(name);
			if (verb === undefined) return failure("invalid_input", `unknown command: ${name}`);
			if (!entry.exists(entryPath))
				return failure("capability_missing", "host entry point missing");
			let outcome: AdapterOutcome;
			try {
				outcome = await runner.run([verb]);
			} catch {
				return failure("internal", "command failed");
			}
			if (outcome.exitCode !== 0) return failure("internal", "command failed");
			return { ok: true, value: { stdout: outcome.stdout.slice(0, STDOUT_LIMIT) } };
		},
	};
}
