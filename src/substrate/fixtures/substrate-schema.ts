// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * A pinned copy of the Agent Substrate contract this plugin talks to: the surface vocabulary, the event body, the
 * `graph_register` field lists, the node states and edge kinds, and the route rules the fake Substrate in
 * `contract.test.ts` enforces. It is a copy, never an import: the sibling repo is read-only and absent on most
 * machines. Every list names the sibling file and the lines it was copied from (`source`), so a reader can open the
 * original and `scripts/check-substrate-contract.ts` can diff the copy against it when `../agent-substrate` exists.
 *
 * When the check fails, the sibling moved: re-read the cited lines, update the copy AND the builders, and bump the
 * line numbers here. Nothing in this file is a credential.
 */

import { isRecord } from "../../shared.ts";

/** Where a pinned value was copied from: a path under the agent-substrate repo root and an inclusive 1-based line range. */
export interface PinnedSource {
	file: string;
	from: number;
	to: number;
}

export interface PinnedList {
	source: PinnedSource;
	extract: "quoted-strings";
	values: readonly string[];
}

export interface PinnedField {
	name: string;
	required: boolean;
}

export interface PinnedFields {
	source: PinnedSource;
	extract: "interface-fields" | "zod-fields";
	fields: readonly PinnedField[];
}

/** A rule or shape the cited lines must still state: `evidence` has to appear verbatim in the cited range. */
export interface PinnedFact {
	id: string;
	rule: string;
	source: PinnedSource;
	evidence: string;
}

const TYPES = "packages/mcp-server/src/types.ts";
const MCP = "packages/mcp-server/src/mcp.ts";
const SERVER = "packages/mcp-server/src/server.ts";
const EVENT = "packages/mcp-server/src/event.ts";

/** `SURFACES` (types.ts lines 45-62) with `SWARM_SURFACES` (lines 11-42) spread in; compared as a set. */
export const SURFACES: PinnedList = {
	source: { file: TYPES, from: 11, to: 62 },
	extract: "quoted-strings",
	values: [
		"claude-code",
		"cursor",
		"hermes",
		"omp",
		"muse",
		"grok-build",
		"grok-bot",
		"codex",
		"opencode",
		"pi",
		"rivet-agentos",
		"swarm-a01-orch",
		"swarm-a02-req",
		"swarm-a03-arch",
		"swarm-a04-uxd",
		"swarm-a05-be",
		"swarm-a06-fe",
		"swarm-a07-data",
		"swarm-a08-qa",
		"swarm-a09-rev",
		"swarm-a10-sec",
		"swarm-a11-devops",
		"swarm-a12-rel",
		"swarm-a13-obs",
		"swarm-a14-maint",
		"swarm-a15-doc",
		"swarm-a16-cloud",
		"swarm-a17-plat",
		"swarm-a18-supply",
		"swarm-a19-event",
		"swarm-a20-finops",
		"swarm-a21-k8s",
		"swarm-a22-gitops",
		"swarm-a23-mesh",
		"swarm-a24-ksec",
		"swarm-a25-resil",
		"swarm-a26-sol",
		"swarm-a27-audit",
		"swarm-a28-chain",
		"swarm-a29-dapp",
		"swarm-a30-custody",
		"substrate",
	],
};

/** The `EventInput` interface, types.ts lines 97-118. `surface` is required there but the REST route fills it (see {@link EVENT_WIRE_REQUIRED}). */
export const EVENT_INPUT: PinnedFields = {
	source: { file: TYPES, from: 97, to: 118 },
	extract: "interface-fields",
	fields: [
		{ name: "surface", required: true },
		{ name: "kind", required: true },
		{ name: "summary", required: true },
		{ name: "session_id", required: false },
		{ name: "graph_id", required: false },
		{ name: "node_id", required: false },
		{ name: "linear_identifier", required: false },
		{ name: "step", required: false },
		{ name: "repo", required: false },
		{ name: "branch", required: false },
		{ name: "actor", required: false },
		{ name: "payload", required: false },
		{ name: "ts", required: false },
		{ name: "idempotency_key", required: false },
	],
};

/**
 * What an `/events` body must carry on the wire: `surface` may be absent because the route attributes it
 * (server.ts lines 1171-1172, mcp.ts `attributedSurface` line 125) before `normalizeEvent` validates it
 * (event.ts lines 231-233).
 */
const EVENT_WIRE_REQUIRED: readonly string[] = ["kind", "summary"];

/** Linear workflow states, types.ts lines 419-427. */
export const NODE_STATES: PinnedList = {
	source: { file: TYPES, from: 419, to: 427 },
	extract: "quoted-strings",
	values: [
		"backlog",
		"unstarted",
		"started",
		"started_review",
		"completed",
		"canceled",
		"duplicate",
	],
};

/** Edge kinds, types.ts line 464. */
export const EDGE_KINDS: PinnedList = {
	source: { file: TYPES, from: 464, to: 464 },
	extract: "quoted-strings",
	values: ["requires", "blocks", "gated_by"],
};

/** `graph_register` scalar fields, mcp.ts lines 1146-1152 (`nodes`, `steps`, `edges` follow, see {@link PINNED_FACTS}). */
export const GRAPH_REGISTER_FIELDS: PinnedFields = {
	source: { file: MCP, from: 1146, to: 1152 },
	extract: "zod-fields",
	fields: [
		{ name: "graph_id", required: true },
		{ name: "notion_task_page", required: false },
		{ name: "repo", required: false },
		{ name: "branch", required: false },
		{ name: "surface", required: false },
		{ name: "status", required: false },
		{ name: "pr_url", required: false },
	],
};

/** The `nodes` object, mcp.ts lines 1155-1161. */
export const GRAPH_REGISTER_NODE_FIELDS: PinnedFields = {
	source: { file: MCP, from: 1155, to: 1161 },
	extract: "zod-fields",
	fields: [
		{ name: "node_id", required: true },
		{ name: "linear_issue_id", required: false },
		{ name: "linear_identifier", required: false },
		{ name: "notion_page", required: false },
		{ name: "state", required: false },
	],
};

/** The `steps` object, mcp.ts lines 1166-1172. */
export const GRAPH_REGISTER_STEP_FIELDS: PinnedFields = {
	source: { file: MCP, from: 1166, to: 1172 },
	extract: "zod-fields",
	fields: [
		{ name: "node_id", required: true },
		{ name: "step", required: true },
		{ name: "linear_sub_issue_id", required: false },
		{ name: "notion_page", required: false },
		{ name: "state", required: false },
	],
};

/** The `edges` object, mcp.ts lines 1177-1181. */
export const GRAPH_REGISTER_EDGE_FIELDS: PinnedFields = {
	source: { file: MCP, from: 1177, to: 1181 },
	extract: "zod-fields",
	fields: [
		{ name: "from_node", required: true },
		{ name: "to_node", required: true },
		{ name: "kind", required: true },
	],
};

/** Route rules and shapes the fake Substrate enforces. Each `evidence` string must still sit in its cited lines. */
export const PINNED_FACTS: readonly PinnedFact[] = [
	{
		id: "graph-register-collections",
		rule: "graph_register takes optional nodes, steps and edges arrays after its scalar fields",
		source: { file: MCP, from: 1153, to: 1153 },
		evidence: "nodes: z",
	},
	{
		id: "graph-register-steps",
		rule: "graph_register steps array",
		source: { file: MCP, from: 1164, to: 1164 },
		evidence: "steps: z",
	},
	{
		id: "graph-register-edges",
		rule: "graph_register edges array",
		source: { file: MCP, from: 1175, to: 1175 },
		evidence: "edges: z",
	},
	{
		id: "bearer-bound-to-surface",
		rule: "every authenticated caller has a surface: the bearer is bound to one",
		source: { file: SERVER, from: 798, to: 799 },
		evidence: "Every authenticated caller therefore has a surface",
	},
	{
		id: "unmapped-bearer-401",
		rule: "a bearer that names no surface is refused 401",
		source: { file: SERVER, from: 817, to: 817 },
		evidence: "unknown or missing bearer token",
	},
	{
		id: "healthz-open",
		rule: "GET /healthz needs no bearer",
		source: { file: SERVER, from: 810, to: 810 },
		evidence: 'url.pathname === "/healthz"',
	},
	{
		id: "wrong-content-type-415",
		rule: "a POST to a JSON route with another media type is refused 415",
		source: { file: SERVER, from: 823, to: 824 },
		evidence: "sendJson(res, 415",
	},
	{
		id: "json-routes",
		rule: "/brief and /events are JSON body routes",
		source: { file: SERVER, from: 286, to: 289 },
		evidence: '"/events": true',
	},
	{
		id: "brief-surface-claim-403",
		rule: "a /brief body naming a surface the bearer is not bound to is refused 403",
		source: { file: SERVER, from: 1097, to: 1100 },
		evidence: "sendJson(res, 403, { error: briefRefusal })",
	},
	{
		id: "surface-claim-message",
		rule: "the 403 message is `this token is <bound> and cannot act as <named>`",
		source: { file: MCP, from: 139, to: 139 },
		evidence: "this token is ${callerSurface} and cannot act as ${named}",
	},
	{
		id: "unrecognised-surface-named",
		rule: "a claimed surface outside SURFACES is named `an unrecognised surface` in that message",
		source: { file: MCP, from: 138, to: 138 },
		evidence: '"an unrecognised surface"',
	},
	{
		id: "swarm-attribution-403",
		rule: "a swarm or substrate token cannot attribute an event to another surface",
		source: { file: MCP, from: 120, to: 125 },
		evidence: "cannot act as ${supplied}",
	},
	{
		id: "event-surface-optional-on-wire",
		rule: "/events reads body.surface only when it is a string, then attributes it",
		source: { file: SERVER, from: 1171, to: 1172 },
		evidence: 'typeof body.surface === "string" ? body.surface : null',
	},
	{
		id: "unknown-surface-400",
		rule: "an event naming an unknown surface is refused 400 `unknown surface: <name>`",
		source: { file: EVENT, from: 231, to: 233 },
		evidence: "unknown surface: ",
	},
	{
		id: "events-202-or-503",
		rule: "/events answers 202 when the ledger stored the event and 503 when it did not",
		source: { file: SERVER, from: 1195, to: 1195 },
		evidence: "result.stored ? 202 : 503",
	},
	{
		id: "brief-state-header",
		rule: "/brief carries X-Substrate-Brief: complete, degraded or snapshot",
		source: { file: SERVER, from: 1129, to: 1129 },
		evidence: '"x-substrate-brief": brief.state',
	},
	{
		id: "brief-markdown-200",
		rule: "/brief answers 200 text/markdown",
		source: { file: SERVER, from: 1140, to: 1140 },
		evidence: 'send(res, 200, brief.text, "text/markdown',
	},
];

/** The 403 message shape for a surface the bearer is not bound to. */
export function surfaceClaimMessage(bound: string, claimed: unknown): string {
	const named =
		typeof claimed === "string" && SURFACES.values.includes(claimed)
			? claimed
			: "an unrecognised surface";
	return `this token is ${bound} and cannot act as ${named}`;
}

export function isSurface(value: unknown): boolean {
	return typeof value === "string" && SURFACES.values.includes(value);
}

/** Wire types for the fields whose value is not a plain string. Everything else must be a string. */
function typeError(name: string, value: unknown, path: string): string | undefined {
	if (name === "step") return Number.isInteger(value) ? undefined : `${path} must be an integer`;
	if (name === "surface")
		return isSurface(value) ? undefined : `${path} is not a Substrate surface: ${String(value)}`;
	if (name === "state")
		return typeof value === "string" && NODE_STATES.values.includes(value)
			? undefined
			: `${path} is not a node state: ${String(value)}`;
	if (name === "kind" && path.includes("edges"))
		return typeof value === "string" && EDGE_KINDS.values.includes(value)
			? undefined
			: `${path} is not an edge kind: ${String(value)}`;
	if (name === "payload") return isRecord(value) ? undefined : `${path} must be an object`;
	if (name === "nodes" || name === "steps" || name === "edges")
		return Array.isArray(value) ? undefined : `${path} must be an array`;
	return typeof value === "string" ? undefined : `${path} must be a string`;
}

function checkObject(
	value: unknown,
	fields: readonly PinnedField[],
	path: string,
	extra: readonly string[],
	errors: string[],
): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	const known = new Set([...fields.map((f) => f.name), ...extra]);
	for (const key of Object.keys(value))
		if (!known.has(key)) errors.push(`${path}.${key} is not an accepted field`);
	for (const field of fields) {
		const present = Object.hasOwn(value, field.name) && value[field.name] !== undefined;
		if (!present) {
			if (field.required) errors.push(`${path}.${field.name} is required`);
			continue;
		}
		const error = typeError(field.name, value[field.name], `${path}.${field.name}`);
		if (error) errors.push(error);
	}
}

/**
 * Validate a `graph_register` argument object against the pinned schema: unknown fields, missing required fields,
 * wrong types, and values outside SURFACES, NODE_STATES and EDGE_KINDS. Returns every problem, empty when valid.
 */
export function validateGraphRegister(payload: unknown): string[] {
	const errors: string[] = [];
	checkObject(
		payload,
		GRAPH_REGISTER_FIELDS.fields,
		"graph_register",
		["nodes", "steps", "edges"],
		errors,
	);
	if (!isRecord(payload)) return errors;
	const collections = [
		["nodes", GRAPH_REGISTER_NODE_FIELDS],
		["steps", GRAPH_REGISTER_STEP_FIELDS],
		["edges", GRAPH_REGISTER_EDGE_FIELDS],
	] as const;
	for (const [name, spec] of collections) {
		const list = payload[name];
		if (list === undefined) continue;
		if (!Array.isArray(list)) {
			errors.push(`graph_register.${name} must be an array`);
			continue;
		}
		list.forEach((item: unknown, index: number) => {
			checkObject(item, spec.fields, `graph_register.${name}[${index}]`, [], errors);
		});
	}
	return errors;
}

/**
 * Validate an `/events` request body the way the route does: only EventInput fields, `kind` and `summary` present,
 * `surface` (when sent) a real surface. Returns every problem, empty when valid.
 */
export function validateEventBody(body: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(body)) return ["event must be an object"];
	const known = new Set(EVENT_INPUT.fields.map((f) => f.name));
	for (const key of Object.keys(body))
		if (!known.has(key)) errors.push(`event.${key} is not an accepted field`);
	for (const name of EVENT_WIRE_REQUIRED)
		if (typeof body[name] !== "string" || body[name] === "")
			errors.push(`event.${name} is required`);
	if (body.surface !== undefined && !isSurface(body.surface))
		errors.push(`event.surface is not a Substrate surface: ${String(body.surface)}`);
	if (body.step !== undefined && !Number.isInteger(body.step))
		errors.push("event.step must be an integer");
	if (body.payload !== undefined && !isRecord(body.payload))
		errors.push("event.payload must be an object");
	return errors;
}
