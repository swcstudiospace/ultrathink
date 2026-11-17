// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Model routing for the Tree-of-Thought (ToT) PRD stage. ToT writes many small, structured documents, so it may run on a
 * cheaper model than the one the user selected. GoT and CoT never may: they keep the selected model and never reach this
 * path (`resolveStageModel` and `assertCheapPathAllowed` are the guard).
 *
 * Resolution order for ToT, first hit wins:
 *   1. the user's override (`models.tot.model`), used as written;
 *   2. the host's own model list and pricing, when the caller injects one: the cheapest allowlisted entry of the selected
 *      model's provider, by input price (an exact tie goes to the earlier model of the configured candidates). A listed
 *      provider whose callable models publish no input price refuses with `PRD_NO_PRICE` (a `TotRefusal`);
 *   3. the configured per-provider candidate list for tier "prd" (`models.tot.candidates`, defaults in `route-defaults.ts`);
 *   4. the selected model.
 * Steps 2 and 3 only offer a model that is on the allowlist (every id in the candidate map), reported available by the
 * host and answered a one-time smoke check. A host that cannot pick a model per call, an unknown provider or a missing
 * candidate resolves to the selected model with a warning in `reason`.
 *
 * At run time `createToTRouter` falls back to the selected model per item when the cheap model fails, and a circuit
 * breaker moves the whole stage to the selected model after N consecutive cheap failures.
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

/** The codes of a ToT refusal: the stage writes no PRD and reports the code as its `error`. */
export const PRD_NO_PRICE = "PRD_NO_PRICE";
export const PRD_NO_SELECTED_MODEL = "PRD_NO_SELECTED_MODEL";

export type TotRefusalCode = typeof PRD_NO_PRICE | typeof PRD_NO_SELECTED_MODEL;

/** A ToT refusal. Its message is the code, so the code reads the same wherever it is logged or returned. */
export class TotRefusal extends Error {
	readonly code: TotRefusalCode;

	constructor(code: TotRefusalCode) {
		super(code);
		this.name = "TotRefusal";
		this.code = code;
	}
}

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

/**
 * Resolves the model the ToT PRD stage runs on. Never throws for a host or probe failure: it falls back to the selected
 * model. The one refusal is a `TotRefusal` with `PRD_NO_PRICE`, thrown when the host lists callable models of the
 * provider and none publishes an input price.
 */
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
			`host ${host} cannot pick a model per call${override ? "; models.tot.model ignored" : ""}, using the selected model`,
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

	if (selectedProvider === undefined) {
		return selected("provider of the selected model is unknown, using the selected model", true);
	}
	const ranked = tot.candidates[selectedProvider] ?? [];
	if (ranked.length === 0) {
		return selected(`no tot candidates configured for provider ${selectedProvider}`, true);
	}
	// The configured callable list in config order: the allowlist, and the tie order of host-listed candidates.
	const allowlist = new Map<string, number>();
	for (const ids of Object.values(tot.candidates)) {
		for (const id of ids) if (!allowlist.has(id)) allowlist.set(id, allowlist.size);
	}

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
		const eligible = listed.filter(
			(entry) =>
				allowlist.has(entry.modelId) &&
				entry.available !== false &&
				providerFamily(entry.provider, entry.modelId, host) === selectedProvider,
		);
		// Callable models are listed, but none publishes an input price: there is no cheapest one to pick.
		if (eligible.length > 0 && eligible.every((entry) => entry.inputPricePerMTok === undefined)) {
			throw new TotRefusal(PRD_NO_PRICE);
		}
		// Cheapest input price first. An exact tie goes to the earlier model of the configured callable list, never to
		// the order the host lists models in.
		const priced = eligible.flatMap((entry) => {
			if (entry.inputPricePerMTok === undefined) return [];
			const order = allowlist.get(entry.modelId) ?? Number.MAX_SAFE_INTEGER;
			return [{ entry, price: entry.inputPricePerMTok, order }];
		});
		priced.sort((a, b) => a.price - b.price || a.order - b.order);
		for (const { entry, price } of priced) {
			if (tried.has(entry.modelId)) continue;
			if (await usable(entry.modelId)) {
				return finish({
					choice: {
						modelId: entry.modelId,
						provider: selectedProvider,
						source: "host-list",
						reason: `cheapest host-listed candidate (${price}/MTok input)`,
					},
					warning: false,
				});
			}
		}
	}

	for (const modelId of ranked) {
		if (tried.has(modelId)) continue;
		if (await usable(modelId)) {
			return finish({
				choice: {
					modelId,
					provider: selectedProvider,
					source: "mapping",
					reason: `models.tot.candidates.${selectedProvider}`,
				},
				warning: false,
			});
		}
	}
	return selected(`no ${selectedProvider} tot candidate passed availability and smoke check`, true);
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
	/** True once the circuit breaker moved the whole stage to the selected model. */
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
	/** Consecutive cheap failures that trip the breaker; at least 1. */
	readonly breakerThreshold: number;
	readonly log?: (line: string) => void;
}

/**
 * Runs ToT items on the resolved model. A cheap-model failure retries the same item once on the selected model; after
 * `breakerThreshold` consecutive cheap failures every later item goes straight to the selected model. A cheap success
 * resets the count. A cancelled call is rethrown and never counts against the cheap model.
 */
export function createToTRouter(options: ToTRouterOptions): ToTRouter {
	const { choice, selectedModelId, complete, log } = options;
	const threshold = Math.max(1, Math.floor(options.breakerThreshold));
	const cheap = choice.source !== "selected" && choice.modelId !== selectedModelId;
	let consecutiveFailures = 0;
	let open = false;

	const emit = (event: string, extra: Record<string, unknown>): void => {
		log?.(
			`tot-model ${JSON.stringify({ event, level: "warn", chosen: choice.modelId, selected: selectedModelId, ...extra })}`,
		);
	};

	return {
		choice,
		selectedModelId,
		tripped: () => open,
		async complete(input) {
			if (!cheap || open) {
				const text = await complete({ ...input, modelId: selectedModelId });
				return { text, modelId: selectedModelId, fallback: cheap, attempts: 1 };
			}
			try {
				const text = await complete({ ...input, modelId: choice.modelId });
				consecutiveFailures = 0;
				return { text, modelId: choice.modelId, fallback: false, attempts: 1 };
			} catch (error) {
				if (input.signal?.aborted) throw error;
				consecutiveFailures++;
				const tripping = consecutiveFailures >= threshold;
				emit("fallback", {
					consecutiveFailures,
					error: error instanceof Error ? error.name : "error",
				});
				if (tripping && !open) {
					open = true;
					emit("breaker-open", { consecutiveFailures, threshold });
				}
			}
			const text = await complete({ ...input, modelId: selectedModelId });
			return { text, modelId: selectedModelId, fallback: true, attempts: 2 };
		},
	};
}
