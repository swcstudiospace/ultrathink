// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Conformance subject for the Hermes plugin entry point. Declared commands are the names that hosts/hermes/__init__.py
 * registers through ctx.register_command, read when the subject is created: each plain string first argument, plus
 * ultrathink-<verb> for every verb of its COMMANDS table, since the loop that registers the verbs passes an f-string.
 * bridge.py holds no registrations, so it is not read. Hermes has no per-command file, so invoke re-reads __init__.py
 * and checks that the name is still registered there. It never runs Hermes or the bridge.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceSubject } from "./suite.ts";

const REGISTRATION_FILE = join(import.meta.dir, "..", "hosts", "hermes", "__init__.py");
// A Python string literal in either quote style. Backslash escapes stay inside it, so an escaped quote never ends it.
const LITERAL_REGISTRATION =
	/register_command\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g;
// The loop that registers each COMMANDS verb: register_command(f"ultrathink-{verb}", ...).
const VERB_REGISTRATION = /register_command\(\s*f"ultrathink-\{verb\}"/;
const COMMANDS_TABLE = /^COMMANDS\b[^=\n]*=\s*\{([\s\S]*?)^\}/m;
const TABLE_KEY = /^\s*"([^"\\\n]+)"\s*:/gm;

/** Names registered through ctx.register_command in the Hermes registration source, sorted and unique. */
function registeredNames(source: string): string[] {
	const names = new Set<string>();
	for (const match of source.matchAll(LITERAL_REGISTRATION)) {
		const name = match[1] ?? match[2];
		if (name) {
			names.add(name);
		}
	}
	if (VERB_REGISTRATION.test(source)) {
		const table = COMMANDS_TABLE.exec(source)?.[1] ?? "";
		for (const match of table.matchAll(TABLE_KEY)) {
			if (match[1]) {
				names.add(`ultrathink-${match[1]}`);
			}
		}
	}
	return [...names].sort();
}

/** Whether the registration file, re-read now, still registers `command`. */
function stillRegistered(command: string): boolean {
	if (!existsSync(REGISTRATION_FILE)) {
		return false;
	}
	return registeredNames(readFileSync(REGISTRATION_FILE, "utf8")).includes(command);
}

export function createHermesSubject(): ConformanceSubject {
	const commands = registeredNames(readFileSync(REGISTRATION_FILE, "utf8"));
	if (commands.length === 0) {
		throw new Error(`${REGISTRATION_FILE}: no ctx.register_command names found`);
	}
	const declared = new Set(commands);

	return {
		name: "Hermes plugin command entry point",
		capabilities: {
			supports_slash_commands: true,
			supports_skills: false,
			supports_hooks: true,
			supports_subagents: false,
			supports_persistent_state: false,
			supports_interactive_prompts: false,
		},
		commands,
		// Input and correlation ids are not used: invoke executes nothing, it only re-reads the registration file.
		invoke: async (command) => {
			if (!declared.has(command)) {
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${command}` },
				};
			}
			if (!stillRegistered(command)) {
				return {
					ok: false,
					error: { category: "internal", message: "command registration missing" },
				};
			}
			return { ok: true };
		},
	};
}
