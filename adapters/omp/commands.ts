// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type {
	CommandDefinition,
	CommandPort,
	CommandResult,
	ErrorCategory,
	Schema,
} from "../../core/src/ports/command.ts";
import { type VersionFloorResult, checkVersionFloor } from "../version-floor.ts";

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

/** Host facts the port checks before it routes any command. */
export interface OmpCommandPortOptions {
	/** Observed Omp version of the hosting binary, read once at extension load. Null (unreadable) refuses every command. */
	readonly observedVersion: string | null;
}

/** Refusal message when the observed version fails the Omp floor; null when the port may route commands. */
function versionRefusal(observedVersion: string | null): string | null {
	const check: VersionFloorResult = checkVersionFloor("omp", observedVersion);
	if (check.ok) return null;
	return check.reason === "unknown_version"
		? `omp version unknown; minimum ${check.floor}`
		: `omp version below minimum ${check.floor}`;
}

/**
 * CommandPort over Omp slash commands. `handlers` is read on every call, so names added to the map after
 * creation are dispatchable. A handler that throws yields `internal` with a fixed message: the thrown text
 * is never returned, because it may carry secrets. A refused version lists no commands and fails every invoke.
 */
export function createOmpCommandPort(
	handlers: ReadonlyMap<string, OmpCommandHandler>,
	options: OmpCommandPortOptions,
): CommandPort {
	const refusal = versionRefusal(options.observedVersion);
	return {
		list(): readonly CommandDefinition<unknown, unknown>[] {
			if (refusal !== null) return [];
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
			if (refusal !== null) return { ok: false, error: { category: "internal", message: refusal } };
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
