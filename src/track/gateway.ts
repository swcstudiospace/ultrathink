// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../redact.ts";
import type { UltrathinkConfig } from "../config.ts";
import { createMcpClient } from "../mcp/client.ts";
import type { McpClient } from "../mcp/client.ts";
import { resolveAuthHeader } from "../mcp/oauth.ts";
import { storePath as defaultStorePath } from "../mcp/store.ts";
import type { ProgressSink } from "../host/progress.ts";
import type { ThoughtGraph } from "../think/types.ts";
import { createTracking } from "./create.ts";
import type { TrackingRefs, TrackPlan } from "./types.ts";

/** Minimal timer port: the platform `setTimeout`/`clearTimeout` by default, or a test double. */
type TimerPort = {
	setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
	clearTimeout(handle: NodeJS.Timeout | undefined): void;
};

const platformTimers: TimerPort = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => clearTimeout(handle),
};

export type Tracker = (input: {
	plan: TrackPlan;
	graph?: ThoughtGraph;
	existing?: TrackingRefs;
	/** Node ids whose think fill is degraded: their tracker rows are created with a "[degraded fill]" marker. */
	degradedNodes?: readonly string[];
	signal?: AbortSignal;
	progress?: ProgressSink;
	/** Called with the live refs after each created row, so the caller can checkpoint them (see `CreateTrackingDeps.onRef`). */
	onRef?: (refs: TrackingRefs) => void;
}) => Promise<TrackingRefs | undefined>;

/** One provider's credential lookup: its auth header, or why there is none. `undefined` header with no error means not logged in. */
interface Lookup {
	header: string | undefined;
	error?: string;
}

/** A short, single-line, secret-free reason for a failed credential lookup. */
function lookupError(error: unknown): string {
	const text = redactSecrets(error instanceof Error ? error.message : String(error));
	return text.replace(/\s+/g, " ").trim().slice(0, 160) || "error";
}

/**
 * Undefined when neither `linear.team` nor `notion.dataSourceUrl` is configured; an unconfigured provider is never
 * contacted and never reported. For a configured one, a credential lookup that fails (corrupt store, lock, refresh) is
 * logged and reported on the refs as a credential error, apart from "login required" (no credential at all).
 */
export function createGatewayTracker(
	config: UltrathinkConfig,
	deps: {
		storePath?: string;
		fetch?: typeof fetch;
		timers?: TimerPort;
		log?: (message: string) => void;
	} = {},
): Tracker | undefined {
	const linearTeam = config.linear.team.trim();
	const notionDataSource = config.notion.dataSourceUrl.trim().replace(/^collection:\/\//, "");
	const timers = deps.timers ?? platformTimers;
	const log = deps.log ?? (() => undefined);
	if (!linearTeam && !notionDataSource) return undefined;
	return async ({ plan, graph, existing, degradedNodes, signal, progress, onRef }) => {
		if (signal?.aborted) return undefined;
		const clientDeps = { storePath: deps.storePath ?? defaultStorePath(), fetch: deps.fetch };
		const clients: McpClient[] = [];
		// Credential resolution can wait on the store lock and a token refresh; bound it by the
		// budget (none when `track.budgetMs` is 0) and the caller's signal so a set budget is never exceeded.
		const stop = Promise.withResolvers<"stop">();
		const budgetMs = config.track.budgetMs;
		const timer =
			budgetMs > 0 ? timers.setTimeout(() => stop.resolve("stop"), budgetMs) : undefined;
		const onAbort = () => stop.resolve("stop");
		// Both abort listeners are named so the finally removes them: a long-lived signal must not collect one per call.
		const closeClients = () => {
			for (const client of clients) client.close();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		signal?.addEventListener("abort", closeClients, { once: true });
		const startedAt = Date.now();
		const lookup = (provider: "linear" | "notion"): Promise<Lookup> =>
			resolveAuthHeader(provider, clientDeps).then(
				(header) => ({ header }),
				(error: unknown) => ({ header: undefined, error: lookupError(error) }),
			);
		try {
			const auth = await Promise.race([
				Promise.all([
					linearTeam ? lookup("linear") : undefined,
					notionDataSource ? lookup("notion") : undefined,
				]),
				stop.promise,
			]);
			if (auth === "stop" || signal?.aborted) return undefined;
			// 0 means no limit: createTracking receives 0 and creates no abort timer.
			const remainingMs = budgetMs > 0 ? budgetMs - (Date.now() - startedAt) : 0;
			if (budgetMs > 0 && remainingMs <= 0) return undefined;
			const [linearAuth, notionAuth] = auth;
			const credentialErrors: { linear?: string; notion?: string } = {};
			for (const [provider, found] of [
				["linear", linearAuth],
				["notion", notionAuth],
			] as const) {
				if (found?.error !== undefined) {
					credentialErrors[provider] = found.error;
					log(`tracker: ${provider} credential error: ${found.error}`);
				} else if (found && found.header === undefined) {
					log(`tracker: ${provider} login required`);
				}
			}
			if (linearAuth?.header === undefined && notionAuth?.header === undefined) return undefined;
			const linear =
				linearAuth?.header === undefined ? undefined : createMcpClient("linear", clientDeps);
			const notion =
				notionAuth?.header === undefined ? undefined : createMcpClient("notion", clientDeps);
			if (linear) clients.push(linear);
			if (notion) clients.push(notion);
			return await createTracking(plan, graph, existing, {
				linear,
				notion,
				...(linearTeam ? { linearTeam } : {}),
				...(notionDataSource ? { notionDataSource } : {}),
				...(degradedNodes ? { degradedNodes } : {}),
				...(credentialErrors.linear !== undefined || credentialErrors.notion !== undefined
					? { credentialErrors }
					: {}),
				concurrency: config.track.concurrency,
				budgetMs: remainingMs,
				progress,
				...(onRef ? { onRef } : {}),
			});
		} catch (error) {
			log(`tracker: setup failed: ${lookupError(error)}`);
			return undefined;
		} finally {
			timers.clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			signal?.removeEventListener("abort", closeClients);
			closeClients();
		}
	};
}

/**
 * One shell word for a command line printed into the agent's context: plain paths stay as they are, anything else
 * (spaces, quotes, `$`…) is POSIX single-quoted so the line can be run as-is.
 */
export function shellArg(value: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function trackCommand(
	repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
): string {
	return `${shellArg(resolve(repoRoot, "bin", "ultrathink-mcp"))} track complete`;
}
