// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PrdRecord } from "../think/tot/types.ts";
import type { ToolCaller } from "./create.ts";
import type { SyncDeps } from "./prd-types.ts";
import {
	type NotionBlock,
	NOTION_BLOCKS_PER_REQUEST,
	NOTION_RICH_TEXT_LIMIT,
	buildNotionBlocks,
	markdownToBlocks,
	resumePrds,
	syncPrds,
} from "./prd-sync.ts";

const PAGE_URL = "https://www.notion.so/Sub-Issue-0123456789abcdef0123456789abcdef";
const SECRET = "sk-ant-api03-abcdefghijklmnop1234567890";

const refs = {
	linear: {
		steps: {
			"n1.1": {
				id: "uuid-1",
				identifier: "ENG-1",
				url: "https://linear.app/t/issue/ENG-1",
				title: "step",
			},
		},
	},
	notion: { steps: { "n1.1": PAGE_URL } },
};

function prd(markdown: string, hash = "a".repeat(64), key = "n1.1"): PrdRecord {
	return {
		key,
		hash,
		markdown,
		status: "generated",
		model: "m",
		fallback: false,
		attempts: 1,
	};
}

function httpError(status: number, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
}

interface Mock {
	caller: ToolCaller;
	calls: Array<{ name: string; args: Record<string, unknown> }>;
	/** Errors thrown by the next calls to a tool, in order. */
	fail: Map<string, Error[]>;
	count(name: string): number;
}

function mockCaller(handle: (name: string, args: Record<string, unknown>) => unknown): Mock {
	const calls: Mock["calls"] = [];
	const fail = new Map<string, Error[]>();
	return {
		calls,
		fail,
		count: (name) => calls.filter((call) => call.name === name).length,
		caller: {
			async call(name, args) {
				calls.push({ name, args });
				const queued = fail.get(name);
				const error = queued?.shift();
				if (error) throw error;
				return handle(name, args);
			},
		},
	};
}

interface LinearMock extends Mock {
	readonly description: string;
	readonly docs: string[];
}

function linearMock(initial = "Existing notes"): LinearMock {
	const state = { description: initial, docs: [] as string[] };
	const mock = mockCaller((name, args) => {
		if (name === "get_issue") {
			return {
				id: "uuid-1",
				description: state.description,
				url: "https://linear.app/t/issue/ENG-1",
			};
		}
		if (name === "save_issue") {
			state.description = String(args.description);
			return { id: "uuid-1" };
		}
		if (name === "save_document") {
			state.docs.push(String(args.content));
			return { id: "doc-1", url: "https://linear.app/t/document/doc-1" };
		}
		throw new Error(`unexpected ${name}`);
	});
	return {
		...mock,
		get description() {
			return state.description;
		},
		get docs() {
			return state.docs;
		},
	};
}

/** The text of each rich-text segment of `block[field]`; throws when the block has none. */
function segmentsOf(block: NotionBlock | undefined, field: string): string[] {
	const body = block?.[field];
	if (typeof body !== "object" || body === null || !("rich_text" in body)) {
		throw new Error(`block has no ${field}.rich_text`);
	}
	const items: unknown = body.rich_text;
	if (!Array.isArray(items)) throw new Error("rich_text is not a list");
	return items.map((item: unknown) => {
		if (typeof item === "object" && item !== null && "text" in item) {
			const text = item.text;
			if (typeof text === "object" && text !== null && "content" in text) {
				if (typeof text.content === "string") return text.content;
			}
		}
		throw new Error("segment has no text.content");
	});
}

function languageOf(block: NotionBlock | undefined, field: string): unknown {
	const body = block?.[field];
	return typeof body === "object" && body !== null && "language" in body
		? body.language
		: undefined;
}

function childCount(args: Record<string, unknown>): number {
	return Array.isArray(args.children) ? args.children.length : -1;
}

interface MockBlock {
	id: string;
	type: string;
	[field: string]: unknown;
}

interface NotionMock extends Mock {
	readonly blocks: MockBlock[];
}

function notionMock(): NotionMock {
	const blocks: MockBlock[] = [];
	let next = 0;
	const mock = mockCaller((name, args) => {
		if (name === "API-get-block-children") return { results: [...blocks], has_more: false };
		if (name === "API-patch-block-children") {
			const children: unknown[] = Array.isArray(args.children) ? args.children : [];
			const made = children.map((child) => ({
				...(typeof child === "object" && child !== null ? child : {}),
				id: `blk-${++next}`,
				type:
					typeof child === "object" && child !== null && "type" in child ? String(child.type) : "",
			}));
			blocks.push(...made);
			return { results: made };
		}
		if (name === "API-delete-a-block") {
			const at = blocks.findIndex((block) => block.id === args.block_id);
			if (at < 0) throw httpError(404);
			blocks.splice(at, 1);
			return {};
		}
		throw new Error(`unexpected ${name}`);
	});
	return {
		...mock,
		get blocks() {
			return blocks;
		},
	};
}

let dir: string;
let delays: number[];

beforeEach(() => {
	dir = mkdtempSync(join(homedir(), "ultrathink-test-prdsync-"));
	delays = [];
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function deps(extra: Partial<SyncDeps> = {}): SyncDeps {
	return {
		graphId: "ut-g1",
		stateDir: dir,
		refs,
		sleep: async (ms) => {
			delays.push(ms);
		},
		random: () => 0.5,
		...extra,
	};
}

const START = "<!-- ultrathink:prd:start key=n1.1 hash=";
const END = "<!-- ultrathink:prd:end -->";

describe("syncPrds", () => {
	test("attaches the PRD to both existing Sub Issues and a re-run changes nothing", async () => {
		const linear = linearMock();
		const notion = notionMock();
		const d = deps({ linear: linear.caller, notion: notion.caller });
		const first = await syncPrds([prd("# Title\n\nBody")], d);
		expect(first.keys[0]?.linear.outcome).toBe("created");
		expect(first.keys[0]?.notion.outcome).toBe("created");
		expect(first.keys[0]?.linear.url).toBe("https://linear.app/t/issue/ENG-1");
		expect(first.summary).toEqual({ total: 1, synced: 1, pending: 0, failed: 0 });
		expect(linear.description).toContain("Existing notes");
		expect(linear.description).toContain(`${START}${"a".repeat(64)} -->`);
		expect(linear.description.endsWith(END)).toBe(true);
		const callsBefore = linear.calls.length + notion.calls.length;
		const second = await syncPrds([prd("# Title\n\nBody")], d);
		expect(second.keys[0]?.linear.outcome).toBe("skipped");
		expect(second.keys[0]?.notion.outcome).toBe("skipped");
		expect(linear.calls.length + notion.calls.length).toBe(callsBefore);
		expect(linear.description.split(START).length).toBe(2);
		expect(notion.blocks.filter((b) => b.type === "callout").length).toBe(2);
	});

	test("a changed hash updates the managed region in place and keeps the rest", async () => {
		const linear = linearMock("Intro\n");
		const notion = notionMock();
		const d = deps({ linear: linear.caller, notion: notion.caller });
		await syncPrds([prd("old text")], d);
		await linear.caller.call("save_issue", {
			id: "ENG-1",
			description: `${linear.description}\n\nTrailer`,
		});
		const report = await syncPrds([prd("new text", "b".repeat(64))], d);
		expect(report.keys[0]?.linear.outcome).toBe("updated");
		expect(report.keys[0]?.notion.outcome).toBe("updated");
		expect(linear.description).toContain("new text");
		expect(linear.description).not.toContain("old text");
		expect(linear.description.startsWith("Intro")).toBe(true);
		expect(linear.description.endsWith("Trailer")).toBe(true);
		expect(linear.description.split(START).length).toBe(2);
		const text = JSON.stringify(notion.blocks);
		expect(text).toContain("new text");
		expect(text).not.toContain("old text");
		expect(notion.blocks.filter((b) => b.type === "callout").length).toBe(2);
	});

	test("a lost ledger still skips a PRD whose marker hash matches", async () => {
		const linear = linearMock();
		const notion = notionMock();
		const d = deps({ linear: linear.caller, notion: notion.caller });
		const first = await syncPrds([prd("same")], d);
		rmSync(first.ledgerPath);
		const saves = linear.count("save_issue");
		const appends = notion.count("API-patch-block-children");
		const again = await syncPrds([prd("same")], d);
		expect(again.keys[0]?.linear.outcome).toBe("skipped");
		expect(again.keys[0]?.notion.outcome).toBe("skipped");
		expect(linear.count("save_issue")).toBe(saves);
		expect(notion.count("API-patch-block-children")).toBe(appends);
	});

	test("a 429 with Retry-After waits at least that long, then succeeds", async () => {
		const linear = linearMock();
		linear.fail.set("get_issue", [httpError(429, { headers: { "retry-after": "3" } })]);
		const report = await syncPrds([prd("x")], deps({ linear: linear.caller }));
		expect(delays.some((ms) => ms >= 3000)).toBe(true);
		expect(report.keys[0]?.linear.outcome).toBe("created");
		expect(report.keys[0]?.linear.attempts).toBe(4);
		expect(linear.count("get_issue")).toBe(3);
	});

	test("a 400 is not retried and leaves the ledger failed", async () => {
		const linear = linearMock();
		linear.fail.set("get_issue", [httpError(400)]);
		const report = await syncPrds([prd("x")], deps({ linear: linear.caller }));
		expect(linear.count("get_issue")).toBe(1);
		expect(delays).toEqual([]);
		expect(report.keys[0]?.linear.outcome).toBe("failed");
		expect(report.keys[0]?.linear.errorClass).toBe("client-error");
		expect(report.summary.failed).toBe(1);
		const ledger = JSON.parse(readFileSync(report.ledgerPath, "utf8"));
		expect(ledger.entries[0].linear.status).toBe("failed");
	});

	test("a 5xx that never clears stays pending after the retry budget", async () => {
		const linear = linearMock();
		linear.fail.set("get_issue", [httpError(503), httpError(503), httpError(503)]);
		const report = await syncPrds([prd("x")], deps({ linear: linear.caller }));
		expect(report.keys[0]?.linear.outcome).toBe("pending");
		expect(report.keys[0]?.linear.attempts).toBe(3);
		expect(report.summary).toEqual({ total: 1, synced: 0, pending: 1, failed: 0 });
	});

	test("the PRD and hash are on disk before the first tracker call", async () => {
		let seen: { status: string; hash: string; local: string } | undefined;
		const caller: ToolCaller = {
			async call() {
				const path = join(dir, "prd-sync", "ut-g1", "ledger.json");
				const ledger = JSON.parse(readFileSync(path, "utf8"));
				const entry = ledger.entries[0];
				seen = {
					status: entry.linear.status,
					hash: entry.hash,
					local: readFileSync(entry.localPath, "utf8"),
				};
				throw httpError(400);
			},
		};
		await syncPrds([prd("local first", "c".repeat(64))], deps({ linear: caller }));
		expect(seen).toEqual({ status: "pending", hash: "c".repeat(64), local: "local first" });
	});

	test("never creates a Sub Issue: an unknown one stays pending without a call", async () => {
		const linear = linearMock();
		const notion = notionMock();
		const report = await syncPrds(
			[prd("x", "d".repeat(64), "n9.9")],
			deps({ linear: linear.caller, notion: notion.caller }),
		);
		expect(linear.calls).toEqual([]);
		expect(notion.calls).toEqual([]);
		expect(report.keys[0]?.linear.outcome).toBe("pending");
		expect(report.keys[0]?.linear.errorClass).toBe("missing-sub-issue");
		expect(report.keys[0]?.notion.outcome).toBe("pending");
	});

	test("an unconfigured tracker is skipped and not counted against the key", async () => {
		const linear = linearMock();
		const report = await syncPrds([prd("x")], deps({ linear: linear.caller }));
		expect(report.keys[0]?.notion).toMatchObject({ outcome: "skipped", reason: "not-configured" });
		expect(report.summary.synced).toBe(1);
	});

	test("a PRD that did not generate is reported, not synced", async () => {
		const linear = linearMock();
		const failed: PrdRecord = { ...prd(""), status: "failed", error: "boom" };
		const report = await syncPrds([failed], deps({ linear: linear.caller }));
		expect(linear.calls).toEqual([]);
		expect(report.keys[0]?.state).toBe("failed");
		expect(report.summary.failed).toBe(1);
	});

	test("an unreadable Linear issue is never overwritten", async () => {
		const linear = mockCaller(() => ({ unexpected: true }));
		const report = await syncPrds([prd("x")], deps({ linear: linear.caller }));
		expect(linear.count("save_issue")).toBe(0);
		expect(report.keys[0]?.linear.outcome).not.toBe("created");
	});

	test("a PRD over the size threshold goes to a linked document, the issue keeps a summary", async () => {
		const linear = linearMock();
		const long = `# Big\n\n${"word ".repeat(2000)}`;
		const d = deps({ linear: linear.caller, linearInlineLimit: 500 });
		await syncPrds([prd(long)], d);
		expect(linear.docs).toEqual([long]);
		expect(linear.description).toContain("[Full PRD](https://linear.app/t/document/doc-1)");
		expect(linear.description.length).toBeLessThan(long.length);
		const edited = `${long}\nmore`;
		await syncPrds([prd(edited, "e".repeat(64))], d);
		const saves = linear.calls.filter((call) => call.name === "save_document");
		expect(saves.length).toBe(2);
		expect(saves[1]?.args.id).toBe("doc-1");
		expect(linear.docs[1]).toBe(edited);
	});
});

describe("notion blocks", () => {
	test("a segment is cut at the rich-text limit, not before", () => {
		const exact = markdownToBlocks("a".repeat(NOTION_RICH_TEXT_LIMIT));
		const over = markdownToBlocks("a".repeat(NOTION_RICH_TEXT_LIMIT + 1));
		const segments = (blocks: NotionBlock[]) =>
			segmentsOf(blocks[0], "paragraph").map((content) => content.length);
		expect(segments(exact)).toEqual([NOTION_RICH_TEXT_LIMIT]);
		expect(segments(over)).toEqual([NOTION_RICH_TEXT_LIMIT, 1]);
	});

	test("a surrogate pair is never split across segments", () => {
		const text = `${"a".repeat(NOTION_RICH_TEXT_LIMIT - 1)}😀tail`;
		const parts = segmentsOf(markdownToBlocks(text)[0], "paragraph");
		expect(parts.join("")).toBe(text);
		expect(parts[0]?.length).toBe(NOTION_RICH_TEXT_LIMIT - 1);
	});

	test("code blocks keep their language and long code splits into segments", () => {
		const code = "x".repeat(NOTION_RICH_TEXT_LIMIT + 5);
		const blocks = markdownToBlocks(`text\n\n\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`weird\nq\n\`\`\``);
		const first = segmentsOf(blocks[1], "code");
		expect(blocks[1]?.type).toBe("code");
		expect(languageOf(blocks[1], "code")).toBe("typescript");
		expect(first.length).toBe(2);
		expect(languageOf(blocks[2], "code")).toBe("plain text");
	});

	test("the region opens with a key+hash callout and closes with an end callout", () => {
		const blocks = buildNotionBlocks("n1.1", "h".repeat(8), "# H\n\n- a\n- b\n\n1. c");
		expect(blocks.map((b) => b.type)).toEqual([
			"callout",
			"heading_1",
			"bulleted_list_item",
			"bulleted_list_item",
			"numbered_list_item",
			"callout",
		]);
		const text = segmentsOf(blocks[0], "callout")[0];
		expect(text).toBe("ultrathink:prd key=n1.1 hash=hhhhhhhh");
	});

	test("appends are batched at the per-request block limit", async () => {
		const notion = notionMock();
		const md = Array.from({ length: 250 }, (_, i) => `para ${i}`).join("\n\n");
		const report = await syncPrds([prd(md)], deps({ notion: notion.caller }));
		const sizes = notion.calls
			.filter((call) => call.name === "API-patch-block-children")
			.map((call) => childCount(call.args));
		expect(sizes).toEqual([NOTION_BLOCKS_PER_REQUEST, NOTION_BLOCKS_PER_REQUEST, 52]);
		expect(notion.blocks.length).toBe(252);
		expect(report.keys[0]?.notion.outcome).toBe("created");
		expect(report.keys[0]?.notion.attempts).toBe(4);
	});

	test("a write that died half way is cleaned up and redone on the next run", async () => {
		const notion = notionMock();
		const md = Array.from({ length: 150 }, (_, i) => `para ${i}`).join("\n\n");
		const d = deps({ notion: notion.caller });
		// First batch lands, the second fails permanently.
		let appends = 0;
		const real = notion.caller.call.bind(notion.caller);
		const flaky: ToolCaller = {
			async call(name, args, signal) {
				if (name === "API-patch-block-children" && ++appends === 2) throw httpError(400);
				return real(name, args, signal);
			},
		};
		const broken = await syncPrds([prd(md)], { ...d, notion: flaky });
		expect(broken.keys[0]?.notion.outcome).toBe("failed");
		expect(notion.blocks.length).toBe(100);
		const fixed = await syncPrds([prd(md)], d);
		expect(fixed.keys[0]?.notion.outcome).toBe("created");
		expect(notion.blocks.length).toBe(152);
		expect(notion.blocks.filter((b) => b.type === "callout").length).toBe(2);
	});
});

describe("resumePrds", () => {
	test("retries only what the ledger still owes, from the local copy", async () => {
		const linear = linearMock();
		const notion = notionMock();
		notion.fail.set("API-get-block-children", [httpError(500), httpError(500), httpError(500)]);
		const d = deps({ linear: linear.caller, notion: notion.caller });
		const first = await syncPrds([prd("resume me", "f".repeat(64))], d);
		expect(first.keys[0]?.linear.outcome).toBe("created");
		expect(first.keys[0]?.notion.outcome).toBe("pending");
		const linearCalls = linear.calls.length;
		const second = await resumePrds(d);
		expect(linear.calls.length).toBe(linearCalls);
		expect(second.keys[0]?.linear.outcome).toBe("skipped");
		expect(second.keys[0]?.notion.outcome).toBe("created");
		expect(second.summary).toEqual({ total: 1, synced: 1, pending: 0, failed: 0 });
		expect(JSON.stringify(notion.blocks)).toContain("resume me");
		const third = await resumePrds(d);
		expect(third.summary.total).toBe(0);
	});

	test("a key whose local copy is gone reports failed", async () => {
		const notion = notionMock();
		notion.fail.set("API-get-block-children", [httpError(500), httpError(500), httpError(500)]);
		const d = deps({ notion: notion.caller });
		const first = await syncPrds([prd("x")], d);
		const ledger = JSON.parse(readFileSync(first.ledgerPath, "utf8"));
		rmSync(ledger.entries[0].localPath);
		const report = await resumePrds(d);
		expect(report.keys[0]?.notion.errorClass).toBe("local-missing");
		expect(report.summary.failed).toBe(1);
	});

	test("a ledger path outside the PRD root is never read: the key reports local-missing and sends none of it", async () => {
		const linear = linearMock();
		linear.fail.set("get_issue", [httpError(503), httpError(503), httpError(503)]);
		const d = deps({ linear: linear.caller });
		const first = await syncPrds([prd("public PRD")], d);
		expect(first.keys[0]?.linear.outcome).toBe("pending");
		const outside = join(dir, "outside.md");
		writeFileSync(outside, "PRIVATE FILE CONTENT");
		const ledger = JSON.parse(readFileSync(first.ledgerPath, "utf8"));
		ledger.entries[0].localPath = outside;
		writeFileSync(first.ledgerPath, JSON.stringify(ledger));
		const fresh = linearMock();
		const second = await resumePrds(deps({ linear: fresh.caller }));
		expect(second.keys[0]?.linear.errorClass).toBe("local-missing");
		expect(second.keys[0]?.linear.error).toContain("not this key's copy under the PRD root");
		expect(second.summary.failed).toBe(1);
		expect(fresh.calls).toEqual([]);
		expect(JSON.stringify(second)).not.toContain("PRIVATE FILE CONTENT");
	});
});

describe("heading parsing", () => {
	test("a long whitespace run before a non-matching character parses to the same heading as a short one", () => {
		const long = markdownToBlocks(`#${" ".repeat(50_000)}x`);
		expect(long.map((block) => block.type)).toEqual(["heading_1"]);
		expect(segmentsOf(long[0], "heading_1").join("")).toBe("x");
		expect(long).toEqual(markdownToBlocks("# x"));
	});

	test("a long whitespace run inside a heading keeps the text and drops only the closing sequence", () => {
		const run = " ".repeat(50_000);
		const blocks = markdownToBlocks(`## a${run}b${run}##`);
		expect(blocks.map((block) => block.type)).toEqual(["heading_2"]);
		expect(segmentsOf(blocks[0], "heading_2").join("")).toBe(`a${run}b`);
	});
});

describe("secrets", () => {
	test("never reach the ledger, the local copy, the upload or the report", async () => {
		const linear = linearMock();
		linear.fail.set("get_issue", [httpError(400, { message: `bad key ${SECRET}` })]);
		const notion = notionMock();
		const d = deps({ linear: linear.caller, notion: notion.caller });
		const md = `Use the key ${SECRET} for the API.\n\napi_key = "hunter2hunter2"`;
		const first = await syncPrds([prd(md)], d);
		expect(first.keys[0]?.redacted).toBe(true);
		expect(JSON.stringify(first)).not.toContain(SECRET);
		await syncPrds([prd(md)], d);
		const ledgerText = readFileSync(first.ledgerPath, "utf8");
		expect(ledgerText).not.toContain(SECRET);
		expect(ledgerText).not.toContain("hunter2hunter2");
		const ledger = JSON.parse(ledgerText);
		expect(readFileSync(ledger.entries[0].localPath, "utf8")).not.toContain(SECRET);
		expect(linear.description).not.toContain(SECRET);
		expect(JSON.stringify(notion.blocks)).not.toContain(SECRET);
		expect(existsSync(first.ledgerPath)).toBe(true);
	});
});

describe("ledger writes", () => {
	test("overlapping syncs of one graph keep each other's entries", async () => {
		const linear = linearMock();
		const notion = notionMock();
		const d = deps({
			refs: { linear: refs.linear, notion: { steps: { "n1.2": PAGE_URL } } },
		});
		const first = syncPrds([prd("linear side", "a".repeat(64), "n1.1")], {
			...d,
			linear: linear.caller,
		});
		const second = syncPrds([prd("notion side", "b".repeat(64), "n1.2")], {
			...d,
			notion: notion.caller,
		});
		const [a, b] = await Promise.all([first, second]);
		expect(a.keys[0]?.linear.outcome).toBe("created");
		expect(b.keys[0]?.notion.outcome).toBe("created");
		const ledger = JSON.parse(readFileSync(a.ledgerPath, "utf8"));
		const entry = (key: string) => ledger.entries.find((e: { key: string }) => e.key === key);
		expect(entry("n1.1").linear).toMatchObject({
			status: "synced",
			url: "https://linear.app/t/issue/ENG-1",
		});
		expect(entry("n1.1").linearIssueId).toBe("ENG-1");
		expect(entry("n1.2").notion).toMatchObject({ status: "synced", url: PAGE_URL });
	});

	test("a ledger lock that cannot be taken fails the sync with an explicit error and leaves the ledger unchanged", async () => {
		const linear = linearMock();
		const d = deps({ linear: linear.caller });
		const first = await syncPrds([prd("first", "a".repeat(64))], d);
		const before = readFileSync(first.ledgerPath, "utf8");
		const calls = linear.calls.length;
		// Another writer holds the lock. Its record names this live process with no start identity, so it is never
		// reclaimed as dead, and its mtime is fresh.
		writeFileSync(
			`${first.ledgerPath}.lock`,
			JSON.stringify({ pid: process.pid, startTime: "", token: "held" }),
		);
		// The lock wait reads this clock: each read jumps past its timeout, so the wait ends without sleeping.
		let tick = 0;
		const clock = spyOn(Date, "now").mockImplementation(() => (tick += 60_000));
		const report = await syncPrds([prd("second", "b".repeat(64))], d).finally(() =>
			clock.mockRestore(),
		);
		expect(report.keys[0]?.state).toBe("pending");
		expect(report.keys[0]?.linear.errorClass).toBe("local-write");
		expect(report.keys[0]?.linear.error).toContain("still held");
		expect(linear.calls.length).toBe(calls);
		expect(readFileSync(first.ledgerPath, "utf8")).toBe(before);
	});
});
