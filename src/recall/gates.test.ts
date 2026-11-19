// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultRecallSettings } from "./config.ts";
import {
	type BudgetCaps,
	type BudgetRequest,
	type BudgetState,
	type CooldownRequest,
	type CooldownWindows,
	type RecallSource,
	applyRelevanceFloor,
	checkBudget,
	checkCooldown,
	contentHash,
	createBudgetState,
	createCooldownState,
	createDedupeState,
	createFailureState,
	cooldownKey,
	dedupeKey,
	filterInjected,
	pruneCooldown,
	pruneFailures,
	recordCooldownFire,
	recordFailure,
	recordInjected,
	recordSpend,
	resetDedupeEpoch,
	resetTurn,
} from "./gates.ts";

const { budget: CAPS, cooldownMs } = defaultRecallSettings().recall;
const WINDOWS: CooldownWindows = cooldownMs;
const T0 = 1_000_000;

function scope(path: string, source: RecallSource = "knowledge"): CooldownRequest {
	return { source, trigger: "scopeChange", subject: { scopePath: path } };
}

function failure(error: string): CooldownRequest {
	return { source: "lessons", trigger: "failure", subject: { error } };
}

function phase(planStep: string, taskType: string): CooldownRequest {
	return { source: "moments", trigger: "phaseBoundary", subject: { planStep, taskType } };
}

function uncertainty(topic: string): CooldownRequest {
	return { source: "knowledge", trigger: "uncertainty", subject: { topic } };
}

/** A cooldown state holding one fire for `request` at `atMs`. */
function firedAt(request: CooldownRequest, atMs: number) {
	return recordCooldownFire(createCooldownState(), request, atMs);
}

function routine(tokens: number): BudgetRequest {
	return { trigger: "scopeChange", tokens };
}

/** Records `count` calls of `tokens` each, one per turn, so only the session counters grow. */
function spendInTurns(state: BudgetState, count: number, tokens: number): BudgetState {
	let next = state;
	for (let i = 0; i < count; i++) next = recordSpend(resetTurn(next), tokens);
	return next;
}

describe("cooldown", () => {
	test("a refire inside the window is refused and one at or after it is allowed", () => {
		const request = scope("src/a");
		const state = firedAt(request, T0);

		const inside = checkCooldown(state, request, WINDOWS, T0 + cooldownMs.scopeChange - 1);
		expect(inside).toEqual({
			allowed: false,
			reason: "cooldown_active",
			key: cooldownKey(request),
			remainingMs: 1,
		});
		expect(checkCooldown(state, request, WINDOWS, T0 + cooldownMs.scopeChange)).toMatchObject({
			allowed: true,
		});
		expect(checkCooldown(state, request, WINDOWS, T0 + cooldownMs.scopeChange + 1)).toMatchObject({
			allowed: true,
		});
	});

	test("scope changes cool down per normalized scope path", () => {
		const state = firedAt(scope("src/a"), T0);

		expect(checkCooldown(state, scope("src/b"), WINDOWS, T0 + 1)).toMatchObject({ allowed: true });
		expect(checkCooldown(state, scope("./src\\a/"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: false,
			reason: "cooldown_active",
		});
	});

	test("failures cool down per normalized error signature", () => {
		const state = firedAt(failure("TypeError at line 12: x is undefined"), T0);

		expect(
			checkCooldown(state, failure("typeerror at line 40:  x is undefined"), WINDOWS, T0 + 1),
		).toMatchObject({ allowed: false, reason: "cooldown_active" });
		expect(
			checkCooldown(state, failure("TypeError at line 12: y is undefined"), WINDOWS, T0 + 1),
		).toMatchObject({ allowed: true });
	});

	test("failure signatures that differ only by path, line, column or address cool down together", () => {
		const state = firedAt(failure("TypeError at /repo/src/a.ts:12:5: x is undefined"), T0);

		expect(
			checkCooldown(
				state,
				failure("TypeError at /other/lib/a.ts:40:9: x is undefined"),
				WINDOWS,
				T0 + 1,
			),
		).toMatchObject({ allowed: false, reason: "cooldown_active" });
		expect(
			checkCooldown(
				state,
				failure("TypeError at C:\\build\\a.ts:7:1: x is undefined"),
				WINDOWS,
				T0 + 1,
			),
		).toMatchObject({ allowed: false, reason: "cooldown_active" });
		expect(
			checkCooldown(
				state,
				failure("TypeError at /repo/src/a.ts:12:5: y is undefined"),
				WINDOWS,
				T0 + 1,
			),
		).toMatchObject({ allowed: true });

		const crash = firedAt(failure("segfault at 0x7ffd5c2a1b10"), T0);
		expect(
			checkCooldown(crash, failure("segfault at 0x7ffd5c2a9f00"), WINDOWS, T0 + 1),
		).toMatchObject({
			allowed: false,
		});
		expect(
			checkCooldown(crash, failure("segfault at 7ffd5c2a9f00"), WINDOWS, T0 + 1),
		).toMatchObject({
			allowed: false,
		});
	});

	test("phase boundaries cool down per plan step and task type", () => {
		const state = firedAt(phase("2", "migration"), T0);

		expect(checkCooldown(state, phase("3", "migration"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: true,
		});
		expect(checkCooldown(state, phase("2", "test"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: true,
		});
		expect(checkCooldown(state, phase(" 2 ", "MIGRATION"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: false,
			reason: "cooldown_active",
		});
		const later = T0 + 10 * 86_400_000;
		expect(checkCooldown(state, phase("2", "migration"), WINDOWS, later)).toMatchObject({
			allowed: false,
			remainingMs: Number.POSITIVE_INFINITY,
		});
	});

	test("uncertainty cools down per normalized topic, ignoring word order and case", () => {
		const state = firedAt(uncertainty("Auth token refresh"), T0);

		expect(checkCooldown(state, uncertainty("refresh TOKEN auth"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: false,
			reason: "cooldown_active",
		});
		expect(checkCooldown(state, uncertainty("database migration"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: true,
		});
	});

	test("the same subject under different sources does not share a cooldown", () => {
		const state = firedAt(scope("src/a", "knowledge"), T0);

		expect(checkCooldown(state, scope("src/a", "lessons"), WINDOWS, T0 + 1)).toMatchObject({
			allowed: true,
		});
	});

	test("recording a fire returns a new state and leaves the earlier one unchanged", () => {
		const request = scope("src/a");
		const before = createCooldownState();
		const after = recordCooldownFire(before, request, T0);

		expect(checkCooldown(before, request, WINDOWS, T0 + 1)).toMatchObject({ allowed: true });
		expect(checkCooldown(after, request, WINDOWS, T0 + 1)).toMatchObject({ allowed: false });
	});

	test("each windowed trigger refuses a repeat inside its own window and allows it at the window", () => {
		const cases: { request: CooldownRequest; window: number }[] = [
			{ request: scope("src/a"), window: cooldownMs.scopeChange },
			{ request: failure("TypeError at line 12"), window: cooldownMs.failure },
			{ request: uncertainty("which cache layer"), window: cooldownMs.uncertainty },
		];
		for (const { request, window } of cases) {
			const state = firedAt(request, T0);
			expect(checkCooldown(state, request, WINDOWS, T0 + window - 1)).toMatchObject({
				allowed: false,
				remainingMs: 1,
			});
			expect(checkCooldown(state, request, WINDOWS, T0 + window)).toMatchObject({ allowed: true });
		}
	});
});

describe("budget", () => {
	test("a routine request is refused by the turn call cap and admitted in the next turn", () => {
		const state = recordSpend(createBudgetState(), 100);

		expect(checkBudget(state, CAPS, routine(100))).toEqual({
			allowed: false,
			reason: "turn_calls_cap",
		});
		expect(checkBudget(resetTurn(state), CAPS, routine(100))).toEqual({ allowed: true });
	});

	test("resetTurn advances the turn counter, clears the turn spend and keeps the session spend", () => {
		const next = resetTurn(recordSpend(createBudgetState(), 100));

		expect(next).toEqual({
			turnIndex: 1,
			turn: { calls: 0, tokens: 0 },
			session: { calls: 1, tokens: 100 },
		});
	});

	test("a recorded spend keeps the turn index, so resetTurn advances it across prompts", () => {
		const first = recordSpend(createBudgetState(), 100);
		const turnOne = resetTurn(first);
		expect(turnOne.turnIndex).toBe(1);

		const second = recordSpend(turnOne, 100);
		expect(second.turnIndex).toBe(1);

		const turnTwo = resetTurn(second);
		expect(turnTwo.turnIndex).toBe(2);
		expect(turnTwo.session.calls).toBe(2);
	});

	test("a routine request is refused by the session call cap once every turn is fresh", () => {
		const routineShare = Math.floor(CAPS.perSessionCalls * (1 - CAPS.reservedShare));
		let state = createBudgetState();
		for (let i = 0; i < routineShare; i++) {
			const turn = resetTurn(state);
			expect(checkBudget(turn, CAPS, routine(10))).toEqual({ allowed: true });
			state = recordSpend(turn, 10);
		}

		expect(checkBudget(resetTurn(state), CAPS, routine(10))).toEqual({
			allowed: false,
			reason: "session_calls_cap",
		});
	});

	test("a routine request is refused by the turn token cap", () => {
		const caps: BudgetCaps = { ...CAPS, perTurnCalls: 10 };
		const state = recordSpend(createBudgetState(), 1000);
		const turnTokenShare = Math.floor(CAPS.perTurnTokens * (1 - CAPS.reservedShare));

		expect(checkBudget(state, caps, routine(turnTokenShare - 1000 + 1))).toEqual({
			allowed: false,
			reason: "turn_tokens_cap",
		});
		expect(checkBudget(state, caps, routine(turnTokenShare - 1000))).toEqual({ allowed: true });
	});

	test("an uncertainty request still has the reserved share after routine requests reach the session cap", () => {
		const routineShare = Math.floor(CAPS.perSessionCalls * (1 - CAPS.reservedShare));
		const reservedShare = CAPS.perSessionCalls - routineShare;
		const afterRoutine = spendInTurns(createBudgetState(), routineShare, 10);
		const uncertain: BudgetRequest = { trigger: "uncertainty", tokens: 10 };

		expect(checkBudget(resetTurn(afterRoutine), CAPS, routine(10))).toEqual({
			allowed: false,
			reason: "session_calls_cap",
		});
		expect(checkBudget(resetTurn(afterRoutine), CAPS, uncertain)).toEqual({ allowed: true });
		expect(checkBudget(resetTurn(afterRoutine), CAPS, { trigger: "explicit", tokens: 10 })).toEqual(
			{
				allowed: true,
			},
		);

		const afterReserved = spendInTurns(afterRoutine, reservedShare, 10);
		expect(checkBudget(resetTurn(afterReserved), CAPS, uncertain)).toEqual({
			allowed: false,
			reason: "session_calls_cap",
		});
	});

	test("a reserved request never exceeds the session token cap", () => {
		const caps: BudgetCaps = { ...CAPS, perTurnCalls: 10, perTurnTokens: 20_000 };
		const state = recordSpend(createBudgetState(), 7900);
		const explicit = (tokens: number): BudgetRequest => ({ trigger: "explicit", tokens });

		expect(checkBudget(state, caps, explicit(100))).toEqual({ allowed: true });
		expect(checkBudget(state, caps, explicit(101))).toEqual({
			allowed: false,
			reason: "session_tokens_cap",
		});
	});

	test("a non-finite token estimate is refused, not admitted", () => {
		expect(checkBudget(createBudgetState(), CAPS, routine(Number.NaN))).toEqual({
			allowed: false,
			reason: "invalid_tokens",
		});
	});
});

describe("relevance floor", () => {
	test("keeps items at or above the floor and returns the rest with their scores", () => {
		const result = applyRelevanceFloor(
			[
				{ item: "a", score: 0.9 },
				{ item: "b", score: 0.5 },
				{ item: "c", score: 0.49 },
			],
			0.5,
		);

		expect(result).toEqual({
			ok: true,
			kept: [
				{ item: "a", score: 0.9 },
				{ item: "b", score: 0.5 },
			],
			filtered: [{ item: "c", score: 0.49, reason: "below_floor" }],
		});
	});

	test("refuses a floor that is not a finite value in [0, 1]", () => {
		expect(applyRelevanceFloor([], Number.NaN)).toEqual({ ok: false, reason: "invalid_floor" });
		expect(applyRelevanceFloor([], 1.5)).toEqual({ ok: false, reason: "invalid_floor" });
	});
});

describe("dedupe", () => {
	test("skips an id already injected in the current epoch", () => {
		const first = filterInjected(createDedupeState(), [{ id: "lesson-1", content: "A" }]);
		const state = recordInjected(
			createDedupeState(),
			first.fresh.map((entry) => entry.key),
		);

		const second = filterInjected(state, [
			{ id: "lesson-1", content: "A, edited" },
			{ id: "lesson-2", content: "B" },
		]);

		expect(second.skipped.map((entry) => [entry.candidate.id, entry.reason])).toEqual([
			["lesson-1", "already_injected"],
		]);
		expect(second.fresh.map((entry) => entry.candidate.id)).toEqual(["lesson-2"]);
	});

	test("resets after compaction so an earlier id may be injected again", () => {
		const state = recordInjected(createDedupeState(), [
			dedupeKey({ id: "lesson-1", content: "A" }),
		]);
		const compacted = resetDedupeEpoch(state);

		expect(compacted.epoch).toBe(state.epoch + 1);
		expect(filterInjected(compacted, [{ id: "lesson-1", content: "A" }]).fresh).toHaveLength(1);
	});

	test("falls back to a content hash when there is no id, and skips a repeat within the batch", () => {
		const outcome = filterInjected(createDedupeState(), [
			{ content: "x" },
			{ content: "x" },
			{ content: "y" },
		]);

		expect(outcome.fresh.map((entry) => entry.candidate.content)).toEqual(["x", "y"]);
		expect(outcome.skipped.map((entry) => entry.reason)).toEqual(["duplicate_in_batch"]);

		const state = recordInjected(
			createDedupeState(),
			outcome.fresh.map((entry) => entry.key),
		);
		expect(filterInjected(state, [{ content: "x" }]).skipped.map((entry) => entry.reason)).toEqual([
			"already_injected",
		]);
	});

	test("contentHash is FNV-1a 32-bit", () => {
		expect(contentHash("")).toBe("811c9dc5");
		expect(contentHash("a")).toBe("e40c292c");
		expect(contentHash("foobar")).toBe("bf9cf968");
	});
});

describe("session state", () => {
	test("pruning drops windowed fires older than the largest window and keeps once-per-session fires", () => {
		const state = recordCooldownFire(
			recordCooldownFire(createCooldownState(), scope("src/a"), T0),
			phase("2", "migration"),
			T0,
		);

		const kept = pruneCooldown(state, T0 + cooldownMs.scopeChange - 1, cooldownMs.scopeChange);
		expect(kept.size).toBe(2);
		const pruned = pruneCooldown(state, T0 + cooldownMs.scopeChange, cooldownMs.scopeChange);
		expect([...pruned.keys()]).toEqual([cooldownKey(phase("2", "migration"))]);
		const later = T0 + 10 * 86_400_000;
		expect(checkCooldown(pruned, phase("2", "migration"), WINDOWS, later)).toMatchObject({
			allowed: false,
			reason: "cooldown_active",
		});
	});
});

describe("failure occurrences", () => {
	test("counts repeats of one normalized signature while they are within the window", () => {
		const window = cooldownMs.failure;
		const first = recordFailure(createFailureState(), "TypeError at line 12: x", T0, window);
		const second = recordFailure(first.state, "typeerror at line 40:  x", T0 + 1, window);
		const other = recordFailure(second.state, "TypeError at line 7: y", T0 + 2, window);

		expect([first.occurrence, second.occurrence, other.occurrence]).toEqual([1, 2, 1]);
	});

	test("an occurrence exactly one window after the last starts the count again", () => {
		const window = cooldownMs.failure;
		const first = recordFailure(createFailureState(), "boom", T0, window);

		expect(recordFailure(first.state, "boom", T0 + window, window).occurrence).toBe(1);
	});

	test("pruning drops the records that are a window old", () => {
		const { state } = recordFailure(createFailureState(), "boom", T0, cooldownMs.failure);

		expect(pruneFailures(state, T0 + cooldownMs.failure - 1, cooldownMs.failure).size).toBe(1);
		expect(pruneFailures(state, T0 + cooldownMs.failure, cooldownMs.failure).size).toBe(0);
	});
});
