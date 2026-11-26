// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Pending state machine + hard Swarm gate (SPE-37788, n5).
 *
 * Placement: lives beside `sync-todos.ts` because it extends its
 * `SessionRecord` model (`hook.ts`/`state.ts`/`sync-todos.ts`) rather than
 * inventing a second convention. The durable write stays an
 * `updateSession` replace (`syncValidatedTodos`); the in-memory
 * `PendingStore` mirrors `OrderGate`'s in-memory confirmations in
 * `host/uplift-delivery.ts` (hooks are one-shot processes, so the pending
 * overlay is per-process state, never a second on-disk store). The Swarm
 * subagent-spawn entry consults `gatePasses(sessionId)`: substantive work
 * from raw input is blocked while a pending exists in
 * `Invoked`/`UpliftPending`/`SwarmGated`; read-only preparation (no code,
 * TODO, or session-state mutation) is always allowed.
 *
 * Untrusted content: the uplifted prompt and TODO texts are stored and
 * compared as strings only — never executed, never granted permissions.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	HOOK_LOCK,
	serializeRecallState,
	updateSession,
	type SessionRecord,
	type TodoSnapshotItem,
} from "../claude/state.ts";
import { createRecallState } from "../recall/engine.ts";
import {
	createObservabilityEvent,
	eventTypeForTransition,
	type ObservabilityEvent,
	type ObservabilitySink,
} from "./observability.ts";
/** Closed state set (contract §states). `Failed` and `TimedOut` are distinct terminal-ish states. */
export type PendingState =
	| "Idle"
	| "Invoked"
	| "UpliftPending"
	| "SwarmGated"
	| "PlanReady"
	| "Injecting"
	| "Injected"
	| "TODOsSynced"
	| "ForceStoppedOrFinishedOff"
	| "HandedOff"
	| "Failed"
	| "TimedOut"
	| "Cancelled";

/** One logged transition: every `transition()` appends exactly one entry. */
interface PendingTransition {
	invocationId: string;
	timestamp: number;
	reason: string;
	from: PendingState;
	to: PendingState;
}

/** Pending record created at magic-words invocation. Todo/promp payloads are `undefined` until bound to this `invocationId`. */
export interface PendingInvocation {
	invocationId: string;
	sessionId: string;
	rawInputHash: string;
	startedAt: number;
	state: PendingState;
	epoch: number;
	upliftedPrompt?: string;
	upliftedPromptInvocationId?: string;
	validatedTodos?: TodoSnapshotItem[];
	validatedTodosInvocationId?: string;
	injectionAttemptCount: number;
	injected: boolean;
	upliftRetryCount: number;
	queuedInputs: string[];
	transitions: PendingTransition[];
	lastReason: string;
}

/** Uplift deadline (contract default). Configurable per caller via `checkTimeout`/`applyTimeout` timeoutMs. */
export const UPLIFT_TIMEOUT_MS = 120_000;
/** Uplift retry budget (contract default): one retry after `Failed`/`TimedOut`. */
const UPLIFT_RETRY_BUDGET = 1;
/** Injection retry budget (contract default): 3 attempts with exponential backoff. */
export const INJECTION_RETRY_BUDGET = 3;
/** Base delay for injection exponential backoff: `base * 2^(attempt-1)`. */
const INJECTION_RETRY_BASE_MS = 500;
/** aria-live mode for the visible pending entry: announced politely, focus never moves. */
export const PENDING_ARIA_LIVE = "polite" as const;
/** The one held reason a blocked substantive gate reports. */
export const PENDING_GATE_HELD_REASON =
	"Waiting for the uplifted prompt injection before starting substantive work.";

const TODO_STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

/** States that block substantive work from raw input at the Swarm spawn entry. */
const BLOCKING_STATES: readonly PendingState[] = ["Invoked", "UpliftPending", "SwarmGated"];

/** Legal transitions. Ordering `Injected -> TODOsSynced -> ForceStoppedOrFinishedOff -> HandedOff` is enforced. */
const ALLOWED_TRANSITIONS: Record<PendingState, readonly PendingState[]> = {
	Idle: ["Invoked"],
	Invoked: ["UpliftPending", "SwarmGated", "Cancelled", "Failed", "TimedOut"],
	UpliftPending: ["SwarmGated", "PlanReady", "Failed", "TimedOut", "Cancelled"],
	SwarmGated: ["PlanReady", "Failed", "TimedOut", "Cancelled"],
	PlanReady: ["Injecting", "Cancelled", "Failed"],
	Injecting: ["Injected", "Failed", "TimedOut", "Cancelled"],
	Injected: ["TODOsSynced", "Failed"],
	TODOsSynced: ["ForceStoppedOrFinishedOff", "Failed"],
	ForceStoppedOrFinishedOff: ["HandedOff"],
	HandedOff: ["Idle"],
	Failed: ["Invoked", "Idle"],
	TimedOut: ["Invoked", "Idle"],
	Cancelled: ["Idle", "Invoked"],
};

/** `state` may move to `to` (forward progress, cancel, and dismiss/retry only; nothing else). */
function canTransition(from: PendingState, to: PendingState): boolean {
	return ALLOWED_TRANSITIONS[from].includes(to);
}

/** True while substantive raw-input work must stay gated. */
function isSubstantiveBlocked(state: PendingState): boolean {
	return BLOCKING_STATES.includes(state);
}

function causeText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Schema validation for a TODO set: non-empty, each item names real content with a lifecycle status. */
export function validateTodoSnapshot(todos: unknown): {
	ok: boolean;
	todos?: TodoSnapshotItem[];
	error?: string;
} {
	if (!Array.isArray(todos)) return { ok: false, error: "todos must be an array" };
	if (todos.length === 0) return { ok: false, error: "todos must be non-empty" };
	const copy: TodoSnapshotItem[] = [];
	for (const entry of todos) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			return { ok: false, error: "todo entry must be an object" };
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.content !== "string" || record.content.trim() === "") {
			return { ok: false, error: "todo content must be non-empty" };
		}
		if (typeof record.status !== "string" || !TODO_STATUSES.includes(record.status)) {
			return { ok: false, error: "todo status must be pending, in_progress or completed" };
		}
		copy.push({
			content: record.content,
			status: record.status as TodoSnapshotItem["status"],
			...(typeof record.activeForm === "string" ? { activeForm: record.activeForm } : {}),
		});
	}
	return { ok: true, todos: copy };
}

/** Exponential backoff before injection attempt `attempt` (1-based): `base * 2^(attempt-1)`. */
export function injectionBackoffMs(attempt: number): number {
	if (attempt < 1) return 0;
	return INJECTION_RETRY_BASE_MS * 2 ** (attempt - 1);
}

/** What the plugin surface shows for a pending: one labeled line, announced via `aria-live="polite"`, focus-preserving. */
export function pendingStatusText(pending: PendingInvocation | undefined): string {
	if (!pending) return "Ultrathink pending: none";
	return `Ultrathink pending: ${pending.state} (${pending.invocationId}, epoch ${pending.epoch})`;
}

/** Retry/dismiss surfacing data for `Failed`/`TimedOut` (which stay distinct states). */
export interface FailureSurface {
	state: PendingState;
	reason: string;
	retryable: boolean;
	retryBudgetRemaining: number;
	dismissible: boolean;
}

export function getFailureSurface(pending: PendingInvocation): FailureSurface {
	const failed = pending.state === "Failed" || pending.state === "TimedOut";
	return {
		state: pending.state,
		reason: pending.lastReason,
		retryable: failed && pending.upliftRetryCount < UPLIFT_RETRY_BUDGET,
		retryBudgetRemaining: Math.max(0, UPLIFT_RETRY_BUDGET - pending.upliftRetryCount),
		dismissible: failed || pending.state === "Cancelled",
	};
}

/**
 * Cancel-or-finish primitive seam. No Swarm cancel primitive exists in this
 * repo to invoke: `src/swarm/lane.ts` only exposes a stop hint and
 * `host/uplift-delivery.ts` owns the drain coordinator, so the host wires a
 * real one behind this interface. TODO(host): provide the Swarm-side
 * cancel-for-session implementation; until then callers get
 * `missingPrimitive` and no state moves.
 */
export interface ForceStopSeam {
	forceStop: (input: { sessionId: string; invocationId: string }) => Promise<void> | void;
}

/** Result of `syncValidatedTodos`: `ok` means the TODO replace landed atomically on the session record. */
export interface SyncValidatedResult {
	ok: boolean;
	error?: string;
}

/** Result of `forceStopFinishOff`. `missingPrimitive` names the absent Swarm cancel seam when there is none. */
export interface ForceStopResult {
	ok: boolean;
	missingPrimitive?: string;
	error?: string;
}

interface Identity {
	invocationId: string;
	epoch: number;
}

/**
 * Per-session pending registry. One `PendingInvocation` per session; a
 * second magic-words invocation supersedes (`epoch++`, old state
 * `Cancelled`) and any later write stamped with the old identity+epoch is
 * rejected as stale.
 */
export class PendingStore {
	readonly #pending = new Map<string, PendingInvocation>();
	readonly #nextEpoch = new Map<string, number>();
	readonly #onEvent?: ObservabilitySink;

	/**
	 * Optional observability sink (n6): every keyed transition emits its contract
	 * event. Unset means the store behaves exactly as before (no observer, no log).
	 */
	constructor(options?: { onEvent?: ObservabilitySink }) {
		this.#onEvent = options?.onEvent;
	}

	#emit(event: ObservabilityEvent): void {
		this.#onEvent?.(event);
	}
	/** Create (or supersede into) a pending at magic-words invocation; starts in `Invoked`. */
	create(sessionId: string, rawInput: string, now: number = Date.now()): PendingInvocation {
		const epoch = (this.#nextEpoch.get(sessionId) ?? 0) + 1;
		this.#nextEpoch.set(sessionId, epoch);
		const prior = this.#pending.get(sessionId);
		let priorFrom: string | undefined;
		if (prior && prior.state !== "Idle") {
			priorFrom = prior.state;
			prior.transitions.push({
				invocationId: prior.invocationId,
				timestamp: now,
				reason: "superseded by a new magic-words invocation",
				from: prior.state,
				to: "Cancelled",
			});
			prior.state = "Cancelled";
			prior.lastReason = "superseded by a new magic-words invocation";
		}
		const invocation: PendingInvocation = {
			invocationId: `pending-${randomUUID()}`,
			sessionId,
			rawInputHash: createHash("sha256").update(rawInput, "utf8").digest("hex"),
			startedAt: now,
			state: "Invoked",
			epoch,
			injectionAttemptCount: 0,
			injected: false,
			upliftRetryCount: 0,
			queuedInputs: [],
			transitions: [
				{
					invocationId: "",
					timestamp: now,
					reason: "magic-words invoked",
					from: "Idle",
					to: "Invoked",
				},
			],
			lastReason: "magic-words invoked",
		};
		invocation.transitions[0]!.invocationId = invocation.invocationId;
		this.#pending.set(sessionId, invocation);
		if (prior && priorFrom !== undefined) {
			this.#emit(
				createObservabilityEvent({
					type: "user_input.superseded",
					invocationId: prior.invocationId,
					epoch: prior.epoch,
					sessionId,
					from: priorFrom,
					to: "Cancelled",
					startedAt: prior.startedAt,
					now,
				}),
			);
		}
		this.#emit(
			createObservabilityEvent({
				type: "ultrathink.invoked",
				invocationId: invocation.invocationId,
				epoch,
				sessionId,
				from: "Idle",
				to: "Invoked",
				startedAt: now,
				now,
			}),
		);
		return invocation;
	}

	/** The session's current pending, or `undefined` when there is none. Read-only. */
	get(sessionId: string): PendingInvocation | undefined {
		return this.#pending.get(sessionId);
	}

	#assertCurrent(sessionId: string, identity: Identity): PendingInvocation {
		const current = this.#pending.get(sessionId);
		if (!current) throw new Error(`no pending for session ${sessionId}`);
		if (current.invocationId !== identity.invocationId || current.epoch !== identity.epoch) {
			throw new Error(
				`stale pending for session ${sessionId}: expected ${identity.invocationId}@${identity.epoch}, have ${current.invocationId}@${current.epoch}`,
			);
		}
		return current;
	}

	/** Logged transition: validates identity+epoch and legality, appends `{invocationId, timestamp, reason}`. Throws on stale or illegal. */
	transition(
		sessionId: string,
		to: PendingState,
		reason: string,
		identity: Identity,
		now: number = Date.now(),
	): PendingInvocation {
		const current = this.#assertCurrent(sessionId, identity);
		if (!canTransition(current.state, to)) {
			throw new Error(
				`illegal pending transition ${current.state} -> ${to} for session ${sessionId}`,
			);
		}
		const from = current.state;
		current.transitions.push({
			invocationId: current.invocationId,
			timestamp: now,
			reason,
			from: current.state,
			to,
		});
		current.state = to;
		current.lastReason = reason;
		if (to === "Injected") current.injected = true;
		const eventType = eventTypeForTransition(from, to);
		if (eventType !== undefined) {
			this.#emit(
				createObservabilityEvent({
					type: eventType,
					invocationId: current.invocationId,
					epoch: current.epoch,
					sessionId,
					from,
					to,
					startedAt: current.startedAt,
					now,
				}),
			);
		}
		return current;
	}

	/** Bind the uplifted prompt to this invocation (untrusted text: stored, never executed). */
	setUpliftedPrompt(sessionId: string, identity: Identity, prompt: string): PendingInvocation {
		const current = this.#assertCurrent(sessionId, identity);
		current.upliftedPrompt = prompt;
		current.upliftedPromptInvocationId = identity.invocationId;
		return current;
	}

	/** Bind a schema-validated TODO set to this invocation. Throws on stale identity or invalid todos (nothing is stored). */
	setValidatedTodos(sessionId: string, identity: Identity, todos: unknown): PendingInvocation {
		const current = this.#assertCurrent(sessionId, identity);
		const validated = validateTodoSnapshot(todos);
		if (!validated.ok || !validated.todos) throw new Error(`invalid todos: ${validated.error}`);
		current.validatedTodos = validated.todos;
		current.validatedTodosInvocationId = identity.invocationId;
		return current;
	}

	/** Queue input that arrives while waiting: held until the pending resolves, never dispatched from raw input. */
	queueInput(
		sessionId: string,
		identity: Identity,
		text: string,
		now: number = Date.now(),
	): number {
		const current = this.#assertCurrent(sessionId, identity);
		current.queuedInputs.push(text);
		this.#emit(
			createObservabilityEvent({
				type: "user_input.queued",
				invocationId: current.invocationId,
				epoch: current.epoch,
				sessionId,
				from: current.state,
				to: current.state,
				startedAt: current.startedAt,
				now,
			}),
		);
		return current.queuedInputs.length;
	}

	/** Completion: non-empty uplifted prompt AND a validated, non-empty TODO set bound to the same invocationId. */
	checkCompletion(pending: PendingInvocation): { complete: boolean; reasons: string[] } {
		const reasons: string[] = [];
		if (!pending.upliftedPrompt || pending.upliftedPrompt.trim() === "") {
			reasons.push("uplifted prompt is empty");
		} else if (pending.upliftedPromptInvocationId !== pending.invocationId) {
			reasons.push("uplifted prompt is bound to a different invocation");
		}
		const validated = validateTodoSnapshot(pending.validatedTodos ?? []);
		if (!validated.ok || !validated.todos) {
			reasons.push(validated.error ?? "todos are not schema-validated");
		} else if (pending.validatedTodosInvocationId !== pending.invocationId) {
			reasons.push("todos are bound to a different invocation");
		}
		return { complete: reasons.length === 0, reasons };
	}

	/** Record one injection attempt; `budgetExceeded` once past the 3-attempt budget (exp backoff in `injectionBackoffMs`). */
	recordInjectionAttempt(
		sessionId: string,
		identity: Identity,
	): { attempt: number; budgetExceeded: boolean; backoffMs: number } {
		const current = this.#assertCurrent(sessionId, identity);
		current.injectionAttemptCount += 1;
		return {
			attempt: current.injectionAttemptCount,
			budgetExceeded: current.injectionAttemptCount > INJECTION_RETRY_BUDGET,
			backoffMs: injectionBackoffMs(current.injectionAttemptCount),
		};
	}

	/** Timeout check against `startedAt`; distinction from `Failed` is preserved by the caller drilling into `getFailureSurface`. */
	checkTimeout(
		sessionId: string,
		now: number = Date.now(),
		timeoutMs: number = UPLIFT_TIMEOUT_MS,
	): boolean {
		const current = this.#pending.get(sessionId);
		return (
			!!current &&
			now - current.startedAt > timeoutMs &&
			(current.state === "UpliftPending" ||
				current.state === "SwarmGated" ||
				current.state === "Injecting")
		);
	}

	/** Apply the timeout: move an in-flight pending to `TimedOut`. Returns true when applied. */
	applyTimeout(
		sessionId: string,
		now: number = Date.now(),
		timeoutMs: number = UPLIFT_TIMEOUT_MS,
	): boolean {
		const current = this.#pending.get(sessionId);
		if (!current || !this.checkTimeout(sessionId, now, timeoutMs)) return false;
		this.transition(
			sessionId,
			"TimedOut",
			`uplift timed out after ${timeoutMs}ms`,
			{
				invocationId: current.invocationId,
				epoch: current.epoch,
			},
			now,
		);
		return true;
	}

	/** Retry a `Failed`/`TimedOut` pending (one retry): back to `Invoked` with prompt/todos cleared. Throws when not retryable. */
	retry(sessionId: string, now: number = Date.now()): PendingInvocation {
		const current = this.#pending.get(sessionId);
		if (!current || (current.state !== "Failed" && current.state !== "TimedOut")) {
			throw new Error(`pending for session ${sessionId} is not retryable`);
		}
		if (current.upliftRetryCount >= UPLIFT_RETRY_BUDGET) {
			throw new Error(`uplift retry budget exhausted for session ${sessionId}`);
		}
		current.upliftRetryCount += 1;
		current.upliftedPrompt = undefined;
		current.upliftedPromptInvocationId = undefined;
		current.validatedTodos = undefined;
		current.validatedTodosInvocationId = undefined;
		current.injected = false;
		current.injectionAttemptCount = 0;
		current.startedAt = now;
		const retried = this.transition(
			sessionId,
			"Invoked",
			"retry after failure/timeout",
			{
				invocationId: current.invocationId,
				epoch: current.epoch,
			},
			now,
		);
		return retried;
	}

	/** Dismiss a `Failed`/`TimedOut`/`Cancelled` pending back to `Idle`. Throws when not dismissible. */
	dismiss(sessionId: string, now: number = Date.now()): PendingInvocation {
		const current = this.#pending.get(sessionId);
		if (!current || !["Failed", "TimedOut", "Cancelled"].includes(current.state)) {
			throw new Error(`pending for session ${sessionId} is not dismissible`);
		}
		return this.transition(
			sessionId,
			"Idle",
			"dismissed",
			{ invocationId: current.invocationId, epoch: current.epoch },
			now,
		);
	}

	/** Hard Swarm gate: `substantive` blocks in `Invoked`/`UpliftPending`/`SwarmGated`; `read-only` prep is always allowed. */
	gateFor(
		sessionId: string,
		mode: "substantive" | "read-only",
		now: number = Date.now(),
	): { allowed: boolean; reason: string } {
		if (mode === "read-only") return { allowed: true, reason: "" };
		const current = this.#pending.get(sessionId);
		if (!current || !isSubstantiveBlocked(current.state)) return { allowed: true, reason: "" };
		this.#emit(
			createObservabilityEvent({
				type: "gate.blocked",
				invocationId: current.invocationId,
				epoch: current.epoch,
				sessionId,
				from: current.state,
				to: current.state,
				startedAt: current.startedAt,
				now,
			}),
		);
		return { allowed: false, reason: PENDING_GATE_HELD_REASON };
	}

	/** Substantive gate for the spawn entry: true when substantive work may proceed. */
	gatePasses(sessionId: string, now?: number): boolean {
		return this.gateFor(sessionId, "substantive", now).allowed;
	}
}

/** Process-wide store for the host wiring (`gatePasses` at the spawn entry). Tests inject their own `PendingStore`. */
export const defaultPendingStore = new PendingStore();



export interface SyncValidatedInput {
	store: PendingStore;
	sessionId: string;
	identity: Identity;
	todos: unknown;
	stateDir: string;
	/** Clock or fixed instant used for the transition timestamp; defaults to `Date.now`. */
	now?: number | (() => number);
	log?: (message: string) => void;
	/** Test seam: replaces the locked session write. Defaults to `updateSession`. */
	update?: typeof updateSession;
	/**
	 * Master-switch gate for the `recall.lastTodos` write (default `true`).
	 * When `false` (recall disabled), the atomic sync still validates and
	 * transitions the pending to `TODOsSynced`, but no recall record is
	 * synthesized or written — `record.recall` stays `undefined`.
	 */
	recallOn?: boolean;
}

/**
 * Atomic TODO sync (ordering `Injected -> TODOsSynced`): validate, verify
 * identity+epoch and ordering, then replace `recall.lastTodos` in a single
 * locked write. Failure at any step leaves the session file and the pending
 * state untouched (no partial mutation). Never throws.
 */
export function syncValidatedTodos(input: SyncValidatedInput): SyncValidatedResult {
	const nowValue = input.now ?? Date.now;
	const now = typeof nowValue === "function" ? nowValue : () => nowValue;
	const log = input.log ?? (() => undefined);
	const validated = validateTodoSnapshot(input.todos);
	if (!validated.ok || !validated.todos) return { ok: false, error: validated.error };
	let pending: PendingInvocation;
	try {
		pending = input.store.get(input.sessionId) as PendingInvocation;
		if (!pending) return { ok: false, error: "no pending for session" };
		if (
			pending.invocationId !== input.identity.invocationId ||
			pending.epoch !== input.identity.epoch
		) {
			return { ok: false, error: "stale pending identity" };
		}
	} catch (error) {
		return { ok: false, error: causeText(error) };
	}
	if (pending.state !== "Injected") {
		return {
			ok: false,
			error: `ordering violation: sync requires Injected, have ${pending.state}`,
		};
	}
	if (pending.validatedTodosInvocationId !== pending.invocationId) {
		return { ok: false, error: "todos are not bound to this invocation" };
	}
	const todos = validated.todos;
	const update = input.update ?? updateSession;
	try {
		const saved = update(
			input.stateDir,
			input.sessionId,
			(record: SessionRecord) => {
				if (!record) return undefined;
				if (input.recallOn === false) {
					return { ...record };
				}
				const state = record.recall?.state ?? serializeRecallState(createRecallState());
				return {
					...record,
					recall: {
						...(record.recall ?? { state }),
						state,
						lastTodos: todos.map((todo) => ({ ...todo })),
					},
				};
			},
			HOOK_LOCK,
		);
		if (!saved) return { ok: false, error: "session record missing" };
	} catch (error) {
		log(`syncValidatedTodos failed: ${causeText(error)}`);
		return { ok: false, error: causeText(error) };
	}
	try {
		input.store.transition(
			input.sessionId,
			"TODOsSynced",
			"todos synced atomically",
			input.identity,
			now(),
		);
	} catch (error) {
		return { ok: false, error: causeText(error) };
	}
	return { ok: true };
}

/**
 * Force-stop/finish-off hook (`TODOsSynced -> ForceStoppedOrFinishedOff`).
 * Requires a wired `ForceStopSeam`; without one it reports
 * `missingPrimitive` and moves no state (fail closed, never a silent pass).
 */
export async function forceStopFinishOff(
	store: PendingStore,
	sessionId: string,
	identity: Identity,
	seam: ForceStopSeam | undefined,
	now: number = Date.now(),
): Promise<ForceStopResult> {
	if (seam === undefined) return { ok: false, missingPrimitive: "Swarm cancel seam not provided" };
	const pending = store.get(sessionId);
	if (!pending) return { ok: false, error: "no pending for session" };
	if (pending.invocationId !== identity.invocationId || pending.epoch !== identity.epoch) {
		return { ok: false, error: "stale pending identity" };
	}
	if (pending.state !== "TODOsSynced") {
		return {
			ok: false,
			error: `ordering violation: force-stop requires TODOsSynced, have ${pending.state}`,
		};
	}
	try {
		await seam.forceStop({ sessionId, invocationId: identity.invocationId });
	} catch (error) {
		return { ok: false, error: causeText(error) };
	}
	store.transition(
		sessionId,
		"ForceStoppedOrFinishedOff",
		"force-stopped/finished-off via seam",
		identity,
		now,
	);
	return { ok: true };
}
