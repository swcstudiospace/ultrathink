// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig } from "../config.ts";
import { ROUTE_DEFAULT_MODELS, TOT_BREAKER_THRESHOLD } from "../route-defaults.ts";
import type { CompleteFn } from "../think/tot/types.ts";
import {
	assertCheapPathAllowed,
	createSmokeCache,
	createToTRouter,
	type HostModelInfo,
	resolveStageModel,
	resolveToTModel,
	type ToTRouteContext,
} from "./cheapest-model.ts";

function configWith(tot?: Record<string, unknown>) {
	return mergeConfig({ models: { tot } }, defaultConfig());
}

function context(overrides: Partial<ToTRouteContext> = {}): ToTRouteContext {
	return {
		config: configWith(),
		selected: { modelId: "claude-opus-5-5", provider: "anthropic" },
		host: "claude-code",
		smokeCache: createSmokeCache(),
		...overrides,
	};
}

const okComplete: CompleteFn = async () => "OK";

describe("resolveToTModel: override precedence", () => {
	test("the user override wins over the host list and the mapping, unprobed", async () => {
		const probed: string[] = [];
		const choice = await resolveToTModel(
			context({
				config: configWith({ model: "my-cheap-model" }),
				listModels: () => [{ modelId: ROUTE_DEFAULT_MODELS.claude, provider: "anthropic" }],
				complete: async ({ modelId }) => {
					probed.push(modelId);
					return "OK";
				},
			}),
		);
		expect(choice).toMatchObject({ modelId: "my-cheap-model", source: "override" });
		expect(probed).toEqual([]);
	});

	test("a blank override in a later layer clears the lower one", async () => {
		const lower = configWith({ model: "pinned" });
		const cleared = mergeConfig({ models: { tot: { model: "  " } } }, lower);
		const choice = await resolveToTModel(context({ config: cleared }));
		expect(choice.source).toBe("mapping");
	});

	test("an override is ignored, with a warning, on a host that cannot pick a model per call", async () => {
		const choice = await resolveToTModel(
			context({ host: "omp", config: configWith({ model: "my-cheap-model" }) }),
		);
		expect(choice).toMatchObject({ modelId: "claude-opus-5-5", source: "selected" });
		expect(choice.reason).toContain("warning:");
		expect(choice.reason).toContain("models.tot.model ignored");
	});
});

describe("resolveToTModel: per-provider defaults", () => {
	test("anthropic resolves to the Haiku-class default", async () => {
		const choice = await resolveToTModel(context());
		expect(choice).toMatchObject({
			modelId: ROUTE_DEFAULT_MODELS.claude,
			provider: "anthropic",
			source: "mapping",
		});
	});

	test("openai, xai and a provider derived from the model id resolve through the mapping", async () => {
		const openai = await resolveToTModel(
			context({ selected: { modelId: "gpt-5", provider: "openai-codex" } }),
		);
		expect(openai).toMatchObject({ modelId: "gpt-5-mini", provider: "openai", source: "mapping" });
		const xai = await resolveToTModel(context({ selected: { modelId: "grok-4" } }));
		expect(xai).toMatchObject({
			modelId: ROUTE_DEFAULT_MODELS.grok,
			provider: "xai",
			source: "mapping",
		});
		const derived = await resolveToTModel(
			context({ selected: { modelId: "anthropic/claude-sonnet-5-5" } }),
		);
		expect(derived).toMatchObject({ modelId: ROUTE_DEFAULT_MODELS.claude, provider: "anthropic" });
	});

	test("cursor resolves through the mapping only when the injected capability says it can pick a model", async () => {
		const capable = await resolveToTModel(
			context({
				host: "cursor",
				canPickModelPerCall: true,
				selected: { modelId: "composer-1" },
			}),
		);
		expect(capable).toMatchObject({ provider: "cursor", source: "mapping" });
	});

	test("config candidates replace a provider's list and an empty list removes it", async () => {
		const replaced = await resolveToTModel(
			context({
				config: configWith({ candidates: { anthropic: ["claude-haiku-x", "claude-haiku-y"] } }),
			}),
		);
		expect(replaced.modelId).toBe("claude-haiku-x");
		const removed = await resolveToTModel(
			context({ config: configWith({ candidates: { anthropic: [] } }) }),
		);
		expect(removed).toMatchObject({ source: "selected", modelId: "claude-opus-5-5" });
		expect(removed.reason).toContain("warning:");
	});
});

describe("resolveToTModel: host list", () => {
	const list: readonly HostModelInfo[] = [
		{
			modelId: "claude-haiku-pricey",
			provider: "anthropic",
			inputPricePerMTok: 1,
			outputPricePerMTok: 5,
		},
		{
			modelId: "claude-haiku-cheap",
			provider: "anthropic",
			inputPricePerMTok: 0.25,
			outputPricePerMTok: 1,
		},
		{
			modelId: "claude-haiku-down",
			provider: "anthropic",
			inputPricePerMTok: 0.01,
			available: false,
		},
		{ modelId: "claude-not-allowlisted", provider: "anthropic", inputPricePerMTok: 0.001 },
		{ modelId: "gpt-5-nano", provider: "openai", inputPricePerMTok: 0.001 },
	];
	const allow = {
		candidates: {
			anthropic: ["claude-haiku-pricey", "claude-haiku-cheap", "claude-haiku-down"],
		},
	};

	test("the cheapest allowlisted, available entry of the selected provider beats the mapping order", async () => {
		const choice = await resolveToTModel(
			context({ config: configWith(allow), listModels: () => list }),
		);
		expect(choice).toMatchObject({ modelId: "claude-haiku-cheap", source: "host-list" });
	});

	test("a failing or empty host list falls through to the mapping", async () => {
		const throwing = await resolveToTModel(
			context({
				config: configWith(allow),
				listModels: () => {
					throw new Error("catalog offline");
				},
			}),
		);
		expect(throwing).toMatchObject({ modelId: "claude-haiku-pricey", source: "mapping" });
		const empty = await resolveToTModel(
			context({ config: configWith(allow), listModels: async () => [] }),
		);
		expect(empty.source).toBe("mapping");
	});

	test("a host-listed model that fails the smoke check is skipped for the next one", async () => {
		const choice = await resolveToTModel(
			context({
				config: configWith(allow),
				listModels: () => list,
				complete: async ({ modelId }) => {
					if (modelId === "claude-haiku-cheap") throw new Error("not callable");
					return "OK";
				},
			}),
		);
		expect(choice).toMatchObject({ modelId: "claude-haiku-pricey", source: "host-list" });
	});

	test("AC-8: alpha at 0.50, beta at 1.00, gamma at 3.00 and delta at 0.50 per MTok input selects alpha", async () => {
		const callable: HostModelInfo[] = [
			{ modelId: "delta", provider: "anthropic", inputPricePerMTok: 0.5 },
			{ modelId: "gamma", provider: "anthropic", inputPricePerMTok: 3 },
			{ modelId: "beta", provider: "anthropic", inputPricePerMTok: 1 },
			{ modelId: "alpha", provider: "anthropic", inputPricePerMTok: 0.5 },
		];
		const choice = await resolveToTModel(
			context({
				config: configWith({ candidates: { anthropic: ["alpha", "beta", "gamma", "delta"] } }),
				listModels: () => callable,
			}),
		);
		expect(choice).toMatchObject({ modelId: "alpha", provider: "anthropic", source: "host-list" });
	});

	test("a tie on input price goes to the earlier configured candidate, whatever order the host lists in", async () => {
		const choice = await resolveToTModel(
			context({
				config: configWith({ candidates: { anthropic: ["delta", "alpha"] } }),
				listModels: () => [
					{ modelId: "alpha", provider: "anthropic", inputPricePerMTok: 0.5 },
					{ modelId: "delta", provider: "anthropic", inputPricePerMTok: 0.5 },
				],
			}),
		);
		expect(choice).toMatchObject({ modelId: "delta", source: "host-list" });
	});

	test("refuses with PRD_NO_PRICE when the callable models of the provider publish no input price", async () => {
		await expect(
			resolveToTModel(
				context({
					config: configWith(allow),
					listModels: () => [
						{ modelId: "claude-haiku-pricey", provider: "anthropic", outputPricePerMTok: 5 },
					],
				}),
			),
		).rejects.toMatchObject({ code: "PRD_NO_PRICE" });
	});
});

describe("resolveToTModel: hosts and providers that cannot be routed", () => {
	test("Cursor and Omp keep the selected model with a warning unless the capability says yes", async () => {
		for (const host of ["cursor", "omp"] as const) {
			const choice = await resolveToTModel(context({ host }));
			expect(choice).toMatchObject({ modelId: "claude-opus-5-5", source: "selected" });
			expect(choice.reason).toStartWith("warning:");
		}
		const allowed = await resolveToTModel(context({ host: "omp", canPickModelPerCall: true }));
		expect(allowed.source).toBe("mapping");
	});

	test("a host that is not Cursor or Omp can be denied by the injected capability", async () => {
		const choice = await resolveToTModel(context({ canPickModelPerCall: false }));
		expect(choice.source).toBe("selected");
		expect(choice.reason).toContain("cannot pick a model per call");
	});

	test("an unknown provider keeps the selected model with a warning", async () => {
		const choice = await resolveToTModel(context({ selected: { modelId: "mystery-model-9" } }));
		expect(choice).toMatchObject({
			modelId: "mystery-model-9",
			provider: "unknown",
			source: "selected",
		});
		expect(choice.reason).toContain("warning:");
	});
});

describe("resolveToTModel: suitability filter", () => {
	test("an unavailable candidate is skipped and the selected model is the last resort", async () => {
		const choice = await resolveToTModel(context({ isAvailable: () => false }));
		expect(choice).toMatchObject({ source: "selected", modelId: "claude-opus-5-5" });
		expect(choice.reason).toContain("warning:");
	});

	test("the smoke check runs once per model through the shared cache", async () => {
		const smokeCache = createSmokeCache();
		let probes = 0;
		const complete: CompleteFn = async () => {
			probes++;
			return "OK";
		};
		await resolveToTModel(context({ smokeCache, complete }));
		await resolveToTModel(context({ smokeCache, complete }));
		expect(probes).toBe(1);
	});

	test("a failed or blank smoke answer rules the candidate out", async () => {
		for (const complete of [
			(async () => {
				throw new Error("401");
			}) as CompleteFn,
			(async () => "   ") as CompleteFn,
		]) {
			const choice = await resolveToTModel(context({ complete }));
			expect(choice.source).toBe("selected");
		}
	});

	test("a cancelled caller does not poison the smoke cache", async () => {
		const smokeCache = createSmokeCache();
		const controller = new AbortController();
		controller.abort();
		await resolveToTModel(
			context({
				smokeCache,
				signal: controller.signal,
				complete: async () => {
					throw new Error("aborted");
				},
			}),
		);
		const again = await resolveToTModel(context({ smokeCache, complete: okComplete }));
		expect(again.source).toBe("mapping");
	});
});

describe("decision log", () => {
	test("writes exactly one structured line per decision and no secrets", async () => {
		const lines: string[] = [];
		await resolveToTModel(context({ log: (line) => lines.push(line) }));
		expect(lines).toHaveLength(1);
		const [line = ""] = lines;
		expect(line.startsWith("tot-model ")).toBe(true);
		const record = JSON.parse(line.slice("tot-model ".length)) as Record<string, unknown>;
		expect(record).toMatchObject({
			event: "resolve",
			host: "claude-code",
			provider: "anthropic",
			selected: "claude-opus-5-5",
			chosen: ROUTE_DEFAULT_MODELS.claude,
			source: "mapping",
		});
		expect(Object.keys(record).some((key) => /key|token|secret/i.test(key))).toBe(false);
	});

	test("a fallback to the selected model logs at warn level", async () => {
		const lines: string[] = [];
		await resolveToTModel(context({ host: "cursor", log: (line) => lines.push(line) }));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('"level":"warn"');
	});
});

describe("GoT and CoT bypass guard", () => {
	test("got and cot keep the selected model and never touch config tiers, host list, availability or probes", async () => {
		let touched = 0;
		const bump = () => {
			touched++;
			throw new Error("the cheap path must not run for this stage");
		};
		const ctx = context({
			config: configWith({ model: "my-cheap-model" }),
			listModels: bump,
			isAvailable: bump,
			complete: async () => {
				bump();
				return "OK";
			},
		});
		for (const stage of ["got", "cot"] as const) {
			const choice = await resolveStageModel(stage, ctx);
			expect(choice).toMatchObject({ modelId: "claude-opus-5-5", source: "selected" });
		}
		expect(touched).toBe(0);
		expect((await resolveStageModel("tot", ctx)).source).toBe("override");
	});

	test("assertCheapPathAllowed rejects got and cot and accepts tot", () => {
		expect(() => assertCheapPathAllowed("got")).toThrow("got");
		expect(() => assertCheapPathAllowed("cot")).toThrow("cot");
		expect(() => assertCheapPathAllowed("tot")).not.toThrow();
	});
});

describe("createToTRouter: per-item fallback and circuit breaker", () => {
	const choice = {
		modelId: "cheap",
		provider: "anthropic",
		source: "mapping",
		reason: "test",
	} as const;
	const input = { system: "s", user: "u" };

	function router(complete: CompleteFn, breakerThreshold = 3, lines: string[] = []) {
		return createToTRouter({
			choice,
			selectedModelId: "selected",
			complete,
			breakerThreshold,
			log: (line) => lines.push(line),
		});
	}

	test("the cheap model answers when healthy", async () => {
		const seen: string[] = [];
		const result = await router(async ({ modelId }) => {
			seen.push(modelId);
			return "doc";
		}).complete(input);
		expect(result).toEqual({ text: "doc", modelId: "cheap", fallback: false, attempts: 1 });
		expect(seen).toEqual(["cheap"]);
	});

	test("one failing item retries on the selected model without tripping the breaker", async () => {
		let first = true;
		const r = router(async ({ modelId }) => {
			if (modelId === "cheap" && first) {
				first = false;
				throw new Error("overloaded");
			}
			return modelId;
		});
		const failed = await r.complete(input);
		expect(failed).toEqual({ text: "selected", modelId: "selected", fallback: true, attempts: 2 });
		expect(r.tripped()).toBe(false);
		const healthy = await r.complete(input);
		expect(healthy.modelId).toBe("cheap");
	});

	test("N consecutive cheap failures send the whole stage to the selected model", async () => {
		const calls: string[] = [];
		const lines: string[] = [];
		const r = router(
			async ({ modelId }) => {
				calls.push(modelId);
				if (modelId === "cheap") throw new Error("down");
				return "ok";
			},
			TOT_BREAKER_THRESHOLD,
			lines,
		);
		for (let item = 0; item < TOT_BREAKER_THRESHOLD; item++) await r.complete(input);
		expect(r.tripped()).toBe(true);
		calls.length = 0;
		const after = await r.complete(input);
		expect(calls).toEqual(["selected"]);
		expect(after).toMatchObject({ modelId: "selected", fallback: true, attempts: 1 });
		expect(lines.filter((line) => line.includes('"event":"breaker-open"'))).toHaveLength(1);
	});

	test("a cheap success resets the consecutive failure count", async () => {
		let n = 0;
		const r = router(async ({ modelId }) => {
			if (modelId !== "cheap") return "ok";
			n++;
			if (n % 3 !== 0) throw new Error("flaky");
			return "ok";
		}, 3);
		// failures: 2, then a success, then 2 again: never 3 in a row
		for (let item = 0; item < 5; item++) await r.complete(input);
		expect(r.tripped()).toBe(false);
	});

	test("a cancelled call is rethrown and never counts against the cheap model", async () => {
		const controller = new AbortController();
		const r = router(async ({ signal }) => {
			controller.abort();
			if (signal?.aborted) throw new Error("aborted");
			return "ok";
		}, 1);
		await expect(r.complete({ ...input, signal: controller.signal })).rejects.toThrow("aborted");
		expect(r.tripped()).toBe(false);
	});

	test("a selected-model choice makes one call and no fallback", async () => {
		const calls: string[] = [];
		const r = createToTRouter({
			choice: { modelId: "selected", provider: "anthropic", source: "selected", reason: "r" },
			selectedModelId: "selected",
			breakerThreshold: 3,
			complete: async ({ modelId }) => {
				calls.push(modelId);
				return "ok";
			},
		});
		const result = await r.complete(input);
		expect(result).toEqual({ text: "ok", modelId: "selected", fallback: false, attempts: 1 });
		expect(calls).toEqual(["selected"]);
	});

	test("when the selected model also fails the item's error surfaces", async () => {
		const r = router(async () => {
			throw new Error("everything is down");
		});
		await expect(r.complete(input)).rejects.toThrow("everything is down");
	});
});
