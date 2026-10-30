// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	classifyFailure,
	type FailureClass,
	failureCooldownMs,
	isFailoverWorthy,
} from "./classify.ts";

type Extra = { name?: string; apiErrorStatus?: number; status?: number; code?: string };

function err(message: string, extra: Extra = {}): Error {
	return Object.assign(new Error(message), extra);
}

const XAI_BODY = (limit: string) =>
	`grok HTTP 429: {"code":"resource-exhausted","error":"Too many requests for team 0f3a and model grok-build-0.1. Your team's rate limit is \u2014 Requests per Minute (actual/limit): ${limit}. Your rate limit tier is determined based on your historical API spend."}`;

const CORPUS: readonly [string, Error, FailureClass][] = [
	// Claude plan limits
	["session limit", err("You've hit your session limit \u00b7 resets 3:45pm"), "plan-limit"],
	["weekly limit", err("You've hit your weekly limit \u00b7 resets Mon 12:00am"), "plan-limit"],
	["Opus limit", err("You've hit your Opus limit \u00b7 resets 3:45pm"), "plan-limit"],
	["Sonnet limit", err("You've hit your Sonnet limit \u00b7 resets 3:45pm"), "plan-limit"],
	["monthly spend limit", err("You've hit your monthly spend limit"), "plan-limit"],
	["spend limit reached", err("spend limit reached"), "plan-limit"],
	[
		"typographic apostrophe",
		err("You\u2019ve hit your session limit \u00b7 resets 3:45pm"),
		"plan-limit",
	],
	["upper case", err("YOU'VE HIT YOUR WEEKLY LIMIT"), "plan-limit"],
	// billing
	["credit balance", err("Credit balance is too low"), "billing"],
	["usage credits", err("Usage credits required for 1M context"), "billing"],
	["status 402", err("payment", { apiErrorStatus: 402 }), "billing"],
	// auth
	["not logged in", err("Not logged in \u00b7 Please run /login"), "auth"],
	["login expired", err("Login expired \u00b7 Please run /login"), "auth"],
	["invalid api key", err("Invalid API key \u00b7 Please run /login"), "auth"],
	["invalid x-api-key", err("invalid x-api-key"), "auth"],
	[
		"claude status 401",
		err("request failed", { name: "ClaudeResultError", apiErrorStatus: 401 }),
		"auth",
	],
	["grok http 401", err("denied", { name: "GrokHttpError", status: 401 }), "auth"],
	[
		"grok login missing",
		err("Grok login missing: run `grok login`", { name: "GrokAuthError" }),
		"auth",
	],
	[
		"grok login expired",
		err("Grok login expired: run `grok login`", { name: "GrokAuthError" }),
		"auth",
	],
	[
		"grok login rejected",
		err("Grok login rejected (HTTP 401): token revoked", { name: "GrokAuthError" }),
		"auth",
	],
	["GrokAuthError by name only", err("something else", { name: "GrokAuthError" }), "auth"],
	// model-unavailable
	[
		"old Claude Code",
		err("Claude Code v2.1.200 does not support this model; version 2.1.293 or newer is required"),
		"model-unavailable",
	],
	[
		"xAI entitlement 429 (limit 0)",
		err(XAI_BODY("0/0"), { name: "GrokHttpError", status: 429 }),
		"model-unavailable",
	],
	[
		"grok subscription 403",
		err(
			`grok HTTP 403: {"code":"permission-denied","error":"The model 'grok-build' requires a Grok subscription."}`,
			{ name: "GrokHttpError", status: 403 },
		),
		"model-unavailable",
	],
	[
		"grok cli unknown model",
		err(
			`Couldn't set model 'grok-build-0.1': Invalid params: "unknown model id". Run 'grok models' to see available models.`,
		),
		"model-unavailable",
	],
	[
		"claude selected model missing",
		err(
			"There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.",
		),
		"model-unavailable",
	],
	[
		"claude selected model missing (typographic apostrophe)",
		err(
			"There\u2019s an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it. Run --model to pick a different model.",
		),
		"model-unavailable",
	],
	[
		"model access sentence alone, upper case",
		err("IT MAY NOT EXIST OR YOU MAY NOT HAVE ACCESS TO IT"),
		"model-unavailable",
	],
	// rate-limit
	["request rejected 429", err("Request rejected (429)"), "rate-limit"],
	["temporarily limiting", err("Server is temporarily limiting requests"), "rate-limit"],
	[
		"xAI ordinary 429 (61/60)",
		err(XAI_BODY("61/60"), { name: "GrokHttpError", status: 429 }),
		"rate-limit",
	],
	[
		"claude status 429",
		err("slow down", { name: "ClaudeResultError", apiErrorStatus: 429 }),
		"rate-limit",
	],
	// overloaded
	["status 529", err("busy", { name: "ClaudeResultError", apiErrorStatus: 529 }), "overloaded"],
	["overloaded_error", err('{"type":"overloaded_error"}'), "overloaded"],
	["status 500", err("boom", { name: "ClaudeResultError", apiErrorStatus: 500 }), "overloaded"],
	["status 503", err("boom", { name: "GrokHttpError", status: 503 }), "overloaded"],
	// network
	["fetch failed", err("fetch failed"), "network"],
	["ECONNRESET", err("ECONNRESET"), "network"],
	["ENOTFOUND", err("getaddrinfo ENOTFOUND api.anthropic.com"), "network"],
	// timeout
	["claude timeout", err("claude timed out after 90000ms"), "timeout"],
	["grok timeout", err("grok timed out after 1000ms"), "timeout"],
	["status 408 is a hung route", err("request timeout", { status: 408 }), "timeout"],
	["status 408 with plain text", err("body read stalled", { status: 408 }), "timeout"],
	// spawn resources and killed children
	["EAGAIN code", err("spawn failed", { code: "EAGAIN" }), "network"],
	["ENOMEM code", err("cannot allocate", { code: "ENOMEM" }), "network"],
	["EMFILE code", err("too many open", { code: "EMFILE" }), "network"],
	["EAGAIN text", err("spawn claude EAGAIN"), "network"],
	["claude exited 137", err("claude exited 137"), "network"],
	["SIGKILL text", err("child killed by SIGKILL"), "network"],
	[
		"SIGTERM signalCode",
		Object.assign(new Error("claude stopped"), { signalCode: "SIGTERM" }),
		"network",
	],
	["OOM kill wording", err("claude was OOM-killed"), "network"],
	// unavailable
	["spawn ENOENT", err("spawn claude ENOENT", { code: "ENOENT" }), "unavailable"],
	["ENOENT code only", err("no such binary", { code: "ENOENT" }), "unavailable"],
	// aborted
	["AbortError", err("Aborted", { name: "AbortError" }), "aborted"],
	// other
	["not JSON", err("claude output is not JSON"), "other"],
	["status 400 keeps text rules", err("bad request", { status: 400 }), "other"],
];

describe("classifyFailure corpus", () => {
	for (const [label, error, expected] of CORPUS) {
		test(`${label} -> ${expected}`, () => {
			expect(classifyFailure(error)).toBe(expected);
		});
	}

	test("non-Error values are classified by their text", () => {
		expect(classifyFailure("fetch failed")).toBe("network");
		expect(classifyFailure({ message: "Credit balance is too low" })).toBe("billing");
		expect(classifyFailure(undefined)).toBe("other");
		expect(classifyFailure(null)).toBe("other");
		expect(classifyFailure(42)).toBe("other");
	});
});

describe("classifyFailure precedence", () => {
	test("a 403 with the Grok subscription text is model-unavailable, not auth", () => {
		const error = err("The model 'grok-build' requires a Grok subscription.", {
			name: "GrokHttpError",
			status: 403,
		});
		expect(classifyFailure(error)).toBe("model-unavailable");
	});

	test("a 429 with limit 0 is model-unavailable, a 429 with 61/60 is rate-limit", () => {
		expect(classifyFailure(err(XAI_BODY("0/0"), { status: 429 }))).toBe("model-unavailable");
		expect(classifyFailure(err(XAI_BODY("12/0"), { status: 429 }))).toBe("model-unavailable");
		expect(classifyFailure(err(XAI_BODY("61/60"), { status: 429 }))).toBe("rate-limit");
		expect(classifyFailure(err(XAI_BODY("0/600"), { status: 429 }))).toBe("rate-limit");
	});

	test("an AbortError is aborted even if its message says timed out", () => {
		expect(classifyFailure(err("claude timed out after 90000ms", { name: "AbortError" }))).toBe(
			"aborted",
		);
	});

	test("a FailoverError reports its carried class before any text or status rule", () => {
		const carried = Object.assign(new Error("x"), { name: "FailoverError", failure: "plan-limit" });
		expect(classifyFailure(carried)).toBe("plan-limit");
		const overText = Object.assign(new Error("fetch failed"), {
			name: "FailoverError",
			failure: "auth",
			status: 429,
		});
		expect(classifyFailure(overText)).toBe("auth");
	});

	test("a FailoverError with an invalid failure falls through to the normal rules", () => {
		for (const failure of ["bogus", 7, undefined, "toString"]) {
			const error = Object.assign(new Error("fetch failed"), { name: "FailoverError", failure });
			expect(classifyFailure(error)).toBe("network");
		}
	});

	test("a plan-limit message wins over a 429 status", () => {
		expect(classifyFailure(err("You've hit your session limit", { apiErrorStatus: 429 }))).toBe(
			"plan-limit",
		);
	});

	test("a billing message wins over a 5xx status", () => {
		expect(classifyFailure(err("Credit balance is too low", { apiErrorStatus: 500 }))).toBe(
			"billing",
		);
	});

	test("the status wins over a later text rule", () => {
		expect(classifyFailure(err("request timed out upstream", { status: 503 }))).toBe("overloaded");
	});

	test("ETIMEDOUT is a network failure, a bare timeout is not", () => {
		expect(classifyFailure(err("connect ETIMEDOUT 1.2.3.4:443"))).toBe("network");
		expect(classifyFailure(err("request timeout"))).toBe("timeout");
	});
});

const ALL: readonly FailureClass[] = [
	"auth",
	"billing",
	"plan-limit",
	"rate-limit",
	"overloaded",
	"model-unavailable",
	"unavailable",
	"network",
	"timeout",
	"aborted",
	"other",
];

describe("isFailoverWorthy and failureCooldownMs", () => {
	const WORTHY: Partial<Record<FailureClass, number>> = {
		auth: 600_000,
		billing: 3_600_000,
		"plan-limit": 900_000,
		"rate-limit": 60_000,
		overloaded: 30_000,
		"model-unavailable": 3_600_000,
		unavailable: 3_600_000,
		network: 30_000,
		timeout: 30_000,
	};

	for (const failure of ALL) {
		const cooldown = WORTHY[failure];
		test(`${failure}: worthy=${cooldown !== undefined} cooldown=${cooldown ?? 0}`, () => {
			expect(isFailoverWorthy(failure)).toBe(cooldown !== undefined);
			expect(failureCooldownMs(failure)).toBe(cooldown ?? 0);
		});
	}
});

describe("refused connections", () => {
	test("a refused Bun connect is a failover-worthy network failure", () => {
		const error = Object.assign(
			new TypeError("Unable to connect. Is the computer able to access the url?"),
			{ code: "ConnectionRefused" },
		);
		const failure = classifyFailure(error);
		expect(failure).toBe("network");
		expect(isFailoverWorthy(failure)).toBe(true);
		expect(failureCooldownMs(failure)).toBe(30_000);
	});

	test("connect ECONNREFUSED text is network", () => {
		expect(classifyFailure(err("connect ECONNREFUSED 127.0.0.1:3001"))).toBe("network");
	});

	test("an ECONNREFUSED code without that text is network", () => {
		expect(classifyFailure(err("socket failed", { code: "ECONNREFUSED" }))).toBe("network");
	});

	test("a 401 and a plan limit classify as before, with or without the refused code", () => {
		const weekly = "You've hit your weekly limit \u00b7 resets Mon 12:00am";
		expect(classifyFailure(err("denied", { status: 401 }))).toBe("auth");
		expect(classifyFailure(err(weekly))).toBe("plan-limit");
		expect(classifyFailure(err(weekly, { code: "ConnectionRefused", status: 401 }))).toBe(
			"plan-limit",
		);
	});
});
