// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFailure } from "../failover/classify.ts";
import { readReport } from "../types.ts";
import {
	buildClaudeArgs,
	CHILD_ENV,
	CLAUDE_AUTH_MODES,
	type ClaudeCallInfo,
	ClaudeResultError,
	abortError,
	createClaudeCompleter,
	isChildInvocation,
	PLAN_SCRUBBED_ENV,
	parseClaudeJson,
	parseClaudeResult,
	planEnv,
} from "./complete.ts";

describe("buildClaudeArgs", () => {
	test("disables tools and settings, asks for json, passes system prompt", () => {
		const args = buildClaudeArgs("SYS");
		expect(args).toEqual([
			"-p",
			"--tools",
			"",
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--strict-mcp-config",
			"--exclude-dynamic-system-prompt-sections",
			"--output-format",
			"json",
			"--system-prompt",
			"SYS",
		]);
	});

	test("adds model and custom setting sources when given", () => {
		const args = buildClaudeArgs("SYS", { model: " sonnet ", settingSources: "user" });
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
		expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
	});
});

describe("parseClaudeJson", () => {
	test("returns result text", () => {
		expect(parseClaudeJson('{"type":"result","is_error":false,"result":"<X/>"}')).toBe("<X/>");
	});

	test("throws on is_error with the result message", () => {
		expect(() => parseClaudeJson('{"is_error":true,"result":"Not logged in"}')).toThrow(
			"Not logged in",
		);
	});

	test("throws on empty or non-json output", () => {
		expect(() => parseClaudeJson("")).toThrow();
		expect(() => parseClaudeJson("nope")).toThrow();
	});

	test("tolerates log lines before the JSON object", () => {
		expect(parseClaudeJson('warn: something\n{"result":"ok","is_error":false}')).toBe("ok");
	});
});

describe("isChildInvocation", () => {
	test("true only when the marker is 1", () => {
		expect(isChildInvocation({ [CHILD_ENV]: "1" })).toBe(true);
		expect(isChildInvocation({ [CHILD_ENV]: "0" })).toBe(false);
		expect(isChildInvocation({})).toBe(false);
	});
});

describe("planEnv", () => {
	test("copies without the scrubbed variables and does not mutate its input", () => {
		const input: Record<string, string | undefined> = {
			PATH: "/bin",
			ANTHROPIC_API_KEY: "sk-ant-fake",
			ANTHROPIC_AUTH_TOKEN: "fake-token",
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CODE_USE_VERTEX: "1",
			CLAUDE_CODE_USE_FOUNDRY: "1",
			CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
		};
		const out = planEnv(input);
		expect(out).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth" });
		expect(out).not.toBe(input);
		expect(Object.keys(input)).toHaveLength(7);
		expect(input.ANTHROPIC_API_KEY).toBe("sk-ant-fake");
	});

	test("scrubs exactly the documented variables", () => {
		expect([...PLAN_SCRUBBED_ENV]).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_VERTEX",
			"CLAUDE_CODE_USE_FOUNDRY",
		]);
		expect([...CLAUDE_AUTH_MODES]).toEqual(["plan", "api-key"]);
	});
});

describe("parseClaudeResult", () => {
	test("sums input, cache read and cache creation tokens and reads the first model", () => {
		const stdout = JSON.stringify({
			type: "result",
			is_error: false,
			result: "hello",
			usage: {
				input_tokens: 10,
				cache_read_input_tokens: 200,
				cache_creation_input_tokens: 3000,
				output_tokens: 42,
			},
			modelUsage: { "claude-haiku-5-5": { inputTokens: 10 }, "other-model": {} },
		});
		expect(parseClaudeResult(stdout)).toEqual({
			text: "hello",
			info: { inputTokens: 3210, outputTokens: 42, model: "claude-haiku-5-5" },
		});
	});

	test("ignores missing and non-numeric usage fields", () => {
		const stdout = JSON.stringify({
			result: "ok",
			usage: { input_tokens: 7, cache_read_input_tokens: "many", output_tokens: null },
		});
		expect(parseClaudeResult(stdout).info).toEqual({ inputTokens: 7 });
	});

	test("a payload without usage yields empty info", () => {
		expect(parseClaudeResult('{"result":"ok","is_error":false}')).toEqual({ text: "ok", info: {} });
	});

	test("throws a ClaudeResultError carrying the api status on is_error", () => {
		let thrown: unknown;
		try {
			parseClaudeResult('{"is_error":true,"api_error_status":429,"result":"slow down"}');
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ClaudeResultError);
		expect((thrown as ClaudeResultError).apiErrorStatus).toBe(429);
		expect((thrown as ClaudeResultError).name).toBe("ClaudeResultError");
	});
});

const noWait = { sleep: async (): Promise<void> => undefined, random: () => 0 };

describe("claudeComplete plan auth", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const okResult =
		'{"type":"result","is_error":false,"result":"plan ok","usage":{"input_tokens":5,"cache_read_input_tokens":20,"output_tokens":9},"modelUsage":{"claude-haiku-5-5":{}}}';
	const limitError =
		'{"type":"result","is_error":true,"api_error_status":429,"result":"Too many requests, slow down"}';
	const sessionLimitError =
		'{"type":"result","is_error":true,"api_error_status":429,"result":"You\'ve hit your session limit"}';

	/** Stub `claude`: logs the credential env it sees, one line per call, then prints `STUB_OUT` and exits `STUB_EXIT`. */
	function setup(): {
		bin: string;
		log: () => string[];
		caps: () => string[];
		env: (extra: Record<string, string>) => Record<string, string | undefined>;
	} {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-complete-"));
		dirs.push(dir);
		const bin = join(dir, "claude");
		const logFile = join(dir, "calls.log");
		const capFile = join(dir, "caps.log");
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
				"cat >/dev/null",
				`echo "key=\${ANTHROPIC_API_KEY:+set} token=\${ANTHROPIC_AUTH_TOKEN:+set} bedrock=\${CLAUDE_CODE_USE_BEDROCK:+set} vertex=\${CLAUDE_CODE_USE_VERTEX:+set} foundry=\${CLAUDE_CODE_USE_FOUNDRY:+set} oauth=\${CLAUDE_CODE_OAUTH_TOKEN:+set} child=\${ULTRATHINK_CHILD}" >> "${logFile}"`,
				`echo "cap=\${CLAUDE_CODE_MAX_OUTPUT_TOKENS}" >> "${capFile}"`,
				"printf '%s\\n' \"$STUB_OUT\"",
				'exit "${STUB_EXIT:-0}"',
			].join("\n"),
			{ mode: 0o755 },
		);
		return {
			bin,
			log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : []),
			caps: () => (existsSync(capFile) ? readFileSync(capFile, "utf8").trim().split("\n") : []),
			env: (extra) => ({ PATH: process.env.PATH, ...extra }),
		};
	}

	test("maxOutputTokens sets CLAUDE_CODE_MAX_OUTPUT_TOKENS in plan mode, floored", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			maxOutputTokens: 1234.9,
			env: stub.env({ STUB_OUT: okResult }),
		});
		await complete("s", "u");
		expect(stub.caps()).toEqual(["cap=1234"]);
	});

	test("maxOutputTokens also reaches the child in api-key mode", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			auth: "api-key",
			maxOutputTokens: 500,
			env: stub.env({ ANTHROPIC_API_KEY: "sk-ant-fake", STUB_OUT: okResult }),
		});
		await complete("s", "u");
		expect(stub.caps()).toEqual(["cap=500"]);
	});

	for (const auth of ["plan", "api-key"] as const) {
		test(`the ${auth} child never sees the Jev key variables inherited from the parent env`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-jev-"));
			dirs.push(dir);
			const bin = join(dir, "claude");
			const seenFile = join(dir, "seen.log");
			writeFileSync(
				bin,
				[
					"#!/bin/sh",
					"cat >/dev/null",
					`echo "ult=\${ULTRATHINK_OPENROUTER_KEY:+set} or=\${OPENROUTER_API_KEY:+set} gw=\${AI_GATEWAY_API_KEY:+set} anth=\${ANTHROPIC_API_KEY:+set}" >> "${seenFile}"`,
					"printf '%s\\n' \"$STUB_OUT\"",
				].join("\n"),
				{ mode: 0o755 },
			);
			const saved = {
				ult: process.env.ULTRATHINK_OPENROUTER_KEY,
				or: process.env.OPENROUTER_API_KEY,
				gw: process.env.AI_GATEWAY_API_KEY,
				anth: process.env.ANTHROPIC_API_KEY,
				out: process.env.STUB_OUT,
			};
			process.env.ULTRATHINK_OPENROUTER_KEY = "sk-or-v1-UTTESTKEY-0123456789abcdef";
			process.env.OPENROUTER_API_KEY = "sk-or-v1-UTTESTKEY-0123456789abcdef";
			process.env.AI_GATEWAY_API_KEY = "vck_UTTESTKEY0123456789abcdef";
			process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
			process.env.STUB_OUT = okResult;
			try {
				await createClaudeCompleter({ bin, auth })("s", "u");
			} finally {
				for (const [name, value] of [
					["ULTRATHINK_OPENROUTER_KEY", saved.ult],
					["OPENROUTER_API_KEY", saved.or],
					["AI_GATEWAY_API_KEY", saved.gw],
					["ANTHROPIC_API_KEY", saved.anth],
					["STUB_OUT", saved.out],
				] as const) {
					if (value === undefined) delete process.env[name];
					else process.env[name] = value;
				}
			}
			expect(readFileSync(seenFile, "utf8").trim()).toBe(
				`ult= or= gw= anth=${auth === "api-key" ? "set" : ""}`,
			);
		});
	}

	test("a failing child's stderr is masked before it is thrown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-stderr-"));
		dirs.push(dir);
		const bin = join(dir, "claude");
		const canary = "sk-or-v1-CANARYCANARYCANARY1234";
		writeFileSync(
			bin,
			["#!/bin/sh", "cat >/dev/null", `echo "auth failed for ${canary}" >&2`, "exit 1"].join("\n"),
			{ mode: 0o755 },
		);
		let thrown: unknown;
		try {
			await createClaudeCompleter({ bin, env: { PATH: process.env.PATH }, retrySeams: noWait })(
				"s",
				"u",
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("auth failed");
		expect(message).not.toContain(canary);
		expect(message).not.toContain("CANARYCANARYCANARY");
	});

	test("no cap variable is set without maxOutputTokens or for a non-positive value", async () => {
		for (const maxOutputTokens of [undefined, 0, -5, 0.4, Number.NaN]) {
			const stub = setup();
			const complete = createClaudeCompleter({
				bin: stub.bin,
				maxOutputTokens,
				env: stub.env({ STUB_OUT: okResult }),
			});
			await complete("s", "u");
			expect(stub.caps()).toEqual(["cap="]);
		}
	});

	const credentials = {
		ANTHROPIC_API_KEY: "sk-ant-fake",
		ANTHROPIC_AUTH_TOKEN: "fake-token",
		CLAUDE_CODE_USE_BEDROCK: "1",
		CLAUDE_CODE_USE_VERTEX: "1",
		CLAUDE_CODE_USE_FOUNDRY: "1",
	};

	test("default strips the credentials that outrank the plan login", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({ ...credentials, STUB_OUT: okResult }),
		});
		expect(await complete("s", "u")).toBe("plan ok");
		expect(stub.log()).toEqual(["key= token= bedrock= vertex= foundry= oauth= child=1"]);
	});

	test("auth plan behaves like the default", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			auth: "plan",
			env: stub.env({ ...credentials, STUB_OUT: okResult }),
		});
		await complete("s", "u");
		expect(stub.log()).toEqual(["key= token= bedrock= vertex= foundry= oauth= child=1"]);
	});

	test("auth api-key passes the credentials through", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			auth: "api-key",
			env: stub.env({ ...credentials, STUB_OUT: okResult }),
		});
		expect(await complete("s", "u")).toBe("plan ok");
		expect(stub.log()).toEqual([
			"key=set token=set bedrock=set vertex=set foundry=set oauth= child=1",
		]);
	});

	test("CLAUDE_CODE_OAUTH_TOKEN survives plan mode", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({
				...credentials,
				CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
				STUB_OUT: okResult,
			}),
		});
		await complete("s", "u");
		expect(stub.log()).toEqual(["key= token= bedrock= vertex= foundry= oauth=set child=1"]);
	});

	test("a 429 call is retried on the same model and finally throws the ClaudeResultError with the status", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			retrySeams: noWait,
			env: stub.env({ ...credentials, STUB_OUT: limitError, STUB_EXIT: "1" }),
		});
		let thrown: unknown;
		try {
			await complete("s", "u");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ClaudeResultError);
		expect((thrown as ClaudeResultError).apiErrorStatus).toBe(429);
		expect((thrown as ClaudeResultError).message).toBe("Too many requests, slow down");
		expect(stub.log()).toHaveLength(3);
	});

	test("a 429 with session-limit wording is permanent and is not retried", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			retrySeams: noWait,
			env: stub.env({ ...credentials, STUB_OUT: sessionLimitError, STUB_EXIT: "1" }),
		});
		let thrown: unknown;
		try {
			await complete("s", "u");
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ClaudeResultError);
		expect((thrown as ClaudeResultError).apiErrorStatus).toBe(429);
		expect((thrown as ClaudeResultError).message).toBe("You've hit your session limit");
		expect(stub.log()).toHaveLength(1);
	});

	test("a failing call with api-key auth is also attempted exactly once", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			auth: "api-key",
			env: stub.env({
				ANTHROPIC_API_KEY: "sk-ant-fake",
				STUB_OUT:
					'{"type":"result","is_error":true,"api_error_status":400,"result":"Credit balance is too low"}',
				STUB_EXIT: "1",
			}),
		});
		await expect(complete("s", "u")).rejects.toThrow("Credit balance is too low");
		expect(stub.log()).toHaveLength(1);
	});

	test("onResult fires once with usage info for a success", async () => {
		const stub = setup();
		const seen: ClaudeCallInfo[] = [];
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({ STUB_OUT: okResult }),
			onResult: (info) => seen.push(info),
		});
		await complete("s", "u");
		expect(seen).toEqual([{ inputTokens: 25, outputTokens: 9, model: "claude-haiku-5-5" }]);
	});

	test("onResult fires once per attempt for an is_error result, before the error is thrown", async () => {
		const stub = setup();
		const seen: ClaudeCallInfo[] = [];
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({
				STUB_OUT:
					'{"type":"result","is_error":true,"api_error_status":429,"result":"limit","usage":{"input_tokens":4,"output_tokens":1},"modelUsage":{"claude-haiku-5-5":{}}}',
				STUB_EXIT: "1",
			}),
			retrySeams: noWait,
			onResult: (info) => seen.push(info),
		});
		await expect(complete("s", "u")).rejects.toBeInstanceOf(ClaudeResultError);
		// The 429 is transient: three attempts, each reports its own usage.
		expect(seen).toEqual(
			Array(3).fill({ inputTokens: 4, outputTokens: 1, model: "claude-haiku-5-5" }),
		);
	});

	test("onResult is not called for non-JSON output", async () => {
		const stub = setup();
		let calls = 0;
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({ STUB_OUT: "not json" }),
			retrySeams: noWait,
			onResult: () => {
				calls += 1;
			},
		});
		await expect(complete("s", "u")).rejects.toThrow("claude output is not JSON");
		expect(calls).toBe(0);
	});

	test("an onResult exception is swallowed and the text is still returned", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({ STUB_OUT: okResult }),
			onResult: () => {
				throw new Error("hook failed");
			},
		});
		expect(await complete("s", "u")).toBe("plan ok");
	});
});

describe("claudeComplete resilience", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	interface Step {
		out?: string;
		err?: string;
		exit?: number;
	}

	/** Stub `claude` whose n-th call replays steps[n-1] (the last step repeats); `spawns()` counts calls. */
	function sequence(steps: Step[]): { bin: string; spawns: () => number } {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-seq-"));
		dirs.push(dir);
		steps.forEach((step, index) => {
			writeFileSync(join(dir, `out.${index + 1}`), step.out ?? "");
			writeFileSync(join(dir, `err.${index + 1}`), step.err ?? "");
			writeFileSync(join(dir, `exit.${index + 1}`), String(step.exit ?? 0));
		});
		const counter = join(dir, "counter");
		const bin = join(dir, "claude");
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
				"cat >/dev/null",
				`n=$(cat "${counter}" 2>/dev/null || echo 0)`,
				"n=$((n+1))",
				`echo $n > "${counter}"`,
				`[ $n -gt ${steps.length} ] && n=${steps.length}`,
				`cat "${dir}/out.$n"`,
				`cat "${dir}/err.$n" >&2`,
				`exit $(cat "${dir}/exit.$n")`,
			].join("\n"),
			{ mode: 0o755 },
		);
		return {
			bin,
			spawns: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8").trim()) : 0),
		};
	}

	const env = { PATH: process.env.PATH };
	const ok = (text: string): string =>
		JSON.stringify({ type: "result", is_error: false, result: text });
	const transient: Step = { err: "fetch failed", exit: 1 };

	async function failure(run: Promise<string>): Promise<Error> {
		return run.then(
			() => new Error("should have thrown"),
			(error: Error) => error,
		);
	}

	test("a transient failure is retried on the same model and succeeds on attempt 2", async () => {
		const stub = sequence([transient, { out: ok("second") }]);
		const complete = createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait });
		expect(await complete("s", "u")).toBe("second");
		expect(stub.spawns()).toBe(2);
	});

	test("a success spawns exactly once", async () => {
		const stub = sequence([{ out: ok("fine") }]);
		await createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u");
		expect(stub.spawns()).toBe(1);
	});

	test("two transient failures then a success resolves on attempt 3", async () => {
		const stub = sequence([transient, transient, { out: ok("third") }]);
		const complete = createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait });
		expect(await complete("s", "u")).toBe("third");
		expect(stub.spawns()).toBe(3);
	});

	test("a truncated reply (max_tokens) is a failed attempt with cause truncated_reply", async () => {
		const truncated = JSON.stringify({
			type: "result",
			is_error: false,
			result: "cut off mid-sen",
			stop_reason: "max_tokens",
		});
		const stub = sequence([{ out: truncated }]);
		const error = await failure(
			createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u"),
		);
		expect(readReport(error)?.cause).toBe("truncated_reply");
		expect(readReport(error)?.attempts).toBe(3);
		expect(stub.spawns()).toBe(3);
	});

	test("a truncated first reply followed by a complete one resolves with the complete text", async () => {
		const truncated = JSON.stringify({ is_error: false, result: "cut", stop_reason: "max_tokens" });
		const stub = sequence([{ out: truncated }, { out: ok("whole") }]);
		const complete = createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait });
		expect(await complete("s", "u")).toBe("whole");
	});

	test("an empty reply text is a truncated_reply failure, never accepted text", async () => {
		const stub = sequence([{ out: ok("") }]);
		const error = await failure(
			createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u"),
		);
		expect(readReport(error)?.cause).toBe("truncated_reply");
	});

	test("a permanent failure is not retried", async () => {
		const stub = sequence([{ err: "permission denied", exit: 1 }]);
		const error = await failure(
			createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u"),
		);
		expect(error.message).toContain("permission denied");
		expect(stub.spawns()).toBe(1);
		expect(readReport(error)?.attempts).toBe(1);
	});

	test("an abort during the backoff rejects with AbortError after one spawn", async () => {
		const stub = sequence([transient, { out: ok("never") }]);
		const controller = new AbortController();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env,
			retrySeams: {
				sleep: async () => {
					controller.abort();
					throw abortError();
				},
			},
		});
		const error = await failure(complete("s", "u", controller.signal));
		expect(error.name).toBe("AbortError");
		expect(readReport(error)).toBeUndefined();
		expect(stub.spawns()).toBe(1);
	});

	test("an already-aborted signal rejects without spawning", async () => {
		const stub = sequence([{ out: ok("never") }]);
		const controller = new AbortController();
		controller.abort();
		const error = await failure(
			createClaudeCompleter({ bin: stub.bin, env })("s", "u", controller.signal),
		);
		expect(error.name).toBe("AbortError");
		expect(stub.spawns()).toBe(0);
	});

	test("the report cause is redacted, one line and at most 200 characters", async () => {
		const secret = "sk-ant-api03-SENTINELSENTINELSENTINEL1234567890";
		const stub = sequence([
			{ err: `first line ${secret}\nsecond line ${"x".repeat(400)}`, exit: 1 },
		]);
		const error = await failure(
			createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u"),
		);
		const cause = readReport(error)?.cause ?? "";
		expect(cause.length).toBeGreaterThan(0);
		expect(cause.length).toBeLessThanOrEqual(200);
		expect(cause).not.toContain("\n");
		expect(cause).not.toContain("SENTINELSENTINEL");
	});

	test("a transient failure on every attempt throws the original error with attempts 3", async () => {
		const stub = sequence([transient]);
		const error = await failure(
			createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u"),
		);
		expect(error.name).not.toBe("RetryExhaustedError");
		expect(error.message).toBe("fetch failed");
		expect(readReport(error)?.attempts).toBe(3);
		expect(stub.spawns()).toBe(3);
	});

	test("an api_error_status surfaces as the report httpStatus", async () => {
		for (const status of [429, 529]) {
			const stub = sequence([
				{
					out: JSON.stringify({ is_error: true, api_error_status: status, result: "busy" }),
					exit: 1,
				},
			]);
			const error = await failure(
				createClaudeCompleter({ bin: stub.bin, env, retrySeams: noWait })("s", "u"),
			);
			expect(error).toBeInstanceOf(ClaudeResultError);
			expect(readReport(error)?.httpStatus).toBe(status);
			expect(stub.spawns()).toBe(3);
		}
	});

	test("a timeout is final and not retried", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-hang-"));
		dirs.push(dir);
		const bin = join(dir, "claude");
		writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
		const error = await failure(
			createClaudeCompleter({ bin, env, timeoutMs: 50, retrySeams: noWait })("s", "u"),
		);
		expect(error.message).toBe("claude timed out after 50ms");
		expect(readReport(error)?.attempts).toBe(1);
	});

	test("a child killed by a signal with no output keeps its cause for the failover classifier", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-killed-"));
		dirs.push(dir);
		const bin = join(dir, "claude");
		writeFileSync(bin, "#!/bin/sh\ncat >/dev/null\nkill -9 $$\n", { mode: 0o755 });
		const error = await failure(createClaudeCompleter({ bin, env, retrySeams: noWait })("s", "u"));
		expect(error.message).toContain("SIGKILL");
		expect(classifyFailure(error)).toBe("network");
		expect(readReport(error)?.cause).toContain("SIGKILL");
	});
});
