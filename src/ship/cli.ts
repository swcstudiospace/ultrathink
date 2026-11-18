// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ultrathink-ship: assess | pr | review | merge | run | resolve <phase> | status --state <sessions/<id>.json> [--cwd <dir>].
 * Prints one JSON object; always exits 0 except usage errors (2). Fails open; the merge gate on the phase record fails closed.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";
import type { ClaudeCompleter } from "../claude/complete.ts";
import type { SessionRecord } from "../claude/state.ts";
import { defaultStateDir, HOOK_LOCK, readControl } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { createDecisions } from "../decisions/gate.ts";
import type { Decisions } from "../decisions/gate.ts";
import { selectJudgeEngine } from "../host/engine.ts";
import { findPhaseDirectory, openHtilEntries, verificationEntryId } from "../host/omp-phase.ts";
import { createMcpClientIfCredentialed } from "../mcp/client.ts";
import type { McpClient } from "../mcp/client.ts";
import { storePath } from "../mcp/store.ts";
import { fileStore } from "../workflow/phase-loop-store.ts";
import {
	confirmShip,
	recordAudit,
	resolve as resolveHumanItem,
	type ShipConfirmationInput,
} from "../workflow/phase-loop.ts";
import { assessDecisionJson, assessDone } from "./assess.ts";
import { CLAUDE_REVIEW_TIMEOUT_MS, reviewWithClaude, usesClaudeReviewer } from "./claude-review.ts";
import { createGithub } from "./github.ts";
import type { Github, ReviewThreadsOptions } from "./github.ts";
import { openThreadComments, runReview } from "./greptile.ts";
import type { ToolCaller } from "./greptile.ts";
import { mergeGate, reviewPasses } from "./merge.ts";
import { buildPr } from "./pr-body.ts";
import { defaultRun } from "./run.ts";
import { collectSignals, gatherDiff } from "./signals.ts";
import { appendAttempts, archiveShip, readShip, writeShip } from "./state.ts";
import { GREPTILE_MAX_SCORE } from "./types.ts";
import type {
	Assessment,
	PrRef,
	PrStatus,
	ReviewComment,
	ReviewResult,
	Run,
	ShipAttempt,
	ShipConfig,
	ShipState,
} from "./types.ts";

export interface ShipDeps {
	config: ShipConfig;
	run: Run;
	now: () => number;
	github: (cwd: string) => Github;
	review: typeof runReview;
	assess: typeof assessDone;
	signals: typeof collectSignals;
	diff: typeof gatherDiff;
	/** Judge for this session; it follows the session's provider. `label` names its first candidate; `answering`, when given, names the one that answered. Undefined when no judge is available. */
	engine: (
		record: SessionRecord,
	) => Promise<
		{ complete: ClaudeCompleter; label: string; answering?: () => string | undefined } | undefined
	>;
	greptile: () => ToolCaller | undefined;
	/** Waits between merge polls; tests inject a fake clock. */
	sleep: (ms: number) => Promise<void>;
	/** Jev runtime for the `ship` decision of this session; absent = no Jev (today's assessment). */
	decisions?: (record: SessionRecord) => Decisions | undefined;
	/** Directory of the phase loop records; the merge is confirmed against the session's record in it. */
	phaseLoopDir: string;
}

type Output = Record<string, unknown>;
type ShipRecord = SessionRecord & { ship?: ShipState };

/**
 * `merge` and `run` take `--owner-override <reason>` with `--owner <name>`: the owner decision closes the phase without a
 * passing audit, and the reason is kept in the phase record. `resolve <phase>` closes the phase's open HTIL entry
 * (`verification:<phase directory>`) with `--owner <name>` and `--evidence <text>` as the owner's evidence.
 */
const USAGE =
	"usage: ultrathink-ship assess|pr|review|merge|run|status --state <sessions/<id>.json> [--cwd <dir>] [--ignore-gsd] [--approve] [--owner <name> --owner-override <reason>] | ultrathink-ship resolve <phase> --state <sessions/<id>.json> --owner <name> --evidence <text> [--cwd <dir>]";
const NEXT_FIX =
	"fix the listed findings, commit only the files you edited, push, then run review again";
const NEXT_PENDING =
	"Greptile review still running; run review again (safe to repeat, it resumes the same review)";

/** What the agent does when the merge gate refuses for a reason only a new commit can fix. */
const GATE_NEXT: Record<string, string> = {
	"CI checks failing": "CI checks failing: fix CI, commit, push, then run review again",
	"merge conflicts": "merge conflicts: resolve them against the base, push, then run review again",
};
/** Gate reasons that clear on their own; `merge` keeps retrying through them. */
const TRANSIENT_GATE: Record<string, true> = {
	"CI checks pending": true,
	"GitHub has not computed mergeability yet": true,
};
/** GitHub merge errors that clear without a new commit: branch protection awaiting a human (bounded by mergeTimeoutMs) or rate limits. */
const TRANSIENT_MERGE_ERROR = /base branch policy prohibits|rate limit/i;
/** GitHub merge errors no retry or new commit fixes: a human must act. */
const TERMINAL_MERGE_ERROR = new RegExp(
	[
		"approv|review(s)? required|changes requested|permission|forbidden|not authori[sz]ed|pull request is closed|PR is CLOSED",
		"resource not accessible|must have (admin|write|push|maintain)|insufficient (scopes|permissions)|not permitted",
	].join("|"),
	"i",
);
/** GitHub merge errors the agent fixes with a new commit and review. */
const AGENT_MERGE_ERROR =
	/conflict|not mergeable|out of date|behind|update the branch|head branch was modified|head commit/i;
const MAX_POLL_MS = 60_000;
const MERGED_OUTSIDE = "PR was merged outside the ship flow before its review passed";

/** The ship state write did not land: the step fails with this error, since its outcome is not recorded. */
const STATE_WRITE_ERROR = "state write failed: the ship state file could not be written";
const NEXT_STATE_WRITE = "fix the ship state file so it can be written, then run again";
/** The merge happened on GitHub but its state write failed: the merge is not recorded in the ship state. */
const MERGED_STATE_WRITE_ERROR =
	"state write failed after the merge: the PR was merged on GitHub but the ship state file could not be written";
const NEXT_MERGED_STATE_WRITE =
	"the PR is merged; fix the ship state file, then run merge again to record it";

/** Next step when the review passed but the PR itself is not mergeable yet. */
function prWaitNext(reason: string): string {
	const next = GATE_NEXT[reason];
	return next ? `review passed; ${next}` : `review passed; ${reason}: wait, then run merge again`;
}

const isFailedReview = (round: ReviewResult) =>
	round.status === "failed" || round.status === "timeout";

/** Rounds counted toward ship.maxRounds: completed reviews that did not pass. Failed or timed-out reviews never count. */
function countFailedRounds(config: ShipConfig, rounds: ReviewResult[]): number {
	return rounds.filter((round) => round.status === "completed" && !reviewPasses(config, round))
		.length;
}

/** Minutes with one decimal, for messages. */
const minutes = (ms: number) => String(Math.round(ms / 6000) / 10);

/** One attempt as a PR-comment list line: `- <ISO time> <step> <sha7> <outcome>[ <score>/5][ — <detail>]`. */
function formatAttempt(attempt: ShipAttempt): string {
	const at = Number.isFinite(attempt.at) ? new Date(attempt.at).toISOString() : String(attempt.at);
	const score = typeof attempt.score === "number" ? ` ${attempt.score}/${GREPTILE_MAX_SCORE}` : "";
	const detail = attempt.detail ? ` — ${attempt.detail}` : "";
	return `- ${at} ${attempt.step} ${attempt.headSha.slice(0, 7)} ${attempt.outcome}${score}${detail}`;
}

/** The one PR comment posted when the ship stops; shared by review and merge. */
function stoppedComment(input: {
	reason: string;
	score: number | null | undefined;
	failedRounds: number;
	findings: ReviewComment[];
	attempts: ShipAttempt[];
}): string {
	const findings = input.findings
		.slice(0, 20)
		.map((c) =>
			`- ${c.path ?? "?"}${c.line ? `:${c.line}` : ""} ${c.severity ?? ""} ${c.body.split("\n")[0]}`.replace(
				/ +/g,
				" ",
			),
		);
	const attempts = input.attempts.slice(-10).map(formatAttempt);
	return [
		`**ultrathink-ship stopped:** ${input.reason}`,
		`Greptile score: ${input.score ?? "n/a"}/${GREPTILE_MAX_SCORE} after ${input.failedRounds} failed round(s).`,
		...(findings.length ? ["Remaining findings:", ...findings] : []),
		...(attempts.length ? ["Attempts:", ...attempts] : []),
		"Left open for human follow-up.",
	].join("\n");
}

function readRecord(statePath: string): ShipRecord | undefined {
	try {
		return JSON.parse(readFileSync(statePath, "utf8")) as ShipRecord;
	} catch {
		return undefined;
	}
}

/** A step's result when its ship state write did not land: nothing is recorded, so the step fails. */
function stateWriteFailed(): Output & { ok: false } {
	return { ok: false, error: STATE_WRITE_ERROR, next: NEXT_STATE_WRITE };
}

/**
 * Writes a review's round and phase under the state lock, onto the rounds the state holds now: the review ran with no
 * lock held, so a round another run recorded meanwhile is kept. `replaces` (a reused round) is swapped for this round in
 * place; otherwise this round is appended. The rest of the ship is merged as `writeShip` does. False when the state file
 * cannot be written.
 */
function writeReviewRound(
	statePath: string,
	round: { result: ReviewResult; replaces?: ReviewResult },
	patch: Partial<ShipState>,
	now: number,
): boolean {
	return withFileLock(
		statePath,
		() => {
			const record = readRecord(statePath);
			if (!record) return false;
			const prior: Partial<ShipState> = record.ship ?? {};
			const current = prior.rounds ?? [];
			const { result, replaces } = round;
			const index =
				replaces === undefined
					? -1
					: current.findLastIndex(
							(entry) =>
								entry.at === replaces.at &&
								entry.headSha === replaces.headSha &&
								entry.status === replaces.status,
						);
			const rounds =
				index < 0
					? [...current, result]
					: current.map((entry, i) => (i === index ? result : entry));
			const ship: ShipState = { phase: "not-done", ...prior, ...patch, rounds, updatedAt: now };
			try {
				writeFileAtomic(statePath, `${JSON.stringify({ ...record, ship }, null, 2)}\n`);
				return true;
			} catch {
				return false;
			}
		},
		HOOK_LOCK,
	);
}

interface Ctx {
	deps: ShipDeps;
	statePath: string;
	cwd: string;
	/** Leave the repository's GSD roadmap out of the done assessment; the operator decided it is separate work. */
	ignoreGsd: boolean;
	/** The operator approved the merge (`--approve`); a passing Claude review merges only with it. */
	approve: boolean;
	/** The owner's `--owner-override` decision: a merge or run that proceeds without a passing audit; undefined otherwise. */
	override: ShipOverride | undefined;
}

/** The owner's answer to an open HTIL entry: the phase (a phase number or directory name) whose verification entry it closes, who resolved it, and the evidence. */
interface Resolution {
	phase: string;
	owner: string;
	evidence: string;
}

/** The owner decision that lets a merge or run proceed without a passing audit (`--owner-override`). */
interface ShipOverride {
	owner: string;
	reason: string;
}

/** owner/repo of a recorded PR: its own `repo`, else parsed from a `https://github.com/<owner>/<repo>/pull/<n>` url. */
function prRepo(pr: PrRef): string | undefined {
	if (pr.repo) return pr.repo;
	const match = pr.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
	return match ? `${match[1]}/${match[2]}` : undefined;
}

async function stepAssess(ctx: Ctx): Promise<Output & { done: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const record = readRecord(statePath);
	if (!record) return { ok: false, done: false, reason: "state file missing or unreadable" };
	const probed = deps.signals({ cwd, record, run: deps.run });
	const signals = ctx.ignoreGsd ? { ...probed, gsd: undefined, gsdIgnored: true } : probed;
	let pr = record.ship?.pr;
	if (record.ship && pr) {
		// One session ships sequentially: a merged ship is always archived (re-assessing it must not reopen the merged PR),
		// a blocked ship of another repository or branch is archived, an active one elsewhere refuses.
		const priorRepo = prRepo(pr);
		const elsewhere =
			(priorRepo && signals.git.repo && priorRepo !== signals.git.repo) ||
			pr.head !== signals.git.branch;
		const { phase } = record.ship;
		if (elsewhere && phase !== "merged" && phase !== "blocked") {
			return {
				ok: false,
				done: false,
				reason: `this session is still shipping ${pr.url} (phase ${phase}); finish or block that ship before assessing another repository or branch`,
			};
		}
		if (phase === "merged" || elsewhere) {
			if (!archiveShip(statePath, deps.now())) {
				return {
					ok: false,
					done: false,
					error: `could not archive the finished ship ${pr.url}: ${STATE_WRITE_ERROR}`,
					next: NEXT_STATE_WRITE,
				};
			}
			pr = undefined;
		}
	}
	const diff = signals.git.base
		? deps.diff({ cwd, base: signals.git.base, run: deps.run })
		: { stat: "", log: "" };
	const judgeEngine = await deps.engine(record);
	const mode = deps.config.judge;
	const decisions = deps.decisions?.(record);
	const { autoMerge } = deps.config;
	let assessment: Assessment = await deps.assess({
		record,
		signals,
		diff,
		complete: judgeEngine?.complete,
		judgedBy: judgeEngine?.label,
		now: deps.now,
		mode,
		decisions,
		autoMerge,
	});
	// The judge's provenance names the candidate that answered, not the first one tried (a failover moves the answer).
	const answered = judgeEngine?.answering?.();
	if (assessment.judgedBy && answered) assessment = { ...assessment, judgedBy: answered };
	// A rules-only "done" (no judge ran) never auto-merges in gate mode; with autoMerge assess never lets Jev stand in.
	if (mode === "gate" && autoMerge && assessment.source === "rules" && assessment.done) {
		assessment = { ...assessment, done: false, gaps: [...assessment.gaps, "no judge available"] };
	}
	const recorded = writeShip(
		statePath,
		{ assessment, phase: assessment.done && pr ? "pr-open" : "not-done" },
		deps.now(),
	);
	if (!recorded) return { ...stateWriteFailed(), done: false };
	const { done, confidence, summary, gaps, judge, source, decision } = assessment;
	// Jev additions only: `decision` when the point ran, plus `source` when Jev itself gave the verdict.
	const jev = decision
		? { ...(source === "jev" ? { source } : {}), decision: assessDecisionJson(decision) }
		: {};
	return {
		ok: true,
		done,
		confidence,
		summary,
		gaps,
		mode: assessment.mode ?? mode,
		...(judge ? { judge } : {}),
		...(assessment.judgedBy ? { judgedBy: assessment.judgedBy } : {}),
		...jev,
		signals,
	};
}

async function stepPr(ctx: Ctx): Promise<Output & { ok: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const record = readRecord(statePath);
	const assessment = record?.ship?.assessment;
	if (!record || !assessment?.done)
		return { ok: false, reason: "task not assessed as done; run assess first" };
	const { git } = deps.signals({ cwd, record, run: deps.run });
	if (!git.branch) return { ok: false, reason: "no current branch (detached HEAD?)" };
	if (assessment.signals.git.branch !== git.branch) {
		return {
			ok: false,
			reason: `branch changed since assessment (${assessment.signals.git.branch ?? "none"} -> ${git.branch}); run assess again`,
		};
	}
	if (git.onBase)
		return {
			ok: false,
			reason: `on base branch ${git.base ?? ""}; work must be on a feature branch`,
		};
	if (git.dirty.length > 0)
		return { ok: false, reason: `uncommitted tracked changes: ${git.dirty.join(", ")}` };
	const github = deps.github(cwd);
	const repo = github.repo();
	const base = repo?.defaultBranch ?? git.base;
	if (!base) return { ok: false, reason: "could not determine default branch" };
	const pushed = github.push(git.branch);
	if (!pushed.ok) return { ok: false, reason: `push failed: ${pushed.error ?? "unknown"}` };
	let pr: PrRef | undefined = github.findOpenPr(git.branch);
	const reused = pr !== undefined;
	if (!pr) {
		const created = github.createPr({ base, head: git.branch, ...buildPr(record, assessment) });
		if ("error" in created) return { ok: false, reason: `create PR failed: ${created.error}` };
		pr = created;
	}
	pr = { ...pr, head: git.branch, ...(repo?.name ? { repo: repo.name } : {}) };
	if (!writeShip(statePath, { pr, phase: "pr-open" }, deps.now())) return stateWriteFailed();
	return { ok: true, pr, reused };
}

async function stepReview(ctx: Ctx): Promise<Output & { ready: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const started = deps.now();
	// The review call blocks up to waitMs; its thread scans share that single-call budget (same pattern as stepMerge).
	const threadDeadline = started + deps.config.waitMs;
	const ship = readShip(statePath);
	const pr = ship?.pr;
	if (!pr) return { ok: false, ready: false, reason: "no PR; run pr first" };
	const github = deps.github(cwd);
	const status = github.prStatus(pr.number);
	if (!status) return { ok: false, ready: false, reason: "could not read PR status" };
	const repo = github.repo()?.name;
	if (!repo) return { ok: false, ready: false, reason: "could not resolve GitHub repo" };
	const prior = ship.rounds.at(-1);
	const reusedRound = prior?.status === "completed" && prior.headSha === status.headSha;
	if (!reusedRound) {
		// CLI mode reviews local HEAD and the gate records the PR head: they must be the same commit.
		const local = deps.run(["git", "rev-parse", "HEAD"], { cwd });
		const head = local.exitCode === 0 ? local.stdout.trim() : "";
		if (head !== status.headSha) {
			return {
				ok: false,
				ready: false,
				reason: `local HEAD ${head.slice(0, 7) || "unknown"} differs from PR head ${status.headSha.slice(0, 7)}; push your commits (or pull) first`,
				next: "git push, then run review again",
			};
		}
	}
	// Reviews of this head that failed or timed out are never resumed: the next call triggers a fresh one.
	const failedHere = ship.rounds.filter(
		(round) => isFailedReview(round) && round.headSha === status.headSha,
	);
	const staleReviewIds = failedHere.flatMap((round) => (round.reviewId ? [round.reviewId] : []));
	// One without an id cannot be marked stale: restart ignores every existing review of the head, unless the fresh
	// review it started is still pending (then it is resumed, not restarted again).
	const restart =
		failedHere.some((round) => !round.reviewId) && ship.pending?.headSha !== status.headSha;
	let result: ReviewResult = reusedRound
		? prior
		: usesClaudeReviewer(deps.config)
			? await reviewWithClaude({
					run: deps.run,
					cwd,
					repo,
					prNumber: pr.number,
					headSha: status.headSha,
					timeoutMs: CLAUDE_REVIEW_TIMEOUT_MS,
					now: deps.now,
				})
			: await deps.review({
					config: deps.config,
					client: deps.greptile(),
					run: deps.run,
					cwd,
					repo,
					base: pr.base,
					prNumber: pr.number,
					headSha: status.headSha,
					reviewThreads: () =>
						github.reviewThreads(pr.number, { deadlineMs: threadDeadline, now: deps.now }),
					staleReviewIds,
					...(restart ? { restart: true } : {}),
				});
	if (reusedRound && result.source === "pr") {
		// Threads resolved since the round (non-actionable findings) close without a new commit. A failed refresh must not
		// fall back to the stored snapshot: a finding posted since then would be missed, so report not ready and persist nothing.
		const threads = github.reviewThreads(pr.number, { deadlineMs: threadDeadline, now: deps.now });
		if (!threads.ok) {
			return {
				ok: false,
				ready: false,
				reason: `could not read review threads: ${threads.error}`,
				next: "run review again",
			};
		}
		result = { ...result, comments: openThreadComments(threads.threads) };
	}
	if (result.status === "unverified") {
		// The completed review remains reusable. Only its thread scan failed, so no round or retry is consumed.
		const recorded = writeShip(statePath, { phase: "pr-open", pending: undefined }, deps.now());
		if (!recorded) return { ...stateWriteFailed(), ready: false };
		return {
			ok: false,
			ready: false,
			status: "unverified",
			reviewId: result.reviewId,
			reason: `could not read review threads: ${result.error ?? "verification unavailable"}`,
			round: ship.rounds.length,
			next: "run review again",
		};
	}
	if (result.status === "blocked") {
		// Greptile is unusable as configured: no round is recorded and the flow stops until the user fixes the setup.
		const reason = result.error ?? "Greptile review blocked";
		const recorded = writeShip(
			statePath,
			{ phase: "blocked", blockedReason: reason, pending: undefined },
			deps.now(),
		);
		if (!recorded) return { ...stateWriteFailed(), ready: false };
		return {
			ok: false,
			ready: false,
			blocked: true,
			status: "blocked",
			reason,
			round: ship.rounds.length,
			next: `stop: ${reason}`,
		};
	}
	const maxRounds = deps.config.maxRounds;
	if (result.status === "pending") {
		const same = ship.pending?.headSha === status.headSha ? ship.pending : undefined;
		const since = same?.since ?? deps.now();
		if (deps.now() - since <= deps.config.reviewTimeoutMs) {
			const runId = result.reviewId ?? same?.runId;
			const pending = {
				headSha: status.headSha,
				source: result.source,
				since,
				...(runId ? { runId } : {}),
			};
			if (!writeShip(statePath, { pending }, deps.now()))
				return { ...stateWriteFailed(), ready: false };
			const error = result.error ? { error: result.error } : {};
			return {
				ok: true,
				ready: false,
				status: "pending",
				pending,
				round: ship.rounds.length,
				maxRounds,
				next: NEXT_PENDING,
				...error,
			};
		}
		const cause = result.error ? ` (last error: ${result.error})` : "";
		const runId = result.reviewId ?? same?.runId;
		result = {
			...result,
			status: "timeout",
			error: `review still pending after ${deps.config.reviewTimeoutMs}ms${cause}`,
			...(runId ? { reviewId: runId } : {}),
		};
	}
	const now = deps.now();
	const rounds: ReviewResult[] = reusedRound
		? [...ship.rounds.slice(0, -1), result]
		: [...ship.rounds, result];
	const gate = mergeGate({ config: deps.config, status, latest: result });
	const failedRounds = countFailedRounds(deps.config, rounds);
	const passed = reviewPasses(deps.config, result);
	// A failed or timed-out review is re-triggered up to reviewRetries times per head; `used` includes this one.
	const failure = isFailedReview(result)
		? result.status === "timeout"
			? "timed out"
			: "failed"
		: undefined;
	const used = failure ? failedHere.length + 1 : 0;
	const retries = deps.config.reviewRetries;
	const errorSuffix = result.error ? `: ${result.error}` : "";
	// A PR merged outside the flow is ready only for cleanup, and only when its review passed.
	const mergedPassing = status.state === "MERGED" && passed;
	const waiting =
		!gate.ok && status.state === "OPEN" && result.headSha === status.headSha && passed;
	const blockedReason =
		gate.ok || waiting || mergedPassing
			? undefined
			: status.state === "MERGED"
				? MERGED_OUTSIDE
				: status.state === "CLOSED"
					? "PR closed without merge"
					: failure
						? used > retries
							? `Greptile review ${failure} ${used} times on ${status.headSha.slice(0, 7)} (ship.reviewRetries ${retries})${errorSuffix}`
							: undefined
						: failedRounds >= maxRounds
							? `max rounds reached: ${gate.reason}`
							: undefined;
	const phase =
		gate.ok || mergedPassing
			? "ready"
			: waiting
				? "pr-open"
				: blockedReason
					? "blocked"
					: "needs-fixes";
	let attempts = ship.attempts ?? [];
	if (!reusedRound) {
		const attempt: ShipAttempt = {
			at: now,
			step: "review",
			headSha: status.headSha,
			outcome:
				result.status === "failed" || result.status === "timeout"
					? result.status
					: passed
						? "passed"
						: "needs-fixes",
			score: result.score,
			detail: result.error ?? gate.reason,
		};
		const logged = appendAttempts(statePath, [attempt], now);
		if (!logged) return { ...stateWriteFailed(), ready: false };
		attempts = logged.attempts ?? [...attempts, attempt];
	}
	// The round is recorded before the stop comment: a failed write posts no comment for a stop the state lacks.
	if (
		!writeReviewRound(
			statePath,
			{ result, replaces: reusedRound ? prior : undefined },
			{ phase, blockedReason, pending: undefined },
			now,
		)
	)
		return { ...stateWriteFailed(), ready: false };
	if (result.status === "completed") {
		// The review stage's audit: a merge of this head cites it in the phase record (LIFE-02).
		const audited = recordReviewAudit(
			deps.phaseLoopDir,
			readRecord(statePath)?.sessionId ?? "",
			status.headSha,
			passed,
			now,
		);
		if (audited !== undefined)
			return {
				ok: false,
				ready: false,
				error: audited,
				next: "fix the phase record so it can be written, then run review again",
			};
	}
	let commented: boolean | undefined;
	if (blockedReason && status.state === "OPEN" && !reusedRound && ship.phase !== "blocked") {
		const body = stoppedComment({
			reason: blockedReason,
			score: result.score,
			failedRounds,
			findings: result.comments,
			attempts,
		});
		commented = github.comment(pr.number, body).ok;
	}
	const next = gate.ok
		? "run merge"
		: mergedPassing
			? "PR already merged: run merge to finish the cleanup"
			: waiting
				? prWaitNext(gate.reason)
				: blockedReason
					? `stop: ${blockedReason}`
					: failure
						? `Greptile review ${failure}${errorSuffix}; run review again to re-trigger it (retry ${used} of ${retries})`
						: NEXT_FIX;
	return {
		ok: true,
		ready: gate.ok || mergedPassing,
		passed,
		blocked: blockedReason !== undefined,
		reused: reusedRound,
		status: result.status,
		score: result.score,
		comments: result.comments,
		gate,
		round: rounds.length,
		failedRounds,
		maxRounds,
		next,
		...(commented === undefined ? {} : { commented }),
	};
}

/** One merge poll's outcome. */
type MergeStep =
	| {
			kind: "merged";
			headSha: string;
			score: number | null | undefined;
			method: ShipConfig["mergeMethod"];
			alreadyMerged: boolean;
	  }
	/** Clears on its own: poll again. `retry` marks a failed GitHub merge call. */
	| { kind: "transient"; reason: string; headSha?: string; retry?: boolean }
	/** Only a new commit and review fix it: back to the agent. */
	| { kind: "needs-agent"; reason: string; next: string; headSha: string }
	/** A human must act; `comment` posts the stopped comment (open PRs only). */
	| { kind: "blocked"; reason: string; headSha: string; comment: boolean }
	/** A passing Claude review waits for the operator's `--approve`; nothing is merged or recorded. */
	| { kind: "needs-approval"; headSha: string };

/** A merge-gate refusal after the review passed: pending CI and mergeability are retried, the rest go back to the agent. */
function classifyGateReason(reason: string, headSha: string): MergeStep {
	if (TRANSIENT_GATE[reason] === true) return { kind: "transient", reason, headSha };
	return {
		kind: "needs-agent",
		reason,
		next: GATE_NEXT[reason] ?? `${reason}; run review again`,
		headSha,
	};
}

/** A failed GitHub merge: refused for good (a human must act), fixable by the agent with a new commit, or retried. */
function classifyMergeError(error: string, headSha: string): MergeStep {
	const transient = {
		kind: "transient",
		reason: `merge failed: ${error}`,
		headSha,
		retry: true,
	} as const;
	if (TRANSIENT_MERGE_ERROR.test(error)) return transient;
	if (TERMINAL_MERGE_ERROR.test(error))
		return { kind: "blocked", reason: `merge refused by GitHub: ${error}`, headSha, comment: true };
	if (AGENT_MERGE_ERROR.test(error))
		return { kind: "needs-agent", reason: error, next: `${error}; run review again`, headSha };
	return transient;
}

/** Why the stored review alone refuses the merge (none, or not passing), or undefined when it passed. No GitHub read. */
function storedReviewRefusal(
	config: ShipConfig,
	latest: ReviewResult | undefined,
	url: string,
): string | undefined {
	if (latest && reviewPasses(config, latest)) return undefined;
	// The review side of the gate alone: a mergeable, check-free stand-in for the PR at the stored head.
	const standIn: PrStatus = {
		state: "OPEN",
		headSha: latest?.headSha ?? "",
		mergeable: "MERGEABLE",
		checks: "none",
		url,
	};
	return mergeGate({ config, status: standIn, latest }).reason;
}

/** The phase record id of the review of `headSha`: the audit a merge of that head cites (LIFE-02). */
const reviewRecordId = (headSha: string): string => `review:${headSha}`;

/**
 * Runs `fn` under the phase-record lock. Undefined, with `fn` not run, when the lock is not taken: the caller refuses, so
 * nothing is written unlocked.
 */
function underPhaseRecordLock<T>(dir: string, fn: () => T): { value: T } | undefined {
	let notTaken = false;
	return withFileLock(dir, () => (notTaken ? undefined : { value: fn() }), {
		...HOOK_LOCK,
		onTimeout: "throw",
		// acquire reports through `log` only when it runs the callback unlocked, and it does so before the callback.
		log: () => {
			notTaken = true;
		},
	});
}

/**
 * The review stage's audit (LIFE-02): records the completed review of `headSha` in the phase record, passed or not, so
 * a merge of that head can cite it. Returns why it was not recorded, or undefined when it was.
 */
function recordReviewAudit(
	dir: string,
	sessionId: string,
	headSha: string,
	passed: boolean,
	at: number,
): string | undefined {
	if (!sessionId) return "session id missing from the state file";
	try {
		const locked = underPhaseRecordLock(dir, () =>
			recordAudit(
				sessionId,
				{
					id: reviewRecordId(headSha),
					kind: "validation",
					result: passed ? "pass" : "fail",
					recordedAt: new Date(at).toISOString(),
				},
				fileStore(dir),
			),
		);
		if (locked === undefined) return "phase record lock not taken; nothing recorded";
		return locked.value.accepted ? undefined : locked.value.refusals.join("; ");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return `phase record unavailable: ${detail}`;
	}
}

/** What a merge confirmation is checked against: the session's record, the reviewed head, and the owner override if given. */
interface PhaseMergeInput {
	cwd: string;
	dir: string;
	sessionId: string;
	headSha: string;
	now: number;
	override: ShipOverride | undefined;
}

/**
 * The phase record gates the merge: the session's record confirms a reviewed head once, and a head that moved after that
 * confirmation is blocked for a human. The close cites the audit the review stage recorded for the head, or, with an owner
 * override, the override, which the record keeps with its reason. Only the store is read; the runtime connection is not
 * evaluated here. An unreadable or unwritable record blocks, so GitHub is never asked to merge on a record the CLI could not
 * read or write.
 */
function confirmPhaseMerge(input: PhaseMergeInput): MergeStep | undefined {
	const { cwd, dir, sessionId, headSha, now, override } = input;
	const blocked = (reason: string): MergeStep => ({
		kind: "blocked",
		reason,
		headSha,
		comment: false,
	});
	if (!sessionId) return blocked("session id missing from the state file");
	const recordId = reviewRecordId(headSha);
	const decisionId = `override:${headSha}`;
	const store = fileStore(dir);
	try {
		const locked = underPhaseRecordLock(dir, (): MergeStep | undefined => {
			const stored = store.load(sessionId);
			if (stored.status === "quarantined")
				return blocked(`phase record is corrupt; set aside at ${stored.quarantinedAs}`);
			const record = stored.status === "found" ? stored.record : undefined;
			const closedBy = record?.closedBy;
			if (closedBy !== undefined) {
				if (closedBy.recordId === recordId || closedBy.recordId === decisionId) return undefined;
				return blocked(
					`phase was confirmed for ${closedBy.recordId}; the head moved, so a human must confirm ${recordId}`,
				);
			}
			// LIFE-05: a human_needed phase whose verification was written after its settle-time record is opened here,
			// so the entries checked below include it.
			openHtilEntries(cwd, sessionId, store);
			// The runtime connection is not evaluated here: the CLI checks only the store.
			const afterVerify = record?.phaseOrder.at(-1) === "Verify";
			let closing: ShipConfirmationInput;
			if (override !== undefined) {
				closing = {
					afterVerify,
					override: {
						decisionId,
						owner: override.owner,
						decidedAt: new Date(now).toISOString(),
						reason: override.reason,
					},
				};
			} else {
				const audit = record?.audits?.find((item) => item.id === recordId);
				if (audit === undefined || audit.result !== "pass") {
					const reason =
						audit === undefined
							? `no recorded audit for ${recordId}`
							: `audit ${recordId} did not pass`;
					return { kind: "needs-agent", reason, next: `${reason}; run review again`, headSha };
				}
				closing = { afterVerify, audit, auditId: recordId };
			}
			const outcome = confirmShip(sessionId, closing, () => true, store);
			if (outcome.accepted) return undefined;
			const reason = outcome.refusals.join("; ");
			return {
				kind: "needs-agent",
				reason,
				next: `${reason}; resolve it in the phase record, then run merge again`,
				headSha,
			};
		});
		if (locked === undefined) return blocked("phase record lock not taken; nothing merged");
		return locked.value;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return blocked(`phase record unavailable: ${detail}`);
	}
}

/**
 * One merge poll: merges only when the latest review passed for the PR's exact head commit. A closed PR, or one merged
 * outside the flow, blocks; a stored review that does not pass goes back to the agent and never waits, even when the
 * PR cannot be read.
 */
function mergeOnce(
	config: ShipConfig,
	github: Github,
	ship: ShipState,
	pr: PrRef,
	confirm: (headSha: string) => MergeStep | undefined,
	threadOpts?: ReviewThreadsOptions,
	approved = false,
): MergeStep {
	let latest = ship.rounds.at(-1);
	// After a recorded merge the stored review no longer matters: an unreadable PR is simply retried for the cleanup.
	const refusal = ship.phase === "merged" ? undefined : storedReviewRefusal(config, latest, pr.url);
	const status = github.prStatus(pr.number);
	if (!status) {
		if (!refusal) return { kind: "transient", reason: "could not read PR status" };
		return {
			kind: "needs-agent",
			reason: refusal,
			next: `${refusal}; run review again`,
			headSha: latest?.headSha ?? "",
		};
	}
	const headSha = status.headSha;
	if (status.state === "CLOSED")
		return { kind: "blocked", reason: "PR closed without merge", headSha, comment: false };
	if (status.state === "MERGED") {
		// Cleanup only for a merge this flow made or one whose exact head passed review; anything else is reported, never recorded.
		if (ship.phase === "merged" || (latest?.headSha === headSha && !refusal)) {
			return {
				kind: "merged",
				headSha,
				score: latest?.score,
				method: config.mergeMethod,
				alreadyMerged: true,
			};
		}
		return { kind: "blocked", reason: MERGED_OUTSIDE, headSha, comment: false };
	}
	if (refusal || !latest) {
		const reason = refusal ?? "no review has run";
		return { kind: "needs-agent", reason, next: `${reason}; run review again`, headSha };
	}
	if (latest.headSha !== headSha) {
		const reason = "PR head changed since last review";
		return { kind: "needs-agent", reason, next: `${reason}; run review again`, headSha };
	}
	if (latest.source === "pr") {
		// Merge on the PR's current threads, never on the stored snapshot; an unreadable thread list refuses this poll.
		const threads = github.reviewThreads(pr.number, threadOpts);
		if (!threads.ok)
			return {
				kind: "transient",
				reason: `could not read review threads: ${threads.error}`,
				headSha,
			};
		latest = { ...latest, comments: openThreadComments(threads.threads) };
	}
	const gate = mergeGate({ config, status, latest });
	if (!reviewPasses(config, latest))
		return {
			kind: "needs-agent",
			reason: gate.reason,
			next: `${gate.reason}; run review again`,
			headSha,
		};
	if (!gate.ok) return classifyGateReason(gate.reason, headSha);
	// A passing Claude review never merges on its own: the operator approves the merge with --approve.
	if (usesClaudeReviewer(config) && !approved) return { kind: "needs-approval", headSha };
	// The phase record gates the merge: this head is confirmed there before GitHub is asked to merge.
	const refused = confirm(headSha);
	if (refused) return refused;
	const allowed = github.mergeMethods();
	const method =
		allowed.length > 0 && !allowed.includes(config.mergeMethod)
			? (allowed[0] ?? config.mergeMethod)
			: config.mergeMethod;
	const merged = github.merge({ number: pr.number, method, headSha });
	if (merged.ok)
		return { kind: "merged", headSha, score: latest.score, method, alreadyMerged: false };
	return classifyMergeError(merged.error ?? "unknown", headSha);
}

/** Stops the ship: phase blocked, a "blocked" attempt, and on an open PR the stopped comment once. */
function blockMerge(
	ctx: Ctx,
	github: Github,
	ship: ShipState,
	pr: PrRef,
	block: { reason: string; headSha: string; comment: boolean },
	now: number,
): Output & { ok: boolean } {
	const { deps, statePath } = ctx;
	const attempt: ShipAttempt = {
		at: now,
		step: "merge",
		headSha: block.headSha,
		outcome: "blocked",
		detail: block.reason,
	};
	const logged = appendAttempts(statePath, [attempt], now);
	// The stop is recorded before its comment: a failed write posts nothing for a stop the state lacks.
	// A later merge of this head (after a new review) starts a fresh bound instead of blocking again at once.
	const recorded = writeShip(
		statePath,
		{ phase: "blocked", blockedReason: block.reason, waiting: undefined },
		now,
	);
	if (!logged || !recorded)
		return { ...stateWriteFailed(), merged: false, blocked: true, reason: block.reason };
	const attempts = logged.attempts ?? [...(ship.attempts ?? []), attempt];
	let commented: boolean | undefined;
	if (block.comment && ship.phase !== "blocked") {
		const body = stoppedComment({
			reason: block.reason,
			score: ship.rounds.at(-1)?.score,
			failedRounds: countFailedRounds(deps.config, ship.rounds),
			findings: [],
			attempts,
		});
		commented = github.comment(pr.number, body).ok;
	}
	return {
		ok: false,
		merged: false,
		blocked: true,
		reason: block.reason,
		next: `stop: ${block.reason}`,
		...(commented === undefined ? {} : { commented }),
	};
}

/** After the merge (by this flow or already on GitHub): branch cleanup, phase merged, a "merged" attempt. */
function finishMerge(
	ctx: Ctx,
	github: Github,
	ship: ShipState,
	pr: PrRef,
	merged: Extract<MergeStep, { kind: "merged" }>,
	now: number,
): Output & { ok: boolean } {
	const { deps, statePath } = ctx;
	const cleanup: Output = {};
	if (deps.config.deleteBranch) {
		const deleted = github.deleteRemoteBranch(pr.head);
		// The merged head lets syncBase delete a squash/rebase-merged branch whose tip is exactly what landed.
		const synced = github.syncBase({ base: pr.base, branch: pr.head, headSha: merged.headSha });
		Object.assign(cleanup, { remoteDeleted: deleted.ok, synced: synced.ok });
		if (deleted.error) cleanup.deleteError = deleted.error;
		if (synced.error) cleanup.syncError = synced.error;
	} else {
		// The remote branch stays, so only the local copy goes, and only when its tip is exactly what landed.
		const local = github.deleteLocalBranch({ branch: pr.head, headSha: merged.headSha });
		if (!local.ok) cleanup.localBranch = `error: ${local.error}`;
		else cleanup.localBranch = local.kept === undefined ? "deleted" : `kept: ${local.kept}`;
	}
	const detail = merged.alreadyMerged ? { detail: "PR already merged" } : {};
	const logged = appendAttempts(
		statePath,
		[
			{
				at: now,
				step: "merge",
				headSha: merged.headSha,
				outcome: "merged",
				score: merged.score,
				...detail,
			},
		],
		now,
	);
	const recorded = writeShip(
		statePath,
		{ phase: "merged", mergedAt: ship.mergedAt ?? now, waiting: undefined },
		now,
	);
	const { method } = merged;
	const outcome: Output = {
		merged: true,
		alreadyMerged: merged.alreadyMerged,
		pr,
		method,
		...(method !== deps.config.mergeMethod
			? { methodSubstituted: `${deps.config.mergeMethod} not allowed; used ${method}` }
			: {}),
		...cleanup,
	};
	// The merge already happened on GitHub: a failed write is reported with the merge, not as a failed merge.
	if (!logged || !recorded)
		return {
			...outcome,
			ok: false,
			error: MERGED_STATE_WRITE_ERROR,
			next: NEXT_MERGED_STATE_WRITE,
		};
	return { ...outcome, ok: true, next: "run ultrathink-sync" };
}

/**
 * Merges once the latest review passed for the PR's exact head, retrying transient refusals (pending CI, uncomputed
 * mergeability, unreadable PR state, transient GitHub errors) within `budgetMs`, and blocking after
 * `ship.mergeTimeoutMs` on one head commit.
 */
async function stepMerge(
	ctx: Ctx,
	budgetMs: number = ctx.deps.config.waitMs,
): Promise<Output & { ok: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const { config } = deps;
	if (!config.autoMerge) return { ok: false, merged: false, reason: "autoMerge disabled" };
	const ship = readShip(statePath);
	const pr = ship?.pr;
	if (!pr) return { ok: false, merged: false, reason: "no PR; run pr first" };
	const github = deps.github(cwd);
	const started = deps.now();
	const sessionId = readRecord(statePath)?.sessionId ?? "";
	const confirm = (headSha: string) =>
		confirmPhaseMerge({
			cwd,
			dir: deps.phaseLoopDir,
			sessionId,
			headSha,
			now: deps.now(),
			override: ctx.override,
		});
	let waiting = ship.waiting;
	let delay = config.pollMs;
	for (let polls = 1; ; polls++) {
		const step = mergeOnce(
			config,
			github,
			ship,
			pr,
			confirm,
			{ deadlineMs: started + budgetMs, now: deps.now },
			ctx.approve,
		);
		const now = deps.now();
		if (step.kind === "merged") return finishMerge(ctx, github, ship, pr, step, now);
		if (step.kind === "blocked") return blockMerge(ctx, github, ship, pr, step, now);
		if (step.kind === "needs-approval")
			return {
				ok: false,
				merged: false,
				reason: "needs human approval",
				pr,
				next: `needs human approval: ${pr.url}; review the PR, then run merge with --approve`,
			};
		if (step.kind === "needs-agent") {
			const logged = appendAttempts(
				statePath,
				[
					{
						at: now,
						step: "merge",
						headSha: step.headSha,
						outcome: "needs-agent",
						detail: step.reason,
					},
				],
				now,
			);
			if (!logged) return { ...stateWriteFailed(), merged: false };
			return { ok: false, merged: false, reason: step.reason, next: step.next };
		}
		// An unreadable PR status has no head: count against the reviewed head, never a stale persisted `waiting` head.
		const headSha = step.headSha ?? ship.rounds.at(-1)?.headSha ?? waiting?.headSha ?? "";
		if (
			step.retry &&
			!appendAttempts(
				statePath,
				[{ at: now, step: "merge", headSha, outcome: "retry", detail: step.reason }],
				now,
			)
		)
			return { ...stateWriteFailed(), merged: false };
		if (waiting?.headSha !== headSha) {
			waiting = { headSha, since: now };
			if (!writeShip(statePath, { waiting }, now)) return { ...stateWriteFailed(), merged: false };
		}
		const waitedMs = now - waiting.since;
		if (waitedMs >= config.mergeTimeoutMs) {
			const reason = `merge still not possible after ${minutes(waitedMs)} min on ${headSha.slice(0, 7)}: ${step.reason}`;
			return blockMerge(ctx, github, ship, pr, { reason, headSha, comment: true }, now);
		}
		const remaining = budgetMs - (now - started);
		if (remaining <= 0) {
			const detail = `${step.reason} (${polls} poll(s))`;
			if (
				!appendAttempts(
					statePath,
					[{ at: now, step: "merge", headSha, outcome: "waiting", detail }],
					now,
				)
			)
				return { ...stateWriteFailed(), merged: false };
			const progress = `waited ${minutes(waitedMs)} of ${minutes(config.mergeTimeoutMs)} min on this commit`;
			return {
				ok: false,
				merged: false,
				waiting: true,
				reason: step.reason,
				polls,
				waitedMs,
				next: `run merge again: ${step.reason} (${progress}; it keeps retrying until the PR merges)`,
			};
		}
		await deps.sleep(Math.min(delay, remaining));
		delay = Math.min(delay * 1.5, MAX_POLL_MS);
	}
}

/**
 * Resolves the phase's open HTIL entry `verification:<phase directory>` (LIFE-05) with the owner's evidence and the
 * time, under the phase-record lock. An entry that is not open is refused and nothing is written.
 */
function stepResolve(ctx: Ctx, resolution: Resolution | undefined): Output {
	const { deps, statePath } = ctx;
	if (resolution === undefined)
		return { ok: false, error: "resolve needs a phase, --owner and --evidence" };
	const { phase, owner, evidence } = resolution;
	const sessionId = readRecord(statePath)?.sessionId ?? "";
	if (!sessionId) return { ok: false, error: "session id missing from the state file" };
	const directory = findPhaseDirectory(phase, join(ctx.cwd, ".planning", "phases"));
	if (directory === null)
		return { ok: false, error: `no phase directory matches ${phase} under .planning/phases` };
	const entryId = verificationEntryId(directory);
	const resolvedAt = new Date(deps.now()).toISOString();
	try {
		const locked = underPhaseRecordLock(deps.phaseLoopDir, () =>
			resolveHumanItem(
				sessionId,
				entryId,
				{ state: "done", evidenceId: evidence, resolvedBy: owner, resolvedAt },
				fileStore(deps.phaseLoopDir),
			),
		);
		if (locked === undefined)
			return { ok: false, entryId, error: "phase record lock not taken; nothing resolved" };
		const outcome = locked.value;
		if (!outcome.accepted) return { ok: false, entryId, error: outcome.refusals.join("; ") };
		return { ok: true, entryId, resolvedBy: owner, resolvedAt, next: "run merge" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, entryId, error: `phase record unavailable: ${detail}` };
	}
}

async function stepRun(ctx: Ctx): Promise<Output> {
	const { config } = ctx.deps;
	const started = ctx.deps.now();
	const assess = await stepAssess(ctx);
	if (assess.error !== undefined) return { ok: false, assess, next: NEXT_STATE_WRITE };
	if (!assess.done)
		return { ok: true, assess, next: "task not done: finish the listed gaps, then run again" };
	const pr = await stepPr(ctx);
	if (!pr.ok)
		return { ok: false, assess, pr, next: String(pr.next ?? `stop: ${String(pr.reason)}`) };
	const review = await stepReview(ctx);
	// A passed review merges now, or waits on the PR (CI, mergeability) inside the merge loop; blocked means closed.
	const passed = review.ready || (review.passed === true && review.blocked !== true);
	if (!passed || !config.autoMerge) {
		const next = review.ready
			? "autoMerge disabled: merge manually"
			: (review.next ?? `stop: ${String(review.reason)}`);
		return { ok: review.ok !== false && review.blocked !== true, assess, pr, review, next };
	}
	const merge = await stepMerge(ctx, Math.max(0, config.waitMs - (ctx.deps.now() - started)));
	const next = merge.ok
		? "run ultrathink-sync"
		: String(merge.next ?? `stop: ${String(merge.reason)}`);
	return { ok: merge.ok, assess, pr, review, merge, next };
}

export async function runShip(
	argv: string[],
	deps: ShipDeps,
): Promise<{ code: number; output: Output }> {
	const [command, ...rest] = argv;
	let state: string | undefined;
	let cwd = process.cwd();
	let ignoreGsd = false;
	let approve = false;
	let phase: string | undefined;
	let owner: string | undefined;
	let evidence: string | undefined;
	let overrideReason: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--state") state = rest[++i];
		else if (arg === "--cwd") cwd = rest[++i] ?? cwd;
		else if (arg === "--ignore-gsd") ignoreGsd = true;
		else if (arg === "--approve") approve = true;
		else if (arg === "--owner") owner = rest[++i] ?? "";
		else if (arg === "--evidence") evidence = rest[++i] ?? "";
		else if (arg === "--owner-override") overrideReason = rest[++i] ?? "";
		else if (command === "resolve" && phase === undefined && arg && !arg.startsWith("--"))
			phase = arg;
		else return { code: 2, output: { ok: false, error: `unknown argument ${arg}`, usage: USAGE } };
	}
	if (!state) return { code: 2, output: { ok: false, error: "--state is required", usage: USAGE } };
	const usageError = (error: string): { code: number; output: Output } => ({
		code: 2,
		output: { ok: false, error, usage: USAGE },
	});
	const present = (value: string | undefined): value is string =>
		value !== undefined && value.trim() !== "";
	let resolution: Resolution | undefined;
	if (command === "resolve") {
		if (!present(phase))
			return usageError("resolve needs a phase: resolve <phase> --owner <name> --evidence <text>");
		if (!present(owner)) return usageError("resolve needs --owner <name>");
		if (!present(evidence)) return usageError("resolve needs a non-empty --evidence <text>");
		resolution = { phase, owner, evidence };
	} else if (evidence !== undefined) {
		return usageError("--evidence applies to resolve");
	}
	let override: ShipOverride | undefined;
	if (overrideReason !== undefined) {
		if (command !== "merge" && command !== "run")
			return usageError("--owner-override applies to merge and run");
		if (!present(overrideReason)) return usageError("--owner-override needs a non-empty reason");
		if (!present(owner)) return usageError("--owner-override needs --owner <name>");
		override = { owner, reason: overrideReason };
	} else if (owner !== undefined && command !== "resolve") {
		return usageError("--owner applies to resolve and --owner-override");
	}
	const ctx: Ctx = {
		deps,
		statePath: resolve(state),
		cwd: resolve(cwd),
		ignoreGsd,
		approve,
		override,
	};
	try {
		switch (command) {
			case "assess":
				return { code: 0, output: await stepAssess(ctx) };
			case "pr":
				return { code: 0, output: await stepPr(ctx) };
			case "review":
				return { code: 0, output: await stepReview(ctx) };
			case "merge":
				return { code: 0, output: await stepMerge(ctx) };
			case "run":
				return { code: 0, output: await stepRun(ctx) };
			case "resolve":
				return { code: 0, output: stepResolve(ctx, resolution) };
			case "status": {
				const ship = readShip(ctx.statePath);
				return {
					code: 0,
					output: ship ? { ok: true, ship } : { ok: false, reason: "no ship state" },
				};
			}
			default:
				return {
					code: 2,
					output: { ok: false, error: `unknown command ${command ?? ""}`, usage: USAGE },
				};
		}
	} catch (error) {
		return {
			code: 0,
			output: { ok: false, error: error instanceof Error ? error.message : String(error) },
		};
	}
}

/**
 * The session model the ship judge routes on (`selectJudgeEngine`). A Hermes session that plans on Grok saves its
 * transport and model id but no provider, so a Grok transport supplies the `grok/` prefix that `engineForSessionModel`
 * maps to Grok even when the model id names no family (for example `route-xhigh`).
 */
export function judgeSessionModel(
	modelResolution: SessionRecord["modelResolution"],
): string | undefined {
	const modelId = modelResolution?.modelId;
	if (!modelId) return undefined;
	const provider = modelResolution?.provider;
	if (provider) return `${provider}/${modelId}`;
	if (modelResolution?.transport?.startsWith("grok")) return `grok/${modelId}`;
	return modelId;
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const cwdIndex = argv.indexOf("--cwd");
	const cwd = resolve(cwdIndex >= 0 ? (argv[cwdIndex + 1] ?? process.cwd()) : process.cwd());
	const stateIndex = argv.indexOf("--state");
	// The session record lives at <stateDir>/sessions/<id>.json; without it the host's default state dir applies.
	const stateFile = stateIndex >= 0 ? argv[stateIndex + 1] : undefined;
	const stateDir = stateFile ? dirname(dirname(resolve(stateFile))) : defaultStateDir();
	const config = loadConfig(claudeConfigPaths(cwd));
	let client: McpClient | undefined;
	const deps: ShipDeps = {
		config: config.ship,
		run: defaultRun,
		now: Date.now,
		github: (dir) => createGithub({ cwd: dir, run: defaultRun }),
		review: runReview,
		assess: assessDone,
		signals: collectSignals,
		diff: gatherDiff,
		engine: async (record) => {
			if (!stateFile) return undefined;
			// The judge chooses its route from the session's model.
			const sessionModel = judgeSessionModel(record.modelResolution);
			const selected = await selectJudgeEngine(config, readControl(stateDir), cwd, sessionModel);
			if ("skipped" in selected) return undefined;
			return { complete: selected.complete, label: selected.label, answering: selected.answering };
		},
		greptile: () => {
			// No stored Greptile credential means no MCP mode; review then needs a signed-in greptile CLI.
			client ??= createMcpClientIfCredentialed("greptile", { storePath: storePath() });
			return client;
		},
		sleep: Bun.sleep,
		phaseLoopDir: join(stateDir, "phase-loop"),
		decisions: (record) =>
			createDecisions({ config: config.decisions, sessionId: record.sessionId, stateDir }),
	};
	const { code, output } = await runShip(argv, deps);
	client?.close();
	process.stdout.write(`${JSON.stringify(output)}\n`);
	return code;
}

if (import.meta.main) {
	process.exit(await main());
}
