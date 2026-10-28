// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The USSR Stack connection contract: how Ultrathink reports its link to each sibling it depends on.
 *
 * Every probe is independent, never throws, never prints a credential value, carries a hard timeout and fails
 * open: a probe that cannot answer reports `unavailable` or `misconfigured` with a reason. Probes run only
 * free, read-only checks unless `StackProbeContext.live` is set (Decisions spends tokens, so it needs `live`).
 */

import type { UltrathinkConfig } from "../config.ts";
import type { HostId } from "../host/types.ts";

/** The five links `ultrathink stack` reports, in display order. */
export const STACK_MEMBERS = ["substrate", "swarm", "realm", "decisions", "hindsight"] as const;
export type StackMember = (typeof STACK_MEMBERS)[number];

/**
 * - `connected`: the link answers and does what it is for.
 * - `degraded`: the link works with a known limit (a stale brief, a breaker open, advisory containment).
 * - `unavailable`: configured, but nothing answers or the answer is refused.
 * - `misconfigured`: a setting is missing, invalid or contradicts another; the reason names it.
 * - `disabled`: switched off or never opted in; nothing is contacted.
 */
export const CONNECTION_STATUSES = [
	"connected",
	"degraded",
	"unavailable",
	"misconfigured",
	"disabled",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface StackConnection {
	member: StackMember;
	status: ConnectionStatus;
	/** One line, secret-free, names the cause. Never contains a credential value. */
	reason: string;
	/** A command or variable name the user can act on; absent when nothing is needed. */
	fix?: string;
	/** Capabilities that do not work in this state, for example `["brief"]`. */
	affects?: readonly string[];
	latencyMs?: number;
	via?: "http" | "socket" | "cli" | "config" | "none";
}

export interface StackProbeContext {
	env: Record<string, string | undefined>;
	config: UltrathinkConfig;
	cwd: string;
	stateDir: string;
	host: HostId;
	/** Network probes that cost money or change state run only when true. Free, read-only probes always run. */
	live: boolean;
	/** Hard upper bound for one probe, in milliseconds. */
	timeoutMs: number;
	fetch?: typeof fetch;
	now?: () => number;
}

/** A probe never rejects; an internal failure is reported as `unavailable`. */
export type StackProbe = (ctx: StackProbeContext) => Promise<StackConnection>;
