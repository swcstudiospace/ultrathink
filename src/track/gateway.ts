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
import { abortableSleep } from "../resilience/sleep.ts";
import type { TimerPort } from "../shared.ts";
import { createTracking, platformTimers, stepKey, type ToolCaller } from "./create.ts";
import type { TrackPlan, TrackingRefs } from "./types.ts";
import { notionPageId } from "../mcp/notion-db.ts";

/** A Notion data source id: a UUID, dashed or not. Any other value never reaches a Notion query. */
const NOTION_DATA_SOURCE_ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

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
	const timers = deps.timers ?? platformTimers;
	const log = deps.log ?? (() => undefined);
	const dataSource = config.notion.dataSourceUrl.trim().replace(/^collection:\/\//, "");
	// The id is interpolated into the Notion query, so a value that is not a UUID is refused here, before any Notion call.
	const notionDataSource = NOTION_DATA_SOURCE_ID.test(dataSource) ? dataSource : "";
	if (dataSource !== "" && notionDataSource === "")
		log("tracker: notion.dataSourceUrl is not a Notion data source id; Notion tracking is off");
	if (!linearTeam && !notionDataSource) return undefined;
	return async ({ plan, graph, existing, degradedNodes, signal, progress, onRef }) => {
		if (signal?.aborted) return undefined;
		const clientDeps = { storePath: deps.storePath ?? defaultStorePath(), fetch: deps.fetch };
		const clients: McpClient[] = [];
		// Credential resolution can wait on the store lock and a token refresh; bound it by the
		// budget (none when `track.budgetMs` is 0) and the caller's signal so a set budget is never exceeded.
		const stop = Promise.withResolvers<"stop">();
		// Ending the wait also ends every credential step still in flight: no lock polls, no token refresh afterwards.
		const lookups = new AbortController();
		const budgetMs = config.track.budgetMs;
		const onAbort = () => {
			stop.resolve("stop");
			lookups.abort();
		};
		const timer = budgetMs > 0 ? timers.setTimeout(onAbort, budgetMs) : undefined;
		// Both abort listeners are named so the finally removes them: a long-lived signal must not collect one per call.
		const closeClients = () => {
			for (const client of clients) client.close();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		signal?.addEventListener("abort", closeClients, { once: true });
		const startedAt = Date.now();
		// Only the credential lookups get these seams: their token requests and lock waits end with the wait above.
		const authDeps = {
			storePath: clientDeps.storePath,
			fetch: ((input: string | URL | Request, init?: RequestInit) =>
				(deps.fetch ?? fetch)(input, {
					...init,
					signal: init?.signal ? AbortSignal.any([init.signal, lookups.signal]) : lookups.signal,
				})) as typeof fetch,
			sleep: (ms: number) => abortableSleep(ms, lookups.signal),
		};
		const lookup = (provider: "linear" | "notion"): Promise<Lookup> =>
			resolveAuthHeader(provider, authDeps).then(
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

// ---------------------------------------------------------------------------------------------------------------------
// Sub-issue closeout
//
// The one code path that closes a finished Sub Issue after its work is done. It exists so an agent (or a
// future hook) never has to guess the order or the gates: the Linear sub-issue moves to Done first, and only
// then is the Notion step row set to Done. Both gates run before any tracker call, and the parent (node)
// issue is never addressed: only `linear.steps[key]` / `notion.steps[key]` are touched. Row creation is
// untouched: this helper never creates a row, it refuses a step whose row is missing.

/** What `closeSubIssue` needs to know about one finished Sub Issue. */
export interface CloseSubIssueInput {
	/** The refs `createTracking` recorded: `linear.steps` / `notion.steps` hold the step rows. */
	readonly refs: Pick<TrackingRefs, "linear" | "notion">;
	readonly nodeId: string;
	readonly step: number;
	/**
	 * Whether the step's PRD is already present on both configured trackers. Callers derive this from the
	 * PRD sync outcome for the step key (the `SyncReport` key with state `synced`, e.g. `PrdOutcome.sync`
	 * in src/think/tot/stage.ts): a step whose PRD never reached its rows must not be closed, or the
	 * tracker would show Done for work no one can read back.
	 */
	readonly prdPresent: boolean;
	/** ISO timestamp for the Notion `Completed` property; defaults to now. */
	readonly completedAt?: string;
	readonly signal?: AbortSignal;
}

/** Tracker callers and the vendor spellings, for the closeout. The defaults follow the repo's existing
 *  MCP call patterns (`save_issue` like src/track/create.ts and src/track/prd-sync.ts, `notion-update-page`
 *  like the `notion-*` family in src/mcp/notion-db.ts); override only when a hosted server renames a field. */
export interface CloseSubIssueDeps {
	readonly linear?: ToolCaller;
	readonly notion?: ToolCaller;
	/** Linear workflow-state value that marks an issue done (default `"Done"`). */
	readonly linearDoneState?: string;
	/** Field the Linear `save_issue` call sets to move the state (default `"state"`; e.g. `"stateId"`). */
	readonly linearStateField?: string;
	/** Linear tool name (default `"save_issue"`). */
	readonly linearTool?: string;
	/** Notion tool name (default `"notion-update-page"`). */
	readonly notionTool?: string;
	/** Field carrying the page id on the Notion update (default `"page_id"`). */
	readonly notionPageIdField?: string;
	readonly now?: () => string;
}

/** The ordered, gated plan for one closeout, or the reasons it is blocked. Pure: no tracker call. */
export type SubIssueCloseoutPlan =
	| {
			blocked: false;
			key: string;
			linearIdentifier: string;
			notionPageId: string;
			notionUrl: string;
	  }
	| { blocked: true; key: string; reasons: string[] };

/**
 * Whether `input` may close its Sub Issue: the PRD is present, both step rows exist (a missing or blocked
 * tracker row never marks the sub-issue done), and both callers are configured. Returns every blocking
 * reason, never a bare boolean, so the caller can report why nothing was closed.
 */
export function planSubIssueCloseout(
	input: CloseSubIssueInput,
	deps: CloseSubIssueDeps = {},
): SubIssueCloseoutPlan {
	const key = stepKey(input.nodeId, input.step);
	const reasons: string[] = [];
	if (!input.prdPresent) reasons.push(`PRD for ${key} is not present on its tracker rows`);
	const linearRef = input.refs.linear.steps[key];
	if (!linearRef?.identifier) reasons.push(`no Linear sub-issue row recorded for ${key}`);
	const notionUrl = input.refs.notion.steps[key];
	const pageId = notionUrl ? notionPageId(notionUrl) : undefined;
	if (!notionUrl || pageId === undefined) reasons.push(`no Notion step row recorded for ${key}`);
	if (deps.linear === undefined) reasons.push("Linear is not configured");
	if (deps.notion === undefined) reasons.push("Notion is not configured");
	if (reasons.length > 0) return { blocked: true, key, reasons };
	const ref = linearRef as NonNullable<typeof linearRef>;
	return {
		blocked: false,
		key,
		linearIdentifier: ref.identifier,
		notionPageId: pageId as string,
		notionUrl: notionUrl as string,
	};
}

/** The closeout result: which step was closed, in which order the two writes happened. */
export interface CloseSubIssueResult {
	readonly key: string;
	readonly linearIdentifier: string;
	readonly notionUrl: string;
	/** Always `["linear", "notion"]`: the Linear write resolved before the Notion write was issued. */
	readonly closedInOrder: readonly ["linear", "notion"];
}

function closeoutError(key: string, message: string): Error {
	return new Error(`closeSubIssue ${key}: ${message}`);
}

/**
 * Closes one finished Sub Issue: moves its Linear sub-issue to Done, then sets its Notion step row to
 * `Status`/`Linear State` `"Done"` with `Completed` set. Throws (starting with `closeSubIssue <key>:`) when
 * the PRD is absent, a step row is missing, a tracker is not configured, or a write fails; a refused or
 * failed closeout makes no tracker call beyond the one that failed, in particular a failed Linear write
 * leaves the Notion row untouched. The parent (node) issue is never addressed.
 */
export async function closeSubIssue(
	input: CloseSubIssueInput,
	deps: CloseSubIssueDeps,
): Promise<CloseSubIssueResult> {
	const plan = planSubIssueCloseout(input, deps);
	if (plan.blocked) throw closeoutError(plan.key, plan.reasons.join("; "));
	const linear = deps.linear as ToolCaller;
	const notion = deps.notion as ToolCaller;
	// Step 1: the Linear sub-issue itself is marked Done. Only a resolved write earns the Notion update.
	try {
		await linear.call(
			deps.linearTool ?? "save_issue",
			{
				id: plan.linearIdentifier,
				[deps.linearStateField ?? "state"]: deps.linearDoneState ?? "Done",
			},
			input.signal,
		);
	} catch (error) {
		throw closeoutError(
			plan.key,
			`linear ${plan.linearIdentifier} not marked done: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	// Step 2: the issue is marked done, so the Notion step row may now say Done too.
	const completedAt = input.completedAt ?? deps.now?.() ?? new Date().toISOString();
	try {
		await notion.call(
			deps.notionTool ?? "notion-update-page",
			{
				[deps.notionPageIdField ?? "page_id"]: plan.notionPageId,
				properties: {
					Status: "Done",
					"Linear State": "Done",
					Completed: completedAt,
				},
			},
			input.signal,
		);
	} catch (error) {
		throw closeoutError(
			plan.key,
			`notion step row not marked done (linear ${plan.linearIdentifier} is already Done): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		key: plan.key,
		linearIdentifier: plan.linearIdentifier,
		notionUrl: plan.notionUrl,
		closedInOrder: ["linear", "notion"],
	};
}
