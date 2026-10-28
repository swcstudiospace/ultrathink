// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildClaudeArgs,
	CHILD_ENV,
	CLAUDE_AUTH_MODES,
	type ClaudeCallInfo,
	ClaudeResultError,
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

describe("claudeComplete plan auth", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const okResult =
		'{"type":"result","is_error":false,"result":"plan ok","usage":{"input_tokens":5,"cache_read_input_tokens":20,"output_tokens":9},"modelUsage":{"claude-haiku-5-5":{}}}';
	const limitError =
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

	test("a failing call is attempted exactly once and throws a ClaudeResultError with the status", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
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

	test("onResult fires once for an is_error result, before the error is thrown", async () => {
		const stub = setup();
		const seen: ClaudeCallInfo[] = [];
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({
				STUB_OUT:
					'{"type":"result","is_error":true,"api_error_status":429,"result":"limit","usage":{"input_tokens":4,"output_tokens":1},"modelUsage":{"claude-haiku-5-5":{}}}',
				STUB_EXIT: "1",
			}),
			onResult: (info) => seen.push(info),
		});
		await expect(complete("s", "u")).rejects.toBeInstanceOf(ClaudeResultError);
		expect(seen).toEqual([{ inputTokens: 4, outputTokens: 1, model: "claude-haiku-5-5" }]);
	});

	test("onResult is not called for non-JSON output", async () => {
		const stub = setup();
		let calls = 0;
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({ STUB_OUT: "not json" }),
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
