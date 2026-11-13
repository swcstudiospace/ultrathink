// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";
import { type DeclaredCapabilities, gateCapabilities } from "../capability-gate.ts";
import { checkVersionFloor } from "../version-floor.ts";

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
	/** Flags the host declares. Defaults to the Hermes declaration. */
	readonly capabilities?: DeclaredCapabilities;
	/** Observed host version. Defaults to the recorded version. `null` is unknown and is refused. */
	readonly hostVersion?: string | null;
}

/** Host entry point that Hermes loads. Callers pass it as `entryPath`. */
export const HERMES_ENTRY_PATH = "hosts/hermes/bridge.py";

/**
 * Flags the Hermes host declares. Copied from `createHermesSubject` in conformance/hermes-subject.ts, which does
 * not export them; keep the two in step.
 */
const HERMES_DECLARED_CAPABILITIES: DeclaredCapabilities = {
	supports_slash_commands: true,
	supports_skills: true,
	supports_hooks: true,
	supports_subagents: true,
	supports_persistent_state: true,
	supports_interactive_prompts: false,
};

/**
 * Hermes version recorded in docs/plugin-research/host-contracts.md. The entry check reports existence only and
 * no live version source exists, so this stands in for the observed version unless a caller passes `hostVersion`.
 * The live version is not read.
 */
const HERMES_RECORDED_VERSION = "v0.23.1";

/** Verbs accepted by `bin/ultrathink`. Each one is exposed to Hermes as `ultrathink-<verb>`. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"version_mismatch",
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
 * thrown text may carry secrets. Every command is a slash command, so a disabled `supports_slash_commands`
 * flag returns its documented fallback text. A host version below the floor, or unknown, is refused with
 * `version_mismatch` before the engine runs.
 */
export function createHermesAdapter(options: HermesAdapterOptions): CommandPort {
	const {
		runner,
		entry,
		entryPath,
		capabilities = HERMES_DECLARED_CAPABILITIES,
		hostVersion = HERMES_RECORDED_VERSION,
	} = options;
	const commandsFallback = gateCapabilities(["supports_slash_commands"], capabilities).find(
		(gate) => !gate.enabled,
	)?.fallback;
	const version = checkVersionFloor("hermes", hostVersion);
	const versionRefusal: CommandResult<unknown> | null = version.ok
		? null
		: failure(
				"version_mismatch",
				version.reason === "unknown_version"
					? "host version unknown"
					: `host version below ${version.floor}`,
			);
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
			if (versionRefusal !== null) return versionRefusal;
			if (typeof commandsFallback === "string")
				return failure("capability_missing", commandsFallback);
			if (!entry.exists(entryPath))
				return failure("capability_missing", "host entry point missing");
			let outcome: AdapterOutcome;
			try {
				outcome = await runner.run([verb]);
			} catch {
				return failure("internal", "command failed");
			}
			if (outcome.exitCode !== 0) return failure("internal", "command failed");
			return { ok: true, value: { stdout: outcome.stdout } };
		},
	};
}
