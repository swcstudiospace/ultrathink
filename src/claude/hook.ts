// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Orchestrates one UserPromptSubmit event: decide → Jev plan gate (opt-in) → uplift → Graph of Thought
 * with per-node rationale/conclusion fills → HITL clarifications → build a Notion/Linear
 * TrackPlan → persist session state → return the spec plus an instruction to
 * invoke ultrathink-kickoff as hook context. Everything after "decide" is
 * fail-open: the user's prompt always goes through. Caller or provider cancellation is re-thrown as an
 * AbortError, aborting sibling work and preventing later inference or side effects.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { UltrathinkConfig } from "../config.ts";
import { createDecisions, type DecisionsDeps, decisionsKilled } from "../decisions/gate.ts";
import { takeJevWarning } from "../decisions/health.ts";
import type { DecisionRecord } from "../decisions/types.ts";
import {
	createGreptileKnowledge,
	type KnowledgeLookup,
	type KnowledgeReader,
	type KnowledgeResult,
	type KnowledgeSession,
} from "../greptile/knowledge.ts";
import { injectClarificationsXml } from "../hitl/format.ts";
import { normalizeQuestion, type RunClarifyOptions, runClarify } from "../hitl/pipeline.ts";
import type { Clarification } from "../hitl/types.ts";
import { FlightThrottle } from "../resilience/throttle.ts";
import { injectGraphXml, isFallbackGraph } from "../think/graph.ts";
import { type RunThinkOptions, runThink, type ThinkResult } from "../think/pipeline.ts";
import type { ThoughtGraph } from "../think/types.ts";
import {
	type BriefFailure,
	type BriefResult,
	type EmitInput,
	emitEvent,
	fetchBrief,
} from "../substrate/brief.ts";
import { sanitizeBrief } from "../substrate/inject.ts";
import { resolveBranch, resolveRepoSlug } from "../track/git.ts";
import { buildTrackPlan } from "../track/plan.ts";
import type { Tracker } from "../track/gateway.ts";
import { injectTrackingXml } from "../track/render.ts";
import type { TrackingRefs, TrackPlan } from "../track/types.ts";
import type { ModelResolution } from "../host/engine.ts";
import { type ActivityNotice, toActivityNotice } from "../host/activity-notice.ts";
import type { ProgressEvent, ProgressSink, StageName } from "../host/progress.ts";
import type { CompletionReport, UpliftResult, UpliftState } from "../types.ts";
import { docsLookup, formatDocsSection, groundDocs } from "../ragflow/ground.ts";
import { teachContext, teachEnabled } from "../teach/context.ts";
import { formatLessonsSection, lessonsLookup, recallLessons } from "../teach/recall.ts";
import type { GroundOutcome, DocsLookup } from "../ragflow/types.ts";
import { isHostId, type HostId } from "../host/types.ts";
import { redactSecrets } from "../redact.ts";
import { isAbortError, isRecord } from "../shared.ts";
import { probeRealmRaw, realmHint, type RealmProbe } from "../stack/realm.ts";
import {
	formatSkillsSection,
	recallSkills,
	skillsLookup,
	SKILL_SECTION_CHARS,
} from "../teach/skills.ts";
import type {
	LessonsLookup,
	RecallOutcome,
	SkillRecallOutcome,
	SkillsLookup,
} from "../teach/types.ts";
import { isSubagentEnvelope } from "../host/envelope.ts";
import { decideUplift } from "../uplift/detect.ts";
import type { SkillInvocation } from "../uplift/skill.ts";
import { runUplift } from "../uplift/run.ts";
import { pruneSessionsBestEffort } from "../retention/prune.ts";
import { type LockOptions, withFileLock, writeFileAtomic } from "./atomic.ts";
import type { ClaudeCompleter } from "./complete.ts";
import { isChildInvocation } from "./complete.ts";
import { formatPlanSkipNotice, formatPromptContext, formatSummary } from "./output.ts";
import { JEV_PLAN_SKIP, planGate } from "./plan-gate.ts";
import { shipApplies } from "../ship/policy.ts";
import {
	clearSkipOnce,
	type ControlState,
	hostSessionId,
	HOOK_LOCK,
	isTurnSessionId,
	newTurnSessionId,
	readSession,
	readSkipOnce,
	type SessionRecord,
	sessionPath,
	trackingCheckpoint,
	updateSession,
	writeSession,
} from "./state.ts";

export interface PromptSubmitInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	prompt?: string;
	hook_event_name?: string;
	/** Set when `prompt` is the instruction (or objective) of a skill invocation; the skill stays authoritative. */
	skill?: SkillInvocation;
}

interface HookOutput {
	hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string };
	systemMessage?: string;
}

export interface HookDeps {
	config: UltrathinkConfig;
	control: ControlState;
	complete: ClaudeCompleter;
	/** Thinking engine label recorded and echoed: the selected route and its wire model, e.g. "claude:<model>" or "<model>@<effort>". */
	engine: string;
	/**
	 * Safe selection record of `complete` (UT-Planning-ModelSelection §6). Reported on progress begin/end and in the
	 * summary and context, and persisted on the SessionRecord of a real plan only. Absent for legacy injected callers.
	 */
	modelResolution?: ModelResolution;
	stateDir: string;
	/** Lock policy of the plan save and the tracker checkpoints. Absent: `HOOK_LOCK` (this pipeline runs in a hook process: 15 s, then one logged unlocked write); the Omp extension passes `OMP_LOCK` (2 s) so it never freezes the TUI. */
	stateLock?: LockOptions;
	/**
	 * The session's armed /ultrathink-skip as the caller read it, before any engine wait (the Claude/Grok/Muse hook and
	 * planPrompt both do). Absent, the hook reads it at its own start. Either way, a prompt skipped by it clears the flag.
	 */
	armedSkip?: boolean;
	clarify?: (opts: RunClarifyOptions) => Promise<{ items: Clarification[]; failed?: string }>;
	/** Test seam for the Graph of Thought; defaults to `runThink`. */
	think?: (opts: RunThinkOptions) => Promise<ThinkResult>;
	/** First error the completer threw (already redacted), surfaced in the summary. */
	engineError?: () => string | undefined;
	/** A successful failover to another route this run (not an error), e.g. "claude:… → grok:… (plan-limit)". */
	engineFailover?: () => string | undefined;
	/** The completer's report for its most recent call (attempts, HTTP status), read when the uplift falls back. */
	engineReport?: () => CompletionReport | undefined;
	/** Set when the engine route's completer already owns the flight's limiter (Omp's native binding): the think stage then builds and takes none, so a flight has exactly one. */
	throttle?: FlightThrottle;
	/** Test seam for git remote/branch resolution; default reads the real repo at cwd. */
	git?: (cwd: string) => { repo?: string; branch?: string };
	conversation?: (transcriptPath?: string) => string;
	/**
	 * Test seam for the Agent Substrate brief; defaults to the real fail-open `fetchBrief` against `config.substrate.url`,
	 * with the env the host injected (`decisionsDeps.env`) or else `process.env`. Resolves to a {@link BriefResult}: a
	 * missing brief is `state: "none"` with a `reason`, never a rejection (a rejection still reads as no brief).
	 */
	brief?: (input: {
		repo?: string;
		branch?: string;
		surface?: string;
		signal?: AbortSignal;
	}) => Promise<BriefResult>;
	/**
	 * Test seam for the Agent Substrate plan event: the one `note` a planned prompt leaves in the ledger, carrying the
	 * Graph ID the substrate adopts as its correlation key. Defaults to the real fail-open `emitEvent` against
	 * `config.substrate.url`, with the env the host injected (`decisionsDeps.env`) or else `process.env`. Called once,
	 * after the session record is written; its answer, a rejection or a throw never changes the result.
	 */
	emit?: (event: EmitInput, signal?: AbortSignal) => Promise<boolean>;
	/** Host that asked for the brief and is named on the plan event. Defaults to Claude so existing callers stay stable. */
	surface?: string;
	/**
	 * Test seam for the Realm daemon probe: one per plan, started next to the brief fetch with a 1 s budget and never
	 * awaited past the brief. Defaults to {@link probeRealmRaw}. A rejection reads as an unknown realm (no note).
	 */
	realmProbe?: (
		env: Record<string, string | undefined>,
		opts: { timeoutMs: number; cwd: string },
	) => Promise<RealmProbe>;
	now?: () => number;
	/** Timer port for the budget and lookup deadlines; defaults to the platform timers. */
	timers?: TimerPort;
	log?: (message: string) => void;
	/** Creates tracker rows through the MCP gateway before the prompt goes out; fail-open. */
	track?: Tracker;
	/** Deterministic command the kickoff skill runs to finish missing rows. */
	trackCommand?: string;
	/** Tracking is off for this prompt: no tracker call, no kickoff instruction or Linked issues; the plan is still recorded. */
	trackingOff?: boolean;
	/** Structured live progress (Omp status bar); a throwing sink never breaks planning. */
	progress?: ProgressSink;
	/** Test seam for the Greptile knowledge-base prefetch; defaults to `createGreptileKnowledge(config)` (undefined unless opted in). */
	knowledge?: KnowledgeReader;
	/**
	 * The whole planning lifetime (caller or flight cancellation). Combined with `config.claude.budgetMs` and passed to the
	 * Jev gate, the brief, every lookup and stage, and tracking; once it aborts, the next stage boundary throws an
	 * AbortError and no later stage, tracker call, state write or delivery starts.
	 */
	signal?: AbortSignal;
	/** Seams for the Decisions runtime (env, storePath, fetch, now, sleep, random, debug); config comes from config.decisions. */
	decisionsDeps?: DecisionsDeps;
	/**
	 * Lessons lookup (Teachable Moments). Defaults to `recallLessons` when `config.teach.enabled && config.teach.recall`;
	 * an injected seam always runs. Gets only the user's original prompt (truncated), never the spec or history.
	 */
	recall?: (input: { query: string; cwd: string; signal: AbortSignal }) => Promise<RecallOutcome>;
	/** RAGFlow document grounding. Defaults to `groundDocs` when `config.ragflow.enabled && config.ragflow.ground`; same query rule. */
	ground?: (input: { query: string; signal: AbortSignal }) => Promise<GroundOutcome>;
	/**
	 * Promoted-skills lookup (Teachable Moments). Defaults to `recallSkills` when `config.teach.enabled && config.teach.recall`;
	 * an injected seam always runs. Same query rule as `recall`.
	 */
	skills?: (input: {
		query: string;
		cwd: string;
		signal: AbortSignal;
	}) => Promise<SkillRecallOutcome>;
}

export interface PromptSubmitResult {
	output?: HookOutput;
	record?: SessionRecord;
	skipped?: string;
	/** Why a deterministic skip happened (the uplift decision's reason, e.g. "trivial" or "skip-once"); set with `skipped`. */
	reason?: string;
	/** Jev skip notice (§5.3); set only on a Jev skip with claude.echo on. */
	notice?: string;
	/** Every DecisionRecord of this prompt, in call order; absent when none. */
	decisions?: DecisionRecord[];
}

function specFile(stateDir: string, sessionId: string): string {
	return sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml");
}

/**
 * The id every tracker row of one plan carries, in the shape every graph-id consumer expects
 * (`ut-<token>-<8 hex>`: the gateway's GRAPH_ID_PATTERN, the swarm lane brief, the hand-off guard in uplift/detect).
 * The first 10 hex digits are the session's hash of the user's original prompt:
 * `sha256(sessionId + "\n" + sha256(original))`. The 8 after the dash are a hash of that, the repository the plan labels
 * its rows with (the resolved `owner/name` slug, else the resolved working directory) and the graph's text, for each
 * node in order its id, kind, title, question, dependencies, thinking and conclusion: everything the tracker's rows are
 * built from (step titles come from the thinking, descriptions from the conclusion). So equal ids mean identical row
 * titles and bodies for the same repository. A byte-identical resend adopts the rows a killed flight already made; any
 * other graph or another repository gets a different id and can never adopt an earlier plan's rows (they are left alone
 * in the tracker). Without a graph (thinking off) the id is the prompt and the repository. The `degraded` flag is not in
 * it: a degraded node has empty fills, which differ on their own.
 */
function deterministicGraphId(
	sessionId: string,
	original: string,
	graph: ThoughtGraph | undefined,
	repository: string,
): string {
	const digest = (text: string) => createHash("sha256").update(text).digest("hex");
	const hex = digest(`${sessionId}\n${digest(original)}`);
	const nodes = graph
		? graph.nodes.map((node) => [
				node.id,
				node.kind,
				node.title,
				node.question,
				node.dependsOn,
				node.thinking ?? "",
				node.conclusion ?? "",
			])
		: null;
	// One JSON array, so no two inputs can concatenate to the same text.
	return `ut-${hex.slice(0, 10)}-${digest(JSON.stringify([hex, repository, nodes])).slice(0, 8)}`;
}

/** A tracking record with no refs: tells the tracker a flight of this graph id may already have created rows to adopt. */
function emptyTracking(graphId: string, at: number): TrackingRefs {
	return {
		graphId,
		status: "failed",
		linear: { nodes: {}, steps: {} },
		notion: { nodes: {}, steps: {} },
		errors: [],
		updatedAt: at,
	};
}

/**
 * A replan keeps the session's edited repos and recalculates its mismatch against the new plan's label, so a session that
 * already edited another repo neither forgets it nor repeats its warning (see recordEditAttribution in host/omp.ts).
 */
function carryRepoAttribution(
	prior: SessionRecord | undefined,
	record: SessionRecord,
): SessionRecord {
	const workRepos = prior?.workRepos;
	if (workRepos === undefined) return record;
	if (!record.plan) return { ...record, workRepos };
	const labelled = record.plan.task.repo ?? null;
	if (workRepos.every((repo) => repo === labelled)) return { ...record, workRepos };
	return { ...record, workRepos, repoMismatch: { labelled, edited: workRepos } };
}

/**
 * Saves a fresh plan record and its spec XML under the session's file lock, the
 * same lock `updateSession` (the answers/ship/mark updates) holds, so a locked
 * update can neither be overwritten by nor overwrite this save with stale
 * content. Answers that landed after this flight read the session are overlaid
 * onto the same questions (and re-injected into the spec XML) instead of being
 * lost with the stale read; plan-scoped marks stay false on the new plan by
 * design. The hold is one read plus two atomic writes, and a stale or
 * unobtainable lock never blocks the prompt: the save runs unlocked, as the
 * lock API already does.
 */
export function savePlanRecord(
	stateDir: string,
	sessionId: string,
	record: SessionRecord,
	log: (message: string) => void = () => {
		// reason: no logger was injected; the default is a silent sink
	},
	lock?: LockOptions,
): { record: SessionRecord; specPath: string; statePath: string; lastNote?: string } {
	const statePath = sessionPath(stateDir, sessionId);
	const specPath = specFile(stateDir, sessionId);
	let lastNote: string | undefined;
	const saved = withFileLock(
		statePath,
		() => {
			const base = record.clarifications ?? [];
			const prior = readSession(stateDir, sessionId);
			const late = (prior?.clarifications ?? []).filter(
				(c) => c.answer && c.source !== "knowledge",
			);
			let merged = carryRepoAttribution(prior, record);
			if (late.length > 0) {
				const byQuestion = new Map<string, Clarification>(
					late.map((c) => [normalizeQuestion(c.question), c]),
				);
				const seen = new Set(base.map((c) => normalizeQuestion(c.question)));
				const clarifications = base.map((c) => byQuestion.get(normalizeQuestion(c.question)) ?? c);
				for (const c of late) {
					if (!seen.has(normalizeQuestion(c.question))) clarifications.push(c);
				}
				if (clarifications.some((c, index) => c !== base[index])) {
					merged = {
						...merged,
						clarifications,
						result: {
							...record.result,
							xml: injectClarificationsXml(record.result.xml, clarifications),
						},
					};
				}
			}
			writeFileAtomic(specPath, `${merged.result.xml}\n`);
			lastNote = writeSession(stateDir, merged);
			if (lastNote) log(lastNote);
			return merged;
		},
		{ log, ...lock },
	);
	return { record: saved, specPath, statePath, lastNote };
}

/**
 * What the knowledge base should be matched against: the uplifted spec's text plus the graph's goal and node titles and
 * conclusions. Tags are stripped: their names and attributes (GRAPH_OF_THOUGHT, NODE, kind, …) would otherwise score
 * unrelated routing entries on every request.
 */
function knowledgeTopic(result: UpliftResult, graph: ThoughtGraph | undefined): string {
	const parts = [result.xml.replace(/<[^>]*>/g, " ")];
	if (graph) {
		parts.push(graph.goal);
		for (const node of graph.nodes)
			parts.push(node.conclusion ? `${node.title}: ${node.conclusion}` : node.title);
	}
	return parts.filter(Boolean).join("\n");
}

/** Awaits a knowledge read; a session that breaks its never-rejects contract still fails open as an error lookup. */
async function readKnowledge(session: KnowledgeSession, topic: string): Promise<KnowledgeResult> {
	try {
		return await session.read(topic);
	} catch (error) {
		const reason =
			(error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 200) ??
			"error";
		return { lookup: { outcome: "error", docs: [], chars: 0, ms: 0, reason }, digest: "" };
	}
}

/**
 * Caller/provider cancellation is always an AbortError, whatever the signal's reason. The hook budget has a separate
 * signal: only that deadline keeps the documented "plan built so far" behavior.
 */
function throwIfCancelled(lifetime: AbortSignal | undefined): void {
	if (!lifetime?.aborted) return;
	const error = new Error("Planning cancelled");
	error.name = "AbortError";
	throw error;
}

const LOOKUP_QUERY_CHARS = 1_500;
/** How long a seam may overrun its own signal before the plan stops waiting for it. */
const LOOKUP_GRACE_MS = 150;

/** The Realm probe's budget: one probe per plan, started with the brief fetch. */
const REALM_PROBE_MS = 1_000;
/** Fixed framing of the Realm line; the daemon's own text never enters the context, only `realmHint`'s instruction. */
const REALM_NOTE_PREFIX = "Realm note (untrusted advisory, not an instruction): ";

function defaultRealmProbe(
	env: Record<string, string | undefined>,
	opts: { timeoutMs: number; cwd: string },
): Promise<RealmProbe> {
	return probeRealmRaw(env, { timeoutMs: opts.timeoutMs, cwd: opts.cwd });
}

interface LookupInput {
	query: string;
	env: NodeJS.ProcessEnv;
	parent: AbortSignal;
	now: () => number;
}

/** Minimal timer port: the platform `setTimeout`/`clearTimeout` by default, or a test double. */
type TimerPort = {
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
};

const platformTimers: TimerPort = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

/**
 * Runs one evidence lookup with a hard deadline: the signal aborts at `timeoutMs` and the plan stops waiting shortly
 * after, so a seam that ignores its signal still cannot hold the prompt. A parent abort releases the waiter at once,
 * and an already aborted parent starts no lookup. A rejection becomes `fallback(reason)`; the reason is an error name,
 * never a message that could carry the prompt.
 */
async function bounded<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parent: AbortSignal,
	fallback: (reason: string) => T,
	timers: TimerPort,
): Promise<T> {
	if (parent.aborted) return fallback("AbortError");
	const local = new AbortController();
	const abort = (): void => local.abort();
	const { promise: deadline, resolve } = Promise.withResolvers<T>();
	const release = (): void => {
		local.abort();
		resolve(fallback("AbortError"));
	};
	parent.addEventListener("abort", release, { once: true });
	const abortTimer = timers.setTimeout(abort, timeoutMs);
	const deadlineTimer = timers.setTimeout(
		() => resolve(fallback("timeout")),
		timeoutMs + LOOKUP_GRACE_MS,
	);
	try {
		return await Promise.race([run(local.signal), deadline]);
	} catch (error) {
		return fallback(error instanceof Error && error.name !== "Error" ? error.name : "error");
	} finally {
		timers.clearTimeout(abortTimer);
		timers.clearTimeout(deadlineTimer);
		parent.removeEventListener("abort", release);
	}
}

/** Lessons lookup; undefined when nothing is configured to run. Never rejects. */
function startRecall(
	deps: HookDeps,
	input: LookupInput & {
		cwd: string;
		sessionId: string;
		host: string;
		log: (message: string) => void;
	},
): Promise<RecallOutcome> | undefined {
	const seam = deps.recall;
	const teach = deps.config.teach;
	if (!seam && !(teach.enabled && teach.recall)) return undefined;
	const started = input.now();
	const run =
		seam ??
		(async (arg: { query: string; cwd: string; signal: AbortSignal }): Promise<RecallOutcome> => {
			const ctx = teachContext({
				host: input.host,
				cwd: arg.cwd,
				env: input.env,
				sessionId: input.sessionId,
				stateDir: deps.stateDir,
				config: { teach, hindsight: deps.config.hindsight, gateway: deps.config.gateway },
				signal: arg.signal,
				now: input.now,
				log: input.log,
			});
			if (!teachEnabled(ctx))
				return { status: "off", lessons: [], source: "none", chars: 0, ms: 0, reason: "disabled" };
			return recallLessons({ query: arg.query }, ctx, { countUse: true });
		});
	return bounded(
		(signal) => run({ query: input.query, cwd: input.cwd, signal }),
		teach.timeoutMs,
		input.parent,
		(reason) => ({
			status: "error",
			lessons: [],
			source: "none",
			chars: 0,
			ms: input.now() - started,
			reason,
		}),
		deps.timers ?? platformTimers,
	);
}

/** RAGFlow grounding lookup; undefined when nothing is configured to run. Never rejects. */
function startGround(deps: HookDeps, input: LookupInput): Promise<GroundOutcome> | undefined {
	const seam = deps.ground;
	const ragflow = deps.config.ragflow;
	if (!seam && !(ragflow.enabled && ragflow.ground)) return undefined;
	const started = input.now();
	const run =
		seam ??
		(async (arg: { query: string; signal: AbortSignal }): Promise<GroundOutcome> => {
			return groundDocs({
				query: arg.query,
				config: ragflow,
				gateway: deps.config.gateway,
				env: input.env,
				signal: arg.signal,
				now: input.now,
			});
		});
	return bounded(
		(signal) => run({ query: input.query, signal }),
		ragflow.timeoutMs,
		input.parent,
		(reason) => ({
			status: "error",
			chunks: [],
			chars: 0,
			ms: input.now() - started,
			datasets: 0,
			reason,
		}),
		deps.timers ?? platformTimers,
	);
}

/** Promoted-skills lookup; undefined when nothing is configured to run. Never rejects. */
function startSkills(
	deps: HookDeps,
	input: LookupInput & {
		cwd: string;
		sessionId: string;
		host: string;
		log: (message: string) => void;
	},
): Promise<SkillRecallOutcome> | undefined {
	const seam = deps.skills;
	const teach = deps.config.teach;
	if (!seam && !(teach.enabled && teach.recall)) return undefined;
	const started = input.now();
	const run =
		seam ??
		(async (arg: {
			query: string;
			cwd: string;
			signal: AbortSignal;
		}): Promise<SkillRecallOutcome> => {
			const ctx = teachContext({
				host: input.host,
				cwd: arg.cwd,
				env: input.env,
				sessionId: input.sessionId,
				stateDir: deps.stateDir,
				config: { teach, hindsight: deps.config.hindsight, gateway: deps.config.gateway },
				signal: arg.signal,
				now: input.now,
				log: input.log,
			});
			if (!teachEnabled(ctx))
				return { status: "off", skills: [], chars: 0, ms: 0, reason: "disabled" };
			return recallSkills({ query: arg.query }, ctx);
		});
	return bounded(
		(signal) => run({ query: input.query, cwd: input.cwd, signal }),
		teach.timeoutMs,
		input.parent,
		(reason) => ({ status: "error", skills: [], chars: 0, ms: input.now() - started, reason }),
		deps.timers ?? platformTimers,
	);
}

/** The stable wording of a missing brief's reason; a closed vocabulary, so a segment can never carry a token or a URL. */
function briefReasonPhrase(reason: BriefFailure): string | undefined {
	switch (reason) {
		case "disabled":
		case "no-url":
			return undefined; // no Substrate is configured, so there is nothing to report
		case "unauthorized":
			return "unauthorized";
		case "surface-mismatch":
			return "surface mismatch, retry skipped";
		case "bad-request":
			return "bad request";
		case "timeout":
			return "timed out";
		case "unreachable":
			return "unreachable";
		case "redirect refused":
			return "redirect refused";
		default:
			if (reason.startsWith("url refused:")) return "url refused";
			return /^http-\d{3}$/.test(reason) ? reason : "unreachable";
	}
}

/**
 * The one planning-summary segment for a configured Substrate that returned no brief: `Substrate · brief unavailable
 * (<phrase>)`. Absent for a usable brief (complete, degraded, snapshot), for an empty answer without a reason, and when no
 * Substrate is configured (`disabled`, `no-url`). Carries the reason phrase only, never `detail`, a URL or a token.
 */
function substrateBriefNotice(result: BriefResult): string | undefined {
	if (result.state !== "none" || result.reason === undefined) return undefined;
	const phrase = briefReasonPhrase(result.reason);
	return phrase === undefined ? undefined : `Substrate · brief unavailable (${phrase})`;
}

/**
 * Tells the Agent Substrate a prompt was planned: one `note` event keyed by the Graph ID, which the substrate adopts
 * unchanged as the correlation key for the run. It names the graph, its size and the host, never anything the user wrote
 * or the engine produced. Its `sessionId` is `<hostSessionId>:<graphId>`: the substrate chains events per session id, so each
 * planned graph gets its own chain. Never rejects: no URL, a refusal, a timeout or a throwing seam all leave the prompt as it was.
 */
async function announcePlan(
	deps: HookDeps,
	input: {
		plan: TrackPlan;
		sessionId: string;
		host: string;
		skill?: string;
		repo?: string;
		branch?: string;
		/** The planning budget: once it fires there is no point telling the substrate, so the request is skipped or cut short. */
		signal: AbortSignal;
	},
): Promise<void> {
	try {
		if (input.signal.aborted) return;
		const { plan, host } = input;
		const nodes = plan.issues.length;
		// The host's own env when it injected one (planPrompt does, for the brief too), else the process's.
		const env = deps.decisionsDeps?.env ?? process.env;
		const send =
			deps.emit ??
			((event: EmitInput, signal?: AbortSignal) =>
				emitEvent(event, env, deps.config.substrate.url, signal, {
					backend: deps.config.substrate.backend,
					gateway: deps.config.gateway,
				}));
		await send(
			{
				kind: "note",
				summary: `ultrathink planned graph ${plan.graphId} (${nodes} nodes)`,
				surface: host,
				sessionId: `${input.sessionId}:${plan.graphId}`,
				graphId: plan.graphId,
				repo: input.repo,
				branch: input.branch,
				payload: {
					ultrathink: "plan",
					nodes,
					host,
					...(input.skill ? { skill: input.skill } : {}),
				},
			},
			input.signal,
		);
	} catch {
		// reason: fail-open: the substrate records a plan, it never gates one
	}
}

/** Most model calls one flight lets run at once, whatever `claude.concurrency` says: a shared rate limit punishes more. */
const MAX_FLIGHT_CONCURRENCY = 3;
/** Longest cause the hook records or shows for a failed stage. */
const MAX_CAUSE_CHARS = 200;
/** The `degraded` cause of a clarify stage that was not attempted because the provider had just failed every retry. */
const CLARIFY_SKIPPED_CAUSE = "skipped: provider unavailable";

/** A redacted, single-line, bounded cause of a failed stage: the error's message or the given text, never a reply body. */
function causeText(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value);
	return redactSecrets(raw).replace(/\s+/g, " ").trim().slice(0, MAX_CAUSE_CHARS) || "error";
}

function isThoughtGraph(value: unknown): value is ThoughtGraph {
	return (
		isRecord(value) &&
		typeof value.goal === "string" &&
		Array.isArray(value.nodes) &&
		value.nodes.every((node) => isRecord(node) && typeof node.id === "string")
	);
}

/** The partial graph a throwing think stage carries, as `error.partial.graph` or `error.graph`; undefined when it carries none. */
function partialGraphOf(error: unknown): ThoughtGraph | undefined {
	if (!isRecord(error)) return undefined;
	const carrier = isRecord(error.partial) ? error.partial : error;
	return isThoughtGraph(carrier.graph) ? carrier.graph : undefined;
}

export async function runPromptSubmit(
	input: PromptSubmitInput,
	deps: HookDeps,
): Promise<PromptSubmitResult> {
	const now = deps.now ?? Date.now;
	const timers = deps.timers ?? platformTimers;
	const emit = (event: ProgressEvent): void => {
		try {
			deps.progress?.(event);
		} catch {
			// reason: fail-open: progress is display only
		}
	};
	const emitActivity = (notice: ActivityNotice): void => {
		if (!deps.progress) return;
		try {
			const clean = toActivityNotice(notice);
			if (!clean) return;
			deps.progress({ type: "activity", at: now(), notice: clean });
		} catch {
			// reason: fail-open: a card never blocks planning
		}
	};
	const stage = (name: StageName, phase: "start" | "end", ok?: boolean, detail?: string): void =>
		emit({
			type: "stage",
			at: now(),
			stage: name,
			phase,
			...(ok === undefined ? {} : { ok }),
			...(detail ? { detail } : {}),
		});
	const started = now();
	const log =
		deps.log ??
		(() => {
			// reason: no logger was injected; the hook runs silently
		});
	const cwd = input.cwd?.trim() || process.cwd();
	const sessionId = hostSessionId(input.session_id) ?? newTurnSessionId();

	// The armed skip belongs to this session alone; the global control file never carries one. A caller that read it before
	// an engine wait passes that value, so a skip armed during the wait waits for this session's next prompt. The prompt
	// that consumes the flag clears it here.
	const skipArmed = deps.armedSkip ?? readSkipOnce(deps.stateDir, sessionId);
	const state: UpliftState = {
		enabled: deps.control.enabled ?? deps.config.uplift.enabled,
		skipOnce: skipArmed,
		skipTrivial: deps.config.uplift.skipTrivial,
	};
	const decision = decideUplift({ text: input.prompt ?? "", source: "user", idle: true }, state);
	// Only the prompt skipped by the armed flag spends it (reason "skip-once"); a command, an ack or a disabled-planning
	// skip leaves it armed for the real next prompt.
	if (skipArmed && decision.action === "skip" && decision.reason === "skip-once") {
		try {
			clearSkipOnce(deps.stateDir, sessionId);
		} catch {
			// reason: fail-open: a skip-once marker that cannot be removed only skips one later planning pass; the prompt must not block on it
		}
	}
	if (decision.action !== "uplift") {
		return {
			skipped: decision.action,
			...(decision.action === "skip" ? { reason: decision.reason } : {}),
		};
	}
	// A cancelled flight starts nothing: no gate request, stage, lookup, tracker call or write.
	throwIfCancelled(deps.signal);
	const skill = input.skill;
	// Read once: the plan gate's last assistant turn and the planner's recent conversation.
	const history = deps.conversation?.(input.transcript_path) ?? "";
	// DP-PLAN (D8): consulted once every deterministic rule has left the prompt to plan, before anything runs. A skip
	// looks exactly like a deterministic one: no event, engine, brief, knowledge or tracker call, and no state write.
	const decisions = createDecisions({
		config: deps.config.decisions,
		...(isTurnSessionId(sessionId) ? {} : { sessionId }),
		stateDir: deps.stateDir,
		...deps.decisionsDeps,
	});
	// Keep cancellation separate from the hook's partial-result budget, whose timer starts after the gate as before.
	const controller = new AbortController();
	const cancellation = deps.signal
		? AbortSignal.any([deps.signal, controller.signal])
		: controller.signal;
	const budgetController = new AbortController();
	const lifetime = AbortSignal.any([cancellation, budgetController.signal]);
	const rethrowCancellation = (error: unknown): void => {
		// A provider can abort while the caller is still live. Only an expired hook budget may fail open with a partial plan.
		if (!budgetController.signal.aborted && isAbortError(error)) controller.abort();
		throwIfCancelled(cancellation);
	};
	const complete: ClaudeCompleter = async (system, user, signal) => {
		// The algorithm's parallel workers may still be unwinding: none may dispatch or consume a late sibling result.
		throwIfCancelled(lifetime);
		try {
			const text = await deps.complete(system, user, signal);
			throwIfCancelled(cancellation);
			return text;
		} catch (error) {
			rethrowCancellation(error);
			throw error;
		}
	};
	const gate = await planGate(
		{ prompt: input.prompt ?? "", text: decision.text, skill, history },
		decisions,
		lifetime,
	);
	throwIfCancelled(cancellation);
	if (!gate.plan) {
		return {
			skipped: JEV_PLAN_SKIP,
			decisions: [gate.record],
			...(deps.config.claude.echo ? { notice: formatPlanSkipNotice(gate.p) } : {}),
		};
	}
	const records: DecisionRecord[] = gate.record ? [gate.record] : [];
	const withResolution = deps.modelResolution ? { modelResolution: deps.modelResolution } : {};
	emit({
		type: "begin",
		at: now(),
		sessionId,
		engine: deps.engine,
		...withResolution,
		track: deps.track !== undefined && !deps.trackingOff,
		...(skill ? { skill: skill.name } : {}),
	});
	let outcome: "planned" | "skipped" | "failed" = "failed";
	let outcomeDetail: string | undefined;

	let session: KnowledgeSession | undefined;
	const budget =
		deps.config.claude.budgetMs > 0
			? timers.setTimeout(() => budgetController.abort(), deps.config.claude.budgetMs)
			: undefined;
	try {
		const original = decision.text;
		const skillLine = skill
			? `The user invoked the "${skill.name}" skill with this message.${skill.summary ? ` Skill summary: ${skill.summary}` : ""}`
			: "";
		const conversation = [skillLine, history].filter(Boolean).join("\n");

		// Resolved once and shared by the brief and the TrackPlan below.
		const git = (() => {
			try {
				return deps.git?.(cwd) ?? { repo: resolveRepoSlug(cwd), branch: resolveBranch(cwd) };
			} catch {
				return {} as { repo?: string; branch?: string };
			}
		})();

		// Decided before the brief: the knowledge-base prefetch only runs when clarify will.
		const hitlOn = deps.control.hitlEnabled ?? deps.config.hitl.enabled;

		// Started now, awaited before the Graph of Thought: the graph is then
		// planned knowing what other agents already did, and the round trip
		// overlaps the uplift call instead of adding to it.
		stage("brief", "start");
		// The brief and the plan event read the same env: the host's injected one, else the process's (announcePlan).
		const substrateEnv = deps.decisionsDeps?.env ?? process.env;
		const fetchSessionBrief =
			deps.brief ??
			((brief) =>
				fetchBrief(brief, substrateEnv, deps.config.substrate.url, {
					backend: deps.config.substrate.backend,
					gateway: deps.config.gateway,
				}));
		const briefPromise = fetchSessionBrief({
			repo: git.repo,
			branch: git.branch,
			surface: deps.surface ?? "claude-code",
			signal: lifetime,
		}).catch((): BriefResult => ({ text: "", state: "none" }));

		// The Realm probe runs beside the brief and the uplift, once per plan, capped at 1 s; it never rejects.
		// The async wrapper turns a seam that throws before returning its promise into a rejection too.
		const realmPromise = (async () =>
			(deps.realmProbe ?? defaultRealmProbe)(substrateEnv, {
				timeoutMs: REALM_PROBE_MS,
				cwd,
			}))().catch((): RealmProbe => ({ kind: "unknown", why: "io" }));

		// The two evidence lookups start next to the brief and use only the user's own words: never the spec XML, the
		// conversation history, or anything the engine produced.
		const lookupQuery = original.trim().slice(0, LOOKUP_QUERY_CHARS);
		const lookups =
			lookupQuery !== "" &&
			!isChildInvocation() &&
			!isSubagentEnvelope(input as Record<string, unknown>);
		const lookupEnv = deps.decisionsDeps?.env ?? process.env;
		const surfaceId = deps.surface ?? "claude-code";
		const recallPromise = lookups
			? startRecall(deps, {
					query: lookupQuery,
					cwd,
					sessionId,
					host: surfaceId,
					env: lookupEnv,
					parent: lifetime,
					now,
					log,
				})
			: undefined;
		const groundPromise = lookups
			? startGround(deps, { query: lookupQuery, env: lookupEnv, parent: lifetime, now })
			: undefined;
		const skillsPromise = lookups
			? startSkills(deps, {
					query: lookupQuery,
					cwd,
					sessionId,
					host: surfaceId,
					env: lookupEnv,
					parent: lifetime,
					now,
					log,
				})
			: undefined;

		// The knowledge-base prefetch (find the repo, list documents, read index.md) overlaps the uplift and the
		// Graph of Thought; the topic-specific documents are read right before clarify.
		const reader = hitlOn ? (deps.knowledge ?? createGreptileKnowledge(deps.config)) : undefined;
		if (reader) {
			try {
				session = reader.start({ repo: git.repo, signal: lifetime });
				stage("knowledge", "start");
			} catch (error) {
				log(
					`greptile knowledge base: start failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		let result: UpliftResult;
		throwIfCancelled(cancellation);
		stage("uplift", "start");
		try {
			result = await runUplift({
				original,
				conversation,
				complete,
				signal: lifetime,
				report: deps.engineReport,
			});
		} catch (error) {
			rethrowCancellation(error);
			log(`uplift failed: ${error instanceof Error ? error.message : String(error)}`);
			stage("uplift", "end", false);
			outcome = "skipped";
			outcomeDetail = "uplift-failed";
			return { skipped: "uplift-failed", ...(records.length ? { decisions: records } : {}) };
		}
		// A completer that ignored its signal and answered anyway still ends a cancelled flight here.
		throwIfCancelled(cancellation);
		stage(
			"uplift",
			"end",
			result.source === "llm",
			`${result.root} · ${result.source}${result.fallbackReason ? ` · ${result.fallbackReason}` : ""}`,
		);

		const briefResult = await briefPromise;
		throwIfCancelled(cancellation);
		// The one secret gate for the brief: everything downstream (summary, activity, context) reads the masked text. A
		// degraded or snapshot label is plain text and survives; only secret shapes are masked. Then control characters go
		// and the text is capped, so a brief another agent wrote cannot carry terminal escapes or flood the context.
		const brief = sanitizeBrief(redactSecrets(briefResult.text));
		// One secret-free line when a configured Substrate answered nothing; shown in the summary only (never repeated).
		const briefNotice = substrateBriefNotice(briefResult);
		if (brief) log(`substrate brief: ${brief.split("\n").length} lines`);
		else if (briefNotice) log(briefNotice);
		stage("brief", "end", true, brief ? `${brief.split("\n").length} lines` : "none");
		// Untrusted advisory about Realm, only for an enforcing realm (or a degraded one under fail-closed); formatPromptContext
		// appends it after the sanitised brief (so the cap never cuts it), and it never reaches the summary.
		const realmResult = await realmPromise;
		throwIfCancelled(cancellation);
		const realmHostId: HostId = isHostId(surfaceId) ? surfaceId : "claude-code";
		const realmAdvice = realmHint(realmResult, realmHostId);
		const realmNote =
			realmAdvice.enforcement === "enforcing" && realmAdvice.instruction
				? `${REALM_NOTE_PREFIX}${realmAdvice.instruction}`
				: undefined;
		try {
			if (brief) {
				const lines = brief.split("\n").length;
				emitActivity({
					v: 1,
					kind: "resource",
					title: "Substrate brief",
					source: "substrate",
					outcome: "used",
					count: lines,
					detail: `${lines} lines`,
				});
			}
		} catch {
			// reason: fail-open: the activity card is display only; a failed card never blocks planning
		}

		// Settled before anything is formatted so the record says what happened; all are bounded and never reject.
		const [recalled, grounded, skilled] = await Promise.all([
			recallPromise,
			groundPromise,
			skillsPromise,
		]);
		throwIfCancelled(cancellation);
		let lessons: LessonsLookup | undefined;
		let lessonsText = "";
		if (recalled) {
			try {
				lessons = lessonsLookup(recalled);
				lessonsText = formatLessonsSection(recalled, deps.config.teach.recallChars);
			} catch (error) {
				log(`lessons: format failed: ${error instanceof Error ? error.name : "error"}`);
				lessons = {
					outcome: "error",
					count: 0,
					ids: [],
					chars: 0,
					ms: recalled.ms,
					source: "none",
					reason: "format",
				};
			}
			log(
				`lessons: ${lessons.outcome} · ${lessons.count} · ${lessons.source} · ${lessons.ms}ms${lessons.reason ? ` · ${lessons.reason}` : ""}`,
			);
			if (lessons.outcome !== "off") {
				try {
					const source =
						lessons.source === "hindsight" || lessons.source === "local"
							? lessons.source
							: undefined;
					emitActivity({
						v: 1,
						kind: "teachable-recalled",
						title: "Lesson recalled",
						...(source ? { source } : {}),
						outcome: lessons.outcome,
						count: lessons.count,
						names: recalled.lessons.map((lesson) => lesson.name),
					});
				} catch {
					// reason: fail-open: the activity card is display only; a failed card never blocks planning
				}
			}
		}
		let docs: DocsLookup | undefined;
		let docsText = "";
		if (grounded) {
			try {
				docs = docsLookup(grounded);
				docsText = formatDocsSection(grounded, deps.config.ragflow.groundChars);
			} catch (error) {
				log(`docs: format failed: ${error instanceof Error ? error.name : "error"}`);
				docs = {
					status: "error",
					count: 0,
					chars: 0,
					ms: grounded.ms,
					datasets: grounded.datasets,
					reason: "format",
				};
			}
			log(
				`docs (RAGFlow): ${docs.status} · ${docs.count} excerpts · ${docs.datasets} datasets · ${docs.ms}ms${docs.reason ? ` · ${docs.reason}` : ""}`,
			);
			if (docs.status !== "off") {
				try {
					emitActivity({
						v: 1,
						kind: "resource",
						title: "RAGFlow",
						source: "ragflow",
						outcome: docs.status,
						count: docs.count,
						detail: docs.status === "error" ? (docs.reason ?? "error") : `${docs.count} excerpts`,
					});
				} catch {
					// reason: fail-open: the activity card is display only; a failed card never blocks planning
				}
			}
		}
		let skills: SkillsLookup | undefined;
		let skillsText = "";
		if (skilled) {
			try {
				skills = skillsLookup(skilled);
				skillsText = formatSkillsSection(skilled, SKILL_SECTION_CHARS);
			} catch (error) {
				log(`skills: format failed: ${error instanceof Error ? error.name : "error"}`);
				skills = {
					outcome: "error",
					count: 0,
					names: [],
					chars: 0,
					ms: skilled.ms,
					reason: "format",
				};
			}
			log(
				`skills: ${skills.outcome} · ${skills.count} · ${skills.ms}ms${skills.reason ? ` · ${skills.reason}` : ""}`,
			);
			if (skills.outcome !== "off") {
				try {
					emitActivity({
						v: 1,
						kind: "skill-recalled",
						title: "Skill recalled",
						outcome: skills.outcome,
						count: skills.count,
						names: skilled.skills.map((skill) => skill.name),
					});
				} catch {
					// reason: fail-open: the activity card is display only; a failed card never blocks planning
				}
			}
		}

		let graph: ThoughtGraph | undefined;
		let thinkDegraded: string[] = [];
		/** Redacted, bounded cause per degraded token ("graph", "fill:<id>", "clarify", "think", "state"); shown in the notice and stage details. */
		const degradedCauses: Record<string, string> = {};
		/** The think stage threw: a graph it did not hand back is unknown, never the boilerplate one. */
		let thinkThrew = false;
		/** The graph call failed after the completer's own retries (it carried a report): the provider is unavailable for this flight. */
		let providerUnavailable = false;
		const thinkOn = deps.control.thinkEnabled ?? deps.config.think.enabled;
		if (thinkOn && !lifetime.aborted) {
			stage("think", "start");
			// One limiter per flight: a rate limit seen by any fill slows every fill of this prompt. A route whose completer
			// already owns the limiter (Omp's native binding acquires a slot per call and feeds it every failure) is that one:
			// the think stage takes no second slot from it (a nested acquire at a limit of one would wait forever) and builds
			// none of its own. Only a route without a limiter gets one here.
			const throttle = deps.throttle
				? undefined
				: new FlightThrottle({
						max: Math.min(MAX_FLIGHT_CONCURRENCY, deps.config.claude.concurrency),
					});
			try {
				const thought = await (deps.think ?? runThink)({
					uplift: result,
					complete,
					signal: lifetime,
					minNodes: deps.config.think.minNodes,
					maxNodes: deps.config.think.maxNodes,
					concurrency: deps.config.claude.concurrency,
					fillRetries: deps.config.think.fillRetries,
					repair: deps.config.think.repair,
					...(throttle ? { throttle } : {}),
					onProgress: log,
					onEvent: (event) => emit({ ...event, at: now() }),
				});
				throwIfCancelled(cancellation);
				result = thought;
				graph = thought.graph;
				thinkDegraded = [
					...(thought.degraded.graph ? ["graph"] : []),
					...thought.degraded.fills.map((id) => `fill:${id}`),
				];
				for (const [id, cause] of Object.entries(thought.degraded.causes ?? {}))
					degradedCauses[`fill:${id}`] = causeText(cause);
				if (thought.degraded.graphFailure !== undefined) {
					providerUnavailable = true;
					degradedCauses.graph = causeText(thought.degraded.graphFailure);
				}
				const total = `${graph.nodes.length} nodes`;
				if (thought.partial || thinkDegraded.length > 0)
					stage("think", "end", false, `${total} · ${thinkDegraded.join(", ") || "partial"}`);
				else stage("think", "end", true, total);
			} catch (error) {
				rethrowCancellation(error);
				const cause = causeText(error);
				log(`think failed: ${cause}`);
				thinkThrew = true;
				// Whatever the failing stage carried stays: the nodes it had filled are real work, the rest are marked.
				const partial = partialGraphOf(error);
				if (partial) {
					graph = partial;
					result = { ...result, xml: injectGraphXml(result.xml, partial) };
				}
				thinkDegraded = [
					...(partial && isFallbackGraph(partial) ? ["graph"] : []),
					...(partial?.nodes ?? [])
						.filter((node) => node.degraded === true || !node.conclusion?.trim())
						.map((node) => `fill:${node.id}`),
					"think",
				];
				degradedCauses.think = cause;
				stage("think", "end", false, cause);
			}
		}

		/** Answered clarifications from an earlier turn of this session survive; stale open ones are dropped. */
		let clarifications: Clarification[] = (
			readSession(deps.stateDir, sessionId)?.clarifications ?? []
		).filter((c) => c.answer && c.source !== "knowledge");

		// Always awaited once started (it honours the abort signal and never rejects) so the record says what happened.
		let knowledge: KnowledgeLookup | undefined;
		let knowledgeInput: { digest: string; docs: string[] } | undefined;
		if (session) {
			const read = await readKnowledge(session, knowledgeTopic(result, graph));
			throwIfCancelled(cancellation);
			const lookup = read.lookup;
			log(
				`greptile knowledge base: ${lookup.outcome}${lookup.docs.length > 0 ? ` · ${lookup.docs.join(", ")}` : ""}${lookup.reason ? ` · ${lookup.reason}` : ""} · ${lookup.ms}ms`,
			);
			stage(
				"knowledge",
				"end",
				lookup.outcome !== "error",
				lookup.outcome === "used" ? `${lookup.docs.length} docs` : lookup.outcome,
			);
			knowledge = { ...lookup, settled: 0 };
			if (lookup.outcome === "used") knowledgeInput = { digest: read.digest, docs: lookup.docs };
			if (lookup.outcome !== "off") {
				try {
					emitActivity({
						v: 1,
						kind: "resource",
						title: "Knowledge",
						source: "greptile",
						outcome: lookup.outcome,
						count: lookup.docs.length,
					});
				} catch {
					// reason: fail-open: the activity card is display only; a failed card never blocks planning
				}
			}
		}
		let clarifyFailed: string | undefined;
		if (hitlOn && !lifetime.aborted && providerUnavailable) {
			// The graph call exhausted its retries against a provider that answered with a failure: a clarify call would only
			// repeat it (three more completer calls), so the stage is recorded as skipped instead.
			clarifyFailed = CLARIFY_SKIPPED_CAUSE;
			log(`clarify ${CLARIFY_SKIPPED_CAUSE}`);
			stage("clarify", "end", false, CLARIFY_SKIPPED_CAUSE);
		} else if (hitlOn && !lifetime.aborted) {
			stage("clarify", "start");
			try {
				const outcome = await (deps.clarify ?? runClarify)({
					uplift: result,
					graph,
					conversation,
					answered: clarifications,
					complete,
					signal: lifetime,
					maxQuestions: deps.config.hitl.maxQuestions,
					onProgress: log,
					...(knowledgeInput ? { knowledge: knowledgeInput } : {}),
					// DP-KNOWLEDGE and DP-BLOCKING share the plan gate's runtime; every record lands in this prompt's list.
					decisions,
					onDecision: (decisionRecord) => records.push(decisionRecord),
				});
				throwIfCancelled(cancellation);
				const seen = new Set(clarifications.map((c) => normalizeQuestion(c.question)));
				const kept = outcome.items.filter((c) => !seen.has(normalizeQuestion(c.question)));
				clarifications = [...clarifications, ...kept];
				if (knowledge)
					knowledge = {
						...knowledge,
						settled: kept.filter((c) => c.source === "knowledge").length,
					};
				if (outcome.failed !== undefined) {
					// Leading items a cut-off reply still yielded are kept; the stage is not a success.
					clarifyFailed = causeText(outcome.failed);
					log(`clarify failed: ${clarifyFailed}`);
					stage("clarify", "end", false, clarifyFailed);
				} else
					stage(
						"clarify",
						"end",
						true,
						`${clarifications.length} question${clarifications.length === 1 ? "" : "s"}`,
					);
			} catch (error) {
				rethrowCancellation(error);
				clarifyFailed = causeText(error);
				log(`clarify failed: ${clarifyFailed}`);
				stage("clarify", "end", false, clarifyFailed);
			}
		}
		if (clarifyFailed !== undefined) degradedCauses.clarify = clarifyFailed;
		if (clarifications.length > 0) {
			result = { ...result, xml: injectClarificationsXml(result.xml, clarifications) };
		}

		let plan: TrackPlan | undefined;
		// Fail-open per design: a totally failed engine (conservative XML fallback) proceeds
		// untracked rather than creating generic FALLBACK_GRAPH boilerplate rows in the shared
		// Notion/Linear tracker on every engine outage. Only a real LLM uplift on a real graph is tracked: the boilerplate
		// graph (substituted when the model's graph is unusable) and a think stage that threw without a graph make no rows.
		const boilerplateGraph = graph ? isFallbackGraph(graph) : thinkThrew;
		if (result.source === "llm" && boilerplateGraph)
			log("track plan skipped: graph-fallback, no tracker rows");
		if (result.source === "llm" && !boilerplateGraph) {
			throwIfCancelled(cancellation);
			stage("plan", "start");
			try {
				plan = buildTrackPlan({
					uplift: result,
					graph,
					clarifications,
					repo: git.repo,
					branch: git.branch,
					graphId: deterministicGraphId(
						sessionId,
						result.original,
						graph,
						git.repo ?? resolve(cwd),
					),
					agent: deps.surface ?? "claude-code",
				});
				stage(
					"plan",
					"end",
					true,
					`${plan.linearIssues.length} issues · ${plan.linearSubIssues.length} steps`,
				);
			} catch (error) {
				log(`track plan failed: ${error instanceof Error ? error.message : String(error)}`);
				stage("plan", "end", false);
			}
		}

		// Read once: the record, the summary and the context all report the same first error.
		const engineError = deps.engineError?.();
		const engineFailover = deps.engineFailover?.();
		const degraded = [
			...(result.source === "fallback" ? ["uplift"] : []),
			...thinkDegraded,
			...(clarifyFailed !== undefined ? ["clarify"] : []),
		];
		const buildRecord = (current: UpliftResult, refs: TrackingRefs | undefined): SessionRecord => ({
			sessionId,
			at: now(),
			engine: deps.engine,
			...withResolution,
			...(engineError ? { engineError } : {}),
			...(engineFailover ? { engineFailover } : {}),
			...(degraded.length > 0 ? { degraded } : {}),
			host: deps.surface ?? "claude-code",
			result: current,
			graph,
			clarifications,
			plan,
			tracking: refs,
			...(skill
				? {
						skill: {
							name: skill.name,
							...(skill.summary ? { summary: skill.summary } : {}),
							source: skill.source,
						},
					}
				: {}),
			kickedOff: false,
			synced: false,
			...(knowledge ? { knowledge } : {}),
			...(lessons ? { lessons } : {}),
			...(docs ? { docs } : {}),
			...(skills ? { skills } : {}),
			...(records.length ? { decisions: records } : {}),
		});
		let record: SessionRecord = buildRecord(result, undefined);
		/** The state directory could not be written: `degraded` gains a `state` token and the record (when it is saved later) says so. */
		const markStateFailed = (cause: string): void => {
			if (!degraded.includes("state")) degraded.push("state");
			degradedCauses.state = cause;
			record = { ...record, degraded: [...degraded] };
		};
		let specPath: string | undefined;
		let statePath: string | undefined;
		let lastNote: string | undefined;
		/**
		 * Saves `record` (the JSON and XML saves share the session lock with the answers/ship/mark updates, so neither
		 * side can overwrite the other with stale content). A late answer merged at save time must reach the agent:
		 * `record` alone is not enough, since `result`/`clarifications` still hold the stale pre-save values, so the
		 * derived locals are refreshed, keeping reference equality when the merge changed nothing.
		 */
		const persist = (): void => {
			const saved = savePlanRecord(
				deps.stateDir,
				sessionId,
				record,
				log,
				deps.stateLock ?? HOOK_LOCK,
			);
			record = saved.record;
			if (
				saved.record.clarifications !== undefined &&
				saved.record.clarifications !== clarifications
			)
				clarifications = saved.record.clarifications;
			if (saved.record.result.xml !== result.xml)
				result = { ...result, xml: saved.record.result.xml };
			specPath = saved.specPath;
			statePath = saved.statePath;
			lastNote = saved.lastNote;
		};

		let tracking: TrackingRefs | undefined;
		let existing: TrackingRefs | undefined;
		let trackBlocked = false;
		if (plan && deps.track && !deps.trackingOff) {
			throwIfCancelled(cancellation);
			// Rows in the shared trackers are permanent: the record that points at them is saved first, so a kill while
			// they are being created leaves a readable record (spec and state paths). A resend that produces the same graph
			// gets the same graph id (the id is content-addressed, see `deterministicGraphId`) and adopts the rows instead of
			// creating them again; one that produces another graph gets another id and adopts none of them.
			const prior = readSession(deps.stateDir, sessionId);
			const priorRefs = prior?.tracking?.graphId === plan.graphId ? prior.tracking : undefined;
			// The adoption lookup runs only when the record already holds this graph id (a resend of the same graph, or a
			// saved record): a first-time plan makes no lookup call and never waits on one before it creates rows.
			const sameGraph = prior?.plan?.graphId === plan.graphId;
			existing = priorRefs ?? (sameGraph ? emptyTracking(plan.graphId, now()) : undefined);
			if (priorRefs) record = { ...record, tracking: priorRefs };
			try {
				persist();
			} catch (error) {
				const cause = causeText(error);
				log(`state write failed before tracking: ${cause}`);
				markStateFailed(cause);
				// Rows in the shared trackers are permanent and a resend adopts them only through a saved record: none are made.
				stage("track", "end", false, "skipped: state not writable");
				trackBlocked = true;
			}
		}
		if (plan && deps.track && !deps.trackingOff && !trackBlocked) {
			stage("track", "start");
			tracking = await deps
				.track({
					plan,
					graph,
					...(existing ? { existing } : {}),
					degradedNodes: thinkDegraded
						.filter((token) => token.startsWith("fill:"))
						.map((token) => token.slice("fill:".length)),
					signal: lifetime,
					progress: deps.progress,
					// Every created row is checkpointed into the record under its lock, merged over what it holds: a flight killed
					// between two rows keeps the refs made so far, and no later save loses them.
					onRef: (live) => {
						try {
							updateSession(
								deps.stateDir,
								sessionId,
								trackingCheckpoint(plan.graphId, live),
								deps.stateLock ?? HOOK_LOCK,
							);
						} catch (error) {
							log(
								`tracking checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
					},
				})
				.catch((error: unknown) => {
					rethrowCancellation(error);
					log(`tracking failed: ${error instanceof Error ? error.message : String(error)}`);
					return undefined;
				});
			throwIfCancelled(cancellation);
			if (tracking) {
				result = { ...result, xml: injectTrackingXml(result.xml, plan, tracking) };
				// A node whose fill is degraded is created with a "[degraded fill]" marker on its tracker rows.
				const notes = [
					...tracking.errors,
					...thinkDegraded
						.filter((token) => token.startsWith("fill:"))
						.map((token) => `degraded ${token}`),
				];
				log(`tracking ${tracking.status}${notes.length > 0 ? `: ${notes.join("; ")}` : ""}`);
				const issues = Object.keys(tracking.linear.nodes).length;
				stage(
					"track",
					"end",
					tracking.status !== "failed",
					`${tracking.status} · ${issues}/${plan.linearIssues.length} issues`,
				);
				record = buildRecord(result, tracking);
			} else {
				stage("track", "end", false);
				// A tracker that returned nothing may still have checkpointed rows: the record keeps them.
				const checkpointed = readSession(deps.stateDir, sessionId)?.tracking;
				if (checkpointed?.graphId === plan.graphId) record = { ...record, tracking: checkpointed };
			}
		}

		// No spec or session write for a cancelled flight.
		throwIfCancelled(cancellation);
		stage("state", "start");
		try {
			persist();
			stage("state", "end", true);
		} catch (error) {
			const cause = causeText(error);
			log(`state write failed: ${cause}`);
			markStateFailed(cause);
			stage("state", "end", false, cause);
		}
		// Opt-in retention (state.retentionDays above 0): at most one bounded sweep a day. It never throws and never waits.
		pruneSessionsBestEffort({
			stateDir: deps.stateDir,
			retentionDays: deps.config.state.retentionDays,
			log,
		});

		const providers = {
			linear: deps.config.linear.team.trim() !== "",
			notion: deps.config.notion.dataSourceUrl.trim() !== "",
		};
		const output: HookOutput = {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: formatPromptContext({
					result,
					engine: deps.engine,
					...withResolution,
					...(engineError ? { engineError } : {}),
					...(degraded.length > 0 ? { degraded, causes: degradedCauses } : {}),
					graph,
					clarifications,
					brief,
					...(realmNote ? { briefNote: realmNote } : {}),
					statePath,
					specPath,
					...(lastNote ? { lastNote } : {}),
					plan,
					tracking,
					trackCommand: deps.trackCommand,
					...(skill ? { skill: skill.name } : {}),
					ship: shipApplies(deps.config.ship, skill?.name),
					trackingOff: deps.trackingOff,
					providers,
					knowledge,
					lessons: lessonsText,
					docs: docsText,
					skills: skillsText,
					skillHints: deps.surface === "hermes",
					// No spec file (the write failed) means nothing to point at: fall back to the inline spec.
					handoff: deps.surface === "hermes" && specPath !== undefined,
				}),
			},
		};
		// One event, after every fallible step, for a plan that exists and whose record is on disk, in a session the
		// substrate can chain on: a skip, a fallback spec, a failed state write or a turn with no session id leaves nothing behind.
		// Bounded by the planning budget, and ahead of the summary so the elapsed time it shows includes the attempt.
		if (plan?.graphId && statePath && !isTurnSessionId(sessionId)) {
			await announcePlan(deps, {
				plan,
				sessionId,
				host: surfaceId,
				skill: skill?.name,
				repo: git.repo,
				branch: git.branch,
				signal: lifetime,
			});
		}
		// Taken only when the summary is shown: it marks the cause as warned, so a hidden summary must not spend it. An
		// intentionally disabled run (ULTRATHINK_DECISIONS=0) neither shows nor consumes a Jev failure warning.
		const jevWarning =
			deps.config.claude.echo && !decisionsKilled(deps.decisionsDeps?.env ?? process.env)
				? takeJevWarning(deps.stateDir, now())
				: undefined;
		if (deps.config.claude.echo) {
			const summary = formatSummary({
				result,
				engine: deps.engine,
				...withResolution,
				graph,
				clarifications,
				brief,
				tracked: Boolean(plan && statePath) && !deps.trackingOff,
				tracking,
				plan,
				...(skill ? { skill: skill.name } : {}),
				trackingOff: deps.trackingOff,
				providers,
				knowledge,
				lessons,
				docs,
				skills,
				...(engineError ? { engineError } : {}),
				...(jevWarning ? { jevWarning } : {}),
				...(engineFailover ? { engineFailover } : {}),
				elapsedMs: now() - started,
				decisions: records,
				degraded,
			});
			// The Substrate segment is echo-only and once per plan: this is the single place a summary is built.
			output.systemMessage = briefNotice ? `${summary} · ${briefNotice}` : summary;
		}
		outcome = "planned";
		return { output, record, ...(records.length ? { decisions: records } : {}) };
	} catch (error) {
		// A cancelled flight ends skipped, as planPrompt reports it; anything else stays a failure named by its error.
		if (cancellation.aborted) {
			outcome = "skipped";
			outcomeDetail = "aborted";
		} else outcomeDetail = error instanceof Error ? error.name : "error";
		throw error;
	} finally {
		session?.close();
		timers.clearTimeout(budget);
		emit({
			type: "end",
			at: now(),
			outcome,
			...(outcomeDetail ? { detail: outcomeDetail } : {}),
			...withResolution,
		});
	}
}
