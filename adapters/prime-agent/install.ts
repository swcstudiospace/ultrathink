// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Installs the ultrathink skill into a Prime-Agent skills root. The skill manifest and the command
 * skills are read from the repo's hosts/prime-agent directory and handed to the host-neutral install
 * engine. The caller supplies the skills root, so this module reads neither the home directory nor
 * the environment.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type InstallResult, installPlugin } from "../install.ts";

export interface PrimeAgentSkillOptions {
	/** Prime-Agent skills root, with `~` already expanded: `<home>/.prime/agent/skills`. */
	readonly skillsDir: string;
	/** Repo root that contains `hosts/prime-agent`. */
	readonly sourceDir: string;
}

/** Directory name of the installed skill under the skills root. */
const SKILL_NAME = "ultrathink";
/** Skill manifest; the only file the install requires. */
const SKILL_FILE = "SKILL.md";
/** Host source directory, relative to the repo root. */
const HOST_SOURCE = join("hosts", "prime-agent");
/** Command skills live in `commands/<name>/SKILL.md`; only names with this prefix count. */
const COMMANDS_DIR = "commands";
const COMMAND_PREFIX = "ultrathink-";

const SOURCE_ACTION = "Make the hosts/prime-agent sources readable, then rerun the install.";

/**
 * Installs the skill to `<skillsDir>/ultrathink`. Installing identical sources again reports
 * unchanged. A source without SKILL.md fails with install_failed and leaves no target behind.
 */
export async function installPrimeAgentSkill(
	options: PrimeAgentSkillOptions,
): Promise<InstallResult> {
	let files: Map<string, string>;
	try {
		files = await readSkillFiles(join(options.sourceDir, HOST_SOURCE));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: {
				category: "install_failed",
				message: `cannot read Prime-Agent skill sources: ${reason}`,
				nextAction: SOURCE_ACTION,
			},
		};
	}
	return installPlugin({
		targetDir: join(options.skillsDir, SKILL_NAME),
		files,
		requiredFiles: [SKILL_FILE],
	});
}

/**
 * Reads SKILL.md and each commands/<name>/SKILL.md under `hostDir`, keyed by relative path with
 * forward slashes. A missing file is left out so the engine's required-file check reports it.
 */
async function readSkillFiles(hostDir: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const manifest = await readIfPresent(join(hostDir, SKILL_FILE));
	if (manifest !== undefined) files.set(SKILL_FILE, manifest);
	for (const name of await commandNames(join(hostDir, COMMANDS_DIR))) {
		const path = `${COMMANDS_DIR}/${name}/${SKILL_FILE}`;
		const content = await readIfPresent(join(hostDir, path));
		if (content !== undefined) files.set(path, content);
	}
	return files;
}

/** Names of the `commands/` entries with the command prefix. A missing `commands/` has none. */
async function commandNames(commandsDir: string): Promise<string[]> {
	try {
		return (await readdir(commandsDir)).filter((name) => name.startsWith(COMMAND_PREFIX));
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
}

/** Returns the file's text, or undefined when the path does not exist. */
async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

/** A path that does not exist, or that runs through a file, is simply absent. */
function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}
