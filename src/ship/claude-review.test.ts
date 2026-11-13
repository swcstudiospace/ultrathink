// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	CLAUDE_REVIEW_MODEL,
	CLAUDE_REVIEW_PROMPT,
	parseReview,
	reviewWithClaude,
	usesClaudeReviewer,
} from "./claude-review.ts";
import { reviewPasses } from "./merge.ts";
import { DEFAULT_SHIP_CONFIG, type Run, type ShipConfig } from "./types.ts";

const config: ShipConfig = { ...DEFAULT_SHIP_CONFIG, enabled: true, reviewer: "claude" };
const DIFF = "diff --git a/src/x.ts b/src/x.ts\n+const x = 1;\n";

type Reply = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout: string): Reply => ({ exitCode: 0, stdout, stderr: "" });

/** A fake `run`: `gh pr view` returns the base branch, `git diff` returns the diff, `claude` returns the reply; every call is recorded. */
function fakeRun(
	claude: Partial<Reply>,
	git: Reply = ok(DIFF),
	view: Reply = ok('{"baseRefName":"master"}'),
) {
	const calls: { argv: string[]; stdin?: string }[] = [];
	const run: Run = (argv, opts) => {
		calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
		if (argv[0] === "git") return git;
		if (argv[0] === "gh") return view;
		return { exitCode: 0, stdout: "", stderr: "", ...claude };
	};
	return { run, calls };
}

const input = {
	cwd: "/repo",
	repo: "acme/app",
	prNumber: 7,
	headSha: "abc123",
	timeoutMs: 1000,
	now: () => 42,
};

describe("parseReview", () => {
	test("valid JSON object parses to score and trimmed non-empty comments", () => {
		expect(parseReview('{"score": 4, "comments": [" null check missing ", ""]}')).toEqual({
			ok: true,
			score: 4,
			comments: ["null check missing"],
		});
	});

	test("a single code fence around the JSON is accepted", () => {
		expect(parseReview('```json\n{"score": 5, "comments": []}\n```')).toEqual({
			ok: true,
			score: 5,
			comments: [],
		});
	});

	test("non-JSON reply is a parse failure, not a score", () => {
		expect(parseReview("Looks good to me!").ok).toBe(false);
	});

	test("a JSON array or scalar is not a review", () => {
		expect(parseReview("[5]").ok).toBe(false);
		expect(parseReview("5").ok).toBe(false);
	});

	test.each([
		['{"score": 6, "comments": []}'],
		['{"score": -1, "comments": ["x"]}'],
		['{"score": 4.5, "comments": ["x"]}'],
		['{"score": "5", "comments": []}'],
		['{"comments": []}'],
	])("out-of-range or non-integer score is rejected: %s", (reply) => {
		expect(parseReview(reply).ok).toBe(false);
	});

	test("comments must be a list of strings", () => {
		expect(parseReview('{"score": 3, "comments": [1]}').ok).toBe(false);
		expect(parseReview('{"score": 3, "comments": "bad"}').ok).toBe(false);
	});
});

describe("reviewWithClaude", () => {
	test("valid reply completes with the same fields Greptile returns", async () => {
		const { run, calls } = fakeRun(
			ok('{"score": 4, "comments": ["src/x.ts: unchecked input"]}'),
		);
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toEqual({
			source: "cli",
			status: "completed",
			score: 4,
			comments: [{ body: "src/x.ts: unchecked input" }],
			headSha: "abc123",
			at: 42,
		});
		expect(calls[0]?.argv).toEqual([
			"gh", "pr", "view", "7", "--repo", "acme/app", "--json", "baseRefName",
		]);
		expect(calls[1]?.argv).toEqual(["git", "fetch", "--quiet", "origin", "master"]);
		expect(calls[2]?.argv).toEqual(["git", "diff", "origin/master...abc123"]);
		expect(calls[3]?.argv).toEqual(["claude", "-p", "--model", CLAUDE_REVIEW_MODEL]);
		expect(CLAUDE_REVIEW_MODEL).toBe("claude-haiku-5-5");
		expect(calls[3]?.stdin).toBe(`${CLAUDE_REVIEW_PROMPT}\n\n${DIFF}`);
	});

	test("score 5 with no comments completes and passes the gate", async () => {
		const { run } = fakeRun(ok('{"score": 5, "comments": []}'));
		const result = await reviewWithClaude({ ...input, run });
		expect(result.status).toBe("completed");
		expect(result.score).toBe(5);
		expect(reviewPasses(config, result)).toBe(true);
	});

	test("score below 5 with comments completes but does not pass the gate", async () => {
		const { run } = fakeRun(ok('{"score": 4, "comments": ["race in cache write"]}'));
		const result = await reviewWithClaude({ ...input, run });
		expect(result.status).toBe("completed");
		expect(reviewPasses(config, result)).toBe(false);
	});

	test("non-JSON reply fails with no score", async () => {
		const { run } = fakeRun(ok("I think it is fine."));
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null, comments: [] });
		expect(result.error).toContain("not JSON");
	});

	test("out-of-range score fails with no score", async () => {
		const { run } = fakeRun(ok('{"score": 9, "comments": []}'));
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null, comments: [] });
	});

	test("score 5 that lists issues fails: score must match findings", async () => {
		const { run } = fakeRun(ok('{"score": 5, "comments": ["bug"]}'));
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null });
	});

	test("score below 5 that lists no issue fails", async () => {
		const { run } = fakeRun(ok('{"score": 3, "comments": []}'));
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null });
	});

	test("non-zero claude exit fails with the exit code and no score", async () => {
		const { run } = fakeRun({ exitCode: 1, stderr: "rate limited" });
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null, comments: [] });
		expect(result.error).toContain("exit 1");
		expect(result.error).toContain("rate limited");
	});

	test("failed git diff fails before claude runs", async () => {
		const { run, calls } = fakeRun(ok('{"score": 5, "comments": []}'), {
			exitCode: 128,
			stdout: "",
			stderr: "unknown revision",
		});
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null });
		expect(result.error).toContain("unknown revision");
		expect(calls.map((c) => c.argv[0])).toEqual(["gh", "git"]);
	});

	test("failed gh pr view, or no base branch in its reply, fails before git runs", async () => {
		const viewFailure = fakeRun(ok('{"score": 5, "comments": []}'), ok(DIFF), {
			exitCode: 1,
			stdout: "",
			stderr: "no pull request found",
		});
		const failedView = await reviewWithClaude({ ...input, run: viewFailure.run });
		expect(failedView).toMatchObject({ status: "failed", score: null });
		expect(failedView.error).toContain("no pull request found");
		expect(viewFailure.calls.map((c) => c.argv[0])).toEqual(["gh"]);

		const noBase = fakeRun(ok('{"score": 5, "comments": []}'), ok(DIFF), ok("{}"));
		const result = await reviewWithClaude({ ...input, run: noBase.run });
		expect(result).toMatchObject({ status: "failed", score: null });
		expect(noBase.calls.map((c) => c.argv[0])).toEqual(["gh"]);
	});

	test("empty diff fails", async () => {
		const { run } = fakeRun(ok('{"score": 5, "comments": []}'), ok("  \n"));
		const result = await reviewWithClaude({ ...input, run });
		expect(result).toMatchObject({ status: "failed", score: null });
	});
});

describe("reviewer selection", () => {
	test("only reviewer: claude selects the Claude reviewer", () => {
		expect(usesClaudeReviewer({ reviewer: "claude" })).toBe(true);
		expect(usesClaudeReviewer({ reviewer: "greptile" })).toBe(false);
	});

	test("the default reviewer is greptile", () => {
		expect(DEFAULT_SHIP_CONFIG.reviewer).toBe("greptile");
		expect(usesClaudeReviewer(DEFAULT_SHIP_CONFIG)).toBe(false);
	});
});
