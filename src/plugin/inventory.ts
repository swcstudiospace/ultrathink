// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** GSD-Core CLI-installable runtime ids. vscode is excluded. gemini is retired. omp is not in the set. */
export const CLI_RUNTIME_IDS: readonly string[] = [
	"claude",
	"codex",
	"antigravity",
	"opencode",
	"kilo",
	"kimi",
	"copilot",
	"cursor",
	"windsurf",
	"cline",
	"codebuddy",
	"qwen",
	"augment",
	"trae",
	"zcode",
	"pi",
	"hermes",
	"kimi-code",
];

const REQUIRED = new Set(CLI_RUNTIME_IDS);

export type RuntimeEntry =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "pi-extensions"; readonly path: string };

const file = (path: string): RuntimeEntry => ({ kind: "file", path });

/**
 * Repo-relative evidence per required runtime id (docs/architecture/tab6a-blueprint.md section 6).
 * claude is detected through its claude-code adapter directory. pi is detected only by a pi.extensions key in package.json; omp never counts.
 */
export const CLI_RUNTIME_ENTRIES: Readonly<Record<string, readonly RuntimeEntry[]>> = {
	claude: [file(".claude-plugin/plugin.json"), file("adapters/claude-code/index.ts")],
	codex: [file("adapters/codex/index.ts")],
	antigravity: [file("adapters/antigravity/index.ts")],
	opencode: [file("adapters/opencode/index.ts")],
	kilo: [file("adapters/kilo/index.ts")],
	kimi: [file("adapters/kimi/index.ts")],
	copilot: [file("adapters/copilot/index.ts")],
	cursor: [file(".cursor-plugin/plugin.json"), file("hosts/cursor")],
	windsurf: [file("adapters/windsurf/index.ts")],
	cline: [file("adapters/cline/index.ts")],
	codebuddy: [file("adapters/codebuddy/index.ts")],
	qwen: [file("adapters/qwen/index.ts")],
	augment: [file("adapters/augment/index.ts")],
	trae: [file("adapters/trae/index.ts")],
	zcode: [file("adapters/zcode/index.ts")],
	pi: [{ kind: "pi-extensions", path: "package.json" }],
	hermes: [file("hosts/hermes/plugin.yaml"), file("adapters/hermes/index.ts")],
	"kimi-code": [file("adapters/kimi-code/index.ts")],
};

/** The single connected rule: a required id with at least one loaded entry. */
export function isConnected(runtimeId: string, loaded: Record<string, number>): boolean {
	return REQUIRED.has(runtimeId) && (loaded[runtimeId] ?? 0) >= 1;
}

export type ConnectionStatus = "connected" | "missing" | "excluded" | "retired";

export interface ConnectionLine {
	runtimeId: string;
	status: "connected" | "missing";
	code?: "PLUGIN_AGENT_MISSING";
}

export interface ConnectionInventory {
	requiredCount: 18;
	lines: ConnectionLine[];
}

export interface ConnectionResult {
	runtimeId: string;
	status: ConnectionStatus;
	requiredCount: 18;
	code?: "GSD_RETIRED_RUNTIME" | "PLUGIN_AGENT_MISSING";
}

/** One line per required id. vscode never appears. requiredCount is always 18. */
export function listConnections(loaded: Record<string, number>): ConnectionInventory {
	return {
		requiredCount: 18,
		lines: CLI_RUNTIME_IDS.map((runtimeId) => {
			if (isConnected(runtimeId, loaded)) {
				return { runtimeId, status: "connected" };
			}
			return { runtimeId, status: "missing", code: "PLUGIN_AGENT_MISSING" };
		}),
	};
}

/**
 * gemini is retired and does not change the required set.
 * vscode and any other non-required id (including omp and the windsurf alias devin-desktop) are excluded.
 * A loaded pi entry does not connect omp, and omp is not required.
 */
export function requestConnection(
	runtimeId: string,
	loaded: Record<string, number>,
): ConnectionResult {
	if (runtimeId === "gemini") {
		return { runtimeId, status: "retired", requiredCount: 18, code: "GSD_RETIRED_RUNTIME" };
	}
	if (!REQUIRED.has(runtimeId)) {
		return { runtimeId, status: "excluded", requiredCount: 18 };
	}
	if (isConnected(runtimeId, loaded)) {
		return { runtimeId, status: "connected", requiredCount: 18 };
	}
	return { runtimeId, status: "missing", requiredCount: 18, code: "PLUGIN_AGENT_MISSING" };
}

/** Counts, per required id, the entries that exist under root. Pi counts only when package.json declares pi.extensions. */
export function detectLoaded(root: string): Record<string, number> {
	return Object.fromEntries(
		CLI_RUNTIME_IDS.map((runtimeId): [string, number] => {
			const entries = CLI_RUNTIME_ENTRIES[runtimeId] ?? [];
			return [runtimeId, entries.filter((entry) => entryPresent(root, entry)).length];
		}),
	);
}

function entryPresent(root: string, entry: RuntimeEntry): boolean {
	if (entry.kind === "file") return existsSync(join(root, entry.path));
	return piExtensionsDeclared(join(root, entry.path));
}

function piExtensionsDeclared(manifestPath: string): boolean {
	let manifest: { pi?: { extensions?: unknown } } | null;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return false;
	}
	const extensions = manifest?.pi?.extensions;
	return extensions !== undefined && extensions !== null;
}
