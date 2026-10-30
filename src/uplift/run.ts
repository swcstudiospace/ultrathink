// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { isAbortError } from "../shared.ts";
import type { CompletionReport, UpliftResult } from "../types.ts";
import { fallbackUplift } from "./fallback.ts";
import { UPLIFT_SYSTEM_PROMPT } from "./prompt.ts";
import { checkUpliftXml } from "./xml.ts";

function buildPayload(original: string, conversation?: string): string {
	if (conversation?.trim()) {
		return `<conversation>\n${conversation}\n</conversation>\n\n<user_request>\n${original}\n</user_request>`;
	}
	return `<user_request>\n${original}\n</user_request>`;
}

function fallbackResult(original: string): UpliftResult {
	const xml = fallbackUplift(original);
	return { xml, original, root: "UPLIFTED_PROMPT", source: "fallback" };
}

function fallbackWith(
	original: string,
	fallbackReason: string,
	rawReplyChars: number,
	attempts: number,
): UpliftResult {
	return { ...fallbackResult(original), fallbackReason, rawReplyChars, attempts };
}

/** `provider_error:<status>` when the provider's HTTP status is known, else `provider_error`. */
function providerReason(report: CompletionReport | undefined): string {
	return report?.httpStatus === undefined
		? "provider_error"
		: `provider_error:${report.httpStatus}`;
}

export async function runUplift(input: {
	original: string;
	conversation?: string;
	complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
	/** The completer's report for its most recent call; absent when the route reports nothing. */
	report?: () => CompletionReport | undefined;
}): Promise<UpliftResult> {
	const original = input.original;

	// The report seam is the completer's own bookkeeping: a throwing one reads as absent and never escapes.
	const readReport = (): CompletionReport | undefined => {
		try {
			return input.report?.();
		} catch {
			// reason: fail-open: a broken report seam must not turn an uplift into a failed flight
			return undefined;
		}
	};

	let raw: unknown;
	try {
		raw = await input.complete(
			UPLIFT_SYSTEM_PROMPT,
			buildPayload(original, input.conversation),
			input.signal,
		);
	} catch (error) {
		if (isAbortError(error)) throw error;
		const report = readReport();
		return fallbackWith(original, providerReason(report), 0, report?.attempts ?? 1);
	}

	const report = readReport();
	const attempts = report?.attempts ?? 1;
	if (raw !== undefined && raw !== null && typeof raw !== "string") {
		return fallbackWith(original, "engine_error", 0, attempts);
	}
	const reply = raw ?? "";
	try {
		if (!reply.trim()) return fallbackWith(original, "empty_reply", reply.length, attempts);
		const checked = checkUpliftXml(reply, original);
		if (!checked.ok) {
			// A root opened and never closed is a cut-off reply; everything else is a reply that is not an uplift.
			const reason = checked.reason === "unclosed_root" ? "truncated_reply" : "unparseable_reply";
			return fallbackWith(original, reason, reply.length, attempts);
		}
		const xml = checked.xml;
		return {
			xml,
			original,
			root: xml.trim().match(/^<([A-Za-z_][\w.-]*)\b/)?.[1] ?? "UPLIFTED_PROMPT",
			source: "llm",
			...(report ? { attempts } : {}),
		};
	} catch {
		// reason: fail-open: an engine bug while post-processing a reply falls back instead of failing the flight
		return fallbackWith(original, "engine_error", reply.length, attempts);
	}
}
