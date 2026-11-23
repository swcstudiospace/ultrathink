// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYBOOK_ROUTES, playbookForStage } from "./subagents.ts";
import {
	PSTACK_REQUIRED_ARG,
	PSTACK_STRICT_ENV,
	fleetStateFor,
	redactReason,
	resolveFleetOutcome,
	resolveStrictFlag,
	type PhaseType,
} from "./outcome.ts";
import { dispatchPhasePlaybook, shouldAdvancePhase } from "./dispatcher.ts";

const SIX = ["how", "architect", "arena", "tdd", "interrogate", "no-comments"];

// Same fixture shape as subagents.test.ts: a completed pstack plugin cache
// with the six skills and the four playbooks, resolved from `$homeDir`.
function mkFleetHome(
	names: readonly string[],
	playbooks = ["investigation", "multi-phase-plan", "feature", "shipping"],
): string {
	const home = mkdtempSync(join(tmpdir(), "fleet-outcome-"));
	const pluginDir = join(
		home,
		".cursor",
		"plugins",
		"cache",
		"cursor-public",
		"pstack",
		"pstack@1.2.0",
	);
	mkdirSync(join(pluginDir, ".cursor-plugin"), { recursive: true });
	writeFileSync(
		join(pluginDir, ".cursor-plugin", "plugin.json"),
		JSON.stringify({ name: "pstack", version: "1.2.0" }),
	);
	writeFileSync(join(pluginDir, ".cache-complete"), "");
	for (const name of names) {
		mkdirSync(join(pluginDir, "skills", name), { recursive: true });
		writeFileSync(join(pluginDir, "skills", name, "SKILL.md"), `# ${name}\n`);
	}
	const potetoDir = join(pluginDir, "skills", "poteto-mode");
	mkdirSync(join(potetoDir, "playbooks"), { recursive: true });
	writeFileSync(join(potetoDir, "SKILL.md"), "# poteto-mode\n");
	for (const title of playbooks) {
		writeFileSync(join(potetoDir, "playbooks", `${title}.md`), `# ${title}\n`);
	}
	return home;
}

let emptyDir = "";
let fullDir = "";
let noPlaybookDir = "";

beforeAll(() => {
	emptyDir = mkdtempSync(join(tmpdir(), "fleet-empty-"));
	fullDir = mkFleetHome(SIX);
	noPlaybookDir = mkFleetHome(SIX, ["investigation"]);
});

afterAll(() => {
	for (const dir of [emptyDir, fullDir, noPlaybookDir]) {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("PLAYBOOK_ROUTES (AC-41..AC-43)", () => {
	test("four routes pinned in phase order", () => {
		expect([...PLAYBOOK_ROUTES]).toEqual([
			["discuss", "investigation"],
			["plan", "multi-phase-plan"],
			["execute", "feature"],
			["review", "shipping"],
		]);
	});

	test("discuss routes to investigation and the roster lists how under discuss", () => {
		expect(playbookForStage("discuss")).toBe("investigation");
		const outcome = resolveFleetOutcome({ phaseType: "discuss", enabled: true, homeDir: fullDir });
		expect(outcome.playbook).toBe("investigation");
		expect(outcome.roster).toContain("- [discuss] how");
	});

	test("plan/execute/review route to multi-phase-plan/feature/shipping", () => {
		const expected: [PhaseType, string][] = [
			["plan", "multi-phase-plan"],
			["execute", "feature"],
			["review", "shipping"],
		];
		for (const [phaseType, title] of expected) {
			expect(playbookForStage(phaseType)).toBe(title);
			expect(resolveFleetOutcome({ phaseType, enabled: true, homeDir: fullDir }).playbook).toBe(
				title,
			);
		}
	});
});

describe("resolveFleetOutcome typed states (AC-49)", () => {
	test("resolvable fleet returns state ok with reasonCode ok", () => {
		const outcome = resolveFleetOutcome({ phaseType: "execute", enabled: true, homeDir: fullDir });
		expect(outcome.state).toBe("ok");
		expect(outcome.ok).toBe(true);
		expect(outcome.reasonCode).toBe("ok");
		expect(outcome.fallback).toBe("blocked"); // resolved: no fallback taken
		expect(outcome.fleet?.ok).toBe(true);
		expect(outcome.roster).toContain("## PSTACK subagent fleet");
	});

	test("disabled, unresolvable and forced-off are typed and never empty", () => {
		expect(resolveFleetOutcome({ phaseType: "plan", enabled: false, homeDir: fullDir }).state).toBe(
			"disabled",
		);
		expect(resolveFleetOutcome({ phaseType: "plan", enabled: true, homeDir: emptyDir }).state).toBe(
			"unresolvable",
		);
		expect(
			resolveFleetOutcome({ phaseType: "plan", enabled: true, homeDir: fullDir, forcedOff: true })
				.state,
		).toBe("forced-off");
		for (const state of ["ok", "disabled", "unresolvable", "forced-off", "blocked"] as const) {
			expect(state.length).toBeGreaterThan(0);
		}
	});

	test("fleetStateFor maps fleet reasons onto contract states", () => {
		expect(fleetStateFor("pstack bridge forced off (ULTRATHINK_PSTACK=0)")).toBe("forced-off");
		expect(fleetStateFor("pstack bridge disabled")).toBe("disabled");
		expect(fleetStateFor("pstack cache directory not found")).toBe("unresolvable");
	});
});

describe("fail-open default, fail-closed only on override (AC-44/AC-45)", () => {
	test("absent cache fails open: fallback vanilla, strict false", () => {
		const outcome = resolveFleetOutcome({ phaseType: "execute", enabled: true, homeDir: emptyDir });
		expect(outcome.ok).toBe(false);
		expect(outcome.strict).toBe(false);
		expect(outcome.fallback).toBe("vanilla");
		expect(outcome.reasonCode).toBe("unresolvable");
	});

	test("each explicit strict source fails closed", () => {
		for (const overrides of [
			{ strict: true },
			{ configStrict: true },
			{ env: { [PSTACK_STRICT_ENV]: "1" } },
			{ argv: [PSTACK_REQUIRED_ARG] },
		]) {
			const outcome = resolveFleetOutcome({
				phaseType: "execute",
				enabled: true,
				homeDir: emptyDir,
				...overrides,
			});
			expect(outcome.strict).toBe(true);
			expect(outcome.fallback).toBe("blocked");
		}
	});

	test("resolveStrictFlag reads env, config and CLI alias; default is fail-open", () => {
		expect(resolveStrictFlag({})).toBe(false);
		expect(resolveStrictFlag({ configStrict: true })).toBe(true);
		expect(resolveStrictFlag({ env: { [PSTACK_STRICT_ENV]: "1" } })).toBe(true);
		expect(resolveStrictFlag({ env: { [PSTACK_STRICT_ENV]: "0" } })).toBe(false);
		expect(resolveStrictFlag({ argv: ["--pstack-required"] })).toBe(true);
		expect(resolveStrictFlag({ argv: ["something-else"] })).toBe(false);
	});

	describe("resolveStrictFlag precedence (THREAT-STRICT-WIRING)", () => {
		test("explicit disable never disarms an arming source", () => {
			expect(
				resolveStrictFlag({ strict: false, configStrict: true, env: { [PSTACK_STRICT_ENV]: "0" } }),
			).toBe(true);
			expect(
				resolveStrictFlag({ env: { [PSTACK_STRICT_ENV]: "0" }, argv: [PSTACK_REQUIRED_ARG] }),
			).toBe(true);
			expect(resolveStrictFlag({ strict: false, configStrict: false })).toBe(false);
		});

		test("precedence order: caller > config > env > argv, default fail-open", () => {
			expect(resolveStrictFlag({ strict: true })).toBe(true);
			expect(resolveStrictFlag({ configStrict: true })).toBe(true);
			expect(resolveStrictFlag({ env: { [PSTACK_STRICT_ENV]: "1" } })).toBe(true);
			expect(resolveStrictFlag({ argv: [PSTACK_REQUIRED_ARG] })).toBe(true);
			expect(resolveStrictFlag({})).toBe(false);
			expect(
				resolveStrictFlag({
					strict: false,
					configStrict: false,
					env: { [PSTACK_STRICT_ENV]: "0" },
					argv: ["other"],
				}),
			).toBe(false);
		});
	});
});

describe("redactReason (NFR-19)", () => {
	test("secret-shaped substrings are redacted, normal reasons pass through", () => {
		expect(redactReason("pstack cache directory not found")).toBe(
			"pstack cache directory not found",
		);
		expect(redactReason("token=abc123 failed")).not.toContain("abc123");
		expect(redactReason("key sk-1234567890abcdef failed")).not.toContain("sk-1234567890abcdef");
		expect(redactReason(`ghp_${"A".repeat(30)}`)).not.toContain("ghp_");
	});

	test("parity with redactSecrets: JWT, Bearer, PEM, URL and auth header", () => {
		const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;
		expect(redactReason(`JWT ${jwt}`)).not.toContain(jwt);
		expect(redactReason("Authorization: Bearer abcdefghij123456")).not.toContain(
			"abcdefghij123456",
		);
		expect(redactReason("fetch https://user:pass123456789@example.com/x")).not.toContain(
			"pass123456789",
		);
		expect(redactReason("-----BEGIN PRIVATE KEY----- MII")).not.toContain("PRIVATE KEY");
		expect(redactReason("")).toBe("");
	});
});

describe("one-line summary (AC-47)", () => {
	test("outcome summaryLine names phase, playbook and fleet in one plain line", () => {
		const line =
			resolveFleetOutcome({ phaseType: "execute", enabled: true, homeDir: fullDir }).summaryLine ??
			"";
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("phase=execute");
		expect(line).toContain("playbook=feature");
		expect(line).toContain("fleet=");
		expect(line).toContain("tdd");
		expect(line).not.toContain("\n");
	});

	test("fallback summaryLine names the fallback target, never color", () => {
		const line =
			resolveFleetOutcome({ phaseType: "plan", enabled: true, homeDir: emptyDir }).summaryLine ??
			"";
		expect(line.split("\n")).toHaveLength(1);
		expect(line).toContain("outcome=vanilla");
		expect(line).toContain("fallback=vanilla");
		expect(line).not.toMatch(/\u001b/);
	});
});

describe("dispatchPhasePlaybook", () => {
	test("no pre-PLAN dispatch: 0 subagents, blocked record (AC-46)", () => {
		for (const planContext of [undefined, "", "  "]) {
			const record = dispatchPhasePlaybook({
				phaseType: "execute",
				unit: "unit-1",
				planContext,
				enabled: true,
				homeDir: fullDir,
			});
			expect(record.state).toBe("blocked");
			expect(record.reason).toContain("no phase PLAN");
			expect(record.units).toEqual([
				{ unit: "unit-1", outcome: "blocked", detail: expect.stringContaining("0 subagents") },
			]);
			expect(shouldAdvancePhase(record)).toBe(false);
		}
	});

	test("resolvable fleet dispatches to the routed playbook and advances (AC-41)", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "discuss",
			unit: "unit-1",
			planContext: "## PSTACK subagent fleet\n...",
			enabled: true,
			homeDir: fullDir,
		});
		expect(record.playbook).toBe("investigation");
		expect(record.state).toBe("ok");
		expect(record.units[0]?.outcome).toBe("landed");
		expect(record.summaryLine).toContain("phase=discuss playbook=investigation");
		expect(shouldAdvancePhase(record)).toBe(true);
	});

	test("absent cache fails open: fallback reason recorded, unit runs vanilla (AC-44)", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN with fallback",
			enabled: true,
			homeDir: emptyDir,
		});
		expect(record.fallback).toBe("vanilla");
		expect(record.strict).toBe(false);
		expect(record.reason).toContain("pstack cache directory not found");
		expect(record.units[0]?.outcome).toBe("landed");
		expect(record.units[0]?.detail).toContain("vanilla");
		expect(record.summaryLine).toContain("outcome=vanilla");
		expect(shouldAdvancePhase(record)).toBe(true);
	});

	test("explicit override stops the phase blocked with a named reason (AC-45)", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: emptyDir,
			env: { [PSTACK_STRICT_ENV]: "1" },
		});
		expect(record.state).toBe("blocked");
		expect(record.fallback).toBe("blocked");
		expect(record.units).toEqual([
			{
				unit: "unit-1",
				outcome: "blocked",
				detail: expect.stringContaining("pstack cache directory not found"),
			},
		]);
		expect(record.units.every((unit) => unit.outcome !== "landed")).toBe(true);
		expect(shouldAdvancePhase(record)).toBe(false);
	});

	test("missing playbook file blocks the unit with the absent path named (AC-48)", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: noPlaybookDir,
		});
		expect(record.state).toBe("blocked");
		expect(record.reason).toContain("playbooks/feature.md");
		expect(record.units[0]?.outcome).toBe("blocked");
		expect(record.units[0]?.detail).toContain("playbooks/feature.md");
		expect(record.units[0]?.detail).toContain("0 improvised steps");
		expect(shouldAdvancePhase(record)).toBe(false);
	});

	test("red unit is recorded and the phase does not advance (AC-50)", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "review",
			unit: "unit-red",
			planContext: "PLAN",
			enabled: true,
			homeDir: fullDir,
			unitOutcome: "failed",
		});
		expect(record.playbook).toBe("shipping");
		expect(record.units[0]?.outcome).toBe("failed");
		expect(shouldAdvancePhase(record)).toBe(false);
	});

	test("provenance fields are carried on the record", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "plan",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: fullDir,
			correlationId: "3b18f741-390c-4422-bdd2-4b18499c4490",
			taskId: "T3b18-be",
			createdAt: "2026-11-23T10:00:42.000Z",
		});
		expect(record.correlationId).toBe("3b18f741-390c-4422-bdd2-4b18499c4490");
		expect(record.taskId).toBe("T3b18-be");
		expect(record.createdAt).toBe("2026-11-23T10:00:42.000Z");
		expect(record.units[0]?.unit).toBe("unit-1");
	});
});
