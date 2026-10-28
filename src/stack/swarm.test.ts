// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import type { ClassifyRun, ClassifySpawn } from "../swarm/classify.ts";
import { briefDigest, writeLaneFile } from "../swarm/lane.ts";
import type { OrchStatusSpawn } from "../swarm/teams.ts";
import { createSwarmProbe, probeSwarm } from "./swarm.ts";
import type { StackConnection, StackProbeContext } from "./types.ts";

const SECRET = "sk-or-fake-CANARYCANARY1234";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** A directory that passes `resolveSwarmRoot`: absolute, existing, with `hooks/autonomous_run.py`. */
function swarmCheckout(): string {
	const root = tempDir("ut-stack-swarm-root-");
	mkdirSync(join(root, "hooks"), { recursive: true });
	writeFileSync(join(root, "hooks", "autonomous_run.py"), "import sys\nsys.exit(0)\n");
	return root;
}

interface Fixture {
	root: string;
	stateDir: string;
	alive: Set<number>;
	classifyCalls: string[];
	statusCalls: string[];
	classifier: ClassifySpawn;
	status: OrchStatusSpawn;
	probe: (ctx: StackProbeContext) => Promise<StackConnection>;
	ctx: (
		env?: Record<string, string | undefined>,
		over?: Partial<StackProbeContext>,
	) => StackProbeContext;
}

/** A probe over a stub classifier and a stub `orch_status`; no python, no real pid is ever signalled. */
function fixture(run: ClassifyRun = { exitCode: 0 }, statusStdout = ""): Fixture {
	const root = swarmCheckout();
	const stateDir = tempDir("ut-stack-swarm-state-");
	const alive = new Set<number>();
	const classifyCalls: string[] = [];
	const statusCalls: string[] = [];
	const classifier: ClassifySpawn = async (cmd, args) => {
		classifyCalls.push([cmd, ...args].join(" "));
		return run;
	};
	const status: OrchStatusSpawn = async (_cmd, args) => {
		statusCalls.push(args.join(" "));
		return { stdout: statusStdout };
	};
	return {
		root,
		stateDir,
		alive,
		classifyCalls,
		statusCalls,
		classifier,
		status,
		probe: createSwarmProbe({
			classifySpawn: classifier,
			statusSpawn: status,
			isAlive: (pid) => alive.has(pid),
			verify: () => "match",
		}),
		ctx: (env = {}, over = {}) => ({
			env: {
				ULTRATHINK_SWARM_ROOT: root,
				OPENROUTER_API_KEY: SECRET,
				...env,
			},
			config: defaultConfig(),
			cwd: "/work/space",
			stateDir,
			host: "omp",
			live: false,
			timeoutMs: 2000,
			...over,
		}),
	};
}

/** One lane directory with a `lane.json`; `correlation` adds the file that makes status ask `orch_status`. */
function addLane(
	stateDir: string,
	laneId: string,
	pid: number,
	opts: { correlation?: boolean; startedAt?: string } = {},
): void {
	const dir = join(stateDir, "swarm", laneId);
	mkdirSync(dir, { recursive: true });
	writeLaneFile(dir, {
		laneId,
		pid,
		briefDigest: briefDigest(laneId),
		cwd: "/work/space",
		startedAt: opts.startedAt ?? new Date().toISOString(),
	});
	if (opts.correlation) writeFileSync(join(dir, "latest_correlation"), "corr-1\n");
}

/** No user-visible field may carry the planted secret. */
function expectClean(result: StackConnection): void {
	expect(JSON.stringify(result)).not.toContain("sk-or-fake");
}

describe("probeSwarm", () => {
	test("nothing opted in and no root set is disabled, names swarm.autoRun, and runs nothing", async () => {
		const f = fixture();
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_ROOT: undefined }));
		expect(result).toMatchObject({ member: "swarm", status: "disabled", via: "config" });
		expect(result.reason).toContain("swarm.autoRun");
		expect(f.classifyCalls).toEqual([]);
		expect(f.statusCalls).toEqual([]);
		expectClean(result);
	});

	test("autoRun on with no root is misconfigured and says which variables are unset", async () => {
		const f = fixture();
		const config = defaultConfig();
		config.swarm.autoRun = true;
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_ROOT: undefined }, { config }));
		expect(result.status).toBe("misconfigured");
		expect(result.reason).toContain("ULTRATHINK_SWARM_ROOT");
		expect(result.reason).toContain("SWARM_ROOT");
		expect(f.classifyCalls).toEqual([]);
		expectClean(result);
	});

	test("a root that does not exist is misconfigured with the resolver's reason, even with autoRun off", async () => {
		const f = fixture();
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_ROOT: "/nonexistent/agent-swarm" }));
		expect(result).toMatchObject({ status: "misconfigured", via: "config" });
		expect(result.reason).toBe(
			"/nonexistent/agent-swarm is not an agent-swarm checkout (missing /nonexistent/agent-swarm/hooks/autonomous_run.py)",
		);
		expect(f.classifyCalls).toEqual([]);
		expectClean(result);
	});

	test("a checkout directory without hooks/autonomous_run.py is misconfigured", async () => {
		const f = fixture();
		const bare = tempDir("ut-stack-swarm-bare-");
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_ROOT: bare }));
		expect(result.status).toBe("misconfigured");
		expect(result.reason).toContain("is not an agent-swarm checkout");
	});

	test("a relative root is misconfigured and the mistyped value is never echoed", async () => {
		const f = fixture();
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_ROOT: SECRET }));
		expect(result.status).toBe("misconfigured");
		expect(result.reason).toBe("ULTRATHINK_SWARM_ROOT must be an absolute path");
		expect(f.classifyCalls).toEqual([]);
		expectClean(result);
	});

	test("a mistyped root that is a credential reaches no field of the report, through either variable", async () => {
		const canary = "sk-or-v1-CANARYCANARYCANARY1234";
		const f = fixture();
		const envs = [
			{ ULTRATHINK_SWARM_ROOT: canary },
			{ SWARM_ROOT: canary, ULTRATHINK_SWARM_ROOT: undefined },
		];
		for (const env of envs) {
			const result = await f.probe(f.ctx(env));
			expect(result.status).toBe("misconfigured");
			expect(JSON.stringify(result)).not.toContain("CANARY");
			expect(result.reason).toMatch(/^(ULTRATHINK_)?SWARM_ROOT must be an absolute path$/);
		}
	});

	test("a lane whose identity cannot be verified is still counted live, never forgotten", async () => {
		const f = fixture();
		addLane(f.stateDir, "aaaaaaaa-1-n1", 4501);
		f.alive.add(4501);
		const probe = createSwarmProbe({
			classifySpawn: f.classifier,
			statusSpawn: f.status,
			isAlive: (pid) => f.alive.has(pid),
			verify: () => "unknown",
		});
		const result = await probe(f.ctx());
		expect(result.reason).toBe("classifier ok, 1 live lane(s)");
	});

	test("SWARM_ROOT is accepted when ULTRATHINK_SWARM_ROOT is unset (the resolver's fallback, not a second lookup)", async () => {
		const f = fixture();
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_ROOT: undefined, SWARM_ROOT: f.root }));
		expect(result.status).toBe("connected");
	});

	test("python3 missing is unavailable and says so", async () => {
		const f = fixture({ errorCode: "ENOENT" });
		const result = await f.probe(f.ctx());
		expect(result).toMatchObject({ status: "unavailable", via: "cli" });
		expect(result.reason).toBe("Swarm classifier unavailable: python3 not found");
		expectClean(result);
	});

	test("a classifier that cannot import swarm.signal_detector is unavailable", async () => {
		const f = fixture({ exitCode: 1, stderr: "ModuleNotFoundError: No module named 'swarm'" });
		const result = await f.probe(f.ctx());
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("Swarm classifier unavailable: classifier import failed");
		expectClean(result);
	});

	test("a plain non-zero classifier exit is reported by its code, not as an import failure", async () => {
		const f = fixture({ exitCode: 1 });
		const result = await f.probe(f.ctx());
		expect(result.status).toBe("unavailable");
		expect(result.reason).toBe("Swarm classifier unavailable: classifier exited with code 1");
		expectClean(result);
	});

	test("the probe asks the real preflight with the swarm checkout as cwd and imports swarm.signal_detector", async () => {
		const f = fixture();
		await f.probe(f.ctx());
		expect(f.classifyCalls).toHaveLength(1);
		expect(f.classifyCalls[0]).toContain("python3 -c");
		expect(f.classifyCalls[0]).toContain("swarm.signal_detector");
	});

	test("a classifier that answers skip still proves the link: connected", async () => {
		const f = fixture({ exitCode: 2 });
		const result = await f.probe(f.ctx());
		expect(result.status).toBe("connected");
	});

	test("live lanes at the cap are degraded and name the cap and the stop command", async () => {
		const f = fixture();
		addLane(f.stateDir, "aaaaaaaa-1-n1", 4101);
		addLane(f.stateDir, "bbbbbbbb-1-n2", 4102);
		f.alive.add(4101).add(4102);
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_MAX_LANES: "2" }));
		expect(result).toMatchObject({ status: "degraded", affects: ["lanes"] });
		expect(result.reason).toBe("2 live lane(s) at the cap of 2 (ULTRATHINK_SWARM_MAX_LANES)");
		expect(result.fix).toContain("/ultrathink-swarm stop");
		expectClean(result);
	});

	test("a live lane older than the 24 newest still counts toward the cap", async () => {
		const f = fixture();
		// The long-running lane is the oldest directory by mtime; 24 newer (dead) lanes push it out of the bounded listing.
		addLane(f.stateDir, "aaaaaaaa-1-old", 4101);
		const old = (Date.now() - 3_600_000) / 1000;
		utimesSync(join(f.stateDir, "swarm", "aaaaaaaa-1-old"), old, old);
		f.alive.add(4101);
		for (let i = 2; i < 26; i += 1) addLane(f.stateDir, `bbbbbbbb-${i}-n${i}`, 5000 + i);
		const result = await f.probe(f.ctx({ ULTRATHINK_SWARM_MAX_LANES: "1" }));
		expect(result).toMatchObject({ status: "degraded", affects: ["lanes"] });
		expect(result.reason).toBe("1 live lane(s) at the cap of 1 (ULTRATHINK_SWARM_MAX_LANES)");
	});

	test("a lane that needs attention is degraded even below the cap", async () => {
		const f = fixture(
			{ exitCode: 0 },
			JSON.stringify({ complete: false, counts: { FAILED: 1, DONE: 2 } }),
		);
		// pid 4201 is not alive: a finished lane whose Task Store holds a FAILED task.
		addLane(f.stateDir, "aaaaaaaa-1-n1", 4201, { correlation: true });
		const result = await f.probe(f.ctx());
		expect(result.status).toBe("degraded");
		expect(result.reason).toBe(
			"1 lane(s) started in the last 24 h need attention (see /ultrathink-swarm status)",
		);
		expect(f.statusCalls).toHaveLength(1);
		expectClean(result);
	});

	describe("the 24 hour attention window", () => {
		const NOW = Date.parse("2026-10-28T12:00:00.000Z");
		const HOUR_MS = 60 * 60 * 1000;
		const FAILED = JSON.stringify({ complete: false, counts: { FAILED: 1 } });

		test("a failed lane started 25 h ago does not degrade the link", async () => {
			const f = fixture({ exitCode: 0 }, FAILED);
			addLane(f.stateDir, "aaaaaaaa-1-n1", 4401, {
				correlation: true,
				startedAt: new Date(NOW - 25 * HOUR_MS).toISOString(),
			});
			const result = await f.probe(f.ctx({}, { now: () => NOW }));
			expect(result.status).toBe("connected");
			expect(result.reason).toBe("classifier ok, 0 live lane(s)");
		});

		test("a failed lane started 2 h ago degrades the link and the reason counts it", async () => {
			const f = fixture({ exitCode: 0 }, FAILED);
			addLane(f.stateDir, "aaaaaaaa-1-n1", 4402, {
				correlation: true,
				startedAt: new Date(NOW - 2 * HOUR_MS).toISOString(),
			});
			addLane(f.stateDir, "bbbbbbbb-1-n2", 4403, {
				correlation: true,
				startedAt: new Date(NOW - 30 * HOUR_MS).toISOString(),
			});
			const result = await f.probe(f.ctx({}, { now: () => NOW }));
			expect(result.status).toBe("degraded");
			expect(result.reason).toBe(
				"1 lane(s) started in the last 24 h need attention (see /ultrathink-swarm status)",
			);
		});

		test("a lane directory without lane.json is not counted", async () => {
			const f = fixture({ exitCode: 0 }, FAILED);
			const dir = join(f.stateDir, "swarm", "aaaaaaaa-1-n1");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "latest_correlation"), "corr-1\n");
			const result = await f.probe(f.ctx({}, { now: () => NOW }));
			expect(result.status).toBe("connected");
			expect(f.statusCalls).toEqual([]);
		});
	});

	test("connected reports the live-lane count and does not count dead lanes", async () => {
		const f = fixture();
		addLane(f.stateDir, "aaaaaaaa-1-n1", 4301);
		addLane(f.stateDir, "bbbbbbbb-1-n2", 4302);
		addLane(f.stateDir, "cccccccc-1-n3", 4303); // dead: its pid is not alive
		f.alive.add(4301).add(4302);
		const result = await f.probe(f.ctx());
		expect(result).toMatchObject({
			member: "swarm",
			status: "connected",
			reason: "classifier ok, 2 live lane(s)",
			via: "cli",
		});
		expectClean(result);
	});

	test("with no lanes at all it is connected with zero and never calls orch_status", async () => {
		const f = fixture();
		const result = await f.probe(f.ctx());
		expect(result.reason).toBe("classifier ok, 0 live lane(s)");
		expect(f.statusCalls).toEqual([]);
	});

	test("the free read-only checks run without `live`, and `live` changes nothing", async () => {
		const f = fixture();
		const idle = await f.probe(f.ctx({}, { live: false }));
		const live = await f.probe(f.ctx({}, { live: true }));
		expect(idle.status).toBe("connected");
		expect({ ...live, latencyMs: 0 }).toEqual({ ...idle, latencyMs: 0 });
	});

	test("a classifier that never answers ends in unavailable within the probe budget", async () => {
		const hang: ClassifySpawn = () => Promise.withResolvers<ClassifyRun>().promise;
		const f = fixture();
		const probe = createSwarmProbe({ classifySpawn: hang });
		const began = Date.now();
		// Real clock on purpose: the probe's own hard timeout is the behaviour under test.
		const result = await probe(f.ctx({}, { timeoutMs: 150 }));
		expect(result.status).toBe("unavailable");
		expect(Date.now() - began).toBeLessThan(2000);
		expectClean(result);
	});

	test("the exported probeSwarm is a ready StackProbe that reports the swarm member and never throws", async () => {
		const f = fixture();
		const result = await probeSwarm(f.ctx({ ULTRATHINK_SWARM_ROOT: undefined }));
		expect(result.member).toBe("swarm");
		expect(result.status).toBe("disabled");
	});
});
