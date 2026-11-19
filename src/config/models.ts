// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { HostModelOverride, ModelsConfig } from "../config.ts";
import { type HostId, isHostId } from "../host/types.ts";
import { asRecord, selectorField } from "./fields.ts";

/** Provider keys never merged into a dictionary, in any layer (prototype pollution, T-15-01). An object lookup would hit the prototype itself. */
const UNSAFE_DICTIONARY_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** A prototype-free copy of a provider dictionary's own entries, so no inherited property can act as a mapping. */
export function providerDictionary(
	entries: Readonly<Record<string, string>>,
): Record<string, string> {
	const out = Object.create(null) as Record<string, string>;
	for (const [key, value] of Object.entries(entries)) out[key] = value;
	return out;
}

/**
 * Per-entry merge of `models` (D-05): a wrong type keeps the lower value, a blank host field clears it, a blank provider
 * default removes the lower selector (exposing the host-catalog tier), and unknown hosts, prototype keys and inherited fields are ignored.
 * A project layer (`project`) may set a host's `model` only: its `provider` and `providerDefaults` are ignored.
 */
export function mergeModels(
	models: Record<string, unknown> | undefined,
	defaults: ModelsConfig,
	project: boolean,
): ModelsConfig {
	if (!models) return defaults;
	const hosts: Partial<Record<HostId, HostModelOverride>> = { ...defaults.hosts };
	for (const [host, entry] of Object.entries(asRecord(models.hosts) ?? {})) {
		const fields = asRecord(entry);
		if (!fields || !isHostId(host)) continue;
		const provider =
			!project && Object.hasOwn(fields, "provider") ? selectorField(fields.provider) : undefined;
		const model = Object.hasOwn(fields, "model") ? selectorField(fields.model) : undefined;
		if (provider === undefined && model === undefined) continue;
		const lower = hosts[host];
		hosts[host] = {
			provider: provider ?? lower?.provider ?? "",
			model: model ?? lower?.model ?? "",
		};
	}
	const providerDefaults = providerDictionary(defaults.providerDefaults);
	// A project layer cannot choose the provider a host plans with or the provider defaults.
	if (project) return { hosts, providerDefaults };
	for (const [provider, selector] of Object.entries(asRecord(models.providerDefaults) ?? {})) {
		if (UNSAFE_DICTIONARY_KEYS.includes(provider)) continue;
		const value = selectorField(selector);
		if (value === "") delete providerDefaults[provider];
		else if (value !== undefined) providerDefaults[provider] = value;
	}
	return { hosts, providerDefaults };
}
