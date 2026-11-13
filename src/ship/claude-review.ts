// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude review for ship's review step. A headless `claude -p` call reads the PR diff and returns a score and comments.
 * It reports the same ReviewResult as the Greptile review, so the merge gate (reviewPasses) judges both alike.
 * The reviewer is chosen only by `ShipConfig.reviewer`; see usesClaudeReviewer.
 */
import { redactSecrets } from "../redact.ts";
import { defaultRun } from "./run.ts";
import { GREPTILE_MAX_SCORE, type ReviewResult, type Run, type ShipConfig } from "./types.ts";

export const CLAUDE_REVIEW_MODEL = "claude-haiku-5-5";

/** A diff review can take minutes; the merge wait budget (`waitMs`) is for polling, not for this call. */
export const CLAUDE_REVIEW_TIMEOUT_MS = 600_000;

/** Fixed review instruction; the PR diff follows it on stdin. */
export const CLAUDE_REVIEW_PROMPT = [
	"You review a GitHub pull request diff for correctness, security, and regressions.",
	"- Correctness: logic errors, wrong results, unhandled error paths on new code.",
	"- Security: injection, secret exposure, authorization or permission bypass, unsafe input handling.",
	"- Regressions: changed behavior that breaks existing callers, removed code still in use, broken contracts.",
	"Report only concrete issues you can point to in the diff. No style nits, no speculation.",
	`Score from 0 to ${GREPTILE_MAX_SCORE} as an integer. Score ${GREPTILE_MAX_SCORE} only when there are no issues at all; any issue means a lower score.`,
	'Respond with ONLY a JSON object and no other text, no code fence: {"score": <integer 0-5>, "comments": [<string>, ...]}.',
	"Each comment states one issue: file and line when known, then what is wrong. Use an empty array when there are no issues.",
	"The diff follows.",
].join("\n");

export type ParsedReview =
	| { ok: true; score: number; comments: string[] }
	| { ok: false; error: string };

/** Parses the model reply: one JSON object, optionally inside a single code fence. Never invents a score. */
export function parseReview(stdout: string): ParsedReview {
	const text = stdout
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, error: "review reply is not JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, error: "review reply is not a JSON object" };
	}
	const { score, comments } = value as Record<string, unknown>;
	const scoreOk =
		typeof score === "number" && Number.isInteger(score) && score >= 0 && score <= GREPTILE_MAX_SCORE;
	if (!scoreOk) {
		return { ok: false, error: `review score is not an integer 0-${GREPTILE_MAX_SCORE}` };
	}
	if (!Array.isArray(comments) || !comments.every((c) => typeof c === "string")) {
		return { ok: false, error: "review comments are not a list of strings" };
	}
	return {
		ok: true,
		score,
		comments: comments.map((c) => c.trim()).filter((c) => c.length > 0),
	};
}

/** One line of a failure message, secrets redacted, at most 200 chars. */
function shortError(text: string): string {
	const line = redactSecrets(text).replace(/\s+/g, " ").trim();
	return line.slice(0, 200) || "unknown error";
}

/** The PR's base branch from `gh pr view --json baseRefName`; undefined for anything unusable, so no name starting with "-" reaches git. */
function baseBranch(stdout: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed !== "object" || parsed === null || !("baseRefName" in parsed)) return undefined;
		const name = typeof parsed.baseRefName === "string" ? parsed.baseRefName.trim() : "";
		return name && !name.startsWith("-") ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reviews the PR's diff with Claude. Status is "completed" with a score and comments, or "failed" with a short error.
 * A score of 5 requires no comments and a lower score requires at least one, so the score always matches the findings.
 */
export async function reviewWithClaude(input: {
	run?: Run;
	cwd: string;
	/** owner/repo */
	repo: string;
	prNumber: number;
	headSha: string;
	/** Bound on each child process (gh and claude). */
	timeoutMs: number;
	now?: () => number;
}): Promise<ReviewResult> {
	const run = input.run ?? defaultRun;
	const failed = (error: string): ReviewResult => ({
		source: "cli",
		status: "failed",
		score: null,
		comments: [],
		headSha: input.headSha,
		error: shortError(error),
		at: (input.now ?? Date.now)(),
	});
	const view = run(
		["gh", "pr", "view", String(input.prNumber), "--repo", input.repo, "--json", "baseRefName"],
		{ cwd: input.cwd, timeoutMs: input.timeoutMs },
	);
	if (view.exitCode !== 0) return failed(`gh pr view failed: ${view.stderr}`);
	const base = baseBranch(view.stdout);
	if (!base) return failed("gh pr view returned no usable base branch");
	const fetched = run(["git", "fetch", "--quiet", "origin", base], {
		cwd: input.cwd,
		timeoutMs: input.timeoutMs,
	});
	if (fetched.exitCode !== 0) return failed(`git fetch failed: ${fetched.stderr}`);
	// The reviewed commit, not the live PR head: the diff is exactly origin/base...headSha.
	const diff = run(["git", "diff", `origin/${base}...${input.headSha}`], {
		cwd: input.cwd,
		timeoutMs: input.timeoutMs,
	});
	if (diff.exitCode !== 0) return failed(`git diff failed: ${diff.stderr}`);
	if (!diff.stdout.trim()) return failed("git diff returned an empty diff");
	const reply = run(["claude", "-p", "--model", CLAUDE_REVIEW_MODEL], {
		cwd: input.cwd,
		timeoutMs: input.timeoutMs,
		stdin: `${CLAUDE_REVIEW_PROMPT}\n\n${diff.stdout}`,
	});
	if (reply.exitCode !== 0) {
		return failed(`claude review failed (exit ${reply.exitCode}): ${reply.stderr}`);
	}
	const parsed = parseReview(reply.stdout);
	if (!parsed.ok) return failed(parsed.error);
	if (parsed.score === GREPTILE_MAX_SCORE && parsed.comments.length > 0) {
		return failed(`review scored ${GREPTILE_MAX_SCORE}/${GREPTILE_MAX_SCORE} but listed issues`);
	}
	if (parsed.score < GREPTILE_MAX_SCORE && parsed.comments.length === 0) {
		return failed(`review scored ${parsed.score}/${GREPTILE_MAX_SCORE} but listed no issue`);
	}
	return {
		source: "cli",
		status: "completed",
		score: parsed.score,
		comments: parsed.comments.map((body) => ({ body })),
		headSha: input.headSha,
		at: (input.now ?? Date.now)(),
	};
}

/** The config's `reviewer` key alone decides the review step: "claude" uses reviewWithClaude, anything else Greptile. */
export function usesClaudeReviewer(config: Pick<ShipConfig, "reviewer">): boolean {
	return config.reviewer === "claude";
}
