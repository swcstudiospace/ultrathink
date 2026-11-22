// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { writeSync } from "node:fs";
import type { ModelResolution } from "./engine.ts";
import type { ActivityNotice } from "./activity-notice.ts";

const STAGE_NAMES = [
	"brief",
	"uplift",
	"think",
	"knowledge",
	"clarify",
	"plan",
	"track",
	"state",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * `modelResolution` on `begin` and `end` is the selection's safe record (§9 path 4), not a new event kind: begin names
 * the selected model, and an unresolved end carries its safe reason even though no begin or inference happened.
 */
export type ProgressEvent =
	/** `track`: planner-side tracking will run this turn. */
	| {
			type: "begin";
			at: number;
			sessionId: string;
			engine: string;
			track?: boolean;
			skill?: string;
			modelResolution?: ModelResolution;
	  }
	| {
			type: "stage";
			at: number;
			stage: StageName;
			phase: "start" | "end";
			ok?: boolean;
			detail?: string;
	  }
	| {
			type: "graph";
			at: number;
			total: number;
			nodes: Array<{ id: string; title: string; kind: string; dependsOn?: string[] }>;
	  }
	| {
			type: "node";
			at: number;
			phase: "start" | "done";
			id: string;
			title: string;
			kind: string;
			index: number;
			total: number;
			fallback?: boolean;
			/** Only on "done": the node's sub-issue titles in step order (step = index + 1). */
			steps?: string[];
	  }
	| {
			type: "track";
			at: number;
			/** Absent when that provider is not configured: it gets no rows and must not be shown. */
			linear?: { nodes: [number, number]; steps: [number, number] };
			notion?: { task: boolean; nodes: [number, number]; steps: [number, number] };
			error?: string;
	  }
	/** One per created or adopted tracker row; `step` absent for the node's own issue. */
	| {
			type: "issue";
			at: number;
			provider: "linear" | "notion";
			nodeId: string;
			step?: number;
			identifier?: string;
			url: string;
	  }
	| { type: "activity"; at: number; notice: ActivityNotice }
	| {
			type: "end";
			at: number;
			outcome: "planned" | "skipped" | "failed";
			detail?: string;
			modelResolution?: ModelResolution;
	  };

export type ProgressSink = (event: ProgressEvent) => void;

const EVENT_TYPES: Record<string, true> = {
	begin: true,
	stage: true,
	graph: true,
	node: true,
	track: true,
	issue: true,
	activity: true,
	end: true,
};

const MAX_WRITE_STALLS = 100;

/** `dropped` counts the events the fd refused: closed, gone, or still full after bounded retries. */
type FdProgressSink = ProgressSink & { readonly dropped: number };

/** Writes all of `buffer` to `fd`: a partial write continues where it stopped, and EAGAIN (a full non-blocking pipe) retries. */
function writeAll(write: typeof writeSync, fd: number, buffer: Buffer): boolean {
	let offset = 0;
	let stalls = 0;
	while (offset < buffer.length) {
		try {
			const written = write(fd, buffer, offset, buffer.length - offset);
			if (written > 0) {
				offset += written;
				stalls = 0;
				continue;
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) return false;
		}
		if (++stalls > MAX_WRITE_STALLS) return false;
	}
	return true;
}

/**
 * Sink writing JSON lines to the fd named by ULTRATHINK_PROGRESS_FD (>= 3). Never touches stdout and never throws: a
 * line the fd refuses is counted in `dropped`. `write` is the test seam for the fd write.
 */
export function createFdProgressSink(
	env: Record<string, string | undefined> = process.env,
	write: typeof writeSync = writeSync,
): FdProgressSink | undefined {
	const raw = env.ULTRATHINK_PROGRESS_FD?.trim();
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const fd = Number(raw);
	if (!Number.isSafeInteger(fd) || fd < 3) return undefined;
	let dropped = 0;
	const sink = (event: ProgressEvent): void => {
		if (!writeAll(write, fd, Buffer.from(`${JSON.stringify(event)}\n`))) dropped++;
	};
	return Object.defineProperty(sink, "dropped", {
		get: () => dropped,
		enumerable: true,
	}) as FdProgressSink;
}

const isNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStageName = (value: unknown): value is StageName =>
	typeof value === "string" && (STAGE_NAMES as readonly string[]).includes(value);

/** The required fields of each event type; optional fields are not checked. An event without its required fields is not progress. */
function hasRequiredFields(type: string, value: Record<string, unknown>): boolean {
	switch (type) {
		case "begin":
			return isString(value.sessionId) && isString(value.engine);
		case "stage":
			return isStageName(value.stage) && (value.phase === "start" || value.phase === "end");
		case "graph":
			return isNumber(value.total) && Array.isArray(value.nodes);
		case "node":
			return (
				(value.phase === "start" || value.phase === "done") &&
				isString(value.id) &&
				isString(value.title) &&
				isString(value.kind) &&
				isNumber(value.index) &&
				isNumber(value.total)
			);
		case "track":
			return true;
		case "issue":
			return (
				(value.provider === "linear" || value.provider === "notion") &&
				isString(value.nodeId) &&
				isString(value.url)
			);
		case "activity":
			return typeof value.notice === "object" && value.notice !== null;
		case "end":
			return (
				value.outcome === "planned" || value.outcome === "skipped" || value.outcome === "failed"
			);
		default:
			return false;
	}
}

export function parseProgressLine(line: string): ProgressEvent | undefined {
	const text = line.trim();
	if (!text.startsWith("{")) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	// Untrusted JSON: each field read below is checked with typeof or a literal comparison before it is used.
	const value = parsed as Record<string, unknown>;
	if (typeof value.type !== "string" || EVENT_TYPES[value.type] !== true) return undefined;
	if (!isNumber(value.at) || !hasRequiredFields(value.type, value)) return undefined;
	// Validated above: the type, the timestamp and each type's required fields. Optional fields keep the producer's shape.
	return value as ProgressEvent;
}
