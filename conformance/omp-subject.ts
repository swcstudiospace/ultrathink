// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Conformance subject for the Omp host. Drives the commands registered by `createOmpExtension()` through the same mocked
 * ExtensionAPI surface that test/golden/omp/capture.ts records. Each invoke gets a fresh extension inside a throwaway
 * sandbox with a pinned environment, so no command reads or writes the operator's real config or state.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpExtension } from "../src/host/omp.ts";
import type { ExtensionAPI } from "../src/host/omp.ts";
import type { ConformanceSubject } from "./suite.ts";

const SESSION_ID = "conformance-session";
/** The only inherited variables; everything else is removed while a session is open and restored on dispose. */
const KEPT_ENV = ["PATH", "TMPDIR"];
const PINNED_ENV: Record<string, string> = { TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const SECRET_WORDS = /token|secret|password/i;

type CommandOptions = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string | undefined, ctx: unknown) => unknown;
};

interface HostState {
	commands: Map<string, CommandOptions>;
	events: string[];
}

interface Session {
	readonly host: { pi: ExtensionAPI; state: HostState };
	readonly ctx: unknown;
	readonly dispose: () => void;
}

/** Mocked ExtensionAPI recording registrations, the same surface capture.ts's createHost() records. */
function createHost(): { pi: ExtensionAPI; state: HostState } {
	const state: HostState = { commands: new Map(), events: [] };
	const pi = {
		on: (event: string) => {
			state.events.push(event);
		},
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		registerCommand: (name: string, options: CommandOptions) => {
			state.commands.set(name, options);
		},
		registerMessageRenderer: () => undefined,
	} as unknown as ExtensionAPI;
	return { pi, state };
}

/**
 * Creates a sandbox, pins the environment to it, and builds a fresh extension against the mock host. The environment
 * stays pinned until dispose(), so handlers see the sandbox while they run.
 */
function openSession(): Session {
	const root = mkdtempSync(join(tmpdir(), "omp-conformance-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	mkdirSync(home, { recursive: true });
	mkdirSync(workspace, { recursive: true });

	const saved = { ...process.env };
	for (const name of Object.keys(process.env)) {
		if (!KEPT_ENV.includes(name)) delete process.env[name];
	}
	Object.assign(process.env, PINNED_ENV, {
		HOME: home,
		PI_CODING_AGENT_DIR: join(root, "omp-agent"),
		XDG_CONFIG_HOME: join(root, "xdg"),
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		GROK_HOME: join(root, "grok"),
		HERMES_HOME: join(root, "hermes"),
		PRIME_AGENT_CODING_AGENT_DIR: join(root, "prime"),
	});

	const host = createHost();
	createOmpExtension()(host.pi);

	return {
		host,
		ctx: {
			cwd: workspace,
			sessionManager: { getSessionId: () => SESSION_ID },
			ui: { notify: () => undefined },
		},
		dispose: () => {
			for (const name of Object.keys(process.env)) delete process.env[name];
			Object.assign(process.env, saved);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Input is either the argument string itself or an object with a string `args`; anything else means no arguments. */
function argsOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (
		typeof input === "object" &&
		input !== null &&
		"args" in input &&
		typeof input.args === "string"
	) {
		return input.args;
	}
	return "";
}

/** Host-thrown messages that mention a secret-like word are withheld, so no forbidden substring reaches a caller. */
function safeMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return SECRET_WORDS.test(message) ? "command failed; details withheld" : message;
}

export function createOmpConformanceSubject(): ConformanceSubject {
	const probe = openSession();
	const commands = [...probe.host.state.commands.keys()].sort();
	const capabilities = {
		supports_slash_commands: probe.host.state.commands.size > 0,
		supports_hooks: probe.host.state.events.length > 0,
		supports_skills: false,
		supports_subagents: false,
		supports_persistent_state: true,
		supports_interactive_prompts: false,
	};
	probe.dispose();
	const declared = new Set(commands);

	return {
		name: "Omp host",
		capabilities,
		commands,
		// Correlation ids are not used: each invoke is an isolated session, so nothing needs to be keyed by them.
		invoke: async (command, input) => {
			if (!declared.has(command)) {
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${command}` },
				};
			}
			const session = openSession();
			try {
				const options = session.host.state.commands.get(command);
				if (!options) {
					return {
						ok: false,
						error: { category: "invalid_input", message: `unknown command: ${command}` },
					};
				}
				await options.handler(argsOf(input), session.ctx);
				return { ok: true };
			} catch (error) {
				return { ok: false, error: { category: "internal", message: safeMessage(error) } };
			} finally {
				session.dispose();
			}
		},
	};
}
