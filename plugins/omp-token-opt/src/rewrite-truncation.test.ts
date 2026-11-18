import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const indexPath = new URL("./index.ts", import.meta.url).pathname;

describe("rtk rewrite truncation", () => {
	test("rtk output larger than the cap produces no rewritten command", async () => {
		const bin = fakeRtk("printf 'rtk %65540s\\n' ''");
		const home = mkdtempSync(join(tmpdir(), "token-opt-rtk-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "token-opt-rtk-cwd-"));
		expect(await toolCallInChild({ home, path: bin, cwd, command: "git status" })).toBeNull();
	});

	test("rtk output exactly at the cap is still used as the rewrite", async () => {
		const bin = fakeRtk("printf 'rtk %65531s\\n' ''");
		const home = mkdtempSync(join(tmpdir(), "token-opt-rtk-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "token-opt-rtk-cwd-"));
		const rewritten = (await toolCallInChild({ home, path: bin, cwd, command: "git status" })) as {
			input: { command: string };
		} | null;
		expect(rewritten?.input.command.length).toBe(65535);
	});

	// Fake rtk uses only shell builtins so the child process can run with PATH set to the fake's directory alone.
	function fakeRtk(body: string): string {
		const bin = mkdtempSync(join(tmpdir(), "token-opt-rtk-bin-"));
		writeFileSync(join(bin, "rtk"), ["#!/bin/sh", 'if [ "$1" = rewrite ]; then', `  ${body}`, "fi", ""].join("\n"), {
			mode: 0o755,
		});
		return bin;
	}

	// Bun.which reads PATH once at process start, so the rtk lookup is exercised in a child process with its own PATH.
	async function toolCallInChild(opts: { home: string; path: string; cwd: string; command: string }): Promise<unknown> {
		const script = [
			`import tokenOpt from ${JSON.stringify(indexPath)};`,
			"(async () => {",
			"  const handlers = new Map();",
			"  tokenOpt({",
			"    setLabel() {}, zod: { object: () => ({}), string: () => ({}) }, registerTool() {}, registerCommand() {},",
			"    on(event, handler) { handlers.set(event, handler); }, events: { emit() {} },",
			"  });",
			`  const result = await handlers.get("tool_call")({ toolName: "bash", cwd: ${JSON.stringify(opts.cwd)}, input: { command: ${JSON.stringify(opts.command)} } });`,
			"  console.log(JSON.stringify(result ?? null));",
			"})();",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "-e", script], {
			env: { ...process.env, HOME: opts.home, PATH: opts.path },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
		return JSON.parse(out.trim());
	}
});
