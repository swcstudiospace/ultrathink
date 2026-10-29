// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { writeSync } from "node:fs";
import type { ModelResolution } from "./engine.ts";
import type { ActivityNotice } from "./activity-notice.ts";

export type StageName =
	| "brief"
	| "uplift"
	| "think"
	| "knowledge"
	| "clarify"
	| "plan"
	| "track"
	| "state";

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
/** Sink writing JSON lines to the fd named by ULTRATHINK_PROGRESS_FD (>= 3). Never touches stdout; swallows errors. */
export function createFdProgressSink(
	env: Record<string, string | undefined> = process.env,
): ProgressSink | undefined {
	const raw = env.ULTRATHINK_PROGRESS_FD?.trim();
	if (!raw || !/^\d+$/.test(raw)) return undefined;
	const fd = Number(raw);
	if (!Number.isSafeInteger(fd) || fd < 3) return undefined;
	return (event) => {
		try {
			writeSync(fd, `${JSON.stringify(event)}\n`);
		} catch {
			// reason: Parent gone (EPIPE) or fd closed: progress is best-effort.
		}
	};
}

export function parseProgressLine(line: string): ProgressEvent | undefined {
	const text = line.trim();
	if (!text.startsWith("{")) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || !("type" in value) || !("at" in value))
		return undefined;
	if (typeof value.type !== "string" || EVENT_TYPES[value.type] !== true) return undefined;
	if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined;
	// Trusted child-process boundary: type + timestamp validated above.
	const event: ProgressEvent = value as ProgressEvent;
	return event;
}

/** Longest partial line the splitter keeps; bytes past it are dropped until the next newline. */
const MAX_LINE_CHARS = 256 * 1024;

export function createLineSplitter(onLine: (line: string) => void): {
	push(chunk: string): void;
	end(): void;
} {
	let buffer = "";
	// True while the current line has overflowed: its tail is skipped up to the next newline.
	let dropping = false;
	const keep = (text: string): void => {
		buffer += text;
		if (buffer.length > MAX_LINE_CHARS) {
			buffer = buffer.slice(0, MAX_LINE_CHARS);
			dropping = true;
		}
	};
	return {
		push(chunk) {
			let rest = chunk;
			for (let newline = rest.indexOf("\n"); newline !== -1; newline = rest.indexOf("\n")) {
				if (!dropping) keep(rest.slice(0, newline));
				const line = buffer.replace(/\r$/, "");
				buffer = "";
				dropping = false;
				if (line) onLine(line);
				rest = rest.slice(newline + 1);
			}
			if (!dropping) keep(rest);
		},
		end() {
			const rest = buffer.replace(/\r$/, "");
			buffer = "";
			dropping = false;
			if (rest) onLine(rest);
		},
	};
}
