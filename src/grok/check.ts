// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { classifyFailure, type FailureClass } from "../failover/classify.ts";
import { type GrokAuthStatus, grokAuthStatus, redactSecrets } from "./auth.ts";
import { type GrokCallInfo, grokComplete } from "./complete.ts";
import type { GrokConfig } from "./types.ts";

export interface GrokCheckOptions {
	model?: string;
	transport?: "http" | "cli";
	json?: boolean;
}

export interface GrokCheckDeps {
	/** `config.grok`; the call goes through exactly this route. */
	grok: GrokConfig;
	/** Test seam. */
	complete?: typeof grokComplete;
	/** Test seam; default `grokAuthStatus`. */
	status?: (home?: string) => GrokAuthStatus;
	now?: () => number;
}

export interface GrokCheckResult {
	ok: boolean;
	exitCode: 0 | 1;
	text: string;
	json: Record<string, unknown>;
}

const PROBE_SYSTEM = "You are a connectivity probe. Answer with exactly what is asked.";
const PROBE_PROMPT = "Reply with exactly the single word: pong";
const MAX_MESSAGE_CHARS = 240;
const PROBE_MAX_TOKENS = 16;

/** Fix hints per failure class; classes without an actionable fix print none. */
function fixHint(failure: FailureClass, model: string): string | undefined {
	switch (failure) {
		case "model-unavailable":
			return `the login is not entitled to ${model} (xAI answers 429 with a request limit of 0): run \`ultrathink grok login\` as the xAI account that holds Grok Build`;
		case "auth":
			return "run `ultrathink grok login`";
		case "plan-limit":
		case "rate-limit":
			return "the plan is rate limited, retry later";
		default:
			return undefined;
	}
}

function oneLine(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactSecrets(message).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * A one-word probe through the configured Grok route, reported as a line and a JSON mirror.
 * The cap of PROBE_MAX_TOKENS output tokens applies on the HTTP and shunt routes only; the
 * CLI route has no token cap, so the prompt itself asks for one word. Never prints a token.
 */
export async function runGrokCheck(
	deps: GrokCheckDeps,
	opts: GrokCheckOptions = {},
): Promise<GrokCheckResult> {
	const complete = deps.complete ?? grokComplete;
	const status = deps.status ?? grokAuthStatus;
	const now = deps.now ?? Date.now;
	const transport = opts.transport ?? deps.grok.transport;
	// A shunt gateway pins its route by alias, and that alias (not grok.model) is what is sent.
	const alias = transport === "shunt" ? deps.grok.shuntModel.trim() : "";
	const shuntAlias = alias !== "";
	const model = shuntAlias ? alias : opts.model?.trim() || deps.grok.model;
	const aliasNote = shuntAlias ? " (shunt alias)" : "";
	const home = deps.grok.home.trim() || undefined;

	let info: GrokCallInfo = {};
	const started = now();
	try {
		await complete(PROBE_SYSTEM, PROBE_PROMPT, {
			transport,
			model,
			reasoningEffort: deps.grok.reasoningEffort,
			baseUrl: deps.grok.baseUrl,
			bin: deps.grok.bin,
			home,
			timeoutMs: deps.grok.callTimeoutMs,
			shuntBaseUrl: deps.grok.shuntBaseUrl,
			shuntModel: deps.grok.shuntModel,
			shuntMaxTokens: PROBE_MAX_TOKENS,
			maxOutputTokens: PROBE_MAX_TOKENS,
			onResult: (result) => {
				info = result;
			},
		});
	} catch (error) {
		const failure = classifyFailure(error);
		const message = oneLine(error);
		const fix = fixHint(failure, `${model}${aliasNote}`);
		const text = `Grok check: error (${failure}) · ${message}${fix ? ` · fix: ${fix}` : ""}`;
		return {
			ok: false,
			exitCode: 1,
			text,
			json: {
				ok: false,
				class: failure,
				message,
				model,
				...(shuntAlias ? { shuntAlias: true } : {}),
				transport,
				...(fix ? { fix } : {}),
			},
		};
	}

	const seconds = Number(((now() - started) / 1000).toFixed(1));
	const reportedModel = info.model ?? model;
	const account = status(home).email;
	const parts = [`Grok check: ok`, `${reportedModel}${aliasNote}`, `${seconds} s`];
	if (info.inputTokens !== undefined || info.outputTokens !== undefined)
		parts.push(`in ${info.inputTokens ?? "?"} out ${info.outputTokens ?? "?"}`);
	if (account) parts.push(`account ${account}`);
	parts.push(`home ${home ?? "default"}`, `transport ${transport}`);
	return {
		ok: true,
		exitCode: 0,
		text: parts.join(" · "),
		json: {
			ok: true,
			model: reportedModel,
			...(shuntAlias ? { shuntAlias: true } : {}),
			seconds,
			...(info.inputTokens !== undefined ? { inputTokens: info.inputTokens } : {}),
			...(info.outputTokens !== undefined ? { outputTokens: info.outputTokens } : {}),
			...(account ? { account } : {}),
			home: home ?? "default",
			transport,
		},
	};
}
