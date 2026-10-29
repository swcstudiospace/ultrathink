// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { splitRationaleSteps } from "../../../../src/track/plan.ts";
import type { ThoughtNode } from "../../../../src/think/types.ts";
import { ROOT_TAGS } from "../../../../src/types.ts";
import { escapeXml, sanitizeUpliftXml } from "../../../../src/uplift/xml.ts";
import { readHistory } from "../history.ts";
import type { RunResult } from "../run.ts";
import { type DriveReport, type PromptOutcome, type PromptVerdict, scanState } from "./drive.ts";
import type { CallLog } from "./provider.ts";
import { INVARIANT_IDS, type InvariantId } from "./scenario.ts";

type HypothesisResult = RunResult["hypotheses"][number];

/** What a run may leave behind: the process figures and the state directories the driver should have removed. */
export interface ResourceSnapshot {
	rssBytes: number;
	/** JS heap in use, read after a forced full collection: what the code under test still holds. */
	heapUsedBytes: number;
	/** Active libuv-style resources (timers, sockets, child processes). */
	handles: number;
	children: number;
	files: number;
	bytes: number;
	/** Leftover `.lock` and `.tmp` files. */
	stale: number;
}

/** The knobs that shape how one prompt is judged; the same values reach the per-prompt judge and the run-level check. */
interface JudgeOptions {
	/** `think.fillRetries` of the run (default 2). */
	fillRetries?: number;
	minNodes?: number;
	maxNodes?: number;
	/** The prompts went to a live engine: its text carries no nonce, so the nonce-presence check is skipped. */
	real?: boolean;
	/** The per-prompt watchdog budget in ms, named in the finding for a prompt it aborted. */
	watchdogMs?: number;
	/** Any watchdog abort is accepted. Otherwise only a prompt an injected `hang` targeted may be aborted. */
	allowAborts?: boolean;
}

export interface OracleContext extends JudgeOptions {
	stateRoot: string;
	historyPath: string;
	/** Taken before the run with {@link snapshotResources}. */
	baseline: ResourceSnapshot;
	/** One ordinary prompt planned after the load, with the faults quiesced. */
	probe: PromptOutcome;
	/** Probe time on the scripted provider's clock of the baseline run (informational; used when no real baseline exists). */
	baselineMs?: number;
	/** Probe time on the real clock of the baseline run (the nominal scenario): the probe must be within 1.25x plus 250 ms. */
	baselineRealMs?: number;
	/** Prompts the corpus asks to be planned ({@link expectedPlanned} in drive.ts); fewer planned than this is a finding. */
	expectedPlanned?: number;
	/** Number of prompts the scenario asked for. */
	expectedPrompts?: number;
	/** Which invariants to evaluate. Default: all ten. */
	invariants?: readonly InvariantId[];
	/** Test seam for the after-run snapshot. */
	snapshot?: (stateRoot: string) => ResourceSnapshot;
	/** Most provider calls allowed in flight at once; unchecked when absent. */
	maxInflight?: number;
	/** Base of the JS heap growth allowance in MiB (default 64); {@link HEAP_SLACK_PER_PROMPT_BYTES} per prompt is added. */
	resourceSlackMiB?: number;
	handleSlack?: number;
}

interface Verdict {
	violations: string[];
	observed: string | number;
}

/** Skips the pipeline decides on the prompt alone, before any engine call (hook reasons, Omp precheck codes, the call cap). */
const SKIP_REASONS: Record<string, true> = {
	empty: true,
	trivial: true,
	command: true,
	"already-uplifted": true,
	"graph-reference": true,
	"skip-once": true,
	disabled: true,
	extension: true,
	steer: true,
	"precheck-skip": true,
	"max-calls": true,
};

/** Any token that starts like a nonce, whole or clipped by a field cap. */
const NONCE_TOKEN = /pl-\d+-\d*/g;
const DEFAULT_FILL_RETRIES = 2;
const DEFAULT_SLACK_MIB = 64;
const HEAP_SLACK_PER_PROMPT_BYTES = 64 * 1024;
const DEFAULT_HANDLE_SLACK = 16;
/** The Omp native binding retries a call three times before it fails. */
const NATIVE_ATTEMPTS = 3;
const LATENCY_FACTOR = 1.25;
/** Absolute allowance on top of the ratio, so a fast baseline (tens of ms) does not make host noise a regression. */
const LATENCY_ALLOWANCE_MS = 250;
const SHOWN = 3;

/** The process figures and what the driver's state directories under `stateRoot` still hold. */
export function snapshotResources(stateRoot: string): ResourceSnapshot {
	// Garbage the run left behind is not a leak: collect (synchronously, fully) before the figures are read.
	Bun.gc(true);
	const memory = process.memoryUsage();
	const active =
		typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : [];
	const snapshot: ResourceSnapshot = {
		rssBytes: memory.rss,
		heapUsedBytes: memory.heapUsed,
		handles: active.length,
		children: active.filter((name) => name === "ChildProcess").length,
		files: 0,
		bytes: 0,
		stale: 0,
	};
	let names: string[] = [];
	try {
		names = readdirSync(stateRoot).filter((name) => name.startsWith("drive-"));
	} catch {
		// reason: a missing state root holds no leftovers; that is the observation, not an error
	}
	for (const name of names) {
		const scan = scanState(join(stateRoot, name));
		snapshot.files += scan.files;
		snapshot.bytes += scan.bytes;
		snapshot.stale += scan.stale.length;
	}
	return snapshot;
}

function tokensOf(outcome: PromptOutcome): Set<string> {
	return new Set(outcome.record?.degraded ?? []);
}

function isReal(node: ThoughtNode, tokens: Set<string>): boolean {
	return node.degraded !== true && !tokens.has(`fill:${node.id}`);
}

/** An abort is accepted only for a prompt an injected `hang` targeted (on any stage, also behind a `delay`) or when the scenario allows aborts. */
function abortAllowed(outcome: PromptOutcome, calls: CallLog[], options: JudgeOptions): boolean {
	return (
		outcome.terminal === "aborted" &&
		(options.allowAborts === true || calls.some((call) => call.chain.includes("hang")))
	);
}

function terminalOf(outcome: PromptOutcome, calls: CallLog[], options: JudgeOptions): string[] {
	const id = outcome.promptId;
	if (outcome.error !== undefined) return [`prompt ${id}: threw ${outcome.error}`];
	if (outcome.terminal === "planned") {
		return outcome.record === undefined ? [`prompt ${id}: planned with no session record`] : [];
	}
	if (outcome.terminal === "aborted") {
		if (abortAllowed(outcome, calls, options)) return [];
		const budget = options.watchdogMs === undefined ? "" : ` (budget ${options.watchdogMs} ms)`;
		return [`prompt ${id}: aborted by the watchdog${budget} and no injected hang targeted it`];
	}
	if (Object.hasOwn(SKIP_REASONS, outcome.terminal.slice("skipped:".length))) return [];
	return [`prompt ${id}: unexpected terminal status ${outcome.terminal}`];
}

function originalOf(outcome: PromptOutcome): string[] {
	const record = outcome.record;
	if (record === undefined) return [];
	if (record.result.original !== outcome.expected) {
		return [`prompt ${outcome.promptId}: original differs from the prompt`];
	}
	if (!record.result.xml.includes(escapeXml(outcome.expected))) {
		return [`prompt ${outcome.promptId}: the spec lost the original text`];
	}
	return [];
}

function upliftOf(outcome: PromptOutcome): string[] {
	const result = outcome.record?.result;
	if (result === undefined) return [];
	const id = outcome.promptId;
	if (result.source === "llm") {
		if (!(ROOT_TAGS as readonly string[]).includes(result.root)) {
			return [`prompt ${id}: llm result with root ${result.root}`];
		}
		if (sanitizeUpliftXml(result.xml, result.original) === null) {
			return [`prompt ${id}: llm result that is not a complete uplift`];
		}
		if (result.fallbackReason !== undefined) {
			return [`prompt ${id}: llm result carrying a fallback reason`];
		}
		return [];
	}
	if (result.fallbackReason === undefined || result.fallbackReason === "") {
		return [`prompt ${id}: fallback with no reason`];
	}
	if (!tokensOf(outcome).has("uplift")) {
		return [`prompt ${id}: fallback not listed as degraded uplift`];
	}
	return [];
}

/** Per node: whether any fill call produced a usable reply (no failure, no garbage, no truncation). */
function goodFills(calls: CallLog[]): Map<string, boolean> {
	const byNode = new Map<string, boolean>();
	for (const call of calls) {
		if (call.stage !== "fill" || call.node === undefined) continue;
		const good = call.outcome === "ok" && (call.effect === "ok" || call.effect === "delay");
		byNode.set(call.node, (byNode.get(call.node) ?? false) || good);
	}
	return byNode;
}

function nameOfToken(token: string): string {
	if (token === "graph") return "the graph structure";
	if (token.startsWith("fill:")) return `the ${token.slice("fill:".length)} fill`;
	return `the ${token} step`;
}

function degradedOf(outcome: PromptOutcome, calls: CallLog[]): string[] {
	const record = outcome.record;
	if (record === undefined) return [];
	const violations: string[] = [];
	const id = outcome.promptId;
	const tokens = tokensOf(outcome);
	const fills = goodFills(calls);
	for (const node of record.graph?.nodes ?? []) {
		const listed = tokens.has(`fill:${node.id}`);
		const conclusion = node.conclusion?.trim() ?? "";
		if ((node.degraded === true || conclusion === "") && !listed) {
			violations.push(
				`prompt ${id}: node ${node.id} has no real fill and is not listed as fill:${node.id}`,
			);
		} else if (conclusion !== "" && conclusion === node.question.trim() && !listed) {
			violations.push(
				`prompt ${id}: node ${node.id} concludes with its own question and is not listed`,
			);
		} else if (fills.get(node.id) === false && !listed) {
			violations.push(
				`prompt ${id}: every fill call for node ${node.id} failed but fill:${node.id} is not listed`,
			);
		}
	}
	if (tokens.size === 0) return violations;
	if (!outcome.context.includes("Planning degraded")) {
		violations.push(
			`prompt ${id}: degraded (${[...tokens].join(", ")}) but the output never says so`,
		);
	} else if (record.result.source === "llm") {
		const unnamed = [...tokens].filter((token) => !outcome.context.includes(nameOfToken(token)));
		if (unnamed.length > 0)
			violations.push(`prompt ${id}: the output does not name ${unnamed.join(", ")}`);
	}
	return violations;
}

function cotOf(outcome: PromptOutcome, options: JudgeOptions): string[] {
	const record = outcome.record;
	if (record === undefined) return [];
	const violations: string[] = [];
	const minNodes = options.minNodes ?? 5;
	const maxNodes = options.maxNodes ?? 8;
	const id = outcome.promptId;
	const tokens = tokensOf(outcome);
	const graph = record.graph;
	if (graph === undefined) {
		if (!tokens.has("think"))
			violations.push(`prompt ${id}: no graph and think is not listed as degraded`);
		return violations;
	}
	if (!tokens.has("graph")) {
		if (graph.nodes.length < minNodes || graph.nodes.length > maxNodes) {
			violations.push(
				`prompt ${id}: ${graph.nodes.length} nodes, expected ${minNodes} to ${maxNodes}`,
			);
		}
		const seen = new Set<string>();
		for (const node of graph.nodes) {
			const late = node.dependsOn.filter((dep) => !seen.has(dep));
			if (late.length > 0 || seen.has(node.id)) {
				violations.push(
					`prompt ${id}: node ${node.id} depends on ${late.join(", ") || "itself"} out of order`,
				);
			}
			seen.add(node.id);
		}
	}
	for (const node of graph.nodes) {
		if (!isReal(node, tokens)) continue;
		const steps = splitRationaleSteps(node.thinking ?? "").length;
		if (steps < 5 || steps > 8)
			violations.push(`prompt ${id}: node ${node.id} has ${steps} rationale steps`);
		else if ((node.conclusion?.trim() ?? "") === "")
			violations.push(`prompt ${id}: node ${node.id} has no conclusion`);
	}
	return violations;
}

/**
 * A token is foreign unless it is the prompt's own nonce or a clipped start of it: a field cap may cut the nonce
 * short, and with fixed-width nonces a clipped token can never be another prompt's whole nonce.
 */
function isForeign(token: string, own: string): boolean {
	return token !== own && !(token.length < own.length && own.startsWith(token));
}

function isolationOf(outcome: PromptOutcome, options: JudgeOptions): string[] {
	const record = outcome.record;
	if (record === undefined) return [];
	const violations: string[] = [];
	const id = outcome.promptId;
	const haystack = [
		JSON.stringify(record),
		outcome.specXml ?? "",
		outcome.context,
		...outcome.rows,
	].join("\n");
	const foreign = new Set(
		(haystack.match(NONCE_TOKEN) ?? []).filter((token) => isForeign(token, outcome.nonce)),
	);
	if (foreign.size > 0)
		violations.push(`prompt ${id}: carries ${[...foreign].slice(0, SHOWN).join(", ")}`);
	if (options.real) return violations;
	const real = (record.graph?.nodes ?? []).filter((node) => isReal(node, tokensOf(outcome)));
	if (real.length > 0 && !real.some((node) => node.conclusion?.includes(outcome.nonce))) {
		violations.push(`prompt ${id}: its own nonce never reached a fill conclusion`);
	}
	return violations;
}

function budgets(outcome: PromptOutcome, options: JudgeOptions): Record<string, number> {
	const per = outcome.path === "omp" ? NATIVE_ATTEMPTS : 1;
	const nodes = outcome.record?.graph?.nodes.length ?? options.maxNodes ?? 8;
	// One attempt plus fillRetries retries, plus the single repair attempt of the dependency-ordered pass.
	const fill = nodes * ((options.fillRetries ?? DEFAULT_FILL_RETRIES) + 2) * per;
	return { uplift: per, graph: per, fill, clarify: 2 * per };
}

function callsOf(outcome: PromptOutcome, options: JudgeOptions): string[] {
	const violations: string[] = [];
	const limit = budgets(outcome, options);
	for (const [stage, made] of Object.entries(outcome.calls)) {
		const budget = limit[stage];
		if (made !== undefined && budget !== undefined && made > budget) {
			violations.push(`prompt ${outcome.promptId}: ${made} ${stage} calls, budget ${budget}`);
		}
	}
	return violations;
}

/**
 * Judges one prompt on its own, from its heavy fields and its provider calls. The driver runs this right after the
 * prompt completes and keeps only the verdict, so a long run does not hold every record, spec and context to the end.
 */
export function createJudge(
	options: JudgeOptions,
): (outcome: PromptOutcome, calls: CallLog[]) => PromptVerdict {
	return (outcome, calls) => ({
		planned: outcome.terminal === "planned" && outcome.record !== undefined,
		allowedAbort: abortAllowed(outcome, calls, options),
		terminal: terminalOf(outcome, calls, options),
		original: originalOf(outcome),
		uplift: upliftOf(outcome),
		degraded: degradedOf(outcome, calls),
		cot: cotOf(outcome, options),
		isolation: isolationOf(outcome, options),
		calls: callsOf(outcome, options),
	});
}

function verdictsOf(report: DriveReport, ctx: OracleContext): Array<PromptVerdict | undefined> {
	const byKey = new Map<string, CallLog[]>();
	let judge: ReturnType<typeof createJudge> | undefined;
	return report.outcomes.map((outcome) => {
		if (outcome === undefined) return undefined;
		if (outcome.verdict !== undefined) return outcome.verdict;
		if (byKey.size === 0) {
			for (const call of report.calls) {
				const list = byKey.get(call.key) ?? [];
				list.push(call);
				byKey.set(call.key, list);
			}
		}
		judge ??= createJudge(ctx);
		return judge(outcome, byKey.get(outcome.nonce) ?? []);
	});
}

function collect(
	verdicts: Array<PromptVerdict | undefined>,
	pick: (verdict: PromptVerdict) => string[],
): { violations: string[]; planned: number } {
	const violations: string[] = [];
	let planned = 0;
	for (const verdict of verdicts) {
		if (verdict === undefined) continue;
		if (verdict.planned) planned += 1;
		violations.push(...pick(verdict));
	}
	return { violations, planned };
}

function honest(
	verdicts: Array<PromptVerdict | undefined>,
	pick: (verdict: PromptVerdict) => string[],
	label: string,
): Verdict {
	const { violations, planned } = collect(verdicts, pick);
	return { violations, observed: `${planned - violations.length}/${planned} ${label}` };
}

function terminal(
	report: DriveReport,
	ctx: OracleContext,
	verdicts: Array<PromptVerdict | undefined>,
): Verdict {
	const violations: string[] = [];
	const { outcomes } = report;
	if (ctx.expectedPrompts !== undefined && outcomes.length !== ctx.expectedPrompts) {
		violations.push(`${outcomes.length} outcomes for ${ctx.expectedPrompts} prompts`);
	}
	let settled = 0;
	let planned = 0;
	let skipped = 0;
	let aborted = 0;
	let allowedAborts = 0;
	for (const [index, verdict] of verdicts.entries()) {
		if (verdict === undefined) {
			violations.push(`prompt ${index}: no outcome`);
			continue;
		}
		if (verdict.terminal.length === 0) settled += 1;
		else violations.push(...verdict.terminal);
		const status = outcomes[index]?.terminal;
		if (verdict.planned) planned += 1;
		else if (status === "aborted") {
			aborted += 1;
			if (verdict.allowedAbort) allowedAborts += 1;
		} else if (status?.startsWith("skipped:") && verdict.terminal.length === 0) skipped += 1;
	}
	const pending = report.calls.filter((call) => call.outcome === "pending").length;
	if (pending > 0) violations.push(`${pending} provider call(s) still pending after the run`);
	if (ctx.expectedPlanned !== undefined && planned + allowedAborts < ctx.expectedPlanned) {
		violations.push(
			`${planned} planned, expected at least ${ctx.expectedPlanned - allowedAborts} (${ctx.expectedPlanned} by the corpus, ${allowedAborts} aborted by an injected hang)`,
		);
	}
	const injected = allowedAborts > 0 ? ` (${allowedAborts} allowed)` : "";
	return {
		violations,
		observed: `${settled}/${outcomes.length} terminal: ${planned} planned, ${skipped} skipped (by design), ${aborted} aborted${injected}`,
	};
}

function isolation(report: DriveReport, verdicts: Array<PromptVerdict | undefined>): Verdict {
	const { violations, planned } = collect(verdicts, (verdict) => verdict.isolation);
	for (const call of report.calls) {
		if (call.foreign.length > 0) {
			violations.push(
				`call ${call.seq} (${call.key}, ${call.stage}): payload carried ${call.foreign.slice(0, SHOWN).join(", ")}`,
			);
		}
	}
	return { violations, observed: `${planned} prompts, ${violations.length} leaks` };
}

function mib(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function signed(value: number, unit: (value: number) => string): string {
	return `${value >= 0 ? "+" : ""}${unit(value)}`;
}

function resources(report: DriveReport, ctx: OracleContext): Verdict {
	const after = (ctx.snapshot ?? snapshotResources)(ctx.stateRoot);
	const before = ctx.baseline;
	const violations: string[] = [];
	if (after.files > before.files)
		violations.push(`${after.files} state files left (baseline ${before.files})`);
	if (after.bytes > before.bytes)
		violations.push(`${after.bytes} state bytes left (baseline ${before.bytes})`);
	if (after.stale > before.stale)
		violations.push(`${after.stale} stale lock or temp files (baseline ${before.stale})`);
	if (after.children > before.children)
		violations.push(`${after.children} child processes (baseline ${before.children})`);
	const handleSlack = ctx.handleSlack ?? DEFAULT_HANDLE_SLACK;
	if (after.handles > before.handles + handleSlack) {
		violations.push(
			`${after.handles} active handles (baseline ${before.handles}, slack ${handleSlack})`,
		);
	}
	// The verdict is the JS heap after a forced collection, once the run's own report has been reduced to verdicts: what the
	// code under test still holds, not what the harness retained or what the allocator has not given back.
	const heap = after.heapUsedBytes - before.heapUsedBytes;
	const slack =
		(ctx.resourceSlackMiB ?? DEFAULT_SLACK_MIB) * 1024 * 1024 +
		HEAP_SLACK_PER_PROMPT_BYTES * report.outcomes.length;
	if (heap > slack)
		violations.push(`heap grew ${mib(heap)} after a full collection (slack ${mib(slack)})`);
	if (ctx.maxInflight !== undefined && report.peakInflight > ctx.maxInflight) {
		violations.push(`peak ${report.peakInflight} calls in flight, cap ${ctx.maxInflight}`);
	}
	const handles = after.handles - before.handles;
	return {
		violations,
		observed: `heap ${signed(heap, mib)}, rss ${signed(after.rssBytes - before.rssBytes, mib)}, handles ${signed(handles, String)}, files ${after.files}, peak in flight ${report.peakInflight}`,
	};
}

function recovery(ctx: OracleContext): Verdict {
	const probe = ctx.probe;
	const violations: string[] = [];
	if (probe.error !== undefined) violations.push(`probe threw ${probe.error}`);
	else if (probe.terminal !== "planned") violations.push(`probe ended ${probe.terminal}`);
	else if (probe.record?.result.source !== "llm")
		violations.push("probe fell back instead of planning from the model");
	else if (probe.degraded.length > 0)
		violations.push(`probe degraded: ${probe.degraded.join(", ")}`);
	const real = Math.round(probe.realMs);
	const baselineReal =
		ctx.baselineRealMs === undefined ? undefined : Math.round(ctx.baselineRealMs);
	if (baselineReal !== undefined) {
		// The real clock decides: the scripted provider's clock only moves when a wait is injected, so it is vacuous here.
		if (real > baselineReal * LATENCY_FACTOR + LATENCY_ALLOWANCE_MS) {
			violations.push(
				`probe took ${real} ms of real time, over ${LATENCY_FACTOR}x the ${baselineReal} ms baseline plus ${LATENCY_ALLOWANCE_MS} ms`,
			);
		}
	} else if (ctx.baselineMs !== undefined && probe.ms > ctx.baselineMs * LATENCY_FACTOR) {
		violations.push(
			`probe took ${probe.ms} ms, over ${LATENCY_FACTOR}x the ${ctx.baselineMs} ms baseline`,
		);
	}
	const ratio =
		baselineReal === undefined || baselineReal === 0
			? "n/a"
			: String(Math.round((real / baselineReal) * 100) / 100);
	return {
		violations,
		observed: `probe latency real ${real} ms baseline ${baselineReal === undefined ? "none" : `${baselineReal} ms`} ratio ${ratio} (virtual ${probe.ms} ms)`,
	};
}

function persisted(report: DriveReport, ctx: OracleContext): Verdict {
	const violations: string[] = [];
	let scanned = 0;
	for (const outcome of report.outcomes) {
		if (outcome?.state === undefined) continue;
		scanned += 1;
		if (outcome.state.bad.length > 0) {
			violations.push(
				`prompt ${outcome.promptId}: unparsable state ${outcome.state.bad.slice(0, SHOWN).join(", ")}`,
			);
		}
		if (outcome.state.stale.length > 0) {
			violations.push(
				`prompt ${outcome.promptId}: leftover ${outcome.state.stale.slice(0, SHOWN).join(", ")}`,
			);
		}
	}
	try {
		const { skipped } = readHistory(ctx.historyPath);
		if (skipped > 0) violations.push(`history has ${skipped} unreadable line(s)`);
	} catch {
		violations.push("history file is unreadable");
	}
	return { violations, observed: `${scanned} state directories scanned` };
}

function calls(
	report: DriveReport,
	ctx: OracleContext,
	verdicts: Array<PromptVerdict | undefined>,
): Verdict {
	const { violations } = collect(verdicts, (verdict) => verdict.calls);
	violations.push(...callsOf(ctx.probe, ctx));
	let counted = 1;
	for (const outcome of report.outcomes) {
		if (outcome === undefined) continue;
		counted += 1;
		if (outcome.terminal !== "aborted") continue;
		const mine = report.calls.filter((call) => call.key === outcome.nonce);
		const aborts = mine.filter((call) => call.outcome === "aborted" && call.endedAt !== undefined);
		if (aborts.length === 0) continue;
		const at = Math.min(...aborts.map((call) => call.endedAt ?? Number.POSITIVE_INFINITY));
		if (mine.some((call) => call.startedAt > at)) {
			violations.push(`prompt ${outcome.promptId}: started a call after abort`);
		}
	}
	return { violations, observed: `${counted - violations.length}/${counted} within budget` };
}

function summarize(id: InvariantId, verdict: Verdict): HypothesisResult {
	if (verdict.violations.length === 0) return { id, passed: true, observed: verdict.observed };
	const shown = verdict.violations.slice(0, SHOWN).join("; ");
	const more =
		verdict.violations.length > SHOWN ? ` (+${verdict.violations.length - SHOWN} more)` : "";
	return { id, passed: false, observed: verdict.observed, reason: `${shown}${more}` };
}

/**
 * Judges a drive against the ten design invariants: terminal status, original preserved, no malformed uplift counted
 * as success, every degraded stage listed and shown, real 5 to 8 step fills, no cross-prompt nonce leak, resources back
 * to baseline, a normal probe after the load, persisted state that parses, and call counts inside the retry budget.
 * One result per requested invariant, in id order, each failing on its own with a reason that names the prompt. A
 * prompt the driver already judged (and compacted) is read from its verdict; any other is judged here.
 */
export function checkInvariants(report: DriveReport, ctx: OracleContext): HypothesisResult[] {
	const wanted = new Set<InvariantId>(ctx.invariants ?? INVARIANT_IDS);
	const verdicts = verdictsOf(report, ctx);
	const run: Record<InvariantId, () => Verdict> = {
		terminal: () => terminal(report, ctx, verdicts),
		original: () => honest(verdicts, (verdict) => verdict.original, "byte for byte"),
		uplift: () => honest(verdicts, (verdict) => verdict.uplift, "honest"),
		degraded: () => honest(verdicts, (verdict) => verdict.degraded, "honest"),
		cot: () => honest(verdicts, (verdict) => verdict.cot, "real chains"),
		isolation: () => isolation(report, verdicts),
		resources: () => resources(report, ctx),
		recovery: () => recovery(ctx),
		persisted: () => persisted(report, ctx),
		calls: () => calls(report, ctx, verdicts),
	};
	return INVARIANT_IDS.filter((id) => wanted.has(id)).map((id) => summarize(id, run[id]()));
}
