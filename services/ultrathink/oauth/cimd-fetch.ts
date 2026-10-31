// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { UltrathinkConfig } from "../config/config.ts";
import {
	createOutboundFetchGuard,
	type GuardedFetch,
	type OutboundCacheHeaders,
	type OutboundFetchCode,
	type OutboundFetchPolicy,
} from "../security/outbound-fetch.ts";
import {
	type CimdDocument,
	type CimdFailureCode,
	parseCimdDocument,
	validateCimdClientId,
} from "./cimd.ts";

export type CimdFetchResult =
	| { readonly ok: true; readonly document: CimdDocument; readonly headers: OutboundCacheHeaders }
	| {
			readonly ok: false;
			readonly kind: "model";
			readonly refused: { readonly field: string; readonly code: CimdFailureCode };
	  }
	| { readonly ok: false; readonly kind: "fetch"; readonly code: "DISABLED" | OutboundFetchCode };
export interface CimdFetcher {
	fetch(raw: unknown, signal?: AbortSignal): Promise<CimdFetchResult>;
}

const CIMD_FETCH_POLICY: OutboundFetchPolicy = { timeoutMs: 5000, maxBytes: 5000, maxInflight: 4 };
// Inert construction, one admission counter for every default factory in this process.
const sharedCimdGuard = createOutboundFetchGuard(CIMD_FETCH_POLICY);

/**
 * OFF first, then the original identity/model contracts around one complete guarded fetch.
 * Trusted origins and enablement are independent snapshots. Configuration never supplies
 * executable dependencies. Resolution/cache/consent and requested-redirect checks belong
 * to phase103; advertisement and live enablement remain separately gated.
 */
export function createCimdFetcher(
	config: Pick<UltrathinkConfig, "cimdEnabled">,
	allowedRedirectOrigins: ReadonlySet<string>,
	guardedFetch: GuardedFetch = sharedCimdGuard,
): CimdFetcher {
	const enabled = config.cimdEnabled === true;
	const origins = new Set(allowedRedirectOrigins);
	return {
		async fetch(raw, signal) {
			if (!enabled) return { ok: false, kind: "fetch", code: "DISABLED" };
			const identity = validateCimdClientId(raw);
			if (!identity.valid) return { ok: false, kind: "model", refused: identity.refused };
			const response = await guardedFetch(identity.value, signal);
			if (!response.ok) return { ok: false, kind: "fetch", code: response.code };
			const document = parseCimdDocument(identity.value, response.text, origins);
			if (!document.valid) return { ok: false, kind: "model", refused: document.refused };
			return { ok: true, document: document.value, headers: response.headers };
		},
	};
}
