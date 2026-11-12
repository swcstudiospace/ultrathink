// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/** Shared error categories. Every port failure and every command failure carries exactly one of these. */
export const ERROR_CATEGORIES = [
	"invalid_input",
	"capability_missing",
	"version_mismatch",
	"host_unreachable",
	"state_corrupt",
	"permission_denied",
	"internal",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Error thrown by port operations. `category` is always an ErrorCategory; `message` never contains credentials. */
export interface CategorizedError extends Error {
	readonly category: ErrorCategory;
}

/**
 * Idempotency contract for a command.
 * - "idempotent": repeating an invocation with the same input is safe.
 * - "keyed": the caller MUST supply an idempotency key; the command deduplicates on it.
 */
type Idempotency = "idempotent" | "keyed";

/** Host-agnostic validator. `parse` returns the typed value or throws. */
export interface Schema<T> {
	parse(value: unknown): T;
}

/** Declaration of one command: its name, schemas, idempotency and the error categories it can produce. */
export interface CommandDefinition<I, O> {
	readonly name: string;
	readonly input: Schema<I>;
	readonly output: Schema<O>;
	readonly idempotency: Idempotency;
	readonly errorCategories: readonly ErrorCategory[];
}

/** Failure value returned by a command. `message` never contains credentials. */
interface CommandError {
	readonly category: ErrorCategory;
	readonly message: string;
}

export type CommandResult<O> =
	| { readonly ok: true; readonly value: O }
	| { readonly ok: false; readonly error: CommandError };

interface InvokeContext {
	readonly correlationId: string;
	/** Required for "keyed" commands; ignored by "idempotent" commands. */
	readonly idempotencyKey?: string;
}

/** Registry of commands declared by a host-agnostic core. Adapters implement `invoke`. */
export interface CommandPort {
	list(): readonly CommandDefinition<unknown, unknown>[];
	invoke(name: string, input: unknown, context: InvokeContext): Promise<CommandResult<unknown>>;
}
