import { randomBytes } from "node:crypto";
import type { Finding } from "./doctor/types.ts";
import type { TeachableMoment } from "./teach/types.ts";
import { escapeXml } from "./uplift/xml.ts";

/** Runs a command to completion and returns its exit code and captured output. */
export async function run(
	cmd: string[],
	env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({ cmd, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

/** Resolves after the current macrotask, so queued microtasks and I/O callbacks can run. */
export function yieldTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** A PHC-shaped argon2id string with random salt and digest; it is not a hash of any password. */
export function randomHash(): string {
	// PHC strings use standard base64 without padding, as Bun.password.hash writes them.
	const salt = randomBytes(16).toString("base64").replace(/=+$/, "");
	const digest = randomBytes(16).toString("base64").replace(/=+$/, "");
	return `$argon2id$v=19$m=65536,t=2,p=1$${salt}$${digest}`;
}

export const UPLIFT = (original: string) =>
	`<BUILD_PROMPT><ORIGINAL>${escapeXml(original)}</ORIGINAL><SYSTEM_ROLE>Senior TypeScript engineer.</SYSTEM_ROLE><APP_CONTEXT>A standalone CLI.</APP_CONTEXT><SCOPE>CSV to JSON with streaming.</SCOPE><CONSTRAINTS>Do not invent repo facts.</CONSTRAINTS><ACCEPTANCE_CRITERIA>Converts a 1 GB file in bounded memory.</ACCEPTANCE_CRITERIA><OUT_OF_SCOPE>XLSX input.</OUT_OF_SCOPE></BUILD_PROMPT>`;

const steps = (n: number, id: string) =>
	Array.from(
		{ length: n },
		(_, i) => `${i + 1}. Step ${i + 1} of ${id}: a discrete, self-contained action.`,
	).join("\n");

export const NODE = (id: string, kind: string, n: number) => {
	let conclusion = `Answer for ${id}.`;
	if (kind === "critique")
		conclusion += "\nOpen questions:\n- Output as JSON lines or array? Default: array.";
	if (kind === "synthesize")
		conclusion +=
			"\nWORKFLOW\nWave 1 (parallel): parser — files: src/parse.ts — done when: unit tests pass\nWave 1 (parallel): cli — files: src/cli.ts — done when: --help prints\nWave 2: docs — files: README.md — done when: README lists flags\nVerify: bun test";
	return `<node><rationale>\n${steps(n, id)}\n</rationale><conclusion>${conclusion}</conclusion></node>`;
};

/** Returns the error a function throws, or undefined when it returns normally. */
export function thrownBy(run: () => void): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

/** About 8 KB of primitives per record (32 keys, 250 characters each), so a 1 MiB segment holds about 125 records. */
export function bulk(i: number): Record<string, string | number> {
	const fields: Record<string, string | number> = { n: i };
	for (let k = 0; k < 31; k += 1) fields[`k${k}`] = "x".repeat(250);
	return fields;
}

export function graphJson(count = 5): string {
	return JSON.stringify({
		goal: "Ship it",
		nodes: Array.from({ length: count }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : i === count - 1 ? "synthesize" : "generate",
			question: `Q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		})),
	});
}

export interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export function recorded(input: string | URL | Request, init?: RequestInit): Recorded {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
	return { url: String(input), method: init?.method ?? "GET", headers, body };
}

/** Recording fetch R: records every call, answers from a queue (last entry repeats). Installed as globalThis.fetch too. */
export function recordingFetch(queue: Array<() => Response | Promise<Response>>): {
	fetch: typeof fetch;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
		calls.push({ url: String(input), method: init?.method ?? "GET", headers, body });
		const next = queue[Math.min(calls.length, queue.length) - 1];
		if (!next) throw new Error("empty queue");
		return next();
	}) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return { fetch: fetchImpl, calls };
}

export const JEV =
	(p: number, key = "plan_worthy") =>
	() =>
		Response.json({
			id: "gen-dec-test",
			model: "typesafe/jev-1.13-20260917",
			provider: "TypeSafe",
			answers: { [key]: { type: "noul", noul: p } },
			usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
		});

export const VEV = (p: number) => () =>
	Response.json({
		answers: { plan_worthy: { type: "boolean", probability: p } },
		usage: { inputTokens: 100, outputTokens: 5 },
	});

/** Never resolves; rejects with an AbortError when its signal fires. */
export function hangingFetch(onCall?: () => void): typeof fetch {
	return ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () =>
				reject(new DOMException("aborted", "AbortError")),
			);
			onCall?.();
		})) as typeof fetch;
}

export function byId(findings: Finding[], id: string): Finding {
	const found = findings.find((finding) => finding.id === id);
	if (!found)
		throw new Error(`no finding ${id} in ${findings.map((finding) => finding.id).join(", ")}`);
	return found;
}

export function moment(id: string, overrides: Partial<TeachableMoment> = {}): TeachableMoment {
	return {
		id,
		name: `lesson ${id}`,
		description: "",
		body: "",
		sourcePhase: "",
		sourceArtifacts: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: [],
		relatedIds: [],
		schema: 2,
		kind: "pitfall",
		status: "confirmed",
		origin: "explicit",
		project: "proj",
		host: "omp",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		dedupeKey: `key-${id}`,
		recalled: 0,
		...overrides,
	};
}

export interface Call {
	url: string;
	method: string;
	body: unknown;
}

export function fakeFetch(handler: (call: Call) => Response | Promise<Response>): {
	fetch: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	return { fetch: impl, calls };
}
