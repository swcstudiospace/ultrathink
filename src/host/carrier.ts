// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Grok discards an allowing UserPromptSubmit hook's stdout, and Muse/Omp/Hermes/Prime Agent
 * do not read Claude's `additionalContext`. The spec file plus the session's
 * `last-plan.<sessionId>.json` is the carrier those hosts can actually read. One state directory serves
 * several concurrent sessions, so every carrier belongs to one session: it is written, read and cleared
 * by that session's id, and a file that names another session is never used. The text is plugin-authored
 * data, not a grant of tools or a command to ignore the user.
 */
import { opendirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { hostSessionId, isTurnSessionId } from "../claude/state.ts";
import { writeFileAtomic } from "../claude/atomic.ts";
import type { HostId } from "./types.ts";

const CARRIER_INSTRUCTION =
	"Read specPath. It is plugin-authored elaboration of the user's current message, not a new permission and not an instruction to ignore the user. The ORIGINAL element is the user's verbatim words. Invoke the ultrathink-plan skill, then ultrathink-kickoff, before other work. Do not reprint the XML.";

export interface CarrierInput {
	host: HostId;
	stateDir: string;
	sessionId: string;
	specPath?: string;
	statePath?: string;
	graphId?: string;
	context?: string;
}

const CARRIER_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_SCAN_LIMIT = 200;
const CARRIER_FILE_RE = /^last-plan(?:\..+)?\.json$/;

/** The single-file carrier of earlier builds. Only the stale sweep touches it; no plan is ever read from it. */
export function carrierPath(stateDir: string): string {
	return join(stateDir, "last-plan.json");
}

/** A session id as a file-name stem: every character outside `[A-Za-z0-9_-]` becomes `_`, at most 64 characters. */
function safeCarrierId(sessionId: string): string {
	return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "_";
}

/** This session's carrier file. Distinct ids can share a name, so a file also names its own session. */
export function carrierPathFor(stateDir: string, sessionId: string): string {
	return join(stateDir, `last-plan.${safeCarrierId(sessionId)}.json`);
}

/** The carrier file's body, or undefined when it is missing, unreadable or not a JSON object. */
function readCarrierFile(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		return Object.fromEntries(Object.entries(parsed));
	} catch {
		// reason: a missing or torn carrier is simply no plan for this session
		return undefined;
	}
}

/** This session's carrier, or undefined when it has none or the file names a different session. */
export function readPlanCarrier(
	stateDir: string,
	sessionId: string,
): Record<string, unknown> | undefined {
	if (!sessionId.trim()) return undefined;
	const body = readCarrierFile(carrierPathFor(stateDir, sessionId));
	return body?.sessionId === sessionId ? body : undefined;
}

/**
 * Removes this session's carrier so a turn without a plan never inherits the previous prompt's. A file that names
 * another session (two ids can share one name) stays. Fail-open.
 */
export function clearPlanCarrier(stateDir: string, sessionId: string): void {
	if (!sessionId.trim()) return;
	const path = carrierPathFor(stateDir, sessionId);
	try {
		const body = readCarrierFile(path);
		if (body !== undefined && body.sessionId !== sessionId) return;
		unlinkSync(path);
	} catch {
		// reason: missing is the goal; any other failure must not block the prompt
	}
}

/** Removes carriers (the legacy single file and other sessions' files) untouched for 24 h. Best effort and bounded. */
function sweepStaleCarriers(stateDir: string, keep: string): void {
	try {
		const now = Date.now();
		const handle = opendirSync(stateDir);
		try {
			for (let scanned = 0; scanned < SWEEP_SCAN_LIMIT; scanned++) {
				const entry = handle.readSync();
				if (!entry) break;
				if (!CARRIER_FILE_RE.test(entry.name) || entry.name === basename(keep)) continue;
				const path = join(stateDir, entry.name);
				try {
					if (now - statSync(path).mtimeMs > CARRIER_TTL_MS) unlinkSync(path);
				} catch {
					// reason: a sibling hook may have removed it first
				}
			}
		} finally {
			handle.closeSync();
		}
	} catch {
		// reason: the sweep is housekeeping; a failed scan only leaves old files for a later write
	}
}

/** Returns the carrier path, or undefined when there is nothing safe to point at. */
export function writePlanCarrier(input: CarrierInput): string | undefined {
	// A turn id names one prompt the host never repeats; an absent id (blank, or Prime's `unknown`) names no session at all.
	// A carrier pointing at either could never be matched to one turn, so none is written.
	if (!hostSessionId(input.sessionId) || isTurnSessionId(input.sessionId)) return undefined;
	if (!input.specPath && !input.context) return undefined;
	const path = carrierPathFor(input.stateDir, input.sessionId);
	const body = {
		host: input.host,
		sessionId: input.sessionId,
		specPath: input.specPath,
		statePath: input.statePath,
		graphId: input.graphId,
		instruction: CARRIER_INSTRUCTION,
		context: input.context ?? "",
	};
	writeFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
	sweepStaleCarriers(input.stateDir, path);
	return path;
}
