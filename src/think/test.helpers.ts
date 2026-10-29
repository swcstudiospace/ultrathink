// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { abortableSleep } from "../resilience/sleep.ts";
import { runThink, type RunThinkOptions, type ThinkResult } from "./pipeline.ts";

/**
 * The real Graph of Thought with its retry backoff collapsed to one macrotask. A fill that fails (a fake model that
 * answers every call with the same canned reply, a provider that throws) is retried with 500 ms to 8 s of real backoff
 * per attempt: several seconds per planned prompt on any host, over the 5 s default budget of a CI test. Retries still
 * run, an abort still ends the wait with its AbortError; only the delay is gone. A test that asserts on the backoff
 * passes its own `sleep` through `runThink`.
 */
export function instantThink(opts: RunThinkOptions): Promise<ThinkResult> {
	return runThink({ sleep: (_ms, signal) => abortableSleep(0, signal), ...opts });
}
