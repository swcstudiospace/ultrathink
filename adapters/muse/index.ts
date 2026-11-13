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
	/** Capability flags Muse declares. Defaults to `MUSE_DECLARED_CAPABILITIES`. */
	readonly declared?: DeclaredCapabilities;
	/**
	 * Muse CLI version checked against the version floor. Defaults to `MUSE_RECORDED_VERSION`.
	 * The adapter has no version source (its runner spawns only `bin/ultrathink`), so the live
	 * Muse version is not read unless the caller supplies it.
	 */
	readonly observedVersion?: string | null;
}

/** Version recorded for Muse in docs/plugin-research/host-contracts.md ("Host versions used"). */
export const MUSE_RECORDED_VERSION = "1.4.14";

/**
 * Capability flags Muse declares, mirroring `capabilities` in conformance/muse-subject.ts. The
 * adapter cannot import that subject, which reads the manifest from disk; a test keeps them equal.
 */
export const MUSE_DECLARED_CAPABILITIES: DeclaredCapabilities = {
	supports_slash_commands: true,
	supports_skills: true,
	supports_hooks: true,
	supports_subagents: false,
	supports_persistent_state: false,
	supports_interactive_prompts: false,
};

/** Flags the verb commands rely on: each verb is a Muse slash command. */
const REQUESTED_CAPABILITIES = ["supports_slash_commands"] as const;

/** `bin/ultrathink` verbs this host exposes as `ultrathink-<verb>` commands. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

type Verb = (typeof VERBS)[number];

/** Command name to engine verb. A Map, so a name such as `__proto__` is never a lookup hit. */
const COMMANDS: ReadonlyMap<string, Verb> = new Map(
	VERBS.map((verb): [string, Verb] => [`ultrathink-${verb}`, verb]),
);

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"version_mismatch",
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
 * A Muse version below the floor, or unknown, is refused with `version_mismatch` and nothing runs.
 * A requested flag the host does not declare still runs the verb, and the result carries its
 * fallback text in `value.fallbacks`.
 */
export function createMuseAdapter(options: MuseAdapterOptions): CommandPort {
	const {
		runner,
		entry,
		entryPath,
		declared = MUSE_DECLARED_CAPABILITIES,
		observedVersion = MUSE_RECORDED_VERSION,
	} = options;
	const version = checkVersionFloor("muse", observedVersion);
	const fallbacks: readonly string[] = gateCapabilities(REQUESTED_CAPABILITIES, declared).flatMap(
		(capability) => (capability.fallback === null ? [] : [capability.fallback]),
	);
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
			if (!version.ok)
				return {
					ok: false,
					error: {
						category: "version_mismatch",
						message:
							version.reason === "below_floor"
								? `host version is below the minimum ${version.floor}`
								: `host version is unknown; minimum is ${version.floor}`,
					},
				};
			if (!entry.exists(entryPath))
				return {
					ok: false,
					error: { category: "capability_missing", message: "host entry point missing" },
				};
			try {
				const result = await runner.run([verb]);
				if (result.exitCode !== 0) return internalFailure();
				const value =
					fallbacks.length === 0 ? { stdout: result.stdout } : { stdout: result.stdout, fallbacks };
				return { ok: true, value };
			} catch {
				return internalFailure();
			}
		},
	};
}
