// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * A wait that ends at once, with an `AbortError`, when the signal aborts. The timer and the abort listener are
 * released on every path. `isAbortError` in `src/shared.ts` stays the only abort check; this module only raises one.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const aborted = (): Error =>
		Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
	if (signal?.aborted) {
		reject(aborted());
		return promise;
	}
	const onAbort = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		reject(aborted());
	};
	const timer = setTimeout(
		() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		},
		Math.max(0, ms),
	);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/**
 * A wait that resolves after ms and never rejects; it ignores aborts. Use abortableSleep where an abort must end the wait.
 */
export function sleep(ms: number): Promise<void> {
	return Bun.sleep(ms);
}
