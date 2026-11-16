// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Model routing for the Tree-of-Thought (ToT) PRD stage. ToT writes many small, structured documents, so it may run on a
 * cheaper model than the one the user selected. GoT and CoT never may: they keep the selected model and never reach this
 * path (`resolveStageModel` and `assertCheapPathAllowed` are the guard).
 *
 * Resolution order for ToT, first hit wins:
 *   1. a host that cannot pick a model per call keeps the selected model (a host limit, not a guess);
 *   2. the user's override (`models.tot.model`), used as written;
 *   3. the cheapest allowlisted host-list entry of the selected provider that has both an input and an output price;
 *   4. an official economy alias already listed in `models.tot.candidates` for that provider;
 *   5. otherwise a blocked choice: reason starts with `blocked:` and the selected model is not substituted.
 * Steps 3 and 4 only offer a model that is on the allowlist (every id in the candidate map), reported available by the
 * host and answered a one-time smoke check. Built-in candidate ids are unverified placeholders, not economy aliases.
 *
 * At run time `createToTRouter` retries a cheap-model failure once on that same model, then throws `tot-model-blocked`.
 * It never promotes the item or the stage onto the selected model.
 *
 * Every decision logs one structured line through the injected `log` (the repo's hook convention: a `(message) => void`
 * sink, silent by default). Lines carry host, provider and model ids only, never keys or prompts.
 */
import type { UltrathinkConfig } from "../config.ts";
import { detectHost } from "../host/detect.ts";
import { engineForSessionModel } from "../host/engine.ts";
import type { HostId } from "../host/types.ts";
import { TOT_HOST_PER_CALL_MODEL } from "../route-defaults.ts";
import type { CompleteFn, ModelChoice } from "../think/tot/types.ts";

/** The planning stages that call a model. Only "tot" may leave the selected model. */
export type ThinkStage = "got" | "cot" | "tot";

export interface SelectedModel {
	readonly modelId: string;
	/** Credential provider id when the host knows it; otherwise it is derived from the model id. */
	readonly provider?: string;
}

/** One entry of a host's model list. Prices are per million tokens in any one currency; absent means unknown. */
export interface HostModelInfo {
	readonly modelId: string;
	readonly provider?: string;
	readonly inputPricePerMTok?: number;
	readonly outputPricePerMTok?: number;
	/** False when the host lists the model but cannot call it (no credential, disabled). */
	readonly available?: boolean;
}

/** Remembers which models already answered the smoke check, so each is probed once. */
export interface SmokeCache {
	check(key: string, run: () => Promise<boolean>): Promise<boolean>;
	forget(key: string): void;
}

export function createSmokeCache(): SmokeCache {
	const results = new Map<string, Promise<boolean>>();
	return {
		check(key, run) {
			const known = results.get(key);
			if (known) return known;
			const started = run();
			results.set(key, started);
			return started;
		},
		forget(key) {
			results.delete(key);
		},
	};
}

/** Process-wide cache used when the caller injects none. */
const PROCESS_SMOKE_CACHE = createSmokeCache();

const SMOKE_TIMEOUT_MS = 20_000;

export interface ToTRouteContext {
	readonly config: Pick<UltrathinkConfig, "models">;
	readonly selected: SelectedModel;
	/** Default: `detectHost()`. */
	readonly host?: HostId;
	/** Whether the host takes a model id per call. Default: `TOT_HOST_PER_CALL_MODEL[host]` (false when unlisted). */
	readonly canPickModelPerCall?: boolean;
	/** The host's own model list and pricing, when it exposes one. A throw counts as an absent list. */
	readonly listModels?: () => readonly HostModelInfo[] | Promise<readonly HostModelInfo[]>;
	/** Host-side availability of one model (credential present, not disabled). A throw counts as unavailable. */
	readonly isAvailable?: (modelId: string, provider: string) => boolean | Promise<boolean>;
	/** Runs the one-time smoke check. Absent: candidates are used unprobed and per-item fallback is the safety net. */
	readonly complete?: CompleteFn;
	readonly smokeCache?: SmokeCache;
	readonly signal?: AbortSignal;
	readonly log?: (line: string) => void;
}

function isCheapPathStage(stage: ThinkStage): stage is "tot" {
	return stage === "tot";
}

/** Throws unless `stage` may use a cheaper model. GoT and CoT are tied to the selected model, by design. */
export function assertCheapPathAllowed(stage: ThinkStage): asserts stage is "tot" {
	if (!isCheapPathStage(stage)) {
		throw new Error(
			`the cheap-model path is closed to the ${stage} stage: it keeps the selected model`,
		);
	}
}

/**
 * The model one stage runs on. GoT and CoT return the selected model without consulting config, the host list, the
 * availability callback or the smoke check; ToT resolves through `resolveToTModel`.
 */
export async function resolveStageModel(
	stage: ThinkStage,
	ctx: ToTRouteContext,
): Promise<ModelChoice> {
	if (!isCheapPathStage(stage)) {
		return {
			modelId: ctx.selected.modelId,
			provider: providerFamily(ctx.selected.provider, ctx.selected.modelId, ctx.host) ?? "unknown",
			source: "selected",
			reason: `${stage} keeps the selected model`,
		};
	}
	return resolveToTModel(ctx);
}

/**
 * A provider family ("anthropic", "openai", "xai", "cursor") from an explicit provider id first, then from the model id;
 * undefined when neither says. Matching is by substring on lower-cased text, like `engineForSessionModel`.
 */
function providerFamily(
	provider: string | undefined,
	modelId: string,
	host?: HostId,
): string | undefined {
	const fromProvider = provider === undefined ? undefined : familyOfText(provider.toLowerCase());
	if (fromProvider !== undefined) return fromProvider;
	const route = engineForSessionModel(modelId);
	if (route === "claude") return "anthropic";
	if (route === "grok") return "xai";
	const fromModel = familyOfText(modelId.toLowerCase());
	if (fromModel !== undefined) return fromModel;
	return host === "cursor" ? "cursor" : undefined;
}

function familyOfText(text: string): string | undefined {
	if (text.includes("anthropic") || text.includes("claude")) return "anthropic";
	if (text.includes("xai") || text.includes("grok")) return "xai";
	if (text.includes("cursor")) return "cursor";
	if (text.includes("openai") || text.includes("codex") || /(^|[/:_-])(gpt|o[1-9])/.test(text)) {
		return "openai";
	}
	return undefined;
}

interface Decision {
	readonly choice: ModelChoice;
	/** True when the decision is a fallback the user should hear about. */
	readonly warning: boolean;
}

function logDecision(
	ctx: ToTRouteContext,
	host: HostId,
	decision: Decision,
	selectedModelId: string,
): void {
	if (!ctx.log) return;
	ctx.log(
		`tot-model ${JSON.stringify({
			event: "resolve",
			level: decision.warning ? "warn" : "info",
			host,
			provider: decision.choice.provider,
			selected: selectedModelId,
			chosen: decision.choice.modelId,
			source: decision.choice.source,
			reason: decision.choice.reason,
		})}`,
	);
}

function price(entry: HostModelInfo): number | undefined {
	if (!hasBothPrices(entry)) return undefined;
	return (entry.inputPricePerMTok ?? 0) + (entry.outputPricePerMTok ?? 0);
}

/** Both prices are required. A missing side is unknown, not zero, and is not a priced candidate. */
function hasBothPrices(entry: HostModelInfo): boolean {
	return (
		typeof entry.inputPricePerMTok === "number" &&
		Number.isFinite(entry.inputPricePerMTok) &&
		typeof entry.outputPricePerMTok === "number" &&
		Number.isFinite(entry.outputPricePerMTok)
	);
}

/**
 * Provider-published economy aliases. A config candidate is an official alias only when it is in this set.
 * This repo's built-in ToT candidates are unverified placeholders and are not listed here: do not guess one.
 */
const OFFICIAL_ECONOMY_ALIASES: ReadonlySet<string> = new Set<string>();

function officialEconomyAlias(candidates: readonly string[]): string | undefined {
	for (const id of candidates) {
		if (OFFICIAL_ECONOMY_ALIASES.has(id)) return id;
	}
	return undefined;
}

function totModelBlocked(detail: string): Error {
	const error = new Error(`tot-model-blocked: ${detail}`);
	error.name = "tot-model-blocked";
	return error;
}

async function safely<T>(run: () => T | Promise<T>): Promise<T | undefined> {
	try {
		return await run();
	} catch {
		// reason: a host callback that throws is treated as "no answer"; the next tier decides
		return undefined;
	}
}

async function smokeCheck(
	ctx: ToTRouteContext,
	complete: CompleteFn,
	provider: string,
	modelId: string,
): Promise<boolean> {
	const cache = ctx.smokeCache ?? PROCESS_SMOKE_CACHE;
	const key = `${provider}:${modelId}`;
	const ok = await cache.check(key, async () => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), SMOKE_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const text = await complete({
				system: "Reply with the single word OK.",
				user: "ping",
				modelId,
				signal: controller.signal,
			});
			return text.trim() !== "";
		} catch {
			// reason: any failure of the probe means the model is not usable here
			return false;
		} finally {
			clearTimeout(timer);
			ctx.signal?.removeEventListener("abort", onAbort);
		}
	});
	// An aborted caller says nothing about the model: do not remember a failure it caused.
	if (!ok && ctx.signal?.aborted) cache.forget(key);
	return ok;
}

/** Resolves the model the ToT PRD stage runs on. A missing price and a missing official economy alias block the stage; they do not substitute the selected model. */
export async function resolveToTModel(ctx: ToTRouteContext): Promise<ModelChoice> {
	const host = ctx.host ?? detectHost();
	const tot = ctx.config.models.tot;
	const selectedId = ctx.selected.modelId;
	const selectedProvider = providerFamily(ctx.selected.provider, selectedId, host);
	const provider = selectedProvider ?? "unknown";

	const finish = (decision: Decision): ModelChoice => {
		logDecision(ctx, host, decision, selectedId);
		return decision.choice;
	};
	const selected = (reason: string, warning: boolean): ModelChoice =>
		finish({
			choice: {
				modelId: selectedId,
				provider,
				source: "selected",
				reason: warning ? `warning: ${reason}` : reason,
			},
			warning,
		});

	const perCall = ctx.canPickModelPerCall ?? TOT_HOST_PER_CALL_MODEL[host] ?? false;
	const override = tot.model.trim();
	if (!perCall) {
		return selected(
			`host limit: host ${host} cannot pick a model per call${override ? "; models.tot.model ignored" : ""}, using the selected model`,
			true,
		);
	}

	if (override) {
		return finish({
			choice: {
				modelId: override,
				provider: providerFamily(undefined, override, host) ?? provider,
				source: "override",
				reason: "models.tot.model",
			},
			warning: false,
		});
	}
	const blocked = (detail: string, source: ModelChoice["source"]): ModelChoice =>
		finish({
			choice: {
				// Not the selected model: a blocked choice must not be run as a guess.
				modelId: "",
				provider,
				source,
				reason: `blocked: ${detail}`,
			},
			warning: true,
		});

	if (selectedProvider === undefined) {
		return blocked(
			"provider of the selected model is unknown; no candidate has both input and output prices and config has no official economy alias",
			"mapping",
		);
	}
	const ranked = tot.candidates[selectedProvider] ?? [];
	const allowlist = new Set<string>();
	for (const ids of Object.values(tot.candidates)) for (const id of ids) allowlist.add(id);

	const tried = new Set<string>();
	const usable = async (modelId: string): Promise<boolean> => {
		tried.add(modelId);
		if (ctx.isAvailable) {
			const available = await safely(() => ctx.isAvailable?.(modelId, selectedProvider));
			if (available !== true) return false;
		}
		return ctx.complete ? smokeCheck(ctx, ctx.complete, selectedProvider, modelId) : true;
	};

	const listed = ctx.listModels ? await safely(ctx.listModels) : undefined;
	if (listed) {
		const rank = (id: string): number => {
			const at = ranked.indexOf(id);
			return at === -1 ? Number.MAX_SAFE_INTEGER : at;
		};
		const eligible = listed
			.filter(
				(entry) =>
					allowlist.has(entry.modelId) &&
					entry.available !== false &&
					hasBothPrices(entry) &&
					providerFamily(entry.provider, entry.modelId, host) === selectedProvider,
			)
			.sort((a, b) => {
				const pa = price(a) ?? 0;
				const pb = price(b) ?? 0;
				if (pa !== pb) return pa - pb;
				return rank(a.modelId) - rank(b.modelId);
			});
		for (const entry of eligible) {
			if (tried.has(entry.modelId)) continue;
			if (await usable(entry.modelId)) {
				const cost = price(entry);
				return finish({
					choice: {
						modelId: entry.modelId,
						provider: selectedProvider,
						source: "host-list",
						reason: `cheapest host-listed candidate (${cost}/MTok)`,
					},
					warning: false,
				});
			}
		}
	}

	const alias = officialEconomyAlias(ranked);
	if (alias !== undefined && !tried.has(alias) && (await usable(alias))) {
		return finish({
			choice: {
				modelId: alias,
				provider: selectedProvider,
				source: "mapping",
				reason: `official economy alias ${alias}`,
			},
			warning: false,
		});
	}
	return blocked(
		"no candidate has both input and output prices and config has no official economy alias",
		listed ? "host-list" : "mapping",
	);
}

interface ToTCompletion {
	readonly text: string;
	/** The model that produced `text`. */
	readonly modelId: string;
	/** True when the selected model answered because the cheap model did not. */
	readonly fallback: boolean;
	/** Model calls made for this item (1, or 2 after a fallback). */
	readonly attempts: number;
}

export interface ToTRouter {
	readonly choice: ModelChoice;
	readonly selectedModelId: string;
	/** Always false: a cheap failure is not promoted onto the selected model. */
	tripped(): boolean;
	complete(input: {
		readonly system: string;
		readonly user: string;
		readonly signal?: AbortSignal;
	}): Promise<ToTCompletion>;
}

export interface ToTRouterOptions {
	readonly choice: ModelChoice;
	readonly selectedModelId: string;
	readonly complete: CompleteFn;
	/** Kept for callers. Cheap failures are not promoted onto the selected model, so this no longer opens a breaker. */
	readonly breakerThreshold: number;
	readonly log?: (line: string) => void;
}

/**
 * Runs ToT items on the resolved model. A `blocked:` choice throws `tot-model-blocked` and does not call the selected
 * model. A cheap-model failure retries that same cheap model once, then throws `tot-model-blocked`. A cancelled call
 * is rethrown and is not a cheap-model failure.
 */
export function createToTRouter(options: ToTRouterOptions): ToTRouter {
	const { choice, selectedModelId, complete, log } = options;
	const cheap = choice.source !== "selected" && choice.modelId !== selectedModelId;

	const emit = (event: string, extra: Record<string, unknown>): void => {
		log?.(
			`tot-model ${JSON.stringify({ event, level: "warn", chosen: choice.modelId, selected: selectedModelId, ...extra })}`,
		);
	};

	return {
		choice,
		selectedModelId,
		tripped: () => false,
		async complete(input) {
			if (choice.reason.startsWith("blocked:")) {
				throw totModelBlocked(choice.reason);
			}
			if (!cheap) {
				const text = await complete({ ...input, modelId: selectedModelId });
				return { text, modelId: selectedModelId, fallback: false, attempts: 1 };
			}
			let last: unknown;
			for (let attempt = 1; attempt <= 2; attempt++) {
				try {
					const text = await complete({ ...input, modelId: choice.modelId });
					return { text, modelId: choice.modelId, fallback: false, attempts: attempt };
				} catch (error) {
					if (input.signal?.aborted) throw error;
					last = error;
					emit("cheap-retry", {
						attempt,
						error: error instanceof Error ? error.name : "error",
					});
				}
			}
			throw totModelBlocked(last instanceof Error ? last.message : "cheap model failed");
		},
	};
}
