// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Conformance subject for the Prime Agent skill entry point. Prime Agent has no prompt or command hook, so skills are
 * its only workflow entry. Commands are the `/ultrathink-*` rows of the Controls table in hosts/prime-agent/SKILL.md,
 * read when the subject is created; each one's skill file is hosts/prime-agent/commands/<name>/SKILL.md. invoke runs
 * nothing: it only checks that the skill file exists on disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceSubject } from "./suite.ts";

const PRIME_AGENT_DIR = join(import.meta.dir, "..", "hosts", "prime-agent");
const SKILL_FILE = join(PRIME_AGENT_DIR, "SKILL.md");
const CONTROLS_HEADING = "## Controls";
const CONTROL_TOKEN = /\/ultrathink-[a-z-]+/g;

/** Names of the `/ultrathink-*` commands in the Controls table of SKILL.md, sorted. */
function readControlCommands(): string[] {
	const lines = readFileSync(SKILL_FILE, "utf8").split("\n");
	const start = lines.findIndex((line) => line.startsWith(CONTROLS_HEADING));
	if (start === -1) {
		throw new Error(`${SKILL_FILE}: no "${CONTROLS_HEADING}" section`);
	}
	const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	const section = lines.slice(start, next === -1 ? undefined : next);
	const names = new Set<string>();
	for (const line of section) {
		if (!line.startsWith("|")) {
			continue;
		}
		for (const token of line.match(CONTROL_TOKEN) ?? []) {
			names.add(token.slice(1));
		}
	}
	if (names.size === 0) {
		throw new Error(`${SKILL_FILE}: Controls table maps no /ultrathink-* command`);
	}
	return [...names].sort();
}

export function createPrimeAgentSkillSubject(): ConformanceSubject {
	const commands = readControlCommands();
	const declared = new Set(commands);

	return {
		name: "Prime Agent skill entry point",
		capabilities: {
			supports_skills: true,
			supports_slash_commands: false,
			supports_hooks: false,
			supports_subagents: true,
			supports_persistent_state: true,
			supports_interactive_prompts: false,
		},
		commands,
		// Input and correlation ids are not used: invoke executes nothing, it only checks the skill file.
		invoke: async (command) => {
			if (!declared.has(command)) {
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${command}` },
				};
			}
			if (!existsSync(join(PRIME_AGENT_DIR, "commands", command, "SKILL.md"))) {
				return { ok: false, error: { category: "internal", message: "skill file missing" } };
			}
			return { ok: true };
		},
	};
}
