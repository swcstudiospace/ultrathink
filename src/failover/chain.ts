// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Ordered failover over completers. A candidate whose failure another candidate could cover is skipped
 * for a cooldown instead of being retried on every stage call; the CLIs already retry 429/529 themselves.
 */

import { abortError } from "../claude/complete.ts";
import { redactSecrets } from "../grok/auth.ts";
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

export function createFailoverCompleter(
	candidates: readonly FailoverCandidate[],
	opts: { now?: () => number } = {},
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
		if (signal?.aborted) throw abortError();
		const at = now();
		const ready = candidates.filter((c) => (cooldownUntil.get(c.id) ?? 0) <= at);
		const walk = ready.length > 0 ? ready : candidates;
		const failed: { label: string; message: string }[] = [];
		let firstError: unknown;
		for (const candidate of walk) {
			if (signal?.aborted) throw abortError();
			try {
				const text = await candidate.complete(system, user, signal);
				if (candidate !== first) {
					failoverText = `${first.label} → ${candidate.label} (${lastFailure.get(first.id) ?? "other"})`;
				}
				return text;
			} catch (error) {
				const failure = classifyFailure(error);
				if (failure === "aborted" || signal?.aborted) throw error;
				const message = safeMessage(error, MAX_ATTEMPT_MESSAGE_CHARS);
				attempts.push({ candidate: candidate.id, failure, message });
				if (attempts.length > MAX_KEPT_ATTEMPTS) attempts.shift();
				lastFailure.set(candidate.id, failure);
				if (!isFailoverWorthy(failure)) throw error;
				cooldownUntil.set(candidate.id, now() + failureCooldownMs(failure));
				firstError ??= error;
				failed.push({ label: candidate.label, message });
			}
		}
		const summary = failed.map((f) => `${f.label}: ${f.message}`).join("; ");
		throw new Error(redactSecrets(summary.slice(0, MAX_ERROR_CHARS)), { cause: firstError });
	};

	return {
		complete,
		attempts: () => attempts.slice(),
		failover: () => failoverText,
	};
}
