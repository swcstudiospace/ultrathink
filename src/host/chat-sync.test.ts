// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Chat/session sync card + onCancel handoff (SPE-37787, n4). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeChatSyncNoDrop, onChatCancel } from "./chat-handoff.ts";
import {
	CHAT_SYNC_TYPE,
	chatSyncFallbackLine,
	registerUltrathinkRenderers,
} from "./omp-render.ts";
import { visibleWidth } from "./omp-paint.ts";
import { buildChatSyncView, isChatSyncView, type PlanView } from "./view.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function handoffDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-chat-sync-"));
	dirs.push(dir);
	return dir;
}

const FG = ["accent", "muted", "dim", "success", "customMessageLabel", "borderMuted"];
const CARD_BG = "\x1b[48;5;236m";
const theme = {
	fg(color: string, text: string) {
		if (!FG.includes(color)) throw new Error(`Unknown theme color: ${color}`);
		return `\x1b[38;5;${FG.indexOf(color) + 1}m${text}\x1b[39m`;
	},
	bg(color: string, text: string) {
		if (color !== "customMessageBg") throw new Error(`Unknown theme background color: ${color}`);
		return `${CARD_BG}${text}\x1b[49m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	icon: { package: "📦" },
	status: { running: "RR", success: "OK", error: "XX", warning: "WW", pending: ".." },
};

type Renderer = Parameters<
	Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]
>[1];
const renderers: Record<string, Renderer> = {};
registerUltrathinkRenderers({
	registerMessageRenderer: (type, renderer) => void (renderers[type] = renderer),
});
const renderChatSync = renderers[CHAT_SYNC_TYPE] as Renderer;

const view: PlanView = {
	root: "BUILD_PROMPT",
	source: "llm",
	graphId: "ut-chat-sync",
	elapsedMs: 1000,
	nodes: [
		{ id: "n1", title: "Understand", kind: "understand", wave: 1, dependsOn: [], steps: [] },
		{ id: "n2", title: "Generate left", kind: "generate", wave: 2, dependsOn: ["n1"], steps: [] },
		{ id: "n3", title: "Generate right", kind: "generate", wave: 2, dependsOn: ["n1"], steps: [] },
	],
	waves: [["n1"], ["n2", "n3"]],
	clarifications: [],
};

describe("buildChatSyncView", () => {
	test("every wave member becomes a row carrying both wave_id and node_id", () => {
		const sync = buildChatSyncView(view, {
			sessionId: "s1",
			kind: "managed",
			syncDone: true,
		});
		expect(sync.rows).toEqual([
			{ wave_id: "w1", node_id: "n1", title: "Understand" },
			{ wave_id: "w2", node_id: "n2", title: "Generate left" },
			{ wave_id: "w2", node_id: "n3", title: "Generate right" },
		]);
		expect(sync).toMatchObject({ graphId: "ut-chat-sync", sessionId: "s1", kind: "managed" });
		expect(isChatSyncView(sync)).toBe(true);
	});

	test("a node without a title still gets its row (no drop)", () => {
		const sync = buildChatSyncView(
			{ ...view, nodes: view.nodes.slice(0, 1), waves: [["n1"], ["nX"]] },
			{ sessionId: "s1", kind: "direct", syncDone: false },
		);
		expect(sync.rows).toEqual([
			{ wave_id: "w1", node_id: "n1", title: "Understand" },
			{ wave_id: "w2", node_id: "nX" },
		]);
	});

	test("isChatSyncView rejects malformed details", () => {
		for (const details of [
			undefined,
			"x",
			null,
			{ sessionId: "", kind: "direct", syncDone: true, rows: [] },
			{ sessionId: "s", kind: "side", syncDone: true, rows: [] },
			{ sessionId: "s", kind: "direct", syncDone: "yes", rows: [] },
			{ sessionId: "s", kind: "direct", syncDone: true, rows: [{ wave_id: "", node_id: "n" }] },
			{ sessionId: "s", kind: "direct", syncDone: true, rows: [{ wave_id: "w1" }] },
		]) {
			expect(isChatSyncView(details)).toBe(false);
		}
	});
});

describe("chat sync card (no NativeDialog)", () => {
	const sync = buildChatSyncView(view, { sessionId: "s1", kind: "managed", syncDone: true });

	test("renders the wave/node rows through the chat/session channel at exactly the render width", () => {
		const component = renderChatSync({ content: "sync", details: sync }, { expanded: false }, theme);
		expect(component).toBeDefined();
		const rows = component?.render(80) ?? [];
		expect(rows.map(visibleWidth)).toEqual(rows.map(() => 80));
		const plain = rows.map((row) => Bun.stripANSI(row)).join("\n");
		expect(plain).toContain(CHAT_SYNC_TYPE);
		expect(plain).toContain("w1");
		expect(plain).toContain("n1");
		expect(plain).toContain("w2");
		expect(plain).toContain("n3");
		expect(plain).toContain("sync complete");
	});

	test("a pending sync is stated in words, never treated as complete", () => {
		const pending = buildChatSyncView(view, { sessionId: "s1", kind: "direct", syncDone: false });
		const plain = Bun.stripANSI(
			renderChatSync({ content: "sync", details: pending }, { expanded: false }, theme)?.render(80)?.join("\n") ?? "",
		);
		expect(plain).toContain("sync pending");
		expect(plain).not.toContain("sync complete");
	});

	test("malformed details fall back to Omp's default card", () => {
		for (const details of [undefined, "x", null, { sessionId: "s" }]) {
			expect(renderChatSync({ content: "sync", details }, { expanded: false }, theme)).toBeUndefined();
		}
	});

	test("fallback line names kind, verdict and the first wave/node pair", () => {
		expect(chatSyncFallbackLine(sync)).toContain("managed");
		expect(chatSyncFallbackLine(sync)).toContain("sync complete");
		expect(chatSyncFallbackLine(sync)).toContain("wave w1");
		expect(chatSyncFallbackLine(sync)).toContain("node n1");
	});
});

describe("onChatCancel -> handoff file", () => {
	test("cancel writes an entry carrying both wave_id and node_id", () => {
		const path = join(handoffDir(), "handoff.jsonl");
		const entry = onChatCancel(path, {
			wave_id: "w1",
			node_id: "n1",
			sessionId: "s1",
			kind: "direct",
			at: 7,
		});
		expect(entry).toMatchObject({ wave_id: "w1", node_id: "n1", reason: "cancel", at: 7 });
		expect(consumeChatSyncNoDrop(path)).toEqual([entry]);
	});

	test("a second cancel appends instead of overwriting — no dropped card", () => {
		const path = join(handoffDir(), "handoff.jsonl");
		onChatCancel(path, { wave_id: "w1", node_id: "n1" });
		onChatCancel(path, { wave_id: "w2", node_id: "n2", kind: "managed" });
		expect(consumeChatSyncNoDrop(path)?.map((entry) => [entry.wave_id, entry.node_id])).toEqual([
			["w1", "n1"],
			["w2", "n2"],
		]);
	});

	test("CONSUME_NO_DROP gate: consume is non-null after kill (write, then read fresh from disk)", () => {
		const path = join(handoffDir(), "nested", "handoff.jsonl");
		expect(consumeChatSyncNoDrop(path)).toBeNull();
		onChatCancel(path, { wave_id: "w2", node_id: "n3", sessionId: "s9", kind: "managed" });
		// "Kill": the process dies here — nothing is kept in memory; the next process reads the file alone.
		const consumed = consumeChatSyncNoDrop(path);
		expect(consumed).not.toBeNull();
		expect(consumed).toEqual([
			expect.objectContaining({ wave_id: "w2", node_id: "n3", reason: "cancel" }),
		]);
	});

	test("cancel without both ids is refused, never recorded as a half entry", () => {
		const path = join(handoffDir(), "handoff.jsonl");
		expect(() => onChatCancel(path, { wave_id: "", node_id: "n1" })).toThrow();
		expect(() => onChatCancel(path, { wave_id: "w1", node_id: "" })).toThrow();
		expect(consumeChatSyncNoDrop(path)).toBeNull();
	});
});
