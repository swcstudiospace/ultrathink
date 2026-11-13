// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK_SCRIPT = "hooks/muse-prompt";
const SESSION_ID = "muse-prompt-test-session-1";
const HOOK_BUDGET_MS = 120_000;

interface MuseHook {
	id: string;
	event: string;
	command: string[];
	timeoutMs: number;
}

function readUserPromptSubmitHook(): MuseHook {
	const manifest = JSON.parse(readFileSync(join(ROOT, ".muse-plugin/plugin.json"), "utf8")) as {
		capabilities: { hooks: MuseHook[] };
	};
	const hook = manifest.capabilities.hooks.find((entry) => entry.id === "user-prompt-submit");
	if (!hook) throw new Error("the Muse manifest registers no user-prompt-submit hook");
	return hook;
}

describe("Muse UserPromptSubmit hook", () => {
	test("the manifest registers hooks/muse-prompt for UserPromptSubmit, and its launcher is executable", () => {
		expect(readUserPromptSubmitHook()).toMatchObject({
			event: "UserPromptSubmit",
			command: ["sh", HOOK_SCRIPT],
			timeoutMs: 600000,
		});
		expect(existsSync(join(ROOT, HOOK_SCRIPT))).toBe(true);
		// hooks/muse-prompt execs bin/run-bun directly; without the execute bit the hook silently does nothing.
		expect(statSync(join(ROOT, "bin/run-bun")).mode & 0o111).not.toBe(0);
	});

	test(
		"a sample UserPromptSubmit payload emits hookSpecificOutput context and writes the plan record",
		() => {
			const home = mkdtempSync(join(tmpdir(), "ut-muse-prompt-"));
			try {
				const [program, ...args] = readUserPromptSubmitHook().command;
				if (!program) throw new Error("the hook command is empty");
				const run = spawnSync(program, args, {
					// Muse runs the registered command from the plugin root.
					cwd: ROOT,
					input: JSON.stringify({
						session_id: SESSION_ID,
						cwd: home,
						transcript_path: join(home, "no-transcript.jsonl"),
						hook_event_name: "UserPromptSubmit",
						prompt: "Plan a small change: add a README line.",
					}),
					encoding: "utf8",
					// Keyless: no API key, and no `muse` on PATH, so the planning engine fails without calling a model.
					env: { PATH: "/usr/bin:/bin", HOME: home, BUN: process.execPath },
					timeout: HOOK_BUDGET_MS,
				});
				expect(run.error).toBeUndefined();
				expect(run.status).toBe(0);

				const output = JSON.parse(run.stdout) as {
					hookSpecificOutput: { hookEventName: string; additionalContext: string };
				};
				expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
				expect(output.hookSpecificOutput.additionalContext).toContain("## Prompt Uplift");

				const stateDir = join(home, ".config", "muse", "ultrathink");
				const specPath = join(stateDir, "sessions", `${SESSION_ID}.xml`);
				expect(output.hookSpecificOutput.additionalContext).toContain(specPath);
				expect(existsSync(specPath)).toBe(true);

				const record = JSON.parse(
					readFileSync(join(stateDir, `last-plan.${SESSION_ID}.json`), "utf8"),
				) as { host: string; sessionId: string; specPath: string };
				expect(record).toMatchObject({ host: "muse", sessionId: SESSION_ID, specPath });
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
		HOOK_BUDGET_MS,
	);
});
