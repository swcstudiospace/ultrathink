// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ultrathink-runtime-install <install|uninstall|list> --runtime <id|all> [--dry-run] [--global|--local]
 *
 * Installs the Ultrathink skills and commands into the CLI agents of the runtime registry, converted to each agent's
 * layout, or removes exactly what an earlier install wrote. `--runtime all` installs only into agents whose config
 * root already exists. `list` shows every runtime with its config root and install state. Exit codes: 0 success,
 * 1 a runtime failed, 2 usage error.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	type EngineOptions,
	installRuntime,
	listRuntimes,
	type RuntimeListing,
	type RuntimeReport,
	uninstallRuntime,
} from "./engine.ts";
import type { EnvMap, InstallScope } from "./plan.ts";
import { RUNTIMES } from "./runtimes.ts";
import type { RuntimeDescriptor } from "./types.ts";

/** Everything the CLI reads from its environment, injected so tests run against a scratch home. */
export interface CliDeps {
	readonly runtimes: readonly RuntimeDescriptor[];
	readonly cloneRoot: string;
	readonly home: string;
	readonly cwd: string;
	readonly env: EnvMap;
}

interface CliResult {
	readonly exitCode: 0 | 1 | 2;
	readonly stdout: string;
	readonly stderr: string;
}

interface Parsed {
	readonly command: "install" | "uninstall" | "list";
	readonly runtime: string | undefined;
	readonly scope: InstallScope;
	readonly dryRun: boolean;
}

const USAGE =
	"usage: ultrathink-runtime-install <install|uninstall|list> --runtime <id|all> [--dry-run] [--global|--local]";

/** Parses the arguments; a string is the reason they are invalid. */
function parseArgs(argv: readonly string[]): Parsed | string {
	const [command, ...rest] = argv;
	if (command !== "install" && command !== "uninstall" && command !== "list") {
		return command === undefined ? "missing command" : `unknown command: ${command}`;
	}
	let runtime: string | undefined;
	let scope: InstallScope | undefined;
	let dryRun = false;
	let index = 0;
	while (index < rest.length) {
		const arg = rest[index] ?? "";
		index += 1;
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--global" || arg === "--local") {
			const requested = arg === "--global" ? "global" : "local";
			if (scope !== undefined && scope !== requested) return "--global and --local are exclusive";
			scope = requested;
		} else if (arg === "--runtime" || arg.startsWith("--runtime=")) {
			const value = arg === "--runtime" ? rest[index++] : arg.slice("--runtime=".length);
			if (value === undefined || value === "" || value.startsWith("--")) {
				return "--runtime needs a value";
			}
			if (runtime !== undefined) return "--runtime given twice";
			runtime = value;
		} else {
			return `unknown argument: ${arg}`;
		}
	}
	if (runtime === undefined && command !== "list") return "--runtime is required";
	return { command, runtime, scope: scope ?? "global", dryRun };
}

/**
 * Runs one command. Output goes to the returned streams, never to the process, so the caller decides where it lands.
 */
export async function runRuntimeInstallCli(
	argv: readonly string[],
	deps: CliDeps,
): Promise<CliResult> {
	if (argv[0] === "--help" || argv[0] === "-h") {
		return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
	}
	const parsed = parseArgs(argv);
	if (typeof parsed === "string") return usageError(parsed);
	const options: EngineOptions = {
		runtimes: deps.runtimes,
		cloneRoot: deps.cloneRoot,
		home: deps.home,
		cwd: deps.cwd,
		env: deps.env,
		scope: parsed.scope,
		runtime: parsed.runtime ?? "all",
		dryRun: parsed.dryRun,
	};
	try {
		if (parsed.command === "list") {
			const listed = await listRuntimes(options);
			if (listed.kind === "unknown-runtime") return usageError(listed.message);
			return { exitCode: 0, stdout: formatListing(listed.items), stderr: "" };
		}
		const run = parsed.command === "install" ? installRuntime : uninstallRuntime;
		const outcome = await run(options);
		if (outcome.kind === "unknown-runtime") return usageError(outcome.message);
		const failed = outcome.items.some((item) => item.status === "failed");
		return { exitCode: failed ? 1 : 0, stdout: formatReports(outcome.items), stderr: "" };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { exitCode: 1, stdout: "", stderr: `ultrathink-runtime-install: ${reason}\n` };
	}
}

function usageError(reason: string): CliResult {
	return { exitCode: 2, stdout: "", stderr: `${USAGE}: ${reason}\n` };
}

function formatReports(reports: readonly RuntimeReport[]): string {
	const lines: string[] = [];
	for (const item of reports) {
		const where = item.configRoot === undefined ? "" : ` (${item.configRoot})`;
		lines.push(`${item.runtime}: ${item.status}${where}`);
		for (const change of item.changes) lines.push(`  ${change.action} ${change.path}`);
		for (const note of item.notes) {
			lines.push(`  ${item.status === "failed" ? "error" : "note"}: ${note}`);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function formatListing(items: readonly RuntimeListing[]): string {
	const rows = items.map((item) => {
		const drift = [
			item.missing > 0 ? `${item.missing} missing` : "",
			item.modified > 0 ? `${item.modified} modified` : "",
		].filter((part) => part !== "");
		const state = item.installed
			? `installed, ${item.files} files${drift.length > 0 ? `, ${drift.join(", ")}` : ""}`
			: "not installed";
		return [
			item.runtime,
			item.label,
			item.scopeSupport,
			item.detected ? "detected" : "not detected",
			state,
		];
	});
	const widths = [0, 1, 2, 3, 4].map((column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	);
	const lines = rows.map((row, index) => {
		const item = items[index];
		const cells = row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
		return `${cells}  ${item?.configRoot ?? item?.note ?? "-"}`;
	});
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const result = await runRuntimeInstallCli(argv, {
		runtimes: RUNTIMES,
		cloneRoot: resolve(import.meta.dir, "..", ".."),
		home: homedir(),
		cwd: process.cwd(),
		env: process.env,
	});
	if (result.stdout !== "") process.stdout.write(result.stdout);
	if (result.stderr !== "") process.stderr.write(result.stderr);
	return result.exitCode;
}

if (import.meta.main) {
	process.exitCode = await main();
}
