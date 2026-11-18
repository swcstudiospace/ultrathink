// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { SubstrateConfig } from "../config.ts";
import { type GatewayConfig, SEAT_PATTERN } from "../gateway/types.ts";
import type { HindsightConfig } from "../hindsight/types.ts";
import type { RagflowConfig } from "../ragflow/types.ts";
import { booleanOr, intInRange, nonEmpty, unitInterval } from "./fields.ts";

/** Upper bound for the Hindsight and RAGFlow request budgets. */
const MAX_SERVICE_TIMEOUT_MS = 120_000;
const HINDSIGHT_BANK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_DATASET_IDS = 20;

/**
 * A non-empty http(s) URL with trailing slashes stripped; anything else falls back. A URL with a query or a fragment
 * falls back too. A user name or password is kept: the doctor shows the URL with it removed, and a bearer-carrying
 * request is refused by the service-URL policy at use.
 */
function httpUrl(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().replace(/\/+$/, "");
	if (!trimmed) return fallback;
	try {
		const url = new URL(trimmed);
		if (url.search || url.hash) return fallback;
		if (url.protocol === "https:") return trimmed;
		// Cleartext is allowed only to loopback and private (RFC 1918) addresses, which do not route on the public internet.
		return url.protocol === "http:" &&
			/^(localhost|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[::1\])$/.test(
				url.hostname,
			)
			? trimmed
			: fallback;
	} catch {
		return fallback;
	}
}

/** `"gateway"` is kept. `"direct"` clears it. Anything else keeps the earlier layer. Absent means direct. */
function backendField(
	value: unknown,
	fallback: "direct" | "gateway" | undefined,
): "gateway" | undefined {
	if (value === "direct") return undefined;
	if (value === "gateway") return "gateway";
	return fallback === "gateway" ? "gateway" : undefined;
}

/**
 * A project layer (a file a cloned repository controls) never reaches the service target: `url` is where the Substrate
 * bearer token, the repository, the branch and the host name are sent, so only the user layers set it. The same trust
 * rule as `mergeHindsight`; `backend` is user-only for the same reason.
 */
export function mergeSubstrate(
	substrate: Record<string, unknown> | undefined,
	defaults: SubstrateConfig,
	project: boolean,
): SubstrateConfig {
	if (!substrate || project) return defaults;
	const url = httpUrl(substrate.url, defaults.url);
	const backend = backendField(substrate.backend, defaults.backend);
	return backend === "gateway" ? { url, backend } : { url };
}

export function mergeGateway(
	gateway: Record<string, unknown> | undefined,
	defaults: GatewayConfig,
	project: boolean,
): GatewayConfig {
	if (!gateway || project) return defaults;
	const seat =
		typeof gateway.seat === "string" && SEAT_PATTERN.test(gateway.seat)
			? gateway.seat
			: defaults.seat;
	return {
		url: nonEmpty(gateway.url, defaults.url),
		seat,
		timeoutMs: intInRange(gateway.timeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.timeoutMs),
	};
}

/**
 * A project layer (a file a cloned repository controls) never reaches the service target or turns anything on: it is
 * ignored apart from `enabled`, which can only go true -> false, so a repository cannot point memory traffic at its own host.
 */
export function mergeHindsight(
	hindsight: Record<string, unknown> | undefined,
	defaults: HindsightConfig,
	project: boolean,
): HindsightConfig {
	if (!hindsight) return defaults;
	const enabled = booleanOr(hindsight.enabled, defaults.enabled);
	if (project) return { ...defaults, enabled: defaults.enabled && enabled };
	const backend = backendField(hindsight.backend, defaults.backend);
	const merged: HindsightConfig = {
		enabled,
		url: nonEmpty(hindsight.url, defaults.url),
		bank:
			typeof hindsight.bank === "string" && HINDSIGHT_BANK.test(hindsight.bank)
				? hindsight.bank
				: defaults.bank,
		timeoutMs: intInRange(hindsight.timeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.timeoutMs),
		retainTimeoutMs: intInRange(
			hindsight.retainTimeoutMs,
			1,
			MAX_SERVICE_TIMEOUT_MS,
			defaults.retainTimeoutMs,
		),
	};
	if (backend === "gateway") merged.backend = "gateway";
	return merged;
}

/** Same trust rule as `mergeHindsight`; `ground` (sends the prompt to RAGFlow) can only be turned off by a project file. */
export function mergeRagflow(
	ragflow: Record<string, unknown> | undefined,
	defaults: RagflowConfig,
	project: boolean,
): RagflowConfig {
	if (!ragflow) return defaults;
	const enabled = booleanOr(ragflow.enabled, defaults.enabled);
	const ground = booleanOr(ragflow.ground, defaults.ground);
	if (project)
		return { ...defaults, enabled: defaults.enabled && enabled, ground: defaults.ground && ground };
	let datasetIds = defaults.datasetIds;
	if (Array.isArray(ragflow.datasetIds)) {
		const ids = ragflow.datasetIds
			.filter((id): id is string => typeof id === "string" && id.trim() !== "")
			.map((id) => id.trim());
		if (ids.length === ragflow.datasetIds.length && ids.length <= MAX_DATASET_IDS)
			datasetIds = [...new Set(ids)];
	}
	const backend = backendField(ragflow.backend, defaults.backend);
	const merged: RagflowConfig = {
		enabled,
		url: nonEmpty(ragflow.url, defaults.url),
		datasetIds,
		topK: intInRange(ragflow.topK, 1, 20, defaults.topK),
		similarityThreshold: unitInterval(ragflow.similarityThreshold, defaults.similarityThreshold),
		timeoutMs: intInRange(ragflow.timeoutMs, 1, MAX_SERVICE_TIMEOUT_MS, defaults.timeoutMs),
		ground,
		groundChars: intInRange(ragflow.groundChars, 500, 8_000, defaults.groundChars),
	};
	if (backend === "gateway") merged.backend = "gateway";
	return merged;
}
