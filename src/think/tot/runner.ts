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
	/** Writes one PRD (typically `generatePrd` bound to a model, the facts and a fallback). */
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

/** Hash of everything one PRD is generated from; a checkpoint is reused only while it still matches. */
export function inputHash(request: PrdRequest, salt = ""): string {
	return sha256Hex(
		JSON.stringify([
			PRD_TEMPLATE_VERSION,
			salt,
			request.key,
			request.graphId,
			request.nodeId,
			request.step,
			request.title,
			request.thought,
		]),
	);
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
 * Writes every PRD of `requests` with a bounded worker pool. Each finished PRD is checkpointed atomically before it is
 * counted, so a killed run keeps everything it finished; a rerun with the same `checkpointDir` reuses each PRD whose
 * input hash is unchanged and writes the rest. One PRD failing never stops the others: it is recorded as `failed`
 * (the caller's gate decides what a partial run means). On abort, PRDs that never started are `skipped`.
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
		emit("started", request.key);
		try {
			const { value, attempts } = await withRetry(
				(attempt) => {
					if (attempt > 1) emit("retry", request.key, { attempt });
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

	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			if (signal?.aborted) return;
			const index = cursor++;
			if (index >= total) return;
			await processOne(index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));

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
