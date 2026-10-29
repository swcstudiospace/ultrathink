// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { ROOT_TAGS, type UpliftState } from "../types.ts";
import {
	decideUplift,
	isAlreadyUplifted,
	isCommandPrompt,
	isTrivial,
	stripPrefix,
} from "./detect.ts";

function state(overrides?: Partial<UpliftState>): UpliftState {
	return { enabled: true, skipOnce: false, skipTrivial: true, ...overrides };
}

describe("stripPrefix", () => {
	test("strips raw: case-insensitively", () => {
		expect(stripPrefix("raw: do this exactly")).toEqual({
			text: "do this exactly",
			force: false,
			raw: true,
		});
		expect(stripPrefix("RAW:hello")).toEqual({ text: "hello", force: false, raw: true });
	});

	test("strips uplift: case-insensitively and sets force", () => {
		expect(stripPrefix("uplift: build a form")).toEqual({
			text: "build a form",
			force: true,
			raw: false,
		});
		expect(stripPrefix("Uplift: ok")).toEqual({ text: "ok", force: true, raw: false });
	});

	test("leaves unprefixed text trimmed", () => {
		expect(stripPrefix("  ship it  ")).toEqual({ text: "ship it", force: false, raw: false });
	});
});

describe("isTrivial", () => {
	const trivial = [
		"yes",
		"y",
		"no",
		"n",
		"ok",
		"okay",
		"k",
		"continue",
		"go",
		"go ahead",
		"do it",
		"please",
		"thanks",
		"thank you",
		"sure",
		"yep",
		"nope",
		"lgtm",
		"OK.",
		"lgtm!",
		"go ahead?",
	];
	for (const text of trivial) {
		test(`treats ${JSON.stringify(text)} as trivial`, () => {
			expect(isTrivial(text)).toBe(true);
		});
	}

	test("does not treat real requests as trivial", () => {
		expect(isTrivial("yes please build it")).toBe(false);
		expect(isTrivial("go build the clients list")).toBe(false);
	});
});

describe("isAlreadyUplifted", () => {
	const tags = [...ROOT_TAGS, "uplifted", "ultrathink"];
	for (const tag of tags) {
		test(`detects ${tag} with brackets`, () => {
			expect(isAlreadyUplifted(`<${tag}><ORIGINAL>x</ORIGINAL></${tag}>`)).toBe(true);
		});
		test(`detects ${tag} without brackets`, () => {
			expect(isAlreadyUplifted(tag)).toBe(true);
		});
	}

	test("is case-insensitive", () => {
		expect(isAlreadyUplifted("<build_prompt>x</build_prompt>")).toBe(true);
		expect(isAlreadyUplifted("UPLIFTED")).toBe(true);
	});

	test("does not match tags mid-sentence", () => {
		expect(isAlreadyUplifted("please BUILD_PROMPT this")).toBe(false);
	});

	test("does not treat tag-prefixed prose as already uplifted", () => {
		expect(isAlreadyUplifted("ultrathink implement the clients list")).toBe(false);
		expect(isAlreadyUplifted("BUILD_PROMPT this feature")).toBe(false);
	});

	test("detects a BUILD_PROMPT document", () => {
		expect(isAlreadyUplifted("<BUILD_PROMPT><ORIGINAL>x</ORIGINAL></BUILD_PROMPT>")).toBe(true);
	});

	test("detects bare BUILD_PROMPT", () => {
		expect(isAlreadyUplifted("BUILD_PROMPT")).toBe(true);
	});
});

describe("decideUplift", () => {
	test("raw: passthroughs stripped text and does not uplift", () => {
		expect(decideUplift({ text: "raw: do this exactly", source: "user" }, state())).toEqual({
			action: "passthrough",
			text: "do this exactly",
		});
	});

	test("uplift: forces even when disabled", () => {
		expect(
			decideUplift({ text: "uplift: build a form", source: "user" }, state({ enabled: false })),
		).toEqual({
			action: "uplift",
			text: "build a form",
		});
	});

	test("uplift: forces even when trivial", () => {
		expect(decideUplift({ text: "uplift: ok", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "ok",
		});
	});

	test("skips trivial acknowledgements", () => {
		expect(decideUplift({ text: "lgtm", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "trivial",
		});
		expect(decideUplift({ text: "go ahead!", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "trivial",
		});
	});

	test("skips slash commands", () => {
		expect(decideUplift({ text: "/help", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "command",
		});
		expect(decideUplift({ text: "/uplift on", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "command",
		});
		expect(decideUplift({ text: "/all-in-one:issues list", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "command",
		});
		expect(isCommandPrompt("/all-in-one:grok status")).toBe(true);
		expect(
			decideUplift(
				{
					text: "<command-name>all-in-one:issues</command-name>\n<command-args>list</command-args>",
					source: "user",
				},
				state(),
			),
		).toEqual({ action: "skip", reason: "command" });
		expect(
			decideUplift(
				{
					text: "<command-message>all-in-one:uplift</command-message>\n<command-name>all-in-one:uplift</command-name>",
					source: "user",
				},
				state(),
			),
		).toEqual({ action: "skip", reason: "command" });
		expect(
			decideUplift({ text: "<local-command>compact</local-command>", source: "user" }, state()),
		).toEqual({ action: "skip", reason: "command" });
		expect(isCommandPrompt("please run /help later")).toBe(false);
		expect(decideUplift({ text: "please run /help later", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "please run /help later",
		});
	});

	test("skips already-uplifted roots", () => {
		for (const tag of [...ROOT_TAGS, "uplifted", "ultrathink"]) {
			expect(decideUplift({ text: `<${tag}>x</${tag}>`, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "already-uplifted",
			});
			expect(decideUplift({ text: tag, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "already-uplifted",
			});
		}
	});

	test("skips a prompt that carries out an existing graph unless forced", () => {
		const dispatched =
			"You were dispatched by a task dispatcher for Linear issue ENG-467, graph ut-mughkkc0-1a2b3c4d. Implement the node and open a PR.";
		expect(decideUplift({ text: dispatched, source: "user" }, state())).toEqual({
			action: "skip",
			reason: "graph-reference",
		});
		expect(decideUplift({ text: `uplift: ${dispatched}`, source: "user" }, state())).toEqual({
			action: "uplift",
			text: dispatched,
		});
	});

	test("mentions of graphs or ut- names without a graph id still uplift", () => {
		for (const text of [
			"explain graph theory for the onboarding doc",
			"rename ut-foo to ut-bar in the config",
			"graph ut-mughkkc0-1a2b3c4 is one hex short",
			"see ut-mughkkc0-1a2b3c4d without the graph keyword",
		]) {
			expect(decideUplift({ text, source: "user" }, state())).toEqual({ action: "uplift", text });
		}
	});

	test("skipOnce skips then clears", () => {
		const current = state({ skipOnce: true });
		expect(decideUplift({ text: "build a form", source: "user" }, current)).toEqual({
			action: "skip",
			reason: "skip-once",
		});
		expect(current.skipOnce).toBe(false);
		expect(decideUplift({ text: "build a form", source: "user" }, current)).toEqual({
			action: "uplift",
			text: "build a form",
		});
	});

	test("disabled skips unless force prefix", () => {
		const current = state({ enabled: false });
		expect(decideUplift({ text: "build a form", source: "user" }, current)).toEqual({
			action: "skip",
			reason: "disabled",
		});
		expect(decideUplift({ text: "uplift: build a form", source: "user" }, current)).toEqual({
			action: "uplift",
			text: "build a form",
		});
	});

	test("skips extension source", () => {
		expect(decideUplift({ text: "build a form", source: "extension" }, state())).toEqual({
			action: "skip",
			reason: "extension",
		});
		expect(decideUplift({ text: "uplift: build a form", source: "extension" }, state())).toEqual({
			action: "skip",
			reason: "extension",
		});
	});

	test("skips steer streaming behavior", () => {
		expect(
			decideUplift({ text: "build a form", source: "user", streamingBehavior: "steer" }, state()),
		).toEqual({ action: "skip", reason: "steer" });
	});

	test("skips empty after strip", () => {
		expect(decideUplift({ text: "   ", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "empty",
		});
		expect(decideUplift({ text: "uplift:  ", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "empty",
		});
		expect(decideUplift({ text: "raw:", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "empty",
		});
		expect(decideUplift({ text: "raw:   ", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "empty",
		});
	});

	test("skipTrivial false uplifts trivial text", () => {
		expect(decideUplift({ text: "ok", source: "user" }, state({ skipTrivial: false }))).toEqual({
			action: "uplift",
			text: "ok",
		});
	});

	test("uplifts a normal request", () => {
		expect(decideUplift({ text: "add a clients list page", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "add a clients list page",
		});
	});

	test("uplifts ultrathink prose that is not a tag", () => {
		expect(isAlreadyUplifted("ultrathink implement the clients list")).toBe(false);
		expect(
			decideUplift(
				{ text: "ultrathink implement the clients list", source: "interactive" },
				state(),
			),
		).toEqual({
			action: "uplift",
			text: "ultrathink implement the clients list",
		});
	});

	test("skips when session is not idle", () => {
		expect(
			decideUplift({ text: "also fix the button", source: "interactive", idle: false }, state()),
		).toEqual({ action: "skip", reason: "steer" });
	});

	test("uplifts when idle is true or undefined", () => {
		expect(
			decideUplift({ text: "also fix the button", source: "interactive", idle: true }, state()),
		).toEqual({
			action: "uplift",
			text: "also fix the button",
		});
		expect(decideUplift({ text: "also fix the button", source: "interactive" }, state())).toEqual({
			action: "uplift",
			text: "also fix the button",
		});
	});
});

describe("path-aware commands (L2-01)", () => {
	test("a first token with a second slash is prose, not a command", () => {
		expect(isCommandPrompt("/root/src/x.ts is broken")).toBe(false);
		expect(decideUplift({ text: "/root/src/x.ts is broken", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "/root/src/x.ts is broken",
		});
	});

	test("a bare /word that resolves on disk is prose; an unresolved one stays a command", () => {
		expect(isCommandPrompt("/tmp is full", { exists: (p) => p === "/tmp" })).toBe(false);
		expect(isCommandPrompt("/model sonnet", { exists: () => false })).toBe(true);
		expect(decideUplift({ text: "/tmp is full", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "/tmp is full",
		});
	});

	test("a throwing exists seam is treated as not existing", () => {
		expect(
			isCommandPrompt("/model sonnet", {
				exists: () => {
					throw new Error("EACCES");
				},
			}),
		).toBe(true);
	});

	test("unknown bare /word stays a command at this lookup-free layer; planningTarget refines it", () => {
		expect(decideUplift({ text: "/frobnicate do the thing", source: "user" }, state())).toEqual({
			action: "skip",
			reason: "command",
		});
	});
});

describe("uplift: force bypasses command and already-uplifted checks (L2-02)", () => {
	test("uplift: with a path-led prompt uplifts", () => {
		expect(
			decideUplift({ text: "uplift: /root/src/x.ts is broken", source: "user" }, state()),
		).toEqual({ action: "uplift", text: "/root/src/x.ts is broken" });
	});

	test("uplift: with an already-uplifted spec or a bare command redoes the uplift", () => {
		expect(
			decideUplift({ text: "uplift: <FIX_PROMPT>x</FIX_PROMPT>", source: "user" }, state()),
		).toEqual({ action: "uplift", text: "<FIX_PROMPT>x</FIX_PROMPT>" });
		expect(decideUplift({ text: "uplift: FIX_PROMPT", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "FIX_PROMPT",
		});
		expect(decideUplift({ text: "uplift: /model sonnet", source: "user" }, state())).toEqual({
			action: "uplift",
			text: "/model sonnet",
		});
	});
});

describe("referencesPlannedGraph hand-off shape (L2-07)", () => {
	const id = "ut-mughkkc0-1a2b3c4d";
	test("a quoted graph id plans, near the start or far into the prompt", () => {
		const quoted = `The log line says "graph ${id}" was dropped by the dispatcher, please investigate.`;
		expect(decideUplift({ text: quoted, source: "user" }, state())).toEqual({
			action: "uplift",
			text: quoted,
		});
		const late = `${"We saw a retry storm in the dispatcher last night and nobody knows why. ".repeat(3)}The id graph ${id} appeared in the log.`;
		expect(decideUplift({ text: late, source: "user" }, state())).toEqual({
			action: "uplift",
			text: late,
		});
	});

	test("a mid-sentence id inside the first 100 characters is ordinary text and plans (G-3)", () => {
		for (const prompt of [
			`why did graph ${id} fail?`,
			`Per graph ${id} the plan was wrong; redo the plan from scratch and add caching`,
			`Redo graph ${id} with caching added`,
			`Is graph ${id} still valid after the schema change?`,
			`Start by explaining why graph ${id} failed last night`,
		]) {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "uplift",
				text: prompt,
			});
		}
	});

	test("the shapes the dispatcher, kickoff and swarm lanes really send keep skipping (G-3)", () => {
		for (const prompt of [
			`Implement node n2 of graph ${id}.`,
			`implement unit 3 of graph ${id} and open a PR`,
			`Execute node n4 of graph ${id}`,
			`Graph ID: ${id}\nBuild the exporter and open a PR.`,
			`Lane brief for ENG-12.\nGraph ID: ${id}\nBuild the exporter.`,
			`graph ${id}: implement the parser node`,
		]) {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "graph-reference",
			});
		}
	});

	test("a question or report that mentions an id still plans (G-3)", () => {
		for (const prompt of [
			`what is graph ${id}?`,
			`Why did node n2 of graph ${id} fail?`,
			`The Graph ID: ${id} in that issue looks wrong, can you check it?`,
			`Please summarise the failure history of graph ${id}`,
		]) {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "uplift",
				text: prompt,
			});
		}
	});

	test("run, kick off and start hand a graph over; the dispatcher preamble still does (G-3)", () => {
		for (const prompt of [
			`run graph ${id}`,
			`Kick off graph ${id} and open a PR`,
			`start graph ${id} now`,
			`Please carry out graph ${id}`,
			`You were dispatched by a task dispatcher for Linear issue ENG-467, graph ${id}. Implement the node.`,
		]) {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "graph-reference",
			});
		}
	});

	test("hand-off shapes skip with the graph-reference reason", () => {
		for (const prompt of [
			`continue graph ${id}`,
			`graph ${id} next steps`,
			`Please execute graph ${id} now`,
			`resume work on graph ${id}`,
		]) {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "graph-reference",
			});
		}
	});
});

describe("the hand-off verb starts the sentence that holds the graph id (G-3b)", () => {
	const id = "ut-mughkkc0-1a2b3c4d";
	const skips: string[] = [
		`Execute the plan in graph ${id}`,
		`Implement node n3 of graph ${id}`,
		`Please resume graph ${id} and open a PR`,
		`Linear issue ENG-9 is open. Start graph ${id} now`,
		`Graph ID: ${id}\nBuild the exporter and open a PR.`,
		`You were dispatched by a task dispatcher for Linear issue ENG-467, graph ${id}. Implement the node.`,
	];
	const plans: string[] = [
		`Why did the run of graph ${id} fail?`,
		`Linear issue ENG-9 is tracked under graph ${id}. Implement it.`,
		`We want to continue graph ${id} later and understand why it stalled`,
		`Before you execute anything, tell me whether graph ${id} is still valid`,
		`I tried to resume graph ${id} but it errored out`,
		`Is graph ${id} done? Run the tests afterwards`,
	];
	for (const prompt of skips) {
		test(`skips: ${prompt.replace(/\n/g, " / ")}`, () => {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "graph-reference",
			});
		});
	}
	for (const prompt of plans) {
		test(`plans: ${prompt}`, () => {
			expect(decideUplift({ text: prompt, source: "user" }, state())).toEqual({
				action: "uplift",
				text: prompt,
			});
		});
	}
});

describe("acknowledgement set (L2-08)", () => {
	for (const text of ["ok thanks", "yeah", "done", "thx", "\u{1f44d}", "got it", "stop", "wait"]) {
		test(`skips ${JSON.stringify(text)} before any model call`, () => {
			expect(isTrivial(text)).toBe(true);
			expect(decideUplift({ text, source: "user" }, state())).toEqual({
				action: "skip",
				reason: "trivial",
			});
		});
	}

	for (const text of ["ok do it", "yes but add tests", "continue with the plan", "lgtm merge it"]) {
		test(`plans ${JSON.stringify(text)}`, () => {
			expect(isTrivial(text)).toBe(false);
			expect(decideUplift({ text, source: "user" }, state())).toEqual({ action: "uplift", text });
		});
	}
});

describe("every skip carries a machine-readable reason (L2-12)", () => {
	type SkipReason = Extract<ReturnType<typeof decideUplift>, { action: "skip" }>["reason"];
	const cases: [SkipReason, Parameters<typeof decideUplift>[0], Partial<UpliftState>][] = [
		["extension", { text: "build x", source: "extension" }, {}],
		["steer", { text: "build x", source: "user", streamingBehavior: "steer" }, {}],
		["steer", { text: "build x", source: "user", idle: false }, {}],
		["empty", { text: "   ", source: "user" }, {}],
		["command", { text: "/help", source: "user" }, {}],
		["already-uplifted", { text: "<BUILD_PROMPT>x</BUILD_PROMPT>", source: "user" }, {}],
		["skip-once", { text: "build x", source: "user" }, { skipOnce: true }],
		["disabled", { text: "build x", source: "user" }, { enabled: false }],
		["trivial", { text: "ok", source: "user" }, {}],
	];
	for (const [reason, event, overrides] of cases) {
		test(`${reason}: ${JSON.stringify(event.text)}`, () => {
			expect(decideUplift(event, state(overrides))).toEqual({ action: "skip", reason });
		});
	}
});
