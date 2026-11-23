// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { isAbsolute } from "node:path";
import type { PstackConfig, PstackMappingStage } from "../config.ts";
import { asRecord, booleanOr, positiveInt } from "./fields.ts";

/** An absolute path as written (trimmed); blank, relative or wrong-typed values keep the lower layer's. */
function absolutePathField(value: unknown, fallback: string | undefined): string | undefined {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed && isAbsolute(trimmed) ? trimmed : fallback;
}

/** The four stages a user mapping may remap; `orchestrate` routes over all of them and is not a mapping key. */
const PSTACK_MAPPING_STAGES: readonly PstackMappingStage[] = [
	"discuss",
	"plan",
	"execute",
	"review",
];

/** A fresh mapping holding only the known stages and only their string entries; everything else is dropped. */
function pstackMapping(
	mapping: unknown,
): Partial<Record<PstackMappingStage, string[]>> | undefined {
	const record = asRecord(mapping);
	if (!record) return undefined;
	const merged: Partial<Record<PstackMappingStage, string[]>> = {};
	for (const stage of PSTACK_MAPPING_STAGES) {
		const value = record[stage];
		if (!Array.isArray(value)) continue;
		merged[stage] = value.filter((name): name is string => typeof name === "string");
	}
	return Object.keys(merged).length ? merged : undefined;
}

/**
 * The pstack bridge is opt-in and user-only: a project layer (a file a cloned repository controls) is ignored
 * entirely — its `enabled: true` stays the default false, and it can retarget neither cursorDir nor mapping.
 */
export function mergePstack(
	pstack: Record<string, unknown> | undefined,
	defaults: PstackConfig,
	project: boolean,
): PstackConfig {
	if (!pstack || project) return defaults;
	// A later layer replaces only the stages it names. Omitting `mapping`, or naming no valid stage, keeps the earlier map.
	const mapping = pstackMapping(pstack.mapping);
	return {
		enabled: booleanOr(pstack.enabled, defaults.enabled),
		cursorDir: absolutePathField(pstack.cursorDir, defaults.cursorDir),
		mapping: mapping ? { ...defaults.mapping, ...mapping } : defaults.mapping,
		contextCapChars: positiveInt(pstack.contextCapChars, defaults.contextCapChars ?? 2000),
		strict: booleanOr(pstack.strict, defaults.strict ?? false),
	};
}
