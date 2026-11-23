// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Typed fleet outcome for gsd-autonomous pstack dispatch (contracts/pstack-dispatch.openapi.json@1.3.0).
 *
 * This module resolves the pstack fleet for one phase into a {@link FleetOutcome}.
 * It is a thin wrapper: the single resolver remains `resolveSubagentFleet`
 * (+ `renderSubagentRoster`) in `./subagents.ts`; no second resolver lives here.
 * Never throws: every failure is a typed `state` plus a `reason`, and the
 * `fallback` says what the caller must do — fail-open to vanilla by default, or
 * fail-closed (`blocked`) only when an explicit strict source is set (OQ1:
 * `ULTRATHINK_PSTACK_STRICT=1`, `pstack.strict`, `--pstack-required`).
 */
import { redactSecrets } from "../redact.ts";
import {
	playbookForStage,
	renderSubagentRoster,
	resolveSubagentFleet,
	type FleetStage,
	type SubagentFleet,
} from "./subagents.ts";
/**
 * Strict precedence (THREAT-STRICT-WIRING, OQ1): sources are evaluated in
 * this order — (1) caller-resolved `strict`, (2) `configStrict`
 * (`pstack.strict`), (3) `ULTRATHINK_PSTACK_STRICT` from `env`
 * (`"1"` arms, `"0"` does not), (4) `--pstack-required` in `argv`
 * (presence arms). Arming rule: any source that explicitly arms strict
 * turns it on; an explicit disable (`false`/`"0"`) never disarms a source
 * that arms it, so a lower source cannot silence a higher one. The
 * default (no source arms) is fail-open.
 */
export function resolveStrictFlag(input: {
	strict?: boolean;
	configStrict?: boolean;
	env?: Record<string, string | undefined>;
	argv?: readonly string[];
}): boolean {
	if (input.strict === true) return true;
	if (input.configStrict === true) return true;
	if (input.env?.[PSTACK_STRICT_ENV] === "1") return true;
	if (input.argv?.includes(PSTACK_REQUIRED_ARG) === true) return true;
	return false;
}

/**
 * Redacts a reason/detail string before it is persisted or shown.
 * Parity with `redactSecrets` (NFR-19, THREAT-REDACT-NARROW): delegates to
 * the one shared redactor (`../redact.ts`) so PEM blocks, URL userinfo,
 * auth/cookie headers, Bearer tokens, JWTs, secret-token prefixes and
 * secret-named assignments are all masked. Never throws (fail-closed to
 * `[redacted]` inside `redactSecrets`); empty input passes through.
 */
export function redactReason(text: string): string {
	return redactSecrets(text);
}

/** Contract `FleetOutcome.state`: a typed state for every resolution, never empty. */
export type FleetState = "ok" | "disabled" | "unresolvable" | "forced-off" | "blocked";
/** Contract `FleetOutcome.fallback`: `vanilla` continues fail-open; `blocked` fails closed. */
export type FleetFallback = "vanilla" | "blocked";
/** The phase types `PLAYBOOK_ROUTES` plays (contract `phaseType`). */
export type PhaseType = "discuss" | "plan" | "execute" | "review";
/** Contract `PhaseDispatchRecord` per-unit outcome. */
export type DispatchUnitOutcome = "landed" | "blocked" | "failed";

/** A wave unit's outcome in a {@link PhaseDispatchRecord} (contract `units[]`). */
export interface DispatchUnit {
	unit: string;
	outcome: DispatchUnitOutcome;
	detail?: string;
}

/**
 * Typed result of resolving the fleet for one phase (contract `FleetOutcome`).
 * `ok`/`reason` keep the `SubagentFleet` back-compat; `state`/`fallback`/
 * `reasonCode`/`strict`/`playbook`/`roster`/`summaryLine` are additive.
 * `fallback` is `blocked` whenever the fleet resolved (`ok`) — meaning no
 * fallback is taken — and follows the strict flag otherwise.
 */
export interface FleetOutcome {
	state: FleetState;
	ok: boolean;
	reason: string;
	reasonCode: FleetState;
	fallback: FleetFallback;
	strict: boolean;
	playbook?: string;
	fleet?: SubagentFleet;
	roster?: string | null;
	summaryLine?: string;
}

/**
 * Provenance record persisted per dispatched phase (contract
 * `PhaseDispatchRecord` + data contract `SC-PhaseDispatchRecord`). `reason`
 * and `units[].detail` are redacted (NFR-19) before persistence; the fleet
 * payload is never stored wholesale — only its skills' names ride along in
 * `summaryLine`.
 */
export interface PhaseDispatchRecord {
	phaseType: PhaseType;
	playbook: string;
	state: FleetState;
	fallback: FleetFallback;
	strict: boolean;
	reason: string;
	units: DispatchUnit[];
	summaryLine?: string;
	correlationId?: string;
	taskId?: string;
	createdAt?: string;
}

/** OQ1 strict sources: the env var name and the CLI alias (config is `pstack.strict`). */
export const PSTACK_STRICT_ENV = "ULTRATHINK_PSTACK_STRICT";
export const PSTACK_REQUIRED_ARG = "--pstack-required";

/** Fleet failure reason → typed state. The fleet reports only `ok` or a reason. */
export function fleetStateFor(reason: string): FleetState {
	if (reason.includes("forced off")) return "forced-off";
	if (reason.includes("disabled")) return "disabled";
	return "unresolvable";
}

function outcome(state: FleetState, partial: Partial<FleetOutcome>): FleetOutcome {
	const strict = partial.strict ?? false;
	const reason = partial.reason ?? "ok";
	const resolved: FleetOutcome = {
		state,
		ok: state === "ok",
		reason: redactReason(reason),
		reasonCode: state,
		fallback: state === "ok" ? "blocked" : strict ? "blocked" : "vanilla",
		strict,
	};
	if (partial.playbook !== undefined) resolved.playbook = partial.playbook;
	if (partial.fleet !== undefined) resolved.fleet = partial.fleet;
	if (partial.roster !== undefined) resolved.roster = partial.roster;
	if (partial.summaryLine !== undefined) resolved.summaryLine = partial.summaryLine;
	return resolved;
}

function summaryLineFor(input: {
	phaseType: PhaseType;
	playbook: string;
	skillNames: readonly string[];
	state: FleetState;
	fallback: FleetFallback;
}): string {
	// Same shape as the data contract's summaryLineFormat, minus `units`
	// (units belong to a dispatch record, not to a resolution).
	const fleet =
		input.state === "ok"
			? (input.skillNames
					.map((name) => name.trim())
					.filter(Boolean)
					.join("+") ?? "")
			: input.fallback;
	const outcomeWord = input.state === "ok" ? "landed" : input.fallback;
	const fallbackToken = input.state === "ok" ? "none" : input.fallback;
	return `phase=${input.phaseType} playbook=${input.playbook} fleet=${fleet || "none"} outcome=${outcomeWord} fallback=${fallbackToken}`;
}

/** The FleetStage passed to the fleet resolver for a contract phase type. */
export function fleetStageFor(phaseType: PhaseType): FleetStage {
	return phaseType;
}

/**
 * Resolves the fleet for one phase exactly once and reports a typed
 * {@link FleetOutcome}. Never throws and never returns an empty outcome:
 * `state` is always one of the contract states.
 */
export function resolveFleetOutcome(input: {
	phaseType: PhaseType;
	enabled: boolean;
	homeDir: string;
	cursorDir?: string;
	mapping?: Partial<Record<FleetStage, readonly string[]>>;
	forcedOff?: boolean;
	strict?: boolean;
	configStrict?: boolean;
	env?: Record<string, string | undefined>;
	argv?: readonly string[];
	rosterCap?: number;
}): FleetOutcome {
	try {
		const strict = resolveStrictFlag(input);
		const playbook = playbookForStage(fleetStageFor(input.phaseType));
		if (input.forcedOff) {
			return outcome("forced-off", {
				reason: "pstack bridge forced off (ULTRATHINK_PSTACK=0)",
				strict,
				playbook,
				summaryLine: summaryLineFor({
					phaseType: input.phaseType,
					playbook,
					skillNames: [],
					state: "forced-off",
					fallback: strict ? "blocked" : "vanilla",
				}),
			});
		}
		if (!input.enabled) {
			return outcome("disabled", {
				reason: "pstack bridge disabled",
				strict,
				playbook,
				summaryLine: summaryLineFor({
					phaseType: input.phaseType,
					playbook,
					skillNames: [],
					state: "disabled",
					fallback: strict ? "blocked" : "vanilla",
				}),
			});
		}
		const fleet = resolveSubagentFleet({
			enabled: input.enabled,
			cursorDir: input.cursorDir,
			homeDir: input.homeDir,
			mapping: input.mapping,
			forcedOff: input.forcedOff,
		});
		if (!fleet.ok) {
			const state = fleetStateFor(fleet.reason);
			return outcome(state, {
				reason: fleet.reason,
				strict,
				playbook,
				summaryLine: summaryLineFor({
					phaseType: input.phaseType,
					playbook,
					skillNames: [],
					state,
					fallback: strict ? "blocked" : "vanilla",
				}),
			});
		}
		const skillNames = fleet.skills.map((skill) => skill.name);
		return outcome("ok", {
			reason: "ok",
			strict,
			playbook,
			fleet,
			roster: renderSubagentRoster(fleet, input.rosterCap ?? 4000),
			summaryLine: summaryLineFor({
				phaseType: input.phaseType,
				playbook,
				skillNames,
				state: "ok",
				fallback: "blocked",
			}),
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const strict = resolveStrictFlag(input);
		const playbook = playbookForStage(fleetStageFor(input.phaseType));
		return outcome("unresolvable", {
			reason: `resolution failed: ${reason}`,
			strict,
			playbook,
			summaryLine: summaryLineFor({
				phaseType: input.phaseType,
				playbook,
				skillNames: [],
				state: "unresolvable",
				fallback: strict ? "blocked" : "vanilla",
			}),
		});
	}
}
