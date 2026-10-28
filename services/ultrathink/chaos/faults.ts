// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeResultError, createClaudeCompleter } from "../../../src/claude/complete.ts";
import type { PlanBackend, PlanBackendOptions } from "../engine/plan.ts";
import { isRecord } from "../../../src/shared.ts";

/**
 * Fault plans for the upstream seam. A plan is ordered steps; each plan call consumes one unit of the current step,
 * and after the last step calls pass through to the real `claude` child. No randomness, no clock assertions.
 *
 * The faults live inside `createPlanBackend`'s `claude` seam, below the backend's own timer and semaphore. A `latency`
 * or `blackhole` fault is a shim executable that the real completer spawns in place of `claude`, so the real
 * `timeoutMs` kill and the caller's `signal` are what end it, and a broken timeout fails the experiment instead of
 * being papered over by a timer of the fault's own.
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

/** The `claude` seam of `createPlanBackend`: builds the completer for one attempt. */
export type FaultyClaudeFactory = NonNullable<PlanBackendOptions["claude"]>;

export interface FaultyClaudeOptions {
	/** Directory for the generated shim scripts. Owned by this wrapper; created by the caller. */
	dir: string;
	/** The executable real (passing) calls and a finished latency run; default `claude` on the child's PATH. */
	bin?: string;
	/** Test seam; default `createClaudeCompleter`. */
	base?: FaultyClaudeFactory;
}

/** Quotes `value` as one POSIX shell word. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wraps the `claude` seam so that each call consumes one unit of the plan. The plan is copied, so later mutation of
 * the caller's object has no effect.
 *
 * - `status` throws the error the CLI raises for an API failure (`ClaudeResultError` with the status), so the backend
 *   classifies it exactly as a real one: 401/403 `auth`, 402 and 429 `rate_limited`, anything else `upstream`.
 * - `reset` throws a network error, class `upstream`.
 * - `blackhole` runs a shim that never answers: only the backend's `timeoutMs` kill (`timeout`) or the caller's
 *   `signal` (`aborted`) ends it, and with neither the call hangs, as a silent upstream would.
 * - `latency` runs a shim that sleeps `ms` and then execs the real binary with the same arguments and stdin, so the
 *   delay sits inside the same timed section as the real call: a delay past `timeoutMs` times out and the real binary
 *   is never started.
 */
export function createFaultyClaude(
	plan: FaultPlan,
	options: FaultyClaudeOptions,
): FaultyClaudeFactory {
	const base = options.base ?? createClaudeCompleter;
	const realBin = options.bin ?? "claude";
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

	const written = new Set<string>();
	const shim = (name: string, body: string): string => {
		const path = join(options.dir, name);
		if (!written.has(path)) {
			writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
			written.add(path);
		}
		return path;
	};

	return (opts) => async (system, user, signal) => {
		const fault = nextFault();
		const run = (bin: string): Promise<string> => base({ ...opts, bin })(system, user, signal);
		if (fault === undefined || fault.kind === "pass") {
			return run(realBin);
		}
		switch (fault.kind) {
			case "status":
				throw new ClaudeResultError(`injected status ${fault.status}`, fault.status);
			case "reset":
				throw new Error("fetch failed: injected reset");
			case "blackhole":
				// exec, so the kill lands on the sleeper itself and closes the child's pipes.
				return run(shim("blackhole.sh", "exec sleep 86400"));
			case "latency":
				// The sleep's fds are detached: a timed-out shell is killed but its sleeper lives on, and an
				// inherited pipe would keep the caller waiting for the full delay.
				return run(
					shim(
						`latency-${fault.ms}.sh`,
						`sleep ${fault.ms / 1000} >/dev/null 2>&1\nexec ${shellQuote(realBin)} "$@"`,
					),
				);
		}
	};
}

function errorCode(error: unknown): string {
	if (isRecord(error) && typeof error.code === "string") {
		return error.code;
	}
	return "read failed";
}

/**
 * The chaos gate. Returns `undefined` unless `chaosEnabled` is exactly true, and then never calls `build`. Otherwise
 * reads and validates the plan at `chaosPlanPath` and returns `build(claude)`: the caller creates the real plan
 * backend with the faulty `claude` seam (so the real backend is built only when chaos is active). Shim scripts go in
 * `<stateDir>/chaos-shims`. A missing or invalid plan throws an Error that names the path and the reason; it never
 * includes the plan contents (JSON syntax errors are replaced by a fixed message for the same reason).
 */
export function loadChaosBackend(
	config: { chaosEnabled?: boolean; chaosPlanPath?: string; stateDir: string },
	build: (claude: FaultyClaudeFactory) => PlanBackend,
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
	const dir = join(config.stateDir, "chaos-shims");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return build(createFaultyClaude(plan, { dir }));
}
