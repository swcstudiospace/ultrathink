// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `bin/ultrathink doctor [--json]`: a static, offline diagnosis of the config files, the credentials the enabled features
 * need, the inference route (claude CLI version and plan login, Grok login), the state directory and the runtime. It
 * sends nothing anywhere and starts no `gh` or `curl`; the only other processes are the Python and `claude --version` /
 * `claude auth status --json` probes, which read local state. The live probes (`ultrathink-mcp check`,
 * `decisions check`, `hindsight check`, `ragflow check`) stay separate commands.
 */
import { checkConfig } from "./config-check.ts";
import { checkCredentials, checkRuntime } from "./env-check.ts";
import { checkInference } from "./inference-check.ts";
import { checkPstack } from "./pstack-check.ts";
import { buildReport, formatReport, reportJson } from "./report.ts";
import { checkState } from "./state-check.ts";
import { checkTeach } from "./teach-check.ts";
import type { DoctorDeps, DoctorSection, Finding, PythonCommand } from "./types.ts";

const USAGE = "Usage: ultrathink doctor [--json]";
const VERSION_TIMEOUT_MS = 3_000;
const CLAUDE_PROBE_TIMEOUT_MS = 8_000;

/** Stdout of `claude <args>`, or undefined when the CLI cannot run or printed nothing. A logged-out status exits non-zero but still prints its JSON. */
function runClaude(args: string[], env: Record<string, string | undefined>): string | undefined {
	try {
		const proc = Bun.spawnSync(["claude", ...args], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			timeout: CLAUDE_PROBE_TIMEOUT_MS,
		});
		return proc.stdout.toString().trim() || undefined;
	} catch {
		// reason: a missing or hanging claude is the answer; the check reports it as absent.
		return undefined;
	}
}

/** First line of `<command> --version` (Python 2 prints it on stderr), or undefined when the command cannot run. */
function runVersion(command: PythonCommand): string | undefined {
	try {
		const proc = Bun.spawnSync([command, "--version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: VERSION_TIMEOUT_MS,
		});
		if (proc.exitCode !== 0) return undefined;
		const text = proc.stdout.toString().trim() || proc.stderr.toString().trim();
		return text.split("\n")[0] || undefined;
	} catch {
		return undefined;
	}
}

function productionDeps(): DoctorDeps {
	return {
		env: process.env,
		cwd: process.cwd(),
		now: Date.now,
		which: (command) => Bun.which(command) ?? undefined,
		bunVersion: Bun.version,
		runVersion,
		claudeVersion: () => runClaude(["--version"], process.env)?.split("\n")[0],
		claudeAuth: (env) => runClaude(["auth", "status", "--json"], env),
	};
}

/** A check that throws is itself a finding, so one bad probe never hides the others. */
function guarded(
	section: DoctorSection,
	check: (deps: DoctorDeps) => Finding[],
	deps: DoctorDeps,
): Finding[] {
	try {
		return check(deps);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [
			{
				id: `${section}.internal`,
				section,
				level: "error",
				title: `the ${section} check failed to run`,
				detail: message,
			},
		];
	}
}

/** Never rejects. exitCode 0 when no finding is an error, 1 when one is, 2 for a usage error. `output` has no trailing newline. */
export async function runDoctorCommand(
	args: string[],
	overrides: Partial<DoctorDeps> = {},
): Promise<{ output: string; exitCode: number }> {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") json = true;
		else return { output: USAGE, exitCode: 2 };
	}
	const deps: DoctorDeps = { ...productionDeps(), ...overrides };
	const report = buildReport([
		...guarded("runtime", checkRuntime, deps),
		...guarded("config", checkConfig, deps),
		...guarded("credentials", checkCredentials, deps),
		...guarded("inference", checkInference, deps),
		...guarded("state", checkState, deps),
		...guarded("memory", checkTeach, deps),
		...guarded("pstack", checkPstack, deps),
	]);
	return { output: json ? reportJson(report) : formatReport(report), exitCode: report.ok ? 0 : 1 };
}
