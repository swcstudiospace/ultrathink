// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Characterization of the subagent (swarm lane) blocks. These snapshots pin what a swarm reply shows today: the spawn
 * reply (formatLaneHandles), the status reply (formatLaneStatusText), the card snapshots those replies project into
 * (toSwarmSpawnCard, toSwarmStatusCard), and the Omp card the swarm renderer draws from them. A later change to the lane
 * wording, the omitted-lane notice or the card rows shows up as a snapshot diff.
 */
import { describe, expect, test } from "bun:test";
import {
	type LaneHandle,
	type LanePlan,
	type LaneStatusRow,
	formatLaneHandles,
	formatLaneStatusText,
	toSwarmSpawnCard,
	toSwarmStatusCard,
} from "../swarm/teams.ts";
import { registerUltrathinkRenderers, SWARM_TYPE } from "./omp-render.ts";

const STATE_ROOT = "/state/swarm";
const LANE_A = "a1b2c3d4-0-x1";
const LANE_B = "e5f6a7b8-1-y2";
const LANE_C = "c9d0e1f2-2-z3";

const plan = (id: string, brief: string): LanePlan => ({
	id,
	brief,
	laneBrief: `${brief}\n`,
	cwd: "/repo",
	stateDir: `${STATE_ROOT}/${id}`,
	argv: ["orchestrate", "--brief"],
	env: {},
});

const plans: LanePlan[] = [
	plan(LANE_A, "Add rate limiting to the login endpoint"),
	plan(LANE_B, "Migrate the sessions table to the new store"),
	plan(LANE_C, "Document the swarm lane states"),
];

const handles: LaneHandle[] = [
	{
		laneId: LANE_A,
		pid: 4242,
		stateDir: `${STATE_ROOT}/${LANE_A}`,
		logPath: `${STATE_ROOT}/${LANE_A}/run.log`,
	},
	{
		laneId: LANE_B,
		pid: 4343,
		stateDir: `${STATE_ROOT}/${LANE_B}`,
		logPath: `${STATE_ROOT}/${LANE_B}/run.log`,
		note: "lane.json could not be written",
	},
	{
		laneId: LANE_C,
		stateDir: `${STATE_ROOT}/${LANE_C}`,
		logPath: `${STATE_ROOT}/${LANE_C}/run.log`,
		error: "spawn failed: ENOENT",
	},
];

const statusRows: LaneStatusRow[] = [
	{
		laneId: LANE_A,
		logPath: `${STATE_ROOT}/${LANE_A}/run.log`,
		state: "running",
		summary: "running · 3 of 5 tasks done",
		total: 5,
		byState: { done: 3, running: 1, pending: 1 },
		done: 3,
		graphId: "ut-1234567890-abcdef12",
	},
	{
		laneId: LANE_B,
		logPath: `${STATE_ROOT}/${LANE_B}/run.log`,
		state: "done",
		summary: "done · 4 of 4 tasks done",
		total: 4,
		byState: { done: 4 },
		done: 4,
	},
	{
		laneId: LANE_C,
		logPath: `${STATE_ROOT}/${LANE_C}/run.log`,
		error: "orch_status.py probe failed: timeout",
	},
];

// Plain-text theme: each colour is a visible tag so snapshots show which colour a row was painted with.
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</>`,
	bg: (color: string, text: string) => `<bg:${color}>${text}</>`,
	bold: (text: string) => `**${text}**`,
	boxRound: {
		topLeft: "╭",
		topRight: "╮",
		bottomLeft: "╰",
		bottomRight: "╯",
		horizontal: "─",
		vertical: "│",
	},
	icon: {},
	status: {},
};

const renderers: Record<
	string,
	Parameters<Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"]>[1]
> = {};
registerUltrathinkRenderers({
	registerMessageRenderer: (type, renderer) => void (renderers[type] = renderer),
});

/** Renders the swarm card for `details` at `width`; undefined when the renderer declines. */
function drawSwarm(
	details: unknown,
	width: number,
	expanded = false,
): readonly string[] | undefined {
	const renderer = renderers[SWARM_TYPE];
	if (renderer === undefined) throw new Error(`no renderer registered for ${SWARM_TYPE}`);
	return renderer({ content: "", details }, { expanded }, theme)?.render(width);
}

describe("subagent block: spawn reply (formatLaneHandles)", () => {
	test("no lanes spawned", () => {
		expect(formatLaneHandles([])).toMatchSnapshot();
	});

	test("started, log-noted and failed lanes", () => {
		expect(formatLaneHandles(handles)).toMatchSnapshot();
	});
});

describe("subagent block: status reply (formatLaneStatusText)", () => {
	test("no lanes under the state directory", () => {
		expect(formatLaneStatusText([])).toMatchSnapshot();
	});

	test("running, done and probe-failed lanes", () => {
		expect(formatLaneStatusText(statusRows)).toMatchSnapshot();
	});

	test("omitted older lanes add a single trailing notice", () => {
		expect(formatLaneStatusText(statusRows.slice(0, 1), 1)).toMatchSnapshot();
	});

	test("several omitted lanes pluralise the notice", () => {
		expect(formatLaneStatusText(statusRows.slice(0, 1), 3)).toMatchSnapshot();
	});
});

describe("subagent block: card snapshots", () => {
	test("spawn card projects each handle onto its planned brief", () => {
		expect(toSwarmSpawnCard(handles, plans)).toMatchSnapshot();
	});

	test("status card keeps probe errors and the omitted count", () => {
		expect(toSwarmStatusCard(statusRows, 2)).toMatchSnapshot();
	});
});

describe("subagent block: swarm card rendering", () => {
	test("spawn card, compact", () => {
		expect(drawSwarm(toSwarmSpawnCard(handles, plans), 72)).toMatchSnapshot();
	});

	test("spawn card, expanded", () => {
		expect(drawSwarm(toSwarmSpawnCard(handles, plans), 72, true)).toMatchSnapshot();
	});

	test("status card, compact", () => {
		expect(drawSwarm(toSwarmStatusCard(statusRows, 2), 72)).toMatchSnapshot();
	});

	test("status card, expanded", () => {
		expect(drawSwarm(toSwarmStatusCard(statusRows, 2), 72, true)).toMatchSnapshot();
	});

	test("zero-lane status card names the empty state", () => {
		expect(drawSwarm(toSwarmStatusCard([], 0), 72)).toMatchSnapshot();
	});
});
