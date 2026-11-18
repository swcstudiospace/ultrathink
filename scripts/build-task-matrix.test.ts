// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildTaskMatrix } from "./build-task-matrix.ts";

const SCRIPT = resolve(import.meta.dir, "build-task-matrix.ts");

const doc = (...lines: string[]): string => `${lines.join("\n")}\n`;

// Line numbers matter: the expected Source cells below cite these lines.
const ROADMAP = doc(
	"# Roadmap: Fixture", // 1
	"", // 2
	"## Active Milestone: v9.9 Fixture", // 3
	"", // 4
	"### Phase 1: Alpha lifecycle", // 5
	"", // 6
	"Status: Complete (merged).", // 7
	"", // 8
	"**Goal:** alpha.", // 9
	"**Depends on:** none", // 10
	"", // 11
	"### Phase 2: Beta writer", // 12
	"", // 13
	"Status: Contract merged.", // 14
	"", // 15
	"**Depends on:** 1.", // 16
	"", // 17
	"### Phase 3: Gamma audit", // 18
	"", // 19
	"Status: Not started.", // 20
	"", // 21
	"**Depends on:** 2.", // 22
	"", // 23
	"## Backlog", // 24
	"", // 25
	"- **HOST-02:** Live proof after a host route is funded.", // 26
	"- Do not auto-run the extractor.", // 27
);

const STATE = doc(
	"# State", // 1
	"", // 2
	"## Deferred Verification", // 3
	"", // 4
	"| Phase | State | Resume |", // 5
	"|-------|-------|--------|", // 6
	"| 9 | verification_deferred_human | /gsd:verify-work 9 |", // 7
	"| 8 | accepted_tech_debt |  |", // 8
	"", // 9
	"## Deferred Items", // 10
	"", // 11
	"| Category | Item | Status | Deferred At | Milestone |", // 12
	"|----------|------|--------|-------------|-----------|", // 13
	"| verification_gaps | 7/7-VERIFICATION.md | gaps_found (owner waiver) | 2026-10-28 | v9.0 |", // 14
	"| verification_gaps | 9/9-VERIFICATION.md | human_needed | 2026-10-21 | v9.0 |", // 15
);

const INVENTORY = doc(
	"# Inventory", // 1
	"", // 2
	"| Phase | Dir |", // 3
	"|---|---|", // 4
	"| 2 | 2-beta-writer | done |", // 5
);

const FIXTURE = { roadmap: ROADMAP, state: STATE, inventory: INVENTORY };

function rowsFor(out: string, id: string): string[] {
	return out.split("\n").filter((line) => line.startsWith(`| ${id} |`));
}

function countOf(out: string, text: string): number {
	return out.split(text).length - 1;
}

/** The text under one `## title` heading, up to the next `## ` heading, trimmed. */
function section(out: string, title: string): string {
	const start = out.indexOf(`## ${title}\n`);
	if (start < 0) return "";
	const rest = out.slice(start + title.length + 4);
	const end = rest.indexOf("\n## ");
	return (end < 0 ? rest : rest.slice(0, end)).trim();
}

describe("buildTaskMatrix", () => {
	test("every ROADMAP phase line is exactly one matrix row", () => {
		const out = buildTaskMatrix(FIXTURE);
		for (const id of ["PHASE-1", "PHASE-2", "PHASE-3"]) {
			expect(rowsFor(out, id)).toHaveLength(1);
		}
		expect(out.split("\n").filter((line) => line.startsWith("| PHASE-"))).toHaveLength(3);
		for (const title of ["Alpha lifecycle", "Beta writer", "Gamma audit"]) {
			expect(countOf(out, title)).toBe(1);
		}
	});

	test("status comes from ROADMAP or STATE and the bucket follows dependencies", () => {
		const out = buildTaskMatrix(FIXTURE);
		expect(rowsFor(out, "PHASE-1")).toEqual([
			"| PHASE-1 | phase | Alpha lifecycle | Complete (merged) | closed | - | - | none | - | - | not in sources | not in sources | R:5 | - |",
		]);
		expect(rowsFor(out, "PHASE-2")).toEqual([
			"| PHASE-2 | phase | Beta writer | Contract merged | executable | G0 | PHASE-1 | PHASE-1 | none | I:5 | not in sources | not in sources | R:12 | I:5 |",
		]);
		expect(rowsFor(out, "PHASE-3")).toEqual([
			"| PHASE-3 | phase | Gamma audit | Not started | blocked | G1 | PHASE-2 | PHASE-2; missing: phase 2 must be closed (currently: Contract merged) | none | - | not in sources | not in sources | R:18 | - |",
		]);
		expect(rowsFor(out, "DEFERRED-9")).toEqual([
			"| DEFERRED-9 | deferred | Phase 9 verification | verification_deferred_human | blocked | external | - | none; missing: human verification pending: run `/gsd:verify-work 9` (verification_deferred_human, S:7, S:15) | - | S:7, S:15 | not in sources | /gsd:verify-work 9 | S:7, S:15 | - |",
		]);
		expect(rowsFor(out, "DEFERRED-8")).toEqual([
			"| DEFERRED-8 | deferred | Phase 8 verification | accepted_tech_debt | closed | - | - | none | - | S:8 | not in sources | not in sources | S:8 | - |",
		]);
		expect(rowsFor(out, "BACKLOG-01")).toEqual([
			"| BACKLOG-01 | backlog | Do not auto-run the extractor. | backlog | constraint | - | - | none | - | - | not in sources | not in sources | R:27 | - |",
		]);
	});

	test("executable, closed and constraint sections list IDs; executable is dependency-ready only", () => {
		const out = buildTaskMatrix(FIXTURE);
		expect(section(out, "Executable now")).toBe("- PHASE-2 (G0)");
		expect(section(out, "Closed")).toBe("- PHASE-1\n- DEFERRED-8");
		expect(section(out, "Standing constraints (not work)")).toBe("- BACKLOG-01");
	});

	test("a blocked item names its exact missing input", () => {
		const blocked = section(buildTaskMatrix(FIXTURE), "Blocked");
		expect(blocked).toContain(
			"- PHASE-3 (blocked): phase 2 must be closed (currently: Contract merged)",
		);
		expect(blocked).toContain(
			"- BACKLOG-HOST-02 (blocked): condition in R:26 is not yet met: Live proof after a host route is funded.",
		);
		expect(blocked).toContain(
			"- DEFERRED-9 (blocked): human verification pending: run `/gsd:verify-work 9` (verification_deferred_human, S:7, S:15)",
		);
		expect(blocked).toContain(
			"- DEFERRED-7 (blocked): phase 7 gaps_found with no resume command (S:14): owner decision or verification evidence required",
		);
	});

	test("a backlog bullet beginning 'Superseded by' classifies as closed with no missing input", () => {
		const roadmap = `${ROADMAP}- **OLD-77:** Superseded by PR #77\n`;
		const out = buildTaskMatrix({ ...FIXTURE, roadmap });
		expect(rowsFor(out, "BACKLOG-OLD-77")).toEqual([
			"| BACKLOG-OLD-77 | backlog | Superseded by PR #77 | backlog | closed | - | - | none | - | - | not in sources | not in sources | R:28 | - |",
		]);
		expect(section(out, "Closed")).toContain("- BACKLOG-OLD-77");
		expect(section(out, "Blocked")).not.toContain("BACKLOG-OLD-77");
	});

	test("the conflict section names both sources with their line numbers", () => {
		const roadmap = doc(
			"### Phase 1: Alpha lifecycle", // 1
			"", // 2
			"Status: Complete.", // 3
			"", // 4
			"**Depends on:** none", // 5
			"", // 6
			"## Backlog", // 7
			"", // 8
			"- **CIMD:** Scheduled as v1.22 phases 101 to 105.", // 9
			"", // 10
			"Completed v1.22: CIMD withdrawn by owner.", // 11
		);
		const out = buildTaskMatrix({ ...FIXTURE, roadmap });
		expect(section(out, "Conflicts")).toBe(
			'- BACKLOG-CIMD: own R:9 says open ("blocked"); R:11 says closed ("completed", "withdrawn")',
		);
	});

	test("a deferred conflict cites the STATE row and the inventory status cell", () => {
		const state = doc(
			"# State", // 1
			"", // 2
			"## Deferred Verification", // 3
			"", // 4
			"| Phase | State | Resume |", // 5
			"|-------|-------|--------|", // 6
			"| 9 | accepted_tech_debt |  |", // 7
			"", // 8
			"## Deferred Items", // 9
			"", // 10
			"| Category | Item | Status | Deferred At | Milestone |", // 11
			"|----------|------|--------|-------------|-----------|", // 12
		);
		const inventory = doc(
			"# Inventory", // 1
			"", // 2
			"| Phase | Dir | Status |", // 3
			"|---|---|---|", // 4
			"| 9 | 9-thing | needs VERIFICATION (pending) |", // 5
		);
		const out = buildTaskMatrix({ roadmap: ROADMAP, state, inventory });
		expect(section(out, "Conflicts")).toBe(
			'- DEFERRED-9: own S:7 says closed ("accepted_tech_debt"); I:5 says open ("needs", "pending")',
		);
	});

	test("a line that names more than one ID attributes its status to none of them", () => {
		const roadmap = doc(
			"### Phase 1: Alpha lifecycle", // 1
			"", // 2
			"Status: Not started.", // 3
			"", // 4
			"**Depends on:** none", // 5
			"", // 6
			"Phases 1 and 2 are withdrawn.", // 7
			"", // 8
			"Phase 1 was withdrawn.", // 9
		);
		const out = buildTaskMatrix({ ...FIXTURE, roadmap });
		expect(section(out, "Conflicts")).toBe(
			'- PHASE-1: own R:3 says open ("not_started"); R:9 says closed ("withdrawn")',
		);
	});

	test("owner and validation come from the sources when present, otherwise 'not in sources'", () => {
		const roadmap = doc(
			"### Phase 1: Alpha lifecycle", // 1
			"", // 2
			"Status: Complete.", // 3
			"", // 4
			"**Owner:** Dana", // 5
			"**Validation:** `bun test scripts/build-task-matrix.test.ts`", // 6
			"**Depends on:** none", // 7
			"", // 8
			"### Phase 2: Beta writer", // 9
			"", // 10
			"Status: Not started.", // 11
			"", // 12
			"**Depends on:** 1.", // 13
		);
		const out = buildTaskMatrix({ ...FIXTURE, roadmap });
		expect(rowsFor(out, "PHASE-1")[0]).toContain(
			"| Dana | bun test scripts/build-task-matrix.test.ts | R:1 | - |",
		);
		expect(rowsFor(out, "PHASE-2")[0]).toContain("| not in sources | not in sources | R:9 | I:5 |");
	});

	test("the header names the input paths and carries no timestamp", () => {
		const out = buildTaskMatrix({
			...FIXTURE,
			paths: { roadmap: "/x/ROADMAP.md", state: "/x/STATE.md", inventory: "/x/INV.md" },
		});
		expect(out).toContain("- `R`: `/x/ROADMAP.md`");
		expect(out).toContain("- `S`: `/x/STATE.md`");
		expect(out).toContain("- `I`: `/x/INV.md`");
		expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}/);
	});

	test("output is byte-identical across two builds of the same input", () => {
		expect(buildTaskMatrix(FIXTURE)).toBe(buildTaskMatrix(FIXTURE));
	});

	test("rejects a ROADMAP with no phase lines instead of writing an empty matrix", () => {
		const roadmap = doc("# Roadmap", "", "## Backlog", "", "- **X-1:** thing.");
		expect(() => buildTaskMatrix({ ...FIXTURE, roadmap })).toThrow(/has no phase lines/);
	});

	test("rejects a phase number defined twice", () => {
		const roadmap = doc(
			"### Phase 1: First",
			"",
			"Status: Complete.",
			"",
			"**Depends on:** none",
			"",
			"### Phase 1: Again",
			"",
			"Status: Not started.",
			"",
			"**Depends on:** none",
		);
		expect(() => buildTaskMatrix({ ...FIXTURE, roadmap })).toThrow(
			/phase 1 is defined more than once/,
		);
	});

	test("escapes a backslash before a pipe so the table cell keeps its column count", () => {
		const roadmap = doc(
			"### Phase 1: Path a\\|b",
			"",
			"Status: Complete.",
			"",
			"**Depends on:** none",
		);
		const out = buildTaskMatrix({ ...FIXTURE, roadmap });
		expect(rowsFor(out, "PHASE-1")).toEqual([
			"| PHASE-1 | phase | Path a\\\\\\|b | Complete | closed | - | - | none | - | - | not in sources | not in sources | R:1 | - |",
		]);
	});

	test("the bucket follows the status line: Complete or verdict passed is closed, verdict human_needed is deferred, otherwise executable", () => {
		const cases: [string, string][] = [
			["Complete (merged)", "closed"],
			["Verified 2026-11-18: passed 3/3 success criteria", "closed"],
			["Verified human_needed on 2026-11-18 at origin/main 99ce989", "deferred"],
			["Verified 2026-11-18: gaps_found on criterion 2", "executable"],
			["Verified 2026-11-18 with no verdict word", "executable"],
			["Verified human_needed on 2026-11-18; gaps_found earlier", "deferred"],
			["Verified 2026-11-18: gaps_found, then passed on rerun", "executable"],
		];
		for (const [status, bucket] of cases) {
			const roadmap = doc(
				"### Phase 1: Alpha",
				"",
				`Status: ${status}.`,
				"",
				"**Depends on:** none",
			);
			const row = rowsFor(buildTaskMatrix({ ...FIXTURE, roadmap }), "PHASE-1")[0] ?? "";
			expect(row.split(" | ")[4]).toBe(bucket);
		}
	});

	test("a dependency is satisfied by a closed phase, and a deferred phase is listed under Deferred to owner", () => {
		const roadmap = doc(
			"### Phase 1: Alpha", // 1
			"", // 2
			"Status: Verified 2026-11-18: passed 3/3.", // 3
			"", // 4
			"**Depends on:** none", // 5
			"", // 6
			"### Phase 2: Beta", // 7
			"", // 8
			"Status: Verified human_needed on 2026-11-18.", // 9
			"", // 10
			"**Depends on:** 1.", // 11
			"", // 12
			"### Phase 3: Gamma", // 13
			"", // 14
			"Status: Not started.", // 15
			"", // 16
			"**Depends on:** 2.", // 17
			"", // 18
			"### Phase 4: Delta", // 19
			"", // 20
			"Status: Not started.", // 21
			"", // 22
			"**Depends on:** 1.", // 23
		);
		const out = buildTaskMatrix({ ...FIXTURE, roadmap });
		expect(section(out, "Executable now")).toBe("- PHASE-4 (G0)");
		expect(section(out, "Deferred to owner")).toBe(
			"- PHASE-2 (deferred): owner human verification of phase 2 must pass (currently: Verified human_needed on 2026-11-18)",
		);
		expect(section(out, "Blocked")).toContain(
			"- PHASE-3 (blocked): phase 2 must be closed (currently: Verified human_needed on 2026-11-18)",
		);
		expect(section(out, "Closed")).toContain("- PHASE-1");
	});
});

describe("build-task-matrix CLI", () => {
	let dir = "";
	let roadmapPath = "";
	let statePath = "";
	let inventoryPath = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "task-matrix-"));
		roadmapPath = join(dir, "ROADMAP.md");
		statePath = join(dir, "STATE.md");
		inventoryPath = join(dir, "PHASES-INVENTORY.md");
		writeFileSync(roadmapPath, ROADMAP);
		writeFileSync(statePath, STATE);
		writeFileSync(inventoryPath, INVENTORY);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function run(args: string[]): Promise<{ code: number; stderr: string }> {
		const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		return { code, stderr };
	}

	const sourceArgs = () => [
		"--roadmap",
		roadmapPath,
		"--state",
		statePath,
		"--inventory",
		inventoryPath,
	];

	test("writes the matrix, exits 0, and two runs are byte-identical", async () => {
		const first = join(dir, "first.md");
		const second = join(dir, "second.md");
		expect((await run([...sourceArgs(), "--out", first])).code).toBe(0);
		expect((await run([...sourceArgs(), "--out", second])).code).toBe(0);
		const written = readFileSync(first, "utf8");
		expect(readFileSync(second, "utf8")).toBe(written);
		expect(written).toBe(
			buildTaskMatrix({
				...FIXTURE,
				paths: {
					roadmap: ".planning/ROADMAP.md",
					state: ".planning/STATE.md",
					inventory: ".planning/PHASES-INVENTORY.md",
				},
			}),
		);
	});

	test("the header uses repo-relative labels for the planning inputs and no absolute path", async () => {
		const out = join(dir, "labels.md");
		expect((await run([...sourceArgs(), "--out", out])).code).toBe(0);
		const written = readFileSync(out, "utf8");
		expect(written).toContain("- `R`: `.planning/ROADMAP.md`");
		expect(written).toContain("- `S`: `.planning/STATE.md`");
		expect(written).toContain("- `I`: `.planning/PHASES-INVENTORY.md`");
		expect(written).not.toContain(dir);
	});

	test("a ROADMAP with no phase lines exits 1, names the file, and writes nothing", async () => {
		const emptyRoadmap = join(dir, "empty-ROADMAP.md");
		const out = join(dir, "empty-out.md");
		writeFileSync(emptyRoadmap, doc("# Roadmap", "", "## Backlog", "", "- thing."));
		const result = await run([
			"--roadmap",
			emptyRoadmap,
			"--state",
			statePath,
			"--inventory",
			inventoryPath,
			"--out",
			out,
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("has no phase lines");
		expect(existsSync(out)).toBe(false);
	});

	test("an unknown flag exits 2 and writes nothing", async () => {
		const out = join(dir, "unknown-out.md");
		const result = await run([...sourceArgs(), "--bogus", "x", "--out", out]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('unknown argument "--bogus"');
		expect(existsSync(out)).toBe(false);
	});
});
