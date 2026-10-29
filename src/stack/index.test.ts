// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import { probeStack } from "./index.ts";
import {
	STACK_MEMBERS,
	type StackConnection,
	type StackMember,
	type StackProbe,
	type StackProbeContext,
} from "./types.ts";

const SECRET = "sk-or-v1-CANARYCANARYCANARY1234";

function context(over: Partial<StackProbeContext> = {}): StackProbeContext {
	return {
		env: {},
		config: defaultConfig(),
		cwd: "/tmp/ut-stack-index-cwd",
		stateDir: "/tmp/ut-stack-index-state",
		host: "claude-code",
		live: false,
		timeoutMs: 1000,
		...over,
	};
}

function fake(member: StackMember, status: StackConnection["status"]): StackProbe {
	return async () => ({
		member,
		status,
		reason: `${member} reason`,
		fix: `fix ${member}`,
		via: "config",
	});
}

describe("probeStack", () => {
	test("starts every probe before any settles and returns canonical order when they settle in reverse", async () => {
		const started: StackMember[] = [];
		const gates = new Map<StackMember, PromiseWithResolvers<void>>();
		const statuses: Record<StackMember, StackConnection["status"]> = {
			substrate: "connected",
			swarm: "degraded",
			realm: "disabled",
			decisions: "misconfigured",
			hindsight: "unavailable",
		};
		const gated =
			(member: StackMember): StackProbe =>
			async () => {
				started.push(member);
				const gate = Promise.withResolvers<void>();
				gates.set(member, gate);
				await gate.promise;
				return {
					member,
					status: statuses[member],
					reason: `${member} reason`,
					fix: `fix ${member}`,
					via: "config",
				};
			};
		const probes: Record<StackMember, StackProbe> = {
			substrate: gated("substrate"),
			swarm: gated("swarm"),
			realm: gated("realm"),
			decisions: gated("decisions"),
			hindsight: gated("hindsight"),
		};
		const pending = probeStack(context(), { probes });
		// Let every microtask run: a sequential aggregator would still be waiting on the first probe.
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		expect(started).toHaveLength(5);
		for (const member of [...STACK_MEMBERS].reverse()) gates.get(member)?.resolve();
		const report = await pending;

		expect(report.members.map((m) => m.member)).toEqual([...STACK_MEMBERS]);
		expect(report.members.map((m) => m.status)).toEqual([
			"connected",
			"degraded",
			"disabled",
			"misconfigured",
			"unavailable",
		]);
		for (const member of report.members) {
			expect(typeof member.latencyMs).toBe("number");
			expect(member.latencyMs).toBeGreaterThanOrEqual(0);
		}
		expect(report.members[1]?.fix).toBe("fix swarm");
		expect(report.members[1]?.via).toBe("config");
	});

	test("a throwing probe becomes unavailable with the fixed reason and never leaks the error", async () => {
		const probes: Partial<Record<StackMember, StackProbe>> = {
			substrate: fake("substrate", "connected"),
			swarm: fake("swarm", "connected"),
			realm: async () => {
				throw new Error(`boom ${SECRET} https://user:pw@example.invalid/x`);
			},
			decisions: fake("decisions", "connected"),
			hindsight: fake("hindsight", "connected"),
		};
		const report = await probeStack(context(), { probes });

		expect(report.members).toHaveLength(5);
		const realm = report.members[2];
		expect(realm?.member).toBe("realm");
		expect(realm?.status).toBe("unavailable");
		expect(realm?.reason).toBe("probe failed");
		expect(JSON.stringify(report)).not.toContain("CANARY");
		for (const index of [0, 1, 3, 4]) expect(report.members[index]?.status).toBe("connected");
	});

	test("a probe that throws synchronously is isolated the same way", async () => {
		const probes: Partial<Record<StackMember, StackProbe>> = {
			swarm: (() => {
				throw new Error(SECRET);
			}) as StackProbe,
			substrate: fake("substrate", "connected"),
			realm: fake("realm", "connected"),
			decisions: fake("decisions", "connected"),
			hindsight: fake("hindsight", "connected"),
		};
		const report = await probeStack(context(), { probes });
		expect(report.members[1]).toMatchObject({
			member: "swarm",
			status: "unavailable",
			reason: "probe failed",
		});
		expect(report.members[0]?.status).toBe("connected");
	});

	test("a probe that never settles is cut at timeoutMs and the others still report", async () => {
		const probes: Partial<Record<StackMember, StackProbe>> = {
			substrate: fake("substrate", "connected"),
			swarm: () => new Promise<StackConnection>(() => undefined),
			realm: fake("realm", "connected"),
			decisions: fake("decisions", "connected"),
			hindsight: fake("hindsight", "connected"),
		};
		// A real 50 ms timer: the guard under test is a real setTimeout and a hung probe cannot be faked otherwise.
		const report = await probeStack(context({ timeoutMs: 50 }), { probes });

		expect(report.members[1]).toMatchObject({
			member: "swarm",
			status: "unavailable",
			reason: "probe timed out after 50 ms",
		});
		expect(report.members[1]?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(report.members.filter((m) => m.status === "connected")).toHaveLength(4);
	});

	test("only narrows to exactly those members in canonical order and drops unknown names", async () => {
		const calls: StackMember[] = [];
		const track =
			(member: StackMember): StackProbe =>
			async () => {
				calls.push(member);
				return { member, status: "connected", reason: "ok" };
			};
		const probes: Record<StackMember, StackProbe> = {
			substrate: track("substrate"),
			swarm: track("swarm"),
			realm: track("realm"),
			decisions: track("decisions"),
			hindsight: track("hindsight"),
		};
		const report = await probeStack(context(), {
			only: ["realm", "substrate", "bogus" as StackMember],
			probes,
		});

		expect(report.members.map((m) => m.member)).toEqual(["substrate", "realm"]);
		// Unwanted probes are not even started.
		expect(calls.sort()).toEqual(["realm", "substrate"]);
	});

	test("generatedAt is the ISO time of the injected clock", async () => {
		const now = (): number => Date.UTC(2026, 9, 28, 12, 30, 15, 250);
		const probes: Partial<Record<StackMember, StackProbe>> = {
			substrate: fake("substrate", "connected"),
			swarm: fake("swarm", "connected"),
			realm: fake("realm", "connected"),
			decisions: fake("decisions", "connected"),
			hindsight: fake("hindsight", "connected"),
		};
		const report = await probeStack(context({ now }), { probes });
		expect(report.generatedAt).toBe(new Date(now()).toISOString());
		expect(report.generatedAt).toBe("2026-10-28T12:30:15.250Z");
	});

	test("a probe that reports the wrong member name is filed under its own slot", async () => {
		const probes: Partial<Record<StackMember, StackProbe>> = {
			substrate: fake("swarm", "connected"),
			swarm: fake("swarm", "connected"),
			realm: fake("realm", "connected"),
			decisions: fake("decisions", "connected"),
			hindsight: fake("hindsight", "connected"),
		};
		const report = await probeStack(context(), { probes });
		expect(report.members.map((m) => m.member)).toEqual([...STACK_MEMBERS]);
	});

	test("a probe that answers with a status outside the five known values is unavailable with the fixed reason", async () => {
		// reason: a deliberately invalid status, which the type system forbids, to pin the runtime guard.
		const unknownStatus = "ok" as unknown as StackConnection["status"];
		const probes: Partial<Record<StackMember, StackProbe>> = {
			substrate: fake("substrate", "connected"),
			swarm: fake("swarm", unknownStatus),
			realm: fake("realm", "connected"),
			decisions: fake("decisions", "connected"),
			hindsight: fake("hindsight", "connected"),
		};
		const report = await probeStack(context(), { probes });
		expect(report.members.map((m) => m.member)).toEqual([...STACK_MEMBERS]);
		const swarm = report.members.find((m) => m.member === "swarm");
		expect(swarm?.status).toBe("unavailable");
		expect(swarm?.reason).toBe("probe failed");
		expect(report.members.filter((m) => m.status === "connected")).toHaveLength(4);
	});
});
