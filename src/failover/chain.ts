// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Ordered failover over completers. A candidate whose failure another candidate could cover is skipped
 * for a cooldown instead of being retried on every stage call; the CLIs already retry 429/529 themselves.
 */

import { updateJsonAtomic } from "../claude/atomic.ts";
import { abortError } from "../claude/complete.ts";
import { redactSecrets } from "../redact.ts";
import { readJson } from "../shared.ts";
import { redactLine } from "../teach/redact.ts";
import { attachReport, type CompletionReport, readReport } from "../types.ts";
import {
	classifyFailure,
	type FailureClass,
	failureCooldownMs,
	isFailoverWorthy,
} from "./classify.ts";

export type Completer = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export interface FailoverCandidate {
	id: string;
	label: string;
	complete: Completer;
	/**
	 * Identity of the access path (transport, endpoint, login home). Persisted cooldowns are keyed by id and route, so
	 * two routes to a same-named model never cool each other. It reaches the state file, so it must hold no secret.
	 */
	route?: string;
}

interface FailoverAttempt {
	/** `FailoverCandidate.id` of the candidate that failed. */
	candidate: string;
	failure: FailureClass;
	/** Redacted, clipped to 160 characters. */
	message: string;
}

export interface FailoverCompleter {
	complete: Completer;
	attempts(): readonly FailoverAttempt[];
	/** Cumulative: set once any call was answered by a later candidate and never cleared. */
	failover(): string | undefined;
}

const MAX_ATTEMPT_MESSAGE_CHARS = 160;
const MAX_ERROR_CHARS = 500;
/** A long-lived process must not grow this without bound. */
const MAX_KEPT_ATTEMPTS = 100;

function safeMessage(error: unknown, max: number): string {
	const text = error instanceof Error ? error.message : String(error);
	return redactSecrets(redactLine(text, max)).slice(0, max);
}

const FAILURE_CLASSES: ReadonlySet<string> = new Set([
	"auth",
	"billing",
	"plan-limit",
	"rate-limit",
	"overloaded",
	"model-unavailable",
	"unavailable",
	"network",
	"timeout",
]);

interface CooldownFile {
	until: Record<string, number>;
	failure: Record<string, FailureClass>;
}

/** A persisted entry is keyed by the candidate id and, when it has one, its route (see {@link FailoverCandidate.route}). */
function cooldownKey(candidate: FailoverCandidate): string {
	return candidate.route === undefined ? candidate.id : `${candidate.id}@${candidate.route}`;
}

/** Fail-open: anything that is not a well-formed file reads as an empty one; entries that already lapsed are dropped. */
function parseCooldowns(raw: unknown, at: number): CooldownFile {
	const out: CooldownFile = { until: {}, failure: {} };
	if (typeof raw !== "object" || raw === null) return out;
	const until: unknown = Reflect.get(raw, "until");
	const failure: unknown = Reflect.get(raw, "failure");
	if (typeof until !== "object" || until === null) return out;
	for (const [id, value] of Object.entries(until)) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= at) continue;
		const cls: unknown =
			typeof failure === "object" && failure !== null ? Reflect.get(failure, id) : undefined;
		if (typeof cls !== "string" || !FAILURE_CLASSES.has(cls)) continue;
		out.until[id] = value;
		out.failure[id] = cls as FailureClass;
	}
	return out;
}

/**
 * The combined error carries a completion report (the last failed candidate's), so a caller that retries on a missing
 * report, such as the fill layer of the think stage, sees that every candidate was already tried and cooled.
 */
function failoverError(
	summary: string,
	cause: unknown,
	failure: FailureClass,
	report: CompletionReport,
): Error {
	const error = Object.assign(
		new Error(redactSecrets(summary.slice(0, MAX_ERROR_CHARS)), { cause }),
		{ name: "FailoverError", failure },
	);
	attachReport(error, report);
	return error;
}

/**
 * Ordered failover over `candidates`. One candidate is returned untouched. Cooldowns, `attempts()` and
 * `failover()` live for the life of the returned completer. With `opts.persist` the cooldowns also live in a small
 * JSON file, so the next hook process starts with the same candidates cooling (probe flags stay process-local: a
 * fresh process may probe once). When every candidate fails the thrown `FailoverError` carries `failure`, the
 * class of the first failure in that walk. While every candidate is cooling nothing is invoked and that error
 * is thrown again at once; when a window lapses exactly one candidate (the earliest to expire) is probed per call.
 *
 * `onFailover` is called synchronously, inside the `complete` call itself, with the summary of that
 * call whenever a candidate after the first answers it. Callers that share one chain between
 * concurrent calls must use it rather than `failover()`, which is cumulative. It never fires for a
 * single candidate, when the first candidate answers or when every candidate fails.
 */
export function createFailoverCompleter(
	candidates: readonly FailoverCandidate[],
	opts: {
		now?: () => number;
		onFailover?: (summary: string) => void;
		persist?: { path: string };
	} = {},
): FailoverCompleter {
	const [first] = candidates;
	if (first === undefined) throw new Error("createFailoverCompleter needs at least one candidate");
	if (candidates.length === 1) {
		return { complete: first.complete, attempts: () => [], failover: () => undefined };
	}
	const now = opts.now ?? Date.now;
	const cooldownUntil = new Map<string, number>();
	const lastFailure = new Map<string, FailureClass>();
	const attempts: FailoverAttempt[] = [];
	let failoverText: string | undefined;
	/** The error of the most recent fully failed walk; cleared by any answer. */
	let remembered: Error | undefined;
	/** Candidates with a probe in flight, so a concurrent call does not probe the same one twice. */
	const probing = new Set<string>();
	/** Candidates whose last outcome was a failover-worthy failure. */
	const failing = new Set<string>();
	const persistPath = opts.persist?.path;
	if (persistPath !== undefined) {
		const saved = parseCooldowns(readJson(persistPath), now());
		for (const candidate of candidates) {
			const key = cooldownKey(candidate);
			const until = saved.until[key];
			if (until === undefined) continue;
			cooldownUntil.set(candidate.id, until);
			failing.add(candidate.id);
			const failure = saved.failure[key];
			if (failure !== undefined) lastFailure.set(candidate.id, failure);
		}
	}

	function earliestExpiry(list: readonly FailoverCandidate[]): FailoverCandidate | undefined {
		let best: FailoverCandidate | undefined;
		for (const candidate of list) {
			const until = cooldownUntil.get(candidate.id) ?? 0;
			if (best === undefined || until < (cooldownUntil.get(best.id) ?? 0)) best = candidate;
		}
		return best;
	}

	function persist(): void {
		if (persistPath === undefined) return;
		try {
			// Under the file lock: other hook processes share the file, so this merges into what is there now and never
			// drops an entry it does not own (a cooldown another chain learned after this one was built stays).
			updateJsonAtomic(persistPath, (current) => {
				const at = now();
				const merged = parseCooldowns(current, at);
				for (const candidate of candidates) {
					const until = cooldownUntil.get(candidate.id);
					const failure = lastFailure.get(candidate.id);
					if (until === undefined || until <= at || failure === undefined) continue;
					const key = cooldownKey(candidate);
					if ((merged.until[key] ?? 0) >= until) continue;
					merged.until[key] = until;
					merged.failure[key] = failure;
				}
				return merged;
			});
		} catch {
			// reason: cooldown persistence is an optimization; a failed write must never change the completion outcome
		}
	}

	/** The error for a call that finds every candidate cooling and has nothing to probe. */
	function coolingError(): Error {
		if (remembered !== undefined) return remembered;
		const parts: string[] = [];
		let firstFailure: FailureClass | undefined;
		for (const candidate of candidates) {
			const failure = lastFailure.get(candidate.id) ?? "other";
			firstFailure ??= failure;
			parts.push(`${candidate.label}: cooling after ${failure}`);
		}
		remembered = failoverError(parts.join("; "), undefined, firstFailure ?? "other", {
			attempts: 1,
		});
		return remembered;
	}

	const complete: Completer = async (system, user, signal) => {
		let firstFailureHere: FailureClass | undefined;
		if (signal?.aborted) throw abortError();
		const at = now();
		const ready = candidates.filter((c) => (cooldownUntil.get(c.id) ?? 0) <= at);
		if (ready.length === 0) throw coolingError();
		let walk = ready;
		// Every candidate has failed and none has answered since: probe the earliest to recover, never re-walk them all.
		const probe = candidates.every((c) => failing.has(c.id)) ? earliestExpiry(ready) : undefined;
		if (probe !== undefined) {
			if (probing.has(probe.id)) throw coolingError();
			walk = [probe];
			probing.add(probe.id);
		}
		const failed: { label: string; message: string }[] = [];
		let firstError: unknown;
		/** The completion report of the last candidate that failed: the walk's final word on how hard it tried. */
		let lastReport: CompletionReport | undefined;
		let firstFailure: FailureClass = "other";
		try {
			for (const candidate of walk) {
				if (signal?.aborted) throw abortError();
				try {
					const text = await candidate.complete(system, user, signal);
					failing.delete(candidate.id);
					remembered = undefined;
					if (candidate !== first) {
						const summary = `${first.label} → ${candidate.label} (${firstFailureHere ?? lastFailure.get(first.id) ?? "other"})`;
						failoverText = summary;
						try {
							opts.onFailover?.(summary);
						} catch {
							// reason: a reporting hook must never change the completion outcome
						}
					}
					return text;
				} catch (error) {
					const failure = classifyFailure(error);
					if (failure === "aborted" || signal?.aborted) throw error;
					const message = safeMessage(error, MAX_ATTEMPT_MESSAGE_CHARS);
					attempts.push({ candidate: candidate.id, failure, message });
					if (attempts.length > MAX_KEPT_ATTEMPTS) attempts.shift();
					lastFailure.set(candidate.id, failure);
					if (candidate === first) firstFailureHere = failure;
					if (!isFailoverWorthy(failure)) throw error;
					cooldownUntil.set(candidate.id, now() + failureCooldownMs(failure));
					failing.add(candidate.id);
					persist();
					if (failed.length === 0) {
						firstError = error;
						firstFailure = failure;
					}
					failed.push({ label: candidate.label, message });
					lastReport = readReport(error);
				}
			}
		} finally {
			if (probe !== undefined) probing.delete(probe.id);
		}
		const summary = failed.map((f) => `${f.label}: ${f.message}`).join("; ");
		remembered = failoverError(
			summary,
			firstError,
			firstFailure,
			lastReport ?? { attempts: Math.max(1, failed.length) },
		);
		throw remembered;
	};

	return {
		complete,
		attempts: () => attempts.slice(),
		failover: () => failoverText,
	};
}
