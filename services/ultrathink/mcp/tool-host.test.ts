// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionRecord, writeSession } from "../../../src/claude/state.ts";
import { journalDir, writeMeta } from "../../../src/host/grokbot.ts";
import type { ThoughtGraph } from "../../../src/think/types.ts";
import { buildGraphView } from "../engine/graph-view.ts";
import type { HeadlessPlanner, ResultView } from "../engine/headless.ts";
import type { JournalOptions } from "../engine/journal.ts";
import { type RequestContext, runWithRequestContext } from "../obs/context.ts";
import type { ToolOutcome } from "./mcp.ts";
import { createResourceRegistry } from "./resources.ts";
import { type ToolHostDeps, createToolHost, toOutcome } from "./tool-host.ts";
import { catalogFromOverlay } from "./tools-connector.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-tool-host-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GRAPH: ThoughtGraph = {
	goal: "Ship it",
	nodes: [
		{
			id: "n1",
			title: "Understand",
			kind: "understand",
			question: "What?",
			dependsOn: [],
			thinking: "1. Read.",
			conclusion: "Done.",
		},
		{
			id: "n2",
			title: "Plan",
			kind: "synthesize",
			question: "How?",
			dependsOn: ["n1"],
			thinking: "1. Order.",
			conclusion: "Ordered.",
		},
	],
};

const PLAN_TEXT = "# Ultrathink plan\n\nRequest: ship it";

function journalOptions(stateDir: string): JournalOptions {
	return { stateDir, maxPromptChars: 8000, maxAnswerChars: 20000 };
}

function record(sessionId: string): SessionRecord {
	return {
		sessionId,
		at: 1,
		result: { xml: "<BUILD_PROMPT/>", original: "Ship it", root: "BUILD_PROMPT", source: "llm" },
		graph: GRAPH,
	};
}

function serverView(sessionId: string, overrides: Partial<ResultView> = {}): ResultView {
	return {
		sessionId,
		status: "planned",
		mode: "server",
		text: PLAN_TEXT,
		questions: [{ question: "Which database?", default: "Postgres" }],
		graph: buildGraphView(record(sessionId)) ?? undefined,
		usage: { calls: 3, inputTokens: 10, outputTokens: 5 },
		...overrides,
	};
}

interface StubPlanner extends HeadlessPlanner {
	starts: unknown[];
	results: unknown[];
	serverIds: Set<string>;
}

function stubPlanner(
	enabled: boolean,
	view: (sessionId: string) => ResultView = serverView,
): StubPlanner {
	const stub: StubPlanner = {
		enabled,
		starts: [],
		results: [],
		serverIds: new Set(),
		upstream: () => undefined,
		backendReady: () => ({ ok: true }),
		async start(input) {
			stub.starts.push(input);
			return { ok: true, data: { sessionId: String(input.sessionId), status: "planned" } };
		},
		async result(input) {
			stub.results.push(input);
			return { ok: true, data: view(String(input.sessionId)) };
		},
		status(input) {
			const sessionId = String(input.sessionId);
			if (!stub.serverIds.has(sessionId)) return null;
			return { ok: true, data: { sessionId, status: "running", pendingCount: 0, pending: [] } };
		},
		async shutdown() {
			// reason: test double, the stub planner holds no state to release
		},
	};
	return stub;
}

function setup(options: Partial<ToolHostDeps> = {}) {
	const stateDir = tmp();
	const finished: ResultView[] = [];
	const host = createToolHost({
		journalOpts: journalOptions(stateDir),
		catalog: catalogFromOverlay(),
		onPlanFinished: (view) => finished.push(view),
		...options,
	});
	return { stateDir, host, finished };
}

function okOf(outcome: ToolOutcome): { data: Record<string, unknown>; text?: string } {
	if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
	return outcome.text === undefined
		? { data: outcome.data }
		: { data: outcome.data, text: outcome.text };
}

describe("capabilities", () => {
	test("serverPlanning follows the planner and is false without one", () => {
		expect(setup().host.capabilities()).toEqual({ serverPlanning: false });
		expect(setup({ planner: stubPlanner(false) }).host.capabilities()).toEqual({
			serverPlanning: false,
		});
		expect(setup({ planner: stubPlanner(true) }).host.capabilities()).toEqual({
			serverPlanning: true,
		});
	});

	test("resources are exposed only when a registry is given", () => {
		expect(setup().host.resources).toBeUndefined();
		const registry = createResourceRegistry([]);
		expect(setup({ resources: registry }).host.resources).toBe(registry);
	});
});

describe("toOutcome", () => {
	test("maps a journal result to a tool outcome and keeps errors only when present", () => {
		expect(toOutcome({ ok: true, data: { a: 1 } })).toEqual({ ok: true, data: { a: 1 } });
		expect(toOutcome({ ok: false, code: "not_found" })).toEqual({ ok: false, code: "not_found" });
		expect(toOutcome({ ok: false, code: "invalid_answer", errors: ["x"] })).toEqual({
			ok: false,
			code: "invalid_answer",
			errors: ["x"],
		});
	});
});

describe("the original tools", () => {
	test("an unknown tool name is unknown_tool", async () => {
		expect(await setup().host.call("ultrathink_delete", {})).toEqual({
			ok: false,
			code: "unknown_tool",
		});
	});

	test("ultrathink_plan starts a journal session on disk and ultrathink_status reports it", async () => {
		const { host } = setup();
		const started = okOf(await host.call("ultrathink_plan", { prompt: "plan the rollout" }));
		expect(started.data.status).toBe("needs-model");
		const sessionId = String(started.data.sessionId);
		const pending = okOf(await host.call("ultrathink_pending", { sessionId }));
		expect(Array.isArray(pending.data.pending) ? pending.data.pending.length : 0).toBeGreaterThan(
			0,
		);
		expect(okOf(await host.call("ultrathink_status", { sessionId })).data).toMatchObject({
			sessionId,
			status: "needs-model",
		});
	});

	test("ultrathink_status asks the planner first and falls back to the journal", async () => {
		const planner = stubPlanner(true);
		const { host } = setup({ planner });
		const serverId = randomUUID();
		planner.serverIds.add(serverId);
		expect(okOf(await host.call("ultrathink_status", { sessionId: serverId })).data).toMatchObject({
			sessionId: serverId,
			status: "running",
		});
		expect(await host.call("ultrathink_status", { sessionId: "../etc" })).toEqual({
			ok: false,
			code: "invalid_session_id",
		});
	});

	test("ultrathink_plan refuses a session id owned by a server job and leaves its session and job files alone", async () => {
		const planner = stubPlanner(true);
		const { host, stateDir } = setup({ planner });
		const sessionId = randomUUID();
		planner.serverIds.add(sessionId);
		writeSession(stateDir, record(sessionId));
		const jobPath = join(stateDir, "jobs", `${sessionId}.json`);
		mkdirSync(join(stateDir, "jobs"), { recursive: true });
		writeFileSync(
			jobPath,
			JSON.stringify({
				sessionId,
				status: "planned",
				usage: { calls: 3, inputTokens: 10, outputTokens: 5 },
			}),
		);
		const sessionPath = join(stateDir, "sessions", `${sessionId}.json`);
		const before = {
			session: readFileSync(sessionPath, "utf8"),
			job: readFileSync(jobPath, "utf8"),
		};

		expect(await host.call("ultrathink_plan", { prompt: "plan the rollout", sessionId })).toEqual({
			ok: false,
			code: "session_conflict",
		});

		expect(readFileSync(sessionPath, "utf8")).toBe(before.session);
		expect(readFileSync(jobPath, "utf8")).toBe(before.job);
		expect(existsSync(journalDir(stateDir, sessionId))).toBe(false);
	});

	test("ultrathink_uplift needs a planner", async () => {
		expect(await setup().host.call("ultrathink_uplift", { prompt: "plan it" })).toEqual({
			ok: false,
			code: "disabled",
		});
	});

	test("ultrathink_uplift counts a start that already finished, from its finished view", async () => {
		const planner = stubPlanner(true);
		const { host, finished } = setup({ planner });
		const sessionId = randomUUID();
		const started = okOf(await host.call("ultrathink_uplift", { prompt: "plan it", sessionId }));
		expect(started.data).toEqual({ sessionId, status: "planned" });
		expect(started.text).toBeUndefined();
		expect(planner.starts).toEqual([{ prompt: "plan it", sessionId }]);
		expect(planner.results).toEqual([{ sessionId, waitSeconds: 0 }]);
		expect(finished.map((view) => view.sessionId)).toEqual([sessionId]);
	});

	test("ultrathink_uplift does not count a running start", async () => {
		const planner = stubPlanner(true);
		planner.start = async (input) => ({
			ok: true,
			data: { sessionId: String(input.sessionId), status: "running", pollAfterSec: 5 },
		});
		const { host, finished } = setup({ planner });
		await host.call("ultrathink_uplift", { prompt: "plan it", sessionId: randomUUID() });
		expect(planner.results).toEqual([]);
		expect(finished).toEqual([]);
	});
});

describe("ultrathink_result", () => {
	test("the plan text is the content and also stays in the structured data, next to every other field", async () => {
		const planner = stubPlanner(true);
		const { host } = setup({ planner });
		const sessionId = randomUUID();
		const { data, text } = okOf(
			await host.call("ultrathink_result", { sessionId, waitSeconds: 0, detail: "full" }),
		);
		expect(text).toBe(PLAN_TEXT);
		expect(data.text).toBe(PLAN_TEXT);
		expect(data).toMatchObject({
			sessionId,
			status: "planned",
			mode: "server",
			questions: [{ question: "Which database?", default: "Postgres" }],
		});
		expect(data.graph).toEqual(buildGraphView(record(sessionId)));
		expect(planner.results).toEqual([{ sessionId, waitSeconds: 0, detail: "full" }]);
	});

	test("each finished server plan is reported once, however often it is read and through either tool", async () => {
		const planner = stubPlanner(true);
		const { host, finished } = setup({ planner });
		const sessionId = randomUUID();
		await host.call("ultrathink_result", { sessionId });
		await host.call("ultrathink_result", { sessionId });
		await host.call("ultrathink_graph", { sessionId });
		expect(finished).toHaveLength(1);
		await host.call("ultrathink_graph", { sessionId: randomUUID() });
		expect(finished).toHaveLength(2);
	});

	test("a running plan and a client-driven plan are not reported", async () => {
		const running = setup({
			planner: stubPlanner(true, (sessionId) =>
				serverView(sessionId, { status: "running", text: "still preparing" }),
			),
		});
		await running.host.call("ultrathink_result", { sessionId: randomUUID() });
		expect(running.finished).toEqual([]);
		const client = setup({
			planner: stubPlanner(false, (sessionId) => serverView(sessionId, { mode: "client" })),
		});
		await client.host.call("ultrathink_result", { sessionId: randomUUID() });
		expect(client.finished).toEqual([]);
	});

	test("a planner refusal is a refusal", async () => {
		const planner = stubPlanner(true);
		planner.result = async () => ({
			ok: false,
			code: "invalid_input",
			errors: ["waitSeconds must be a number"],
		});
		const { host } = setup({ planner });
		expect(await host.call("ultrathink_result", { sessionId: randomUUID() })).toEqual({
			ok: false,
			code: "invalid_input",
			errors: ["waitSeconds must be a number"],
		});
	});

	test("without a planner it reads client-driven sessions and validates its arguments", async () => {
		const { host, stateDir } = setup();
		expect(await host.call("ultrathink_result", { sessionId: "../etc" })).toEqual({
			ok: false,
			code: "invalid_session_id",
		});
		expect(await host.call("ultrathink_result", { sessionId: randomUUID(), detail: "x" })).toEqual({
			ok: false,
			code: "invalid_input",
		});
		expect(await host.call("ultrathink_result", { sessionId: randomUUID() })).toEqual({
			ok: false,
			code: "not_found",
		});

		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), {
			sessionId,
			original: "Ship it",
			status: "planned",
		});
		writeSession(stateDir, record(sessionId));
		const { data, text } = okOf(await host.call("ultrathink_result", { sessionId }));
		expect(data).toMatchObject({ sessionId, status: "planned", mode: "client" });
		expect(text).toContain("Ship it");
		expect(data.text).toBe(text);
		expect(data.graph).toEqual(buildGraphView(record(sessionId)));
	});

	test("without a planner a malformed waitSeconds is refused and a number is accepted and ignored", async () => {
		const { host, stateDir } = setup();
		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), {
			sessionId,
			original: "Ship it",
			status: "planned",
		});
		writeSession(stateDir, record(sessionId));
		for (const waitSeconds of ["5", Number.NaN, null, {}]) {
			expect(await host.call("ultrathink_result", { sessionId, waitSeconds })).toEqual({
				ok: false,
				code: "invalid_input",
			});
		}
		for (const waitSeconds of [0, 45, 1000, -3]) {
			const { data } = okOf(await host.call("ultrathink_result", { sessionId, waitSeconds }));
			expect(data).toMatchObject({ sessionId, status: "planned", mode: "client" });
		}
	});
});

describe("the connector tools", () => {
	test("are dispatched with the host's own state, planner and catalog", async () => {
		const { host, stateDir } = setup({ planningInfo: () => ({ serverPlanning: false }) });
		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), {
			sessionId,
			original: "Ship it",
			status: "planned",
		});
		writeSession(stateDir, record(sessionId));

		const graph = okOf(await host.call("ultrathink_graph", {}));
		expect(graph.data.sessionId).toBe(sessionId);
		expect(graph.data.text).toBe(graph.text);

		const sessions = okOf(await host.call("ultrathink_sessions", {}));
		expect(sessions.data.planning).toEqual({ serverPlanning: false });
		expect(sessions.text).toContain(sessionId);

		const help = okOf(await host.call("ultrathink_command", { command: "help" }));
		expect(help.data.support).toBe("native");
		expect(help.data.text).toBe(help.text);
	});
});

describe("ultrathink_cancel", () => {
	test("needs a planner that can cancel", async () => {
		const sessionId = randomUUID();
		expect(await setup().host.call("ultrathink_cancel", { sessionId })).toEqual({
			ok: false,
			code: "disabled",
		});
		expect(
			await setup({ planner: stubPlanner(true) }).host.call("ultrathink_cancel", { sessionId }),
		).toEqual({ ok: false, code: "disabled" });
	});

	test("asks the planner to cancel the session and reports its answer", async () => {
		const planner = stubPlanner(true);
		const cancels: unknown[] = [];
		planner.cancel = (input) => {
			cancels.push(input);
			return {
				ok: true,
				data: { sessionId: String(input.sessionId), status: "failed", error: "aborted" },
			};
		};
		const { host } = setup({ planner });
		const sessionId = randomUUID();
		expect(await host.call("ultrathink_cancel", { sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "failed", error: "aborted" },
		});
		expect(cancels).toEqual([{ sessionId }]);
	});

	test("an unknown or finished session is the planner's not_found", async () => {
		const planner = stubPlanner(true);
		planner.cancel = () => ({ ok: false, code: "not_found" });
		const { host } = setup({ planner });
		expect(await host.call("ultrathink_cancel", { sessionId: randomUUID() })).toEqual({
			ok: false,
			code: "not_found",
		});
	});
});

describe("refusal hints and job outcomes", () => {
	test("toOutcome carries a retry hint as an error line", () => {
		expect(toOutcome({ ok: false, code: "busy", retryAfterSec: 30 })).toEqual({
			ok: false,
			code: "busy",
			errors: ["retry after 30s"],
		});
		expect(
			toOutcome({ ok: false, code: "busy", errors: ["queue full"], retryAfterSec: 30 }),
		).toEqual({ ok: false, code: "busy", errors: ["queue full", "retry after 30s"] });
	});

	test("ultrathink_uplift passes the planner's retry hint to the client", async () => {
		const planner = stubPlanner(true);
		planner.start = async () => ({ ok: false, code: "upstream_unavailable", retryAfterSec: 12 });
		const { host } = setup({ planner });
		expect(await host.call("ultrathink_uplift", { prompt: "plan it" })).toEqual({
			ok: false,
			code: "upstream_unavailable",
			errors: ["retry after 12s"],
		});
	});

	test("a job outcome is counted once, and a later poll of the same plan does not count it again", async () => {
		const planner = stubPlanner(true);
		const { host, finished } = setup({ planner });
		const sessionId = randomUUID();
		host.recordOutcome({
			sessionId,
			status: "planned",
			calls: 9,
			inputTokens: 100,
			outputTokens: 50,
			ms: 1234,
		});
		expect(finished).toHaveLength(1);
		expect(finished[0]).toMatchObject({
			sessionId,
			status: "planned",
			mode: "server",
			usage: { calls: 9, inputTokens: 100, outputTokens: 50 },
		});
		await host.call("ultrathink_result", { sessionId, waitSeconds: 0 });
		expect(finished).toHaveLength(1);
	});

	test("a failed outcome keeps its error", () => {
		const { host, finished } = setup({ planner: stubPlanner(true) });
		host.recordOutcome({
			sessionId: randomUUID(),
			status: "failed",
			error: "timeout",
			calls: 2,
			inputTokens: 0,
			outputTokens: 0,
			ms: 10,
		});
		expect(finished[0]).toMatchObject({ status: "failed", error: "timeout" });
	});
});

describe("client journals record their principal", () => {
	const admitted = (principal: string) => ({
		reqId: randomUUID(),
		traceId: "0".repeat(32),
		spanId: "0".repeat(16),
		admission: { principal, class: "connector" as const },
	});
	const ownerContext: RequestContext = {
		...admitted("owner"),
		admission: { principal: "owner", class: "owner" },
	};
	const metaOf = (stateDir: string, sessionId: string): Record<string, unknown> =>
		JSON.parse(readFileSync(join(journalDir(stateDir, sessionId), "meta.json"), "utf8")) as Record<
			string,
			unknown
		>;

	test("a session started by an admitted request names its principal in the journal meta, and answers keep it", async () => {
		const { host, stateDir } = setup();
		const started = await runWithRequestContext(admitted("key:alice"), () =>
			host.call("ultrathink_plan", { prompt: "plan the rollout" }),
		);
		const sessionId = String(okOf(started).data.sessionId);
		expect(metaOf(stateDir, sessionId).principal).toBe("key:alice");
		const again = await runWithRequestContext(admitted("key:bob"), () =>
			host.call("ultrathink_plan", { prompt: "plan the rollout", sessionId }),
		);
		expect(again.ok).toBe(true);
		expect(metaOf(stateDir, sessionId).principal).toBe("key:alice");
	});

	test("a session started without an admission records none", async () => {
		const { host, stateDir } = setup();
		const sessionId = String(
			okOf(await host.call("ultrathink_plan", { prompt: "plan the rollout" })).data.sessionId,
		);
		expect("principal" in metaOf(stateDir, sessionId)).toBe(false);
	});

	test("a journal whose run throws is still the caller's: another connector principal never lists it, an owner and stdio do", async () => {
		const stateDir = tmp();
		const host = createToolHost({
			journalOpts: {
				...journalOptions(stateDir),
				plan: async () => {
					throw new Error("the client journal died mid-run");
				},
			},
			catalog: catalogFromOverlay(),
		});
		const sessionId = randomUUID();
		const started = await runWithRequestContext(admitted("key:alice"), () =>
			host.call("ultrathink_plan", { prompt: "plan the rollout", sessionId }),
		);
		expect(started).toMatchObject({ ok: false, code: "engine_error" });
		const listed = async (ctx?: RequestContext): Promise<string[]> => {
			const run = () => host.call("ultrathink_sessions", {});
			const outcome = okOf(await (ctx === undefined ? run() : runWithRequestContext(ctx, run)));
			return (outcome.data.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
		};
		expect(await listed(admitted("key:alice"))).toEqual([sessionId]);
		expect(await listed(admitted("key:bob"))).toEqual([]);
		expect(await listed(ownerContext)).toEqual([sessionId]);
		expect(await listed()).toEqual([sessionId]);
	});

	test("a principal-less journal is hidden from a connector-key caller and shown to an owner and to stdio", async () => {
		const { host, stateDir } = setup();
		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), {
			sessionId,
			original: "Build the converter",
			status: "planned",
		});
		const listed = async (ctx?: RequestContext): Promise<string[]> => {
			const run = () => host.call("ultrathink_sessions", {});
			const outcome = okOf(await (ctx === undefined ? run() : runWithRequestContext(ctx, run)));
			return (outcome.data.sessions as Array<{ sessionId: string }>).map((s) => s.sessionId);
		};
		expect(await listed(admitted("key:connector"))).toEqual([]);
		expect(await listed(ownerContext)).toEqual([sessionId]);
		expect(await listed()).toEqual([sessionId]);
	});
});
