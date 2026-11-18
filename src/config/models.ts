// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { HostModelOverride, ModelsConfig, TotModelsConfig } from "../config.ts";
import { type HostId, isHostId } from "../host/types.ts";
import { TOT_BREAKER_THRESHOLD, TOT_PRD_CANDIDATES } from "../route-defaults.ts";
import { asRecord, hasControlCharacter, selectorField } from "./fields.ts";

/** Provider keys never merged into a dictionary, in any layer (prototype pollution, T-15-01). An object lookup would hit the prototype itself. */
const UNSAFE_DICTIONARY_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

/** A prototype-free copy of a provider dictionary's own entries, so no inherited property can act as a mapping. */
export function providerDictionary(entries: Readonly<Record<string, string>>): Record<string, string> {
	const out = Object.create(null) as Record<string, string>;
	for (const [key, value] of Object.entries(entries)) out[key] = value;
	return out;
}

/** A prototype-free copy of a ToT candidate map, each list copied so no layer shares a mutable array. */
function totCandidates(
	entries: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
	const out = Object.create(null) as Record<string, readonly string[]>;
	for (const [key, value] of Object.entries(entries)) out[key] = [...value];
	return out;
}

export function defaultTotModels(): TotModelsConfig {
	return {
		model: "",
		candidates: totCandidates(TOT_PRD_CANDIDATES),
		breakerThreshold: TOT_BREAKER_THRESHOLD,
	};
}

/** A candidate list from a string or an array of strings: blanks, controls and repeats dropped; undefined for any other type. */
function candidateIds(value: unknown): string[] | undefined {
	const list: unknown[] | undefined =
		typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
	if (list === undefined) return undefined;
	const ids: string[] = [];
	for (const item of list) {
		const id = selectorField(item);
		if (id && !hasControlCharacter(id) && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * Per-entry merge of `models.tot`: a wrong type keeps the lower value, a blank `model` clears the override, a provider's
 * list replaces the lower list and an empty list removes the provider; prototype keys and control characters are ignored.
 */
function mergeTotModels(
	tot: Record<string, unknown> | undefined,
	defaults: TotModelsConfig,
): TotModelsConfig {
	if (!tot) return defaults;
	const model = selectorField(tot.model);
	const candidates = totCandidates(defaults.candidates);
	for (const [provider, list] of Object.entries(asRecord(tot.candidates) ?? {})) {
		const key = provider.trim().toLowerCase();
		if (!key || hasControlCharacter(key) || UNSAFE_DICTIONARY_KEYS.includes(key)) continue;
		const ids = candidateIds(list);
		if (ids === undefined) continue;
		if (ids.length === 0) delete candidates[key];
		else candidates[key] = ids;
	}
	const threshold = tot.breakerThreshold;
	return {
		model: model === undefined || hasControlCharacter(model) ? defaults.model : model,
		candidates,
		breakerThreshold:
			typeof threshold === "number" && Number.isInteger(threshold) && threshold >= 1
				? threshold
				: defaults.breakerThreshold,
	};
}

/**
 * Per-entry merge of `models` (D-05): a wrong type keeps the lower value, a blank host field clears it, a blank provider
 * default removes the lower selector (exposing the host-catalog tier), and unknown hosts, prototype keys and inherited fields are ignored.
 * A project layer (`project`) may set a host's `model` only: its `provider`, `providerDefaults` and `tot` are ignored.
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
	// A project layer cannot choose the provider a host plans with, the provider defaults or the ToT allowlist.
	if (project) return { hosts, providerDefaults, tot: defaults.tot };
	for (const [provider, selector] of Object.entries(asRecord(models.providerDefaults) ?? {})) {
		if (UNSAFE_DICTIONARY_KEYS.includes(provider)) continue;
		const value = selectorField(selector);
		if (value === "") delete providerDefaults[provider];
		else if (value !== undefined) providerDefaults[provider] = value;
	}
	return { hosts, providerDefaults, tot: mergeTotModels(asRecord(models.tot), defaults.tot) };
}
