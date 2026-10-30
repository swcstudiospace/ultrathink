// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Decisions (Jev) link for `ultrathink stack`. Without `ctx.live` it only reads the environment, the credential
 * store and the rail breaker files: no request is made and no key leaves the process. With `ctx.live` it sends the
 * one request `ultrathink decisions check` sends (the single place a key is used) and reports its verdict.
 *
 * A reason or fix never carries a key, a URL or a filesystem path: the key source is a label (`store` or the
 * variable's name) and a failure is its kind, never its message.
 */
import { decisionsLiveCheck } from "../decisions/cli.ts";
import { decisionsKilled, resolveOpenRouterKey } from "../decisions/gate.ts";
import { describeJevHealth, openJevHealth } from "../decisions/health.ts";
import { storePath } from "../mcp/store.ts";
import type { StackConnection, StackProbe, StackProbeContext } from "./types.ts";

const SET_KEY_FIX = "bin/ultrathink-mcp auth set-key openrouter --stdin";
const AFFECTS = ["plan gate", "ship gate", "knowledge, blocking and teachable decisions"] as const;

function connection(
	ctx: StackProbeContext,
	startedAt: number,
	rest: Omit<StackConnection, "member" | "latencyMs">,
): StackConnection {
	const elapsed = (ctx.now ?? Date.now)() - startedAt;
	return {
		member: "decisions",
		latencyMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
		...rest,
	};
}

/** The breaker's open state as `openrouter (credits)`, or undefined when closed. Enum values only. */
function openRail(ctx: StackProbeContext): string | undefined {
	const state = openJevHealth(ctx.stateDir).read();
	return state.state === "open" ? `openrouter (${state.cause})` : undefined;
}

function failureFix(kind: string | undefined): string | undefined {
	if (kind === "auth") return SET_KEY_FIX;
	if (kind === "credits") return "add credits to the provider account";
	return undefined;
}

/** Never throws. */
export const probeDecisions: StackProbe = async (
	ctx: StackProbeContext,
): Promise<StackConnection> => {
	const startedAt = (ctx.now ?? Date.now)();
	try {
		if (decisionsKilled(ctx.env)) {
			return connection(ctx, startedAt, {
				status: "disabled",
				reason: "ULTRATHINK_DECISIONS=0 turns Jev decisions off for this process",
				via: "none",
			});
		}
		const { decisions } = ctx.config;
		const key = resolveOpenRouterKey(storePath(ctx.env), ctx.env);
		if (!key) {
			const exported = ctx.env.OPENROUTER_API_KEY?.trim();
			return connection(ctx, startedAt, {
				status: "misconfigured",
				reason: exported
					? "no Jev key: OPENROUTER_API_KEY is exported but Ultrathink does not read it"
					: "no Jev key",
				fix: exported ? "bin/ultrathink-mcp auth set-key openrouter --stdin" : SET_KEY_FIX,
				affects: AFFECTS,
				via: "config",
			});
		}
		const label = `openrouter rail, key from ${key.source}`;
		if (ctx.live) {
			const result = await decisionsLiveCheck(
				{
					cwd: ctx.cwd,
					env: ctx.env,
					stateDir: ctx.stateDir,
					fetch: ctx.fetch,
					now: ctx.now,
				},
				{ ...decisions, timeoutMs: Math.min(decisions.timeoutMs, ctx.timeoutMs) },
			);
			if (result.ok) {
				return {
					member: "decisions",
					status: "connected",
					reason: `live check ok on the ${label}`,
					latencyMs: Math.max(0, Math.round(result.latencyMs)),
					via: "http",
				};
			}
			const fix = failureFix(result.kind);
			return {
				member: "decisions",
				status: "unavailable",
				reason: `live check failed on the openrouter rail (${result.kind ?? "unknown"})`,
				...(fix ? { fix } : {}),
				affects: AFFECTS,
				latencyMs: Math.max(0, Math.round(result.latencyMs)),
				via: "http",
			};
		}
		if (describeJevHealth(ctx.stateDir, (ctx.now ?? Date.now)()) !== undefined) {
			const rail = openRail(ctx);
			return connection(ctx, startedAt, {
				status: "degraded",
				reason: `Jev breaker open on ${rail ?? "openrouter"}; decisions are skipped until it re-checks`,
				fix: "bin/ultrathink decisions check",
				affects: AFFECTS,
				via: "config",
			});
		}
		return connection(ctx, startedAt, {
			status: "connected",
			reason: `Jev configured on the ${label}; not contacted (no live check)`,
			via: "config",
		});
	} catch {
		return connection(ctx, startedAt, {
			status: "unavailable",
			reason: "Decisions probe failed unexpectedly",
			via: "none",
		});
	}
};
