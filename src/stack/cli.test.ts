// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config.ts";
import { runStackCommand, type StackCommandDeps } from "./cli.ts";
import { STACK_MEMBERS, type StackConnection, type StackMember, type StackProbe } from "./types.ts";

const KEY_A = "sk-or-v1_CANARYCANARYCANARY1234";
const KEY_B = "vck_CANARYCANARYCANARY1234";
const NOW = Date.UTC(2026, 9, 28, 9, 0, 0, 0);

const COST_SENTENCE =
	"--live also runs the Decisions check (spends one request; moves the rail breaker and writes a usage row exactly like `decisions check`)";

function probe(member: StackMember, rest: Omit<StackConnection, "member">): StackProbe {
	return async () => ({ member, ...rest });
}

function probes(
	over: Partial<Record<StackMember, Omit<StackConnection, "member">>> = {},
): Record<StackMember, StackProbe> {
	const base: Record<StackMember, Omit<StackConnection, "member">> = {
		substrate: { status: "connected", reason: "Substrate answers", via: "http" },
		swarm: { status: "disabled", reason: "swarm auto-run is off", fix: "set swarm.enabled" },
		realm: { status: "degraded", reason: "Realm is advisory", fix: "realm up" },
		decisions: { status: "connected", reason: "Jev configured" },
		hindsight: { status: "disabled", reason: "Hindsight is opt-in" },
	};
	const merged = { ...base, ...over };
	return {
		substrate: probe("substrate", merged.substrate),
		swarm: probe("swarm", merged.swarm),
		realm: probe("realm", merged.realm),
		decisions: probe("decisions", merged.decisions),
		hindsight: probe("hindsight", merged.hindsight),
	};
}

function deps(
	over: Partial<Record<StackMember, Omit<StackConnection, "member">>> = {},
	extra: Partial<StackCommandDeps> = {},
): StackCommandDeps {
	return {
		probes: probes(over),
		config: defaultConfig(),
		stateDir: "/tmp/ut-stack-cli-state",
		host: "claude-code",
		now: () => NOW,
		...extra,
	};
}

const INPUT = { cwd: "/tmp/ut-stack-cli-cwd", env: {} };

describe("runStackCommand text", () => {
	test("prints one line per member in order with an indented fix line only when a fix exists", async () => {
		const { output, exitCode } = await runStackCommand([], INPUT, deps());
		expect(exitCode).toBe(0);
		expect(output.split("\n")).toEqual([
			"substrate  connected  Substrate answers",
			"swarm  disabled  swarm auto-run is off",
			"  fix: set swarm.enabled",
			"realm  degraded  Realm is advisory",
			"  fix: realm up",
			"decisions  connected  Jev configured",
			"hindsight  disabled  Hindsight is opt-in",
		]);
	});

	test("--only reports just that member and unions repeats in canonical order", async () => {
		const single = await runStackCommand(["--only", "swarm"], INPUT, deps());
		expect(single.output.split("\n")).toEqual([
			"swarm  disabled  swarm auto-run is off",
			"  fix: set swarm.enabled",
		]);
		const union = await runStackCommand(["--only", "realm", "--only", "substrate"], INPUT, deps());
		expect(union.output.split("\n")[0]).toStartWith("substrate  ");
		expect(union.output).toContain("realm  degraded");
		expect(union.output).not.toContain("swarm");
	});
});

describe("runStackCommand --json", () => {
	test("prints { members, generatedAt } with five members in STACK_MEMBERS order", async () => {
		const { output, exitCode } = await runStackCommand(["--json"], INPUT, deps());
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(output) as { members: StackConnection[]; generatedAt: string };
		expect(Object.keys(parsed).sort()).toEqual(["generatedAt", "members"]);
		expect(parsed.members.map((m) => m.member)).toEqual([...STACK_MEMBERS]);
		expect(parsed.generatedAt).toBe(new Date(NOW).toISOString());
		expect(output.includes("\n")).toBe(false);
	});
});

describe("runStackCommand exit codes", () => {
	test("--strict exits 1 for a misconfigured member and for an unavailable one", async () => {
		const misconfigured = await runStackCommand(
			["--strict"],
			INPUT,
			deps({ decisions: { status: "misconfigured", reason: "no Jev key" } }),
		);
		expect(misconfigured.exitCode).toBe(1);
		const unavailable = await runStackCommand(
			["--strict"],
			INPUT,
			deps({ substrate: { status: "unavailable", reason: "no answer" } }),
		);
		expect(unavailable.exitCode).toBe(1);
	});

	test("--strict stays 0 with only connected, degraded and disabled members", async () => {
		const { exitCode } = await runStackCommand(["--strict"], INPUT, deps());
		expect(exitCode).toBe(0);
	});

	test("without --strict a misconfigured member still exits 0", async () => {
		const { exitCode } = await runStackCommand(
			[],
			INPUT,
			deps({ decisions: { status: "misconfigured", reason: "no Jev key" } }),
		);
		expect(exitCode).toBe(0);
	});

	test("--strict ignores members excluded by --only", async () => {
		const { exitCode } = await runStackCommand(
			["--strict", "--only", "substrate"],
			INPUT,
			deps({ decisions: { status: "misconfigured", reason: "no Jev key" } }),
		);
		expect(exitCode).toBe(0);
	});

	test("a probe that throws is reported unavailable and fails --strict", async () => {
		const failing = deps();
		failing.probes = {
			...failing.probes,
			hindsight: async () => {
				throw new Error(`boom ${KEY_A}`);
			},
		};
		const { output, exitCode } = await runStackCommand(["--strict"], INPUT, failing);
		expect(exitCode).toBe(1);
		expect(output).toContain("hindsight  unavailable  probe failed");
		expect(output).not.toContain("CANARY");
	});
});

describe("runStackCommand usage", () => {
	const bad: string[][] = [
		["--bogus"],
		["stack"],
		["--only"],
		["--only", "nothing"],
		["--only", "--live"],
		["--timeout"],
		["--timeout", "abc"],
		["--timeout", "1.5"],
		["--timeout", "-5"],
		["--timeout", "0"],
		["--timeout", "15001"],
		["--timeout", "10", "--timeout", "20"],
		["--timeout=10"],
	];
	for (const args of bad) {
		test(`rejects ${JSON.stringify(args)} with one usage line and exit 2`, async () => {
			const { output, exitCode } = await runStackCommand(args, INPUT, deps());
			expect(exitCode).toBe(2);
			expect(output).toStartWith("Usage: ultrathink stack");
			expect(output.includes("\n")).toBe(false);
		});
	}

	test("accepts the timeout bounds 1 and 15000", async () => {
		expect((await runStackCommand(["--timeout", "1"], INPUT, deps())).exitCode).toBe(0);
		expect((await runStackCommand(["--timeout", "15000"], INPUT, deps())).exitCode).toBe(0);
	});

	test("--help and -h print the usage with the Decisions-cost sentence and exit 0", async () => {
		for (const flag of ["--help", "-h"]) {
			const { output, exitCode } = await runStackCommand([flag], INPUT, deps());
			expect(exitCode).toBe(0);
			expect(output).toStartWith("Usage: ultrathink stack");
			expect(output).toContain(COST_SENTENCE);
			for (const member of STACK_MEMBERS) expect(output).toContain(member);
		}
	});
});

describe("runStackCommand context", () => {
	test("passes live, the timeout and the injected clock to every probe", async () => {
		const seen: Array<{ live: boolean; timeoutMs: number; stateDir: string; host: string }> = [];
		const spy: StackProbe = async (ctx) => {
			seen.push({
				live: ctx.live,
				timeoutMs: ctx.timeoutMs,
				stateDir: ctx.stateDir,
				host: ctx.host,
			});
			return { member: "substrate", status: "connected", reason: "ok" };
		};
		const base = deps();
		base.probes = { ...base.probes, substrate: spy };
		await runStackCommand(["--only", "substrate"], INPUT, base);
		await runStackCommand(["--only", "substrate", "--live", "--timeout", "250"], INPUT, base);
		expect(seen).toEqual([
			{ live: false, timeoutMs: 3000, stateDir: "/tmp/ut-stack-cli-state", host: "claude-code" },
			{ live: true, timeoutMs: 250, stateDir: "/tmp/ut-stack-cli-state", host: "claude-code" },
		]);
	});
});

describe("runStackCommand secret safety", () => {
	const leaking = (): Partial<Record<StackMember, Omit<StackConnection, "member">>> => ({
		substrate: {
			status: "unavailable",
			reason: `refused with key ${KEY_A}`,
			fix: `export SUBSTRATE_TOKEN=${KEY_B}`,
		},
		decisions: {
			status: "misconfigured",
			reason: `Authorization: Bearer ${KEY_B}`,
			fix: `set ${KEY_A}`,
			affects: [`plan gate ${KEY_A}`],
		},
	});

	test("no credential value reaches the text output", async () => {
		const { output } = await runStackCommand([], INPUT, deps(leaking()));
		expect(output).not.toContain("CANARY");
		expect(output).toContain("substrate  unavailable  refused with key");
	});

	test("no credential value reaches the JSON output", async () => {
		const { output } = await runStackCommand(["--json"], INPUT, deps(leaking()));
		expect(output).not.toContain("CANARY");
		const parsed = JSON.parse(output) as { members: StackConnection[] };
		expect(parsed.members).toHaveLength(5);
		expect(parsed.members[0]?.status).toBe("unavailable");
	});
});
