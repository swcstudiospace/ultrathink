// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Gates a host's requested capability flags against the flags the host declares. Pure: no host SDK
 * imports. Resolution and fallback text come from core `resolveCapabilities` and `CAPABILITY_FALLBACKS`.
 */
import {
	CAPABILITY_FLAGS,
	type CapabilityFlag,
	resolveCapabilities,
} from "../core/src/capabilities/manifest.ts";

/** Flag values one host declares. An absent flag is unset and resolves to disabled. */
export type DeclaredCapabilities = Readonly<Partial<Record<CapabilityFlag, boolean>>>;

export interface GatedCapability {
	readonly flag: CapabilityFlag;
	readonly enabled: boolean;
	/** Degraded-mode text when disabled (core `CAPABILITY_FALLBACKS`); null when enabled. */
	readonly fallback: string | null;
}

/** Resolves each requested flag against the host's declared flags, preserving request order. */
export function gateCapabilities(
	requested: readonly CapabilityFlag[],
	declared: DeclaredCapabilities,
): readonly GatedCapability[] {
	const reports: Partial<Record<CapabilityFlag, { value: boolean; source: string }>> = {};
	for (const flag of CAPABILITY_FLAGS) {
		const value = declared[flag];
		if (value !== undefined) {
			reports[flag] = { value, source: "declared" };
		}
	}
	const resolved = resolveCapabilities(reports);
	return requested.map((flag) => ({
		flag,
		enabled: resolved[flag].enabled,
		fallback: resolved[flag].fallback,
	}));
}
