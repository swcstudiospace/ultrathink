// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig, type UltrathinkConfig } from "../config.ts";
import { readControl, readSkipOnce, type SessionRecord, writeSession } from "../claude/state.ts";
import type { DoctorReport } from "../doctor/types.ts";
import type { ModelResolution } from "../host/engine.ts";
import type { HostId } from "../host/types.ts";
import type { GrokCheckResult, runGrokCheck } from "../grok/check.ts";
import type { runGrokLogin } from "../grok/login.ts";
import { writeStore } from "../mcp/store.ts";
import { dispatchStack } from "../stack/cli.ts";
import {
	STACK_MEMBERS,
	type StackConnection,
	type StackMember,
	type StackProbe,
} from "../stack/types.ts";
import {
	parseUltrathinkCommand,
	runControl,
	runGrokCommand,
	trackingEnabled,
	trackingOff,
	type UltrathinkCommand,
	ULTRATHINK_VERBS,
} from "./commands.ts";

function config(
	patch: { track?: boolean; notion?: string; linear?: string } = {},
): UltrathinkConfig {
	const base = defaultConfig();
	return {
		...base,
		track: { ...base.track, enabled: patch.track ?? true },
		notion: { dataSourceUrl: patch.notion ?? "" },
		linear: { team: patch.linear ?? "" },
	};
}

describe("parseUltrathinkCommand", () => {
	test.each<[string, UltrathinkCommand]>([
		["/ultrathink-quick fix the typo", { verb: "quick", args: "fix the typo" }],
		["/ultrathink-track off", { verb: "track", args: "off" }],
		["  /ULTRATHINK-Status  ", { verb: "status", args: "" }],
		["/ultrathink-quick   fix\n  the typo  ", { verb: "quick", args: "fix\n  the typo" }],
		["/ultrathink:ultrathink-skip", { verb: "skip", args: "" }],
		[
			"<command-message>ultrathink:ultrathink-quick is running…</command-message>\n<command-name>/ultrathink:ultrathink-quick</command-name>\n<command-args>  fix the typo </command-args>",
			{ verb: "quick", args: "fix the typo" },
		],
		[
			"<command-name>/ultrathink-track</command-name>\n<command-args>on</command-args>",
			{ verb: "track", args: "on" },
		],
		[
			'<user_query>\n/ultrathink-quick fix the typo\n</user_query>\n<skill_information>\n<skill name="ultrathink-quick" args="fix the typo">\nBody.\n</skill>\n</skill_information>',
			{ verb: "quick", args: "fix the typo" },
		],
		// Older names stay accepted.
		["/ultrathink:quick fix the typo", { verb: "quick", args: "fix the typo" }],
		["<command-name>/ultrathink:off</command-name>", { verb: "off", args: "" }],
		["/ultrathink quick fix it", { verb: "quick", args: "fix it" }],
		["/ultrathink TRACK\n on ", { verb: "track", args: "on" }],
		["<user_query>\n/ultrathink status\n</user_query>", { verb: "status", args: "" }],
	])("%p", (text, expected) => {
		expect(parseUltrathinkCommand(text)).toEqual(expected);
	});

	test("every verb parses under each of its names", () => {
		for (const verb of ULTRATHINK_VERBS) {
			for (const typed of [
				`/ultrathink-${verb}`,
				`/ultrathink:ultrathink-${verb}`,
				`/ultrathink:${verb}`,
				`/ultrathink ${verb}`,
			]) {
				expect(parseUltrathinkCommand(typed)).toEqual({ verb, args: "" });
			}
		}
	});

	test.each([
		"fix the typo",
		"",
		"please run /ultrathink:quick later",
		"/ultrathink-bogus x",
		"/ultrathink:ultrathink-bogus",
		"/ultrathink:bogus x",
		"/ultrathink-last",
		"/ultrathink:last",
		"/ultrathink-",
		"/ultrathink:",
		"/ultrathink",
		"/ultrathink bogus x",
		"/ultrathink-ship",
		"/ultrathink:ultrathink-kickoff stateFile=/tmp/s.json",
		"/model sonnet",
		"<local-command-stdout>/ultrathink-status</local-command-stdout>",
		"<user_query>\nfix the typo\n</user_query>",
		"<user_query>\n/quick fix the typo\n</user_query>",
	])("%p is not a command", (text) => {
		expect(parseUltrathinkCommand(text)).toBeUndefined();
	});
});

describe("trackingEnabled", () => {
	test("the control toggle beats config; ULTRATHINK_TRACK=0 beats both", () => {
		expect(trackingEnabled(config({ track: true }), {}, {})).toBe(true);
		expect(trackingEnabled(config({ track: false }), {}, {})).toBe(false);
		expect(trackingEnabled(config({ track: true }), { trackEnabled: false }, {})).toBe(false);
		expect(trackingEnabled(config({ track: false }), { trackEnabled: true }, {})).toBe(true);
		expect(
			trackingEnabled(config({ track: true }), { trackEnabled: true }, { ULTRATHINK_TRACK: "0" }),
		).toBe(false);
		expect(trackingEnabled(config({ track: true }), {}, { ULTRATHINK_TRACK: "1" })).toBe(true);
	});
});

describe("trackingOff", () => {
	test("rows are unwanted when tracking is turned off or nothing is configured", () => {
		expect(trackingOff(config(), {})).toBe(true);
		expect(trackingOff(config({ notion: "  ", linear: " " }), { trackEnabled: true })).toBe(true);
		expect(trackingOff(config({ notion: "collection://abc" }), {})).toBe(false);
		expect(trackingOff(config({ linear: "Acme" }), {})).toBe(false);
		expect(trackingOff(config({ linear: "Acme" }), { trackEnabled: false })).toBe(true);
	});

	test("config track.enabled=false only stops the planner's own tracker; kickoff still creates rows", () => {
		const hookOff = config({ track: false, linear: "Acme" });
		expect(trackingEnabled(hookOff, {}, {})).toBe(false);
		expect(trackingOff(hookOff, {})).toBe(false);
	});
});

describe("runControl", () => {
	const ENV_KEYS = [
		"XDG_CONFIG_HOME",
		"CLAUDE_CONFIG_DIR",
		"ULTRATHINK_TRACK",
		"ULTRATHINK_SHIP",
		"SUBSTRATE_URL",
		"SUBSTRATE_DISABLED",
		"ULTRATHINK_MCP_STORE",
		"ULTRATHINK_HINDSIGHT",
		"ULTRATHINK_RAGFLOW",
		"ULTRATHINK_TEACH",
		"HINDSIGHT_API_URL",
		"HINDSIGHT_API_KEY",
		"HINDSIGHT_API_TOKEN",
		"RAGFLOW_URL",
		"RAGFLOW_API_KEY",
		"OPENROUTER_API_KEY",
		"ULTRATHINK_OPENROUTER_KEY",
		"AI_GATEWAY_API_KEY",
		"ULTRATHINK_DECISIONS_URL",
		"ULTRATHINK_DECISIONS",
		"ULTRATHINK_DEBUG",
		"ULTRATHINK_REALM",
		"ULTRATHINK_SWARM_ROOT",
		"SWARM_ROOT",
		"SUBSTRATE_TOKEN",
		"SUBSTRATE_TOKENS_DIR",
	] as const;
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let dir: string;
	let io: { stateDir: string; cwd: string };

	function projectConfig(extra: Record<string, unknown>): void {
		mkdirSync(join(io.cwd, ".claude"), { recursive: true });
		// An empty Grok home keeps the OAuth status line off the real ~/.grok.
		writeFileSync(
			join(io.cwd, ".claude", "ultrathink.json"),
			JSON.stringify({ grok: { home: join(dir, "grok") }, ...extra }),
		);
	}

	/** User-layer config (`~/.config/ultrathink/config.json`); overwrites the whole file. */
	function userServices(services: Record<string, unknown>): void {
		mkdirSync(join(dir, "xdg", "ultrathink"), { recursive: true });
		writeFileSync(join(dir, "xdg", "ultrathink", "config.json"), JSON.stringify(services));
	}

	/** The credential store holds no file; reads fall through to the environment. */
	function clearStore(): void {
		rmSync(process.env.ULTRATHINK_MCP_STORE as string, { recursive: true, force: true });
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-commands-"));
		io = { stateDir: join(dir, "state"), cwd: join(dir, "project") };
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		// User-level config on the machine running the tests must not leak in.
		process.env.XDG_CONFIG_HOME = join(dir, "xdg");
		process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
		for (const key of [
			"ULTRATHINK_TRACK",
			"ULTRATHINK_SHIP",
			"SUBSTRATE_URL",
			"SUBSTRATE_DISABLED",
		] as const)
			delete process.env[key];
		// Neither the machine's Jev keys nor its endpoint override may reach a test.
		for (const key of [
			"OPENROUTER_API_KEY",
			"ULTRATHINK_OPENROUTER_KEY",
			"AI_GATEWAY_API_KEY",
			"ULTRATHINK_DECISIONS_URL",
			"ULTRATHINK_DECISIONS",
			"ULTRATHINK_DEBUG",
		] as const) {
			delete process.env[key];
		}
		for (const key of [
			"ULTRATHINK_HINDSIGHT",
			"ULTRATHINK_RAGFLOW",
			"ULTRATHINK_TEACH",
			"HINDSIGHT_API_URL",
			"HINDSIGHT_API_KEY",
			"HINDSIGHT_API_TOKEN",
			"RAGFLOW_URL",
			"RAGFLOW_API_KEY",
		] as const) {
			delete process.env[key];
		}
		// The credential store must never be the real one.
		process.env.ULTRATHINK_MCP_STORE = join(dir, "mcp-credentials.json");
		projectConfig({});
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	test("off, on, skip, track off and track on persist in the state dir", async () => {
		expect(await runControl(["off"], io)).toBe("Prompt Uplift off");
		expect(readControl(io.stateDir)).toEqual({ enabled: false });
		expect(await runControl(["on"], io)).toBe("Prompt Uplift on");
		expect(await runControl(["skip"], io)).toBe(
			"Prompt Uplift skip needs a session id (--session <id>); none was given, so nothing was armed.",
		);
		expect(readSkipOnce(io.stateDir, "s1")).toBe(false);
		expect(await runControl(["skip"], { ...io, sessionId: "s1" })).toBe(
			"Prompt Uplift will skip the next prompt in this session",
		);
		expect(readSkipOnce(io.stateDir, "s1")).toBe(true);
		expect(readSkipOnce(io.stateDir, "s2")).toBe(false);
		expect(await runControl(["track", "off"], io)).toStartWith(
			"Tracking: off (Linear/Notion rows)",
		);
		expect(readControl(io.stateDir)).toEqual({ enabled: true, trackEnabled: false });
		expect(await runControl(["Track", "ON"], io)).toStartWith("Tracking: on");
		expect(readControl(io.stateDir)).toEqual({ enabled: true, trackEnabled: true });
		expect(await runControl(["status"], { ...io, sessionId: "s1" })).toStartWith(
			"Prompt Uplift on (skipping next prompt)",
		);
		expect(await runControl(["status"], io)).not.toContain("skipping next prompt");
	});

	test("status reports tracking and names what is not configured", async () => {
		const status = await runControl(["status"], io);
		expect(status).toContain(
			"Tracking: on (not configured: set notion.dataSourceUrl / linear.team)",
		);
		expect(status).toContain("Notion: not configured");
		expect(status).toContain("Linear team: not configured");
		expect(status).toContain(`State: ${io.stateDir}`);
		expect(await runControl([], io)).toBe(status);

		projectConfig({ notion: { dataSourceUrl: "collection://abc" }, linear: { team: "Acme" } });
		const configured = await runControl(["status"], io);
		expect(configured).toContain("Tracking: on (Linear/Notion rows)");
		expect(configured).toContain("Notion: collection://abc");
		expect(configured).toContain("Linear team: Acme");

		await runControl(["track", "off"], io);
		expect(await runControl(["track"], io)).toBe(
			"Tracking: off (Linear/Notion rows)\nNotion: collection://abc\nLinear team: Acme",
		);
	});

	test("tracking reads off only when no rows are wanted; config or ULTRATHINK_TRACK=0 leaves them to kickoff", async () => {
		const kickoff =
			"Tracking: kickoff (planner-side row creation off; /ultrathink-track off stops all rows)";
		projectConfig({ linear: { team: "Acme" }, track: { enabled: false } });
		expect(await runControl(["status"], io)).toContain(kickoff);
		projectConfig({ linear: { team: "Acme" } });
		process.env.ULTRATHINK_TRACK = "0";
		expect(await runControl(["track"], io)).toStartWith(kickoff);
		expect(await runControl(["track", "on"], io)).toStartWith(kickoff);
		expect(await runControl(["track", "off"], io)).toStartWith(
			"Tracking: off (Linear/Notion rows)",
		);
	});

	/** The one status line starting with `prefix`. */
	async function statusLine(prefix: string): Promise<string | undefined> {
		return (await runControl(["status"], io)).split("\n").find((line) => line.startsWith(prefix));
	}

	test("status shows the substrate as off until a user-level URL is set; SUBSTRATE_URL beats config, SUBSTRATE_DISABLED beats both", async () => {
		const off = "Substrate: off (optional: set substrate.url or SUBSTRATE_URL)";
		expect(await statusLine("Substrate:")).toBe(off);
		// A cloned repository must not redirect the Substrate bearer token: a project file cannot set substrate.url.
		projectConfig({ substrate: { url: "https://evil-substrate.example/" } });
		expect(await statusLine("Substrate:")).toBe(off);
		userServices({ substrate: { url: "https://substrate.example/" } });
		expect(await statusLine("Substrate:")).toBe("Substrate: https://substrate.example (config)");
		process.env.SUBSTRATE_URL = "http://localhost:9000";
		expect(await statusLine("Substrate:")).toBe("Substrate: http://localhost:9000 (SUBSTRATE_URL)");
		process.env.SUBSTRATE_DISABLED = "1";
		expect(await statusLine("Substrate:")).toBe("Substrate: off (SUBSTRATE_DISABLED=1)");
	});

	test("status shows ship as off by default, its merge settings when enabled, and off again under ULTRATHINK_SHIP=0", async () => {
		expect(await statusLine("Ship:")).toBe("Ship: off (opt-in: set ship.enabled)");
		projectConfig({ ship: { enabled: true } });
		expect(await statusLine("Ship:")).toBe("Ship: on · auto-merge off · delete branch off");
		projectConfig({ ship: { enabled: true, autoMerge: true, deleteBranch: true } });
		expect(await statusLine("Ship:")).toBe("Ship: on · auto-merge on · delete branch on");
		process.env.ULTRATHINK_SHIP = "0";
		expect(await statusLine("Ship:")).toBe("Ship: off (ULTRATHINK_SHIP=0)");
	});

	test("status shows the knowledge base as opt-in, idle while HITL is off, missing a credential, then ready with its organization", async () => {
		expect(await statusLine("Knowledge base:")).toBe(
			"Knowledge base: off (opt-in: set hitl.knowledgeBase)",
		);
		projectConfig({ hitl: { knowledgeBase: true } });
		expect(await statusLine("Knowledge base:")).toBe(
			"Knowledge base: on · no Greptile credential (run bin/ultrathink-mcp auth login greptile)",
		);
		writeStore(process.env.ULTRATHINK_MCP_STORE as string, {
			version: 1,
			providers: { greptile: { kind: "api_key", apiKey: "test-key", updatedAt: 1 } },
		});
		expect(await statusLine("Knowledge base:")).toBe("Knowledge base: on · Greptile");
		projectConfig({ hitl: { knowledgeBase: true }, ship: { greptileOrganization: "acme" } });
		expect(await statusLine("Knowledge base:")).toBe(
			"Knowledge base: on · Greptile · organization acme",
		);
		await runControl(["hitl", "off"], io);
		expect(await statusLine("Knowledge base:")).toBe(
			"Knowledge base: on · not read while HITL is off",
		);
		projectConfig({
			hitl: { enabled: false, knowledgeBase: true },
			ship: { greptileOrganization: "acme" },
		});
		await runControl(["hitl", "on"], io);
		expect(await statusLine("Knowledge base:")).toBe(
			"Knowledge base: on · Greptile · organization acme",
		);
	});

	test("the shunt status names the missing gateway setting and the model actually sent", async () => {
		const grok = { home: join(dir, "grok"), model: "grok-test", transport: "shunt" };
		projectConfig({ grok });
		const unset = await statusLine("Grok:");
		expect(unset).toContain("shunt gateway not configured (set grok.shuntBaseUrl)");
		expect(unset).toContain("wire model grok-test");
		expect(unset).not.toContain("/v1/messages");
		// A project file cannot set the gateway: the same key there leaves the status line unchanged.
		projectConfig({ grok: { ...grok, shuntBaseUrl: "https://gateway.example" } });
		expect(await statusLine("Grok:")).toBe(unset);

		userServices({ grok: { shuntBaseUrl: "https://gateway.example" } });
		projectConfig({ grok: { ...grok, shuntModel: "wire-x" } });
		const set = await statusLine("Grok:");
		expect(set).toContain("https://gateway.example/v1/messages");
		expect(set).toContain("wire model wire-x");
	});

	test("status lines show the Claude route and the Grok model chain by default", async () => {
		projectConfig({ grok: { home: join(dir, "grok"), transport: "http" } });
		const lines = (await runControl(["status"], io)).split("\n");
		const engine = lines.findIndex((line) => line.startsWith("Engine:"));
		expect(lines[engine + 1]).toBe("Claude: claude-haiku-5-5 · auth plan · fallback to Grok off");
		expect(lines[engine + 2]).toBe("Grok: grok-build-0.1 · transport http");
	});

	test("status shows claude.auth api-key and claude.fallbackToGrok when set in user config", async () => {
		userServices({ claude: { auth: "api-key", fallbackToGrok: true } });
		expect(await statusLine("Claude:")).toBe(
			"Claude: claude-haiku-5-5 · auth api-key · fallback to Grok on",
		);
	});

	test("status shows the effort for a model that supports it and hides the then part for no fallbacks", async () => {
		projectConfig({
			grok: { home: join(dir, "grok"), transport: "http", model: "grok-4.7", fallbackModels: [] },
		});
		expect(await statusLine("Grok:")).toBe("Grok: grok-4.7 @ xhigh · transport http");
	});

	test("status prints the effort actually sent: grok-4.5 maps xhigh to high", async () => {
		projectConfig({
			grok: { home: join(dir, "grok"), transport: "http", model: "grok-4.5", fallbackModels: [] },
		});
		expect(await statusLine("Grok:")).toBe("Grok: grok-4.5 @ high · transport http");
	});

	test("status masks unsafe fallback and Claude model ids", async () => {
		userServices({ claude: { model: "user:private@model" } });
		projectConfig({
			grok: {
				home: join(dir, "grok"),
				transport: "http",
				fallbackModels: ["user:private@model", "grok-4.7"],
			},
		});
		const text = await runControl(["status"], io);
		expect(text).not.toContain("private");
		expect(await statusLine("Claude:")).toBe(
			"Claude: <opaque-model> · auth plan · fallback to Grok off",
		);
		expect(await statusLine("Grok:")).toBe(
			"Grok: grok-build-0.1 · transport http · then <opaque-model>, grok-4.7",
		);
	});

	test("the shunt status keeps its gateway extension after the transport", async () => {
		projectConfig({ grok: { home: join(dir, "grok"), model: "grok-test", transport: "shunt" } });
		expect(await statusLine("Grok:")).toBe(
			"Grok: grok-test · transport shunt · shunt gateway not configured (set grok.shuntBaseUrl) · wire model grok-test · max_tokens 8192",
		);
	});

	test("status omits the then part by default and shows the lane home from user config", async () => {
		userServices({ grok: { home: "/lane/grok-home", transport: "http" } });
		expect(await statusLine("Grok:")).toBe(
			"Grok: grok-build-0.1 · transport http · home /lane/grok-home",
		);
	});

	test("status still shows then for fallback models the user sets explicitly", async () => {
		userServices({ grok: { transport: "http", fallbackModels: ["grok-4.7"] } });
		expect(await statusLine("Grok:")).toContain("transport http · then grok-4.7");
	});

	describe("grok login and check", () => {
		const calls: { check: unknown[]; login: unknown[] } = { check: [], login: [] };
		const failedCheck: GrokCheckResult = {
			ok: false,
			exitCode: 1,
			text: "Grok check: error (model-unavailable)",
			json: { ok: false, class: "model-unavailable" },
		};
		let nextCheck = failedCheck;
		const check: typeof runGrokCheck = async (deps, opts) => {
			calls.check.push({ model: deps.grok.model, opts });
			return nextCheck;
		};
		const login: typeof runGrokLogin = async (deps, opts) => {
			calls.login.push({ home: deps.grok.home, opts });
			return { ok: true, exitCode: 0, text: "Grok login: ok" };
		};
		const run = (args: string[]) => runGrokCommand(args, { cwd: io.cwd, check, login });

		beforeEach(() => {
			calls.check = [];
			calls.login = [];
			nextCheck = failedCheck;
		});

		test("check passes its flags through with the module's exit code and text", async () => {
			expect(await run(["check", "--model", "Grok-Build-0.1", "--transport", "cli"])).toEqual({
				code: 1,
				text: "Grok check: error (model-unavailable)",
			});
			expect(calls.check).toEqual([
				{
					model: loadConfig(claudeConfigPaths(io.cwd)).grok.model,
					opts: { model: "Grok-Build-0.1", transport: "cli" },
				},
			]);
		});

		test("check --json prints the result's JSON for a failed and an ok check, keeping the exit code", async () => {
			const failed = await run(["check", "--json"]);
			expect(failed.code).toBe(1);
			expect(JSON.parse(failed.text)).toEqual({ ok: false, class: "model-unavailable" });
			nextCheck = {
				ok: true,
				exitCode: 0,
				text: "Grok check: ok · grok-build-0.1",
				json: { ok: true, model: "grok-build-0.1", account: "lane@example.test" },
			};
			const ok = await run(["check", "--json"]);
			expect(ok.code).toBe(0);
			expect(JSON.parse(ok.text)).toEqual({
				ok: true,
				model: "grok-build-0.1",
				account: "lane@example.test",
			});
			expect((await run(["check"])).text).toBe("Grok check: ok · grok-build-0.1");
		});

		test("login keeps the directory's case and returns the module's code", async () => {
			expect(await run(["login", "--home", "/Lane/Grok", "--write-config"])).toEqual({
				code: 0,
				text: "Grok login: ok",
			});
			expect(calls.login).toEqual([{ home: "", opts: { home: "/Lane/Grok", writeConfig: true } }]);
		});

		test("bare check and login call the modules with empty options", async () => {
			await run(["check"]);
			await run(["login"]);
			expect(calls.check).toHaveLength(1);
			expect(calls.login).toHaveLength(1);
		});

		test.each([
			[["login", "--home"], "Usage: grok login [--home <dir>] [--write-config]"],
			[["login", "--home", "--write-config"], "Usage: grok login [--home <dir>] [--write-config]"],
			[
				["login", "--home", "/a", "--home", "/b"],
				"Usage: grok login [--home <dir>] [--write-config]",
			],
			[["login", "--force"], "Usage: grok login [--home <dir>] [--write-config]"],
			[["login", "extra"], "Usage: grok login [--home <dir>] [--write-config]"],
			[["check", "--model"], "Usage: grok check [--model <id>] [--transport http|cli] [--json]"],
			[
				["check", "--transport", "shunt"],
				"Usage: grok check [--model <id>] [--transport http|cli] [--json]",
			],
			[
				["check", "--json", "--json"],
				"Usage: grok check [--model <id>] [--transport http|cli] [--json]",
			],
			[["check", "--bogus"], "Usage: grok check [--model <id>] [--transport http|cli] [--json]"],
		])("bad flags %p are a usage error that never reaches the module", async (args, usage) => {
			expect(await run(args)).toEqual({ code: 2, text: usage });
			expect(calls.check).toEqual([]);
			expect(calls.login).toEqual([]);
		});

		test("the grok help line names login and check", async () => {
			expect(await runControl(["grok", "bogus"], io)).toBe(
				"Usage: grok [status | engine auto|claude|grok|muse | login | check]",
			);
		});
	});

	test("the legacy think, hitl, grok and last scopes keep working", async () => {
		expect(await runControl(["think", "off"], io)).toBe("Graph of Thought off");
		expect(await runControl(["think"], io)).toBe("Graph of Thought off");
		expect(await runControl(["hitl", "off"], io)).toBe("HITL clarifications off");
		expect(await runControl(["grok", "engine", "claude"], io)).toBe(
			"Thinking engine set to claude:claude-haiku-5-5",
		);
		expect(readControl(io.stateDir)).toEqual({
			thinkEnabled: false,
			hitlEnabled: false,
			engine: "claude",
		});
		expect(await runControl(["grok"], io)).toStartWith(
			"Engine: claude:claude-haiku-5-5\nClaude: claude-haiku-5-5 · auth plan · fallback to Grok off\nGrok: ",
		);
		expect(await runControl(["last"], io)).toBe("No uplift recorded yet");
		expect(await runControl(["think", "last"], io)).toBe("No thought graph recorded yet");
	});

	describe("model selection status (§9 paths 5-6)", () => {
		const detected: ModelResolution = {
			version: "1.0.0",
			state: "detected",
			host: "omp",
			transport: "omp-native",
			source: "ctx.model",
			reason: "live-model",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			provider: "anthropic",
			modelId: "claude-x",
			modelKnown: true,
			label: "omp-native:anthropic/claude-x [detected]",
		};

		/** Saves a successful plan whose record carries `modelResolution` (possibly malformed) as the host's last.json. */
		function savePlan(modelResolution: unknown): void {
			const record: SessionRecord = {
				sessionId: "s1",
				at: 1,
				engine: "claude:sonnet",
				result: { xml: "<x/>", original: "x", root: "BUILD_PROMPT", source: "llm" },
				modelResolution: modelResolution as ModelResolution,
			};
			writeSession(io.stateDir, record);
		}

		async function statusLines(
			input: { host?: HostId; modelResolution?: ModelResolution } = {},
		): Promise<string[]> {
			return (await runControl(["status"], { ...io, ...input })).split("\n");
		}

		test("the universal Model line is gone: the engine request, its source and concurrency show apart from model state", async () => {
			const lines = await statusLines({ host: "claude-code" });
			expect(lines.some((line) => line.startsWith("Model:"))).toBe(false);
			expect(lines).toContain("Engine: claude:claude-haiku-5-5");
			expect(lines).toContain("Engine request: auto (config) · concurrency 3");
			expect(lines.some((line) => line.startsWith("Last planned resolution:"))).toBe(false);
		});

		test.each([
			["claude-code", "claude"],
			["muse", "muse"],
			["grok-build", "grok"],
			["hermes", "claude"],
		] as const)(
			"%s static status projects host overrides and engine pins across the whole response",
			async (host, route) => {
				const sentinel = "EXAMPLE_SENTINEL";
				const selectors = [
					[`https://model.invalid/path?token=${sentinel}`, false],
					[`sk-${sentinel}_0123456789abcdef`, false],
					[`user:${sentinel}@model.invalid`, false],
					[`<model>${sentinel}</model>`, false],
					[`${sentinel}${"x".repeat(600)}`, false],
					[`${sentinel}\u001b[31m\nmodel`, true],
				] as const;
				for (const [model, invalid] of selectors) {
					for (const source of [
						"host-override",
						"engine-model",
						...(route === "grok" ? ["shunt-model"] : []),
					]) {
						const grok = {
							home: join(dir, "grok"),
							transport: "shunt",
							shuntBaseUrl: "http://gateway.example",
						};
						const extra: Record<string, unknown> = { grok };
						if (source === "host-override") extra.models = { hosts: { [host]: { model } } };
						else if (source === "shunt-model") extra.grok = { ...grok, shuntModel: model };
						else extra[route] = route === "grok" ? { ...grok, model } : { model };
						projectConfig(extra);
						for (const args of [["status"], ["grok", "status"]]) {
							const text = await runControl(args, { ...io, host });
							expect(text).not.toContain(sentinel);
							expect(text).not.toContain("model.invalid");
							expect(text).not.toContain("\u001b");
							expect(text).not.toContain("</model>");
							const engine = text.split("\n").find((line) => line.startsWith("Engine:"));
							expect(engine).toContain(
								invalid ? "unresolved [selector-invalid]" : "<opaque-model>",
							);
							expect(engine!.length).toBeLessThanOrEqual(500);
							if (host === "hermes") expect(engine).toEndWith("(follows session model)");
						}
					}
				}
			},
		);

		test("Grok HTTP and CLI status never repeat unsafe configured models in the transport line", async () => {
			const sentinel = "EXAMPLE_SENTINEL";
			for (const transport of ["http", "cli"]) {
				projectConfig({
					grok: {
						home: join(dir, "grok"),
						transport,
						model: `https://model.invalid/path?token=${sentinel}`,
					},
				});
				for (const args of [["status"], ["grok", "status"]]) {
					const text = await runControl(args, { ...io, host: "grok-build" });
					expect(text).not.toContain(sentinel);
					expect(text).not.toContain("model.invalid");
					expect(text).toContain("Engine: <opaque-model>");
					expect(text).toContain(`Grok: <opaque-model> · transport ${transport}`);
					expect(text).not.toContain("· then");
				}
			}
		});

		test("disabled Grok status projects Claude's fallback model without adopting the host selector", async () => {
			const sentinel = "EXAMPLE_SENTINEL";
			projectConfig({
				grok: { home: join(dir, "grok"), enabled: false },
				claude: { model: `https://model.invalid/path?token=${sentinel}` },
				models: { hosts: { "grok-build": { model: `ignored-${sentinel}` } } },
			});
			for (const args of [["status"], ["grok", "status"]]) {
				const text = await runControl(args, { ...io, host: "grok-build" });
				expect(text).toContain("Engine: claude:<opaque-model>");
				expect(text).not.toContain(sentinel);
			}
		});

		test("standalone Omp status says the live model is not observed, never a guessed follows-session-model Claude line", async () => {
			const lines = await statusLines({ host: "omp" });
			expect(lines).toContain("Engine: omp-native:auto (live model not observed)");
			expect(lines).toContain("Engine request: auto (config) · concurrency 3");
			expect(lines.join("\n")).not.toContain("follows session model");
		});

		test("the saved successful record shows as Last planned resolution, never as current detection", async () => {
			savePlan(detected);
			const lines = await statusLines({ host: "omp" });
			expect(lines).toContain("Engine: omp-native:auto (live model not observed)");
			expect(lines.at(-2)).toStartWith("Last: BUILD_PROMPT · llm");
			expect(lines.at(-1)).toBe(
				"Last planned resolution: omp-native:anthropic/claude-x [detected] · reason live-model · engine auto (config)",
			);
		});

		test("a live projection names the current model without any lookup; a named Omp engine shows its opt-out", async () => {
			expect(await statusLines({ host: "omp", modelResolution: detected })).toContain(
				"Engine: omp-native:anthropic/claude-x [detected]",
			);
			expect(
				await runControl(["grok", "engine", "claude"], {
					...io,
					host: "omp",
					modelResolution: detected,
				}),
			).toBe("Thinking engine set to claude:claude-haiku-5-5");
			// The live record was observed for `auto`; it is not the named engine's selection.
			const named = await statusLines({ host: "omp", modelResolution: detected });
			expect(named).toContain("Engine: claude:claude-haiku-5-5");
			expect(named).toContain("Engine request: claude (control, native opt-out) · concurrency 3");
			expect(await runControl(["grok", "status"], { ...io, host: "omp" })).toStartWith(
				"Engine: claude:claude-haiku-5-5\nClaude: ",
			);
		});

		test("a malformed or unsafe record never fails the status and never shows unsafe text", async () => {
			for (const saved of [
				null,
				"omp-native:x",
				[],
				{ ...detected, engineSelection: null },
				{ ...detected, version: "2.0.0" },
			]) {
				savePlan(saved);
				const text = (await statusLines({ host: "omp" })).join("\n");
				expect(text).toStartWith("Prompt Uplift on");
				expect(text).not.toContain("Last planned resolution:");
			}
			// Built in pieces so no scanner reads a credential-like literal out of this fixture.
			const sentinel = ["sentinel", "credential", "value"].join("-");
			savePlan({
				...detected,
				label: `omp-native:x [detected]\nBearer ${sentinel}`,
				baseUrl: "https://gateway.example/v1",
				apiKey: sentinel,
			});
			const live = {
				...detected,
				label: `omp-native:https://user:${sentinel}@gateway.example/v1 [detected]`,
			};
			const text = (await statusLines({ host: "omp", modelResolution: live })).join("\n");
			expect(text).toContain("Engine: <opaque-model>");
			expect(text).toContain(
				"Last planned resolution: <opaque-model> · reason live-model · engine auto (config)",
			);
			expect(text).not.toContain(sentinel);
			expect(text).not.toContain("gateway.example");
		});

		test("unsafe live and saved labels are opaque throughout both status commands", async () => {
			const sentinel = "EXAMPLE_SENTINEL";
			for (const label of [
				`user:${sentinel}@model.invalid`,
				`omp-native:user:${sentinel}@model.invalid/model [detected]`,
				`omp-native:/private/${sentinel} [detected]`,
				`omp-native:https://model.invalid/path?token=${sentinel} [detected]`,
				`omp-native:Bearer ${sentinel} [detected]`,
				`omp-native:<model>${sentinel}</model> [detected]`,
				`omp-native:${sentinel}\nmodel [detected]`,
				`omp-native:${sentinel}\tmodel [detected]`,
				`omp-native:${sentinel}\u001b[31m\nmodel [detected]`,
			]) {
				const modelResolution = { ...detected, label };
				savePlan(modelResolution);
				for (const args of [["status"], ["grok", "status"]]) {
					const text = await runControl(args, { ...io, host: "omp", modelResolution });
					expect(text).toContain("Engine: <opaque-model>");
					expect(text).not.toContain(sentinel);
					expect(text).not.toContain("model.invalid");
					expect(text).not.toContain("\u001b");
					if (args[0] === "status")
						expect(text).toContain("Last planned resolution: <opaque-model>");
				}
			}
		});

		test("the six commands keep their names (COMPAT-02)", () => {
			expect(ULTRATHINK_VERBS).toEqual(["quick", "skip", "off", "on", "track", "status"]);
		});
	});

	test("bad arguments answer with usage; failures become a message, never a throw", async () => {
		expect(await runControl(["bogus"], io)).toStartWith("Usage: ultrathink <command>");
		expect(await runControl(["quick", "fix", "it"], io)).toStartWith("Usage: ultrathink <command>");
		expect(await runControl(["track", "maybe"], io)).toBe("Usage: track on|off|status");
		expect(await runControl(["think", "sideways"], io)).toBe("Usage: think on|off|last|status");
		expect(await runControl(["hitl", "maybe"], io)).toBe("Usage: hitl on|off|last|status");
		expect(await runControl(["grok", "engine", "gpt"], io)).toBe(
			"Usage: grok engine auto|claude|grok|muse",
		);
		expect(readControl(io.stateDir)).toEqual({});

		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		expect(
			await runControl(["off"], { stateDir: join(blocker, "state"), cwd: io.cwd }),
		).toStartWith("ultrathink: ");
	});

	describe("Decisions status line", () => {
		const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
		const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
		const ON_DEFAULTS =
			"Decisions: on · ~typesafe/jev-latest · plan, ship, knowledge, blocking, teachable, skillworthy";

		/** User-layer config (`~/.config/ultrathink/config.json`); undefined leaves no decisions key in any layer. */
		function userConfig(decisions: Record<string, unknown> | undefined): void {
			mkdirSync(join(dir, "xdg", "ultrathink"), { recursive: true });
			writeFileSync(
				join(dir, "xdg", "ultrathink", "config.json"),
				JSON.stringify(decisions ? { decisions } : {}),
			);
		}

		function storeKey(): void {
			writeStore(process.env.ULTRATHINK_MCP_STORE as string, {
				version: 1,
				providers: { openrouter: { kind: "api_key", apiKey: K, updatedAt: 1 } },
			});
		}

		/** The status text with every Jev request recorded (the endpoint, or the active override): status never asks Jev. */
		async function status(): Promise<{
			text: string;
			line: string | undefined;
			jevCalls: string[];
		}> {
			const jevCalls: string[] = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === ENDPOINT || url === process.env.ULTRATHINK_DECISIONS_URL) jevCalls.push(url);
				return new Response(null, { status: 500 });
			}) as unknown as typeof fetch;
			try {
				const text = await runControl(["status"], io);
				return { text, line: text.split("\n").find((l) => l.startsWith("Decisions:")), jevCalls };
			} finally {
				globalThis.fetch = realFetch;
			}
		}

		test("a fresh install shows Decisions on right after the knowledge-base line, with a key stored and in the env (JEV-01)", async () => {
			userConfig(undefined);
			storeKey();
			process.env.ULTRATHINK_OPENROUTER_KEY = K;
			const { text, line, jevCalls } = await status();
			expect(line).toBe(`${ON_DEFAULTS} · provider openrouter · key from store · zdr on`);
			if (line === undefined) throw new Error("status printed no Decisions line");
			const lines = text.split("\n");
			expect(lines[lines.findIndex((l) => l.startsWith("Knowledge base:")) + 1]).toBe(line);
			expect(jevCalls).toEqual([]);
			expect(text).not.toContain(K);
		});

		test("on without a stored or env key names both ways to supply one", async () => {
			userConfig({ enabled: true });
			const { line, jevCalls } = await status();
			expect(line).toBe(
				"Decisions: on · no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or ULTRATHINK_OPENROUTER_KEY)",
			);
			expect(jevCalls).toEqual([]);
		});

		test("on with a key reports where the key comes from, never the key", async () => {
			userConfig({ enabled: true });
			storeKey();
			const stored = await status();
			expect(stored.line).toBe(`${ON_DEFAULTS} · provider openrouter · key from store · zdr on`);
			expect(stored.text).not.toContain(K);
			expect(stored.text).not.toContain("Bearer sk-or-");

			rmSync(process.env.ULTRATHINK_MCP_STORE as string);
			process.env.ULTRATHINK_OPENROUTER_KEY = K;
			const fromEnv = await status();
			expect(fromEnv.line).toBe(
				`${ON_DEFAULTS} · provider openrouter · key from ULTRATHINK_OPENROUTER_KEY · zdr on`,
			);
			expect(fromEnv.text).not.toContain(K);
			expect(fromEnv.text).not.toContain("Bearer sk-or-");
			expect([...stored.jevCalls, ...fromEnv.jevCalls]).toEqual([]);
		});

		test("auto with only a Vercel key shows provider vercel; explicit provider pins the rail (JEV-02)", async () => {
			const V = "vck_test_key_do_not_use";
			userConfig({ enabled: true });
			process.env.AI_GATEWAY_API_KEY = V;
			const auto = await status();
			expect(auto.line).toBe(
				`${ON_DEFAULTS} · provider vercel · key from AI_GATEWAY_API_KEY · zdr n/a (vercel)`,
			);
			expect(auto.text).not.toContain(V);
			process.env.ULTRATHINK_OPENROUTER_KEY = K;
			userConfig({ enabled: true, provider: "openrouter" });
			const pinned = await status();
			expect(pinned.line).toBe(
				`${ON_DEFAULTS} · provider openrouter · key from ULTRATHINK_OPENROUTER_KEY · zdr on`,
			);
			expect([...auto.jevCalls, ...pinned.jevCalls]).toEqual([]);
		});

		test("the stored key wins over the env key", async () => {
			userConfig({ enabled: true });
			storeKey();
			process.env.ULTRATHINK_OPENROUTER_KEY = "sk-or-v1-ENVKEY";
			const { line, text } = await status();
			expect(line).toBe(`${ON_DEFAULTS} · provider openrouter · key from store · zdr on`);
			expect(text).not.toContain("sk-or-v1-ENVKEY");
		});

		function writeHealth(state: Record<string, unknown>, rail = "openrouter"): void {
			mkdirSync(io.stateDir, { recursive: true });
			writeFileSync(join(io.stateDir, `decisions-health-${rail}.json`), JSON.stringify(state));
		}

		test("an open breaker appends its reason to the Decisions line; closed or corrupt shows nothing", async () => {
			userConfig({ enabled: true });
			storeKey();
			const closed = `${ON_DEFAULTS} · provider openrouter · key from store · zdr on`;
			expect((await status()).line).toBe(closed);

			const now = Date.now();
			writeHealth({
				v: 1,
				state: "open",
				cause: "credits",
				since: now - 60_000,
				nextProbeAt: now + 3_600_000,
				coolDownMs: 300_000,
				failures: 1,
			});
			const open = (await status()).line;
			expect(open).toStartWith(`${closed} · Jev unavailable`);
			expect(open).toContain("credits");

			writeHealth({ v: 1, state: "closed", failures: 0 });
			expect((await status()).line).toBe(closed);

			writeFileSync(join(io.stateDir, "decisions-health-openrouter.json"), "{not json");
			expect((await status()).line).toBe(closed);
		});

		test("an open Vercel breaker names Vercel on the Decisions line, not OpenRouter", async () => {
			userConfig({ enabled: true });
			storeKey();
			const now = Date.now();
			writeHealth(
				{
					v: 1,
					state: "open",
					cause: "auth",
					since: now - 60_000,
					nextProbeAt: now + 3_600_000,
					coolDownMs: 300_000,
					failures: 1,
				},
				"vercel",
			);
			const { line } = await status();
			expect(line).toContain("Jev unavailable: Vercel AI Gateway rejected the key");
			expect(line).toContain("auth set-key vercel --stdin");
			expect(line).not.toContain("OpenRouter rejected");
		});

		test("the line shows the configured model, points and zdr, the normalised URL when an override is in effect, and flags a rejected one", async () => {
			userConfig({
				enabled: true,
				model: "typesafe/jev-1.13-20260917",
				points: ["ship", "plan"],
				zdr: false,
			});
			storeKey();
			const base =
				"Decisions: on · typesafe/jev-1.13-20260917 · ship, plan · provider openrouter · key from store · zdr off";
			expect((await status()).line).toBe(base);
			process.env.ULTRATHINK_DECISIONS_URL = "http://127.0.0.1:9999/decisions?token=secret#frag";
			const override = await status();
			expect(override.line).toBe(`${base} · url http://127.0.0.1:9999/decisions`);
			expect(override.text).not.toContain("secret");
			const ignored = `${base} · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)`;
			for (const rejected of [
				"ftp://127.0.0.1/x",
				"https://gw.example/d",
				"http://openrouter.ai/api",
				"https://me:pw@openrouter.ai/api",
			]) {
				process.env.ULTRATHINK_DECISIONS_URL = rejected;
				const out = await status();
				expect(out.line).toBe(ignored);
				expect(out.text).not.toContain(rejected);
			}
			delete process.env.ULTRATHINK_DECISIONS_URL;
			userConfig({ enabled: true, points: [] });
			expect((await status()).line).toBe(
				"Decisions: on · ~typesafe/jev-latest · no points · provider openrouter · key from store · zdr on",
			);
		});

		test("K1: ULTRATHINK_DECISIONS=0 shows Decisions off whatever the config and key say", async () => {
			userConfig({ enabled: true });
			storeKey();
			process.env.ULTRATHINK_DECISIONS = "0";
			const { line, jevCalls } = await status();
			expect(line).toBe("Decisions: off (ULTRATHINK_DECISIONS=0)");
			expect(jevCalls).toEqual([]);
			userConfig(undefined);
			expect((await status()).line).toBe("Decisions: off (ULTRATHINK_DECISIONS=0)");
		});
	});

	test("usage lists the decisions commands right after the grok line", async () => {
		expect(await runControl(["bogus"], io)).toContain(
			[
				"  grok [status | engine auto|claude|grok|muse | login | check]",
				"  decisions check        one live Jev decision: resolved model, latency, cost",
				"  decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json>",
				"  hindsight check",
			].join("\n"),
		);
	});

	test("usage lists the hindsight, ragflow and teach commands after the decisions commands", async () => {
		const usage = (await runControl(["bogus"], io)).split("\n");
		const probe = usage.findIndex((line) => line.startsWith("  decisions probe"));
		expect(usage[probe + 1]).toStartWith("  hindsight check");
		expect(usage[probe + 2]).toStartWith("  ragflow check|datasets|search");
		expect(usage[probe + 3]).toStartWith(
			"  teach status|list|show|capture|recall|confirm|forget|sync|observe|promote|export",
		);
		expect(usage[probe + 4]).toStartWith("In an agent:");
	});

	test("status shows Hindsight and RAGFlow as opt-in and Teach on by default right after the Decisions line on a fresh install", async () => {
		const lines = (await runControl(["status"], io)).split("\n");
		const decisions = lines.findIndex((line) => line.startsWith("Decisions:"));
		expect(decisions).toBeGreaterThan(-1);
		expect(lines[decisions + 1]).toStartWith("Hindsight: off (opt-in");
		expect(lines[decisions + 2]).toStartWith("RAGFlow: off (opt-in");
		expect(lines[decisions + 3]).toStartWith("Teach: on · capture auto · recall on");
		expect(lines[decisions + 4]).toStartWith("Stack: ");
		expect(lines[decisions + 5]).toStartWith("Engine request:");
	});

	test("status reflects the config sections for Hindsight, RAGFlow and Teach", async () => {
		projectConfig({
			hindsight: { enabled: true },
			ragflow: { enabled: true },
			teach: { enabled: true },
		});
		// A project file can only turn things off, so the lines stay off.
		expect(await statusLine("Hindsight:")).toStartWith("Hindsight: off (opt-in");
		mkdirSync(join(dir, "xdg", "ultrathink"), { recursive: true });
		writeFileSync(
			join(dir, "xdg", "ultrathink", "config.json"),
			JSON.stringify({
				hindsight: { enabled: true },
				ragflow: { enabled: true },
				teach: { enabled: true },
			}),
		);
		for (const prefix of ["Hindsight:", "RAGFlow:", "Teach:"]) {
			const line = await statusLine(prefix);
			expect(line).toStartWith(prefix);
			expect(line).not.toStartWith(`${prefix} off (opt-in`);
		}
	});

	test("a project file that tries to enable Hindsight and RAGFlow cannot turn status on or retarget the URL", async () => {
		// User layer leaves both integrations off; the project layer tries to enable them,
		// point them at a foreign host, and turn grounding on.
		userServices({});
		projectConfig({
			hindsight: { enabled: true, url: "https://evil-hs.example", bank: "evil" },
			ragflow: {
				enabled: true,
				ground: true,
				url: "https://evil-rf.example",
				datasetIds: ["evil"],
			},
		});
		// The same load bin/ultrathink status uses: the project layer changes nothing.
		const merged = loadConfig(claudeConfigPaths(io.cwd));
		expect(merged.hindsight.enabled).toBe(false);
		expect(merged.hindsight.url).toBe("");
		expect(merged.ragflow.enabled).toBe(false);
		expect(merged.ragflow.ground).toBe(false);
		expect(merged.ragflow.url).toBe("");
		expect(merged.ragflow.datasetIds).toEqual([]);
		const status = await runControl(["status"], io);
		expect(status).toContain("Hindsight: off (opt-in: set hindsight.enabled)");
		expect(status).toContain("RAGFlow: off (opt-in: set ragflow.enabled)");
		expect(status).not.toContain("evil");
	});

	describe("Hindsight and RAGFlow status lines", () => {
		const HS_URL = "https://hs.example.test";
		const RF_URL = "https://rag.example.test";
		const HS_STORE_KEY = "hs-store-KEY-aaa111";
		const HS_ENV_KEY = "hs-env-KEY-bbb222";
		const RF_STORE_KEY = "rf-store-KEY-ccc333";
		const RF_ENV_KEY = "rf-env-KEY-ddd444";

		function storeKeys(hindsight?: string, ragflow?: string): void {
			const providers: Record<string, unknown> = {};
			if (hindsight !== undefined)
				providers.hindsight = { kind: "api_key", apiKey: hindsight, updatedAt: 1 };
			if (ragflow !== undefined)
				providers.ragflow = { kind: "api_key", apiKey: ragflow, updatedAt: 1 };
			writeStore(process.env.ULTRATHINK_MCP_STORE as string, { version: 1, providers });
		}

		function serviceLines(text: string): { hindsight: string; ragflow: string } {
			const hindsight = text.split("\n").find((line) => line.startsWith("Hindsight:"));
			const ragflow = text.split("\n").find((line) => line.startsWith("RAGFlow:"));
			if (hindsight === undefined || ragflow === undefined)
				throw new Error("status printed no Hindsight/RAGFlow lines");
			return { hindsight, ragflow };
		}

		test("off, no URL, bad URL, no key, and ready each print a distinct line per integration", async () => {
			const hindsight: string[] = [];
			const ragflow: string[] = [];
			const collect = async (): Promise<void> => {
				const lines = serviceLines(await runControl(["status"], io));
				hindsight.push(lines.hindsight);
				ragflow.push(lines.ragflow);
			};

			userServices({});
			clearStore();
			await collect();
			expect(hindsight[0]).toBe("Hindsight: off (opt-in: set hindsight.enabled)");
			expect(ragflow[0]).toBe("RAGFlow: off (opt-in: set ragflow.enabled)");

			userServices({ hindsight: { enabled: true }, ragflow: { enabled: true } });
			await collect();
			expect(hindsight[1]).toBe("Hindsight: on · no URL (set hindsight.url or HINDSIGHT_API_URL)");
			expect(ragflow[1]).toBe("RAGFlow: on · no URL (set ragflow.url or RAGFLOW_URL)");

			userServices({
				hindsight: { enabled: true, url: "http://hindsight.example.com" },
				ragflow: { enabled: true, url: "http://ragflow.example.com" },
			});
			await collect();
			expect(hindsight[2]).toContain("Hindsight: on · bad URL (http is allowed only for");
			expect(ragflow[2]).toContain("RAGFlow: on · bad URL (http is allowed only for");

			userServices({
				hindsight: { enabled: true, url: HS_URL },
				ragflow: { enabled: true, url: RF_URL },
			});
			await collect();
			expect(hindsight[3]).toBe(
				"Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)",
			);
			expect(ragflow[3]).toBe(
				"RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)",
			);

			storeKeys(HS_STORE_KEY, RF_STORE_KEY);
			const text = await runControl(["status"], io);
			const ready = serviceLines(text);
			hindsight.push(ready.hindsight);
			ragflow.push(ready.ragflow);
			expect(ready.hindsight).toBe(`Hindsight: on · ${HS_URL} · bank ultrathink · key from store`);
			expect(ready.ragflow).toBe(
				`RAGFlow: on · ${RF_URL} · key from store · grounding off · all datasets`,
			);
			expect(text).not.toContain(HS_STORE_KEY);
			expect(text).not.toContain(RF_STORE_KEY);

			expect(new Set(hindsight).size).toBe(5);
			expect(new Set(ragflow).size).toBe(5);
		});

		test("the kill switch forces the off line even when enabled, URL, and key are present", async () => {
			userServices({
				hindsight: { enabled: true, url: HS_URL },
				ragflow: { enabled: true, url: RF_URL },
			});
			storeKeys(HS_STORE_KEY, RF_STORE_KEY);
			process.env.ULTRATHINK_HINDSIGHT = "0";
			process.env.ULTRATHINK_RAGFLOW = "0";
			const lines = serviceLines(await runControl(["status"], io));
			expect(lines.hindsight).toBe("Hindsight: off (ULTRATHINK_HINDSIGHT=0)");
			expect(lines.ragflow).toBe("RAGFlow: off (ULTRATHINK_RAGFLOW=0)");
		});

		test("an env URL fills in an empty config URL instead of the no-URL line", async () => {
			userServices({ hindsight: { enabled: true }, ragflow: { enabled: true } });
			clearStore();
			process.env.HINDSIGHT_API_URL = "https://env-hs.example";
			process.env.RAGFLOW_URL = "https://env-rf.example";
			process.env.HINDSIGHT_API_KEY = HS_ENV_KEY;
			process.env.RAGFLOW_API_KEY = RF_ENV_KEY;
			const text = await runControl(["status"], io);
			const lines = serviceLines(text);
			expect(lines.hindsight).toBe(
				"Hindsight: on · https://env-hs.example · bank ultrathink · key from HINDSIGHT_API_KEY",
			);
			expect(lines.ragflow).toBe(
				"RAGFlow: on · https://env-rf.example · key from RAGFLOW_API_KEY · grounding off · all datasets",
			);
			expect(text).not.toContain(HS_ENV_KEY);
			expect(text).not.toContain(RF_ENV_KEY);
		});

		test("the stored key wins over env keys, and env keys are named when nothing is stored", async () => {
			userServices({
				hindsight: { enabled: true, url: HS_URL },
				ragflow: { enabled: true, url: RF_URL },
			});
			clearStore();
			process.env.HINDSIGHT_API_KEY = HS_ENV_KEY;
			process.env.RAGFLOW_API_KEY = RF_ENV_KEY;
			const fromEnv = serviceLines(await runControl(["status"], io));
			expect(fromEnv.hindsight).toBe(
				`Hindsight: on · ${HS_URL} · bank ultrathink · key from HINDSIGHT_API_KEY`,
			);
			expect(fromEnv.ragflow).toBe(
				`RAGFlow: on · ${RF_URL} · key from RAGFLOW_API_KEY · grounding off · all datasets`,
			);

			storeKeys(HS_STORE_KEY, RF_STORE_KEY);
			const text = await runControl(["status"], io);
			const stored = serviceLines(text);
			expect(stored.hindsight).toContain("key from store");
			expect(stored.ragflow).toContain("key from store");
			for (const secret of [HS_STORE_KEY, HS_ENV_KEY, RF_STORE_KEY, RF_ENV_KEY])
				expect(text).not.toContain(secret);
		});

		test("status makes no request to either service", async () => {
			userServices({
				hindsight: { enabled: true, url: HS_URL },
				ragflow: { enabled: true, url: RF_URL },
			});
			storeKeys(HS_STORE_KEY, RF_STORE_KEY);
			const fetched: string[] = [];
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (input: string | URL | Request) => {
				fetched.push(input instanceof Request ? input.url : String(input));
				return new Response(null, { status: 500 });
			}) as unknown as typeof fetch;
			try {
				await runControl(["status"], io);
			} finally {
				globalThis.fetch = realFetch;
			}
			expect(fetched).toEqual([]);
		});
	});

	test("bin/ultrathink decisions goes to the decisions command, not the control verbs", () => {
		// beforeEach already removed OPENROUTER_API_KEY and pointed config and the store at temp paths.
		const proc = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "commands.ts"), "Decisions"],
			{
				cwd: io.cwd,
				env: { ...process.env, HOME: join(dir, "home") },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(proc.exitCode).toBe(2);
		expect(proc.stdout.toString()).toBe(
			"Usage: ultrathink decisions check | ultrathink decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json> | ultrathink decisions usage [--days N] [--json]\n",
		);
	});

	test.each(["hindsight", "ragflow", "teach"])(
		"bin/ultrathink %s goes to its own command, not the control verbs",
		(name) => {
			const proc = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "commands.ts"), name, "--no-such-flag"],
				{
					cwd: io.cwd,
					env: {
						...process.env,
						HOME: join(dir, "home"),
						ULTRATHINK_STATE_DIR: join(dir, "state"),
						ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			// Not runControl's usage text, and a usage failure (2) rather than a success (0).
			expect(proc.stdout.toString()).not.toStartWith("Usage: ultrathink <command>");
			expect(proc.exitCode).not.toBe(0);
		},
	);

	test("the usage text lists doctor", async () => {
		expect(await runControl(["bogus"], io)).toContain(
			"  doctor [--json]        check config files, credentials, state and environment",
		);
	});

	describe("Stack status line", () => {
		const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
		const CANARY_B = "vck_CANARYCANARYCANARY1234";

		function stackLine(text: string): string {
			const line = text.split("\n").find((candidate) => candidate.startsWith("Stack: "));
			if (line === undefined) throw new Error("status printed no Stack line");
			return line;
		}

		/** Every stack member off or missing, and no token directory of the host in reach. */
		function hermeticStackEnv(): void {
			process.env.SUBSTRATE_DISABLED = "1";
			process.env.ULTRATHINK_REALM = "off";
			process.env.ULTRATHINK_DECISIONS = "0";
			process.env.SUBSTRATE_TOKENS_DIR = join(dir, "no-tokens");
			delete process.env.ULTRATHINK_SWARM_ROOT;
			delete process.env.SWARM_ROOT;
		}

		test("status carries one counts-only Stack line between the Teach and Engine request lines", async () => {
			hermeticStackEnv();
			const text = await runControl(["status"], io);
			const lines = text.split("\n");
			expect(stackLine(text)).toBe("Stack: 4 off · 1 missing (run ultrathink stack)");
			expect(lines.filter((line) => line.startsWith("Stack: "))).toHaveLength(1);
			const index = lines.findIndex((line) => line.startsWith("Stack: "));
			expect(lines[index - 1]).toStartWith("Teach:");
			expect(lines[index + 1]).toStartWith("Engine request:");
		});

		test("a ready Decisions key moves one member from off to ready without a request", async () => {
			hermeticStackEnv();
			delete process.env.ULTRATHINK_DECISIONS;
			process.env.ULTRATHINK_OPENROUTER_KEY = CANARY;
			const original = globalThis.fetch;
			let calls = 0;
			globalThis.fetch = (() => {
				calls++;
				throw new Error("status must not touch the network");
			}) as unknown as typeof fetch;
			try {
				const text = await runControl(["status"], io);
				expect(stackLine(text)).toBe("Stack: 1 ready · 3 off · 1 missing (run ultrathink stack)");
				expect(calls).toBe(0);
			} finally {
				globalThis.fetch = original;
			}
		});

		test("no planted input value reaches the Stack line", async () => {
			hermeticStackEnv();
			delete process.env.SUBSTRATE_DISABLED;
			process.env.SUBSTRATE_URL = `https://operator:${CANARY}@substrate.example.test`;
			process.env.SUBSTRATE_TOKEN = CANARY;
			process.env.ULTRATHINK_SWARM_ROOT = `/nonexistent/${CANARY_B}`;
			process.env.HINDSIGHT_API_URL = `https://hindsight.example.test/${CANARY}`;
			process.env.HINDSIGHT_API_KEY = CANARY_B;
			process.env.AI_GATEWAY_API_KEY = CANARY;
			process.env.RAGFLOW_API_KEY = CANARY_B;
			const line = stackLine(await runControl(["status"], io));
			expect(line).toMatch(/^Stack: (\d+ (ready|off|missing)( · )?)+ \(run ultrathink stack\)$/);
			expect(line).not.toContain("CANARY");
			expect(line).not.toContain("substrate.example");
			expect(line).not.toContain("nonexistent");
		});

		test("the usage text lists stack with its flags", async () => {
			expect(await runControl(["bogus"], io)).toContain(
				"  stack [--live] [--json] [--strict] [--only <member>] [--timeout <ms>]   five stack links with reason and fix",
			);
		});
	});

	describe("bin/ultrathink doctor", () => {
		const FAKE_KEY = "sk-test-not-a-real-key-0123456789";

		/**
		 * The doctor's `stack` section makes real probes (Substrate brief, Hindsight, the Swarm classifier, the Realm
		 * socket). Every member is disabled or pointed at nothing here, and no directory of the host is in reach, so
		 * the run depends on this temp dir only.
		 */
		function hermeticDoctorEnv(): Record<string, string | undefined> {
			const env: Record<string, string | undefined> = {
				...process.env,
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "xdg"),
				ULTRATHINK_STATE_DIR: join(dir, "state"),
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				SUBSTRATE_DISABLED: "1",
				SUBSTRATE_TOKENS_DIR: join(dir, "no-tokens"),
				ULTRATHINK_REALM: "off",
				ULTRATHINK_DECISIONS: "0",
				ULTRATHINK_HINDSIGHT: "0",
				OPENROUTER_API_KEY: FAKE_KEY,
			};
			for (const name of [
				"SUBSTRATE_URL",
				"SUBSTRATE_TOKEN",
				"ULTRATHINK_SWARM_ROOT",
				"SWARM_ROOT",
				"HINDSIGHT_API_URL",
				"HINDSIGHT_API_KEY",
				"HINDSIGHT_API_TOKEN",
				"DESK_GATEWAY_URL",
				"DESK_GATEWAY_TOKEN",
				"ULTRATHINK_HINDSIGHT_BACKEND",
				"ULTRATHINK_SUBSTRATE_BACKEND",
				"ULTRATHINK_OPENROUTER_KEY",
				"AI_GATEWAY_API_KEY",
			]) {
				delete env[name];
			}
			return env;
		}

		function runDoctor(args: string[]): { stdout: string; exitCode: number | null } {
			const proc = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "commands.ts"), "doctor", ...args],
				{
					cwd: io.cwd,
					env: hermeticDoctorEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
		}

		test("goes to the doctor command and prints a report without any key", () => {
			const { stdout, exitCode } = runDoctor([]);
			expect(stdout).toStartWith("ultrathink doctor\n");
			expect(stdout).toMatch(/\d+ errors?, \d+ warnings?\n$/);
			expect(stdout).not.toContain(FAKE_KEY);
			expect(exitCode).toBe(stdout.includes("✗") ? 1 : 0);
		});

		test("--json prints one object", () => {
			const { stdout } = runDoctor(["--json"]);
			const report: DoctorReport = JSON.parse(stdout);
			expect(typeof report.ok).toBe("boolean");
			expect(report.findings.length).toBeGreaterThan(0);
			expect(stdout).not.toContain(FAKE_KEY);
		});

		test("an unknown flag is a usage error", () => {
			const { stdout, exitCode } = runDoctor(["--no-such-flag"]);
			expect(stdout).toBe("Usage: ultrathink doctor [--json]\n");
			expect(exitCode).toBe(2);
		});
	});

	test("the usage text lists prune", async () => {
		expect(await runControl(["bogus"], io)).toContain("  prune [--older-than <days>] [--dry-run]");
	});

	describe("bin/ultrathink prune", () => {
		const SECRET_PROMPT = "a prompt that must never be printed";
		const PRUNE_NOW = Date.UTC(2026, 9, 9, 12);

		function runPrune(args: string[]): { stdout: string; exitCode: number | null } {
			const proc = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "commands.ts"), "prune", ...args],
				{
					cwd: io.cwd,
					env: {
						...process.env,
						HOME: join(dir, "home"),
						ULTRATHINK_STATE_DIR: join(dir, "state"),
						ULTRATHINK_PRUNE_NOW_MS: String(PRUNE_NOW),
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
		}

		function seedSession(id: string, ageDays: number): string {
			const sessions = join(dir, "state", "sessions");
			mkdirSync(sessions, { recursive: true });
			const path = join(sessions, `${id}.json`);
			writeFileSync(
				path,
				JSON.stringify({
					sessionId: id,
					at: 0,
					result: { xml: "", original: SECRET_PROMPT, root: "", source: "llm" },
				}),
			);
			const aged = (PRUNE_NOW - ageDays * 86_400_000) / 1000;
			utimesSync(path, aged, aged);
			return path;
		}

		test("--dry-run reports the old session and removes nothing; without it the session goes and the new one stays", () => {
			const old = seedSession("old-session", 60);
			const fresh = seedSession("fresh-session", 1);
			const preview = runPrune(["--older-than", "30", "--dry-run"]);
			expect(preview.exitCode).toBe(0);
			expect(preview.stdout).toStartWith("Would prune 1 session");
			expect(preview.stdout).toContain("old-session");
			expect(preview.stdout).not.toContain(SECRET_PROMPT);
			expect(existsSync(old)).toBe(true);
			const real = runPrune(["--older-than", "30"]);
			expect(real.exitCode).toBe(0);
			expect(real.stdout).toStartWith("Pruned 1 session");
			expect(existsSync(old)).toBe(false);
			expect(existsSync(fresh)).toBe(true);
		});

		test("without a cutoff anywhere it refuses and removes nothing", () => {
			const old = seedSession("old-session", 400);
			const { stdout, exitCode } = runPrune([]);
			expect(exitCode).toBe(2);
			expect(stdout).toContain("no cutoff");
			expect(existsSync(old)).toBe(true);
		});

		test("a cutoff below one day is refused", () => {
			const old = seedSession("old-session", 400);
			const { stdout, exitCode } = runPrune(["--older-than", "0"]);
			expect(exitCode).toBe(2);
			expect(stdout).toContain("refusing to prune everything");
			expect(existsSync(old)).toBe(true);
		});
	});
});

describe("dispatchStack", () => {
	const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
	const INPUT = { cwd: "/tmp/ut-dispatch-stack-cwd", env: {} };

	function fake(member: StackMember, over: Partial<StackConnection> = {}): StackProbe {
		return async () => ({ member, status: "connected", reason: `${member} answers`, ...over });
	}

	function deps(over: Partial<Record<StackMember, Partial<StackConnection>>> = {}) {
		const probes: Record<StackMember, StackProbe> = {
			substrate: fake("substrate", over.substrate),
			swarm: fake("swarm", over.swarm),
			realm: fake("realm", over.realm),
			decisions: fake("decisions", over.decisions),
			hindsight: fake("hindsight", over.hindsight),
		};
		return {
			probes,
			config: defaultConfig(),
			stateDir: "/tmp/ut-dispatch-stack-state",
			host: "claude-code" as const,
		};
	}

	test("passes argv through to the stack command: --only and --json shape the output", async () => {
		const { code, text } = await dispatchStack(["--json", "--only", "realm"], INPUT, deps());
		expect(code).toBe(0);
		const parsed = JSON.parse(text) as { members: StackConnection[] };
		expect(parsed.members.map((member) => member.member)).toEqual(["realm"]);
		const all = await dispatchStack([], INPUT, deps());
		expect(all.text.split("\n")).toHaveLength(STACK_MEMBERS.length);
	});

	test("exit 0 for a healthy stack, also under --strict", async () => {
		expect((await dispatchStack(["--strict"], INPUT, deps())).code).toBe(0);
	});

	test("--strict exits 1 with a misconfigured member and 0 without --strict", async () => {
		const bad = deps({
			swarm: { status: "misconfigured", reason: "ULTRATHINK_SWARM_ROOT is relative" },
		});
		const strict = await dispatchStack(["--strict"], INPUT, bad);
		expect(strict.code).toBe(1);
		expect(strict.text).toContain("swarm  misconfigured  ULTRATHINK_SWARM_ROOT is relative");
		expect((await dispatchStack([], INPUT, bad)).code).toBe(0);
	});

	test("a bad --only value is a usage error: exit 2 and the one-line usage", async () => {
		const result = await dispatchStack(["--only", "nope"], INPUT, deps());
		expect(result.code).toBe(2);
		expect(result.text).toStartWith("Usage: ultrathink stack ");
		expect(result.text).not.toContain("\n");
	});

	test("a secret in a probe answer never reaches the text", async () => {
		const leaky = deps({
			hindsight: { status: "unavailable", reason: `key ${CANARY} refused`, fix: `use ${CANARY}` },
		});
		const { text } = await dispatchStack([], INPUT, leaky);
		expect(text).not.toContain("CANARYCANARY");
	});
});
