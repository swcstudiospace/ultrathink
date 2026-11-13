// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Minimum host versions the adapters accept. No host documents a minimum supported version, so each
 * floor is the version observed in docs/plugin-research/host-contracts.md ("Host versions used").
 * Versions compare by dotted numeric components; a leading "v" is ignored. Unparseable versions are
 * refused (fail closed).
 */

export type HostId = "claude-code" | "grok-build" | "muse" | "hermes" | "prime-agent" | "omp";

export const HOST_VERSION_FLOORS: Readonly<Record<HostId, string>> = {
	"claude-code": "2.1.322",
	"grok-build": "1.0.77",
	muse: "1.4.14",
	hermes: "v0.23.1",
	"prime-agent": "0.10.2",
	omp: "18.19.0",
};

export type VersionFloorResult =
	| { readonly ok: true; readonly floor: string; readonly observed: string | null }
	| {
			readonly ok: false;
			readonly reason: "below_floor" | "unknown_version";
			readonly floor: string;
			readonly observed: string | null;
	  };

const VERSION_PATTERN = /^v?(\d+(?:\.\d+)*)$/;

function parseVersion(version: string): readonly number[] | null {
	const digits = VERSION_PATTERN.exec(version)?.[1];
	if (digits === undefined) {
		return null;
	}
	return digits.split(".").map(Number);
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

/**
 * Accepts `observed` when it is at or above the host's floor. Refuses with `unknown_version` when
 * `observed` is null or not a dotted numeric version (or the floor itself is not one), and with
 * `below_floor` when it is lower than the floor.
 */
export function checkVersionFloor(hostId: HostId, observed: string | null): VersionFloorResult {
	const floor = HOST_VERSION_FLOORS[hostId];
	const floorParts = parseVersion(floor);
	const observedParts = observed === null ? null : parseVersion(observed);
	if (floorParts === null || observedParts === null) {
		return { ok: false, reason: "unknown_version", floor, observed };
	}
	if (compareVersions(observedParts, floorParts) < 0) {
		return { ok: false, reason: "below_floor", floor, observed };
	}
	return { ok: true, floor, observed };
}
