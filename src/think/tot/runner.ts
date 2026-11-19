// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { isAbsolute, join } from "node:path";
import { writeFileAtomic } from "../../claude/atomic.ts";
import { redactSecrets } from "../../redact.ts";
import { clip } from "../../resilience/limits.ts";
import {
	type FailureVerdict,
	isTransientFailure,
	RetryExhaustedError,
	type RetryPolicy,
	type RetrySeams,
	withRetry,
} from "../../resilience/retry.ts";
import { isAbortError, isRecord, readJson } from "../../shared.ts";
import { PrdValidationError } from "./generator.ts";
import { PRD_TEMPLATE_VERSION, sha256Hex } from "./template.ts";
import type {
	GeneratedPrd,
	PrdRecord,
	PrdRequest,
	TotManifest,
	TotProgress,
	TotProgressKind,
} from "./types.ts";

const DEFAULT_TOT_CONCURRENCY = 4;
const MAX_TOT_CONCURRENCY = 16;
/** Per-PRD retry of a failing completion call; content rejections are the generator's own, separate retries. */
const DEFAULT_TOT_RETRY: RetryPolicy = { maxAttempts: 3, baseMs: 500, capMs: 8000 };
/** Written next to the per-PRD checkpoints when a run settles. */
export const MANIFEST_FILE = "manifest.json";
const CHECKPOINT_VERSION = 1;
const MAX_ERROR_CHARS = 300;

export interface RunTotOptions {
	readonly requests: readonly PrdRequest[];
	/** Writes one PRD (typically `generatePrd` bound to a model and a fallback). */
	readonly generate: (request: PrdRequest, signal?: AbortSignal) => Promise<GeneratedPrd>;
	/** Absolute directory for the per-PRD checkpoints and the manifest. */
	readonly checkpointDir: string;
	/** Parallel PRDs (default 4, at most 16). */
	readonly concurrency?: number;
	readonly retry?: RetryPolicy;
	/** Test seams for the backoff: `sleep`, `random`, `now`. */
	readonly seams?: RetrySeams;
	/** Anything besides the request that changes what a PRD should say (model, template options); part of the input hash. */
	readonly inputSalt?: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (event: TotProgress) => void;
}

interface Checkpoint {
	readonly version: number;
	readonly inputHash: string;
	readonly record: PrdRecord;
}

/** Effective execution wave of one PRD: the explicit `wave` when set, otherwise its CoT `step` (see `PrdRequest`). */
function waveOf(request: PrdRequest): number {
	return request.wave ?? request.step;
}

/**
 * Hash of everything one PRD is generated from; a checkpoint is reused only while it still matches.
 *
 * The explicit wave IS content-bearing: the generator's `userPrompt` emits a `wave="..."` attribute iff
 * `request.wave !== undefined`, so two requests differing only in an explicit wave produce different prompts
 * and must not share a checkpoint. The wave is therefore appended as the final canonical element — but only
 * when defined. When it is absent the generator emits nothing extra, so the hashed JSON array stays
 * byte-identical to the pre-wave format and existing version-1 checkpoints keep matching (no envelope bump
 * or migration needed: `loadCheckpoint`'s hash-equality check is the acceptance gate, and it accepts a
 * legacy checkpoint exactly in the no-wave case). A legacy checkpoint reused under an explicit wave has a
 * different hash and is regenerated, as its prompt differs. An explicit wave equal to `step` still differs
 * from an absent wave, because the prompt gains the extra attribute.
 */
/**
 * The dependency fingerprint of a request: its `blockedBy` and `blocks` keys, each deduplicated and sorted.
 * Empty when the request carries no dependency edge, so edge-free requests keep the pre-dependency hash format.
 */
function dependencyFingerprint(request: PrdRequest): string {
	const side = (keys: readonly string[] | undefined): string =>
		[...new Set(keys ?? [])].sort().join(",");
	const blockedBy = side(request.blockedBy);
	const blocks = side(request.blocks);
	return blockedBy === "" && blocks === "" ? "" : `${blockedBy}->${blocks}`;
}

export function inputHash(request: PrdRequest, salt = ""): string {
	const base: readonly unknown[] = [
		PRD_TEMPLATE_VERSION,
		salt,
		request.key,
		request.graphId,
		request.nodeId,
		request.step,
		request.title,
		request.thought,
	];
	const canonical = [
		...base,
		...(request.wave === undefined ? [] : [request.wave]),
		...[dependencyFingerprint(request)].filter((fingerprint) => fingerprint !== ""),
	];
	return sha256Hex(JSON.stringify(canonical));
}

/** The checkpoint file of one key: a readable prefix plus a hash, so distinct keys never collide. */
export function checkpointPath(dir: string, key: string): string {
	const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
	return join(dir, `${safe}-${sha256Hex(key).slice(0, 8)}.json`);
}

function isGeneratedRecord(value: unknown, key: string): value is PrdRecord {
	return (
		isRecord(value) &&
		value.key === key &&
		value.status === "generated" &&
		typeof value.markdown === "string" &&
		typeof value.hash === "string" &&
		typeof value.model === "string" &&
		typeof value.fallback === "boolean" &&
		typeof value.attempts === "number" &&
		value.hash === sha256Hex(value.markdown)
	);
}

/** The saved PRD for `request`, or undefined when there is none, it is damaged, or its input changed. */
function loadCheckpoint(path: string, request: PrdRequest, hash: string): PrdRecord | undefined {
	const saved = readJson(path);
	if (!isRecord(saved) || saved.version !== CHECKPOINT_VERSION || saved.inputHash !== hash) {
		return undefined;
	}
	return isGeneratedRecord(saved.record, request.key) ? saved.record : undefined;
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return clip(redactSecrets(message).replace(/\s+/g, " ").trim(), MAX_ERROR_CHARS).text;
}

function failureRecord(
	request: PrdRequest,
	status: "failed" | "skipped",
	attempts: number,
	error: string,
): PrdRecord {
	return {
		key: request.key,
		hash: "",
		markdown: "",
		status,
		model: "",
		fallback: false,
		attempts,
		error,
	};
}

function classify(error: unknown, now?: number): FailureVerdict {
	// A PRD the validator keeps rejecting will be rejected again: the generator already retried it.
	if (error instanceof PrdValidationError) return { transient: false, reason: "validation" };
	return isTransientFailure(error, now);
}

/**
 * Writes every PRD of `requests` in dependency-ready order: a step is generated only after every `blockedBy` PRD
 * has been generated, while steps with no dependency edge run in parallel up to `concurrency`. When callers use
 * explicit waves (see `waveOf`), the wave is an extra barrier: every earlier-wave step settles before a later
 * wave is released. The input order is kept among ready steps, and the returned records always follow the input
 * order, however the queue interleaved. Each finished PRD is checkpointed atomically before it is counted, so a
 * killed run keeps everything it finished; a rerun with the same `checkpointDir` reuses each PRD whose input
 * hash is unchanged and writes the rest. One PRD failing never stops the others: it is recorded as `failed`,
 * and its dependents' steps are held (`skipped`) rather than generated on a missing PRD — a plan with any PRD
 * missing is never emitted as usable. On abort, PRDs that never started are `skipped`.
 */
export async function runTot(options: RunTotOptions): Promise<TotManifest> {
	const { requests, checkpointDir, signal } = options;
	if (!isAbsolute(checkpointDir)) throw new Error("checkpointDir must be an absolute path");
	const keys = new Set<string>();
	for (const request of requests) {
		if (keys.has(request.key)) throw new Error(`duplicate PRD key ${request.key}`);
		keys.add(request.key);
	}
	const total = requests.length;
	const concurrency = Math.min(
		MAX_TOT_CONCURRENCY,
		Math.max(1, Math.floor(options.concurrency ?? DEFAULT_TOT_CONCURRENCY)),
	);
	const policy = options.retry ?? DEFAULT_TOT_RETRY;
	const results: (PrdRecord | undefined)[] = new Array(total).fill(undefined);
	let done = 0;

	const emit = (kind: TotProgressKind, key: string, extra: Partial<TotProgress> = {}): void => {
		try {
			options.onProgress?.({ kind, key, done, total, ...extra });
		} catch {
			// reason: a progress listener must never fail the run it observes
		}
	};
	const settle = (index: number, kind: TotProgressKind, record: PrdRecord): void => {
		results[index] = record;
		done++;
		emit(kind, record.key, record.error === undefined ? {} : { error: record.error });
	};

	const processOne = async (index: number): Promise<void> => {
		const request = requests[index];
		if (request === undefined) return;
		const hash = inputHash(request, options.inputSalt);
		const path = checkpointPath(checkpointDir, request.key);
		const saved = loadCheckpoint(path, request, hash);
		if (saved !== undefined) {
			settle(index, "resumed", saved);
			return;
		}
		emit("started", request.key, { wave: waveOf(request) });
		try {
			const { value, attempts } = await withRetry(
				(attempt) => {
					if (attempt > 1) emit("retry", request.key, { attempt, wave: waveOf(request) });
					return options.generate(request, signal);
				},
				policy,
				{ ...options.seams, signal, classify },
			);
			const record: PrdRecord = {
				key: request.key,
				hash: sha256Hex(value.markdown),
				markdown: value.markdown,
				status: "generated",
				model: value.model,
				fallback: value.fallback,
				attempts: attempts - 1 + value.attempts,
				...(value.error === undefined ? {} : { error: value.error }),
			};
			try {
				const checkpoint: Checkpoint = { version: CHECKPOINT_VERSION, inputHash: hash, record };
				writeFileAtomic(path, `${JSON.stringify(checkpoint)}\n`);
			} catch (error) {
				settle(
					index,
					"failed",
					failureRecord(
						request,
						"failed",
						record.attempts,
						`checkpoint write failed: ${errorText(error)}`,
					),
				);
				return;
			}
			settle(index, "generated", record);
		} catch (error) {
			if (isAbortError(error) || signal?.aborted) {
				settle(index, "skipped", failureRecord(request, "skipped", 0, "aborted"));
				return;
			}
			const attempts = error instanceof RetryExhaustedError ? error.attempts : 1;
			settle(index, "failed", failureRecord(request, "failed", attempts, errorText(error)));
		}
	};

	// Dependency-ready scheduling: a step is released only once every `blockedBy` key has been generated;
	// steps with no dependency edge are released together, up to `concurrency`. An explicit wave is an extra
	// barrier: nothing of a later wave starts until every earlier-wave step has settled. A request whose
	// `blockedBy` names a PRD outside the run (or a cycle) can never be released: it is recorded `failed`,
	// never generated, so the run holds its dependents back and the plan is not released.
	const indexByKey = new Map(requests.map((request, index) => [request.key, index] as const));
	const settledIndex = (index: number): boolean => results[index] !== undefined;
	const generatedIndex = (index: number): boolean => results[index]?.status === "generated";
	const depsOf = (request: PrdRequest): readonly string[] => request.blockedBy ?? [];
	for (const [index, request] of requests.entries()) {
		const missing = depsOf(request).filter((key) => !indexByKey.has(key));
		if (missing.length > 0) {
			settle(
				index,
				"failed",
				failureRecord(request, "failed", 0, `unknown dependency ${missing.join(", ")}`),
			);
		}
	}
	const useWaves = requests.some((request) => request.wave !== undefined);
	while (true) {
		if (signal?.aborted) break;
		const pending = requests
			.map((_request, index) => index)
			.filter((index) => !settledIndex(index));
		if (pending.length === 0) break;
		const ready = pending.filter((index) => {
			const request = requests[index];
			if (request === undefined) return false;
			if (!depsOf(request).every((key) => generatedIndex(indexByKey.get(key) ?? -1))) return false;
			if (!useWaves) return true;
			return requests.every(
				(other, otherIndex) => waveOf(other) >= waveOf(request) || settledIndex(otherIndex),
			);
		});
		if (ready.length === 0) {
			// Nothing can proceed: steps waiting on a non-generated dependency are held (`skipped`,
			// never generated on a missing PRD); the rest form a cycle and are recorded `failed`.
			let held = false;
			for (const index of pending) {
				const request = requests[index];
				if (request === undefined) continue;
				const unsatisfied = depsOf(request).find((key) => {
					const dep = results[indexByKey.get(key) ?? -1];
					return dep !== undefined && dep.status !== "generated";
				});
				if (unsatisfied !== undefined) {
					held = true;
					settle(
						index,
						"skipped",
						failureRecord(request, "skipped", 0, `blocked by ${unsatisfied}`),
					);
				}
			}
			if (!held) {
				for (const index of pending) {
					const request = requests[index];
					if (request === undefined) continue;
					settle(
						index,
						"failed",
						failureRecord(request, "failed", 0, `dependency cycle at ${request.key}`),
					);
				}
			}
			continue;
		}
		await Promise.all(ready.slice(0, concurrency).map(processOne));
	}

	for (const [index, request] of requests.entries()) {
		if (results[index] === undefined) {
			settle(index, "skipped", failureRecord(request, "skipped", 0, "aborted before start"));
		}
	}
	const records = results.filter((record): record is PrdRecord => record !== undefined);
	const manifest: TotManifest = {
		total,
		generated: records.filter((record) => record.status === "generated").length,
		failed: records.filter((record) => record.status === "failed").length,
		fallbacks: records.filter((record) => record.fallback).length,
		records,
	};
	try {
		writeFileAtomic(join(checkpointDir, MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
	} catch {
		// reason: the manifest is a convenience copy of the return value; the per-PRD checkpoints are what a rerun reads
	}
	return manifest;
}
