// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { readFileSync } from "node:fs";
import { type PlanBackend, PlanCompleterError } from "../engine/plan.ts";
import { isRecord } from "../../../src/shared.ts";

/**
 * Fault plans for the upstream seam. A plan is ordered steps; each call through the faulty backend consumes one unit
 * of the current step, and after the last step calls pass through to the inner backend. No randomness, no clock
 * assertions: latency and blackhole faults honour the call's `signal` (and the backend timeout for a blackhole), so the
 * caller's own timeout is the behaviour under test.
 *
 * Plan errors name the offending field path and never echo the plan's values, so a rejected plan cannot leak its
 * contents into a log line.
 */

type Fault =
	| { kind: "pass" }
	| { kind: "status"; status: number }
	| { kind: "reset" }
	| { kind: "blackhole" }
	| { kind: "latency"; ms: number };

export interface FaultStep {
	count: number | "forever";
	fault: Fault;
}

export interface FaultPlan {
	steps: FaultStep[];
}

const MAX_STEPS = 100;
const MAX_STATUS = 599;
const MIN_ERROR_STATUS = 400;
const MAX_LATENCY_MS = 60_000;
const FAULT_KINDS = ["pass", "status", "reset", "blackhole", "latency"] as const;

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortedError(): PlanCompleterError {
	return new PlanCompleterError("aborted", "aborted");
}

/** Resolves after `ms`, or early when `signal` aborts; the caller checks the signal to tell the two apart. */
function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted === true) {
		resolve();
		return promise;
	}
	const done = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal?.addEventListener("abort", done, { once: true });
	return promise;
}

/** Never resolves; rejects with an `aborted` plan error as soon as `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	if (signal.aborted) {
		reject(abortedError());
		return promise;
	}
	signal.addEventListener("abort", () => reject(abortedError()), { once: true });
	return promise;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value;
}

function rejectUnknownKeys(
	record: Record<string, unknown>,
	path: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new TypeError(`${path}.${key} is not a known field`);
		}
	}
}

function expectNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${path} must be a number`);
	}
	return value;
}

function expectInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new TypeError(`${path} must be an integer`);
	}
	return value;
}

function expectRange(value: number, path: string, min: number, max: number): void {
	if (value < min || value > max) {
		throw new RangeError(`${path} must be between ${min} and ${max}`);
	}
}

function parseCount(value: unknown, path: string): number | "forever" {
	if (value === "forever") {
		return "forever";
	}
	const count = expectInteger(value, path);
	if (count < 1 || count > Number.MAX_SAFE_INTEGER) {
		throw new RangeError(`${path} must be a positive safe integer`);
	}
	return count;
}

function parseFault(value: unknown, path: string): Fault {
	const fault = expectRecord(value, path);
	switch (fault.kind) {
		case "pass":
		case "reset":
		case "blackhole":
			rejectUnknownKeys(fault, path, ["kind"]);
			return { kind: fault.kind };
		case "status": {
			rejectUnknownKeys(fault, path, ["kind", "status"]);
			const status = expectInteger(fault.status, `${path}.status`);
			expectRange(status, `${path}.status`, MIN_ERROR_STATUS, MAX_STATUS);
			return { kind: "status", status };
		}
		case "latency": {
			rejectUnknownKeys(fault, path, ["kind", "ms"]);
			const ms = expectNumber(fault.ms, `${path}.ms`);
			expectRange(ms, `${path}.ms`, 0, MAX_LATENCY_MS);
			return { kind: "latency", ms };
		}
		default:
			throw new TypeError(`${path}.kind must be one of ${FAULT_KINDS.join(", ")}`);
	}
}

function parseStep(value: unknown, path: string, last: boolean): FaultStep {
	const step = expectRecord(value, path);
	rejectUnknownKeys(step, path, ["count", "fault"]);
	const count = parseCount(step.count, `${path}.count`);
	if (count === "forever" && !last) {
		throw new RangeError(`${path}.count "forever" is only allowed on the last step`);
	}
	return { count, fault: parseFault(step.fault, `${path}.fault`) };
}

/**
 * Validates untrusted JSON into a FaultPlan. Wrong shapes throw `TypeError`, out-of-range values throw `RangeError`;
 * the message names the field path (for example `steps[1].fault.status`) and not the value.
 */
export function parseFaultPlan(json: unknown): FaultPlan {
	const plan = expectRecord(json, "plan");
	rejectUnknownKeys(plan, "plan", ["steps"]);
	if (!Array.isArray(plan.steps)) {
		throw new TypeError("steps must be an array");
	}
	const entries: unknown[] = plan.steps;
	if (entries.length < 1 || entries.length > MAX_STEPS) {
		throw new RangeError(`steps must hold between 1 and ${MAX_STEPS} entries`);
	}
	const steps = entries.map((entry, index) =>
		parseStep(entry, `steps[${index}]`, index === entries.length - 1),
	);
	return { steps };
}

/** Maps an injected HTTP status onto the class the plan backend would have reported for the same upstream answer. */
function statusError(status: number): PlanCompleterError {
	if (status === 401 || status === 403) {
		return new PlanCompleterError("auth", "auth");
	}
	if (status === 429) {
		return new PlanCompleterError("rate_limited", "rate-limit");
	}
	return new PlanCompleterError("upstream", status >= 500 ? "unavailable" : "other");
}

export interface FaultyBackendOptions {
	/** Replaces the real timer behind `latency` and the blackhole timeout; tests inject one that never waits on the clock. */
	sleep?: Sleep;
	/** The plan backend's per-call timer (config `modelTimeoutMs`); 0 or absent = none, so only the caller's signal ends a blackhole. */
	timeoutMs?: number;
}

/**
 * Wraps `inner` so that each call consumes one unit of the plan. The plan is copied, so later mutation of the caller's
 * object has no effect. Consumption happens synchronously when the call is made, so concurrent calls take units in
 * call order. `label` and `ready` delegate to `inner`; only `complete` is faulted. Injected failures are thrown as the
 * `PlanCompleterError` the real backend would have thrown, so the planner's breaker, metrics and outcome codes see them
 * exactly like a real upstream failure.
 */
export function createFaultyBackend(
	plan: FaultPlan,
	inner: PlanBackend,
	opts: FaultyBackendOptions = {},
): PlanBackend {
	const sleep = opts.sleep ?? waitFor;
	const timeoutMs = opts.timeoutMs ?? 0;
	const steps: FaultStep[] = plan.steps.map((step) => ({ count: step.count, fault: step.fault }));
	let index = 0;
	let used = 0;
	const nextFault = (): Fault | undefined => {
		while (index < steps.length) {
			const step = steps[index];
			if (step === undefined) {
				break;
			}
			if (step.count === "forever") {
				return step.fault;
			}
			if (used < step.count) {
				used += 1;
				return step.fault;
			}
			index += 1;
			used = 0;
		}
		return undefined;
	};

	// A silent upstream ends the way the real backend's call does: its own timer says `timeout`, the caller's signal says `aborted`.
	const blackhole = async (signal: AbortSignal | undefined): Promise<never> => {
		if (timeoutMs > 0) {
			await sleep(timeoutMs, signal);
			if (signal?.aborted === true) {
				throw abortedError();
			}
			throw new PlanCompleterError("timeout", "timeout");
		}
		if (signal === undefined) {
			throw new Error(
				"blackhole fault needs a way to end: the call has no signal and timeoutMs is 0",
			);
		}
		return untilAborted(signal);
	};

	return {
		label: inner.label,
		ready: () => inner.ready(),
		async complete(system, user, signal, hooks) {
			const fault = nextFault();
			if (fault === undefined || fault.kind === "pass") {
				return inner.complete(system, user, signal, hooks);
			}
			switch (fault.kind) {
				case "status":
					throw statusError(fault.status);
				case "reset":
					throw new PlanCompleterError("upstream", "network");
				case "blackhole":
					return blackhole(signal);
				case "latency":
					await sleep(fault.ms, signal);
					if (signal?.aborted === true) {
						throw abortedError();
					}
					return inner.complete(system, user, signal, hooks);
			}
		},
	};
}

function errorCode(error: unknown): string {
	if (isRecord(error) && typeof error.code === "string") {
		return error.code;
	}
	return "read failed";
}

/**
 * The chaos gate. Returns `undefined` unless `chaosEnabled` is exactly true. Otherwise reads and validates the plan at
 * `chaosPlanPath` and returns the faulty wrapper around `inner` (the caller builds the real plan backend, and only when
 * chaos is active). A missing or invalid plan throws an Error that names the path and the reason; it never includes
 * the plan contents (JSON syntax errors are replaced by a fixed message for the same reason).
 */
export function loadChaosBackend(
	config: { chaosEnabled?: boolean; chaosPlanPath?: string; modelTimeoutMs?: number },
	inner: PlanBackend,
	readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): PlanBackend | undefined {
	if (config.chaosEnabled !== true) {
		return undefined;
	}
	const path = config.chaosPlanPath;
	if (path === undefined) {
		throw new Error("chaos is enabled but no fault plan path is set");
	}
	let text: string;
	try {
		text = readText(path);
	} catch (error) {
		throw new Error(`chaos fault plan ${path} cannot be read (${errorCode(error)})`);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`chaos fault plan ${path} is not valid JSON`);
	}
	let plan: FaultPlan;
	try {
		plan = parseFaultPlan(json);
	} catch (error) {
		throw new Error(
			`chaos fault plan ${path} is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
		);
	}
	return createFaultyBackend(
		plan,
		inner,
		config.modelTimeoutMs === undefined ? {} : { timeoutMs: config.modelTimeoutMs },
	);
}
