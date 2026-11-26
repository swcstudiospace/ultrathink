// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Pstack background host (W1-HOST, Option 1 NEW HOST) — the long-running
 * session supervisor for a continuous `gsd-autonomous` run.
 *
 * What it owns: start-once, observable-alive, stop-at-closeout and
 * resume-without-duplication for exactly one in-process session per run id.
 * Run identity is `makeRunId(milestoneId, sessionAnchor)`: same run id on
 * resume replays the recorded outcome and never duplicates an instance;
 * a different run id is a new run.
 *
 * "Real invocation" (the only definition n6 may use): a live host handle
 * exists for the run id AND the liveness predicate (below) passes now.
 * A mocked flat `Skill()` call with no handle, or a handle that fails the
 * predicate, is not a real invocation.
 *
 * Skill()-difference handoff paragraph (for W3-SKILL to paste into
 * gsd-autonomous/SKILL.md): a flat `Skill()` invocation is a bounded,
 * one-shot call that runs to completion and returns a result; this host is
 * different. `start(runId)` returns a live session handle, not a result.
 * The session then stays alive across phases while a fixed-interval liveness
 * predicate decides `running` vs `degraded` (predicate only — never the
 * caller's optimism), and `stop(runId)` blocks at closeout with a fixed
 * timeout, yielding `stopped` or `orphaned`. Do not treat a returned handle
 * as completed work, and do not assume a flat `Skill()` call started or
 * stopped the session: only this host's start/monitor/stop surface does.
 *
 * Single-writer rule: the host mutates only its own in-memory status map
 * and emits status lines through the injected sink. It never writes
 * `.planning/STATE.md`, `ROADMAP.md`, or phase artifacts; the GSD loop owns
 * those and appends the host's status line itself.
 *
 * Reuse: fleet resolution goes through the one resolver
 * (`resolveSubagentFleet` in `./subagents.ts`) — never a second resolver.
 * Secret redaction runs at capture (`captureOutput` and every log/status
 * line) via the shared `redactSecrets`, before anything is stored.
 */

import { homedir } from "node:os";
import { redactSecrets } from "../redact.ts";
import { resolveSubagentFleet, type SubagentFleet } from "./subagents.ts";

/** Fixed liveness evaluation interval (ms). Named per n4 D-18; W3 copies this number. */
export const LIVENESS_INTERVAL_MS = 1_000;
/** Freshness threshold (ms): a handle unseen for longer is stale, not running. */
export const LIVENESS_THRESHOLD_MS = 3_000;
/** Blocking stop timeout (ms): a stop that overruns it is `orphaned`, never silent. */
export const STOP_TIMEOUT_MS = 5_000;
/**
 * Bounded restart (ASSUMPTION, unverified — n5 §6 / n4 D-10): a mid-run
 * crash is treated as a fresh startup sequence of at most 1 retry,
 * 2 attempts total per run id. After the bound: degraded, never infinite.
 */
export const MAX_START_ATTEMPTS = 2;
const MAX_RESTARTS = 1;

export type HostStatus =
	| "running"
	| "completed"
	| "skipped"
	| "degraded"
	| "blocked"
	| "stopped"
	| "orphaned";

export type LifecycleEvent =
	| "started"
	| "healthy"
	| "stale"
	| "restarted"
	| "stopped"
	| "stop-failed";

/** Every lifecycle event maps to exactly one status value. */
export const EVENT_STATUS: Readonly<Record<LifecycleEvent, HostStatus>> = {
	started: "running",
	healthy: "running",
	stale: "degraded",
	restarted: "running",
	stopped: "stopped",
	"stop-failed": "orphaned",
};

export interface HostHandle {
	runId: string;
	instanceId: number;
	startedAt: number;
	lastSeenAt: number;
	alive: boolean;
	output: string;
}

export interface HostDeps {
	/** Fleet validation; defaults to the one resolver. Tests inject a stub. */
	fleetResolver?: () => SubagentFleet;
	homeDir?: string;
	/** Create the session handle. Default: in-memory handle (no CLI exists). */
	spawn?: (runId: string) => HostHandle;
	/** Blocking stop: true = stopped; false/throw = refused. Default: true. */
	stopper?: (handle: HostHandle) => boolean;
	/** Reap action invoked on orphaning. Default: mark dead. */
	reap?: (handle: HostHandle, reason: string) => void;
	now?: () => number;
	/** Status/log sink (the host's only output channel). Default: console.log. */
	sink?: (line: string) => void;
	/** Monitor interval override; 0 disables the timer (test seam). */
	intervalMs?: number;
	thresholdMs?: number;
	stopTimeoutMs?: number;
}

export interface StartResult {
	status: HostStatus;
	handle: HostHandle | null;
	reason?: string;
}
export interface ReconcileResult {
	status: HostStatus;
	handle: HostHandle | null;
	action: "noop" | "started" | "restarted" | "honored-recorded";
	reason?: string;
}

interface RunState {
	runId: string;
	handle: HostHandle | null;
	status: HostStatus;
	reason?: string;
	attempts: number;
	restarts: number;
}

function makeHandle(runId: string, instanceId: number, now: number): HostHandle {
	return { runId, instanceId, startedAt: now, lastSeenAt: now, alive: true, output: "" };
}

/** Run identity = milestone id + STATE session anchor (n4 D-14). */
export function makeRunId(milestoneId: string, sessionAnchor: string): string {
	return `${milestoneId}::${sessionAnchor}`;
}

export class BackgroundHost {
	private readonly runs = new Map<string, RunState>();
	/** Active-run marker: at most one run owns the session at a time. */
	private activeRunId: string | null = null;
	private instanceSeq = 0;
	private readonly timer: NodeJS.Timeout | null = null;
	private readonly now: () => number;
	private readonly threshold: number;
	private readonly stopTimeout: number;
	private readonly sink: (line: string) => void;

	constructor(private readonly deps: HostDeps = {}) {
		this.now = deps.now ?? (() => Date.now());
		this.threshold = deps.thresholdMs ?? LIVENESS_THRESHOLD_MS;
		this.stopTimeout = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
		this.sink = deps.sink ?? ((line) => console.log(line));
		const interval = deps.intervalMs ?? LIVENESS_INTERVAL_MS;
		if (interval > 0) {
			this.timer = setInterval(() => {
				for (const runId of [...this.runs.keys()]) this.checkLiveness(runId);
			}, interval);
			this.timer.unref?.();
		}
	}

	dispose(): void {
		clearInterval(this.timer as NodeJS.Timeout | undefined);
	}

	private log(line: string): void {
		this.sink(redactSecrets(line));
	}

	private emit(run: RunState): string {
		const line = run.reason ? `[pstack] ${run.status}: ${run.reason}` : `[pstack] ${run.status}`;
		this.log(line);
		return line;
	}

	/** The liveness predicate (named): alive handle, seen within threshold. */
	isLive(handle: HostHandle): boolean {
		return handle.alive && this.now() - handle.lastSeenAt <= this.threshold;
	}

	/** Freshness is part of the output contract: stale output is not consumable. */
	isFresh(handle: HostHandle): boolean {
		return this.isLive(handle);
	}

	/** Capture session output — redacted at capture, before any storage. */
	captureOutput(handle: HostHandle, text: string): string {
		handle.output = redactSecrets(text);
		handle.lastSeenAt = this.now();
		return handle.output;
	}

	/** Read captured output, or null when stale (never consume stale-but-alive). */
	consumeOutput(handle: HostHandle): string | null {
		return this.isFresh(handle) ? handle.output : null;
	}

	/** One-line status for the current run state (redacted). */
	formatStatus(runId: string): string {
		const run = this.runs.get(runId);
		if (!run) return "[pstack] skipped: no such run";
		return run.reason ? `[pstack] ${run.status}: ${run.reason}` : `[pstack] ${run.status}`;
	}

	instanceCount(runId?: string): number {
		let count = 0;
		for (const run of this.runs.values()) {
			if (run.handle?.alive && (runId === undefined || run.runId === runId)) count++;
		}
		return count;
	}

	getHandle(runId: string): HostHandle | null {
		return this.runs.get(runId)?.handle ?? null;
	}

	getStatus(runId: string): HostStatus | null {
		return this.runs.get(runId)?.status ?? null;
	}

	private spawn(runId: string): HostHandle {
		this.instanceSeq++;
		return this.deps.spawn
			? this.deps.spawn(runId)
			: makeHandle(runId, this.instanceSeq, this.now());
	}

	/** (a) Start once: same run id ⇒ live handle + one logged no-op. */
	start(runId: string): StartResult {
		if (!runId) return { status: "blocked", handle: null, reason: "empty run id" };
		const existing = this.runs.get(runId);
		if (existing?.handle && this.isLive(existing.handle)) {
			this.log(`[pstack] no-op: run ${runId} already running`);
			return { status: existing.status, handle: existing.handle };
		}
		// Active-run marker / re-entry guard: a second run while one is active no-ops.
		if (this.activeRunId && this.activeRunId !== runId) {
			this.log(`[pstack] no-op: re-entry while run ${this.activeRunId} active`);
			const active = this.runs.get(this.activeRunId);
			return { status: active?.status ?? "running", handle: active?.handle ?? null };
		}
		// §4a fleet validation through the one resolver.
		const fleet = (
			this.deps.fleetResolver ??
			(() =>
				resolveSubagentFleet({
					enabled: true,
					homeDir: this.deps.homeDir ?? homedir(),
				}))
		)();
		if (!fleet.ok) {
			const run: RunState = {
				runId,
				handle: null,
				status: "degraded",
				reason: fleet.reason,
				attempts: existing?.attempts ?? 0,
				restarts: existing?.restarts ?? 0,
			};
			this.runs.set(runId, run);
			this.emit(run);
			return { status: run.status, handle: null, reason: run.reason };
		}
		// Bounded startup attempts (≤1 retry / 2 attempts).
		const attempts = existing?.attempts ?? 0;
		for (let attempt = attempts; attempt < MAX_START_ATTEMPTS; attempt++) {
			try {
				const handle = this.spawn(runId);
				const run: RunState = {
					runId,
					handle,
					status: EVENT_STATUS.started,
					attempts: attempt + 1,
					restarts: existing?.restarts ?? 0,
				};
				this.runs.set(runId, run);
				this.activeRunId = runId;
				this.emit(run);
				return { status: run.status, handle };
			} catch (error) {
				if (attempt === MAX_START_ATTEMPTS - 1) {
					const run: RunState = {
						runId,
						handle: null,
						status: "degraded",
						reason: redactSecrets(String(error)),
						attempts: attempt + 1,
						restarts: existing?.restarts ?? 0,
					};
					this.runs.set(runId, run);
					this.emit(run);
					return { status: run.status, handle: null, reason: run.reason };
				}
			}
		}
		const run = this.runs.get(runId);
		return { status: run?.status ?? "degraded", handle: run?.handle ?? null };
	}

	/** Re-entry guard for U3/downstream callers: logged no-op while a run is active. */
	reenter(runId: string): StartResult {
		if (this.activeRunId) {
			this.log(`[pstack] no-op: re-entry while run ${this.activeRunId} active`);
			const active = this.runs.get(this.activeRunId);
			return { status: active?.status ?? "running", handle: active?.handle ?? null };
		}
		return this.start(runId);
	}

	/** (b) Liveness on demand (the timer calls this): predicate alone picks running/degraded. */
	checkLiveness(runId: string): HostStatus {
		const run = this.runs.get(runId);
		if (!run?.handle) return run?.status ?? "skipped";
		if (this.isLive(run.handle)) {
			run.status = EVENT_STATUS.healthy;
			run.reason = undefined;
		} else {
			run.status = EVENT_STATUS.stale;
			run.reason = run.handle.alive ? "stale output" : "session not alive";
		}
		this.emit(run);
		return run.status;
	}

	/** (d) Resume: recorded §4 outcome first, then actual liveness. Exactly one instance after. */
	reconcile(runId: string, recordedOutcome: HostStatus | null): ReconcileResult {
		const run = this.runs.get(runId);
		// Recorded terminal/bypass outcomes are honored without starting anything.
		if (
			recordedOutcome === "completed" ||
			recordedOutcome === "stopped" ||
			recordedOutcome === "skipped" ||
			recordedOutcome === "degraded" ||
			recordedOutcome === "blocked"
		) {
			if (run) {
				run.status = recordedOutcome;
				this.emit(run);
			}
			return { status: recordedOutcome, handle: run?.handle ?? null, action: "honored-recorded" };
		}
		// Recorded running (or nothing recorded): probe actual liveness.
		if (run?.handle && this.isLive(run.handle)) {
			run.status = EVENT_STATUS.healthy;
			this.emit(run);
			return { status: run.status, handle: run.handle, action: "noop" };
		}
		// Dead/stale/absent: bounded restart as a fresh startup sequence.
		const restarts = run?.restarts ?? 0;
		const attempts = run?.attempts ?? 0;
		if (restarts >= MAX_RESTARTS || attempts >= MAX_START_ATTEMPTS) {
			const bounded: RunState = {
				runId,
				handle: run?.handle ?? null,
				status: "degraded",
				reason: "restart bound reached",
				attempts,
				restarts,
			};
			this.runs.set(runId, bounded);
			this.emit(bounded);
			return {
				status: bounded.status,
				handle: bounded.handle,
				action: "noop",
				reason: bounded.reason,
			};
		}
		try {
			const handle = this.spawn(runId);
			const restarted: RunState = {
				runId,
				handle,
				status: EVENT_STATUS.restarted,
				attempts: attempts + 1,
				restarts: restarts + 1,
			};
			this.runs.set(runId, restarted);
			this.activeRunId = runId;
			this.emit(restarted);
			return {
				status: restarted.status,
				handle,
				action: run?.handle ? "restarted" : "started",
			};
		} catch (error) {
			const failed: RunState = {
				runId,
				handle: null,
				status: "degraded",
				reason: redactSecrets(String(error)),
				attempts: attempts + 1,
				restarts,
			};
			this.runs.set(runId, failed);
			this.emit(failed);
			return { status: failed.status, handle: null, action: "noop", reason: failed.reason };
		}
	}

	/** (c) Stop at closeout: blocking, fixed timeout; refusal ⇒ orphaned + reap, never silent. */
	stop(runId: string): StartResult {
		const run = this.runs.get(runId);
		if (!run?.handle) {
			return { status: "stopped", handle: null, reason: "no live instance" };
		}
		const handle = run.handle;
		const before = this.now();
		let stopped = false;
		let reason: string | undefined;
		try {
			stopped = (this.deps.stopper ?? (() => true))(handle);
			if (!stopped) reason = "stop refused";
		} catch (error) {
			reason = redactSecrets(String(error));
		}
		if (reason === undefined && this.now() - before > this.stopTimeout) {
			reason = "stop timed out";
		}
		if (reason !== undefined) {
			run.status = EVENT_STATUS["stop-failed"];
			run.reason = `${reason} → reap`;
			this.deps.reap?.(handle, reason);
			this.emit(run);
			return { status: run.status, handle, reason: run.reason };
		}
		handle.alive = false;
		run.status = EVENT_STATUS.stopped;
		run.reason = undefined;
		if (this.activeRunId === runId) this.activeRunId = null;
		this.emit(run);
		return { status: run.status, handle };
	}
}
