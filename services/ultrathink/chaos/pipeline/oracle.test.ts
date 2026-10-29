// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../test.helpers.ts";
import { type DriveReport, type PromptOutcome, runProbe, runPrompts } from "./drive.ts";
import {
	checkInvariants,
	createJudge,
	type OracleContext,
	type ResourceSnapshot,
	snapshotResources,
} from "./oracle.ts";
import { createScriptedProvider, createVirtualClock } from "./provider.ts";
import { INVARIANT_IDS, type Scenario } from "./scenario.ts";

const roots: string[] = [];

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SCENARIO: Scenario = {
	id: "tiny-run",
	title: "tiny",
	failureMode: "pipeline-load",
	seed: 7,
	prompts: {
		count: 4,
		concurrency: 2,
		corpus: [
			"add a retry wrapper to the http client",
			"",
			"write a changelog entry for the release",
			"scaffold a new cli command",
		],
	},
	faults: [
		{
			stage: "fill",
			promptId: 2,
			effect: { kind: "error", status: 429, retryAfterSec: 1 },
			count: "forever",
		},
		{
			stage: "graph",
			promptId: 3,
			effect: { kind: "garbage", text: "not json at all" },
			count: "forever",
		},
	],
	pressure: { cpuWorkers: 0, duty: 0, memMB: 0 },
	config: {},
	invariants: [...INVARIANT_IDS],
};

let report: DriveReport;
let probe: PromptOutcome;
let baseline: ResourceSnapshot;
let stateRoot: string;
let historyPath: string;

beforeAll(async () => {
	stateRoot = makeTempDir("pipeline-oracle-", roots);
	historyPath = join(stateRoot, "history.jsonl");
	baseline = snapshotResources(stateRoot);
	const clock = createVirtualClock();
	const provider = createScriptedProvider(SCENARIO.faults, {
		sleep: clock.sleep,
		now: clock.now,
		seed: SCENARIO.seed,
	});
	const deps = { provider, sleep: clock.sleep, now: clock.now, stateRoot, ompPrompts: 1 };
	report = await runPrompts(SCENARIO, deps);
	provider.quiesce();
	probe = await runProbe(SCENARIO, deps);
});

function context(overrides: Partial<OracleContext> = {}): OracleContext {
	return { stateRoot, historyPath, baseline, probe, ...overrides };
}

function copy(): DriveReport {
	return structuredClone(report);
}

function only(results: ReturnType<typeof checkInvariants>, id: string) {
	const found = results.find((result) => result.id === id);
	if (found === undefined) throw new Error(`no result for ${id}`);
	return found;
}

/** Every invariant but `id` must still pass: each one fails in isolation. */
function expectOnlyFailing(results: ReturnType<typeof checkInvariants>, id: string): void {
	expect(results.filter((result) => !result.passed).map((result) => result.id)).toEqual([id]);
	expect(only(results, id).reason).toBeTruthy();
}

describe("a passing report", () => {
	test("all ten invariants hold for the tiny drive and the probe, in id order", () => {
		const results = checkInvariants(report, context());

		expect(results.map((result) => result.id)).toEqual([...INVARIANT_IDS]);
		for (const result of results) {
			expect(result.passed).toBe(true);
			expect(result.reason).toBeUndefined();
			expect(result.observed).toBeDefined();
		}
	});

	test("the recovery observation names the real-clock probe latency, the baseline, the ratio and the virtual figure", () => {
		const results = checkInvariants(report, context());

		expect(only(results, "recovery").observed).toBe(
			`probe latency real ${Math.round(probe.realMs)} ms baseline none ratio n/a (virtual ${probe.ms} ms)`,
		);
	});

	test("the terminal observation breaks the statuses down", () => {
		const results = checkInvariants(report, context({ expectedPlanned: 3 }));

		expect(only(results, "terminal").observed).toBe(
			"4/4 terminal: 3 planned, 1 skipped (by design), 0 aborted",
		);
	});

	test("a subset of invariants returns only those", () => {
		const results = checkInvariants(report, context({ invariants: ["terminal", "calls"] }));

		expect(results.map((result) => result.id)).toEqual(["terminal", "calls"]);
	});
});

describe("terminal", () => {
	test("an unknown skip reason, a planned prompt with no record, a stray error and a pending call each fail", () => {
		const unknown = copy();
		unknown.outcomes[1]!.terminal = "skipped:mystery";
		const missing = copy();
		delete missing.outcomes[0]!.record;
		const errored = copy();
		errored.outcomes[0]!.error = "TypeError: boom";
		const pending = copy();
		pending.calls[0]!.outcome = "pending";

		for (const broken of [unknown, missing, errored, pending]) {
			expectOnlyFailing(checkInvariants(broken, context()), "terminal");
		}
		expect(only(checkInvariants(unknown, context()), "terminal").reason).toContain("prompt 1");
	});

	test("a batch with fewer outcomes than expected fails", () => {
		const results = checkInvariants(report, context({ expectedPrompts: 5 }));

		expect(only(results, "terminal").passed).toBe(false);
		expect(only(results, "terminal").reason).toContain("5");
	});
});

describe("watchdog aborts", () => {
	/** Prompt 0 ends aborted by the watchdog; `hang` makes it the injected kind. */
	function abortedPrompt(hang: boolean): DriveReport {
		const broken = copy();
		const outcome = broken.outcomes[0]!;
		outcome.terminal = "aborted";
		delete outcome.record;
		outcome.degraded = [];
		outcome.calls = {};
		broken.calls = broken.calls.filter((call) => call.key !== outcome.nonce);
		if (hang) {
			broken.calls.push({
				seq: 9999,
				stage: "graph",
				key: outcome.nonce,
				index: 0,
				node: undefined,
				ordinal: 1,
				effect: "delay",
				chain: ["delay", "hang"],
				outcome: "aborted",
				status: undefined,
				startedAt: 0,
				endedAt: 1,
				foreign: [],
			});
		}
		return broken;
	}

	test("an abort with no injected hang fails terminal, naming the prompt and the watchdog budget", () => {
		const results = checkInvariants(abortedPrompt(false), context({ watchdogMs: 120000 }));

		const terminal = only(results, "terminal");
		expect(terminal.passed).toBe(false);
		expect(terminal.reason).toContain("prompt 0: aborted by the watchdog (budget 120000 ms)");
		expect(terminal.observed).toBe("3/4 terminal: 2 planned, 1 skipped (by design), 1 aborted");
	});

	test("an abort on a prompt an injected hang targeted (also behind a delay) passes and is counted", () => {
		const results = checkInvariants(abortedPrompt(true), context({ expectedPlanned: 3 }));

		expect(only(results, "terminal").passed).toBe(true);
		expect(only(results, "terminal").observed).toBe(
			"4/4 terminal: 2 planned, 1 skipped (by design), 1 aborted (1 allowed)",
		);
	});

	test("a scenario that allows aborts accepts any abort", () => {
		const results = checkInvariants(abortedPrompt(false), context({ allowAborts: true }));

		expect(only(results, "terminal").passed).toBe(true);
	});

	test("the per-prompt judge decides it too, so a compacted report keeps the finding", () => {
		const broken = abortedPrompt(false);
		const outcome = broken.outcomes[0]!;
		outcome.verdict = createJudge({ watchdogMs: 5000 })(
			outcome,
			broken.calls.filter((call) => call.key === outcome.nonce),
		);

		const results = checkInvariants(broken, context());

		expect(only(results, "terminal").reason).toContain("(budget 5000 ms)");
		expect(outcome.verdict.allowedAbort).toBe(false);
	});
});

describe("expected planned share", () => {
	test("fewer planned prompts than the corpus asks for is a finding, even with every status terminal", () => {
		const broken = copy();
		broken.outcomes[2]!.terminal = "skipped:empty";
		delete broken.outcomes[2]!.record;

		const results = checkInvariants(broken, context({ expectedPlanned: 3 }));

		const terminal = only(results, "terminal");
		expect(terminal.passed).toBe(false);
		expect(terminal.reason).toContain("2 planned, expected at least 3 (3 by the corpus");
		expect(terminal.observed).toBe("4/4 terminal: 2 planned, 2 skipped (by design), 0 aborted");
	});

	test("an abort by an injected hang lowers the expected share by one", () => {
		const aborted = copy();
		aborted.outcomes[2]!.terminal = "aborted";
		delete aborted.outcomes[2]!.record;
		aborted.calls.push({
			seq: 9998,
			stage: "fill",
			key: aborted.outcomes[2]!.nonce,
			index: 2,
			node: "n1",
			ordinal: 1,
			effect: "hang",
			chain: ["hang"],
			outcome: "aborted",
			status: undefined,
			startedAt: 0,
			endedAt: 1,
			foreign: [],
		});

		expect(only(checkInvariants(aborted, context({ expectedPlanned: 3 })), "terminal").passed).toBe(
			true,
		);
	});

	test("is not checked when the context gives none", () => {
		const broken = copy();
		broken.outcomes[2]!.terminal = "skipped:empty";
		delete broken.outcomes[2]!.record;

		expect(only(checkInvariants(broken, context()), "terminal").passed).toBe(true);
	});
});

describe("original", () => {
	test("a record whose original differs from the prompt fails and names the prompt", () => {
		const broken = copy();
		broken.outcomes[0]!.record!.result.original += " (paraphrased)";

		const results = checkInvariants(broken, context());

		expectOnlyFailing(results, "original");
		expect(only(results, "original").reason).toContain("prompt 0");
	});

	test("a spec whose ORIGINAL block lost the prompt fails", () => {
		const broken = copy();
		const record = broken.outcomes[0]!.record!;
		record.result.xml = record.result.xml.replace("retry wrapper", "something else");

		expectOnlyFailing(checkInvariants(broken, context()), "original");
	});
});

describe("uplift", () => {
	test("an llm result needs an allowed root and a fallback needs its reason and the degraded token", () => {
		const root = copy();
		root.outcomes[0]!.record!.result.root = "NOT_A_ROOT";
		const noReason = copy();
		noReason.outcomes[0]!.record!.result.source = "fallback";
		const noToken = copy();
		const fallback = noToken.outcomes[0]!.record!.result;
		fallback.source = "fallback";
		fallback.fallbackReason = "empty_reply";
		const noReasonResult = noReason.outcomes[0]!.record!.result;
		noReasonResult.fallbackReason = undefined;
		noReason.outcomes[0]!.record!.degraded = ["uplift"];
		noReason.outcomes[0]!.degraded = ["uplift"];

		for (const broken of [root, noReason, noToken]) {
			expect(only(checkInvariants(broken, context()), "uplift").passed).toBe(false);
		}
	});

	test("an llm result whose xml is not a complete uplift fails", () => {
		const broken = copy();
		broken.outcomes[0]!.record!.result.xml = "<BUILD_PROMPT><SCOPE>only</SCOPE></BUILD_PROMPT>";

		expect(only(checkInvariants(broken, context()), "uplift").passed).toBe(false);
	});
});

describe("degraded", () => {
	test("a failed fill missing from degraded fails, with the fill named", () => {
		const broken = copy();
		const outcome = broken.outcomes[2]!;
		const dropped = outcome.record!.degraded!.pop();
		outcome.degraded = outcome.record!.degraded!;

		const result = only(checkInvariants(broken, context()), "degraded");

		expect(dropped).toMatch(/^fill:/);
		expect(result.passed).toBe(false);
		expect(result.reason).toContain(String(dropped).slice("fill:".length));
	});

	test("a node whose conclusion is its own question and is not listed fails", () => {
		const broken = copy();
		const node = broken.outcomes[0]!.record!.graph!.nodes[0]!;
		node.conclusion = node.question;

		expect(only(checkInvariants(broken, context()), "degraded").passed).toBe(false);
	});

	test("a degraded plan whose context never says so fails", () => {
		const broken = copy();
		broken.outcomes[2]!.context = broken.outcomes[2]!.context.replaceAll(
			"Planning degraded",
			"All good",
		);

		expect(only(checkInvariants(broken, context()), "degraded").passed).toBe(false);
	});

	test("a degraded fill the notice does not name fails", () => {
		const broken = copy();
		const outcome = broken.outcomes[2]!;
		const token = outcome.degraded[0]!;
		outcome.context = outcome.context.replaceAll(
			`the ${token.slice("fill:".length)} fill`,
			"a part",
		);

		expect(only(checkInvariants(broken, context()), "degraded").passed).toBe(false);
	});
});

describe("cot", () => {
	test("a real fill with fewer than five steps fails", () => {
		const broken = copy();
		const node = broken.outcomes[0]!.record!.graph!.nodes[0]!;
		node.thinking = "1. only one step";

		const results = checkInvariants(broken, context());

		expectOnlyFailing(results, "cot");
		expect(only(results, "cot").reason).toContain("prompt 0");
	});

	test("a real fill with an empty conclusion fails", () => {
		const broken = copy();
		const node = broken.outcomes[0]!.record!.graph!.nodes[1]!;
		node.conclusion = "  ";
		// The empty conclusion is also a silent degradation, which the degraded invariant reports on its own.

		expect(only(checkInvariants(broken, context()), "cot").passed).toBe(false);
	});

	test("a graph with a forward dependency or too few nodes fails", () => {
		const forward = copy();
		forward.outcomes[0]!.record!.graph!.nodes[0]!.dependsOn = ["n3"];
		const small = copy();
		small.outcomes[0]!.record!.graph!.nodes.length = 4;

		expect(only(checkInvariants(forward, context()), "cot").passed).toBe(false);
		expect(only(checkInvariants(small, context()), "cot").passed).toBe(false);
	});

	test("the node bounds come from the context", () => {
		const results = checkInvariants(report, context({ minNodes: 9, maxNodes: 12 }));

		expect(only(results, "cot").passed).toBe(false);
	});
});

describe("isolation", () => {
	test("another prompt's nonce in the spec, the record, the rows, the context or a payload fails", () => {
		const spec = copy();
		spec.outcomes[0]!.specXml += "\n<!-- pl-7-000002 -->";
		const rec = copy();
		rec.outcomes[0]!.record!.result.xml += " pl-7-000003";
		const rows = copy();
		rows.outcomes[0]!.rows.push('{"leak":"pl-7-000002"}');
		const ctx = copy();
		ctx.outcomes[0]!.context += " pl-7-000001";
		const payload = copy();
		payload.calls[0]!.foreign = ["pl-7-000003"];

		for (const broken of [spec, rec, rows, ctx, payload]) {
			expect(only(checkInvariants(broken, context()), "isolation").passed).toBe(false);
		}
	});

	test("a prompt whose own nonce never reaches a fill conclusion fails", () => {
		const broken = copy();
		for (const node of broken.outcomes[0]!.record!.graph!.nodes) {
			node.conclusion = node.conclusion?.replace("pl-7-000000", "pl-x");
		}

		const results = checkInvariants(broken, context());

		expect(only(results, "isolation").passed).toBe(false);
		expect(only(checkInvariants(broken, context({ real: true })), "isolation").passed).toBe(true);
	});

	test("a clipped start of the prompt's own nonce is not a leak, a whole foreign nonce is", () => {
		const clipped = copy();
		clipped.outcomes[0]!.specXml += " pl-7-0000 pl-7- pl-7-00";
		const foreign = copy();
		foreign.outcomes[0]!.specXml += " pl-7-000001";
		const clippedForeign = copy();
		clippedForeign.outcomes[0]!.specXml += " pl-7-0001";

		expect(only(checkInvariants(clipped, context()), "isolation").passed).toBe(true);
		expect(only(checkInvariants(foreign, context()), "isolation").passed).toBe(false);
		expect(only(checkInvariants(clippedForeign, context()), "isolation").passed).toBe(false);
	});
});

describe("resources", () => {
	const at =
		(over: Partial<ResourceSnapshot> = {}) =>
		(): ResourceSnapshot => ({ ...baseline, ...over });
	const MIB = 1024 * 1024;

	test("a snapshot equal to the baseline passes", () => {
		expect(only(checkInvariants(report, context({ snapshot: at() })), "resources").passed).toBe(
			true,
		);
	});

	test("leftover state files, stale locks, bytes, handles, children and heap growth each fail", () => {
		const broken = [
			at({ files: baseline.files + 1 }),
			at({ stale: baseline.stale + 1 }),
			at({ bytes: baseline.bytes + 1 }),
			at({ handles: baseline.handles + 1000 }),
			at({ children: baseline.children + 1 }),
			at({ heapUsedBytes: baseline.heapUsedBytes + 100 * MIB }),
		];

		for (const snapshot of broken) {
			const results = checkInvariants(
				report,
				context({ snapshot, resourceSlackMiB: 10, handleSlack: 4 }),
			);
			expectOnlyFailing(results, "resources");
		}
	});

	test("RSS growth alone is reported but does not fail; heap growth inside the slack passes", () => {
		const results = checkInvariants(
			report,
			context({
				snapshot: at({
					rssBytes: baseline.rssBytes + 900 * MIB,
					heapUsedBytes: baseline.heapUsedBytes + 1000,
				}),
				resourceSlackMiB: 1,
			}),
		);

		expect(only(results, "resources").passed).toBe(true);
		expect(only(results, "resources").observed).toContain("rss +900 MiB");
	});

	test("the heap allowance grows with the prompt count: 64 KiB per prompt on top of the base", () => {
		const base = 1;
		const four = checkInvariants(
			report,
			context({
				snapshot: at({ heapUsedBytes: baseline.heapUsedBytes + base * MIB + 4 * 64 * 1024 }),
				resourceSlackMiB: base,
			}),
		);
		const over = checkInvariants(
			report,
			context({
				snapshot: at({ heapUsedBytes: baseline.heapUsedBytes + base * MIB + 4 * 64 * 1024 + 1 }),
				resourceSlackMiB: base,
			}),
		);

		expect(only(four, "resources").passed).toBe(true);
		expect(only(over, "resources").passed).toBe(false);
		expect(only(over, "resources").reason).toContain("heap grew");
	});

	test("a peak of in-flight calls above the cap fails", () => {
		const results = checkInvariants(report, context({ maxInflight: 0 }));

		expectOnlyFailing(results, "resources");
	});
});

describe("compacted outcomes", () => {
	test("a report judged per prompt and then stripped of its heavy fields gives the same verdicts", () => {
		const judge = createJudge({});
		const compact = copy();
		for (const outcome of compact.outcomes) {
			outcome.verdict = judge(
				outcome,
				compact.calls.filter((call) => call.key === outcome.nonce),
			);
			delete outcome.record;
			delete outcome.specXml;
			outcome.context = "";
			outcome.rows = [];
			outcome.expected = "";
		}

		const still = { snapshot: () => baseline };
		const before = checkInvariants(report, context(still));
		const after = checkInvariants(compact, context(still));

		expect(after).toEqual(before);
	});

	test("a verdict carries the findings of the heavy fields after they are dropped", () => {
		const judge = createJudge({});
		const broken = copy();
		broken.outcomes[0]!.record!.result.original += " (paraphrased)";
		const outcome = broken.outcomes[0]!;
		outcome.verdict = judge(outcome, []);
		delete outcome.record;

		const results = checkInvariants(broken, context());

		expect(only(results, "original").passed).toBe(false);
		expect(only(results, "original").reason).toContain("prompt 0");
	});
});

describe("recovery", () => {
	test("a degraded or fallback probe, or one that did not plan, fails", () => {
		const degraded: PromptOutcome = { ...structuredClone(probe), degraded: ["fill:n2"] };
		const fallback = structuredClone(probe);
		fallback.record!.result.source = "fallback";
		const skipped: PromptOutcome = { ...structuredClone(probe), terminal: "aborted" };

		for (const bad of [degraded, fallback, skipped]) {
			expectOnlyFailing(checkInvariants(report, context({ probe: bad })), "recovery");
		}
	});

	test("the real-clock latency decides: within 1.25x plus 250 ms passes, over it fails, and the virtual figure is only informational", () => {
		const real = (ms: number): PromptOutcome => ({ ...structuredClone(probe), ms: 0, realMs: ms });

		const within = checkInvariants(
			report,
			context({ probe: real(1000 * 1.25 + 250), baselineRealMs: 1000 }),
		);
		const over = checkInvariants(
			report,
			context({ probe: real(1000 * 1.25 + 251), baselineRealMs: 1000, baselineMs: 0 }),
		);
		const fastBaseline = checkInvariants(report, context({ probe: real(300), baselineRealMs: 40 }));

		expect(only(within, "recovery").passed).toBe(true);
		expect(only(over, "recovery").passed).toBe(false);
		expect(only(over, "recovery").reason).toContain("1501 ms of real time");
		expect(only(over, "recovery").reason).toContain("1.25x the 1000 ms baseline plus 250 ms");
		expect(only(within, "recovery").observed).toBe(
			"probe latency real 1500 ms baseline 1000 ms ratio 1.5 (virtual 0 ms)",
		);
		// 300 ms against a 40 ms baseline is inside 40 x 1.25 + 250: host noise, not a regression.
		expect(only(fastBaseline, "recovery").passed).toBe(true);
	});

	test("a virtual baseline of 0 does not fail a real probe when a real baseline exists", () => {
		const slowReal: PromptOutcome = { ...structuredClone(probe), ms: 0, realMs: 100 };

		const results = checkInvariants(
			report,
			context({ probe: slowReal, baselineRealMs: 90, baselineMs: 0 }),
		);

		expect(only(results, "recovery").passed).toBe(true);
	});

	test("the probe latency must stay within 1.25x the baseline", () => {
		const slow: PromptOutcome = { ...structuredClone(probe), ms: 126 };
		const edge: PromptOutcome = { ...structuredClone(probe), ms: 125 };

		const over = checkInvariants(report, context({ probe: slow, baselineMs: 100 }));
		const within = checkInvariants(report, context({ probe: edge, baselineMs: 100 }));

		expect(only(over, "recovery").passed).toBe(false);
		expect(only(over, "recovery").reason).toContain("1.25");
		expect(only(within, "recovery").passed).toBe(true);
	});
});

describe("persisted", () => {
	test("an unparsable state file, a stale temp file or a torn history line fails", () => {
		const bad = copy();
		bad.outcomes[0]!.state!.bad = ["sessions/s.json"];
		const stale = copy();
		stale.outcomes[0]!.state!.stale = ["sessions/.s.json.1.abcd1234.tmp"];

		expectOnlyFailing(checkInvariants(bad, context()), "persisted");
		expectOnlyFailing(checkInvariants(stale, context()), "persisted");

		const dir = makeTempDir("pipeline-oracle-history-", roots);
		mkdirSync(dir, { recursive: true });
		const torn = join(dir, "history.jsonl");
		writeFileSync(torn, '{"templateId":"x","score":1\n');
		const results = checkInvariants(report, context({ historyPath: torn }));

		expectOnlyFailing(results, "persisted");
		expect(only(results, "persisted").reason).toContain("history");
	});
});

describe("calls", () => {
	test("more fill calls than the retry budget allows fails", () => {
		const broken = copy();
		broken.outcomes[0]!.calls.fill = 1000;

		const results = checkInvariants(broken, context());

		expectOnlyFailing(results, "calls");
		expect(only(results, "calls").reason).toContain("fill");
	});

	test("the budget grows with the Omp native attempts and the configured fill retries", () => {
		const omp = copy();
		const outcome = omp.outcomes[2]!;
		const nodes = outcome.record!.graph!.nodes.length;
		outcome.path = "omp";
		outcome.calls.fill = nodes * 4 * 3;
		const tight = copy();
		tight.outcomes[2]!.calls.fill = nodes * 4 + 1;

		expect(only(checkInvariants(omp, context()), "calls").passed).toBe(true);
		expect(only(checkInvariants(tight, context()), "calls").passed).toBe(false);
		expect(only(checkInvariants(tight, context({ fillRetries: 5 })), "calls").passed).toBe(true);
	});

	test("an aborted prompt that started a call after its abort fails", () => {
		const broken = copy();
		const outcome = broken.outcomes[0]!;
		outcome.terminal = "aborted";
		const mine = broken.calls.filter((call) => call.key === outcome.nonce);
		mine[0]!.outcome = "aborted";
		mine[0]!.endedAt = 5;
		mine[1]!.startedAt = 9;

		const results = checkInvariants(broken, context());

		expect(only(results, "calls").passed).toBe(false);
		expect(only(results, "calls").reason).toContain("after abort");
	});
});

describe("snapshotResources", () => {
	test("counts only the leftover drive directories under the root", () => {
		const root = makeTempDir("pipeline-snapshot-", roots);
		mkdirSync(join(root, "drive-pl-1-000000-abc", "sessions"), { recursive: true });
		writeFileSync(join(root, "drive-pl-1-000000-abc", "sessions", "a.json"), "{}");
		writeFileSync(join(root, "drive-pl-1-000000-abc", "sessions", ".a.json.1.abcd1234.tmp"), "xx");
		writeFileSync(join(root, "unrelated.txt"), "ignored");

		const snapshot = snapshotResources(root);

		expect(snapshot.files).toBe(2);
		expect(snapshot.bytes).toBe(4);
		expect(snapshot.stale).toBe(1);
		expect(snapshot.rssBytes).toBeGreaterThan(0);
		expect(snapshot.handles).toBeGreaterThanOrEqual(0);
		expect(snapshotResources(join(root, "missing")).files).toBe(0);
	});
});
