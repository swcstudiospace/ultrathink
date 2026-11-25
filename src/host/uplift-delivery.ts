// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Swarm×Ultrathink race fix (Tdfe6): force-injection, hard order gate, bounded
 * drain coordinator and the closed-set status ledger.
 *
 * Contracts: `contracts/swarm-uplift-race.openapi.json@1.0.0`
 * (`POST /force-inject`, `POST /order-gate`, `POST /drain`,
 * `GET /delivery-status`) and `contracts/swarm-uplift-race.data.json`
 * (`SC-UpliftDeliveryRecord@1.0.0`). A03 blueprint:
 * `docs/architecture/blueprint-Tdfe6-arch.md`; A07 data model:
 * `docs/data/data-model-Tdfe6.md` (migration `2026112303`, prepared only —
 * the session files remain the runtime source of truth, so this module
 * persists nothing itself; callers project the returned records).
 *
 * Hard rules (brief FR-1..FR-4):
 * 1. FORCE-INJECTION: the full uplifted prompt is delivered to the session
 *    even while orchestration is mid-flight, with finite retry, one log line
 *    per attempt (0 silent drops) and byte-identical retry (0 prompt loss).
 * 2. FORCE-STOP: a new user prompt drains running orchestration gracefully
 *    within a bounded 30s window, 0 mid-write kills; past the bound the
 *    drain reports `timed-out` and the new turn proceeds.
 * 3. ORDER GATE: no subagent dispatch before the injection confirmation
 *    lands; a refused attempt carries exactly 1 held reason.
 * 4. Production grade: closed outcome set `{injected, retrying, drained,
 *    timed-out, dropped-with-reason}`, explicit failure states on every
 *    path, secret redaction before persistence, audited kill-switch bypass.
 */
import { createHash } from "node:crypto";
import { redactSecrets } from "../redact.ts";
import { isSyncTodosDone as isSyncTodosDoneGate } from "../track/sync-todos.ts";
import type { SessionRecord } from "../claude/state.ts";

/** Contract `DeliveryState`: the closed outcome set. `dropped-with-reason` always names its reason. */
export type DeliveryState =
	| "injected"
	| "retrying"
	| "drained"
	| "timed-out"
	| "dropped-with-reason";

/** Contract `RecordType` (`SC-UpliftDeliveryRecord.recordType`). */
export type DeliveryRecordType = "force_inject" | "order_gate" | "drain";

/**
 * Runtime projection of one `UpliftDeliveryRecord` row
 * (`contracts/swarm-uplift-race.data.json@1.0.0`, migration `2026112303`).
 * `promptText` / `heldReason` / `reason` are redacted (NFR-29); `promptHash`
 * is the sha256 hex of the stored `promptText`, so a retry reuses the
 * byte-identical prompt instead of re-uplifting (FR-1, 0 prompt loss).
 */
export interface UpliftDeliveryRecord {
	sessionId: string;
	taskId?: string;
	correlationId?: string;
	recordType: DeliveryRecordType;
	state: DeliveryState;
	allowed: boolean;
	heldReason: string;
	promptText: string;
	promptHash: string;
	attemptCount: number;
	retryCount: number;
	retryBudget: number;
	injectionLatencyMs: number;
	drainBoundS: number;
	drainElapsedMs: number;
	todoUpdated: boolean;
	killSwitchBypass: boolean;
	reason: string;
	createdAt: string;
	updatedAt: string;
}

/** Result of `POST /force-inject` (contract response: `{ state }`, plus evidence). */
export interface ForceInjectResult {
	state: DeliveryState;
	record: UpliftDeliveryRecord;
	/** One line per attempt, failures named in words — 0 silent drops. */
	retryLog: string[];
	/** The TODO entry appended on landing (FR-1); absent when not injected. */
	todoEntry?: string;
}

/** Result of `POST /order-gate` (contract response: `{ allowed, heldReason }`). */
export interface OrderGateResult {
	allowed: boolean;
	heldReason: string;
	record: UpliftDeliveryRecord;
	/** Injection confirmation time, present once dispatch is allowed (AC-66). */
	confirmedAt?: string;
}

/** Result of `POST /drain` (contract response: `{ state: drained | timed-out }`). */
export interface DrainResult {
	state: "drained" | "timed-out";
	record: UpliftDeliveryRecord;
	/** Elapsed drain time in seconds, rounded to one decimal. */
	elapsedS: number;
}

/** Result of `GET /delivery-status` (contract response: `{ state }`). */
export interface DeliveryStatusResult {
	state: DeliveryState;
	reason?: string;
	/** Latest ledger record for the session, when one exists. */
	record?: UpliftDeliveryRecord;
}

/** NFR-28: injection latency budget, ms from uplift completion to session delivery. */
export const INJECTION_LATENCY_BUDGET_MS = 5000;
/** FR-3: bounded graceful drain, seconds. A2 may tighten, never remove. */
export const DRAIN_BOUND_S = 30;
/** FR-1: finite retry budget (migration default). */
export const FORCE_INJECT_RETRY_BUDGET = 3;
/** FR-4: the one held reason carried by a refused dispatch attempt. */
export const ORDER_GATE_HELD_REASON =
	"Waiting for the uplift prompt injection confirmation before starting subagents.";

/** sha256 hex of the stored (redacted) prompt text — the 0-prompt-loss proof. */
export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function baseRecord(input: {
	sessionId: string;
	taskId?: string;
	correlationId?: string;
	recordType: DeliveryRecordType;
	state: DeliveryState;
}): UpliftDeliveryRecord {
	const now = new Date().toISOString();
	return {
		sessionId: input.sessionId,
		recordType: input.recordType,
		state: input.state,
		allowed: false,
		heldReason: "",
		promptText: "",
		promptHash: "",
		attemptCount: 0,
		retryCount: 0,
		retryBudget: FORCE_INJECT_RETRY_BUDGET,
		injectionLatencyMs: 0,
		drainBoundS: DRAIN_BOUND_S,
		drainElapsedMs: 0,
		todoUpdated: false,
		killSwitchBypass: false,
		reason: "",
		createdAt: now,
		updatedAt: now,
		...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
		...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
	};
}

/** A delivered prompt's TODO entry: the first line, trimmed, capped so the entry stays one line. */
function todoEntryFor(promptText: string): string {
	const firstLine = promptText
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	const entry = firstLine ?? "Uplifted prompt injected";
	return entry.length > 120 ? `${entry.slice(0, 117)}...` : entry;
}

/**
 * Force-injector (FR-1). Delivers the full uplifted prompt through `deliver`
 * regardless of orchestration state. The prompt is redacted once and the
 * redacted bytes are retried verbatim — never truncated, never re-uplifted:
 * `promptHash` is identical on every attempt (0 prompt loss). Each failed
 * attempt appends one `retryLog` line naming the failure (0 silent drops);
 * when the finite `retryBudget` is exhausted the outcome is
 * `dropped-with-reason` naming the last failure, on the next attempt tick.
 */
export class ForceInjector {
	readonly #deliver: (promptText: string, sessionId: string) => Promise<boolean> | boolean;
	readonly #now: () => number;

	constructor(
		deliver: (promptText: string, sessionId: string) => Promise<boolean> | boolean,
		now: () => number = () => Date.now(),
	) {
		this.#deliver = deliver;
		this.#now = now;
	}

	async inject(input: {
		sessionId: string;
		promptText: string;
		taskId?: string;
		correlationId?: string;
		retryBudget?: number;
		upliftCompletedAt?: number;
	}): Promise<ForceInjectResult> {
		const retryBudget = Math.max(0, Math.floor(input.retryBudget ?? FORCE_INJECT_RETRY_BUDGET));
		const storedPrompt = redactSecrets(input.promptText);
		const retryLog: string[] = [];
		const todoEntry = todoEntryFor(storedPrompt);
		let lastFailure = "";
		let attempts = 0;
		const startedAt = this.#now();

		for (let attempt = 1; attempt <= retryBudget + 1; attempt += 1) {
			attempts = attempt;
			const t0 = this.#now();
			let delivered = false;
			let failure = "";
			try {
				delivered = (await this.#deliver(storedPrompt, input.sessionId)) === true;
				if (!delivered) failure = "delivery channel returned false";
			} catch (error) {
				failure = error instanceof Error ? error.message : "delivery channel threw";
			}
			const latencyMs = Math.max(0, Math.round(this.#now() - t0));
			if (delivered && latencyMs > INJECTION_LATENCY_BUDGET_MS) {
				delivered = false;
				failure = `delivery exceeded the 5000ms injection latency budget (${latencyMs}ms)`;
			}
			if (delivered) {
				const elapsed = Math.max(
					0,
					Math.round(this.#now() - (input.upliftCompletedAt ?? startedAt)),
				);
				const record: UpliftDeliveryRecord = {
					...baseRecord({
						sessionId: input.sessionId,
						recordType: "force_inject",
						state: "injected",
						taskId: input.taskId,
						correlationId: input.correlationId,
					}),
					promptText: storedPrompt,
					promptHash: sha256Hex(storedPrompt),
					attemptCount: attempts,
					retryCount: attempts - 1,
					retryBudget,
					injectionLatencyMs: elapsed,
					todoUpdated: true,
				};
				return { state: "injected", record, retryLog, todoEntry };
			}
			lastFailure = failure;
			retryLog.push(
				`attempt ${attempt}: failed (${redactSecrets(failure)}); prompt retained (${storedPrompt.length} chars, sha256 ${sha256Hex(storedPrompt).slice(0, 12)}...)`,
			);
		}

		const record: UpliftDeliveryRecord = {
			...baseRecord({
				sessionId: input.sessionId,
				recordType: "force_inject",
				state: "dropped-with-reason",
				taskId: input.taskId,
				correlationId: input.correlationId,
			}),
			promptText: storedPrompt,
			promptHash: sha256Hex(storedPrompt),
			attemptCount: attempts,
			retryCount: Math.max(0, attempts - 1),
			retryBudget,
			reason: redactSecrets(lastFailure || "delivery channel unavailable"),
		};
		return { state: "dropped-with-reason", record, retryLog };
	}
}

/**
 * Order gate (FR-4, hard rule): subagent dispatch may begin only once the
 * injection confirmation exists for the session. A refused attempt carries
 * exactly one held reason. The kill-switch bypass is the audited manual
 * override: it requires a reason, is recorded with `killSwitchBypass: true`,
 * and never silently forwards (explicit `state: injected` is not claimed —
 * the gate records `retrying` until a real confirmation lands).
 */
export class OrderGate {
	readonly #confirmations = new Map<string, { at: string; promptHash: string }>();

	confirm(sessionId: string, promptHash: string, at: string = new Date().toISOString()): void {
		this.#confirmations.set(sessionId, { at, promptHash });
	}

	isConfirmed(sessionId: string): boolean {
		return this.#confirmations.has(sessionId);
	}

	check(input: {
		sessionId: string;
		taskId?: string;
		correlationId?: string;
		killSwitchBypass?: { reason: string; by: string };
	}): OrderGateResult {
		const confirmation = this.#confirmations.get(input.sessionId);
		if (confirmation !== undefined) {
			const record: UpliftDeliveryRecord = {
				...baseRecord({
					sessionId: input.sessionId,
					recordType: "order_gate",
					state: "injected",
					taskId: input.taskId,
					correlationId: input.correlationId,
				}),
				allowed: true,
				promptHash: confirmation.promptHash,
			};
			return { allowed: true, heldReason: "", record, confirmedAt: confirmation.at };
		}
		if (input.killSwitchBypass !== undefined) {
			const reason = redactSecrets(
				`${input.killSwitchBypass.by}: ${input.killSwitchBypass.reason}`,
			).trim();
			const record: UpliftDeliveryRecord = {
				...baseRecord({
					sessionId: input.sessionId,
					recordType: "order_gate",
					state: "retrying",
					taskId: input.taskId,
					correlationId: input.correlationId,
				}),
				allowed: true,
				heldReason: "",
				killSwitchBypass: true,
				reason,
			};
			return { allowed: true, heldReason: "", record };
		}
		const heldReason = ORDER_GATE_HELD_REASON;
		const record: UpliftDeliveryRecord = {
			...baseRecord({
				sessionId: input.sessionId,
				recordType: "order_gate",
				state: "retrying",
				taskId: input.taskId,
				correlationId: input.correlationId,
			}),
			allowed: false,
			heldReason: redactSecrets(heldReason),
		};
		return { allowed: false, heldReason: record.heldReason, record };
	}
}

/**
 * Drain coordinator (FR-3 / FORCE-STOP): when a new user prompt starts,
 * running orchestration is stopped gracefully within `boundS` (default 30s).
 * A `writeInProgress` section is never interrupted mid-write: the drain
 * waits for it to finish; when the bound elapses first, the outcome is
 * `timed-out` (the new turn still proceeds, and no mid-write kill occurred).
 * The clock is injectable so tests prove the bound without sleeping.
 */
export class DrainCoordinator {
	readonly #now: () => number;

	constructor(now: () => number = () => Date.now()) {
		this.#now = now;
	}

	async drain(input: {
		sessionId: string;
		taskId?: string;
		correlationId?: string;
		boundS?: number;
		/** Live orchestration: resolves true when it has stopped cleanly. */
		waitForIdle: () => Promise<boolean> | boolean;
		/** True while a write section is open; the drain waits, never kills it. */
		isWriteInProgress?: () => boolean;
		pollMs?: number;
	}): Promise<DrainResult> {
		const boundS = Math.min(DRAIN_BOUND_S, Math.max(0, Math.floor(input.boundS ?? DRAIN_BOUND_S)));
		const boundMs = boundS * 1000;
		const startedAt = this.#now();
		const pollMs = Math.max(1, input.pollMs ?? 10);
		let elapsedMs = 0;

		while (elapsedMs < boundMs) {
			const writeOpen = input.isWriteInProgress?.() === true;
			const idle = !writeOpen && (await input.waitForIdle()) === true;
			if (idle) {
				elapsedMs = Math.max(0, Math.round(this.#now() - startedAt));
				const record: UpliftDeliveryRecord = {
					...baseRecord({
						sessionId: input.sessionId,
						recordType: "drain",
						state: "drained",
						taskId: input.taskId,
						correlationId: input.correlationId,
					}),
					drainBoundS: boundS,
					drainElapsedMs: elapsedMs,
				};
				return { state: "drained", record, elapsedS: Math.round(elapsedMs / 100) / 10 };
			}
			const { promise: slept, resolve: wake } = Promise.withResolvers<void>();
			setTimeout(wake, pollMs);
			await slept;
			elapsedMs = Math.max(0, Math.round(this.#now() - startedAt));
		}

		const record: UpliftDeliveryRecord = {
			...baseRecord({
				sessionId: input.sessionId,
				recordType: "drain",
				state: "timed-out",
				taskId: input.taskId,
				correlationId: input.correlationId,
			}),
			drainBoundS: boundS,
			drainElapsedMs: elapsedMs,
			reason: redactSecrets(`drain bound of ${boundS}s elapsed; new turn proceeded`),
		};
		return { state: "timed-out", record, elapsedS: Math.round(elapsedMs / 100) / 10 };
	}
}

/**
 * Status ledger (status-ledger container): append-only collection of
 * delivery records per session, and the `GET /delivery-status` query. The
 * query always answers one of the 5 closed-set states — `retrying` when
 * records exist but nothing terminal landed, `dropped-with-reason` with its
 * named reason when the latest record dropped, and a named `retrying`
 * reason for a session with no record at all (legacy sessions never crash).
 */
export class StatusLedger {
	readonly #records: UpliftDeliveryRecord[] = [];

	append(record: UpliftDeliveryRecord): UpliftDeliveryRecord {
		const stored: UpliftDeliveryRecord = {
			...record,
			updatedAt: new Date().toISOString(),
		};
		this.#records.push(stored);
		return stored;
	}

	forSession(sessionId: string): UpliftDeliveryRecord[] {
		return this.#records.filter((record) => record.sessionId === sessionId);
	}

	latest(sessionId: string): UpliftDeliveryRecord | undefined {
		const records = this.forSession(sessionId);
		return records.length > 0 ? records[records.length - 1] : undefined;
	}

	status(sessionId: string): DeliveryStatusResult {
		const latest = this.latest(sessionId);
		if (latest === undefined) {
			return {
				state: "retrying",
				reason: "no delivery record yet for this session",
			};
		}
		switch (latest.state) {
			case "dropped-with-reason":
				return {
					state: latest.state,
					reason: latest.reason || "delivery dropped without a named reason",
					record: latest,
				};
			default:
				return { state: latest.state, record: latest };
		}
	}
}

/** One race-check scenario result (SCR-RaceChecks; `src/host/view.ts` shape). */
export interface RaceChecks {
	midFlight: { injectedPrompts: number; lostPlans: number };
	newPrompt: { drainedOrchestrations: number; landedPrompts: number; drops: number };
}

/**
 * Race-check assertions (AC-67/68): the mid-flight scenario must show 1
 * injected prompt with 0 lost plans; the new-prompt scenario 1 drained
 * orchestration, 1 landed prompt and 0 drops. Returns the counts the view
 * layer projects; each predicate is a hard assertion, not a claim.
 */
export function raceChecks(input: {
	midFlightInjected: number;
	midFlightLost: number;
	newPromptDrained: number;
	newPromptLanded: number;
	newPromptDrops: number;
}): RaceChecks {
	return {
		midFlight: { injectedPrompts: input.midFlightInjected, lostPlans: input.midFlightLost },
		newPrompt: {
			drainedOrchestrations: input.newPromptDrained,
			landedPrompts: input.newPromptLanded,
			drops: input.newPromptDrops,
		},
	};
}

export function assertRaceChecks(checks: RaceChecks): void {
	if (checks.midFlight !== undefined) {
		const mid = checks.midFlight;
		if (mid.injectedPrompts < 1 || mid.lostPlans !== 0) {
			throw new Error(
				`mid-flight race check failed: ${mid.injectedPrompts} injected, ${mid.lostPlans} lost plans`,
			);
		}
	}
	if (checks.newPrompt !== undefined) {
		const fresh = checks.newPrompt;
		if (fresh.drainedOrchestrations < 1 || fresh.landedPrompts < 1 || fresh.drops !== 0) {
			throw new Error(
				`new-prompt race check failed: ${fresh.drainedOrchestrations} drained, ${fresh.landedPrompts} landed, ${fresh.drops} drops`,
			);
		}
	}
}

/** Minimal route-registrar shape (Express/Hono-style `app`/`router`). */
export interface UpliftDeliveryRoutesApp {
	post: (path: string, handler: unknown) => unknown;
	get: (path: string, handler: unknown) => unknown;
}

/**
 * Registers the four contract routes on any `app.post`/`app.get` registrar
 * (Omp host adapter, Claude hook adapter or a test double). Handlers are
 * the injected `deliver` channel and the shared ledger/gate/drain
 * instances supplied by the host, so the routes here are the same service
 * the unit tests exercise — no second implementation.
 */
export function registerUpliftDeliveryRoutes(
	app: UpliftDeliveryRoutesApp,
	deps: {
		injector: ForceInjector;
		gate: OrderGate;
		drain: DrainCoordinator;
		ledger: StatusLedger;
		onInjected?: (result: ForceInjectResult, sessionId: string) => void;
		waitForIdle?: (sessionId: string) => Promise<boolean> | boolean;
		isWriteInProgress?: (sessionId: string) => boolean;
	},
): void {
	app.post("/force-inject", async (body: { sessionId: string; promptText: string }) => {
		const result = await deps.injector.inject(body);
		deps.ledger.append(result.record);
		if (result.state === "injected") {
			deps.gate.confirm(body.sessionId, result.record.promptHash);
		}
		deps.onInjected?.(result, body.sessionId);
		return { state: result.state };
	});
	app.post("/order-gate", (body: { sessionId: string }) => {
		const result = deps.gate.check(body);
		deps.ledger.append(result.record);
		return { allowed: result.allowed, heldReason: result.heldReason };
	});
	app.post("/drain", async (body: { sessionId: string }) => {
		const result = await deps.drain.drain({
			sessionId: body.sessionId,
			waitForIdle: () => deps.waitForIdle?.(body.sessionId) ?? true,
			isWriteInProgress: () => deps.isWriteInProgress?.(body.sessionId) ?? false,
		});
		deps.ledger.append(result.record);
		return { state: result.state };
	});
	app.get("/delivery-status", (query: { sessionId: string }) => {
		const status = deps.ledger.status(query.sessionId);
		return status.reason !== undefined
			? { state: status.state, reason: status.reason }
			: { state: status.state };
	});
}

/**
 * Gated final-hop session injection (SPE-37786 / n3).
 *
 * Non-NativeDialog channel: deterministic in-session attempt first
 * (`create_chat_tab` for direct sessions, `steer`/`resume` for managed
 * sessions), `replace-via-out://` as the final hop. Popup/focus/speech/echo
 * heuristics are banned and are never preselected. Injection fires only when
 * `isSyncTodosDone(record, graphId)` is true; otherwise it is a queued no-op
 * that touches neither the channels nor the artifact store. On fire (a
 * channel confirms delivery) every prior non-seeded negative artifact is
 * removed, the uplifted prompt lands in the transcript under an idempotent
 * replace key, and every out-of-band param carried by `out://` is parsed back
 * from the delivered URL — params that never land in the transcript are a
 * failure, not a silent drop. Channels are awaited on the critical path:
 * no fire-and-forget.
 */

/** Session shape the gate reads: the persisted `syncTodos` marker only. */
export type InjectionGateRecord = Pick<SessionRecord, "syncTodos"> | undefined;

/** Direct sessions open a chat tab; managed sessions steer or resume an existing one. */
export type InjectionSessionKind = "direct" | "managed";

/** The two allowed strategies. Deterministic in-session is attempted first; `replace-via-out` is the final hop. */
export type InjectionStrategy = "deterministic-in-session" | "replace-via-out";

/** Session operations the deterministic channel maps onto, plus the final-hop handoff. */
export type SessionOperation = "create_chat_tab" | "steer" | "resume" | "injection_handoff";

/** Banned as a primary chat channel: never preselected, never fired. */
export const BANNED_INJECTION_STRATEGIES = ["native-dialog", "popup", "focus", "speech", "echo"] as const;

/** Host capabilities as exposed through the host LSP descriptor. */
export interface HostLspCapabilities {
	sessionKind: InjectionSessionKind;
	supportsDeterministic: boolean;
	supportsOut: boolean;
}

/**
 * Preselect the injection strategy per host LSP. Deterministic in-session is
 * preferred whenever the host supports it; the `replace-via-out` final hop is
 * used only when it does not. Banned heuristics are never returned.
 */
export function preselectInjectionStrategy(caps: HostLspCapabilities): InjectionStrategy {
	if (caps.supportsDeterministic) return "deterministic-in-session";
	if (caps.supportsOut) return "replace-via-out";
	return "replace-via-out";
}

/**
 * The deterministic session operation for a preselected strategy: direct
 * sessions create a chat tab, managed sessions steer (or resume when asked),
 * and the `replace-via-out` hop is an injection handoff.
 */
export function sessionOperationFor(input: {
	sessionKind: InjectionSessionKind;
	strategy: InjectionStrategy;
	resume?: boolean;
}): SessionOperation {
	if (input.strategy === "replace-via-out") return "injection_handoff";
	if (input.sessionKind === "direct") return "create_chat_tab";
	return input.resume === true ? "resume" : "steer";
}

/** One artifact in the delivery store. Only non-seeded negative artifacts are removed on fire. */
export interface ArtifactEntry {
	key: string;
	seeded: boolean;
	negative: boolean;
	text: string;
}

/** In-memory artifact store: add/list, and remove every prior non-seeded negative artifact on fire. */
export class ArtifactStore {
	readonly #entries: ArtifactEntry[] = [];

	add(entry: ArtifactEntry): void {
		this.#entries.push({ ...entry });
	}

	list(): ArtifactEntry[] {
		return this.#entries.map((entry) => ({ ...entry }));
	}

	/** Removes (and returns) every prior non-seeded negative artifact; seeded negatives stay. */
	removeNonSeededNegatives(): ArtifactEntry[] {
		const removed: ArtifactEntry[] = [];
		for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
			const entry = this.#entries[i];
			if (entry.seeded === false && entry.negative === true) {
				removed.push({ ...entry });
				this.#entries.splice(i, 1);
			}
		}
		return removed.reverse();
	}
}

/** One landed transcript entry. `outParams` are the params parsed back from `outUrl`. */
export interface TranscriptEntry {
	sessionId: string;
	promptText: string;
	replaceKey: string;
	outParams: Record<string, string>;
	outUrl: string;
	strategy: InjectionStrategy;
	operation: SessionOperation;
}

/** Transcript keyed by the idempotent replace key: re-delivering a key replaces its entry. */
export class TranscriptStore {
	readonly #byKey = new Map<string, TranscriptEntry>();

	put(entry: TranscriptEntry): TranscriptEntry {
		const stored = { ...entry, outParams: { ...entry.outParams } };
		this.#byKey.set(entry.replaceKey, stored);
		return { ...stored, outParams: { ...stored.outParams } };
	}

	get(replaceKey: string): TranscriptEntry | undefined {
		const entry = this.#byKey.get(replaceKey);
		return entry === undefined ? undefined : { ...entry, outParams: { ...entry.outParams } };
	}

	list(): TranscriptEntry[] {
		return [...this.#byKey.values()].map((entry) => ({ ...entry, outParams: { ...entry.outParams } }));
	}
}

/** Build the `replace-via-out://` URL carrying the session, the idempotent replace key, and the out-of-band params. */
export function buildReplaceViaOutUrl(input: {
	sessionId: string;
	replaceKey: string;
	outParams?: Record<string, string>;
}): string {
	const params = new URLSearchParams();
	params.set("key", input.replaceKey);
	for (const [name, value] of Object.entries(input.outParams ?? {})) {
		if (name === "key") continue;
		params.set(name, value);
	}
	return `replace-via-out:///session/${encodeURIComponent(input.sessionId)}?${params.toString()}`;
}

/** Parse a `replace-via-out://` (or `out://`) URL such that params demonstrably land in the transcript. */
export function parseReplaceViaOutUrl(url: string): { sessionId: string; replaceKey: string; outParams: Record<string, string> } {
	const parsed = new URL(url);
	const raw = parsed.host === "session" ? parsed.pathname.replace(/^\//, "") : parsed.pathname.replace(/^\/session\//, "");
	const sessionId = decodeURIComponent(raw);
	const replaceKey = parsed.searchParams.get("key") ?? "";
	const outParams: Record<string, string> = {};
	for (const [name, value] of parsed.searchParams.entries()) {
		if (name === "key") continue;
		outParams[name] = value;
	}
	return { sessionId, replaceKey, outParams };
}

/** Input to the deterministic in-session channel (attempted first). */
export interface DeterministicChannelInput {
	sessionId: string;
	promptText: string;
	sessionKind: InjectionSessionKind;
	operation: SessionOperation;
	replaceKey: string;
	outParams: Record<string, string>;
}

/** Deterministic in-session delivery: `create_chat_tab`/`steer`/`resume`. Awaited, never fire-and-forget. */
export type DeterministicChannel = (input: DeterministicChannelInput) => Promise<boolean> | boolean;

/** Final-hop delivery through `replace-via-out://`. Awaited, never fire-and-forget. */
export type OutChannel = (outUrl: string, entry: TranscriptEntry) => Promise<boolean> | boolean;

/** One gated final-hop injection request. */
export interface GatedInjectionInput {
	record: InjectionGateRecord;
	graphId: string;
	sessionId: string;
	promptText: string;
	replaceKey: string;
	outParams?: Record<string, string>;
	sessionKind: InjectionSessionKind;
	resume?: boolean;
	capabilities?: HostLspCapabilities;
}

/** Closed outcome set for the gated final hop. `queued` is the pre-gate no-op. */
export type GatedInjectionState = "queued" | "injected" | "dropped-with-reason";

/** Result of `GatedFinalHopInjector.inject`. */
export interface GatedInjectionResult {
	state: GatedInjectionState;
	strategy?: InjectionStrategy;
	operation?: SessionOperation;
	outUrl?: string;
	transcriptEntry?: TranscriptEntry;
	removedArtifacts: ArtifactEntry[];
	reason?: string;
	retryLog: string[];
}

/**
 * Gated final-hop injector (SPE-37786). Only fires when
 * `isSyncTodosDone(record, graphId)` is true; until then it is a queued no-op.
 * On fire it attempts the deterministic in-session channel first and falls
 * back to the `replace-via-out://` final hop; both are awaited. A confirmed
 * delivery removes every prior non-seeded negative artifact and writes the
 * transcript entry under the idempotent replace key, with out-of-band params
 * parsed from the delivered URL.
 */
export class GatedFinalHopInjector {
	readonly #deterministic: DeterministicChannel;
	readonly #out: OutChannel;
	readonly #artifacts: ArtifactStore;
	readonly #transcript: TranscriptStore;

	constructor(deps: {
		deterministic: DeterministicChannel;
		out: OutChannel;
		artifacts?: ArtifactStore;
		transcript?: TranscriptStore;
	}) {
		this.#deterministic = deps.deterministic;
		this.#out = deps.out;
		this.#artifacts = deps.artifacts ?? new ArtifactStore();
		this.#transcript = deps.transcript ?? new TranscriptStore();
	}

	transcript(): TranscriptStore {
		return this.#transcript;
	}

	artifacts(): ArtifactStore {
		return this.#artifacts;
	}

	async inject(input: GatedInjectionInput): Promise<GatedInjectionResult> {
		const retryLog: string[] = [];
		if (!isSyncTodosDoneGate(input.record, input.graphId)) {
			return {
				state: "queued",
				removedArtifacts: [],
				reason: "syncTodos not done for this graph",
				retryLog,
			};
		}
		const storedPrompt = redactSecrets(input.promptText);
		const outParams = { ...(input.outParams ?? {}) };
		const caps: HostLspCapabilities = input.capabilities ?? {
			sessionKind: input.sessionKind,
			supportsDeterministic: true,
			supportsOut: true,
		};
		const primary = preselectInjectionStrategy(caps);
		const deterministicOperation = sessionOperationFor({
			sessionKind: input.sessionKind,
			strategy: "deterministic-in-session",
			resume: input.resume,
		});
		const outOperation = sessionOperationFor({ sessionKind: input.sessionKind, strategy: "replace-via-out" });
		const outUrl = buildReplaceViaOutUrl({
			sessionId: input.sessionId,
			replaceKey: input.replaceKey,
			outParams,
		});
		const parsed = parseReplaceViaOutUrl(outUrl);

		const fire = (strategy: InjectionStrategy, operation: SessionOperation): GatedInjectionResult => {
			const removedArtifacts = this.#artifacts.removeNonSeededNegatives();
			const transcriptEntry: TranscriptEntry = {
				sessionId: parsed.sessionId,
				promptText: storedPrompt,
				replaceKey: parsed.replaceKey,
				outParams: parsed.outParams,
				outUrl,
				strategy,
				operation,
			};
			this.#transcript.put(transcriptEntry);
			return {
				state: "injected",
				strategy,
				operation,
				outUrl,
				transcriptEntry,
				removedArtifacts,
				retryLog,
			};
		};

		if (primary === "deterministic-in-session") {
			let delivered = false;
			let failure = "";
			try {
				delivered = (await this.#deterministic({
					sessionId: input.sessionId,
					promptText: storedPrompt,
					sessionKind: input.sessionKind,
					operation: deterministicOperation,
					replaceKey: input.replaceKey,
					outParams,
				})) === true;
				if (!delivered) failure = "deterministic channel returned false";
			} catch (error) {
				failure = error instanceof Error ? error.message : "deterministic channel threw";
			}
			if (delivered) return fire("deterministic-in-session", deterministicOperation);
			retryLog.push(`deterministic (${deterministicOperation}): failed (${redactSecrets(failure)})`);
		}

		let outDelivered = false;
		let outFailure = "";
		try {
			const entry: TranscriptEntry = {
				sessionId: parsed.sessionId,
				promptText: storedPrompt,
				replaceKey: parsed.replaceKey,
				outParams: parsed.outParams,
				outUrl,
				strategy: "replace-via-out",
				operation: outOperation,
			};
			outDelivered = (await this.#out(outUrl, entry)) === true;
			if (!outDelivered) outFailure = "replace-via-out channel returned false";
		} catch (error) {
			outFailure = error instanceof Error ? error.message : "replace-via-out channel threw";
		}
		if (outDelivered) return fire("replace-via-out", outOperation);
		retryLog.push(`replace-via-out: failed (${redactSecrets(outFailure)}); prompt retained (${storedPrompt.length} chars, sha256 ${sha256Hex(storedPrompt).slice(0, 12)}...)`);
		return {
			state: "dropped-with-reason",
			removedArtifacts: [],
			reason: redactSecrets(outFailure || "delivery channel unavailable"),
			retryLog,
		};
	}
}
