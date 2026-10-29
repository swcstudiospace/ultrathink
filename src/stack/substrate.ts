// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Substrate seam: a read-only probe that says whether the Agent Substrate link is switched off, unreachable,
 * misconfigured, degraded or working.
 *
 * It runs two free requests inside `ctx.timeoutMs`: `GET /healthz` (open, no bearer) and one `/brief` through
 * `fetchBrief`, the same code path a prompt uses (per-surface bearer, host surface, one retry on a surface mismatch).
 * There is no second client. Every reason names a surface or a variable, never a token value.
 */

import { gatewayStatus, resolveGateway, serviceBackend } from "../gateway/settings.ts";
import { SUBSTRATE_BACKEND_ENV } from "../gateway/types.ts";
import { storePath } from "../mcp/store.ts";
import { boundedLine, resolveSubstrate, fetchBrief, type BriefResult } from "../substrate/brief.ts";
import type { StackConnection, StackProbe, StackProbeContext } from "./types.ts";

const FIX_UNAUTHORIZED =
	"set SUBSTRATE_TOKEN (or SUBSTRATE_TOKEN_FILE / SUBSTRATE_TOKENS_DIR per-surface files)";

const FIX_URL =
	"set SUBSTRATE_URL or substrate.url to an https URL (http only for localhost, *.ts.net, 100.64.0.0/10)";

const AFFECTS_BRIEF: readonly string[] = ["brief"];

/** Headroom under the probe's own deadline, so a brief that times out reports `brief timed out` rather than losing the race. */
const SETTLE_MS = 50;

/** `token <surface> cannot act as host surface <host>; retried without surface` (brief.ts), surfaces only. */
const RECOVERED_DETAIL = /^token (\S+) cannot act as host surface (\S+);/;

type Outcome = Omit<StackConnection, "member" | "latencyMs">;

function unavailable(reason: string): Outcome {
	return { status: "unavailable", reason, affects: AFFECTS_BRIEF, via: "http" };
}

/** What a brief that came back (or did not) says about the link. */
function fromBrief(result: BriefResult, host: string): Outcome {
	if (result.state === "none") {
		switch (result.reason) {
			case "disabled":
				return { status: "disabled", reason: "SUBSTRATE_DISABLED=1", via: "config" };
			case "no-url":
				return { status: "disabled", reason: "no Substrate URL configured", via: "config" };
			case "unauthorized":
				return {
					status: "misconfigured",
					reason: "brief refused the bearer (401)",
					fix: FIX_UNAUTHORIZED,
					affects: AFFECTS_BRIEF,
					via: "http",
				};
			case "surface-mismatch":
				return unavailable(
					`brief refused: ${boundedLine(result.detail ?? "token cannot act as the host surface")}`,
				);
			case "bad-request":
				return unavailable("brief request rejected (400)");
			case "timeout":
				return unavailable("brief timed out");
			case "unreachable":
				return unavailable("brief unreachable");
			case undefined:
				return { status: "connected", reason: "brief empty", via: "http" };
			case "redirect refused":
				return unavailable("brief redirect refused");
			default:
				if (result.reason.startsWith("url refused: "))
					return {
						status: "misconfigured",
						reason: `brief ${boundedLine(result.reason)}`,
						fix: FIX_URL,
						affects: AFFECTS_BRIEF,
						via: "config",
					};
				return unavailable(`brief ${result.reason}`);
		}
	}
	const recovered =
		result.reason === "surface-mismatch" ? RECOVERED_DETAIL.exec(result.detail ?? "") : null;
	const via = recovered ? `via token surface ${recovered[1]} for host ${host}` : undefined;
	if (result.state === "complete")
		return { status: "connected", reason: via ? `brief ${via}` : "brief ok", via: "http" };
	return {
		status: "degraded",
		reason: `brief is ${result.state}${via ? ` (${via})` : ""}`,
		affects: AFFECTS_BRIEF,
		via: "http",
	};
}

async function probe(ctx: StackProbeContext, started: number, now: () => number): Promise<Outcome> {
	if (ctx.env.SUBSTRATE_DISABLED === "1")
		return { status: "disabled", reason: "SUBSTRATE_DISABLED=1", via: "config" };
	if (serviceBackend(ctx.config.substrate.backend, ctx.env, SUBSTRATE_BACKEND_ENV) === "gateway") {
		// The plugin talks to the desk gateway, never to substrate.url: probing the direct URL would report a link it does not use.
		// A gateway live check is out of scope, so a ready gateway is reported as configured and not probed: a link nobody dialled is not `connected`.
		const resolved = resolveGateway(ctx.config.gateway, ctx.env, {
			storePath: storePath(ctx.env),
		});
		if (!resolved.ok)
			return {
				status: "misconfigured",
				reason: `desk gateway ${gatewayStatus(resolved)}`,
				fix: "fix the desk gateway settings (gateway.url, DESK_GATEWAY_TOKEN)",
				affects: AFFECTS_BRIEF,
				via: "config",
			};
		return {
			status: "degraded",
			reason: "desk gateway configured; link not probed",
			via: "config",
		};
	}
	const configured = ctx.config.substrate.url;
	const target = resolveSubstrate(ctx.env, configured);
	if (!target)
		return {
			status: "disabled",
			reason: "no Substrate URL (set SUBSTRATE_URL or substrate.url)",
			via: "config",
		};
	const doFetch = ctx.fetch ?? fetch;
	try {
		const health = await doFetch(`${target.url}/healthz`, {
			method: "GET",
			signal: AbortSignal.timeout(ctx.timeoutMs),
		});
		if (health.status >= 500) return unavailable(`healthz http-${health.status}`);
	} catch {
		return unavailable("healthz unreachable");
	}
	const budget = Math.floor(ctx.timeoutMs - (now() - started) - SETTLE_MS);
	if (budget < 1) return unavailable("brief timed out");
	// fetchBrief reads its budget from the environment; hand it what is left of the probe's, nothing more.
	const env = { ...ctx.env, SUBSTRATE_TIMEOUT_MS: String(budget) };
	const result = await fetchBrief({ surface: ctx.host, fetch: doFetch }, env, configured);
	return fromBrief(result, ctx.host);
}

/** The Substrate link for `ultrathink stack`: read-only, never throws, bounded by `ctx.timeoutMs`. */
export const probeSubstrate: StackProbe = async (
	ctx: StackProbeContext,
): Promise<StackConnection> => {
	const now = ctx.now ?? Date.now;
	const started = now();
	const { promise: deadline, resolve } = Promise.withResolvers<Outcome>();
	const timer = setTimeout(() => resolve(unavailable("probe timed out")), ctx.timeoutMs);
	let outcome: Outcome;
	try {
		outcome = await Promise.race([probe(ctx, started, now), deadline]);
	} catch {
		outcome = unavailable("probe failed");
	} finally {
		clearTimeout(timer);
	}
	return { member: "substrate", ...outcome, latencyMs: Math.max(0, now() - started) };
};
