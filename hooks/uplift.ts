#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude Code UserPromptSubmit hook entry (and `--ctl` control CLI).
 *
 * stdin: hook JSON from Claude Code. stdout: hook JSON with additionalContext, or a
 * block decision answering an `/ultrathink-<verb>` command (src/uplift/commands.ts).
 * Always exits 0 so the user's prompt is never blocked by a plugin failure.
 */
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import { isChildInvocation } from "../src/claude/complete.ts";
import { runPromptSubmit, type PromptSubmitInput } from "../src/claude/hook.ts";
import {
	clearSkipOnce,
	defaultStateDir,
	hostSessionId,
	readControl,
	readSkipOnce,
	sessionPath,
} from "../src/claude/state.ts";
import { recentConversationFromTranscript } from "../src/claude/transcript.ts";
import { installChildReaper } from "../src/resilience/child.ts";
import {
	parseUltrathinkCommand,
	runControl,
	takeSessionFlag,
	trackingEnabled,
	trackingOff,
} from "../src/uplift/commands.ts";
import { decideUplift } from "../src/uplift/detect.ts";
import { recordLastSkip, skipNotice } from "../src/uplift/skip.ts";
import { planningTarget } from "../src/uplift/skill.ts";
import { clearPlanCarrier, writePlanCarrier } from "../src/host/carrier.ts";
import { claimTurn, markClaimedTurnsDone } from "../src/host/claim.ts";
import { detectHost } from "../src/host/detect.ts";
import { selectEngine } from "../src/host/engine.ts";
import { createGatewayTracker, trackCommand } from "../src/track/gateway.ts";
import { isSubagentEnvelope, parseEnvelope } from "../src/host/envelope.ts";

function log(message: string): void {
	if (process.env.ULTRATHINK_DEBUG === "1") process.stderr.write(`[ultrathink] ${message}\n`);
}

/**
 * One line per skip in the hook's stderr, whatever ULTRATHINK_DEBUG says: a skipped prompt is a decision the user cannot
 * see. `stateDir` also records it for `ultrathink status` (the routine exits before the state directory is known do not).
 */
function noteSkip(reason: string, stateDir?: string): void {
	process.stderr.write(`[ultrathink] skipped: ${reason}\n`);
	if (stateDir !== undefined) recordLastSkip(stateDir, reason);
}

/**
 * Writes hook output and waits for it to reach the pipe. `process.stdout.write` followed by `process.exit` (even from
 * the write callback) drops everything past the pipe buffer under Bun: a large plan would reach the host truncated.
 */
export async function emit(text: string): Promise<void> {
	await Bun.write(Bun.stdout, text);
}

async function readStdin(): Promise<string> {
	try {
		return await new Response(Bun.stdin.stream()).text();
	} catch {
		return "";
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "--ctl") {
		const { sessionId, args } = takeSessionFlag(argv.slice(1));
		await emit(
			`${await runControl(args, { stateDir: defaultStateDir(), cwd: process.cwd(), sessionId })}\n`,
		);
		return;
	}
	if (isChildInvocation()) return;
	const envelope = parseEnvelope(await readStdin());
	const raw = envelope as PromptSubmitInput;
	// The session this turn belongs to; its carrier is the only one this hook ever clears or writes.
	const hookSession = hostSessionId(raw.session_id);
	const clearCarrier = (stateDir: string): void => {
		if (hookSession !== undefined) clearPlanCarrier(stateDir, hookSession);
	};
	if (process.env.ULTRATHINK_UPLIFT === "0") {
		noteSkip("ULTRATHINK_UPLIFT=0");
		if (detectHost() === "grok-build") clearCarrier(defaultStateDir());
		return;
	}
	if (raw.hook_event_name && raw.hook_event_name !== "UserPromptSubmit") return;
	// Grok runs UserPromptSubmit inside subagents too; only the main session plans and tracks.
	if (isSubagentEnvelope(envelope)) {
		noteSkip("subagent");
		return;
	}
	const cwd = raw.cwd?.trim() || process.cwd();
	const host = detectHost();
	const stateDir = defaultStateDir();
	// Grok's rule reads this session's last-plan.<sessionId>.json every turn, so a turn that ends without a plan must
	// not leave the previous prompt's carrier behind.
	const grok = host === "grok-build";
	// `/ultrathink-<verb>` runs before planning. quick: the host's command template delivers
	// the message, so plan nothing. Other verbs: answer with a block so no model turn runs.
	const command = parseUltrathinkCommand(raw.prompt ?? "");
	if (command?.verb === "quick") {
		noteSkip("quick");
		if (grok) clearCarrier(stateDir);
		return;
	}
	if (command) {
		if (grok) clearCarrier(stateDir);
		const reason = await runControl([command.verb, ...command.args.split(/\s+/).filter(Boolean)], {
			stateDir,
			cwd,
			host,
			sessionId: hostSessionId(raw.session_id),
		});
		await emit(JSON.stringify({ decision: "block", reason }));
		return;
	}
	let input = raw;
	try {
		const target = planningTarget(raw.prompt ?? "", { cwd });
		// Yield before engine select: built-in slash commands and ultrathink's own skills
		// must not wait on the engine.
		if ("skip" in target) {
			noteSkip(target.skip, stateDir);
			if (grok) clearCarrier(stateDir);
			return;
		}
		// Every accepted target, skill or text-only, is what is planned (as on Omp): a rewritten `/word …` no longer begins with `/`.
		input = { ...raw, prompt: target.text, ...(target.skill ? { skill: target.skill } : {}) };
	} catch {
		// reason: fail-open: a throwing skill parser plans the prompt as written
	}
	if (grok) {
		// Grok may dispatch this hook twice per turn (global hook file plus plugin hooks); only the
		// first plans, and it owns the carrier: a duplicate must not clear the plan it writes.
		const promptId = envelope.prompt_id ?? envelope.promptId;
		const turnSessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
		if (
			typeof promptId === "string" &&
			promptId.trim() &&
			turnSessionId &&
			!claimTurn(stateDir, `${turnSessionId}:${promptId.trim()}`)
		) {
			noteSkip("duplicate-hook");
			return;
		}
		// Start the owned turn with no carrier: every exit below that plans nothing leaves none.
		clearCarrier(stateDir);
	}
	const config = loadConfig(claudeConfigPaths(cwd));
	const state = readControl(stateDir, { log });
	// Read before the engine wait: a /ultrathink-skip typed while the engine is selected is for this session's next prompt.
	const armedSkip = hookSession !== undefined && readSkipOnce(stateDir, hookSession);
	// Every deterministic skip (commands, acknowledgements, uplifted XML, graph hand-offs, planning off, an armed
	// /ultrathink-skip) is decided before an engine is selected, as the Omp and Hermes entry does: a skipped prompt must
	// never run the engine lookup (Grok spawns `grok models`) or print its login notice, and an armed skip is spent by the
	// prompt it skips, never left for a later task because selection returned first. runPromptSubmit decides again.
	const precheck = decideUplift(
		{ text: input.prompt ?? "", source: "user", idle: true },
		{
			enabled: state.enabled ?? config.uplift.enabled,
			skipOnce: armedSkip,
			skipTrivial: config.uplift.skipTrivial,
		},
	);
	if (precheck.action !== "uplift") {
		const reason = precheck.action === "skip" ? precheck.reason : precheck.action;
		if (hookSession !== undefined && armedSkip && reason === "skip-once") {
			try {
				clearSkipOnce(stateDir, hookSession);
			} catch {
				// reason: fail-open: the skip still applies to this prompt
			}
		}
		noteSkip(reason, stateDir);
		// Only the skips a user can be surprised by say so on screen; acknowledgements, commands, planning off and the
		// user's own raw: or skip-once stay quiet.
		const notice = skipNotice(reason);
		if (notice) await emit(JSON.stringify({ systemMessage: notice }));
		return;
	}
	// Legacy route evidence only when the host's own envelope carries it (blank means unknown); nothing is read from a
	// transcript (AD-4). selectEngine reads a session model for Hermes `auto` routing only, so other routes are unchanged.
	const sessionModel =
		typeof envelope.model === "string" && envelope.model.trim() ? envelope.model.trim() : undefined;
	const provider =
		typeof envelope.provider === "string" && envelope.provider.trim()
			? envelope.provider.trim()
			: undefined;
	const engine = await selectEngine(config, state, cwd, {
		host,
		purpose: "planning",
		...(sessionModel ? { sessionModel } : {}),
		...(provider ? { provider } : {}),
	});
	if ("skipped" in engine) {
		noteSkip(`engine ${engine.resolution.reason}`, stateDir);
		// A skill invocation must never receive a skip systemMessage (e.g. Grok login required) that eats the command.
		if (!input.skill)
			await emit(JSON.stringify({ systemMessage: engine.notice ?? engine.skipped }));
		return;
	}

	const result = await runPromptSubmit(input, {
		config,
		control: state,
		complete: engine.complete,
		engine: engine.label,
		engineError: engine.error,
		engineReport: engine.report,
		engineFailover: engine.failover,
		modelResolution: engine.resolution,
		stateDir,
		armedSkip,
		surface: host,
		conversation: recentConversationFromTranscript,
		log,
		track: trackingEnabled(config, state) ? createGatewayTracker(config, { log }) : undefined,
		trackingOff: trackingOff(config, state),
		trackCommand: trackCommand(),
	});
	if (result.skipped) noteSkip(result.reason ?? result.skipped, stateDir);
	// A Jev skip shows its notice only: no hookSpecificOutput, so the prompt reaches the model unchanged. Grok discards
	// stdout, and its carrier was cleared at the start of the owned turn, exactly as for a deterministic skip.
	if (result.skipped && result.notice) await emit(JSON.stringify({ systemMessage: result.notice }));
	if (result.output) {
		// Claude reads stdout first, so a carrier failure can never cost it the plan. Grok discards stdout and may close
		// its end early: its plan is the session's last-plan.<sessionId>.json, so a failed write must not skip it.
		try {
			await emit(JSON.stringify(result.output));
		} catch (error) {
			log(`stdout write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const sessionId = hostSessionId(input.session_id) ?? "";
		try {
			writePlanCarrier({
				host,
				stateDir,
				sessionId,
				specPath: sessionId
					? sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml")
					: undefined,
				statePath: sessionId ? sessionPath(stateDir, sessionId) : undefined,
				graphId: result.record?.plan?.graphId,
				context: result.output.hookSpecificOutput.additionalContext,
			});
		} catch (error) {
			log(`carrier write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

// Exit explicitly once stdout drained: a lingering handle (in-flight upstream request) must not keep the hook alive
// past the tracker budget. Every path exits 0, and only after the awaited emit above resolved.
if (import.meta.main) {
	installChildReaper({ signals: true });
	main()
		.then(markClaimedTurnsDone)
		.catch((error) => {
			log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
		})
		.catch(() => {
			// reason: fail-open: nothing left to say
		})
		.finally(() => {
			process.exit(0);
		});
}
