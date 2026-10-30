// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkipOnce } from "../claude/state.ts";
import {
	carrierPath,
	carrierPathFor,
	clearPlanCarrier,
	readPlanCarrier,
	writePlanCarrier,
} from "./carrier.ts";
import { claimTurn } from "./claim.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "uplift.ts");

let dir: string;
let stateDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-carrier-"));
	stateDir = join(dir, "state");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeStalePlan(sessionId = "s1"): string {
	const path = writePlanCarrier({
		host: "grok-build",
		stateDir,
		sessionId,
		context: "<spec>old prompt</spec>",
	});
	if (!path) throw new Error("stale carrier not written");
	return path;
}

describe("clearPlanCarrier", () => {
	test("removes the carrier of the named session", () => {
		const path = writeStalePlan("s1");
		clearPlanCarrier(stateDir, "s1");
		expect(existsSync(path)).toBe(false);
	});

	test("a missing carrier or state dir is fine", () => {
		expect(() => clearPlanCarrier(stateDir, "s1")).not.toThrow();
		mkdirSync(stateDir, { recursive: true });
		clearPlanCarrier(stateDir, "s1");
		expect(existsSync(carrierPathFor(stateDir, "s1"))).toBe(false);
	});

	test("clearing one session leaves another session's carrier intact", () => {
		const a = writeStalePlan("session-a");
		const b = writeStalePlan("session-b");
		clearPlanCarrier(stateDir, "session-a");
		expect(existsSync(a)).toBe(false);
		expect(existsSync(b)).toBe(true);
	});

	test("a carrier whose stored session differs from the caller's is left in place", () => {
		const path = writeStalePlan("s1");
		// Two ids can sanitize to one file name; the file names its own session.
		const other = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...other, sessionId: "someone-else" }));
		clearPlanCarrier(stateDir, "s1");
		expect(existsSync(path)).toBe(true);
	});

	test("a blank session id clears nothing", () => {
		const path = writeStalePlan("s1");
		for (const id of ["", "  "]) clearPlanCarrier(stateDir, id);
		expect(existsSync(path)).toBe(true);
	});
});

describe("carrierPathFor", () => {
	test("keeps A-Za-z0-9_- and replaces every other character with _", () => {
		expect(carrierPathFor(stateDir, "Abc_9-z")).toBe(join(stateDir, "last-plan.Abc_9-z.json"));
		expect(carrierPathFor(stateDir, "a/../b c\\d")).toBe(
			join(stateDir, "last-plan.a____b_c_d.json"),
		);
		expect(carrierPathFor(stateDir, "s.1:é")).toBe(join(stateDir, "last-plan.s_1__.json"));
	});

	test("cuts the name to 64 characters", () => {
		const path = carrierPathFor(stateDir, `${"a".repeat(80)}`);
		expect(path).toBe(join(stateDir, `last-plan.${"a".repeat(64)}.json`));
	});

	test("a blank id still names a harmless file inside the state dir", () => {
		for (const id of ["", "   "]) {
			const path = carrierPathFor(stateDir, id);
			expect(path.startsWith(`${stateDir}/last-plan.`)).toBe(true);
			expect(path.endsWith(".json")).toBe(true);
			expect(path.slice(stateDir.length + 1)).not.toContain("/");
		}
	});

	test("a path traversal id cannot leave the state dir", () => {
		const path = carrierPathFor(stateDir, "../../etc/passwd");
		expect(path.slice(stateDir.length + 1)).not.toContain("/");
		expect(path.startsWith(`${stateDir}/`)).toBe(true);
	});
});

describe("per-session carriers", () => {
	test("two sessions write distinct files and never read each other's plan", () => {
		const a = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "A",
			context: "plan for A",
		});
		const b = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "B",
			context: "plan for B",
		});
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a).not.toBe(b);
		expect(readPlanCarrier(stateDir, "A")?.context).toBe("plan for A");
		expect(readPlanCarrier(stateDir, "B")?.context).toBe("plan for B");
		expect(readPlanCarrier(stateDir, "C")).toBeUndefined();
	});

	test("clearing session A leaves session B's file intact", () => {
		const a = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "A",
			context: "plan for A",
		});
		const b = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "B",
			context: "plan for B",
		});
		clearPlanCarrier(stateDir, "A");
		expect(existsSync(a as string)).toBe(false);
		expect(existsSync(b as string)).toBe(true);
		expect(readPlanCarrier(stateDir, "B")?.context).toBe("plan for B");
	});

	test("a carrier whose stored sessionId differs from the reader's is rejected", () => {
		const path = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "A",
			context: "plan for A",
		});
		const body = JSON.parse(readFileSync(path as string, "utf8"));
		writeFileSync(path as string, JSON.stringify({ ...body, sessionId: "B" }));
		expect(readPlanCarrier(stateDir, "A")).toBeUndefined();
	});

	test("ids that sanitize to the same file name never read each other's carrier", () => {
		writePlanCarrier({ host: "grok-build", stateDir, sessionId: "a.b", context: "dotted" });
		expect(readPlanCarrier(stateDir, "a.b")?.context).toBe("dotted");
		expect(readPlanCarrier(stateDir, "a:b")).toBeUndefined();
	});

	test("the legacy single-file carrier is never read for a plan", () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			carrierPath(stateDir),
			JSON.stringify({ host: "grok-build", sessionId: "A", context: "old" }),
		);
		expect(readPlanCarrier(stateDir, "A")).toBeUndefined();
	});

	test("an unreadable, blank-id or non-object carrier reads as absent", () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(carrierPathFor(stateDir, "A"), "{");
		expect(readPlanCarrier(stateDir, "A")).toBeUndefined();
		writeFileSync(carrierPathFor(stateDir, "A"), "[]");
		expect(readPlanCarrier(stateDir, "A")).toBeUndefined();
		expect(readPlanCarrier(stateDir, "")).toBeUndefined();
	});

	test("the next write removes a legacy single-file carrier older than 24 h and keeps a fresh one", () => {
		mkdirSync(stateDir, { recursive: true });
		const legacy = carrierPath(stateDir);
		writeFileSync(legacy, "{}");
		const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		utimesSync(legacy, old, old);
		writePlanCarrier({ host: "grok-build", stateDir, sessionId: "A", context: "ctx" });
		expect(existsSync(legacy)).toBe(false);

		writeFileSync(legacy, "{}");
		writePlanCarrier({ host: "grok-build", stateDir, sessionId: "A", context: "ctx" });
		expect(existsSync(legacy)).toBe(true);
	});

	test("the next write also removes another session's carrier older than 24 h, never the writer's own", () => {
		const stale = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "old",
			context: "x",
		});
		const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		utimesSync(stale as string, old, old);
		const fresh = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "new",
			context: "y",
		});
		expect(existsSync(stale as string)).toBe(false);
		expect(existsSync(fresh as string)).toBe(true);
	});
});

describe("writePlanCarrier", () => {
	test("writes the carrier owner-only in a new owner-only state dir, replacing the previous one whole", () => {
		const path = writePlanCarrier({
			host: "grok-build",
			stateDir,
			sessionId: "s1",
			specPath: "/s/s1.xml",
			statePath: "/s/s1.json",
			graphId: "ut-1",
			context: "first",
		});
		const own = carrierPathFor(stateDir, "s1");
		expect(path).toBe(own);
		expect(JSON.parse(readFileSync(own, "utf8"))).toMatchObject({
			host: "grok-build",
			sessionId: "s1",
			specPath: "/s/s1.xml",
			graphId: "ut-1",
			context: "first",
		});
		if (process.platform !== "win32") {
			expect(statSync(own).mode & 0o777).toBe(0o600);
			expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		}
		writePlanCarrier({ host: "grok-build", stateDir, sessionId: "s1", context: "second" });
		expect(JSON.parse(readFileSync(own, "utf8"))).toMatchObject({
			sessionId: "s1",
			context: "second",
		});
		expect(readdirSync(stateDir)).toEqual(["last-plan.s1.json"]);
	});

	test.skipIf(process.platform === "win32")(
		"a 0644 carrier from an older version is 0600 after the next write",
		() => {
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(carrierPathFor(stateDir, "s1"), "{}", { mode: 0o644 });
			writePlanCarrier({ host: "omp", stateDir, sessionId: "s1", context: "ctx" });
			expect(statSync(carrierPathFor(stateDir, "s1")).mode & 0o777).toBe(0o600);
		},
	);

	test("an absent session id (blank, or Prime's unknown placeholder) writes no carrier, since no record could be matched to it", () => {
		for (const sessionId of ["", "  ", "unknown"]) {
			expect(
				writePlanCarrier({
					host: "prime-agent",
					stateDir,
					sessionId,
					specPath: "/s/x.xml",
					context: "ctx",
				}),
			).toBeUndefined();
		}
		const names = existsSync(stateDir) ? readdirSync(stateDir) : [];
		expect(names.filter((name) => name.startsWith("last-plan"))).toEqual([]);
	});
});

describe("uplift hook on Grok, Claude and Muse", () => {
	function runHook(envelope: Record<string, unknown>, host = "grok-build"): string {
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("ULTRATHINK_") && !key.startsWith("GROK_") && key !== "CLAUDE_CONFIG_DIR")
				env[key] = value;
		}
		const proc = Bun.spawnSync([process.execPath, HOOK], {
			cwd: dir,
			env: {
				...env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				ULTRATHINK_HOST: host,
				ULTRATHINK_STATE_DIR: stateDir,
			},
			stdin: Buffer.from(
				JSON.stringify({ hookEventName: "user_prompt_submit", cwd: dir, ...envelope }),
			),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		expect(proc.exitCode).toBe(0);
		return proc.stdout.toString();
	}

	test("prompts that end without a plan remove the previous prompt's carrier", () => {
		for (const prompt of ["/ultrathink-quick fix the typo", "/model sonnet", "ok"]) {
			const path = writeStalePlan();
			runHook({ sessionId: "s1", promptId: prompt, userPrompt: prompt });
			expect(existsSync(path)).toBe(false);
		}
	});

	test("control commands and prompts while planning is off remove the carrier", () => {
		const path = writeStalePlan();
		expect(
			JSON.parse(runHook({ sessionId: "s1", promptId: "p1", userPrompt: "/ultrathink-off" })),
		).toMatchObject({ decision: "block" });
		expect(existsSync(path)).toBe(false);
		writeStalePlan();
		runHook({
			sessionId: "s1",
			promptId: "p2",
			userPrompt: "refactor the billing module to use the new ledger api",
		});
		expect(existsSync(path)).toBe(false);
	});

	test("a duplicate dispatch of a claimed turn leaves the owner's carrier alone", () => {
		const path = writeStalePlan();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		runHook({
			sessionId: "s1",
			promptId: "p1",
			userPrompt: "refactor the billing module to use the new ledger api",
		});
		expect(existsSync(path)).toBe(true);
	});

	test("a subagent prompt leaves the main session's carrier alone", () => {
		const path = writeStalePlan();
		runHook({
			sessionId: "s1",
			promptId: "p2",
			subagentType: "explore",
			userPrompt: "/ultrathink-quick look around",
		});
		expect(existsSync(path)).toBe(true);
	});

	test("/ultrathink-skip arms exactly the session the envelope names, case included", () => {
		const output = JSON.parse(
			runHook({ sessionId: "Grok-S1", promptId: "p9", userPrompt: "/ultrathink-skip" }),
		);
		expect(output).toMatchObject({
			decision: "block",
			reason: "Prompt Uplift will skip the next prompt in this session",
		});
		expect(readSkipOnce(stateDir, "Grok-S1")).toBe(true);
		expect(readSkipOnce(stateDir, "grok-s1")).toBe(false);
	});

	test("the --ctl control CLI arms the session named by --session, with its id kept as given", () => {
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const proc = Bun.spawnSync([process.execPath, HOOK, "--ctl", "skip", "--session", "Ctl-S1"], {
			cwd: dir,
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				ULTRATHINK_HOST: "grok-build",
				ULTRATHINK_STATE_DIR: stateDir,
			},
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toContain(
			"Prompt Uplift will skip the next prompt in this session",
		);
		expect(readSkipOnce(stateDir, "Ctl-S1")).toBe(true);
		expect(readSkipOnce(stateDir, "ctl-s1")).toBe(false);
	});

	test("the normal command branch arms the session its session_id names on every host that routes through this hook; without one it refuses", () => {
		for (const host of ["claude-code", "muse", "grok-build"]) {
			const sessionId = `${host}-Sess`;
			const output = JSON.parse(
				runHook({ session_id: sessionId, prompt: "/ultrathink-skip" }, host),
			);
			expect(output).toMatchObject({
				decision: "block",
				reason: "Prompt Uplift will skip the next prompt in this session",
			});
			expect(readSkipOnce(stateDir, sessionId)).toBe(true);
		}
		const refused = JSON.parse(runHook({ prompt: "/ultrathink-skip" }, "claude-code"));
		expect(refused.reason).toContain("needs a session id");
	});
});

describe("uplift hook with a Jev plan skip", () => {
	const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
	const ACK = "thanks, that works now";
	const NOTICE_004 =
		"Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it";

	/** A loopback Decisions endpoint that always answers JEV(p) and records each request body. */
	function fakeJev(p: number): {
		url: string;
		requests: Array<Record<string, unknown>>;
		stop: () => void;
	} {
		const requests: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push((await request.json()) as Record<string, unknown>);
				return Response.json({
					id: "gen-dec-test",
					model: "typesafe/jev-1.13-20260917",
					provider: "TypeSafe",
					answers: { plan_worthy: { type: "noul", noul: p } },
					usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
				});
			},
		});
		return {
			url: `http://127.0.0.1:${server.port}/decisions`,
			requests,
			stop: () => server.stop(true),
		};
	}

	/**
	 * Runs hooks/uplift.ts as `host` with `ON` (user layer `config`, K in the env, an empty temp store) pointed at the
	 * loopback endpoint. Async spawn: a blocking spawn would starve the fake server's event loop. `claude.bin` names a
	 * missing binary so a run that wrongly plans can never reach a real engine.
	 */
	async function runJevHook(
		host: "claude-code" | "grok-build",
		envelope: Record<string, unknown>,
		jevUrl: string,
		config: Record<string, unknown>,
	): Promise<{ stdout: string; stderr: string }> {
		const home = join(dir, "home");
		mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
		writeFileSync(
			join(home, ".config", "ultrathink", "config.json"),
			JSON.stringify({
				...config,
				claude: { bin: join(dir, "no-claude"), ...(config.claude as object | undefined) },
			}),
		);
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (
				!key.startsWith("ULTRATHINK_") &&
				!key.startsWith("GROK_") &&
				key !== "CLAUDE_CONFIG_DIR" &&
				key !== "OPENROUTER_API_KEY"
			)
				env[key] = value;
		}
		const proc = Bun.spawn([process.execPath, HOOK], {
			cwd: dir,
			env: {
				...env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				ULTRATHINK_HOST: host,
				ULTRATHINK_STATE_DIR: stateDir,
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				ULTRATHINK_DECISIONS_URL: jevUrl,
				ULTRATHINK_OPENROUTER_KEY: K,
				SUBSTRATE_DISABLED: "1",
			},
			stdin: new Blob([JSON.stringify({ cwd: dir, ...envelope })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(await proc.exited).toBe(0);
		expect(`${stdout}${stderr}`).not.toContain(K);
		expect(`${stdout}${stderr}`).not.toContain("Bearer sk-or-");
		return { stdout, stderr };
	}

	test("on Claude a Jev skip prints only the notice, and nothing with echo off, like a deterministic skip (AC-3.1, AC-3.3)", async () => {
		const jev = fakeJev(0.04);
		try {
			const claude = (prompt: string) => ({
				hook_event_name: "UserPromptSubmit",
				session_id: "s1",
				prompt,
			});
			const trivial = await runJevHook("claude-code", claude("thanks"), jev.url, {
				decisions: { enabled: true },
			});
			expect(trivial.stdout).toBe("");
			expect(jev.requests).toHaveLength(0);

			const skipped = await runJevHook("claude-code", claude(ACK), jev.url, {
				decisions: { enabled: true },
			});
			expect(jev.requests).toHaveLength(1);
			expect(jev.requests[0]?.session_id).toBe("s1");
			// No hookSpecificOutput: the prompt reaches the model unchanged.
			expect(JSON.parse(skipped.stdout)).toEqual({ systemMessage: NOTICE_004 });
			expect(existsSync(join(stateDir, "sessions", "s1.json"))).toBe(false);

			const quiet = await runJevHook("claude-code", claude(ACK), jev.url, {
				decisions: { enabled: true },
				claude: { echo: false },
			});
			expect(jev.requests).toHaveLength(2);
			expect(quiet.stdout).toBe("");
			expect(existsSync(join(stateDir, "sessions", "s1.json"))).toBe(false);
		} finally {
			jev.stop();
		}
	}, 30_000);
});
