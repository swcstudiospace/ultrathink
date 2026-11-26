// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { ToolCaller } from "./create.ts";
import {
	closeSubIssue,
	createSubIssueCloser,
	planSubIssueCloseout,
	runSubIssueCloseout,
	type SubIssueCloseoutLedgerEvent,
} from "./gateway.ts";
import type { TrackingRefs } from "./types.ts";

const NODE = "n1";
const STEP = 2;
const KEY = `${NODE}.${STEP}`;
const NOTION_URL = "https://www.notion.so/Step-12345678123412341234123412345678";

function refs(over: Partial<TrackingRefs> = {}): TrackingRefs {
	return {
		graphId: "g-1",
		status: "complete",
		linear: {
			nodes: {
				[NODE]: {
					id: "uuid-parent",
					identifier: "ENG-1",
					url: "https://linear.app/t/issue/ENG-1",
					title: "[n1] Build",
				},
			},
			steps: {
				[KEY]: {
					id: "uuid-step",
					identifier: "ENG-2",
					url: "https://linear.app/t/issue/ENG-2",
					title: "Step 2",
				},
			},
		},
		notion: {
			nodes: { [NODE]: "https://www.notion.so/Node-12345678123412341234123412345678" },
			steps: { [KEY]: NOTION_URL },
		},
		errors: [],
		updatedAt: 1,
		...over,
	};
}

/** Recording callers sharing one order log, so a test proves Linear ran before Notion. */
function recording(order: string[], linearFails = false) {
	const linear: ToolCaller = {
		async call(name, args) {
			order.push(`linear:${name}:${String(args.id)}:${String(args.state)}`);
			if (linearFails) throw new Error("linear down");
			return {
				issue: { id: "uuid-step", identifier: args.id, url: "https://linear.app/t/issue/ENG-2" },
			};
		},
	};
	const notion: ToolCaller = {
		async call(name, args) {
			const props = args.properties as Record<string, unknown>;
			order.push(
				`notion:${name}:${String(args.page_id)}:${String(props.Status)}:${String(props["Linear State"])}:${String(props["date:Completed:start"])}`,
			);
			return { object: "page", id: args.page_id };
		},
	};
	return { linear, notion };
}

describe("planSubIssueCloseout", () => {
	test("a ready step plans both writes", () => {
		const { linear, notion } = recording([]);
		const plan = planSubIssueCloseout(
			{ refs: refs(), nodeId: NODE, step: STEP },
			{ linear, notion },
		);
		expect(plan).toMatchObject({ blocked: false, key: KEY, linearIdentifier: "ENG-2" });
	});

	test("a missing tracker row blocks: the sub-issue is never marked done", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order);
		const noNotion = refs();
		noNotion.notion.steps = {};
		await expect(
			closeSubIssue({ refs: noNotion, nodeId: NODE, step: STEP }, { linear, notion }),
		).rejects.toThrow(`closeSubIssue ${KEY}: no Notion step row recorded for ${KEY}`);
		expect(order).toEqual([]);

		const noLinear = refs();
		noLinear.linear.steps = {};
		await expect(
			closeSubIssue({ refs: noLinear, nodeId: NODE, step: STEP }, { linear, notion }),
		).rejects.toThrow(`closeSubIssue ${KEY}: no Linear sub-issue row recorded for ${KEY}`);
		expect(order).toEqual([]);
	});
});

describe("closeSubIssue", () => {
	test("closes Linear first, then the Notion step row, and leaves the parent open", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order);
		const result = await closeSubIssue(
			{
				refs: refs(),
				nodeId: NODE,
				step: STEP,
				completedAt: "2026-11-19T00:00:00.000Z",
			},
			{ linear, notion },
		);
		expect(result).toEqual({
			key: KEY,
			linearIdentifier: "ENG-2",
			notionUrl: NOTION_URL,
			closedInOrder: ["linear", "notion"],
		});
		expect(order).toEqual([
			"linear:save_issue:ENG-2:Done",
			"notion:notion-update-page:12345678-1234-1234-1234-123412345678:Done:Done:2026-11-19T00:00:00.000Z",
		]);
		// The parent (node) issue was never addressed.
		expect(order.some((entry) => entry.includes("ENG-1"))).toBe(false);
	});

	test("a failed Linear write leaves the Notion row untouched", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order, true);
		await expect(
			closeSubIssue({ refs: refs(), nodeId: NODE, step: STEP }, { linear, notion }),
		).rejects.toThrow(`closeSubIssue ${KEY}: linear ENG-2 not marked done: linear down`);
	});
});

describe("runSubIssueCloseout (production)", () => {
	test("completion closes once, in order, with one ledger event; a second attempt is a no-op", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order);
		const events: SubIssueCloseoutLedgerEvent[] = [];
		const closed = new Set<string>();
		const input = {
			refs: refs(),
			nodeId: NODE,
			step: STEP,
			completedAt: "2026-11-19T00:00:00.000Z",
		};
		const first = await runSubIssueCloseout(input, {
			linear,
			notion,
			closed,
			onLedgerEvent: (event) => events.push(event),
			now: () => "2026-11-19T00:00:00.000Z",
		});
		expect(first).toMatchObject({
			status: "closed",
			key: KEY,
			result: { linearIdentifier: "ENG-2", closedInOrder: ["linear", "notion"] },
		});
		expect(order).toEqual([
			"linear:save_issue:ENG-2:Done",
			"notion:notion-update-page:12345678-1234-1234-1234-123412345678:Done:Done:2026-11-19T00:00:00.000Z",
		]);
		expect(events).toEqual([
			{
				key: KEY,
				linearIdentifier: "ENG-2",
				notionUrl: NOTION_URL,
				at: "2026-11-19T00:00:00.000Z",
				closedInOrder: ["linear", "notion"],
			},
		]);
		const second = await runSubIssueCloseout(input, {
			linear,
			notion,
			closed,
			onLedgerEvent: (event) => events.push(event),
		});
		expect(second).toEqual({ status: "already-closed", key: KEY });
		expect(order).toHaveLength(2);
		expect(events).toHaveLength(1);
	});

	test("a bound closer shares its idempotency set across calls", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order);
		const close = createSubIssueCloser({ linear, notion });
		const input = { refs: refs(), nodeId: NODE, step: STEP };
		expect(await close(input)).toMatchObject({ status: "closed", key: KEY });
		expect(await close(input)).toEqual({ status: "already-closed", key: KEY });
		expect(order).toHaveLength(2);
	});

	test("a blocked plan makes no tracker call and surfaces an HTIL hold", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order);
		const events: SubIssueCloseoutLedgerEvent[] = [];
		const noNotion = refs();
		noNotion.notion.steps = {};
		const outcome = await runSubIssueCloseout(
			{ refs: noNotion, nodeId: NODE, step: STEP },
			{ linear, notion, onLedgerEvent: (event) => events.push(event) },
		);
		expect(outcome.status).toBe("blocked");
		if (outcome.status === "blocked") {
			expect(outcome.holdText).toBe(
				`HTIL hold: Sub-Issue ${KEY} not closed — no Notion step row recorded for ${KEY}`,
			);
			expect(outcome.reasons).toEqual([`no Notion step row recorded for ${KEY}`]);
		}
		expect(order).toEqual([]);
		expect(events).toEqual([]);
	});

	test("no callers degrade to a no-op note with no tracker call", async () => {
		const outcome = await runSubIssueCloseout({ refs: refs(), nodeId: NODE, step: STEP }, {});
		expect(outcome).toEqual({
			status: "unavailable",
			key: KEY,
			note: `Sub-Issue ${KEY} closeout unavailable: Linear and Notion tracker is not configured; no tracker call was made`,
		});
	});

	test("a failed Linear write is held, leaves Notion untouched, and never throws", async () => {
		const order: string[] = [];
		const { linear, notion } = recording(order, true);
		const events: SubIssueCloseoutLedgerEvent[] = [];
		const outcome = await runSubIssueCloseout(
			{ refs: refs(), nodeId: NODE, step: STEP },
			{ linear, notion, onLedgerEvent: (event) => events.push(event) },
		);
		expect(outcome).toEqual({
			status: "held",
			key: KEY,
			holdText: `HTIL hold: closeSubIssue ${KEY}: linear ENG-2 not marked done: linear down`,
		});
		expect(order).toEqual(["linear:save_issue:ENG-2:Done"]);
		expect(events).toEqual([]);
	});
});
