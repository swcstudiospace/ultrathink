// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type EnsureFreshOptions,
	type GrokAuth,
	GrokAuthError,
	GrokHttpError,
	readGrokAuth,
} from "./auth.ts";
import {
	buildResponsesBody,
	buildShuntBody,
	createGrokCompleter,
	grokComplete,
	isGrokAuthError,
	parseResponsesText,
	parseShuntText,
} from "./complete.ts";
import { classifyFailure } from "../failover/classify.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { readReport } from "../types.ts";
import { hangingFetch } from "../test.helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The clock every auth fixture ages from and the expiry check reads: pinned so token lifetimes are deterministic. */
const FIXED_NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
beforeEach(() => {
	setSystemTime(FIXED_NOW);
});
afterEach(() => {
	setSystemTime();
});

const TOKEN =
	"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImV4cCI6MTk5OX0.Sflkxw_RJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const FRESH_TOKEN = "fresh.tok.en";

function tempHome(opts: { expiresAt?: string; version?: string; token?: string } = {}): string {
	const home = mkdtempSync(join(tmpdir(), "ultrathink-grok-complete-"));
	dirs.push(home);
	writeAuth(home, opts);
	if (opts.version)
		writeFileSync(join(home, "version.json"), JSON.stringify({ version: opts.version }));
	return home;
}

function writeAuth(home: string, opts: { expiresAt?: string; token?: string } = {}): void {
	writeFileSync(
		join(home, "auth.json"),
		JSON.stringify({
			"https://auth.x.ai::client-abc": {
				key: opts.token ?? TOKEN,
				expires_at: opts.expiresAt ?? new Date(FIXED_NOW + 3_600_000).toISOString(),
				email: "dev@example.com",
			},
		}),
	);
}

/** Refresh fake: on `force`, rewrites auth.json with a fresh token the way the CLI would. */
function fakeRefresh(
	home: string,
	onForce: () => void = () => writeAuth(home, { token: FRESH_TOKEN }),
) {
	const calls: EnsureFreshOptions[] = [];
	const refresh = async (opts: EnsureFreshOptions): Promise<GrokAuth | undefined> => {
		calls.push(opts);
		if (opts.force) onForce();
		return readGrokAuth(opts.home);
	};
	return { refresh, calls };
}

interface Captured {
	url: string;
	init: RequestInit;
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`rejected with non-Error: ${String(error)}`);
	}
	throw new Error("expected promise to reject");
}

function responsesReply(text: string): Response {
	return Response.json({
		output: [
			{ type: "reasoning", summary: [] },
			{ type: "message", content: [{ type: "output_text", text }] },
		],
		model: "grok-4.6-build",
	});
}

describe("buildResponsesBody", () => {
	test("produces the /responses payload", () => {
		expect(buildResponsesBody("SYS", "USER", "grok-4.6", "xhigh")).toEqual({
			model: "grok-4.6",
			instructions: "SYS",
			input: "USER",
			reasoning: { effort: "xhigh" },
			stream: false,
		});
	});

	test("adds max_output_tokens only for a positive number", () => {
		expect(buildResponsesBody("S", "U", "grok-build-0.1", undefined, 100.7).max_output_tokens).toBe(
			100,
		);
		expect("max_output_tokens" in buildResponsesBody("S", "U", "grok-build-0.1")).toBe(false);
	});

	test("omits reasoning when effort is undefined", () => {
		const body = buildResponsesBody("SYS", "USER", "grok-build-0.1");
		expect("reasoning" in body).toBe(false);
	});
});

describe("parseResponsesText", () => {
	test("joins output_text blocks from message items, skipping reasoning", () => {
		const text = parseResponsesText({
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "ignored" }] },
				{
					type: "message",
					content: [
						{ type: "output_text", text: "a" },
						{ type: "refusal", text: "no" },
					],
				},
				{ type: "message", content: [{ type: "output_text", text: "b" }] },
			],
		});
		expect(text).toBe("a\nb");
	});

	test("accepts a top-level output_text string", () => {
		expect(parseResponsesText({ output_text: "plain" })).toBe("plain");
	});

	test("throws when there is no text", () => {
		expect(() => parseResponsesText({ output: [{ type: "reasoning" }] })).toThrow(
			"grok returned no text",
		);
		expect(() => parseResponsesText(null)).toThrow("grok returned no text");
	});
});

/** Fetch whose reply has `status` but a body that never arrives; `text()` rejects with an AbortError when the call's signal fires. */
function stalledBodyFetch(status: number, onText?: () => void): typeof fetch {
	return (async (_input: string | URL | Request, init?: RequestInit) => ({
		status,
		ok: false,
		body: null,
		text: () => {
			const { promise, reject } = Promise.withResolvers<string>();
			const fail = (): void => reject(new DOMException("Aborted", "AbortError"));
			if (init?.signal?.aborted) fail();
			else init?.signal?.addEventListener("abort", fail, { once: true });
			onText?.();
			return promise;
		},
	})) as unknown as typeof fetch;
}

describe("grokComplete (http)", () => {
	test("posts to {baseUrl}/responses with login headers and returns the text", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("<UPLIFT/>"));
		const text = await grokComplete("SYS", "USER", {
			home: tempHome({ version: "1.0.30" }),
			baseUrl: "https://proxy.test/v1/",
			model: "grok-4.6",
			reasoningEffort: "xhigh",
			fetch,
		});
		expect(text).toBe("<UPLIFT/>");
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("https://proxy.test/v1/responses");
		expect(call.init.method).toBe("POST");
		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
		expect(headers.get("x-grok-client-version")).toBe("1.0.30");
		expect(headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(String(call.init.body));
		expect(body).toEqual({
			model: "grok-4.6",
			instructions: "SYS",
			input: "USER",
			reasoning: { effort: "xhigh" },
			stream: false,
		});
	});

	test("defaults to the Grok route default (grok-build-0.1) with no reasoning via createGrokCompleter", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("ok"));
		const complete = createGrokCompleter({ home: tempHome(), fetch });
		await complete("S", "U");
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.model).toBe(ROUTE_DEFAULT_MODELS.grok);
		expect(body.model).toBe("grok-build-0.1");
		expect("reasoning" in body).toBe(false);
		expect(calls[0]!.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
	});

	test("grok-4.7 sends reasoning xhigh", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("ok"));
		await grokComplete("S", "U", { home: tempHome(), fetch, model: "grok-4.7" });
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.reasoning).toEqual({ effort: "xhigh" });
	});

	test("onResult reports usage from the reply", async () => {
		const { fetch } = fakeFetch(() =>
			Response.json({
				output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
				usage: { input_tokens: 216, output_tokens: 151 },
			}),
		);
		const seen: unknown[] = [];
		await grokComplete("S", "U", {
			home: tempHome(),
			fetch,
			model: "grok-build-0.1",
			onResult: (info) => {
				seen.push(info);
				throw new Error("callback failures must not surface");
			},
		});
		expect(seen).toEqual([{ model: "grok-build-0.1", inputTokens: 216, outputTokens: 151 }]);
	});

	test("401 becomes a GrokAuthError pointing at grok login", async () => {
		const { fetch } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(isGrokAuthError(error)).toBe(true);
		expect(error.message).toContain("HTTP 401");
		expect(error.message).toEndWith("run `grok login`");
	});

	test("retries once with the refreshed token after a 401", async () => {
		const home = tempHome();
		const { refresh, calls: refreshCalls } = fakeRefresh(home);
		const { fetch, calls } = fakeFetch(() =>
			calls.length === 1
				? new Response("unauthorized", { status: 401 })
				: responsesReply("after refresh"),
		);
		expect(await grokComplete("S", "U", { home, fetch, refresh })).toBe("after refresh");
		expect(calls).toHaveLength(2);
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe(`Bearer ${FRESH_TOKEN}`);
		expect(refreshCalls).toEqual([
			{ home, bin: undefined, timeoutMs: 60_000 },
			{ home, bin: undefined, timeoutMs: 60_000, force: true },
		]);
	});

	test("a second 401 after the refresh is a GrokAuthError", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home);
		const { fetch, calls } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(calls).toHaveLength(2);
	});

	test("a 403 naming the model or subscription is a GrokHttpError classified model-unavailable", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home);
		const body = `{"code":"permission-denied","error":"The model 'grok-build' requires a Grok subscription."}`;
		const { fetch } = fakeFetch(() => new Response(body, { status: 403 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokHttpError);
		expect(isGrokAuthError(error)).toBe(false);
		expect(error.message).toBe(`grok HTTP 403: ${body}`);
		expect(classifyFailure(error)).toBe("model-unavailable");
	});

	test("a 403 with an empty body stays a GrokAuthError", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home);
		const { fetch } = fakeFetch(() => new Response("", { status: 403 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(classifyFailure(error)).toBe("auth");
	});

	test("max_output_tokens is sent only for a positive number, floored", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("ok"));
		const home = tempHome();
		await grokComplete("S", "U", { home, fetch, maxOutputTokens: 4096.9 });
		await grokComplete("S", "U", { home, fetch });
		await grokComplete("S", "U", { home, fetch, maxOutputTokens: 0 });
		const bodies = calls.map((call) => JSON.parse(String(call.init.body)));
		expect(bodies[0].max_output_tokens).toBe(4096);
		expect("max_output_tokens" in bodies[1]).toBe(false);
		expect("max_output_tokens" in bodies[2]).toBe(false);
	});

	test("the refresh gets the given env, never process.env", async () => {
		const home = tempHome();
		const { refresh, calls: refreshCalls } = fakeRefresh(home);
		const { fetch } = fakeFetch(() => responsesReply("ok"));
		const env = { PATH: "/usr/bin" };
		await grokComplete("S", "U", { home, fetch, refresh, env });
		expect(refreshCalls[0]?.env).toBe(env);
	});

	test("does not retry when the forced refresh yields nothing usable", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home, () =>
			writeAuth(home, { expiresAt: new Date(FIXED_NOW - 1_000).toISOString() }),
		);
		const { fetch, calls } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(calls).toHaveLength(1);
	});

	test("500 becomes a GrokHttpError with a redacted body", async () => {
		const { fetch } = fakeFetch(
			() => new Response(`upstream failed for Bearer ${TOKEN}`, { status: 500 }),
		);
		const error = await rejection(
			grokComplete("S", "U", { home: tempHome(), fetch, ...retrySeams().seams }),
		);
		expect(error).toBeInstanceOf(GrokHttpError);
		if (!(error instanceof GrokHttpError)) return;
		expect(error.status).toBe(500);
		expect(error.body).toBe("upstream failed for [redacted]");
		expect(error.message).not.toContain(TOKEN);
		expect(isGrokAuthError(error)).toBe(false);
	});

	test("expired login fails before any request", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const home = tempHome({ expiresAt: new Date(FIXED_NOW - 1000).toISOString() });
		const error = await rejection(grokComplete("S", "U", { home, fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(error.message).toBe("Grok login expired: run `grok login`");
		expect(calls).toHaveLength(0);
	});

	test("missing login fails before any request", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const home = mkdtempSync(join(tmpdir(), "ultrathink-grok-empty-"));
		dirs.push(home);
		const error = await rejection(grokComplete("S", "U", { home, fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(error.message).toBe("Grok login missing: run `grok login`");
		expect(calls).toHaveLength(0);
	});

	test("already-aborted signal throws AbortError without fetching", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const controller = new AbortController();
		controller.abort();
		const error = await rejection(
			grokComplete("S", "U", { home: tempHome(), fetch, signal: controller.signal }),
		);
		expect(error.name).toBe("AbortError");
		expect(calls).toHaveLength(0);
	});

	test("abort during the request surfaces as AbortError", async () => {
		const controller = new AbortController();
		const fetch = hangingFetch(() => controller.abort());
		const error = await rejection(
			grokComplete("S", "U", { home: tempHome(), fetch, signal: controller.signal }),
		);
		expect(error.name).toBe("AbortError");
	});

	test("timeout surfaces as a timed-out error", async () => {
		const error = await rejection(
			grokComplete("S", "U", { home: tempHome(), fetch: hangingFetch(), timeoutMs: 20 }),
		);
		expect(error.message).toBe("grok timed out after 20ms");
	});

	test("a timeout while reading a 403 body is the timeout, not an auth failure", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home, () => undefined);
		const error = await rejection(
			grokComplete("S", "U", { home, refresh, fetch: stalledBodyFetch(403), timeoutMs: 20 }),
		);
		expect(error.message).toBe("grok timed out after 20ms");
		expect(isGrokAuthError(error)).toBe(false);
		expect(["auth", "model-unavailable"]).not.toContain(classifyFailure(error));
	});

	test("a timeout while reading a 500 body is the timeout, not a GrokHttpError", async () => {
		const error = await rejection(
			grokComplete("S", "U", {
				home: tempHome(),
				fetch: stalledBodyFetch(500),
				timeoutMs: 20,
			}),
		);
		expect(error.message).toBe("grok timed out after 20ms");
		expect(error).not.toBeInstanceOf(GrokHttpError);
	});

	test("a caller abort while reading a 403 body surfaces as AbortError", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home, () => undefined);
		const controller = new AbortController();
		const fetch = stalledBodyFetch(403, () => controller.abort());
		const error = await rejection(
			grokComplete("S", "U", { home, refresh, fetch, signal: controller.signal }),
		);
		expect(error.name).toBe("AbortError");
		expect(isGrokAuthError(error)).toBe(false);
	});

	test("a non-timeout failure reading a 403 body leaves the body empty (GrokAuthError)", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home, () => undefined);
		const fetch = (async () => ({
			status: 403,
			ok: false,
			body: null,
			text: async () => {
				throw new Error("socket closed");
			},
		})) as unknown as typeof globalThis.fetch;
		const error = await rejection(grokComplete("S", "U", { home, refresh, fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
	});
});

/** Anthropic Messages reply the shunt gateway returns for `grok-shunt-route` (thinking block first). */
function shuntReply(text: string, extra: Record<string, unknown>[] = []): Response {
	return Response.json({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "grok-shunt-route",
		content: [
			{ type: "thinking", thinking: "hidden reasoning", signature: "sig" },
			...extra,
			{ type: "text", text },
		],
		stop_reason: "end_turn",
		usage: { input_tokens: 1, output_tokens: 1 },
	});
}

describe("buildShuntBody", () => {
	test("produces an Anthropic Messages payload without a thinking param", () => {
		const body = buildShuntBody("SYS", "USER", "grok-shunt-route", 4096);
		expect(body).toEqual({
			model: "grok-shunt-route",
			max_tokens: 4096,
			system: "SYS",
			messages: [{ role: "user", content: "USER" }],
		});
		expect("thinking" in body).toBe(false);
	});
});

describe("parseShuntText", () => {
	test("joins text blocks and ignores thinking / redacted_thinking blocks", () => {
		const text = parseShuntText({
			type: "message",
			content: [
				{ type: "thinking", thinking: "secret plan" },
				{ type: "redacted_thinking", data: "opaque" },
				{ type: "text", text: "a" },
				{ type: "tool_use", id: "t", name: "x", input: {} },
				{ type: "text", text: "b" },
			],
		});
		expect(text).toBe("a\nb");
		expect(text).not.toContain("secret plan");
	});

	test("surfaces an Anthropic error body as a redacted GrokHttpError", () => {
		let error: unknown;
		try {
			parseShuntText({
				type: "error",
				error: { type: "overloaded_error", message: `busy Bearer ${TOKEN}` },
			});
		} catch (caught) {
			// reason: the error is captured and asserted by the caller
			error = caught;
		}
		expect(error).toBeInstanceOf(GrokHttpError);
		if (!(error instanceof GrokHttpError)) return;
		expect(error.message).toBe("shunt overloaded_error: busy [redacted]");
		expect(error.body).toBe("busy [redacted]");
		expect(error.message).not.toContain(TOKEN);
	});

	test("throws when there is no text", () => {
		expect(() =>
			parseShuntText({ type: "message", content: [{ type: "thinking", thinking: "only" }] }),
		).toThrow("grok returned no text");
		expect(() => parseShuntText(null)).toThrow("grok returned no text");
	});
});

describe("grokComplete (shunt)", () => {
	const shuntBaseUrl = "http://gateway.test:8080";

	test("posts Anthropic Messages to {shuntBaseUrl}/v1/messages with no auth and returns the text", async () => {
		const { fetch, calls } = fakeFetch(() => shuntReply("<UPLIFT/>"));
		const text = await grokComplete("SYS", "USER", {
			transport: "shunt",
			shuntBaseUrl: "http://gateway.test:8080/",
			shuntModel: "grok-shunt-route",
			shuntMaxTokens: 2048,
			model: "grok-4.7",
			reasoningEffort: "xhigh",
			fetch,
		});
		expect(text).toBe("<UPLIFT/>");
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("http://gateway.test:8080/v1/messages");
		expect(call.init.method).toBe("POST");
		const headers = new Headers(call.init.headers);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("x-xai-token-auth")).toBeNull();
		expect(JSON.parse(String(call.init.body))).toEqual({
			model: "grok-shunt-route",
			max_tokens: 2048,
			system: "SYS",
			messages: [{ role: "user", content: "USER" }],
		});
	});

	test("an unset shuntBaseUrl throws naming the setting, without fetching or touching grok login", async () => {
		const { fetch, calls } = fakeFetch(() => shuntReply("never"));
		const home = mkdtempSync(join(tmpdir(), "ultrathink-grok-empty-"));
		dirs.push(home);
		for (const url of [undefined, "", "  "]) {
			const error = await rejection(
				grokComplete("S", "U", {
					transport: "shunt",
					shuntBaseUrl: url,
					shuntModel: "m",
					home,
					fetch,
				}),
			);
			expect(error.message).toContain("grok.shuntBaseUrl");
			expect(error.message).toContain("~/.config/ultrathink/config.json");
			expect(isGrokAuthError(error)).toBe(false);
		}
		expect(calls).toHaveLength(0);
	});

	test("an unset shuntModel sends model, and max_tokens defaults to 8192, without touching grok login", async () => {
		const { fetch, calls } = fakeFetch(() => shuntReply("ok"));
		const home = mkdtempSync(join(tmpdir(), "ultrathink-grok-empty-"));
		dirs.push(home);
		const complete = createGrokCompleter({
			transport: "shunt",
			shuntBaseUrl,
			shuntModel: "",
			model: "grok-4.6",
			home,
			fetch,
		});
		expect(await complete("S", "U")).toBe("ok");
		expect(calls[0]!.url).toBe("http://gateway.test:8080/v1/messages");
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.model).toBe("grok-4.6");
		expect(body.max_tokens).toBe(8192);
		expect(body.thinking).toBeUndefined();
	});

	test("non-2xx becomes a GrokHttpError with a redacted body", async () => {
		const { fetch } = fakeFetch(
			() => new Response(`route missing for Bearer ${TOKEN}`, { status: 502 }),
		);
		const error = await rejection(
			grokComplete("S", "U", { transport: "shunt", shuntBaseUrl, fetch, ...retrySeams().seams }),
		);
		expect(error).toBeInstanceOf(GrokHttpError);
		if (!(error instanceof GrokHttpError)) return;
		expect(error.status).toBe(502);
		expect(error.body).toBe("route missing for [redacted]");
		expect(error.message).toBe("shunt HTTP 502: route missing for [redacted]");
		expect(isGrokAuthError(error)).toBe(false);
	});

	test("a 200 carrying an Anthropic error body is still an error", async () => {
		const { fetch } = fakeFetch(() =>
			Response.json({ type: "error", error: { type: "api_error", message: "upstream" } }),
		);
		const error = await rejection(
			grokComplete("S", "U", { transport: "shunt", shuntBaseUrl, fetch, ...retrySeams().seams }),
		);
		expect(error).toBeInstanceOf(GrokHttpError);
		expect(error.message).toBe("shunt api_error: upstream");
	});

	test("already-aborted signal throws AbortError without fetching", async () => {
		const { fetch, calls } = fakeFetch(() => shuntReply("never"));
		const controller = new AbortController();
		controller.abort();
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "shunt",
				shuntBaseUrl,
				fetch,
				signal: controller.signal,
			}),
		);
		expect(error.name).toBe("AbortError");
		expect(calls).toHaveLength(0);
	});

	test("abort during the request surfaces as AbortError", async () => {
		const controller = new AbortController();
		const fetch = hangingFetch(() => controller.abort());
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "shunt",
				shuntBaseUrl,
				fetch,
				signal: controller.signal,
			}),
		);
		expect(error.name).toBe("AbortError");
	});

	test("timeout surfaces as a timed-out error", async () => {
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "shunt",
				shuntBaseUrl,
				fetch: hangingFetch(),
				timeoutMs: 20,
			}),
		);
		expect(error.message).toBe("grok timed out after 20ms");
	});

	test("a timeout while reading a non-OK body surfaces as the timeout", async () => {
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "shunt",
				shuntBaseUrl,
				fetch: stalledBodyFetch(502),
				timeoutMs: 20,
			}),
		);
		expect(error.message).toBe("grok timed out after 20ms");
		expect(error).not.toBeInstanceOf(GrokHttpError);
	});
});

describe("grokComplete (cli)", () => {
	/** Writes a fake `grok` binary that records argv/env/cwd and prints `reply(prompt)` as its JSON output. */
	function fakeGrok(replyJs: string): { bin: string; argsPath: string } {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-grok-cli-"));
		dirs.push(dir);
		const bin = join(dir, "grok");
		const argsPath = join(dir, "args.json");
		writeFileSync(
			bin,
			`#!${process.execPath}\nconst args = process.argv.slice(2);\nconst prompt = await Bun.file(args[args.indexOf("--prompt-file") + 1]).text();\nawait Bun.write(${JSON.stringify(argsPath)}, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { GROK_HOME: process.env.GROK_HOME, GROK_SUBAGENTS: process.env.GROK_SUBAGENTS, GROK_MEMORY: process.env.GROK_MEMORY, GROK_WEB_FETCH: process.env.GROK_WEB_FETCH }, leaked: process.env.OPENROUTER_API_KEY }));\nconsole.log(JSON.stringify(${replyJs}));\n`,
			{ mode: 0o755 },
		);
		return { bin, argsPath };
	}

	test("spawns the grok CLI tool-free in a private per-process scratch cwd and parses .text", async () => {
		const { bin, argsPath } = fakeGrok('{ text: "<X>" + prompt + "</X>", stopReason: "end_turn" }');
		const home = tempHome();
		const text = await grokComplete("SYS", "USER TEXT", {
			transport: "cli",
			bin,
			home,
			model: "grok-4.6",
			reasoningEffort: "high",
			cwd: "/nonexistent",
		});
		expect(text).toBe("<X>USER TEXT</X>");
		const seen = JSON.parse(await Bun.file(argsPath).text()) as {
			args: string[];
			prompt: string;
			cwd: string;
			env: Record<string, string | undefined>;
		};
		expect(seen.prompt).toBe("USER TEXT");
		expect(seen.env).toEqual({
			GROK_HOME: home,
			GROK_SUBAGENTS: "0",
			GROK_MEMORY: "0",
			GROK_WEB_FETCH: "0",
		});
		expect(realpathSync(dirname(seen.cwd))).toBe(realpathSync(tmpdir()));
		expect(basename(seen.cwd)).toMatch(/^ultrathink-grok-.+$/);
		expect(statSync(seen.cwd).mode & 0o777).toBe(0o700);
		expect(seen.args.slice(0, 4)).toEqual(["-m", "grok-4.6", "--reasoning-effort", "high"]);
		const after = (flag: string) => seen.args[seen.args.indexOf(flag) + 1];
		expect(after("--tools")).toBe("none");
		expect(seen.args).not.toContain("");
		expect(after("--permission-mode")).toBe("plan");
		expect(after("--max-turns")).toBe("1");
		expect(after("--disallowed-tools")).toContain("run_terminal_cmd");
		const denied = seen.args.flatMap((arg, i) => (arg === "--deny" ? [seen.args[i + 1]] : []));
		expect(denied).toEqual(["Bash", "Edit", "Write"]);
		for (const flag of ["--no-plan", "--no-subagents", "--disable-web-search", "--verbatim"])
			expect(seen.args).toContain(flag);
		expect(after("--system-prompt-override")).toBe("SYS");
	});

	test("a given env replaces process.env for the child", async () => {
		const { bin, argsPath } = fakeGrok('{ text: "ok" }');
		const home = tempHome();
		const before = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = "planted-secret";
		try {
			await grokComplete("SYS", "USER", {
				transport: "cli",
				bin,
				home,
				env: { HOME: "/nonexistent" },
			});
		} finally {
			if (before === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = before;
		}
		const seen = JSON.parse(await Bun.file(argsPath).text()) as {
			env: Record<string, string | undefined>;
			leaked?: string;
		};
		expect(seen.leaked).toBeUndefined();
		expect(seen.env).toEqual({
			GROK_HOME: home,
			GROK_SUBAGENTS: "0",
			GROK_MEMORY: "0",
			GROK_WEB_FETCH: "0",
		});
	});

	test("the child never sees the Jev key variables, whether given or inherited", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-grok-jev-"));
		dirs.push(dir);
		const bin = join(dir, "grok");
		const seenPath = join(dir, "seen.json");
		writeFileSync(
			bin,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(seenPath)}, JSON.stringify({ jev: [process.env.ULTRATHINK_OPENROUTER_KEY ?? null, process.env.OPENROUTER_API_KEY ?? null, process.env.AI_GATEWAY_API_KEY ?? null] }));\nconsole.log(JSON.stringify({ text: "ok" }));\n`,
			{ mode: 0o755 },
		);
		const planted = "sk-or-v1-CANARYCANARYCANARY1234";
		const names = [
			"ULTRATHINK_OPENROUTER_KEY",
			"OPENROUTER_API_KEY",
			"AI_GATEWAY_API_KEY",
		] as const;
		const saved = names.map((name) => process.env[name]);
		for (const name of names) process.env[name] = planted;
		try {
			for (const env of [
				undefined,
				{
					ULTRATHINK_OPENROUTER_KEY: planted,
					OPENROUTER_API_KEY: planted,
					AI_GATEWAY_API_KEY: planted,
				},
			]) {
				await grokComplete("SYS", "USER", { transport: "cli", bin, home: tempHome(), env });
				const got = JSON.parse(await Bun.file(seenPath).text()) as { jev: (string | null)[] };
				expect(got.jev).toEqual([null, null, null]);
			}
		} finally {
			names.forEach((name, index) => {
				const value = saved[index];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			});
		}
	});

	test("omits --reasoning-effort for a model without effort support", async () => {
		const { bin, argsPath } = fakeGrok('{ text: "ok" }');
		await grokComplete("SYS", "USER", {
			transport: "cli",
			bin,
			home: tempHome(),
			model: "grok-build-0.1",
			reasoningEffort: "xhigh",
		});
		const seen = JSON.parse(await Bun.file(argsPath).text()) as { args: string[] };
		expect(seen.args.slice(0, 3)).toEqual(["-m", "grok-build-0.1", "--output-format"]);
		expect(seen.args).not.toContain("--reasoning-effort");
	});

	test("reuses one scratch cwd within the process", async () => {
		const first = fakeGrok('{ text: "a" }');
		const second = fakeGrok('{ text: "b" }');
		await grokComplete("SYS", "USER", { transport: "cli", bin: first.bin, home: tempHome() });
		await grokComplete("SYS", "USER", { transport: "cli", bin: second.bin, home: tempHome() });
		const firstSeen = JSON.parse(await Bun.file(first.argsPath).text()) as { cwd: string };
		const secondSeen = JSON.parse(await Bun.file(second.argsPath).text()) as { cwd: string };
		const firstCwd = firstSeen.cwd;
		const secondCwd = secondSeen.cwd;
		expect(basename(firstCwd)).toMatch(/^ultrathink-grok-/);
		expect(secondCwd).toBe(firstCwd);
		expect(statSync(firstCwd).isDirectory()).toBe(true);
	});

	test("a non-end_turn stopReason is an error even when partial text is present", async () => {
		const { bin } = fakeGrok('{ text: "partial", stopReason: "cancelled" }');
		const error = await rejection(
			grokComplete("SYS", "USER", {
				transport: "cli",
				bin,
				home: tempHome(),
				...retrySeams().seams,
			}),
		);
		expect(error.message).toBe("grok cli stopped: cancelled");
	});

	test("output without stopReason (older CLI) is still accepted", async () => {
		const { bin } = fakeGrok('{ text: "ok" }');
		expect(await grokComplete("SYS", "USER", { transport: "cli", bin, home: tempHome() })).toBe(
			"ok",
		);
	});
});

describe("isGrokAuthError", () => {
	test("matches by class or by name", () => {
		expect(isGrokAuthError(new GrokAuthError("x: run `grok login`"))).toBe(true);
		expect(isGrokAuthError({ name: "GrokAuthError" })).toBe(true);
		expect(isGrokAuthError(new Error("x"))).toBe(false);
		expect(isGrokAuthError(null)).toBe(false);
	});
});

/** Instant retry seams: records every backoff the kernel asked for and never waits. */
function retrySeams(): {
	delays: number[];
	seams: { retrySleep: (ms: number) => Promise<void>; retryRandom: () => number };
} {
	const delays: number[] = [];
	return {
		delays,
		seams: {
			retrySleep: async (ms: number) => {
				delays.push(ms);
			},
			retryRandom: () => 0,
		},
	};
}

const PLANTED_BEARER = `Bearer ${TOKEN}`;
const PLANTED_KEY = "sk-or-v1-PLANTEDSENTINEL0123456789abcdef";

function expectCleanCause(cause: string | undefined): void {
	expect(cause).toBeDefined();
	expect(cause).not.toContain("\n");
	expect((cause ?? "").length).toBeLessThanOrEqual(200);
	expect(cause).not.toContain(TOKEN);
	expect(cause).not.toContain("PLANTEDSENTINEL");
}

/** Fetch that serves `replies` in order, repeating the last one. */
function sequenceFetch(replies: (() => Response)[]): { fetch: typeof fetch; calls: Captured[] } {
	let index = 0;
	return fakeFetch(() => {
		const reply = replies[Math.min(index, replies.length - 1)];
		index++;
		if (!reply) throw new Error("no reply");
		return reply();
	});
}

const tooMany = (): Response =>
	new Response(`slow down ${PLANTED_BEARER} ${PLANTED_KEY}\nsecond line`, {
		status: 429,
		headers: { "retry-after": "2" },
	});

describe("grokComplete retries (97-02)", () => {
	test("http: 429 with Retry-After then 200 succeeds on attempt 2 after the hinted wait", async () => {
		const { delays, seams } = retrySeams();
		const { fetch, calls } = sequenceFetch([tooMany, () => responsesReply("ok")]);
		const text = await grokComplete("S", "U", { home: tempHome(), fetch, ...seams });
		expect(text).toBe("ok");
		expect(calls).toHaveLength(2);
		expect(delays).toEqual([2000]);
	});

	test("http: a 429 that never clears throws the original GrokHttpError carrying the report", async () => {
		const { seams } = retrySeams();
		const { fetch, calls } = fakeFetch(tooMany);
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch, ...seams }));
		expect(error.name).not.toBe("RetryExhaustedError");
		expect(error).toBeInstanceOf(GrokHttpError);
		if (!(error instanceof GrokHttpError)) return;
		expect(error.status).toBe(429);
		expect(error.retryAfterMs).toBe(2000);
		expect(calls).toHaveLength(3);
		const report = readReport(error);
		expect(report?.attempts).toBe(3);
		expect(report?.httpStatus).toBe(429);
		expect(report?.retryAfterMs).toBe(2000);
		expectCleanCause(report?.cause);
	});

	test("http: a failure that cannot be retried reports one attempt", async () => {
		const { seams } = retrySeams();
		const { fetch, calls } = fakeFetch(() => new Response("bad request", { status: 400 }));
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch, ...seams }));
		expect(calls).toHaveLength(1);
		expect(readReport(error)?.attempts).toBe(1);
		expect(readReport(error)?.httpStatus).toBe(400);
	});

	test("shunt: 503 with Retry-After then 200 succeeds on attempt 2; a standing 429 carries the report", async () => {
		const { delays, seams } = retrySeams();
		const shuntBaseUrl = "https://shunt.example";
		const flaky = sequenceFetch([
			() => new Response("busy", { status: 503, headers: { "retry-after": "3" } }),
			() => shuntReply("ok"),
		]);
		expect(
			await grokComplete("S", "U", {
				transport: "shunt",
				shuntBaseUrl,
				fetch: flaky.fetch,
				...seams,
			}),
		).toBe("ok");
		expect(flaky.calls).toHaveLength(2);
		expect(delays).toEqual([3000]);
		const standing = fakeFetch(tooMany);
		const error = await rejection(
			grokComplete("S", "U", { transport: "shunt", shuntBaseUrl, fetch: standing.fetch, ...seams }),
		);
		expect(error).toBeInstanceOf(GrokHttpError);
		const report = readReport(error);
		expect(report?.attempts).toBe(3);
		expect(report?.httpStatus).toBe(429);
		expect(report?.retryAfterMs).toBe(2000);
		expectCleanCause(report?.cause);
	});

	test("a rejected fetch (fetch failed) is retried on the same model", async () => {
		const { seams } = retrySeams();
		let calls = 0;
		const fetch = (async () => {
			calls++;
			if (calls === 1) throw new TypeError("fetch failed");
			return responsesReply("ok");
		}) as unknown as typeof globalThis.fetch;
		expect(await grokComplete("S", "U", { home: tempHome(), fetch, ...seams })).toBe("ok");
		expect(calls).toBe(2);
	});

	test("an abort during the backoff stops the call with a bare AbortError", async () => {
		const controller = new AbortController();
		const { fetch, calls } = fakeFetch(tooMany);
		const error = await rejection(
			grokComplete("S", "U", {
				home: tempHome(),
				fetch,
				signal: controller.signal,
				retrySleep: async () => {
					controller.abort();
					throw Object.assign(new Error("aborted"), { name: "AbortError" });
				},
			}),
		);
		expect(error.name).toBe("AbortError");
		expect(readReport(error)).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	test("success carries no report and makes the minimal calls", async () => {
		const home = tempHome();
		const { refresh, calls: refreshCalls } = fakeRefresh(home);
		const { fetch, calls } = fakeFetch(() => responsesReply("ok"));
		expect(await grokComplete("S", "U", { home, fetch, refresh })).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(refreshCalls).toHaveLength(1);
	});

	test("auth failures are final, carry one attempt and a clean cause", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home, () => undefined);
		const { fetch, calls } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(calls).toHaveLength(1);
		const report = readReport(error);
		expect(report?.attempts).toBe(1);
		expectCleanCause(report?.cause);
	});
});

describe("grokComplete abort across the refresh (97-02)", () => {
	test("an abort while the token refresh runs stops the call before any request is sent", async () => {
		const home = tempHome();
		const controller = new AbortController();
		const gate = Promise.withResolvers<void>();
		const refresh = async (opts: EnsureFreshOptions): Promise<GrokAuth | undefined> => {
			await gate.promise;
			return readGrokAuth(opts.home);
		};
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const pending = rejection(
			grokComplete("S", "U", { home, fetch, refresh, signal: controller.signal }),
		);
		controller.abort();
		gate.resolve();
		const error = await pending;
		expect(error.name).toBe("AbortError");
		expect(calls).toHaveLength(0);
		expect(readReport(error)).toBeUndefined();
	});

	test("an abort during the forced 401 refresh sends no second request", async () => {
		const home = tempHome();
		const controller = new AbortController();
		const refresh = async (opts: EnsureFreshOptions): Promise<GrokAuth | undefined> => {
			if (opts.force) {
				writeAuth(home, { token: FRESH_TOKEN });
				controller.abort();
			}
			return readGrokAuth(opts.home);
		};
		const { fetch, calls } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(
			grokComplete("S", "U", { home, fetch, refresh, signal: controller.signal }),
		);
		expect(error.name).toBe("AbortError");
		expect(calls).toHaveLength(1);
	});

	test("the caller signal and a 60 s budget reach the refresh", async () => {
		const home = tempHome();
		const controller = new AbortController();
		const { refresh, calls } = fakeRefresh(home);
		await grokComplete("S", "U", {
			home,
			refresh,
			fetch: fakeFetch(() => responsesReply("ok")).fetch,
			signal: controller.signal,
		});
		expect(calls[0]?.signal).toBe(controller.signal);
		expect(calls[0]?.timeoutMs).toBe(60_000);
		const custom = fakeRefresh(home);
		await grokComplete("S", "U", {
			home,
			refresh: custom.refresh,
			refreshTimeoutMs: 90_000,
			fetch: fakeFetch(() => responsesReply("ok")).fetch,
		});
		expect(custom.calls[0]?.timeoutMs).toBe(90_000);
	});

	test("a refresh that timed out with a still-expired token says so, not login expired", async () => {
		const home = tempHome({ expiresAt: new Date(FIXED_NOW - 1000).toISOString() });
		const refresh = async (opts: EnsureFreshOptions): Promise<GrokAuth | undefined> => {
			const auth = readGrokAuth(opts.home);
			return auth && { ...auth, refreshTimedOut: true };
		};
		const { seams } = retrySeams();
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh, ...seams }));
		expect(error.message).toContain("refresh timed out");
		expect(error.message).not.toContain("login expired");
		expect(isGrokAuthError(error)).toBe(false);
		expect(calls).toHaveLength(0);
	});
});

describe("grokComplete truncation (97-02)", () => {
	test("/responses status incomplete is a truncated_reply failure", async () => {
		const { seams } = retrySeams();
		const { fetch, calls } = fakeFetch(() =>
			Response.json({
				status: "incomplete",
				output: [{ type: "message", content: [{ type: "output_text", text: "cut off" }] }],
			}),
		);
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch, ...seams }));
		expect(readReport(error)?.cause).toBe("truncated_reply");
		expect(readReport(error)?.attempts).toBe(3);
		expect(calls).toHaveLength(3);
	});

	test("shunt stop_reason max_tokens is a truncated_reply failure", async () => {
		const { seams } = retrySeams();
		const { fetch } = fakeFetch(() =>
			Response.json({
				type: "message",
				content: [{ type: "text", text: "cut" }],
				stop_reason: "max_tokens",
			}),
		);
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "shunt",
				shuntBaseUrl: "https://shunt.example",
				fetch,
				...seams,
			}),
		);
		expect(readReport(error)?.cause).toBe("truncated_reply");
	});
});

describe("grokComplete (cli) resilience (97-02)", () => {
	function scriptGrok(body: string): string {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-grok-script-"));
		dirs.push(dir);
		const bin = join(dir, "grok");
		writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
		return bin;
	}

	function failingGrok(stderr: string, code = 1): string {
		return scriptGrok(`console.error(${JSON.stringify(stderr)}); process.exit(${code});`);
	}

	function promptDirs(): Set<string> {
		return new Set(
			readdirSync(tmpdir()).filter(
				(name) =>
					name.startsWith("ultrathink-grok-") && existsSync(join(tmpdir(), name, "prompt.md")),
			),
		);
	}

	test("transient stderr (fetch failed) is retried on the same model and succeeds on attempt 2", async () => {
		const { seams } = retrySeams();
		const counter = join(mkdtempSync(join(tmpdir(), "ultrathink-grok-count-")), "n");
		dirs.push(dirname(counter));
		const bin = scriptGrok(
			`const f = ${JSON.stringify(counter)};\nconst n = (await Bun.file(f).exists()) ? Number(await Bun.file(f).text()) : 0;\nawait Bun.write(f, String(n + 1));\nif (n === 0) { console.error("fetch failed"); process.exit(1); }\nconsole.log(JSON.stringify({ text: "ok", stopReason: "end_turn" }));`,
		);
		expect(
			await grokComplete("S", "U", { transport: "cli", bin, home: tempHome(), ...seams }),
		).toBe("ok");
		expect(readFileSync(counter, "utf8")).toBe("2");
	});

	test("a bin that cannot spawn leaves no prompt directory behind", async () => {
		const { seams } = retrySeams();
		await grokComplete("S", "U", {
			transport: "cli",
			bin: scriptGrok('console.log(JSON.stringify({ text: "ok" }));'),
			home: tempHome(),
		});
		const before = promptDirs();
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "cli",
				bin: join(tmpdir(), "ultrathink-no-such-grok-bin"),
				home: tempHome(),
				...seams,
			}),
		);
		expect(error).toBeInstanceOf(Error);
		const leaked = [...promptDirs()].filter((name) => !before.has(name));
		expect(leaked).toEqual([]);
		expect(readReport(error)?.attempts).toBe(1);
	});

	test("an abort kills the child and its grandchild", async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), "ultrathink-grok-pid-")), "pids");
		dirs.push(dirname(pidFile));
		const bin = scriptGrok(
			`const child = Bun.spawn(["sleep", "300"], { stdio: ["ignore", "ignore", "ignore"] });\nawait Bun.write(${JSON.stringify(pidFile)}, String(child.pid));\nsetInterval(() => {}, 1000);`,
		);
		const controller = new AbortController();
		const pending = rejection(
			grokComplete("S", "U", {
				transport: "cli",
				bin,
				home: tempHome(),
				signal: controller.signal,
			}),
		);
		for (let i = 0; i < 400 && !existsSync(pidFile); i++) await Bun.sleep(25);
		const grandchild = Number(readFileSync(pidFile, "utf8"));
		controller.abort();
		const error = await pending;
		expect(error.name).toBe("AbortError");
		const alive = (): boolean => {
			try {
				return !readFileSync(`/proc/${grandchild}/stat`, "utf8").includes(") Z ");
			} catch {
				return false;
			}
		};
		for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(20);
		expect(alive()).toBe(false);
	});

	test("an already-aborted signal rejects without spawning", async () => {
		const controller = new AbortController();
		controller.abort();
		const error = await rejection(
			grokComplete("S", "U", {
				transport: "cli",
				bin: join(tmpdir(), "ultrathink-no-such-grok-bin"),
				home: tempHome(),
				signal: controller.signal,
			}),
		);
		expect(error.name).toBe("AbortError");
	});

	test("stderr with a bare number like 14012 is not a login failure", async () => {
		const { seams } = retrySeams();
		const bin = failingGrok("stream reset after 14012 ms (EAGAIN)");
		const error = await rejection(
			grokComplete("S", "U", { transport: "cli", bin, home: tempHome(), ...seams }),
		);
		expect(isGrokAuthError(error)).toBe(false);
		expect(error.message).toBe("stream reset after 14012 ms (EAGAIN)");
		expect(readReport(error)?.attempts).toBe(3);
	});

	test("an exact login marker is a GrokAuthError and is not retried", async () => {
		const { seams } = retrySeams();
		const bin = failingGrok("Error: login required");
		const error = await rejection(
			grokComplete("S", "U", { transport: "cli", bin, home: tempHome(), ...seams }),
		);
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(readReport(error)?.attempts).toBe(1);
	});

	test("CLI failure reports carry a single-line redacted cause of at most 200 characters", async () => {
		const { seams } = retrySeams();
		const bin = failingGrok(`boom ${PLANTED_BEARER}\n${PLANTED_KEY} ${"x".repeat(400)}`);
		const error = await rejection(
			grokComplete("S", "U", { transport: "cli", bin, home: tempHome(), ...seams }),
		);
		const report = readReport(error);
		expect(report?.attempts).toBe(3);
		expect(report?.httpStatus).toBeUndefined();
		expect(report?.retryAfterMs).toBeUndefined();
		expectCleanCause(report?.cause);
		expect(error.message).not.toContain("PLANTEDSENTINEL");
	});

	test("a length stop is a truncated_reply failure", async () => {
		const { seams } = retrySeams();
		const bin = scriptGrok('console.log(JSON.stringify({ text: "cut", stopReason: "length" }));');
		const error = await rejection(
			grokComplete("S", "U", { transport: "cli", bin, home: tempHome(), ...seams }),
		);
		expect(readReport(error)?.cause).toBe("truncated_reply");
		expect(readReport(error)?.attempts).toBe(3);
	});

	test("stdout past the 4 MB cap fails instead of buffering without bound", async () => {
		const { seams } = retrySeams();
		const bin = scriptGrok('process.stdout.write("x".repeat(5 * 1024 * 1024));');
		const error = await rejection(
			grokComplete("S", "U", { transport: "cli", bin, home: tempHome(), ...seams }),
		);
		expect(error.message).toContain("exceeded");
		expect(readReport(error)?.attempts).toBe(1);
	});
});
