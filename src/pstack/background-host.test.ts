// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	BackgroundHost,
	EVENT_STATUS,
	LIVENESS_INTERVAL_MS,
	LIVENESS_THRESHOLD_MS,
	MAX_START_ATTEMPTS,
	STOP_TIMEOUT_MS,
	makeRunId,
	type HostHandle,
	type HostStatus,
} from "./background-host.ts";
import type { SubagentFleet } from "./subagents.ts";

const OK_FLEET = { ok: true } as unknown as SubagentFleet;

function harness(
	overrides: {
		stopper?: (handle: HostHandle) => boolean;
		reap?: (handle: HostHandle, reason: string) => void;
		fleetResolver?: () => SubagentFleet;
		now?: () => number;
		thresholdMs?: number;
		stopTimeoutMs?: number;
	} = {},
) {
	const lines: string[] = [];
	let spawns = 0;
	let t = 1_000_000;
	const host = new BackgroundHost({
		intervalMs: 0,
		now: overrides.now ?? (() => t),
		sink: (line) => lines.push(line),
		fleetResolver: overrides.fleetResolver ?? (() => OK_FLEET),
		spawn: (runId) => {
			spawns++;
			return { runId, instanceId: spawns, startedAt: t, lastSeenAt: t, alive: true, output: "" };
		},
		stopper: overrides.stopper,
		reap: overrides.reap,
		thresholdMs: overrides.thresholdMs,
		stopTimeoutMs: overrides.stopTimeoutMs,
	});
	return {
		host,
		lines,
		spawns: () => spawns,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe("background host", () => {
	test("named constants: predicate, interval, threshold, stop timeout", () => {
		expect(LIVENESS_INTERVAL_MS).toBeGreaterThan(0);
		expect(LIVENESS_THRESHOLD_MS).toBeGreaterThan(0);
		expect(STOP_TIMEOUT_MS).toBeGreaterThan(0);
		expect(MAX_START_ATTEMPTS).toBe(2);
	});

	test("every lifecycle event maps to exactly one status", () => {
		const statuses = Object.values(EVENT_STATUS);
		expect(Object.keys(EVENT_STATUS)).toEqual([
			"started",
			"healthy",
			"stale",
			"restarted",
			"stopped",
			"stop-failed",
		]);
		for (const status of statuses) {
			expect(["running", "degraded", "stopped", "orphaned"]).toContain(status);
		}
		expect(EVENT_STATUS.started).toBe("running");
		expect(EVENT_STATUS.stale).toBe("degraded");
		expect(EVENT_STATUS["stop-failed"]).toBe("orphaned");
	});

	test("run id = milestone id + STATE session anchor", () => {
		expect(makeRunId("M-12", "sess-abc")).toBe("M-12::sess-abc");
	});

	// ★ start-twice same runId → 1 instance + 1 logged no-op (D-11/A-05)
	test("start twice with same runId: one instance, one logged no-op", () => {
		const { host, lines, spawns } = harness();
		const runId = makeRunId("M-1", "s1");
		const first = host.start(runId);
		const second = host.start(runId);
		expect(first.status).toBe("running");
		expect(second.handle).toBe(first.handle);
		expect(spawns()).toBe(1);
		expect(host.instanceCount(runId)).toBe(1);
		expect(lines.filter((l) => l.includes("no-op"))).toHaveLength(1);
	});

	// ★ resume-after-crash → recorded-vs-actual reconcile → exactly 1 instance (D-21/R-02)
	test("reconcile with live handle: no-op, exactly one instance", () => {
		const { host, spawns } = harness();
		const runId = makeRunId("M-2", "s2");
		host.start(runId);
		const again = host.reconcile(runId, "running");
		expect(again.action).toBe("noop");
		expect(again.status).toBe("running");
		expect(spawns()).toBe(1);
		expect(host.instanceCount(runId)).toBe(1);
	});

	test("reconcile with recorded terminal outcome: honored, no new instance", () => {
		const { host, spawns } = harness();
		const runId = makeRunId("M-3", "s3");
		const result = host.reconcile(runId, "completed");
		expect(result.action).toBe("honored-recorded");
		expect(result.status).toBe("completed");
		expect(spawns()).toBe(0);
	});

	test("resume on fresh host with recorded running: exactly one instance", () => {
		const { host, spawns } = harness();
		const runId = makeRunId("M-4", "s4");
		const result = host.reconcile(runId, "running");
		expect(result.action).toBe("started");
		expect(host.instanceCount(runId)).toBe(1);
		expect(spawns()).toBe(1);
	});

	// ★ kill-mid-run → exactly one outcome under the bounded-restart policy (D-10/A-04)
	test("kill mid-run: predicate degrades, reconcile restarts once — one outcome", () => {
		const { host } = harness();
		const runId = makeRunId("M-5", "s5");
		const { handle } = host.start(runId);
		handle!.alive = false;
		expect(host.checkLiveness(runId)).toBe("degraded");
		const reconciled = host.reconcile(runId, "running");
		expect(reconciled.action).toBe("restarted");
		expect(reconciled.status).toBe("running");
		expect(host.checkLiveness(runId)).toBe("running");
		expect(host.instanceCount(runId)).toBe(1);
	});

	// ★ stop-refusal/timeout → orphaned + reason + reap, never completed (D-09/R-05)
	test("stop refusal: orphaned with reason and reap action", () => {
		const reaped: string[] = [];
		const { host } = harness({
			stopper: () => false,
			reap: (_h, reason) => reaped.push(reason),
		});
		const runId = makeRunId("M-6", "s6");
		host.start(runId);
		const stopped = host.stop(runId);
		expect(stopped.status).toBe("orphaned");
		expect(stopped.status).not.toBe("completed");
		expect(stopped.reason).toContain("reap");
		expect(reaped).toHaveLength(1);
		expect(host.formatStatus(runId)).toContain("orphaned");
	});

	test("stop timeout: orphaned, never silent success", () => {
		const { host, advance } = harness({
			stopper: () => {
				advance(STOP_TIMEOUT_MS + 1);
				return true;
			},
		});
		const runId = makeRunId("M-7", "s7");
		host.start(runId);
		const stopped = host.stop(runId);
		expect(stopped.status).toBe("orphaned");
		expect(stopped.reason).toContain("timed out");
	});

	test("stop success: stopped", () => {
		const { host } = harness();
		const runId = makeRunId("M-8", "s8");
		host.start(runId);
		expect(host.stop(runId).status).toBe("stopped");
		expect(host.instanceCount(runId)).toBe(0);
	});

	// ★ re-entry during active marker → logged no-op, no restart (R-01)
	test("re-entry while active: logged no-op, still one instance", () => {
		const { host, lines, spawns } = harness();
		host.start(makeRunId("M-9", "s9"));
		const reentered = host.reenter(makeRunId("M-10", "s10"));
		expect(reentered.handle).not.toBeNull();
		expect(spawns()).toBe(1);
		expect(host.instanceCount()).toBe(1);
		expect(lines.filter((l) => l.includes("no-op"))).toHaveLength(1);
		// Starting a different run while active also no-ops.
		const other = host.start(makeRunId("M-11", "s11"));
		expect(other.handle!.runId).toBe(makeRunId("M-9", "s9"));
		expect(spawns()).toBe(1);
	});

	// ★ secret-shaped mock output → never captured (D-19/R-03)
	test("secret-shaped output is redacted at capture, never stored or logged", () => {
		const { host, lines } = harness();
		const runId = makeRunId("M-12", "s12");
		const { handle } = host.start(runId);
		const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
		const captured = host.captureOutput(handle!, `leaked ${secret} here`);
		expect(captured).not.toContain(secret);
		expect(handle!.output).not.toContain(secret);
		expect(captured).toContain("[redacted]");
		expect(lines.join("\n")).not.toContain(secret);
		expect(host.formatStatus(runId)).not.toContain(secret);
	});

	test("stale-but-alive output is not consumable; running/degraded by predicate only", () => {
		const { host, advance } = harness();
		const runId = makeRunId("M-13", "s13");
		const { handle } = host.start(runId);
		host.captureOutput(handle!, "fresh work");
		expect(host.consumeOutput(handle!)).toBe("fresh work");
		expect(host.checkLiveness(runId)).toBe("running");
		advance(LIVENESS_THRESHOLD_MS + 1);
		expect(host.checkLiveness(runId)).toBe("degraded");
		expect(host.consumeOutput(handle!)).toBeNull();
	});

	test("fleet unavailable: degraded, no instance spawned", () => {
		const { host, spawns } = harness({
			fleetResolver: () => ({ ok: false, reason: "no pstack skills resolved" }),
		});
		const result = host.start(makeRunId("M-14", "s14"));
		expect(result.status).toBe("degraded");
		expect(result.handle).toBeNull();
		expect(spawns()).toBe(0);
	});

	test("restart bound: second reconcile after bound degrades, no infinite retry", () => {
		const { host } = harness();
		const runId = makeRunId("M-15", "s15");
		host.start(runId);
		const first = host.reconcile(runId, "running");
		expect(first.action).toBe("noop");
		// Kill and restart once (bound: 1 restart).
		host.getHandle(runId)!.alive = false;
		host.reconcile(runId, "running");
		host.getHandle(runId)!.alive = false;
		const bounded = host.reconcile(runId, "running");
		expect(bounded.status).toBe("degraded");
		expect(bounded.reason).toContain("bound");
	});

	test("status vocabulary covers the full set", () => {
		const vocab: HostStatus[] = [
			"running",
			"completed",
			"skipped",
			"degraded",
			"blocked",
			"stopped",
			"orphaned",
		];
		expect(vocab).toHaveLength(7);
	});
});
