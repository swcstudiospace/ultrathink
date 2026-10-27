// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildClaudeArgs,
	CHILD_ENV,
	createClaudeCompleter,
	isChildInvocation,
	parseClaudeJson,
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

describe("claudeComplete fallbackToLogin", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const creditError =
		'{"type":"result","is_error":true,"api_error_status":400,"result":"Credit balance is too low"}';

	/** Stub `claude`: logs one line per attempt; fails with `STUB_FAIL` while ANTHROPIC_API_KEY is set. */
	function setup(): {
		bin: string;
		log: () => string[];
		env: (extra: Record<string, string>) => Record<string, string | undefined>;
	} {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-claude-complete-"));
		dirs.push(dir);
		const bin = join(dir, "claude");
		const logFile = join(dir, "attempts.log");
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
				"cat >/dev/null",
				`echo "key=\${ANTHROPIC_API_KEY:+set}" >> "${logFile}"`,
				'if [ -n "$ANTHROPIC_API_KEY" ]; then printf \'%s\\n\' "$STUB_FAIL"; exit 1; fi',
				'if [ -n "$STUB_FAIL2" ]; then printf \'%s\\n\' "$STUB_FAIL2"; exit 1; fi',
				'printf \'%s\\n\' \'{"type":"result","is_error":false,"result":"login ok"}\'',
			].join("\n"),
			{ mode: 0o755 },
		);
		return {
			bin,
			log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n") : []),
			env: (extra) => ({ PATH: process.env.PATH, ...extra }),
		};
	}

	test("option off with the key set makes one attempt and surfaces the billing error", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			env: stub.env({ ANTHROPIC_API_KEY: "sk-ant-fake", STUB_FAIL: creditError }),
		});
		await expect(complete("s", "u")).rejects.toThrow("Credit balance is too low");
		expect(stub.log()).toEqual(["key=set"]);
	});

	test("option on with the key set retries once without the key and returns the text", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			fallbackToLogin: true,
			env: stub.env({ ANTHROPIC_API_KEY: "sk-ant-fake", STUB_FAIL: creditError }),
		});
		expect(await complete("s", "u")).toBe("login ok");
		expect(stub.log()).toEqual(["key=set", "key="]);
	});

	test("option on with the key unset makes one attempt", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			fallbackToLogin: true,
			env: stub.env({ STUB_FAIL: creditError }),
		});
		expect(await complete("s", "u")).toBe("login ok");
		expect(stub.log()).toEqual(["key="]);
	});

	test("option on with a non-billing error makes one attempt", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			fallbackToLogin: true,
			env: stub.env({
				ANTHROPIC_API_KEY: "sk-ant-fake",
				STUB_FAIL: '{"type":"result","is_error":true,"api_error_status":529,"result":"overloaded"}',
			}),
		});
		await expect(complete("s", "u")).rejects.toThrow("overloaded");
		expect(stub.log()).toEqual(["key=set"]);
	});

	test("both attempts failing throws the retry error noting the first attempt", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			fallbackToLogin: true,
			env: stub.env({
				ANTHROPIC_API_KEY: "sk-ant-fake",
				STUB_FAIL: creditError,
				STUB_FAIL2: '{"type":"result","is_error":true,"result":"Not logged in"}',
			}),
		});
		await expect(complete("s", "u")).rejects.toThrow(
			"Not logged in (first attempt: Credit balance is too low)",
		);
		expect(stub.log()).toEqual(["key=set", "key="]);
	});

	test("a 401 api_error_status retries even without matching text", async () => {
		const stub = setup();
		const complete = createClaudeCompleter({
			bin: stub.bin,
			fallbackToLogin: true,
			env: stub.env({
				ANTHROPIC_API_KEY: "sk-ant-fake",
				STUB_FAIL: '{"type":"result","is_error":true,"api_error_status":401,"result":"denied"}',
			}),
		});
		expect(await complete("s", "u")).toBe("login ok");
		expect(stub.log()).toEqual(["key=set", "key="]);
	});
});
