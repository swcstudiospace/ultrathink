// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import type { ShipState } from "../ship/types.ts";
import { graphRegisterPayload } from "./grokbot-track.ts";

const PR_URL = "https://github.com/o/r/pull/7";

function record(ship?: ShipState): SessionRecord {
	return {
		sessionId: "s1",
		at: 0,
		plan: {
			graphId: "g-pr",
			task: { graphId: "g-pr", item: "t", status: "Todo", linearState: "Todo", repo: "o/r" },
			issues: [],
			subIssues: [],
		},
		...(ship ? { ship } : {}),
	} as unknown as SessionRecord;
}

describe("graphRegisterPayload pr_url", () => {
	test("a stored shipped PR is registered as pr_url", () => {
		const payload = graphRegisterPayload(
			record({
				phase: "pr-open",
				pr: { number: 7, url: PR_URL, head: "feat", base: "main" },
				rounds: [],
				updatedAt: 1,
			}),
		);
		expect(payload.pr_url).toBe(PR_URL);
	});

	test("a ship without a PR, and a record without a ship, send no pr_url", () => {
		const noPr = graphRegisterPayload(record({ phase: "not-done", rounds: [], updatedAt: 1 }));
		expect("pr_url" in noPr).toBe(false);
		expect("pr_url" in graphRegisterPayload(record())).toBe(false);
	});
});
