// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, type writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelResolution } from "./engine.ts";
import { createFdProgressSink, type ProgressEvent, parseProgressLine } from "./progress.ts";

const detected: ModelResolution = {
	version: "1.0.0",
	state: "detected",
	host: "omp",
	transport: "omp-native",
	source: "ctx.model",
	reason: "live-model",
	engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
	provider: "anthropic",
	modelId: "claude-x",
	modelKnown: true,
	label: "omp-native:anthropic/claude-x [detected]",
};

/** An unresolved selection: no begin and no inference happened, so its end alone carries the safe reason. */
const unresolved: ModelResolution = {
	version: "1.0.0",
	state: "unresolved",
	host: "omp",
	transport: "omp-native",
	source: "none",
	reason: "native-unavailable",
	engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
	modelKnown: false,
	label: "omp-native:unresolved [native-unavailable]",
};

const events: ProgressEvent[] = [
	{ type: "begin", at: 1, sessionId: "s", engine: "grok" },
	{ type: "stage", at: 2, stage: "uplift", phase: "end", ok: true, detail: "BUILD_PROMPT · llm" },
	{ type: "graph", at: 3, total: 1, nodes: [{ id: "n1", title: "A", kind: "understand" }] },
	{
		type: "node",
		at: 4,
		phase: "done",
		id: "n1",
		title: "A",
		kind: "understand",
		index: 0,
		total: 1,
		fallback: true,
	},
	{
		type: "track",
		at: 5,
		linear: { nodes: [1, 2], steps: [0, 3] },
		notion: { task: true, nodes: [0, 2], steps: [0, 3] },
		error: "boom",
	},
	{ type: "begin", at: 6, sessionId: "s", engine: "grok", skill: "gsd-plan-phase" },
	{
		type: "graph",
		at: 6,
		total: 2,
		nodes: [
			{ id: "n1", title: "A", kind: "understand", dependsOn: [] },
			{ id: "n2", title: "B", kind: "generate", dependsOn: ["n1"] },
		],
	},
	{
		type: "node",
		at: 6,
		phase: "done",
		id: "n1",
		title: "A",
		kind: "understand",
		index: 0,
		total: 2,
		steps: ["Step 1: read"],
	},
	{
		type: "issue",
		at: 6,
		provider: "linear",
		nodeId: "n1",
		step: 2,
		identifier: "ENG-1",
		url: "https://linear.app/o/issue/ENG-1",
	},
	{
		type: "activity",
		at: 6,
		notice: {
			v: 1,
			kind: "teachable-recalled",
			title: "Lesson recalled",
			source: "hindsight",
			outcome: "used",
			count: 2,
			names: ["Retry the fetch"],
		},
	},
	{ type: "end", at: 6, outcome: "planned" },
	{ type: "begin", at: 7, sessionId: "s", engine: detected.label, modelResolution: detected },
	{ type: "end", at: 8, outcome: "planned", modelResolution: detected },
	{
		type: "end",
		at: 9,
		outcome: "skipped",
		detail: "native-unavailable",
		modelResolution: unresolved,
	},
];

describe("createFdProgressSink", () => {
	test("undefined without env var, for fd < 3, or non-integer", () => {
		expect(createFdProgressSink({})).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "1" })).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "2" })).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "3.5" })).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "abc" })).toBeUndefined();
	});

	test("writes one JSON line per event and counts the events a closed fd refuses, without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "ut-progress-"));
		try {
			const path = join(dir, "events.jsonl");
			const fd = openSync(path, "w");
			const sink = createFdProgressSink({ ULTRATHINK_PROGRESS_FD: String(fd) });
			expect(sink).toBeDefined();
			for (const event of events) sink?.(event);
			closeSync(fd);
			const lines = readFileSync(path, "utf8").split("\n");
			expect(lines.at(-1)).toBe("");
			expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual(events);
			expect(sink?.dropped).toBe(0);
			expect(() => sink?.(events[0]!)).not.toThrow();
			expect(sink?.dropped).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a partial write continues until the whole line is written", () => {
		const written: Buffer[] = [];
		const partial = ((_fd: number, buffer: Buffer, offset = 0, length = buffer.length - offset) => {
			const count = Math.min(length, 5);
			written.push(Buffer.from(buffer.subarray(offset, offset + count)));
			return count;
		}) as unknown as typeof writeSync;
		const sink = createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "3" }, partial);
		sink?.(events[0]!);
		expect(Buffer.concat(written).toString("utf8")).toBe(`${JSON.stringify(events[0])}\n`);
		expect(sink?.dropped).toBe(0);
	});

	test("a fd that keeps refusing with EAGAIN counts each dropped event and never throws", () => {
		let calls = 0;
		const refusing = (() => {
			calls++;
			throw Object.assign(new Error("resource temporarily unavailable"), { code: "EAGAIN" });
		}) as unknown as typeof writeSync;
		const sink = createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "3" }, refusing);
		expect(() => sink?.(events[0]!)).not.toThrow();
		expect(() => sink?.(events[1]!)).not.toThrow();
		expect(sink?.dropped).toBe(2);
		expect(calls).toBeGreaterThan(2);
	});
});

describe("parseProgressLine", () => {
	test("accepts every event type", () => {
		for (const event of events) expect(parseProgressLine(JSON.stringify(event))).toEqual(event);
	});

	test("rejects junk, unknown types, and missing at", () => {
		expect(parseProgressLine("not json")).toBeUndefined();
		expect(parseProgressLine("{broken")).toBeUndefined();
		expect(parseProgressLine("[1,2]")).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "mystery", at: 1 }))).toBeUndefined();
		expect(
			parseProgressLine(
				JSON.stringify({ type: "issue", provider: "linear", nodeId: "n1", url: "u" }),
			),
		).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "toString", at: 1 }))).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "end", outcome: "planned" }))).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "end", at: "1" }))).toBeUndefined();
	});

	test("rejects an event whose per-type required fields are malformed", () => {
		expect(
			parseProgressLine(JSON.stringify({ type: "end", at: 1, outcome: "bogus" })),
		).toBeUndefined();
		expect(
			parseProgressLine(JSON.stringify({ type: "stage", at: 1, stage: "nope", phase: "start" })),
		).toBeUndefined();
		expect(
			parseProgressLine(JSON.stringify({ type: "begin", at: 1, sessionId: "s" })),
		).toBeUndefined();
		expect(
			parseProgressLine(
				JSON.stringify({ type: "issue", at: 1, provider: "jira", nodeId: "n1", url: "u" }),
			),
		).toBeUndefined();
		expect(
			parseProgressLine(JSON.stringify({ type: "activity", at: 1, notice: "text" })),
		).toBeUndefined();
	});

	test("the safe record rides on begin and end only: no new event kind, and an unresolved end needs no begin", () => {
		const end = parseProgressLine(
			JSON.stringify({
				type: "end",
				at: 9,
				outcome: "skipped",
				detail: "native-unavailable",
				modelResolution: unresolved,
			}),
		);
		expect(end).toEqual({
			type: "end",
			at: 9,
			outcome: "skipped",
			detail: "native-unavailable",
			modelResolution: unresolved,
		});
		expect(end?.type === "end" ? end.modelResolution?.label : undefined).toBe(
			"omp-native:unresolved [native-unavailable]",
		);
		const begin = parseProgressLine(
			JSON.stringify({
				type: "begin",
				at: 7,
				sessionId: "s",
				engine: detected.label,
				modelResolution: detected,
			}),
		);
		expect(begin?.type === "begin" ? begin.modelResolution : undefined).toEqual(detected);
		for (const type of ["resolution", "modelResolution", "model"]) {
			expect(
				parseProgressLine(JSON.stringify({ type, at: 1, modelResolution: detected })),
			).toBeUndefined();
		}
	});
});
