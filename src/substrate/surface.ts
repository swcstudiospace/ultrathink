// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The two places the plugin's idea of a caller meets Substrate's: which bearer
 * a surface sends, and which surface a host is.
 *
 * - {@link resolveSubstrateToken} mirrors `resolveBearer` in
 *   agent-substrate `packages/cli/src/token.ts` (lines 62-77) — same order,
 *   same variable names, same default directory — so one `.env` works across
 *   the stack. Precedence, first hit wins:
 *     1. `SUBSTRATE_TOKEN` (trimmed, non-empty)
 *     2. first line of the file named by `SUBSTRATE_TOKEN_FILE`
 *     3. first line of `<SUBSTRATE_TOKENS_DIR | /etc/substrate/tokens>/<surface>`
 *        (the surface is validated before it is joined to a path)
 *     4. no bearer (null)
 *   Any read problem means null (fail-open); the value is never logged and
 *   never leaves this module except as the return value.
 * - {@link hostToSurface} is the one host-to-surface boundary the brief and
 *   the event path share. `prime-agent` is not a Substrate surface.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** Built-in tokens directory, used when `SUBSTRATE_TOKENS_DIR` names none. */
const DEFAULT_TOKENS_DIR = "/etc/substrate/tokens";

/** A token file holds one short value; anything larger is not one. */
const MAX_TOKEN_FILE_BYTES = 4096;

/** Caller-controlled surfaces are validated before they are joined to a path (token.ts line 25). */
const SURFACE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Whether a string has the shape of a Substrate surface name (also the filename rule for per-surface tokens). */
export function isSurfaceName(value: string): boolean {
	return SURFACE_NAME.test(value);
}

/**
 * Substrate's surface vocabulary, copied from agent-substrate
 * `packages/mcp-server/src/types.ts` lines 11-62 (`SWARM_SURFACES` and `SURFACES`).
 */
export const SUBSTRATE_SURFACES = [
	"claude-code",
	"cursor",
	"hermes",
	"omp",
	"muse",
	"grok-build",
	"grok-bot",
	"codex",
	"opencode",
	"pi",
	"rivet-agentos",
	"swarm-a01-orch",
	"swarm-a02-req",
	"swarm-a03-arch",
	"swarm-a04-uxd",
	"swarm-a05-be",
	"swarm-a06-fe",
	"swarm-a07-data",
	"swarm-a08-qa",
	"swarm-a09-rev",
	"swarm-a10-sec",
	"swarm-a11-devops",
	"swarm-a12-rel",
	"swarm-a13-obs",
	"swarm-a14-maint",
	"swarm-a15-doc",
	"swarm-a16-cloud",
	"swarm-a17-plat",
	"swarm-a18-supply",
	"swarm-a19-event",
	"swarm-a20-finops",
	"swarm-a21-k8s",
	"swarm-a22-gitops",
	"swarm-a23-mesh",
	"swarm-a24-ksec",
	"swarm-a25-resil",
	"swarm-a26-sol",
	"swarm-a27-audit",
	"swarm-a28-chain",
	"swarm-a29-dapp",
	"swarm-a30-custody",
	"substrate",
] as const;

type SubstrateSurface = (typeof SUBSTRATE_SURFACES)[number];

/** The plugin host that has no Substrate surface of its own. */
export const PRIME_AGENT_HOST = "prime-agent";

/** The surface an absent or unknown host is attributed to. */
const DEFAULT_SURFACE: SubstrateSurface = "claude-code";

function isSubstrateSurface(value: string): value is SubstrateSurface {
	return (SUBSTRATE_SURFACES as readonly string[]).includes(value);
}

/**
 * The Substrate surface for a plugin host. A host that is already a surface
 * maps to itself; `prime-agent` (not a surface) maps to `pi`; anything else,
 * including an absent host, maps to `claude-code`.
 */
export function hostToSurface(host: string | undefined): SubstrateSurface {
	if (host === undefined) return DEFAULT_SURFACE;
	if (host === PRIME_AGENT_HOST) return "pi";
	return isSubstrateSurface(host) ? host : DEFAULT_SURFACE;
}

/**
 * The surface to put in an `/events` body, or undefined to send none.
 *
 * D-06 decision: the `/events` route accepts a missing surface — server.ts
 * (line 1171) reads `body.surface` only when it is a string, and
 * `attributedSurface` (mcp.ts line 125) falls back to the token's surface and
 * then `claude-code` before `normalizeEvent` (event.ts lines 231-233) ever
 * validates it. So `prime-agent` sends none and the caller carries
 * `payload.host: "prime-agent"`. Every other host sends {@link hostToSurface}.
 */
export function hostToEventSurface(host: string | undefined): SubstrateSurface | undefined {
	return host === PRIME_AGENT_HOST ? undefined : hostToSurface(host);
}

/**
 * The first line of a file, trimmed, or null when there is nothing usable.
 * Missing paths, directories, oversize or unreadable files and empty first
 * lines all mean null. Never throws, never logs.
 */
function firstLine(path: string): string | null {
	try {
		const info = statSync(path);
		if (!info.isFile() || info.size === 0 || info.size > MAX_TOKEN_FILE_BYTES) return null;
		const buffer = Buffer.alloc(info.size);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, info.size, 0);
		} finally {
			closeSync(fd);
		}
		const line = buffer.toString("utf8").split("\n", 1)[0]?.trim() ?? "";
		return line ? line : null;
	} catch {
		return null;
	}
}

/**
 * The bearer for a surface, or null when none is configured. `read` is the
 * injectable file seam (first line of a path, or null).
 */
export function resolveSubstrateToken(
	env: Record<string, string | undefined>,
	surface: string,
	read: (path: string) => string | null = firstLine,
): string | null {
	const direct = env.SUBSTRATE_TOKEN?.trim();
	if (direct) return direct;
	const file = env.SUBSTRATE_TOKEN_FILE?.trim();
	if (file) {
		const viaFile = read(file);
		if (viaFile) return viaFile;
	}
	if (!SURFACE_NAME.test(surface)) return null;
	const dir = env.SUBSTRATE_TOKENS_DIR?.trim() || DEFAULT_TOKENS_DIR;
	return read(join(dir, surface));
}
