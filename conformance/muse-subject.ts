// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Conformance subject for the Muse plugin. Its declared commands are the ids under capabilities.commands in
 * .muse-plugin/plugin.json, read when the subject is created; each command's file is the `path` given in that manifest,
 * resolved from the repo root. invoke executes nothing: it only checks that the command file exists on disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConformanceSubject } from "./suite.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const MANIFEST_FILE = join(REPO_ROOT, ".muse-plugin", "plugin.json");

interface MuseCommandEntry {
	readonly id: string;
	readonly path: string;
}

interface MuseManifest {
	readonly capabilities?: {
		readonly commands?: readonly MuseCommandEntry[];
	};
}

/** The `capabilities.commands` entries of the Muse manifest. Throws when the manifest declares none. */
function readManifestCommands(): readonly MuseCommandEntry[] {
	const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as MuseManifest;
	const entries = manifest.capabilities?.commands ?? [];
	if (entries.length === 0) {
		throw new Error(`${MANIFEST_FILE}: capabilities.commands declares no commands`);
	}
	return entries;
}

export function createMuseSubject(): ConformanceSubject {
	const entries = readManifestCommands();
	const commands = entries.map((entry) => entry.id);
	const commandFiles = new Map(entries.map((entry) => [entry.id, join(REPO_ROOT, entry.path)]));

	return {
		name: "Muse plugin entry points",
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
			const file = commandFiles.get(command);
			if (file === undefined) {
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${command}` },
				};
			}
			if (!existsSync(file)) {
				return { ok: false, error: { category: "internal", message: "command file missing" } };
			}
			return { ok: true };
		},
	};
}
