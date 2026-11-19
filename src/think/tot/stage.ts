// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The Tree-of-Thought pipeline stage: after Graph of Thought and the CoT Sub Issues exist and the tracker rows are made,
 * one PRD per Sub Issue is written (on the session's selected model, checkpointed), then synced into its row. The stage returns a
 * {@link PrdOutcome}: the manifest and the sync summary the CompletionGate reads, so the session only starts once every
 * PRD was generated and delivered (`failed == 0 && pending == 0`).
 *
 * The stage never throws for a model, tracker or disk failure: that is a partial outcome the gate turns into a
 * `partial_failure`. Only cancellation is rethrown. GoT and CoT never come through here.
 *
 * Nothing the model wrote reaches the XML as text. The PRDs live in the Sub Issue rows; the XML only carries counts and
 * the model id, escaped (`injectPrdXml`), next to the row links the ISSUES block already renders.
 */
import { resolve } from "node:path";
import type { ClaudeCompleter } from "../../claude/complete.ts";
import type { UltrathinkConfig } from "../../config.ts";
import { createMcpClientIfCredentialed } from "../../mcp/client.ts";
import { storePath as defaultStorePath } from "../../mcp/store.ts";
import { redactSecrets } from "../../redact.ts";
import type { RetryPolicy, RetrySeams } from "../../resilience/retry.ts";
import { isAbortError } from "../../shared.ts";
import { type ToolCaller, stepKey } from "../../track/create.ts";
import { syncPrds } from "../../track/prd-sync.ts";
import type { SyncDeps, SyncSummary } from "../../track/prd-types.ts";
import type { TrackingRefs, TrackPlan } from "../../track/types.ts";
import { escapeXml, escapeXmlText } from "../../uplift/xml.ts";
import { escapeText } from "./escape.ts";
import {
	generatePrd,
	type ModelChoice,
	type PrdRequest,
	renderFallbackPrd,
	runTot,
	type TotManifest,
	type TotProgress,
} from "./index.ts";
import type { PrdRecord } from "./types.ts";

/** The `error` of a stage asked to write PRDs with no selected model id: nothing is written. */
const PRD_NO_SELECTED_MODEL = "PRD_NO_SELECTED_MODEL";
/** The reason every run records: Tree-of-Thought always uses the session's selected model. */
const SELECTED_REASON = "the selected model: Tree-of-Thought uses the session model";

/** What the stage hands the CompletionGate: how many PRDs were written and how many reached their tracker rows. */
export interface PrdOutcome {
	readonly manifest: TotManifest;
	readonly sync: SyncSummary;
	/** The model the PRDs were written on: always the session's selected model. */
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
	/** Per-PRD retry of a failing completion call and its test seams. */
	readonly retry?: RetryPolicy;
	readonly retrySeams?: RetrySeams;
	/** Tracker sync tuning and test seams (concurrency, retry policy, clock, sleep). */
	readonly sync?: Pick<
		SyncDeps,
		"concurrency" | "linearInlineLimit" | "notionTools" | "now" | "random" | "retryPolicy" | "sleep"
	>;
}

/** The session's selected model: its id and, when the host knows it, its provider. */
interface SelectedModel {
	readonly modelId: string;
	readonly provider?: string;
}

interface TotStageInput {
	readonly plan: TrackPlan;
	/** The tracker rows the PRDs are attached to. */
	readonly tracking: TrackingRefs;
	readonly config: UltrathinkConfig;
	/** The host's one bound completer. */
	readonly complete: ClaudeCompleter;
	readonly selected: SelectedModel;
	readonly seams: TotSeams;
	/** The host state dir: PRD checkpoints and the tracker ledger live under it, keyed by graph id. */
	readonly stateDir: string;
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

/** A file-name-safe segment: the graph id is content-addressed but a state dir name never trusts it. A dot-only name would be a parent directory, so it is the fallback too. */
function segment(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
	return safe === "" || /^\.+$/.test(safe) ? "graph" : safe;
}

function causeOf(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return redactSecrets(raw).replace(/\s+/g, " ").trim().slice(0, 200) || "error";
}

/** The tracker sync summary of a stage that wrote `manifest` (none when it failed before writing). Written PRDs that never reached a tracker row are owed, not lost: the checkpoints keep them for the next run. */
function summaryOf(manifest: TotManifest | undefined, total: number): SyncSummary {
	return {
		total,
		synced: 0,
		pending: manifest?.generated ?? 0,
		failed: manifest?.failed ?? total,
	};
}

/**
 * Writes and syncs the PRDs of one plan. A provider abort is rethrown; every other failure, an aborted `signal` included
 * (PRDs not started are `skipped`, rows not reached stay `pending`), is part of the returned outcome, so a caller that
 * gates on it never sees a half-written result as complete.
 *
 * A refusal writes 0 PRDs and reports its code as `error`: `PRD_NO_SELECTED_MODEL` for an empty selected model id.
 */
export async function runTotStage(input: TotStageInput): Promise<PrdOutcome> {
	const { plan, tracking, config, seams, signal, log } = input;
	const requests = totRequests(plan);
	const total = requests.length;
	const model: ModelChoice = {
		modelId: input.selected.modelId,
		provider: input.selected.provider ?? "unknown",
		source: "selected",
		reason: SELECTED_REASON,
	};
	const failedOutcome = (error: string, manifest?: TotManifest): PrdOutcome => ({
		manifest: manifest ?? { total, generated: 0, failed: total, fallbacks: 0, records: [] },
		sync: summaryOf(manifest, total),
		model,
		error,
	});
	if (input.selected.modelId.trim() === "") {
		log(`tot refused: ${PRD_NO_SELECTED_MODEL}`);
		return failedOutcome(PRD_NO_SELECTED_MODEL);
	}
	let callers: PrdCallers | undefined;
	let written: TotManifest | undefined;
	try {
		const limits = {
			maxLines: config.think.tot.maxPrdLines,
			maxChars: config.think.tot.maxPrdChars,
		};
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
			generate: (request, callSignal) =>
				generatePrd(request, {
					modelId: model.modelId,
					limits,
					...(callSignal ? { signal: callSignal } : {}),
					...(tracking.linear.steps[request.key]?.url
						? { linkUrl: tracking.linear.steps[request.key]?.url }
						: {}),
					fallback: (source) => {
						const url = tracking.linear.steps[source.key]?.url;
						return renderFallbackPrd(source, url ? { linkUrl: url } : {});
					},
					complete: (call) => input.complete(call.system, call.user, call.signal),
				}),
		});
		written = manifest;
		callers = await seams.open();
		if (callers === undefined || (callers.linear === undefined && callers.notion === undefined)) {
			log("tot: no tracker reachable, PRDs stay pending");
			return {
				manifest,
				sync: summaryOf(manifest, total),
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

const ISSUES_OPEN = "<ISSUES ";
const ISSUES_CLOSE = "</ISSUES>";
const ISSUE_CLOSE = "</ISSUE>";
const SUBISSUE_CLOSE = "</SUBISSUE>";

/** The `<PRD>` element of one generated record: key and model as escaped attributes, the markdown as escaped element text. */
function prdElement(record: PrdRecord): string {
	return `<PRD key="${escapeXml(record.key)}" model="${escapeXml(record.model)}">${escapeXmlText(record.markdown)}</PRD>`;
}

/**
 * The block with the record's PRD placed just before the `</SUBISSUE>` of its step. The key is `<nodeId>.<step>`, split at
 * its last dot; the step is searched inside the ISSUE of its node only. Undefined when the block has no such Sub Issue.
 */
function placePrd(block: string, record: PrdRecord): string | undefined {
	const dot = record.key.lastIndexOf(".");
	if (dot < 0) return undefined;
	const issueAt = block.indexOf(`<ISSUE node="${escapeXml(record.key.slice(0, dot))}"`);
	if (issueAt < 0) return undefined;
	const issueEnd = block.indexOf(ISSUE_CLOSE, issueAt);
	const subAt = block.indexOf(`<SUBISSUE step="${escapeXml(record.key.slice(dot + 1))}"`, issueAt);
	if (issueEnd < 0 || subAt < 0 || subAt > issueEnd) return undefined;
	const subEnd = block.indexOf(SUBISSUE_CLOSE, subAt);
	if (subEnd < 0 || subEnd > issueEnd) return undefined;
	return `${block.slice(0, subEnd)}${prdElement(record)}${block.slice(subEnd)}`;
}

/**
 * Writes the PRDs of `outcome` into the ISSUES block of `xml`. Each generated PRD becomes a `<PRD key model>` child of the
 * `<SUBISSUE>` of its step, after the Sub Issue text and beside its links. One `<PRDS .../>` element with the counts and the
 * model id closes the block. Every value is escaped. An XML with no ISSUES block is returned as is.
 *
 * Returns `xml`, the injected XML, and `unplaced`: the keys (`<nodeId>.<step>`, in record order) of the generated PRDs that
 * matched no Sub Issue element, so they were written nowhere. A non-empty `unplaced` means the plan is missing PRDs: the
 * caller holds it. Failed records are skipped.
 */
export function injectPrdXml(
	xml: string,
	outcome: PrdOutcome,
): { readonly xml: string; readonly unplaced: readonly string[] } {
	const generated = outcome.manifest.records.filter((record) => record.status === "generated");
	const at = xml.lastIndexOf(ISSUES_CLOSE);
	const open = at < 0 ? -1 : xml.lastIndexOf(ISSUES_OPEN, at);
	if (open < 0)
		return { xml, unplaced: generated.map((record) => record.key.replace(/\s+/g, " ")) };
	let block = xml.slice(open, at);
	const unplaced: string[] = [];
	for (const record of generated) {
		const placed = placePrd(block, record);
		if (placed === undefined) unplaced.push(record.key.replace(/\s+/g, " "));
		else block = placed;
	}
	const { manifest, sync } = outcome;
	const counts: [string, string | number][] = [
		["total", manifest.total],
		["generated", manifest.generated],
		["failed", manifest.failed],
		["fallbacks", manifest.fallbacks],
		["synced", sync.synced],
		["pending", sync.pending],
		["model", outcome.model.modelId],
	];
	const attrs = counts.map(([name, value]) => `${name}="${escapeText(String(value))}"`).join(" ");
	return {
		xml: `${xml.slice(0, open)}${block.replace(/[ \t]*$/, "")}  <PRDS ${attrs}/>\n${xml.slice(at)}`,
		unplaced,
	};
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
