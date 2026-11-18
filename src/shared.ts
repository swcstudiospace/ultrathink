// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Helpers shared by root and services code. Imports only `node:*` modules so
 * that every tree can import it without an import cycle.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

/** A non-null, non-array object: the shape every JSON-object check means. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as a record, or `undefined` when it is not one. */
export function asObj(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function isScalar(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Parsed JSON from `path`, or `undefined` when the file is missing or is not valid JSON. */
export function readJson(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) return error.name === "AbortError";
	if (!error || typeof error !== "object" || !("name" in error)) return false;
	return error.name === "AbortError";
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `count` and `noun`, the noun in its plural form unless the count is exactly one. */
export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A file's identity on disk (size, mtime, inode), or `undefined` when it cannot be stat'ed. */
export function diskFingerprint(
	path: string,
): { readonly size: number; readonly mtimeMs: number; readonly ino: number } | undefined {
	try {
		const stat = statSync(path);
		return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
	} catch {
		return undefined;
	}
}

/** The clock a teach context injects, else the wall clock. */
export function nowOf(ctx: { readonly now?: () => number }): number {
	return (ctx.now ?? Date.now)();
}

/** Distinct items in first-seen order. `keep` drops items before the dedupe; `max` caps how many are returned. */
export function unique<T>(
	items: Iterable<T>,
	options: { readonly keep?: (item: T) => boolean; readonly max?: number } = {},
): T[] {
	const kept = options.keep ? [...items].filter(options.keep) : items;
	return [...new Set(kept)].slice(0, options.max);
}

/** SHA-256 hex digest of text: the identity a reviewed draft is checked against. */
export function fingerprintOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Minimal timer port: the platform `setTimeout`/`clearTimeout` by default, or a test double. The handle is opaque. */
export type TimerPort = {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
};
