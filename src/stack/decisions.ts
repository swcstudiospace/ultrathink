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
import { decisionsKilled, resolveDecisionsKeys } from "../decisions/gate.ts";
import { describeJevHealth, JEV_RAILS, openJevHealth } from "../decisions/health.ts";
import { storePath } from "../mcp/store.ts";
import type { StackConnection, StackProbe, StackProbeContext } from "./types.ts";

const SET_KEY_FIX =
	"bin/ultrathink-mcp auth set-key vercel --stdin, or bin/ultrathink-mcp auth set-key openrouter --stdin";
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

/** The rails whose breaker is open, each with its cause: `openrouter (credits)`. Enum values only. */
function openRails(ctx: StackProbeContext): string[] {
	const open: string[] = [];
	for (const rail of JEV_RAILS) {
		const state = openJevHealth(ctx.stateDir, rail).read();
		if (state.state === "open") open.push(`${rail} (${state.cause})`);
	}
	return open;
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
		const picked = resolveDecisionsKeys(decisions, storePath(ctx.env), ctx.env);
		if (!picked.key) {
			const exported = ctx.env.OPENROUTER_API_KEY?.trim();
			return connection(ctx, startedAt, {
				status: "misconfigured",
				reason: exported
					? "no Jev key: OPENROUTER_API_KEY is exported but Ultrathink does not read it"
					: "no Jev key on either rail",
				fix: exported ? "bin/ultrathink-mcp auth set-key openrouter --stdin" : SET_KEY_FIX,
				affects: AFFECTS,
				via: "config",
			});
		}
		const label = `${picked.provider} rail, key from ${picked.key.source}`;
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
				reason: `live check failed on the ${picked.provider} rail (${result.kind ?? "unknown"})`,
				...(fix ? { fix } : {}),
				affects: AFFECTS,
				latencyMs: Math.max(0, Math.round(result.latencyMs)),
				via: "http",
			};
		}
		if (describeJevHealth(ctx.stateDir, (ctx.now ?? Date.now)()) !== undefined) {
			const rails = openRails(ctx);
			return connection(ctx, startedAt, {
				status: "degraded",
				reason: `Jev breaker open on ${rails.length > 0 ? rails.join(", ") : "a rail"}; decisions are skipped until it re-checks`,
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
