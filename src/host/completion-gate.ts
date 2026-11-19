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
import type { TotManifest } from "../think/tot/types.ts";
import type { SyncSummary } from "../track/prd-types.ts";
import { checkUpliftXml } from "../uplift/xml.ts";

type GateState = "generating" | "validating" | "ready" | "partial_failure" | "failed_or_cancelled";

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

interface CompletionGateOptions {
	/** Inactivity window in ms; 0 disables the watchdog. Default `DEFAULT_GATE_INACTIVITY_MS`. */
	readonly inactivityMs?: number;
	readonly timers?: GateTimers;
	readonly validate?: (artifacts: GateArtifacts) => GateVerdict;
	/** Called once, loudly, when the watchdog failed the gate; the host must stop the planner and tell the user. */
	readonly onStall?: (reason: string) => void;
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

	constructor(options: CompletionGateOptions = {}) {
		const window = options.inactivityMs ?? DEFAULT_GATE_INACTIVITY_MS;
		this.#inactivityMs = Number.isFinite(window) && window > 0 ? Math.min(window, MAX_TIMER_MS) : 0;
		this.#timers = options.timers ?? PLATFORM_TIMERS;
		this.#validate = options.validate ?? ((artifacts) => validateArtifacts(artifacts));
		this.#onStall = options.onStall;
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
	 * The single atomic release: it returns the staged text exactly once, and only from `ready`. A partial plan
	 * reports what is missing and stays unreleased; any other call changes nothing and says why.
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
		if (!staged || !verdict)
			return { ok: false, reason: "failed", detail: "no validated artifacts are staged" };
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
