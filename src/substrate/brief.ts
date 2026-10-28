// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Agent Substrate client — an optional integration.
 *
 * Fetches the cross-agent briefing before the Graph of Thought is built, so the
 * graph is planned knowing what other agents already did in this repo, and
 * reports the plan back once it exists: `emitEvent` appends one `note` event
 * carrying the Graph ID, which the substrate adopts unchanged as its
 * correlation key (the caller is `runPromptSubmit`).
 *
 * Opt-in: nothing is contacted unless a server URL is set, either through the
 * `SUBSTRATE_URL` environment variable or `substrate.url` in the ultrathink
 * config (the environment wins). `SUBSTRATE_DISABLED=1` turns both off.
 *
 * Every function here fails open. The substrate is an enhancement to a prompt,
 * never a precondition for one: if it is unset, down, slow, or simply not
 * installed, the user's prompt proceeds exactly as it did before.
 */

import { gatewayBrief, gatewayEmit } from "../gateway/substrate.ts";
import { resolveGateway, serviceBackend } from "../gateway/settings.ts";
import { SUBSTRATE_BACKEND_ENV, type GatewayConfig } from "../gateway/types.ts";
import { checkServiceUrl, type UrlCheck } from "../net/safe-url.ts";
import {
	hostToEventSurface,
	hostToSurface,
	isSurfaceName,
	PRIME_AGENT_HOST,
	resolveSubstrateToken,
} from "./surface.ts";

const DEFAULT_TIMEOUT_MS = 1500;

/** Passed by callers that have the merged config. Absent keeps the direct substrate client. */
export interface SubstrateGatewayBinding {
	backend?: "direct" | "gateway";
	gateway: GatewayConfig;
	storePath?: string;
	fetch?: typeof fetch;
}

export interface BriefInput {
	repo?: string;
	branch?: string;
	graphId?: string;
	surface?: string;
	/** The caller's planning lifetime, combined with the request timeout: an abort ends the request and the result is `none/timeout`. */
	signal?: AbortSignal;
	/** The fetch to send the direct-client requests with; the global `fetch` when absent. */
	fetch?: typeof fetch;
}

export interface SubstrateTarget {
	url: string;
	/** Where the URL came from; the environment wins over the config file. */
	source: "SUBSTRATE_URL" | "config";
}

/**
 * The server to talk to, or undefined when the integration is off: no URL in
 * `SUBSTRATE_URL` or `substrate.url`, or `SUBSTRATE_DISABLED=1`.
 */
export function resolveSubstrate(
	env: Record<string, string | undefined>,
	configuredUrl: string,
): SubstrateTarget | undefined {
	if (env.SUBSTRATE_DISABLED === "1") return undefined;
	const fromEnv = env.SUBSTRATE_URL?.trim().replace(/\/+$/, "");
	if (fromEnv) return { url: fromEnv, source: "SUBSTRATE_URL" };
	const fromConfig = configuredUrl.trim().replace(/\/+$/, "");
	return fromConfig ? { url: fromConfig, source: "config" } : undefined;
}

function authHeaders(
	env: Record<string, string | undefined>,
	surface: string,
): Record<string, string> {
	const token = resolveSubstrateToken(env, surface);
	return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * The base URL a request may use. With a bearer attached the URL must pass the shared service-URL policy (https, or
 * http only to loopback, `*.ts.net` or 100.64.0.0/10) and the normalised form is the one used; without a bearer there
 * is no secret to protect and the configured URL is used as is.
 */
function endpointBase(url: string, auth: Record<string, string>): UrlCheck {
	return auth.authorization === undefined ? { ok: true, url } : checkServiceUrl(url);
}

const MAX_LINE_CHARS = 160;

/**
 * One printable line of untrusted text: C0, DEL and C1 controls and bidi overrides become spaces, whitespace
 * collapses to single spaces, and anything past 160 characters is cut with a trailing `...`.
 */
export function boundedLine(text: string): string {
	const line = text
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 3)}...` : line;
}

function timeoutMs(env: Record<string, string | undefined>): number {
	const raw = Number(env.SUBSTRATE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** How much of a brief a caller can rely on. `none` carries no text and, usually, a {@link BriefFailure}. */
type BriefState = "complete" | "degraded" | "snapshot" | "none";

/** Why a brief is missing or recovered. Closed vocabulary, secret-free: a word, `redirect refused`, or `url refused: <policy reason>` (never the URL). */
export type BriefFailure =
	| "disabled"
	| "no-url"
	| "unauthorized"
	| "surface-mismatch"
	| "bad-request"
	| "timeout"
	| "unreachable"
	| "redirect refused"
	| `url refused: ${string}`
	| `http-${number}`;

export interface BriefResult {
	/** The brief as Markdown (a degraded or snapshot brief starts with a one-line label), or `""`. */
	text: string;
	state: BriefState;
	/** Set when the brief is missing, or recovered by a retry (`surface-mismatch`). Absent for an empty 200. */
	reason?: BriefFailure;
	/** One secret-free line that sharpens `reason`: surface names only, never a token. */
	detail?: string;
}

/** The retry needs room to answer; with less budget left than this it is skipped. */
const RETRY_MIN_REMAINING_MS = 300;

/** The server's refusal of a body that names a surface the bearer is not bound to (mcp.ts `surfaceClaimRefusal`). */
const SURFACE_MISMATCH = /this token is (.+) and cannot act as (.+)/;

function none(reason: BriefFailure, detail?: string): BriefResult {
	return detail === undefined
		? { text: "", state: "none", reason }
		: { text: "", state: "none", reason, detail };
}

type Attempt =
	| { kind: "reply"; status: number; briefHeader: string | null; text: string }
	| { kind: "failed"; reason: "timeout" | "unreachable" | "redirect refused" };

/** A fetch told `redirect: "error"` fails with one of these (Bun: code `UnexpectedRedirect`; others word it in the message). */
function isRedirectRefusal(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code = (error as Error & { code?: unknown }).code;
	return (
		code === "UnexpectedRedirect" ||
		/unexpected redirect|redirect is not allowed|redirect mode is set to error/i.test(error.message)
	);
}

/** One POST. Aborts (the caller's or the budget's) read as `timeout`, a refused redirect as `redirect refused`; every other throw as `unreachable`. */
async function postBrief(
	endpoint: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	budgetMs: number,
	caller: AbortSignal | undefined,
	doFetch: typeof fetch,
): Promise<Attempt> {
	const timeout = AbortSignal.timeout(budgetMs);
	const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
	try {
		const response = await doFetch(endpoint, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
			// A redirect would resend the bearer wherever it points, so it is a failure, never followed.
			redirect: "error",
		});
		return {
			kind: "reply",
			status: response.status,
			briefHeader: response.headers.get("x-substrate-brief"),
			text: await response.text(),
		};
	} catch (error) {
		if (signal.aborted) return { kind: "failed", reason: "timeout" };
		const refused = isRedirectRefusal(error);
		return { kind: "failed", reason: refused ? "redirect refused" : "unreachable" };
	}
}

/** The token's own surface from a surface-mismatch 403, or undefined when the body is any other refusal. */
function mismatchTokenSurface(text: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		const error =
			typeof parsed === "object" && parsed !== null
				? (parsed as Record<string, unknown>).error
				: undefined;
		const match = typeof error === "string" ? SURFACE_MISMATCH.exec(error) : null;
		if (!match) return undefined;
		// Only a surface-shaped name reaches a display string; anything else is the server's free text.
		const token = match[1]?.trim() ?? "";
		return isSurfaceName(token) ? token : "unknown";
	} catch {
		return undefined;
	}
}

function classify(reply: Extract<Attempt, { kind: "reply" }>, recovered?: string): BriefResult {
	if (reply.status === 401) return none("unauthorized");
	if (reply.status === 400) return none("bad-request");
	if (reply.status < 200 || reply.status >= 300) return none(`http-${reply.status}`);
	const body = reply.text.trim();
	if (!body) return { text: "", state: "none" };
	const state: BriefState =
		reply.briefHeader === "degraded" || reply.briefHeader === "snapshot"
			? reply.briefHeader
			: "complete";
	const text =
		state === "complete"
			? body
			: `(Substrate brief is ${state}; some sources failed or the copy is a snapshot)\n\n${body}`;
	return recovered === undefined
		? { text, state }
		: { text, state, reason: "surface-mismatch", detail: recovered };
}

/**
 * The session brief as Markdown plus how far to trust it. Never rejects:
 * every failure is a `state: "none"` result whose `reason` says why, and the
 * caller carries on without a brief. `url` is the configured `substrate.url`;
 * `SUBSTRATE_URL` wins.
 *
 * The request names the host's surface. A token bound to another surface is
 * refused with 403 `this token is X and cannot act as Y`; that one answer is
 * retried once without a surface (the server then answers for the bearer's own
 * surface), inside the original timeout budget and only with at least 300 ms
 * left. No other status is retried.
 */
export async function fetchBrief(
	input: BriefInput,
	env: Record<string, string | undefined> = process.env,
	url = "",
	binding?: SubstrateGatewayBinding,
): Promise<BriefResult> {
	try {
		if (binding && serviceBackend(binding.backend, env, SUBSTRATE_BACKEND_ENV) === "gateway") {
			if (env.SUBSTRATE_DISABLED === "1") return none("disabled");
			const resolved = resolveGateway(binding.gateway, env, { storePath: binding.storePath });
			if (!resolved.ok) return none("unreachable");
			const text = await gatewayBrief(resolved.gateway, input, binding.fetch);
			return text ? { text, state: "complete" } : none("unreachable");
		}
		if (env.SUBSTRATE_DISABLED === "1") return none("disabled");
		const target = resolveSubstrate(env, url);
		if (!target) return none("no-url");
		// A cancelled caller sends nothing; the brief is optional, so cancellation reads as "no brief".
		if (input.signal?.aborted) return none("timeout");
		const surface = hostToSurface(input.surface);
		const auth = authHeaders(env, surface);
		const base = endpointBase(target.url, auth);
		if (!base.ok) return none(`url refused: ${base.reason}`);
		const headers = { "content-type": "application/json", ...auth };
		const endpoint = `${base.url}/brief`;
		const budget = timeoutMs(env);
		const deadline = Date.now() + budget;
		const body = {
			repo: input.repo,
			branch: input.branch,
			graph_id: input.graphId,
		};
		const doFetch = input.fetch ?? fetch;
		const first = await postBrief(
			endpoint,
			headers,
			{ ...body, surface },
			budget,
			input.signal,
			doFetch,
		);
		if (first.kind === "failed") return none(first.reason);
		const tokenSurface = first.status === 403 ? mismatchTokenSurface(first.text) : undefined;
		if (tokenSurface === undefined) return classify(first);
		const summary = boundedLine(`token ${tokenSurface} cannot act as host surface ${surface}`);
		const remaining = deadline - Date.now();
		if (remaining < RETRY_MIN_REMAINING_MS)
			return none("surface-mismatch", boundedLine(`${summary}; retry skipped, under 300 ms left`));
		const second = await postBrief(endpoint, headers, body, remaining, input.signal, doFetch);
		if (second.kind === "failed") return none(second.reason);
		return classify(second, boundedLine(`${summary}; retried without surface`));
	} catch {
		return none("unreachable"); // fail-open: a missing substrate never blocks a prompt
	}
}

export interface EmitInput {
	kind: string;
	summary: string;
	surface?: string;
	sessionId?: string;
	graphId?: string;
	nodeId?: string;
	repo?: string;
	branch?: string;
	payload?: Record<string, unknown>;
}

/**
 * Append an event. Returns whether it landed; callers are expected to ignore that.
 * Same opt-in rule as {@link fetchBrief}: no URL, no request. The optional `signal` (the caller's own budget) cuts the
 * request short, or skips it when already aborted, on top of the substrate timeout. The bearer and the surface come
 * from the same helpers as the brief's; `prime-agent` is not a Substrate surface, so its events send none and carry
 * `payload.host`.
 */
export async function emitEvent(
	input: EmitInput,
	env: Record<string, string | undefined> = process.env,
	url = "",
	signal?: AbortSignal,
	binding?: SubstrateGatewayBinding,
): Promise<boolean> {
	if (binding && serviceBackend(binding.backend, env, SUBSTRATE_BACKEND_ENV) === "gateway") {
		if (env.SUBSTRATE_DISABLED === "1") return false;
		const resolved = resolveGateway(binding.gateway, env, { storePath: binding.storePath });
		if (!resolved.ok) return false;
		return gatewayEmit(resolved.gateway, input, binding.fetch, signal);
	}
	const target = resolveSubstrate(env, url);
	if (!target || signal?.aborted) return false;
	try {
		const auth = authHeaders(env, hostToSurface(input.surface));
		const base = endpointBase(target.url, auth);
		if (!base.ok) return false; // no request carries a bearer to an URL the policy refuses
		const timeout = AbortSignal.timeout(timeoutMs(env));
		// One boundary for the bearer and the surface, shared with the brief (D-01, D-06).
		const response = await fetch(`${base.url}/events`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...auth,
			},
			body: JSON.stringify({
				kind: input.kind,
				summary: input.summary,
				surface: hostToEventSurface(input.surface),
				session_id: input.sessionId,
				graph_id: input.graphId,
				node_id: input.nodeId,
				repo: input.repo,
				branch: input.branch,
				payload:
					input.surface === PRIME_AGENT_HOST
						? { ...input.payload, host: PRIME_AGENT_HOST }
						: input.payload,
			}),
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
			redirect: "error",
		});
		return response.ok;
	} catch {
		return false;
	}
}
