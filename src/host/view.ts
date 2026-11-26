// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Display-only projection of a planned session for host UIs (Omp transcript
 * cards), and of a model resolution record for every display surface. Pure:
 * the model never reads this, it reads the hook context.
 */
import type { SessionRecord } from "../claude/state.ts";
import {
	displayId,
	displayLabel,
	displayToken,
	OPAQUE_MODEL,
	OPAQUE_PROVIDER,
} from "../claude/output.ts";
import { dependencyLevels } from "../think/graph.ts";
import type { ModelResolution } from "./engine.ts";
import { isRecord } from "../shared.ts";
import type { TurnPanels } from "../recall/turn-panels.ts";

/** Closed set of delivery outcomes (SCR-DeliveryOutcome, contract `GET /delivery-status`): no silent loss, every outcome is one of these 5 named states. */
export type DeliveryState =
	| "injected"
	| "retrying"
	| "drained"
	| "timed-out"
	| "dropped-with-reason";

const DELIVERY_STATES: Record<DeliveryState, true> = {
	injected: true,
	retrying: true,
	drained: true,
	"timed-out": true,
	"dropped-with-reason": true,
};

const isNonNegativeInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

export interface PlanView {
	root: string;
	source: "llm" | "fallback";
	/** Display label of the planning selection: the resolution record's safe label, else the recorded engine label. */
	engine?: string;
	/** The selection's safe record, projected for display (§9 path 3): engine request kept apart from model state. */
	modelResolution?: ModelResolution;
	/** The information panels of the plan's prompt; on by default, absent only when `panels.informationPanels` is false or no lookup ran. */
	panels?: TurnPanels;
	/** The complete uplifted prompt XML for the second card section beneath the plan summary; absent when the record carries none. */
	fullPromptXml?: string;
	/** Name of the skill the user invoked, when the plan covers a skill invocation. */
	skill?: string;
	graphId?: string;
	goal?: string;
	elapsedMs: number;
	nodes: Array<{
		id: string;
		title: string;
		kind: string;
		wave: number;
		dependsOn: string[];
		conclusion?: string;
		issue?: { identifier: string; url: string };
		notionUrl?: string;
		steps: Array<{ step: number; title: string; identifier?: string; url?: string }>;
	}>;
	waves: string[][];
	clarifications: Array<{
		id: string;
		question: string;
		blocking: boolean;
		answer?: string;
		recommended?: string;
	}>;
	tracking?: {
		status: "complete" | "partial" | "failed";
		notionTaskUrl?: string;
		errors: string[];
		issues: number;
		subIssues: number;
	};
	/** Pipeline stages that ran degraded (record.degraded), shown on the plan card; absent when none did. */
	degraded?: string[];
	/** Per-stage line counts of the Double Uplift (contract `StageMetrics`), projected from the record when the pipeline recorded them; absent on older records. */
	stageMetrics?: { stages: Array<{ stage: string; lines: number }>; densityLossStage?: string };
	/** 10-prompt accounting line `1 graph + N node chains + 2 uplifts = N+3`, derived from the node count; absent when the graph has no nodes. */
	promptAccounting?: string;
	/** Dispatch gate state (contract `DispatchGate`), projected from the record when recorded; derived from the final prompt otherwise. */
	dispatchGate?: { specialistsBeforeFinal: number; finalPromptLanded: boolean };
	/** Force-injected prompt evidence (SCR-ForceInjectedPrompt), projected from the record when recorded; absent on older records. The landed prompt text itself renders via `fullPromptXml`. */
	forceInjected?: { charCount: number; todoEntry: string; retryLog: string[] };
	/** Closed-set delivery outcome (SCR-DeliveryOutcome, contract `GET /delivery-status`), projected from the record when recorded. */
	deliveryOutcome?: { state: DeliveryState; reason?: string };
	/** Force-stop drain outcome (SCR-ForceStopDrain, contract `POST /drain`), projected from the record when recorded; `manual-override` only ever carries its logged reason. */
	forceStop?: {
		state: "drained" | "timed-out" | "manual-override";
		elapsedS: number;
		reason?: string;
	};
	/** Order gate state (SCR-OrderGate, contract `POST /order-gate`), projected from the record when recorded. */
	orderGate?: { allowed: boolean; heldReasons: string[]; confirmedAt?: string };
	/** Race-check scenario results (SCR-RaceChecks), projected from the record when recorded. */
	raceChecks?: {
		midFlight: { injectedPrompts: number; lostPlans: number };
		newPrompt: { drainedOrchestrations: number; landedPrompts: number; drops: number };
	};
}

/**
 * Project the record's `stageMetrics` (contract `StageMetrics` shape) defensively: the record is persisted session
 * data, so anything that is not an array of `{stage: string, lines: non-negative integer}` rows is dropped, never guessed.
 */
function projectStageMetrics(record: unknown): PlanView["stageMetrics"] {
	if (!isRecord(record)) return undefined;
	const value = record.stageMetrics;
	if (!isRecord(value) || !Array.isArray(value.stages)) return undefined;
	const stages: Array<{ stage: string; lines: number }> = [];
	for (const row of value.stages) {
		if (!isRecord(row)) continue;
		if (typeof row.stage !== "string" || row.stage === "") continue;
		if (typeof row.lines !== "number" || !Number.isInteger(row.lines) || row.lines < 0) continue;
		stages.push({ stage: row.stage, lines: row.lines });
	}
	if (stages.length === 0) return undefined;
	return {
		stages,
		...(typeof value.densityLossStage === "string" && value.densityLossStage !== ""
			? { densityLossStage: value.densityLossStage }
			: {}),
	};
}

/** Project the record's `dispatchGate` (contract `DispatchGate` shape) defensively; absent when the record carries none. */
function projectDispatchGate(record: unknown): PlanView["dispatchGate"] {
	if (!isRecord(record)) return undefined;
	const value = record.dispatchGate;
	if (!isRecord(value)) return undefined;
	if (
		typeof value.specialistsBeforeFinal !== "number" ||
		!Number.isInteger(value.specialistsBeforeFinal) ||
		value.specialistsBeforeFinal < 0 ||
		typeof value.finalPromptLanded !== "boolean"
	)
		return undefined;
	return {
		specialistsBeforeFinal: value.specialistsBeforeFinal,
		finalPromptLanded: value.finalPromptLanded,
	};
}

/** Project `record.forceInjected` (contract `POST /force-inject` evidence) defensively; absent when the record carries none. `charCount` is the landed prompt's character count, `todoEntry` the one TODO update, `retryLog` one line per failed attempt — 0 silent drops. */
function projectForceInjected(record: unknown): PlanView["forceInjected"] {
	if (!isRecord(record)) return undefined;
	const value = record.forceInjected;
	if (!isRecord(value) || !isNonNegativeInt(value.charCount)) return undefined;
	if (typeof value.todoEntry !== "string" || value.todoEntry === "") return undefined;
	const retryLog = Array.isArray(value.retryLog)
		? value.retryLog.filter((line): line is string => typeof line === "string" && line !== "")
		: [];
	return { charCount: value.charCount, todoEntry: value.todoEntry, retryLog };
}

/** Project `record.deliveryOutcome` (contract `GET /delivery-status`) defensively: only the 5 closed-set states; `dropped-with-reason` always carries its reason. */
function projectDeliveryOutcome(record: unknown): PlanView["deliveryOutcome"] {
	if (!isRecord(record)) return undefined;
	const value = record.deliveryOutcome;
	if (!isRecord(value) || typeof value.state !== "string") return undefined;
	if (!Object.hasOwn(DELIVERY_STATES, value.state)) return undefined;
	const state = value.state as DeliveryState;
	const reason = typeof value.reason === "string" && value.reason !== "" ? value.reason : undefined;
	if (state === "dropped-with-reason" && reason === undefined) return undefined;
	return { state, ...(reason !== undefined ? { reason } : {}) };
}

/** Project `record.forceStop` (contract `POST /drain`) defensively: 30s bound; `manual-override` (the kill-switch bypass) only ever projects with its one logged reason. */
function projectForceStop(record: unknown): PlanView["forceStop"] {
	if (!isRecord(record)) return undefined;
	const value = record.forceStop;
	if (!isRecord(value) || typeof value.state !== "string") return undefined;
	if (value.state !== "drained" && value.state !== "timed-out" && value.state !== "manual-override")
		return undefined;
	const elapsedS =
		typeof value.elapsedS === "number" && Number.isFinite(value.elapsedS) && value.elapsedS >= 0
			? value.elapsedS
			: 0;
	const reason = typeof value.reason === "string" && value.reason !== "" ? value.reason : undefined;
	if (value.state === "manual-override" && reason === undefined) return undefined;
	return { state: value.state, elapsedS, ...(reason !== undefined ? { reason } : {}) };
}

/** Project `record.orderGate` (contract `POST /order-gate`) defensively: 1 held reason per refused attempt, confirmation timestamp. */
function projectOrderGate(record: unknown): PlanView["orderGate"] {
	if (!isRecord(record)) return undefined;
	const value = record.orderGate;
	if (!isRecord(value) || typeof value.allowed !== "boolean") return undefined;
	const heldReasons = Array.isArray(value.heldReasons)
		? value.heldReasons.filter((line): line is string => typeof line === "string" && line !== "")
		: [];
	return {
		allowed: value.allowed,
		heldReasons,
		...(typeof value.confirmedAt === "string" && value.confirmedAt !== ""
			? { confirmedAt: value.confirmedAt }
			: {}),
	};
}

/** Project `record.raceChecks` defensively; absent unless both scenario counts are complete and non-negative. */
function projectRaceChecks(record: unknown): PlanView["raceChecks"] {
	if (!isRecord(record)) return undefined;
	const value = record.raceChecks;
	if (!isRecord(value) || !isRecord(value.midFlight) || !isRecord(value.newPrompt))
		return undefined;
	const mid = value.midFlight;
	const fresh = value.newPrompt;
	if (!isNonNegativeInt(mid.injectedPrompts) || !isNonNegativeInt(mid.lostPlans)) return undefined;
	if (
		!isNonNegativeInt(fresh.drainedOrchestrations) ||
		!isNonNegativeInt(fresh.landedPrompts) ||
		!isNonNegativeInt(fresh.drops)
	)
		return undefined;
	return {
		midFlight: { injectedPrompts: mid.injectedPrompts, lostPlans: mid.lostPlans },
		newPrompt: {
			drainedOrchestrations: fresh.drainedOrchestrations,
			landedPrompts: fresh.landedPrompts,
			drops: fresh.drops,
		},
	};
}

const NODE_PREFIX = /^\[[^\]]*\]\s*/;

/**
 * Display projection of a model resolution record (§6, §9, D-11): only the allowlisted fields, the label through
 * `displayLabel`, ids through `displayId` and fixed-vocabulary values as plain tokens. A record read back from disk or
 * carried between processes brings no extra or unsafe content into a view, status line or summary. Anything that is not
 * a version 1.0.0 record projects to undefined, so a malformed saved record shows nothing instead of failing the surface.
 */
export function projectResolution(value: unknown): ModelResolution | undefined {
	if (!isRecord(value) || value.version !== "1.0.0" || !isRecord(value.engineSelection))
		return undefined;
	const selection = value.engineSelection;
	const state = displayToken(value.state);
	const host = displayToken(value.host);
	const source = displayToken(value.source);
	const reason = displayToken(value.reason);
	const engine = displayToken(selection.engine);
	const requestSource = displayToken(selection.source);
	if (!state || !host || !source || !reason || !engine || !requestSource) return undefined;
	if (typeof selection.nativeOptOut !== "boolean" || typeof value.modelKnown !== "boolean")
		return undefined;
	const transport = displayToken(value.transport);
	const defaultSource = displayToken(value.defaultSource);
	const api = typeof value.api === "string" ? displayId(value.api, OPAQUE_PROVIDER) : undefined;
	const providerType =
		typeof value.providerType === "string"
			? displayId(value.providerType, OPAQUE_PROVIDER)
			: undefined;
	const provider =
		typeof value.provider === "string" ? displayId(value.provider, OPAQUE_PROVIDER) : undefined;
	const modelId =
		typeof value.modelId === "string" ? displayId(value.modelId, OPAQUE_MODEL) : undefined;
	return {
		version: "1.0.0",
		state,
		host,
		...(transport ? { transport } : {}),
		source,
		reason,
		engineSelection: { engine, source: requestSource, nativeOptOut: selection.nativeOptOut },
		...(defaultSource ? { defaultSource } : {}),
		...(api ? { api } : {}),
		...(providerType ? { providerType } : {}),
		...(provider ? { provider } : {}),
		...(modelId ? { modelId } : {}),
		modelKnown: value.modelKnown,
		label: displayLabel(value.label),
	} as ModelResolution;
}

export function buildPlanView(record: SessionRecord, elapsedMs: number): PlanView {
	const { graph, plan, tracking } = record;
	const levels = graph ? dependencyLevels(graph.nodes) : [];
	const waveOf = new Map<string, number>();
	levels.forEach((level, index) => {
		for (const node of level) waveOf.set(node.id, index);
	});
	const nodes: PlanView["nodes"] = (graph?.nodes ?? []).map((node) => {
		const issue = tracking?.linear.nodes[node.id];
		const steps = (plan?.subIssues ?? [])
			.filter((row) => row.nodeId === node.id)
			.map((row) => {
				const ref = tracking?.linear.steps[`${node.id}.${row.step}`];
				return {
					step: row.step,
					title: row.item.replace(NODE_PREFIX, ""),
					...(ref ? { identifier: ref.identifier, url: ref.url } : {}),
				};
			});
		const notionUrl = tracking?.notion.nodes[node.id];
		return {
			id: node.id,
			title: node.title,
			kind: node.kind,
			wave: waveOf.get(node.id) ?? 0,
			dependsOn: [...node.dependsOn],
			...(node.conclusion ? { conclusion: node.conclusion } : {}),
			...(issue ? { issue: { identifier: issue.identifier, url: issue.url } } : {}),
			...(notionUrl ? { notionUrl } : {}),
			steps,
		};
	});
	const clarifications = (record.clarifications ?? []).map((c) => {
		const recommended = c.options.find((o) => o.label === c.default)?.label ?? c.default;
		return {
			id: c.id,
			question: c.question,
			blocking: c.blocking,
			...(c.answer ? { answer: c.answer } : {}),
			...(recommended ? { recommended } : {}),
		};
	});
	const modelResolution = projectResolution(record.modelResolution);
	return {
		root: record.result.root,
		source: record.result.source,
		...(modelResolution
			? { engine: modelResolution.label, modelResolution }
			: record.engine
				? { engine: displayLabel(record.engine) }
				: {}),
		...(record.skill ? { skill: record.skill.name } : {}),
		...(plan?.graphId ? { graphId: plan.graphId } : {}),
		...(graph?.goal ? { goal: graph.goal } : {}),
		...(record.result.xml ? { fullPromptXml: record.result.xml } : {}),
		elapsedMs,
		nodes,
		waves: levels.map((level) => level.map((node) => node.id)),
		clarifications,
		...(tracking
			? {
					tracking: {
						status: tracking.status,
						...(tracking.notion.taskUrl ? { notionTaskUrl: tracking.notion.taskUrl } : {}),
						errors: [...tracking.errors],
						issues: Object.keys(tracking.linear.nodes).length,
						subIssues: Object.keys(tracking.linear.steps).length,
					},
				}
			: {}),
		...(record.degraded?.length ? { degraded: [...record.degraded] } : {}),
		...(projectStageMetrics(record) ? { stageMetrics: projectStageMetrics(record) } : {}),
		...(nodes.length > 0
			? {
					promptAccounting: `1 graph + ${nodes.length} node chains + 2 uplifts = ${nodes.length + 3}`,
				}
			: {}),
		...(projectDispatchGate(record)
			? { dispatchGate: projectDispatchGate(record) }
			: record.result.xml
				? { dispatchGate: { specialistsBeforeFinal: 0, finalPromptLanded: true } }
				: {}),
		...(projectForceInjected(record) ? { forceInjected: projectForceInjected(record) } : {}),
		...(projectDeliveryOutcome(record) ? { deliveryOutcome: projectDeliveryOutcome(record) } : {}),
		...(projectForceStop(record) ? { forceStop: projectForceStop(record) } : {}),
		...(projectOrderGate(record) ? { orderGate: projectOrderGate(record) } : {}),
		...(projectRaceChecks(record) ? { raceChecks: projectRaceChecks(record) } : {}),
	};
}

/**
 * Chat/session sync view (SPE-37787, n4): the plugin-visible dual of the plan card. It travels as a custom
 * message through the chat/session channel (create_chat_tab / steer / resume / injection handoff), never
 * through a NativeDialog select — a native select forces the selected text to echo as speech into chat.
 * Every row carries both the `wave_id` and the `node_id` the cancel path hands off.
 */
interface ChatSyncRow {
	wave_id: string;
	node_id: string;
	title?: string;
}

/**
 * Display-only chat/session sync view; `syncDone` is the injection gate's verdict (`isSyncTodosDone` in
 * `src/track/sync-todos.ts`): the caller passes the record check, this projection only carries it.
 */
export interface ChatSyncView {
	graphId?: string;
	sessionId: string;
	/** Session kind: `direct` (create_chat_tab) or `managed` (steer / resume / injection handoff). */
	kind: "direct" | "managed";
	syncDone: boolean;
	rows: ChatSyncRow[];
}

/** Project a plan view into chat-visible wave/node rows. Nodes are never invented or dropped: every entry of
 * `view.waves` becomes one row, with its title when the plan carries one. */
export function buildChatSyncView(
	view: PlanView,
	options: { sessionId: string; kind: "direct" | "managed"; syncDone: boolean },
): ChatSyncView {
	const titleById = new Map(view.nodes.map((node) => [node.id, node.title]));
	const rows = view.waves.flatMap((wave, index) =>
		wave.map((nodeId) => {
			const title = titleById.get(nodeId);
			return {
				wave_id: `w${index + 1}`,
				node_id: nodeId,
				...(title ? { title } : {}),
			};
		}),
	);
	return {
		...(view.graphId ? { graphId: view.graphId } : {}),
		sessionId: options.sessionId,
		kind: options.kind,
		syncDone: options.syncDone,
		rows,
	};
}

/** Chat-sync view guard; message details are untrusted persisted data, so anything else is not a view. */
export function isChatSyncView(value: unknown): value is ChatSyncView {
	if (!isRecord(value)) return false;
	if (!Array.isArray(value.rows)) return false;
	if (typeof value.sessionId !== "string" || value.sessionId === "") return false;
	if (value.kind !== "direct" && value.kind !== "managed") return false;
	if (typeof value.syncDone !== "boolean") return false;
	if (value.graphId !== undefined && typeof value.graphId !== "string") return false;
	return value.rows.every(
		(row) =>
			isRecord(row) &&
			typeof row.wave_id === "string" &&
			row.wave_id !== "" &&
			typeof row.node_id === "string" &&
			row.node_id !== "",
	);
}
