// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { existsSync } from "node:fs";
import { ROOT_TAGS, type UpliftDecision, type UpliftState } from "../types.ts";

const ALREADY_TAGS = [...ROOT_TAGS, "uplifted", "ultrathink"] as const;
const ALREADY_ROOTS: Record<string, true> = Object.fromEntries(
	ALREADY_TAGS.map((tag) => [tag.toLowerCase(), true as const]),
);
/** Single words that acknowledge without asking for work. A prompt made only of these skips before any model call. */
const ACK_WORDS: ReadonlySet<string> = new Set([
	..."ok okay k yes y yeah yep yup no n nope thanks thx cool done stop wait sure fine great nice awesome perfect go ahead on proceed next continue please lgtm".split(
		" ",
	),
	"\u{1f44d}",
	"\u{1f64f}",
	"\u{1f44c}",
	"\u2705",
]);
/** Short phrases that are acknowledgements only as the whole prompt (`ok do it` is a request, `do it` is a nod). */
const ACK_PHRASES: ReadonlySet<string> = new Set(["do it", "got it", "thank you"]);
const HANDOFF_FILLER_WORDS = 3;
const HANDOFF_DISPATCH_GAP_WORDS = 12;
/** Verbs that hand a graph to the agent (`execute graph ut-…`), each with how many words may sit between it and `graph`. */
const HANDOFF_VERBS: readonly { verb: readonly string[]; gap: number }[] = [
	{ verb: ["implement"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["kickoff"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["execute"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["carry", "out"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["continue"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["resume"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["run"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["kick", "off"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["start"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["pick", "up"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["work", "on"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["finish"], gap: HANDOFF_FILLER_WORDS },
	{ verb: ["complete"], gap: HANDOFF_FILLER_WORDS },
];
/** Politeness words that may come before the hand-off verb without making the sentence something else. */
const HANDOFF_LEADERS: readonly string[] = [
	"please",
	"kindly",
	"now",
	"then",
	"also",
	"and",
	"just",
];
const QUOTE_CHARS = "\"'`\u201c\u2018";

const COMMAND_TAG_RE = /^<(?:command-name|command-message|local-command)\b/i;
/** An existing ultrathink graph id introduced by "graph" or "Graph ID:", e.g. `graph ut-mugl6r87-70da50da`. */
const PLANNED_GRAPH_RE = /\bgraph(?:\s+id)?(?:\s*:\s*|\s+)ut-[a-z0-9]+-[0-9a-f]{8}\b/gi;

type SkipReason =
	| "extension"
	| "steer"
	| "command"
	| "already-uplifted"
	| "graph-reference"
	| "skip-once"
	| "disabled"
	| "trivial"
	| "empty";

/** `uplift` and `passthrough` as in `UpliftDecision`; a skip names why, for the hook log, status notes and tests. */
type UpliftChoice =
	| Exclude<UpliftDecision, { action: "skip" }>
	| { action: "skip"; reason: SkipReason };

/**
 * User-typed `/cmd` and Claude Code expansions (`<command-name>…`) must not be rewritten. A first token with a second
 * `/` (`/root/src/x.ts`) or one that names an existing path (`/tmp`) is prose. Every other bare `/word` is a command
 * here: this layer is lookup-free. Known commands versus installed skills versus unknown words is `planningTarget`'s call.
 */
export function isCommandPrompt(
	text: string,
	opts?: { exists?: (path: string) => boolean },
): boolean {
	const trimmed = text.trim();
	if (COMMAND_TAG_RE.test(trimmed)) return true;
	if (!trimmed.startsWith("/")) return false;
	const space = trimmed.search(/\s/);
	const token = space === -1 ? trimmed : trimmed.slice(0, space);
	if (token.indexOf("/", 1) !== -1) return false;
	try {
		return !(opts?.exists ?? existsSync)(token);
	} catch {
		// reason: fail-open: an unreadable path is not a path; the prompt stays a command
		return true;
	}
}

export function stripPrefix(text: string): { text: string; force: boolean; raw: boolean } {
	const trimmed = text.trim();
	const rawMatch = trimmed.match(/^raw:\s*/i);
	if (rawMatch) {
		return { text: trimmed.slice(rawMatch[0].length).trim(), force: false, raw: true };
	}
	const forceMatch = trimmed.match(/^uplift:\s*/i);
	if (forceMatch) {
		return { text: trimmed.slice(forceMatch[0].length).trim(), force: true, raw: false };
	}
	return { text: trimmed, force: false, raw: false };
}

export function isTrivial(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s\p{Extended_Pictographic}]/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (normalized.length === 0) return false;
	return ACK_PHRASES.has(normalized.join(" ")) || normalized.every((word) => ACK_WORDS.has(word));
}

export function isAlreadyUplifted(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.startsWith("<")) {
		const tag = /^<([A-Za-z_][\w.-]*)/.exec(trimmed)?.[1];
		return tag !== undefined && ALREADY_ROOTS[tag.toLowerCase()] === true;
	}
	return ALREADY_ROOTS[trimmed.toLowerCase()] === true;
}

/** Words that name the part of a graph being handed over: `implement node n2 of graph …`. */
const GRAPH_PART_WORDS: readonly string[] = ["node", "nodes", "unit", "task", "step", "wave"];

/** Words that may sit between the hand-off verb and `graph` (`execute the plan in graph …`); anything else is a different sentence. */
const HANDOFF_FILLER: readonly string[] = [
	"the",
	"a",
	"an",
	"this",
	"that",
	"existing",
	"planned",
	"plan",
	"work",
	"in",
	"on",
	"of",
	"for",
	"with",
	"to",
	"from",
	"out",
	"up",
	"at",
];

/** Up to `limit` filler words, or the longer `<part> <id> of` that names which piece of the graph is handed over. */
function gapAllowed(gap: readonly string[], limit: number): boolean {
	if (gap.length <= limit && gap.every((word) => HANDOFF_FILLER.includes(word))) return true;
	return (
		gap.length <= 5 && gap.at(-1) === "of" && gap.some((word) => GRAPH_PART_WORDS.includes(word))
	);
}

/**
 * True when the sentence's `words` (the words before the graph id) begin with a hand-off verb followed by at most that
 * verb's gap of words, or carry the dispatcher preamble (`dispatched … graph`, the one longer form).
 */
function handsOff(words: string[]): boolean {
	let start = 0;
	while (start < words.length && HANDOFF_LEADERS.includes(words[start]!)) start++;
	for (const { verb, gap } of HANDOFF_VERBS) {
		if (!verb.every((part, offset) => words[start + offset] === part)) continue;
		if (gapAllowed(words.slice(start + verb.length), gap)) return true;
	}
	const dispatched = words.indexOf("dispatched");
	return dispatched !== -1 && words.length - dispatched - 1 <= HANDOFF_DISPATCH_GAP_WORDS;
}

/**
 * The prompt carries out an already-planned graph (a dispatcher or kickoff hand-off); planning it again would fork the
 * graph. Only a hand-off shape counts: `graph <id>` opens the prompt, or the sentence that holds the id (the text since
 * the previous `.`, `?`, `!` or newline) starts with a hand-off verb (`execute the plan in graph …`, at most a few filler
 * words between; the dispatcher preamble is the one longer form). A quoted id, or one mentioned in any other sentence
 * (`why did the run of graph … fail?`, `we want to continue graph … later`), is ordinary text.
 */
function referencesPlannedGraph(text: string): boolean {
	for (const match of text.matchAll(PLANNED_GRAPH_RE)) {
		const at = match.index ?? 0;
		if (at > 0 && QUOTE_CHARS.includes(text.charAt(at - 1))) continue;
		if (text.slice(0, at).trim() === "") return true;
		// The `Graph ID: ut-…` line of a lane brief is a structured hand-off wherever its line sits.
		if (/^graph\s+id\b/i.test(match[0]) && /(?:^|\n)[ \t]*$/.test(text.slice(0, at))) return true;
		const head = text.slice(0, at);
		const sentenceStart = Math.max(
			head.lastIndexOf("."),
			head.lastIndexOf("?"),
			head.lastIndexOf("!"),
			head.lastIndexOf("\n"),
		);
		const words = head
			.slice(sentenceStart + 1)
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter(Boolean);
		if (handsOff(words)) return true;
	}
	return false;
}

export function decideUplift(
	event: { text: string; source: string; streamingBehavior?: string; idle?: boolean },
	state: UpliftState,
): UpliftChoice {
	if (event.source === "extension") return { action: "skip", reason: "extension" };
	if (event.idle === false || event.streamingBehavior === "steer") {
		return { action: "skip", reason: "steer" };
	}

	const { text, force, raw } = stripPrefix(event.text);
	if (!text) return { action: "skip", reason: "empty" };
	if (raw) return { action: "passthrough", text };

	// `uplift:` is the user overriding the guards: a command-shaped or already-uplifted prompt is redone on request.
	if (!force) {
		if (isCommandPrompt(text)) return { action: "skip", reason: "command" };
		if (isAlreadyUplifted(text)) return { action: "skip", reason: "already-uplifted" };
		if (referencesPlannedGraph(text)) return { action: "skip", reason: "graph-reference" };
	}

	if (state.skipOnce) {
		state.skipOnce = false;
		return { action: "skip", reason: "skip-once" };
	}

	if (!state.enabled && !force) return { action: "skip", reason: "disabled" };
	if (isTrivial(text) && !force && state.skipTrivial !== false) {
		return { action: "skip", reason: "trivial" };
	}
	return { action: "uplift", text };
}
