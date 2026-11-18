// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig } from "../config.ts";
import type { CompleteFn } from "../think/tot/types.ts";
import { createSmokeCache, resolveToTModel, type ToTRouteContext } from "./cheapest-model.ts";

function context(overrides: Partial<ToTRouteContext> = {}): ToTRouteContext {
	return {
		config: mergeConfig(
			{ models: { tot: { candidates: { anthropic: ["claude-haiku-cheap"] } } } },
			defaultConfig(),
		),
		selected: { modelId: "claude-opus-5-5", provider: "anthropic" },
		host: "claude-code",
		smokeCache: createSmokeCache(),
		...overrides,
	};
}

describe("smoke cache: failed probes are not remembered", () => {
	test("after a failed probe, the next call probes again and can succeed", async () => {
		const smokeCache = createSmokeCache();
		let probes = 0;
		let healthy = false;
		const complete: CompleteFn = async () => {
			probes++;
			if (!healthy) throw new Error("timeout");
			return "OK";
		};

		const first = await resolveToTModel(context({ smokeCache, complete }));
		expect(first.source).toBe("selected");
		expect(probes).toBe(1);

		healthy = true;
		const second = await resolveToTModel(context({ smokeCache, complete }));
		expect(probes).toBe(2);
		expect(second).toMatchObject({ modelId: "claude-haiku-cheap", source: "mapping" });
	});

	test("a false result is forgotten and a true result is kept", async () => {
		const cache = createSmokeCache();
		let runs = 0;
		expect(
			await cache.check("anthropic:m", async () => {
				runs++;
				return false;
			}),
		).toBe(false);
		expect(
			await cache.check("anthropic:m", async () => {
				runs++;
				return true;
			}),
		).toBe(true);
		expect(
			await cache.check("anthropic:m", async () => {
				runs++;
				return false;
			}),
		).toBe(true);
		expect(runs).toBe(2);
	});

	test("callers that joined a failed in-flight probe get a fresh probe on their next call", async () => {
		const cache = createSmokeCache();
		const { promise: pending, resolve: release } = Promise.withResolvers<boolean>();
		let runs = 0;
		const failing = () => {
			runs++;
			return pending;
		};

		const joined = Promise.all([
			cache.check("anthropic:m", failing),
			cache.check("anthropic:m", failing),
		]);
		release(false);
		expect(await joined).toEqual([false, false]);
		expect(runs).toBe(1);

		expect(
			await cache.check("anthropic:m", async () => {
				runs++;
				return true;
			}),
		).toBe(true);
		expect(runs).toBe(2);
	});
});
