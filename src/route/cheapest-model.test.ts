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
		expect(choice.reason.startsWith("blocked:")).toBe(true);
		expect(choice.modelId).not.toBe("claude-opus-5-5");
		expect(choice.source).not.toBe("selected");
	});

	test("an override is ignored, with a warning, on a host that cannot pick a model per call", async () => {
		const choice = await resolveToTModel(
			context({ host: "omp", config: configWith({ model: "my-cheap-model" }) }),
		);
		expect(choice).toMatchObject({ modelId: "claude-opus-5-5", source: "selected" });
		expect(choice.reason).toContain("host limit");
		expect(choice.reason).toContain("warning:");
		expect(choice.reason).toContain("models.tot.model ignored");
	});
});

describe("resolveToTModel: per-provider defaults", () => {
	test("a placeholder candidate without prices is blocked, not substituted for the selected model", async () => {
		const choice = await resolveToTModel(context());
		expect(choice.reason.startsWith("blocked:")).toBe(true);
		expect(choice.modelId).not.toBe("claude-opus-5-5");
		expect(choice.modelId).not.toBe(ROUTE_DEFAULT_MODELS.claude);
		expect(choice.source).not.toBe("selected");
	});

	test("openai, xai and a derived provider are blocked when prices and an official alias are missing", async () => {
		const openai = await resolveToTModel(
			context({ selected: { modelId: "gpt-5", provider: "openai-codex" } }),
		);
		expect(openai.reason.startsWith("blocked:")).toBe(true);
		expect(openai.modelId).not.toBe("gpt-5");
		const xai = await resolveToTModel(context({ selected: { modelId: "grok-4" } }));
		expect(xai.reason.startsWith("blocked:")).toBe(true);
		expect(xai.modelId).not.toBe("grok-4");
		const derived = await resolveToTModel(
			context({ selected: { modelId: "anthropic/claude-sonnet-5-5" } }),
		);
		expect(derived.reason.startsWith("blocked:")).toBe(true);
		expect(derived.modelId).not.toBe("anthropic/claude-sonnet-5-5");
	});

	test("a host that can pick still does not guess a cursor placeholder", async () => {
		const capable = await resolveToTModel(
			context({
				host: "cursor",
				canPickModelPerCall: true,
				selected: { modelId: "composer-1" },
			}),
		);
		expect(capable.reason.startsWith("blocked:")).toBe(true);
		expect(capable.modelId).not.toBe("composer-1");
		expect(capable.source).not.toBe("selected");
	});

	test("a configured id without prices is not an official economy alias, and an empty list blocks", async () => {
		const replaced = await resolveToTModel(
			context({
				config: configWith({ candidates: { anthropic: ["claude-haiku-x", "claude-haiku-y"] } }),
			}),
		);
		expect(replaced.reason.startsWith("blocked:")).toBe(true);
		expect(replaced.modelId).not.toBe("claude-opus-5-5");
		const removed = await resolveToTModel(
			context({ config: configWith({ candidates: { anthropic: [] } }) }),
		);
		expect(removed.reason.startsWith("blocked:")).toBe(true);
		expect(removed.modelId).not.toBe("claude-opus-5-5");
		expect(removed.source).not.toBe("selected");
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

	test("a failing or empty host list does not guess an unpriced mapping id", async () => {
		const throwing = await resolveToTModel(
			context({
				config: configWith(allow),
				listModels: () => {
					throw new Error("catalog offline");
				},
			}),
		);
		expect(throwing.reason.startsWith("blocked:")).toBe(true);
		expect(throwing.modelId).not.toBe("claude-opus-5-5");
		const empty = await resolveToTModel(
			context({ config: configWith(allow), listModels: async () => [] }),
		);
		expect(empty.reason.startsWith("blocked:")).toBe(true);
		expect(empty.source).not.toBe("selected");
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
});

describe("resolveToTModel: hosts and providers that cannot be routed", () => {
	test("Cursor and Omp keep the selected model as a host limit unless they can pick per call", async () => {
		for (const host of ["cursor", "omp"] as const) {
			const choice = await resolveToTModel(context({ host }));
			expect(choice).toMatchObject({ modelId: "claude-opus-5-5", source: "selected" });
			expect(choice.reason).toStartWith("warning:");
			expect(choice.reason).toContain("host limit");
		}
		const allowed = await resolveToTModel(context({ host: "omp", canPickModelPerCall: true }));
		expect(allowed.reason.startsWith("blocked:")).toBe(true);
		expect(allowed.modelId).not.toBe("claude-opus-5-5");
		expect(allowed.source).not.toBe("selected");
	});
	test("a host that is not Cursor or Omp can be denied by the injected capability", async () => {
		const choice = await resolveToTModel(context({ canPickModelPerCall: false }));
		expect(choice.source).toBe("selected");
		expect(choice.reason).toContain("host limit");
		expect(choice.reason).toContain("cannot pick a model per call");
	});
});

describe("resolveToTModel: suitability filter", () => {
	const priced = {
		config: configWith({ candidates: { anthropic: ["claude-haiku-cheap"] } }),
		listModels: () => [
			{
				modelId: "claude-haiku-cheap",
				provider: "anthropic",
				inputPricePerMTok: 0.25,
				outputPricePerMTok: 1,
			},
		],
	};

	test("an unavailable placeholder is blocked instead of substituting the selected model", async () => {
		const choice = await resolveToTModel(context({ isAvailable: () => false }));
		expect(choice.reason.startsWith("blocked:")).toBe(true);
		expect(choice.modelId).not.toBe("claude-opus-5-5");
		expect(choice.source).not.toBe("selected");
	});

	test("the smoke check runs once per priced model through the shared cache", async () => {
		const smokeCache = createSmokeCache();
		let probes = 0;
		const complete: CompleteFn = async () => {
			probes++;
			return "OK";
		};
		await resolveToTModel(context({ ...priced, smokeCache, complete }));
		await resolveToTModel(context({ ...priced, smokeCache, complete }));
		expect(probes).toBe(1);
	});

	test("a failed or blank smoke answer does not substitute the selected model", async () => {
		for (const complete of [
			(async () => {
				throw new Error("401");
			}) as CompleteFn,
			(async () => "   ") as CompleteFn,
		]) {
			const choice = await resolveToTModel(context({ ...priced, complete }));
			expect(choice.reason.startsWith("blocked:")).toBe(true);
			expect(choice.modelId).not.toBe("claude-opus-5-5");
		}
	});

	test("a cancelled caller does not poison the smoke cache", async () => {
		const smokeCache = createSmokeCache();
		const controller = new AbortController();
		controller.abort();
		await resolveToTModel(
			context({
				...priced,
				smokeCache,
				signal: controller.signal,
				complete: async () => {
					throw new Error("aborted");
				},
			}),
		);
		const again = await resolveToTModel(context({ ...priced, smokeCache, complete: okComplete }));
		expect(again).toMatchObject({ modelId: "claude-haiku-cheap", source: "host-list" });
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
			chosen: "",
			source: "mapping",
		});
		expect(String(record.reason).startsWith("blocked:")).toBe(true);
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

describe("createToTRouter: cheap retry without promotion", () => {
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

	test("one cheap failure retries the same model once and does not call the selected model", async () => {
		const seen: string[] = [];
		let first = true;
		const r = router(async ({ modelId }) => {
			seen.push(modelId);
			if (modelId === "cheap" && first) {
				first = false;
				throw new Error("overloaded");
			}
			return modelId;
		});
		const recovered = await r.complete(input);
		expect(recovered).toEqual({ text: "cheap", modelId: "cheap", fallback: false, attempts: 2 });
		expect(seen).toEqual(["cheap", "cheap"]);
		expect(r.tripped()).toBe(false);
	});

	test("repeated cheap failures throw tot-model-blocked and never call the selected model", async () => {
		const calls: string[] = [];
		const lines: string[] = [];
		const r = router(
			async ({ modelId }) => {
				calls.push(modelId);
				throw new Error("down");
			},
			TOT_BREAKER_THRESHOLD,
			lines,
		);
		for (let item = 0; item < TOT_BREAKER_THRESHOLD; item++) {
			await expect(r.complete(input)).rejects.toThrow("tot-model-blocked");
		}
		expect(r.tripped()).toBe(false);
		expect(calls.every((id) => id === "cheap")).toBe(true);
		expect(calls).toHaveLength(TOT_BREAKER_THRESHOLD * 2);
		expect(lines.some((line) => line.includes("breaker-open"))).toBe(false);
	});

	test("a cancelled call is rethrown and is not retried as a cheap failure", async () => {
		const controller = new AbortController();
		const seen: string[] = [];
		const r = router(async ({ modelId, signal }) => {
			seen.push(modelId);
			controller.abort();
			if (signal?.aborted) throw new Error("aborted");
			return "ok";
		}, 1);
		await expect(r.complete({ ...input, signal: controller.signal })).rejects.toThrow("aborted");
		expect(seen).toEqual(["cheap"]);
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

	test("a blocked choice throws tot-model-blocked and does not call any model", async () => {
		const calls: string[] = [];
		const r = createToTRouter({
			choice: {
				modelId: "",
				provider: "anthropic",
				source: "mapping",
				reason: "blocked: no prices and no official economy alias",
			},
			selectedModelId: "selected",
			breakerThreshold: 3,
			complete: async ({ modelId }) => {
				calls.push(modelId);
				return "ok";
			},
		});
		await expect(r.complete(input)).rejects.toThrow("tot-model-blocked");
		expect(calls).toEqual([]);
	});

	test("a cheap model that keeps failing throws tot-model-blocked, not the selected model's error", async () => {
		const r = router(async ({ modelId }) => {
			throw new Error(modelId === "cheap" ? "cheap down" : "everything is down");
		});
		await expect(r.complete(input)).rejects.toThrow("tot-model-blocked");
	});
});
