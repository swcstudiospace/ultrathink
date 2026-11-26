// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Static report of the Cursor pstack bridge. Reads the same user-config files the staged hook reads, the pstack
 * plugin cache and `hooks.json`. It never writes, never enables the bridge, and never opens a network connection.
 * A missing plugin or an unknown skill is a warning only while the bridge is enabled; disabled is info, so a
 * machine that never opted in stays free of warnings. Section 4a availability validation (validatePstackAvailability)
 * is the read-only half of the autonomous §4 gate: cache present, fleet block resolvable, force-off respected.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAPPING, resolvePstack, skillPath, type PstackStage } from "../cursor/pstack.ts";
import { resolveSubagentFleet } from "../pstack/subagents.ts";
import { defaultConfig } from "../config.ts";
import type { DoctorDeps, Finding } from "./types.ts";
import { isRecord, readJson } from "../shared.ts";
import { validatePstackConfig } from "../config/pstack.ts";

type StageKey = Exclude<PstackStage, "orchestrate">;

const STAGES: readonly StageKey[] = ["discuss", "plan", "execute", "review"];
const HOOK_FILE = "ultrathink-cursor-pstack.js";

type Env = DoctorDeps["env"];

interface Decision {
	/** Absolute path of the file the hook would read, or `default` when no user file parses. */
	source: string;
	enabled: boolean;
	/** `ULTRATHINK_PSTACK=0`. The hook returns `{}` before config, so doctor must not report the bridge on. */
	forcedOff: boolean;
	cursorDir?: string | undefined;
	mapping?: Partial<Record<StageKey, string[]>> | undefined;
	/** Raw user-file `pstack` record, when the deciding file had one; strictly validated by `validatePstackConfig`. */
	pstack?: Record<string, unknown> | undefined;
	/** Set when `ULTRATHINK_CONFIG_DIR` names a file that exists but is not valid JSON. config-check reports the standard files. */
	invalidOverride?: string | undefined;
}

/** The hook's search order. `ULTRATHINK_CONFIG_DIR` replaces it; a project file is never a candidate. */
function hookConfigCandidates(env: Env): string[] {
	const override = env.ULTRATHINK_CONFIG_DIR?.trim();
	if (override) return [join(override, "config.json")];
	const home = env.HOME?.trim() || homedir();
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const claude = env.CLAUDE_CONFIG_DIR?.trim();
	return [
		join(xdg || join(home, ".config"), "ultrathink", "config.json"),
		join(claude || join(home, ".claude"), "ultrathink.json"),
	];
}

function mappingOverride(value: unknown): Partial<Record<StageKey, string[]>> | undefined {
	if (!isRecord(value)) return undefined;
	const merged: Partial<Record<StageKey, string[]>> = {};
	for (const stage of STAGES) {
		const names = value[stage];
		if (!Array.isArray(names)) continue;
		merged[stage] = names
			.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
			.map((name) => name.trim());
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** First successfully parsed user file wins, matching the hook. `null` or `[]` stops the search; invalid JSON does not. */
function readDecision(env: Env): Decision {
	const forcedOff = env.ULTRATHINK_PSTACK === "0";
	const override = env.ULTRATHINK_CONFIG_DIR?.trim();
	let invalidOverride: string | undefined;
	for (const file of hookConfigCandidates(env)) {
		const value = readJson(file);
		if (value === undefined) {
			// reason: config-check reads only the standard files, so an invalid override is reported here
			if (override && existsSync(file)) invalidOverride ??= file;
			continue;
		}
		if (!isRecord(value)) return { source: file, enabled: false, forcedOff };
		const pstack = value.pstack;
		if (!isRecord(pstack)) return { source: file, enabled: false, forcedOff };
		const cursorDir =
			typeof pstack.cursorDir === "string" && pstack.cursorDir.startsWith("/")
				? pstack.cursorDir
				: undefined;
		return {
			source: file,
			enabled: !forcedOff && pstack.enabled === true,
			forcedOff,
			cursorDir,
			mapping: mappingOverride(pstack.mapping),
			pstack,
		};
	}
	return { source: "default", enabled: false, forcedOff, invalidOverride };
}

function namesFor(stage: StageKey, override: Decision["mapping"]): readonly string[] {
	if (override && Object.prototype.hasOwnProperty.call(override, stage))
		return override[stage] ?? [];
	return DEFAULT_MAPPING[stage];
}

function cursorDirFor(env: Env, decision: Decision): string {
	const fromEnv = env.ULTRATHINK_PSTACK_CURSOR_DIR?.trim();
	if (fromEnv && fromEnv.startsWith("/")) return fromEnv;
	if (decision.cursorDir) return decision.cursorDir;
	return join(env.HOME?.trim() || homedir(), ".cursor");
}

function hookState(cursorDir: string): { installed: boolean; detail: string } {
	const staged = join(cursorDir, "hooks", HOOK_FILE);
	const hooksFile = join(cursorDir, "hooks.json");
	const stagedOk = existsSync(staged);
	if (!existsSync(hooksFile)) {
		return {
			installed: false,
			detail: `hooks.json not found in ${cursorDir}${stagedOk ? `; staged file present at ${staged}` : ""}`,
		};
	}
	const parsed = readJson(hooksFile);
	if (parsed === undefined) return { installed: false, detail: `${hooksFile} is not valid JSON` };
	const hooks = isRecord(parsed) ? parsed.hooks : undefined;
	const list = isRecord(hooks) ? hooks.beforeSubmitPrompt : undefined;
	const entry =
		Array.isArray(list) &&
		list.some(
			(item) =>
				isRecord(item) &&
				(item["ultrathink-managed"] === true ||
					(typeof item.command === "string" && item.command.includes(HOOK_FILE))),
		);
	if (entry && stagedOk)
		return {
			installed: true,
			detail: `${hooksFile} has one ultrathink-managed beforeSubmitPrompt entry; staged file ${staged}`,
		};
	if (entry)
		return { installed: false, detail: `hooks.json names the hook but ${staged} is missing` };
	return {
		installed: false,
		detail: `${hooksFile} has no ultrathink-managed beforeSubmitPrompt entry`,
	};
}

/**
 * §4a availability validation: the read-only half of the autonomous §4 gate (cache present, fleet block resolvable,
 * force-off respected), checked before any §4c start. `ULTRATHINK_PSTACK=0` short-circuits to `bypassed`, so §4c/§4d
 * are skipped and the exact legacy loop runs. Never writes, never enables the bridge.
 *
 * Precedence chain (F-4: §4a must not degrade a fleet the host would start — keep in sync with
 * `BackgroundHost.start`'s default `fleetResolver` in `src/pstack/background-host.ts`, which calls
 * `resolveSubagentFleet({ enabled: true, homeDir })` from the cache alone):
 * 1. `ULTRATHINK_PSTACK=0` → `bypassed`. Wins over everything, same as the hook and the resolver's `forcedOff`.
 * 2. Cache + fleet resolvability via the single resolver `resolveSubagentFleet` with the host default
 *    `enabled: true`. A granted fleet (cache present + ≥1 mapped skill resolves) is `ok` here even when no user
 *    config sets `pstack.enabled`. Gating §4a on `pstack.enabled` (the hook/`mergePstack` opt-in, default false)
 *    would report `unavailable` for a fleet §4c would start — the V13 surface mismatch.
 * 3. Location/mapping only refines step 2: `ULTRATHINK_PSTACK_CURSOR_DIR` > user-config `cursorDir` >
 *    `$HOME/.cursor` (the host default), and the per-stage `mapping` override with per-stage `DEFAULT_MAPPING`
 *    fallback, expanded to a full stage map so the resolver counts exactly what `checkPstack`'s probe counts.
 *    User `pstack.enabled` governs the hook roster path (`pstackRosterFor`) and `checkPstack` warn/info levels
 *    only; it does not gate §4a. Reporting `ok` enables nothing — doctor stays read-only.
 */
type PstackAvailability =
	| { status: "ok"; root: string; version: string; resolvedSkills: number }
	| { status: "unavailable"; reason: string }
	| { status: "bypassed"; reason: string };

function validatePstackAvailability(deps: DoctorDeps): PstackAvailability {
	try {
		const decision = readDecision(deps.env);
		if (decision.forcedOff)
			return {
				status: "bypassed",
				reason: "ULTRATHINK_PSTACK=0 turns the hook off before config is applied",
			};
		const homeDir = deps.env.HOME?.trim() || homedir();
		const mapping: Record<StageKey, readonly string[]> = {
			discuss: namesFor("discuss", decision.mapping),
			plan: namesFor("plan", decision.mapping),
			execute: namesFor("execute", decision.mapping),
			review: namesFor("review", decision.mapping),
		};
		// Host default enabled:true (precedence step 2); decision.enabled is intentionally not consulted here.
		const fleet = resolveSubagentFleet({
			enabled: true,
			cursorDir: cursorDirFor(deps.env, decision),
			homeDir,
			mapping,
			forcedOff: false,
		});
		if (!fleet.ok) return { status: "unavailable", reason: fleet.reason };
		return {
			status: "ok",
			root: fleet.root,
			version: fleet.version,
			resolvedSkills: fleet.skills.length,
		};
	} catch (error) {
		return { status: "unavailable", reason: String(error) };
	}
}

/** Pstack findings for doctor. Never throws: a probe that fails becomes a finding inside this function. */
export function checkPstack(deps: DoctorDeps): Finding[] {
	const decision = readDecision(deps.env);
	const findings: Finding[] = [];
	findings.push({
		id: "pstack.enabled",
		section: "pstack",
		level: decision.enabled ? "ok" : "info",
		title: decision.enabled ? "pstack bridge enabled" : "pstack bridge disabled",
		detail: decision.forcedOff
			? `ULTRATHINK_PSTACK=0 turns the hook off before config is applied.${decision.source === "default" ? "" : ` Config not applied: ${decision.source}.`}`
			: decision.source === "default"
				? "Deciding source: default (no user config the Cursor hook can read). A project file cannot enable it."
				: `Deciding source: ${decision.source}`,
	});
	if (decision.invalidOverride) {
		findings.push({
			id: "pstack.config-invalid",
			section: "pstack",
			level: "info",
			title: "ULTRATHINK_CONFIG_DIR names a config file that is not valid JSON",
			detail: `File: ${decision.invalidOverride}`,
			fix: "Fix the JSON in that file, or unset ULTRATHINK_CONFIG_DIR to use the standard config files.",
		});
	}
	// Strict config validation: values the merge drops are surfaced with the default that stayed.
	if (decision.pstack) {
		const validation = validatePstackConfig(decision.pstack, defaultConfig().pstack, false);
		if (validation.issues.length > 0) {
			findings.push({
				id: "pstack.config-values",
				section: "pstack",
				level: decision.enabled ? "warn" : "info",
				title: "pstack config values ignored",
				detail: validation.issues
					.map(
						(issue) =>
							`${issue.field}: expected ${issue.expected}, got ${issue.received}; kept ${issue.kept}`,
					)
					.join("\n"),
				fix: "Fix the pstack values in the deciding user config; the defaults shown were kept.",
			});
		}
	}

	const projectFile = join(deps.cwd, ".claude", "ultrathink.json");
	const project = readJson(projectFile);
	const projectPstack = isRecord(project) && isRecord(project.pstack) ? project.pstack : undefined;
	if (projectPstack?.enabled === true && !decision.enabled && !decision.forcedOff) {
		findings.push({
			id: "pstack.project-ignored",
			section: "pstack",
			level: "info",
			title: "project config cannot enable the pstack bridge",
			detail: `File: ${projectFile}`,
			fix: "Set pstack.enabled in the user config the Cursor hook reads, then install the hook.",
		});
	}

	const cursorDir = cursorDirFor(deps.env, decision);
	const resolved = resolvePstack(cursorDir);
	if ("reason" in resolved) {
		findings.push({
			id: "pstack.plugin",
			section: "pstack",
			level: decision.enabled ? "warn" : "info",
			title: "pstack plugin not resolved",
			detail: `${resolved.reason}\nLooked in: ${cursorDir}`,
			...(decision.enabled
				? {
						fix: "Install the pstack Cursor plugin, or set pstack.cursorDir to the Cursor directory that contains it.",
					}
				: {}),
		});
		const planned = STAGES.map(
			(stage) => `${stage}: ${namesFor(stage, decision.mapping).join(", ") || "(none)"}`,
		).join("\n");
		findings.push({
			id: "pstack.skills",
			section: "pstack",
			level: "info",
			title: "per-stage skills not resolved",
			detail: planned,
		});
	} else {
		findings.push({
			id: "pstack.plugin",
			section: "pstack",
			level: "ok",
			title: `pstack ${resolved.version}`,
			detail: resolved.root,
		});
		const lines: string[] = [];
		const missing: string[] = [];
		for (const stage of STAGES) {
			const parts: string[] = [];
			for (const name of namesFor(stage, decision.mapping)) {
				const found = skillPath(resolved, name);
				if ("path" in found) parts.push(`${name} → ${found.path}`);
				else {
					parts.push(`${name} → missing`);
					missing.push(`${stage}/${name}`);
				}
			}
			lines.push(`${stage}: ${parts.join("; ") || "(none)"}`);
		}
		findings.push({
			id: "pstack.skills",
			section: "pstack",
			level: missing.length > 0 ? (decision.enabled ? "warn" : "info") : "ok",
			title:
				missing.length > 0
					? `unknown or missing pstack skill: ${missing.join(", ")}`
					: "per-stage skills resolve",
			detail: lines.join("\n"),
			...(missing.length > 0 && decision.enabled
				? {
						fix: "Fix pstack.mapping or reinstall the pstack plugin. The hook skips a missing skill and still injects the rest.",
					}
				: {}),
		});
	}
	// Subagent fleet: mirror the fleet counts from resolvePstack + namesFor without importing
	// src/pstack/subagents.ts, so this check stays static/read-only on the plugin cache.
	try {
		if (!decision.enabled) {
			findings.push({
				id: "pstack.fleet",
				section: "pstack",
				level: "info",
				title: "pstack subagent fleet disabled",
				detail: "pstack subagent fleet disabled (pstack.enabled)",
			});
		} else if ("reason" in resolved) {
			findings.push({
				id: "pstack.fleet",
				section: "pstack",
				level: "info",
				title: "pstack subagent fleet not resolved",
				detail: `fleet: not resolved — ${resolved.reason}`,
			});
		} else {
			const counts = STAGES.map(
				(stage) =>
					`${stage} ${namesFor(stage, decision.mapping).filter((name) => "path" in skillPath(resolved, name)).length}`,
			).join(", ");
			findings.push({
				id: "pstack.fleet",
				section: "pstack",
				level: "ok",
				title: "pstack subagent fleet",
				detail: `fleet: ${resolved.root} (pstack ${resolved.version}) — ${counts} skill(s)`,
			});
		}
	} catch (error) {
		findings.push({
			id: "pstack.fleet",
			section: "pstack",
			level: "info",
			title: "pstack subagent fleet unavailable",
			detail: String(error),
		});
	}

	// §4a availability: one finding summarizing the read-only gate outcome (bypass skips §4c/§4d, legacy loop).
	const availability = validatePstackAvailability(deps);
	if (availability.status === "bypassed") {
		findings.push({
			id: "pstack.availability",
			section: "pstack",
			level: "info",
			title: "pstack availability bypassed",
			detail: `ULTRATHINK_PSTACK=0: §4a short-circuits, §4c/§4d skipped, exact legacy loop. ${availability.reason}.`,
		});
	} else if (availability.status === "ok") {
		findings.push({
			id: "pstack.availability",
			section: "pstack",
			level: "ok",
			title: `pstack availability ok (pstack ${availability.version})`,
			detail: `${availability.root} — ${availability.resolvedSkills} mapped skill(s) resolve`,
		});
	} else {
		findings.push({
			id: "pstack.availability",
			section: "pstack",
			level: decision.enabled ? "warn" : "info",
			title: "pstack availability unavailable",
			detail: availability.reason,
			...(decision.enabled
				? {
						fix: "Install the pstack plugin or fix pstack.mapping; the autonomous §4 gate degrades and the legacy loop continues.",
					}
				: {}),
		});
	}

	const hook = hookState(cursorDir);
	findings.push({
		id: "pstack.hook",
		section: "pstack",
		level: hook.installed ? "ok" : decision.enabled ? "warn" : "info",
		title: hook.installed ? "Cursor hook installed" : "Cursor hook not installed",
		detail: hook.detail,
		...(!hook.installed && decision.enabled
			? { fix: "From the ultrathink clone, run: bun scripts/cursor-hooks.ts install" }
			: {}),
	});
	return findings;
}
