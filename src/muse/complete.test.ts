// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortError, CHILD_ENV } from "../claude/complete.ts";
import { readReport } from "../types.ts";
import { CHILD_PROMPT_SENTINEL, planningTarget } from "../uplift/skill.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { buildMuseArgs, buildMusePrompt, museComplete, parseMuseJsonl } from "./complete.ts";
import { DEFAULT_MUSE_CONFIG, MUSE_MODEL_DEFAULT } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function terminalLine(text: string, terminal = "completed", reason: string | null = null): string {
	return JSON.stringify({
		payload_type: "run.terminal.completed",
		payload: { terminal, reason, text },
	});
}

function noiseLine(): string {
	return JSON.stringify({ payload_type: "task.lifecycle.started", payload: { kind: "started" } });
}

describe("buildMuseArgs", () => {
	test("neuters tools, asks for json, passes model/effort/prompt file", () => {
		expect(
			buildMuseArgs("/tmp/p.txt", { model: "muse-spark-1.3-contributor", reasoningEffort: "low" }),
		).toEqual([
			"exec",
			"--json",
			"--disable-shell",
			"--disable-write",
			"--disable-web-tools",
			"--max-model-steps",
			"1",
			"--model",
			"muse-spark-1.3-contributor",
			"--reasoning-effort",
			"low",
			"--prompt-file",
			"/tmp/p.txt",
		]);
	});

	test("the unpinned default sends the Muse route default from the central map (muse-spark-1.3-contributor)", () => {
		expect(MUSE_MODEL_DEFAULT).toBe(ROUTE_DEFAULT_MODELS.muse);
		const args = buildMuseArgs("/tmp/p.txt", {
			model: DEFAULT_MUSE_CONFIG.model,
			reasoningEffort: DEFAULT_MUSE_CONFIG.reasoningEffort,
		});
		expect(args[args.indexOf("--model") + 1]).toBe(ROUTE_DEFAULT_MODELS.muse);
		expect(args[args.indexOf("--model") + 1]).toBe("muse-spark-1.3-contributor");
	});

	test("blank model omits --model (CLI session default answers)", () => {
		for (const model of [undefined, "", "   "]) {
			const args = buildMuseArgs("/tmp/p.txt", { model });
			expect(args).not.toContain("--model");
			expect(args).toContain("--reasoning-effort");
		}
	});

	test("echo provider omits model/effort (the echo provider rejects both)", () => {
		const args = buildMuseArgs("/tmp/p.txt", {
			provider: "echo",
			model: "muse-spark-1.3-contributor",
			reasoningEffort: "low",
		});
		expect(args).toContain("--provider");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--reasoning-effort");
	});
});

describe("buildMusePrompt", () => {
	test("system block above the user payload", () => {
		expect(buildMusePrompt("SYS", "USER")).toBe(
			`${CHILD_PROMPT_SENTINEL}\n<system>\nSYS\n</system>\n\n<user_request>\nUSER\n</user_request>`,
		);
	});
	test("the nesting sentinel rides first so nested hooks skip without the child env", () => {
		expect(buildMusePrompt("SYS", "USER").startsWith(`${CHILD_PROMPT_SENTINEL}\n`)).toBe(true);
	});
	test("a built child prompt plans to a nested-child skip", () => {
		expect(planningTarget(buildMusePrompt("SYS", "USER"), { cwd: "/nonexistent" })).toEqual({
			skip: "nested-child",
		});
	});
});

describe("parseMuseJsonl", () => {
	test("returns the last terminal text", () => {
		const stdout = [noiseLine(), terminalLine("first"), noiseLine(), terminalLine("<X/>")].join(
			"\n",
		);
		expect(parseMuseJsonl(stdout, "", 0)).toBe("<X/>");
	});

	test("failed terminal throws with the reason", () => {
		const stdout = terminalLine("", "failed", "bad config");
		expect(() => parseMuseJsonl(stdout, "", 1)).toThrow("bad config");
	});

	test("missing terminal throws with the stderr excerpt", () => {
		expect(() => parseMuseJsonl(`${noiseLine()}\n`, "muse: something broke", 1)).toThrow(
			"muse: something broke",
		);
	});

	test("empty output falls back to the exit code", () => {
		expect(() => parseMuseJsonl("", "", 2)).toThrow("muse exited 2");
	});

	test("skips blank and non-JSON lines", () => {
		expect(parseMuseJsonl(`\nnot json\n${terminalLine("ok")}\n{broken`, "", 0)).toBe("ok");
	});

	test("empty text throws", () => {
		expect(() => parseMuseJsonl(terminalLine(""), "", 0)).toThrow("no text");
	});
});

const noWait = { sleep: async (): Promise<void> => undefined, random: () => 0 };

describe("museComplete (fake bin)", () => {
	/** Writes a fake `muse` binary that records argv/prompt/child-env and prints `stdout` lines. */
	function fakeMuse(stdout: string, exitCode = 0): { bin: string; seenPath: string } {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-cli-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		const seenPath = join(dir, "seen.json");
		writeFileSync(
			bin,
			`#!${process.execPath}\nconst args = process.argv.slice(2);\nconst prompt = await Bun.file(args[args.indexOf("--prompt-file") + 1]).text();\nawait Bun.write(${JSON.stringify(seenPath)}, JSON.stringify({ args, prompt, child: process.env.${CHILD_ENV} }));\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.exit(${exitCode});\n`,
			{ mode: 0o755 },
		);
		return { bin, seenPath };
	}

	async function seen(
		seenPath: string,
	): Promise<{ args: string[]; prompt: string; child?: string }> {
		return (await Bun.file(seenPath).json()) as { args: string[]; prompt: string; child?: string };
	}

	test("spawns tool-free, sends the system block via prompt file, marks the child", async () => {
		const { bin, seenPath } = fakeMuse(`${noiseLine()}\n${terminalLine("<X/>")}\n`);
		const text = await museComplete("SYS", "USER", { bin, model: "m1", reasoningEffort: "low" });
		expect(text).toBe("<X/>");
		const got = await seen(seenPath);
		expect(got.prompt).toBe(buildMusePrompt("SYS", "USER"));
		expect(got.child).toBe("1");
		expect(got.args.slice(0, 7)).toEqual([
			"exec",
			"--json",
			"--disable-shell",
			"--disable-write",
			"--disable-web-tools",
			"--max-model-steps",
			"1",
		]);
		expect(got.args).toContain("--model");
		expect(got.args).toContain("m1");
	});

	test("the child never sees the Jev key variables inherited from the parent env", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-jev-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		const seenPath = join(dir, "seen.json");
		writeFileSync(
			bin,
			`#!${process.execPath}\nawait Bun.write(${JSON.stringify(seenPath)}, JSON.stringify({ jev: [process.env.ULTRATHINK_OPENROUTER_KEY ?? null, process.env.OPENROUTER_API_KEY ?? null, process.env.AI_GATEWAY_API_KEY ?? null] }));\nprocess.stdout.write(${JSON.stringify(`${terminalLine("ok")}\n`)});\n`,
			{ mode: 0o755 },
		);
		const names = [
			"ULTRATHINK_OPENROUTER_KEY",
			"OPENROUTER_API_KEY",
			"AI_GATEWAY_API_KEY",
		] as const;
		const saved = names.map((name) => process.env[name]);
		for (const name of names) process.env[name] = "sk-or-v1-CANARYCANARYCANARY1234";
		try {
			await museComplete("SYS", "USER", { bin });
		} finally {
			names.forEach((name, index) => {
				const value = saved[index];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			});
		}
		const got = (await Bun.file(seenPath).json()) as { jev: (string | null)[] };
		expect(got.jev).toEqual([null, null, null]);
	});

	test("removes the prompt directory afterwards", async () => {
		const { bin, seenPath } = fakeMuse(`${terminalLine("ok")}\n`);
		await museComplete("SYS", "USER", { bin });
		const got = await seen(seenPath);
		const promptFile = got.args[got.args.indexOf("--prompt-file") + 1] as string;
		expect(promptFile.startsWith(`${tmpdir()}/`)).toBe(true);
		await expect(Bun.file(promptFile).exists()).resolves.toBe(false);
	});

	test("non-zero exit without output throws the exit code", async () => {
		const { bin } = fakeMuse("", 2);
		const error = await museComplete("SYS", "USER", { bin, retrySeams: noWait }).then(
			() => new Error("should have thrown"),
			(error: Error) => error,
		);
		expect(error.message).toContain("muse exited 2");
	});

	test("timeout surfaces as a timed-out error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-cli-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		// The child never exits on its own: the kernel timeout is the only thing that ends it.
		writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
		const error = await museComplete("SYS", "USER", { bin, timeoutMs: 50 }).then(
			() => new Error("should have thrown"),
			(error: Error) => error,
		);
		expect(error.message).toBe("muse timed out after 50ms");
		expect(readReport(error)?.attempts).toBe(1);
	});

	test("abort rejects with AbortError", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-cli-"));
		dirs.push(dir);
		const bin = join(dir, "muse");
		writeFileSync(bin, `#!${process.execPath}\nawait new Promise(() => {});\n`, { mode: 0o755 });
		const controller = new AbortController();
		const pending = museComplete("SYS", "USER", { bin, signal: controller.signal }).then(
			() => "resolved",
			(error: Error) => error.name,
		);
		controller.abort();
		expect(await pending).toBe("AbortError");
	});
});

describe("museComplete resilience", () => {
	interface Step {
		out?: string;
		err?: string;
		exit?: number;
	}

	/** Stub `muse` whose n-th call replays steps[n-1] (the last step repeats); `spawns()` counts calls. */
	function sequence(steps: Step[]): { bin: string; spawns: () => number } {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-muse-seq-"));
		dirs.push(dir);
		steps.forEach((step, index) => {
			writeFileSync(join(dir, `out.${index + 1}`), step.out ?? "");
			writeFileSync(join(dir, `err.${index + 1}`), step.err ?? "");
			writeFileSync(join(dir, `exit.${index + 1}`), String(step.exit ?? 0));
		});
		const counter = join(dir, "counter");
		const bin = join(dir, "muse");
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
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

	const okOut = (text: string): string => `${terminalLine(text)}\n`;
	const transient: Step = { err: "fetch failed", exit: 1 };

	async function failure(run: Promise<string>): Promise<Error> {
		return run.then(
			() => new Error("should have thrown"),
			(error: Error) => error,
		);
	}

	const museTempDirs = (): string[] =>
		readdirSync(tmpdir()).filter(
			(name) =>
				name.startsWith("ultrathink-muse-") &&
				!name.includes("-cli-") &&
				!name.includes("-seq-") &&
				!name.includes("-jev-"),
		);

	test("a transient failure is retried and succeeds on attempt 2", async () => {
		const stub = sequence([transient, { out: okOut("second") }]);
		expect(await museComplete("s", "u", { bin: stub.bin, retrySeams: noWait })).toBe("second");
		expect(stub.spawns()).toBe(2);
	});

	test("a success spawns exactly once", async () => {
		const stub = sequence([{ out: okOut("fine") }]);
		await museComplete("s", "u", { bin: stub.bin, retrySeams: noWait });
		expect(stub.spawns()).toBe(1);
	});

	test("two transient failures then a success resolves on attempt 3", async () => {
		const stub = sequence([transient, transient, { out: okOut("third") }]);
		expect(await museComplete("s", "u", { bin: stub.bin, retrySeams: noWait })).toBe("third");
		expect(stub.spawns()).toBe(3);
	});

	test("a truncated payload is a failed attempt with cause truncated_reply", async () => {
		const stub = sequence([{ out: `${terminalLine("cut", "truncated", "max_tokens")}\n` }]);
		const error = await failure(museComplete("s", "u", { bin: stub.bin, retrySeams: noWait }));
		expect(readReport(error)?.cause).toBe("truncated_reply");
		expect(readReport(error)?.attempts).toBe(3);
	});

	test("an empty reply text is a truncated_reply failure", async () => {
		const stub = sequence([{ out: okOut("") }]);
		const error = await failure(museComplete("s", "u", { bin: stub.bin, retrySeams: noWait }));
		expect(readReport(error)?.cause).toBe("truncated_reply");
	});

	test("a permanent failure is not retried", async () => {
		const stub = sequence([{ err: "permission denied", exit: 1 }]);
		const error = await failure(museComplete("s", "u", { bin: stub.bin, retrySeams: noWait }));
		expect(error.message).toContain("permission denied");
		expect(stub.spawns()).toBe(1);
	});

	test("an abort during the backoff rejects with AbortError after one spawn", async () => {
		const stub = sequence([transient, { out: okOut("never") }]);
		const controller = new AbortController();
		const error = await failure(
			museComplete("s", "u", {
				bin: stub.bin,
				signal: controller.signal,
				retrySeams: {
					sleep: async () => {
						controller.abort();
						throw abortError();
					},
				},
			}),
		);
		expect(error.name).toBe("AbortError");
		expect(readReport(error)).toBeUndefined();
		expect(stub.spawns()).toBe(1);
	});

	test("an already-aborted signal rejects without spawning", async () => {
		const stub = sequence([{ out: okOut("never") }]);
		const controller = new AbortController();
		controller.abort();
		const error = await failure(
			museComplete("s", "u", { bin: stub.bin, signal: controller.signal }),
		);
		expect(error.name).toBe("AbortError");
		expect(stub.spawns()).toBe(0);
	});

	test("a missing executable rejects and leaves no prompt directory behind", async () => {
		const before = museTempDirs();
		const error = await failure(
			museComplete("PLAINTEXT-PROMPT", "u", {
				bin: join(tmpdir(), "ultrathink-muse-missing-bin-does-not-exist"),
				retrySeams: noWait,
			}),
		);
		expect(error).toBeInstanceOf(Error);
		expect(museTempDirs().filter((name) => !before.includes(name))).toEqual([]);
	});

	test("the report cause is redacted, one line and at most 200 characters", async () => {
		const secret = "sk-ant-api03-SENTINELSENTINELSENTINEL1234567890";
		const stub = sequence([{ err: `first ${secret}\nsecond ${"x".repeat(400)}`, exit: 1 }]);
		const error = await failure(museComplete("s", "u", { bin: stub.bin, retrySeams: noWait }));
		const cause = readReport(error)?.cause ?? "";
		expect(cause.length).toBeGreaterThan(0);
		expect(cause.length).toBeLessThanOrEqual(200);
		expect(cause).not.toContain("\n");
		expect(cause).not.toContain("SENTINELSENTINEL");
	});

	test("a transient failure on every attempt throws the original error with attempts 3", async () => {
		const stub = sequence([transient]);
		const error = await failure(museComplete("s", "u", { bin: stub.bin, retrySeams: noWait }));
		expect(error.name).not.toBe("RetryExhaustedError");
		expect(error.message).toContain("fetch failed");
		expect(readReport(error)?.attempts).toBe(3);
		expect(stub.spawns()).toBe(3);
	});
});
