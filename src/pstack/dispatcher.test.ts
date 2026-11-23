// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PSTACK_REQUIRED_ARG, PSTACK_STRICT_ENV, type PhaseType } from "./outcome.ts";
import { dispatchPhasePlaybook, shouldAdvancePhase } from "./dispatcher.ts";

const SIX = ["how", "architect", "arena", "tdd", "interrogate", "no-comments"];

// Same fixture shape as outcome.test.ts / subagents.test.ts: a completed pstack
// plugin cache with the six skills and selected playbooks, resolved from
// `$homeDir` — self-contained so this suite stands alone.
function mkFleetHome(
	names: readonly string[],
	playbooks = ["investigation", "multi-phase-plan", "feature", "shipping"],
): string {
	const home = mkdtempSync(join(tmpdir(), "fleet-dispatcher-"));
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

const PHASES: readonly PhaseType[] = ["discuss", "plan", "execute", "review"];
const ROUTES: ReadonlyArray<readonly [PhaseType, string]> = [
	["discuss", "investigation"],
	["plan", "multi-phase-plan"],
	["execute", "feature"],
	["review", "shipping"],
];

let emptyDir = "";
let fullDir = "";
let investigationOnlyDir = "";
let noPlaybooksDir = "";

beforeAll(() => {
	emptyDir = mkdtempSync(join(tmpdir(), "fleet-dispatcher-empty-"));
	fullDir = mkFleetHome(SIX);
	investigationOnlyDir = mkFleetHome(SIX, ["investigation"]);
	noPlaybooksDir = mkFleetHome(SIX, []);
});

afterAll(() => {
	for (const dir of [emptyDir, fullDir, investigationOnlyDir, noPlaybooksDir]) {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("playbook routing through the dispatcher (AC-41..AC-43)", () => {
	test.each(ROUTES)("phase %s dispatches to %s and the unit lands", (phaseType, title) => {
		const record = dispatchPhasePlaybook({
			phaseType,
			unit: "unit-1",
			planContext: "## PSTACK subagent fleet\n...",
			enabled: true,
			homeDir: fullDir,
		});
		expect(record.playbook).toBe(title);
		expect(record.state).toBe("ok");
		expect(record.units).toEqual([
			{ unit: "unit-1", outcome: "landed", detail: expect.stringContaining(title) },
		]);
	});
	test("an override playbook is recorded on the pre-PLAN blocked record", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: undefined,
			enabled: true,
			homeDir: fullDir,
			playbookOverride: "shipping",
		});
		expect(record.state).toBe("blocked");
		expect(record.playbook).toBe("shipping");
		expect(record.reason).toContain("no phase PLAN");
	});
});

describe("AC-46: no pre-PLAN dispatch", () => {
	test.each(PHASES)("phase %s: no PLAN context blocks with 0 subagents spawned", (phaseType) => {
		for (const planContext of [undefined, "", "  \n\t "]) {
			const record = dispatchPhasePlaybook({
				phaseType,
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
			expect(record.summaryLine).toContain("units=0/1");
			expect(shouldAdvancePhase(record)).toBe(false);
		}
	});

	// Paired control: the identical call with a PLAN present dispatches, so the
	// gate above is the missing PLAN — not the fleet or the phase.
	test("paired control: the same call with a PLAN dispatches and advances", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "## PLAN\n- unit-1: ship it",
			enabled: true,
			homeDir: fullDir,
		});
		expect(record.state).toBe("ok");
		expect(record.units[0]?.outcome).toBe("landed");
		expect(shouldAdvancePhase(record)).toBe(true);
	});

	// Paired control: the PLAN gate fires before fleet resolution, so even an
	// unresolvable fleet reports the PLAN block, never a vanilla fallback.
	test("paired control: no PLAN + unresolvable fleet still blocks on the PLAN", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: undefined,
			enabled: true,
			homeDir: emptyDir,
		});
		expect(record.state).toBe("blocked");
		expect(record.reason).toContain("no phase PLAN");
		expect(record.units[0]?.outcome).toBe("blocked");
		expect(shouldAdvancePhase(record)).toBe(false);
	});
});

describe("AC-48: missing playbook stops blocked", () => {
	test.each(ROUTES)(
		"phase %s: absent routed playbook blocks with the path named",
		(phaseType, title) => {
			const record = dispatchPhasePlaybook({
				phaseType,
				unit: "unit-1",
				planContext: "PLAN",
				enabled: true,
				homeDir: noPlaybooksDir,
			});
			expect(record.state).toBe("blocked");
			expect(record.reason).toContain(`playbooks/${title}.md`);
			expect(record.units[0]?.outcome).toBe("blocked");
			expect(record.units[0]?.detail).toContain(`playbooks/${title}.md`);
			expect(record.units[0]?.detail).toContain("0 improvised steps");
			expect(shouldAdvancePhase(record)).toBe(false);
		},
	);

	// Paired control: the same call against a home that carries the playbook
	// runs, so the block above is the absent file — not the phase or PLAN.
	test("paired control: the same phase runs when its playbook file exists", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: fullDir,
		});
		expect(record.state).toBe("ok");
		expect(record.playbook).toBe("feature");
		expect(shouldAdvancePhase(record)).toBe(true);
	});

	// Paired control: in one partial home, the phase whose playbook exists runs
	// while the phase whose playbook is absent stays blocked.
	test("paired control: present vs absent playbook in one partial home", () => {
		const present = dispatchPhasePlaybook({
			phaseType: "discuss",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: investigationOnlyDir,
		});
		expect(present.state).toBe("ok");
		expect(present.playbook).toBe("investigation");
		expect(shouldAdvancePhase(present)).toBe(true);

		const blocked = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: investigationOnlyDir,
		});
		expect(blocked.state).toBe("blocked");
		expect(blocked.units[0]?.detail).toContain("playbooks/feature.md");
		expect(shouldAdvancePhase(blocked)).toBe(false);
	});
});

describe("AC-50: a red unit does not advance", () => {
	test.each(ROUTES)(
		"phase %s: a failed unit is recorded and the phase holds",
		(phaseType, title) => {
			const record = dispatchPhasePlaybook({
				phaseType,
				unit: "unit-red",
				planContext: "PLAN",
				enabled: true,
				homeDir: fullDir,
				unitOutcome: "failed",
			});
			expect(record.playbook).toBe(title);
			expect(record.units).toEqual([
				{
					unit: "unit-red",
					outcome: "failed",
					detail: expect.stringContaining("phase does not advance"),
				},
			]);
			expect(record.summaryLine).toContain("units=0/1");
			expect(shouldAdvancePhase(record)).toBe(false);
		},
	);

	// Paired control: the identical dispatch with a landed unit advances, so
	// the hold above is the red unit — not the phase or the playbook.
	test("paired control: the same dispatch with a landed unit advances", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "review",
			unit: "unit-red",
			planContext: "PLAN",
			enabled: true,
			homeDir: fullDir,
		});
		expect(record.playbook).toBe("shipping");
		expect(record.units[0]?.outcome).toBe("landed");
		expect(shouldAdvancePhase(record)).toBe(true);
	});

	test("shouldAdvancePhase: empty and mixed unit lists never advance", () => {
		const base = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: fullDir,
		});
		expect(shouldAdvancePhase({ ...base, units: [] })).toBe(false);
		expect(
			shouldAdvancePhase({
				...base,
				units: [
					{ unit: "unit-1", outcome: "landed", detail: "ok" },
					{ unit: "unit-2", outcome: "failed", detail: "red" },
				],
			}),
		).toBe(false);
		expect(
			shouldAdvancePhase({
				...base,
				units: [
					{ unit: "unit-1", outcome: "landed", detail: "ok" },
					{ unit: "unit-2", outcome: "landed", detail: "ok" },
				],
			}),
		).toBe(true);
	});
});

describe("strict-blocked path vs fail-open (AC-45 paired with AC-44)", () => {
	const strictSources = [
		{ label: "caller strict", strict: { strict: true } },
		{ label: "configStrict", strict: { configStrict: true } },
		{ label: "env", strict: { env: { [PSTACK_STRICT_ENV]: "1" } } },
		{ label: "argv", strict: { argv: [PSTACK_REQUIRED_ARG] } },
	] as const;

	for (const { label, strict } of strictSources) {
		test(`strict via ${label}: unresolvable fleet stops blocked with 0 vanilla units`, () => {
			const record = dispatchPhasePlaybook({
				phaseType: "execute",
				unit: "unit-1",
				planContext: "PLAN",
				enabled: true,
				homeDir: emptyDir,
				...strict,
			});
			expect(record.strict).toBe(true);
			expect(record.state).toBe("blocked");
			expect(record.fallback).toBe("blocked");
			expect(record.reason).toContain("pstack cache directory not found");
			expect(record.units).toEqual([
				{
					unit: "unit-1",
					outcome: "blocked",
					detail: expect.stringContaining("pstack cache directory not found"),
				},
			]);
			expect(record.units.some((unit) => unit.outcome === "landed")).toBe(false);
			expect(shouldAdvancePhase(record)).toBe(false);
		});
	}

	// Paired control: the identical dispatch without any strict source fails
	// open — the unit runs vanilla and the phase advances (AC-44).
	test("paired control: no strict source fails open and runs vanilla", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "execute",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: emptyDir,
		});
		expect(record.strict).toBe(false);
		expect(record.fallback).toBe("vanilla");
		expect(record.units[0]?.outcome).toBe("landed");
		expect(record.units[0]?.detail).toContain("vanilla");
		expect(shouldAdvancePhase(record)).toBe(true);
	});

	// Paired control: strict also blocks when the fleet is disabled or
	// forced off, while the same inputs without strict fall back to vanilla.
	test("paired control: strict blocks disabled and forced-off fleets, non-strict runs vanilla", () => {
		const extras: Array<{ enabled: boolean; forcedOff?: boolean }> = [
			{ enabled: false },
			{ enabled: true, forcedOff: true },
		];
		for (const extra of extras) {
			const blocked = dispatchPhasePlaybook({
				phaseType: "plan",
				unit: "unit-1",
				planContext: "PLAN",
				homeDir: fullDir,
				strict: true,
				...extra,
			});
			expect(blocked.state).toBe("blocked");
			expect(blocked.units[0]?.outcome).toBe("blocked");
			expect(shouldAdvancePhase(blocked)).toBe(false);

			const vanilla = dispatchPhasePlaybook({
				phaseType: "plan",
				unit: "unit-1",
				planContext: "PLAN",
				homeDir: fullDir,
				...extra,
			});
			expect(vanilla.fallback).toBe("vanilla");
			expect(vanilla.units[0]?.outcome).toBe("landed");
			expect(shouldAdvancePhase(vanilla)).toBe(true);
		}
	});

	// Strict with a resolvable fleet still dispatches: strict only changes the
	// failure path, never the happy path.
	test("paired control: strict with a resolvable fleet dispatches normally", () => {
		const record = dispatchPhasePlaybook({
			phaseType: "discuss",
			unit: "unit-1",
			planContext: "PLAN",
			enabled: true,
			homeDir: fullDir,
			strict: true,
		});
		expect(record.state).toBe("ok");
		expect(record.playbook).toBe("investigation");
		expect(shouldAdvancePhase(record)).toBe(true);
	});
});
