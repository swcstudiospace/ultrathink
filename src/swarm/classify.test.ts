// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Covers the Swarm preflight: exit 0 accepts, exit 2 refuses, and every other outcome (no python3, import
// failure, timeout, no result) is `unknown` so the lane still spawns. Unit cases use an injected spawn seam;
// the stub-detector cases run the real default runner against a throwaway `swarm.signal_detector` package in
// a tmpdir and skip when python3 is absent.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildClassifyArgv,
	type ClassifyRun,
	type ClassifySpawn,
	preflightClassify,
} from "./classify.ts";

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";

/** A spawn seam that returns a fixed run and records every call. */
function fixedSpawn(run: ClassifyRun) {
	const calls: Array<{
		cmd: string;
		args: readonly string[];
		cwd: string;
		timeout: number;
		env: Record<string, string | undefined>;
	}> = [];
	const spawn: ClassifySpawn = async (cmd, args, opts) => {
		calls.push({ cmd, args, cwd: opts.cwd, timeout: opts.timeout, env: opts.env });
		return run;
	};
	return { spawn, calls };
}

/** Planted Jev keys: all three must be stripped from any child environment. */
const JEV_ENV: Record<string, string> = {
	ULTRATHINK_OPENROUTER_KEY: `${CANARY}A`,
	OPENROUTER_API_KEY: `${CANARY}B`,
	AI_GATEWAY_API_KEY: `${CANARY}C`,
};

const tmpRoots: string[] = [];
afterEach(() => {
	for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-classify-"));
	tmpRoots.push(dir);
	return dir;
}

describe("preflightClassify verdicts", () => {
	test("exit 0 means Swarm accepts the brief", async () => {
		const { spawn } = fixedSpawn({ exitCode: 0 });
		expect(await preflightClassify("build a thing", { swarmRoot: "/swarm", spawn })).toEqual({
			kind: "sdlc",
		});
	});

	test("exit 2 means Swarm would skip the brief, and a skip is never an accept", async () => {
		const { spawn } = fixedSpawn({ exitCode: 2 });
		const verdict = await preflightClassify("what is a monad?", { swarmRoot: "/swarm", spawn });
		expect(verdict).toEqual({ kind: "skip" });
		expect(verdict.kind).not.toBe("sdlc");
	});

	test("a numeric exit code without an import error names the code, never an accept", async () => {
		for (const exitCode of [1, 3, 127, -1]) {
			const { spawn } = fixedSpawn({ exitCode });
			const verdict = await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
			expect(verdict).toEqual({
				kind: "unknown",
				reason: `classifier exited with code ${exitCode}`,
			});
		}
	});

	test("a ModuleNotFoundError or ImportError on stderr is `classifier import failed`", async () => {
		for (const stderr of [
			"Traceback (most recent call last):\nModuleNotFoundError: No module named 'swarm'",
			"ImportError: cannot import name 'classify'",
		]) {
			const { spawn } = fixedSpawn({ exitCode: 1, stderr });
			const verdict = await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
			expect(verdict).toEqual({ kind: "unknown", reason: "classifier import failed" });
		}
	});

	test("stderr without an import error keeps the exit-code reason and is never echoed", async () => {
		const { spawn } = fixedSpawn({ exitCode: 1, stderr: `KeyError: ${CANARY}` });
		const verdict = await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
		expect(verdict).toEqual({ kind: "unknown", reason: "classifier exited with code 1" });
		expect(JSON.stringify(verdict)).not.toContain(CANARY);
	});

	test("a missing python3 (ENOENT) is unknown and names python3", async () => {
		const { spawn } = fixedSpawn({ errorCode: "ENOENT" });
		const verdict = await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
		expect(verdict.kind).toBe("unknown");
		if (verdict.kind === "unknown") expect(verdict.reason).toContain("python3");
	});

	test("a timeout is unknown and names the timeout", async () => {
		const { spawn } = fixedSpawn({ timedOut: true });
		const verdict = await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
		expect(verdict.kind).toBe("unknown");
		if (verdict.kind === "unknown") expect(verdict.reason).toContain("timed out");
	});

	test("an empty result is unknown", async () => {
		const { spawn } = fixedSpawn({});
		expect((await preflightClassify("build x", { swarmRoot: "/swarm", spawn })).kind).toBe(
			"unknown",
		);
	});

	test("a seam that throws is unknown, not a rejection", async () => {
		const spawn: ClassifySpawn = async () => {
			throw new Error(`boom ${CANARY}`);
		};
		const verdict = await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
		expect(verdict.kind).toBe("unknown");
		expect(JSON.stringify(verdict)).not.toContain(CANARY);
	});

	test("no verdict reason ever contains the brief text", async () => {
		const brief = `build the thing with ${CANARY}`;
		const runs: ClassifyRun[] = [
			{ exitCode: 0 },
			{ exitCode: 2 },
			{ exitCode: 1 },
			{ errorCode: "ENOENT" },
			{ errorCode: "EACCES" },
			{ timedOut: true },
			{},
		];
		for (const run of runs) {
			const { spawn } = fixedSpawn(run);
			const verdict = await preflightClassify(brief, { swarmRoot: "/swarm", spawn });
			expect(JSON.stringify(verdict)).not.toContain(CANARY);
		}
	});

	test("the child environment drops the three Jev keys, keeps everything else and never mutates the caller's", async () => {
		const { spawn, calls } = fixedSpawn({ exitCode: 0 });
		const parent = { ...JEV_ENV, PATH: "/usr/bin:/bin", HOME: "/home/x" };
		await preflightClassify("build x", { swarmRoot: "/swarm", spawn, env: parent });
		expect(calls[0]?.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/x" });
		expect(Object.keys(parent)).toContain("ULTRATHINK_OPENROUTER_KEY");
		expect(JSON.stringify(calls[0]?.env)).not.toContain("CANARY");
	});

	test("without an injected env the child env is built from process.env, still without the Jev keys", async () => {
		const saved = process.env.OPENROUTER_API_KEY;
		process.env.OPENROUTER_API_KEY = CANARY;
		try {
			const { spawn, calls } = fixedSpawn({ exitCode: 0 });
			await preflightClassify("build x", { swarmRoot: "/swarm", spawn });
			expect(calls[0]?.env.OPENROUTER_API_KEY).toBeUndefined();
			expect(calls[0]?.env.PATH).toBe(process.env.PATH);
		} finally {
			if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = saved;
		}
	});
});

describe("preflightClassify process contract", () => {
	test("classifies the exact lane text verbatim, with the Swarm root as cwd and the 5 s default cap", async () => {
		const laneText = `Graph ID: ut-abc\nbuild the importer -- "quoted" 'single'\n\n<pstack>\nskills block\n</pstack>`;
		const { spawn, calls } = fixedSpawn({ exitCode: 0 });
		await preflightClassify(laneText, { swarmRoot: "/opt/agent-swarm", spawn });
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.cmd).toBe("python3");
		expect(call?.cwd).toBe("/opt/agent-swarm");
		expect(call?.timeout).toBe(5_000);
		// python sees the last argv element as sys.argv[1]: it must be the lane text, untouched.
		expect(call?.args[call.args.length - 1]).toBe(laneText);
		expect(call?.args).toEqual(buildClassifyArgv(laneText));
	});

	test("an explicit timeoutMs overrides the default cap", async () => {
		const { spawn, calls } = fixedSpawn({ exitCode: 0 });
		await preflightClassify("build x", { swarmRoot: "/swarm", timeoutMs: 123, spawn });
		expect(calls[0]?.timeout).toBe(123);
	});
});

describe("buildClassifyArgv", () => {
	test("imports swarm.signal_detector's classify and accepts only the sdlc label", () => {
		const argv = buildClassifyArgv("build x");
		expect(argv[0]).toBe("-c");
		expect(argv[1]).toContain("from swarm.signal_detector import classify");
		expect(argv[1]).toContain('== "sdlc"');
		expect(argv[2]).toBe("build x");
		expect(argv).toHaveLength(3);
	});
});

const hasPython = Bun.which("python3") !== null;

/** A throwaway Swarm root whose classifier says "sdlc" only for the exact text in `expected.txt`. */
function stubSwarmRoot(expected: string): string {
	const root = tmpRoot();
	mkdirSync(join(root, "swarm"));
	writeFileSync(join(root, "swarm", "__init__.py"), "");
	writeFileSync(
		join(root, "swarm", "signal_detector.py"),
		[
			"def classify(text):",
			'    with open("expected.txt", encoding="utf-8", newline="") as handle:',
			'        return "sdlc" if text == handle.read() else "non-sdlc"',
			"",
		].join("\n"),
	);
	writeFileSync(join(root, "expected.txt"), expected);
	return root;
}

describe.skipIf(!hasPython)("preflightClassify with a stub signal_detector (real python3)", () => {
	test("accepts the exact text, skips any other, with swarm.* resolved from the root's cwd", async () => {
		const laneText = `Graph ID: ut-abc\nbuild it -- "q"\n\n<pstack>\nblock\n</pstack>`;
		const root = stubSwarmRoot(laneText);
		expect(await preflightClassify(laneText, { swarmRoot: root })).toEqual({ kind: "sdlc" });
		expect(await preflightClassify(`${laneText} `, { swarmRoot: root })).toEqual({ kind: "skip" });
		expect(await preflightClassify("what is this?", { swarmRoot: root })).toEqual({ kind: "skip" });
	});

	test("a root without the swarm package is unknown (import failure), never skip or sdlc", async () => {
		const verdict = await preflightClassify("build x", { swarmRoot: tmpRoot() });
		expect(verdict.kind).toBe("unknown");
		if (verdict.kind === "unknown") expect(verdict.reason).toContain("import failed");
	});

	test("a classifier slower than the cap is unknown and names the timeout", async () => {
		const root = tmpRoot();
		mkdirSync(join(root, "swarm"));
		writeFileSync(join(root, "swarm", "__init__.py"), "");
		writeFileSync(
			join(root, "swarm", "signal_detector.py"),
			[
				"import time",
				"",
				"def classify(text):",
				"    time.sleep(30)",
				'    return "sdlc"',
				"",
			].join("\n"),
		);
		const verdict = await preflightClassify("build x", { swarmRoot: root, timeoutMs: 300 });
		expect(verdict.kind).toBe("unknown");
		if (verdict.kind === "unknown") expect(verdict.reason).toContain("timed out");
	});

	test("a missing Swarm root directory is unknown, never a throw", async () => {
		const verdict = await preflightClassify("build x", {
			swarmRoot: join(tmpRoot(), "does-not-exist"),
		});
		expect(verdict.kind).toBe("unknown");
	});

	test("the real child sees the injected environment minus the Jev keys, with PATH intact", async () => {
		const root = tmpRoot();
		mkdirSync(join(root, "swarm"));
		writeFileSync(join(root, "swarm", "__init__.py"), "");
		writeFileSync(
			join(root, "swarm", "signal_detector.py"),
			[
				"import os",
				"",
				"def classify(text):",
				'    leaked = [n for n in ("ULTRATHINK_OPENROUTER_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY") if n in os.environ]',
				'    ok = os.environ.get("UT_MARKER") == "1" and "PATH" in os.environ and not leaked',
				'    return "sdlc" if ok else "non-sdlc"',
				"",
			].join("\n"),
		);
		const env = { ...JEV_ENV, PATH: process.env.PATH, UT_MARKER: "1" };
		expect(await preflightClassify("build x", { swarmRoot: root, env })).toEqual({ kind: "sdlc" });
	});
});
