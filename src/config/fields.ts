// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/**
 * Largest delay `setTimeout`/`AbortSignal.timeout` accept (signed 32-bit ms, ~24.8 days). Timers clamp bigger
 * values to 1 ms, so a budget of e.g. `1e10` meant as "no limit" would fire at once; every ms budget is capped here.
 */
export const MAX_TIMER_MS = 2_147_483_647;

function nonNegativeMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(value, MAX_TIMER_MS)
		: fallback;
}

/**
 * A call timer a project file sets can only shorten a bound the earlier files set. A project `0` (no timer) or an unusable
 * value keeps the earlier value, so a repository cannot remove a bound by writing `0` (K5).
 */
export function projectTimerMs(value: unknown, base: number, project: boolean): number {
	if (!project) return nonNegativeMs(value, base);
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return base;
	const capped = Math.min(value, MAX_TIMER_MS);
	return base > 0 ? Math.min(base, capped) : capped;
}

export function nonEmpty(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** C0 and C1 control characters: NUL, newline, ESC (ANSI), DEL and the rest. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** A selector or provider string carrying a control character is never sent anywhere; resolution reports it `selector-invalid`. */
export function hasControlCharacter(value: string): boolean {
	return CONTROL_CHARACTER.test(value);
}

/** Shared selector string normalization: blanks stay absent; nonblank controls stay raw so selection can reject them before trim. */
function normalizeSelectorField(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return hasControlCharacter(value) ? value : trimmed;
}

/**
 * A model/provider selector after normalization: undefined for a wrong type, "" for an entirely-whitespace blank,
 * otherwise trimmed of surrounding whitespace only. Nonblank strings carrying controls stay as written so resolution
 * can diagnose them before trim hides them; each merge consumer applies its existing blank/reset rule.
 */
export function selectorField(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return normalizeSelectorField(value);
}

export function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1
		? Math.floor(value)
		: fallback;
}

/** A finite number in [0, 1]; anything else falls back. */
export function unitInterval(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: fallback;
}

/** An integer in [min, max]; anything else falls back. */
export function intInRange(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
		? value
		: fallback;
}

export function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}
