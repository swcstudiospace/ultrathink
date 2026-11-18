// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The stack report: runs the five member probes concurrently and returns one {@link StackConnection} per member in
 * `STACK_MEMBERS` order.
 *
 * Each probe runs under its own `ctx.timeoutMs` guard. A probe that throws, rejects or never settles is reported as
 * `unavailable` with a FIXED reason: the caught error is never read, because it may carry a URL or a credential. The
 * aggregator itself never throws and never contacts anything: every request a probe makes is the probe's own.
 */

import { probeDecisions } from "./decisions.ts";
import { probeHindsight } from "./hindsight.ts";
import { probeRealm } from "./realm.ts";
import { probeSubstrate } from "./substrate.ts";
import { probeSwarm } from "./swarm.ts";
import {
	CONNECTION_STATUSES,
	STACK_MEMBERS,
	type StackConnection,
	type StackMember,
	type StackProbe,
	type StackProbeContext,
	unavailableOutcome,
} from "./types.ts";

export interface StackReport {
	/** One entry per wanted member, in `STACK_MEMBERS` order. */
	members: StackConnection[];
	/** ISO-8601 time the report was assembled, from `ctx.now`. */
	generatedAt: string;
}

const DEFAULT_PROBES: Readonly<Record<StackMember, StackProbe>> = {
	substrate: probeSubstrate,
	swarm: probeSwarm,
	realm: probeRealm,
	decisions: probeDecisions,
	hindsight: probeHindsight,
};

const TIMED_OUT = Symbol("probe-timed-out");

/**
 * The seam each member's probe names when it cannot answer: the `affects` and `via` its own `unavailableOutcome` uses.
 * A probe that times out, returns a malformed outcome or throws never reaches its own outcome, so the aggregator names
 * this seam instead. Mirrors the `AFFECTS` constants and unavailable `via` of each probe module; keep them in step.
 */
const UNAVAILABLE_SEAM: Readonly<
	Record<StackMember, { affects: readonly string[]; via: NonNullable<StackConnection["via"]> }>
> = {
	substrate: { affects: ["brief"], via: "http" },
	swarm: { affects: ["preflight", "lanes"], via: "cli" },
	realm: { affects: ["containment"], via: "socket" },
	decisions: {
		affects: ["plan gate", "ship gate", "knowledge, blocking and teachable decisions"],
		via: "http",
	},
	hindsight: { affects: ["lesson retain", "lesson recall"], via: "http" },
};

async function runProbe(
	member: StackMember,
	probe: StackProbe,
	ctx: StackProbeContext,
): Promise<StackConnection> {
	const now = ctx.now ?? Date.now;
	const startedAt = now();
	const elapsed = (): number => {
		const delta = now() - startedAt;
		return Number.isFinite(delta) ? Math.max(0, delta) : 0;
	};
	const unavailable = (reason: string): StackConnection => ({
		member,
		...unavailableOutcome({ reason, ...UNAVAILABLE_SEAM[member] }),
		latencyMs: elapsed(),
	});
	const guard = Promise.withResolvers<typeof TIMED_OUT>();
	const timer = setTimeout(() => guard.resolve(TIMED_OUT), ctx.timeoutMs);
	try {
		const settled = await Promise.race([probe(ctx), guard.promise]);
		if (settled === TIMED_OUT) {
			return unavailable(`probe timed out after ${ctx.timeoutMs} ms`);
		}
		if (
			typeof settled !== "object" ||
			settled === null ||
			!(CONNECTION_STATUSES as readonly string[]).includes(settled.status)
		) {
			return unavailable("probe failed");
		}
		return { ...settled, member, latencyMs: elapsed() };
	} catch {
		// reason: the caught error may carry a secret or a URL; only the fixed reason is reported.
		return unavailable("probe failed");
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probes every wanted member at once. `opts.only` narrows the members (unknown names are dropped; the CLI rejects
 * them earlier); `opts.probes` replaces individual probes and exists for tests only.
 */
export async function probeStack(
	ctx: StackProbeContext,
	opts?: { only?: StackMember[]; probes?: Partial<Record<StackMember, StackProbe>> },
): Promise<StackReport> {
	const wanted = STACK_MEMBERS.filter((member) =>
		(opts?.only ?? [...STACK_MEMBERS]).includes(member),
	);
	const probes = { ...DEFAULT_PROBES, ...opts?.probes };
	const members = await Promise.all(wanted.map((member) => runProbe(member, probes[member], ctx)));
	return { members, generatedAt: new Date((ctx.now ?? Date.now)()).toISOString() };
}
