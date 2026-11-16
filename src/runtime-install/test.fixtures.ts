// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeDescriptor } from "./types.ts";

/** A descriptor with every field filled in; the tests override what they exercise. */
export function runtime(
	overrides: Partial<RuntimeDescriptor> & Pick<RuntimeDescriptor, "id">,
): RuntimeDescriptor {
	return {
		label: overrides.id,
		gsdFlag: `--${overrides.id}`,
		configRoot: { env: [], defaults: [`~/.${overrides.id}`, `./.${overrides.id}`] },
		layout: "skills",
		skillsDir: "skills",
		commandSuffix: ".md",
		hooks: "none",
		scope: "both",
		gating: "unverified",
		modelRouting: "unverified",
		sources: ["test fixture"],
		...overrides,
	};
}

export const SKILLS = runtime({ id: "fx-skills" });
const BOTH = runtime({
	id: "fx-both",
	layout: "skills+commands",
	commandsDir: "commands",
});
const TOML = runtime({
	id: "fx-toml",
	layout: "commands",
	skillsDir: undefined,
	commandsDir: "prompts",
	commandSuffix: ".toml",
});
const WORKFLOWS = runtime({
	id: "fx-wf",
	layout: "workflows",
	skillsDir: undefined,
	commandsDir: "workflows",
	scope: "workspace",
	configRoot: { env: [], defaults: ["./.fx-wf"] },
});
const GLOBAL_ONLY = runtime({
	id: "fx-global",
	scope: "global",
	configRoot: { env: ["FX_GLOBAL_DIR"], defaults: ["~/.fx-global"] },
});
export const REGISTRY = [SKILLS, BOTH, TOML, WORKFLOWS, GLOBAL_ONLY];

export const PLAN_SOURCE =
	"---\nname: ultrathink-plan\ndescription: Plan things.\n---\n\n# Plan\n\nBody.\n";

export function put(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/**
 * A scratch tree under the home directory: a fake home, a clone holding two skills, two commands and decoys the
 * installer must ignore, and a workspace. The caller removes `scratch`.
 */
export function scratchTree(): {
	readonly scratch: string;
	readonly home: string;
	readonly clone: string;
	readonly cwd: string;
} {
	const scratch = mkdtempSync(join(homedir(), "ultrathink-runtime-install-test-"));
	const home = join(scratch, "home");
	const clone = join(scratch, "clone");
	const cwd = join(scratch, "work");
	for (const dir of [home, clone, cwd]) mkdirSync(dir, { recursive: true });
	put(join(clone, "skills/ultrathink-plan/SKILL.md"), PLAN_SOURCE);
	put(
		join(clone, "skills/ultrathink-teach/SKILL.md"),
		'---\nname: ultrathink-teach\ndescription: "Teach: lessons"\n---\n\n# Teach\n',
	);
	put(
		join(clone, "commands/ultrathink-off.md"),
		"---\nname: ultrathink-off\ndescription: Turn it off\n---\n\nRun off $ARGUMENTS\n",
	);
	put(
		join(clone, "commands/ultrathink-on.md"),
		"---\nname: ultrathink-on\ndescription: Turn it on\n---\n\nRun on\n",
	);
	put(join(clone, "skills/other-skill/SKILL.md"), "not ours\n");
	put(join(clone, "skills/ultrathink-empty/.keep"), "");
	put(join(clone, "commands/README.md"), "not a command\n");
	return { scratch, home, clone, cwd };
}
