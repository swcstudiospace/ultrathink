// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The `/ultrathink-skills` command over the generated-skill store: list the store, or disable or delete one generated
 * skill by name. It manages skills that already exist and never generates one. Every outcome is one reply text; a store
 * failure is reported with its reason and never thrown.
 */
import { listGenerated, removeGeneratedSkill, setGeneratedStatus } from "./skill-store.ts";

const USAGE = "Usage: /ultrathink-skills [list | disable <name> | delete <name>]";

interface SkillsCommandDeps {
	storeDir: string;
}

/** A store failure as one reply line: its reason and the rule or code that failed. */
function failureText(failure: { reason: string; detail: string }): string {
	return `${failure.reason}: ${failure.detail}`;
}

async function listReply(storeDir: string): Promise<string> {
	const result = await listGenerated(storeDir);
	if (!result.ok) return failureText(result);
	if (result.entries.length === 0) return "No generated skills.";
	return result.entries
		.map(
			(entry) =>
				`${entry.name} · ${entry.status} · v${entry.version}${entry.stale ? " · stale" : ""}`,
		)
		.join("\n");
}

export async function runSkillsCommand(argText: string, deps: SkillsCommandDeps): Promise<string> {
	const [verb, ...args] = argText.split(/\s+/).filter((token) => token !== "");
	if (verb === undefined || verb === "list") {
		return args.length === 0 ? listReply(deps.storeDir) : USAGE;
	}
	const [name, ...extra] = args;
	if (name === undefined || extra.length > 0) return USAGE;
	switch (verb) {
		case "disable": {
			const result = await setGeneratedStatus(deps.storeDir, name, "disabled");
			return result.ok ? `disabled ${result.entry.name}` : failureText(result);
		}
		case "delete": {
			const result = await removeGeneratedSkill(deps.storeDir, name);
			return result.ok ? `deleted ${result.name}` : failureText(result);
		}
		default:
			return USAGE;
	}
}
