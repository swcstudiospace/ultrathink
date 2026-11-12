// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";

/** Handler behind one Omp slash command: the typed argument string and the host's command context. */
export type OmpCommandHandler = (args: string, ctx: unknown) => Promise<unknown> | unknown;

/** Input shape the Omp adapter expects from `invoke`. `args` and `ctx` are passed to the handler unchanged. */
interface OmpCommandInput {
	readonly args: string;
	readonly ctx: unknown;
}

/** Accepts any value unchanged: Omp command arguments and contexts are host-owned, not validated here. */
const passthrough: Schema<unknown> = { parse: (value) => value };

const COMMAND_ERRORS: readonly ErrorCategory[] = ["invalid_input", "internal"];

/**
 * CommandPort over Omp slash commands. `handlers` is read on every call, so names added to the map after
 * creation are dispatchable. A handler that throws yields `internal` with a fixed message: the thrown text
 * is never returned, because it may carry secrets.
 */
export function createOmpCommandPort(
	handlers: ReadonlyMap<string, OmpCommandHandler>,
): CommandPort {
	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			return [...handlers.keys()].map((name) => ({
				name,
				input: passthrough,
				output: passthrough,
				// Every routed command can send messages or spawn lanes, and the port adds no dedup: none is idempotent.
				idempotency: "side-effecting",
				errorCategories: COMMAND_ERRORS,
			}));
		},
		async invoke(name: string, input: unknown): Promise<CommandResult<unknown>> {
			const handler = handlers.get(name);
			if (!handler)
				return {
					ok: false,
					error: { category: "invalid_input", message: `unknown command: ${name}` },
				};
			if (typeof input !== "object" || input === null)
				return {
					ok: false,
					error: { category: "invalid_input", message: `invalid input: ${name}` },
				};
			const { args, ctx } = input as OmpCommandInput;
			try {
				return { ok: true, value: await handler(args, ctx) };
			} catch {
				return { ok: false, error: { category: "internal", message: "command failed" } };
			}
		},
	};
}
