// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type ClaudeCompleteOptions, ClaudeResultError } from "../../../src/claude/complete.ts";
import type { GrokCompleteOptions } from "../../../src/grok/complete.ts";
import { DEFAULT_GROK_CONFIG } from "../../../src/grok/types.ts";
import { ROUTE_DEFAULT_MODELS } from "../../../src/route-defaults.ts";
import {
	createPlanBackend,
	PlanCompleterError,
	type PlanBackendOptions,
	type PlanErrorCode,
	type PlanUsage,
} from "./plan.ts";

type Complete = (system: string, user: string, signal?: AbortSignal) => Promise<string>;
type ClaudeSeamOptions = Omit<ClaudeCompleteOptions, "signal">;
type GrokSeamOptions = Omit<GrokCompleteOptions, "signal">;

const FAKE_ENV: Record<string, string | undefined> = {
	PATH: "/usr/bin",
	HOME: "/home/ultrathink",
	TZ: "UTC",
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	TMPDIR: "/tmp",
	XDG_CONFIG_HOME: "/home/ultrathink/.config",
	CLAUDE_CONFIG_DIR: "/home/ultrathink/.claude",
	CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth-token",
	GROK_HOME: "/home/ultrathink/.grok",
	OPENROUTER_API_KEY: "fake-openrouter-key-0123456789",
	ULTRATHINK_SESSION_SECRET: "fake-session-secret",
	ULTRATHINK_OWNER_PASSWORD_HASH: "fake-hash",
	ANTHROPIC_API_KEY: "fake-anthropic-key",
	ANTHROPIC_AUTH_TOKEN: "fake-anthropic-auth",
	SOMETHING_ELSE: "x",
};

function namedError(name: string, message: string, extra: object = {}): Error {
	const error = Object.assign(new Error(message), extra);
	error.name = name;
	return error;
}

interface Harness {
	opts: PlanBackendOptions;
	claudeOpts: ClaudeSeamOptions[];
	grokOpts: GrokSeamOptions[];
}

function harness(
	claude: (opts: ClaudeSeamOptions) => Complete,
	overrides: Partial<PlanBackendOptions> = {},
	grok: (opts: GrokSeamOptions) => Complete = () => async () => "grok",
): Harness {
	const claudeOpts: ClaudeSeamOptions[] = [];
	const grokOpts: GrokSeamOptions[] = [];
	return {
		claudeOpts,
		grokOpts,
		opts: {
			model: "claude-haiku-5-5",
			fallback: "none",
			concurrency: 2,
			timeoutMs: 0,
			env: FAKE_ENV,
			which: () => "/usr/bin/fake",
			claude: (seamOpts) => {
				claudeOpts.push(seamOpts);
				return claude(seamOpts);
			},
			grok: (seamOpts) => {
				grokOpts.push(seamOpts);
				return grok(seamOpts);
			},
			...overrides,
		},
	};
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to fail");
}

describe("child env allowlist", () => {
	test("the claude child gets exactly the allowlisted variables, never server secrets", async () => {
		const h = harness(() => async () => "ok");
		const backend = createPlanBackend({ ...h.opts, timeoutMs: 1234 });
		await backend.complete("s", "u");
		const seam = h.claudeOpts[0];
		expect(seam?.auth).toBe("plan");
		expect(seam?.model).toBe("claude-haiku-5-5");
		expect(seam?.timeoutMs).toBe(1234);
		const env = seam?.env ?? {};
		expect(Object.keys(env).sort()).toEqual(
			[
				"CLAUDE_CODE_OAUTH_TOKEN",
				"CLAUDE_CONFIG_DIR",
				"GROK_HOME",
				"HOME",
				"LANG",
				"LC_ALL",
				"PATH",
				"TMPDIR",
				"TZ",
				"XDG_CONFIG_HOME",
			].sort(),
		);
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fake-oauth-token");
		expect(env.HOME).toBe("/home/ultrathink");
		for (const secret of [
			"OPENROUTER_API_KEY",
			"ULTRATHINK_SESSION_SECRET",
			"ULTRATHINK_OWNER_PASSWORD_HASH",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"SOMETHING_ELSE",
		]) {
			expect(secret in env).toBe(false);
		}
	});

	test("an unset allowlisted variable is absent, not undefined-valued", async () => {
		const h = harness(() => async () => "ok");
		const backend = createPlanBackend({ ...h.opts, env: { PATH: "/usr/bin" } });
		await backend.complete("s", "u");
		expect(h.claudeOpts[0]?.env).toEqual({ PATH: "/usr/bin" });
	});

	test("the grok fallback is given GROK_HOME from the env and never the whole env", () => {
		const h = harness(() => async () => "ok");
		createPlanBackend({ ...h.opts, fallback: "grok" });
		expect(h.grokOpts.length).toBeGreaterThan(0);
		for (const seam of h.grokOpts) {
			expect(seam.transport).toBe("http");
			expect(seam.home).toBe("/home/ultrathink/.grok");
			expect("env" in seam).toBe(false);
		}
	});
});

describe("concurrency semaphore", () => {
	function gated(): {
		complete: Complete;
		started: () => number;
		maxActive: () => number;
		release: (index: number) => void;
	} {
		const gates: Array<() => void> = [];
		let started = 0;
		let active = 0;
		let maxActive = 0;
		return {
			complete: async () => {
				started += 1;
				active += 1;
				maxActive = Math.max(maxActive, active);
				const { promise, resolve } = Promise.withResolvers<void>();
				gates.push(resolve);
				await promise;
				active -= 1;
				return "ok";
			},
			started: () => started,
			maxActive: () => maxActive,
			release: (index) => gates[index]?.(),
		};
	}

	// One macrotask turn: every pending microtask chain settles first.
	const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

	test("concurrency 1 serializes two calls", async () => {
		const g = gated();
		const backend = createPlanBackend(harness(() => g.complete, { concurrency: 1 }).opts);
		const first = backend.complete("s", "a");
		const second = backend.complete("s", "b");
		await tick();
		expect(g.started()).toBe(1);
		g.release(0);
		await first;
		await tick();
		expect(g.started()).toBe(2);
		g.release(1);
		await second;
		expect(g.maxActive()).toBe(1);
	});

	test("concurrency 2 lets two calls run and queues the third", async () => {
		const g = gated();
		const backend = createPlanBackend(harness(() => g.complete, { concurrency: 2 }).opts);
		const calls = [
			backend.complete("s", "a"),
			backend.complete("s", "b"),
			backend.complete("s", "c"),
		];
		await tick();
		expect(g.started()).toBe(2);
		g.release(0);
		await tick();
		expect(g.started()).toBe(3);
		g.release(1);
		g.release(2);
		await Promise.all(calls);
		expect(g.maxActive()).toBe(2);
	});

	test("a failing call releases its slot", async () => {
		let calls = 0;
		const backend = createPlanBackend(
			harness(
				() => async () => {
					calls += 1;
					if (calls === 1) throw new Error("claude output is not JSON");
					return "ok";
				},
				{ concurrency: 1 },
			).opts,
		);
		await failureOf(backend.complete("s", "a"));
		expect(await backend.complete("s", "b")).toBe("ok");
	});

	test("an abort while queued rejects with an aborted error and never starts a child", async () => {
		const g = gated();
		const backend = createPlanBackend(harness(() => g.complete, { concurrency: 1 }).opts);
		const first = backend.complete("s", "a");
		const controller = new AbortController();
		const queued = backend.complete("s", "b", controller.signal);
		await tick();
		controller.abort();
		const error = await failureOf(queued);
		expect(error).toBeInstanceOf(PlanCompleterError);
		expect((error as PlanCompleterError).code).toBe("aborted");
		g.release(0);
		await first;
		expect(g.started()).toBe(1);
		// The aborted waiter must not hold on to the slot: a later call still runs.
		const third = backend.complete("s", "c");
		await tick();
		expect(g.started()).toBe(2);
		g.release(1);
		await third;
	});

	test("an already aborted signal rejects before any slot or child is used", async () => {
		const g = gated();
		const backend = createPlanBackend(harness(() => g.complete).opts);
		const controller = new AbortController();
		controller.abort();
		const error = await failureOf(backend.complete("s", "a", controller.signal));
		expect((error as PlanCompleterError).code).toBe("aborted");
		expect(g.started()).toBe(0);
	});
});

describe("error mapping", () => {
	const table: Array<{
		name: string;
		error: Error;
		code: PlanErrorCode;
		failure: string;
	}> = [
		{
			name: "session limit",
			error: new Error("You've hit your session limit · resets 3:45pm"),
			code: "rate_limited",
			failure: "plan-limit",
		},
		{
			name: "weekly limit",
			error: new Error("You've hit your weekly limit · resets Mon 12:00am"),
			code: "rate_limited",
			failure: "plan-limit",
		},
		{
			name: "billing",
			error: new Error("Credit balance is too low"),
			code: "rate_limited",
			failure: "billing",
		},
		{
			name: "rate limit text",
			error: new Error("Request rejected (429)"),
			code: "rate_limited",
			failure: "rate-limit",
		},
		{
			name: "not logged in",
			error: new Error("Not logged in · Please run /login"),
			code: "auth",
			failure: "auth",
		},
		{
			name: "http 401 result",
			error: new ClaudeResultError("denied", 401),
			code: "auth",
			failure: "auth",
		},
		{
			name: "timeout",
			error: new Error("claude timed out after 90000ms"),
			code: "timeout",
			failure: "timeout",
		},
		{
			name: "abort",
			error: namedError("AbortError", "Aborted"),
			code: "aborted",
			failure: "aborted",
		},
		{
			name: "overloaded status",
			error: new ClaudeResultError("busy", 529),
			code: "upstream",
			failure: "overloaded",
		},
		{
			name: "model unavailable",
			error: new Error(
				"Claude Code v2.1.200 does not support this model; version 2.1.293 or newer is required",
			),
			code: "upstream",
			failure: "model-unavailable",
		},
		{
			name: "network",
			error: new Error("fetch failed"),
			code: "upstream",
			failure: "network",
		},
		{
			name: "missing binary",
			error: namedError("Error", "spawn claude ENOENT", { code: "ENOENT" }),
			code: "upstream",
			failure: "unavailable",
		},
		{
			name: "garbage output",
			error: new Error("claude output is not JSON"),
			code: "upstream",
			failure: "other",
		},
	];

	for (const row of table) {
		test(`${row.name} maps to ${row.code}`, async () => {
			const backend = createPlanBackend(
				harness(() => async () => {
					throw row.error;
				}).opts,
			);
			const error = await failureOf(backend.complete("s", "u"));
			expect(error).toBeInstanceOf(PlanCompleterError);
			const planError = error as PlanCompleterError;
			expect(planError.code).toBe(row.code);
			expect(planError.failure).toBe(row.failure as PlanCompleterError["failure"]);
			expect(planError.name).toBe("PlanCompleterError");
			// The raw CLI text never reaches the message.
			expect(planError.message).toBe(`plan ${row.code}`);
			expect(planError.cause).toBe(row.error);
		});
	}
});

describe("usage reporting", () => {
	test("reports prompt and completion tokens for the call, without a cost", async () => {
		const backend = createPlanBackend(
			harness((seam) => async () => {
				seam.onResult?.({ inputTokens: 120, outputTokens: 34 });
				return "ok";
			}).opts,
		);
		const seen: PlanUsage[] = [];
		await backend.complete("s", "u", undefined, (usage) => seen.push(usage));
		expect(seen).toEqual([{ promptTokens: 120, completionTokens: 34 }]);
		expect("costUsd" in (seen[0] ?? {})).toBe(false);
	});

	test("absent counts stay absent and a result without tokens reports nothing", async () => {
		let step = 0;
		const backend = createPlanBackend(
			harness((seam) => async () => {
				step += 1;
				if (step === 1) seam.onResult?.({ outputTokens: 5 });
				if (step === 2) seam.onResult?.({ model: "claude-haiku-5-5" });
				return "ok";
			}).opts,
		);
		const seen: PlanUsage[] = [];
		await backend.complete("s", "u", undefined, (usage) => seen.push(usage));
		await backend.complete("s", "u", undefined, (usage) => seen.push(usage));
		expect(seen).toEqual([{ completionTokens: 5 }]);
	});

	test("a call without onUsage is fine", async () => {
		const backend = createPlanBackend(
			harness((seam) => async () => {
				seam.onResult?.({ inputTokens: 1, outputTokens: 1 });
				return "ok";
			}).opts,
		);
		expect(await backend.complete("s", "u")).toBe("ok");
	});

	test("concurrent calls each get only their own usage", async () => {
		const fastDone = Promise.withResolvers<void>();
		const backend = createPlanBackend(
			harness(
				(seam) => async (_system, user) => {
					if (user === "slow") await fastDone.promise;
					seam.onResult?.({ inputTokens: user === "slow" ? 100 : 7, outputTokens: 1 });
					if (user === "fast") fastDone.resolve();
					return user;
				},
				{ concurrency: 2 },
			).opts,
		);
		const slow: PlanUsage[] = [];
		const fast: PlanUsage[] = [];
		await Promise.all([
			backend.complete("s", "slow", undefined, (usage) => slow.push(usage)),
			backend.complete("s", "fast", undefined, (usage) => fast.push(usage)),
		]);
		expect(slow).toEqual([{ promptTokens: 100, completionTokens: 1 }]);
		expect(fast).toEqual([{ promptTokens: 7, completionTokens: 1 }]);
	});

	test("a throwing usage hook never changes the outcome", async () => {
		const backend = createPlanBackend(
			harness((seam) => async () => {
				seam.onResult?.({ inputTokens: 1 });
				return "ok";
			}).opts,
		);
		const text = await backend.complete("s", "u", undefined, () => {
			throw new Error("hook");
		});
		expect(text).toBe("ok");
	});

	test("grok fallback tokens are reported too", async () => {
		const backend = createPlanBackend(
			harness(
				() => async () => {
					throw new Error("You've hit your session limit · resets 3:45pm");
				},
				{ fallback: "grok" },
				(seam) => async () => {
					seam.onResult?.({ inputTokens: 9, outputTokens: 2 });
					return "from grok";
				},
			).opts,
		);
		const seen: PlanUsage[] = [];
		expect(await backend.complete("s", "u", undefined, (usage) => seen.push(usage))).toBe(
			"from grok",
		);
		expect(seen).toEqual([{ promptTokens: 9, completionTokens: 2 }]);
	});
});

describe("fallback chain", () => {
	const grokModels = [
		...new Set([ROUTE_DEFAULT_MODELS.grok, ...DEFAULT_GROK_CONFIG.fallbackModels]),
	];

	test("fallback none never builds a grok completer and labels the model", async () => {
		const h = harness(() => async () => "claude says hi");
		const backend = createPlanBackend(h.opts);
		expect(backend.label).toBe("plan:claude-haiku-5-5");
		expect(await backend.complete("s", "u")).toBe("claude says hi");
		expect(h.grokOpts).toEqual([]);
	});

	test("fallback none surfaces a plan-limit as rate_limited without trying grok", async () => {
		const h = harness(() => async () => {
			throw new Error("You've hit your weekly limit · resets Mon 12:00am");
		});
		const error = await failureOf(createPlanBackend(h.opts).complete("s", "u"));
		expect((error as PlanCompleterError).code).toBe("rate_limited");
		expect(h.grokOpts).toEqual([]);
	});

	test("grok fallback builds one completer per unique grok model, in order", () => {
		const h = harness(() => async () => "ok");
		const backend = createPlanBackend({ ...h.opts, fallback: "grok" });
		expect(backend.label).toBe("plan:claude-haiku-5-5+grok");
		expect(h.grokOpts.map((seam) => seam.model)).toEqual(grokModels);
	});

	test("a plan-limit walks claude, then each grok model in order, until one answers", async () => {
		const order: string[] = [];
		const h = harness(
			() => async () => {
				order.push("claude");
				throw new Error("You've hit your session limit · resets 3:45pm");
			},
			{ fallback: "grok" },
			(seam) => async () => {
				order.push(`grok:${seam.model}`);
				if (seam.model === grokModels[0] && grokModels.length > 1) {
					throw namedError(
						"GrokHttpError",
						'grok HTTP 429: {"code":"resource-exhausted","error":"Requests per Minute (actual/limit): 0/0."}',
						{ status: 429 },
					);
				}
				return `answer from ${seam.model}`;
			},
		);
		const backend = createPlanBackend(h.opts);
		const text = await backend.complete("s", "u");
		expect(order).toEqual(["claude", ...grokModels.map((model) => `grok:${model}`)]);
		expect(text).toBe(`answer from ${grokModels[grokModels.length - 1]}`);
	});

	test("an error that is not failover-worthy does not reach grok", async () => {
		const h = harness(
			() => async () => {
				throw new Error("claude output is not JSON");
			},
			{ fallback: "grok" },
		);
		const error = await failureOf(createPlanBackend(h.opts).complete("s", "u"));
		expect((error as PlanCompleterError).code).toBe("upstream");
		const grokCalls: string[] = [];
		const h2 = harness(
			() => async () => {
				throw new Error("claude output is not JSON");
			},
			{ fallback: "grok" },
			() => async () => {
				grokCalls.push("called");
				return "grok";
			},
		);
		await failureOf(createPlanBackend(h2.opts).complete("s", "u"));
		expect(grokCalls).toEqual([]);
	});

	test("every candidate failing maps through the same code table", async () => {
		const h = harness(
			() => async () => {
				throw new Error("You've hit your session limit · resets 3:45pm");
			},
			{ fallback: "grok" },
			() => async () => {
				throw namedError("GrokAuthError", "Grok login missing: run `grok login`");
			},
		);
		const error = await failureOf(createPlanBackend(h.opts).complete("s", "u"));
		expect(error).toBeInstanceOf(PlanCompleterError);
		expect((error as PlanCompleterError).code).toBe("rate_limited");
	});

	test("an abort propagates as aborted and is not retried on grok", async () => {
		const grokCalls: string[] = [];
		const h = harness(
			() => async () => {
				throw namedError("AbortError", "Aborted");
			},
			{ fallback: "grok" },
			() => async () => {
				grokCalls.push("called");
				return "grok";
			},
		);
		const error = await failureOf(createPlanBackend(h.opts).complete("s", "u"));
		expect((error as PlanCompleterError).code).toBe("aborted");
		expect(grokCalls).toEqual([]);
	});
});

describe("ready", () => {
	const claudeOnly = (command: string): string | undefined =>
		command === "claude" ? "/usr/bin/claude" : undefined;

	test("is ok when claude resolves", () => {
		const h = harness(() => async () => "ok", { which: claudeOnly });
		expect(createPlanBackend(h.opts).ready()).toEqual({ ok: true });
	});

	test("is not ok without claude, with a detail", () => {
		const h = harness(() => async () => "ok", { which: () => undefined });
		const ready = createPlanBackend(h.opts).ready();
		expect(ready.ok).toBe(false);
		expect(ready.detail).toContain("claude");
	});

	test("a missing grok adds a detail but stays ok under the grok fallback", () => {
		const h = harness(() => async () => "ok", { which: claudeOnly, fallback: "grok" });
		const ready = createPlanBackend(h.opts).ready();
		expect(ready.ok).toBe(true);
		expect(ready.detail).toContain("grok");
	});

	test("both binaries present under the grok fallback has no detail", () => {
		const h = harness(() => async () => "ok", { fallback: "grok" });
		expect(createPlanBackend(h.opts).ready()).toEqual({ ok: true });
	});

	test("a missing grok is irrelevant without the fallback", () => {
		const h = harness(() => async () => "ok", { which: claudeOnly, fallback: "none" });
		expect(createPlanBackend(h.opts).ready()).toEqual({ ok: true });
	});

	test("which is asked for claude by name", () => {
		const asked: string[] = [];
		const h = harness(() => async () => "ok", {
			which: (command) => {
				asked.push(command);
				return "/usr/bin/x";
			},
		});
		createPlanBackend(h.opts).ready();
		expect(asked).toEqual(["claude"]);
	});
});
