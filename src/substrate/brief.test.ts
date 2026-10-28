// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BriefResult, boundedLine, emitEvent, fetchBrief } from "./brief.ts";

const realFetch = globalThis.fetch;
/** An empty per-test tokens directory: no test reads the real /etc/substrate/tokens. */
let tokensDir = "";
beforeEach(() => {
	tokensDir = mkdtempSync(join(tmpdir(), "ut-brief-"));
});
afterEach(() => {
	globalThis.fetch = realFetch;
	rmSync(tokensDir, { recursive: true, force: true });
});

/** The env every test starts from; `extra` wins. */
function env(extra: Record<string, string> = {}): Record<string, string> {
	return { SUBSTRATE_TOKENS_DIR: tokensDir, ...extra };
}

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
const FILE_CANARY = "sk-or-v1-FILECANARYFILECANARY5678";

/** Controller-driven AbortSignal.timeout: each request budget the brief and event calls arm is a signal the test aborts. */
type ControlledTimeouts = { armed: AbortController[]; budgets: number[]; restore: () => void };

function controlledTimeouts(): ControlledTimeouts {
	const armed: AbortController[] = [];
	const budgets: number[] = [];
	const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
		const controller = new AbortController();
		armed.push(controller);
		budgets.push(ms);
		return controller.signal;
	});
	return { armed, budgets, restore: () => spy.mockRestore() };
}

interface Call {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** Answer call N with `reply(N)` and record every request; the last reply repeats. */
function scriptFetch(reply: (call: number) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({
			url: String(url),
			headers: init.headers as Record<string, string>,
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
		});
		return Promise.resolve(reply(calls.length - 1));
	}) as unknown as typeof fetch;
	return calls;
}

/** The last request's init, for tests that only look at one request. */
function stubFetch(
	handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): () => RequestInit {
	let captured: RequestInit = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		captured = init;
		return Promise.resolve(handler(url, init));
	}) as unknown as typeof fetch;
	return () => captured;
}

/** Record every URL fetch is called with; responds 200 "ok". */
function recordFetch(): string[] {
	const urls: string[] = [];
	globalThis.fetch = ((url: string) => {
		urls.push(String(url));
		return Promise.resolve(new Response("ok"));
	}) as unknown as typeof fetch;
	return urls;
}

/** The server's own refusal when the bearer is bound to another surface (mcp.ts `surfaceClaimRefusal`). */
function mismatch(token = "claude-code", named = "omp"): Response {
	return new Response(
		JSON.stringify({ error: `this token is ${token} and cannot act as ${named}` }),
		{
			status: 403,
			headers: { "content-type": "application/json" },
		},
	);
}

const URL_ = "http://127.0.0.1:9000";

describe("fetchBrief", () => {
	test("returns the brief body as a complete brief with no reason", async () => {
		stubFetch(() => new Response("## Substrate brief: repo\nNodes: n1 done"));
		const brief = await fetchBrief({ repo: "a/b" }, env(), URL_);
		expect(brief).toEqual({ text: "## Substrate brief: repo\nNodes: n1 done", state: "complete" });
	});

	test("sends snake_case keys, which is what the server reads", async () => {
		const calls = scriptFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b", branch: "main", graphId: "ut-1" }, env(), URL_);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({
			repo: "a/b",
			branch: "main",
			graph_id: "ut-1",
			surface: "claude-code",
		});
	});

	test("names the host's surface, and prime-agent (not a Substrate surface) as pi", async () => {
		const calls = scriptFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
		await fetchBrief({ repo: "a/b", surface: "prime-agent" }, env(), URL_);
		expect(calls.map((call) => call.body.surface)).toEqual(["omp", "pi"]);
	});

	test("a server that refuses the connection is unreachable, not a timeout", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toEqual({
			text: "",
			state: "none",
			reason: "unreachable",
		});
	});

	test("a fetch that throws synchronously still resolves", async () => {
		globalThis.fetch = (() => {
			throw new Error("sync boom");
		}) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toMatchObject({
			state: "none",
			reason: "unreachable",
		});
	});

	test("a body that fails mid-read resolves as unreachable", async () => {
		const broken = new Response(
			new ReadableStream({
				start(controller) {
					controller.error(new Error("reset"));
				},
			}),
		);
		stubFetch(() => broken);
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toMatchObject({
			state: "none",
			reason: "unreachable",
		});
	});

	test("a non-2xx names its status and never surfaces the error page", async () => {
		stubFetch(() => new Response("upstream exploded", { status: 500 }));
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toEqual({
			text: "",
			state: "none",
			reason: "http-500",
		});
		stubFetch(() => new Response("gone", { status: 404 }));
		expect((await fetchBrief({ repo: "a/b" }, env(), URL_)).reason).toBe("http-404");
	});

	test("401 is unauthorized and 400 is bad-request", async () => {
		stubFetch(() => new Response("{}", { status: 401 }));
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toEqual({
			text: "",
			state: "none",
			reason: "unauthorized",
		});
		stubFetch(() => new Response("{}", { status: 400 }));
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toEqual({
			text: "",
			state: "none",
			reason: "bad-request",
		});
	});

	test("makes no request when no URL is configured anywhere, and says so", async () => {
		const urls = recordFetch();
		const none: BriefResult = { text: "", state: "none", reason: "no-url" };
		expect(await fetchBrief({ repo: "a/b" }, env())).toEqual(none);
		expect(await fetchBrief({ repo: "a/b" }, env({ SUBSTRATE_URL: "  " }), "")).toEqual(none);
		expect(urls).toEqual([]);
	});

	test("uses the configured URL, without a trailing slash", async () => {
		const urls = recordFetch();
		await fetchBrief({ repo: "a/b" }, env(), `${URL_}/`);
		expect(urls).toEqual([`${URL_}/brief`]);
	});

	test("SUBSTRATE_URL wins over the configured URL", async () => {
		const urls = recordFetch();
		await fetchBrief({ repo: "a/b" }, env({ SUBSTRATE_URL: "https://env.test" }), URL_);
		expect(urls).toEqual(["https://env.test/brief"]);
	});

	test("SUBSTRATE_DISABLED beats both the env and the configured URL and reports disabled", async () => {
		const urls = recordFetch();
		expect(
			await fetchBrief(
				{ repo: "a/b" },
				env({ SUBSTRATE_DISABLED: "1", SUBSTRATE_URL: "https://env.test" }),
				URL_,
			),
		).toEqual({ text: "", state: "none", reason: "disabled" });
		expect(urls).toEqual([]);
	});

	test("sends a bearer token when SUBSTRATE_TOKEN is set", async () => {
		const calls = scriptFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b" }, env({ SUBSTRATE_TOKEN: "secret-token" }), URL_);
		expect(calls[0]?.headers.authorization).toBe("Bearer secret-token");
	});

	test("with no env token the bearer is the host surface's own token file", async () => {
		writeFileSync(join(tokensDir, "omp"), `${FILE_CANARY}\n`);
		writeFileSync(join(tokensDir, "claude-code"), "other-surface-token\n");
		const calls = scriptFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${FILE_CANARY}`);
		await fetchBrief({ repo: "a/b" }, env(), URL_);
		expect(calls[1]?.headers.authorization).toBe("Bearer other-surface-token");
	});

	test("no token anywhere sends no authorization header", async () => {
		const calls = scriptFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b" }, env(), URL_);
		expect(calls[0]?.headers).toEqual({ "content-type": "application/json" });
	});

	test("a caller signal ends the request as a timeout result", async () => {
		let seen: AbortSignal | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			seen = init.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
		}) as unknown as typeof fetch;
		const caller = new AbortController();
		const pending = fetchBrief(
			{ repo: "a/b", signal: caller.signal },
			env({ SUBSTRATE_TIMEOUT_MS: "60000" }),
			URL_,
		);
		expect(seen?.aborted).toBe(false);
		caller.abort();
		expect(await pending).toEqual({ text: "", state: "none", reason: "timeout" });
		expect(seen?.aborted).toBe(true);
	});

	test("the request timeout still applies when the caller never aborts", async () => {
		// The request timeout is AbortSignal.timeout; the test swaps in a signal it aborts, so no platform clock runs.
		const timeouts = controlledTimeouts();
		try {
			globalThis.fetch = ((_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(new DOMException("timed out", "TimeoutError")),
					);
					timeouts.armed.at(-1)?.abort(new DOMException("timed out", "TimeoutError"));
				})) as unknown as typeof fetch;
			expect(
				await fetchBrief(
					{ repo: "a/b", signal: new AbortController().signal },
					env({ SUBSTRATE_TIMEOUT_MS: "20" }),
					URL_,
				),
			).toEqual({ text: "", state: "none", reason: "timeout" });
		} finally {
			timeouts.restore();
		}
	});

	test("an already cancelled caller sends no request and reads as a timeout", async () => {
		const urls = recordFetch();
		const caller = new AbortController();
		caller.abort();
		expect(await fetchBrief({ repo: "a/b", signal: caller.signal }, env(), URL_)).toEqual({
			text: "",
			state: "none",
			reason: "timeout",
		});
		expect(urls).toEqual([]);
	});

	test("the body stays the snake_case keys: the signal goes to the request, never the server", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief(
			{ repo: "a/b", branch: "main", signal: new AbortController().signal },
			env(),
			URL_,
		);
		expect(JSON.parse(String(captured().body))).toEqual({
			repo: "a/b",
			branch: "main",
			surface: "claude-code",
		});
		expect(captured().signal).toBeInstanceOf(AbortSignal);
	});
});

describe("fetchBrief empty and labelled bodies", () => {
	test("a 200 with an empty body is none with no reason", async () => {
		stubFetch(() => new Response("  \n"));
		const brief = await fetchBrief({ repo: "a/b" }, env(), URL_);
		expect(brief).toEqual({ text: "", state: "none" });
		expect(brief).not.toHaveProperty("reason");
	});

	test("X-Substrate-Brief: complete adds no label", async () => {
		stubFetch(() => new Response("body\n", { headers: { "x-substrate-brief": "complete" } }));
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toEqual({
			text: "body",
			state: "complete",
		});
	});

	test("a degraded brief starts with exactly the one-line label, then the trimmed body", async () => {
		stubFetch(
			() => new Response("\n## Brief\nnodes\n", { headers: { "x-substrate-brief": "degraded" } }),
		);
		const brief = await fetchBrief({ repo: "a/b" }, env(), URL_);
		expect(brief.state).toBe("degraded");
		expect(brief.reason).toBeUndefined();
		expect(brief.text.split("\n")[0]).toBe(
			"(Substrate brief is degraded; some sources failed or the copy is a snapshot)",
		);
		expect(brief.text.endsWith("## Brief\nnodes")).toBe(true);
		expect(brief.text.split("(Substrate brief is")).toHaveLength(2);
	});

	test("a snapshot brief starts with the snapshot label", async () => {
		stubFetch(() => new Response("copy", { headers: { "x-substrate-brief": "snapshot" } }));
		const brief = await fetchBrief({ repo: "a/b" }, env(), URL_);
		expect(brief.state).toBe("snapshot");
		expect(brief.text.split("\n")[0]).toBe(
			"(Substrate brief is snapshot; some sources failed or the copy is a snapshot)",
		);
		expect(brief.text.endsWith("copy")).toBe(true);
	});

	test("an unknown X-Substrate-Brief value is read as complete", async () => {
		stubFetch(() => new Response("body", { headers: { "x-substrate-brief": "weird" } }));
		expect(await fetchBrief({ repo: "a/b" }, env(), URL_)).toEqual({
			text: "body",
			state: "complete",
		});
	});
});

describe("fetchBrief with an injected fetch", () => {
	test("the first request and the surface-mismatch retry both go through input.fetch, never the global", async () => {
		const globalCalls = scriptFetch(() => new Response("from the global"));
		const injected: Call[] = [];
		const injectedFetch = ((url: string, init: RequestInit) => {
			injected.push({
				url: String(url),
				headers: init.headers as Record<string, string>,
				body: JSON.parse(String(init.body)) as Record<string, unknown>,
			});
			return Promise.resolve(
				injected.length === 1 ? mismatch("claude-code", "omp") : new Response("## Injected"),
			);
		}) as unknown as typeof fetch;
		const brief = await fetchBrief(
			{ repo: "a/b", surface: "omp", fetch: injectedFetch },
			env({ SUBSTRATE_TOKEN: CANARY }),
			URL_,
		);
		expect(brief).toMatchObject({
			text: "## Injected",
			state: "complete",
			reason: "surface-mismatch",
		});
		expect(injected.map((call) => call.url)).toEqual([`${URL_}/brief`, `${URL_}/brief`]);
		expect(globalCalls).toEqual([]);
	});
});

describe("fetchBrief surface-mismatch retry", () => {
	test("a 403 naming the bearer's surface is retried once without a surface and recovers", async () => {
		const calls = scriptFetch((n) =>
			n === 0 ? mismatch("claude-code", "omp") : new Response("## Brief"),
		);
		const brief = await fetchBrief(
			{ repo: "a/b", branch: "main", graphId: "ut-1", surface: "omp" },
			env({ SUBSTRATE_TOKEN: CANARY }),
			URL_,
		);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.body).toEqual({
			repo: "a/b",
			branch: "main",
			graph_id: "ut-1",
			surface: "omp",
		});
		expect(calls[1]?.body).toEqual({ repo: "a/b", branch: "main", graph_id: "ut-1" });
		expect(calls[1]?.body).not.toHaveProperty("surface");
		expect(calls[1]?.headers).toEqual(calls[0]?.headers);
		expect(brief.text).toBe("## Brief");
		expect(brief.state).toBe("complete");
		expect(brief.reason).toBe("surface-mismatch");
		expect(brief.detail).toContain("claude-code");
		expect(brief.detail).toContain("omp");
	});

	test("a recovered retry keeps the degraded label and state", async () => {
		scriptFetch((n) =>
			n === 0 ? mismatch() : new Response("body", { headers: { "x-substrate-brief": "degraded" } }),
		);
		const brief = await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
		expect(brief.state).toBe("degraded");
		expect(brief.reason).toBe("surface-mismatch");
		expect(brief.text.split("\n")[0]).toBe(
			"(Substrate brief is degraded; some sources failed or the copy is a snapshot)",
		);
	});

	test("an unrecovered retry maps the second status normally and sends exactly two requests", async () => {
		let calls = scriptFetch(() => mismatch());
		expect(await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_)).toMatchObject({
			state: "none",
			reason: "http-403",
		});
		expect(calls).toHaveLength(2);

		calls = scriptFetch((n) => (n === 0 ? mismatch() : new Response("{}", { status: 401 })));
		expect((await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_)).reason).toBe(
			"unauthorized",
		);
		expect(calls).toHaveLength(2);

		calls = scriptFetch((n) => (n === 0 ? mismatch() : new Response("down", { status: 502 })));
		expect((await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_)).reason).toBe(
			"http-502",
		);
		expect(calls).toHaveLength(2);
	});

	test("a retry that cannot connect resolves as unreachable", async () => {
		let n = 0;
		globalThis.fetch = (() =>
			n++ === 0
				? Promise.resolve(mismatch())
				: Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_)).toMatchObject({
			state: "none",
			reason: "unreachable",
		});
	});

	test("an empty recovered body is none with no reason", async () => {
		scriptFetch((n) => (n === 0 ? mismatch() : new Response("")));
		expect(await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_)).toEqual({
			text: "",
			state: "none",
		});
	});

	test("no status other than a mismatch 403 is retried", async () => {
		for (const status of [400, 401, 404, 500, 503]) {
			const calls = scriptFetch(() => new Response("{}", { status }));
			await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
			expect(calls).toHaveLength(1);
		}
	});

	test("a 403 that is not the mismatch shape is not retried: the shape decides, not the status", async () => {
		const bodies = [
			JSON.stringify({ error: "forbidden" }),
			JSON.stringify({ error: 7 }),
			JSON.stringify({ message: "this token is claude-code and cannot act as omp" }),
			"this token is claude-code and cannot act as omp",
			"not json",
			"",
		];
		for (const body of bodies) {
			const calls = scriptFetch(() => new Response(body, { status: 403 }));
			const brief = await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
			expect(calls).toHaveLength(1);
			expect(brief).toEqual({ text: "", state: "none", reason: "http-403" });
		}
	});

	test("the retry is skipped with under 300 ms of the budget left", async () => {
		const calls = scriptFetch(() => mismatch());
		const brief = await fetchBrief(
			{ repo: "a/b", surface: "omp" },
			env({ SUBSTRATE_TIMEOUT_MS: "200" }),
			URL_,
		);
		expect(calls).toHaveLength(1);
		expect(brief.text).toBe("");
		expect(brief.state).toBe("none");
		expect(brief.reason).toBe("surface-mismatch");
		expect(brief.detail).toContain("claude-code");
	});

	test("the retry spends what is left of the original budget, not a fresh one", async () => {
		const timeouts = controlledTimeouts();
		// A fake clock: the first reply "takes" 400 ms, so 1100 of the 1500 ms budget remain.
		let now = 1_000_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			scriptFetch((n) => {
				if (n > 0) return new Response("recovered");
				now += 400;
				return mismatch();
			});
			const brief = await fetchBrief(
				{ repo: "a/b", surface: "omp" },
				env({ SUBSTRATE_TIMEOUT_MS: "1500" }),
				URL_,
			);
			expect(brief.reason).toBe("surface-mismatch");
			expect(brief.text).toBe("recovered");
			expect(timeouts.budgets).toEqual([1500, 1100]);
		} finally {
			clock.mockRestore();
			timeouts.restore();
		}
	});

	test("the caller's signal still ends a retry", async () => {
		const caller = new AbortController();
		let n = 0;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			if (n++ === 0) return Promise.resolve(mismatch());
			const { promise, reject } = Promise.withResolvers<Response>();
			init.signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError")),
			);
			caller.abort();
			return promise;
		}) as unknown as typeof fetch;
		expect(
			await fetchBrief({ repo: "a/b", surface: "omp", signal: caller.signal }, env(), URL_),
		).toEqual({ text: "", state: "none", reason: "timeout" });
	});
});

describe("fetchBrief never leaks a token", () => {
	test("planted env and file tokens appear in no result string, whatever the outcome", async () => {
		writeFileSync(join(tokensDir, "omp"), `${FILE_CANARY}\n`);
		const outcomes: Array<() => Response> = [
			() => new Response(`echo ${CANARY} ${FILE_CANARY}`),
			() => new Response(`echo ${CANARY}`, { status: 500 }),
			() => new Response(`echo ${CANARY}`, { status: 401 }),
			() => new Response(`echo ${CANARY}`, { status: 400 }),
			() => new Response(`echo ${FILE_CANARY}`, { status: 403 }),
			() => mismatch(CANARY, FILE_CANARY),
		];
		for (const outcome of outcomes) {
			scriptFetch(() => outcome());
			for (const planted of [{ SUBSTRATE_TOKEN: CANARY }, {}] as Array<Record<string, string>>) {
				const brief = await fetchBrief({ repo: "a/b", surface: "omp" }, env(planted), URL_);
				const printed = [brief.reason ?? "", brief.detail ?? ""].join("|");
				expect(printed).not.toContain(CANARY);
				expect(printed).not.toContain(FILE_CANARY);
			}
		}
	});

	test("a mismatch 403 naming a non-surface string never puts that string in the detail", async () => {
		scriptFetch((n) => (n === 0 ? mismatch(`<${CANARY}>`, "omp") : new Response("ok")));
		const brief = await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
		expect(brief.reason).toBe("surface-mismatch");
		expect(brief.detail).not.toContain(CANARY);
		expect(brief.detail).toContain("unknown");
	});
});

describe("fetchBrief through the gateway", () => {
	const GATEWAY = { url: "https://gateway.example/desk", seat: "lead", timeoutMs: 8_000 };

	function gatewayReply(payload: unknown): Response {
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false },
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	test("gateway text is a complete brief", async () => {
		const binding = {
			backend: "gateway" as const,
			gateway: GATEWAY,
			fetch: (async () =>
				gatewayReply({
					substrate: { ok: true, brief: "landed the cache" },
				})) as unknown as typeof fetch,
		};
		expect(
			await fetchBrief({ repo: "a/b" }, env({ DESK_GATEWAY_TOKEN: "seat-token" }), "", binding),
		).toEqual({ text: "landed the cache", state: "complete" });
	});

	test("an empty gateway answer is none/unreachable", async () => {
		const binding = {
			backend: "gateway" as const,
			gateway: GATEWAY,
			fetch: (async () =>
				gatewayReply({ substrate: { ok: true, brief: "" } })) as unknown as typeof fetch,
		};
		expect(
			await fetchBrief({ repo: "a/b" }, env({ DESK_GATEWAY_TOKEN: "seat-token" }), "", binding),
		).toEqual({ text: "", state: "none", reason: "unreachable" });
	});

	test("SUBSTRATE_DISABLED reads as disabled before the gateway is contacted", async () => {
		let contacted = false;
		const binding = {
			backend: "gateway" as const,
			gateway: GATEWAY,
			fetch: (async () => {
				contacted = true;
				return gatewayReply({});
			}) as unknown as typeof fetch,
		};
		expect(
			await fetchBrief({ repo: "a/b" }, env({ SUBSTRATE_DISABLED: "1" }), "", binding),
		).toEqual({ text: "", state: "none", reason: "disabled" });
		expect(contacted).toBe(false);
	});
});

describe("emitEvent", () => {
	test("reports success and failure without throwing", async () => {
		stubFetch(() => new Response("{}", { status: 202 }));
		expect(await emitEvent({ kind: "commit", summary: "abc" }, env(), URL_)).toBe(true);

		globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
		expect(await emitEvent({ kind: "commit", summary: "abc" }, env(), URL_)).toBe(false);
	});

	test("follows the same opt-in rule as fetchBrief", async () => {
		const urls = recordFetch();
		expect(await emitEvent({ kind: "commit", summary: "abc" }, env())).toBe(false);
		expect(
			await emitEvent({ kind: "commit", summary: "abc" }, env({ SUBSTRATE_DISABLED: "1" }), URL_),
		).toBe(false);
		expect(
			await emitEvent(
				{ kind: "commit", summary: "abc" },
				env({ SUBSTRATE_URL: "https://env.test" }),
				URL_,
			),
		).toBe(true);
		expect(urls).toEqual(["https://env.test/events"]);
	});

	test("sends snake_case keys, the content type and the bearer token, which is what the server reads", async () => {
		const captured = stubFetch(() => new Response("{}", { status: 202 }));
		await emitEvent(
			{
				kind: "note",
				summary: "ultrathink planned graph ut-1 (5 nodes)",
				surface: "hermes",
				sessionId: "s1",
				graphId: "ut-1",
				nodeId: "n1",
				repo: "a/b",
				branch: "main",
				payload: { ultrathink: "plan", nodes: 5 },
			},
			env({ SUBSTRATE_TOKEN: "secret-token" }),
			URL_,
		);
		const init = captured();
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"content-type": "application/json",
			authorization: "Bearer secret-token",
		});
		expect(JSON.parse(String(init.body))).toEqual({
			kind: "note",
			summary: "ultrathink planned graph ut-1 (5 nodes)",
			surface: "hermes",
			session_id: "s1",
			graph_id: "ut-1",
			node_id: "n1",
			repo: "a/b",
			branch: "main",
			payload: { ultrathink: "plan", nodes: 5 },
		});

		// No surface named: the event is Claude Code's, as for the brief.
		await emitEvent({ kind: "note", summary: "s" }, env(), URL_);
		expect(JSON.parse(String(captured().body)).surface).toBe("claude-code");
	});

	test("the body surface is the mapped host surface: a surface host as itself, an unknown host as claude-code", async () => {
		const calls = scriptFetch(() => new Response("{}", { status: 202 }));
		await emitEvent({ kind: "note", summary: "s", surface: "omp" }, env(), URL_);
		await emitEvent({ kind: "note", summary: "s", surface: "grok-bot" }, env(), URL_);
		await emitEvent({ kind: "note", summary: "s", surface: "gpt-dot" }, env(), URL_);
		expect(calls.map((call) => call.body.surface)).toEqual(["omp", "grok-bot", "claude-code"]);
		// A host that is a surface carries no payload of its own.
		expect(calls[0]?.body).not.toHaveProperty("payload");
	});

	test("prime-agent sends no surface and carries payload.host; caller keys survive, host is forced", async () => {
		const calls = scriptFetch(() => new Response("{}", { status: 202 }));
		await emitEvent({ kind: "note", summary: "s", surface: "prime-agent" }, env(), URL_);
		await emitEvent(
			{
				kind: "note",
				summary: "s",
				surface: "prime-agent",
				payload: { ultrathink: "plan", host: "spoofed" },
			},
			env(),
			URL_,
		);
		expect(calls[0]?.body).not.toHaveProperty("surface");
		expect(calls[0]?.body.payload).toEqual({ host: "prime-agent" });
		expect(calls[1]?.body).not.toHaveProperty("surface");
		expect(calls[1]?.body.payload).toEqual({ ultrathink: "plan", host: "prime-agent" });
	});

	test("the bearer is the host surface's token file when no env token is set", async () => {
		writeFileSync(join(tokensDir, "hermes"), `${FILE_CANARY}\n`);
		writeFileSync(join(tokensDir, "pi"), "pi-token\n");
		const calls = scriptFetch(() => new Response("{}", { status: 202 }));
		await emitEvent({ kind: "note", summary: "s", surface: "hermes" }, env(), URL_);
		await emitEvent({ kind: "note", summary: "s", surface: "prime-agent" }, env(), URL_);
		await emitEvent({ kind: "note", summary: "s", surface: "cursor" }, env(), URL_);
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${FILE_CANARY}`);
		expect(calls[1]?.headers.authorization).toBe("Bearer pi-token");
		expect(calls[2]?.headers).toEqual({ "content-type": "application/json" });
	});

	test("a planted token appears only in the Authorization header, never in a body or another header", async () => {
		writeFileSync(join(tokensDir, "omp"), `${FILE_CANARY}\n`);
		const calls = scriptFetch(() => new Response("{}", { status: 202 }));
		await emitEvent({ kind: "note", summary: "s", surface: "omp" }, env(), URL_);
		await emitEvent(
			{ kind: "note", summary: "s", surface: "prime-agent" },
			env({ SUBSTRATE_TOKEN: CANARY }),
			URL_,
		);
		for (const call of calls) {
			const { authorization, ...rest } = call.headers;
			expect(authorization).toMatch(/^Bearer sk-or-v1-/);
			expect(JSON.stringify(rest)).not.toContain("CANARY");
			expect(JSON.stringify(call.body)).not.toContain("CANARY");
		}
	});

	test("a non-2xx answer is not an accepted event, and a server that never answers is given up on at the timeout", async () => {
		stubFetch(() => new Response("upstream exploded", { status: 503 }));
		expect(await emitEvent({ kind: "note", summary: "s" }, env(), URL_)).toBe(false);

		globalThis.fetch = ((_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			})) as unknown as typeof fetch;
		expect(
			await emitEvent({ kind: "note", summary: "s" }, env({ SUBSTRATE_TIMEOUT_MS: "20" }), URL_),
		).toBe(false);
	});

	test("an already-aborted signal sends nothing", async () => {
		const urls = recordFetch();
		expect(await emitEvent({ kind: "note", summary: "s" }, env(), URL_, AbortSignal.abort())).toBe(
			false,
		);
		expect(urls).toEqual([]);
	});

	test("a signal aborted while the request hangs ends it promptly, well inside the substrate timeout", async () => {
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init.signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError")),
			);
			return promise;
		}) as unknown as typeof fetch;
		const controller = new AbortController();
		const started = performance.now();
		const pending = emitEvent(
			{ kind: "note", summary: "s" },
			env({ SUBSTRATE_TIMEOUT_MS: "30000" }),
			URL_,
			controller.signal,
		);
		controller.abort();
		expect(await pending).toBe(false);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	test("a live signal leaves the request unchanged", async () => {
		const captured = stubFetch(() => new Response("{}", { status: 202 }));
		const controller = new AbortController();
		expect(await emitEvent({ kind: "note", summary: "s" }, env(), URL_, controller.signal)).toBe(
			true,
		);
		expect(captured().signal?.aborted).toBe(false);
	});
});

interface Hop {
	url: string;
	headers: Record<string, string>;
	redirect: RequestInit["redirect"];
}

const EVIL = "https://evil.example.com";

/**
 * Real fetch semantics for a server that answers 302: told `redirect: "error"` it throws a TypeError; otherwise it
 * follows to the target, bearer included, and the target answers 200/202.
 */
function redirectingFetch(): { hops: Hop[]; fetch: typeof fetch } {
	const hops: Hop[] = [];
	async function fake(url: string | URL | Request, init?: RequestInit): Promise<Response> {
		hops.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			redirect: init?.redirect,
		});
		if (String(url).startsWith(EVIL)) return new Response("# stolen brief", { status: 202 });
		if (init?.redirect === "error") throw new TypeError("fetch failed: redirect is not allowed");
		return fake(`${EVIL}/brief`, init);
	}
	return { hops, fetch: fake as unknown as typeof fetch };
}

describe("redirects are refused, never followed", () => {
	test("a redirected brief is the failure `redirect refused`; the bearer never reaches the second hop", async () => {
		const { hops, fetch: fake } = redirectingFetch();
		const result = await fetchBrief(
			{ repo: "a/b", fetch: fake },
			env({ SUBSTRATE_TOKEN: CANARY }),
			URL_,
		);
		expect(result).toEqual({ text: "", state: "none", reason: "redirect refused" });
		expect(hops.map((hop) => hop.url)).toEqual([`${URL_}/brief`]);
		expect(hops[0]?.redirect).toBe("error");
		expect(JSON.stringify(result)).not.toContain(CANARY);
	});

	test("a redirected surface-mismatch retry is refused too", async () => {
		const hops: Hop[] = [];
		const fake = (async (url: string, init: RequestInit) => {
			hops.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect });
			if (hops.length === 1) return mismatch();
			if (init.redirect === "error") throw new TypeError("fetch failed: redirect is not allowed");
			return new Response("# stolen");
		}) as unknown as typeof fetch;
		const result = await fetchBrief(
			{ repo: "a/b", surface: "omp", fetch: fake },
			env({ SUBSTRATE_TOKEN: CANARY }),
			URL_,
		);
		expect(result).toEqual({ text: "", state: "none", reason: "redirect refused" });
		expect(hops.map((hop) => hop.redirect)).toEqual(["error", "error"]);
	});

	test("a redirected event is not delivered and the bearer never reaches the second hop", async () => {
		const { hops, fetch: fake } = redirectingFetch();
		globalThis.fetch = fake;
		const stored = await emitEvent(
			{ kind: "note", summary: "s" },
			env({ SUBSTRATE_TOKEN: CANARY }),
			URL_,
		);
		expect(stored).toBe(false);
		expect(hops.map((hop) => hop.url)).toEqual([`${URL_}/events`]);
		expect(hops[0]?.redirect).toBe("error");
	});

	test("an unrelated connection failure is still `unreachable`, not a refused redirect", async () => {
		const fake = (async () => {
			throw new TypeError("fetch failed: ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b", fetch: fake }, env(), URL_)).toEqual({
			text: "",
			state: "none",
			reason: "unreachable",
		});
	});
});

describe("the URL policy applies whenever a bearer is attached", () => {
	const REMOTE_HTTP = "http://substrate.example.com";

	test("a bearer with plain http to a remote host sends nothing and fails `url refused: ...`", async () => {
		const urls = recordFetch();
		const result = await fetchBrief({ repo: "a/b" }, env({ SUBSTRATE_TOKEN: CANARY }), REMOTE_HTTP);
		expect(result.state).toBe("none");
		expect(result.reason).toStartWith("url refused: ");
		expect(urls).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(CANARY);
		expect(JSON.stringify(result)).not.toContain("substrate.example.com");
	});

	test("the same URL with no bearer still sends", async () => {
		const urls = recordFetch();
		await fetchBrief({ repo: "a/b" }, env(), REMOTE_HTTP);
		expect(urls).toEqual([`${REMOTE_HTTP}/brief`]);
	});

	test("a user name, password, query or fragment in the URL is refused with a reason that does not echo it", async () => {
		const urls = recordFetch();
		for (const bad of [
			"https://user:hunter2@x.example.com",
			"https://x.example.com/?q=1",
			"https://x.example.com/#frag",
		]) {
			const result = await fetchBrief({ repo: "a/b" }, env({ SUBSTRATE_TOKEN: CANARY }), bad);
			expect(result.reason).toStartWith("url refused: ");
			expect(JSON.stringify(result)).not.toContain("hunter2");
		}
		expect(urls).toEqual([]);
	});

	test("loopback http and a remote https URL pass, and the normalised URL is the one used", async () => {
		const urls = recordFetch();
		const bearer = env({ SUBSTRATE_TOKEN: CANARY });
		await fetchBrief({ repo: "a/b" }, bearer, "http://127.0.0.1:7410");
		await fetchBrief({ repo: "a/b" }, bearer, "https://x.example.com/base/");
		expect(urls).toEqual(["http://127.0.0.1:7410/brief", "https://x.example.com/base/brief"]);
	});

	test("an event with a bearer to a refused URL sends nothing; without a bearer it sends", async () => {
		const urls = recordFetch();
		expect(
			await emitEvent(
				{ kind: "note", summary: "s" },
				env({ SUBSTRATE_TOKEN: CANARY }),
				REMOTE_HTTP,
			),
		).toBe(false);
		expect(urls).toEqual([]);
		expect(await emitEvent({ kind: "note", summary: "s" }, env(), REMOTE_HTTP)).toBe(true);
		expect(urls).toEqual([`${REMOTE_HTTP}/events`]);
	});

	test("an event to an allowed URL goes to the normalised `/events` path", async () => {
		const urls = recordFetch();
		await emitEvent(
			{ kind: "note", summary: "s" },
			env({ SUBSTRATE_TOKEN: CANARY }),
			"https://x.example.com/base/",
		);
		expect(urls).toEqual(["https://x.example.com/base/events"]);
	});
});

describe("boundedLine", () => {
	test("turns controls and bidi overrides into spaces, collapses whitespace and trims", () => {
		expect(boundedLine("  a\u0000b\u001b[31m\n\tc\u009dd\u202Ee  ")).toBe("a b [31m c d e");
	});

	test("leaves a short printable line unchanged", () => {
		expect(boundedLine("token omp cannot act as host surface pi")).toBe(
			"token omp cannot act as host surface pi",
		);
	});

	test("caps at 160 characters with a trailing ellipsis, and keeps exactly 160 as is", () => {
		const long = boundedLine("x".repeat(5000));
		expect(long).toHaveLength(160);
		expect(long.endsWith("...")).toBe(true);
		expect(boundedLine("y".repeat(160))).toBe("y".repeat(160));
	});

	test("a hostile 403 body never puts server text in the detail, and the detail stays one short line", async () => {
		const hostile = `\u001b[31m${"A\u0007\u009b ".repeat(1000)}`;
		scriptFetch((n) => (n === 0 ? mismatch(hostile, "omp") : new Response("ok")));
		const result = await fetchBrief({ repo: "a/b", surface: "omp" }, env(), URL_);
		expect(result.reason).toBe("surface-mismatch");
		expect((result.detail ?? "").length).toBeLessThanOrEqual(160);
		expect(/[\u0000-\u001f\u007f-\u009f]/.test(result.detail ?? "")).toBe(false);
	});
});
