// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The single door from src/host/omp.ts into the cursor, ship, teach, greptile and swarm lanes.
 * Each value export is a pass-through: same arguments, same return value, no logic of its own.
 * Types and constants are re-exported unchanged.
 */
import * as activity from "../teach/activity.ts";
import * as context from "../teach/context.ts";
import * as digest from "../teach/digest.ts";
import * as knowledge from "../greptile/knowledge.ts";
import * as mapping from "../teach/mapping.ts";
import * as nudge from "../ship/nudge.ts";
import * as policy from "../ship/policy.ts";
import * as precheck from "../ship/precheck.ts";
import * as pstack from "../cursor/pstack.ts";
import * as recall from "../teach/recall.ts";
import * as skillControls from "../teach/skill-controls.ts";
import * as skills from "../teach/skills.ts";
import * as spawn from "../teach/spawn.ts";
import * as state from "../ship/state.ts";
import * as teams from "../swarm/teams.ts";

export type { ShipConfig } from "../ship/types.ts";
export type { KnowledgeLookup } from "../greptile/knowledge-probe.ts";
export type { KnowledgeReader } from "../greptile/knowledge.ts";
export type { SkillKey } from "../teach/skills.ts";
export type { LessonsLookup, SkillsLookup, TeachContext } from "../teach/types.ts";
export type { LaneClassify, LaneHandle, LanePlan } from "../swarm/teams.ts";
export { TEAMS_USAGE } from "../swarm/teams.ts";

export const resolvePstack: typeof pstack.resolvePstack = (...args) =>
	pstack.resolvePstack(...args);

export const shipNudge: typeof nudge.shipNudge = (...args) => nudge.shipNudge(...args);
export const shipApplies: typeof policy.shipApplies = (...args) => policy.shipApplies(...args);
export const shipPrecheck: typeof precheck.shipPrecheck = (...args) =>
	precheck.shipPrecheck(...args);
export const writeShip: typeof state.writeShip = (...args) => state.writeShip(...args);

export const teachContext: typeof context.teachContext = (...args) => context.teachContext(...args);
export const teachEnabled: typeof context.teachEnabled = (...args) => context.teachEnabled(...args);
export const digestFromAgentMessages: typeof digest.digestFromAgentMessages = (...args) =>
	digest.digestFromAgentMessages(...args);
export const spawnObserveDetached: typeof spawn.spawnObserveDetached = (...args) =>
	spawn.spawnObserveDetached(...args);
export const lessonsLookup: typeof recall.lessonsLookup = (...args) =>
	recall.lessonsLookup(...args);
export const recallLessons: typeof recall.recallLessons = (...args) =>
	recall.recallLessons(...args);
export const runSkillsCommand: typeof skillControls.runSkillsCommand = (...args) =>
	skillControls.runSkillsCommand(...args);
export const recallSkills: typeof skills.recallSkills = (...args) => skills.recallSkills(...args);
export const skillsLookup: typeof skills.skillsLookup = (...args) => skills.skillsLookup(...args);
export const readActivity: typeof activity.readActivity = (...args) =>
	activity.readActivity(...args);
export const projectOf: typeof mapping.projectOf = (...args) => mapping.projectOf(...args);

export const createGreptileKnowledge: typeof knowledge.createGreptileKnowledge = (...args) =>
	knowledge.createGreptileKnowledge(...args);

export const filterSpawnable: typeof teams.filterSpawnable = (...args) =>
	teams.filterSpawnable(...args);
export const formatLaneHandles: typeof teams.formatLaneHandles = (...args) =>
	teams.formatLaneHandles(...args);
export const formatLaneStatusText: typeof teams.formatLaneStatusText = (...args) =>
	teams.formatLaneStatusText(...args);
export const isSdlcPrompt: typeof teams.isSdlcPrompt = (...args) => teams.isSdlcPrompt(...args);
export const allLaneDirs: typeof teams.allLaneDirs = (...args) => teams.allLaneDirs(...args);
export const laneDirs: typeof teams.laneDirs = (...args) => teams.laneDirs(...args);
export const laneStatus: typeof teams.laneStatus = (...args) => teams.laneStatus(...args);
export const maxLanes: typeof teams.maxLanes = (...args) => teams.maxLanes(...args);
export const orchStatusRunner: typeof teams.orchStatusRunner = (...args) =>
	teams.orchStatusRunner(...args);
export const parseLaneArgs: typeof teams.parseLaneArgs = (...args) => teams.parseLaneArgs(...args);
export const pidAlive: typeof teams.pidAlive = (...args) => teams.pidAlive(...args);
export const planLanes: typeof teams.planLanes = (...args) => teams.planLanes(...args);
export const resolveStopTargets: typeof teams.resolveStopTargets = (...args) =>
	teams.resolveStopTargets(...args);
export const resolveSwarmRoot: typeof teams.resolveSwarmRoot = (...args) =>
	teams.resolveSwarmRoot(...args);
export const spawnGuarded: typeof teams.spawnGuarded = (...args) => teams.spawnGuarded(...args);
export const spawnLanes: typeof teams.spawnLanes = (...args) => teams.spawnLanes(...args);
export const stopLanes: typeof teams.stopLanes = (...args) => teams.stopLanes(...args);
export const swarmClassifier: typeof teams.swarmClassifier = (...args) =>
	teams.swarmClassifier(...args);
export const swarmRootMessage: typeof teams.swarmRootMessage = (...args) =>
	teams.swarmRootMessage(...args);
export const toSwarmSpawnCard: typeof teams.toSwarmSpawnCard = (...args) =>
	teams.toSwarmSpawnCard(...args);
export const toSwarmStatusCard: typeof teams.toSwarmStatusCard = (...args) =>
	teams.toSwarmStatusCard(...args);
