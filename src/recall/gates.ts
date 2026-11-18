// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Pure gates for mid-session recall: cooldown per (source, trigger, cooldown key), per-turn and per-session budget with
 * a reserved share for explicit and uncertainty requests, a relevance floor that keeps the filtered items visible, and
 * dedupe of stable ids within a context epoch. Every gate takes its clock and its state as arguments and returns a new
 * state rather than mutating one, and every refusal names its reason so the audit record can say why a recall fired or
 * was skipped. No I/O, no clock reads, no node or Bun imports.
 */
import type { RecallSettings } from "./config.ts";

/** Every trigger the recall gate knows. `explicit` is a user request and has no cooldown. */
type RecallTrigger = keyof RecallSettings["recall"]["triggers"];
/** Triggers that fire on their own and therefore cool down. */
type CooldownTrigger = Exclude<RecallTrigger, "explicit">;
/** A recall source, named as the settings name it. */
export type RecallSource = keyof RecallSettings["recall"]["sources"];
export type BudgetCaps = RecallSettings["recall"]["budget"];
/** Cooldown window per windowed automatic trigger, in ms. A phase boundary has no window: it fires once per session. */
export type CooldownWindows = RecallSettings["recall"]["cooldownMs"];

/** The subject a cooldown is keyed on. Each trigger has exactly one subject shape. */
interface CooldownSubjects {
	/** Scope path that changed. Normalized before keying. */
	scopeChange: { scopePath: string };
	/** Raw error text. Normalized to a signature before keying. */
	failure: { error: string };
	/** Plan step and task type at a phase boundary. Each is normalized before keying. */
	phaseBoundary: { planStep: string; taskType: string };
	/** Free-text topic of the uncertainty. Normalized and hashed before keying. */
	uncertainty: { topic: string };
}

export type CooldownRequest = {
	[T in CooldownTrigger]: { source: RecallSource; trigger: T; subject: CooldownSubjects[T] };
}[CooldownTrigger];

/** The fire recorded for one cooldown key. A phase boundary fires once per session and never ages out. */
interface CooldownFire {
	readonly atMs: number;
	readonly oncePerSession: boolean;
}

/** Last fire per cooldown key. Immutable: a fire produces a new map. */
export type CooldownState = ReadonlyMap<string, CooldownFire>;

export type CooldownDecision =
	| { allowed: true; key: string }
	| { allowed: false; reason: "cooldown_active"; key: string; remainingMs: number };

/** Why a budget request was refused. Each cap names itself; `invalid_tokens` is a non-finite or negative estimate. */
type BudgetRefusal =
	| "turn_calls_cap"
	| "turn_tokens_cap"
	| "session_calls_cap"
	| "session_tokens_cap"
	| "invalid_tokens";

interface BudgetSpend {
	readonly calls: number;
	readonly tokens: number;
}

export interface BudgetState {
	/** The turn counter: `resetTurn` advances it at each turn boundary. */
	readonly turnIndex: number;
	/** Spend in the current turn. `resetTurn` clears it. */
	readonly turn: BudgetSpend;
	/** Spend in the session. It carries over every turn. */
	readonly session: BudgetSpend;
}

export interface BudgetRequest {
	readonly trigger: RecallTrigger;
	/** Estimated tokens the recall would inject. */
	readonly tokens: number;
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: BudgetRefusal };

export interface ScoredCandidate<T> {
	readonly item: T;
	readonly score: number;
}

interface FilteredCandidate<T> extends ScoredCandidate<T> {
	readonly reason: "below_floor";
}

export type FloorResult<T> =
	| { ok: true; kept: ScoredCandidate<T>[]; filtered: FilteredCandidate<T>[] }
	| { ok: false; reason: "invalid_floor" };

export interface DedupeCandidate {
	/** Stable id from the source. When present it is the dedupe key. */
	readonly id?: string;
	/** Content used for the fallback key when there is no id. */
	readonly content: string;
}

export interface DedupeState {
	/** Context epoch. Incremented on compaction. */
	readonly epoch: number;
	readonly injected: ReadonlySet<string>;
}

interface DedupeEntry<T> {
	readonly candidate: T;
	readonly key: string;
}

interface DedupeSkip<T> extends DedupeEntry<T> {
	readonly reason: "already_injected" | "duplicate_in_batch";
}

export interface DedupeOutcome<T> {
	readonly fresh: DedupeEntry<T>[];
	readonly skipped: DedupeSkip<T>[];
}

/** Reserved requests may use the reserved share of each cap. Routine requests may not. */
function isReservedTrigger(trigger: RecallTrigger): boolean {
	return trigger === "uncertainty" || trigger === "explicit";
}

/**
 * FNV-1a 32-bit over UTF-16 code units, as eight lowercase hex digits. Deterministic across runtimes; not a
 * cryptographic hash, and it is only used to key cooldown topics and fallback content.
 */
export function contentHash(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Scope path with separators unified, repeated slashes collapsed, a leading `./` and any trailing slash removed. */
function normalizeScopePath(path: string): string {
	const collapsed = path
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^(\.\/)+/, "");
	return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** Error signature: lowercase, hex addresses and digit runs replaced by `#`, whitespace collapsed. */
function normalizeErrorSignature(error: string): string {
	return error
		.toLowerCase()
		.replace(/0x[0-9a-f]+/g, "#")
		.replace(/\d+/g, "#")
		.replace(/\s+/g, " ")
		.trim();
}

/** Topic words: lowercase, split on non-letter and non-digit runs, deduplicated and sorted, so word order and case do not matter. */
function normalizeTopic(topic: string): string {
	const words = topic
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 0);
	return [...new Set(words)].sort().join(" ");
}

/** Label for a plan step or task type: trimmed, whitespace collapsed, lowercase. */
function normalizeLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function subjectParts(request: CooldownRequest): readonly string[] {
	switch (request.trigger) {
		case "scopeChange":
			return ["scope", normalizeScopePath(request.subject.scopePath)];
		case "failure":
			return ["failure", normalizeErrorSignature(request.subject.error)];
		case "phaseBoundary":
			return [
				"phase",
				normalizeLabel(request.subject.planStep),
				normalizeLabel(request.subject.taskType),
			];
		case "uncertainty":
			return ["topic", contentHash(normalizeTopic(request.subject.topic))];
	}
}

/** Cooldown key for one (source, trigger, normalized subject). JSON encoding keeps the parts unambiguous. */
export function cooldownKey(request: CooldownRequest): string {
	return JSON.stringify([request.source, request.trigger, ...subjectParts(request)]);
}

export function createCooldownState(): CooldownState {
	return new Map();
}

/**
 * Allowed only when the last fire for this key is at least the trigger's window old. The window is a minimum gap, so a
 * fire exactly one window ago is allowed. A last fire in the future (clock moved back) counts as inside the window. A
 * phase boundary has an infinite window, so its key stays refused for the rest of the session.
 */
export function checkCooldown(
	state: CooldownState,
	request: CooldownRequest,
	windowsMs: CooldownWindows,
	nowMs: number,
): CooldownDecision {
	const key = cooldownKey(request);
	const fire = state.get(key);
	if (fire === undefined) return { allowed: true, key };
	const windowMs =
		request.trigger === "phaseBoundary" ? Number.POSITIVE_INFINITY : windowsMs[request.trigger];
	const elapsed = nowMs - fire.atMs;
	if (elapsed >= windowMs) return { allowed: true, key };
	return { allowed: false, reason: "cooldown_active", key, remainingMs: windowMs - elapsed };
}

/** Records a fire for a request's key at `nowMs`. Returns a new state; the input is unchanged. */
export function recordCooldownFire(
	state: CooldownState,
	request: CooldownRequest,
	nowMs: number,
): CooldownState {
	const fire: CooldownFire = { atMs: nowMs, oncePerSession: request.trigger === "phaseBoundary" };
	return new Map(state).set(cooldownKey(request), fire);
}

/**
 * Drops the fires older than `maxAgeMs`. Each is already allowed at that age, so dropping one changes no decision. A
 * once-per-session fire never ages out. Returns a new state; the input is unchanged.
 */
export function pruneCooldown(
	state: CooldownState,
	nowMs: number,
	maxAgeMs: number,
): CooldownState {
	const kept = new Map<string, CooldownFire>();
	for (const [key, fire] of state) {
		if (fire.oncePerSession || nowMs - fire.atMs < maxAgeMs) kept.set(key, fire);
	}
	return kept;
}

export function createBudgetState(): BudgetState {
	return { turnIndex: 0, turn: { calls: 0, tokens: 0 }, session: { calls: 0, tokens: 0 } };
}

/** Starts a new turn: the turn counter advances and the turn counters reset; the session counters carry over. */
export function resetTurn(state: BudgetState): BudgetState {
	return { turnIndex: state.turnIndex + 1, turn: { calls: 0, tokens: 0 }, session: state.session };
}

/** Records one recall call that injected `tokens` tokens against both the turn and the session. */
export function recordSpend(state: BudgetState, tokens: number): BudgetState {
	return {
		turnIndex: state.turnIndex,
		turn: { calls: state.turn.calls + 1, tokens: state.turn.tokens + tokens },
		session: { calls: state.session.calls + 1, tokens: state.session.tokens + tokens },
	};
}

/**
 * Admits a request against the turn cap, then the session cap, each for calls and for tokens. A routine request sees
 * only the share of each cap that the reserved share leaves free, so explicit and uncertainty requests always find room.
 * A reserved request sees the whole cap, and still never passes the session cap. A refusal names the cap that refused.
 */
export function checkBudget(
	state: BudgetState,
	caps: BudgetCaps,
	request: BudgetRequest,
): BudgetDecision {
	if (!Number.isFinite(request.tokens) || request.tokens < 0) {
		return { allowed: false, reason: "invalid_tokens" };
	}
	const usable = (cap: number): number =>
		Math.floor(cap * (isReservedTrigger(request.trigger) ? 1 : 1 - caps.reservedShare));
	if (state.turn.calls + 1 > usable(caps.perTurnCalls)) {
		return { allowed: false, reason: "turn_calls_cap" };
	}
	if (state.turn.tokens + request.tokens > usable(caps.perTurnTokens)) {
		return { allowed: false, reason: "turn_tokens_cap" };
	}
	if (state.session.calls + 1 > usable(caps.perSessionCalls)) {
		return { allowed: false, reason: "session_calls_cap" };
	}
	if (state.session.tokens + request.tokens > usable(caps.perSessionTokens)) {
		return { allowed: false, reason: "session_tokens_cap" };
	}
	return { allowed: true };
}

/**
 * Keeps candidates whose score is at or above the floor. Every candidate keeps its score, and the filtered ones are
 * returned with `below_floor`, so the caller can show what was left out. A non-finite floor, or one outside [0, 1], is
 * refused rather than applied.
 */
export function applyRelevanceFloor<T>(
	candidates: readonly ScoredCandidate<T>[],
	floor: number,
): FloorResult<T> {
	if (!Number.isFinite(floor) || floor < 0 || floor > 1) {
		return { ok: false, reason: "invalid_floor" };
	}
	const kept: ScoredCandidate<T>[] = [];
	const filtered: FilteredCandidate<T>[] = [];
	for (const candidate of candidates) {
		if (candidate.score >= floor) {
			kept.push({ item: candidate.item, score: candidate.score });
		} else {
			filtered.push({ item: candidate.item, score: candidate.score, reason: "below_floor" });
		}
	}
	return { ok: true, kept, filtered };
}

/** Dedupe key: `id:<stable id>` when the candidate has one, otherwise `content:<hash of its content>`. */
export function dedupeKey(candidate: DedupeCandidate): string {
	return candidate.id !== undefined && candidate.id.length > 0
		? `id:${candidate.id}`
		: `content:${contentHash(candidate.content)}`;
}

export function createDedupeState(): DedupeState {
	return { epoch: 0, injected: new Set() };
}

/**
 * Splits candidates into those to inject and those to skip. A key already injected in this epoch is skipped, and so is
 * a later candidate with a key an earlier candidate in the same batch already took.
 */
export function filterInjected<T extends DedupeCandidate>(
	state: DedupeState,
	candidates: readonly T[],
): DedupeOutcome<T> {
	const fresh: DedupeEntry<T>[] = [];
	const skipped: DedupeSkip<T>[] = [];
	const batch = new Set<string>();
	for (const candidate of candidates) {
		const key = dedupeKey(candidate);
		if (state.injected.has(key)) {
			skipped.push({ candidate, key, reason: "already_injected" });
		} else if (batch.has(key)) {
			skipped.push({ candidate, key, reason: "duplicate_in_batch" });
		} else {
			batch.add(key);
			fresh.push({ candidate, key });
		}
	}
	return { fresh, skipped };
}

/** Marks keys as injected in the current epoch. Returns a new state; the input is unchanged. */
export function recordInjected(state: DedupeState, keys: readonly string[]): DedupeState {
	const injected = new Set(state.injected);
	for (const key of keys) injected.add(key);
	return { epoch: state.epoch, injected };
}

/** Context compaction: starts a new epoch with nothing injected, so earlier items may be injected again. */
export function resetDedupeEpoch(state: DedupeState): DedupeState {
	return { epoch: state.epoch + 1, injected: new Set() };
}

/** Occurrences of one normalized error signature: how many came up while recent, and when the last one did. */
interface FailureRecord {
	readonly count: number;
	readonly lastMs: number;
}

/** Failure occurrences per error signature. Immutable: a record produces a new map. */
export type FailureState = ReadonlyMap<string, FailureRecord>;

export function createFailureState(): FailureState {
	return new Map();
}

/**
 * Counts one occurrence of an error. An earlier occurrence counts only while it is within `maxAgeMs`, so an error that
 * has gone quiet starts again at its first occurrence. Returns that occurrence's number (1 for the first) and a new state.
 */
export function recordFailure(
	state: FailureState,
	error: string,
	nowMs: number,
	maxAgeMs: number,
): { occurrence: number; state: FailureState } {
	const signature = normalizeErrorSignature(error);
	const prior = state.get(signature);
	const recent = prior !== undefined && nowMs - prior.lastMs < maxAgeMs ? prior.count : 0;
	const occurrence = recent + 1;
	return { occurrence, state: new Map(state).set(signature, { count: occurrence, lastMs: nowMs }) };
}

/** Drops the records that have aged past `maxAgeMs`. Returns a new state; the input is unchanged. */
export function pruneFailures(state: FailureState, nowMs: number, maxAgeMs: number): FailureState {
	const kept = new Map<string, FailureRecord>();
	for (const [signature, record] of state) {
		if (nowMs - record.lastMs < maxAgeMs) kept.set(signature, record);
	}
	return kept;
}
