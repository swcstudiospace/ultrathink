// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Two doctor sections that read the environment and the USSR Stack connections.
 *
 * - `env`: {@link checkRegisteredEnv} turns every problem `validateEnv` finds (a bad kind, an out-of-range number, a wrong
 *   kill-switch value, an alias that disagrees with its canonical name) into one `env.<name>` warning. Offline and
 *   value-free: a finding names variables and expectations, never a value.
 * - `stack`: {@link checkStackConnections} runs the same five probes as `ultrathink stack` with `live: false` and reports
 *   one finding per member that is not connected. The probes run only free, read-only checks: Substrate and Hindsight
 *   HTTP requests, the Realm local socket and the Swarm classifier spawn. Decisions sends nothing without `live`. Each
 *   probe is capped at {@link STACK_PROBE_TIMEOUT_MS}. This is the one doctor section that may contact a network service.
 */
import { defaultStateDir } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { ENV_REGISTRY, type EnvFinding, type EnvVarDef, validateEnv } from "../env-registry.ts";
import { detectHost } from "../host/detect.ts";
import { probeStack } from "../stack/index.ts";
import type {
	ConnectionStatus,
	StackConnection,
	StackMember,
	StackProbe,
	StackProbeContext,
} from "../stack/types.ts";
import type { DoctorDeps, DoctorLevel, Finding } from "./types.ts";

/** Per-probe cap of the stack section. */
const STACK_PROBE_TIMEOUT_MS = 3000;

/** Statuses that produce a finding, and its level. `connected` and `disabled` say nothing. */
const STACK_LEVELS: Partial<Record<ConnectionStatus, DoctorLevel>> = {
	unavailable: "warn",
	misconfigured: "warn",
	degraded: "info",
};

function definitionOf(name: string): EnvVarDef | undefined {
	return ENV_REGISTRY.find((def) => def.name === name || def.aliases?.includes(name));
}

/** The alias whose value disagrees with the canonical name's, in the order the registry lists them. */
function conflictingAlias(def: EnvVarDef, env: DoctorDeps["env"]): string | undefined {
	const canonical = env[def.name]?.trim();
	return def.aliases?.find((alias) => {
		const value = env[alias]?.trim();
		return value !== undefined && value !== "" && value !== canonical;
	});
}

function envFix(finding: EnvFinding, env: DoctorDeps["env"]): string {
	const def = definitionOf(finding.name);
	if (finding.problem === "alias-conflict" && def) {
		return `set ${def.name} (or remove ${conflictingAlias(def, env) ?? "the alias"})`;
	}
	if (finding.problem === "kill-switch" && def?.disableValue !== undefined) {
		return `unset it or set it to ${def.disableValue}`;
	}
	return `correct ${finding.name} or unset it (see docs/environment.md)`;
}

/** One warning per environment problem. Never throws, reads no file and prints no value. */
export function checkRegisteredEnv(deps: DoctorDeps): Finding[] {
	return validateEnv(deps.env).map(
		(finding): Finding => ({
			id: `env.${finding.name}`,
			section: "env",
			level: "warn",
			title: finding.message,
			fix: envFix(finding, deps.env),
		}),
	);
}

function stackFinding(connection: StackConnection): Finding | undefined {
	const level = STACK_LEVELS[connection.status];
	if (level === undefined) return undefined;
	return {
		id: `stack.${connection.member}`,
		section: "stack",
		level,
		title: `${connection.member}: ${connection.reason}`,
		...(connection.fix ? { fix: connection.fix } : {}),
	};
}

/**
 * One finding per member that is not connected (disabled members and connected ones yield nothing). Any throw becomes the
 * single `stack.report` warning; the error text is never shown, because it may carry a URL or a credential. `probes`
 * replaces individual probes and exists for tests only.
 */
export async function checkStackConnections(
	deps: DoctorDeps,
	probes?: Partial<Record<StackMember, StackProbe>>,
): Promise<Finding[]> {
	try {
		const ctx: StackProbeContext = {
			env: deps.env,
			config: loadConfig(claudeConfigPaths(deps.cwd, deps.env)),
			cwd: deps.cwd,
			stateDir: defaultStateDir(deps.env),
			host: detectHost(deps.env),
			live: false,
			timeoutMs: STACK_PROBE_TIMEOUT_MS,
		};
		const report = await probeStack(ctx, probes ? { probes } : undefined);
		return report.members.flatMap((connection) => stackFinding(connection) ?? []);
	} catch {
		// reason: the caught error may carry a secret or a URL; the fixed title is the whole report.
		return [{ id: "stack.report", section: "stack", level: "warn", title: "stack check failed" }];
	}
}
