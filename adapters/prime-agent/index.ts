// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { CAPABILITY_FALLBACKS, type CapabilityFlag } from "../../core/src/capabilities/manifest.ts";
import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";
import { type DeclaredCapabilities, gateCapabilities } from "../capability-gate.ts";
import { checkVersionFloor } from "../version-floor.ts";

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
	/** Flags the host declares. Defaults to PRIME_AGENT_DECLARED_CAPABILITIES. */
	readonly declared?: DeclaredCapabilities;
	/** Host version checked against the floor. Defaults to PRIME_AGENT_RECORDED_VERSION; null is refused. */
	readonly observedVersion?: string | null;
}

/** Prime-Agent host entry point: the skill manifest that wires the commands into the host. */
export const PRIME_AGENT_ENTRY_PATH = "hosts/prime-agent/SKILL.md";

/**
 * Flags Prime Agent declares. Mirrors `createPrimeAgentSkillSubject().capabilities` in
 * conformance/prime-agent-subject.ts; the adapter test keeps the two equal. The adapter does not import
 * that subject because it is a test-side module that reads SKILL.md.
 */
export const PRIME_AGENT_DECLARED_CAPABILITIES: DeclaredCapabilities = {
	supports_skills: true,
	supports_slash_commands: false,
	supports_hooks: false,
	supports_subagents: true,
	supports_persistent_state: true,
	supports_interactive_prompts: false,
};

/**
 * Prime Agent version the adapter was verified against (docs/plugin-research/host-contracts.md, "Host
 * versions used"). No entry or CLI in this adapter reads the live version, so this is the observed version
 * unless a caller passes `observedVersion`.
 */
export const PRIME_AGENT_RECORDED_VERSION = "0.10.2";

/**
 * Flags each command requests. Prime Agent reaches the `/ultrathink-*` commands through its skill; it declares
 * no slash-command hook (`supports_slash_commands` is false), so the request is `supports_skills`.
 */
const REQUESTED_CAPABILITIES: readonly CapabilityFlag[] = ["supports_skills"];

/** Engine CLI verbs accepted by `bin/ultrathink`. Each one backs one `ultrathink-<verb>` command. */
const VERBS = ["quick", "skip", "off", "on", "track", "status"] as const;

/** Command name to engine verb. */
const COMMANDS = new Map<string, string>(
	VERBS.map((verb) => [`ultrathink-${verb}`, verb] as const),
);

const COMMAND_ERRORS: readonly ErrorCategory[] = [
	"invalid_input",
	"capability_missing",
	"version_mismatch",
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
	const declared = options.declared ?? PRIME_AGENT_DECLARED_CAPABILITIES;
	const version = checkVersionFloor(
		"prime-agent",
		options.observedVersion === undefined ? PRIME_AGENT_RECORDED_VERSION : options.observedVersion,
	);
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
			if (!version.ok)
				return {
					ok: false,
					error: {
						category: "version_mismatch",
						message:
							version.reason === "below_floor"
								? `host version below floor ${version.floor}`
								: "host version unknown",
					},
				};
			const blocked = gateCapabilities(REQUESTED_CAPABILITIES, declared).find(
				(capability) => !capability.enabled,
			);
			if (blocked !== undefined)
				return {
					ok: false,
					error: { category: "capability_missing", message: CAPABILITY_FALLBACKS[blocked.flag] },
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
				return { ok: true, value: { stdout: result.stdout } };
			} catch {
				return { ok: false, error: { category: "internal", message: "command failed" } };
			}
		},
	};
}
