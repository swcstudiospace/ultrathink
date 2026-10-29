// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Effect, Rule } from "./provider.ts";

/** The ten invariants the oracle asserts for every prompt of a run. */
export const INVARIANT_IDS = [
	"terminal",
	"original",
	"uplift",
	"degraded",
	"cot",
	"isolation",
	"resources",
	"recovery",
	"persisted",
	"calls",
] as const;

export type InvariantId = (typeof INVARIANT_IDS)[number];

export interface Scenario {
	id: string;
	title: string;
	failureMode: "pipeline-load";
	seed: number;
	prompts: { count: number; concurrency: number; corpus?: string[] };
	faults: Rule[];
	pressure: { cpuWorkers: number; duty: number; memMB: number };
	config: {
		claudeConcurrency?: number;
		thinkMinNodes?: number;
		thinkMaxNodes?: number;
		hitl?: boolean;
		track?: boolean;
	};
	invariants: InvariantId[];
	/** Base of the JS heap growth allowance in MiB for the `resources` invariant; 64 KiB per prompt is added. Default 64. */
	resourceSlackMiB?: number;
	/** Per-prompt real-time watchdog in ms (the hang detector). Default: the larger of 120000 and 4000 per concurrent slot. */
	watchdogMs?: number;
	/** A prompt the watchdog aborts is a violation unless an injected `hang` targeted it; true accepts any abort. */
	allowAborts?: boolean;
	/** Recovery only: the scenario whose recorded probe latency the post-load probe is compared with. */
	baselineOf?: string;
}

type Fields = Record<string, unknown>;

const FAILURE_MODES = ["pipeline-load"] as const;
const STAGES = ["uplift", "graph", "fill", "clarify"] as const;
const EFFECT_KINDS = [
	"ok",
	"delay",
	"error",
	"network",
	"empty",
	"truncate",
	"garbage",
	"hang",
] as const;
const NETWORK_CODES = ["ECONNRESET", "ETIMEDOUT"] as const;

const SCENARIO_KEYS = [
	"id",
	"title",
	"failureMode",
	"seed",
	"prompts",
	"faults",
	"pressure",
	"config",
	"invariants",
	"resourceSlackMiB",
	"watchdogMs",
	"allowAborts",
	"baselineOf",
];
const PROMPTS_KEYS = ["count", "concurrency", "corpus"];
const RULE_KEYS = ["stage", "node", "promptId", "nth", "every", "effect", "count"];
const PRESSURE_KEYS = ["cpuWorkers", "duty", "memMB"];
const CONFIG_KEYS = ["claudeConcurrency", "thinkMinNodes", "thinkMaxNodes", "hitl", "track"];
const EFFECT_KEYS: Record<(typeof EFFECT_KINDS)[number], readonly string[]> = {
	ok: ["kind"],
	delay: ["kind", "ms", "after"],
	error: ["kind", "status", "retryAfterSec", "message"],
	network: ["kind", "code"],
	empty: ["kind"],
	truncate: ["kind", "at"],
	garbage: ["kind", "text"],
	hang: ["kind"],
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const NODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE_PATTERN = /^pl-\d+-\d{6}$/;

const MAX_PROMPTS = 5000;
const MAX_CONCURRENCY = 128;
const MAX_CORPUS = 200;
const MAX_CORPUS_TEXT = 2000;
const MAX_FAULTS = 200;
const MAX_TEXT = 200;
const MAX_DELAY_DEPTH = 3;

function asRecord(value: unknown, path: string): Fields {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value as Fields;
}

function rejectUnknown(fields: Fields, path: string, allowed: readonly string[]): void {
	for (const key of Object.keys(fields)) {
		if (!allowed.includes(key)) {
			throw new TypeError(`${path === "" ? "" : `${path}.`}${key} is not a known field`);
		}
	}
}

function asString(
	value: unknown,
	path: string,
	min: number,
	max: number,
	pattern?: RegExp,
): string {
	if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
	if (value.length < min || value.length > max) {
		throw new RangeError(`${path} must be ${min} to ${max} characters`);
	}
	if (pattern !== undefined && !pattern.test(value)) {
		throw new TypeError(`${path} must match ${pattern.source}`);
	}
	return value;
}

function asInteger(value: unknown, path: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new TypeError(`${path} must be an integer`);
	}
	if (value < min || value > max) throw new RangeError(`${path} must be between ${min} and ${max}`);
	return value;
}

function asBoolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new TypeError(`${path} must be true or false`);
	return value;
}

function asEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
		throw new TypeError(`${path} must be one of ${allowed.join(", ")}`);
	}
	return value as T;
}

function asArray(value: unknown, path: string, min: number, max: number): unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
	if (value.length < min || value.length > max) {
		throw new RangeError(`${path} must hold ${min} to ${max} entries`);
	}
	return value;
}

function parseEffect(value: unknown, path: string, depth: number): Effect {
	const fields = asRecord(value, path);
	const kind = asEnum(fields.kind, `${path}.kind`, EFFECT_KINDS);
	rejectUnknown(fields, path, EFFECT_KEYS[kind]);
	switch (kind) {
		case "ok":
		case "empty":
		case "hang":
			return { kind };
		case "delay": {
			if (depth >= MAX_DELAY_DEPTH) throw new RangeError(`${path}.after is nested too deeply`);
			const ms = asInteger(fields.ms, `${path}.ms`, 0, 600_000);
			if (fields.after === undefined) return { kind, ms };
			return { kind, ms, after: parseEffect(fields.after, `${path}.after`, depth + 1) };
		}
		case "error": {
			const effect: Extract<Effect, { kind: "error" }> = { kind };
			if (fields.status !== undefined) {
				effect.status = asInteger(fields.status, `${path}.status`, 400, 599);
			}
			if (fields.retryAfterSec !== undefined) {
				effect.retryAfterSec = asInteger(fields.retryAfterSec, `${path}.retryAfterSec`, 0, 3600);
			}
			if (fields.message !== undefined) {
				effect.message = asString(fields.message, `${path}.message`, 1, MAX_TEXT);
			}
			return effect;
		}
		case "network":
			return { kind, code: asEnum(fields.code, `${path}.code`, NETWORK_CODES) };
		case "truncate":
			return { kind, at: asInteger(fields.at, `${path}.at`, 0, 1_000_000) };
		case "garbage":
			return { kind, text: asString(fields.text, `${path}.text`, 0, 10_000) };
	}
}

function parseNth(value: unknown, path: string): number | [number, number] {
	if (!Array.isArray(value)) return asInteger(value, path, 1, 1_000_000);
	const pair = asArray(value, path, 2, 2);
	const from = asInteger(pair[0], `${path}[0]`, 1, 1_000_000);
	const to = asInteger(pair[1], `${path}[1]`, 1, 1_000_000);
	if (from > to) throw new RangeError(`${path} must be an ascending pair`);
	return [from, to];
}

function parseRule(value: unknown, path: string): Rule {
	const fields = asRecord(value, path);
	rejectUnknown(fields, path, RULE_KEYS);
	const rule: Rule = {
		stage: asEnum(fields.stage, `${path}.stage`, STAGES),
		effect: parseEffect(fields.effect, `${path}.effect`, 0),
	};
	if (fields.node !== undefined)
		rule.node = asString(fields.node, `${path}.node`, 1, 64, NODE_PATTERN);
	if (fields.promptId !== undefined) {
		rule.promptId =
			typeof fields.promptId === "string"
				? asString(fields.promptId, `${path}.promptId`, 1, 64, NONCE_PATTERN)
				: asInteger(fields.promptId, `${path}.promptId`, 0, MAX_PROMPTS);
	}
	if (fields.nth !== undefined) rule.nth = parseNth(fields.nth, `${path}.nth`);
	if (fields.every !== undefined) rule.every = asInteger(fields.every, `${path}.every`, 1, 100_000);
	if (fields.count !== undefined) {
		rule.count =
			fields.count === "forever"
				? "forever"
				: asInteger(fields.count, `${path}.count`, 1, 1_000_000);
	}
	return rule;
}

function parsePrompts(value: unknown): Scenario["prompts"] {
	const fields = asRecord(value, "prompts");
	rejectUnknown(fields, "prompts", PROMPTS_KEYS);
	const prompts: Scenario["prompts"] = {
		count: asInteger(fields.count, "prompts.count", 1, MAX_PROMPTS),
		concurrency: asInteger(fields.concurrency, "prompts.concurrency", 1, MAX_CONCURRENCY),
	};
	if (fields.corpus !== undefined) {
		const entries = asArray(fields.corpus, "prompts.corpus", 1, MAX_CORPUS);
		prompts.corpus = entries.map((entry, index) =>
			asString(entry, `prompts.corpus[${index}]`, 0, MAX_CORPUS_TEXT),
		);
	}
	return prompts;
}

function parsePressure(value: unknown): Scenario["pressure"] {
	if (value === undefined) return { cpuWorkers: 0, duty: 0, memMB: 0 };
	const fields = asRecord(value, "pressure");
	rejectUnknown(fields, "pressure", PRESSURE_KEYS);
	const duty = fields.duty ?? 0;
	if (typeof duty !== "number" || !Number.isFinite(duty)) {
		throw new TypeError("pressure.duty must be a finite number");
	}
	if (duty < 0 || duty > 1) throw new RangeError("pressure.duty must be between 0 and 1");
	return {
		cpuWorkers: asInteger(fields.cpuWorkers ?? 0, "pressure.cpuWorkers", 0, 256),
		duty,
		memMB: asInteger(fields.memMB ?? 0, "pressure.memMB", 0, 4096),
	};
}

function parseConfig(value: unknown): Scenario["config"] {
	if (value === undefined) return {};
	const fields = asRecord(value, "config");
	rejectUnknown(fields, "config", CONFIG_KEYS);
	const config: Scenario["config"] = {};
	if (fields.claudeConcurrency !== undefined) {
		config.claudeConcurrency = asInteger(
			fields.claudeConcurrency,
			"config.claudeConcurrency",
			1,
			16,
		);
	}
	if (fields.thinkMinNodes !== undefined) {
		config.thinkMinNodes = asInteger(fields.thinkMinNodes, "config.thinkMinNodes", 1, 20);
	}
	if (fields.thinkMaxNodes !== undefined) {
		config.thinkMaxNodes = asInteger(fields.thinkMaxNodes, "config.thinkMaxNodes", 1, 20);
	}
	if (
		config.thinkMinNodes !== undefined &&
		config.thinkMaxNodes !== undefined &&
		config.thinkMinNodes > config.thinkMaxNodes
	) {
		throw new RangeError("config.thinkMinNodes must not exceed config.thinkMaxNodes");
	}
	if (fields.hitl !== undefined) config.hitl = asBoolean(fields.hitl, "config.hitl");
	if (fields.track !== undefined) config.track = asBoolean(fields.track, "config.track");
	return config;
}

function buildScenario(json: unknown): Scenario {
	const fields = asRecord(json, "scenario");
	rejectUnknown(fields, "", SCENARIO_KEYS);
	const seed = fields.seed;
	if (typeof seed !== "number" || !Number.isSafeInteger(seed) || seed < 0) {
		throw new TypeError("seed must be a non-negative safe integer");
	}
	const invariants = asArray(fields.invariants, "invariants", 1, INVARIANT_IDS.length).map(
		(entry, index) => asEnum(entry, `invariants[${index}]`, INVARIANT_IDS),
	);
	if (new Set(invariants).size !== invariants.length) {
		throw new TypeError("invariants must not repeat an id");
	}
	const scenario: Scenario = {
		id: asString(fields.id, "id", 3, 64, ID_PATTERN),
		title: asString(fields.title, "title", 1, 200),
		failureMode: asEnum(fields.failureMode, "failureMode", FAILURE_MODES),
		seed,
		prompts: parsePrompts(fields.prompts),
		faults:
			fields.faults === undefined
				? []
				: asArray(fields.faults, "faults", 0, MAX_FAULTS).map((rule, index) =>
						parseRule(rule, `faults[${index}]`),
					),
		pressure: parsePressure(fields.pressure),
		config: parseConfig(fields.config),
		invariants,
	};
	if (fields.watchdogMs !== undefined) {
		scenario.watchdogMs = asInteger(fields.watchdogMs, "watchdogMs", 1000, 3_600_000);
	}
	if (fields.allowAborts !== undefined) {
		scenario.allowAborts = asBoolean(fields.allowAborts, "allowAborts");
	}
	if (fields.resourceSlackMiB !== undefined) {
		scenario.resourceSlackMiB = asInteger(fields.resourceSlackMiB, "resourceSlackMiB", 1, 4096);
	}
	if (fields.baselineOf !== undefined) {
		scenario.baselineOf = asString(fields.baselineOf, "baselineOf", 3, 64, ID_PATTERN);
	}
	return scenario;
}

/**
 * Validates untrusted JSON into a Scenario. Wrong shapes throw `TypeError`, out-of-range values throw `RangeError`.
 * The message starts with `source` and names the field path (for example `prompts.count`), never the value.
 */
export function parseScenario(json: unknown, source: string): Scenario {
	try {
		return buildScenario(json);
	} catch (error) {
		if (error instanceof TypeError || error instanceof RangeError) {
			error.message = `${source}: ${error.message}`;
		}
		throw error;
	}
}

function parseJsonFile(source: string): unknown {
	const text = readFileSync(source, "utf8");
	try {
		return JSON.parse(text);
	} catch {
		throw new SyntaxError(`${source}: not valid JSON`);
	}
}

/**
 * Reads every `*.json` file in `dir`, in file-name order, validates each one and returns the scenarios sorted by id.
 * Duplicate ids are rejected; other files are ignored.
 */
export function parseScenarios(dir: string): Scenario[] {
	const names = readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
	const sourceById = new Map<string, string>();
	const scenarios: Scenario[] = [];
	for (const name of names) {
		const source = join(dir, name);
		const scenario = parseScenario(parseJsonFile(source), source);
		const first = sourceById.get(scenario.id);
		if (first !== undefined) {
			throw new TypeError(`${source}: id "${scenario.id}" duplicates ${first}`);
		}
		sourceById.set(scenario.id, source);
		scenarios.push(scenario);
	}
	return scenarios.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
