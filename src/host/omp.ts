// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp extension. Planning runs in-process on the session's own live model: each flight snapshots the whole live Model
 * once, and every stage completes through the host's `completeSimple` with the host registry's auth resolver
 * (UT-Planning-ModelSelection 1.0.0 §7-§8). omp caps every handler at 30s and drops late results, but the planner takes
 * minutes. The cap (EXTENSION_HANDLER_TIMEOUT_MS = 30000 in the omp runner, omp 18.20.3) is paused while an extension
 * UI dialog (`ctx.ui.confirm`/`select`/`input`/`editor`/`custom`) is open, and a returned `{message}` only adds to a turn
 * that then starts: nothing `before_agent_start` returns can hold the turn. So with the CompletionGate on (default;
 * `ULTRATHINK_GATE=off` opts out) the turn never starts on a partial plan. After `raceMs` the handler holds inside a
 * confirm dialog, which pauses the cap, until the gate validated the whole plan (XML, graph, issue rows). A partial plan
 * is never released: its flight ends with a message that names what is missing. A host with no dialog (print, json, no
 * UI) cannot hold past the cap, so the turn gets an explicit stop message and the plan follows as an `aside`. With the
 * gate off the old race applies: a fast plan
 * inline, otherwise a pending note and a later `aside`. Each flight owns its own cancellation and outer time limit. A
 * tool result that opens a PR for a planned session gets an ultrathink-sync aside. `/ultrathink-<verb>` commands
 * toggle control state or send one unplanned message.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collapseWhitespace, isAbortError, isDirectory } from "../shared.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Effort,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { EnvironmentPort } from "../../core/src/ports/environment.ts";
import { createOmpCommandPort, type OmpCommandHandler } from "../../adapters/omp/commands.ts";
import type { ClockPort } from "../../core/src/ports/injection.ts";
import type { SyncFileSystemPort } from "../../core/src/ports/sync-filesystem.ts";
import type { ClaudeCompleter } from "../claude/complete.ts";
import {
	type ControlState,
	readControl,
	readSession,
	type SessionRecord,
	sessionRecordPath,
	OMP_LOCK,
	updateSession,
} from "../claude/state.ts";
import type { LockOptions } from "../claude/atomic.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import type { LegacyModelProvenance, UltrathinkConfig } from "../config.ts";
import { attachReport, type CompletionReport, readReport } from "../completion-report.ts";
import { TRUNCATED_REPLY } from "../types.ts";
import { redactSecrets } from "../redact.ts";
import {
	type FailureVerdict,
	isTransientFailure,
	parseRetryAfter,
	RetryExhaustedError,
	unwrapRetryError,
	withRetry,
} from "../resilience/retry.ts";
import { abortableSleep } from "../resilience/sleep.ts";
import { FlightThrottle } from "../resilience/throttle.ts";
import { DEFAULT_GROK_CONFIG } from "../grok/types.ts";
import { runExplicitRecall } from "../recall/explicit.ts";
import type { RecallSettings } from "../recall/config.ts";
import {
	createRecallState,
	planRecall,
	type RecallEvent,
	type RecallLookups,
	type RecallPlan,
	type RecallRuntimeState,
} from "../recall/engine.ts";
import { createFailureState, recordFailure, resetTurn } from "../recall/gates.ts";
import { recallMoments } from "../recall/moments.ts";
import { status as authStatus } from "../mcp/oauth.ts";
import { storePath } from "../mcp/store.ts";
import {
	allLaneDirs,
	createGreptileKnowledge,
	digestFromAgentMessages,
	filterSpawnable,
	formatLaneHandles,
	formatLaneStatusText,
	isSdlcPrompt,
	laneDirs,
	laneStatus,
	lessonsLookup,
	maxLanes,
	orchStatusRunner,
	parseLaneArgs,
	pidAlive,
	planLanes,
	projectOf,
	readActivity,
	recallLessons,
	recallSkills,
	resolvePstack,
	resolveStopTargets,
	resolveSwarmRoot,
	runSkillsCommand,
	shipApplies,
	shipNudge,
	shipPrecheck,
	skillsLookup,
	spawnGuarded,
	spawnLanes,
	spawnObserveDetached,
	stopLanes,
	swarmClassifier,
	swarmRootMessage,
	TEAMS_USAGE,
	teachContext,
	teachEnabled,
	toSwarmSpawnCard,
	toSwarmStatusCard,
	writeShip,
	type KnowledgeLookup,
	type KnowledgeReader,
	type LaneClassify,
	type LaneHandle,
	type LanePlan,
	type LessonsLookup,
	type ShipConfig,
	type SkillKey,
	type SkillsLookup,
	type TeachContext,
} from "./omp-lanes.ts";
import { extractPrFromOutput, isPrCreationTool } from "../track/pr-detect.ts";
import { resolveRepoSlug } from "../track/git.ts";
import { runControl, type UltrathinkVerb } from "../uplift/commands.ts";
import {
	type ModelResolution,
	type NativeEngineSelector,
	type NativeModelQuery,
	selectNativeEngine,
} from "./engine.ts";
import {
	type BarState,
	type BarStore,
	createBarComponent,
	createBarStore,
	parseSubstrateStatus,
	parseTokenSavings,
} from "./omp-ui.ts";
import {
	ACTIVITY_DELIVERY,
	ACTIVITY_TYPE,
	activityFallbackLine,
	PENDING_TYPE,
	PLAN_TYPE,
	RECALL_TYPE,
	registerUltrathinkRenderers,
	SHIP_TYPE,
	SYNC_TYPE,
} from "./omp-render.ts";
import {
	CompletionGate,
	DEFAULT_GATE_INACTIVITY_MS,
	type GateExpected,
} from "./completion-gate.ts";
import { resolveStateDir } from "./paths.ts";
import type { PrdOutcome } from "../think/tot/stage.ts";
import { planPrompt, wouldSkipPlanning, type PlanResponse } from "./plan.ts";
import { claimPlan, loadPlan, planKey, savePlan } from "./plan-store.ts";
import type { ProgressEvent } from "./progress.ts";
import { toActivityNotice } from "./activity-notice.ts";
import {
	confirmInsightLesson,
	installInsightSkill,
	previewInsightSkill,
	type InsightActionRuntime,
} from "./omp-insight-actions.ts";
import {
	createInsightDashboard,
	type InsightDashboardCallbacks,
	type InsightPanel,
} from "./omp-dashboard.ts";
import type {
	InsightActionResult,
	InsightScope,
	InsightSnapshot,
	LessonSelection,
	SkillPreview,
} from "./omp-insights.ts";
import { formatInsightText, readInsightSnapshot, toInsightCardSnapshot } from "./omp-insights.ts";
import { paint, truncateToWidth } from "./omp-paint.ts";
import { INSIGHT_TYPE, SWARM_TYPE } from "./omp-render.ts";
import { type PlanView, projectResolution } from "./view.ts";
import {
	installKillCheckpoint,
	pauseSessionPhases,
	type PhaseReport,
	type PhaseSession,
	recordGsdPhase,
	restoreSessionPhases,
} from "./omp-phase.ts";

interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: unknown[];
	systemPrompt: string[];
}

/** Omp's `tool_result` payload, trimmed to what PR sync reads. */
interface ToolResultEvent {
	type: "tool_result";
	toolName: string;
	input: Record<string, unknown>;
	content: { type: string; text?: string }[];
	isError: boolean;
}

interface TuiLike {
	requestRender(): void;
	terminal?: { rows?: number };
}

type WidgetFactory = (tui: TuiLike, theme: unknown) => { render(width: number): readonly string[] };

interface ExtensionUI {
	setWidget?(
		key: string,
		content: WidgetFactory | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
	/** Modal yes/no; omp pauses the handler's 30s cap while it is open. The signal dismisses it. */
	confirm?(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
	/**
	 * Structural `ui.custom`: public factory order tui/theme/keybindings/done with optional signal.
	 * Absent on non-TUI/RPC hosts. No host runtime import: the dashboard component shape is structural.
	 */
	custom?<T>(
		factory: (
			tui: InsightTui,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => InsightComponent | Promise<InsightComponent>,
		options?: InsightCustomOptions,
	): Promise<T>;
}

/** Structural `TUI` subset the insight dashboard needs: redraw requests plus optional viewport size. */
interface InsightTui {
	requestRender(): void;
	terminal?: { rows?: number; columns?: number };
}

/** Structural custom component matching the frozen dashboard return; terminal input stays opaque bytes. */
interface InsightComponent {
	render(width: number): readonly string[];
	invalidate(): void;
	handleInput(data: unknown): void;
	dispose(): void;
}

/** Structural subset of Omp's public `ExtensionCustomOptions`: abort the custom UI and reject its promise. */
interface InsightCustomOptions {
	overlay?: boolean;
	signal?: AbortSignal;
}

/**
 * The host capabilities native planning uses, in the published `ExtensionContext` shapes (`ctx.models`,
 * `ctx.modelRegistry`). In-process only: never serialized, never handed to a child process.
 */
export interface OmpNativeRuntime {
	/** `ctx.models`: `current()` reads the live session model lazily; `resolve()` resolves through authenticated availability. */
	models: { current(): Model<Api> | undefined; resolve(spec: string): Model<Api> | undefined };
	/** `ctx.modelRegistry.resolver`: the host's auth-retry policy bound to one Model and session, passed as the request key. */
	modelRegistry: { resolver(model: Model<Api>, sessionId?: string): SimpleStreamOptions["apiKey"] };
}

interface ExtensionContext {
	cwd: string;
	sessionManager: {
		getSessionId(): string;
		getSessionFile?(): string | undefined;
		getHeader?(): { parentSession?: string } | null;
	};
	hasUI?: boolean;
	mode?: string;
	ui?: ExtensionUI;
	setInterval?(callback: () => void, ms: number): unknown;
	/** The live session Model (a host getter); it wins over `models.current()` when both exist (D-01). */
	model?: Model<Api>;
	models?: OmpNativeRuntime["models"];
	modelRegistry?: OmpNativeRuntime["modelRegistry"];
}

interface CustomMessage {
	customType?: string;
	content?: string;
	display?: boolean;
	details?: unknown;
	attribution?: "user" | "agent";
}

interface BeforeAgentStartResult {
	message?: string | CustomMessage;
}

type LifecycleEvent =
	| "session_start"
	| "session_switch"
	| "session_shutdown"
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "tool_execution_start"
	| "tool_execution_end";

/** Omp's public ThinkingLevel shape, using the provider's effort type without loading the agent runtime. */
type SessionThinkingLevel = Effort | "off" | "inherit";

/** The default ceiling on the provider reasoning of a planning stage call. "inherit" keeps the session's own level, uncapped;
 * `think.reasoningCeiling` lowers it on purpose, and a lower session level is always kept. */
export const PLANNING_REASONING_CEILING: Effort | "inherit" = "inherit";
const EFFORT_ORDER: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The session's effort, lowered to the ceiling when above it; an effort outside the known order is passed through. */
function cappedEffort(level: Effort, ceiling: Effort | "inherit"): Effort {
	if (ceiling === "inherit") return level;
	const have = EFFORT_ORDER.indexOf(level);
	const cap = EFFORT_ORDER.indexOf(ceiling);
	return have > cap && cap >= 0 ? ceiling : level;
}

export interface ExtensionAPI {
	on(
		event: "before_agent_start",
		handler: (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		) => Promise<BeforeAgentStartResult | void>,
	): void;
	on(event: LifecycleEvent, handler: (event: unknown, ctx: ExtensionContext) => void): void;
	/** Returning undefined keeps the user's input unchanged. */
	on(event: "input", handler: (event: unknown, ctx: ExtensionContext) => undefined): void;
	/** Returning undefined keeps the tool result unchanged. */
	on(
		event: "tool_result",
		handler: (event: ToolResultEvent, ctx: ExtensionContext) => undefined,
	): void;
	sendMessage(
		message: CustomMessage,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void;
	/** Starts a turn when idle; the message runs through `before_agent_start` like typed input. */
	sendUserMessage?(content: string): void;
	/** Optional for older hosts; a native flight snapshots this session setting once (AD-5). */
	getThinkingLevel?(): SessionThinkingLevel | undefined;
	/** Omp matches `/name args` on the first space against registered names. */
	registerCommand?(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (
				argumentPrefix: string,
			) => { value: string; label: string; description?: string }[] | null;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		},
	): void;
	registerMessageRenderer?: Parameters<
		typeof registerUltrathinkRenderers
	>[0]["registerMessageRenderer"];
	/** Omp's shared event bus, absent on older hosts; handlers run synchronously inside `emit`. */
	events?: {
		emit(channel: string, data: unknown): void;
		on(channel: string, handler: (data: unknown) => void): () => void;
	};
}

export interface OmpPlanRequest {
	prompt: string;
	cwd: string;
	sessionId: string;
	/** Receives the uplift-only context once the uplift is final, before the graph; the flight's early delivery uses it. */
	onUplift?: (handoff: { context: string }) => void;
	/** The flight's one whole live Model snapshot (D-01); the target every native stage of the flight uses when detected. */
	model?: Model<Api>;
	/** Where the live Model was observed: `ctx.model`, else `ctx.models.current()`. */
	modelSource?: "ctx.model" | "ctx.models.current";
	/** In-process host capabilities; absent means native planning is unavailable, never a fabricated fallback. */
	native?: OmpNativeRuntime;
	/** Captured session thinking level for every native stage; absent/inherit leaves provider options unset. */
	thinkingLevel?: SessionThinkingLevel;
	/** This flight's captured config, control and state directory, used as given. */
	config?: UltrathinkConfig;
	control?: ControlState;
	stateDir?: string;
	/** Flight validity, checked before and after every native call; false cancels the call. Never a model chooser. */
	isCurrent?: () => boolean;
	/** Absolute flight limit (ms since the epoch); a transient retry never waits past it. */
	deadline?: number;
}

export interface OmpPlan {
	context: string;
	view?: PlanView;
	/** Tree-of-Thought PRD outcome the completion gate reads; absent when the stage did not run. */
	prd?: PrdOutcome;
	/** The safe selection record (§9) for display and `/ultrathink-status`; never the Model. */
	modelResolution?: ModelResolution;
	/** Stable skip code when nothing was planned, including an unresolved selection. */
	skipped?: string;
	summary?: string;
}

export type OmpPlanner = (
	request: OmpPlanRequest,
	signal: AbortSignal,
	onEvent?: (event: ProgressEvent) => void,
) => Promise<OmpPlan>;

/** `completeSimple` from `@oh-my-pi/pi-ai`, in the one call shape the native adapter makes. */
export type CompleteSimple = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

/** Test seams of the native binding; production loads both lazily from the host-remapped packages. */
export interface NativeEngineDeps {
	completeSimple?: CompleteSimple;
	/** Catalog injection: provider id -> default model id, as `DEFAULT_MODEL_PER_PROVIDER`. */
	providerDefaults?: Readonly<Record<string, string>>;
	/** Flight validity, not a model chooser: false before or after a native call cancels it. */
	isCurrent?: () => boolean;
	/** Backoff and cooldown wait: resolves after `ms`, or ends at once when the signal aborts. Tests inject an instant one. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Jitter source in [0, 1) for the retry backoff; tests pin it. */
	random?: () => number;
	/** Clock of the retry classifier and the flight limiter's cooldown; tests inject one their instant sleep advances. */
	now?: () => number;
	/** Most concurrent native calls of one flight; never above 3 on Omp. Default 3. */
	maxConcurrency?: number;
	/** Highest reasoning effort a planning call uses; default `PLANNING_REASONING_CEILING`. "inherit" leaves the session level alone. */
	reasoningCeiling?: Effort | "inherit";
	/**
	 * The flight's limiter. Absent, the binding creates it and writes it back here; the selection carries it as
	 * `SelectedEngine.throttle`, which tells the planner this flight already has its one limiter (the think stage builds none).
	 */
	throttle?: FlightThrottle;
}

type McpState = NonNullable<BarState["mcp"]>;

export const PENDING =
	"Ultrathink is still planning this prompt. If planning finishes while this request is still current, its result arrives as a separate message at a subsequent step boundary. Until then, read and investigate only: no edits and no mutating commands. If a note says planning produced nothing, proceed with the user's request as written.";

/** Gate hold for a host that cannot hold the turn (no dialog): the strongest thing a handler can return is an explicit stop-and-confirm. */
export const GATE_HOLD =
	"STOP. Ultrathink has not finished planning this prompt, so this session is on hold. Do not call any tool, edit any file or run any command, and do not act on the request. Tell the user that planning is still running and that the complete plan (uplifted prompt, graph of thought and issues) arrives as a separate message when it is done; they can run /ultrathink-quick <message> to continue without a plan. Then wait for that message.";

/** Gate hold for a finished plan that is incomplete (`usable`) or unusable; `detail` says what is wrong. */
export const gateHoldPartial = (detail: string, usable: boolean): string =>
	`STOP. Ultrathink finished planning but the plan is ${usable ? "incomplete" : "unusable"}: ${detail}. Nothing from it was released, so the session did not start on it. Do not call any tool, edit any file or run any command, and do not act on the request. Tell the user what is missing from the plan and ask them to resend the prompt to plan again, or to run /ultrathink-quick <message> to continue without a plan.`;

/** Gate hold while waiting_for_plan: Ultrathink waits; a late valid Plan auto-resumes and is used automatically. */
export const GATE_WAITING =
	"STOP. Ultrathink is waiting for the phase Plan: it is missing, stale, unparseable or failing the checklist (objective, scope, named surfaces, acceptance, out-of-scope, dependencies, ordering, referenced Linear issues, ROADMAP). Do not act yet. Bounded polling is running; when a valid Plan lands it is hashed and used automatically as execution context (no manual restart).";
/** Gate hold once bounded polling is exhausted (`gate.blocked`): names the block reason; polling has stopped and a valid Plan no longer auto-resumes until reset/manual action. */
export const gateWaitingBlocked = (blockReason: string): string =>
	`STOP. Ultrathink is waiting for the phase Plan: it is missing, stale, unparseable or failing the checklist (objective, scope, named surfaces, acceptance, out-of-scope, dependencies, ordering, referenced Linear issues, ROADMAP). Do not act yet. Polling has stopped (blocked): ${blockReason}. A late valid Plan will not be hashed and used automatically; valid Plan auto-resume is unavailable until the gate is reset or you act manually (for example re-send the prompt to plan again).`;

/** The inactivity watchdog ended planning: shown loudly, and the request continues as written. */
export const gateStalled = (reason: string): string =>
	`Ultrathink stopped planning: ${reason}. Continue with the user's request as written.`;

export const NO_PLAN =
	"Ultrathink planning produced no plan. Continue with the user's request as written.";

/** The uplift never reached the model: the prompt runs without it, and the user is asked to re-send it to plan again. */
export const planFailedNotice = (reason: string): string =>
	`Ultrathink's uplift did not complete (${reason}). This prompt runs without it: continue with the user's request as written, and tell the user to re-send the prompt to plan again.`;

/** A failure's message, redacted and capped before it reaches the model-facing text. */
const errorText = (error: unknown): string =>
	redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);

/** Store outcomes that a recovery cannot use: the notice says so, and the stored plan is not re-delivered. */
const STORE_UNREADABLE =
	"Ultrathink could not read the stored plan for this prompt, so it is not re-delivered.";
const STORE_UNWRITABLE =
	"Ultrathink could not mark the stored plan as delivered, so it is not re-delivered.";

/**
 * Deliberate planner skips. `precheck-*` reasons are the uplift policy's own decisions; the rest are the user's intent
 * (a command or slash command, an empty prompt, an abort, a skill that owns the prompt, a nested child) or a child,
 * disabled or cron run. Every other skip (native-unavailable, engine-error, unsupported-host, any engine skip) is a
 * planning failure: announced and retried once.
 */
const DELIBERATE_SKIP_REASONS: Record<string, true> = {
	"child-or-disabled": true,
	"parent-session": true,
	cron: true,
	empty: true,
	"ultrathink-command": true,
	"slash-command": true,
	"ultrathink-skill": true,
	"nested-child": true,
	"skill-preamble": true,
	aborted: true,
};
const deliberateSkip = (reason: string | undefined): boolean =>
	reason !== undefined &&
	(reason.startsWith("precheck-") || DELIBERATE_SKIP_REASONS[reason] === true);

/** Sent after an inline uplift when the rest of the plan could not be built: the uplift stands, so the model goes on with it. */
export const EARLY_RELEASE =
	"Planning could not finish the rest of the plan; continue with the uplifted prompt above.";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A cancellation as every planning boundary classifies it (the hook's convention): name `AbortError`. */
function cancelled(): Error {
	const error = new Error("Ultrathink planning was cancelled");
	error.name = "AbortError";
	return error;
}

/** A native completion failure with a static, bounded public message; an upstream rejection stays a private, non-enumerable cause. */
function nativeFailure(message: string, cause?: unknown): Error {
	const error = cause === undefined ? new Error(message) : new Error(message, { cause });
	error.name = "NativeCompletionError";
	return error;
}

function isModel(value: unknown): value is Model<Api> {
	return (
		typeof value === "object" &&
		value !== null &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"id" in value &&
		typeof value.id === "string"
	);
}

/**
 * One copy of a host Model for a flight (§8): `structuredClone` of its data, as the published registry copies models,
 * with the request-time `resolveHeaders` capability reattached. Never a JSON round trip, never a mutation of the host
 * object, never persisted. A Model carrying another callable cannot be cloned and fails visibly instead of losing it.
 */
function snapshotModel(model: Model<Api>): Model<Api> {
	const { resolveHeaders, ...data } = model;
	// structuredClone keeps the data's own shape; the cast restores the Model type so the capability can be reattached.
	const snapshot = structuredClone(data) as Model<Api>;
	if (resolveHeaders) snapshot.resolveHeaders = resolveHeaders;
	return snapshot;
}

/** Caps of the extension's per-session memory; the oldest entry goes first. */
const TURNS_CAP = 200;
const RESOLUTIONS_CAP = 100;
const SYNCED_PRS_CAP = 500;
const NUDGED_GRAPHS_CAP = 1000;

/** Sets `key` as the newest entry and evicts the oldest ones past `cap`. */
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
	map.delete(key);
	map.set(key, value);
	for (const oldest of map.keys()) {
		if (map.size <= cap) break;
		map.delete(oldest);
	}
}

/** Recall state the host keeps per session (SPE-34394): the planner's runtime state, the repository of the last turn that recalled, and the chain of its recall steps. */
interface RecallSession {
	runtime: RecallRuntimeState;
	/** The repository of the last turn seen while recall was on; undefined before the first one. */
	scope?: string;
	/** Settles after the last step, so the next step plans from the state that step left. */
	chain: Promise<void>;
}

const RECALL_SESSIONS_CAP = 200;
/** The planner's failure window: the largest windowed cooldown, capped at one day (`MAX_PRUNE_AGE_MS` in engine.ts). */
const FAILURE_WINDOW_CAP_MS = 86_400_000;

/**
 * A trigger may inject only when the master switch, its trigger flag and the injection flag (`panels.informationPanels`)
 * are all on. Otherwise it does nothing: nothing is fetched, planned, injected or stored.
 */
function recallInjects(settings: RecallSettings, trigger: RecallEvent["trigger"]): boolean {
	return (
		settings.recall.enabled &&
		settings.recall.triggers[trigger] &&
		settings.panels.informationPanels
	);
}

/** The window the planner counts failure occurrences in. */
function failureWindowMs(settings: RecallSettings): number {
	const { cooldownMs } = settings.recall;
	return Math.min(
		Math.max(cooldownMs.scopeChange, cooldownMs.failure, cooldownMs.uncertainty),
		FAILURE_WINDOW_CAP_MS,
	);
}

/**
 * Runs one lookup bounded by `ms`. A rejection or a timeout becomes the failed lookup `failed` builds, with its reason, so
 * the other sources' results survive a slow one. A source without a fetcher resolves to undefined.
 */
async function boundedLookup<T>(
	run: () => Promise<T> | undefined,
	failed: (reason: string) => T,
	ms: number,
): Promise<T | undefined> {
	const { promise: expired, resolve: expire } = Promise.withResolvers<T>();
	const timer = setTimeout(() => expire(failed("timeout")), ms);
	try {
		return await Promise.race([Promise.resolve().then(run), expired]);
	} catch (error) {
		return failed(error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timer);
	}
}

const failedKnowledge = (reason: string): KnowledgeLookup => ({
	outcome: "error",
	docs: [],
	chars: 0,
	ms: 0,
	reason,
});
const failedLessons = (reason: string): LessonsLookup => ({
	outcome: "error",
	count: 0,
	ids: [],
	chars: 0,
	ms: 0,
	source: "none",
	reason,
});
const failedSkills = (reason: string): SkillsLookup => ({
	outcome: "error",
	count: 0,
	names: [],
	rows: [],
	chars: 0,
	ms: 0,
	reason,
});

function boundedAdd<T>(set: Set<T>, value: T, cap: number): void {
	set.delete(value);
	set.add(value);
	for (const oldest of set) {
		if (set.size <= cap) break;
		set.delete(oldest);
	}
}

const MAX_COMPARE_DEPTH = 32;

/**
 * Private in-memory comparison of whole Model data (§8 reentry): plain data structurally, callables such as
 * `resolveHeaders` by identity, an undefined field the same as an absent one. Never logged, hashed or persisted.
 */
function sameData(a: unknown, b: unknown, depth = 0): boolean {
	if (Object.is(a, b)) return true;
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null ||
		depth > MAX_COMPARE_DEPTH
	)
		return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (a instanceof Date || b instanceof Date)
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	if (a instanceof Map || b instanceof Map) {
		if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
		for (const [key, value] of a)
			if (!b.has(key) || !sameData(value, b.get(key), depth + 1)) return false;
		return true;
	}
	if (a instanceof Set || b instanceof Set) {
		if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
		for (const value of a) if (!b.has(value)) return false;
		return true;
	}
	// Both are non-null, non-array-or-both objects here; their own enumerable fields are compared below.
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left).filter((key) => left[key] !== undefined);
	if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length)
		return false;
	return keys.every(
		(key) => Object.hasOwn(right, key) && sameData(left[key], right[key], depth + 1),
	);
}

/**
 * Whether a Model can serve native planning now. Authenticated availability comes from the query facade itself, which
 * resolves only available models: the exact `provider/id` reference must return that same provider and id.
 */
function classify(
	models: OmpNativeRuntime["models"],
	model: Model<Api>,
): "usable" | "unavailable" | "unsupported" {
	// Only isolated chat/text planning is supported: a role-specific runner kind (no kind means chat) or text-less input is not.
	if (
		(model.kind !== undefined && model.kind !== "chat") ||
		(Array.isArray(model.input) && !model.input.includes("text"))
	)
		return "unsupported";
	try {
		const available = models.resolve(`${model.provider}/${model.id}`);
		return isModel(available) && available.provider === model.provider && available.id === model.id
			? "usable"
			: "unavailable";
	} catch {
		return "unavailable";
	}
}

/**
 * `ctx.models.resolve` takes one spec, so a bare id is qualified to the required provider at this host boundary. Role
 * aliases (`@role`, legacy `pi/role`) and specs already qualified with that provider pass unchanged; nothing is
 * lowercased, truncated or reconstructed.
 */
function qualify(selector: string, provider: string | undefined): string {
	if (
		!provider ||
		selector.startsWith("@") ||
		selector.startsWith("pi/") ||
		selector.startsWith(`${provider}/`)
	)
		return selector;
	return `${provider}/${selector}`;
}

/** Own-property lookup only: an inherited or non-string entry is no mapping. */
function ownString(
	table: Readonly<Record<string, unknown>> | undefined,
	key: string,
): string | undefined {
	const value = table && Object.hasOwn(table, key) ? table[key] : undefined;
	return typeof value === "string" ? value : undefined;
}

/**
 * The host catalog's provider defaults. A dynamic import with a literal specifier, because a static one would load the
 * host package when the extension loads and in every test run, while it exists only inside Omp (whose loader remaps the
 * literal specifier to its bundled copy, D-03) or after `bun install`.
 */
async function loadProviderDefaults(): Promise<Readonly<Record<string, unknown>> | undefined> {
	try {
		const catalog = await import("@oh-my-pi/pi-catalog/provider-models");
		const table: unknown = catalog.DEFAULT_MODEL_PER_PROVIDER;
		return typeof table === "object" && table !== null
			? (table as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		// A missing export disables only the catalog tier; live and configured resolution stay available.
		return undefined;
	}
}

/** Only `type: "text"` blocks, in order, with no invented separator; thinking, tool and image blocks never become plan text. */
function textOf(result: AssistantMessage): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("");
}

/** A usable HTTP status (100-599) or nothing: only a real status names a retryable or permanent provider failure. */
function httpStatusCode(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
		? value
		: undefined;
}

function httpStatus(result: AssistantMessage): string {
	const status = httpStatusCode(result?.errorStatus);
	return status === undefined ? "" : `, HTTP ${status}`;
}

/** A thrown provider error's HTTP status (`status`, or `statusCode`), when it carries one. */
function thrownStatus(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
	return httpStatusCode(status) ?? httpStatusCode(statusCode);
}

/** Same-model retry of the native completer: three attempts, backoff 2 s then up to 8 s with full jitter and Retry-After. */
const RETRY_POLICY = { maxAttempts: 3, baseMs: 2000, capMs: 8000 } as const;

/** The pi-ai error classifier, loaded lazily with the catalog (D-03); absent means errorId-less classification only. */
interface ErrorFlags {
	Flag: Readonly<Record<string, number>>;
	is(id: number | undefined, flag: number): boolean;
	retriable(id: number | undefined): boolean;
}
let errorFlags: ErrorFlags | undefined;

// A literal dynamic specifier, as for the catalog (D-03): the host package exists only inside Omp (its loader remaps the
// specifier) or after `bun install`, so a static import would load it in every test run and at extension load.
async function loadErrorFlags(): Promise<void> {
	if (errorFlags) return;
	try {
		const flags = await import("@oh-my-pi/pi-ai/error");
		errorFlags = { Flag: flags.Flag, is: flags.is, retriable: flags.retriable };
	} catch {
		// reason: without the host's error flags the kernel's status and text classification still applies
	}
}

/** The redacted failure detail of each attempt's error; private to this module, never enumerable on the error. */
const FAILURE_DETAIL = new WeakMap<object, string>();

/** Raised from `onRetry` when the next backoff would cross the flight deadline; the last attempt's failure is then final. */
class DeadlineStop extends Error {
	readonly attempt: number;
	constructor(attempt: number) {
		super("retry would cross the flight deadline");
		this.name = "DeadlineStop";
		this.attempt = attempt;
	}
}

/** The server's `Retry-After` from a response's headers, as milliseconds, or nothing. */
function retryAfterOf(headers: Record<string, string> | undefined): number | undefined {
	if (!headers || typeof headers !== "object") return undefined;
	const key = Object.keys(headers).find((name) => name.toLowerCase() === "retry-after");
	return key === undefined ? undefined : parseRetryAfter(headers[key]);
}

/** The raw fields the kernel classifier reads, placed on an attempt's error as own properties. */
function withFields(
	error: Error,
	fields: { status?: number; retryAfterMs?: number; errorId?: number },
	detail: string,
): Error {
	if (fields.status !== undefined) Object.assign(error, { errorStatus: fields.status });
	if (fields.retryAfterMs !== undefined)
		Object.assign(error, { retryAfterMs: fields.retryAfterMs });
	if (fields.errorId !== undefined) Object.assign(error, { errorId: fields.errorId });
	if (detail) FAILURE_DETAIL.set(error, detail);
	return error;
}

/** A provider call that rejected: the static public message, the upstream error as private cause. */
function thrownFailure(error: unknown, retryAfterMs: number | undefined): Error {
	const text = error instanceof Error ? `${error.name} ${error.message}` : "";
	const errorId =
		typeof error === "object" &&
		error !== null &&
		"errorId" in error &&
		typeof error.errorId === "number"
			? error.errorId
			: undefined;
	return withFields(
		nativeFailure("omp-native completion failed", error),
		{ status: thrownStatus(error), retryAfterMs, errorId },
		collapseWhitespace(redactSecrets(text)).slice(0, 200),
	);
}

/** A resolved `stopReason: "error"` reply: safe public message, the redacted provider text as private cause. */
function resultFailure(result: AssistantMessage, retryAfterMs: number | undefined): Error {
	const detail = collapseWhitespace(redactSecrets(result.errorMessage ?? "")).slice(0, 200);
	return withFields(
		nativeFailure(
			`omp-native completion failed (provider error${httpStatus(result)})`,
			detail || undefined,
		),
		{
			status: httpStatusCode(result.errorStatus),
			retryAfterMs,
			errorId: typeof result.errorId === "number" ? result.errorId : undefined,
		},
		detail,
	);
}

/** A reply the model cut off at its token limit: a failed, retryable attempt whose report cause is `truncated_reply`. */
function truncatedFailure(): Error {
	const error = nativeFailure("omp-native completion failed (truncated reply)", TRUNCATED_REPLY);
	attachReport(error, { attempts: 1, cause: TRUNCATED_REPLY });
	return error;
}

/**
 * Whether another attempt can help. A pi-ai `errorId` decides first, like its own oneshot retry: Transient, UsageLimit or a
 * retriable kind retries, ContentBlocked, ContextOverflow, PayloadRejected and AuthFailed never do. Otherwise the kernel's
 * status-led verdict on the raw fields (a 503 with refusal-sounding text still retries; only a 429 is vetoed by it).
 */
function classifyNativeFailure(error: unknown, now: number = SYSTEM_CLOCK.now()): FailureVerdict {
	if (isAbortError(error)) return { transient: false, reason: "aborted" };
	if (readReport(error)?.cause === TRUNCATED_REPLY)
		return { transient: true, reason: TRUNCATED_REPLY };
	const own = typeof error === "object" && error !== null ? error : undefined;
	const status =
		own && "errorStatus" in own && typeof own.errorStatus === "number"
			? own.errorStatus
			: own && "status" in own && typeof own.status === "number"
				? own.status
				: undefined;
	const hint =
		own && "retryAfterMs" in own && typeof own.retryAfterMs === "number"
			? { retryAfterMs: own.retryAfterMs }
			: {};
	const message = (own && FAILURE_DETAIL.get(own)) ?? (error instanceof Error ? error.message : "");
	const base = isTransientFailure(
		{ ...(status === undefined ? {} : { status }), ...hint, message },
		now,
	);
	const id = own && "errorId" in own && typeof own.errorId === "number" ? own.errorId : undefined;
	const flags = errorFlags;
	if (id === undefined || !flags) return base;
	const { Flag, is } = flags;
	const refused =
		is(id, Flag.ContentBlocked ?? 0) ||
		is(id, Flag.ContextOverflow ?? 0) ||
		is(id, Flag.PayloadRejected ?? 0) ||
		is(id, Flag.AuthFailed ?? 0);
	if (refused) return { ...base, transient: false, reason: "errorId is a permanent refusal" };
	if (is(id, Flag.Transient ?? 0) || is(id, Flag.UsageLimit ?? 0) || flags.retriable(id))
		return { ...base, transient: true, reason: "errorId is transient" };
	return base;
}

/** The final report of a failed call: attempts, HTTP status, the server's hint and the redacted one-line cause. */
function failureReport(root: unknown, attempts: number): CompletionReport {
	if (readReport(root)?.cause === TRUNCATED_REPLY) return { attempts, cause: TRUNCATED_REPLY };
	const own = typeof root === "object" && root !== null ? root : undefined;
	const status =
		own && "errorStatus" in own && typeof own.errorStatus === "number"
			? own.errorStatus
			: undefined;
	const retryAfterMs =
		own && "retryAfterMs" in own && typeof own.retryAfterMs === "number"
			? own.retryAfterMs
			: undefined;
	const cause = own ? FAILURE_DETAIL.get(own) : undefined;
	return {
		attempts,
		...(status === undefined ? {} : { httpStatus: status }),
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		...(cause ? { cause } : {}),
	};
}

/**
 * The native binding's `NativeEngineSelector` (D-01, D-02, D-06): the shared policy `selectNativeEngine` decides from the
 * flight's live Model snapshot and the host query, and the one chosen whole Model is bound once per flight. Every stage
 * then completes through `completeSimple` with one system prompt, one timestamped user message, no tools, no per-call
 * headers, the registry resolver for that snapshot and session as the key, and the flight combined with the stage
 * signal. Only text blocks become plan text; `error` is a safe classified failure and `aborted` or an aborted lifetime
 * is an `AbortError`.
 */
export function createNativeEngineSelector(
	request: OmpPlanRequest,
	flightSignal: AbortSignal,
	deps: NativeEngineDeps = {},
): NativeEngineSelector {
	// Match Omp's toReasoningEffort/shouldDisableReasoning convention, once for this native binding.
	const level = request.thinkingLevel;
	// The chain of thought is written out explicitly, and its depth follows the reasoning level the session chose. A ceiling is
	// opt-in (think.reasoningCeiling): a lower level makes each of the ~15 stage calls shallower. "inherit" uses the host's default.
	const ceiling = deps.reasoningCeiling ?? PLANNING_REASONING_CEILING;
	/** The attempt clock: the injected `deps.now`, else the real clock. */
	const now = (): number => deps.now?.() ?? SYSTEM_CLOCK.now();
	const thinking: Pick<SimpleStreamOptions, "reasoning" | "disableReasoning"> =
		level === "off"
			? { disableReasoning: true }
			: level === undefined || level === "inherit"
				? ceiling === "inherit"
					? {}
					: { reasoning: ceiling }
				: { reasoning: cappedEffort(level, ceiling) };
	// Backoff and cooldown waits go through the injected seam, or the kernel's real wait that ends at once on abort.
	const kernelSleep: typeof abortableSleep = deps.sleep
		? (ms, signal) => deps.sleep!(ms, signal ?? flightSignal)
		: abortableSleep;
	// One limiter per flight (D-06): fills share it, a transient failure halves its limit. The selection returns it, so the planner
	// knows the think stage needs no second one; this binding acquires a slot per call and feeds it every failure.
	const throttle =
		deps.throttle ??
		new FlightThrottle({
			max: Math.min(Math.max(1, Math.floor(deps.maxConcurrency ?? 3)), 3),
			sleep: kernelSleep,
			...(deps.now ? { now: deps.now } : {}),
		});
	deps.throttle = throttle;
	// The last settled call's report, read by the uplift stage right after its own call; a flight's stages run in turn.
	let lastReport: CompletionReport | undefined;
	return async (intent, signal) => {
		const runtime = request.native;
		if (!runtime) throw nativeFailure("omp-native runtime unavailable");
		if (flightSignal.aborted || signal?.aborted) throw cancelled();
		const [complete, catalog] = await Promise.all([
			// A literal dynamic specifier for the same reason as the catalog (D-03); tests inject a recorder instead.
			deps.completeSimple ??
				import("@oh-my-pi/pi-ai").then((ai): CompleteSimple => ai.completeSimple),
			deps.providerDefaults ?? loadProviderDefaults(),
			loadErrorFlags(),
		]);
		const sessionId = request.sessionId.trim() || undefined;
		const query: NativeModelQuery<Model<Api>> = {
			...(request.model
				? { live: { model: request.model, source: request.modelSource ?? "ctx.model" } }
				: {}),
			check: (model) => classify(runtime.models, model),
			resolve: async (selector, provider) => {
				try {
					const model = runtime.models.resolve(qualify(selector, provider));
					return isModel(model) ? model : undefined;
				} catch {
					return undefined;
				}
			},
			catalogDefault: (provider) => ownString(catalog, provider),
		};
		const bind = (model: Model<Api>): ClaudeCompleter => {
			// The live target is already this flight's snapshot; a resolved override or default is copied once here.
			const snapshot = model === request.model ? model : snapshotModel(model);
			// One auth route per flight: the host resolver for exactly this snapshot and session, passed as the callable key.
			const apiKey = runtime.modelRegistry.resolver(snapshot, sessionId);
			// One call's bound: claude.callTimeoutMs when it is above zero. A hung provider then fails this attempt; it never cancels
			// the flight. The default is 0: no per-call timer, so a call runs until it answers or the flight is cancelled.
			const callTimeoutMs = request.config?.claude.callTimeoutMs ?? 0;
			return async (system, user, stageSignal) => {
				const lifetime =
					stageSignal && stageSignal !== flightSignal
						? AbortSignal.any([flightSignal, stageSignal])
						: flightSignal;
				if (lifetime.aborted || deps.isCurrent?.() === false) throw cancelled();
				const context: Context = {
					systemPrompt: [system],
					messages: [{ role: "user", content: user, timestamp: now() }],
				};
				let lastError: unknown;
				/** One attempt: a failed one throws a `NativeCompletionError` carrying the raw fields the classifier reads. */
				const attempt = async (): Promise<string> => {
					// A flight cancelled or replaced while a backoff slept never makes another call.
					if (lifetime.aborted || deps.isCurrent?.() === false) throw cancelled();
					// The provider's Retry-After for THIS attempt only: each attempt starts without a stale hint.
					let hintMs: number | undefined;
					const release = await throttle.acquire(lifetime);
					try {
						let result: AssistantMessage;
						const deadline = callTimeoutMs > 0 ? AbortSignal.timeout(callTimeoutMs) : undefined;
						try {
							result = await complete(snapshot, context, {
								apiKey,
								signal: deadline ? AbortSignal.any([lifetime, deadline]) : lifetime,
								onResponse: (response) => {
									hintMs = retryAfterOf(response?.headers);
								},
								...thinking,
								...(sessionId ? { sessionId } : {}),
							});
						} catch (error) {
							// A cancelled flight stays a cancellation. A TimeoutError of a live flight (a hung resolver or
							// request deadline) is a failed attempt, never a silent cancel.
							if (lifetime.aborted || deps.isCurrent?.() === false) throw cancelled();
							if (deadline?.aborted)
								throw thrownFailure(
									new Error(`native call timed out after ${callTimeoutMs} ms`),
									hintMs,
								);
							if (isAbortError(error)) throw cancelled();
							throw thrownFailure(error, hintMs);
						}
						// The per-call deadline ended this call, not the flight: a provider that resolves "aborted" on it is a failed attempt.
						if (
							deadline?.aborted &&
							!lifetime.aborted &&
							deps.isCurrent?.() !== false &&
							result?.stopReason === "aborted"
						)
							throw thrownFailure(
								new Error(`native call timed out after ${callTimeoutMs} ms`),
								hintMs,
							);
						// A provider that ignores the signal and still answers never turns a cancelled flight into a plan.
						if (
							lifetime.aborted ||
							deps.isCurrent?.() === false ||
							result?.stopReason === "aborted"
						)
							throw cancelled();
						if (result?.stopReason === "error") throw resultFailure(result, hintMs);
						// A reply cut off at the token limit is a failed attempt, never a plan made of its first half.
						if (result?.stopReason === "length") throw truncatedFailure();
						throttle.noteSuccess();
						return textOf(result);
					} catch (error) {
						lastError = error;
						if (!isAbortError(error)) {
							const verdict = classifyNativeFailure(error, now());
							if (verdict.transient)
								throttle.noteFailure(
									verdict.retryAfterMs === undefined ? {} : { retryAfterMs: verdict.retryAfterMs },
								);
						}
						throw error;
					} finally {
						release();
					}
				};
				try {
					const { value, attempts } = await withRetry(attempt, RETRY_POLICY, {
						signal: lifetime,
						sleep: kernelSleep,
						...(deps.random ? { random: deps.random } : {}),
						...(deps.now ? { now: deps.now } : {}),
						classify: classifyNativeFailure,
						onRetry: ({ attempt: made, delayMs }) => {
							// A retry that would cross the flight's own deadline is not taken: the failure is final.
							if (request.deadline !== undefined && now() + delayMs > request.deadline)
								throw new DeadlineStop(made);
						},
					});
					lastReport = { attempts };
					return value;
				} catch (error) {
					const root = error instanceof DeadlineStop ? lastError : unwrapRetryError(error);
					if (isAbortError(root)) throw cancelled();
					const attempts =
						error instanceof RetryExhaustedError
							? error.attempts
							: error instanceof DeadlineStop
								? error.attempt
								: 1;
					const report = failureReport(root, attempts);
					lastReport = report;
					attachReport(root, report);
					throw root;
				}
			};
		};
		const selection = await selectNativeEngine(intent, query, bind);
		// The binding's limiter (written back to `deps` when it was created) travels with the engine so the think stage reuses it.
		return "skipped" in selection
			? selection
			: {
					...selection,
					report: () => lastReport,
					...(deps.throttle ? { throttle: deps.throttle } : {}),
				};
	};
}

/** The planner's response as the extension shows it: the context, the view and the projected safe record only. */
function toOmpPlan(response: PlanResponse): OmpPlan {
	const modelResolution = projectResolution(response.modelResolution);
	return {
		context: response.context,
		...(response.view ? { view: response.view } : {}),
		...(response.prd ? { prd: response.prd } : {}),
		...(modelResolution ? { modelResolution } : {}),
		...(response.skipped ? { skipped: response.skipped } : {}),
		...(response.summary ? { summary: response.summary } : {}),
	};
}

/**
 * The in-process Omp planner: `planPrompt` for host `omp` with the flight's native selector, signal, progress sink and
 * captured config, control and state directory. Without a native runtime the shared selection reports
 * `native-unavailable`; no subprocess, foreign CLI login or copied credential is involved. `env` is a test seam.
 */
export function createNativeEnginePlanner(
	deps: Omit<NativeEngineDeps, "isCurrent"> & { env?: Record<string, string | undefined> } = {},
): OmpPlanner {
	return async (request, signal, onEvent) => {
		const { env, ...native } = deps;
		// The flight's own deps object: the binding writes its throttle back here; the selection carries it.
		const flightDeps: NativeEngineDeps = {
			...native,
			maxConcurrency: Math.min(
				native.maxConcurrency ?? (request.config?.claude.concurrency || 3),
				3,
			),
			...(request.isCurrent ? { isCurrent: request.isCurrent } : {}),
			// The configured ceiling reaches every native stage of the flight; a dependency value (tests) still wins.
			...(native.reasoningCeiling === undefined && request.config
				? { reasoningCeiling: request.config.think.reasoningCeiling as Effort | "inherit" }
				: {}),
		};
		const selector = request.native
			? createNativeEngineSelector(request, signal, flightDeps)
			: undefined;
		const response = await planPrompt(
			{ host: "omp", session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },
			env ?? { ...PROCESS_ENV.read(), ULTRATHINK_HOST: "omp" },
			{
				...(request.onUplift ? { onUplift: request.onUplift } : {}),
				...(selector ? { native: selector } : {}),
				signal,
				...(onEvent ? { progress: onEvent } : {}),
				...(request.config ? { config: request.config } : {}),
				...(request.control ? { control: request.control } : {}),
				...(request.stateDir ? { stateDir: request.stateDir } : {}),
				// In-process in the TUI: keep the short 2 s lock bound.
				stateLock: OMP_LOCK,
			},
		);
		return toOmpPlan(response);
	};
}

/** The default Omp planner: native, in-process, on the flight's live Model snapshot. */
export const nativeEnginePlanner: OmpPlanner = createNativeEnginePlanner();

/** A hashline header at a line start: `[<path>#<4-hex TAG>]`. Its path group is the edited file. */
const EDIT_HEADER_RE = /^\[(.+?)#[0-9A-Fa-f]{4}\]/gm;

/**
 * Files a tool call changed, as absolute paths. `write` names its file in `path`; `edit` names each file in a hashline
 * header of its `input` string. Other tools, and input without a usable path, name none. Never throws.
 */
export function editTargets(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): string[] {
	if (toolName === "write") {
		const path = typeof input.path === "string" ? input.path.trim() : "";
		// Omp's device calls (`write xd://<tool>`) name no local file, so they edit nothing on disk.
		return path && !path.startsWith("xd://") ? [resolve(cwd, path)] : [];
	}
	const text = input.input;
	if (toolName !== "edit" || typeof text !== "string") return [];
	const files: string[] = [];
	for (const match of text.matchAll(EDIT_HEADER_RE)) {
		const path = (match[1] ?? "").trim();
		if (path) files.push(resolve(cwd, path));
	}
	return files;
}

/** A git call never waits longer than this on the host's event loop; a killed call reads as "no repo". */
const GIT_TIMEOUT_MS = 2000;
/** A directory's repo slug is reused this long, so a burst of edits spawns one git process per directory. */
const GIT_CACHE_TTL_MS = 5000;
const GIT_CACHE_CAP = 200;
const slugCache = new Map<string, { at: number; slug: string | undefined }>();

function timedGitRun(cmd: string[], cwd: string): { stdout: string; code: number } {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: GIT_TIMEOUT_MS });
	return { stdout: proc.stdout?.toString() ?? "", code: proc.exitCode ?? 1 };
}

/** Repo slug of the nearest existing directory at or above `file`; undefined outside a git repo with an origin. Cached 5 s per directory, each git call timed out after 2 s. */
export function repoOfPath(file: string, now: () => number = SYSTEM_CLOCK.now): string | undefined {
	let dir = dirname(file);
	while (!isDirectory(dir)) {
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	const at = now();
	const cached = slugCache.get(dir);
	if (cached && at - cached.at < GIT_CACHE_TTL_MS) return cached.slug;
	const slug = resolveRepoSlug(dir, timedGitRun);
	slugCache.delete(dir);
	slugCache.set(dir, { at, slug });
	if (slugCache.size > GIT_CACHE_CAP) {
		const oldest = slugCache.keys().next();
		if (!oldest.done) slugCache.delete(oldest.value);
	}
	return slug;
}

/**
 * Records the repo an edit touched on the session's record and returns a warning when that repo is not the plan's
 * labelled repo, once per distinct edited set. Attribution only: the label and the edit itself are never changed.
 * A session with no record (never planned) or a file outside any repo changes nothing. Runs inside the Omp TUI, where a
 * raw stderr line would corrupt the screen: a lock that cannot be taken falls back to the unlocked write silently
 * (`lock` is a test seam).
 */
export function recordEditAttribution(
	dir: string,
	sessionId: string,
	file: string,
	lock?: LockOptions,
): string | undefined {
	const edited = repoOfPath(file);
	if (edited === undefined) return undefined;
	let warning: string | undefined;
	updateSession(
		dir,
		sessionId,
		(record) => {
			const previous = record.workRepos ?? [];
			if (previous.includes(edited)) return undefined;
			const workRepos = [...previous, edited].sort();
			if (!record.plan) return { ...record, workRepos };
			const labelled = record.plan.task.repo ?? null;
			if (workRepos.every((repo) => repo === labelled)) return { ...record, workRepos };
			const before = record.repoMismatch;
			if (!before || before.edited.join("\n") !== workRepos.join("\n")) {
				warning = `Ultrathink: this session edited ${workRepos.join(", ")}, but its plan is labelled ${labelled ?? "with no repo"}. The tracked task row may name the wrong repository.`;
			}
			return { ...record, workRepos, repoMismatch: { labelled, edited: workRepos } };
		},
		{
			// The TUI process: keep the short 2 s lock bound (a long wait would freeze the screen).
			...OMP_LOCK,
			log: () => {
				// reason: no stderr inside the Omp TUI; attribution is a best-effort label, so the unlocked fallback is not reported
			},
			...lock,
		},
	);
	return warning;
}

/** Credential readiness from the local store only (no network). */
export function readMcpState(): McpState {
	const mcp: McpState = { linear: "none", notion: "none", greptile: "none" };
	for (const s of authStatus({ storePath: storePath() })) {
		if (s.provider in mcp)
			mcp[s.provider as keyof McpState] = s.ready ? "ready" : s.kind === "none" ? "none" : "login";
	}
	return mcp;
}

/** Omp's temp lease dirs for subagents of non-persisted parents: `os.tmpdir()/omp-task-<id>/<Agent>.jsonl`. */
const LEASE_DIR = /^omp-(?:task|eval-agent)-\d+$/;

/**
 * Omp also runs extensions inside task-tool subagent sessions; planning those
 * prompts would create tracker rows per subagent. Subagent when:
 * - the session file is nested, `<parent file without .jsonl>/<Agent>.jsonl`;
 * - the session file sits directly in a temp lease dir (`omp-task-<n>` or
 *   `omp-eval-agent-<n>`), used when the parent session is not persisted;
 * - there is no UI and either the header carries `parentSession` or there is no
 *   session file at all (in-memory workpool subagents; a top-level
 *   `omp -p --no-session` run is deliberately treated the same and not planned).
 * User forks carry `parentSession` too, but are not nested and keep the UI, so
 * they are still planned, as are top-level persisted sessions. Unsure -> false (plan).
 */
export function isSubagentSession(
	ctx: ExtensionContext | undefined,
	exists: (path: string) => boolean = SYSTEM_FS.existsSync,
): boolean {
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		const hasFile = typeof file === "string" && file !== "";
		if (hasFile && (LEASE_DIR.test(basename(dirname(file))) || exists(`${dirname(file)}.jsonl`)))
			return true;
		if (ctx?.hasUI !== false) return false;
		if (!hasFile) return true;
		const parent = ctx.sessionManager?.getHeader?.()?.parentSession;
		return typeof parent === "string" && parent !== "";
	} catch {
		return false;
	}
}

const planMessage = (content: string, view?: PlanView): CustomMessage => ({
	customType: PLAN_TYPE,
	content,
	display: true,
	...(view ? { details: view } : {}),
	attribution: "agent",
});

const pendingMessage = (): CustomMessage => ({
	customType: PENDING_TYPE,
	content: PENDING,
	display: true,
	attribution: "agent",
});

/** A stored plan's view is untrusted JSON: only the fields the plan message reads are accepted. */
function isPlanView(value: unknown): value is PlanView {
	if (typeof value !== "object" || value === null) return false;
	return (
		"root" in value &&
		typeof value.root === "string" &&
		"nodes" in value &&
		Array.isArray(value.nodes) &&
		"waves" in value &&
		Array.isArray(value.waves) &&
		"clarifications" in value &&
		Array.isArray(value.clarifications)
	);
}

/** Omp slash commands, registered as `ultrathink-<verb>`. */
const COMMANDS: Record<UltrathinkVerb, string> = {
	quick:
		"Send <message> to the agent as typed: no plan, no Graph of Thought, no Linear/Notion rows",
	skip: "Do not plan the next message",
	off: "Turn planning off for Omp on this machine until turned on",
	on: "Turn planning back on for Omp on this machine",
	track: "on|off: keep planning but start or stop creating Linear/Notion rows",
	status: "Show the current ultrathink state",
};

export const QUICK_USAGE =
	"Usage: /ultrathink-quick <message>. Sends the message to the agent as typed, without planning.";

export const RECALL_USAGE =
	"Usage: /ultrathink-recall <query>. Recalls the knowledge base, lessons and skills for <query> now.";

const TRACK_COMPLETIONS = [
	{ value: "on", label: "on", description: "Create Linear/Notion rows for planned prompts" },
	{ value: "off", label: "off", description: "Plan without creating Linear/Notion rows" },
];

/** Local ship precheck result (see src/ship/precheck.ts). */
export interface ShipPrecheck {
	ok: boolean;
	reason: string;
	branch?: string;
	base?: string;
	ahead: number;
}

/** The observed live Model and where it came from (D-01). */
interface LiveTarget {
	model: Model<Api>;
	source: "ctx.model" | "ctx.models.current";
}

/** `ctx.model`, else `ctx.models.current()`; never blended. A throwing or non-Model value counts as absent. */
function observeLive(ctx: ExtensionContext | undefined): LiveTarget | undefined {
	try {
		const model = ctx?.model;
		if (isModel(model)) return { model, source: "ctx.model" };
	} catch {
		// reason: a host model getter that throws means no live model from this source; the next source is tried
	}
	try {
		const current = ctx?.models?.current?.();
		if (isModel(current)) return { model: current, source: "ctx.models.current" };
	} catch {
		// reason: a host models getter that throws means no live model from this source; the result is undefined
	}
	return undefined;
}

function sameLive(a: LiveTarget | undefined, b: LiveTarget | undefined): boolean {
	if (!a || !b) return a === b;
	return a.source === b.source && sameData(a.model, b.model);
}

/** The host's native capabilities when both published facades are present; otherwise native planning is unavailable. */
function nativeRuntime(ctx: ExtensionContext | undefined): OmpNativeRuntime | undefined {
	try {
		const models = ctx?.models;
		const modelRegistry = ctx?.modelRegistry;
		if (
			typeof models?.current !== "function" ||
			typeof models.resolve !== "function" ||
			typeof modelRegistry?.resolver !== "function"
		)
			return undefined;
		return { models, modelRegistry };
	} catch {
		return undefined;
	}
}

/**
 * A flight's view of `ctx.models`: each selector the native policy resolves is remembered with a private copy of what
 * it returned, so a reentry can revalidate alias, role and default selectors against the current query (§8 reentry 3).
 */
interface TrackedQuery {
	models: OmpNativeRuntime["models"];
	changed(current: OmpNativeRuntime["models"]): boolean;
}

function trackQuery(models: OmpNativeRuntime["models"]): TrackedQuery {
	const seen = new Map<string, Model<Api> | undefined>();
	const copy = (model: Model<Api> | undefined): Model<Api> | undefined => {
		if (!isModel(model)) return undefined;
		try {
			return snapshotModel(model);
		} catch {
			return model;
		}
	};
	return {
		models: {
			current: () => models.current(),
			resolve: (spec) => {
				const model = models.resolve(spec);
				if (!seen.has(spec)) seen.set(spec, copy(model));
				return model;
			},
		},
		changed: (current) => {
			for (const [spec, model] of seen) {
				let now: unknown;
				try {
					now = current.resolve(spec);
				} catch {
					// reason: a spec that cannot be resolved is treated as no current model, so the comparison reports a change
					now = undefined;
				}
				if (!sameData(model, isModel(now) ? now : undefined)) return true;
			}
			return false;
		},
	};
}

/** A legacy wire model and its config provenance, copied by value for private reentry comparison only. */
interface LegacyFlightTarget {
	model: string;
	provenance: LegacyModelProvenance;
}

/** What a reentry compares besides the live Model: effective route/selector intent, not the whole config or display state. */
interface FlightIntent {
	engine: string;
	source: "control" | "config";
	override: { provider: string; model: string };
	providerDefaults: [string, string][];
	legacy?: LegacyFlightTarget;
	grok?: {
		enabled: boolean;
		transport: UltrathinkConfig["grok"]["transport"];
		/** Effective fetch target, normalized like the completer; private and never projected into resolution/display. */
		endpoint?: string;
		fallbackToClaude: boolean;
		fallback?: LegacyFlightTarget;
	};
}

function intentOf(config: UltrathinkConfig, control: ControlState): FlightIntent {
	const override = config.models.hosts.omp;
	const engine = control.engine ?? config.think.engine;
	const grok = engine === "grok" ? config.grok : undefined;
	const legacy =
		engine !== "auto" && !override?.provider && !override?.model && (!grok || grok.enabled)
			? { model: config[engine].model, provenance: config.modelProvenance[engine] }
			: undefined;
	return {
		engine,
		source: control.engine === undefined ? "config" : "control",
		override: { provider: override?.provider ?? "", model: override?.model ?? "" },
		providerDefaults: Object.entries(config.models.providerDefaults),
		legacy,
		...(grok
			? {
					grok: {
						enabled: grok.enabled,
						transport: grok.transport,
						endpoint:
							grok.enabled && grok.transport !== "cli"
								? (grok.baseUrl.trim() || DEFAULT_GROK_CONFIG.baseUrl).replace(/\/+$/, "")
								: undefined,
						fallbackToClaude: grok.fallbackToClaude,
						...(!grok.enabled || grok.fallbackToClaude
							? {
									fallback: {
										model: config.claude.model,
										provenance: config.modelProvenance.claude,
									},
								}
							: {}),
					},
				}
			: {}),
	};
}

const SUPERSEDED = "superseded by a newer prompt";
const MODEL_CHANGED = "superseded: the session model changed";
const THINKING_CHANGED = "superseded: the session thinking level changed";
const SESSION_ENDED = "cancelled: the session ended or switched";

type TimerPort = {
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
};

const platformTimers: TimerPort = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

/** The real process environment, read on every call so each read sees the live value. */
const PROCESS_ENV: EnvironmentPort = {
	read: () => process.env,
};

/** The real clock: the default for every timestamp and deadline read, so a ClockPort is the only way to change time. */
const SYSTEM_CLOCK: ClockPort = {
	now: () => Date.now(),
};

/** The real filesystem's synchronous reads, for hook paths that cannot await; a SyncFileSystemPort is the only way to change them. */
const SYSTEM_FS: SyncFileSystemPort = {
	existsSync: (path) => existsSync(path),
	readFileSync: (path) => readFileSync(path, "utf8"),
};

export function createOmpExtension(
	options: {
		plan?: OmpPlanner;
		raceMs?: number;
		/** CompletionGate settings. Absent fields read `ULTRATHINK_GATE` and `ULTRATHINK_GATE_INACTIVITY_MS`. */
		gate?: {
			enabled?: boolean;
			inactivityMs?: number;
			/** Watchdog timers; default the platform timers, apart from `timers` so the race and flight-limit timers stay the only ones armed there. */
			timers?: TimerPort;
		};
		maxRunMs?: number;
		now?: () => number;
		/** Clock port for every timestamp and deadline read; defaults to the real clock. */
		clock?: ClockPort;
		/** Timer port for the remount, flight deadline and race timers; defaults to the platform timers. */
		timers?: TimerPort;
		ui?: boolean;
		/** MCP readiness source; defaults to the local credential store. */
		mcp?: () => McpState;
		/** File existence check for subagent detection; defaults to `existsSync`. */
		exists?: (path: string) => boolean;
		/** Synchronous filesystem port for the live token-opt snapshot read; defaults to the real filesystem. */
		fs?: SyncFileSystemPort;
		/** Ultrathink state dir holding `sessions/<id>.json`; defaults to the omp host state dir. */
		stateDir?: string;
		/** Process environment port for every env read; defaults to the real process environment. */
		env?: EnvironmentPort;
		/** The effective config a flight captures for a session cwd; defaults to the layered config files. */
		config?: (cwd: string) => UltrathinkConfig;
		/** Local ship precheck (`git` only); defaults to `shipPrecheck`. */
		shipPrecheck?: (cwd: string) => ShipPrecheck;
		/** Teachable Moments context source; defaults to the merged config for the session cwd. */
		teachContext?: typeof teachContext;
		/**
		 * Test seam: the knowledge reader the explicit recall reads through. Defaults to the Greptile reader
		 * (`createGreptileKnowledge`), which is undefined unless `hitl.knowledgeBase` is on.
		 */
		knowledgeReader?: (config: UltrathinkConfig) => KnowledgeReader | undefined;
		/** Detached `teach observe` launcher; defaults to `spawnObserveDetached`. */
		spawnObserve?: typeof spawnObserveDetached;
		/** Ship config source; defaults to the merged Claude config files for the session cwd. */
		shipConfig?: (cwd: string) => ShipConfig;
		/** AgentSwarm lane seams: the classifier bound to a swarm root, and the lane spawner. Default to the real ones. */
		swarm?: {
			classify?: (swarmRoot: string) => LaneClassify;
			spawn?: (plan: readonly LanePlan[]) => LaneHandle[];
		};
	} = {},
): (pi: ExtensionAPI) => void {
	const plan = options.plan ?? nativeEnginePlanner;
	const raceMs = options.raceMs ?? 25_000;
	/**
	 * CompletionGate settings, read when a flight starts. On by default: `ULTRATHINK_GATE=off|0|false|no` opts out, the
	 * `gate` option wins over the environment. `ULTRATHINK_GATE_INACTIVITY_MS` is the watchdog window (0 disables).
	 */
	const gateSettings = (): {
		enabled: boolean;
		inactivityMs: number;
	} => {
		const env = environment.read();
		const window = Number(env.ULTRATHINK_GATE_INACTIVITY_MS?.trim() || Number.NaN);
		return {
			enabled:
				options.gate?.enabled ?? !/^(?:off|0|false|no)$/i.test(env.ULTRATHINK_GATE?.trim() ?? ""),
			inactivityMs:
				options.gate?.inactivityMs ??
				(Number.isFinite(window) && window >= 0 ? window : DEFAULT_GATE_INACTIVITY_MS),
		};
	};
	// 0 (the default) means no outer limit: no flight timer and no retry deadline.
	const maxRunMs = options.maxRunMs ?? 0;
	const clock = options.clock ?? SYSTEM_CLOCK;
	const now = options.now ?? (() => clock.now());
	const instanceStartedAt = now();
	const timers = options.timers ?? platformTimers;
	const uiEnabled = options.ui ?? true;
	const readMcp = options.mcp ?? readMcpState;
	const exists = options.exists ?? SYSTEM_FS.existsSync;
	const flightConfig = options.config ?? ((cwd: string) => loadConfig(claudeConfigPaths(cwd)));
	const environment = options.env ?? PROCESS_ENV;
	const fsPort = options.fs ?? SYSTEM_FS;
	// The host state dir for the session cwd, made absolute: planning, carriers and commands share it.
	const stateDir = (cwd: string) =>
		resolve(
			cwd,
			options.stateDir ?? resolveStateDir({ ...environment.read(), ULTRATHINK_HOST: "omp" }),
		);
	// Swarm seams: Swarm's own classifier and the lane spawner; the defaults are the real ones.
	const classifierFor = options.swarm?.classify ?? swarmClassifier;
	const spawnLaneSet = options.swarm?.spawn ?? spawnLanes;
	/** One `<laneId>: <note>` line per lane that started with a remark (for example, `lane.json` was not written). */
	const laneNotes = (handles: readonly LaneHandle[]): string[] =>
		handles.flatMap((handle) => (handle.note ? [`${handle.laneId}: ${handle.note}`] : []));

	return (pi) => {
		interface Flight {
			sessionId: string;
			cwd: string;
			/** The session's `turn_start` count when planning began; with `prompt`, identifies the submission. */
			submission: number;
			prompt: string;
			/** Private target identity: the live Model snapshot and the engine request, compared at reentry. */
			live?: LiveTarget;
			intent?: FlightIntent;
			/** Native effort snapshot, compared only at reentry; stages never reread or adopt a new level. */
			thinkingLevel?: SessionThinkingLevel;
			/** The flight's view of `ctx.models`, for revalidating resolved selectors at reentry. */
			selectors?: TrackedQuery;
			/** The context the flight observes the live model through at call and delivery boundaries. */
			ctx: ExtensionContext | undefined;
			/** The flight's own lifetime: superseded, switched, invalidated, ended or out of time aborts it. */
			controller: AbortController;
			result: Promise<OmpPlan>;
			/** Settles the existing outcome and clears the optional outer handle; cancellation releases through this. */
			finishFlight: (result: OmpPlan) => void;
			/** The outer deadline handle, present only for a strictly positive maxRunMs. */
			deadlineTimer: NodeJS.Timeout | undefined;
			/** Pending was returned; the aside is the only delivery. */
			deferred: boolean;
			/** The uplift-only context, when it was final before the race ended; the rest of the plan follows as the aside. */
			early?: { context: string };
			/** The early context was delivered inline: settle sends the whole final plan as the aside, so the uplift is repeated there. */
			earlyDelivered?: boolean;
			/** The completion gate guarding this flight; absent when the gate is off, which keeps the old race. */
			gate?: CompletionGate;
			/** This flight's gate was seen in `waiting_for_plan`: a later `ready` auto-resumes and delivers the Plan. */
			gateWaiting?: boolean;
			/** The gate-released Plan already went (or is going) out as the flight's one aside: the duplicate guard. */
			gateAsideDelivered?: boolean;
			/** Tracker rows are expected in the plan (tracking on and a tracker configured when the flight launched). */
			tracked?: boolean;
			/** The no-plan or stalled note, or a recovered stored plan, was already delivered for this flight. */
			noticed?: boolean;
			/** This flight is the relaunch of a failed planner; a submission gets no second retry. */
			retried?: boolean;
			/** Launches this flight's prompt again through the same path; set by `launch`. */
			relaunch?: (limitMs: number) => Flight;
			/** The planner's skip reason. A deliberate skip (deliberateSkip) is silent; any other skip is a planning failure. */
			skipped?: string;
			/** Why the flight was cancelled; a model or thinking change during planning is announced, any other cancel stays silent. */
			cancelReason?: string;
			/** The plan already reached the model inline: the aside and any re-entry must not repeat it. */
			deliveredInline?: boolean;
			/** When planning began (clock ms): a relaunch gets only the budget that is left. */
			startedAt: number;
			/** The Tree-of-Thought PRD outcome of the settled plan; it makes the gate wait for every PRD to be delivered. */
			prd?: PrdOutcome;
			/** What the gate released for this flight; kept so a host re-run of the same submission gets the same plan. */
			releasedText?: string;
			/** Validated identity of the gate-released plan text; kept with `releasedText` for re-delivery. */
			releasedPlan?: { planId: string; planHash: string };
			/** Start order; only the latest flight writes to the bar store. */
			generation: number;
			settled: boolean;
			/** Cancelled and suppressed: delivers nothing and writes nothing more. */
			cancelled: boolean;
			/** The outer limit ended it: the current request still gets its no-plan note. */
			timedOut: boolean;
			content: string;
			view?: PlanView;
			/** Detail of the planner's `end` event, used as the skip reason. */
			endDetail?: string;
		}
		// Omp re-runs before_agent_start for one submission (agent-start policy retries, a restored
		// queued batch) and each plan creates tracker rows, so a re-run reuses the flight. The hook
		// carries no submission id, but every submission reaches the agent as a turn: a `turn_start`
		// since the last run means a new submission, even with identical text.
		const turns = new Map<string, number>();
		// The latest submission's flight per session. A replaced flight is cancelled and delivers nothing:
		// delivered later, it would steer the newer request toward the old one.
		const flights = new Map<string, Flight>();
		// Plans this session has delivered, by record key: a repeat is refused before any store read.
		const deliveredKeys = new Set<string>();
		// The latest observed safe resolution per session, for `/ultrathink-status`; extension memory only, never persisted.
		const resolutions = new Map<string, ModelResolution>();
		// Overlapping flights share one bar; a newer prompt owns it, older flights only deliver messages.
		let latestGeneration = 0;
		const barWrite = (generation: number, fn: () => void): void => {
			if (generation === latestGeneration) guard(fn);
		};
		const store: BarStore = createBarStore();
		try {
			pi.events?.on("substrate:status", (data) => {
				const substrate = parseSubstrateStatus(data);
				if (substrate !== undefined) store.setSubstrate(substrate);
			});
			pi.events?.emit("substrate:status-request", {});
		} catch {
			// reason: the substrate status channel is optional; a host without it shows no substrate state
		}
		try {
			const live = join(homedir(), ".omp", "agent", "token-opt", "live.json");
			if (fsPort.existsSync(live)) {
				const savings = parseTokenSavings(JSON.parse(fsPort.readFileSync(live)));
				if (savings !== undefined) store.setSavings(savings);
			}
		} catch {
			// reason: a missing or unreadable snapshot must not block planning
		}
		try {
			pi.events?.on("token-opt:savings", (data) => {
				const savings = parseTokenSavings(data);
				if (savings !== undefined) store.setSavings(savings);
			});
		} catch {
			// reason: the savings channel is optional; a host without it keeps the file snapshot
		}
		let ui: ExtensionUI | undefined;
		let tuiRef: TuiLike | undefined;
		let timerStarted = false;
		// Set on session_shutdown and cleared on session_start/session_switch: a reply computed across an
		// await must not be delivered into a host that no longer has a live session to receive it.
		let shutDown = false;
		let activityTimer: NodeJS.Timeout | undefined;
		const activitySeen = new Set<string>();

		const guard = (fn: () => void): void => {
			try {
				fn();
			} catch {
				// reason: a failing UI or store update must never break the host hook; the error is dropped by design
			}
		};
		const refreshMcp = () => guard(() => store.setMcp(readMcp()));
		const factory: WidgetFactory = (tui, theme) => {
			tuiRef = tui;
			const rows = () => {
				try {
					return tui?.terminal?.rows ?? process.stdout.rows ?? 40;
				} catch {
					return 40;
				}
			};
			const reducedMotion = flightConfig(process.cwd()).ui.reducedMotion;
			return createBarComponent(store, theme, now, rows, reducedMotion);
		};
		const mountBar = () =>
			guard(() => ui?.setWidget?.("ultrathink", factory, { placement: "aboveEditor" }));
		// Other extensions re-set their aboveEditor widgets inside the same handlers, which moves them
		// between ours and the status band; one deferred remount per tick puts the bar back last.
		let mountQueued = false;
		const scheduleMount = (): void => {
			if (!ui || mountQueued) return;
			mountQueued = true;
			try {
				timers.setTimeout(() => {
					try {
						mountQueued = false;
						mountBar();
					} catch {
						// reason: the deferred mount is best effort; a failed mount leaves the bar unmounted until the next event
					}
				}, 0);
			} catch {
				// reason: a scheduler that cannot be armed clears the queued flag so the next event retries
				mountQueued = false;
			}
		};

		if (uiEnabled) {
			store.subscribe(() => guard(() => tuiRef?.requestRender()));
			if (typeof pi.registerMessageRenderer === "function")
				guard(() => registerUltrathinkRenderers(pi as never));
		}

		/** The session's current flight, not cancelled: the only one that may write state, show progress or deliver. */
		const owns = (flight: Flight): boolean =>
			!flight.cancelled && flights.get(flight.sessionId) === flight;
		/** Cancels and suppresses a flight: aborts its lifetime and clears its delivery eligibility (§8 reentry 5). */
		const cancel = (flight: Flight, note: string): void => {
			if (flight.cancelled) return;
			flight.cancelled = true;
			flight.cancelReason = note;
			if (flights.get(flight.sessionId) === flight) flights.delete(flight.sessionId);
			// Release the waiting consumer through the existing outcome even when the provider ignores abort;
			// suppression flags are already set, so the settlement publishes nothing.
			guard(() => flight.finishFlight({ context: "" }));
			guard(() => flight.controller.abort());
			if (!flight.settled) barWrite(flight.generation, () => store.skipped(note, now()));
		};
		/** Ownership plus the lazily read live model, at lifecycle, native call and delivery boundaries; a changed target cancels. */
		const current = (flight: Flight): boolean => {
			if (!owns(flight)) return false;
			if (sameLive(flight.live, observeLive(flight.ctx))) return true;
			cancel(flight, MODEL_CHANGED);
			return false;
		};
		/** Observe the active session before a paused planner can resume into tracking or persistence. */
		const observeFlights = (ctx: ExtensionContext): void => {
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			guard(() => store.setLiveSession(sessionId));
			const cwd = ctx?.cwd || process.cwd();
			// A prompt observed in another session/cwd orphans the dashboard: drop it silently here
			// (the switch handler explains); planner-flight handling below is unchanged.
			if (activeInsight && (activeInsight.sessionId !== sessionId || activeInsight.cwd !== cwd)) {
				teardownInsight(activeInsight);
			}
			for (const flight of flights.values()) {
				if (flight.sessionId !== sessionId || flight.cwd !== cwd) {
					cancel(flight, SESSION_ENDED);
				} else {
					flight.ctx = ctx;
					current(flight);
				}
			}
		};
		const observe = (sessionId: string, record: unknown): void => {
			const projected = projectResolution(record);
			if (projected) boundedSet(resolutions, sessionId, projected, RESOLUTIONS_CAP);
		};
		const endFlights = (): void => {
			for (const flight of [...flights.values()]) cancel(flight, SESSION_ENDED);
			quick = undefined;
		};
		/** Drops per-session memory of sessions with no live flight; run after `endFlights`, on switch and shutdown. */
		const pruneSessions = (): void => {
			for (const map of [turns, resolutions])
				for (const sessionId of [...map.keys()]) if (!flights.has(sessionId)) map.delete(sessionId);
		};
		// `/ultrathink-ui` native dashboard lifetimes (Phase 26). One owned lifetime at a time, separate from
		// planner flights: its own AbortController plus a monotonic epoch covering session/cwd/stateDir/project.
		// Session switch/shutdown, explicit close and replacement open abort the old lifetime, dispose its
		// component once, clear ephemeral state and suppress its late callbacks. Teardown never touches planner
		// flights, the bar store, tracking, quick handoff or auth. No dashboard opens per turn: only this command.
		const UI_PANELS = ["overview", "jev", "moments", "skills", "card"] as const;
		type UiPanel = (typeof UI_PANELS)[number];

		const UI_OFF_COPY =
			"Ultrathink native UI is disabled by the extension option. No dashboard or custom card was opened.";
		const UI_CHILD_COPY = "Dashboard is available only in the top-level Omp session.";
		const UI_UNSUPPORTED_COPY =
			"Native dashboard unavailable in this host. Showing a local read-only snapshot; use Omp TUI for guarded actions.";
		const UI_SCOPE_COPY =
			"Scope unavailable. Cross-project/session inspection and actions are disabled; reopen from a top-level Omp session.";
		const UI_STALE_COPY =
			"Session changed. Dashboard closed; no further action was started for the old selection.";
		const UI_LOADING_COPY = "Loading local snapshot… No model calls or lesson changes.";

		/** Plain-text fallback budget (UI-SPEC): at most 24 rows of 120 visible columns. */
		const UI_FALLBACK_ROWS = 24;
		const UI_FALLBACK_COLS = 120;

		/** Strip untrusted terminal controls from a short label; the read model owns body sanitization. */
		const uiOneLine = (text: string): string =>
			text
				.replace(/[\x00-\x1f\x7f]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();

		/** Clamp fallback text to the row/column budget, keeping the trailing explanation always visible. */
		const clampUiFallback = (text: string, tail: string): string => {
			const rows = text
				.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
				.split("\n")
				.slice(0, UI_FALLBACK_ROWS - 1);
			return [...rows, tail]
				.slice(0, UI_FALLBACK_ROWS)
				.map((row) => truncateToWidth(row, UI_FALLBACK_COLS))
				.join("\n");
		};

		interface InsightLifetime {
			epoch: number;
			sessionId: string;
			cwd: string;
			stateDir: string;
			project: string;
			controller: AbortController;
			dashboard?: InsightComponent;
			disposed: boolean;
			refreshSeq: number;
			lastSnapshot?: InsightSnapshot;
			loadingUi?: ExtensionUI;
		}

		let insightEpoch = 0;
		let activeInsight: InsightLifetime | undefined;

		/** The lifetime still owns the dashboard: active, undisposed, unaborted. Planner flights are never consulted. */
		const insightCurrent = (lifetime: InsightLifetime): boolean =>
			activeInsight === lifetime && !lifetime.disposed && !lifetime.controller.signal.aborted;

		/** Abort the lifetime, dispose its component once, drop ephemeral state. Never touches flights/bar/tracking/quick. */
		const teardownInsight = (lifetime: InsightLifetime): void => {
			if (lifetime.disposed) return;
			lifetime.disposed = true;
			const loadingUi = lifetime.loadingUi;
			lifetime.loadingUi = undefined;
			if (loadingUi) guard(() => loadingUi.setWidget?.(INSIGHT_TYPE, undefined));
			if (activeInsight === lifetime) activeInsight = undefined;
			guard(() => lifetime.controller.abort());
			const dashboard = lifetime.dashboard;
			lifetime.dashboard = undefined;
			if (dashboard) guard(() => dashboard.dispose());
		};

		/**
		 * The TeachContext snapshot and preview work runs in: the same layered config authority flights capture,
		 * passed explicitly so inspection never invokes Hindsight readiness, credential resolution, recall or sync.
		 * No network, model, or store mutation happens here; the read model and action adapter own their boundaries.
		 */
		const insightTeachContext = (lifetime: InsightLifetime): TeachContext => {
			const env = { ...environment.read(), ULTRATHINK_HOST: "omp" };
			let config: TeachContext["config"] | undefined;
			try {
				const full = flightConfig(lifetime.cwd);
				config = {
					teach: full.teach,
					hindsight: full.hindsight,
					decisions: full.decisions,
					gateway: full.gateway,
				};
			} catch {
				// reason: an unreadable config yields no config snapshot; the card renders without config details
				config = undefined;
			}
			return (options.teachContext ?? teachContext)({
				host: "omp",
				cwd: lifetime.cwd,
				env,
				sessionId: lifetime.sessionId,
				stateDir: lifetime.stateDir,
				...(config ? { config } : {}),
				signal: lifetime.controller.signal,
			});
		};

		/**
		 * Display-only delivery for UI text: default delivery with `triggerTurn: false` renders in the transcript
		 * without starting a turn. Never `deliverAs: "aside"` (starts a turn when idle) or `sendUserMessage`
		 * (starts a model prompt and skips slash expansion) on UI/teaching paths. Existing planner `aside`
		 * deliveries are unchanged.
		 */
		const sendInsightText = (content: string): void => {
			guard(() => pi.sendMessage({ content, display: true }, { triggerTurn: false }));
		};

		/**
		 * Delivery for command replies computed across an await: the session the command started in is
		 * captured at entry, and a reply is suppressed when the extension shut down or the live session id
		 * changed meanwhile — otherwise a switch during the wait delivers the reply into the NEW session.
		 */
		const sendSessionText = (
			sessionId: string,
			ctx: ExtensionContext | undefined,
			content: string,
		): void => {
			if (shutDown || (ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId) return;
			sendInsightText(content);
		};

		/**
		 * Publish a swarm card (spawn or status) as a display-only custom message; the transcript renders it
		 * through the SWARM_TYPE renderer when the host has a card surface, and shows `content` as plain text
		 * otherwise. A stale session (switch or shutdown during an await) sends nothing — same rule as
		 * {@link sendSessionText}.
		 */
		const sendSwarmCard = (
			sessionId: string,
			ctx: ExtensionContext | undefined,
			content: string,
			details: unknown,
		): void => {
			if (shutDown || (ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId) return;
			guard(() =>
				pi.sendMessage(
					{ customType: SWARM_TYPE, content, display: true, details },
					{ triggerTurn: false },
				),
			);
		};

		/** Publish a captured summary card without a model turn. A stale lifetime sends nothing. */
		const publishInsightCard = (
			lifetime: InsightLifetime,
			snapshot: InsightSnapshot,
		): InsightActionResult => {
			if (!insightCurrent(lifetime)) return { status: "cancelled", message: UI_STALE_COPY };
			let details: unknown;
			try {
				details = toInsightCardSnapshot(snapshot);
			} catch {
				// reason: a snapshot that cannot be converted renders without card details
				details = undefined;
			}
			const label = uiOneLine(
				`Ultrathink insight — ${snapshot.project} · session ${snapshot.session}`,
			);
			guard(() =>
				pi.sendMessage(
					{
						customType: INSIGHT_TYPE,
						content: truncateToWidth(label, UI_FALLBACK_COLS),
						display: true,
						...(details !== undefined ? { details } : {}),
					},
					{ triggerTurn: false },
				),
			);
			return { status: "ok", message: label };
		};

		/** Bounded read-only snapshot for unsupported hosts and mount failures, with the TUI-only explanation. */
		const sendSnapshotFallback = (
			snapshot: InsightSnapshot | undefined,
			lifetime: InsightLifetime,
		): void => {
			if (!insightCurrent(lifetime)) return;
			let text = "";
			try {
				if (snapshot) text = formatInsightText(snapshot);
			} catch {
				// reason: a snapshot that cannot be formatted falls back to the fixed unsupported copy
				text = "";
			}
			sendInsightText(text ? clampUiFallback(text, UI_UNSUPPORTED_COPY) : UI_UNSUPPORTED_COPY);
			teardownInsight(lifetime);
		};

		/** Session switch/shutdown ownership: the old dashboard can never publish into the new session. */
		const closeInsightForSwitch = (ctx: ExtensionContext): void => {
			const previous = activeInsight;
			if (!previous) return;
			teardownInsight(previous);
			try {
				ctx?.ui?.notify?.(UI_STALE_COPY, "info");
			} catch {
				// reason: the stale notice is advisory; the old dashboard is already closed
			}
		};

		const openInsightUi = async (
			args: string | undefined,
			ctx: ExtensionContext,
		): Promise<void> => {
			const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const panel: UiPanel = (UI_PANELS as readonly string[]).includes(argv[0] ?? "")
				? (argv[0] as UiPanel)
				: "overview";
			// Guards precede everything: no component mount, no card, no model admission on refused paths.
			if (!uiEnabled) {
				sendInsightText(UI_OFF_COPY);
				return;
			}
			if (isSubagentSession(ctx, exists)) {
				sendInsightText(UI_CHILD_COPY);
				return;
			}
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const cwd = ctx?.cwd || process.cwd();
			if (!sessionId) {
				sendInsightText(UI_SCOPE_COPY);
				return;
			}
			const dir = stateDir(cwd);
			const previous = activeInsight;
			const lifetime: InsightLifetime = {
				epoch: ++insightEpoch,
				sessionId,
				cwd,
				stateDir: dir,
				project: projectOf(cwd),
				controller: new AbortController(),
				disposed: false,
				refreshSeq: 0,
			};
			if (previous) teardownInsight(previous);
			activeInsight = lifetime;
			const isCurrent = (): boolean => insightCurrent(lifetime);
			const scope: InsightScope = { sessionId, cwd, stateDir: dir, epoch: lifetime.epoch };
			const hostUi =
				ctx?.hasUI && ctx.mode === "tui" && ctx.ui && typeof ctx.ui.custom === "function"
					? ctx.ui
					: undefined;
			if (hostUi?.setWidget) {
				lifetime.loadingUi = hostUi;
				guard(() =>
					hostUi.setWidget?.(
						INSIGHT_TYPE,
						(_tui, theme) => {
							const p = paint(theme);
							return {
								render: (width) => [truncateToWidth(p.fg("muted", UI_LOADING_COPY), width)],
							};
						},
						{ placement: "aboveEditor" },
					),
				);
			} else if (hostUi) {
				guard(() => hostUi.notify?.(UI_LOADING_COPY, "info"));
			}
			let snapshot: InsightSnapshot;
			try {
				snapshot = await readInsightSnapshot(
					scope,
					insightTeachContext(lifetime),
					lifetime.controller.signal,
				);
			} catch (error) {
				if (!isCurrent()) return;
				teardownInsight(lifetime);
				const reason =
					uiOneLine(error instanceof Error ? error.message : String(error)).slice(0, 200) ||
					"unknown error";
				sendInsightText(
					`Could not read local snapshot: ${reason}. No lesson changes were made by this read.`,
				);
				return;
			}
			if (!isCurrent()) return;
			const loadingUi = lifetime.loadingUi;
			lifetime.loadingUi = undefined;
			if (loadingUi) guard(() => loadingUi.setWidget?.(INSIGHT_TYPE, undefined));
			lifetime.lastSnapshot = snapshot;
			if (panel === "card") {
				publishInsightCard(lifetime, snapshot);
				teardownInsight(lifetime);
				return;
			}
			if (!hostUi?.custom) {
				sendSnapshotFallback(snapshot, lifetime);
				return;
			}
			const runtime = (): InsightActionRuntime => ({
				scope,
				getContext: () => insightTeachContext(lifetime),
				isCurrent,
				signal: lifetime.controller.signal,
			});
			const staleResult = (): InsightActionResult => ({
				status: "cancelled",
				message: UI_STALE_COPY,
			});
			let finish: ((result: void) => void) | undefined;
			const callbacks: InsightDashboardCallbacks = {
				refresh: async (): Promise<InsightSnapshot> => {
					const seq = ++lifetime.refreshSeq;
					const fresh = await readInsightSnapshot(
						scope,
						insightTeachContext(lifetime),
						lifetime.controller.signal,
					);
					// Latest request alone publishes: a late previous refresh keeps the current snapshot.
					if (!isCurrent() || seq !== lifetime.refreshSeq) return lifetime.lastSnapshot ?? fresh;
					lifetime.lastSnapshot = fresh;
					return fresh;
				},
				confirmCandidate: (selection: LessonSelection): Promise<InsightActionResult> =>
					isCurrent() ? confirmInsightLesson(selection, runtime()) : Promise.resolve(staleResult()),
				previewSkill: (selection: LessonSelection): Promise<InsightActionResult> =>
					isCurrent() ? previewInsightSkill(selection, runtime()) : Promise.resolve(staleResult()),
				installPreview: (
					preview: SkillPreview,
					confirmed: boolean,
				): Promise<InsightActionResult> =>
					isCurrent()
						? installInsightSkill(preview, confirmed, runtime())
						: Promise.resolve(staleResult()),
				publishCard: (next: InsightSnapshot): Promise<InsightActionResult> =>
					Promise.resolve(publishInsightCard(lifetime, next)),
				close: (): void => {
					teardownInsight(lifetime);
					guard(() => finish?.(undefined));
				},
			};
			try {
				const initialPanel: InsightPanel = panel;
				await hostUi.custom<void>(
					(tui, theme, _keybindings, done) => {
						finish = done;
						const dashboard = createInsightDashboard(snapshot, callbacks, {
							theme,
							requestRender: () => {
								try {
									tui.requestRender();
								} catch {
									// reason: a host redraw failure is best effort; the dashboard state is already updated
								}
							},
							rows: () => {
								try {
									return tui.terminal?.rows;
								} catch {
									return undefined;
								}
							},
							initialPanel,
						});
						lifetime.dashboard = dashboard;
						return dashboard;
					},
					{ signal: lifetime.controller.signal },
				);
			} catch {
				// reason: Live host failures degrade to text; stale/aborted closes stay silent.
				if (isCurrent()) sendSnapshotFallback(lifetime.lastSnapshot ?? snapshot, lifetime);
			} finally {
				teardownInsight(lifetime);
			}
		};

		const attach = (ctx: ExtensionContext) =>
			guard(() => {
				if (
					!uiEnabled ||
					!ctx?.hasUI ||
					ctx.mode !== "tui" ||
					typeof ctx.ui?.setWidget !== "function"
				)
					return;
				ui = ctx.ui;
				refreshMcp();
				mountBar();
				if (timerStarted || typeof ctx.setInterval !== "function") return;
				timerStarted = true;
				let wasAnimating = false;
				ctx.setInterval(() => {
					guard(() => {
						const animating = store.animating(now());
						if (animating || wasAnimating) tuiRef?.requestRender();
						wasAnimating = animating;
					});
				}, 80);
			});
		const stopActivityPoll = (): void => {
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
		};
		const startActivityPoll = (ctx: ExtensionContext | undefined): void => {
			stopActivityPoll();
			if (!uiEnabled || shutDown || !ctx?.hasUI || ctx.mode !== "tui") return;
			if (isSubagentSession(ctx, exists)) return;
			const dir = stateDir(ctx.cwd || process.cwd());
			// Receipts name the session whose observe run wrote them: this window publishes only its own session's.
			const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
			if (sessionId === "") return;
			try {
				for (const row of readActivity(dir)) activitySeen.add(row.id);
			} catch {
				// reason: fail-open: the poller must not block on a missing or unreadable receipt log
			}
			const timer = setInterval(() => {
				if (shutDown) return;
				try {
					for (const row of readActivity(dir)) {
						if (row.sessionId !== sessionId || activitySeen.has(row.id)) continue;
						activitySeen.add(row.id);
						if (activitySeen.size > 200) {
							const oldest = activitySeen.values().next().value;
							if (oldest !== undefined) activitySeen.delete(oldest);
						}
						if (shutDown) return;
						const { id: _id, sessionId: _owner, ...notice } = row;
						guard(() =>
							pi.sendMessage(
								{
									customType: ACTIVITY_TYPE,
									content: truncateToWidth(activityFallbackLine(notice), UI_FALLBACK_COLS),
									display: true,
									details: notice,
								},
								ACTIVITY_DELIVERY,
							),
						);
					}
				} catch {
					// reason: fail-open: a receipt is display only
				}
			}, 2_000);
			timer.unref?.();
			activityTimer = timer;
		};
		/** The phase record's directory and session key at a lifecycle boundary: the session id is the record key. */
		const phaseSession = (ctx: ExtensionContext | undefined) => ({
			stateDir: stateDir(ctx?.cwd || process.cwd()),
			sessionId: ctx?.sessionManager?.getSessionId?.() ?? "",
		});
		/** Shows one phase-loop report: a message stays in the transcript without starting a turn; a notice goes to the UI. */
		const showPhaseReport = (
			report: PhaseReport | undefined,
			ctx: ExtensionContext | undefined,
		): void => {
			if (report?.kind === "message")
				guard(() =>
					pi.sendMessage(
						{ content: report.text, display: true, attribution: "agent" },
						{ triggerTurn: false },
					),
				);
			if (report?.kind === "notice") guard(() => ctx?.ui?.notify?.(report.text, "warning"));
		};
		/** The session the kill hook checkpoints: set at session start or switch, cleared once shutdown pauses it. */
		let livePhaseSession: PhaseSession | undefined;
		installKillCheckpoint(() => livePhaseSession, now);
		pi.on("session_start", (_event, ctx) => {
			shutDown = false;
			attach(ctx);
			startActivityPoll(ctx);
			scheduleMount();
			// The host already named this session. An invalid id is ignored; a throw must not block startup.
			guard(() => store.setLiveSession(ctx?.sessionManager?.getSessionId?.()));
			guard(() => {
				livePhaseSession = phaseSession(ctx);
				showPhaseReport(restoreSessionPhases(livePhaseSession), ctx);
			});
		});
		pi.on("session_switch", (_event, ctx) => {
			// The old session's flights would deliver into the new one: cancel and suppress them.
			guard(endFlights);
			guard(pruneSessions);
			// The old dashboard would publish into the new session: abort it first, then explain the closure.
			guard(() => closeInsightForSwitch(ctx));
			shutDown = false;
			attach(ctx);
			startActivityPoll(ctx);
			scheduleMount();
			guard(() => store.setLiveSession(ctx?.sessionManager?.getSessionId?.()));
			guard(() => {
				livePhaseSession = phaseSession(ctx);
				showPhaseReport(restoreSessionPhases(livePhaseSession), ctx);
			});
		});
		pi.on("session_shutdown", (_event, ctx) => {
			shutDown = true;
			stopActivityPoll();
			guard(endFlights);
			guard(pruneSessions);
			syncedPrs.clear();
			nudgedGraphs.clear();
			guard(() => {
				if (activeInsight) teardownInsight(activeInsight);
			});
			// A session that recorded a phase is checkpointed as paused; a session with no record writes nothing.
			guard(() =>
				showPhaseReport(
					pauseSessionPhases({ ...phaseSession(ctx), at: new Date(now()).toISOString() }),
					ctx,
				),
			);
			// Paused: a signal arriving from here on must not overwrite the pause checkpoint with a kill.
			livePhaseSession = undefined;
		});
		for (const event of [
			"agent_start",
			"agent_end",
			"turn_end",
			"tool_execution_start",
			"tool_execution_end",
		] as const) {
			pi.on(event, (_event, ctx) => {
				guard(() => observeFlights(ctx));
				scheduleMount();
			});
		}
		pi.on("turn_start", (_event, ctx) => {
			scheduleMount();
			guard(() => {
				observeFlights(ctx);
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				boundedSet(turns, sessionId, (turns.get(sessionId) ?? 0) + 1, TURNS_CAP);
			});
			guard(() => recallTurnStart(ctx));
		});

		// Edit attribution: each file a successful edit or write changed is attributed to its repo, and a warning fires when
		// that repo is not the plan's labelled repo. A warning only; the edit and the label are left alone.
		pi.on("tool_result", (event, ctx) => {
			guard(() => {
				if (event.isError) return;
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				if (!sessionId) return;
				const cwd = ctx?.cwd || process.cwd();
				for (const file of editTargets(event.toolName, event.input ?? {}, cwd)) {
					const warning = recordEditAttribution(stateDir(cwd), sessionId, file);
					if (warning) ctx?.ui?.notify?.(warning, "warning");
				}
			});
		});

		// A failed tool result recalls for its error (SPE-34394): lessons on its first occurrence, teachable moments on its second.
		pi.on("tool_result", (event, ctx) => {
			guard(() => recallFailure(event, ctx));
		});

		// PR-sync parity with hooks/pr-sync.ts: once a planned session opens a PR, nudge the agent to run
		// ultrathink-sync, once per PR URL. Omp's own `github` tool opens PRs with `op: "pr_create"`; every
		// other tool follows the shared rule. Device calls (`write xd://<tool>`) emit the inner tool's result too.
		const syncedPrs = new Set<string>();
		pi.on("tool_result", (event, ctx) => {
			guard(() => {
				if (event.isError) return;
				const input = event.input ?? {};
				const command = typeof input.command === "string" ? input.command : undefined;
				if (
					!(
						(event.toolName === "github" && input.op === "pr_create") ||
						isPrCreationTool(event.toolName, command)
					)
				)
					return;
				const pr = extractPrFromOutput(
					event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
				);
				if (!pr || syncedPrs.has(pr.url) || isSubagentSession(ctx, exists)) return;
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				if (!sessionId) return;
				const dir = stateDir(ctx?.cwd || process.cwd());
				const tracked = readSession(dir, sessionId)?.plan;
				if (!tracked) return;
				pi.sendMessage(
					{
						customType: SYNC_TYPE,
						content: `Ultrathink: a pull request was opened for the tracked task (${pr.url}). Invoke the ultrathink-sync skill now with stateFile=${sessionRecordPath(dir, sessionId)} and prUrl=${pr.url} (graphId=${tracked.graphId}), so the tracked Notion Task row and Linear issues get the PR URL/number/branch and status. ultrathink-sync only updates existing rows; do not create new Notion rows or Linear issues.`,
						display: true,
						details: pr,
						attribution: "agent",
					},
					{ deliverAs: "aside" },
				);
				boundedAdd(syncedPrs, pr.url, SYNCED_PRS_CAP);
			});
		});

		// Ship parity with hooks/stop.ts: when a planned gsd-* skill run ends with committed work on a
		// feature branch, nudge the agent once per graph to run ultrathink-ship (PR, Greptile 5/5, merge).
		const nudgedGraphs = new Set<string>();

		// Teachable Moments `observe`/`auto` capture: hand the finished run to a detached `teach observe`.
		// Shares this handler (and its guard) with the ship nudge, whose early returns must not skip it.
		const observeAgentEnd = (event: unknown, ctx: ExtensionContext): void => {
			if (isSubagentSession(ctx, exists)) return;
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const messages =
				event && typeof event === "object" && "messages" in event ? event.messages : undefined;
			if (!sessionId || !Array.isArray(messages)) return;
			const lastAssistant: unknown = messages.findLast(
				(m: unknown) =>
					typeof m === "object" && m !== null && "role" in m && m.role === "assistant",
			);
			if (
				typeof lastAssistant === "object" &&
				lastAssistant !== null &&
				"stopReason" in lastAssistant &&
				lastAssistant.stopReason === "aborted"
			)
				return;
			const cwd = ctx?.cwd || process.cwd();
			const env = { ...environment.read(), ULTRATHINK_HOST: "omp" };
			const teach = (options.teachContext ?? teachContext)({
				host: "omp",
				cwd,
				env,
				sessionId,
				stateDir: stateDir(cwd),
			});
			if (!teachEnabled(teach) || teach.config.teach.capture === "explicit") return;
			const digest = digestFromAgentMessages(messages, {
				host: "omp",
				sessionId,
				cwd,
				outcome: "completed",
			});
			if (!digest) return;
			(options.spawnObserve ?? spawnObserveDetached)(digest, {
				repoRoot: ROOT,
				env,
				stateDir: teach.stateDir,
				host: "omp",
			});
		};
		pi.on("agent_end", (event, ctx) => {
			guard(() => observeAgentEnd(event, ctx));
			guard(() => {
				if (isSubagentSession(ctx, exists)) return;
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				if (!sessionId) return;
				const cwd = ctx?.cwd || process.cwd();
				const dir = stateDir(cwd);
				const record: SessionRecord | undefined = readSession(dir, sessionId);
				const graphId = record?.plan?.graphId;
				if (!record || !graphId || nudgedGraphs.has(graphId) || record.ship?.nudgedAt !== undefined)
					return;
				const config = options.shipConfig
					? options.shipConfig(cwd)
					: loadConfig(claudeConfigPaths(cwd)).ship;
				if (!shipApplies(config, record.skill?.name)) return;
				const precheck = (options.shipPrecheck ?? shipPrecheck)(cwd);
				const statePath = sessionRecordPath(dir, sessionId);
				const nudge = shipNudge({ record, config, precheck, statePath });
				if (!nudge) return;
				boundedAdd(nudgedGraphs, graphId, NUDGED_GRAPHS_CAP);
				// The TUI process: keep the short 2 s lock bound (a long wait would freeze the screen).
				writeShip(statePath, { nudgedAt: now() }, now(), OMP_LOCK);
				pi.sendMessage(
					{
						customType: SHIP_TYPE,
						content: nudge.reason,
						display: true,
						details: { branch: precheck.branch, base: precheck.base, ahead: precheck.ahead },
						attribution: "agent",
					},
					{ deliverAs: "aside" },
				);
			});
		});

		// `/ultrathink-quick <message>` arms this for exactly that message: its submission (and Omp's
		// re-runs of it) skip planning, tracking and the bar. Any other prompt disarms it, so a quick
		// message queued as a steer never swallows the next one.
		let quick: { sessionId: string; text: string; submission?: number } | undefined;
		/** Recall state per session. An entry exists once a recall step was asked for in the session. */
		const recallSessions = new Map<string, RecallSession>();
		const recallSessionOf = (sessionId: string): RecallSession => {
			const session = recallSessions.get(sessionId) ?? {
				runtime: createRecallState(),
				chain: Promise.resolve(),
			};
			boundedSet(recallSessions, sessionId, session, RECALL_SESSIONS_CAP);
			return session;
		};
		/** Runs one recall step after the session's earlier steps settle, so each plans from the state the last one left. */
		const serialRecall = <T>(sessionId: string, step: () => Promise<T>): Promise<T> => {
			const session = recallSessionOf(sessionId);
			const run = session.chain.then(step);
			session.chain = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		};
		/** The fetchers the recall sources read through, for one config. The knowledge fetcher is absent when its base is off. */
		const recallFetchers = (cwd: string, sessionId: string, config: UltrathinkConfig) => {
			const reader = (
				options.knowledgeReader ?? ((c: UltrathinkConfig) => createGreptileKnowledge(c))
			)(config);
			const teachCtx = (options.teachContext ?? teachContext)({
				host: "omp",
				cwd,
				env: { ...environment.read(), ULTRATHINK_HOST: "omp" },
				sessionId,
				stateDir: stateDir(cwd),
				config: {
					teach: config.teach,
					hindsight: config.hindsight,
					decisions: config.decisions,
					gateway: config.gateway,
				},
			});
			return {
				knowledge:
					reader &&
					(async (topic: string) => {
						const session = reader.start({ repo: resolveRepoSlug(cwd) });
						try {
							return (await session.read(topic)).lookup;
						} finally {
							session.close();
						}
					}),
				lessons: async (topic: string) =>
					lessonsLookup(await recallLessons({ query: topic }, teachCtx, { countUse: false })),
				moments: async (topic: string) => recallMoments(topic, teachCtx, { countUse: false }),
				skills: async (topic: string, key: SkillKey = {}) =>
					skillsLookup(await recallSkills({ query: topic, ...key }, teachCtx)),
			};
		};
		/** The lookups one query reads from the named sources, each bounded by `ms`. A source with no fetcher stays absent. */
		const boundedLookups = async (
			cwd: string,
			sessionId: string,
			config: UltrathinkConfig,
			query: string,
			ms: number,
			want: { knowledge: boolean; lessons: boolean; moments: boolean; skills?: boolean },
		): Promise<RecallLookups> => {
			const fetchers = recallFetchers(cwd, sessionId, config);
			const [knowledge, lessons, moments, skills] = await Promise.all([
				want.knowledge
					? boundedLookup(() => fetchers.knowledge?.(query), failedKnowledge, ms)
					: undefined,
				want.lessons ? boundedLookup(() => fetchers.lessons(query), failedLessons, ms) : undefined,
				want.moments ? boundedLookup(() => fetchers.moments(query), failedLessons, ms) : undefined,
				// A failure's skills lookup is keyed by its error text, with the working directory as scope.
				want.skills
					? boundedLookup(
							() => fetchers.skills(query, { error: query, scope: cwd }),
							failedSkills,
							ms,
						)
					: undefined,
			]);
			return { knowledge, lessons, moments, skills };
		};
		/**
		 * One automatic recall: `read` fetches the lookups the trigger needs, then the planner plans from the state the
		 * session's earlier steps left and its next state is kept. The caller checks the gates (`recallInjects`) first.
		 */
		const planAutoRecall = (
			sessionId: string,
			settings: RecallSettings,
			event: RecallEvent,
			read: (state: RecallRuntimeState, ms: number) => Promise<RecallLookups>,
		): Promise<RecallPlan> =>
			serialRecall(sessionId, async () => {
				const session = recallSessionOf(sessionId);
				const lookups = await read(session.runtime, settings.recall.timeoutMs);
				const plan = planRecall({
					trigger: event,
					nowMs: Date.now(),
					settings,
					state: session.runtime,
					lookups,
				});
				if (plan.ok) session.runtime = plan.next;
				return plan;
			});
		/** A display-only card for an automatic recall that produced panels: the explicit card's shape, no model turn. */
		const deliverRecall = (
			sessionId: string,
			ctx: ExtensionContext | undefined,
			trigger: RecallEvent["trigger"],
			plan: RecallPlan,
		): void => {
			if (!plan.ok || Object.keys(plan.panels).length === 0) return;
			if (shutDown || (ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId) return;
			const summary = `Recall (${trigger}): ${plan.audit.map((entry) => `${entry.source} ${entry.outcome}`).join(", ")}`;
			guard(() =>
				pi.sendMessage(
					{ customType: RECALL_TYPE, content: summary, display: true, details: plan.panels },
					{ triggerTurn: false },
				),
			);
		};
		// Not wired: phaseBoundary (no step id on this host, only the GSD phase name in omp-phase.ts) and compaction
		// (no Omp compaction event is registered in this host).
		/** A turn starts: the turn budget resets, and a repository change fires a scope-change recall when its gates are open. */
		const recallTurnStart = (ctx: ExtensionContext | undefined): void => {
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			if (!sessionId) return;
			const known = recallSessions.get(sessionId);
			if (known) known.runtime = { ...known.runtime, budget: resetTurn(known.runtime.budget) };
			const cwd = ctx?.cwd || process.cwd();
			const config = flightConfig(cwd);
			if (!config.recallSettings.recall.enabled) return;
			const scope = resolveRepoSlug(cwd, timedGitRun) ?? cwd;
			const tracked = recallSessionOf(sessionId);
			const previous = tracked.scope;
			tracked.scope = scope;
			if (previous === undefined || previous === scope) return;
			if (!recallInjects(config.recallSettings, "scopeChange")) return;
			void planAutoRecall(
				sessionId,
				config.recallSettings,
				{ trigger: "scopeChange", scopePath: scope },
				(_state, ms) =>
					boundedLookups(cwd, sessionId, config, scope, ms, {
						knowledge: true,
						lessons: true,
						moments: false,
					}),
			).then(
				(plan) => deliverRecall(sessionId, ctx, "scopeChange", plan),
				() => undefined,
			);
		};
		/** A failed tool result recalls for its error: lessons on the first occurrence, teachable moments on the second, and skills keyed by the error on both. */
		const recallFailure = (event: ToolResultEvent, ctx: ExtensionContext | undefined): void => {
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const error = event.content
				.map((part) => part.text ?? "")
				.join("\n")
				.trim();
			if (!sessionId || error === "") return;
			const cwd = ctx?.cwd || process.cwd();
			const config = flightConfig(cwd);
			const settings = config.recallSettings;
			if (!recallInjects(settings, "failure")) return;
			void planAutoRecall(sessionId, settings, { trigger: "failure", error }, (state, ms) => {
				const { occurrence } = recordFailure(
					state.failures ?? createFailureState(),
					error,
					Date.now(),
					failureWindowMs(settings),
				);
				if (occurrence > 2) return Promise.resolve<RecallLookups>({});
				return boundedLookups(cwd, sessionId, config, error, ms, {
					knowledge: false,
					lessons: occurrence === 1,
					moments: occurrence === 2,
					skills: settings.recall.sources.skills,
				}).then(
					({ lessons, moments, skills }): RecallLookups =>
						occurrence === 1 ? { lessons, skills } : { moments, skills },
				);
			}).then(
				(plan) => deliverRecall(sessionId, ctx, "failure", plan),
				() => undefined,
			);
		};
		/**
		 * `/ultrathink-recall <query>`: one explicit recall over the knowledge base, lessons and skills. Off unless
		 * `recall.enabled` is set. The panels go to the transcript as a display-only card, never a model turn. The
		 * reply is computed across awaits, so it is dropped when the session changed or the extension shut down.
		 */
		const runRecallCommand = async (
			args: string,
			ctx: ExtensionContext | undefined,
		): Promise<void> => {
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const cwd = ctx?.cwd || process.cwd();
			const config = flightConfig(cwd);
			const fetchers = recallFetchers(cwd, sessionId, config);
			const result = await serialRecall(sessionId, async () => {
				const session = recallSessionOf(sessionId);
				const outcome = await runExplicitRecall({
					query: args,
					nowMs: Date.now(),
					settings: config.recallSettings,
					state: session.runtime,
					fetch: {
						...(fetchers.knowledge && { knowledge: fetchers.knowledge }),
						lessons: fetchers.lessons,
						moments: fetchers.moments,
						skills: fetchers.skills,
					},
				});
				if (outcome.ok) session.runtime = outcome.next;
				return outcome;
			});
			if (!result.ok) {
				if (result.reason === "empty_query") return ctx?.ui?.notify?.(RECALL_USAGE, "info");
				if (result.reason === "recall_off")
					return ctx?.ui?.notify?.(
						"Recall is off: set recall.enabled to use /ultrathink-recall.",
						"info",
					);
				return ctx?.ui?.notify?.(`Recall refused: ${result.reason}.`, "info");
			}
			const summary = `Recall: ${result.audit.map((entry) => `${entry.source} ${entry.outcome}`).join(", ")}`;
			if (shutDown || (ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId) return;
			guard(() =>
				pi.sendMessage(
					{ customType: RECALL_TYPE, content: summary, display: true, details: result.panels },
					{ triggerTurn: false },
				),
			);
		};

		if (typeof pi.registerCommand === "function") {
			// Each command's handler is also held in this map; the registered wrapper dispatches through the port.
			const commandHandlers = new Map<string, OmpCommandHandler>();
			const commandPort = createOmpCommandPort(commandHandlers);
			const routed = (
				name: string,
				handler: (args: string, ctx: ExtensionContext) => Promise<void>,
			) => {
				commandHandlers.set(name, (args, ctx) => handler(args, ctx as ExtensionContext));
				return async (args: string, ctx: ExtensionContext): Promise<void> => {
					const correlationId = globalThis.crypto.randomUUID();
					const result = await commandPort.invoke(name, { args, ctx }, { correlationId });
					if (!result.ok) throw new Error(result.error.message);
				};
			};
			for (const verb of Object.keys(COMMANDS) as UltrathinkVerb[]) {
				const name = `ultrathink-${verb}`;
				guard(() =>
					pi.registerCommand?.(name, {
						description: COMMANDS[verb],
						...(verb === "track"
							? {
									getArgumentCompletions: (prefix: string) =>
										TRACK_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trim())),
								}
							: {}),
						handler: routed(name, async (args, ctx) => {
							try {
								// Subagents act as before: the typed text goes to the agent unchanged.
								if (isSubagentSession(ctx, exists)) {
									pi.sendUserMessage?.(args ? `/${name} ${args}` : `/${name}`);
									return;
								}
								const text = (args ?? "").trim();
								if (verb === "quick") {
									if (!text || typeof pi.sendUserMessage !== "function")
										return ctx?.ui?.notify?.(QUICK_USAGE, "info");
									// Armed before sending: Omp may emit before_agent_start before sendUserMessage returns.
									quick = { sessionId: ctx?.sessionManager?.getSessionId?.() ?? "", text };
									try {
										pi.sendUserMessage(text);
									} catch {
										// reason: a failed sendUserMessage clears the quick reply so the verb is not reported as sent
										quick = undefined;
									}
									return;
								}
								const cwd = ctx?.cwd || process.cwd();
								// Status shows this session's latest observed resolution without any native lookup or auth.
								const observed = resolutions.get(ctx?.sessionManager?.getSessionId?.() ?? "");
								const reply = await runControl([verb, ...text.split(/\s+/).filter(Boolean)], {
									stateDir: stateDir(cwd),
									cwd,
									host: "omp",
									...(observed ? { modelResolution: observed } : {}),
									sessionId: ctx?.sessionManager?.getSessionId?.() || undefined,
									// The TUI process: keep the short 2 s lock bound (a long wait would freeze the screen); a contended
									// toggle fails with one line and writes nothing.
									controlLock: { ...OMP_LOCK, onTimeout: "throw" },
								});
								ctx?.ui?.notify?.(reply, "info");
							} catch {
								// reason: a rejected verb must not throw into the host command runner; the reply is best effort
							}
						}),
					}),
				);
			}
			// `/ultrathink-ui [overview|jev|moments|skills|card]`: the native insight dashboard. Default opens
			// Overview; `card` publishes a captured summary card without a model turn. Never per-turn spam:
			// this registration is the only entry point. Child sessions get an explicit refusal, never
			// model forwarding: unlike the verbs above, this path must not `sendUserMessage` anything.
			guard(() =>
				pi.registerCommand?.("ultrathink-ui", {
					description:
						"Open the native Ultrathink dashboard (overview, jev, moments, skills) or publish a summary card",
					getArgumentCompletions: (prefix: string) =>
						UI_PANELS.filter((panel) => panel.startsWith(prefix.trim())).map((value) => ({
							value,
							label: value,
							description: `Ultrathink dashboard view: ${value}`,
						})),
					handler: routed("ultrathink-ui", async (args, ctx) => {
						try {
							await openInsightUi(args, ctx);
						} catch {
							// reason: a failed dashboard open must not reject into the host command runner
						}
					}),
				}),
			);
			// `/ultrathink-recall <query>`: one explicit recall over the knowledge base, lessons and skills (needs
			// `recall.enabled`). The panels are a display-only card; no model turn starts.
			guard(() =>
				pi.registerCommand?.("ultrathink-recall", {
					description:
						"Recall knowledge, lessons and skills for <query> now (needs recall.enabled)",
					handler: routed("ultrathink-recall", async (args, ctx) => {
						try {
							await runRecallCommand(args ?? "", ctx);
						} catch (error) {
							ctx?.ui?.notify?.(
								`Recall failed: ${error instanceof Error ? error.message : String(error)}`,
								"info",
							);
						}
					}),
				}),
			);
			// `/ultrathink-skills [list | disable <name> | delete <name>]`: manages the generated skills
			// in the state dir's generated-skills store. It never generates a skill.
			guard(() =>
				pi.registerCommand?.("ultrathink-skills", {
					description: "List, disable or delete generated skills (never generates)",
					handler: routed("ultrathink-skills", async (args, ctx) => {
						try {
							const cwd = ctx?.cwd || process.cwd();
							const reply = await runSkillsCommand(args ?? "", {
								storeDir: join(stateDir(cwd), "generated-skills"),
							});
							ctx?.ui?.notify?.(reply, "info");
						} catch (error) {
							ctx?.ui?.notify?.(
								`Skills failed: ${error instanceof Error ? error.message : String(error)}`,
								"info",
							);
						}
					}),
				}),
			);
			// `/ultrathink-swarm brief|brief|…` fans out one detached AgentSwarm orchestrator lane per brief; each
			// lane runs `hooks/autonomous_run.py` with its own SWARM_DIR, so Task Stores and logs never contend.
			// `/ultrathink-swarm status` probes every lane's Task Store through orch_status.py. Replies are
			// display-only text (never a model turn); child sessions may use it like the verbs above.
			guard(() =>
				pi.registerCommand?.("ultrathink-swarm", {
					description:
						"Fan out AgentSwarm lanes from `|`-separated briefs, show lane status, or `stop [laneId|all]`",
					handler: routed("ultrathink-swarm", async (args, ctx) => {
						try {
							// The session this command belongs to; replies computed across an await are dropped if it changed.
							const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
							const cwd = ctx?.cwd || process.cwd();
							const dir = stateDir(cwd);
							const parsed = parseLaneArgs(args ?? "", { maxLanes: maxLanes(environment.read()) });
							if (parsed.kind === "usage")
								return sendInsightText(`${parsed.reason}. ${TEAMS_USAGE}`);
							// `stop` never needs a valid swarm root: a user whose config broke must still be able to end lanes.
							// Every kill goes through `stopLanes`: verified pid, then the lane's process group only.
							if (parsed.kind === "stop") {
								const resolved = resolveStopTargets(parsed.target, allLaneDirs(dir));
								if ("reason" in resolved) return sendSessionText(sessionId, ctx, resolved.reason);
								const lines = await stopLanes(resolved.targets, {
									kill: (pid, signal) => process.kill(pid, signal as NodeJS.Signals),
									waitMs: (ms) => {
										const { promise, resolve } = Promise.withResolvers<void>();
										// unref: a stop wait must never be what keeps the host's event loop alive.
										setTimeout(resolve, ms).unref();
										return promise;
									},
								});
								return sendSessionText(sessionId, ctx, lines.join("\n"));
							}
							const root = resolveSwarmRoot(environment.read());
							if ("reason" in root)
								return sendInsightText(`AgentSwarm lanes unavailable: ${swarmRootMessage(root)}`);
							if (parsed.kind === "status") {
								const discovery = laneDirs(dir);
								const rows = await laneStatus(
									discovery.lanes,
									orchStatusRunner({ swarmRoot: root.root, cwd, env: environment.read() }),
								);
								const full = formatLaneStatusText(rows, discovery.omitted);
								// The card summarizes; the text listing is the complete enumeration (every reported
								// lane with its counts or error and log path), so the two never point at each
								// other circularly. Hosts without a card renderer get the listing alone.
								if (uiEnabled && ctx?.hasUI && typeof pi.registerMessageRenderer === "function")
									sendSwarmCard(
										sessionId,
										ctx,
										`Swarm lanes — ${rows.filter((row) => !("error" in row)).length}/${rows.length} reported${discovery.omitted > 0 ? ` · ${discovery.omitted} older not shown` : ""}`,
										toSwarmStatusCard(rows, discovery.omitted),
									);
								return sendSessionText(sessionId, ctx, full);
							}
							const pstack = resolvePstack(
								join(environment.read().HOME?.trim() || homedir(), ".cursor"),
							);
							// The Graph ID of the session's tracked plan (when there is one) becomes the lane brief's first line.
							const graphId = sessionId ? readSession(dir, sessionId)?.plan?.graphId : undefined;
							const planned = planLanes(parsed.briefs, {
								cwd,
								stateDir: dir,
								swarmRoot: root.root,
								env: environment.read(),
								pstack,
								graphId,
							});
							// Ask Swarm's own classifier about the exact lane text first, then refuse briefs that duplicate a
							// live lane or exceed the live-lane cap; only the survivors spawn.
							const preflight = await filterSpawnable(planned, classifierFor(root.root));
							// Check, spawn and lane.json write are one locked step (spawnGuarded); the classifier await above
							// stays outside the lock.
							const guarded = spawnGuarded(preflight.spawn, {
								stateDir: dir,
								cwd,
								cap: maxLanes(environment.read()),
								isAlive: pidAlive,
								spawn: spawnLaneSet,
							});
							const handles = guarded.handles;
							const plan = guarded.spawn;
							const refusals = [...preflight.refused, ...guarded.refused].map(
								(refusal) => `${refusal.laneId}: ${refusal.reason}`,
							);
							const remarks = [...refusals, ...preflight.notes];
							if (plan.length === 0)
								return sendSessionText(
									sessionId,
									ctx,
									[...refusals, ...(preflight.refused.length > 0 ? [TEAMS_USAGE] : [])].join("\n"),
								);
							const started = handles.filter((handle) => handle.pid !== undefined).length;
							if (uiEnabled && ctx?.hasUI && typeof pi.registerMessageRenderer === "function") {
								sendSwarmCard(
									sessionId,
									ctx,
									`Swarm lanes — ${started}/${plan.length} spawned`,
									toSwarmSpawnCard(handles, plan),
								);
								const beside = [...laneNotes(handles), ...remarks];
								if (beside.length > 0) sendSessionText(sessionId, ctx, beside.join("\n"));
							} else
								sendSessionText(
									sessionId,
									ctx,
									[formatLaneHandles(handles), ...remarks].join("\n"),
								);
						} catch {
							// reason: a failed swarm card must not reject into the host command runner
						}
					}),
				}),
			);
		}

		/** The counts a complete plan must reach, from the plan view the planner returned; none without one. */
		const gateExpected = (flight: Flight): GateExpected => {
			const nodes = flight.view?.nodes;
			const prds = flight.prd ? { prds: flight.prd.manifest.total } : {};
			if (!nodes || nodes.length === 0) return prds;
			return {
				...prds,
				nodes: nodes.length,
				...(flight.tracked
					? {
							issues: nodes.length,
							subIssues: nodes.reduce((total, node) => total + node.steps.length, 0),
						}
					: {}),
			};
		};

		/** Whether this flight's plan is expected to carry tracker rows: tracking on and a tracker configured. */
		const trackedOf = (
			config: UltrathinkConfig | undefined,
			control: ControlState | undefined,
		): boolean =>
			config !== undefined &&
			(control?.trackEnabled ?? config.track.enabled) &&
			environment.read().ULTRATHINK_TRACK?.trim() !== "0" &&
			(config.linear.team.trim() !== "" || config.notion.dataSourceUrl.trim() !== "");

		/**
		 * What a gated flight may put in front of the model right now. `plan`: the gate released the whole plan (once;
		 * the text is kept so a host re-run of the submission gets the same one). `hold`: a finished plan that is
		 * incomplete or unusable and is never released: the flight ends with a message that names what is missing.
		 * `notice`: planning failed, stalled or did not complete, and the request continues as written, loudly.
		 * `none`: a cancelled flight, which stays silent.
		 */
		type GateDelivery =
			| { kind: "plan"; text: string; planId?: string; planHash?: string }
			| { kind: "hold"; text: string }
			| { kind: "notice"; text: string }
			| { kind: "none" };
		const gateDelivery = (flight: Flight, gate: CompletionGate): GateDelivery => {
			if (flight.releasedText !== undefined)
				return { kind: "plan", text: flight.releasedText, ...flight.releasedPlan };
			if (gate.state === "failed_or_cancelled") {
				// A plan was produced but is unusable (for example cut off): it is never injected or released.
				if (gate.verdict) return { kind: "hold", text: gateHoldPartial(gate.reason, false) };
				// A deliberate planner skip is intentional silence. Any other skip is a planning failure and is announced.
				if (flight.cancelled || deliberateSkip(flight.skipped)) return { kind: "none" };
				if (gate.stalled) return { kind: "notice", text: gateStalled(gate.reason) };
				return { kind: "notice", text: failureNotice(flight) };
			}
			// An incomplete plan is never released: the flight ends with a message that names what is missing.
			if (gate.state === "partial_failure") {
				const missing = (gate.verdict?.problems ?? []).map((problem) => problem.detail).join("; ");
				return { kind: "hold", text: gateHoldPartial(missing, true) };
			}
			if (gate.state === "waiting_for_plan") {
				// The one-time hold: arm the late auto-resume, so a later `ready` delivers through the aside.
				flight.gateWaiting = true;
				// A quarantine revoked the prior release: a revised Plan may be delivered again.
				flight.gateAsideDelivered = false;
				flight.releasedText = undefined;
				flight.releasedPlan = undefined;
				flight.deliveredInline = false;
				return { kind: "hold", text: gate.blocked ? gateWaitingBlocked(gate.blockReason) : GATE_WAITING };
			}
			if (gate.state === "plan_validated") {
				const transitioned = gate.tryTransition("ready", "omp", "auto-use validated plan");
				if (!transitioned) {
					const rejected = gate.transitions.at(-1);
					const detail = rejected
						? `the plan transition ${rejected.from} -> ${rejected.to} was rejected: ${rejected.reason} (the plan is still ${gate.state})`
						: `the plan is still ${gate.state}`;
					return { kind: "notice", text: planFailedNotice(detail) };
				}
			}
			if (gate.state !== "ready")
				return { kind: "notice", text: planFailedNotice(`the plan is still ${gate.state}`) };
			const released = gate.release();
			if (!released.ok) return { kind: "notice", text: planFailedNotice(released.detail) };
			// Delivered/saved text is exactly `released.text`: workers re-hash it and
			// must get `planHash`. The validated identity (`planId`/`planHash`, the
			// `planRecord()` equivalent) travels alongside the body only: it is
			// persisted with the stored record and carried on the delivery, never
			// appended into the plan body, so re-hashing the body still verifies.
			const text = released.text;
			const identity = gate.getExecutionContext();
			flight.releasedText = text;
			if (identity) flight.releasedPlan = { planId: identity.planId, planHash: identity.planHash };
			saveReleased(flight, text, identity ?? undefined);
			return { kind: "plan", text, ...flight.releasedPlan };
		};

		/** An aside, or a notice as one: a refused send is warned and shown display-only, so the model and the user both learn of it. */
		const sendAside = async (flight: Flight, message: CustomMessage): Promise<boolean> => {
			try {
				await Promise.resolve(pi.sendMessage(message, { deliverAs: "aside" }));
				return true;
			} catch {
				// reason: a refused aside must never break the host; the failure is warned, and the display note is best effort
				const warning = planFailedNotice("the plan could not be delivered");
				guard(() => flight.ctx?.ui?.notify?.(warning, "warning"));
				try {
					await Promise.resolve(
						pi.sendMessage(
							{ customType: PENDING_TYPE, content: warning, display: true, attribution: "agent" },
							{ triggerTurn: false },
						),
					);
				} catch {
					// reason: the warning already reached the user through the UI notice; a refused display note has no other channel
				}
				return false;
			}
		};
		/** The notice for a flight that a model or thinking change ended mid-plan. Any other cancel stays silent. */
		const changeNotice = (flight: Flight): string | undefined =>
			flight.cancelReason === MODEL_CHANGED
				? planFailedNotice("the session model changed while planning")
				: flight.cancelReason === THINKING_CHANGED
					? planFailedNotice("the session thinking level changed while planning")
					: undefined;
		/**
		 * A cancelled flight's outcome for the call that waits on it. A flight that a newer call replaced is silent; a flight
		 * cancelled with nothing replacing it (a model or thinking change) is announced to the waiting call.
		 */
		const cancelledOutcome = (flight: Flight): BeforeAgentStartResult | undefined => {
			if (flights.has(flight.sessionId)) return undefined;
			const note = changeNotice(flight);
			return note === undefined ? undefined : { message: planMessage(note) };
		};
		/**
		 * Uncertainty (SPE-34394): a settled plan with open clarifications recalls the knowledge base for them, bounded by
		 * recall.timeoutMs, and the knowledge panel joins the plan view. It returns the view as is, synchronously, unless the
		 * gates are open and the view has open clarifications and no knowledge panel yet.
		 */
		const withUncertaintyPanel = (flight: Flight, view: PlanView): PlanView | Promise<PlanView> => {
			const open = view.clarifications.filter((item) => (item.answer ?? "").trim() === "");
			if (open.length === 0 || view.panels?.knowledge !== undefined) return view;
			const config = flightConfig(flight.cwd);
			if (!recallInjects(config.recallSettings, "uncertainty")) return view;
			const topic = open.map((item) => item.question).join("\n");
			return planAutoRecall(
				flight.sessionId,
				config.recallSettings,
				{ trigger: "uncertainty", topic },
				(_state, ms) =>
					boundedLookups(flight.cwd, flight.sessionId, config, topic, ms, {
						knowledge: true,
						lessons: false,
						moments: false,
					}),
			).then(
				(plan) =>
					plan.ok && plan.panels.knowledge !== undefined
						? { ...view, panels: { ...view.panels, knowledge: plan.panels.knowledge } }
						: view,
				() => view,
			);
		};
		/**
		 * Late valid Plan auto-resume: the gate was held in `waiting_for_plan` and has since reached `ready`.
		 * Runs the same `gateDelivery` release as `settle` and sends the released text as the one aside.
		 * `gateAsideDelivered` is set synchronously before the first await, so a repeated `ready` (or a
		 * `settle`/`gatedMessage` delivery racing this one) cannot send a second aside; `deliveredInline`
		 * covers a plan that already reached the model inline.
		 */
		const deliverLateGatePlan = async (flight: Flight): Promise<void> => {
			const gate = flight.gate;
			if (!gate || gate.state !== "ready" || !flight.gateWaiting) return;
			if (!flight.settled || flight.cancelled || deliberateSkip(flight.skipped)) return;
			if (flight.deliveredInline || flight.gateAsideDelivered) return;
			if (!current(flight)) return;
			const delivery = gateDelivery(flight, gate);
			if (delivery.kind === "notice") {
				await sendAside(flight, planMessage(delivery.text, flight.view));
				return;
			}
			if (delivery.kind !== "plan") return;
			if (flight.deliveredInline || flight.gateAsideDelivered) return;
			flight.gateAsideDelivered = true;
			if (!(await sendAside(flight, planMessage(delivery.text, flight.view)))) {
				flight.gateAsideDelivered = false;
				return;
			}
			barWrite(flight.generation, () => store.delivered("aside", flight.view, now()));
			markPlanDelivered(flight);
		};
		/** Delivery once the plan settles: only a still-current flight on an unchanged live model shows or sends anything. */
		const settle = async (flight: Flight, result: OmpPlan): Promise<void> => {
			flight.settled = true;
			flight.content = result?.context ?? "";
			flight.skipped = result?.skipped;
			const settledView = result?.view && withUncertaintyPanel(flight, result.view);
			flight.view = settledView instanceof Promise ? await settledView : settledView;
			flight.prd = result?.prd;
			const gate = flight.gate;
			const prdRefusal = flight.prd?.error;
			if (prdRefusal)
				guard(() =>
					flight.ctx?.ui?.notify?.(`Tree-of-Thought PRDs did not run: ${prdRefusal}`, "warning"),
				);
			if (gate?.state === "generating") {
				if (flight.content)
					gate.complete({
						text: flight.content,
						expected: gateExpected(flight),
						...(flight.prd ? { prd: flight.prd.manifest, prdSync: flight.prd.sync } : {}),
						...(flight.view?.source === "fallback"
							? { degraded: "the plan fell back to the built-in template instead of the model" }
							: {}),
					});
				else
					gate.fail(
						flight.cancelled
							? "cancelled"
							: (result?.skipped ?? flight.endDetail ?? "the planner produced no plan"),
					);
			}
			if (!current(flight)) return;
			if (result?.modelResolution) observe(flight.sessionId, result.modelResolution);
			// A deferred flight whose planner failed with nothing to show is relaunched once; the new flight delivers its own outcome.
			if (flight.deferred && flight.relaunch && retryDue(flight)) {
				const next = retryFailed(flight, flight.relaunch);
				next.deferred = true;
				return;
			}
			// The GSD phase record, advisory at Omp (the merge enforces it): the current flight records, before delivery.
			if (flight.content)
				showPhaseReport(
					recordGsdPhase({
						stateDir: stateDir(flight.cwd),
						cwd: flight.cwd,
						sessionId: flight.sessionId,
						prompt: flight.prompt,
						plan: result,
					}),
					flight.ctx,
				);
			barWrite(flight.generation, () => {
				if (!flight.content)
					store.skipped(flight.timedOut ? "timed out" : (flight.endDetail ?? "no plan"), now());
			});
			barWrite(flight.generation, refreshMcp);
			if (!flight.deferred) return;
			// A deliberate skip is intentional silence, deferred or not; an inline delivery already reached the model.
			if (deliberateSkip(flight.skipped) || flight.deliveredInline) return;
			// With the gate on, the aside carries only what the gate releases: a partial or unusable plan is shown, never sent.
			let body = flight.content || (flight.earlyDelivered ? EARLY_RELEASE : failureNotice(flight));
			if (gate) {
				const delivery = gateDelivery(flight, gate);
				if (delivery.kind === "hold") {
					barWrite(flight.generation, () => store.skipped("plan incomplete", now()));
					guard(() => flight.ctx?.ui?.notify?.(delivery.text, "warning"));
					// Display only: the transcript shows the held plan, and no turn starts on it.
					guard(() =>
						pi.sendMessage(
							{
								customType: PENDING_TYPE,
								content: delivery.text,
								display: true,
								attribution: "agent",
							},
							{ triggerTurn: false },
						),
					);
					return;
				}
				body = delivery.kind === "none" ? failureNotice(flight) : delivery.text;
			}
			// A non-gated plan released to the model is kept durably; the gate saved its own release.
			if (!gate && flight.content) saveReleased(flight, flight.content);
			// A late auto-resume already sent this plan as the aside: one aside per flight, never two.
			if (flight.gateAsideDelivered) return;
			if (gate && flight.releasedText !== undefined) flight.gateAsideDelivered = true;
			// The aside is the only delivery of a deferred plan: it reads delivered only once the host took it. A refused
			// send keeps `flight.content`, so the plan is not lost, and the same submission's next run delivers it inline.
			if (!(await sendAside(flight, planMessage(body, flight.view)))) {
				flight.deferred = false;
				flight.gateAsideDelivered = false;
				if (flight.content) barWrite(flight.generation, () => store.skipped("aside failed", now()));
				return;
			}
			if (flight.content)
				barWrite(flight.generation, () => store.delivered("aside", flight.view, now()));
			if (flight.content && body === flight.content) markPlanDelivered(flight);
		};

		const start = (
			request: OmpPlanRequest,
			submission: number,
			ctx: ExtensionContext | undefined,
			identity: {
				live?: LiveTarget;
				intent?: FlightIntent;
				selectors?: TrackedQuery;
				tracked?: boolean;
			},
			limitMs: number,
		): Flight => {
			const previous = flights.get(request.sessionId);
			const generation = ++latestGeneration;
			const outcome = Promise.withResolvers<OmpPlan>();
			const flight: Flight = {
				sessionId: request.sessionId,
				cwd: request.cwd,
				submission,
				prompt: request.prompt,
				...identity,
				thinkingLevel: request.thinkingLevel,
				ctx,
				controller: new AbortController(),
				result: outcome.promise,
				deferred: false,
				generation,
				settled: false,
				cancelled: false,
				finishFlight: (result) => {
					const timer = flight.deadlineTimer;
					if (timer !== undefined) {
						timers.clearTimeout(timer);
						flight.deadlineTimer = undefined;
					}
					outcome.resolve(result);
				},
				deadlineTimer: undefined,
				timedOut: false,
				content: "",
				startedAt: clock.now(),
			};
			const gating = gateSettings();
			if (gating.enabled) {
				flight.gate = new CompletionGate({
					inactivityMs: gating.inactivityMs,
					timers: options.gate?.timers ?? platformTimers,
					// The watchdog is loud: the planner is stopped, the user sees why, and nothing is applied silently.
					onStall: (reason) => {
						flight.timedOut = true;
						guard(() => flight.finishFlight({ context: "" }));
						guard(() => flight.controller.abort());
						guard(() => flight.ctx?.ui?.notify?.(gateStalled(reason), "error"));
						guard(() =>
							pi.sendMessage(
								{ content: gateStalled(reason), display: true },
								{ triggerTurn: false },
							),
						);
					},
				});
				// Late Plan auto-resume: `onProgress` is the gate's only later effect. A `waiting_for_plan`
				// arms the flight; a later `ready` delivers the released Plan as the one aside. Deferred to
				// a microtask so the `ready` emit inside `gateDelivery`'s own transition cannot reenter it.
				flight.gate.onProgress((progress) => {
					if (progress.state === "waiting_for_plan") {
						flight.gateWaiting = true;
						// A quarantine revoked the prior release: a revised Plan may be delivered again.
						flight.gateAsideDelivered = false;
						flight.releasedText = undefined;
						flight.releasedPlan = undefined;
						flight.deliveredInline = false;
						return;
					}
					if (progress.state !== "ready" || !flight.gateWaiting) return;
					void Promise.resolve()
						.then(() => deliverLateGatePlan(flight))
						.catch(() => {
							// reason: a failing late delivery must never break the host; the gate itself already reported the transition
						});
				});
			}
			// Subscribed before the callback boundary below: cancelling the previous flight runs its abort
			// listeners synchronously, and a reentrant cancellation of this flight still settles through the
			// existing outcome with no second subscription.
			void flight.result
				.then((result) => settle(flight, result))
				.catch((error: unknown) => {
					// A settlement that fails must not vanish: the failure is warned, and the model is told the plan did not reach it.
					const warning = planFailedNotice(`its delivery failed: ${errorText(error)}`);
					guard(() => flight.ctx?.ui?.notify?.(warning, "warning"));
				});
			// Registered before the planner runs, so a progress callback that fires at once already finds its flight.
			flights.set(request.sessionId, flight);
			if (previous) {
				cancel(previous, SUPERSEDED);
				// The superseded flight's observed resolution is stale; the new flight observes its own.
				resolutions.delete(request.sessionId);
			}
			// A reentrant session/model cancellation of this flight during the previous abort runs synchronously
			// above: a flight that lost ownership there admits no planner and schedules no outer timer.
			if (flight.cancelled) return flight;
			guard(() => store.setLiveSession(request.sessionId));
			guard(() => store.begin(now()));
			const onEvent = (event: ProgressEvent) =>
				guard(() => {
					flight.gate?.touch();
					if (flight.timedOut || flight.settled || !owns(flight)) return;
					if ((event.type === "begin" || event.type === "end") && event.modelResolution)
						observe(flight.sessionId, event.modelResolution);
					if (event.type === "activity") {
						barWrite(generation, () => {
							if (shutDown) return;
							const notice = toActivityNotice(event.notice);
							if (!notice) return;
							guard(() =>
								pi.sendMessage(
									{
										customType: ACTIVITY_TYPE,
										content: truncateToWidth(activityFallbackLine(notice), UI_FALLBACK_COLS),
										display: true,
										details: notice,
									},
									ACTIVITY_DELIVERY,
								),
							);
						});
					}
					barWrite(generation, () => store.apply(event));
					if (event.type === "end" && event.detail) flight.endDetail = event.detail;
				});
			// The outer deadline exists only for an explicit positive maxRunMs; omitted and zero leave planning unbounded.
			// A positive deadline still settles independently of provider cooperation; only the inline race keeps the flight running.
			if (limitMs > 0) {
				const timer = timers.setTimeout(() => {
					flight.timedOut = true;
					flight.finishFlight({ context: "" });
					guard(() => flight.controller.abort());
				}, limitMs);
				// Like the AbortSignal.timeout it replaces, the limit alone never keeps a process alive.
				(timer as { unref?: () => void } | undefined)?.unref?.();
				flight.deadlineTimer = timer;
			}
			try {
				plan(
					{
						...request,
						deadline: limitMs > 0 ? clock.now() + limitMs : undefined,
						isCurrent: () => !flight.timedOut && !flight.settled && current(flight),
						onUplift: (handoff) => {
							flight.early = handoff;
							flight.gate?.touch();
						},
					},
					flight.controller.signal,
					onEvent,
				).then(flight.finishFlight, (error: unknown) => {
					flight.endDetail = `the planner failed: ${errorText(error)}`;
					flight.finishFlight({ context: "" });
				});
			} catch (error) {
				// A planner that cannot start finishes the flight with empty context; the cause is kept as its detail.
				flight.endDetail = `the planner could not start: ${errorText(error)}`;
				flight.finishFlight({ context: "" });
			}
			return flight;
		};

		/** A new flight: one live Model and thinking-level snapshot, captured config/control, and the host runtime. */
		const launch = (
			ctx: ExtensionContext | undefined,
			base: { prompt: string; cwd: string; sessionId: string; stateDir: string },
			submission: number,
			live: LiveTarget | undefined,
			thinkingLevel: SessionThinkingLevel | undefined,
			captured: { config?: UltrathinkConfig; control?: ControlState; intent?: FlightIntent },
			limitMs: number = maxRunMs,
		): Flight => {
			let snapshot: LiveTarget | undefined;
			try {
				snapshot = live && { model: snapshotModel(live.model), source: live.source };
			} catch {
				// reason: a model that cannot be snapshotted launches without a model snapshot
				snapshot = undefined;
			}
			const runtime = nativeRuntime(ctx);
			// A live Model that cannot be snapshotted whole is never planned on a partial copy: native is unavailable.
			const selectors = runtime && (snapshot || !live) ? trackQuery(runtime.models) : undefined;
			const request: OmpPlanRequest = {
				...base,
				...(snapshot ? { model: snapshot.model, modelSource: snapshot.source } : {}),
				...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
				...(runtime && selectors
					? { native: { models: selectors.models, modelRegistry: runtime.modelRegistry } }
					: {}),
				...(captured.config ? { config: captured.config } : {}),
				...(captured.control ? { control: captured.control } : {}),
			};
			const flight = start(
				request,
				submission,
				ctx,
				{
					live: snapshot,
					intent: captured.intent,
					selectors,
					tracked: trackedOf(captured.config, captured.control),
				},
				limitMs,
			);
			// The same arguments again, with the budget left: a failed planner's relaunch and a deferred relaunch both come through here.
			flight.relaunch = (remainingMs) =>
				launch(flight.ctx, base, submission, live, thinkingLevel, captured, remainingMs);
			return flight;
		};

		/**
		 * AgentSwarm auto-run: with `swarm.autoRun` on (user files only, default off) an SDLC-sounding prompt in a
		 * top-level session fans out one detached lane for it, published exactly like the /ultrathink-swarm spawn
		 * branch. Explicit /commands, child sessions, unconfigured swarm roots and repeat submissions never spawn;
		 * the first-word `isSdlcPrompt` gate stays as the cheap pre-gate, then Swarm's own classifier is asked about
		 * the exact lane text (a `skip` verdict, a duplicate of a live lane and the live-lane cap all refuse; an
		 * unanswered classifier spawns). Every skip is silent and a failure never breaks prompt submission. When a
		 * lane actually started it owns the request: the quick suppression /ultrathink-quick arms makes the
		 * session's own planning skip the submission, and the caller returns without a plan. Returns `false`
		 * synchronously when any cheap gate fails (a prompt that never auto-runs reaches its planner in the same
		 * tick it always did: the flight lifecycle tests pin that), otherwise a promise of whether the lane owns it;
		 * never rejects.
		 * Fired from `before_agent_start` after its quick bypass, which this host delivers for every submitted prompt.
		 */
		let lastLane = "";
		interface AutoRunStart {
			sessionId: string;
			cwd: string;
			key: string;
			dir: string;
			swarmRoot: string;
			planned: LanePlan[];
		}
		/** Every gate that needs no await; `undefined` means this prompt does not auto-run. */
		const autoRunGate = (
			prompt: string,
			ctx: ExtensionContext | undefined,
		): AutoRunStart | undefined => {
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const cwd = ctx?.cwd || process.cwd();
			// Dedupe per session+cwd+prompt: identical resubmissions never double-spawn, while the same text in
			// another session or repo is a fresh request. The key lands only once a lane actually started, so a
			// failed spawn stays retryable.
			const key = `${sessionId}:${cwd}:${prompt}`;
			if (!prompt || prompt.startsWith("/") || key === lastLane) return undefined;
			if (isSubagentSession(ctx, exists)) return undefined;
			if (flightConfig(cwd).swarm?.autoRun !== true) return undefined;
			const root = resolveSwarmRoot(environment.read());
			if ("reason" in root) return undefined;
			if (!isSdlcPrompt(prompt)) return undefined;
			if (!sessionId) return undefined;
			const dir = stateDir(cwd);
			const pstack = resolvePstack(join(environment.read().HOME?.trim() || homedir(), ".cursor"));
			const planned = planLanes([prompt.trim()], {
				cwd,
				stateDir: dir,
				swarmRoot: root.root,
				env: environment.read(),
				pstack,
				// No graphId: auto-run returns before this prompt is planned, so the session's tracked plan
				// belongs to earlier work; Swarm and Substrate mint the lane's own graph.
			});
			return { sessionId, cwd, key, dir, swarmRoot: root.root, planned };
		};
		const autoRunSpawn = async (
			start: AutoRunStart,
			prompt: string,
			ctx: ExtensionContext | undefined,
		): Promise<boolean> => {
			try {
				const { sessionId, cwd, key, dir, swarmRoot, planned } = start;
				const preflight = await filterSpawnable(planned, classifierFor(swarmRoot));
				// The classifier ran across an await: a shut-down extension or a switched session spawns nothing.
				if (shutDown || (ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId) return false;
				// Check, spawn and lane.json write are one locked step (spawnGuarded); the classifier await stays outside.
				const { spawn: plan, handles } = spawnGuarded(preflight.spawn, {
					stateDir: dir,
					cwd,
					cap: maxLanes(environment.read()),
					isAlive: pidAlive,
					spawn: spawnLaneSet,
				});
				if (plan.length === 0) return false; // Refused (not SDLC, duplicate or over the cap): silent, the turn proceeds.
				const started = handles.filter((handle) => handle.pid !== undefined).length;
				if (uiEnabled && ctx?.hasUI && typeof pi.registerMessageRenderer === "function") {
					sendSwarmCard(
						sessionId,
						ctx,
						`Swarm lanes — ${started}/${plan.length} spawned${started > 0 ? " — the AgentSwarm lane owns this request; monitor with /ultrathink-swarm status, do not implement it here" : ""}`,
						toSwarmSpawnCard(handles, plan),
					);
					const notes = laneNotes(handles);
					if (notes.length > 0) sendSessionText(sessionId, ctx, notes.join("\n"));
				} else sendSessionText(sessionId, ctx, formatLaneHandles(handles));
				if (started === 0) return false; // Nothing started: the normal turn proceeds and a resubmission may retry.
				// The lane owns this submission: the caller's early return skips launch's supersede, so cancel any
				// pending plan here — a stale one must not settle into this submission — then arm quick so neither
				// this turn nor a resubmission of the same text plans the request (the quick bypass's bookkeeping).
				const older = flights.get(sessionId);
				if (older) cancel(older, SUPERSEDED);
				lastLane = key;
				quick = { sessionId, text: prompt.trim(), submission: turns.get(sessionId) };
				return true;
			} catch {
				// reason: a failed lane spawn must never reject into prompt submission; the normal turn proceeds
				return false;
			}
		};
		const maybeAutoRun = (
			prompt: string,
			ctx: ExtensionContext | undefined,
		): boolean | Promise<boolean> => {
			let start: AutoRunStart | undefined;
			try {
				start = autoRunGate(prompt, ctx);
			} catch {
				// reason: a gate that throws must never reject into prompt submission; the normal turn proceeds
				return false;
			}
			return start === undefined ? false : autoRunSpawn(start, prompt, ctx);
		};

		/** A dialog that closes sooner than a person could answer is a host with no real dialog, not an answer. */
		const MIN_DIALOG_MS = 250;
		const heldMessage = (content: string): CustomMessage => ({
			customType: PENDING_TYPE,
			content,
			display: true,
			attribution: "agent",
		});
		/** Whether this host shows a modal dialog; omp pauses the handler's 30s cap while one is open. */
		const canDialog = (ctx: ExtensionContext | undefined): boolean =>
			ctx?.hasUI === true &&
			(ctx.mode === "tui" || ctx.mode === "rpc") &&
			typeof ctx.ui?.confirm === "function";

		/**
		 * Holds the handler for the unfinished plan inside a confirm dialog. The dialog pauses omp's handler cap, so the
		 * wait can last as long as the planner needs; the plan settling dismisses it. `start`: the user chose to go on
		 * without the plan. `unsupported`: the dialog closed at once, so this host cannot hold past the cap.
		 */
		const waitInDialog = async (
			flight: Flight,
			ctx: ExtensionContext,
		): Promise<"settled" | "start" | "unsupported"> => {
			for (;;) {
				const dialog = new AbortController();
				const shownAt = now();
				let answer: boolean | undefined;
				const asked = Promise.resolve(
					ctx.ui?.confirm?.(
						"Ultrathink is still planning",
						"The session starts when the complete plan (prompt, graph of thought, issues) is ready. Start now without it?",
						{ signal: dialog.signal },
					),
				).then(
					(value) => {
						answer = value;
						return "answered" as const;
					},
					(error: unknown) => {
						guard(() =>
							ctx.ui?.notify?.(
								planFailedNotice(`the confirmation dialog failed: ${errorText(error)}`),
								"warning",
							),
						);
						return "answered" as const;
					},
				);
				const first = await Promise.race([flight.result.then(() => "settled" as const), asked]);
				if (first === "settled") {
					dialog.abort();
					return "settled";
				}
				if (answer === true) return "start";
				if (now() - shownAt < MIN_DIALOG_MS) return "unsupported";
			}
		};

		/**
		 * Runs one planner attempt raced against `raceMs`. `begin` starts the flight; the race is armed before it, so the
		 * planner's synchronous prefix can never delay arming the delivery timer.
		 */
		const runAttempt = async (
			begin: () => Flight,
		): Promise<{ flight: Flight; result: OmpPlan | null }> => {
			const timeout = Promise.withResolvers<null>();
			const timer = timers.setTimeout(() => timeout.resolve(null), raceMs);
			let flight: Flight;
			try {
				flight = begin();
			} catch (error) {
				timers.clearTimeout(timer);
				throw error;
			}
			try {
				return { flight, result: await Promise.race([flight.result, timeout.promise]) };
			} finally {
				timers.clearTimeout(timer);
			}
		};
		/**
		 * A failed planner earns exactly one relaunch per submission: no plan and no verdict, and nothing cancelled,
		 * stalled, timed out or deliberately skipped the flight. Every other outcome keeps its own notice or silence.
		 */
		const retryDue = (flight: Flight): boolean => {
			if (maxRunMs > 0 && clock.now() - flight.startedAt >= maxRunMs) return false;
			if (
				flight.retried ||
				flight.cancelled ||
				flight.timedOut ||
				deliberateSkip(flight.skipped) ||
				flight.releasedText !== undefined
			)
				return false;
			const gate = flight.gate;
			if (gate)
				return gate.state === "failed_or_cancelled" && gate.verdict === undefined && !gate.stalled;
			return flight.settled && flight.content === "";
		};
		/**
		 * Why a flight produced no plan, as the user reads it. A planner that exceeded its deadline gets the no-plan note;
		 * every other failure gets planFailedNotice with its reason. A deliberate skip keeps the no-plan note too.
		 */
		const failureNotice = (flight: Flight): string =>
			flight.timedOut || deliberateSkip(flight.skipped)
				? NO_PLAN
				: planFailedNotice(
						flight.gate?.reason || flight.endDetail || "the planner produced no plan",
					);
		/** Clears the failed flight's gate clock and launches its prompt once more with the budget left; the new flight carries the retry mark. */
		const retryFailed = (failed: Flight, relaunch: (limitMs: number) => Flight): Flight => {
			failed.gate?.cancel("the planner failed; relaunching the prompt once");
			const remainingMs = maxRunMs > 0 ? maxRunMs - (clock.now() - failed.startedAt) : 0;
			const next = relaunch(remainingMs);
			next.retried = true;
			// The early uplift already went inline: a relaunch that comes back empty ends with the early release, not a failure.
			next.earlyDelivered = failed.earlyDelivered;
			return next;
		};
		/** The record key a flight's plan is stored under; a session with no id has no identity to store under, so none. */
		const planRecordKey = (flight: Flight): string | undefined =>
			flight.sessionId === ""
				? undefined
				: planKey({
						sessionId: flight.sessionId,
						submission: String(flight.submission),
						prompt: flight.prompt,
						cwd: flight.cwd,
					});
		/** Durable copy of a released plan. A store failure never blocks the turn; it is reported as a warning. */
		const saveReleased = (
			flight: Flight,
			text: string,
			identity?: { planId: string; planHash: string },
		): void => {
			const key = planRecordKey(flight);
			if (key === undefined) return;
			try {
				savePlan(stateDir(flight.cwd), {
					key,
					text,
					// A record without a `view` key is unreadable and JSON drops undefined, so an absent view is stored as null.
					view: flight.view ?? null,
					createdAt: new Date(now()).toISOString(),
					// The validated identity rides alongside the body; the body itself is never altered.
					...(identity ? { planId: identity.planId, planHash: identity.planHash } : {}),
				});
			} catch (error) {
				guard(() =>
					flight.ctx?.ui?.notify?.(
						`Ultrathink could not keep this plan for re-delivery: ${errorText(error)}`,
						"warning",
					),
				);
			}
		};
		/** A plan the host took, inline or as an aside: claimed in the store and remembered for this session, so a repeat is refused. */
		const markPlanDelivered = (flight: Flight): void => {
			const key = planRecordKey(flight);
			if (key === undefined) return;
			deliveredKeys.add(key);
			if (claimPlan(stateDir(flight.cwd), key) === "unwritable")
				guard(() => flight.ctx?.ui?.notify?.(STORE_UNWRITABLE, "warning"));
		};
		/** What a recovery found for a flight: a stored plan to deliver now, a store warning, or nothing. */
		type Recovery =
			| { kind: "none" }
			| { kind: "warn"; text: string }
			| { kind: "recovered"; text: string; view: PlanView | undefined; planId?: string; planHash?: string };
		/**
		 * The stored copy of a flight's plan, when this session has not delivered it yet. A key this session already
		 * delivered is refused before any store read; a record written before this instance started is ignored; only a
		 * successful claim delivers. A store that cannot be read or claimed warns, and the stored plan is not re-delivered.
		 */
		const recoverPlan = (flight: Flight): Recovery => {
			const key = planRecordKey(flight);
			if (key === undefined || deliveredKeys.has(key)) return { kind: "none" };
			const dir = stateDir(flight.cwd);
			const loaded = loadPlan(dir, key);
			if (loaded === "absent") return { kind: "none" };
			if (loaded === "unreadable") return { kind: "warn", text: STORE_UNREADABLE };
			if (!(Date.parse(loaded.createdAt) >= instanceStartedAt)) return { kind: "none" };
			const claim = claimPlan(dir, key);
			if (claim === "unwritable") return { kind: "warn", text: STORE_UNWRITABLE };
			if (claim === "lost") return { kind: "none" };
			deliveredKeys.add(key);
			return {
				kind: "recovered",
				text: loaded.text,
				view: isPlanView(loaded.view) ? loaded.view : undefined,
				...(loaded.planId ? { planId: loaded.planId } : {}),
				...(loaded.planHash ? { planHash: loaded.planHash } : {}),
			};
		};
		/** One loud note per flight. A stored plan that never reached the model replaces the note, delivered once; a store warning is appended. */
		const noticeOnce = (flight: Flight, notice: string): BeforeAgentStartResult | undefined => {
			if (flight.noticed || deliberateSkip(flight.skipped)) return undefined;
			flight.noticed = true;
			const recovery = recoverPlan(flight);
			if (recovery.kind === "recovered") {
				flight.releasedText = recovery.text;
				if (recovery.planId && recovery.planHash) flight.releasedPlan = { planId: recovery.planId, planHash: recovery.planHash };
				flight.deliveredInline = true;
				barWrite(flight.generation, () => store.delivered("inline", recovery.view, now()));
				return { message: planMessage(recovery.text, recovery.view) };
			}
			return {
				message: planMessage(recovery.kind === "warn" ? `${notice} ${recovery.text}` : notice),
			};
		};
		/** The message a gated flight's delivery decision puts in front of the model; `none` stays silent. */
		const gatedMessage = (
			flight: Flight,
			delivery: GateDelivery,
			ctx: ExtensionContext,
		): BeforeAgentStartResult | undefined => {
			switch (delivery.kind) {
				case "plan":
					flight.deliveredInline = true;
					// The late auto-resume already sent this plan as the one aside: never repeat it inline.
					if (flight.gateAsideDelivered) return undefined;
					barWrite(flight.generation, () => store.delivered("inline", flight.view, now()));
					markPlanDelivered(flight);
					return { message: planMessage(delivery.text, flight.view) };
				case "hold":
					barWrite(flight.generation, () => store.skipped("plan incomplete", now()));
					guard(() => ctx.ui?.notify?.(delivery.text, "warning"));
					return { message: heldMessage(delivery.text) };
				case "notice":
					return noticeOnce(flight, delivery.text);
				case "none":
					return undefined;
			}
		};

		pi.on("before_agent_start", async (event, ctx) => {
			scheduleMount();
			if (isSubagentSession(ctx, exists)) return;
			// The session the catch-all may cancel a registered flight of; set once the handler knows it.
			let failedSession = "";
			try {
				const prompt = event?.prompt ?? "";
				const cwd = ctx?.cwd || process.cwd();
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				failedSession = sessionId;
				guard(() => store.setLiveSession(sessionId));
				const submission = turns.get(sessionId) ?? 0;
				if (quick) {
					if (
						quick.sessionId === sessionId &&
						quick.text === prompt.trim() &&
						(quick.submission ?? submission) === submission
					) {
						// The quick message is now the session's latest submission; an older pending plan must not land in it.
						const older = quick.submission === undefined ? flights.get(sessionId) : undefined;
						if (older) cancel(older, SUPERSEDED);
						quick.submission = submission;
						return;
					}
					quick = undefined;
				}
				// After the quick bypass, so an armed quick message never spawns a lane. When one did spawn it owns
				// this submission: return without a plan so the planner never races the lane.
				const autoRun = maybeAutoRun(prompt, ctx);
				let lane = false;
				if (typeof autoRun === "boolean") lane = autoRun;
				else {
					lane = await autoRun;
					// The spawn step awaited the classifier: a session that shut down or switched meanwhile starts no
					// plan (the shutdown already cleared the flights). The synchronous path never reaches this.
					if (shutDown || (ctx?.sessionManager?.getSessionId?.() ?? "") !== sessionId) return;
				}
				if (lane) return;
				const dir = stateDir(cwd);
				let captured: { config?: UltrathinkConfig; control?: ControlState; intent?: FlightIntent } =
					{};
				try {
					const config = flightConfig(cwd);
					const control = readControl(dir);
					captured = { config, control, intent: intentOf(config, control) };
				} catch {
					// reason: fail-open: the planner loads its own config and control
				}
				// Named legacy routes retain their own effort settings; only native planning inherits the session level.
				const namedEngine = captured.intent && captured.intent.engine !== "auto";
				const thinkingLevel = namedEngine ? undefined : pi.getThinkingLevel?.();
				const live = observeLive(ctx);
				// One more launch of this prompt with the arguments this call captured; a relaunch passes the budget left.
				const launchPlan = (launchCtx: ExtensionContext | undefined, limitMs?: number): Flight =>
					launch(
						launchCtx,
						{ prompt, cwd, sessionId, stateDir: dir },
						submission,
						live,
						thinkingLevel,
						captured,
						limitMs,
					);
				const existing = flights.get(sessionId);
				// A follow-up the planner would skip (`continue`, an ack, a command) must not cancel the plan still being
				// built for the real prompt: starting a flight supersedes the old one, and the skipped one delivers nothing.
				if (
					existing &&
					!existing.settled &&
					!existing.cancelled &&
					existing.prompt !== prompt &&
					wouldSkipPlanning(
						{ prompt, cwd, host: "omp", session_id: sessionId },
						{ config: captured.config, control: captured.control, stateDir: dir },
					)
				)
					return;
				let same =
					existing?.submission === submission && existing.prompt === prompt && existing.cwd === cwd
						? existing
						: undefined;
				// Reuse only an unchanged target: the whole live Model, session effort, effective route/provenance and
				// native selector results. Otherwise the old flight is suppressed and this prompt plans afresh.
				if (same) {
					const runtime = nativeRuntime(ctx);
					const unchanged =
						sameLive(same.live, live) &&
						same.thinkingLevel === thinkingLevel &&
						sameData(same.intent, captured.intent) &&
						(!same.selectors || (runtime !== undefined && !same.selectors.changed(runtime.models)));
					if (!unchanged) {
						cancel(same, same.thinkingLevel !== thinkingLevel ? THINKING_CHANGED : MODEL_CHANGED);
						same = undefined;
					}
				}
				if (same?.deferred)
					return same.settled || same.earlyDelivered
						? undefined
						: { message: same.gate ? heldMessage(GATE_HOLD) : pendingMessage() };
				if (same?.settled && !retryDue(same)) {
					if (same.gate) return gatedMessage(same, gateDelivery(same, same.gate), ctx);
					if (same.content) {
						same.deliveredInline = true;
						markPlanDelivered(same);
						return { message: planMessage(same.content, same.view) };
					}
					return noticeOnce(same, failureNotice(same));
				}
				// The race is armed before the flight starts; a failed planner is relaunched once for this submission.
				const reuse = same;
				let planned = await runAttempt(() => reuse ?? launchPlan(ctx));
				for (;;) {
					const { flight, result } = planned;
					if (flight.cancelled) return cancelledOutcome(flight);
					const gate = flight.gate;
					if (gate) {
						// The turn must not start on a partial plan: wait for the whole one (dialog) or hold explicitly.
						if (result === null && !flight.settled) {
							const waited = canDialog(ctx) ? await waitInDialog(flight, ctx) : "unsupported";
							if (flight.cancelled) return cancelledOutcome(flight);
							if (waited === "start") {
								cancel(flight, "cancelled: the user started without the plan");
								return;
							}
							if (waited === "unsupported" && !flight.settled) {
								// No dialog: the 30s cap cannot be held past. The plan then arrives as the one aside.
								flight.deferred = true;
								barWrite(flight.generation, () => store.pending());
								return { message: heldMessage(GATE_HOLD) };
							}
						}
						if (retryDue(flight)) {
							planned = await runAttempt(() =>
								retryFailed(flight, (limitMs) => launchPlan(ctx, limitMs)),
							);
							continue;
						}
						return gatedMessage(flight, gateDelivery(flight, gate), ctx);
					}
					if (result === null) {
						// Delivery only switches to pending and aside; the flight keeps running under its own lifetime.
						flight.deferred = true;
						const early = flight.early;
						if (early) {
							// A final uplift goes inline now; the whole final plan follows as the one aside.
							flight.earlyDelivered = true;
							barWrite(flight.generation, () => store.pending());
							return {
								message: planMessage(
									`${early.context}\n\nThe rest of the plan follows as an aside when planning finishes; until then, only read and investigate.`,
								),
							};
						}
						barWrite(flight.generation, () => store.pending());
						return { message: pendingMessage() };
					}
					if (retryDue(flight)) {
						planned = await runAttempt(() =>
							retryFailed(flight, (limitMs) => launchPlan(ctx, limitMs)),
						);
						continue;
					}
					if (!result.context) return noticeOnce(flight, failureNotice(flight));
					flight.deliveredInline = true;
					saveReleased(flight, result.context);
					markPlanDelivered(flight);
					barWrite(flight.generation, () => store.delivered("inline", result.view, now()));
					return { message: planMessage(result.context, result.view) };
				}
			} catch (error) {
				// The handler failed outside its flight's own handling: a flight it registered is cancelled, and the prompt
				// proceeds without the uplift. The cause is shown, redacted and capped.
				const stale = flights.get(failedSession);
				if (stale) cancel(stale, "cancelled: planning failed inside the handler");
				return {
					message: planMessage(
						planFailedNotice(`an internal error stopped planning: ${errorText(error)}`),
					),
				};
			}
		});
	};
}

export default createOmpExtension();
