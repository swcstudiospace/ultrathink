// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Tree-of-Thought pipeline stage: after Graph of Thought and the CoT Sub Issues exist and the tracker rows are made,
 * one PRD per Sub Issue is written (cheapest allowed model, checkpointed), then synced into its row. The stage returns a
 * {@link PrdOutcome}: the manifest and the sync summary the CompletionGate reads, so the session only starts once every
 * PRD was generated and delivered (`failed == 0 && pending == 0`).
 *
 * The stage never throws for a model, tracker or disk failure: that is a partial outcome the gate turns into a
 * `partial_failure`. Only cancellation is rethrown. GoT and CoT never come through here: this is the one place the
 * cheap-model path is opened (`assertCheapPathAllowed("tot")`).
 *
 * Nothing the model wrote reaches the XML as text. The PRDs live in the Sub Issue rows; the XML only carries counts and
 * the model id, escaped (`injectPrdXml`), next to the row links the ISSUES block already renders.
 */
import { resolve } from "node:path";
import type { ClaudeCompleter } from "../../claude/complete.ts";
import type { UltrathinkConfig } from "../../config.ts";
import type { HostId } from "../../host/types.ts";
import { createMcpClientIfCredentialed } from "../../mcp/client.ts";
import { storePath as defaultStorePath } from "../../mcp/store.ts";
import { redactSecrets } from "../../redact.ts";
import type { RetryPolicy, RetrySeams } from "../../resilience/retry.ts";
import {
	assertCheapPathAllowed,
	createToTRouter,
	type HostModelInfo,
	PRD_NO_SELECTED_MODEL,
	resolveToTModel,
	type SelectedModel,
	type SmokeCache,
	TotRefusal,
} from "../../route/cheapest-model.ts";
import { isAbortError } from "../../shared.ts";
import { type ToolCaller, stepKey } from "../../track/create.ts";
import { syncPrds } from "../../track/prd-sync.ts";
import type { SyncDeps, SyncSummary } from "../../track/prd-types.ts";
import type { TrackingRefs, TrackPlan } from "../../track/types.ts";
import { escapeText } from "./escape.ts";
import {
	type CompleteFn,
	generatePrd,
	getProjectFacts,
	type ModelChoice,
	type PrdRequest,
	type ProjectFacts,
	renderFallbackPrd,
	runTot,
	type TotManifest,
	type TotProgress,
} from "./index.ts";

/** What the stage hands the CompletionGate: how many PRDs were written and how many reached their tracker rows. */
export interface PrdOutcome {
	readonly manifest: TotManifest;
	readonly sync: SyncSummary;
	/** The model the PRDs were written on, with the reason the router chose it. */
	readonly model: ModelChoice;
	/** Why the stage could not run to the end (a secret-free single line); absent on a normal run. */
	readonly error?: string;
}

/** Tracker callers PRDs are written through. `close` is called once the stage is done with them. */
interface PrdCallers {
	readonly linear?: ToolCaller;
	readonly notion?: ToolCaller;
	readonly close?: () => void;
}

/** Host seams of the stage. Without them (`HookDeps.tot` absent) the stage does not run. */
export interface TotSeams {
	/** Opens the tracker callers; `undefined` means no tracker is reachable (the PRDs then stay pending). */
	readonly open: () => Promise<PrdCallers | undefined> | PrdCallers | undefined;
	/**
	 * A completer that takes a model per call. Absent: the stage drives the host's one bound completer and the router
	 * keeps the selected model (the decision is logged as a warning).
	 */
	readonly complete?: CompleteFn;
	/** Whether `complete` accepts another model than the selected one. Default: the host table in `route-defaults.ts`. */
	readonly canPickModelPerCall?: boolean;
	readonly listModels?: () => readonly HostModelInfo[] | Promise<readonly HostModelInfo[]>;
	readonly isAvailable?: (modelId: string, provider: string) => boolean | Promise<boolean>;
	readonly smokeCache?: SmokeCache;
	/** Per-PRD retry of a failing completion call and its test seams. */
	readonly retry?: RetryPolicy;
	readonly retrySeams?: RetrySeams;
	/** Tracker sync tuning and test seams (concurrency, retry policy, clock, sleep). */
	readonly sync?: Pick<
		SyncDeps,
		"concurrency" | "linearInlineLimit" | "notionTools" | "now" | "random" | "retryPolicy" | "sleep"
	>;
	/** Test seam: the project facts the PRDs are grounded in. Default: the bounded inspection of `cwd`. */
	readonly facts?: ProjectFacts;
}

interface TotStageInput {
	readonly plan: TrackPlan;
	/** The tracker rows the PRDs are attached to. */
	readonly tracking: TrackingRefs;
	readonly config: UltrathinkConfig;
	/** The host's one bound completer. */
	readonly complete: ClaudeCompleter;
	readonly selected: SelectedModel;
	readonly host?: HostId;
	readonly seams: TotSeams;
	/** The host state dir: PRD checkpoints and the tracker ledger live under it, keyed by graph id. */
	readonly stateDir: string;
	/** Root of the project the PRDs are grounded in. */
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly log: (line: string) => void;
	readonly onProgress?: (event: TotProgress) => void;
}

/** One PRD request per CoT Sub Issue of the plan; the key is the tracker's step key (`nodeId.step`). */
export function totRequests(plan: TrackPlan): PrdRequest[] {
	const titles = new Map(
		plan.linearSubIssues.map((sub) => [stepKey(sub.nodeId, sub.step), sub.title] as const),
	);
	return plan.subIssues.map((sub) => {
		const key = stepKey(sub.nodeId, sub.step);
		return {
			key,
			graphId: plan.graphId,
			nodeId: sub.nodeId,
			step: sub.step,
			title: titles.get(key) ?? sub.item,
			thought: sub.thought,
		};
	});
}

/** Whether the stage runs for a plan whose tracker rows exist: on unless `think.tot.enabled` is explicitly false. */
export function totEnabled(config: UltrathinkConfig): boolean {
	return config.think.tot.enabled !== false;
}

/** A file-name-safe segment: the graph id is content-addressed but a state dir name never trusts it. */
function segment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "graph";
}

function causeOf(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSecrets(raw).replace(/\s+/g, " ").trim().slice(0, 200) || "error";
}

const NO_FACTS = (root: string): ProjectFacts => ({
	root,
	files: new Set(),
	dirs: new Set(),
	symbols: new Map(),
	truncated: false,
	denied: 0,
});

/**
 * Writes and syncs the PRDs of one plan. A provider abort is rethrown; every other failure, an aborted `signal` included
 * (PRDs not started are `skipped`, rows not reached stay `pending`), is part of the returned outcome, so a caller that
 * gates on it never sees a half-written result as complete.
 *
 * A refusal writes 0 PRDs and reports its code as `error`: `PRD_NO_SELECTED_MODEL` for an empty selected model id, and
 * `PRD_NO_PRICE` when the host lists callable models of the provider and none publishes an input price.
 */
export async function runTotStage(input: TotStageInput): Promise<PrdOutcome> {
	assertCheapPathAllowed("tot");
	const { plan, tracking, config, seams, signal, log } = input;
	const requests = totRequests(plan);
	const total = requests.length;
	let model: ModelChoice = {
		modelId: input.selected.modelId,
		provider: input.selected.provider ?? "unknown",
		source: "selected",
		reason: "stage did not start",
	};
	const failedOutcome = (error: string, manifest?: TotManifest): PrdOutcome => ({
		manifest: manifest ?? { total, generated: 0, failed: total, fallbacks: 0, records: [] },
		sync: {
			total,
			synced: 0,
			// Written PRDs that never reached a tracker row are owed, not lost: the checkpoints keep them for the next run.
			pending: manifest?.generated ?? 0,
			failed: manifest?.failed ?? total,
		},
		model,
		error,
	});
	let callers: PrdCallers | undefined;
	let written: TotManifest | undefined;
	try {
		if (input.selected.modelId.trim() === "") throw new TotRefusal(PRD_NO_SELECTED_MODEL);
		const bound: CompleteFn = (call) => input.complete(call.system, call.user, call.signal);
		const complete = seams.complete ?? bound;
		const choice = await resolveToTModel({
			config,
			selected: input.selected,
			...(input.host ? { host: input.host } : {}),
			// A bound completer cannot take another model: the router then keeps the selected one, with a warning.
			canPickModelPerCall: seams.complete ? seams.canPickModelPerCall : false,
			...(seams.listModels ? { listModels: seams.listModels } : {}),
			...(seams.isAvailable ? { isAvailable: seams.isAvailable } : {}),
			...(seams.complete ? { complete: seams.complete } : {}),
			...(seams.smokeCache ? { smokeCache: seams.smokeCache } : {}),
			...(signal ? { signal } : {}),
			log,
		});
		model = choice;
		const router = createToTRouter({
			choice,
			selectedModelId: input.selected.modelId,
			complete,
			breakerThreshold: config.models.tot.breakerThreshold,
			log,
		});
		const limits = {
			maxLines: config.think.tot.maxPrdLines,
			maxChars: config.think.tot.maxPrdChars,
		};
		const facts =
			seams.facts ?? (await getProjectFacts(input.cwd).catch(() => NO_FACTS(input.cwd)));
		const manifest = await runTot({
			requests,
			checkpointDir: resolve(input.stateDir, "tot", segment(plan.graphId)),
			concurrency: config.think.tot.concurrency,
			// The limits shape every PRD, the model does not: a rerun on another model keeps the PRDs already written.
			inputSalt: `${limits.maxLines}:${limits.maxChars}`,
			...(seams.retry ? { retry: seams.retry } : {}),
			...(seams.retrySeams ? { seams: seams.retrySeams } : {}),
			...(signal ? { signal } : {}),
			onProgress: (event) => {
				if (event.kind === "failed" || event.kind === "skipped") {
					log(
						`tot ${event.kind} ${event.key} ${event.done}/${event.total}${event.error ? `: ${event.error}` : ""}`,
					);
				}
				input.onProgress?.(event);
			},
			generate: async (request, callSignal) => {
				let answered: string | undefined;
				const generated = await generatePrd(request, {
					modelId: choice.modelId,
					facts,
					limits,
					...(callSignal ? { signal: callSignal } : {}),
					...(tracking.linear.steps[request.key]?.url
						? { linkUrl: tracking.linear.steps[request.key]?.url }
						: {}),
					fallback: (source) => {
						const url = tracking.linear.steps[source.key]?.url;
						return renderFallbackPrd(source, url ? { linkUrl: url } : {});
					},
					complete: async (call) => {
						const reply = await router.complete(call);
						answered = reply.modelId;
						return reply.text;
					},
				});
				return answered !== undefined && !generated.fallback
					? { ...generated, model: answered }
					: generated;
			},
		});
		written = manifest;
		callers = await seams.open();
		if (callers === undefined || (callers.linear === undefined && callers.notion === undefined)) {
			log("tot: no tracker reachable, PRDs stay pending");
			return {
				manifest,
				sync: { total, synced: 0, pending: manifest.generated, failed: manifest.failed },
				model,
				error: "no tracker is reachable to receive the PRDs",
			};
		}
		const report = await syncPrds(manifest.records, {
			graphId: plan.graphId,
			refs: { linear: { steps: tracking.linear.steps }, notion: { steps: tracking.notion.steps } },
			...(callers.linear ? { linear: callers.linear } : {}),
			...(callers.notion ? { notion: callers.notion } : {}),
			stateDir: input.stateDir,
			...(signal ? { signal } : {}),
			log,
			...seams.sync,
		});
		return { manifest, sync: report.summary, model };
	} catch (error) {
		if (isAbortError(error)) throw error;
		if (error instanceof TotRefusal) {
			log(`tot refused: ${error.code}`);
			return failedOutcome(error.code, written);
		}
		const cause = causeOf(error);
		log(`tot failed: ${cause}`);
		return failedOutcome(cause, written);
	} finally {
		try {
			callers?.close?.();
		} catch {
			// reason: closing a tracker client is cleanup; it must not turn a finished stage into a failure
		}
	}
}

const ISSUES_CLOSE = "</ISSUES>";

/**
 * Adds one `<PRDS .../>` element to the ISSUES block of `xml`: counts and the model id, every value escaped. The PRD text
 * itself never enters the XML (it sits in the tracker rows the ISSUES block links). An XML with no ISSUES block is returned as is.
 */
export function injectPrdXml(xml: string, outcome: PrdOutcome): string {
	const at = xml.lastIndexOf(ISSUES_CLOSE);
	if (at < 0) return xml;
	const { manifest, sync } = outcome;
	const attrs = [
		["total", manifest.total],
		["generated", manifest.generated],
		["failed", manifest.failed],
		["fallbacks", manifest.fallbacks],
		["synced", sync.synced],
		["pending", sync.pending],
		["model", outcome.model.modelId],
	]
		.map(([name, value]) => `${name}="${escapeText(String(value))}"`)
		.join(" ");
	return `${xml.slice(0, at).replace(/[ \t]*$/, "")}  <PRDS ${attrs}/>\n${xml.slice(at)}`;
}

/** The credentialed tracker callers for `config`, opened lazily and closed by the stage. A tracker with no credential is left out. */
export function createGatewayTot(
	config: UltrathinkConfig,
	deps: { storePath?: string; fetch?: typeof fetch } = {},
): TotSeams {
	return {
		open: () => {
			const clientDeps = { storePath: deps.storePath ?? defaultStorePath(), fetch: deps.fetch };
			const linear = config.linear.team.trim()
				? createMcpClientIfCredentialed("linear", clientDeps)
				: undefined;
			const notion = config.notion.dataSourceUrl.trim()
				? createMcpClientIfCredentialed("notion", clientDeps)
				: undefined;
			if (!linear && !notion) return undefined;
			return {
				...(linear ? { linear } : {}),
				...(notion ? { notion } : {}),
				close: () => {
					linear?.close();
					notion?.close();
				},
			};
		},
	};
}
