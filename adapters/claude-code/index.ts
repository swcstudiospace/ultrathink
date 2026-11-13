// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";
import type { CapabilityFlag } from "../../core/src/capabilities/manifest.ts";
import { type DeclaredCapabilities, gateCapabilities } from "../capability-gate.ts";
import { checkVersionFloor } from "../version-floor.ts";

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
	/** Declared host flags. Defaults to the Claude Code subject's declarations (DECLARED_FLAGS). */
	readonly declared?: DeclaredCapabilities;
	/** Observed host version. Defaults to the version recorded in host-contracts.md (RECORDED_VERSION). */
	readonly observedVersion?: string | null;
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

/** Capabilities this adapter needs: each command is a slash command, and the entry point is the hooks file. */
const REQUESTED_FLAGS: readonly CapabilityFlag[] = ["supports_slash_commands", "supports_hooks"];

/**
 * Flags conformance/claude-code-subject.ts declares. Mirrored here because the subject reads the commands
 * directory when it is created; keep the two in step.
 */
const DECLARED_FLAGS: DeclaredCapabilities = {
	supports_skills: true,
	supports_slash_commands: true,
	supports_subagents: false,
	supports_hooks: true,
	supports_persistent_state: false,
	supports_interactive_prompts: false,
};

/**
 * Claude Code version recorded in docs/plugin-research/host-contracts.md. The live `claude --version` is not read
 * here: this adapter has no version source (the doctor probe is separate), so the recorded version stands in for the
 * observed one unless the caller passes `observedVersion`.
 */
const RECORDED_VERSION = "2.1.322";

/** Fixed refusal text when the version floor rejects `observed`; undefined when it is accepted. */
function versionRefusal(observed: string | null): string | undefined {
	const floor = checkVersionFloor("claude-code", observed);
	if (floor.ok) return undefined;
	return floor.reason === "below_floor"
		? `host version below floor ${floor.floor}`
		: "host version unknown";
}

/**
 * CommandPort for the Claude Code host. Each command runs one `bin/ultrathink <verb>` invocation and
 * returns its stdout. A thrown runner error or a non-zero exit yields `internal` with a fixed message,
 * because the thrown text or stderr may carry secrets.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): CommandPort {
	const {
		runner,
		entry,
		entryPath,
		declared = DECLARED_FLAGS,
		observedVersion = RECORDED_VERSION,
	} = options;
	const [fallback] = gateCapabilities(REQUESTED_FLAGS, declared).flatMap((capability) =>
		capability.fallback === null ? [] : [capability.fallback],
	);
	const refusal = versionRefusal(observedVersion);

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
			if (fallback !== undefined)
				return { ok: false, error: { category: "capability_missing", message: fallback } };
			if (refusal !== undefined)
				return { ok: false, error: { category: "capability_missing", message: refusal } };
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
