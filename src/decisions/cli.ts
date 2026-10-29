// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `bin/ultrathink decisions check | probe <point> <cases.json>`: operator tools for the Jev integration. They read the
 * `decisions` config for model, zdr, timeout and thresholds but ignore `enabled` and `points`; `ULTRATHINK_DECISIONS=0`
 * makes both refuse without a request.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultStateDir } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { storePath as defaultStorePath } from "../mcp/store.ts";
import {
	type DecideOptions,
	type DecideOutcome,
	type DecisionsUrl,
	DECISIONS_URL_IGNORED,
	decide,
	redact,
	resolveDecisionsUrl,
} from "./client.ts";
import {
	type DecisionsDeps,
	type KeySource,
	type ResolvedProvider,
	buildDecisionsRequest,
	decisionsKilled,
	recordHealth,
	resolveDecisionsKeys,
	usageListener,
} from "./gate.ts";
import {
	type JevHealth,
	type JevHealthState,
	openJevHealth,
	openMemoryJevHealth,
} from "./health.ts";
import { type UsageTotals, summarizeUsage } from "./usage.ts";
import { decideVercel } from "./vercel.ts";
import {
	buildBlockingState,
	buildKnowledgeState,
	buildPlanState,
	buildShipState,
	buildSkillworthyState,
	buildTeachableState,
	type DecisionStates,
	QUESTION_KEYS,
} from "./questions.ts";
import {
	type DecisionPoint,
	type DecisionsConfig,
	type DecisionsRequest,
	DECISION_POINTS,
	formatP,
} from "./types.ts";

export interface DecisionsCommandDeps extends Omit<DecisionsDeps, "debug"> {
	cwd: string;
	/** Default: readFileSync(path, "utf8"); relative paths resolve against cwd. */
	readFile?: (path: string) => string;
}

const USAGE =
	"Usage: ultrathink decisions check | ultrathink decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json> | ultrathink decisions usage [--days N] [--json]";
const NO_KEY =
	"no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or ULTRATHINK_OPENROUTER_KEY)";
const KILLED = "off (ULTRATHINK_DECISIONS=0)";
const CHECK_MESSAGE = "Add a --verbose flag to the export command";
const MAX_CASES = 200;

interface Runtime {
	config: DecisionsConfig;
	/** ULTRATHINK_DECISIONS=0: no request is ever sent. */
	killed: boolean;
	provider: ResolvedProvider;
	key?: { key: string; source: KeySource };
	url: DecisionsUrl;
	decideOptions: (apiKey: string, point: string) => DecideOptions;
	rail: typeof decide;
	now: () => number;
	/** The picked rail's breaker: under the caller's state dir, else in memory (no disk). */
	health: JevHealth;
}

function runtime(deps: DecisionsCommandDeps, configured?: DecisionsConfig): Runtime {
	const env = deps.env ?? process.env;
	const config = configured ?? loadConfig(claudeConfigPaths(deps.cwd, env)).decisions;
	const url = resolveDecisionsUrl(env);
	const picked = resolveDecisionsKeys(config, deps.storePath ?? defaultStorePath(env), env);
	return {
		config,
		killed: decisionsKilled(env),
		provider: picked.provider,
		key: picked.key,
		url,
		decideOptions: (apiKey, point) => ({
			apiKey,
			timeoutMs: config.timeoutMs,
			...(picked.provider === "openrouter" ? { url: url.url } : {}),
			fetch: deps.fetch,
			now: deps.now,
			sleep: deps.sleep,
			random: deps.random,
			onAttempt: usageListener(deps.stateDir, {
				point,
				rail: picked.provider,
				model: config.model,
			}),
		}),
		rail: picked.provider === "vercel" ? decideVercel : decide,
		now: deps.now ?? Date.now,
		health:
			deps.health ??
			(deps.stateDir === undefined
				? openMemoryJevHealth(picked.provider)
				: openJevHealth(deps.stateDir, picked.provider)),
	};
}

/** ` · provider <rail> · zdr <n/a (vercel)|on|off> · key from <source>` + ` · url <url>` when the env override is in effect on the OpenRouter rail, or the ignored notice when it was rejected. The Vercel rail sends no ZDR preference. */
function footer(rt: Runtime, source: KeySource): string {
	const url =
		rt.provider === "openrouter"
			? rt.url.source === "ULTRATHINK_DECISIONS_URL"
				? ` · url ${rt.url.url}`
				: rt.url.ignored
					? DECISIONS_URL_IGNORED
					: ""
			: "";
	const zdr = rt.provider === "vercel" ? "n/a (vercel)" : rt.config.zdr ? "on" : "off";
	return ` · provider ${rt.provider} · zdr ${zdr} · key from ${source}${url}`;
}

/** The one-request check: the plan question against the configured model, with the rail's data-handling setting. */
function checkRequest(rt: Runtime): DecisionsRequest {
	return buildDecisionsRequest(
		"plan",
		buildPlanState({ message: CHECK_MESSAGE, recentConversation: "" }),
		{
			model: rt.config.model,
			zdr: rt.config.zdr,
			spanName: "check",
		},
	);
}

interface DecisionsLiveCheck {
	ok: boolean;
	/** The failure's kind (`auth`, `credits`, `timeout`, ...), or `killed` / `no-key` when no request was made; absent on success. Never a message. */
	kind?: string;
	latencyMs: number;
	attempts: number;
}

/**
 * The request `decisions check` sends, with its result recorded on the rail's breaker, for callers that need a verdict
 * and not a printed line (the stack probe). `config` replaces the file layers; `config.timeoutMs` is the total budget.
 * No key, or `ULTRATHINK_DECISIONS=0`, sends nothing. Never rejects.
 */
export async function decisionsLiveCheck(
	deps: DecisionsCommandDeps,
	config: DecisionsConfig,
): Promise<DecisionsLiveCheck> {
	try {
		const rt = runtime(deps, config);
		if (rt.killed) return { ok: false, kind: "killed", latencyMs: 0, attempts: 0 };
		if (!rt.key) return { ok: false, kind: "no-key", latencyMs: 0, attempts: 0 };
		const outcome = await forcedCall(rt, rt.key.key, checkRequest(rt), "check");
		return outcome.ok
			? { ok: true, latencyMs: outcome.latencyMs, attempts: outcome.attempts }
			: {
					ok: false,
					kind: outcome.error.kind,
					latencyMs: outcome.latencyMs,
					attempts: outcome.attempts,
				};
	} catch {
		// reason: a probe verdict must not reject; the failure is reported as an unavailable check without its message.
		return { ok: false, kind: "unavailable", latencyMs: 0, attempts: 0 };
	}
}

async function check(rt: Runtime): Promise<{ code: number; text: string }> {
	if (rt.killed) return { code: 1, text: `Decisions check: ${KILLED}` };
	if (!rt.key) return { code: 1, text: `Decisions check: ${NO_KEY}` };
	const request = checkRequest(rt);
	const before = rt.health.read();
	const outcome = await forcedCall(rt, rt.key.key, request, "check");
	const timing = `${Math.round(outcome.latencyMs)} ms · attempts ${outcome.attempts}`;
	// Between the timing and the footer, so the footer (provider · zdr · key source · url) still ends the line.
	const note = breakerNote(before, rt.health.read());
	const tail = footer(rt, rt.key.source);
	if (!outcome.ok) {
		return {
			code: 1,
			text: `Decisions check: error (${outcome.error.kind}) · ${outcome.error.message} · ${timing}${note}${tail}`,
		};
	}
	const { model, usage } = outcome.response;
	const cost = usage.cost !== undefined ? String(usage.cost) : "n/a";
	return {
		code: 0,
		text: `Decisions check: ok · ${model} (requested ${rt.config.model}) · ${timing} · cost ${cost}${note}${tail}`,
	};
}

/**
 * The operator's request goes out whatever the cool-down says, and its result is recorded like a claimed probe's: a
 * success closes the rail's breaker, a 402/401/403 re-schedules it. The ledger gets a row per real POST.
 */
async function forcedCall(
	rt: Runtime,
	apiKey: string,
	request: DecisionsRequest,
	point: string,
): Promise<DecideOutcome> {
	const startedAt = rt.now();
	const verdict = rt.health.shouldCall(startedAt, { force: true });
	const outcome = await rt.rail(request, rt.decideOptions(apiKey, point));
	recordHealth(rt.health, outcome, rt.now(), verdict.call ? { ...verdict, startedAt } : undefined);
	return outcome;
}

/** ` · breaker closed` / ` · breaker still open: <cause>` / ` · breaker opened: <cause>` when the call changed it, else nothing. */
function breakerNote(before: JevHealthState, after: JevHealthState): string {
	if (after.state === "open") {
		return before.state === "open"
			? ` · breaker still open: ${after.cause}`
			: ` · breaker opened: ${after.cause}`;
	}
	return before.state === "open" ? " · breaker closed" : "";
}

type ProbeCase = { state: DecisionStates[DecisionPoint]; label?: boolean };

function isNonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/** The case's state through the point's builder, or the reason it is invalid. */
function probeState(
	point: DecisionPoint,
	c: Record<string, unknown>,
): DecisionStates[DecisionPoint] | string {
	const need = (...fields: string[]) => fields.find((field) => !isNonEmpty(c[field]));
	switch (point) {
		case "plan": {
			if (!isNonEmpty(c.message)) return `"message" must be a non-empty string`;
			const recent = c.recent_conversation;
			if (recent !== undefined && typeof recent !== "string")
				return `"recent_conversation" must be a string`;
			return buildPlanState({
				message: c.message,
				recentConversation: typeof recent === "string" ? recent : "",
			});
		}
		case "ship": {
			if (!isNonEmpty(c.request)) return `"request" must be a non-empty string`;
			const criteria = c.acceptance_criteria;
			if (
				criteria !== undefined &&
				!(Array.isArray(criteria) && criteria.every((item) => typeof item === "string"))
			) {
				return `"acceptance_criteria" must be an array of strings`;
			}
			if (typeof c.patch !== "string") return `"patch" must be a string`;
			return buildShipState({
				request: c.request,
				acceptanceCriteria: (criteria as string[] | undefined) ?? [],
				patch: c.patch,
			}).state;
		}
		case "knowledge": {
			const missing = need("question", "answer", "document");
			if (missing) return `"${missing}" must be a non-empty string`;
			return buildKnowledgeState({
				question: c.question as string,
				answer: c.answer as string,
				document: c.document as string,
			});
		}
		case "blocking": {
			const missing = need("task", "question", "default");
			if (missing) return `"${missing}" must be a non-empty string`;
			return buildBlockingState({
				task: c.task as string,
				question: c.question as string,
				defaultText: c.default as string,
			});
		}
		case "teachable":
		case "skillworthy": {
			const candidate = c.candidate;
			if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
				return `"candidate" must be a JSON object`;
			const fields = candidate as Record<string, unknown>;
			const missing = ["name", "description", "body", "kind"].find(
				(field) => !isNonEmpty(fields[field]),
			);
			if (missing) return `"candidate.${missing}" must be a non-empty string`;
			const lesson = {
				name: fields.name as string,
				description: fields.description as string,
				body: fields.body as string,
				kind: fields.kind as string,
			};
			if (point === "teachable") return buildTeachableState(lesson);
			const occurrences = fields.occurrences;
			if (typeof occurrences !== "number" || !Number.isInteger(occurrences) || occurrences < 1) {
				return `"candidate.occurrences" must be an integer of at least 1`;
			}
			return buildSkillworthyState({ ...lesson, occurrences });
		}
	}
}

/** Every case validated before the first request; a string is the invalid-file reason. */
function parseCases(point: DecisionPoint, file: string, text: string): ProbeCase[] | string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// reason: an unparseable file is reported by the caller as not a JSON array
		parsed = undefined;
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_CASES) {
		return `${file} is not a JSON array of 1 to ${MAX_CASES} cases`;
	}
	const cases: ProbeCase[] = [];
	for (const [index, item] of parsed.entries()) {
		const at = `case #${index + 1}`;
		if (typeof item !== "object" || item === null || Array.isArray(item))
			return `${at}: must be a JSON object`;
		const c = item as Record<string, unknown>;
		if (c.label !== undefined && typeof c.label !== "boolean")
			return `${at}: "label" must be true or false`;
		const state = probeState(point, c);
		if (typeof state === "string") return `${at}: ${state}`;
		cases.push({ state, ...(typeof c.label === "boolean" ? { label: c.label } : {}) });
	}
	return cases;
}

/** The action the point would take at P under the configured thresholds (§5.7). */
function probeAction(point: DecisionPoint, p: number, config: DecisionsConfig): string {
	switch (point) {
		case "plan":
			return p < config.planSkipBelow ? "skip-plan" : "plan";
		case "knowledge":
			return p < config.groundedAt ? "reject-claim" : "keep";
		case "blocking":
			return p >= config.blockingAt ? "promote" : "keep";
		case "ship":
			return p <= config.shipVetoAtOrBelow
				? "veto"
				: p >= config.shipApproveAt
					? "approve"
					: "pass";
		case "teachable":
			return p < config.teachableBelow
				? "drop"
				: p >= config.teachableAutoAt
					? "auto-confirm"
					: "keep";
		case "skillworthy":
			return p < config.skillworthyAt ? "skip" : "keep";
	}
}

/** The action that counts as Jev answering "yes" for the points whose label is a yes/no on one action. */
const POSITIVE: Record<"plan" | "knowledge" | "blocking" | "skillworthy", string> = {
	plan: "plan",
	knowledge: "keep",
	blocking: "promote",
	skillworthy: "keep",
};

function agrees(point: DecisionPoint, action: string, label: boolean): boolean {
	if (point === "ship") return (label && action !== "veto") || (!label && action !== "approve");
	// A teachable lesson is "yes" unless it is dropped; keep and auto-confirm both let it stand.
	if (point === "teachable") return (action !== "drop") === label;
	return (action === POSITIVE[point]) === label;
}

async function probe(
	rt: Runtime,
	argv: readonly string[],
	deps: DecisionsCommandDeps,
): Promise<{ code: number; text: string }> {
	const point = argv[1]?.trim().toLowerCase() as DecisionPoint;
	const file = argv[2] ?? "";
	if (!DECISION_POINTS.includes(point) || !file) return { code: 2, text: USAGE };
	let text: string;
	try {
		const path = resolve(deps.cwd, file);
		text = deps.readFile ? deps.readFile(path) : readFileSync(path, "utf8");
	} catch {
		return { code: 2, text: `Decisions probe: cannot read ${file}` };
	}
	const cases = parseCases(point, file, text);
	if (typeof cases === "string") return { code: 2, text: `Decisions probe: ${cases}` };
	if (rt.killed) return { code: 1, text: `Decisions probe: ${KILLED}` };
	if (!rt.key) return { code: 1, text: `Decisions probe: ${NO_KEY}` };

	const before = rt.health.read();
	const lines: string[] = [];
	const questionKey = QUESTION_KEYS[point];
	let model: string | undefined;
	let labelled = 0;
	let agreed = 0;
	let errors = 0;
	for (const [index, c] of cases.entries()) {
		if (c.label !== undefined) labelled++;
		const request = buildDecisionsRequest(point, c.state, {
			model: rt.config.model,
			zdr: rt.config.zdr,
			spanName: point,
		});
		const outcome = await forcedCall(rt, rt.key.key, request, point);
		if (!outcome.ok) {
			errors++;
			lines.push(`#${index + 1} error (${outcome.error.kind})`);
			continue;
		}
		model ??= outcome.response.model;
		const answer = outcome.response.answers[questionKey];
		const p = answer?.type === "noul" ? answer.noul : Number.NaN;
		const action = probeAction(point, p, rt.config);
		let line = `#${index + 1} P ${formatP(p)} · ${action}`;
		if (c.label !== undefined) {
			const agree = agrees(point, action, c.label);
			if (agree) agreed++;
			line += ` · label ${c.label} · ${agree ? "agree" : "DISAGREE"}`;
		}
		lines.push(line);
	}
	lines.push(
		`Decisions probe: ${point} · ${model ?? rt.config.model} · cases ${cases.length} · labelled ${labelled} · agree ${agreed}/${labelled} · errors ${errors}${breakerNote(before, rt.health.read())}`,
	);
	return { code: errors > 0 ? 1 : 0, text: lines.join("\n") };
}

const USAGE_DEFAULT_DAYS = 7;
const USAGE_MAX_DAYS = 90;

/** `--days N` (or `--days=N`, integer 1..90) and `--json`, each at most once; anything else is a usage error. */
function parseUsageArgs(args: readonly string[]): { days: number; json: boolean } | undefined {
	let days: number | undefined;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--json") {
			if (json) return undefined;
			json = true;
			continue;
		}
		if (days !== undefined) return undefined;
		let value: string | undefined;
		if (arg === "--days") value = args[++i];
		else if (arg.startsWith("--days=")) value = arg.slice("--days=".length);
		else return undefined;
		if (value === undefined || !/^\d+$/.test(value)) return undefined;
		days = Number(value);
		if (days < 1 || days > USAGE_MAX_DAYS) return undefined;
	}
	return { days: days ?? USAGE_DEFAULT_DAYS, json };
}

function usageStats(totals: UsageTotals): string {
	return `calls ${totals.calls} · failures ${totals.failures} · cost $${totals.costUsd.toFixed(6)}`;
}

/** The local ledger as a table the owner can hold against the OpenRouter dashboard. Reads only; never touches the network or the key. */
function usage(
	args: readonly string[],
	deps: DecisionsCommandDeps,
): { code: number; text: string } {
	const parsed = parseUsageArgs(args);
	if (!parsed) return { code: 2, text: USAGE };
	const env = deps.env ?? process.env;
	const summary = summarizeUsage(deps.stateDir ?? defaultStateDir(env), {
		days: parsed.days,
		now: (deps.now ?? Date.now)(),
	});
	if (parsed.json) return { code: 0, text: JSON.stringify(summary) };
	const rows = (map: Record<string, UsageTotals>): string[] =>
		Object.keys(map)
			.sort()
			.map((key) => `  ${key} · ${usageStats(map[key] as UsageTotals)}`);
	const kinds = Object.entries(summary.failuresByKind)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([kind, count]) => `${kind} ${count}`);
	const lines = [
		`Decisions usage: last ${summary.days} days · ${usageStats(summary.total)}`,
		"Per day (UTC):",
		...(rows(summary.byDay).length > 0 ? rows(summary.byDay) : ["  none"]),
		"Per model:",
		...(rows(summary.byModel).length > 0 ? rows(summary.byModel) : ["  none"]),
		`Failures by kind: ${kinds.length > 0 ? kinds.join(" · ") : "none"}`,
		"This is the local ledger of Jev calls made from this machine: compare its per-model counts and cost with the per-model breakdown on the OpenRouter dashboard.",
	];
	return { code: 0, text: lines.join("\n") };
}

/** `bin/ultrathink decisions <argv…>`. Never rejects. code 0 ok, 1 failure, 2 usage/invalid input. text has no trailing newline. */
export async function runDecisionsCommand(
	argv: readonly string[],
	deps: DecisionsCommandDeps,
): Promise<{ code: number; text: string }> {
	let apiKey: string | undefined;
	try {
		const command = argv[0]?.trim().toLowerCase();
		if (command === "check" && argv.length === 1) {
			const rt = runtime(deps);
			apiKey = rt.key?.key;
			return await check(rt);
		}
		if (command === "probe" && argv.length === 3) {
			const rt = runtime(deps);
			apiKey = rt.key?.key;
			return await probe(rt, argv, deps);
		}
		if (command === "usage") return usage(argv.slice(1), deps);
		return { code: 2, text: USAGE };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 1, text: `Decisions: ${redact(message, apiKey)}` };
	}
}
