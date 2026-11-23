// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig } from "../config.ts";
import { DEFAULT_TEACH_CONFIG } from "../teach/types.ts";
import { defaultRecallSettings, parseRecallSettings, type RecallSettings } from "./config.ts";

/** A config-file root holding `value` at `path`, e.g. `["recall", "enabled"]`. */
function withField(path: string[], value: unknown): Record<string, unknown> {
	return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<
		string,
		unknown
	>;
}

function valueAt(settings: RecallSettings, path: string[]): unknown {
	return path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], settings);
}

const SOURCE_KEYS = ["knowledge", "lessons", "moments", "skills"];
const TRIGGER_KEYS = ["scopeChange", "failure", "phaseBoundary", "uncertainty", "explicit"];

/** Every new field with its default and values that must fall back to it. */
const FIELDS: { path: string[]; fallback: unknown; invalid: unknown[] }[] = [
	{ path: ["knowledge", "probeRecord"], fallback: true, invalid: ["yes", 1, null] },
	{ path: ["recall", "enabled"], fallback: false, invalid: ["true", 1, null] },
	{ path: ["recall", "injectNew"], fallback: false, invalid: ["true", 1, null] },
	...SOURCE_KEYS.map((key) => ({
		path: ["recall", "sources", key],
		fallback: false,
		invalid: ["true", 1, null],
	})),
	...TRIGGER_KEYS.map((key) => ({
		path: ["recall", "triggers", key],
		fallback: false,
		invalid: ["true", 1, null],
	})),
	{
		path: ["recall", "cooldownMs", "scopeChange"],
		fallback: 300_000,
		invalid: ["300000", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "cooldownMs", "failure"],
		fallback: 300_000,
		invalid: ["300000", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "cooldownMs", "uncertainty"],
		fallback: 60_000,
		invalid: ["60000", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "budget", "perTurnCalls"],
		fallback: 2,
		invalid: ["2", 0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "budget", "perTurnTokens"],
		fallback: 1_500,
		invalid: ["1500", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "budget", "perSessionCalls"],
		fallback: 20,
		invalid: ["20", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "budget", "perSessionTokens"],
		fallback: 8_000,
		invalid: ["8000", 0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "budget", "reservedShare"],
		fallback: 0.3,
		invalid: ["0.3", 1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY],
	},
	{
		path: ["recall", "timeoutMs"],
		fallback: 2_500,
		invalid: ["2500", 0, -1, 0.5, Number.NaN],
	},
	{
		path: ["recall", "relevanceFloor", "lessons"],
		fallback: 0.5,
		invalid: ["0.5", 1.01, -0.01, Number.NaN],
	},
	{ path: ["skills", "authoring", "enabled"], fallback: false, invalid: ["true", 1, null] },
	{
		path: ["skills", "authoring", "activation"],
		fallback: "draft",
		invalid: ["DRAFT", "on", 1, null],
	},
	{ path: ["panels", "informationPanels"], fallback: true, invalid: ["true", 1, null] },
];

describe("recall settings defaults", () => {
	test("every new key has its documented default", () => {
		expect(defaultRecallSettings()).toEqual({
			knowledge: { probeRecord: true },
			recall: {
				enabled: false,
				injectNew: false,
				sources: { knowledge: false, lessons: false, moments: false, skills: false },
				triggers: {
					scopeChange: false,
					failure: false,
					phaseBoundary: false,
					uncertainty: false,
					explicit: false,
				},
				cooldownMs: { scopeChange: 300_000, failure: 300_000, uncertainty: 60_000 },
				budget: {
					perTurnCalls: 2,
					perTurnTokens: 1_500,
					perSessionCalls: 20,
					perSessionTokens: 8_000,
					reservedShare: 0.3,
				},
				timeoutMs: 2_500,
				relevanceFloor: { lessons: 0.5 },
			},
			skills: { authoring: { enabled: false, activation: "draft" } },
			panels: { informationPanels: true },
		});
	});

	test("each call returns a fresh object", () => {
		const first = defaultRecallSettings();
		first.recall.enabled = true;
		first.recall.sources.lessons = true;
		expect(defaultRecallSettings().recall.enabled).toBe(false);
		expect(defaultRecallSettings().recall.sources.lessons).toBe(false);
	});

	test("the wired config carries the defaults and leaves existing defaults unchanged", () => {
		const config = defaultConfig();
		expect(config.recallSettings).toEqual(defaultRecallSettings());
		expect(config.hitl.knowledgeBase).toBe(false);
		expect(DEFAULT_TEACH_CONFIG.recallLimit).toBe(5);
		expect(DEFAULT_TEACH_CONFIG.promoteAfter).toBe(3);
		expect(DEFAULT_TEACH_CONFIG.autoPromote).toBe(true);
		expect(DEFAULT_TEACH_CONFIG.timeoutMs).toBe(2_500);
	});
});

describe("recall settings parsing", () => {
	for (const field of FIELDS) {
		test(`${field.path.join(".")} falls back to its default for invalid values`, () => {
			for (const bad of field.invalid) {
				const settings = parseRecallSettings(withField(field.path, bad));
				expect(valueAt(settings, field.path)).toEqual(field.fallback);
			}
		});
	}

	test("a valid override is honoured for every key", () => {
		const override = {
			knowledge: { probeRecord: false },
			recall: {
				enabled: true,
				injectNew: true,
				sources: { knowledge: true, lessons: true, moments: true, skills: true },
				triggers: {
					scopeChange: true,
					failure: true,
					phaseBoundary: true,
					uncertainty: true,
					explicit: true,
				},
				cooldownMs: { scopeChange: 1_000, failure: 2_000, uncertainty: 3_000 },
				budget: {
					perTurnCalls: 4,
					perTurnTokens: 900,
					perSessionCalls: 50,
					perSessionTokens: 12_000,
					reservedShare: 0.5,
				},
				timeoutMs: 1_200,
				relevanceFloor: { lessons: 0.8 },
			},
			skills: { authoring: { enabled: true, activation: "active" as const } },
			panels: { informationPanels: true },
		};
		expect(parseRecallSettings(override)).toEqual(override);
	});

	test("reservedShare outside [0, 1] falls back, and the bounds are accepted", () => {
		expect(parseRecallSettings(withField(["recall", "budget", "reservedShare"], 1.5))).toEqual(
			defaultRecallSettings(),
		);
		expect(parseRecallSettings(withField(["recall", "budget", "reservedShare"], -0.1))).toEqual(
			defaultRecallSettings(),
		);
		for (const edge of [0, 1]) {
			const settings = parseRecallSettings(withField(["recall", "budget", "reservedShare"], edge));
			expect(settings.recall.budget.reservedShare).toBe(edge);
		}
	});

	test("counts and durations are floored and clamped to their maximum", () => {
		const parsed = parseRecallSettings({
			recall: {
				timeoutMs: 60_000,
				cooldownMs: { scopeChange: 1e12 },
				budget: {
					perTurnCalls: 2.9,
					perTurnTokens: 1e9,
					perSessionCalls: 999,
					perSessionTokens: 1e9,
				},
			},
		});
		expect(parsed.recall.timeoutMs).toBe(30_000);
		expect(parsed.recall.cooldownMs.scopeChange).toBe(86_400_000);
		expect(parsed.recall.budget.perTurnCalls).toBe(2);
		expect(parsed.recall.budget.perTurnTokens).toBe(20_000);
		expect(parsed.recall.budget.perSessionCalls).toBe(200);
		expect(parsed.recall.budget.perSessionTokens).toBe(200_000);
	});

	test("non-object input and non-object sections yield the defaults without throwing", () => {
		for (const input of [undefined, null, "recall", 42, [], { recall: 5, knowledge: [] }]) {
			expect(() => parseRecallSettings(input)).not.toThrow();
			expect(parseRecallSettings(input)).toEqual(defaultRecallSettings());
		}
	});

	test("a partial file overrides only the fields it names", () => {
		const parsed = parseRecallSettings({ recall: { enabled: true } });
		expect(parsed.recall.enabled).toBe(true);
		expect(parsed.recall.timeoutMs).toBe(2_500);
		expect(parsed.panels.informationPanels).toBe(true);
	});

	test("an invalid field keeps the base value, not the built-in default", () => {
		const base = defaultRecallSettings();
		base.recall.timeoutMs = 900;
		base.recall.enabled = true;
		const parsed = parseRecallSettings({ recall: { timeoutMs: "x" } }, base);
		expect(parsed.recall.timeoutMs).toBe(900);
		expect(parsed.recall.enabled).toBe(true);
	});
});

describe("recall settings wiring", () => {
	test("a user file sets the new section through the top-level config", () => {
		const config = mergeConfig(
			{ recall: { enabled: true }, panels: { informationPanels: true } },
			defaultConfig(),
		);
		expect(config.recallSettings.recall.enabled).toBe(true);
		expect(config.recallSettings.panels.informationPanels).toBe(true);
	});

	test("a project file cannot set the new section", () => {
		const config = mergeConfig(
			{ recall: { enabled: true }, skills: { authoring: { enabled: true } } },
			defaultConfig(),
			{ project: true },
		);
		expect(config.recallSettings).toEqual(defaultRecallSettings());
	});

	test("a project file cannot turn on recall.enabled or recall.injectNew", () => {
		const config = mergeConfig({ recall: { enabled: true, injectNew: true } }, defaultConfig(), {
			project: true,
		});
		expect(config.recallSettings.recall.enabled).toBe(false);
		expect(config.recallSettings.recall.injectNew).toBe(false);
	});
});
