// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armSkipOnce, readSkipOnce } from "../src/claude/state.ts";

const HOOKS = import.meta.dir;
const ENTRYPOINTS = ["uplift.ts", "stop.ts", "answers.ts", "flow-eval.ts", "pr-sync.ts"] as const;

describe("emit", () => {
	test("a 400,000-byte hook output reaches the caller intact before the entry exits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-uplift-emit-"));
		try {
			const script = join(dir, "big.ts");
			// The entry's own exit pattern: emit, then process.exit in finally. process.stdout.write plus exit drops
			// everything past the pipe buffer under Bun.
			writeFileSync(
				script,
				`import { emit } from ${JSON.stringify(join(HOOKS, "uplift.ts"))};\n` +
					`emit(JSON.stringify({ systemMessage: "x".repeat(400_000) })).finally(() => process.exit(0));\n`,
			);
			const proc = Bun.spawn(["bun", "--no-env-file", script], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ULTRATHINK_HOST: "claude-code" },
			});
			const out = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			expect(JSON.parse(out).systemMessage).toHaveLength(400_000);
			expect(out).toHaveLength(400_000 + '{"systemMessage":""}'.length);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test("importing uplift.ts runs nothing: the entry only starts as the main module", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-uplift-import-"));
		try {
			const script = join(dir, "import.ts");
			writeFileSync(
				script,
				`import { emit } from ${JSON.stringify(join(HOOKS, "uplift.ts"))};\n` +
					`await emit("ok");\n`,
			);
			const home = join(dir, "home");
			mkdirSync(home, { recursive: true });
			const proc = Bun.spawn(["bun", "--no-env-file", script], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: home, ULTRATHINK_STATE_DIR: join(dir, "state") },
			});
			expect(await new Response(proc.stdout).text()).toBe("ok");
			expect(await proc.exited).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("hook entrypoints", () => {
	for (const name of ENTRYPOINTS) {
		const source = readFileSync(join(HOOKS, name), "utf8");

		test(`${name} writes stdout only through an awaited Bun.write`, () => {
			expect(source).not.toMatch(/console\.log\(/);
			expect(source).not.toMatch(/process\.stdout\.write\(/);
		});

		test(`${name} installs the child reaper and exits only after its output resolved`, () => {
			expect(source).toContain("installChildReaper({ signals: true })");
			expect(source).toMatch(/\.finally\(\(\) => \{?\s*process\.exit\(0\)/);
		});
	}
});

describe("deterministic skips run before engine selection (G-1)", () => {
	/** Runs the hook entry as Grok Build would with no grok login: any engine selection prints a login notice. */
	async function runGrokHook(
		prompt: string,
		arm: boolean,
	): Promise<{
		out: string;
		err: string;
		armedAfter: boolean;
		lastSkip?: { reason?: string; at?: number };
	}> {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-uplift-precheck-"));
		try {
			const home = join(dir, "home");
			const stateDir = join(dir, "state");
			mkdirSync(home, { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			if (arm) armSkipOnce(stateDir, "s1");
			const proc = Bun.spawn(["bun", "--no-env-file", join(HOOKS, "uplift.ts")], {
				stdin: new Blob([
					JSON.stringify({
						session_id: "s1",
						hook_event_name: "UserPromptSubmit",
						cwd: dir,
						prompt,
					}),
				]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					ULTRATHINK_STATE_DIR: stateDir,
					ULTRATHINK_HOST: "grok-build",
				},
			});
			const [out, err] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(await proc.exited).toBe(0);
			const lastSkipPath = join(stateDir, "last-skip.json");
			return {
				out,
				err,
				armedAfter: readSkipOnce(stateDir, "s1"),
				...(existsSync(lastSkipPath)
					? { lastSkip: JSON.parse(readFileSync(lastSkipPath, "utf8")) }
					: {}),
			};
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("an acknowledgement is skipped before any engine lookup, so no login notice is printed", async () => {
		const { out } = await runGrokHook("ok", false);
		expect(out).toBe("");
	}, 60_000);

	test("an armed /ultrathink-skip is spent by the prompt it skips, even when no engine could be selected", async () => {
		const { out, armedAfter } = await runGrokHook("add a retry flag to the exporter", true);
		expect(out).toBe("");
		expect(armedAfter).toBe(false);
	}, 60_000);

	test("every skip writes its reason to the hook log in one line and to the last-skip record, routine ones quietly (G-2)", async () => {
		for (const [prompt, reason] of [
			["ok", "trivial"],
			["raw: add a widget", "passthrough"],
		] as const) {
			const { out, err, lastSkip } = await runGrokHook(prompt, false);
			expect(out).toBe("");
			expect(err.trim().split("\n")).toEqual([`[ultrathink] skipped: ${reason}`]);
			expect(lastSkip?.reason).toBe(reason);
			expect(typeof lastSkip?.at).toBe("number");
		}
		const armed = await runGrokHook("add a retry flag to the exporter", true);
		expect(armed.out).toBe("");
		expect(armed.err.trim()).toBe("[ultrathink] skipped: skip-once");
		expect(armed.lastSkip?.reason).toBe("skip-once");
	}, 90_000);

	test("a graph hand-off and an already-uplifted spec each print one short status line with the reason (G-2)", async () => {
		for (const [prompt, reason] of [
			["Implement node n2 of graph ut-mughkkc0-1a2b3c4d.", "graph-reference"],
			["<BUILD_PROMPT>add a widget</BUILD_PROMPT>", "already-uplifted"],
		] as const) {
			const { out, err, lastSkip } = await runGrokHook(prompt, false);
			const message = JSON.parse(out).systemMessage as string;
			expect(message).toContain(reason);
			expect(message).toContain("uplift:");
			expect(message.split("\n")).toHaveLength(1);
			expect(err.trim()).toBe(`[ultrathink] skipped: ${reason}`);
			expect(lastSkip?.reason).toBe(reason);
		}
	}, 90_000);

	test("a command leaves an armed skip armed for the real next prompt", async () => {
		const { out, armedAfter } = await runGrokHook("/help", true);
		expect(out).toBe("");
		expect(armedAfter).toBe(true);
	}, 60_000);

	test("an unrecognised /word is planned as rewritten text, not skipped as a command, as on Omp (greptile r1 #10)", async () => {
		const { err, lastSkip } = await runGrokHook("/frobnicate do the thing", false);
		// The rewritten target no longer starts with `/`, so the precheck lets it through to engine selection,
		// which is where an ordinary prompt stops here when no Grok login exists.
		expect(err).not.toContain("skipped: command");
		expect(lastSkip?.reason).toBe("engine grok-unavailable");
		const plain = await runGrokHook("frobnicate do the thing", false);
		expect(lastSkip?.reason).toBe(plain.lastSkip?.reason);
	}, 90_000);
});

describe("a provider that answers 429 forever, through the real hook entry and the real Claude completer", () => {
	test("the record says provider_error:429 after 3 attempts, the clarify stage is skipped, and no fill is retried a second time", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-uplift-429-"));
		try {
			const home = join(dir, "home");
			const stateDir = join(dir, "state");
			const calls = join(dir, "calls.log");
			const fake = join(dir, "claude-fake");
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(
				fake,
				`#!/bin/sh\ncat >/dev/null\necho call >> '${calls}'\necho '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"rate limited"}'\nexit 1\n`,
				{ mode: 0o755 },
			);
			writeFileSync(
				join(home, ".config", "ultrathink", "config.json"),
				JSON.stringify({ claude: { bin: fake } }),
			);
			const proc = Bun.spawn(["bun", "--no-env-file", join(HOOKS, "uplift.ts")], {
				stdin: new Blob([
					JSON.stringify({
						session_id: "s429",
						hook_event_name: "UserPromptSubmit",
						cwd: dir,
						prompt: "add a retry flag to the exporter please",
					}),
				]),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					HOME: home,
					ULTRATHINK_STATE_DIR: stateDir,
				},
			});
			const [out] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(await proc.exited).toBe(0);
			expect(out).toContain("Planning degraded");
			const record = JSON.parse(readFileSync(join(stateDir, "last.json"), "utf8"));
			expect(record.result.source).toBe("fallback");
			expect(record.result.fallbackReason).toBe("provider_error:429");
			expect(record.result.attempts).toBe(3);
			expect(record.degraded).toContain("clarify");
			// uplift 3 + graph 3 + five fills at 3 attempts each: the fill layer does not retry what the completer retried,
			// the repair pass does not run against a dead provider and clarify is skipped (39 calls before).
			expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(21);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);
});
