// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Conformance subject for the Claude Code plugin. Its declared commands are the `*.md` files in the repo's commands/
 * directory, read when the subject is created. invoke executes nothing: it only checks that the command's file
 * commands/<name>.md exists on disk. The hooks capability is checked the same way, against hooks/hooks.json.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceSubject } from "./suite.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const COMMANDS_DIR = join(REPO_ROOT, "commands");
const HOOKS_FILE = join(REPO_ROOT, "hooks", "hooks.json");
const COMMAND_EXTENSION = ".md";

/** Names of the `*.md` files in commands/, without the extension, sorted. */
function readCommandNames(): string[] {
	const names = readdirSync(COMMANDS_DIR)
		.filter((file) => file.endsWith(COMMAND_EXTENSION))
		.map((file) => file.slice(0, -COMMAND_EXTENSION.length))
		.sort();
	if (names.length === 0) {
		throw new Error(`${COMMANDS_DIR}: no ${COMMAND_EXTENSION} command files`);
	}
	return names;
}

export function createClaudeCodeSubject(): ConformanceSubject {
	const commands = readCommandNames();
	if (!existsSync(HOOKS_FILE)) {
		throw new Error(`${HOOKS_FILE} missing`);
	}
	const declared = new Set(commands);

	return {
		name: "Claude Code plugin entry points",
		capabilities: {
			supports_slash_commands: true,
			supports_skills: true,
			supports_hooks: true,
			supports_subagents: false,
			supports_persistent_state: false,
			supports_interactive_prompts: false,
		},
		commands,
		// Input and correlation ids are not used: invoke executes nothing, it only checks the command file.
		invoke: async (command) => {
			if (!declared.has(command)) {
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${command}` },
				};
			}
			if (!existsSync(join(COMMANDS_DIR, `${command}${COMMAND_EXTENSION}`))) {
				return { ok: false, error: { category: "internal", message: "command file missing" } };
			}
			return { ok: true };
		},
	};
}
