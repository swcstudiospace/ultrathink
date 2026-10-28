// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Swarm seam: a read-only probe that says whether AgentSwarm lanes are switched off, misconfigured, cannot
 * classify briefs, are at their limit or needing a human, or working.
 *
 * It reuses the lane core instead of re-implementing any of it: `resolveSwarmRoot` is the only root lookup
 * (and the only root validation), the classifier is the preflight the spawn path runs (`preflightClassify`),
 * and lane liveness and state come from `resolveStopTargets` and `laneStatus`. Every check is free and
 * read-only, so none of them waits for `ctx.live`. Every reason is a fixed template with counts: no brief
 * text, no environment value and no log text reaches it.
 */
import { type ClassifySpawn, CLASSIFY_TIMEOUT_MS, preflightClassify } from "../swarm/classify.ts";
import { type PidAlive, readLaneFile, STOP_HINT } from "../swarm/lane.ts";
import {
	laneDirs,
	laneStatus,
	type LaneVerify,
	maxLanes,
	type OrchStatusSpawn,
	orchStatusRunner,
	resolveStopTargets,
	resolveSwarmRoot,
	type TeamsFs,
} from "../swarm/teams.ts";
import type { StackConnection, StackProbe, StackProbeContext } from "./types.ts";

/** Seams for tests; the defaults are the real classifier, `orch_status.py`, signal 0 and the real filesystem. */
export interface SwarmProbeDeps {
	classifySpawn?: ClassifySpawn;
	statusSpawn?: OrchStatusSpawn;
	isAlive?: PidAlive;
	verify?: LaneVerify;
	fs?: TeamsFs;
}

type Outcome = Omit<StackConnection, "member" | "latencyMs">;

/** Headroom under the probe's own deadline, so a slow step reports its own reason rather than losing the race. */
const SETTLE_MS = 50;

/** Any SDLC-sounding text: the probe only needs the classifier to import and answer, not a particular verdict. */
const PROBE_TEXT = "build a health endpoint";

/** A lane older than this never degrades the link, however it ended. */
const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

const FIX_ROOT = "set ULTRATHINK_SWARM_ROOT (or SWARM_ROOT) to an absolute agent-swarm checkout";

function unavailable(reason: string, fix?: string): Outcome {
	return {
		status: "unavailable",
		reason,
		...(fix === undefined ? {} : { fix }),
		affects: ["preflight", "lanes"],
		via: "cli",
	};
}

/** `promise`'s value, or undefined when it has not settled within `ms`; never rejects. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	const { promise: expired, resolve } = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => resolve(undefined), Math.max(1, ms));
	try {
		return await Promise.race([promise, expired]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

async function probe(
	ctx: StackProbeContext,
	deps: SwarmProbeDeps,
	started: number,
	now: () => number,
): Promise<Outcome> {
	const primary = (ctx.env.ULTRATHINK_SWARM_ROOT ?? "").trim();
	const fallback = (ctx.env.SWARM_ROOT ?? "").trim();
	if (primary === "" && fallback === "" && ctx.config.swarm.autoRun !== true) {
		return {
			status: "disabled",
			reason: "swarm.autoRun is off and no swarm root is set; opt in with swarm.autoRun",
			fix: "set swarm.autoRun in a user config file and ULTRATHINK_SWARM_ROOT",
			via: "config",
		};
	}

	const root = resolveSwarmRoot(ctx.env, deps.fs);
	if ("reason" in root) {
		return {
			status: "misconfigured",
			reason: root.reason,
			fix: FIX_ROOT,
			affects: ["lanes"],
			via: "config",
		};
	}

	const remaining = (): number => Math.floor(ctx.timeoutMs - (now() - started) - SETTLE_MS);
	if (remaining() < 1) return unavailable("classifier timed out");
	const verdict = await preflightClassify(PROBE_TEXT, {
		swarmRoot: root.root,
		timeoutMs: Math.min(remaining(), CLASSIFY_TIMEOUT_MS),
		spawn: deps.classifySpawn,
	});
	if (verdict.kind === "unknown") {
		return unavailable(
			`Swarm classifier unavailable: ${verdict.reason}`,
			"install python3 and check that swarm.signal_detector imports from the agent-swarm checkout",
		);
	}

	const cap = maxLanes(ctx.env);
	const discovery = laneDirs(ctx.stateDir, deps.fs);
	const laneDeps = { isAlive: deps.isAlive, verify: deps.verify, fs: deps.fs };
	const liveTargets = resolveStopTargets("all", discovery.lanes, laneDeps);
	const live = "targets" in liveTargets ? liveTargets.targets.length : 0;

	// Only lanes started within the window can degrade the link: an old failed lane would otherwise hold it
	// degraded forever. A lane without a readable lane.json (or start time) is not counted; older attention
	// lanes still show in `/ultrathink-swarm status`.
	const windowStart = now() - ATTENTION_WINDOW_MS;
	const recent = discovery.lanes.filter((lane) => {
		const startedAt = Date.parse(readLaneFile(lane.stateDir, deps.fs)?.startedAt ?? "");
		return Number.isFinite(startedAt) && startedAt >= windowStart;
	});
	let attention = 0;
	let statusTimedOut = false;
	if (recent.length > 0) {
		const rows = await within(
			laneStatus(
				recent,
				orchStatusRunner({ swarmRoot: root.root, cwd: ctx.cwd, env: ctx.env }, deps.statusSpawn),
				laneDeps,
			),
			remaining(),
		);
		if (rows === undefined) statusTimedOut = true;
		else attention = rows.filter((row) => "state" in row && row.state === "attention").length;
	}

	const causes: string[] = [];
	if (live >= cap)
		causes.push(`${live} live lane(s) at the cap of ${cap} (ULTRATHINK_SWARM_MAX_LANES)`);
	if (attention > 0)
		causes.push(
			`${attention} lane(s) started in the last 24 h need attention (see /ultrathink-swarm status)`,
		);
	const timedOut = statusTimedOut ? "; lane status timed out" : "";
	if (causes.length > 0) {
		return {
			status: "degraded",
			reason: `${causes.join("; ")}${timedOut}`,
			fix: STOP_HINT,
			...(live >= cap ? { affects: ["lanes"] } : {}),
			via: "cli",
		};
	}
	return {
		status: "connected",
		reason: `classifier ok, ${live} live lane(s)${timedOut}`,
		via: "cli",
	};
}

/** Build a Swarm probe over injectable seams; {@link probeSwarm} is the one the stack report uses. */
export function createSwarmProbe(deps: SwarmProbeDeps = {}): StackProbe {
	return async (ctx: StackProbeContext): Promise<StackConnection> => {
		const now = ctx.now ?? Date.now;
		const started = now();
		const { promise: deadline, resolve } = Promise.withResolvers<Outcome>();
		const timer = setTimeout(() => resolve(unavailable("probe timed out")), ctx.timeoutMs);
		let outcome: Outcome;
		try {
			outcome = await Promise.race([probe(ctx, deps, started, now), deadline]);
		} catch {
			outcome = unavailable("probe failed");
		} finally {
			clearTimeout(timer);
		}
		return { member: "swarm", ...outcome, latencyMs: Math.max(0, now() - started) };
	};
}

/** The Swarm link for `ultrathink stack`: read-only, never throws, bounded by `ctx.timeoutMs`. */
export const probeSwarm: StackProbe = createSwarmProbe();
