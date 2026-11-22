// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Pstack subagent fleet — pure resolution and roster rendering.
 * Resolves the pstack plugin cache and renders a per-stage skill roster
 * for the GSD phase loop; the fleet changes how each unit runs, never sequencing.
 * Never throws: every failure is a `reason` or `null`.
 */
import { join } from "node:path";
import {
	DEFAULT_MAPPING,
	resolvePstack,
	skillPath,
	type PstackInput,
	type StageMapping,
} from "../cursor/pstack.ts";

export type FleetStage = "discuss" | "plan" | "execute" | "review";

export interface FleetSkill {
	stage: FleetStage;
	name: string;
	path: string;
	purpose: string;
}

export type SubagentFleet =
	| { ok: true; root: string; version: string; skills: FleetSkill[] }
	| { ok: false; reason: string };

const STAGE_ORDER: readonly FleetStage[] = ["discuss", "plan", "execute", "review"];

/** Purpose wording matches pstack.ts PURPOSES. */
const PURPOSES: Record<string, string> = {
	how: "read-only walkthrough of how the subsystem works before discussing changes",
	architect: "settle caller usage, types and module shape before the plan locks a design",
	arena: "run parallel alternative attempts and keep the best parts before committing to a design",
	tdd: "write the failing test first, then the fix, while executing",
	interrogate: "have different models try to break the diff during verification or review",
	"no-comments":
		"strip comments before review and fix accepted findings during verification or review",
};

export function resolveSubagentFleet(input: {
	enabled: boolean;
	cursorDir?: string;
	homeDir: string;
	mapping?: Partial<Record<FleetStage, readonly string[]>>;
	forcedOff?: boolean;
}): SubagentFleet {
	try {
		if (input.forcedOff)
			return { ok: false, reason: "pstack bridge forced off (ULTRATHINK_PSTACK=0)" };
		if (!input.enabled) return { ok: false, reason: "pstack bridge disabled" };
		const resolved = resolvePstack(input.cursorDir ?? join(input.homeDir, ".cursor"));
		if ("reason" in resolved) return { ok: false, reason: resolved.reason };
		const mapping: StageMapping = input.mapping ?? DEFAULT_MAPPING;
		const skills: FleetSkill[] = [];
		for (const stage of STAGE_ORDER) {
			for (const name of mapping[stage] ?? []) {
				const skill = skillPath(resolved satisfies PstackInput, name);
				if ("reason" in skill) continue;
				skills.push({
					stage,
					name,
					path: skill.path,
					purpose: PURPOSES[name] ?? `pstack ${name} skill`,
				});
			}
		}
		if (skills.length === 0) return { ok: false, reason: "no pstack skills resolved" };
		return { ok: true, root: resolved.root, version: resolved.version, skills };
	} catch (error) {
		return { ok: false, reason: String(error) };
	}
}

export function renderSubagentRoster(fleet: SubagentFleet, cap = 2000): string | null {
	try {
		if (!fleet.ok) return null;
		const lines = ["## PSTACK subagent fleet"];
		for (const skill of fleet.skills) {
			lines.push(
				`- [${skill.stage}] ${skill.name} — read ${skill.path} — ${skill.purpose} — one subagent per unit`,
			);
		}
		lines.push(
			"The GSD phase loop still sequences the waves (TodoWrite, .planning artifacts, verify gate); the fleet only changes how each unit runs. Absent this section, spawn generic Task subagents.",
		);
		const block = lines.join("\n");
		return block.length > cap ? null : block;
	} catch {
		return null;
	}
}
