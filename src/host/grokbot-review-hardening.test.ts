// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reviewRead } from "./grokbot-cli.ts";
import { type RealRefs, recordRefs } from "./grokbot-track.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const bot = { login: "greptile-apps[bot]" };
const fan = { login: "greptile-fan" };

/** A fetcher answering GitHub REST paths by suffix; records each request's init so a test can inspect it. */
function github(files: Record<string, unknown>, seen: RequestInit[] = []): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		seen.push(init ?? {});
		const path = String(input).split("?")[0] as string;
		const key = Object.keys(files).find((suffix) => path.endsWith(suffix));
		if (key === undefined) return new Response("{}", { status: 404 });
		return new Response(JSON.stringify(files[key]), { status: 200 });
	}) as unknown as typeof fetch;
}

function pull(body: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		"pulls/21": { state: "open", draft: true, head: { sha: "abc" }, body, ...extra },
		"issues/21/comments": [],
		"pulls/21/reviews": [],
		"pulls/21/comments": [],
		"commits/abc/check-runs": { check_runs: [] },
	};
}

describe("grok-bot review read score", () => {
	test("a score written in the PR description is not the review score", async () => {
		const read = await reviewRead("o/r", "21", github(pull("<h3>Confidence Score: 5/5</h3>")));
		expect(read.score).toBeUndefined();
		expect(read.scoreSource).toBe("none");
	});

	test("a review or comment from a non-bot login is ignored, even with a Greptile-looking name", async () => {
		const files = {
			...pull(""),
			"issues/21/comments": [
				{ user: fan, body: "Confidence Score: 2/5", created_at: "2026-10-09T00:00:00Z" },
			],
			"pulls/21/reviews": [{ user: fan, commit_id: "abc", body: "Confidence Score: 1/5" }],
			"pulls/21/comments": [
				{
					id: 1,
					user: fan,
					commit_id: "abc",
					path: "a.ts",
					line: 1,
					body: '<img alt="P1"> **Fan**',
				},
			],
		};
		const read = await reviewRead("o/r", "21", github(files));
		expect(read.score).toBeUndefined();
		expect(read.scoreSource).toBe("none");
		expect(read.greptileThreadsTotal).toBe(0);
		expect(read.reviewedHead).toBe(false);
	});

	test("the Greptile bot login's head review still sets the score beside a non-bot review", async () => {
		const files = {
			...pull(""),
			"pulls/21/reviews": [
				{ user: fan, commit_id: "abc", body: "Confidence Score: 1/5" },
				{ user: bot, commit_id: "abc", body: "Confidence Score: 4/5" },
			],
		};
		const read = await reviewRead("o/r", "21", github(files));
		expect(read.score).toBe(4);
		expect(read.scoreSource).toBe("head-review");
	});
});

describe("grok-bot review read timeouts", () => {
	test("every GitHub read carries an abort signal", async () => {
		const seen: RequestInit[] = [];
		await reviewRead("o/r", "21", github(pull(""), seen));
		expect(seen.length).toBeGreaterThan(0);
		for (const init of seen) expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	test("a GitHub read that times out fails the review read instead of returning a partial result", async () => {
		const timedOut = (async () => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		}) as unknown as typeof fetch;
		await expect(reviewRead("o/r", "21", timedOut)).rejects.toThrow(
			"GitHub pulls/21: timed out after 15 s",
		);
	});
});

const LINEAR_REF = {
	id: "id0",
	identifier: "SPE-1",
	url: "https://linear.app/x/issue/SPE-1/t",
	title: "t",
};

/** A session record with one planned Linear node and no Notion work, written as the kickoff leaves it. */
function sessionState(tracking?: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "grokbot-refs-"));
	dirs.push(root);
	const statePath = join(root, "state", "s1.json");
	mkdirSync(dirname(statePath), { recursive: true });
	writeFileSync(
		statePath,
		JSON.stringify({
			sessionId: "s1",
			at: 0,
			result: { xml: "<GRAPH_OF_THOUGHT></GRAPH_OF_THOUGHT>" },
			plan: {
				graphId: "g1",
				task: { graphId: "g1", item: "t", status: "Todo", linearState: "Todo", repo: "o/r" },
				issues: [],
				subIssues: [],
				linearIssues: [{ nodeId: "n1", title: "t", description: "" }],
				linearSubIssues: [],
				hitl: { blocking: [], nonBlocking: [] },
			},
			...(tracking ? { tracking } : {}),
		}),
	);
	return statePath;
}

const LINEAR_ONLY = { linear: true, notion: false } as const;

describe("grok-bot track record refs", () => {
	test("a well-formed Linear ref completes a Linear-only plan", () => {
		const statePath = sessionState();
		const { tracking } = recordRefs(
			statePath,
			{ linear: { n1: LINEAR_REF }, trackers: LINEAR_ONLY },
			1,
		);
		expect(tracking.status).toBe("complete");
	});

	test("a malformed ref is rejected before the state is touched and never reports complete", () => {
		const statePath = sessionState();
		const before = readFileSync(statePath, "utf8");
		const malformed: Array<[unknown, RegExp]> = [
			[{ linear: { n1: "PEND-1" } }, /linear\.n1/],
			[{ linear: { n1: { id: "id0", identifier: "SPE-1", url: LINEAR_REF.url } } }, /linear\.n1/],
			[{ linear: { n1: { ...LINEAR_REF, id: "" } } }, /linear\.n1/],
			[{ notion: { n1: "x" } }, /notion\.n1/],
			[{ linear: "PEND-1" }, /linear must/],
		];
		for (const [refs, message] of malformed) {
			expect(() =>
				recordRefs(statePath, { ...(refs as RealRefs), trackers: LINEAR_ONLY }, 2),
			).toThrow(message);
		}
		expect(readFileSync(statePath, "utf8")).toBe(before);
	});

	test("a stored ref that is only truthy does not count as complete", () => {
		const statePath = sessionState({
			graphId: "g1",
			status: "partial",
			linear: { nodes: { n1: "PEND-1" }, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 0,
		});
		const { tracking } = recordRefs(statePath, { trackers: LINEAR_ONLY }, 3);
		expect(tracking.status).toBe("failed");
	});
});
