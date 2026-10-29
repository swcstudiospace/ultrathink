// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContract, main as driftMain } from "../../scripts/check-substrate-contract.ts";
import type { SessionRecord } from "../claude/state.ts";
import { graphRegisterPayload } from "../host/grokbot-track.ts";
import { HOSTS } from "../host/types.ts";
import { emitEvent, fetchBrief } from "./brief.ts";
import {
	EDGE_KINDS,
	EVENT_INPUT,
	GRAPH_REGISTER_EDGE_FIELDS,
	GRAPH_REGISTER_FIELDS,
	GRAPH_REGISTER_NODE_FIELDS,
	GRAPH_REGISTER_STEP_FIELDS,
	NODE_STATES,
	PINNED_FACTS,
	type PinnedFields,
	type PinnedList,
	SURFACES,
	isSurface,
	surfaceClaimMessage,
	validateEventBody,
	validateGraphRegister,
} from "./fixtures/substrate-schema.ts";
import { hostToEventSurface, hostToSurface, SUBSTRATE_SURFACES } from "./surface.ts";

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";
const TOKEN_OMP = "tok-omp-AAAA1111";
const TOKEN_PI = "tok-pi-BBBB2222";
const TOKEN_SWARM = "tok-swarm-CCCC3333";

type BriefState = "complete" | "degraded" | "snapshot";

interface FakeOptions {
	/** Bearer to the one surface it is bound to. */
	tokens: ReadonlyMap<string, string>;
	anonymous?: boolean;
	briefState?: BriefState;
	/** `false` makes the ledger refuse: `/events` answers 503. */
	ledger?: boolean;
	/** Answer every /brief (after auth and content-type) with this status and error. */
	forceBrief?: { status: number; error: string };
}

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	contentType: string | null;
	body: Record<string, unknown> | undefined;
	status: number;
}

interface Fake {
	url: string;
	seen: Seen[];
	/** What `/events` stored: the attributed surface and the body. */
	events: Array<{ surface: string; body: Record<string, unknown> }>;
	stop: () => void;
}

const stops: Array<() => void> = [];
const dirs: string[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-substrate-contract-"));
	dirs.push(dir);
	return dir;
}

const JSON_TYPE = /^application\/json\s*(;|$)/i;

/**
 * A Substrate on a loopback ephemeral port that applies the rules pinned in the fixture (each cites the sibling
 * source): a bearer is bound to one surface (unknown bearer 401, healthz open), a POST to a JSON route with another
 * media type is 415, a /brief naming another surface than the bearer's is 403 `this token is X and cannot act as Y`,
 * /events attributes body-first except for swarm and substrate tokens, an unknown surface is 400, the ledger answers
 * 202 or 503, and /brief carries X-Substrate-Brief.
 */
function startFake(options: FakeOptions): Fake {
	const seen: Seen[] = [];
	const events: Fake["events"] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const raw = req.method === "POST" ? await req.text() : "";
			const authorization = req.headers.get("authorization");
			const contentType = req.headers.get("content-type");
			let body: Record<string, unknown> | undefined;
			try {
				const parsed: unknown = raw ? JSON.parse(raw) : undefined;
				body =
					typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: undefined;
			} catch {
				body = undefined;
			}
			const reply = (
				status: number,
				value: unknown,
				headers: Record<string, string> = {},
			): Response => {
				seen.push({
					method: req.method,
					path: url.pathname,
					authorization,
					contentType,
					body,
					status,
				});
				return typeof value === "string"
					? new Response(value, { status, headers })
					: Response.json(value, { status, headers });
			};
			const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
			const surface = bearer === null ? null : (options.tokens.get(bearer) ?? null);
			const openHealth = req.method === "GET" && url.pathname === "/healthz";
			if (
				(bearer !== null && surface === null) ||
				(!openHealth && !options.anonymous && surface === null)
			)
				return reply(401, { error: "unknown or missing bearer token" });
			if (openHealth) return reply(200, { ok: true });
			const jsonRoute = url.pathname === "/brief" || url.pathname === "/events";
			if (req.method === "POST" && jsonRoute && !JSON_TYPE.test((contentType ?? "").trim()))
				return reply(415, { error: "request body must be application/json" });
			if (req.method === "POST" && url.pathname === "/brief") {
				const claimed = body?.surface;
				if (surface !== null && claimed !== undefined && claimed !== null && claimed !== surface)
					return reply(403, { error: surfaceClaimMessage(surface, claimed) });
				if (options.forceBrief)
					return reply(options.forceBrief.status, { error: options.forceBrief.error });
				const state = options.briefState ?? "complete";
				const composedFor = typeof claimed === "string" ? claimed : (surface ?? "claude-code");
				return reply(200, `# Substrate brief for ${composedFor}`, {
					"content-type": "text/markdown; charset=utf-8",
					"x-substrate-brief": state,
				});
			}
			if (req.method === "POST" && url.pathname === "/events") {
				if (body === undefined) return reply(400, { error: "event must be an object" });
				const supplied = typeof body.surface === "string" ? body.surface : null;
				const bound = surface !== null && (surface.startsWith("swarm-") || surface === "substrate");
				if (bound && supplied !== null && supplied !== surface)
					return reply(403, { error: `this token is ${surface} and cannot act as ${supplied}` });
				const attributed: string =
					bound && surface !== null ? surface : (supplied ?? surface ?? "claude-code");
				if (!isSurface(attributed)) return reply(400, { error: `unknown surface: ${attributed}` });
				const problems = validateEventBody({ ...body, surface: attributed });
				if (problems.length > 0) return reply(400, { error: problems[0] });
				const stored = options.ledger !== false;
				if (stored) events.push({ surface: attributed, body });
				return reply(stored ? 202 : 503, { stored });
			}
			return reply(404, { error: "not found" });
		},
	});
	const stop = (): void => {
		void server.stop(true);
	};
	stops.push(stop);
	return { url: `http://127.0.0.1:${server.port}`, seen, events, stop };
}

function standardTokens(): Map<string, string> {
	return new Map([
		[CANARY, "claude-code"],
		[TOKEN_OMP, "omp"],
		[TOKEN_PI, "pi"],
		[TOKEN_SWARM, "swarm-a05-be"],
	]);
}

function envFor(
	fake: Fake,
	extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	return {
		SUBSTRATE_URL: fake.url,
		SUBSTRATE_TIMEOUT_MS: "3000",
		// Never the real /etc/substrate/tokens of this host.
		SUBSTRATE_TOKENS_DIR: tempDir(),
		...extra,
	};
}

function briefRequests(fake: Fake): Seen[] {
	return fake.seen.filter((s) => s.path === "/brief");
}

describe("the fake Substrate applies the pinned rules", () => {
	async function call(
		fake: Fake,
		path: string,
		init: { method?: string; token?: string; type?: string; body?: unknown } = {},
	): Promise<{ status: number; text: string; headers: Headers }> {
		const response = await fetch(`${fake.url}${path}`, {
			method: init.method ?? "POST",
			headers: {
				...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
				...(init.type === undefined ? {} : { "content-type": init.type }),
			},
			body: init.method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
		});
		return { status: response.status, text: await response.text(), headers: response.headers };
	}

	test("healthz is open without a bearer, but a bearer that names no surface is refused even there", async () => {
		const fake = startFake({ tokens: standardTokens() });
		expect((await call(fake, "/healthz", { method: "GET" })).status).toBe(200);
		expect((await call(fake, "/healthz", { method: "GET", token: "nobody" })).status).toBe(401);
		expect((await call(fake, "/brief", { type: "application/json" })).status).toBe(401);
	});

	test("a wrong content type is 415 on both JSON routes, after the bearer", async () => {
		const fake = startFake({ tokens: standardTokens() });
		for (const path of ["/brief", "/events"])
			expect((await call(fake, path, { token: CANARY, type: "text/plain" })).status).toBe(415);
		expect((await call(fake, "/events", { type: "text/plain" })).status).toBe(401);
		expect(
			(
				await call(fake, "/events", {
					token: CANARY,
					type: "application/json; charset=utf-8",
					body: { kind: "note", summary: "s" },
				})
			).status,
		).toBe(202);
	});

	test("a brief naming another surface than the bearer's is 403 with the exact message", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const named = await call(fake, "/brief", {
			token: CANARY,
			type: "application/json",
			body: { surface: "omp" },
		});
		expect(named.status).toBe(403);
		expect(JSON.parse(named.text)).toEqual({
			error: "this token is claude-code and cannot act as omp",
		});
		const stranger = await call(fake, "/brief", {
			token: CANARY,
			type: "application/json",
			body: { surface: "no-such" },
		});
		expect(JSON.parse(stranger.text)).toEqual({
			error: "this token is claude-code and cannot act as an unrecognised surface",
		});
		const own = await call(fake, "/brief", {
			token: CANARY,
			type: "application/json",
			body: { surface: "claude-code" },
		});
		expect(own.status).toBe(200);
		const none = await call(fake, "/brief", { token: CANARY, type: "application/json", body: {} });
		expect(none.text).toBe("# Substrate brief for claude-code");
	});

	test.each(["complete", "degraded", "snapshot"] as const)(
		"a %s brief carries the X-Substrate-Brief header",
		async (state) => {
			const fake = startFake({ tokens: standardTokens(), briefState: state });
			const reply = await call(fake, "/brief", { token: CANARY, type: "application/json" });
			expect(reply.headers.get("x-substrate-brief")).toBe(state);
			expect(reply.headers.get("content-type")).toContain("text/markdown");
		},
	);

	test("events answer 202 or 503, 400 for an unknown surface, and 403 when a swarm token names another surface", async () => {
		const stored = startFake({ tokens: standardTokens() });
		const event = { kind: "note", summary: "s" };
		expect(
			(
				await call(stored, "/events", {
					token: CANARY,
					type: "application/json",
					body: { ...event, surface: "omp" },
				})
			).status,
		).toBe(202);
		expect(stored.events.at(-1)?.surface).toBe("omp");
		const unknown = await call(stored, "/events", {
			token: CANARY,
			type: "application/json",
			body: { ...event, surface: "no-such" },
		});
		expect(unknown.status).toBe(400);
		expect(JSON.parse(unknown.text)).toEqual({ error: "unknown surface: no-such" });
		const swarm = await call(stored, "/events", {
			token: TOKEN_SWARM,
			type: "application/json",
			body: { ...event, surface: "omp" },
		});
		expect(swarm.status).toBe(403);
		expect(JSON.parse(swarm.text)).toEqual({
			error: "this token is swarm-a05-be and cannot act as omp",
		});
		const refusing = startFake({ tokens: standardTokens(), ledger: false });
		expect(
			(await call(refusing, "/events", { token: CANARY, type: "application/json", body: event }))
				.status,
		).toBe(503);
	});

	test("every pinned fact names a rule and a source line", () => {
		for (const fact of PINNED_FACTS) {
			expect(fact.source.file).toMatch(/^packages\/mcp-server\/src\/\w+\.ts$/);
			expect(fact.source.from).toBeGreaterThan(0);
			expect(fact.source.to).toBeGreaterThanOrEqual(fact.source.from);
			expect(fact.evidence.length).toBeGreaterThan(0);
		}
		for (const list of [SURFACES, NODE_STATES, EDGE_KINDS])
			expect(list.source.file).toBe("packages/mcp-server/src/types.ts");
		expect(new Set(SURFACES.values).size).toBe(SURFACES.values.length);
	});
});

describe("fetchBrief against the fake", () => {
	test("a host whose token is bound to another surface still gets the brief: one retry without a surface", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const result = await fetchBrief(
			{ surface: "omp", repo: "o/r", branch: "b" },
			envFor(fake, { SUBSTRATE_TOKEN: CANARY }),
		);
		expect(result.state).toBe("complete");
		expect(result.reason).toBe("surface-mismatch");
		expect(result.detail).toBe(
			"token claude-code cannot act as host surface omp; retried without surface",
		);
		expect(result.text).toContain("# Substrate brief for claude-code");
		const requests = briefRequests(fake);
		expect(requests.map((r) => r.status)).toEqual([403, 200]);
		expect(requests[0]?.body?.surface).toBe("omp");
		expect(requests[1]?.body).not.toHaveProperty("surface");
		expect(requests[1]?.body).toMatchObject({ repo: "o/r", branch: "b" });
	});

	test("a token bound to the host's surface sends that surface and needs no retry", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const result = await fetchBrief(
			{ surface: "omp" },
			envFor(fake, { SUBSTRATE_TOKEN: TOKEN_OMP }),
		);
		expect(result.state).toBe("complete");
		expect(result.reason).toBeUndefined();
		expect(result.text).toContain("# Substrate brief for omp");
		const requests = briefRequests(fake);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.body?.surface).toBe("omp");
	});

	test("per-surface token files pick the bearer from the host's surface, prime-agent through pi", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const tokens = tempDir();
		writeFileSync(join(tokens, "omp"), `${TOKEN_OMP}\n`);
		writeFileSync(join(tokens, "pi"), `${TOKEN_PI}\n`);
		const env = envFor(fake, { SUBSTRATE_TOKENS_DIR: tokens });
		expect((await fetchBrief({ surface: "omp" }, env)).reason).toBeUndefined();
		const pi = await fetchBrief({ surface: "prime-agent" }, env);
		expect(pi.state).toBe("complete");
		expect(pi.reason).toBeUndefined();
		const [omp, prime] = briefRequests(fake);
		expect(omp?.authorization).toBe(`Bearer ${TOKEN_OMP}`);
		expect(prime?.authorization).toBe(`Bearer ${TOKEN_PI}`);
		expect(prime?.body?.surface).toBe("pi");
		expect(briefRequests(fake)).toHaveLength(2);
	});

	test("every plugin host reaches a brief and asks for a real Substrate surface", async () => {
		const fake = startFake({ tokens: standardTokens() });
		for (const host of HOSTS) {
			const result = await fetchBrief({ surface: host }, envFor(fake, { SUBSTRATE_TOKEN: CANARY }));
			expect(result.state).toBe("complete");
		}
		const first = briefRequests(fake).filter((r) => r.body && "surface" in r.body);
		expect(first.length).toBeGreaterThanOrEqual(HOSTS.length);
		for (const request of first) expect(isSurface(request.body?.surface)).toBe(true);
	});

	test("the client always sends application/json, so the 415 rule never fires on its own requests", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const env = envFor(fake, { SUBSTRATE_TOKEN: CANARY });
		await fetchBrief({ surface: "claude-code" }, env);
		await emitEvent({ kind: "note", summary: "s", surface: "claude-code" }, env);
		const post = fake.seen.filter((s) => s.method === "POST");
		expect(post).toHaveLength(2);
		for (const request of post) {
			expect(request.contentType).toBe("application/json");
			expect(request.status).not.toBe(415);
		}
	});

	test.each([
		[400, "unknown brief profile", "bad-request"],
		[415, "request body must be application/json", "http-415"],
		[503, "store unavailable", "http-503"],
	] as const)(
		"a %d answer maps to reason %s with no retry and no text",
		async (status, error, reason) => {
			const fake = startFake({ tokens: standardTokens(), forceBrief: { status, error } });
			const result = await fetchBrief(
				{ surface: "claude-code" },
				envFor(fake, { SUBSTRATE_TOKEN: CANARY }),
			);
			expect(result).toEqual({ text: "", state: "none", reason });
			expect(briefRequests(fake)).toHaveLength(1);
		},
	);

	test("a bearer the server does not know is unauthorized, with no retry", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const result = await fetchBrief(
			{ surface: "omp" },
			envFor(fake, { SUBSTRATE_TOKEN: "tok-unknown" }),
		);
		expect(result).toEqual({ text: "", state: "none", reason: "unauthorized" });
		expect(briefRequests(fake)).toHaveLength(1);
	});

	test.each(["degraded", "snapshot"] as const)(
		"a %s brief starts with the label line and keeps its state",
		async (state) => {
			const fake = startFake({ tokens: standardTokens(), briefState: state });
			const result = await fetchBrief(
				{ surface: "claude-code" },
				envFor(fake, { SUBSTRATE_TOKEN: CANARY }),
			);
			expect(result.state).toBe(state);
			expect(result.text.split("\n")[0]).toBe(
				`(Substrate brief is ${state}; some sources failed or the copy is a snapshot)`,
			);
		},
	);
});

describe("emitEvent against the fake", () => {
	test("every plugin host's event body parses against the pinned event shape and is stored", async () => {
		const fake = startFake({ tokens: standardTokens() });
		for (const host of HOSTS) {
			const stored = await emitEvent(
				{
					kind: "note",
					summary: "plan",
					surface: host,
					graphId: "g-1",
					repo: "o/r",
					branch: "b",
					payload: { n: 1 },
				},
				envFor(fake, { SUBSTRATE_TOKEN: CANARY }),
			);
			expect(stored).toBe(true);
		}
		const posts = fake.seen.filter((s) => s.path === "/events");
		expect(posts).toHaveLength(HOSTS.length);
		for (const post of posts) expect(validateEventBody(post.body)).toEqual([]);
		// Body-first attribution: each host's own surface, except prime-agent, which sends none and is attributed to the token.
		expect(fake.events.map((e) => e.surface)).toEqual(
			HOSTS.map((host) => hostToEventSurface(host) ?? "claude-code"),
		);
		const primeEvent = fake.events[HOSTS.indexOf("prime-agent")];
		expect(primeEvent?.body).not.toHaveProperty("surface");
		expect(primeEvent?.body.payload).toEqual({ n: 1, host: "prime-agent" });
	});

	test("a ledger that refuses (503) reads as not stored", async () => {
		const fake = startFake({ tokens: standardTokens(), ledger: false });
		const stored = await emitEvent(
			{ kind: "note", summary: "s", surface: "omp" },
			envFor(fake, { SUBSTRATE_TOKEN: CANARY }),
		);
		expect(stored).toBe(false);
		expect(fake.seen.at(-1)?.status).toBe(503);
	});

	test("a swarm-bound token cannot emit as a host surface: refused, never re-attributed", async () => {
		const fake = startFake({ tokens: standardTokens() });
		const stored = await emitEvent(
			{ kind: "note", summary: "s", surface: "omp" },
			envFor(fake, { SUBSTRATE_TOKEN: TOKEN_SWARM }),
		);
		expect(stored).toBe(false);
		expect(fake.seen.at(-1)?.status).toBe(403);
		expect(fake.events).toEqual([]);
	});
});

describe("host ids and the surface vocabulary", () => {
	test("every HOSTS entry maps to a member of the pinned SURFACES", () => {
		for (const host of HOSTS) {
			expect(isSurface(hostToSurface(host))).toBe(true);
			const eventSurface = hostToEventSurface(host);
			if (eventSurface !== undefined) expect(isSurface(eventSurface)).toBe(true);
		}
		expect(hostToSurface("prime-agent")).toBe("pi");
		expect(hostToEventSurface("prime-agent")).toBeUndefined();
		expect(hostToSurface(undefined)).toBe("claude-code");
	});

	test("the client's copy of the surface list equals the pinned one", () => {
		const client: string[] = [...SUBSTRATE_SURFACES].sort();
		expect(client).toEqual([...SURFACES.values].sort());
	});
});

describe("graph_register payload against the pinned schema", () => {
	function record(status: string): SessionRecord {
		const node = (id: string, dependsOn: string[]) => ({
			id,
			title: id,
			kind: "generate",
			question: "?",
			dependsOn,
		});
		const ids = ["n1", "n2", "n3", "n4"];
		return {
			sessionId: "s1",
			at: 0,
			host: "grok-bot",
			plan: {
				graphId: "g-contract",
				task: {
					graphId: "g-contract",
					item: "t",
					status,
					linearState: "Todo",
					repo: "o/r",
					branch: "b",
				},
				issues: ids.map((nodeId) => ({
					graphId: "g-contract",
					nodeId,
					item: nodeId,
					thought: "t",
				})),
				subIssues: ids.flatMap((nodeId) =>
					[1, 2].map((step) => ({
						graphId: "g-contract",
						nodeId,
						item: nodeId,
						step,
						thought: "t",
					})),
				),
			},
			tracking: {
				graphId: "g-contract",
				status: "complete",
				linear: {
					nodes: Object.fromEntries(
						ids.map((id, i) => [
							id,
							{
								id: `lin-${i}`,
								identifier: `ENG-${i}`,
								url: `https://linear.app/x/${i}`,
								title: id,
							},
						]),
					),
					steps: Object.fromEntries(
						ids.flatMap((id) =>
							[1, 2].map((s) => [
								`${id}.${s}`,
								{
									id: `sub-${id}-${s}`,
									identifier: `ENG-${id}${s}`,
									url: `https://linear.app/x/${id}${s}`,
									title: id,
								},
							]),
						),
					),
				},
				notion: {
					taskUrl: "https://www.notion.so/task",
					nodes: Object.fromEntries(ids.map((id) => [id, `https://www.notion.so/${id}`])),
					steps: Object.fromEntries(
						ids.flatMap((id) =>
							[1, 2].map((s) => [`${id}.${s}`, `https://www.notion.so/${id}${s}`]),
						),
					),
				},
				errors: [],
				updatedAt: 0,
			},
			graph: {
				goal: "g",
				nodes: [node("n1", []), node("n2", ["n1"]), node("n3", ["n1"]), node("n4", ["n2", "n3"])],
			},
		} as unknown as SessionRecord;
	}

	test.each([
		"Planning",
		"Todo",
		"Implementing",
		"In Review",
		"Done",
		"Cancelled",
		"something else",
	])(
		"the full payload for record status %s has no unknown field and valid enum values",
		(status) => {
			const payload = graphRegisterPayload(record(status), { withNodes: true });
			expect(validateGraphRegister(payload)).toEqual([]);
			expect(validateGraphRegister(graphRegisterPayload(record(status)))).toEqual([]);
		},
	);

	test("the diamond becomes four requires edges, dependent to dependency, each a valid edge", () => {
		const payload = graphRegisterPayload(record("Todo"), { withNodes: true }) as {
			edges: Array<Record<string, string>>;
		};
		expect(payload.edges).toEqual([
			{ from_node: "n2", to_node: "n1", kind: "requires" },
			{ from_node: "n3", to_node: "n1", kind: "requires" },
			{ from_node: "n4", to_node: "n2", kind: "requires" },
			{ from_node: "n4", to_node: "n3", kind: "requires" },
		]);
		for (const edge of payload.edges) expect(EDGE_KINDS.values).toContain(edge.kind ?? "");
	});

	test("every host id yields a surface the schema accepts", () => {
		for (const host of [...HOSTS, "grok-bot", "no-such-host"]) {
			const payload = graphRegisterPayload(record("Todo"), { surface: host, withNodes: true });
			expect(validateGraphRegister(payload)).toEqual([]);
			expect(isSurface(payload.surface)).toBe(true);
		}
	});

	test("the pinned validator rejects the fields and values the old payload carried", () => {
		const base = graphRegisterPayload(record("Todo"), { withNodes: true }) as Record<
			string,
			unknown
		>;
		const withNode = (extra: Record<string, unknown>) => ({
			...base,
			nodes: [{ node_id: "n1", ...extra }],
		});
		expect(validateGraphRegister(withNode({ linear_url: "https://x" }))).toEqual([
			"graph_register.nodes[0].linear_url is not an accepted field",
		]);
		expect(
			validateGraphRegister({
				...base,
				steps: [{ node_id: "n1", step: 1, linear_identifier: "E-1", linear_url: "u" }],
			}),
		).toEqual([
			"graph_register.steps[0].linear_identifier is not an accepted field",
			"graph_register.steps[0].linear_url is not an accepted field",
		]);
		expect(validateGraphRegister(withNode({ state: "Planning" }))).toEqual([
			"graph_register.nodes[0].state is not a node state: Planning",
		]);
		expect(
			validateGraphRegister({
				...base,
				edges: [{ from_node: "a", to_node: "b", kind: "depends" }],
			}),
		).toEqual(["graph_register.edges[0].kind is not an edge kind: depends"]);
		expect(validateGraphRegister({ ...base, surface: "prime-agent" })).toEqual([
			"graph_register.surface is not a Substrate surface: prime-agent",
		]);
		expect(validateGraphRegister({ ...base, nodes: [{}] })).toEqual([
			"graph_register.nodes[0].node_id is required",
		]);
		expect(validateGraphRegister({ surface: "omp" })).toEqual([
			"graph_register.graph_id is required",
		]);
		expect(validateGraphRegister({ ...base, steps: [{ node_id: "n1", step: 1.5 }] })).toEqual([
			"graph_register.steps[0].step must be an integer",
		]);
	});

	test("the pinned field lists carry the sibling's required fields", () => {
		const required = (spec: PinnedFields): string[] =>
			spec.fields.filter((f) => f.required).map((f) => f.name);
		expect(required(GRAPH_REGISTER_FIELDS)).toEqual(["graph_id"]);
		expect(required(GRAPH_REGISTER_NODE_FIELDS)).toEqual(["node_id"]);
		expect(required(GRAPH_REGISTER_STEP_FIELDS)).toEqual(["node_id", "step"]);
		expect(required(GRAPH_REGISTER_EDGE_FIELDS)).toEqual(["from_node", "to_node", "kind"]);
		expect(required(EVENT_INPUT)).toEqual(["surface", "kind", "summary"]);
	});
});

describe("no outcome carries a planted secret", () => {
	test("results, details and payloads built around a planted token never contain it", async () => {
		const outcomes: unknown[] = [];
		const echo = startFake({
			tokens: standardTokens(),
			forceBrief: { status: 500, error: `leaked ${CANARY}` },
		});
		outcomes.push(
			await fetchBrief({ surface: "claude-code" }, envFor(echo, { SUBSTRATE_TOKEN: CANARY })),
		);
		const plain = startFake({ tokens: standardTokens() });
		outcomes.push(await fetchBrief({ surface: "omp" }, envFor(plain, { SUBSTRATE_TOKEN: CANARY })));
		outcomes.push(
			await fetchBrief({ surface: "omp" }, envFor(plain, { SUBSTRATE_TOKEN: `${CANARY}-wrong` })),
		);
		const down = startFake({ tokens: standardTokens() });
		const downEnv = envFor(down, { SUBSTRATE_TOKEN: CANARY });
		down.stop();
		outcomes.push(await fetchBrief({ surface: "omp" }, downEnv));
		const record = graphRegisterPayload(
			{
				plan: { graphId: "g", task: { status: "Todo" }, issues: [], subIssues: [] },
				tracking: undefined,
			} as unknown as SessionRecord,
			{ withNodes: true },
		);
		outcomes.push(record);
		const text = JSON.stringify(outcomes);
		expect(text).not.toContain(CANARY);
		expect(text).not.toContain("CANARYCANARY");
	});
});

describe("scripts/check-substrate-contract.ts", () => {
	type Files = Map<string, string[]>;

	function put(files: Files, file: string, line: number, text: string): void {
		const lines = files.get(file) ?? [];
		while (lines.length < line) lines.push("");
		lines[line - 1] = text;
		files.set(file, lines);
	}

	function pad(files: Files, file: string, to: number): void {
		const lines = files.get(file) ?? [];
		while (lines.length < to) lines.push("");
		files.set(file, lines);
	}

	/** A sibling tree whose cited lines state exactly what the fixture pins. */
	function syntheticSibling(): Files {
		const files: Files = new Map();
		const lists: PinnedList[] = [SURFACES, NODE_STATES, EDGE_KINDS];
		for (const list of lists) {
			put(
				files,
				list.source.file,
				list.source.from,
				`\t${list.values.map((v) => `"${v}"`).join(", ")},`,
			);
			pad(files, list.source.file, list.source.to);
		}
		const fieldSets: PinnedFields[] = [
			EVENT_INPUT,
			GRAPH_REGISTER_FIELDS,
			GRAPH_REGISTER_NODE_FIELDS,
			GRAPH_REGISTER_STEP_FIELDS,
			GRAPH_REGISTER_EDGE_FIELDS,
		];
		for (const spec of fieldSets) {
			spec.fields.forEach((field, i) => {
				const text =
					spec.extract === "interface-fields"
						? `\t${field.name}${field.required ? "" : "?"}: string;`
						: `\t\t\t\t${field.name}: z.string()${field.required ? "" : ".optional()"},`;
				put(files, spec.source.file, spec.source.from + i, text);
			});
			pad(files, spec.source.file, spec.source.to);
		}
		for (const fact of PINNED_FACTS) {
			put(files, fact.source.file, fact.source.from, `\t// ${fact.evidence}`);
			pad(files, fact.source.file, fact.source.to);
		}
		return files;
	}

	function write(root: string, files: Files): void {
		for (const [file, lines] of files) {
			const path = join(root, file);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, lines.join("\n"));
		}
	}

	function run(root: string): { code: number; out: string[]; err: string[] } {
		const out: string[] = [];
		const err: string[] = [];
		const code = driftMain(["--sibling", root], {
			out: (l) => out.push(l),
			err: (l) => err.push(l),
			root: "/unused",
		});
		return { code, out, err };
	}

	test("a sibling that states what the fixture pins has no drift", () => {
		const root = tempDir();
		write(root, syntheticSibling());
		expect(checkContract(root)).toEqual([]);
		const { code, out } = run(root);
		expect(code).toBe(0);
		expect(out.join("\n")).toContain("matches");
	});

	test("drift is reported field by field and fails", () => {
		const files = syntheticSibling();
		const types = "packages/mcp-server/src/types.ts";
		const mcp = "packages/mcp-server/src/mcp.ts";
		const server = "packages/mcp-server/src/server.ts";
		const edit = (file: string, from: string, to: string): void => {
			const lines = files.get(file) ?? [];
			const index = lines.findIndex((l) => l.includes(from));
			expect(index).toBeGreaterThanOrEqual(0);
			lines[index] = (lines[index] ?? "").replace(from, to);
		};
		edit(types, '"duplicate"', '"merged"');
		edit(types, "\tsummary: string;", "\tsummary?: string;");
		edit(mcp, "state: z.string().optional(),", "state: z.string(),");
		edit(mcp, "linear_issue_id: z.string().optional(),", "linear_url: z.string().optional(),");
		edit(server, "result.stored ? 202 : 503", "result.stored ? 201 : 503");
		const root = tempDir();
		write(root, files);
		const problems = checkContract(root);
		expect(problems.some((p) => p.includes('pinned "duplicate" is not in the sibling'))).toBe(true);
		expect(problems.some((p) => p.includes('sibling has "merged", not pinned'))).toBe(true);
		expect(
			problems.some(
				(p) =>
					p.includes("EVENT_INPUT") &&
					p.includes("field summary is optional in the sibling, pinned required"),
			),
		).toBe(true);
		expect(
			problems.some((p) => p.includes("field state is required in the sibling, pinned optional")),
		).toBe(true);
		expect(
			problems.some((p) => p.includes("pinned field linear_issue_id is not in the sibling")),
		).toBe(true);
		expect(problems.some((p) => p.includes("sibling has field linear_url, not pinned"))).toBe(true);
		expect(
			problems.some((p) => p.includes("events-202-or-503") && p.includes("no longer holds")),
		).toBe(true);
		const { code, err } = run(root);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain("difference(s)");
	});

	test("a sibling file shorter than the cited range is a problem, not a crash", () => {
		const root = tempDir();
		const files = syntheticSibling();
		files.set("packages/mcp-server/src/types.ts", ["// moved"]);
		write(root, files);
		const problems = checkContract(root);
		expect(
			problems.some((p) => p.startsWith("SURFACES:") && p.includes("file has only 1 lines")),
		).toBe(true);
	});

	test("an absent sibling exits 0 with a skip note naming the missing directory", () => {
		const root = tempDir();
		const out: string[] = [];
		const err: string[] = [];
		const code = driftMain([], {
			out: (l) => out.push(l),
			err: (l) => err.push(l),
			root: join(root, "repo"),
		});
		expect(code).toBe(0);
		expect(err).toEqual([]);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("skipped");
		expect(out[0]).toContain(join(root, "agent-substrate"));
	});
});
