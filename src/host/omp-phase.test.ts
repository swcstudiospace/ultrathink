// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UPLIFT } from "../test.helpers.ts";
import { TEST_STATE_DIR_PREFIX } from "../test.state-dir.ts";
import { attemptPhase } from "../workflow/phase-loop.ts";
import { fileStore } from "../workflow/phase-loop-store.ts";
import type { OmpPlan, OmpPlanRequest } from "./omp.ts";
import { killSessionPhases } from "./omp-phase.ts";
import { flush, setup } from "./omp-test.helpers.ts";
import type { PlanView } from "./view.ts";

const roots: string[] = [];
const newRoot = (): string => {
	const root = mkdtempSync(join(tmpdir(), TEST_STATE_DIR_PREFIX));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSION = "s1";
const DISCUSS = "/gsd-discuss-phase";
const PLAN = "/gsd-plan-phase";
const EXECUTE = "/gsd-execute-phase";
const PLAIN = "Refactor the parser so nested tables are handled correctly.";
const KILL_AT = "2026-11-17T10:00:00.000Z";
const KILL_FIXTURE = fileURLToPath(new URL("./kill-checkpoint.fixture.ts", import.meta.url));

/** The phase record file of the session: its key is the session id, hex-encoded. */
const recordPath = (root: string, sessionId = SESSION): string =>
	join(root, "phase-loop", `${Buffer.from(sessionId, "utf8").toString("hex")}.json`);

interface StoredRecord {
	phaseOrder: string[];
	executeStarts: number;
	humanItems: { id: string; owner: string; state: string }[];
	checkpoint?: { reason: string; at: string };
}
const readRecord = (root: string): StoredRecord =>
	JSON.parse(readFileSync(recordPath(root), "utf8")) as StoredRecord;

/** Opens one phase loop for the session in the state dir, as an accepted Discuss attempt does. */
const openLoop = (root: string): void => {
	attemptPhase(
		SESSION,
		{ phase: "Discuss", completeUpliftCount: 1, unansweredBlockingClarifications: 0 },
		() => true,
		fileStore(join(root, "phase-loop")),
	);
};

/** The model-facing text of a before_agent_start result; undefined when the handler returned nothing. */
const textOf = (result: unknown): string | undefined => {
	if (typeof result !== "object" || result === null || !("message" in result)) return undefined;
	const { message } = result;
	if (typeof message === "string") return message;
	if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
	return typeof message.content === "string" ? message.content : undefined;
};

/** The content of a sent message; empty when it has none. */
const contentOf = (message: unknown): string =>
	typeof message === "object" &&
	message !== null &&
	"content" in message &&
	typeof message.content === "string"
		? message.content
		: "";

/** Sent messages that start no turn (`triggerTurn: false`) and contain `text`. */
const advisories = (sent: { message: unknown; options: unknown }[], text: string) =>
	sent.filter(
		(entry) =>
			(entry.options as { triggerTurn?: boolean } | undefined)?.triggerTurn === false &&
			contentOf(entry.message).includes(text),
	);

/** A model-made plan view: a complete LLM uplift carrying the given clarifications. */
const llmView = (clarifications: PlanView["clarifications"] = []): PlanView => ({
	root: "/repo",
	source: "llm",
	elapsedMs: 1,
	nodes: [],
	waves: [],
	clarifications,
});

/** Every prompt gets the uplift and the model's view, so the Execute gate depends only on the clarifications given. */
const planner =
	(clarifications: PlanView["clarifications"] = []) =>
	async (request: OmpPlanRequest): Promise<OmpPlan> => ({
		context: UPLIFT(request.prompt),
		view: llmView(clarifications),
	});

/** Runs Discuss then Plan, so the next Execute attempt is the loop's next phase. */
const discussAndPlan = async (run: (prompt: string) => unknown): Promise<void> => {
	await run(DISCUSS);
	await flush();
	await run(PLAN);
	await flush();
};

describe("omp phase record", () => {
	test("a GSD execute prompt with a complete uplift records Execute as the last phase", async () => {
		const root = newRoot();
		const { run, sent } = setup(planner(), 1_000, { stateDir: root });
		await discussAndPlan(run);
		expect(textOf(await run(EXECUTE))).toBe(UPLIFT(EXECUTE));
		await flush();
		const record = readRecord(root);
		expect(record.phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
		expect(record.executeStarts).toBe(1);
		expect(advisories(sent, "Execute gates are unmet")).toHaveLength(0);
	});

	test("an unanswered blocking clarification leaves Execute unstarted and the plan delivered unchanged", async () => {
		const root = newRoot();
		const blocking = [{ id: "c1", question: "Which table?", blocking: true }];
		const { run, sent } = setup(planner(blocking), 1_000, { stateDir: root });
		await discussAndPlan(run);
		expect(textOf(await run(EXECUTE))).toBe(UPLIFT(EXECUTE));
		await flush();
		expect(readRecord(root).phaseOrder).toEqual(["Discuss", "Plan"]);
		expect(readRecord(root).executeStarts).toBe(0);
		expect(advisories(sent, "Execute gates are unmet")).toHaveLength(1);
	});

	test("a plain prompt writes nothing under phase-loop", async () => {
		const root = newRoot();
		const { run } = setup(planner(), 1_000, { stateDir: root });
		expect(textOf(await run(PLAIN))).toBe(UPLIFT(PLAIN));
		await flush();
		expect(existsSync(join(root, "phase-loop"))).toBe(false);
	});

	test("two before_agent_start calls for one submission start Execute once", async () => {
		const root = newRoot();
		const { run } = setup(planner(), 1_000, { stateDir: root });
		await discussAndPlan(run);
		await Promise.all([run(EXECUTE), run(EXECUTE)]);
		await flush();
		expect(readRecord(root).phaseOrder).toEqual(["Discuss", "Plan", "Execute"]);
		expect(readRecord(root).executeStarts).toBe(1);
	});

	test("a corrupt record yields a notice naming its quarantine copy, and the plan is still delivered", async () => {
		const root = newRoot();
		const corrupt = "{not a phase record";
		mkdirSync(join(root, "phase-loop"), { recursive: true });
		writeFileSync(recordPath(root), corrupt);
		const notices: string[] = [];
		const { run } = setup(
			planner(),
			1_000,
			{ stateDir: root },
			{
				ui: { notify: (text: string) => void notices.push(text) },
			},
		);
		expect(textOf(await run(DISCUSS))).toBe(UPLIFT(DISCUSS));
		await flush();
		const copies = readdirSync(join(root, "phase-loop")).filter((name) =>
			name.startsWith(`${basename(recordPath(root))}.corrupt-`),
		);
		expect(copies).toHaveLength(1);
		const copy = join(root, "phase-loop", copies[0] ?? "");
		expect(readFileSync(copy, "utf8")).toBe(corrupt);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(copy);
	});

	test("a store failure delivers the plan with exactly one notice and the handler does not throw", async () => {
		const root = newRoot();
		// The phase-loop path is a file, so the store can neither read nor write its record.
		writeFileSync(join(root, "phase-loop"), "not a directory");
		const notices: string[] = [];
		const { run } = setup(
			planner(),
			1_000,
			{ stateDir: root },
			{
				ui: { notify: (text: string) => void notices.push(text) },
			},
		);
		expect(textOf(await run(DISCUSS))).toBe(UPLIFT(DISCUSS));
		await flush();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("phase record");
	});

	test("a superseded flight records nothing and only the current flight does", async () => {
		const root = newRoot();
		const release = Promise.withResolvers<void>();
		const planFor = async (request: OmpPlanRequest): Promise<OmpPlan> => {
			if (request.prompt === DISCUSS) await release.promise;
			return { context: UPLIFT(request.prompt), view: llmView() };
		};
		const { run } = setup(planFor, 1_000, { stateDir: root });
		const superseded = run(DISCUSS);
		// A newer prompt replaces the pending Discuss flight before it settles.
		expect(textOf(await run(PLAIN))).toBe(UPLIFT(PLAIN));
		release.resolve();
		await superseded;
		await flush();
		expect(existsSync(join(root, "phase-loop"))).toBe(false);
		expect(textOf(await run(DISCUSS))).toBe(UPLIFT(DISCUSS));
		await flush();
		expect(readRecord(root).phaseOrder).toEqual(["Discuss"]);
	});

	test("a session shutdown after an accepted Execute records a pause, and a new session on the state dir reports the restore", async () => {
		const root = newRoot();
		const first = setup(planner(), 1_000, { stateDir: root });
		await discussAndPlan(first.run);
		await first.run(EXECUTE);
		await flush();
		first.emit("session_shutdown");
		expect(readRecord(root).checkpoint?.reason).toBe("pause");

		const second = setup(planner(), 1_000, { stateDir: root });
		second.emit("session_start");
		const restored = second.sent
			.map((entry) => contentOf(entry.message))
			.find((text) => text.includes("restored"));
		expect(restored).toContain("Discuss, Plan, Execute");
	});

	test("a phase whose GSD verification reads human_needed opens an open HTIL entry", async () => {
		const root = newRoot();
		const project = newRoot();
		const verification = join(project, ".planning", "phases", "01-core");
		mkdirSync(verification, { recursive: true });
		writeFileSync(
			join(verification, "01-VERIFICATION.md"),
			"---\nstatus: human_needed\n---\nCheck the live rollout.\n",
		);
		const { run } = setup(planner(), 1_000, { stateDir: root }, { cwd: project });
		await run(DISCUSS);
		await flush();
		expect(readRecord(root).humanItems).toEqual([
			{ id: "verification:01-core", owner: "human", state: "open" },
		]);
	});

	test("a kill checkpoint writes a kill reason at the given time over an open phase loop", () => {
		const root = newRoot();
		openLoop(root);
		expect(killSessionPhases({ stateDir: root, sessionId: SESSION, at: KILL_AT })).toEqual({
			kind: "none",
		});
		expect(readRecord(root)).toMatchObject({
			phaseOrder: ["Discuss"],
			checkpoint: { reason: "kill", at: KILL_AT },
		});
	});

	test("a kill with no phase record writes nothing", () => {
		const root = newRoot();
		expect(killSessionPhases({ stateDir: root, sessionId: SESSION, at: KILL_AT })).toEqual({
			kind: "none",
		});
		expect(existsSync(join(root, "phase-loop"))).toBe(false);
	});

	test("SIGTERM to a host process checkpoints its open loop as killed, and the process exits by that signal", async () => {
		const root = newRoot();
		openLoop(root);
		const proc = Bun.spawn([process.execPath, KILL_FIXTURE], {
			env: {
				...process.env,
				ULTRATHINK_KILL_STATE_DIR: root,
				ULTRATHINK_KILL_SESSION: SESSION,
				ULTRATHINK_KILL_NOW: String(Date.parse(KILL_AT)),
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(proc.signalCode).toBe("SIGTERM");
		expect(stderr).not.toContain("could not");
		expect(readRecord(root).checkpoint).toEqual({ reason: "kill", at: KILL_AT });
	});
});
