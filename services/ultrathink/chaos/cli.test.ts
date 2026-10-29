// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { yieldTurn } from "../../../src/test.helpers.ts";
import { makeTempDir } from "../test.helpers.ts";
import { type CliDeps, runCli } from "./cli.ts";
import { appendHistory } from "./history.ts";
import type { HttpFetch, HttpRequestInit } from "./observe.ts";
import type { Pressure, PressureSpec } from "./pipeline/pressure.ts";
import type { RunResult } from "./run.ts";

const EXPERIMENTS = join(import.meta.dir, "experiments");
const ROLLBACK = ["deploy/ultrathink-release.sh", "rollback"];
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshDir(): string {
	return makeTempDir("chaos-cli-", roots);
}

interface Harness {
	deps: CliDeps;
	stdout: () => string;
	stderr: () => string;
	/** Every side effect in call order: confirmations, requests and rollback argvs. */
	events: string[];
	historyPath: string;
}

interface HarnessOptions {
	env?: Record<string, string | undefined>;
	confirm?: CliDeps["confirm"];
	sleep?: CliDeps["sleep"];
	/** HTTP status for a path; defaults to 200 everywhere. */
	statusFor?: (path: string) => number;
	/** Replaces the Bun-worker pressure helper, so no test spins a real worker. */
	startPressure?: CliDeps["startPressure"];
}

function harness(options: HarnessOptions = {}): Harness {
	const dir = freshDir();
	const out: string[] = [];
	const err: string[] = [];
	const events: string[] = [];
	const statusFor = options.statusFor ?? (() => 200);
	const fetchImpl: HttpFetch = async (url) => {
		const path = new URL(url).pathname;
		events.push(`fetch ${path}`);
		return new Response("{}", { status: statusFor(path) });
	};
	const historyPath = join(dir, "history.jsonl");
	const deps: CliDeps = {
		stdout: (text) => out.push(text),
		stderr: (text) => err.push(text),
		env: options.env ?? {},
		fetch: fetchImpl,
		exec: async (argv) => {
			events.push(`exec ${argv.join(" ")}`);
			return 0;
		},
		confirm:
			options.confirm ??
			(async () => {
				events.push("confirm");
			}),
		now: () => new Date("2026-10-21T00:00:00.000Z"),
		sleep: options.sleep ?? (() => Promise.resolve()),
		templatesDir: EXPERIMENTS,
		historyPath,
		...(options.startPressure ? { startPressure: options.startPressure } : {}),
	};
	return { deps, stdout: () => out.join(""), stderr: () => err.join(""), events, historyPath };
}

function runRecord(templateId: string, score: number): RunResult {
	return {
		templateId,
		driver: "inprocess",
		startedAt: "2026-10-21T00:00:00.000Z",
		finishedAt: "2026-10-21T00:00:01.000Z",
		settled: true,
		hypotheses: [],
		passed: score === 100,
		score,
		rollback: "not_needed",
	};
}

describe("templates", () => {
	test("lists all seven templates, one per failure mode", async () => {
		const h = harness();

		const code = await runCli(["templates"], h.deps);

		expect(code).toBe(0);
		const ids = h
			.stdout()
			.trim()
			.split("\n")
			.map((line) => line.split("\t")[0]);
		expect(ids).toEqual([
			"audit-corrupt",
			"inflight-saturation",
			"persistence-unavailable",
			"sigterm-drain",
			"stale-journal-retention",
			"upstream-5xx-breaker",
			"upstream-latency-timeout",
		]);
	});
});

describe("run: gates and usage", () => {
	test("http driver off loopback without staging exits 2 and sends no request", async () => {
		const h = harness();

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "https://example.com"],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.events).toEqual([]);
		expect(h.stderr()).toContain("ULTRATHINK_CHAOS_ENV=staging");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("http driver off loopback with staging set reaches the target", async () => {
		const h = harness({ env: { ULTRATHINK_CHAOS_ENV: "staging" } });

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "https://example.com"],
			h.deps,
		);

		expect(code).toBe(0);
		expect(h.events).toEqual(["confirm", "fetch /healthz", "fetch /readyz", "fetch /healthz"]);
	});

	test("http driver without a base URL exits 2", async () => {
		const h = harness();

		expect(await runCli(["run", "audit-corrupt", "--driver", "http"], h.deps)).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("a rollback argv that is not JSON exits 2", async () => {
		const h = harness();

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"http://127.0.0.1:9",
				"--rollback-argv",
				"not json",
			],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("an empty rollback argv exits 2", async () => {
		const h = harness();

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"http://127.0.0.1:9",
				"--rollback-argv",
				"[]",
			],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("an in-process template given the http driver exits 2", async () => {
		const h = harness();

		expect(
			await runCli(
				["run", "upstream-5xx-breaker", "--driver", "http", "--base-url", "http://127.0.0.1:9"],
				h.deps,
			),
		).toBe(2);
		expect(h.events).toEqual([]);
	});

	test("an unknown command or template exits 2", async () => {
		expect(await runCli(["frobnicate"], harness().deps)).toBe(2);
		expect(await runCli(["run", "no-such-template", "--driver", "inprocess"], harness().deps)).toBe(
			2,
		);
	});
});

describe("run: operator template over http", () => {
	test("confirmation comes before any request, and a passing run is recorded", async () => {
		const h = harness();

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9"],
			h.deps,
		);

		expect(code).toBe(0);
		expect(h.events[0]).toBe("confirm");
		expect(h.stdout()).toContain("Operator step, to be performed by hand");
		expect(h.stdout()).toContain("audit-corrupt via http: PASSED");
		expect(readFileSync(h.historyPath, "utf8").trim().split("\n")).toHaveLength(1);
	});

	test("a rejected confirmation sends no load and records no history", async () => {
		const h = harness({
			confirm: async () => {
				throw new Error("operator step not confirmed; no load was sent");
			},
		});

		const code = await runCli(
			["run", "audit-corrupt", "--driver", "http", "--base-url", "http://127.0.0.1:9"],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.events.some((event) => event.startsWith("fetch"))).toBe(false);
		expect(h.stderr()).toContain("no load was sent");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("a failed hypothesis exits 1, and rollback runs once when staging and argv are given", async () => {
		const h = harness({
			env: { ULTRATHINK_CHAOS_ENV: "staging" },
			statusFor: (path) => (path === "/readyz" ? 503 : 200),
		});

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"http://127.0.0.1:9",
				"--rollback-argv",
				JSON.stringify(ROLLBACK),
			],
			h.deps,
		);

		expect(code).toBe(1);
		expect(h.events.filter((event) => event.startsWith("exec"))).toEqual([
			`exec ${ROLLBACK.join(" ")}`,
		]);
		expect(h.stdout()).toContain("rollback invoked (exit 0)");
	});

	test("the same failure outside staging does not run rollback", async () => {
		const h = harness({ statusFor: (path) => (path === "/readyz" ? 503 : 200) });

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"http://127.0.0.1:9",
				"--rollback-argv",
				JSON.stringify(ROLLBACK),
			],
			h.deps,
		);

		expect(code).toBe(1);
		expect(h.events.some((event) => event.startsWith("exec"))).toBe(false);
		expect(h.stdout()).toContain("rollback skipped:not_staging");
	});
});

describe("run: in-process template", () => {
	test("upstream-5xx-breaker passes end to end and writes one history line", async () => {
		const h = harness({ sleep: yieldTurn });

		const code = await runCli(["run", "upstream-5xx-breaker", "--driver", "inprocess"], h.deps);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("upstream-5xx-breaker via inprocess: PASSED");
		expect(readFileSync(h.historyPath, "utf8").trim().split("\n")).toHaveLength(1);
	});
});

describe("score", () => {
	test("prints the mean and slope of a fixture history", async () => {
		const h = harness();
		for (const score of [60, 70, 80])
			appendHistory(h.historyPath, runRecord("upstream-5xx-breaker", score));

		const code = await runCli(["score", "upstream-5xx-breaker"], h.deps);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("runs 3");
		expect(h.stdout()).toContain("mean 70");
		expect(h.stdout()).toContain("trend slope 10");
		expect(h.stdout()).toContain("latest 80");
	});

	test("with no runs it reports none without failing", async () => {
		const h = harness();

		expect(await runCli(["score", "upstream-5xx-breaker"], h.deps)).toBe(0);
		expect(h.stdout()).toContain("no runs recorded");
	});
});

describe("run: production-safety gate", () => {
	test("a production URL is refused on the gate before the template is checked", async () => {
		const h = harness();

		const code = await runCli(
			[
				"run",
				"upstream-5xx-breaker",
				"--driver",
				"http",
				"--base-url",
				"https://ultrathink.swcstudio.space",
			],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.stderr()).toContain("ULTRATHINK_CHAOS_ENV=staging");
		expect(h.events).toEqual([]);
	});
});

describe("run: TLS probe flags", () => {
	function pemFiles(): { ca: string; cert: string; key: string } {
		const dir = freshDir();
		const files = {
			ca: join(dir, "ca.pem"),
			cert: join(dir, "probe.pem"),
			key: join(dir, "probe.key"),
		};
		writeFileSync(files.ca, "CA-PEM");
		writeFileSync(files.cert, "CERT-PEM");
		writeFileSync(files.key, "KEY-PEM");
		return files;
	}

	test("the probe presents the client identity read from the PEM files", async () => {
		const h = harness();
		const files = pemFiles();
		const seen: HttpRequestInit[] = [];
		const deps: CliDeps = {
			...h.deps,
			fetch: async (_url, init) => {
				seen.push(init);
				return new Response("{}", { status: 200 });
			},
		};

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"https://127.0.0.1:9",
				"--ca-file",
				files.ca,
				"--client-cert",
				files.cert,
				"--client-key",
				files.key,
			],
			deps,
		);

		expect(code).toBe(0);
		expect(seen.length).toBeGreaterThan(0);
		for (const init of seen)
			expect(init.tls).toEqual({ ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" });
	});

	test("TLS flags with the in-process driver exit 2 before anything runs", async () => {
		const h = harness();
		const files = pemFiles();

		const code = await runCli(
			["run", "upstream-5xx-breaker", "--driver", "inprocess", "--ca-file", files.ca],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.stderr()).toContain("apply to --driver http only");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("a client certificate without its key exits 2 and sends no request", async () => {
		const h = harness();
		const files = pemFiles();

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"https://127.0.0.1:9",
				"--client-cert",
				files.cert,
			],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.stderr()).toContain("must be given together");
		expect(h.events).toEqual([]);
	});

	test("TLS flags over plain http exit 2 and send no request", async () => {
		const h = harness();
		const files = pemFiles();

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"http://127.0.0.1:9",
				"--ca-file",
				files.ca,
			],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.stderr()).toContain("need an https --base-url");
		expect(h.events).toEqual([]);
	});

	test("an unreadable PEM file exits 2 before any request", async () => {
		const h = harness();
		const missing = join(freshDir(), "absent-ca.pem");

		const code = await runCli(
			[
				"run",
				"audit-corrupt",
				"--driver",
				"http",
				"--base-url",
				"https://127.0.0.1:9",
				"--ca-file",
				missing,
			],
			h.deps,
		);

		expect(code).toBe(2);
		expect(h.stderr()).toContain(`--ca-file cannot read ${missing}`);
		expect(h.events).toEqual([]);
	});
});

function stubPressure(ratio: number, asked: PressureSpec[] = []): (spec: PressureSpec) => Pressure {
	return (spec) => {
		asked.push(spec);
		return {
			achieved: () => ({ cpuMs: ratio * 1000, wallMs: 1000, ratio, stallMaxMs: 0 }),
			stop: async () => undefined,
			ballastBytes: () => 0,
		};
	};
}

describe("pipeline templates", () => {
	test("lists the five load scenarios with their prompts and concurrency", async () => {
		const h = harness();

		const code = await runCli(["pipeline", "templates"], h.deps);

		expect(code).toBe(0);
		const rows = h
			.stdout()
			.trim()
			.split("\n")
			.map((line) => line.split("\t"));
		expect(rows.map((row) => [row[0], row[2], row[3]])).toEqual([
			["nominal", "500", "25"],
			["recovery", "5", "1"],
			["smoke", "50", "5"],
			["spike", "1000", "100"],
			["stress", "2000", "100"],
		]);
		expect(rows.every((row) => (row[1] ?? "").length > 0)).toBe(true);
	});

	test("takes no arguments", async () => {
		const h = harness();

		expect(await runCli(["pipeline", "templates", "extra"], h.deps)).toBe(2);
	});
});

describe("pipeline run and score", () => {
	test("runs a resized smoke scenario, prints the verdict, records history and exits 0", async () => {
		const h = harness();

		const code = await runCli(
			["pipeline", "run", "smoke", "--prompts", "4", "--concurrency", "2", "--seed", "5"],
			h.deps,
		);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("smoke via pipeline: PASSED, score 100");
		expect(h.stdout()).toContain("  pass terminal");
		expect(h.stdout()).toContain(`recorded seq 1 in ${h.historyPath}`);
		const history = readFileSync(h.historyPath, "utf8").trim().split("\n");
		expect(history).toHaveLength(1);
		expect(JSON.parse(history[0] ?? "{}")).toMatchObject({
			templateId: "smoke",
			driver: "pipeline",
			score: 100,
			seq: 1,
		});
		expect(h.events).toEqual([]);
	});

	test("--trace-heap is accepted and prints the heap trace lines", async () => {
		const h = harness();

		const code = await runCli(
			["pipeline", "run", "smoke", "--prompts", "2", "--trace-heap"],
			h.deps,
		);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("smoke via pipeline: PASSED");
		expect(await runCli(["pipeline", "run", "smoke", "--trace-heap=yes"], harness().deps)).toBe(2);
	});

	test("--history overrides the default history file", async () => {
		const h = harness();
		const custom = join(freshDir(), "custom.jsonl");

		const code = await runCli(
			["pipeline", "run", "smoke", "--prompts", "2", "--history", custom],
			h.deps,
		);

		expect(code).toBe(0);
		expect(existsSync(custom)).toBe(true);
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("score reads the recorded pipeline runs back", async () => {
		const h = harness();
		appendHistory(h.historyPath, { ...runRecord("smoke", 100), driver: "pipeline" });
		appendHistory(h.historyPath, { ...runRecord("smoke", 90), driver: "pipeline" });

		const code = await runCli(["pipeline", "score", "smoke"], h.deps);

		expect(code).toBe(0);
		expect(h.stdout()).toContain("smoke: runs 2");
		expect(h.stdout()).toContain("mean 95");
		expect(await runCli(["pipeline", "score", "nominal"], h.deps)).toBe(0);
		expect(h.stdout()).toContain("nominal: no runs recorded");
	});

	test("--pressure asks the helper for the scenario's pressure and a met floor passes", async () => {
		const asked: PressureSpec[] = [];
		const h = harness({ startPressure: stubPressure(2, asked) });

		const code = await runCli(["pipeline", "run", "smoke", "--prompts", "2", "--pressure"], h.deps);

		expect(code).toBe(0);
		expect(asked).toHaveLength(1);
		expect(asked[0]?.duty).toBe(1);
		expect(h.stdout()).toContain("  pass pressure");
	});

	test("--pressure that the host did not deliver fails the run with pressure-not-applied", async () => {
		const h = harness({ startPressure: stubPressure(0.01) });

		const code = await runCli(["pipeline", "run", "smoke", "--prompts", "2", "--pressure"], h.deps);

		expect(code).toBe(1);
		expect(h.stdout()).toContain("fail pressure (pressure-not-applied");
		expect(h.stdout()).toContain("FAILED");
	});

	test("usage errors exit 2 and run nothing", async () => {
		const bad: string[][] = [
			["pipeline"],
			["pipeline", "bogus"],
			["pipeline", "run"],
			["pipeline", "run", "no-such-scenario"],
			["pipeline", "run", "smoke", "--prompts", "0"],
			["pipeline", "run", "smoke", "--prompts", "abc"],
			["pipeline", "run", "smoke", "--concurrency", "129"],
			["pipeline", "run", "smoke", "--seed", "-1"],
			["pipeline", "run", "smoke", "--frobnicate", "1"],
			["pipeline", "run", "smoke", "--provider", "fake"],
			["pipeline", "run", "smoke", "--max-calls", "5"],
			["pipeline", "run", "smoke", "--provider", "real", "--max-calls", "0"],
			["pipeline", "run", "smoke", "extra", "args"],
			["pipeline", "score"],
			["pipeline", "score", "smoke", "--prompts", "3"],
		];

		for (const argv of bad) {
			const h = harness();
			expect(await runCli(argv, h.deps)).toBe(2);
			expect(existsSync(h.historyPath)).toBe(false);
		}
	});

	test("--prompts out of range names the field and not the value", async () => {
		const h = harness();

		expect(await runCli(["pipeline", "run", "smoke", "--prompts", "9999"], h.deps)).toBe(2);
		expect(h.stderr()).toContain("prompts.count must be between 1 and 5000");
		expect(h.stderr()).not.toContain("9999");
	});
});

describe("pipeline run: the real-provider guard", () => {
	test("--provider real without ULTRATHINK_CHAOS_REAL=1 is refused with exit 2 and nothing is recorded", async () => {
		const h = harness();

		const code = await runCli(["pipeline", "run", "smoke", "--provider", "real"], h.deps);

		expect(code).toBe(2);
		expect(h.stderr()).toContain("ULTRATHINK_CHAOS_REAL=1");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("the environment flag alone does not turn the real provider on", async () => {
		const h = harness({ env: { ULTRATHINK_CHAOS_REAL: "1" } });

		const code = await runCli(["pipeline", "run", "smoke", "--prompts", "2"], h.deps);

		expect(code).toBe(0);
		expect(h.stdout()).not.toContain("calls made");
	});

	test("stress and spike are refused even with both gates", async () => {
		for (const id of ["stress", "spike"]) {
			const h = harness({ env: { ULTRATHINK_CHAOS_REAL: "1" } });

			const code = await runCli(["pipeline", "run", id, "--provider", "real"], h.deps);

			expect(code).toBe(2);
			expect(h.stderr()).toContain(`refuses the ${id} scenario`);
			expect(existsSync(h.historyPath)).toBe(false);
		}
	});
});

describe("pipeline pressure", () => {
	test("holds the requested pressure on the injected sleep, prints cpuMs wallMs ratio and exits 0", async () => {
		const asked: PressureSpec[] = [];
		const slept: number[] = [];
		const h = harness({
			startPressure: stubPressure(1.5, asked),
			sleep: async (ms) => {
				slept.push(ms);
			},
		});

		const code = await runCli(
			["pipeline", "pressure", "--workers", "2", "--seconds", "3", "--memory-mb", "16"],
			h.deps,
		);

		expect(code).toBe(0);
		expect(slept).toEqual([3000]);
		expect(asked[0]).toMatchObject({ workers: 2, duty: 1, memMB: 16 });
		expect(h.stdout()).toBe("pressure held 3s: cpuMs 1500 wallMs 1000 ratio 1.5\n");
		expect(existsSync(h.historyPath)).toBe(false);
	});

	test("a ratio under the floor exits 2 with pressure not applied; --floor lowers the bar", async () => {
		const slow = harness({ startPressure: stubPressure(0.01) });
		const lowered = harness({ startPressure: stubPressure(0.01) });

		expect(
			await runCli(["pipeline", "pressure", "--workers", "2", "--seconds", "1"], slow.deps),
		).toBe(2);
		expect(slow.stderr()).toContain("pressure not applied");
		expect(
			await runCli(
				["pipeline", "pressure", "--workers", "2", "--seconds", "1", "--floor", "0.005"],
				lowered.deps,
			),
		).toBe(0);
	});

	test("usage errors exit 2 before any pressure starts", async () => {
		const bad: string[][] = [
			["pipeline", "pressure"],
			["pipeline", "pressure", "--workers", "2"],
			["pipeline", "pressure", "--seconds", "3"],
			["pipeline", "pressure", "--workers", "0", "--seconds", "3"],
			["pipeline", "pressure", "--workers", "2", "--seconds", "0"],
			["pipeline", "pressure", "--workers", "two", "--seconds", "3"],
			["pipeline", "pressure", "--workers", "2", "--seconds", "3", "--floor", "high"],
			["pipeline", "pressure", "--workers", "2", "--seconds", "3", "--duty", "1"],
			["pipeline", "pressure", "extra", "--workers", "2", "--seconds", "3"],
		];

		for (const argv of bad) {
			const asked: PressureSpec[] = [];
			const h = harness({ startPressure: stubPressure(5, asked) });
			expect(await runCli(argv, h.deps)).toBe(2);
			expect(asked).toEqual([]);
		}
	});
});
