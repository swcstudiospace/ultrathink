// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Failure classification for inference calls (Claude CLI, Grok http/cli). Duck-typed on `name`,
 * `apiErrorStatus`, `status`, `code` and the message text so this module imports no route classes.
 */

export type FailureClass =
	| "auth"
	| "billing"
	| "plan-limit"
	| "rate-limit"
	| "overloaded"
	| "model-unavailable"
	| "unavailable"
	| "network"
	| "timeout"
	| "aborted"
	| "other";

/** Apostrophe in `You've`: the CLI prints the typographic one, proxies often the ASCII one. */
const APOSTROPHE = "['\u2019]";

// xAI answers an entitlement gap as a 429 whose limit is 0: the account can never call that model.
const ZERO_LIMIT_RE = /requests per minute \(actual\/limit\):\s*\d+\s*\/\s*0(?!\d)/i;

const MODEL_UNAVAILABLE_RES: readonly RegExp[] = [
	ZERO_LIMIT_RE,
	/requires a grok subscription/i,
	/does not support this model/i,
	/version\s+[\d.]+\s+or newer is required/i,
	new RegExp(`couldn${APOSTROPHE}t set model`, "i"),
	/unknown model id/i,
	/issue with the selected model/i,
	/may not exist or you may not have access/i,
];

const PLAN_LIMIT_RES: readonly RegExp[] = [
	new RegExp(`you${APOSTROPHE}ve hit your\\b[^]*?\\blimit\\b`, "i"),
	/spend limit/i,
];

const BILLING_RES: readonly RegExp[] = [
	/credit balance is too low/i,
	/usage credits required/i,
	/payment required/i,
];

const AUTH_RES: readonly RegExp[] = [
	/not logged in/i,
	/login expired/i,
	/invalid api key/i,
	/invalid x-api-key/i,
	/please run \/login/i,
	/grok login (?:missing|expired|rejected)/i,
	/authentication_error/i,
];

const RATE_LIMIT_RES: readonly RegExp[] = [
	/request rejected \(429\)/i,
	/temporarily limiting requests/i,
	/too many requests/i,
	/rate[ _-]?limit/i,
];

const OVERLOADED_RES: readonly RegExp[] = [/overloaded/i, /service unavailable/i];

const NETWORK_RES: readonly RegExp[] = [
	/fetch failed/i,
	/\beconn(?:reset|refused|aborted)\b/i,
	/\benotfound\b/i,
	/\beai_again\b/i,
	/\betimedout\b/i,
	/\bepipe\b/i,
	/socket hang up/i,
	/network error/i,
	/getaddrinfo/i,
];

/** A spawn that ran out of processes, memory or descriptors, or a child the OS or an OOM killer ended. */
const RESOURCE_CODES: ReadonlySet<string> = new Set(["EAGAIN", "ENOMEM", "EMFILE"]);

const RESOURCE_RES: readonly RegExp[] = [
	/\b(?:eagain|enomem|emfile)\b/i,
	/\bexited (?:with (?:code )?)?137\b/i,
	/\bsig(?:kill|term)\b/i,
	/\boom[- ]?kill/i,
	/out of memory/i,
];

const TIMEOUT_RES: readonly RegExp[] = [/timed out/i, /\btimeout\b/i];

const UNAVAILABLE_RES: readonly RegExp[] = [/\benoent\b/i, /command not found/i];

function anyMatch(res: readonly RegExp[], text: string): boolean {
	return res.some((re) => re.test(text));
}

function readString(error: unknown, key: string): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value: unknown = Reflect.get(error, key);
	return typeof value === "string" ? value : undefined;
}

function readNumber(error: unknown, key: string): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value: unknown = Reflect.get(error, key);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageOf(error: unknown): string {
	if (typeof error === "string") return error;
	return readString(error, "message") ?? "";
}

function statusClass(status: number | undefined): FailureClass | undefined {
	if (status === undefined) return undefined;
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "billing";
	if (status === 408) return "timeout";
	if (status === 429) return "rate-limit";
	if (status >= 500 && status <= 599) return "overloaded";
	return undefined;
}

function isResourceFailure(error: unknown, message: string): boolean {
	const code = readString(error, "code");
	if (code !== undefined && RESOURCE_CODES.has(code)) return true;
	if (readString(error, "signalCode") !== undefined) return true;
	return anyMatch(RESOURCE_RES, message);
}

/** Maps a thrown value from any inference route onto one failover class. */
export function classifyFailure(error: unknown): FailureClass {
	const name = readString(error, "name");
	if (name === "FailoverError") {
		// A chain that ran out of candidates carries the class of its first failure; the clipped text cannot.
		const carried = readString(error, "failure");
		if (carried !== undefined && Object.hasOwn(COOLDOWN_MS, carried)) {
			return carried as FailureClass;
		}
	}
	if (name === "AbortError") return "aborted";
	const message = messageOf(error);
	if (anyMatch(MODEL_UNAVAILABLE_RES, message)) return "model-unavailable";
	if (anyMatch(PLAN_LIMIT_RES, message)) return "plan-limit";
	if (anyMatch(BILLING_RES, message)) return "billing";
	if (name === "GrokAuthError" || anyMatch(AUTH_RES, message)) return "auth";
	const byStatus = statusClass(readNumber(error, "apiErrorStatus") ?? readNumber(error, "status"));
	if (byStatus !== undefined) return byStatus;
	if (anyMatch(RATE_LIMIT_RES, message)) return "rate-limit";
	if (anyMatch(OVERLOADED_RES, message)) return "overloaded";
	if (isResourceFailure(error, message) || anyMatch(NETWORK_RES, message)) return "network";
	if (anyMatch(TIMEOUT_RES, message)) return "timeout";
	if (readString(error, "code") === "ENOENT" || anyMatch(UNAVAILABLE_RES, message)) {
		return "unavailable";
	}
	return "other";
}

const COOLDOWN_MS: Record<FailureClass, number> = {
	auth: 600_000,
	billing: 3_600_000,
	"plan-limit": 900_000,
	"rate-limit": 60_000,
	overloaded: 30_000,
	"model-unavailable": 3_600_000,
	unavailable: 3_600_000,
	network: 30_000,
	timeout: 30_000,
	aborted: 0,
	other: 0,
};

/**
 * Whether trying another candidate can help: the caller's own cancel or an unreadable reply cannot. A timeout can: a
 * hung route is skipped for a short cooldown instead of being retried forever.
 */
export function isFailoverWorthy(failure: FailureClass): boolean {
	return COOLDOWN_MS[failure] > 0;
}

/** How long a candidate that failed this way is skipped before it is retried. */
export function failureCooldownMs(failure: FailureClass): number {
	return COOLDOWN_MS[failure];
}
