// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Producer-side success root for injection (SPE-37792).
 *
 * `syncTodos(plan)` is issued once the uplifted prompt is produced. It derives
 * the plan's wave list (one todo per execution wave), persists those todos as
 * the session's `recall.lastTodos` snapshot — the same `TodoSnapshotItem`
 * convention the hook's TodoWrite phase-boundary trigger diffs against — and
 * only then marks the invocation done (`SessionRecord.syncTodos`). A caller
 * (injection / ForceInjector) may treat delivery as ready only once the
 * persisted marker names the plan's graph id: completion is the write landing
 * on disk, not the call returning.
 *
 * Fail-open: the write is retried once; a second failure is logged and
 * reported in the result, never thrown. The session record must already exist
 * (the hook persists it before calling this); a missing record is a failed
 * attempt, not an exception.
 */
import {
	HOOK_LOCK,
	serializeRecallState,
	updateSession,
	type SessionRecord,
	type TodoSnapshotItem,
} from "../claude/state.ts";
import { createRecallState } from "../recall/engine.ts";
import type { TrackPlan } from "./types.ts";
import type { WorkflowWave } from "../think/graph.ts";

/** Outcome of one `syncTodos` invocation. `ok` means the marker and todos are on disk. */
export interface SyncTodosResult {
	ok: boolean;
	graphId: string;
	waves: WorkflowWave[];
	todos: TodoSnapshotItem[];
	attempts: number;
	error?: string;
}
export interface SyncTodosDeps {
	stateDir: string;
	sessionId: string;
	log?: (message: string) => void;
	now?: () => number;
	/** Test seam: replaces the locked session write. Defaults to `updateSession`. */
	update?: typeof updateSession;
	/**
	 * Master-switch gate for the `recall.lastTodos` write (default `true`, so
	 * existing callers keep today's behavior). When `false` (recall disabled),
	 * only the `syncTodos` marker lands — no recall record is synthesized, so
	 * `record.recall` stays `undefined` exactly as the master-switch-off
	 * contract requires. The marker itself is never gated: `isSyncTodosDone`
	 * must keep working for recall-off sessions.
	 */
	recallOn?: boolean;
}

/** Node ids the plan tracks, in issue order, de-duplicated (missing ids never invent a wave). */
function planNodeIds(plan: TrackPlan): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const issue of plan.issues) {
		if (!seen.has(issue.nodeId)) {
			seen.add(issue.nodeId);
			ids.push(issue.nodeId);
		}
	}
	if (ids.length === 0) {
		for (const issue of plan.linearIssues) {
			if (!seen.has(issue.nodeId)) {
				seen.add(issue.nodeId);
				ids.push(issue.nodeId);
			}
		}
	}
	return ids;
}

/**
 * Execution waves for a plan, mirroring `workflowWaves` (src/think/graph.ts)
 * over the plan's `dependencies`: a node's wave is one past the deepest
 * dependency wave; nodes with no dependency (or an unknown one) are wave 1.
 * Cyclic or forward references degrade to wave 1 rather than blocking, so a
 * hand-edited plan never wedges the sync.
 */
export function planWaves(plan: TrackPlan): WorkflowWave[] {
	const ids = planNodeIds(plan);
	const deps = plan.dependencies ?? {};
	const depth = new Map<string, number>();
	let guard = ids.length + 1;
	const depthOf = (node: string): number => {
		const known = depth.get(node);
		if (known !== undefined) return known;
		if (guard-- <= 0) {
			depth.set(node, 0);
			return 0;
		}
		let deepest = -1;
		for (const dep of deps[node] ?? []) {
			if (dep === node || !ids.includes(dep)) continue;
			deepest = Math.max(deepest, depthOf(dep));
		}
		const value = deepest + 1;
		depth.set(node, value);
		return value;
	};
	const levels: string[][] = [];
	for (const id of ids) {
		const level = depthOf(id);
		(levels[level] ??= []).push(id);
	}
	return levels
		.filter((group) => group.length > 0)
		.map((group, index) => ({
			wave: index + 1,
			parallel: group.length > 1,
			ids: group,
		}));
}

/**
 * One todo per wave, in the hook's `TodoSnapshotItem` shape: the first wave is
 * in progress, later waves pending, and `activeForm` names the wave so the
 * phase-boundary trigger can match work started against it.
 */
export function waveTodos(waves: WorkflowWave[]): TodoSnapshotItem[] {
	return waves.map((wave, index) => {
		const ids = wave.ids.join(", ");
		return {
			content: `Wave ${wave.wave}: ${ids}${wave.parallel ? " (parallel)" : ""}`,
			status: index === 0 ? "in_progress" : "pending",
			activeForm: `Wave ${wave.wave} ${ids}`,
		};
	});
}

/** True when the session state proves this plan's `syncTodos` completed on disk. */
export function isSyncTodosDone(
	record: Pick<SessionRecord, "syncTodos"> | undefined,
	graphId: string,
): boolean {
	return record?.syncTodos?.graphId === graphId;
}

function causeText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Issues the wave todos for `plan` and marks the invocation done in the
 * session state file. Returns only after the write lands (or both attempts
 * fail): the returned `ok` is the signal injection gates on. Retries once,
 * then logs and reports — never throws.
 */
export function syncTodos(plan: TrackPlan, deps: SyncTodosDeps): SyncTodosResult {
	const waves = planWaves(plan);
	const todos = waveTodos(waves);
	const update = deps.update ?? updateSession;
	const now = deps.now ?? Date.now;
	const log = deps.log ?? (() => undefined);
	const maxAttempts = 2;
	let lastError = "session record missing";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const saved = update(
				deps.stateDir,
				deps.sessionId,
				(record) => {
					if (record.plan?.graphId !== plan.graphId) return undefined;
					if (deps.recallOn === false) {
						return {
							...record,
							syncTodos: {
								graphId: plan.graphId,
								at: now(),
								waveCount: waves.length,
								todoCount: todos.length,
								attempts: attempt,
							},
						};
					}
					const state = record.recall?.state ?? serializeRecallState(createRecallState());
					return {
						...record,
						recall: { ...(record.recall ?? { state }), state, lastTodos: todos },
						syncTodos: {
							graphId: plan.graphId,
							at: now(),
							waveCount: waves.length,
							todoCount: todos.length,
							attempts: attempt,
						},
					};
				},
				HOOK_LOCK,
			);
			if (isSyncTodosDone(saved, plan.graphId)) {
				return { ok: true, graphId: plan.graphId, waves, todos, attempts: attempt };
			}
			lastError = "session record missing or plan mismatch";
		} catch (error) {
			lastError = causeText(error);
		}
		log(`syncTodos attempt ${attempt} failed: ${lastError}`);
	}
	return {
		ok: false,
		graphId: plan.graphId,
		waves,
		todos,
		attempts: maxAttempts,
		error: lastError,
	};
}
