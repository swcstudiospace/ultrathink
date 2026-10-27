// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { grokEngineLabel } from "./label.ts";
import { DEFAULT_GROK_CONFIG, grokSupportsEffort, grokWireEffort } from "./types.ts";

describe("grokSupportsEffort", () => {
	test("true only for grok-4.5/4.6/4.7 families, case and whitespace tolerant", () => {
		for (const model of ["grok-4.5", "grok-4.6", "grok-4.7", "grok-4.7-latest", " GROK-4.7 "])
			expect(grokSupportsEffort(model)).toBe(true);
		for (const model of [
			"grok-build-0.1",
			"grok-code-fast-1",
			"grok-4.20-0309-reasoning",
			"grok-4.3",
			"grok-4.50",
			"",
		])
			expect(grokSupportsEffort(model)).toBe(false);
	});
});

describe("grokWireEffort", () => {
	test("maps per model", () => {
		expect(grokWireEffort("grok-4.7", "xhigh")).toBe("xhigh");
		expect(grokWireEffort("grok-4.5", "xhigh")).toBe("high");
		expect(grokWireEffort("grok-4.6", "low")).toBe("low");
		expect(grokWireEffort("grok-build-0.1", "xhigh")).toBeUndefined();
	});
});

describe("DEFAULT_GROK_CONFIG", () => {
	test("defaults to grok-build-0.1 with grok-4.7 as fallback", () => {
		expect(DEFAULT_GROK_CONFIG.model).toBe(ROUTE_DEFAULT_MODELS.grok);
		expect(DEFAULT_GROK_CONFIG.model).toBe("grok-build-0.1");
		expect(DEFAULT_GROK_CONFIG.fallbackModels).toEqual(["grok-4.7"]);
	});
});

describe("grokEngineLabel", () => {
	test("default config yields the Grok route default (grok-build-0.1) with no effort suffix", () => {
		expect(grokEngineLabel(DEFAULT_GROK_CONFIG)).toBe(ROUTE_DEFAULT_MODELS.grok);
		expect(grokEngineLabel(DEFAULT_GROK_CONFIG)).toBe("grok-build-0.1");
	});

	test("a model with effort support shows @effort", () => {
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, model: "grok-4.7" })).toBe("grok-4.7@xhigh");
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, model: "grok-4.5" })).toBe("grok-4.5@high");
	});

	test("cli transport uses model@effort for effort-capable models", () => {
		expect(
			grokEngineLabel({
				...DEFAULT_GROK_CONFIG,
				model: "grok-4.6",
				transport: "cli",
				reasoningEffort: "high",
			}),
		).toBe("grok-4.6@high");
	});

	test("shunt transport yields <shuntModel>@shunt", () => {
		expect(
			grokEngineLabel({
				...DEFAULT_GROK_CONFIG,
				transport: "shunt",
				shuntModel: "grok-shunt-route",
			}),
		).toBe("grok-shunt-route@shunt");
		expect(
			grokEngineLabel({
				...DEFAULT_GROK_CONFIG,
				transport: "shunt",
				model: "grok-4.6",
				shuntModel: "grok-4.7",
			}),
		).toBe("grok-4.7@shunt");
	});

	test("shunt transport with no shuntModel falls back to model", () => {
		expect(grokEngineLabel({ ...DEFAULT_GROK_CONFIG, transport: "shunt" })).toBe(
			"grok-build-0.1@shunt",
		);
		expect(
			grokEngineLabel({
				...DEFAULT_GROK_CONFIG,
				transport: "shunt",
				model: "grok-4.6",
				shuntModel: "  ",
			}),
		).toBe("grok-4.6@shunt");
	});
});
