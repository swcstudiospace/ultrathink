// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Ordered failover over completers. A candidate whose failure another candidate could cover is skipped
 * for a cooldown instead of being retried on every stage call; the CLIs already retry 429/529 themselves.
 */

import { abortError } from "../claude/complete.ts";
import { redactSecrets } from "../redact.ts";
import { redactLine } from "../teach/redact.ts";
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

/**
 * Ordered failover over `candidates`. One candidate is returned untouched. Cooldowns, `attempts()` and
 * `failover()` live for the life of the returned completer, not across prompts or processes: a hook
 * that builds a new chain per prompt starts with every candidate ready. When every candidate fails
 * the thrown `FailoverError` carries `failure`, the class of the first failure in that walk.
 *
 * `onFailover` is called synchronously, inside the `complete` call itself, with the summary of that
 * call whenever a candidate after the first answers it. Callers that share one chain between
 * concurrent calls must use it rather than `failover()`, which is cumulative. It never fires for a
 * single candidate, when the first candidate answers or when every candidate fails.
 */
export function createFailoverCompleter(
	candidates: readonly FailoverCandidate[],
	opts: { now?: () => number; onFailover?: (summary: string) => void } = {},
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

	const complete: Completer = async (system, user, signal) => {
		let firstFailureHere: FailureClass | undefined;
		if (signal?.aborted) throw abortError();
		const at = now();
		const ready = candidates.filter((c) => (cooldownUntil.get(c.id) ?? 0) <= at);
		const walk = ready.length > 0 ? ready : candidates;
		const failed: { label: string; message: string }[] = [];
		let firstError: unknown;
		let firstFailure: FailureClass = "other";
		for (const candidate of walk) {
			if (signal?.aborted) throw abortError();
			try {
				const text = await candidate.complete(system, user, signal);
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
				if (failed.length === 0) {
					firstError = error;
					firstFailure = failure;
				}
				failed.push({ label: candidate.label, message });
			}
		}
		const summary = failed.map((f) => `${f.label}: ${f.message}`).join("; ");
		throw Object.assign(
			new Error(redactSecrets(summary.slice(0, MAX_ERROR_CHARS)), { cause: firstError }),
			{ name: "FailoverError", failure: firstFailure },
		);
	};

	return {
		complete,
		attempts: () => attempts.slice(),
		failover: () => failoverText,
	};
}
