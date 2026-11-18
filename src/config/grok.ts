// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { checkServiceUrl } from "../net/safe-url.ts";
import {
	GROK_EFFORTS,
	GROK_TRANSPORTS,
	type GrokConfig,
	type GrokEffort,
	type GrokTransport,
} from "../grok/types.ts";
import { hasControlCharacter, nonEmpty, projectTimerMs, selectorField } from "./fields.ts";

const MAX_FALLBACK_MODELS = 8;

/** Array of model ids: trimmed, blanks and control-character entries dropped, deduped in order, capped. Non-array keeps the default. */
function mergeFallbackModels(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || hasControlCharacter(entry)) continue;
		const model = entry.trim();
		if (!model || out.includes(model)) continue;
		out.push(model);
		if (out.length >= MAX_FALLBACK_MODELS) break;
	}
	return out;
}

/** Same trust rule as `mergeClaude`: a project layer keeps `bin`, `home` and `baseUrl` (where the CLI and traffic go). */
export function mergeGrok(
	grok: Record<string, unknown> | undefined,
	defaults: GrokConfig,
	project: boolean,
): GrokConfig {
	if (!grok) return defaults;
	return {
		enabled: typeof grok.enabled === "boolean" ? grok.enabled : defaults.enabled,
		baseUrl: project ? defaults.baseUrl : grokBaseUrl(grok.baseUrl, defaults.baseUrl),
		model: selectorField(grok.model) || defaults.model,
		reasoningEffort: GROK_EFFORTS.includes(grok.reasoningEffort as GrokEffort)
			? (grok.reasoningEffort as GrokEffort)
			: defaults.reasoningEffort,
		transport: GROK_TRANSPORTS.includes(grok.transport as GrokTransport)
			? (grok.transport as GrokTransport)
			: defaults.transport,
		bin: project ? defaults.bin : nonEmpty(grok.bin, defaults.bin),
		home: !project && typeof grok.home === "string" ? grok.home.trim() : defaults.home,
		callTimeoutMs: projectTimerMs(grok.callTimeoutMs, defaults.callTimeoutMs, project),
		fallbackToClaude:
			typeof grok.fallbackToClaude === "boolean"
				? grok.fallbackToClaude
				: defaults.fallbackToClaude,
		fallbackModels: mergeFallbackModels(grok.fallbackModels, defaults.fallbackModels),
	};
}

/**
 * `grok.baseUrl` receives the Grok key as a bearer token, so it takes the service-URL policy of `checkServiceUrl`
 * (https, or http only to loopback, `*.ts.net` or 100.64.0.0/10), not the wider rule of `httpUrl`.
 */
function grokBaseUrl(value: unknown, fallback: string): string {
	const checked = checkServiceUrl(value);
	return checked.ok ? checked.url : fallback;
}
