// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp host side of the GSD phase record. The record is one JSON file per session under `<stateDir>/phase-loop/`, the
 * directory and lock the CLI merge gate uses, so both writers take turns. Every load-decide-save runs under that lock:
 * a lock that cannot be taken, or any store failure, yields one notice and writes nothing. Only a GSD-skill prompt
 * records a phase; plain prompts write nothing. The Omp refusal is advisory; the merge gate enforces the record.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LockOptions, withFileLock } from "../claude/atomic.ts";
import { OMP_LOCK } from "../claude/state.ts";
import { redactSecrets } from "../redact.ts";
import { parseSkillScaffold, parseSlashCommand } from "../uplift/skill.ts";
import { fileStore } from "../workflow/phase-loop-store.ts";
import {
	attemptPhase,
	checkpointPhaseLoop,
	open as openHtilEntry,
	PhaseLoopCorruptError,
	type PhaseAttemptInput,
	type PhaseName,
	restorePhaseLoop,
} from "../workflow/phase-loop.ts";
import type { PlanView } from "./view.ts";

/**
 * What the host shows for a phase-loop outcome: a transcript message that starts no turn, a warning notice, or nothing.
 */
export type PhaseReport =
	| { kind: "none" }
	| { kind: "message"; text: string }
	| { kind: "notice"; text: string };

/** The planner result the phase attempt reads: the uplift text and the plan view it came with. */
export interface PhasePlan {
	context: string;
	view?: PlanView;
}

/** The session whose record is read: the session id is the record key (Q1). */
export interface PhaseSession {
	stateDir: string;
	sessionId: string;
}

const NONE: PhaseReport = { kind: "none" };

/** The CLI's phase-record lock policy: the host's 2 s bound, and the lock's parent directory created on first use. */
const PHASE_LOCK: LockOptions = { ...OMP_LOCK, onTimeout: "throw", createParent: true };

/**
 * GSD commands that record a phase: the stage table in `cursor/pstack.ts`, mapped stage to phase (discuss, plan,
 * execute, review as Verify). `gsd-ship` is left out, since Ship starts only at the merge confirmation, and
 * `gsd-autonomous` is left out, since it runs several phases.
 */
const GSD_PHASE: Record<string, PhaseName> = {
	"gsd-discuss-phase": "Discuss",
	"gsd-plan-phase": "Plan",
	"gsd-ultraplan-phase": "Plan",
	"gsd-spec-phase": "Plan",
	"gsd-execute-phase": "Execute",
	"gsd-fast": "Execute",
	"gsd-quick": "Execute",
	"gsd-quick-batch": "Execute",
	"gsd-verify-work": "Verify",
	"gsd-code-review": "Verify",
	"gsd-ui-review": "Verify",
	"gsd-audit-uat": "Verify",
	"gsd-audit-fix": "Verify",
	"gsd-audit-milestone": "Verify",
};

const LOCK_NOTICE =
	"Ultrathink could not take the phase record lock, so nothing was recorded for this prompt. The plan is delivered as usual.";

const quarantineText = (path: string): string =>
	`Ultrathink's phase record for this session is corrupt and was set aside at ${path}. Nothing was recorded; the phase loop stays blocked until that copy is removed or a valid record replaces it.`;

/** The failure as one redacted line; a corrupt record names the copy it was set aside to. */
function failureText(error: unknown): string {
	if (error instanceof PhaseLoopCorruptError) return quarantineText(error.quarantinedAs);
	const detail = redactSecrets(error instanceof Error ? error.message : String(error))
		.replace(/\s+/g, " ")
		.slice(0, 200);
	return `Ultrathink could not update the phase record (${detail}); nothing was recorded for this prompt. The plan is delivered as usual.`;
}

/**
 * Runs `fn` under the phase-record lock. A lock that cannot be taken runs no `fn`: it yields the lock notice. Any
 * failure, including a lock timeout or a corrupt record, becomes a notice, so the caller never throws.
 */
function underPhaseLock(dir: string, fn: () => PhaseReport): PhaseReport {
	let notTaken = false;
	try {
		return withFileLock(
			dir,
			(): PhaseReport => (notTaken ? { kind: "notice", text: LOCK_NOTICE } : fn()),
			{
				...PHASE_LOCK,
				log: () => {
					notTaken = true;
				},
			},
		);
	} catch (error) {
		return { kind: "notice", text: failureText(error) };
	}
}

/** The phase a GSD-skill prompt records, or undefined for any other prompt. */
function phaseForPrompt(prompt: string): PhaseName | undefined {
	const name = parseSkillScaffold(prompt)?.name ?? parseSlashCommand(prompt)?.name;
	if (name === undefined) return undefined;
	const bare = name.slice(name.lastIndexOf(":") + 1).toLowerCase();
	return Object.hasOwn(GSD_PHASE, bare) ? GSD_PHASE[bare] : undefined;
}

/**
 * The attempt's counts, from the plan view: a complete uplift is the model's own plan text (the fallback template does
 * not count), and an unanswered clarification is a blocking one with no answer.
 */
function attemptInputOf(phase: PhaseName, plan: PhasePlan): PhaseAttemptInput {
	return {
		phase,
		completeUpliftCount: plan.context.trim() !== "" && plan.view?.source === "llm" ? 1 : 0,
		unansweredBlockingClarifications: (plan.view?.clarifications ?? []).filter(
			(item) => item.blocking && (item.answer ?? "").trim() === "",
		).length,
	};
}

const frontmatterStatus = (text: string): string | undefined => {
	const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	return block?.match(/^status:\s*["']?([^"'\r\n]+?)["']?\s*$/m)?.[1];
};

/**
 * Phases whose latest GSD verification reads `human_needed`, found the way the ship assessment finds the latest
 * verification: the newest phase directory that has a verification file. Unreadable input yields none.
 */
function humanNeededPhases(cwd: string): string[] {
	const phasesDir = join(cwd, ".planning", "phases");
	let phases: string[];
	try {
		phases = readdirSync(phasesDir).sort().reverse();
	} catch {
		// reason: no phases directory means no verification to read; the loop records without an HTIL entry
		return [];
	}
	for (const phase of phases) {
		let files: string[];
		try {
			files = readdirSync(join(phasesDir, phase));
		} catch {
			// reason: an unreadable phase directory has no verification, the same as a phase without one
			continue;
		}
		const file = files
			.filter((name) => name.endsWith("-VERIFICATION.md"))
			.sort()
			.at(-1);
		if (file === undefined) continue;
		let status: string | undefined;
		try {
			status = frontmatterStatus(readFileSync(join(phasesDir, phase, file), "utf8"));
		} catch {
			// reason: an unreadable verification file yields no status; the HTIL entry is not opened
			return [];
		}
		if (status !== undefined) return status === "human_needed" ? [phase] : [];
	}
	return [];
}

/**
 * Attempts the GSD phase a skill prompt names, once its plan has settled. Returns undefined for a prompt that records no
 * phase. An accepted attempt is silent; a refused one is a transcript message; a failure is a notice.
 */
export function recordGsdPhase(options: {
	stateDir: string;
	cwd: string;
	sessionId: string;
	prompt: string;
	plan: PhasePlan;
}): PhaseReport | undefined {
	const phase = phaseForPrompt(options.prompt);
	if (phase === undefined) return undefined;
	const dir = join(options.stateDir, "phase-loop");
	return underPhaseLock(dir, (): PhaseReport => {
		const store = fileStore(dir);
		// A phase whose verification needs a human opens an HTIL entry (Q8); an entry already open is refused without a write.
		for (const verified of humanNeededPhases(options.cwd))
			openHtilEntry(options.sessionId, { id: `verification:${verified}`, owner: "human" }, store);
		// The live session is connected by construction: this host records only for its own flight.
		const outcome = attemptPhase(
			options.sessionId,
			attemptInputOf(phase, options.plan),
			() => true,
			store,
		);
		if (outcome.accepted) return NONE;
		const refusals = outcome.refusals.join("; ");
		return {
			kind: "message",
			text: `${phase} was not recorded: ${refusals}. The plan is unchanged. This is advisory: the merge gate refuses to merge until the phase record shows the phases in order.`,
		};
	});
}

/**
 * Restores the session's stored phase record at session start or switch. A restored record is reported as a message; a
 * quarantined one as a notice naming its copy. No record means nothing to report and nothing is locked.
 */
export function restoreSessionPhases(session: PhaseSession): PhaseReport {
	const dir = join(session.stateDir, "phase-loop");
	if (session.sessionId === "" || !existsSync(dir)) return NONE;
	return underPhaseLock(dir, (): PhaseReport => {
		const report = restorePhaseLoop(fileStore(dir), session.sessionId);
		if (report.quarantined)
			return { kind: "notice", text: quarantineText(report.quarantinedAs ?? "") };
		if (!report.restored) return NONE;
		const phases = report.state.phaseOrder.join(", ") || "no phases yet";
		const pause = report.checkpoint
			? ` The record holds a ${report.checkpoint.reason} checkpoint from ${report.checkpoint.at}.`
			: "";
		return {
			kind: "message",
			text: `Ultrathink restored this session's phase loop: ${phases}.${pause}`,
		};
	});
}

/**
 * Checkpoints the session's stored phase record as paused at shutdown. A session with no record has no loop to pause and
 * writes nothing.
 */
export function pauseSessionPhases(session: PhaseSession & { at: string }): PhaseReport {
	const dir = join(session.stateDir, "phase-loop");
	if (session.sessionId === "" || !existsSync(dir)) return NONE;
	return underPhaseLock(dir, (): PhaseReport => {
		const store = fileStore(dir);
		if (store.load(session.sessionId).status === "absent") return NONE;
		checkpointPhaseLoop(store, session.sessionId, "pause", session.at);
		return NONE;
	});
}
