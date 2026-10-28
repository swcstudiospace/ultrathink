// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Hindsight link for `ultrathink stack`. Free and read-only: `GET /health` and `GET /version`, which take no key,
 * so the service key is never sent. Nothing is contacted while Hindsight is off, not opted in or missing its URL or
 * key. A reason or fix never carries a key, a URL or a filesystem path.
 *
 * The server's `retain_extraction_mode` is not reported: `/health` and `/version` do not carry it, and reading a
 * bank's config needs the key. The client instead sets every bank it uses to `chunks` before it retains anything.
 */
import { serviceBackend } from "../gateway/settings.ts";
import { GATEWAY_TOKEN_ENV, GATEWAY_URL_ENV, HINDSIGHT_BACKEND_ENV } from "../gateway/types.ts";
import { resolveHindsight } from "../hindsight/settings.ts";
import type { HindsightReadiness } from "../hindsight/types.ts";
import { storePath } from "../mcp/store.ts";
import type { StackConnection, StackProbe, StackProbeContext } from "./types.ts";

const AFFECTS = ["lesson retain", "lesson recall"] as const;
const API_VERSION = /^[0-9A-Za-z._+-]{1,32}$/;

type Unready = Extract<HindsightReadiness, { state: "unready" }>;

/** The misconfiguration a not-ready resolution names, as a reason and a fix. */
function unready(readiness: Unready, gateway: boolean): Pick<StackConnection, "reason" | "fix"> {
	switch (readiness.reason) {
		case "no-url":
			return gateway
				? {
						reason: "no desk gateway URL",
						fix: `set gateway.url or ${GATEWAY_URL_ENV}`,
					}
				: {
						reason: "no Hindsight URL",
						fix: "set hindsight.url or HINDSIGHT_API_URL (HINDSIGHT_URL also works)",
					};
		case "bad-url":
			return {
				reason: `${gateway ? "the desk gateway" : "the Hindsight"} URL is refused: ${readiness.detail ?? "refused"}`,
				fix: gateway
					? `fix gateway.url or ${GATEWAY_URL_ENV}`
					: "fix hindsight.url or HINDSIGHT_API_URL",
			};
		case "no-token":
			return {
				reason: "no desk gateway token",
				fix: `set ${GATEWAY_TOKEN_ENV} or store a desk-gateway credential`,
			};
		case "no-key":
			return {
				reason: "no Hindsight key",
				fix: "bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY",
			};
	}
}

/** Never throws. */
export const probeHindsight: StackProbe = async (
	ctx: StackProbeContext,
): Promise<StackConnection> => {
	const now = ctx.now ?? Date.now;
	const startedAt = now();
	const latency = (): number => {
		const elapsed = now() - startedAt;
		return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
	};
	try {
		const { hindsight, gateway } = ctx.config;
		const backend = serviceBackend(hindsight.backend, ctx.env, HINDSIGHT_BACKEND_ENV);
		const viaGateway = backend === "gateway";
		const { readiness, client } = resolveHindsight(
			{ ...hindsight, timeoutMs: Math.min(hindsight.timeoutMs, ctx.timeoutMs) },
			ctx.env,
			{
				storePath: storePath(ctx.env),
				fetch: ctx.fetch,
				signal: AbortSignal.timeout(ctx.timeoutMs),
				gateway,
			},
		);
		if (readiness.state === "off") {
			return {
				member: "hindsight",
				status: "disabled",
				reason:
					readiness.reason === "killed"
						? "ULTRATHINK_HINDSIGHT=0 turns Hindsight off for this process"
						: "Hindsight is opt-in and hindsight.enabled is off",
				via: "none",
			};
		}
		if (readiness.state === "unready") {
			return {
				member: "hindsight",
				status: "misconfigured",
				...unready(readiness, viaGateway),
				affects: AFFECTS,
				via: "config",
			};
		}
		// The gateway has no free health endpoint: its health call is a recall through the desk gateway.
		if ("backend" in readiness && !ctx.live) {
			return {
				member: "hindsight",
				status: "degraded",
				reason:
					"routed through the desk gateway: the configuration is complete but the link is only checked with a live probe",
				affects: ["reachability check"],
				via: "config",
			};
		}
		if (!client) {
			return {
				member: "hindsight",
				status: "unavailable",
				reason: "Hindsight is configured but no client could be built",
				via: "none",
			};
		}
		const result = await client.health();
		if (!result.ok) {
			return {
				member: "hindsight",
				status: "unavailable",
				reason: `Hindsight did not answer its health check (${result.error.kind})`,
				affects: AFFECTS,
				latencyMs: latency(),
				via: "http",
			};
		}
		if (!result.value.ok) {
			return {
				member: "hindsight",
				status: "unavailable",
				reason: `Hindsight answers but reports itself unhealthy${result.value.databaseConnected ? "" : " (database not connected)"}`,
				affects: AFFECTS,
				latencyMs: latency(),
				via: "http",
			};
		}
		const { apiVersion } = result.value;
		const version = API_VERSION.test(apiVersion) ? ` (api ${apiVersion})` : "";
		return {
			member: "hindsight",
			status: "connected",
			reason: `Hindsight is healthy${version}`,
			latencyMs: latency(),
			via: "http",
		};
	} catch {
		return {
			member: "hindsight",
			status: "unavailable",
			reason: "Hindsight did not answer within the probe budget",
			affects: AFFECTS,
			latencyMs: latency(),
			via: "http",
		};
	}
};
