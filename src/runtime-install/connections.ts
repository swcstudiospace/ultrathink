// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/*
 * Connection inventory over the 18 GSD-Core CLI-installable runtime ids.
 * Source: .planning/research/GSD-CORE-RUNTIME-GROUND-TRUTH.md section 1 (bin/install.js flag parser,
 * interactive menu and allRuntimes agree on this set). vscode has no installer flag, gemini is retired,
 * omp is not in the set, and devin-desktop is an alias of windsurf. None of those is a registry id.
 *
 * Pure: the caller supplies loaded-entry counts per id. This module does no filesystem access.
 */

/** GSD-Core CLI-installable runtime ids, in installer menu order. This is the registry. */
export const CONNECTION_RUNTIME_IDS = [
	"claude",
	"antigravity",
	"augment",
	"cline",
	"codebuddy",
	"codex",
	"copilot",
	"cursor",
	"hermes",
	"kimi",
	"kimi-code",
	"kilo",
	"opencode",
	"pi",
	"qwen",
	"trae",
	"windsurf",
	"zcode",
] as const;

export type ConnectionRuntimeId = (typeof CONNECTION_RUNTIME_IDS)[number];

/** Derived from the tuple, so the required count cannot drift from the registry. */
export const REQUIRED_CONNECTION_COUNT = CONNECTION_RUNTIME_IDS.length;

/** Retired id. A connection request returns GSD_RETIRED_RUNTIME; it never joins the registry. */
const RETIRED_RUNTIME_ID = "gemini";

export type ConnectionErrorCode = "GSD_RETIRED_RUNTIME" | "PLUGIN_AGENT_MISSING";

/** Loaded Ultrathink entries per runtime id, supplied by the caller. An absent id counts as 0. */
export type LoadedCounts = Readonly<Record<string, number>>;

export interface ConnectionLine {
	readonly runtime: ConnectionRuntimeId;
	readonly status: "connected" | "missing";
	readonly code?: "PLUGIN_AGENT_MISSING";
}

export interface ConnectionInventory {
	readonly requiredCount: typeof REQUIRED_CONNECTION_COUNT;
	/** One line per registry id, in registry order. Excluded and retired ids never appear. */
	readonly lines: readonly ConnectionLine[];
}

export interface ConnectionRequestResult {
	readonly runtime: string;
	readonly status: "connected" | "missing" | "retired" | "excluded";
	readonly requiredCount: typeof REQUIRED_CONNECTION_COUNT;
	readonly code?: ConnectionErrorCode;
}

export function isRegistryRuntime(runtime: string): runtime is ConnectionRuntimeId {
	return CONNECTION_RUNTIME_IDS.some((id) => id === runtime);
}

/** The single connected rule: a registry id with at least one loaded entry. */
export function isConnected(runtime: ConnectionRuntimeId, loaded: LoadedCounts): boolean {
	return (loaded[runtime] ?? 0) >= 1;
}

function connectionLine(runtime: ConnectionRuntimeId, loaded: LoadedCounts): ConnectionLine {
	if (isConnected(runtime, loaded)) {
		return { runtime, status: "connected" };
	}
	return { runtime, status: "missing", code: "PLUGIN_AGENT_MISSING" };
}

/** One line per registry id. vscode, gemini, omp and devin-desktop never appear. */
export function listConnections(loaded: LoadedCounts): ConnectionInventory {
	return {
		requiredCount: REQUIRED_CONNECTION_COUNT,
		lines: CONNECTION_RUNTIME_IDS.map((runtime) => connectionLine(runtime, loaded)),
	};
}

/**
 * gemini is retired (GSD_RETIRED_RUNTIME) and does not change the required set.
 * Any other non-registry id (vscode, omp, devin-desktop) is excluded and is not scored.
 * A loaded pi entry does not connect omp, because omp is not a registry id.
 */
export function requestConnection(runtime: string, loaded: LoadedCounts): ConnectionRequestResult {
	if (runtime === RETIRED_RUNTIME_ID) {
		return {
			runtime,
			status: "retired",
			requiredCount: REQUIRED_CONNECTION_COUNT,
			code: "GSD_RETIRED_RUNTIME",
		};
	}
	if (!isRegistryRuntime(runtime)) {
		return { runtime, status: "excluded", requiredCount: REQUIRED_CONNECTION_COUNT };
	}
	return { ...connectionLine(runtime, loaded), requiredCount: REQUIRED_CONNECTION_COUNT };
}
