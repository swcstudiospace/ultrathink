// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { teachConfigError, teachContext, teachEnabled } from "./context.ts";
import { DEFAULT_TEACH_CONFIG } from "./types.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A sandbox whose config and state locations are all inside one temp directory under the home directory. */
function sandbox() {
	// The state resolver accepts only paths under the home directory, so the sandbox lives there too.
	const root = mkdtempSync(join(homedir(), "ultrathink-teach-failclosed-"));
	dirs.push(root);
	const cwd = join(root, "project");
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	const env: NodeJS.ProcessEnv = {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "xdg"),
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		ULTRATHINK_MCP_STORE: join(root, "credentials.json"),
	};
	const userConfig = join(env.XDG_CONFIG_HOME!, "ultrathink", "config.json");
	const projectConfig = join(cwd, ".claude", "ultrathink.json");
	return { cwd, env, userConfig, projectConfig };
}

describe("teachContext when a config file cannot be used", () => {
	test("a present but unparseable user config leaves teach disabled with capture explicit", () => {
		const { cwd, env, userConfig } = sandbox();
		mkdirSync(join(userConfig, ".."), { recursive: true });
		writeFileSync(userConfig, '{ "teach": { "enabled": false, ');
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.teach.enabled).toBe(false);
		expect(ctx.config.teach.capture).toBe("explicit");
		expect(teachEnabled(ctx)).toBe(false);
		expect(teachConfigError(ctx)).toContain(userConfig);
	});

	test("a present but unparseable project config leaves teach disabled with capture explicit", () => {
		const { cwd, env, projectConfig } = sandbox();
		writeFileSync(projectConfig, "not json at all");
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.teach.enabled).toBe(false);
		expect(ctx.config.teach.capture).toBe("explicit");
		expect(teachEnabled(ctx)).toBe(false);
		expect(teachConfigError(ctx)).toContain(projectConfig);
	});

	test("a config file that parses to something other than an object fails closed too", () => {
		const { cwd, env, userConfig } = sandbox();
		mkdirSync(join(userConfig, ".."), { recursive: true });
		writeFileSync(userConfig, "[]");
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.teach.enabled).toBe(false);
		expect(ctx.config.teach.capture).toBe("explicit");
		expect(teachConfigError(ctx)).toContain("not a JSON object");
	});

	test("a missing config keeps the defaults and reports no error", () => {
		const { cwd, env } = sandbox();
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.teach).toEqual(DEFAULT_TEACH_CONFIG);
		expect(teachEnabled(ctx)).toBe(true);
		expect(teachConfigError(ctx)).toBeUndefined();
	});

	test("a valid config is still honored and reports no error", () => {
		const { cwd, env, userConfig } = sandbox();
		mkdirSync(join(userConfig, ".."), { recursive: true });
		writeFileSync(userConfig, JSON.stringify({ teach: { capture: "observe" } }));
		const ctx = teachContext({ cwd, env });
		expect(ctx.config.teach.capture).toBe("observe");
		expect(ctx.config.teach.enabled).toBe(true);
		expect(teachConfigError(ctx)).toBeUndefined();
	});
});
