// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { CapabilityFlag } from "../../core/src/capabilities/manifest.ts";
import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";
import { type DeclaredCapabilities, gateCapabilities } from "../capability-gate.ts";
import { checkVersionFloor } from "../version-floor.ts";

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
	/**
	 * Grok Build version the host reports. The adapter has no version source (it imports no host SDK and its
	 * runner only spawns `bin/ultrathink`), so by default it uses RECORDED_GROK_BUILD_VERSION and the live
	 * version is not read. `null` means unknown and is refused.
	 */
	readonly observedVersion?: string | null;
	/** Flags the host declares. Defaults to GROK_BUILD_DECLARED_FLAGS. */
	readonly declared?: DeclaredCapabilities;
}

/** Version recorded for Grok Build in docs/plugin-research/host-contracts.md ("Host versions used"). Not a live reading. */
const RECORDED_GROK_BUILD_VERSION = "1.0.77";

/** Flags conformance/grok-build-subject.ts declares. index.test.ts asserts that the two stay equal. */
export const GROK_BUILD_DECLARED_FLAGS: DeclaredCapabilities = {
	supports_slash_commands: true,
	supports_skills: true,
	supports_hooks: true,
	supports_subagents: false,
	supports_persistent_state: false,
	supports_interactive_prompts: false,
};

/**
 * Flags every command depends on: each is reached as a slash command, and the Ultrathink prompt hook applies
 * its effect. The adapter does not depend on subagents, persistent host state, or interactive prompts, so
 * those flags are not requested.
 */
const COMMAND_FLAGS: readonly CapabilityFlag[] = ["supports_slash_commands", "supports_hooks"];

const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

/** Command name (`ultrathink-<verb>`) to the `bin/ultrathink` verb it runs. */
const VERB_BY_COMMAND: ReadonlyMap<string, (typeof VERBS)[number]> = new Map(
	VERBS.map((verb) => [`ultrathink-${verb}`, verb] as const),
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
 *
 * A host below the version floor, or with an unknown version, yields `capability_missing` and never runs. When a
 * requested capability flag is disabled, the command returns that flag's documented fallback text and never runs.
 */
export function createGrokBuildAdapter(options: GrokBuildAdapterOptions): CommandPort {
	const { runner, entry, entryPath } = options;
	const declared = options.declared ?? GROK_BUILD_DECLARED_FLAGS;
	const version = checkVersionFloor(
		"grok-build",
		options.observedVersion === undefined ? RECORDED_GROK_BUILD_VERSION : options.observedVersion,
	);
	const disabledFallbacks = gateCapabilities(COMMAND_FLAGS, declared).flatMap((capability) =>
		capability.enabled || capability.fallback === null ? [] : [capability.fallback],
	);

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
			if (!version.ok) {
				return fail(
					"capability_missing",
					version.reason === "below_floor"
						? `host version below minimum ${version.floor}`
						: `host version unknown; minimum ${version.floor}`,
				);
			}
			// Running the verb with a disabled flag would silently ignore that capability, so return its fallback.
			if (disabledFallbacks.length > 0) {
				return { ok: true, value: { stdout: disabledFallbacks.join("\n") } };
			}

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
