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

/** One config value the strict parse rejected: what was expected, what arrived, and which default stayed. */
interface PstackConfigIssue {
	field: string;
	expected: string;
	received: string;
	kept: string;
}

/** Result of `validatePstackConfig`: the merged config, the rejected values, and the defaults they fell back to. */
export interface PstackConfigValidation {
	config: PstackConfig;
	issues: PstackConfigIssue[];
	defaults: PstackConfig;
}

const PSTACK_KEYS: readonly string[] = [
	"enabled",
	"cursorDir",
	"mapping",
	"contextCapChars",
	"strict",
];

function kindOf(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null) return "null";
	return typeof value === "object" ? "object" : typeof value;
}

/**
 * Strict parse of one raw `pstack` layer (mergeUplift style, no silent coercion): only exact types are accepted —
 * "true"/1 for a boolean, "4000" for contextCapChars, a relative cursorDir — and every rejected value is reported
 * with the default/lower-layer value that stayed, so a typo is visible instead of silently inert. The merged config
 * is exactly `mergePstack`'s; this function only surfaces what the merge drops.
 */
export function validatePstackConfig(
	pstack: Record<string, unknown> | undefined,
	defaults: PstackConfig,
	project = false,
): PstackConfigValidation {
	const config = mergePstack(pstack, defaults, project);
	const issues: PstackConfigIssue[] = [];
	if (!pstack) return { config, issues, defaults };
	if (project) {
		for (const key of Object.keys(pstack)) {
			issues.push({
				field: key,
				expected: "absent (a project layer cannot set pstack)",
				received: kindOf(pstack[key]),
				kept: "default (project layer ignored)",
			});
		}
		return { config, issues, defaults };
	}
	for (const key of Object.keys(pstack)) {
		if (!PSTACK_KEYS.includes(key)) {
			issues.push({
				field: key,
				expected: "a known pstack key",
				received: kindOf(pstack[key]),
				kept: "ignored",
			});
		}
	}
	if ("enabled" in pstack && typeof pstack.enabled !== "boolean") {
		issues.push({
			field: "enabled",
			expected: "boolean",
			received: kindOf(pstack.enabled),
			kept: String(config.enabled),
		});
	}
	if ("strict" in pstack && typeof pstack.strict !== "boolean") {
		issues.push({
			field: "strict",
			expected: "boolean",
			received: kindOf(pstack.strict),
			kept: String(config.strict),
		});
	}
	if ("cursorDir" in pstack) {
		const value = pstack.cursorDir;
		if (typeof value !== "string" || !value.trim() || !isAbsolute(value.trim())) {
			issues.push({
				field: "cursorDir",
				expected: "absolute path",
				received: kindOf(value),
				kept: config.cursorDir ?? "(absent)",
			});
		}
	}
	if ("contextCapChars" in pstack) {
		const value = pstack.contextCapChars;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
			issues.push({
				field: "contextCapChars",
				expected: "positive integer",
				received: kindOf(value),
				kept: String(config.contextCapChars),
			});
		}
	}
	if ("mapping" in pstack) {
		const record = asRecord(pstack.mapping);
		if (!record) {
			issues.push({
				field: "mapping",
				expected: "object of stage to string[]",
				received: kindOf(pstack.mapping),
				kept: config.mapping ? "lower-layer mapping kept" : "(default mapping)",
			});
		} else {
			for (const [stage, value] of Object.entries(record)) {
				if (!PSTACK_MAPPING_STAGES.includes(stage as PstackMappingStage)) {
					issues.push({
						field: `mapping.${stage}`,
						expected: "a known stage (discuss, plan, execute, review)",
						received: kindOf(value),
						kept: "ignored",
					});
				} else if (!Array.isArray(value)) {
					issues.push({
						field: `mapping.${stage}`,
						expected: "string[]",
						received: kindOf(value),
						kept: "lower-layer mapping kept",
					});
				} else if (value.some((name) => typeof name !== "string")) {
					issues.push({
						field: `mapping.${stage}`,
						expected: "string[]",
						received: "array with non-string entries",
						kept: "non-string entries dropped",
					});
				}
			}
		}
	}
	return { config, issues, defaults };
}
