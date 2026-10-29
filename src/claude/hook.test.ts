// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig, type UltrathinkConfig } from "../config.ts";
import type {
	DecisionAction,
	DecisionRecord,
	DecisionsConfig,
	DecisionsErrorKind,
} from "../decisions/types.ts";
import { openJevHealth } from "../decisions/health.ts";
import { GRAPH_ID_PATTERN } from "../gateway/types.ts";
import { decideUplift } from "../uplift/detect.ts";
import { JEV, recordingFetch, UPLIFT } from "../test.helpers.ts";
import type { Clarification } from "../hitl/types.ts";
import type { KnowledgeReader, KnowledgeResult } from "../greptile/knowledge.ts";
import type { RunClarifyOptions } from "../hitl/pipeline.ts";
import type { ModelResolution } from "../host/engine.ts";
import type { ProgressEvent } from "../host/progress.ts";
import { HANDOFF_MAX_CHARS } from "../host/display-limits.ts";
import { TRACKING_OFF_NOTE, UPLIFT_CONTEXT_HEADER } from "./output.ts";
import {
	runPromptSubmit,
	savePlanRecord,
	type HookDeps,
	type PromptSubmitInput,
	type PromptSubmitResult,
} from "./hook.ts";
import {
	armSkipOnce,
	readSession,
	readSkipOnce,
	type SessionRecord,
	sessionPath,
	updateSession,
	writeSession,
} from "./state.ts";
import type { TrackingRefs } from "../track/types.ts";
import type { BriefFailure, BriefResult, EmitInput } from "../substrate/brief.ts";
import { realmHint, type RealmProbe } from "../stack/realm.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import type {
	RecalledLesson,
	RecallOutcome,
	RecalledSkill,
	SkillRecallOutcome,
} from "../teach/types.ts";
import { graphJson } from "../test.helpers.ts";
import { FlightThrottle } from "../resilience/throttle.ts";
import { runThink, type RunThinkOptions } from "../think/pipeline.ts";
import type { ThoughtGraph } from "../think/types.ts";

function tempStateDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-hook-"));
	return {
		dir: join(dir, "ultrathink"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Dispatches by payload content so one fake handles uplift, graph, CoT, and clarify calls correctly. */
function smartComplete(): (system: string, user: string) => Promise<string> {
	return async (_system, user) => {
		if (user.includes("<user_request>")) return UPLIFT("add a widget");
		if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		return graphJson(5);
	};
}

/** Both trackers configured, as a user who set up Linear and Notion would have. */
function trackedConfig(): UltrathinkConfig {
	const config = defaultConfig();
	config.linear.team = "Team";
	config.notion.dataSourceUrl = "collection://ds";
	return config;
}

/** A brief that came back empty with no reason: the stub for tests that do not care about the Substrate. */
const NO_BRIEF: BriefResult = { text: "", state: "none" };

/** A usable brief carrying `text`, complete unless a test needs the degraded or snapshot label. */
function briefOf(
	text: string,
	state: "complete" | "degraded" | "snapshot" = "complete",
): BriefResult {
	return { text, state };
}

/** Timers the test fires by hand: each timeout the code arms is held here instead of on the real clock. */
type ManualTimers = {
	timers: NonNullable<HookDeps["timers"]>;
	/** Runs the oldest pending timer of `ms`, waiting until the code has armed one. */
	fire: (ms: number) => Promise<void>;
};

function manualTimers(): ManualTimers {
	const armed: Array<{ ms: number; run: () => void; handle: NodeJS.Timeout }> = [];
	const pending = new Set<NodeJS.Timeout>();
	const waiting: Array<() => void> = [];
	const timers: NonNullable<HookDeps["timers"]> = {
		setTimeout: (run, ms) => {
			// reason: the port's handle is opaque; the test tracks it by identity and never reads it
			const handle = {} as NodeJS.Timeout;
			armed.push({ ms, run, handle });
			pending.add(handle);
			for (const wake of waiting.splice(0)) wake();
			return handle;
		},
		clearTimeout: (handle) => {
			if (handle) pending.delete(handle);
		},
	};
	const fire = async (ms: number): Promise<void> => {
		const entry = armed.find((candidate) => pending.has(candidate.handle) && candidate.ms === ms);
		if (!entry) {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			await promise;
			return fire(ms);
		}
		pending.delete(entry.handle);
		entry.run();
	};
	return { timers, fire };
}

/** Controller-driven AbortSignal.timeout: each per-attempt budget the decisions client arms is a signal the test aborts. */
type ControlledTimeouts = { armed: AbortController[]; restore: () => void };

function controlledTimeouts(): ControlledTimeouts {
	const armed: AbortController[] = [];
	const spy = spyOn(AbortSignal, "timeout").mockImplementation(() => {
		const controller = new AbortController();
		armed.push(controller);
		return controller.signal;
	});
	return { armed, restore: () => spy.mockRestore() };
}

function baseDeps(overrides: Partial<HookDeps> = {}): { deps: HookDeps; cleanup: () => void } {
	const { dir, cleanup } = tempStateDir();
	const deps: HookDeps = {
		config: trackedConfig(),
		control: {},
		complete: async () => UPLIFT("add a widget"),
		engine: "claude:claude-haiku-5-5",
		stateDir: dir,
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => NO_BRIEF,
		// No test reaches the real Realm daemon: an absent Realm adds nothing to the plan.
		realmProbe: async () => ({ kind: "absent" }),
		emit: async () => true,
		now: () => 1_000,
		log: () => {
			// reason: test log sink; assertions read the emitted events, not this line
		},
		// Jev is always on, so tests that do not exercise the gate kill it: no ambient key, no network.
		decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
		...overrides,
	};
	return { deps, cleanup };
}

const input: PromptSubmitInput = { session_id: "s1", cwd: "/repo", prompt: "add a widget" };

describe("runPromptSubmit", () => {
	test("trivial prompt is skipped before any engine call", async () => {
		let called = false;
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				called = true;
				return "";
			},
		});
		try {
			const result = await runPromptSubmit({ ...input, prompt: "ok" }, deps);
			expect(result.skipped).toBe("skip");
			expect(called).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("a totally failing engine still produces output via the conservative XML fallback", async () => {
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				throw new Error("boom");
			},
			engineError: () => "boom",
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.result.source).toBe("fallback");
			// Fallback output must not pollute the shared Notion/Linear tracker with
			// generic FALLBACK_GRAPH boilerplate rows — the turn proceeds untracked.
			expect(result.record?.plan).toBeUndefined();
			// But the failure is recorded and loud: the record keeps the first engine error,
			// and the context says the spec is boilerplate instead of promising rows to come.
			expect(result.record?.engineError).toBe("boom");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Planning degraded");
			expect(ctx).toContain("No tracker rows were created for this plan, and none will be.");
			expect(result.output?.systemMessage).toContain("Engine error · boom");
		} finally {
			cleanup();
		}
	});

	test("a failover is persisted and summarized only when the engine reports one", async () => {
		const failover = "claude:claude-haiku-5-5 → grok:grok-4.7 (plan-limit)";
		const withFailover = baseDeps({ engineFailover: () => failover });
		try {
			const result = await runPromptSubmit(input, withFailover.deps);
			expect(result.record?.engineFailover).toBe(failover);
			expect(readSession(withFailover.deps.stateDir, "s1")?.engineFailover).toBe(failover);
			expect(result.output?.systemMessage).toContain(`Failover · ${failover}`);
		} finally {
			withFailover.cleanup();
		}
		const without = baseDeps({ engineFailover: () => undefined });
		try {
			const result = await runPromptSubmit(input, without.deps);
			expect(result.record).not.toHaveProperty("engineFailover");
			expect(readSession(without.deps.stateDir, "s1")).not.toHaveProperty("engineFailover");
			expect(result.output?.systemMessage).not.toContain("Failover");
		} finally {
			without.cleanup();
		}
	});

	test("reading a record drops a non-string engineFailover", async () => {
		const { deps, cleanup } = baseDeps();
		try {
			const result = await runPromptSubmit(input, deps);
			const record = result.record as SessionRecord;
			writeSession(deps.stateDir, {
				...record,
				engineFailover: 42 as unknown as string,
			});
			expect(readSession(deps.stateDir, "s1")).not.toHaveProperty("engineFailover");
		} finally {
			cleanup();
		}
	});

	test("a real spec with a failed fill records the stage and warns without discarding the plan", async () => {
		const flaky = smartComplete();
		const config = trackedConfig();
		config.think.fillRetries = 0;
		config.think.repair = false;
		const { deps, cleanup } = baseDeps({
			config,
			complete: async (system, user) => {
				if (user.includes('current_node id="n2"')) throw new Error("boom");
				return flaky(system, user);
			},
			engineError: () => "boom",
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.result.source).toBe("llm");
			expect(result.record?.plan).toBeDefined();
			expect(result.record?.degraded).toEqual(["fill:n2"]);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Planning degraded");
			expect(ctx).toContain("the n2 fill (boom) use fallback content");
			expect(ctx).toContain("Tracker rows are left for ultrathink-kickoff");
		} finally {
			cleanup();
		}
	});

	test("an engine that returns nothing warns without blaming a call that never threw", async () => {
		const { deps, cleanup } = baseDeps({ complete: async () => "" });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.result.source).toBe("fallback");
			expect(result.record?.engineError).toBeUndefined();
			expect(result.record?.degraded?.[0]).toBe("uplift");
			expect(result.record?.degraded).toContain("graph");
			// Uplift, graph, five fills, and the clarify step: an engine that answers nothing answers the clarifier nothing too.
			expect(result.record?.degraded).toHaveLength(8);
			expect(result.record?.degraded?.at(-1)).toBe("clarify");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Planning degraded");
			expect(ctx).toContain("no usable model output");
		} finally {
			cleanup();
		}
	});

	test("uplift + think + track: additionalContext carries the kickoff instruction, record carries the plan", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete() });
		try {
			const result = await runPromptSubmit(input, deps);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Graph of Thought");
			expect(ctx).toContain("## Ultrathink tracking");
			expect(ctx).toMatch(/invoke the ultrathink-kickoff skill with stateFile=.*s1\.json/);
			expect(result.output?.systemMessage).toContain("Tracking · ultrathink-kickoff pending");

			const plan = result.record?.plan;
			expect(plan?.task.repo).toBe("acme/widgets");
			expect(plan?.task.branch).toBe("feat/widget");
			expect(plan?.issues).toHaveLength(5);
			// 5 nodes × 5 rationale steps: one Sub-Issue (and Linear sub-issue) per step, not per node.
			expect(plan?.subIssues).toHaveLength(25);
			expect(plan?.linearSubIssues).toHaveLength(25);
			for (const id of ["n1", "n2", "n3", "n4", "n5"]) {
				expect(plan?.subIssues.filter((row) => row.nodeId === id).map((row) => row.step)).toEqual([
					1, 2, 3, 4, 5,
				]);
			}

			const persisted = readSession(deps.stateDir, "s1");
			expect(persisted?.plan?.graphId).toBe(plan?.graphId);
			expect(persisted?.kickedOff).toBe(false);
			expect(persisted?.synced).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("clarify failure is fail-open: no clarifications, everything else still proceeds", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => {
				throw new Error("clarify down");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.clarifications).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("previously answered clarifications carry over into the new record", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
		});
		try {
			const priorAnswer: Clarification = {
				id: "q1",
				question: "Which database?",
				header: "DB",
				why: "w",
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				default: "Postgres",
				blocking: true,
				answer: "Postgres",
				answeredAt: 1,
				source: "user",
			};
			writeSession(deps.stateDir, {
				sessionId: "s1",
				at: 0,
				result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
				clarifications: [priorAnswer],
			});
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.clarifications).toEqual([priorAnswer]);
		} finally {
			cleanup();
		}
	});

	test("a plan save interleaved with a locked answer update loses neither", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
		});
		try {
			const open: Clarification = {
				id: "q1",
				question: "Which database?",
				header: "DB",
				why: "w",
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				default: "Postgres",
				blocking: true,
			};
			const answered: Clarification = {
				...open,
				answer: "Postgres",
				answeredAt: 2,
				source: "user",
			};
			const seed: SessionRecord = {
				sessionId: "s1",
				at: 0,
				result: { xml: "<SPEC/>", original: "x", root: "SPEC", source: "llm" },
				clarifications: [open],
			};
			const planned = (record: SessionRecord): SessionRecord => ({
				...record,
				at: 1,
				result: {
					xml: "<SPEC><GOAL>add a widget</GOAL></SPEC>",
					original: "add a widget",
					root: "SPEC",
					source: "llm",
				},
			});
			// The planner read the session before the answer landed, then saves: the
			// late answer is overlaid onto the same question instead of being lost.
			writeSession(deps.stateDir, seed);
			const stale = readSession(deps.stateDir, "s1") ?? seed;
			updateSession(deps.stateDir, "s1", (current) => ({ ...current, clarifications: [answered] }));
			const saved = savePlanRecord(deps.stateDir, "s1", planned(stale));
			expect(saved.record.clarifications).toEqual([answered]);
			expect(saved.record.result.xml).toContain("add a widget");
			expect(saved.record.result.xml).toContain("<ANSWER");
			expect(saved.record.result.xml).toContain("Postgres");
			expect(readSession(deps.stateDir, "s1")).toEqual(saved.record);
			expect(readFileSync(saved.specPath, "utf8")).toBe(`${saved.record.result.xml}\n`);
			expect(existsSync(`${saved.statePath}.lock`)).toBe(false);
			// The plan lands first, then the locked answer update: nothing is lost either.
			writeSession(deps.stateDir, seed);
			const planFirst = savePlanRecord(
				deps.stateDir,
				"s1",
				planned({ ...seed, clarifications: [open] }),
			);
			expect(planFirst.record.clarifications).toEqual([open]);
			updateSession(deps.stateDir, "s1", (current) => ({ ...current, clarifications: [answered] }));
			expect(readSession(deps.stateDir, "s1")?.clarifications).toEqual([answered]);
			expect(readSession(deps.stateDir, "s1")?.result.xml).toContain("add a widget");
		} finally {
			cleanup();
		}
	});

	test("late answers merged at save reach the agent-visible context and summary", async () => {
		const open: Clarification = {
			id: "q1",
			question: "Which database?",
			header: "DB",
			why: "w",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
			default: "Postgres",
			blocking: true,
		};
		const answered: Clarification = { ...open, answer: "Postgres", answeredAt: 2, source: "user" };
		// The answer lands on disk after the flight's stale read (via the
		// tracker call, which runs before the save) so the save merges it.
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [open] }),
		});
		const stateDir = deps.stateDir;
		deps.track = async () => {
			writeSession(stateDir, {
				sessionId: "s1",
				at: 0,
				result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
				clarifications: [answered],
			});
			return undefined;
		};
		try {
			const result = await runPromptSubmit(input, deps);
			// The merged record always had the answer; the regression was that
			// the agent-visible output still showed the stale open question.
			expect(result.record?.clarifications).toEqual([answered]);
			expect(result.record?.result.xml).toContain("Postgres");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("### Answered");
			expect(ctx).toContain("→ Postgres");
			expect(ctx).not.toContain("### Open (blocking)");
			expect(result.output?.systemMessage).toContain("HITL · 0 question(s)");
		} finally {
			cleanup();
		}
	});

	test("echo disabled: no systemMessage, additionalContext still returned", async () => {
		const base = defaultConfig();
		const { deps, cleanup } = baseDeps({
			config: { ...base, claude: { ...base.claude, echo: false } },
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.systemMessage).toBeUndefined();
			expect(result.output?.hookSpecificOutput.additionalContext).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test("no git remote detected: repo/branch stay undefined, tracking still proceeds", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), git: () => ({}) });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.plan?.task.repo).toBeUndefined();
			expect(result.record?.plan?.task.branch).toBeUndefined();
			expect(result.record?.plan?.issues).toHaveLength(5);
		} finally {
			cleanup();
		}
	});

	test("a busy last.json lock keeps the Hermes handoff and reports the missed copy", async () => {
		const { deps, cleanup } = baseDeps({ surface: "hermes", complete: smartComplete() });
		try {
			mkdirSync(deps.stateDir, { recursive: true });
			writeFileSync(`${join(deps.stateDir, "last.json")}.lock`, String(process.pid));
			const saved =
				(await runPromptSubmit(input, deps)).output?.hookSpecificOutput.additionalContext ?? "";
			const spec = join(deps.stateDir, "sessions", "s1.xml");
			expect(saved).toContain(`Specification file: ${spec}`);
			expect(saved).toContain(`State file: ${join(deps.stateDir, "sessions", "s1.json")}`);
			expect(saved).toContain("could not refresh");
			expect(saved).toContain("ultrathink-kickoff");
			expect(existsSync(spec)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("Hermes gets a handoff to the saved spec, or the inline spec when the spec file could not be written", async () => {
		const { deps, cleanup } = baseDeps({ surface: "hermes", complete: smartComplete() });
		try {
			const saved =
				(await runPromptSubmit(input, deps)).output?.hookSpecificOutput.additionalContext ?? "";
			expect(saved).toContain(`Specification file: ${join(deps.stateDir, "sessions", "s1.xml")}`);
			expect(saved).not.toContain("<BUILD_PROMPT>");
			// A file where the state directory should be makes every state write fail.
			rmSync(deps.stateDir, { recursive: true, force: true });
			writeFileSync(deps.stateDir, "not a directory");
			const unsaved =
				(await runPromptSubmit(input, deps)).output?.hookSpecificOutput.additionalContext ?? "";
			expect(unsaved).toContain("<BUILD_PROMPT>");
			expect(unsaved).not.toContain("Specification file:");
		} finally {
			cleanup();
		}
	});
});

describe("gateway tracking", () => {
	const trackCmd = "/opt/ultrathink/bin/ultrathink-mcp track complete";
	const url = "https://linear.app/acme/issue/ENG-12/understand";

	test("tracker refs land in the context, the spec file, and the session record", async () => {
		let seenSignal: AbortSignal | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			trackCommand: trackCmd,
			track: async ({ plan, signal }) => {
				seenSignal = signal;
				const refs: TrackingRefs = {
					graphId: plan.graphId,
					status: "partial",
					linearTeam: "Team",
					linear: {
						nodes: { n1: { id: "uuid-1", identifier: "ENG-12", url, title: "T1" } },
						steps: {},
					},
					notion: { nodes: {}, steps: {} },
					errors: ["notion: login required"],
					updatedAt: 1_000,
				};
				return refs;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(seenSignal).toBeInstanceOf(AbortSignal);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Linked issues");
			expect(ctx).toContain("ENG-12");
			expect(ctx).toContain(url);
			const spec = readFileSync(join(deps.stateDir, "sessions", "s1.xml"), "utf8");
			expect(spec).toContain("<ISSUES");
			expect(spec).toContain('identifier="ENG-12"');
			const persisted = readSession(deps.stateDir, "s1");
			expect(persisted?.tracking?.status).toBe("partial");
			expect(persisted?.tracking?.linear.nodes.n1?.identifier).toBe("ENG-12");
		} finally {
			cleanup();
		}
	});

	test("a throwing tracker never blocks the prompt; kickoff is told to run the track command", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			trackCommand: trackCmd,
			track: async () => {
				throw new Error("gateway down");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Graph of Thought");
			expect(ctx).not.toContain("## Linked issues");
			expect(ctx).toContain(trackCmd);
			expect(result.record?.plan).toBeDefined();
			expect(result.record?.tracking).toBeUndefined();
			const spec = readFileSync(join(deps.stateDir, "sessions", "s1.xml"), "utf8");
			expect(spec).not.toContain("<ISSUES");
		} finally {
			cleanup();
		}
	});

	test("tracking off: no tracker call, no kickoff or Linked issues, one note, plan still recorded", async () => {
		let called = false;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			trackCommand: trackCmd,
			trackingOff: true,
			track: async () => {
				called = true;
				return undefined;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(called).toBe(false);
			expect(ctx).toContain("## Graph of Thought");
			expect(ctx).not.toContain("## Ultrathink tracking");
			expect(ctx).not.toContain("ultrathink-kickoff");
			expect(ctx).not.toContain("## Linked issues");
			expect(ctx).not.toContain(trackCmd);
			expect(ctx).toContain(TRACKING_OFF_NOTE);
			expect(result.output?.systemMessage).toContain("Tracking · off");
			expect(result.output?.systemMessage).not.toContain("kickoff");
			expect(result.record?.plan?.issues).toHaveLength(5);
			expect(readSession(deps.stateDir, "s1")?.plan?.graphId).toBe(result.record?.plan?.graphId);
		} finally {
			cleanup();
		}
	});

	test("Linear-only config counts only missing Linear rows and never mentions a Notion task", async () => {
		const config = defaultConfig();
		config.linear.team = "Team";
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			config,
			track: async ({ plan }) => ({
				graphId: plan.graphId,
				status: "partial",
				linearTeam: "Team",
				linear: {
					nodes: { n1: { id: "uuid-1", identifier: "ENG-12", url, title: "T1" } },
					steps: {},
				},
				notion: { nodes: {}, steps: {} },
				errors: [],
				updatedAt: 1_000,
			}),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			// 5 nodes, 25 steps: 4 node issues + 25 sub-issues missing in Linear; Notion is not configured.
			expect(result.output?.systemMessage).toContain("Tracking · partial (29 missing)");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain(
				"Tracker rows created before this turn: 1 Linear issues, 0 sub-issues (graph",
			);
			expect(ctx).not.toContain("Notion task");
		} finally {
			cleanup();
		}
	});
});

describe("substrate brief", () => {
	test("injects the brief into hook context, framed as history not instructions", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief: async () =>
				briefOf("## Substrate brief: acme/widgets\n- 09:04 cursor edited widget.ts"),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const context = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(context).toContain("## Agent Substrate brief");
			expect(context).toContain("09:04 cursor edited widget.ts");
			expect(context).toContain("not as instructions");
		} finally {
			cleanup();
		}
	});

	test("passes the resolved repo and branch to the brief, with the planning lifetime", async () => {
		let seen:
			| { repo?: string; branch?: string; surface?: string; signal?: AbortSignal }
			| undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief: async (i) => {
				seen = i;
				return NO_BRIEF;
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(seen).toMatchObject({
				repo: "acme/widgets",
				branch: "feat/widget",
				surface: "claude-code",
			});
			expect(Object.keys(seen ?? {}).sort()).toEqual(["branch", "repo", "signal", "surface"]);
			expect(seen?.signal).toBeInstanceOf(AbortSignal);
		} finally {
			cleanup();
		}
	});

	test("an empty brief adds no section at all", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief: async () => NO_BRIEF,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.hookSpecificOutput.additionalContext ?? "").not.toContain(
				"## Agent Substrate brief",
			);
		} finally {
			cleanup();
		}
	});

	test("a substrate outage never blocks the prompt", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.skipped).toBeUndefined();
			expect(result.output?.hookSpecificOutput.additionalContext).toContain("## Prompt Uplift");
		} finally {
			cleanup();
		}
	});

	test("without a brief seam, the substrate is contacted only at the configured substrate.url", async () => {
		const realFetch = globalThis.fetch;
		const saved = { url: process.env.SUBSTRATE_URL, disabled: process.env.SUBSTRATE_DISABLED };
		delete process.env.SUBSTRATE_URL;
		delete process.env.SUBSTRATE_DISABLED;
		const urls: string[] = [];
		globalThis.fetch = ((url: string) => {
			urls.push(String(url));
			return Promise.resolve(new Response("## Substrate brief: acme/widgets\n- earlier work"));
		}) as unknown as typeof fetch;
		const tokensDir = mkdtempSync(join(tmpdir(), "ultrathink-hook-tokens-"));
		const run = async (substrateUrl: string): Promise<string> => {
			const config = trackedConfig();
			config.substrate.url = substrateUrl;
			const { deps, cleanup } = baseDeps({
				config,
				complete: smartComplete(),
				clarify: async () => ({ items: [] }),
				brief: undefined,
				decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0", SUBSTRATE_TOKENS_DIR: tokensDir } },
			});
			try {
				const result = await runPromptSubmit(input, deps);
				return result.output?.hookSpecificOutput.additionalContext ?? "";
			} finally {
				cleanup();
			}
		};
		try {
			expect(await run("")).not.toContain("## Agent Substrate brief");
			expect(urls).toEqual([]);
			expect(await run("https://substrate.test")).toContain("## Agent Substrate brief");
			expect(urls).toEqual(["https://substrate.test/brief"]);
		} finally {
			globalThis.fetch = realFetch;
			rmSync(tokensDir, { recursive: true, force: true });
			if (saved.url === undefined) delete process.env.SUBSTRATE_URL;
			else process.env.SUBSTRATE_URL = saved.url;
			if (saved.disabled === undefined) delete process.env.SUBSTRATE_DISABLED;
			else process.env.SUBSTRATE_DISABLED = saved.disabled;
		}
	});

	/** Both ways a prompt can reach the substrate segment: the summary line and the context block. */
	async function plan(
		brief: NonNullable<HookDeps["brief"]>,
		overrides: Partial<HookDeps> = {},
	): Promise<{ summary: string; context: string; logs: string[] }> {
		const logs: string[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief,
			log: (message) => {
				logs.push(message);
			},
			...overrides,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			return {
				summary: result.output?.systemMessage ?? "",
				context: result.output?.hookSpecificOutput.additionalContext ?? "",
				logs,
			};
		} finally {
			cleanup();
		}
	}

	test("a configured substrate that returned nothing shows one secret-free segment per reason, in the summary only", async () => {
		const cases: Array<[BriefFailure, string]> = [
			["unauthorized", "unauthorized"],
			["surface-mismatch", "surface mismatch, retry skipped"],
			["bad-request", "bad request"],
			["timeout", "timed out"],
			["unreachable", "unreachable"],
			["http-503", "http-503"],
			["redirect refused", "redirect refused"],
			["url refused: userinfo not allowed", "url refused"],
		];
		for (const [reason, phrase] of cases) {
			const { summary, context } = await plan(async () => ({ text: "", state: "none", reason }));
			const segment = `Substrate · brief unavailable (${phrase})`;
			expect(summary.split(segment)).toHaveLength(2);
			expect(summary).not.toContain("Substrate · brief 0");
			expect(context).not.toContain("brief unavailable");
		}
	});

	test("no segment for a usable brief, an empty answer without a reason, a substrate that is off, or a hidden summary", async () => {
		const silent: BriefResult[] = [
			briefOf("## Substrate brief: acme/widgets\n- earlier work"),
			briefOf(
				"(Substrate brief is degraded; some sources failed or the copy is a snapshot)\n\n## Substrate brief",
				"degraded",
			),
			briefOf(
				"(Substrate brief is snapshot; some sources failed or the copy is a snapshot)\n\n## Substrate brief",
				"snapshot",
			),
			{ text: "", state: "complete" },
			NO_BRIEF,
			{ text: "", state: "none", reason: "disabled" },
			{ text: "", state: "none", reason: "no-url" },
		];
		for (const result of silent) {
			const { summary } = await plan(async () => result);
			expect(summary).not.toContain("brief unavailable");
		}
		const config = trackedConfig();
		config.claude.echo = false;
		const hidden = await plan(async () => ({ text: "", state: "none", reason: "timeout" }), {
			config,
		});
		expect(hidden.summary).toBe("");
	});

	test("a rejected brief seam reads as no brief with no segment", async () => {
		const { summary, context } = await plan(async () => {
			throw new Error("ECONNREFUSED");
		});
		expect(summary).not.toContain("brief unavailable");
		expect(context).not.toContain("## Agent Substrate brief");
	});

	test("the segment carries the closed reason phrase only: no detail, token or URL reaches the summary or the log", async () => {
		const canary = "sk-or-v1-CANARYCANARYCANARY1234";
		const { summary, context, logs } = await plan(async () => ({
			text: "",
			state: "none",
			reason: "unauthorized",
			detail: `Bearer ${canary} https://substrate.internal.test`,
		}));
		expect(summary).toContain("Substrate · brief unavailable (unauthorized)");
		for (const text of [summary, context, ...logs]) {
			expect(text).not.toContain(canary);
			expect(text).not.toContain("substrate.internal.test");
		}
	});

	test("a degraded brief reaches the context with its label line and adds no segment", async () => {
		const label = "(Substrate brief is degraded; some sources failed or the copy is a snapshot)";
		const { summary, context } = await plan(async () =>
			briefOf(`${label}\n\n## Substrate brief: acme/widgets\n- earlier work`, "degraded"),
		);
		expect(context).toContain("## Agent Substrate brief");
		expect(context).toContain(label);
		expect(context).toContain("- earlier work");
		expect(summary).toContain("Substrate · brief 4 lines");
		expect(summary).not.toContain("brief unavailable");
	});

	test("the brief is redacted at the single point before the context and the summary: a degraded label survives, secrets do not", async () => {
		const label = "(Substrate brief is degraded; some sources failed or the copy is a snapshot)";
		const text = [
			label,
			"",
			"## Substrate brief: acme/widgets",
			"- cursor used sk-or-v1_CANARYCANARYCANARY1234 on the gateway",
			"- vercel key vck_CANARYCANARYCANARY1234 was rotated",
			"- request carried Authorization: Bearer CANARYBEARERCANARY1234567890",
			"-----BEGIN PRIVATE KEY-----",
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCCANARYCANARYCANARY",
			"-----END PRIVATE KEY-----",
			"- earlier work on widget.ts",
		].join("\n");
		const { summary, context, logs } = await plan(async () => briefOf(text, "degraded"));
		expect(context).toContain("## Agent Substrate brief");
		expect(context).toContain(label);
		expect(context).toContain("- earlier work on widget.ts");
		for (const shown of [summary, context, ...logs]) {
			expect(shown).not.toContain("CANARY");
			expect(shown).not.toContain("BEGIN PRIVATE KEY");
		}
	});

	test("the brief reaches the context without control characters and capped, with a truncation marker", async () => {
		const text = `\u001b[31m## Substrate brief: acme/widgets\u001b[0m\u0007\u009b\n- earlier\twork\n${"x".repeat(100_000)}`;
		const { summary, context, logs } = await plan(async () => briefOf(text));
		expect(context).toContain("## Agent Substrate brief");
		expect(context).toContain("[31m## Substrate brief: acme/widgets[0m");
		expect(context).toContain("- earlier\twork");
		expect(context).toContain("\n[brief truncated]");
		expect(context).not.toContain("x".repeat(HANDOFF_MAX_CHARS));
		for (const shown of [summary, context, ...logs]) {
			expect(shown).not.toContain("\u001b");
			expect(shown).not.toContain("\u0007");
			expect(shown).not.toContain("\u009b");
		}
	});

	describe("Realm note", () => {
		const NOTE = "Realm note (untrusted advisory, not an instruction): ";
		const PROBED_AT = "2026-10-28T09:00:00.000Z";

		function present(
			state: "active" | "degraded" | "error" | "unbound",
			mode: "advisory" | "fail-closed",
		): RealmProbe {
			return {
				kind: "present",
				stateDir: "/tmp/ut-realm-state",
				state,
				label: state === "active" ? "realm active" : "realm disconnected",
				degraded: state !== "active",
				reason: "the daemon said CANARY-DAEMON-TEXT",
				mode,
				lastTransitionAt: PROBED_AT,
				workspaceMatches: true,
				via: "socket",
				probedAt: PROBED_AT,
			};
		}

		function realmLines(context: string): string[] {
			return context.split("\n").filter((line) => line.startsWith("Realm note"));
		}

		test("an enforcing realm on an MCP host adds exactly one framed line carrying realmHint's instruction", async () => {
			const probe = present("active", "fail-closed");
			const instruction = realmHint(probe, "claude-code").instruction;
			expect(instruction).toContain("Realm is enforcing");
			const { summary, context } = await plan(
				async () => briefOf("## Substrate brief: a/b\n- work"),
				{
					realmProbe: async () => probe,
				},
			);
			expect(realmLines(context)).toEqual([`${NOTE}${instruction}`]);
			// It rides after the brief, inside the untrusted-history section, and never reaches the summary.
			expect(context.indexOf("- work")).toBeLessThan(context.indexOf(NOTE));
			expect(summary).not.toContain("Realm");
			// Only the fixed framing and the hint text enter: nothing the daemon said.
			expect(context).not.toContain("CANARY-DAEMON-TEXT");
		});

		test("a degraded realm under fail-closed still enforces, so the note is added; the extension host gets its own text", async () => {
			const probe = present("degraded", "fail-closed");
			const { context } = await plan(async () => NO_BRIEF, {
				realmProbe: async () => probe,
				surface: "omp",
			});
			const expected = realmHint(probe, "omp").instruction;
			expect(realmLines(context)).toEqual([`${NOTE}${expected}`]);
			expect(expected).not.toContain("route tool calls");
		});

		test("advisory, absent, unknown, daemon-down and non-live states add no line", async () => {
			const silent: RealmProbe[] = [
				present("active", "advisory"),
				present("degraded", "advisory"),
				present("error", "fail-closed"),
				present("unbound", "fail-closed"),
				{ kind: "absent" },
				{ kind: "unknown", why: "timeout" },
				{ kind: "daemon-down", stateDir: "/tmp/ut-realm-state" },
			];
			for (const probe of silent) {
				const { context } = await plan(async () => briefOf("## Substrate brief: a/b\n- work"), {
					realmProbe: async () => probe,
				});
				expect(context).not.toContain("Realm note");
				expect(context).not.toContain("Realm is");
			}
		});

		test("a host Realm cannot reach adds no line even when enforcing", async () => {
			const { context } = await plan(async () => NO_BRIEF, {
				realmProbe: async () => present("active", "fail-closed"),
				surface: "cursor",
			});
			expect(context).not.toContain("Realm note");
		});

		test("the Realm note survives a brief that hit the length cap: it is appended after sanitising, never cut", async () => {
			const probe = present("active", "fail-closed");
			const instruction = realmHint(probe, "claude-code").instruction;
			const { context } = await plan(
				async () => briefOf(`## Substrate brief: a/b\n${"- work\n".repeat(20_000)}`),
				{ realmProbe: async () => probe },
			);
			expect(context).toContain("[brief truncated]");
			expect(realmLines(context)).toEqual([`${NOTE}${instruction}`]);
		});

		test("an unknown surface id falls back to the Claude host class", async () => {
			const probe = present("active", "fail-closed");
			const { context } = await plan(async () => NO_BRIEF, {
				realmProbe: async () => probe,
				surface: "some-new-host",
			});
			expect(realmLines(context)).toEqual([
				`${NOTE}${realmHint(probe, "claude-code").instruction}`,
			]);
		});

		test("a rejecting or throwing seam still plans, with no note", async () => {
			const rejecting = await plan(async () => briefOf("## Substrate brief: a/b\n- work"), {
				realmProbe: async () => {
					throw new Error("socket exploded CANARY");
				},
			});
			expect(rejecting.context).toContain("- work");
			expect(rejecting.context).not.toContain("Realm note");
			expect(rejecting.context).not.toContain("CANARY");
			const synchronous = await plan(async () => NO_BRIEF, {
				realmProbe: () => {
					throw new Error("sync failure");
				},
			});
			expect(synchronous.context).toContain("<BUILD_PROMPT>");
		});

		test("the probe runs once per plan, with a 1000 ms budget, the plan's cwd and the injected env", async () => {
			const calls: Array<{
				env: Record<string, string | undefined>;
				timeoutMs: number;
				cwd: string;
			}> = [];
			const env = { ULTRATHINK_DECISIONS: "0", ULTRATHINK_REALM: "probe-me" };
			await plan(async () => NO_BRIEF, {
				decisionsDeps: { env },
				realmProbe: async (probeEnv, opts) => {
					calls.push({ env: probeEnv, ...opts });
					return { kind: "absent" };
				},
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.timeoutMs).toBe(1000);
			expect(calls[0]?.cwd).toBe("/repo");
			expect(calls[0]?.env).toBe(env);
		});

		test("the probe starts before the brief settles: a slow brief does not delay the probe", async () => {
			const order: string[] = [];
			const brief = Promise.withResolvers<BriefResult>();
			const planned = plan(
				() => {
					order.push("brief-start");
					return brief.promise;
				},
				{
					realmProbe: async () => {
						order.push("realm-start");
						brief.resolve(NO_BRIEF);
						return { kind: "absent" };
					},
				},
			);
			await planned;
			expect(order).toEqual(["brief-start", "realm-start"]);
		});
	});

	test("the default brief seam reads the injected env, the same one the plan event uses, not process.env", async () => {
		const realFetch = globalThis.fetch;
		const saved = {
			url: process.env.SUBSTRATE_URL,
			token: process.env.SUBSTRATE_TOKEN,
			disabled: process.env.SUBSTRATE_DISABLED,
		};
		process.env.SUBSTRATE_URL = "https://process.test";
		process.env.SUBSTRATE_TOKEN = "sk-or-v1-PROCESSCANARYCANARY1234";
		delete process.env.SUBSTRATE_DISABLED;
		const tokensDir = mkdtempSync(join(tmpdir(), "ultrathink-hook-tokens-"));
		const calls: Array<{ url: string; authorization: string | undefined }> = [];
		globalThis.fetch = ((url: string, init?: RequestInit) => {
			calls.push({
				url: String(url),
				authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
			});
			return Promise.resolve(new Response("## Substrate brief: acme/widgets\n- earlier work"));
		}) as unknown as typeof fetch;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief: undefined,
			decisionsDeps: {
				env: {
					ULTRATHINK_DECISIONS: "0",
					SUBSTRATE_URL: "https://injected.test",
					SUBSTRATE_TOKEN: "sk-or-v1-INJECTEDCANARYCANARY1234",
					SUBSTRATE_TOKENS_DIR: tokensDir,
				},
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.hookSpecificOutput.additionalContext).toContain(
				"## Agent Substrate brief",
			);
			expect(calls.map((call) => call.url)).toEqual(["https://injected.test/brief"]);
			expect(calls[0]?.authorization).toBe("Bearer sk-or-v1-INJECTEDCANARYCANARY1234");
		} finally {
			cleanup();
			rmSync(tokensDir, { recursive: true, force: true });
			globalThis.fetch = realFetch;
			if (saved.url === undefined) delete process.env.SUBSTRATE_URL;
			else process.env.SUBSTRATE_URL = saved.url;
			if (saved.token === undefined) delete process.env.SUBSTRATE_TOKEN;
			else process.env.SUBSTRATE_TOKEN = saved.token;
			if (saved.disabled === undefined) delete process.env.SUBSTRATE_DISABLED;
			else process.env.SUBSTRATE_DISABLED = saved.disabled;
		}
	});
});

describe("substrate plan event", () => {
	/** A seam that records every event it is given and says the substrate took it. */
	function recorder(): { emit: NonNullable<HookDeps["emit"]>; sent: EmitInput[] } {
		const sent: EmitInput[] = [];
		return {
			sent,
			emit: async (event) => {
				sent.push(event);
				return true;
			},
		};
	}

	test("a planned prompt emits one note with the Graph ID, after the session record is on disk", async () => {
		const sent: EmitInput[] = [];
		const onDisk: Array<string | undefined> = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
		});
		deps.emit = async (event) => {
			sent.push(event);
			onDisk.push(readSession(deps.stateDir, "s1")?.plan?.graphId);
			return true;
		};
		try {
			const result = await runPromptSubmit(input, deps);
			const graphId = result.record?.plan?.graphId ?? "missing graph id";
			expect(graphId).toMatch(GRAPH_ID_PATTERN);
			expect(
				decideUplift(
					{ text: `execute graph ${graphId}`, source: "user" },
					{ enabled: true, skipOnce: false, skipTrivial: true },
				),
			).toEqual({ action: "skip", reason: "graph-reference" });
			expect(sent).toEqual([
				{
					kind: "note",
					summary: `ultrathink planned graph ${graphId} (5 nodes)`,
					surface: "claude-code",
					sessionId: `s1:${graphId}`,
					graphId,
					repo: "acme/widgets",
					branch: "feat/widget",
					payload: { ultrathink: "plan", nodes: 5, host: "claude-code" },
				},
			]);
			expect(onDisk).toEqual([graphId]);
		} finally {
			cleanup();
		}
	});

	test("two different prompts planned in one host session emit notes on different session ids, each ending in its own graph id", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
		});
		try {
			const first = await runPromptSubmit(input, deps);
			const second = await runPromptSubmit({ ...input, prompt: "add a gadget" }, deps);
			const g1 = first.record?.plan?.graphId ?? "missing graph id 1";
			const g2 = second.record?.plan?.graphId ?? "missing graph id 2";
			expect(g1).not.toBe(g2);
			expect(sent).toHaveLength(2);
			expect(sent[0]?.sessionId).not.toBe(sent[1]?.sessionId);
			expect(sent[0]?.sessionId?.endsWith(`:${g1}`)).toBe(true);
			expect(sent[1]?.sessionId?.endsWith(`:${g2}`)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("a cursor host asks the substrate brief and the plan event for surface cursor", async () => {
		const { emit, sent } = recorder();
		let briefSurface: string | undefined;
		const { deps, cleanup } = baseDeps({
			surface: "cursor",
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
			brief: async (brief) => {
				briefSurface = brief.surface;
				return NO_BRIEF;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(briefSurface).toBe("cursor");
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ surface: "cursor", payload: { host: "cursor" } });
			expect(result.record?.host).toBe("cursor");
		} finally {
			cleanup();
		}
	});

	test("a skill run on another host names that host and the skill, and nothing of what was asked", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			surface: "hermes",
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
		});
		try {
			const result = await runPromptSubmit(
				{
					...input,
					prompt: "fix the login redirect",
					skill: {
						name: "gsd-quick",
						instruction: "fix the login redirect",
						summary: "Fast atomic task.",
						source: "omp",
					},
				},
				deps,
			);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({
				surface: "hermes",
				payload: { ultrathink: "plan", nodes: 5, host: "hermes", skill: "gsd-quick" },
			});
			const wire = JSON.stringify(sent);
			expect(wire).toContain(result.record?.plan?.graphId ?? "missing graph id");
			expect(wire).not.toContain("login redirect");
			expect(wire).not.toContain("Fast atomic task");
		} finally {
			cleanup();
		}
	});

	test("a prompt that is not planned emits nothing: trivial, raw, planning off, and a Jev skip", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
		});
		try {
			expect((await runPromptSubmit({ ...input, prompt: "ok" }, deps)).skipped).toBe("skip");
			expect((await runPromptSubmit({ ...input, prompt: "raw: add a widget" }, deps)).skipped).toBe(
				"passthrough",
			);
			expect((await runPromptSubmit(input, { ...deps, control: { enabled: false } })).skipped).toBe(
				"skip",
			);
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}

		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, { emit });
		try {
			const result = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(result.skipped).toBe("jev-skip");
			expect(sent).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
			h.cleanup();
		}
	});

	test("a failed engine leaves no plan and no Graph ID, so nothing is emitted", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				throw new Error("boom");
			},
			emit,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.plan).toBeUndefined();
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a session record that could not be written is not announced", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
		});
		try {
			// A file where the state directory should be makes every state write fail.
			rmSync(deps.stateDir, { recursive: true, force: true });
			writeFileSync(deps.stateDir, "not a directory");
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.plan?.graphId).toBeDefined();
			expect(existsSync(sessionPath(deps.stateDir, "s1"))).toBe(false);
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a prompt with no session id is planned but not announced", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
		});
		try {
			for (const session_id of [undefined, "  "]) {
				const result = await runPromptSubmit({ ...input, session_id }, deps);
				expect(result.record?.sessionId).toStartWith("turn-");
				expect(result.record?.plan?.graphId).toBeDefined();
			}
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a run whose planning budget is already spent sends no event, but still persists the record", async () => {
		const { emit, sent } = recorder();
		const manual = manualTimers();
		const tracking = Promise.withResolvers<void>();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit,
			timers: manual.timers,
			// The tracker waits for the budget to fire, so the plan is finished only after the controller aborted.
			track: async ({ signal }) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => resolve());
				tracking.resolve();
				await promise;
				return undefined;
			},
		});
		deps.config.claude.budgetMs = 20;
		try {
			const running = runPromptSubmit(input, deps);
			await tracking.promise;
			await manual.fire(20);
			const result = await running;
			expect(result.record?.plan?.graphId).toBeDefined();
			expect(readSession(deps.stateDir, "s1")?.plan?.graphId).toBe(result.record?.plan?.graphId);
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("the event is handed the planning signal, and a budget that fires mid-request ends the wait promptly", async () => {
		let seen: AbortSignal | undefined;
		const manual = manualTimers();
		const emitted = Promise.withResolvers<void>();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			timers: manual.timers,
			emit: (_event, signal) => {
				const { promise, resolve } = Promise.withResolvers<boolean>();
				seen = signal;
				// A substrate that never answers: only the budget can end the wait.
				signal?.addEventListener("abort", () => resolve(false));
				emitted.resolve();
				return promise;
			},
		});
		deps.config.claude.budgetMs = 80;
		try {
			const running = runPromptSubmit(input, deps);
			await emitted.promise;
			await manual.fire(80);
			const result = await running;
			expect(seen).toBeDefined();
			expect(seen?.aborted).toBe(true);
			expect(result.record?.plan?.graphId).toBeDefined();
			expect(result.output?.hookSpecificOutput?.additionalContext).toContain("<BUILD_PROMPT>");
		} finally {
			cleanup();
		}
	});

	test("with no budget the signal handed to the seam stays live", async () => {
		let aborted: boolean | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit: async (_event, signal) => {
				aborted = signal?.aborted;
				return true;
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(aborted).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("the summary's elapsed time includes the event attempt", async () => {
		let clock = 1_000;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			now: () => clock,
			emit: async () => {
				clock += 4_000;
				return true;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.systemMessage).toContain("4.0s");
		} finally {
			cleanup();
		}
	});

	test("the substrate's answer, a refusal or a failure never changes the plan, the record, the summary or the result", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			progress: (e) => events.push(e),
		});
		try {
			// The baseline: no emit seam and no substrate URL, so the real emitter has nothing to send to.
			const base = await runPromptSubmit(input, { ...deps, emit: undefined });
			const emitters: Array<[string, NonNullable<HookDeps["emit"]>]> = [
				["accepted", async () => true],
				["refused", async () => false],
				[
					"rejecting",
					async () => {
						throw new Error("ECONNREFUSED substrate.test:9000");
					},
				],
				[
					"throwing",
					() => {
						throw new Error("synchronous failure");
					},
				],
			];
			for (const [name, emit] of emitters) {
				events.length = 0;
				const result = await runPromptSubmit(input, { ...deps, emit });
				expect(normalized(result, result.record?.plan?.graphId), name).toEqual(
					normalized(base, base.record?.plan?.graphId),
				);
				// The record was persisted before the emit, and the progress stream still ends planned.
				expect(readSession(deps.stateDir, "s1")?.plan?.graphId, name).toBe(
					result.record?.plan?.graphId,
				);
				expect(events.at(-1), name).toMatchObject({ type: "end", outcome: "planned" });
			}
		} finally {
			cleanup();
		}
	});

	test("without an emit seam nothing is sent unless a substrate URL is configured, and SUBSTRATE_DISABLED=1 beats it", async () => {
		const urls: string[] = [];
		globalThis.fetch = ((url: string) => {
			urls.push(String(url));
			return Promise.resolve(new Response("{}", { status: 202 }));
		}) as unknown as typeof fetch;
		const run = async (
			substrateUrl: string,
			env: Record<string, string>,
		): Promise<PromptSubmitResult> => {
			const config = trackedConfig();
			config.substrate.url = substrateUrl;
			const { deps, cleanup } = baseDeps({
				config,
				complete: smartComplete(),
				clarify: async () => ({ items: [] }),
				emit: undefined,
				decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0", ...env } },
			});
			try {
				return await runPromptSubmit(input, deps);
			} finally {
				cleanup();
			}
		};
		try {
			expect((await run("", {})).record?.plan?.graphId).toBeDefined();
			expect(urls).toEqual([]);
			expect(
				(await run("https://substrate.test", { SUBSTRATE_DISABLED: "1" })).record?.plan?.graphId,
			).toBeDefined();
			expect(urls).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("with a configured URL the real emitter posts the event to /events, and neither the prompt nor the token is in it", async () => {
		const R = recordingFetch([() => new Response("{}", { status: 202 })]);
		const config = trackedConfig();
		config.substrate.url = "https://substrate.test/";
		const logs: string[] = [];
		const { deps, cleanup } = baseDeps({
			config,
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			emit: undefined,
			log: (message) => logs.push(message),
			decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0", SUBSTRATE_TOKEN: "tok-secret-1234" } },
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const graphId = result.record?.plan?.graphId ?? "missing graph id";
			expect(R.calls).toHaveLength(1);
			const call = R.calls[0];
			expect(call?.url).toBe("https://substrate.test/events");
			expect(call?.method).toBe("POST");
			expect(call?.headers.authorization).toBe("Bearer tok-secret-1234");
			expect(call?.body).toEqual({
				kind: "note",
				summary: `ultrathink planned graph ${graphId} (5 nodes)`,
				surface: "claude-code",
				session_id: `s1:${graphId}`,
				graph_id: graphId,
				repo: "acme/widgets",
				branch: "feat/widget",
				payload: { ultrathink: "plan", nodes: 5, host: "claude-code" },
			});
			// The prompt, the spec and the plan stay local; the token is only ever the Authorization header.
			const wire = JSON.stringify(call?.body);
			expect(wire).not.toContain("add a widget");
			expect(wire).not.toContain("BUILD_PROMPT");
			expect(JSON.stringify([wire, result, logs, sessionText(deps.stateDir)])).not.toContain(
				"tok-secret-1234",
			);
		} finally {
			globalThis.fetch = realFetch;
			cleanup();
		}
	});
});

describe("progress events", () => {
	const label = (e: ProgressEvent): string =>
		e.type === "stage" ? `${e.stage}:${e.phase}` : e.type === "node" ? `node:${e.phase}` : e.type;

	test("a planned prompt streams begin, ordered stages, graph and node events, then end planned", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			progress: (e) => events.push(e),
		});
		try {
			await runPromptSubmit(input, deps);
			const labels = events.map(label);
			expect(labels[0]).toBe("begin");
			expect(labels.at(-1)).toBe("end");
			expect(events.at(-1)).toMatchObject({ type: "end", outcome: "planned" });
			const order = [
				"uplift:start",
				"uplift:end",
				"think:start",
				"graph",
				"think:end",
				"clarify:start",
				"clarify:end",
				"plan:start",
				"plan:end",
				"state:start",
				"state:end",
			];
			const positions = order.map((l) => labels.indexOf(l));
			expect(positions.every((p) => p >= 0)).toBe(true);
			expect([...positions].sort((a, b) => a - b)).toEqual(positions);
			expect(labels).not.toContain("track:start");
			expect(labels.filter((l) => l === "node:done")).toHaveLength(5);
			expect(events.find((e) => e.type === "graph")).toMatchObject({ total: 5 });
			expect(
				events.find((e) => e.type === "stage" && e.stage === "think" && e.phase === "end"),
			).toMatchObject({ ok: true, detail: "5 nodes" });
		} finally {
			cleanup();
		}
	});

	test("begin announces whether planner-side tracking will run", async () => {
		const untracked: ProgressEvent[] = [];
		const tracked: ProgressEvent[] = [];
		const plain = baseDeps({ complete: smartComplete(), progress: (e) => untracked.push(e) });
		const withTracker = baseDeps({
			complete: smartComplete(),
			progress: (e) => tracked.push(e),
			track: async () => {
				throw new Error("gateway down");
			},
		});
		try {
			await runPromptSubmit(input, plain.deps);
			await runPromptSubmit(input, withTracker.deps);
			expect(untracked[0]).toMatchObject({ type: "begin", track: false });
			expect(tracked[0]).toMatchObject({ type: "begin", track: true });
		} finally {
			plain.cleanup();
			withTracker.cleanup();
		}
	});

	test("a throwing sink leaves the output unchanged", async () => {
		const quiet = baseDeps({ complete: smartComplete() });
		const loud = baseDeps({
			complete: smartComplete(),
			progress: () => {
				throw new Error("sink closed");
			},
		});
		try {
			const a = await runPromptSubmit(input, quiet.deps);
			const b = await runPromptSubmit(input, loud.deps);
			expect(b.output).toBeDefined();
			expect(b.output?.systemMessage).toBe(a.output?.systemMessage);
		} finally {
			quiet.cleanup();
			loud.cleanup();
		}
	});

	test("a trivial prompt emits nothing", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({ progress: (e) => events.push(e) });
		try {
			await runPromptSubmit({ ...input, prompt: "ok" }, deps);
			expect(events).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("skill invocations", () => {
	const skillInput: PromptSubmitInput = {
		...input,
		prompt: "fix the login redirect",
		skill: {
			name: "gsd-quick",
			instruction: "fix the login redirect",
			summary: "Fast atomic task.",
			source: "omp",
		},
	};

	test("plans the instruction under the skill: ORIGINAL, conversation line, record, begin, header and summary", async () => {
		const payloads: string[] = [];
		const events: ProgressEvent[] = [];
		const complete = smartComplete();
		const { deps, cleanup } = baseDeps({
			complete: async (system, user) => {
				payloads.push(user);
				return complete(system, user);
			},
			progress: (e) => events.push(e),
		});
		try {
			const result = await runPromptSubmit(skillInput, deps);
			const uplift = payloads.find((p) => p.includes("<user_request>")) ?? "";
			expect(uplift).toContain("<user_request>\nfix the login redirect\n</user_request>");
			expect(uplift).toContain(
				'The user invoked the "gsd-quick" skill with this message. Skill summary: Fast atomic task.',
			);
			expect(result.record?.skill).toEqual({
				name: "gsd-quick",
				summary: "Fast atomic task.",
				source: "omp",
			});
			expect(readSession(deps.stateDir, "s1")?.skill?.name).toBe("gsd-quick");
			expect(events[0]).toMatchObject({ type: "begin", skill: "gsd-quick" });
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain('invoked the "gsd-quick" skill');
			expect(ctx).not.toContain(UPLIFT_CONTEXT_HEADER);
			expect(result.output?.systemMessage).toContain("Skill · gsd-quick");
		} finally {
			cleanup();
		}
	});

	test("a plain prompt keeps the original header and no skill anywhere", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			progress: (e) => events.push(e),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(
				result.output?.hookSpecificOutput.additionalContext.startsWith(UPLIFT_CONTEXT_HEADER),
			).toBe(true);
			expect(result.output?.systemMessage).not.toContain("Skill ·");
			expect(result.record?.skill).toBeUndefined();
			expect(events[0]).not.toHaveProperty("skill");
		} finally {
			cleanup();
		}
	});

	test("with ship enabled a gsd-* skill run asks for ultrathink-ship; other skills and plain prompts do not", async () => {
		const config = trackedConfig();
		config.ship.enabled = true;
		const { deps, cleanup } = baseDeps({ config, complete: smartComplete() });
		const shipFlag = process.env.ULTRATHINK_SHIP;
		delete process.env.ULTRATHINK_SHIP;
		try {
			const gsd = await runPromptSubmit(skillInput, deps);
			expect(gsd.output?.hookSpecificOutput.additionalContext).toMatch(
				/## Ship\n\n.*invoke the ultrathink-ship skill with stateFile=.*s1\.json/,
			);
			const docx = { name: "docx", instruction: "fix the login redirect", source: "omp" as const };
			const other = await runPromptSubmit({ ...skillInput, skill: docx }, deps);
			expect(other.output?.hookSpecificOutput.additionalContext).not.toContain("## Ship");
			const plain = await runPromptSubmit(input, deps);
			expect(plain.output?.hookSpecificOutput.additionalContext).not.toContain("## Ship");
		} finally {
			if (shipFlag === undefined) delete process.env.ULTRATHINK_SHIP;
			else process.env.ULTRATHINK_SHIP = shipFlag;
			cleanup();
		}
	});

	test("with the default config (ship off) a gsd-* skill run gets no Ship section", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete() });
		try {
			const gsd = await runPromptSubmit(skillInput, deps);
			expect(gsd.output?.hookSpecificOutput.additionalContext).not.toContain("## Ship");
		} finally {
			cleanup();
		}
	});
});

describe("Greptile knowledge base before clarify", () => {
	/** A reader whose read() resolves `result`; records start() inputs and close() calls. */
	function fakeReader(result: KnowledgeResult): {
		reader: KnowledgeReader;
		starts: Array<{ repo?: string }>;
		closed: () => number;
	} {
		const starts: Array<{ repo?: string }> = [];
		let closes = 0;
		const reader: KnowledgeReader = {
			start(input) {
				starts.push({ repo: input.repo });
				return {
					read: async () => result,
					close: () => {
						closes++;
					},
				};
			},
		};
		return { reader, starts, closed: () => closes };
	}

	const open: Clarification = {
		id: "q1",
		question: "Which queue backend?",
		header: "Queue",
		why: "w",
		options: [{ label: "Redis" }, { label: "SQS" }],
		default: "Redis",
		blocking: true,
	};
	const settled: Clarification = {
		id: "k1",
		question: "Where do widgets persist?",
		header: "Storage",
		why: "w",
		options: [],
		default: "",
		blocking: false,
		answer: "In the widgets table",
		source: "knowledge",
		evidence: "docs/storage.md",
	};

	test("a used lookup reaches clarify, is recorded with its settled count, and adds the context section", async () => {
		const { reader, starts, closed } = fakeReader({
			lookup: {
				outcome: "used",
				repo: "acme/widgets",
				namespaceId: "ns1",
				docs: ["index.md", "docs/storage.md"],
				chars: 42,
				ms: 5,
			},
			digest: "## index.md\nwidgets persist in the widgets table",
		});
		let seen: RunClarifyOptions | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async (opts) => {
				seen = opts;
				return { items: [open, settled] };
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(starts).toEqual([{ repo: "acme/widgets" }]);
			expect(seen?.knowledge).toEqual({
				digest: "## index.md\nwidgets persist in the widgets table",
				docs: ["index.md", "docs/storage.md"],
			});
			expect(result.record?.knowledge).toMatchObject({
				outcome: "used",
				docs: ["index.md", "docs/storage.md"],
				settled: 1,
			});
			expect(readSession(deps.stateDir, "s1")?.knowledge).toMatchObject({
				outcome: "used",
				settled: 1,
			});
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Greptile knowledge base");
			expect(ctx).toContain("for acme/widgets: index.md, docs/storage.md.");
			expect(result.output?.systemMessage).toContain("Knowledge · 2 docs · 1 settled");
			expect(closed()).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("an error lookup fails open: clarify runs without knowledge, the record says error, no context section", async () => {
		const { reader } = fakeReader({
			lookup: {
				outcome: "error",
				repo: "acme/widgets",
				docs: [],
				chars: 0,
				ms: 20_000,
				reason: "timed out after 20000ms",
			},
			digest: "",
		});
		let seen: RunClarifyOptions | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async (opts) => {
				seen = opts;
				return { items: [open] };
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(seen).toBeDefined();
			expect(seen?.knowledge).toBeUndefined();
			expect(result.record?.knowledge).toMatchObject({ outcome: "error", settled: 0 });
			expect(result.record?.clarifications).toEqual([open]);
			expect(result.output?.hookSpecificOutput.additionalContext ?? "").not.toContain(
				"## Greptile knowledge base",
			);
			expect(result.output?.systemMessage).toContain("Knowledge · error");
		} finally {
			cleanup();
		}
	});

	test("a lookup is still recorded when clarify throws", async () => {
		const { reader } = fakeReader({
			lookup: {
				outcome: "none",
				repo: "acme/widgets",
				docs: [],
				chars: 0,
				ms: 3,
				reason: "repository not listed",
			},
			digest: "",
		});
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async () => {
				throw new Error("clarify down");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.knowledge).toMatchObject({ outcome: "none", settled: 0 });
			expect(result.record?.clarifications).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("HITL off: the knowledge base is never read", async () => {
		const { reader, starts } = fakeReader({
			lookup: { outcome: "used", docs: ["index.md"], chars: 1, ms: 1 },
			digest: "x",
		});
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			control: { hitlEnabled: false },
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(starts).toEqual([]);
			expect(result.record?.knowledge).toBeUndefined();
			expect(result.output?.systemMessage).not.toContain("Knowledge");
		} finally {
			cleanup();
		}
	});

	test("the lookup topic is the request text, goal and node conclusions, without the spec's XML markup", async () => {
		const topics: string[] = [];
		const reader: KnowledgeReader = {
			start: () => ({
				read: async (topic) => {
					topics.push(topic);
					return { lookup: { outcome: "none", docs: [], chars: 0, ms: 1 }, digest: "" };
				},
				close: () => {
					// reason: the fixture holds no resource to release
				},
			}),
		};
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async () => ({ items: [] }),
		});
		try {
			await runPromptSubmit(input, deps);
			expect(topics).toHaveLength(1);
			const topic = topics[0] ?? "";
			expect(topic).toContain("add a widget");
			expect(topic).toContain("Ship it");
			expect(topic).toContain("T1: c n1");
			expect(topic).not.toContain("<");
			for (const tag of ["BUILD_PROMPT", "GRAPH_OF_THOUGHT", "ORIGINAL", "NODE"])
				expect(topic).not.toContain(tag);
		} finally {
			cleanup();
		}
	});

	test("knowledge-settled answers are not carried to the next prompt; user answers are", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
		});
		try {
			const userAnswer: Clarification = { ...open, answer: "Redis", answeredAt: 1, source: "user" };
			writeSession(deps.stateDir, {
				sessionId: "s1",
				at: 0,
				result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
				clarifications: [userAnswer, settled],
			});
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.clarifications).toEqual([userAnswer]);
		} finally {
			cleanup();
		}
	});
});

// ---- Jev plan gate (DP-PLAN) and the prompt's decision records ----

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const realFetch = globalThis.fetch;
const jevDirs: string[] = [];
afterEach(() => {
	globalThis.fetch = realFetch;
	for (const dir of jevDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ERR = (s: number, headers?: Record<string, string>) => () =>
	Response.json(
		{ error: { code: s, message: `upstream said no for ${K}` } },
		{ status: s, headers },
	);

/** Never resolves; rejects with an AbortError when its signal fires (as src/grok/complete.test.ts hangingFetch). Installed as globalThis.fetch too. */
function hangingFetch(onCall?: () => void): typeof fetch {
	const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError")),
			);
			onCall?.();
		})) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return fetchImpl;
}

/** A credential store path in a temp dir: empty, or holding `key` for openrouter. */
function tempStore(key?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-hook-"));
	jevDirs.push(dir);
	const path = join(dir, "mcp-credentials.json");
	if (key !== undefined) {
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				providers: { openrouter: { kind: "api_key", apiKey: key, updatedAt: 1 } },
			}),
			{
				mode: 0o600,
			},
		);
	}
	return path;
}

/** `ON`: decisions enabled with every other key at its default unless overridden; `claude.echo` on unless `echo` is false. */
function onConfig(decisions: Partial<DecisionsConfig> = {}, echo = true): UltrathinkConfig {
	const config = trackedConfig();
	config.decisions = { ...config.decisions, enabled: true, ...decisions };
	config.claude = { ...config.claude, echo };
	return config;
}

const ACK = "thanks, that works now";
const NEW_WORK = "Add OAuth login with GitHub to the web app";
const NOTICE_004 =
	"Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it";

interface JevHarness {
	deps: HookDeps;
	calls: { engine: number; track: number; brief: number; knowledge: number };
	events: ProgressEvent[];
	logs: string[];
	cleanup: () => void;
}

/** Hook deps that count every engine, tracker, brief and knowledge-base call, with the Decisions seams injected (key K, empty store). */
function jevHarness(
	config: UltrathinkConfig,
	fetchImpl: typeof fetch,
	overrides: Partial<HookDeps> = {},
): JevHarness {
	const calls = { engine: 0, track: 0, brief: 0, knowledge: 0 };
	const events: ProgressEvent[] = [];
	const logs: string[] = [];
	const complete = smartComplete();
	const { deps, cleanup } = baseDeps({
		config,
		complete: async (system, user) => {
			calls.engine++;
			return complete(system, user);
		},
		brief: async () => {
			calls.brief++;
			return NO_BRIEF;
		},
		track: async () => {
			calls.track++;
			return undefined;
		},
		knowledge: {
			start: () => {
				calls.knowledge++;
				return {
					read: async () => ({
						lookup: { outcome: "none", docs: [], chars: 0, ms: 1 },
						digest: "",
					}),
					close: () => {
						// reason: the fixture holds no resource to release
					},
				};
			},
		},
		conversation: () =>
			"User: the login page is broken\n\nAssistant: Fixed the redirect; it works now.",
		log: (message) => logs.push(message),
		progress: (event) => events.push(event),
		decisionsDeps: {
			env: { ULTRATHINK_OPENROUTER_KEY: K },
			storePath: tempStore(),
			fetch: fetchImpl,
			sleep: async () => {
				// reason: no real delay in the fixture; retries run immediately
			},
		},
		...overrides,
	});
	return { deps, calls, events, logs, cleanup };
}

/** The same run with a different config (e.g. an earlier prompt with the tracked config), sharing the state dir and counters. */
function withConfig(h: JevHarness, config: UltrathinkConfig): HookDeps {
	return { ...h.deps, config };
}

/** The same run with Jev killed (BASELINE: decisions off), sharing everything else. */
function offDeps(deps: HookDeps): HookDeps {
	const decisionsDeps = deps.decisionsDeps;
	return {
		...deps,
		decisionsDeps: { ...decisionsDeps, env: { ...decisionsDeps?.env, ULTRATHINK_DECISIONS: "0" } },
	};
}

/** `value` with the random graph id replaced, so two planned runs compare equal. */
function normalized(value: unknown, graphId?: string): unknown {
	const text = JSON.stringify(value);
	if (text === undefined) return undefined;
	return JSON.parse(graphId ? text.replaceAll(graphId, "GRAPH") : text);
}

function withoutDecisions(record: SessionRecord | undefined): SessionRecord | undefined {
	if (!record) return undefined;
	const copy = { ...record };
	delete copy.decisions;
	return copy;
}

/** The one-time breaker warning bit; its text carries a real-clock date, so tests match its shape, never its text. */
const JEV_WARNING = / · Jev · unavailable:[^\n]*?(?= · |\n|$)/g;

/** Failure kinds that open the persisted breaker: the first summary after them carries the warning. */
const BREAKER_KINDS: readonly DecisionsErrorKind[] = ["auth", "credits"];

/**
 * A planned Jev run deep-equals its BASELINE apart from the Decisions additions (records and the summary bits).
 * `kind` is the failure the run met: a breaker kind adds exactly one `Jev · unavailable:` bit, anything else none.
 */
function expectBaseline(
	jev: PromptSubmitResult,
	base: PromptSubmitResult,
	bit?: string,
	kind?: DecisionsErrorKind,
): void {
	const jevGraph = jev.record?.plan?.graphId;
	const baseGraph = base.record?.plan?.graphId;
	expect(normalized(jev.output?.hookSpecificOutput, jevGraph)).toEqual(
		normalized(base.output?.hookSpecificOutput, baseGraph),
	);
	expect(normalized(withoutDecisions(jev.record), jevGraph)).toEqual(
		normalized(base.record, baseGraph),
	);
	const summary = jev.output?.systemMessage;
	expect(summary?.match(JEV_WARNING) ?? []).toHaveLength(
		kind !== undefined && BREAKER_KINDS.includes(kind) ? 1 : 0,
	);
	const rest = summary?.replace(JEV_WARNING, "");
	if (bit === undefined) expect(rest).toBe(base.output?.systemMessage);
	else {
		expect(rest).toContain(` · ${bit}`);
		expect(rest?.replace(` · ${bit}`, "")).toBe(base.output?.systemMessage);
	}
}

/** Rule T6: the key and a bearer header never appear in anything the run produced. */
function expectNoKey(...outputs: unknown[]): void {
	for (const output of outputs) {
		const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
		expect(text).not.toContain(K);
		expect(text).not.toContain("Bearer sk-or-");
	}
}

function sessionText(stateDir: string): string {
	const path = sessionPath(stateDir, "s1");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The 4.1–4.9 failures and the kind each maps to; `respond` gets the asked question key. */
const FAILURES: ReadonlyArray<{
	name: string;
	kind: DecisionsErrorKind;
	respond?: (key: string) => () => Response;
}> = [
	{ name: "401", kind: "auth", respond: () => ERR(401) },
	{ name: "402", kind: "credits", respond: () => ERR(402) },
	{ name: "400", kind: "bad-request", respond: () => ERR(400) },
	{ name: "429 then 429", kind: "rate-limit", respond: () => ERR(429) },
	{ name: "503 then 503", kind: "upstream", respond: () => ERR(503) },
	{ name: "a hanging request", kind: "timeout" },
	{
		name: "invalid JSON",
		kind: "invalid-response",
		respond: () => () => new Response("not json", { status: 200 }),
	},
	{ name: "a missing answer key", kind: "invalid-response", respond: () => JEV(0.97, "not_asked") },
	{ name: "noul out of range", kind: "invalid-response", respond: (key) => JEV(1.5, key) },
];

/**
 * R for one failure: a recording fetch that repeats it, or a hanging fetch. The hanging fetch aborts the per-attempt
 * budget the decisions client arms with AbortSignal.timeout, so that attempt times out without a real clock.
 */
function failureFetch(
	failure: (typeof FAILURES)[number],
	key: string,
	timeouts: ControlledTimeouts,
): { fetch: typeof fetch; timeoutMs: number } {
	if (!failure.respond) {
		const fetchImpl = hangingFetch(() => {
			timeouts.armed.at(-1)?.abort(new DOMException("timed out", "TimeoutError"));
		});
		return { fetch: fetchImpl, timeoutMs: 50 };
	}
	return { fetch: recordingFetch([failure.respond(key)]).fetch, timeoutMs: 3000 };
}

/** A fetch that counts its calls, so a refused call can be proven to have made no network request. */
function countingFetch(inner: typeof fetch): { fetch: typeof fetch; count: () => number } {
	let calls = 0;
	const counted = ((...args: Parameters<typeof fetch>) => {
		calls++;
		return inner(...args);
	}) as typeof fetch;
	return { fetch: counted, count: () => calls };
}

describe("Jev plan gate", () => {
	test("a fresh install sends nothing without a key, and consults Jev with one (AC-1.1, JEV-01)", async () => {
		for (const surface of ["claude-code", "grok-build"]) {
			const R = recordingFetch([JEV(0.97)]);
			// FRESH: no decisions key anywhere, and no key in the environment or store.
			const h = jevHarness(trackedConfig(), R.fetch, {
				surface,
				decisionsDeps: { env: {}, storePath: tempStore(), fetch: R.fetch },
			});
			try {
				const keyless = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps);
				expect(R.calls).toHaveLength(0);
				expect(h.calls.engine).toBeGreaterThanOrEqual(1);
				expect(keyless.record?.plan).toBeDefined();
				expect(keyless).not.toHaveProperty("decisions");
				expect(keyless.record).not.toHaveProperty("decisions");
				expect(keyless.output?.systemMessage).not.toContain("Decisions ·");

				const keyed = await runPromptSubmit(
					{ ...input, prompt: NEW_WORK },
					{
						...h.deps,
						decisionsDeps: {
							env: { ULTRATHINK_OPENROUTER_KEY: K },
							storePath: tempStore(K),
							fetch: R.fetch,
						},
					},
				);
				expect(R.calls).toHaveLength(1);
				expect(keyed.output?.systemMessage).toContain("Decisions · plan 0.97");
			} finally {
				h.cleanup();
			}
		}
	});

	test("an acknowledgement Jev scores below planSkipBelow is not planned and shows the notice, on Claude and Grok (AC-3.1)", async () => {
		for (const surface of ["claude-code", "grok-build"]) {
			const R = recordingFetch([JEV(0.04)]);
			const h = jevHarness(onConfig(), R.fetch, { surface });
			try {
				// An earlier planned prompt of this session: the skip must leave its record untouched (A13).
				const earlier = await runPromptSubmit(
					{ ...input, prompt: NEW_WORK },
					offDeps(withConfig(h, trackedConfig())),
				);
				const before = sessionText(h.deps.stateDir);
				const counts = { ...h.calls };
				h.events.length = 0;

				const result = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
				expect(R.calls).toHaveLength(1);
				expect(result).toEqual({
					skipped: "jev-skip",
					decisions: [expect.objectContaining({ point: "plan", p: 0.04 })],
					notice: NOTICE_004,
				});
				// Not planned, exactly as a deterministic skip: no engine, tracker, brief or knowledge call, no event, no write.
				expect(h.calls).toEqual(counts);
				expect(h.events).toEqual([]);
				expect(sessionText(h.deps.stateDir)).toBe(before);
				expect(readSession(h.deps.stateDir, "s1")?.plan?.graphId).toBe(
					earlier.record?.plan?.graphId,
				);

				const trivial = await runPromptSubmit({ ...input, prompt: "thanks" }, h.deps);
				expect(trivial).toEqual({ skipped: "skip", reason: "trivial" });
				// The Jev skip has the same shape as a deterministic one, which also names its reason.
				expect(Object.keys(result).filter((k) => k !== "decisions" && k !== "notice")).toEqual(
					Object.keys(trivial).filter((key) => key !== "reason"),
				);
				expectNoKey(result, h.logs, sessionText(h.deps.stateDir));
			} finally {
				h.cleanup();
			}
		}
	});

	test("with claude.echo off a Jev skip carries no notice and no Decisions bit (AC-3.3)", async () => {
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig({}, false), R.fetch);
		try {
			const result = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(result.skipped).toBe("jev-skip");
			expect(result.output).toBeUndefined();
			expect(result).not.toHaveProperty("notice");
			expect(JSON.stringify(result)).not.toContain("Prompt Uplift · not planned");
			expect(JSON.stringify(result)).not.toContain("Decisions ·");
			expect(h.calls.engine).toBe(0);
			expectNoKey(result);
		} finally {
			h.cleanup();
		}
	});

	test("new work Jev scores at or above planSkipBelow is planned as today, with the Decisions bit (AC-3.4)", async () => {
		for (const surface of ["claude-code", "grok-build"]) {
			const R = recordingFetch([JEV(0.97)]);
			const h = jevHarness(onConfig(), R.fetch, { surface });
			try {
				const base = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(h.deps));
				expect(R.calls).toHaveLength(0);
				const jev = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps);
				expect(R.calls).toHaveLength(1);
				expect(jev.record?.plan).toBeDefined();
				expectBaseline(jev, base, "Decisions · plan 0.97");
				expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
			} finally {
				h.cleanup();
			}
		}
	});

	test("a skill invocation (gsd-quick) bypasses the gate with zero requests and still plans with the skill (AC-3.6)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			const result = await runPromptSubmit(
				{
					...input,
					prompt: "3",
					skill: { name: "gsd-quick", instruction: "3", summary: "Quick task", source: "slash" },
				},
				h.deps,
			);
			expect(R.calls).toHaveLength(0);
			expect(result.record?.skill?.name).toBe("gsd-quick");
			expect(result.record?.plan).toBeDefined();
			expect(readSession(h.deps.stateDir, "s1")?.plan?.graphId).toBe(result.record?.plan?.graphId);
			expect(result).not.toHaveProperty("decisions");
		} finally {
			h.cleanup();
		}
	});

	test("uplift: forces a plan with zero requests (AC-3.7)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			const result = await runPromptSubmit({ ...input, prompt: "uplift: thanks" }, h.deps);
			expect(R.calls).toHaveLength(0);
			expect(h.calls.engine).toBeGreaterThanOrEqual(1);
			expect(result.record?.plan).toBeDefined();
		} finally {
			h.cleanup();
		}
	});

	test("on Grok, a wrapped uplift: or /gsd-quick plans with zero requests; a wrapped acknowledgement still asks Jev", async () => {
		const grok = (typed: string) =>
			`<user_query>\n${typed}\n</user_query>\n<skill_information>\n<skill name="gsd-quick" args="3">\nShip a small task fast.\n</skill>\n</skill_information>`;
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, { surface: "grok-build" });
		try {
			for (const prompt of ["<user_query>\nuplift: thanks\n</user_query>", grok("/gsd-quick 3")]) {
				const result = await runPromptSubmit({ ...input, prompt }, h.deps);
				expect(result.record?.plan).toBeDefined();
				expect(result).not.toHaveProperty("decisions");
			}
			expect(R.calls).toHaveLength(0);

			const ack = await runPromptSubmit(
				{ ...input, prompt: `<user_query>\n${ACK}\n</user_query>` },
				h.deps,
			);
			expect(R.calls).toHaveLength(1);
			expect(ack.skipped).toBe("jev-skip");
		} finally {
			h.cleanup();
		}
	});

	test("TRIVIAL_RE acks are skipped as today with zero requests and no notice (AC-3.8)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			for (const prompt of ["yes", "ok", "thanks", "go ahead", "lgtm!"]) {
				const base = await runPromptSubmit(
					{ ...input, prompt },
					withConfig(h, onConfig({ enabled: false })),
				);
				const jev = await runPromptSubmit({ ...input, prompt }, h.deps);
				expect(jev).toEqual(base);
				expect(jev).toEqual({ skipped: "skip", reason: "trivial" });
			}
			expect(R.calls).toHaveLength(0);
			expect(h.calls.engine).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	test("every other deterministic skip sends nothing and matches today (AC-3.9)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			const cases: Array<[string, Partial<HookDeps>]> = [
				["raw: add a flag", {}],
				["/help", {}],
				["<BUILD_PROMPT><ORIGINAL>add a flag</ORIGINAL></BUILD_PROMPT>", {}],
				[NEW_WORK, { control: { enabled: false } }],
			];
			for (const [prompt, extra] of cases) {
				const base = await runPromptSubmit(
					{ ...input, prompt },
					{ ...h.deps, ...extra, config: onConfig({ enabled: false }) },
				);
				const jev = await runPromptSubmit({ ...input, prompt }, { ...h.deps, ...extra });
				expect(jev).toEqual(base);
				expect(jev.skipped).toBeDefined();
			}
			expect(R.calls).toHaveLength(0);
			expect(h.calls.engine).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	test("an inactive plan point sends nothing and plans as today (AC-3.10)", async () => {
		for (const points of [["ship"], []] as DecisionsConfig["points"][]) {
			const R = recordingFetch([JEV(0.01)]);
			const h = jevHarness(onConfig({ points }), R.fetch);
			try {
				const base = await runPromptSubmit({ ...input, prompt: ACK }, offDeps(h.deps));
				const jev = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
				expect(R.calls).toHaveLength(0);
				expect(jev.record?.plan).toBeDefined();
				expect(jev).not.toHaveProperty("decisions");
				expectBaseline(jev, base);
			} finally {
				h.cleanup();
			}
		}
	});

	test("the record holds no content; a skip returns it unpersisted, a plan stores it in the session (AC-3.13)", async () => {
		const R = recordingFetch([JEV(0.04), JEV(0.97)]);
		const h = jevHarness(onConfig(), R.fetch);
		const expected = (p: number, action: DecisionAction): DecisionRecord => ({
			point: "plan",
			outcome: "ok",
			model: "typesafe/jev-1.13-20260917",
			id: "gen-dec-test",
			p,
			probabilities: { plan_worthy: p },
			threshold: 0.2,
			action,
			latencyMs: expect.any(Number),
			attempts: 1,
			cost: 0.000019,
			at: expect.any(Number),
		});
		try {
			const skipped = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(skipped.decisions).toEqual([expected(0.04, "skip-plan")]);
			const skipRecord = skipped.decisions?.[0];
			expect(Number.isFinite(skipRecord?.latencyMs) && (skipRecord?.latencyMs ?? -1) >= 0).toBe(
				true,
			);
			expect(skipRecord).not.toHaveProperty("error");
			expect(JSON.stringify(skipRecord)).not.toContain(ACK);
			expect(readSession(h.deps.stateDir, "s1")).toBeUndefined();

			const planned = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps);
			expect(planned.decisions).toEqual([expected(0.97, "plan")]);
			const planRecord = planned.decisions?.[0];
			expect(planRecord).not.toHaveProperty("error");
			expect(JSON.stringify(planRecord)).not.toContain(NEW_WORK);
			expect(planned.record?.decisions).toEqual(planned.decisions);
			expect(readSession(h.deps.stateDir, "s1")?.decisions).toEqual(planned.decisions);
			expectNoKey(skipped, planned, sessionText(h.deps.stateDir));
		} finally {
			h.cleanup();
		}
	});

	test("the request carries the host session id (none for an unknown session) and only the message and last assistant turn", async () => {
		const R = recordingFetch([JEV(0.97)]);
		const h = jevHarness(onConfig({ points: ["plan"] }), R.fetch);
		try {
			await runPromptSubmit({ ...input, session_id: "sess-123", prompt: NEW_WORK }, h.deps);
			await runPromptSubmit({ cwd: "/repo", prompt: NEW_WORK }, h.deps);
			expect(R.calls).toHaveLength(2);
			expect((R.calls[0]?.body as { session_id?: string }).session_id).toBe("sess-123");
			expect(R.calls[1]?.body).not.toHaveProperty("session_id");
			expect((R.calls[0]?.body as { state: unknown }).state).toEqual({
				message: NEW_WORK,
				recent_conversation: "Assistant: Fixed the redirect; it works now.",
			});
		} finally {
			h.cleanup();
		}
	});

	test("a project layer cannot redirect the request: only the default endpoint is called (AC-2.12)", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-decisions-project-"));
		jevDirs.push(root);
		const project = join(root, "project");
		mkdirSync(join(project, ".claude"), { recursive: true });
		// Consent is the user's: a project layer can only narrow decisions, so the Claude user layer turns them on.
		mkdirSync(join(root, "claude"), { recursive: true });
		writeFileSync(
			join(root, "claude", "ultrathink.json"),
			JSON.stringify({ decisions: { enabled: true } }),
		);
		writeFileSync(
			join(project, ".claude", "ultrathink.json"),
			JSON.stringify({
				decisions: {
					enabled: true,
					url: "https://evil.example/x",
					endpoint: "https://evil.example/y",
				},
			}),
		);
		const config = loadConfig(
			claudeConfigPaths(project, {
				XDG_CONFIG_HOME: join(root, "xdg"),
				CLAUDE_CONFIG_DIR: join(root, "claude"),
			}),
		);
		expect(Object.keys(config.decisions).sort()).toEqual([
			"blockingAt",
			"enabled",
			"groundedAt",
			"model",
			"planSkipBelow",
			"points",
			"provider",
			"shipApproveAt",
			"shipVetoAtOrBelow",
			"skillworthyAt",
			"teachableAutoAt",
			"teachableBelow",
			"timeoutMs",
			"zdr",
		]);
		expect(JSON.stringify(config.decisions)).not.toContain("evil.example");
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(config, R.fetch);
		try {
			const result = await runPromptSubmit({ ...input, cwd: project, prompt: ACK }, h.deps);
			expect(R.calls.map((call) => call.url)).toEqual([ENDPOINT]);
			expect(R.calls.some((call) => call.url.includes("evil.example"))).toBe(false);
			expect(result.skipped).toBe("jev-skip");
		} finally {
			h.cleanup();
		}
	});

	test("every plan failure kind plans exactly as today and reports the kind (AC-4.11)", async () => {
		for (const failure of FAILURES) {
			const timeouts = controlledTimeouts();
			const { fetch: fetchImpl, timeoutMs } = failureFetch(failure, "plan_worthy", timeouts);
			const counted = countingFetch(fetchImpl);
			const h = jevHarness(onConfig({ points: ["plan"], timeoutMs }), counted.fetch);
			try {
				const base = await runPromptSubmit({ ...input, prompt: ACK }, offDeps(h.deps));
				const jev = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
				expect(jev.record?.plan).toBeDefined();
				expectBaseline(jev, base, `Decisions · error (${failure.kind})`, failure.kind);
				expect(jev.decisions).toEqual([
					expect.objectContaining({
						point: "plan",
						outcome: "error",
						error: failure.kind,
						action: "fail-open",
						probabilities: {},
					}),
				]);
				expect(readSession(h.deps.stateDir, "s1")?.decisions).toEqual(jev.decisions);
				expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
				if (BREAKER_KINDS.includes(failure.kind)) {
					// The breaker is open in the shared state dir: the next prompt is refused with no request.
					const before = counted.count();
					const again = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
					expect(counted.count()).toBe(before);
					expect(again.record?.plan).toBeDefined();
					expectBaseline(again, base, "Decisions · error (unavailable)", "unavailable");
					expect(again.decisions).toEqual([
						expect.objectContaining({
							point: "plan",
							outcome: "error",
							error: "unavailable",
							action: "fail-open",
						}),
					]);
				}
			} finally {
				timeouts.restore();
				h.cleanup();
			}
		}
	}, 30_000);

	test("an intentionally disabled run neither shows nor consumes a saved Jev failure warning (ULTRATHINK_DECISIONS=0)", async () => {
		const h = jevHarness(onConfig({ points: ["plan"] }), recordingFetch([JEV(0.97)]).fetch);
		try {
			openJevHealth(h.deps.stateDir, "openrouter").recordFailure("credits", Date.now());
			const off = await runPromptSubmit({ ...input, prompt: ACK }, offDeps(h.deps));
			expect(off.output?.systemMessage ?? "").not.toContain("Jev · unavailable");
			expect(openJevHealth(h.deps.stateDir, "openrouter").read().warnedCause).toBeUndefined();
			// Enabled again, the saved failure still warns, once.
			const on = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(on.output?.systemMessage?.match(JEV_WARNING) ?? []).toHaveLength(1);
			expect(openJevHealth(h.deps.stateDir, "openrouter").read().warnedCause).toBe("credits");
		} finally {
			h.cleanup();
		}
	});

	test("a caller abort during the plan gate is re-thrown as an AbortError before anything runs (AC-5.7)", async () => {
		const controller = new AbortController();
		const fetchImpl = hangingFetch(() => queueMicrotask(() => controller.abort()));
		const h = jevHarness(onConfig(), fetchImpl, { signal: controller.signal });
		try {
			let caught: unknown;
			try {
				await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			} catch (error) {
				// reason: the error is captured and asserted by the caller
				caught = error;
			}
			expect((caught as Error | undefined)?.name).toBe("AbortError");
			expect(h.calls).toEqual({ engine: 0, track: 0, brief: 0, knowledge: 0 });
			expect(h.events).toEqual([]);
			expect(readSession(h.deps.stateDir, "s1")).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});
});

describe("Jev knowledge and blocking points through the hook", () => {
	const DOCS = ["index.md", "docs/auth.md", "docs/storage.md"];
	const DIGEST =
		"## Greptile knowledge base\n\n### index.md\n\nRouting table.\n\n### docs/auth.md\n\nSessions are JWTs signed with RS256.\n\n### docs/storage.md\n\nWidgets persist in the widgets table.";
	const usedReader: KnowledgeReader = {
		start: () => ({
			read: async () => ({
				lookup: {
					outcome: "used",
					repo: "acme/widgets",
					namespaceId: "ns1",
					docs: DOCS,
					chars: DIGEST.length,
					ms: 1,
				},
				digest: DIGEST,
			}),
			close: () => {
				// reason: the fixture holds no resource to release
			},
		}),
	};
	/** Two claims the knowledge base settles. */
	const SETTLED = JSON.stringify({
		questions: [
			{
				question: "How are sessions signed?",
				header: "Auth",
				why: "w",
				options: [],
				blocking: false,
				knowledge: { answer: "JWTs signed with RS256", source: "docs/auth.md" },
			},
			{
				question: "Where do widgets persist?",
				header: "Storage",
				why: "w",
				options: [],
				blocking: false,
				knowledge: { answer: "In the widgets table", source: "docs/storage.md" },
			},
		],
	});
	/** Two open questions the clarifier did not mark blocking. */
	const OPEN = JSON.stringify({
		questions: [
			{
				question: "Which OAuth scopes?",
				header: "Scopes",
				why: "w",
				options: [{ label: "read:user" }, { label: "repo" }],
				default: "read:user",
				blocking: false,
			},
			{
				question: "Where are tokens stored?",
				header: "Tokens",
				why: "w",
				options: [{ label: "Cookie" }, { label: "Local storage" }],
				default: "Cookie",
				blocking: false,
			},
		],
	});
	/** smartComplete, with `reply` as the clarifier's answer. */
	function clarifying(reply: string): HookDeps["complete"] {
		const complete = smartComplete();
		return async (system, user) => (user.startsWith("<spec>") ? reply : complete(system, user));
	}

	test("every knowledge failure kind keeps both claims settled and reports the kind (AC-4.13)", async () => {
		for (const failure of FAILURES) {
			const timeouts = controlledTimeouts();
			const { fetch: fetchImpl, timeoutMs } = failureFetch(failure, "supported", timeouts);
			const counted = countingFetch(fetchImpl);
			const h = jevHarness(onConfig({ points: ["knowledge"], timeoutMs }), counted.fetch, {
				knowledge: usedReader,
			});
			const deps = { ...h.deps, complete: clarifying(SETTLED) };
			try {
				const base = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(deps));
				expect(base.record?.clarifications?.filter((c) => c.source === "knowledge")).toHaveLength(
					2,
				);
				const jev = await runPromptSubmit({ ...input, prompt: NEW_WORK }, deps);
				expect(jev.record?.clarifications).toEqual(base.record?.clarifications);
				expectBaseline(jev, base, `Decisions · error (${failure.kind})`, failure.kind);
				expect(jev.decisions).toHaveLength(2);
				for (const record of jev.decisions ?? []) {
					expect(record).toMatchObject({
						point: "knowledge",
						outcome: "error",
						error: failure.kind,
						action: "fail-open",
					});
				}
				expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
				if (BREAKER_KINDS.includes(failure.kind)) {
					const before = counted.count();
					const again = await runPromptSubmit({ ...input, prompt: NEW_WORK }, deps);
					expect(counted.count()).toBe(before);
					expect(again.record?.clarifications).toEqual(base.record?.clarifications);
					expectBaseline(again, base, "Decisions · error (unavailable)", "unavailable");
					expect(again.decisions).toHaveLength(2);
					for (const record of again.decisions ?? []) {
						expect(record).toMatchObject({
							point: "knowledge",
							outcome: "error",
							error: "unavailable",
							action: "fail-open",
						});
					}
				}
			} finally {
				timeouts.restore();
				h.cleanup();
			}
		}
	}, 30_000);

	test("every blocking failure kind keeps both questions non-blocking and reports the kind (AC-4.14)", async () => {
		for (const failure of FAILURES) {
			const timeouts = controlledTimeouts();
			const { fetch: fetchImpl, timeoutMs } = failureFetch(failure, "risky", timeouts);
			const counted = countingFetch(fetchImpl);
			const h = jevHarness(onConfig({ points: ["blocking"], timeoutMs }), counted.fetch);
			const deps = { ...h.deps, complete: clarifying(OPEN) };
			try {
				const base = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(deps));
				expect(base.record?.clarifications?.map((c) => c.blocking)).toEqual([false, false]);
				const jev = await runPromptSubmit({ ...input, prompt: NEW_WORK }, deps);
				expect(jev.record?.clarifications).toEqual(base.record?.clarifications);
				expectBaseline(jev, base, `Decisions · error (${failure.kind})`, failure.kind);
				expect(jev.decisions).toHaveLength(2);
				for (const record of jev.decisions ?? []) {
					expect(record).toMatchObject({
						point: "blocking",
						outcome: "error",
						error: failure.kind,
						action: "fail-open",
					});
				}
				expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
				if (BREAKER_KINDS.includes(failure.kind)) {
					const before = counted.count();
					const again = await runPromptSubmit({ ...input, prompt: NEW_WORK }, deps);
					expect(counted.count()).toBe(before);
					expect(again.record?.clarifications).toEqual(base.record?.clarifications);
					expectBaseline(again, base, "Decisions · error (unavailable)", "unavailable");
					expect(again.decisions).toHaveLength(2);
					for (const record of again.decisions ?? []) {
						expect(record).toMatchObject({
							point: "blocking",
							outcome: "error",
							error: "unavailable",
							action: "fail-open",
						});
					}
				}
			} finally {
				timeouts.restore();
				h.cleanup();
			}
		}
	}, 60_000);
});

describe("lessons and RAGFlow documents in the plan", () => {
	const lesson: RecalledLesson = {
		id: "l1",
		name: "Run migrations first MARKER_L1",
		description: "Seeding before migrating fails",
		body: "MARKER_L1 run the migration before the seed script",
		kind: "pitfall",
		project: "widgets",
		host: "claude-code",
		occurrences: 2,
		createdAt: "2026-01-01T00:00:00.000Z",
		source: "local",
	};
	const recalled: RecallOutcome = {
		status: "used",
		lessons: [lesson],
		source: "local",
		chars: 200,
		ms: 5,
	};
	const grounded: GroundOutcome = {
		status: "used",
		chunks: [
			{
				id: "c1",
				content: "MARKER_D1 widgets are stored in the widgets table",
				documentName: "storage.md",
			},
		],
		chars: 120,
		ms: 7,
		datasets: 1,
	};
	const skill: RecalledSkill = {
		name: "lesson-bun-test",
		description: "Use when running the suite MARKER_S1",
		path: "/state/teach/skill-drafts/lesson-bun-test/SKILL.md",
		target: "drafts",
		sourceIds: ["m1"],
		occurrences: 3,
	};
	const skillHits: SkillRecallOutcome = { status: "used", skills: [skill], chars: 200, ms: 4 };
	const never = (): Promise<never> => Promise.withResolvers<never>().promise;

	function echoConfig(): UltrathinkConfig {
		const config = trackedConfig();
		config.claude = { ...config.claude, echo: true };
		return config;
	}

	function contextOf(result: PromptSubmitResult): string {
		return result.output?.hookSpecificOutput.additionalContext ?? "";
	}

	/** The planned context with the random graph id replaced, so two runs on one state dir compare equal. */
	function plannedContext(result: PromptSubmitResult): unknown {
		return normalized(result.output?.hookSpecificOutput, result.record?.plan?.graphId);
	}

	test("a used lookup adds both sections after the brief and before the spec, and the record and summary say so", async () => {
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			brief: async () =>
				briefOf("## Substrate brief: acme/widgets\n- 09:04 cursor edited widget.ts"),
			recall: async () => recalled,
			ground: async () => grounded,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const context = contextOf(result);
			const at = (needle: string) => context.indexOf(needle);
			expect(at("## Agent Substrate brief")).toBeGreaterThan(-1);
			expect(at("## Agent Substrate brief")).toBeLessThan(at("## Lessons from earlier work"));
			expect(at("## Lessons from earlier work")).toBeLessThan(at("## Documents (RAGFlow)"));
			expect(at("## Documents (RAGFlow)")).toBeLessThan(at("<BUILD_PROMPT>"));
			expect(context).toContain("MARKER_L1");
			expect(context).toContain("MARKER_D1");
			expect(result.output?.systemMessage).toContain("Lessons · 1 recalled (local)");
			expect(result.output?.systemMessage).toContain("Docs · 1 excerpt (RAGFlow)");

			// The record keeps the lookups, never their text, and reads back from disk.
			expect(result.record?.lessons).toMatchObject({
				outcome: "used",
				count: 1,
				ids: ["l1"],
				source: "local",
			});
			expect(result.record?.docs).toMatchObject({ status: "used", count: 1, datasets: 1 });
			const stored = readSession(deps.stateDir, "s1");
			expect(stored?.lessons).toEqual(result.record?.lessons);
			expect(stored?.docs).toEqual(result.record?.docs);
			expect(JSON.stringify(stored)).not.toContain("MARKER_L1");
			expect(JSON.stringify(stored)).not.toContain("MARKER_D1");
		} finally {
			cleanup();
		}
	});

	test("a used skills lookup adds its section after the documents, and the record and summary say so", async () => {
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			recall: async () => recalled,
			ground: async () => grounded,
			skills: async () => skillHits,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const context = contextOf(result);
			const at = (needle: string) => context.indexOf(needle);
			expect(at("## Documents (RAGFlow)")).toBeGreaterThan(-1);
			expect(at("## Documents (RAGFlow)")).toBeLessThan(at("## Relevant skills"));
			expect(at("## Relevant skills")).toBeLessThan(at("<BUILD_PROMPT>"));
			expect(context).toContain("MARKER_S1");
			expect(result.output?.systemMessage).toContain("Skills · 1 recalled");

			// The record keeps the lookup, never skill text, and reads back from disk.
			expect(result.record?.skills).toMatchObject({
				outcome: "used",
				count: 1,
				names: ["lesson-bun-test"],
			});
			const stored = readSession(deps.stateDir, "s1");
			expect(stored?.skills).toEqual(result.record?.skills);
			expect(JSON.stringify(stored)).not.toContain("MARKER_S1");
		} finally {
			cleanup();
		}
	});

	test("off, none and error lookups leave the planner text exactly as without them", async () => {
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
		});
		try {
			const base = await runPromptSubmit(input, deps);
			const quiet: Array<[RecallOutcome, GroundOutcome]> = [
				[
					{ status: "off", lessons: [], source: "none", chars: 0, ms: 0, reason: "disabled" },
					{ status: "off", chunks: [], chars: 0, ms: 0, datasets: 0, reason: "grounding is off" },
				],
				[
					{ status: "none", lessons: [], source: "none", chars: 0, ms: 1 },
					{ status: "none", chunks: [], chars: 0, ms: 1, datasets: 1 },
				],
				[
					{
						status: "error",
						lessons: [],
						source: "none",
						chars: 0,
						ms: 1,
						reason: "hindsight unreachable",
					},
					{ status: "error", chunks: [], chars: 0, ms: 1, datasets: 0, reason: "auth" },
				],
			];
			for (const [lessons, docs] of quiet) {
				const result = await runPromptSubmit(input, {
					...deps,
					recall: async () => lessons,
					ground: async () => docs,
				});
				expect(plannedContext(result)).toEqual(plannedContext(base));
				expect(contextOf(result)).not.toContain("## Lessons from earlier work");
				expect(contextOf(result)).not.toContain("## Documents (RAGFlow)");
				const summary = result.output?.systemMessage ?? "";
				expect(summary).not.toContain("recalled");
				expect(summary).not.toContain("excerpt");
				if (lessons.status === "error") {
					expect(summary).toContain("Lessons · error (hindsight unreachable)");
					expect(summary).toContain("Docs · error (auth)");
				} else {
					expect(summary).not.toContain("Lessons");
					expect(summary).not.toContain("Docs");
				}
				expect(result.record?.lessons?.outcome).toBe(lessons.status);
				expect(result.record?.docs?.status).toBe(docs.status);
			}
		} finally {
			cleanup();
		}
	});

	test("with nothing configured only the local lessons and skills lookups run and nothing is contacted", async () => {
		const R = recordingFetch([() => new Response("")]);
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			decisionsDeps: { env: {}, storePath: tempStore(), fetch: R.fetch },
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.lessons).toMatchObject({ outcome: "none", count: 0 });
			expect(result.record?.skills).toMatchObject({ outcome: "none", count: 0 });
			expect(result.record).not.toHaveProperty("docs");
			expect(contextOf(result)).not.toContain("## Lessons from earlier work");
			expect(contextOf(result)).not.toContain("## Documents (RAGFlow)");
			expect(R.calls).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test("a throwing seam fails open: the plan is the same and the record names an error, not the message", async () => {
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
		});
		try {
			const base = await runPromptSubmit(input, deps);
			const result = await runPromptSubmit(input, {
				...deps,
				recall: async () => {
					throw new Error("add a widget: the prompt text leaked into this message");
				},
				ground: () => {
					throw new TypeError("synchronous failure with the prompt");
				},
			});
			expect(plannedContext(result)).toEqual(plannedContext(base));
			expect(result.record?.lessons).toMatchObject({ outcome: "error", count: 0, reason: "error" });
			expect(result.record?.docs).toMatchObject({ status: "error", count: 0, reason: "TypeError" });
			expect(JSON.stringify(result.record)).not.toContain("leaked");
			expect(result.output?.systemMessage).toContain("Lessons · error (error)");
			expect(result.output?.systemMessage).toContain("Docs · error (TypeError)");
		} finally {
			cleanup();
		}
	});

	test("a hanging seam is cut off by its timeout and an aborting one sees its signal fire", async () => {
		const config = echoConfig();
		config.teach.timeoutMs = 20;
		config.ragflow.timeoutMs = 20;
		const manual = manualTimers();
		const { deps, cleanup } = baseDeps({
			config,
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			timers: manual.timers,
		});
		try {
			const base = await runPromptSubmit(input, deps);
			// A lookup aborts at its 20 ms timeout and its deadline falls 150 ms later. The hung seams ignore the abort,
			// so only each deadline ends its wait.
			const hungRun = runPromptSubmit(input, { ...deps, recall: never, ground: never });
			await manual.fire(170);
			await manual.fire(170);
			const hung = await hungRun;
			expect(plannedContext(hung)).toEqual(plannedContext(base));
			expect(hung.record?.lessons).toMatchObject({ outcome: "error", reason: "timeout" });
			expect(hung.record?.docs).toMatchObject({ status: "error", reason: "timeout" });

			const signals: AbortSignal[] = [];
			const abortable = (signal: AbortSignal): Promise<never> => {
				signals.push(signal);
				const { promise, reject } = Promise.withResolvers<never>();
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				return promise;
			};
			const abortingRun = runPromptSubmit(input, {
				...deps,
				recall: ({ signal }) => abortable(signal),
				ground: ({ signal }) => abortable(signal),
			});
			// Each seam rejects on its lookup's abort, which fires at the 20 ms timeout.
			await manual.fire(20);
			await manual.fire(20);
			const aborted = await abortingRun;
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(plannedContext(aborted)).toEqual(plannedContext(base));
			expect(aborted.record?.lessons).toMatchObject({ outcome: "error", reason: "AbortError" });
			expect(aborted.record?.docs).toMatchObject({ status: "error", reason: "AbortError" });
		} finally {
			cleanup();
		}
	});

	test("both lookups start before the uplift call and see only the user's own words", async () => {
		const order: string[] = [];
		const queries: Array<{ query: string; cwd: string }> = [];
		const complete = smartComplete();
		const { deps, cleanup } = baseDeps({
			complete: async (system, user) => {
				if (user.includes("<user_request>")) {
					order.push("uplift");
					return UPLIFT("add a widget").replace(
						"</BUILD_PROMPT>",
						"<NOTES>SPEC_ONLY_TOKEN</NOTES></BUILD_PROMPT>",
					);
				}
				return complete(system, user);
			},
			clarify: async () => ({ items: [] }),
			conversation: () => "User: PRIOR_HISTORY_TOKEN\n\nAssistant: ok",
			recall: async ({ query, cwd }) => {
				order.push("recall");
				queries.push({ query, cwd });
				return recalled;
			},
			ground: async ({ query }) => {
				order.push("ground");
				queries.push({ query, cwd: "" });
				return grounded;
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(order.slice(0, 3).sort()).toEqual(["ground", "recall", "uplift"]);
			expect(order.indexOf("uplift")).toBe(2);
			expect(queries.map((q) => q.query)).toEqual(["add a widget", "add a widget"]);
			expect(queries[0]?.cwd).toBe("/repo");
			for (const { query } of queries) {
				expect(query).not.toContain("SPEC_ONLY_TOKEN");
				expect(query).not.toContain("PRIOR_HISTORY_TOKEN");
				expect(query).not.toContain("<BUILD_PROMPT");
			}
		} finally {
			cleanup();
		}
	});

	test("the query is cut to 1,500 characters", async () => {
		const queries: string[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			recall: async ({ query }) => {
				queries.push(query);
				return recalled;
			},
		});
		try {
			await runPromptSubmit({ ...input, prompt: `add a widget ${"x".repeat(3_000)}` }, deps);
			expect(queries).toHaveLength(1);
			expect(queries[0]).toHaveLength(1_500);
			expect(queries[0]?.startsWith("add a widget xxx")).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("skill invocations and uplift: prompts are planned, so they get lessons and documents too", async () => {
		const queries: string[] = [];
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			recall: async ({ query }) => {
				queries.push(query);
				return recalled;
			},
			ground: async () => grounded,
		});
		try {
			const skilled = await runPromptSubmit(
				{
					...input,
					prompt: "fix the login redirect",
					skill: {
						name: "gsd-quick",
						instruction: "fix the login redirect",
						summary: "Fast atomic task.",
						source: "omp",
					},
				},
				deps,
			);
			expect(contextOf(skilled)).toContain("MARKER_L1");
			expect(contextOf(skilled)).toContain("MARKER_D1");
			const forced = await runPromptSubmit({ ...input, prompt: "uplift: thanks" }, deps);
			expect(contextOf(forced)).toContain("MARKER_L1");
			expect(queries).toEqual(["fix the login redirect", "thanks"]);
		} finally {
			cleanup();
		}
	});

	test("a prompt the plan gate or the trivial check skips never looks anything up", async () => {
		const calls = { recall: 0, ground: 0 };
		const seams = {
			recall: async () => {
				calls.recall++;
				return recalled;
			},
			ground: async () => {
				calls.ground++;
				return grounded;
			},
		};
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, seams);
		try {
			expect((await runPromptSubmit({ ...input, prompt: ACK }, h.deps)).skipped).toBe("jev-skip");
			expect(
				(
					await runPromptSubmit(
						{ ...input, prompt: "thanks" },
						offDeps({ ...h.deps, config: trackedConfig() }),
					)
				).skipped,
			).toBe("skip");
			expect(calls).toEqual({ recall: 0, ground: 0 });
			// The same seams do run for a prompt that is planned.
			const planned = await runPromptSubmit(
				{ ...input, prompt: NEW_WORK },
				offDeps({ ...h.deps, config: trackedConfig() }),
			);
			expect(planned.record).toBeDefined();
			expect(calls).toEqual({ recall: 1, ground: 1 });
		} finally {
			h.cleanup();
		}
	});

	test("child invocations and subagent sessions never look anything up, and still plan", async () => {
		const calls = { recall: 0, ground: 0 };
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			recall: async () => {
				calls.recall++;
				return recalled;
			},
			ground: async () => {
				calls.ground++;
				return grounded;
			},
		});
		const saved = process.env.ULTRATHINK_CHILD;
		try {
			const subagent = { ...input, agent_id: "agent-7" };
			const sub = await runPromptSubmit(subagent, deps);
			expect(sub.record).toBeDefined();
			expect(contextOf(sub)).not.toContain("MARKER_L1");
			expect(calls).toEqual({ recall: 0, ground: 0 });

			process.env.ULTRATHINK_CHILD = "1";
			const child = await runPromptSubmit(input, deps);
			expect(child.record).toBeDefined();
			expect(contextOf(child)).not.toContain("MARKER_L1");
			expect(child.record).not.toHaveProperty("lessons");
			expect(calls).toEqual({ recall: 0, ground: 0 });
		} finally {
			if (saved === undefined) delete process.env.ULTRATHINK_CHILD;
			else process.env.ULTRATHINK_CHILD = saved;
			cleanup();
		}
	});

	test("the default wiring recalls from the local store and grounds only when configured, with no network", async () => {
		const R = recordingFetch([() => new Response("")]);
		const config = echoConfig();
		config.teach.enabled = true;
		config.ragflow.enabled = true;
		config.ragflow.ground = true;
		const { deps, cleanup } = baseDeps({
			config,
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			decisionsDeps: { env: {}, storePath: tempStore(), fetch: R.fetch },
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.lessons).toMatchObject({ outcome: "none", count: 0, source: "none" });
			expect(result.record?.docs).toMatchObject({ status: "off", count: 0 });
			expect(contextOf(result)).not.toContain("## Lessons from earlier work");
			expect(R.calls).toHaveLength(0);

			// The kill switch beats the config.
			const killed = await runPromptSubmit(input, {
				...deps,
				decisionsDeps: { env: { ULTRATHINK_TEACH: "0" }, storePath: tempStore(), fetch: R.fetch },
			});
			expect(killed.record?.lessons?.outcome).toBe("off");
			expect(R.calls).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});

describe("caller cancellation and the resolution record (D-12)", () => {
	/** An honest fixture record: CLI default delegation, no model claimed. */
	const RESOLUTION: ModelResolution = {
		version: "1.0.0",
		state: "default",
		host: "claude-code",
		transport: "claude-cli",
		source: "cli-default",
		reason: "cli-delegation",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		modelKnown: false,
		label: "claude:CLI default (model unobserved)",
	};
	/** Hook stage of each completer call, in run order: the graph and its node fills are one stage. */
	const STAGE = { uplift: 0, graph: 1, fill: 1, clarify: 2 } as const;
	type Phase = keyof typeof STAGE;
	const phaseOf = (user: string): Phase =>
		user.includes("<user_request>")
			? "uplift"
			: user.startsWith("<spec>")
				? "clarify"
				: user.includes("current_node")
					? "fill"
					: "graph";
	const noneKnowledge: KnowledgeResult = {
		lookup: { outcome: "none", docs: [], chars: 0, ms: 1 },
		digest: "",
	};

	/** Runs a plan whose seams record every completer phase and every write, so a test sees what started after cancellation. */
	async function cancelledRun(
		overrides: (controller: AbortController) => Partial<HookDeps>,
		onPhase?: (phase: Phase, controller: AbortController) => boolean,
	) {
		const controller = new AbortController();
		const phases: Phase[] = [];
		const events: ProgressEvent[] = [];
		let tracked = 0;
		const complete = smartComplete();
		const { deps, cleanup } = baseDeps({
			signal: controller.signal,
			modelResolution: RESOLUTION,
			progress: (event) => events.push(event),
			complete: async (system, user) => {
				const phase = phaseOf(user);
				phases.push(phase);
				// true: the provider honours the abort; false: it ignores it and answers anyway.
				if (onPhase?.(phase, controller) === true) throw new DOMException("aborted", "AbortError");
				return complete(system, user);
			},
			track: async () => {
				tracked++;
				return undefined;
			},
			...overrides(controller),
		});
		try {
			const caught = await runPromptSubmit(input, deps).then(
				() => undefined,
				(error: unknown) => error,
			);
			const specFile = sessionPath(deps.stateDir, "s1").replace(/\.json$/, ".xml");
			return {
				name: caught instanceof Error ? caught.name : undefined,
				phases,
				tracked,
				events,
				aborted: controller.signal.aborted,
				written:
					existsSync(sessionPath(deps.stateDir, "s1")) ||
					existsSync(specFile) ||
					existsSync(join(deps.stateDir, "last.json")),
			};
		} finally {
			cleanup();
		}
	}

	const ENDED: ProgressEvent = {
		type: "end",
		at: 1_000,
		outcome: "skipped",
		detail: "aborted",
		modelResolution: RESOLUTION,
	};

	test("a flight cancelled before it starts sends no gate request and starts no lookup, stage, tracker call or write", async () => {
		const R = recordingFetch([JEV(0.97)]);
		const lookups = { recall: 0, ground: 0 };
		const controller = new AbortController();
		controller.abort();
		const h = jevHarness(onConfig(), R.fetch, {
			signal: controller.signal,
			modelResolution: RESOLUTION,
			recall: async () => {
				lookups.recall++;
				return { status: "none", lessons: [], source: "none", chars: 0, ms: 0 };
			},
			ground: async () => {
				lookups.ground++;
				return { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
			},
		});
		try {
			const caught = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(caught instanceof Error ? caught.name : caught).toBe("AbortError");
			expect(R.calls).toHaveLength(0);
			expect(h.calls).toEqual({ engine: 0, track: 0, brief: 0, knowledge: 0 });
			expect(lookups).toEqual({ recall: 0, ground: 0 });
			expect(h.events).toEqual([]);
			expect(existsSync(sessionPath(h.deps.stateDir, "s1"))).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	test("a cancellation during any stage is re-thrown: no later stage, tracker call, write or delivery, even when the provider ignores it", async () => {
		for (const at of ["uplift", "graph", "fill", "clarify"] as const) {
			for (const honours of [true, false]) {
				const run = await cancelledRun(
					() => ({}),
					(phase, controller) => {
						if (phase !== at || controller.signal.aborted) return false;
						controller.abort();
						return honours;
					},
				);
				const label = { at, honours };
				expect({ ...label, name: run.name }).toEqual({ ...label, name: "AbortError" });
				expect({ ...label, later: run.phases.filter((phase) => STAGE[phase] > STAGE[at]) }).toEqual(
					{ ...label, later: [] },
				);
				expect({ ...label, tracked: run.tracked, written: run.written }).toEqual({
					...label,
					tracked: 0,
					written: false,
				});
				expect(run.events.some((event) => event.type === "stage" && event.stage === "state")).toBe(
					false,
				);
				expect(run.events.at(-1)).toEqual(ENDED);
			}
		}
	});

	for (const at of ["uplift", "graph", "fill", "clarify"] as const) {
		test(`a provider AbortError during ${at} cancels planning while the caller signal stays live`, async () => {
			const run = await cancelledRun(
				() => ({}),
				(phase) => phase === at,
			);
			const phases: Phase[] = [
				"uplift",
				"graph",
				"fill",
				"fill",
				"fill",
				"fill",
				"fill",
				"clarify",
			];
			expect(run.phases).toEqual(phases.slice(0, phases.indexOf(at) + 1));
			expect(run).toMatchObject({ name: "AbortError", aborted: false, tracked: 0, written: false });
			expect(
				run.events.some(
					(event) => event.type === "stage" && ["plan", "track", "state"].includes(event.stage),
				),
			).toBe(false);
			expect(run.events.at(-1)).toEqual(ENDED);
		});
	}

	test("an injected clarifier AbortError cancels planning without relying on the completer or caller signal", async () => {
		const run = await cancelledRun(() => ({
			clarify: async () => {
				throw new DOMException("provider cancelled", "AbortError");
			},
		}));
		expect(run).toMatchObject({ name: "AbortError", aborted: false, tracked: 0, written: false });
		expect(run.events.at(-1)).toEqual(ENDED);
	});

	test("a provider cancellation aborts pending brief, evidence and knowledge work without waiting for their deadlines", async () => {
		const config = trackedConfig();
		config.claude.budgetMs = 0;
		config.teach.timeoutMs = 60_000;
		config.ragflow.timeoutMs = 60_000;
		const controller = new AbortController();
		const signals: Record<string, AbortSignal | undefined> = {};
		let reads = 0;
		let closed = 0;
		const pending = (name: string, signal: AbortSignal | undefined): Promise<never> => {
			signals[name] = signal;
			// Deliberately ignores abort: the hook must release its bounded waiters itself.
			return Promise.withResolvers<never>().promise;
		};
		const { deps, cleanup } = baseDeps({
			config,
			signal: controller.signal,
			complete: async () => {
				throw new DOMException("provider cancelled", "AbortError");
			},
			brief: ({ signal }) => pending("brief", signal),
			recall: ({ signal }) => pending("recall", signal),
			ground: ({ signal }) => pending("ground", signal),
			skills: ({ signal }) => pending("skills", signal),
			knowledge: {
				start: ({ signal }) => {
					signals.knowledge = signal;
					return {
						read: async () => {
							reads++;
							return noneKnowledge;
						},
						close: () => {
							closed++;
						},
					};
				},
			},
		});
		try {
			const caught = await runPromptSubmit(input, deps).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(caught instanceof Error ? caught.name : caught).toBe("AbortError");
			expect(controller.signal.aborted).toBe(false);
			expect(Object.keys(signals).sort()).toEqual([
				"brief",
				"ground",
				"knowledge",
				"recall",
				"skills",
			]);
			for (const [name, signal] of Object.entries(signals))
				expect({ name, aborted: signal?.aborted }).toEqual({ name, aborted: true });
			expect({ reads, closed }).toEqual({ reads: 0, closed: 1 });
			expect(existsSync(deps.stateDir)).toBe(false);
		} finally {
			controller.abort();
			cleanup();
		}
	});

	for (const honours of [true, false]) {
		test(`a provider-aborted fill cancels its ${honours ? "signal-honouring" : "signal-ignoring"} sibling and prevents queued fills`, async () => {
			const config = trackedConfig();
			config.claude.concurrency = 2;
			config.claude.budgetMs = 0;
			const controller = new AbortController();
			const first = Promise.withResolvers<string>();
			const sibling = Promise.withResolvers<string>();
			const siblingStarted = Promise.withResolvers<void>();
			const calls: string[] = [];
			const events: ProgressEvent[] = [];
			let siblingSignal: AbortSignal | undefined;
			let tracked = 0;
			const complete = smartComplete();
			const { deps, cleanup } = baseDeps({
				config,
				signal: controller.signal,
				modelResolution: RESOLUTION,
				progress: (event) => events.push(event),
				complete: async (system, user, signal) => {
					const phase = phaseOf(user);
					const id = user.match(/current_node id="([^"]+)"/)?.[1];
					calls.push(id ?? phase);
					if (phase === "graph") {
						return JSON.stringify({
							goal: "Ship it",
							nodes: Array.from({ length: 5 }, (_, i) => ({
								id: `n${i + 1}`,
								title: `T${i + 1}`,
								kind: i === 0 ? "understand" : i === 4 ? "synthesize" : "generate",
								question: `Q${i + 1}`,
								depends_on: i < 3 ? [] : i === 3 ? ["n1", "n2", "n3"] : ["n4"],
							})),
						});
					}
					if (id === "n1") return first.promise;
					if (id === "n2") {
						siblingSignal = signal;
						if (honours)
							signal?.addEventListener(
								"abort",
								() => sibling.reject(new DOMException("aborted", "AbortError")),
								{ once: true },
							);
						siblingStarted.resolve();
						return sibling.promise;
					}
					return complete(system, user);
				},
				track: async () => {
					tracked++;
					return undefined;
				},
			});
			try {
				const running = runPromptSubmit(input, deps).then(
					() => undefined,
					(error: unknown) => error,
				);
				await siblingStarted.promise;
				expect(siblingSignal?.aborted).toBe(false);
				first.reject(new DOMException("provider cancelled", "AbortError"));
				const caught = await running;
				// A late success from an ignoring provider must not release its worker to start n3.
				sibling.resolve("<node><rationale>step</rationale><conclusion>late</conclusion></node>");
				// The late settlement is promise-driven: a bounded microtask flush delivers it, no macrotask needed.
				for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
				expect(caught instanceof Error ? caught.name : caught).toBe("AbortError");
				expect(controller.signal.aborted).toBe(false);
				expect(siblingSignal?.aborted).toBe(true);
				expect(calls).toEqual(["uplift", "graph", "n1", "n2"]);
				expect(events.some((event) => event.type === "node" && event.phase === "done")).toBe(false);
				expect(events.at(-1)).toEqual(ENDED);
				expect(tracked).toBe(0);
				expect(existsSync(deps.stateDir)).toBe(false);
			} finally {
				controller.abort();
				first.resolve("");
				sibling.resolve("");
				cleanup();
			}
		});
	}

	test("a cancellation seen by the brief, a lookup, the knowledge base or the tracker ends the flight at the next boundary", async () => {
		const cases: Array<{
			name: string;
			seams: (controller: AbortController) => Partial<HookDeps>;
			later: Phase[];
		}> = [
			{
				name: "brief",
				seams: (controller) => ({
					brief: async () => {
						controller.abort();
						return briefOf("## Substrate brief");
					},
				}),
				later: ["uplift", "graph", "fill", "clarify"],
			},
			{
				name: "recall",
				seams: (controller) => ({
					recall: async () => {
						controller.abort();
						return { status: "none", lessons: [], source: "none", chars: 0, ms: 0 };
					},
				}),
				later: ["uplift", "graph", "fill", "clarify"],
			},
			{
				name: "knowledge",
				seams: (controller) => ({
					knowledge: {
						start: () => ({
							read: async () => {
								controller.abort();
								return noneKnowledge;
							},
							close: () => {
								// reason: the fixture holds no resource to release
							},
						}),
					},
				}),
				later: ["clarify"],
			},
			{
				name: "track",
				seams: (controller) => ({
					track: async () => {
						controller.abort();
						return undefined;
					},
				}),
				later: [],
			},
		];
		for (const { name, seams, later } of cases) {
			const run = await cancelledRun(seams);
			expect({ name, aborted: run.aborted, error: run.name }).toEqual({
				name,
				aborted: true,
				error: "AbortError",
			});
			expect({ name, later: run.phases.filter((phase) => later.includes(phase)) }).toEqual({
				name,
				later: [],
			});
			// The session record is saved before the tracker runs, so only the tracker case finds it on disk.
			expect({ name, written: run.written }).toEqual({ name, written: name === "track" });
			expect(run.events.at(-1)).toEqual(ENDED);
		}
	});

	test("a cancelled flight releases a lookup that ignores its signal at once", async () => {
		const config = trackedConfig();
		config.teach.timeoutMs = 60_000;
		const controller = new AbortController();
		const lookupSignals: AbortSignal[] = [];
		const { deps, cleanup } = baseDeps({
			config,
			signal: controller.signal,
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			recall: ({ signal }) => {
				lookupSignals.push(signal);
				return Promise.withResolvers<never>().promise;
			},
			// The caller aborts just as the plan starts waiting for the lookups (the brief has settled).
			progress: (event) => {
				if (event.type === "stage" && event.stage === "brief" && event.phase === "end")
					controller.abort();
			},
		});
		try {
			// Without the release this waits out the 60 s lookup deadline and the test times out.
			const caught = await runPromptSubmit(input, deps).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(caught instanceof Error ? caught.name : caught).toBe("AbortError");
			expect(lookupSignals).toHaveLength(1);
			expect(lookupSignals[0]?.aborted).toBe(true);
			expect(existsSync(sessionPath(deps.stateDir, "s1"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("every stage gets the one planning lifetime, which the caller's signal aborts", async () => {
		const controller = new AbortController();
		const seen: Record<string, AbortSignal | undefined> = {};
		const complete = smartComplete();
		const { deps, cleanup } = baseDeps({
			signal: controller.signal,
			complete: async (system, user, signal) => {
				seen[phaseOf(user)] = signal;
				return complete(system, user);
			},
			brief: async ({ signal }) => {
				seen.brief = signal;
				return NO_BRIEF;
			},
			knowledge: {
				start: ({ signal }) => {
					seen.knowledge = signal;
					return {
						read: async () => noneKnowledge,
						close: () => {
							// reason: the fixture holds no resource to release
						},
					};
				},
			},
			track: async ({ signal }) => {
				seen.track = signal;
				return undefined;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record).toBeDefined();
			const names = ["brief", "clarify", "fill", "graph", "knowledge", "track", "uplift"];
			expect(Object.keys(seen).sort()).toEqual(names);
			for (const name of names)
				expect({ name, aborted: seen[name]?.aborted }).toEqual({ name, aborted: false });
			controller.abort();
			for (const name of names)
				expect({ name, aborted: seen[name]?.aborted }).toEqual({ name, aborted: true });
		} finally {
			cleanup();
		}
	});

	test("the hook budget alone is not cancellation: it still delivers the plan built so far", async () => {
		const config = trackedConfig();
		config.claude = { ...config.claude, budgetMs: 30 };
		const complete = smartComplete();
		const manual = manualTimers();
		const graphStarted = Promise.withResolvers<void>();
		const { deps, cleanup } = baseDeps({
			config,
			timers: manual.timers,
			signal: new AbortController().signal,
			modelResolution: RESOLUTION,
			clarify: async () => ({ items: [] }),
			complete: async (system, user, signal) => {
				if (phaseOf(user) !== "graph") return complete(system, user);
				graphStarted.resolve();
				// The graph call outlives the budget and honours its signal.
				return new Promise<string>((_resolve, reject) =>
					signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					),
				);
			},
		});
		try {
			const running = runPromptSubmit(input, deps);
			// The budget fires only once the graph call is in flight, so only the budget can end it.
			await graphStarted.promise;
			await manual.fire(30);
			const result = await running;
			expect(result.skipped).toBeUndefined();
			expect(result.output).toBeDefined();
			expect(result.record?.graph).toBeUndefined();
			expect(result.record?.modelResolution).toEqual(RESOLUTION);
		} finally {
			cleanup();
		}
	});

	for (const at of ["uplift", "fill", "clarify"] as const) {
		test(`the hook budget expiring during ${at} retains its budget-only result instead of cancelling the flight`, async () => {
			const config = trackedConfig();
			config.claude.budgetMs = 30;
			const controller = new AbortController();
			const complete = smartComplete();
			const phases: Phase[] = [];
			const manual = manualTimers();
			const reached = Promise.withResolvers<void>();
			const { deps, cleanup } = baseDeps({
				config,
				signal: controller.signal,
				timers: manual.timers,
				complete: async (system, user, signal) => {
					const phase = phaseOf(user);
					phases.push(phase);
					if (phase !== at) return complete(system, user);
					reached.resolve();
					return new Promise<string>((_resolve, reject) => {
						const abort = (): void => reject(new DOMException("budget expired", "AbortError"));
						if (signal?.aborted) abort();
						else signal?.addEventListener("abort", abort, { once: true });
					});
				},
			});
			try {
				const running = runPromptSubmit(input, deps);
				// The budget fires once the phase under test is in flight, so only the budget can end it.
				await reached.promise;
				await manual.fire(30);
				const result = await running;
				expect(controller.signal.aborted).toBe(false);
				expect(phases.at(-1)).toBe(at);
				if (at === "uplift") {
					expect(result.skipped).toBe("uplift-failed");
					expect(result.output).toBeUndefined();
					expect(existsSync(deps.stateDir)).toBe(false);
				} else {
					expect(result.skipped).toBeUndefined();
					expect(result.output).toBeDefined();
					expect(result.record?.result.source).toBe("llm");
					expect(Boolean(result.record?.graph)).toBe(true);
					if (at === "fill") {
						// The abort carried the graph as far as it got: no fill finished, so every node is marked, none invented.
						const nodes = result.record?.graph?.nodes ?? [];
						expect(nodes.length).toBeGreaterThan(0);
						expect(nodes.every((node) => node.degraded === true && !node.conclusion)).toBe(true);
						expect(result.record?.degraded).toContain("think");
					}
					expect(readSession(deps.stateDir, "s1")).toBeDefined();
				}
			} finally {
				cleanup();
			}
		});
	}

	test("the safe record reaches begin, end and the persisted plan; skips and Jev skips persist nothing", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			modelResolution: RESOLUTION,
			progress: (event) => events.push(event),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.modelResolution).toEqual(RESOLUTION);
			expect(readSession(deps.stateDir, "s1")?.modelResolution).toEqual(RESOLUTION);
			expect(events[0]).toMatchObject({
				type: "begin",
				engine: "claude:claude-haiku-5-5",
				modelResolution: RESOLUTION,
			});
			expect(events.at(-1)).toEqual({
				type: "end",
				at: 1_000,
				outcome: "planned",
				modelResolution: RESOLUTION,
			});
		} finally {
			cleanup();
		}

		const trivial = baseDeps({ modelResolution: RESOLUTION });
		try {
			expect(await runPromptSubmit({ ...input, prompt: "ok" }, trivial.deps)).toEqual({
				skipped: "skip",
				reason: "trivial",
			});
			expect(existsSync(sessionPath(trivial.deps.stateDir, "s1"))).toBe(false);
		} finally {
			trivial.cleanup();
		}

		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, { modelResolution: RESOLUTION });
		try {
			const skipped = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(skipped.skipped).toBe("jev-skip");
			expect(skipped.record).toBeUndefined();
			expect(h.events).toEqual([]);
			expect(existsSync(sessionPath(h.deps.stateDir, "s1"))).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});

describe("scheduled session retention", () => {
	/** The fixed clock the sweep reads through setSystemTime; the seeded record ages relative to it. */
	const FIXED_NOW = Date.UTC(2026, 9, 25);

	/** A record 90 days before FIXED_NOW, written straight to disk: its mtime, set from the fixed clock, ages it. */
	function seedOldSession(stateDir: string): string {
		const sessions = join(stateDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const path = join(sessions, "old-session.json");
		writeFileSync(
			path,
			JSON.stringify({
				sessionId: "old-session",
				at: 0,
				result: { xml: "", original: "old", root: "", source: "llm" },
			}),
		);
		const aged = (FIXED_NOW - 90 * 86_400_000) / 1000;
		utimesSync(path, aged, aged);
		return path;
	}

	test("with state.retentionDays above 0 a planned prompt sweeps old sessions and keeps its own", async () => {
		const config = trackedConfig();
		config.state.retentionDays = 30;
		const { deps, cleanup } = baseDeps({ config });
		try {
			setSystemTime(FIXED_NOW);
			const old = seedOldSession(deps.stateDir);
			const result = await runPromptSubmit(input, deps);
			expect(result.record).toBeDefined();
			expect(existsSync(old)).toBe(false);
			expect(readSession(deps.stateDir, "s1")).toBeDefined();
		} finally {
			setSystemTime();
			cleanup();
		}
	});

	test("by default (state.retentionDays 0) nothing is ever removed", async () => {
		const { deps, cleanup } = baseDeps();
		try {
			const old = seedOldSession(deps.stateDir);
			await runPromptSubmit(input, deps);
			expect(existsSync(old)).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("honest degradation (98-04)", () => {
	const stageEnd = (events: ProgressEvent[], name: string): ProgressEvent | undefined =>
		events.find((e) => e.type === "stage" && e.stage === name && e.phase === "end");

	/** A graph the think stage got partway through: n1 filled, n2 and n3 still empty. */
	const partialGraph = (): ThoughtGraph => ({
		goal: "ship the widget",
		nodes: [
			{
				id: "n1",
				title: "Understand",
				kind: "understand",
				question: "What is asked?",
				dependsOn: [],
				thinking: "1. a 2. b 3. c 4. d 5. e",
				conclusion: "c n1",
			},
			{
				id: "n2",
				title: "Decompose",
				kind: "decompose",
				question: "What parts?",
				dependsOn: ["n1"],
				degraded: true,
			},
			{
				id: "n3",
				title: "Plan",
				kind: "synthesize",
				question: "What order?",
				dependsOn: ["n2"],
			},
		],
	});

	test("a think stage that throws keeps the partial graph it carries, marks the unfilled nodes, and ends ok=false", async () => {
		const events: ProgressEvent[] = [];
		const graph = partialGraph();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			progress: (e) => events.push(e),
			think: async () => {
				throw Object.assign(
					new Error("think exploded sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
					{
						graph,
					},
				);
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.graph?.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
			expect(result.record?.graph?.nodes[0]?.conclusion).toBe("c n1");
			expect(result.record?.result.xml).toContain("<GRAPH_OF_THOUGHT");
			expect(result.record?.degraded).toEqual(["fill:n2", "fill:n3", "think"]);
			expect(stageEnd(events, "think")).toMatchObject({ ok: false });
			const detail = (stageEnd(events, "think") as { detail?: string } | undefined)?.detail ?? "";
			expect(detail).toContain("think exploded");
			expect(detail).not.toContain("sk-ant-api03");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("the think step (think exploded");
			expect(ctx).not.toContain("sk-ant-api03");
			// A real (partial) graph still plans: its rows are not boilerplate, only the unfilled nodes are.
			expect(result.record?.plan?.issues).toHaveLength(3);
		} finally {
			cleanup();
		}
	});

	test("the uplift stage ends ok=false for a fallback uplift and ok=true for a model one, with the reason in the detail (G-10)", async () => {
		const llm: ProgressEvent[] = [];
		const good = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [] }),
			progress: (e) => llm.push(e),
		});
		try {
			await runPromptSubmit(input, good.deps);
			expect(stageEnd(llm, "uplift")).toMatchObject({ ok: true });
		} finally {
			good.cleanup();
		}

		const fallback: ProgressEvent[] = [];
		const complete = smartComplete();
		const bad = baseDeps({
			complete: async (system, user) =>
				user.includes("<user_request>")
					? "<UPLIFTED_PROMPT><SYSTEM_ROLE>r</SYSTEM_ROLE>"
					: complete(system, user),
			clarify: async () => ({ items: [] }),
			progress: (e) => fallback.push(e),
		});
		try {
			const result = await runPromptSubmit(input, bad.deps);
			expect(result.record?.result.source).toBe("fallback");
			expect(stageEnd(fallback, "uplift")).toMatchObject({
				ok: false,
				detail: expect.stringContaining("fallback · truncated_reply"),
			});
		} finally {
			bad.cleanup();
		}
	});

	test("a think stage that throws with no graph records think, creates no tracker rows, and still delivers the spec", async () => {
		const events: ProgressEvent[] = [];
		let tracked = 0;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			progress: (e) => events.push(e),
			think: async () => {
				throw new Error("provider down");
			},
			track: async () => {
				tracked += 1;
				return undefined;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.degraded).toEqual(["think"]);
			expect(result.record?.graph).toBeUndefined();
			expect(result.record?.plan).toBeUndefined();
			expect(tracked).toBe(0);
			expect(stageEnd(events, "think")).toMatchObject({ ok: false, detail: "provider down" });
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("the think step (provider down)");
			expect(ctx).toContain("No tracker rows were created for this plan, and none will be.");
		} finally {
			cleanup();
		}
	});

	test("a boilerplate graph from a failed graph call is recorded and never becomes tracker rows", async () => {
		const events: ProgressEvent[] = [];
		const logs: string[] = [];
		let tracked = 0;
		const smart = smartComplete();
		const { deps, cleanup } = baseDeps({
			complete: async (system, user) => {
				const graphCall =
					!user.includes("<user_request>") &&
					!user.startsWith("<spec>") &&
					!user.includes("current_node");
				return graphCall ? "not a graph" : smart(system, user);
			},
			progress: (e) => events.push(e),
			log: (m) => logs.push(m),
			track: async () => {
				tracked += 1;
				return undefined;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.result.source).toBe("llm");
			expect(result.record?.degraded).toContain("graph");
			expect(result.record?.plan).toBeUndefined();
			expect(tracked).toBe(0);
			expect(events.some((e) => e.type === "stage" && e.stage === "plan")).toBe(false);
			expect(events.some((e) => e.type === "stage" && e.stage === "track")).toBe(false);
			expect(logs.some((m) => m.includes("graph-fallback"))).toBe(true);
			expect(stageEnd(events, "think")).toMatchObject({ ok: false });
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("No tracker rows were created for this plan, and none will be.");
		} finally {
			cleanup();
		}
	});

	test("fills that stayed failed are tagged for the failed node ids only, in the rows' log line and the spec", async () => {
		const events: ProgressEvent[] = [];
		const logs: string[] = [];
		const config = trackedConfig();
		config.think.fillRetries = 0;
		config.think.repair = false;
		const smart = smartComplete();
		const { deps, cleanup } = baseDeps({
			config,
			complete: async (system, user) => {
				if (user.includes('current_node id="n2"')) throw new Error("fill n2 refused");
				return smart(system, user);
			},
			progress: (e) => events.push(e),
			log: (m) => logs.push(m),
			track: async ({ plan }) => ({
				graphId: plan.graphId,
				status: "complete",
				linearTeam: "Team",
				linear: { nodes: {}, steps: {} },
				notion: { nodes: {}, steps: {} },
				errors: [],
				updatedAt: 1_000,
			}),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.degraded).toEqual(["fill:n2"]);
			expect(result.record?.plan).toBeDefined();
			expect(stageEnd(events, "think")).toMatchObject({ ok: false });
			const tracking = logs.find((m) => m.startsWith("tracking complete"));
			expect(tracking).toContain("degraded fill:n2");
			expect(tracking).not.toContain("fill:n1");
			const spec = readFileSync(join(deps.stateDir, "sessions", "s1.xml"), "utf8");
			expect(spec.match(/degraded="true"/g)).toHaveLength(1);
			expect(spec).toMatch(/<NODE id="n2"[^>]* degraded="true"/);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("the n2 fill (");
			expect(ctx).toContain("fill n2 refused");
		} finally {
			cleanup();
		}
	});

	test("a clarify failure ends clarify ok=false with the cause, lands in the record and the notice, never as 0 questions ok", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			progress: (e) => events.push(e),
			clarify: async () => ({ items: [], failed: "reply was not JSON" }),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(stageEnd(events, "clarify")).toMatchObject({
				ok: false,
				detail: "reply was not JSON",
			});
			expect(result.record?.degraded).toEqual(["clarify"]);
			expect(result.record?.clarifications).toEqual([]);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("the clarify step (reply was not JSON)");
		} finally {
			cleanup();
		}
	});

	test("a thrown clarifier is recorded the same way, and salvaged leading items are kept", async () => {
		const open: Clarification = {
			id: "q1",
			question: "Which database?",
			header: "DB",
			why: "w",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
			default: "Postgres",
			blocking: true,
		};
		const thrown = baseDeps({
			complete: smartComplete(),
			clarify: async () => {
				throw new Error("clarify down");
			},
		});
		const salvaged = baseDeps({
			complete: smartComplete(),
			clarify: async () => ({ items: [open], failed: "reply cut off" }),
		});
		try {
			const a = await runPromptSubmit(input, thrown.deps);
			expect(a.record?.degraded).toEqual(["clarify"]);
			expect(a.output?.hookSpecificOutput.additionalContext).toContain(
				"the clarify step (clarify down)",
			);
			const b = await runPromptSubmit(input, salvaged.deps);
			expect(b.record?.clarifications).toEqual([open]);
			expect(b.record?.degraded).toEqual(["clarify"]);
		} finally {
			thrown.cleanup();
			salvaged.cleanup();
		}
	});

	test("a route whose completer owns the flight limiter gets no second one from the think stage (G-11)", async () => {
		const owned = new FlightThrottle({ max: 1 });
		let seen: RunThinkOptions | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			throttle: owned,
			think: async (opts) => {
				seen = opts;
				return runThink(opts);
			},
		});
		try {
			await runPromptSubmit(input, deps);
			// The completer acquires from `owned` per call: a second slot taken by the fills would deadlock at a limit of one.
			expect(seen).toBeDefined();
			expect(seen?.throttle).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("the think stage gets the configured retries, repair, and one per-flight throttle capped at three", async () => {
		const config = trackedConfig();
		config.claude.concurrency = 8;
		config.think.fillRetries = 4;
		config.think.repair = false;
		let seen: RunThinkOptions | undefined;
		const { deps, cleanup } = baseDeps({
			config,
			complete: smartComplete(),
			think: async (opts) => {
				seen = opts;
				return runThink(opts);
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(seen?.fillRetries).toBe(4);
			expect(seen?.repair).toBe(false);
			expect(seen?.throttle).toBeInstanceOf(FlightThrottle);
			expect(seen?.throttle?.limit).toBe(3);
		} finally {
			cleanup();
		}
		const low = trackedConfig();
		low.claude.concurrency = 2;
		const small = baseDeps({
			config: low,
			complete: smartComplete(),
			think: async (opts) => {
				seen = opts;
				return runThink(opts);
			},
		});
		try {
			await runPromptSubmit(input, small.deps);
			expect(seen?.throttle?.limit).toBe(2);
		} finally {
			small.cleanup();
		}
	});

	test("every deterministic skip runs before the engine, carries its reason, and an armed skip is spent only by its own skip", async () => {
		let engineCalls = 0;
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				engineCalls += 1;
				return "";
			},
		});
		try {
			const cases: Array<[string, string, Partial<HookDeps>?]> = [
				["/help", "command"],
				[UPLIFT("add a flag"), "already-uplifted"],
				["ok", "trivial"],
				["continue graph ut-abc-0123abcd", "graph-reference"],
				["add a widget", "disabled", { control: { enabled: false } }],
			];
			for (const [prompt, reason, extra] of cases) {
				const result = await runPromptSubmit({ ...input, prompt }, { ...deps, ...extra });
				expect(result).toEqual({ skipped: "skip", reason });
			}
			expect(engineCalls).toBe(0);

			// Armed, then a command: the flag stays for the real next prompt.
			armSkipOnce(deps.stateDir, "s1");
			const command = await runPromptSubmit({ ...input, prompt: "/help" }, deps);
			expect(command).toEqual({ skipped: "skip", reason: "command" });
			expect(readSkipOnce(deps.stateDir, "s1")).toBe(true);
			// The real prompt is skipped by the flag, and only now is it spent.
			const real = await runPromptSubmit(input, deps);
			expect(real).toEqual({ skipped: "skip", reason: "skip-once" });
			expect(readSkipOnce(deps.stateDir, "s1")).toBe(false);
			expect(engineCalls).toBe(0);
		} finally {
			cleanup();
		}
	});
});

describe("runPromptSubmit lock policy", () => {
	test("with no stateLock in the deps the plan save outwaits a 9 s hold of the session lock", async () => {
		const { deps, cleanup } = baseDeps();
		try {
			const first = await runPromptSubmit(input, deps);
			expect(first.record?.engine).toBe("claude:claude-haiku-5-5");
			// A live helper process holds the session lock for 9 s, then writes its own mark over the record it read. The
			// pipeline reaches the save a few seconds in, so a save that gave up after the 2 s default and wrote unlocked
			// would be overwritten by that stale write; the 15 s hook wait outlasts the hold.
			const holder = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
			import { updateSession } from ${JSON.stringify(join(import.meta.dir, "state.ts"))};
			updateSession(${JSON.stringify(deps.stateDir)}, "s1", record => {
				process.stdout.write("ready");
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 9000);
				return { ...record, workRepos: ["acme/widgets"], engine: "held-by-helper" };
			});
		`,
				],
				{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			const reader = holder.stdout.getReader();
			let ready = "";
			while (ready.length < "ready".length) {
				const chunk = await reader.read();
				if (chunk.done) break;
				ready += new TextDecoder().decode(chunk.value);
			}
			reader.releaseLock();
			expect(ready).toBe("ready");
			// The save blocks this thread on the lock; the helper releases it by itself.
			const second = await runPromptSubmit(input, { ...deps, engine: "claude:second-plan" });
			await holder.exited;
			expect(holder.exitCode).toBe(0);
			expect(second.record?.engine).toBe("claude:second-plan");
			const saved = readSession(deps.stateDir, "s1");
			// The helper's mark is carried onto the new plan, and the new plan is the record on disk.
			expect(saved?.engine).toBe("claude:second-plan");
			expect(saved?.workRepos).toEqual(["acme/widgets"]);
		} finally {
			cleanup();
		}
	}, 30_000);
});
