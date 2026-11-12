// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Conformance subject for the Grok Build plugin entry point. Grok Build loads this repo through its Claude-format
 * manifest fallback. The repo has no .grok/ plugin folder for ultrathink, so this subject never reads .grok/.
 * Commands are the *.md files in commands/, read when the subject is created. invoke runs nothing and does not run
 * Grok Build: it only checks that the declared command's commands/<name>.md file still exists on disk.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceSubject } from "./suite.ts";

const COMMANDS_DIR = join(import.meta.dir, "..", "commands");
const MARKDOWN_FILE = /^(.+)\.md$/;

/** Command names: each *.md file name in commands/ without its extension, sorted. */
function readCommandNames(): string[] {
	const names = readdirSync(COMMANDS_DIR)
		.map((entry) => MARKDOWN_FILE.exec(entry)?.[1])
		.filter((name): name is string => name !== undefined)
		.sort();
	if (names.length === 0) {
		throw new Error(`${COMMANDS_DIR}: no *.md command files`);
	}
	return names;
}

export function createGrokBuildSubject(): ConformanceSubject {
	const commands = readCommandNames();
	const declared = new Set(commands);

	return {
		name: "Grok Build plugin command entry point",
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
			if (!existsSync(join(COMMANDS_DIR, `${command}.md`))) {
				return { ok: false, error: { category: "internal", message: "command file missing" } };
			}
			return { ok: true };
		},
	};
}
