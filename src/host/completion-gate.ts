// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * CompletionGate: the host-neutral rule that a session only starts once the whole plan exists. "Whole" means the
 * uplifted XML, the Graph of Thought, the issue and sub-issue rows and, when the Tree-of-Thought stage ran, every PRD.
 *
 * The gate never starts anything itself. A host stages artifacts into it while a planner runs, the gate validates
 * them, and the host asks `release()` for the content to inject. `release()` hands the staged content over exactly
 * once, and only from `ready`: a session starts only when the whole plan is ready. A partial plan is reported with
 * the problems that keep it from being whole, and it is never released. Nothing staged is readable any other way,
 * so no half-built plan can reach a prompt.
 *
 * States: `generating` -> `validating` -> `ready` | `partial_failure` | `failed_or_cancelled`.
 *
 * An inactivity watchdog fails the gate loudly when nothing touches it for `inactivityMs` (default 30 minutes, 0
 * disables). Progress for a human goes out through `onProgress` listeners only: a side channel that is never part
 * of the prompt.
 */
import { createHash } from "node:crypto";
import type { TotManifest } from "../think/tot/types.ts";
import { redactSecrets } from "../redact.ts";
import type { SyncSummary } from "../track/prd-types.ts";
import { checkUpliftXml } from "../uplift/xml.ts";

export type GateState =
	| "discovering"
	| "discussing"
	| "planning"
	| "waiting_for_plan"
	| "plan_validated"
	| "generating"
	| "validating"
	| "ready"
	| "executing"
	| "partial_failure"
	| "failed_or_cancelled"
	| "complete";

/** Default inactivity window before the watchdog fails the gate: 30 minutes. */
export const DEFAULT_GATE_INACTIVITY_MS = 30 * 60_000;

/** The longest delay a platform timer accepts (2^31-1 ms); a longer window is clamped to it. */
const MAX_TIMER_MS = 2_147_483_647;

/** Counts a complete plan must reach. A field left out is not checked. */
export interface GateExpected {
	readonly nodes?: number;
	readonly issues?: number;
	readonly subIssues?: number;
	readonly prds?: number;
}

/** What the validator counted in the staged artifacts. */
interface GateObserved {
	readonly nodes: number;
	readonly issues: number;
	readonly subIssues: number;
	/** Issue and sub-issue rows still marked `status="pending"`: the tracker never confirmed them. */
	readonly pendingRows: number;
	readonly prds: number;
	readonly prdsFailed: number;
}

interface GateArtifacts {
	/** The plan text the model will read: the uplifted XML (with the graph and issue blocks) inside its context header. */
	readonly text: string;
	/** Expected counts; with none, only the structural checks run. */
	readonly expected?: GateExpected;
	/** The Tree-of-Thought PRD manifest, when that stage ran. */
	readonly prd?: TotManifest;
	/** How many of those PRDs reached their tracker rows. The gate releases only with none failed and none pending. */
	readonly prdSync?: SyncSummary;
	/** A reason the plan is known to be degraded (for example a fallback graph); it makes the plan a partial failure. */
	readonly degraded?: string;
}

interface GateProblem {
	/** `fatal`: the plan is unusable. `partial`: usable but incomplete; the gate reports it and never releases it. */
	readonly severity: "fatal" | "partial";
	readonly code: string;
	readonly detail: string;
}

interface GateVerdict {
	readonly state: "ready" | "partial_failure" | "failed_or_cancelled";
	readonly problems: readonly GateProblem[];
	readonly observed: GateObserved;
}

interface GateValidateOptions {
	/** Reject text with no uplift XML root at all. Default false: a plain-text plan has nothing structural to check. */
	readonly requireXml?: boolean;
}

const NODE_RE = /<NODE\b/g;
const DEGRADED_NODE_RE = /<NODE\b[^>]*\sdegraded="true"/g;
const ISSUE_RE = /<ISSUE\b/g;
const SUBISSUE_RE = /<SUBISSUE\b/g;
const PENDING_ROW_RE = /<(?:SUB)?ISSUE\b[^>]*\sstatus="pending"/g;
const ISSUES_STATUS_RE = /<ISSUES\b[^>]*\sstatus="([^"]*)"/;
const GRAPH_OPEN = "<GRAPH_OF_THOUGHT";
const GRAPH_CLOSE = "</GRAPH_OF_THOUGHT>";
const ISSUES_OPEN = "<ISSUES";
const ISSUES_CLOSE = "</ISSUES>";

function count(re: RegExp, text: string): number {
	return text.match(re)?.length ?? 0;
}

/** The span from the last `open` tag through the first `close` after it (close tag excluded), or undefined. */
function blockBetween(
	scope: string,
	open: string,
	close: string,
): { start: number; end: number } | undefined {
	const start = scope.lastIndexOf(open);
	if (start < 0) return undefined;
	const end = scope.indexOf(close, start);
	return end < 0 ? undefined : { start, end };
}

/**
 * Validates staged artifacts: the XML must be well formed and closed (`checkUpliftXml`), the graph and issue blocks
 * must be closed, and the counts must match the manifest. A broken structure is fatal; a short count, a pending
 * tracker row, a degraded node or a failed PRD is a partial failure.
 */
export function validateArtifacts(
	artifacts: GateArtifacts,
	options: GateValidateOptions = {},
): GateVerdict {
	const problems: GateProblem[] = [];
	const text = artifacts.text;
	if (text.trim() === "") {
		return {
			state: "failed_or_cancelled",
			problems: [{ severity: "fatal", code: "empty", detail: "the plan is empty" }],
			observed: { nodes: 0, issues: 0, subIssues: 0, pendingRows: 0, prds: 0, prdsFailed: 0 },
		};
	}
	const checked = checkUpliftXml(text, "");
	// The uplift root when it parses, else the raw text: one scope for the closure check and for every count.
	const scope = checked.ok ? checked.xml : text;
	const graphBlock = blockBetween(scope, GRAPH_OPEN, GRAPH_CLOSE);
	const issuesBlock = blockBetween(scope, ISSUES_OPEN, ISSUES_CLOSE);
	// A block that opens and never closes means the plan was cut off mid-way.
	for (const [name, open, block] of [
		["GRAPH_OF_THOUGHT", GRAPH_OPEN, graphBlock],
		["ISSUES", ISSUES_OPEN, issuesBlock],
	] as const) {
		if (block === undefined && scope.includes(open))
			problems.push({ severity: "fatal", code: "truncated", detail: `<${name}> is never closed` });
	}
	if (!checked.ok) {
		if (checked.reason === "unclosed_root")
			problems.push({
				severity: "fatal",
				code: "truncated",
				detail: "the uplift XML root is never closed",
			});
		else if (checked.reason === "missing_child")
			problems.push({
				severity: "fatal",
				code: "missing_child",
				detail: `the uplift XML lacks ${checked.missing.join(", ")}`,
			});
		else if (options.requireXml)
			problems.push({
				severity: "fatal",
				code: "no_xml",
				detail: "the plan carries no uplift XML",
			});
	}
	const graph = graphBlock ? scope.slice(graphBlock.start, graphBlock.end) : "";
	const issues = issuesBlock ? scope.slice(issuesBlock.start, issuesBlock.end) : "";
	const prd = artifacts.prd;
	const observed: GateObserved = {
		nodes: count(NODE_RE, graph),
		issues: count(ISSUE_RE, issues),
		subIssues: count(SUBISSUE_RE, issues),
		pendingRows: count(PENDING_ROW_RE, issues),
		prds: prd ? prd.records.filter((record) => record.status === "generated").length : 0,
		prdsFailed: prd ? prd.records.filter((record) => record.status === "failed").length : 0,
	};
	const expected = artifacts.expected;
	const short = (name: string, want: number | undefined, have: number): void => {
		if (want !== undefined && have < want)
			problems.push({
				severity: "partial",
				code: `${name}_short`,
				detail: `${have} of ${want} ${name}`,
			});
	};
	// A plain-text plan has no graph or issue block, so it counts zero: an expected node or issue count reads as short.
	short("nodes", expected?.nodes, observed.nodes);
	short("issues", expected?.issues, observed.issues);
	short("subIssues", expected?.subIssues, observed.subIssues);
	short("prds", expected?.prds, observed.prds);
	if (observed.pendingRows > 0)
		problems.push({
			severity: "partial",
			code: "rows_pending",
			detail: `${observed.pendingRows} tracker rows were never confirmed`,
		});
	const trackStatus = ISSUES_STATUS_RE.exec(issues)?.[1];
	if (trackStatus === "partial" || trackStatus === "failed")
		problems.push({
			severity: "partial",
			code: "tracking_incomplete",
			detail: `tracking finished ${trackStatus}`,
		});
	const degradedNodes = count(DEGRADED_NODE_RE, graph);
	if (degradedNodes > 0)
		problems.push({
			severity: "partial",
			code: "nodes_degraded",
			detail: `${degradedNodes} nodes carry a degraded reasoning fill`,
		});
	if (observed.prdsFailed > 0)
		problems.push({
			severity: "partial",
			code: "prds_failed",
			detail: `${observed.prdsFailed} PRDs failed`,
		});
	// The sync summary counts a failed PRD as failed too; only the tracker-side failures beyond those are new here.
	const syncFailed = Math.max(0, (artifacts.prdSync?.failed ?? 0) - observed.prdsFailed);
	if (syncFailed > 0)
		problems.push({
			severity: "partial",
			code: "prds_sync_failed",
			detail: `${syncFailed} PRDs were not delivered to the tracker`,
		});
	const syncPending = artifacts.prdSync?.pending ?? 0;
	if (syncPending > 0)
		problems.push({
			severity: "partial",
			code: "prds_sync_pending",
			detail: `${syncPending} PRDs are still waiting for the tracker`,
		});
	if (artifacts.degraded)
		problems.push({ severity: "partial", code: "degraded", detail: artifacts.degraded });
	const state = problems.some((p) => p.severity === "fatal")
		? "failed_or_cancelled"
		: problems.length > 0
			? "partial_failure"
			: "ready";
	return { state, problems, observed };
}

/** Timer port, structurally the one the Omp host already injects. */
export interface GateTimers {
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
}

const PLATFORM_TIMERS: GateTimers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

export interface CompletionGateOptions {
	/** Inactivity window in ms; 0 disables the watchdog. Default DEFAULT_GATE_INACTIVITY_MS. */
	readonly inactivityMs?: number;
	readonly timers?: GateTimers;
	readonly validate?: (artifacts: GateArtifacts) => GateVerdict;
	/** Called once, loudly, when the watchdog failed the gate; the host must stop the planner and tell the user. */
	readonly onStall?: (reason: string) => void;
	/** Bounded Plan-gate polling: interval between re-checks while waiting_for_plan. Default 2000. */
	readonly pollIntervalMs?: number;
	/** Bounded Plan-gate polling: max attempts before blocked-with-reason. Default 30. */
	readonly maxPollAttempts?: number;
	/** Plan source re-polled while waiting_for_plan; undefined means submitPlan() drives the gate. */
	readonly planProvider?: () => string | undefined;
	/** Clock for transition timestamps; defaults to Date.now. Test seam. */
	readonly now?: () => number;
}

/** One transition attempt, accepted or rejected, with actor and reason. */
export interface GateTransition {
	readonly timestamp: number;
	readonly actor: string;
	readonly from: GateState;
	readonly to: GateState;
	readonly reason: string;
	readonly accepted: boolean;
}

/** A plan that passed the checklist: version/hash every worker must carry. */
export interface PlanGatePlan {
	readonly planId: string;
	readonly planHash: string;
	readonly text: string;
	readonly version: string;
}

/** Execution context injected to one worker; all share the same plan hash. */
export interface WorkerContext {
	readonly workerId: string;
	readonly planId: string;
	readonly planHash: string;
}

/** A side-channel progress note. It is for the user's eyes and never part of a prompt. */
export interface GateProgress {
	readonly state: GateState;
	readonly label: string;
}

type GateRelease =
	| {
			readonly ok: true;
			readonly state: "ready";
			readonly text: string;
			readonly problems: readonly GateProblem[];
	  }
	| {
			readonly ok: false;
			readonly reason: "not_ready" | "already_released" | "failed";
			readonly detail: string;
	  };

/** The terminal outcome `settled` resolves with: the verdict, or the reason the gate failed or was cancelled. */
type GateOutcome =
	| { readonly state: "ready" | "partial_failure"; readonly verdict: GateVerdict }
	| {
			readonly state: "failed_or_cancelled";
			readonly reason: string;
			readonly verdict?: GateVerdict;
	  };

export class CompletionGate {
	#state: GateState = "generating";
	#staged: GateArtifacts | undefined;
	#verdict: GateVerdict | undefined;
	#reason = "";
	#released = false;
	#timer: NodeJS.Timeout | undefined;
	#stalled = false;
	readonly #listeners = new Set<(progress: GateProgress) => void>();
	readonly #settled = Promise.withResolvers<GateOutcome>();
	readonly #inactivityMs: number;
	readonly #timers: GateTimers;
	readonly #validate: (artifacts: GateArtifacts) => GateVerdict;
	readonly #onStall: ((reason: string) => void) | undefined;
	readonly #planPollIntervalMs: number;
	readonly #planMaxPollAttempts: number;
	readonly #planProvider: (() => string | undefined) | undefined;
	readonly #now: () => number;
	#plan: PlanGatePlan | undefined;
	#pendingPlan: PlanGatePlan | undefined;
	#pollAttempts = 0;
	#pollTimer: NodeJS.Timeout | undefined;
	#blocked = false;
	#blockReason = "";
	#validationEvidence: string | undefined;
	readonly #transitions: GateTransition[] = [];

	constructor(options: CompletionGateOptions = {}) {
		const window = options.inactivityMs ?? DEFAULT_GATE_INACTIVITY_MS;
		this.#inactivityMs = Number.isFinite(window) && window > 0 ? Math.min(window, MAX_TIMER_MS) : 0;
		this.#timers = options.timers ?? PLATFORM_TIMERS;
		this.#validate = options.validate ?? ((artifacts) => validateArtifacts(artifacts));
		this.#onStall = options.onStall;
		this.#planProvider = options.planProvider;
		this.#now = options.now ?? Date.now;
		const pollInterval = options.pollIntervalMs ?? 2000;
		this.#planPollIntervalMs = Number.isFinite(pollInterval) && pollInterval > 0 ? Math.min(pollInterval, MAX_TIMER_MS) : 2000;
		const maxPolls = options.maxPollAttempts ?? 30;
		this.#planMaxPollAttempts = Number.isFinite(maxPolls) && maxPolls > 0 ? Math.floor(maxPolls) : 30;
		// A rejected settlement is impossible: every terminal path resolves.
		this.#arm();
	}

	get state(): GateState {
		return this.#state;
	}

	/** True once `release()` handed the content over. */
	get released(): boolean {
		return this.#released;
	}

	/** True when the watchdog, not the planner, ended the gate. */
	get stalled(): boolean {
		return this.#stalled;
	}

	/** Why the gate failed or was cancelled; empty otherwise. */
	get reason(): string {
		return this.#reason;
	}

	/** The validator's verdict once the gate left `validating`. */
	get verdict(): GateVerdict | undefined {
		return this.#verdict;
	}

	/** Resolves once the gate reached `ready`, `partial_failure` or `failed_or_cancelled`. */
	get settled(): Promise<GateOutcome> {
		return this.#settled.promise;
	}

	get transitions(): readonly GateTransition[] {
		return [...this.#transitions];
	}

	get plan(): PlanGatePlan | undefined {
		return this.#plan;
	}

	get planHash(): string | undefined {
		return this.#plan?.planHash;
	}

	get planId(): string | undefined {
		return this.#plan?.planId;
	}

	get pollAttempts(): number {
		return this.#pollAttempts;
	}

	get blocked(): boolean {
		return this.#blocked;
	}

	get blockReason(): string {
		return this.#blockReason;
	}

	/** True once validation evidence was recorded for the complete() step. */
	get hasValidationEvidence(): boolean {
		return this.#validationEvidence !== undefined;
	}

	/** Record for STATE.md / SUMMARY / Linear PRD / Notion prompt. Empty until a plan validates.
	 * When a validated checklist `#plan` coexists with staged artifacts, `#plan` is the release
	 * authority: `release()` returns `#plan.text`, so this record (and the worker contexts) attribute
	 * exactly that text. Only a legacy staged-only gate (no `#plan`) records nothing. */
	planRecord(): string {
		if (!this.#plan) return "";
		return `Plan ${this.#plan.planId} @ ${this.#plan.planHash} (v${this.#plan.version})`;
	}

	/** Transition log line for persistence; one line per attempt, accepted or rejected. */
	transitionLog(): string[] {
		return this.#transitions.map(
			(t) => `${new Date(t.timestamp).toISOString()} ${t.actor} ${t.from}->${t.to} ${t.accepted ? "accepted" : "rejected"}: ${t.reason}`,
		);
	}

	/**
	 * Hard state machine: only listed edges pass. Executing before plan_validated and
	 * complete without validation evidence are always rejected; every attempt is logged.
	 * Any accepted transition to waiting_for_plan centralizes quarantine here: it
	 * clears the plan/pending records and (except on the waiting self path, which
	 * preserves the poll budget) starts bounded polling.
	 */
	tryTransition(to: GateState, actor = "system", reason = ""): boolean {
		const from = this.#state;
		const allowed = planGateAllowed(from);
		let ok = allowed.has(to);
		// Executing only from ready (plan_validated must pass through ready);
		// complete only with validation evidence recorded in validating.
		if (to === "executing" && from !== "ready") ok = false;
		if (to === "executing" && this.#plan === undefined) ok = false;
		if (to === "complete" && this.#validationEvidence === undefined) ok = false;
		// plan_validated requires a pending (submitPlan) or already validated (#plan) record:
		// the public edge alone never proves a checklist-validated Plan exists.
		if (to === "plan_validated" && this.#pendingPlan === undefined && this.#plan === undefined) ok = false;
		// ready requires the validated plan record itself.
		if (to === "ready" && this.#plan === undefined) ok = false;
		if (from === "complete" || from === "failed_or_cancelled") ok = false;
		const entry: GateTransition = { timestamp: this.#now(), actor, from, to, reason, accepted: ok };
		this.#transitions.push(entry);
		if (!ok) return false;
		// A new execution/validation cycle must not inherit evidence from a prior cycle:
		// after ready->executing->validating, complete requires evidence recorded in this cycle.
		if (to === "executing" || to === "validating") this.#validationEvidence = undefined;
		this.#state = to;
		if (from === "waiting_for_plan" && to !== "waiting_for_plan") {
			this.#blocked = false;
			this.#blockReason = "";
			this.#stopPolling();
		}
		if (to === "waiting_for_plan") {
			// Centralized quarantine: every accepted entry into waiting_for_plan drops any
			// prior plan/pending record, so plan_validated/ready guards below (which
			// require one of those records) cannot re-admit the stale plan. A fresh
			// entry from any other state also starts bounded polling with a fresh
			// budget. The waiting->waiting self path only clears the records: it
			// preserves the in-flight poll budget/blocked state, so an invalid
			// candidate re-quarantining while already waiting (submitPlan/pollOnce)
			// cannot reset the bounded polling it is supposed to exhaust.
			this.#plan = undefined;
			this.#pendingPlan = undefined;
			this.#released = false;
			if (from !== "waiting_for_plan") this.#startPolling();
		}
		this.#emit(entry.reason || `${from} -> ${to}`);
		return true;
	}

	/** Enter waiting_for_plan (missing/stale/unparseable/fails checklist) and start bounded polling.
	 * Quarantine itself lives in tryTransition, so this is a thin wrapper: a raw
	 * tryTransition("waiting_for_plan") gets the identical clear-and-poll behaviour,
	 * and the waiting->waiting self path preserves the in-flight poll budget. */
	enterWaitingForPlan(actor = "system", reason = "plan missing, stale, unparseable or failing checklist"): boolean {
		return this.tryTransition("waiting_for_plan", actor, reason);
	}

	/**
	 * Submit a candidate plan. Returns the plan when it validates and its transition is accepted
	 * (hash computed, gate auto-transitions plan_validated -> ready without manual restart); else
	 * undefined. An invalid candidate quarantines to waiting_for_plan and clears any prior plan.
	 * A valid candidate in ready/executing/validating/complete/failed_or_cancelled is not accepted:
	 * the rejected transitions are logged, a rejection is emitted, and the original plan/state
	 * are kept, never overwritten. A valid candidate from generating, partial_failure or planning
	 * routes through waiting_for_plan (the permitted chain) before plan_validated; from
	 * discovering/discussing it first walks discovering->discussing->planning->waiting_for_plan.
	 */
	submitPlan(text: string | undefined, options: { actor?: string; stale?: boolean; version?: string } = {}): PlanGatePlan | undefined {
		const actor = options.actor ?? "planner";
		const verdict = validatePlanChecklist(text, options);
		if (!verdict.ok) {
			// Quarantine semantics: an invalid candidate must not leave a prior plan executing, even
			// when it arrives after validation. From waiting/plan_validated/ready the waiting_for_plan
			// edge holds (ready/plan_validated enter via the quarantine edge) and the prior plan is
			// cleared. From executing/validating/complete/failed there is no held state: the candidate
			// is rejected (logged by tryTransition) and loudly emitted, and the already-validated plan
			// stays authoritative for the running/terminal gate.
			const reason = `plan quarantined: ${verdict.problems.join("; ")}`;
			if (this.#state === "waiting_for_plan") {
				// Self-quarantine: tryTransition clears any plan/pending record but preserves
				// the in-flight poll budget, so this cannot reset bounded polling.
				this.tryTransition("waiting_for_plan", actor, reason);
			} else if (!this.enterWaitingForPlan(actor, reason)) {
				this.#emit(`plan quarantined (rejected, no held state): ${verdict.problems.join("; ")}`);
			}
			return undefined;
		}
		const plan = buildPlanGatePlan(text ?? "", options.version);
		// The public table has no skip edge into plan_validated, so a valid plan submitted from
		// generating/partial_failure/planning routes through waiting_for_plan (the permitted
		// chain) before it can enter plan_validated, and from discovering/discussing it first
		// walks the forward chain to waiting_for_plan. The pending record is only set after the
		// waiting entry (which centralizes quarantine and clears any pending record), so
		// tryTransition accepts that one entry; without it, the same edge is rejected. #plan is
		// only set once plan_validated accepts, and ready then requires that record, so the
		// chain cannot be entered empty. ready/executing/validating/complete/failed_or_cancelled
		// fall through to the direct attempt below, which the table rejects (logged + emitted).
		let accepted = false;
		if (this.#state === "plan_validated") {
			this.#pendingPlan = plan;
			accepted = this.tryTransition("plan_validated", actor, "plan checklist passed");
		} else if (this.#state === "generating" || this.#state === "partial_failure" || this.#state === "planning") {
			// Route through waiting_for_plan first: that entry centralizes quarantine and
			// clears any pending record, so the pending record is only set after it.
			if (this.enterWaitingForPlan(actor, "plan submitted: routing via waiting_for_plan")) {
				this.#pendingPlan = plan;
				accepted = this.tryTransition("plan_validated", actor, "plan checklist passed");
			}
		} else if (this.#state === "discovering" || this.#state === "discussing") {
			// No skip to waiting_for_plan from discovering/discussing: walk each permitted
			// forward edge, then the waiting edge. Any failed hop aborts (logged + emitted below).
			const chain: readonly GateState[] =
				this.#state === "discovering" ? ["discussing", "planning", "waiting_for_plan"] : ["planning", "waiting_for_plan"];
			let routed = true;
			for (const step of chain) {
				if (!this.tryTransition(step, actor, "plan submitted: routing via waiting_for_plan")) {
					routed = false;
					break;
				}
			}
			if (routed) {
				this.#pendingPlan = plan;
				accepted = this.tryTransition("plan_validated", actor, "plan checklist passed");
			}
		} else {
			this.#pendingPlan = plan;
			accepted = this.tryTransition("plan_validated", actor, "plan checklist passed");
		}
		if (!accepted) {
			this.#pendingPlan = undefined;
			this.#emit(`plan rejected: valid candidate cannot enter plan_validated from ${this.#state} (never silent)`);
			return undefined;
		}
		// Automatic use: validated means ready; no manual restart is required.
		this.#plan = plan;
		this.#pendingPlan = undefined;
		this.tryTransition("ready", actor, "auto-use validated plan");
		this.#stopPolling();
		return plan;
	}

	/** One bounded poll tick (host timer or test): re-check provider, auto-resume or block. */
	pollOnce(): PlanGatePlan | undefined {
		if (this.#state !== "waiting_for_plan") return undefined;
		// A manual tick supersedes any armed poll timer; the re-arm below leaves at most one handle.
		this.#stopPolling();
		this.#pollAttempts++;
		let candidate: string | undefined;
		try {
			candidate = this.#planProvider?.();
		} catch (error) {
			// A throwing provider must never stall silently: stop polling, block loudly with the
			// provider error, emit it, and stay waiting_for_plan.
			const detail = redactSecrets(error instanceof Error ? error.message : String(error))
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 300);
			this.#blocked = true;
			this.#blockReason = `waiting_for_plan blocked: plan provider threw: ${detail} (never silent)`;
			this.#stopPolling();
			this.#emit(this.#blockReason);
			return undefined;
		}
		if (candidate !== undefined) {
			const accepted = this.submitPlan(candidate);
			if (accepted) return accepted;
		}
		if (this.#pollAttempts >= this.#planMaxPollAttempts) {
			this.#blocked = true;
			this.#blockReason = `waiting_for_plan blocked after ${this.#pollAttempts} attempts: no valid Plan (never silent)`;
			this.#stopPolling();
			this.#emit(this.#blockReason);
		} else {
			this.#armPollTimer();
		}
		return undefined;
	}

	/** Execution context for every worker: identical plan id/hash or undefined when not ready.
	 * The hash is `planGateHash(released #plan text)`: workers verify the text they execute against it. */
	buildWorkerContexts(workerIds: readonly string[]): WorkerContext[] | undefined {
		const ready = this.#state === "ready" || this.#state === "plan_validated" || this.#state === "executing" || this.#state === "validating" || this.#state === "complete";
		if (!ready || !this.#plan) return undefined;
		return workerIds.map((workerId) => ({ workerId, planId: this.#plan!.planId, planHash: this.#plan!.planHash }));
	}

	getExecutionContext(): { planId: string; planHash: string; text: string } | undefined {
		if (!this.#plan) return undefined;
		const ready = this.#state === "ready" || this.#state === "plan_validated" || this.#state === "executing" || this.#state === "validating" || this.#state === "complete";
		if (!ready) return undefined;
		return { planId: this.#plan.planId, planHash: this.#plan.planHash, text: this.#plan.text };
	}

	beginExecution(actor = "system", reason = "execution started"): boolean {
		return this.tryTransition("executing", actor, reason);
	}

	beginValidation(actor = "system", reason = "validation started"): boolean {
		return this.tryTransition("validating", actor, reason);
	}

	/**
	 * Validation evidence for the complete() step. Accepted only in `validating`:
	 * evidence recorded earlier (e.g. in ready/executing) never enables complete.
	 */
	recordValidationEvidence(evidence: string, actor = "validator"): void {
		if (this.#state !== "validating" || evidence.trim() === "") return;
		this.#validationEvidence = evidence;
		this.#emit(`validation evidence recorded by ${actor}`);
	}

	completeExecution(actor = "system", reason = "execution complete"): boolean {
		return this.tryTransition("complete", actor, reason);
	}

	#startPolling(): void {
		this.#pollAttempts = 0;
		this.#blocked = false;
		this.#blockReason = "";
		this.#stopPolling();
		this.#armPollTimer();
	}

	#armPollTimer(): void {
		if (this.#state !== "waiting_for_plan") return;
		// Clear any prior handle first: arming must never leave two poll timers live.
		this.#stopPolling();
		const timer = this.#timers.setTimeout(() => {
			this.#pollTimer = undefined;
			this.pollOnce();
		}, this.#planPollIntervalMs);
		(timer as { unref?: () => void } | undefined)?.unref?.();
		this.#pollTimer = timer;
	}

	#stopPolling(): void {
		if (this.#pollTimer === undefined) return;
		this.#timers.clearTimeout(this.#pollTimer);
		this.#pollTimer = undefined;
	}

	/** Subscribes to side-channel progress; returns the unsubscribe function. */
	onProgress(listener: (progress: GateProgress) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Records activity: the watchdog restarts, and a label (when given) goes to the progress listeners. */
	touch(label?: string): void {
		if (this.#state !== "generating") return;
		this.#arm();
		if (label !== undefined) this.#emit(label);
	}

	/** Stages artifacts while generating. They stay unreadable until `release()`; a later stage replaces an earlier one. */
	stage(artifacts: GateArtifacts, label?: string): void {
		if (this.#state !== "generating") return;
		this.#staged = artifacts;
		this.touch(label);
	}

	/** The planner finished: validates what was staged (or `artifacts` when given) and settles the gate. */
	complete(artifacts?: GateArtifacts): GateOutcome {
		if (this.#state !== "generating") return this.#current();
		const target = artifacts ?? this.#staged;
		if (!target) return this.fail("the planner finished with nothing staged");
		this.#staged = target;
		this.#state = "validating";
		this.#disarm();
		this.#emit("validating the plan");
		let verdict: GateVerdict;
		try {
			verdict = this.#validate(target);
		} catch (error) {
			return this.fail(
				`validation threw: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.#verdict = verdict;
		this.#state = verdict.state;
		if (verdict.state === "failed_or_cancelled") this.#reason = describe(verdict.problems);
		this.#emit(verdict.state === "ready" ? "plan complete" : describe(verdict.problems));
		const outcome = this.#current();
		this.#settled.resolve(outcome);
		return outcome;
	}

	/** Ends the gate as failed; staged content is dropped. */
	fail(reason: string): GateOutcome {
		return this.#end(reason);
	}

	/** Ends the gate as cancelled (superseded, session ended); staged content is dropped. */
	cancel(reason: string): GateOutcome {
		return this.#end(reason);
	}

	/**
	 * The single atomic release: it returns the release-authority text exactly once, and only from
	 * `ready`. The authority is a validated checklist `#plan` when present (it wins over any staged
	 * artifacts, so `planRecord()`, `buildWorkerContexts()` and `getExecutionContext()` attribute the
	 * same text); in a legacy staged-only gate it is the staged text. A partial plan reports what is
	 * missing and stays unreleased; any other call changes nothing and says why.
	 */
	release(): GateRelease {
		if (this.#released)
			return { ok: false, reason: "already_released", detail: "the plan was already released" };
		const staged = this.#staged;
		const verdict = this.#verdict;
		if (this.#state === "failed_or_cancelled")
			return { ok: false, reason: "failed", detail: this.#reason || "the plan failed" };
		if (this.#state === "partial_failure")
			return {
				ok: false,
				reason: "not_ready",
				detail: `the plan is incomplete: ${describe(verdict?.problems ?? [])}`,
			};
		if (this.#state !== "ready")
			return { ok: false, reason: "not_ready", detail: `the plan is still ${this.#state}` };
		if (this.#plan) {
			// #plan is the release authority whenever present, staged or not: its text is exactly what
			// planRecord() and the worker contexts hash/attribute, so re-hashing it yields their hash.
			this.#released = true;
			return { ok: true, state: "ready", text: this.#plan.text, problems: verdict?.problems ?? [] };
		}
		if (!staged || !verdict) return { ok: false, reason: "failed", detail: "no validated artifacts are staged" };
		this.#released = true;
		return { ok: true, state: "ready", text: staged.text, problems: verdict.problems };
	}

	#current(): GateOutcome {
		const verdict = this.#verdict;
		if (verdict && (this.#state === "ready" || this.#state === "partial_failure")) {
			return { state: this.#state, verdict };
		}
		return {
			state: "failed_or_cancelled",
			reason: this.#reason,
			...(verdict ? { verdict } : {}),
		};
	}

	#end(reason: string): GateOutcome {
		// Terminal gates keep their outcome. A validating gate still settles, so `fail()` during validation works.
		if (this.#state !== "generating" && this.#state !== "validating") return this.#current();
		this.#state = "failed_or_cancelled";
		this.#reason = reason;
		this.#staged = undefined;
		this.#disarm();
		this.#emit(reason);
		const outcome = this.#current();
		this.#settled.resolve(outcome);
		return outcome;
	}

	#arm(): void {
		this.#disarm();
		if (this.#inactivityMs === 0) return;
		const timer = this.#timers.setTimeout(() => {
			this.#timer = undefined;
			if (this.#state !== "generating") return;
			this.#stalled = true;
			const minutes = Math.round((this.#inactivityMs / 60_000) * 10) / 10;
			const reason = `planning stalled: no progress for ${minutes} min`;
			this.#end(reason);
			try {
				this.#onStall?.(reason);
			} catch {
				// reason: a failing stall callback must not leave the gate unsettled; it already failed above
			}
		}, this.#inactivityMs);
		// The watchdog alone never keeps a process alive.
		(timer as { unref?: () => void } | undefined)?.unref?.();
		this.#timer = timer;
	}

	#disarm(): void {
		if (this.#timer === undefined) return;
		this.#timers.clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#emit(label: string): void {
		for (const listener of [...this.#listeners]) {
			try {
				listener({ state: this.#state, label });
			} catch {
				// reason: a progress listener is display only and must never break the gate
			}
		}
	}
}

/** One line for a problem list, fatal problems first. */
function describe(problems: readonly GateProblem[]): string {
	const ordered = [...problems].sort(
		(a, b) => Number(b.severity === "fatal") - Number(a.severity === "fatal"),
	);
	return ordered.map((problem) => problem.detail).join("; ");
}

/** Allowed hard-state-machine edges: the strict spec chain
 * discovering->discussing->planning->waiting_for_plan->plan_validated->ready->executing->validating->complete,
 * plus legacy generating (the entry state, which may enter discovering, waiting_for_plan — for an invalid
 * first candidate or, inside submitPlan, as the transit hop for a directly submitted valid Plan — or
 * terminal failed_or_cancelled). No skip edges: discovering/discussing/
 * planning cannot jump to plan_validated, ready cannot jump to validating (it must pass through executing),
 * and validating cannot go back to ready. `waiting_for_plan` self-quarantine is idempotent. The sole
 * backward exceptions are quarantine: discovering/discussing, plan_validated/ready may fall back to waiting_for_plan so a rejected
 * Plan candidate clears the prior plan instead of executing on it; executing/validating have no such edge.
 * validating may also branch to partial_failure (validation found the plan incomplete), and partial_failure
 * may fall back to waiting_for_plan for a late valid Plan. Legacy `complete()` bypasses this table by direct
 * assignment, so removing generating->validating does not break it. tryTransition additionally requires a
 * pending/validated plan record for plan_validated and #plan for ready (see tryTransition). */
export function planGateAllowed(from: GateState): ReadonlySet<GateState> {
	const table: Record<string, readonly GateState[]> = {
		discovering: ["discussing", "waiting_for_plan", "failed_or_cancelled"],
		discussing: ["planning", "waiting_for_plan", "failed_or_cancelled"],
		planning: ["waiting_for_plan", "failed_or_cancelled"],
		waiting_for_plan: ["waiting_for_plan", "plan_validated", "failed_or_cancelled"],
		plan_validated: ["plan_validated", "ready", "waiting_for_plan", "failed_or_cancelled"],
		generating: ["discovering", "waiting_for_plan", "failed_or_cancelled"],
		validating: ["partial_failure", "failed_or_cancelled", "complete"],
		ready: ["executing", "failed_or_cancelled", "waiting_for_plan"],
		executing: ["validating", "failed_or_cancelled"],
		partial_failure: ["waiting_for_plan", "failed_or_cancelled"],
		failed_or_cancelled: [],
		complete: [],
	};
	return new Set(table[from] ?? []);
}

/** Sha256 of canonical plan text (trimmed). */
export function planGateHash(text: string): string {
	return createHash("sha256").update(text.trim()).digest("hex");
}

function buildPlanGatePlan(text: string, version?: string): PlanGatePlan {
	const hash = planGateHash(text);
	return { planId: `plan-${hash.slice(0, 12)}`, planHash: hash, text: text.trim(), version: version ?? "1" };
}

/**
 * Plan checklist: a labeled non-empty value for objective, scope, named surfaces, acceptance,
 * out-of-scope, dependencies and ordering; an explicit SPE-<n> issue reference; and ROADMAP with a
 * wave/ordering/consistency reference on the ROADMAP line. Bare keywords do not count.
 * Unparseable (empty/truncated XML) fails; stale is flagged by the caller.
 */
function labeledChecklistValue(body: string, labelPattern: string): string | undefined {
	const end = String.raw`(?=\s*(?:Objective|Scope|Named surfaces?|Acceptance|Out[- ]of[- ]scope|Dependencies|Ordering)\s*:|\n|$)`;
	const normalized = body.replace(/\*\*/g, "");
	const match = new RegExp(`(?:^|[.;\\n]\\s*(?:(?:[-*•>]|\\d+[.)])\\s*)?)${labelPattern}\\s*:[ \\t]*([^\\n]*?)${end}`, "i").exec(normalized);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

export function validatePlanChecklist(
	text: string | undefined,
	options: { stale?: boolean } = {},
): { ok: boolean; problems: string[] } {
	const problems: string[] = [];
	if (text === undefined || text.trim() === "") problems.push("plan missing");
	if (options.stale) problems.push("plan stale");
	if (problems.length > 0) return { ok: false, problems };
	const body = text ?? "";
	if (!checkUpliftXml(body, "").ok) problems.push("plan unparseable");
	const labeled: readonly (readonly [problem: string, label: string])[] = [
		["objective missing", "Objective"],
		["scope missing", "Scope"],
		["named surfaces missing", "Named surfaces?"],
		["acceptance missing", "Acceptance"],
		["out-of-scope missing", "Out[- ]of[- ]scope"],
		["dependencies missing", "Dependencies"],
		["ordering missing", "Ordering"],
	];
	for (const [problem, label] of labeled) {
		if (labeledChecklistValue(body, label) === undefined) problems.push(problem);
	}
	if (!/\bSPE-\d+\b/.test(body)) problems.push("referenced Linear issues missing");
	// ROADMAP consistency: every ROADMAP line must name a wave/ordering/order/consistency reference.
	const roadmapLines = body.split("\n").filter((line) => /ROADMAP/i.test(line));
	const roadmapConsistent =
		roadmapLines.length > 0 &&
		roadmapLines.every((line) => /\b(?:wave|ordering|order|consistency|consistent)\b/i.test(line));
	if (!roadmapConsistent) problems.push("ROADMAP consistency missing");
	return { ok: problems.length === 0, problems };
}

/** Waiting copy for the host: Ultrathink waits; a late valid Plan auto-resumes. */
export const GATE_WAITING_PLAN =
	"STOP. Ultrathink is waiting for the phase Plan: it is missing, stale, unparseable or failing the checklist. Do not act yet. Bounded polling is running; a late valid Plan auto-resumes to ready and is used automatically (no manual restart).";
