// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Greptile account tenant handling, shared by the ship review path and the knowledge reader. A Greptile account that
 * spans several organizations refuses every call until one is chosen; this names that refusal the same way wherever
 * it surfaces.
 */
import { asObj, asStr, parseJson } from "../shared.ts";

/** Organization ids/handles a tenant_required error offers, from a JSON payload or a `candidates: a, b` list. */
function tenantCandidates(message: string): string[] {
	const start = message.indexOf("{");
	const payload = start >= 0 ? asObj(parseJson(message.slice(start))) : undefined;
	const offered = payload?.candidates ?? asObj(payload?.error)?.candidates;
	const listed = Array.isArray(offered) ? offered : [];
	const names = listed
		.map((entry) => asStr(entry) ?? asStr(asObj(entry)?.handle) ?? asStr(asObj(entry)?.id))
		.filter((name): name is string => Boolean(name));
	if (names.length > 0) return names;
	// A truncated JSON payload lands here too: keep only bare ids/handles, never fragments of objects.
	const inline = /candidates["']?\s*[:=]\s*\[?([^\]\n]+)/i.exec(message)?.[1] ?? "";
	return inline
		.split(",")
		.map((name) => name.trim().replace(/^["']|["']$/g, ""))
		.filter((name) => /^[\w.@-]+$/.test(name));
}

/** Actionable reason when Greptile refuses a call because the account spans several organizations and none was chosen. */
export function tenantReason(message: string): string | undefined {
	if (!/tenant_required/i.test(message)) return undefined;
	const candidates = tenantCandidates(message);
	const choose = candidates.length > 0 ? ` (one of: ${candidates.join(", ")})` : "";
	return `Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json${choose}`;
}
