// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp host side of the GSD phase record. The record is one JSON file per session under `<stateDir>/phase-loop/`, the
 * directory and lock the CLI merge gate uses, so both writers take turns. Every load-decide-save runs under that lock:
 * a lock that cannot be taken, or any store failure, yields one notice and writes nothing. Only a GSD-skill prompt
 * records a phase; plain prompts write nothing. The Omp refusal is advisory; the merge gate enforces the record.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { type LockOptions, withFileLock } from "../claude/atomic.ts";
import { OMP_LOCK } from "../claude/state.ts";
import { redactSecrets } from "../redact.ts";
import { verificationFileName } from "../ship/signals.ts";
import { parseSkillScaffold, parseSlashCommand } from "../uplift/skill.ts";
import type { PhaseLoopStore } from "../workflow/phase-loop-store.ts";
import { type CheckpointReason, fileStore } from "../workflow/phase-loop-store.ts";
import {
	attemptPhase,
	checkpointPhaseLoop,
	open as openHtilEntry,
	type OpenHtilOptions,
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

/** GSD verification statuses that open an HTIL entry for their phase directory. */
const HTIL_STATUSES: Record<string, true> = { human_needed: true };

/** The names of the subdirectories directly under `dir`, sorted. A missing or unreadable `dir` has none. */
function subdirectories(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		// reason: a missing or unreadable directory has no subdirectories, so there is no phase or verification to read
		return [];
	}
}

/**
 * Phase directories whose verification status opens an HTIL entry: `human_needed`, the human item ADR 0001 defines. Every phase directory
 * is considered. Each phase's verification is its bare `VERIFICATION.md`, else its last `*-VERIFICATION.md`. A passed
 * status, a missing or unreadable file, or no status opens none. Returns the directory names, sorted.
 */
function htilPhases(cwd: string): string[] {
	const phasesDir = join(cwd, ".planning", "phases");
	return subdirectories(phasesDir).filter((phase) => {
		try {
			const file = verificationFileName(readdirSync(join(phasesDir, phase)));
			if (file === undefined) return false;
			const status = frontmatterStatus(readFileSync(join(phasesDir, phase, file), "utf8"));
			return status !== undefined && HTIL_STATUSES[status] === true;
		} catch {
			// reason: an unreadable phase directory or verification file opens no entry
			return false;
		}
	});
}

/** The HTIL entry id of a phase directory's verification (LIFE-05): `verification:<directory name>`. */
export function verificationEntryId(directoryName: string): string {
	return `verification:${directoryName}`;
}

/**
 * Opens an HTIL entry for every `human_needed` phase directory on disk under `cwd` (LIFE-05). The disk is read at each
 * call, so a verification written after the phase's settle-time record is opened before a merge checks the entries. An
 * entry that already exists, open or resolved, is refused by `open` without a write. `options.afterShip` is passed only by the
 * merge gate's reconcile, so a Ship-closed loop accepts the entry there and nowhere else.
 */
export function openHtilEntries(
	cwd: string,
	sessionId: string,
	store: PhaseLoopStore,
	options: OpenHtilOptions = {},
): void {
	for (const directory of htilPhases(cwd))
		openHtilEntry(
			sessionId,
			{ id: verificationEntryId(directory), owner: "human" },
			store,
			options,
		);
}

/**
 * The phase directory a phase argument names under `phasesDir`: a full directory name, or a bare phase number such as
 * `110` or `1` (compared by integer value, so `1` names `01-core`). A number that matches no directory, or more than
 * one, names none. Returns the directory name, or null.
 */
export function findPhaseDirectory(phaseArg: string, phasesDir: string): string | null {
	const names = subdirectories(phasesDir);
	if (names.includes(phaseArg)) return phaseArg;
	if (!/^\d+$/.test(phaseArg)) return null;
	const matches = names.filter((name) => {
		const prefix = name.split("-", 1)[0] ?? "";
		return /^\d+$/.test(prefix) && Number(prefix) === Number(phaseArg);
	});
	return matches.length === 1 ? (matches[0] ?? null) : null;
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
		openHtilEntries(options.cwd, options.sessionId, store);
		// This host records only for its own session, so the connection check holds for that session.
		const outcome = attemptPhase(
			options.sessionId,
			attemptInputOf(phase, options.plan),
			(runtimeId) => runtimeId === options.sessionId,
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
 * Checkpoints the session's stored phase record with `reason`, under the phase-record lock. A session with no record has
 * no loop to checkpoint and writes nothing.
 */
function checkpointSessionPhases(
	session: PhaseSession & { at: string },
	reason: CheckpointReason,
): PhaseReport {
	const dir = join(session.stateDir, "phase-loop");
	if (session.sessionId === "" || !existsSync(dir)) return NONE;
	return underPhaseLock(dir, (): PhaseReport => {
		const store = fileStore(dir);
		if (store.load(session.sessionId).status === "absent") return NONE;
		checkpointPhaseLoop(store, session.sessionId, reason, session.at);
		return NONE;
	});
}

/**
 * Checkpoints the session's stored phase record as paused at shutdown. A session with no record has no loop to pause and
 * writes nothing.
 */
export function pauseSessionPhases(session: PhaseSession & { at: string }): PhaseReport {
	return checkpointSessionPhases(session, "pause");
}

/**
 * Checkpoints the session's stored phase record as killed when a host signal ends the process (LIFE-04). The same
 * record, lock and no-record rule as the pause.
 */
export function killSessionPhases(session: PhaseSession & { at: string }): PhaseReport {
	return checkpointSessionPhases(session, "kill");
}

/** The signals the kill hook checkpoints on (LIFE-04): an interrupt and a termination request. */
const KILL_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type KillSignal = (typeof KILL_SIGNALS)[number];

/** Disposes the kill hook registered last. A new install replaces it, so a process holds one hook at a time. */
let activeKillHook: (() => void) | undefined;

/**
 * Checkpoints the live session as killed. The process is ending and has no notice surface, so a failure goes to stderr.
 */
function checkpointOnKill(
	signal: KillSignal,
	live: () => PhaseSession | undefined,
	now: () => number,
): void {
	try {
		const session = live();
		if (session === undefined) return;
		const report = killSessionPhases({ ...session, at: new Date(now()).toISOString() });
		if (report.kind === "notice") process.stderr.write(`[ultrathink] ${signal}: ${report.text}\n`);
	} catch (error) {
		process.stderr.write(`[ultrathink] ${signal}: ${failureText(error)}\n`);
	}
}

/**
 * Installs the host's kill hook (LIFE-04). On SIGINT or SIGTERM the live session's phase record is checkpointed as
 * killed, synchronously and under the phase-record lock, before the process ends. When no other listener is registered
 * for the signal, the hook removes its listeners and re-raises the signal, so the exit status is that signal. When
 * another listener is registered, that listener owns termination and the hook only checkpoints. A later install
 * replaces an earlier one. Returns the dispose that removes this registration.
 */
export function installKillCheckpoint(
	live: () => PhaseSession | undefined,
	now: () => number,
): () => void {
	activeKillHook?.();
	const hooks = new Map<KillSignal, () => void>();
	const dispose = (): void => {
		for (const [signal, hook] of hooks) process.removeListener(signal, hook);
		hooks.clear();
		if (activeKillHook === dispose) activeKillHook = undefined;
	};
	for (const signal of KILL_SIGNALS) {
		const hook = (): void => {
			checkpointOnKill(signal, live, now);
			const ours: unknown[] = [...hooks.values()];
			if (process.listeners(signal).some((listener) => !ours.includes(listener))) return;
			dispose();
			process.kill(process.pid, signal);
			// Reached only if the runtime kept a handler for the signal: end with the signal's conventional status.
			process.exit(128 + osConstants.signals[signal]);
		};
		hooks.set(signal, hook);
		process.on(signal, hook);
	}
	activeKillHook = dispose;
	return dispose;
}
