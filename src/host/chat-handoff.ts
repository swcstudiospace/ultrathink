// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * onCancel -> handoff file writer for chat/session sync cards (SPE-37787, n4).
 *
 * A cancelled card must never be dropped: cancelling appends one JSON line per cancelled wave/node pair to
 * the handoff file, synchronously, so the entry is on disk before the cancel path returns. The consumer
 * (`consumeChatSyncNoDrop`) reads the file back from disk alone and returns the entries — after a kill the
 * gate `consumeChatSyncNoDrop(path) !== null` still holds, because durability comes from the file, never
 * from process memory. Every entry carries both `wave_id` and `node_id`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../shared.ts";

/** One cancelled card entry: never dropped, always carrying both the wave and the node. */
export interface ChatCancelEntry {
	wave_id: string;
	node_id: string;
	graphId?: string;
	sessionId?: string;
	kind?: "direct" | "managed";
	reason: "cancel";
	at: number;
}

/**
 * Appends one cancel entry to the handoff file and returns it. The write is synchronous (the parent
 * directory is created as needed), so the entry survives a kill the moment this call returns.
 */
export function onChatCancel(
	handoffPath: string,
	input: {
		wave_id: string;
		node_id: string;
		graphId?: string;
		sessionId?: string;
		kind?: "direct" | "managed";
		at?: number;
	},
): ChatCancelEntry {
	if (!input.wave_id || !input.node_id)
		throw new TypeError("onChatCancel requires both wave_id and node_id");
	const entry: ChatCancelEntry = {
		wave_id: input.wave_id,
		node_id: input.node_id,
		...(input.graphId ? { graphId: input.graphId } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.kind ? { kind: input.kind } : {}),
		reason: "cancel",
		at: input.at ?? Date.now(),
	};
	mkdirSync(dirname(handoffPath), { recursive: true });
	appendFileSync(handoffPath, `${JSON.stringify(entry)}\n`, "utf8");
	return entry;
}

/**
 * Consumes the handoff file: all valid entries, in write order. Returns `null` only when no handoff was
 * ever written (missing or unreadable file); a file holding entries always yields them, even after the
 * writing process died — that non-null result after kill is the no-drop gate.
 */
export function consumeChatSyncNoDrop(handoffPath: string): ChatCancelEntry[] | null {
	let text: string;
	try {
		if (!existsSync(handoffPath)) return null;
		text = readFileSync(handoffPath, "utf8");
	} catch {
		return null;
	}
	return parseChatHandoff(text);
}

/** Parses handoff lines defensively: blank and malformed lines are skipped, never fatal. */
export function parseChatHandoff(text: string): ChatCancelEntry[] {
	const entries: ChatCancelEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (typeof parsed.wave_id !== "string" || parsed.wave_id === "") continue;
		if (typeof parsed.node_id !== "string" || parsed.node_id === "") continue;
		entries.push({
			wave_id: parsed.wave_id,
			node_id: parsed.node_id,
			...(typeof parsed.graphId === "string" ? { graphId: parsed.graphId } : {}),
			...(typeof parsed.sessionId === "string" ? { sessionId: parsed.sessionId } : {}),
			...(parsed.kind === "direct" || parsed.kind === "managed" ? { kind: parsed.kind } : {}),
			reason: "cancel",
			at: typeof parsed.at === "number" ? parsed.at : 0,
		});
	}
	return entries;
}
