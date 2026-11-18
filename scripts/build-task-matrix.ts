// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Builds the decomposition task matrix (v1.24 phase 113, DEC-01 to DEC-03) from the
// planning sources. buildTaskMatrix is pure: source text in, Markdown out. The CLI reads
// the three sources and writes the matrix.
//
//   bun scripts/build-task-matrix.ts --roadmap <path> --state <path> \
//     --inventory <path> --out <path>
//
// Without flags the sources are the repo's .planning files and the output is
// docs/roadmap/task-matrix.md. Relative --out and source paths resolve from the cwd.

import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ROADMAP = ".planning/ROADMAP.md";
const DEFAULT_STATE = ".planning/STATE.md";
const DEFAULT_INVENTORY = ".planning/PHASES-INVENTORY.md";
const DEFAULT_OUT = "docs/roadmap/task-matrix.md";
/** Repo-relative header labels for the planning inputs, keyed by basename. */
const PLANNING_LABELS: Record<string, string> = {
	"ROADMAP.md": DEFAULT_ROADMAP,
	"STATE.md": DEFAULT_STATE,
	"PHASES-INVENTORY.md": DEFAULT_INVENTORY,
};

const PHASE_HEADING = /^### Phase (\d+): (.+)$/;
const SECTION_HEADING = /^#{2,3} /;
const STANDING_RULE = /^(Do not|One-way)\b/;
const CLOSED_STATES: Record<string, true> = { accepted_tech_debt: true, withdrawn: true };
const OPEN_STATES: Record<string, true> = {
	verification_deferred_human: true,
	human_needed: true,
	gaps_found: true,
};
const DV_HEADER = "Phase|State|Resume";
const DI_HEADER = "Category|Item|Status|Deferred At|Milestone";

type MatrixInput = {
	roadmap: string;
	state: string;
	inventory: string;
	/** Labels printed in the header. Defaults to the repo-relative .planning paths. */
	paths?: { roadmap?: string; state?: string; inventory?: string };
};

type Bucket = "executable" | "blocked" | "closed" | "constraint";

type Item = {
	id: string;
	kind: "phase" | "backlog" | "deferred";
	label: string;
	status: string;
	source: string;
	/** Phase numbers this item depends on. */
	dependsOn: string[];
	bucket: Bucket;
	group: string;
	/** The exact input that must become true. Empty unless blocked. */
	missing: string;
	inventory: string;
};

type Line = { no: number; text: string };
type Labels = { roadmap: string; state: string; inventory: string };
type PhaseDef = { num: string; title: string; status: string; deps: string[]; line: number };
type TableRow = { no: number; cells: string[] };
type DeferredRow = { phase: string; state: string; resume: string; sources: string[] };

const RULES = [
	"- Status: a phase shows its ROADMAP `Status:` line, trailing period removed. A deferred item shows its STATE state from Deferred Verification, or from Deferred Items when it has no Deferred Verification row. A backlog item shows `backlog`.",
	"- Bucket: `closed` when a phase status starts with `Complete`, or a deferred state is `accepted_tech_debt` or `withdrawn`. `constraint` for a standing rule whose text starts with `Do not` or `One-way`; it is not work. `blocked` when a dependency is not Complete or a human or external input is missing. `executable` otherwise.",
	"- Parallel group: `G0` has no open dependency. `Gn` is one more than its deepest open dependency. `external` waits on a human or external input. `-` means closed or constraint.",
	"- Non-overlap: the other phase items in the same group. Items in one group have no dependency edge between them. File overlap is not derivable from these sources; check file sets before dispatching a group.",
	"- Depends on: phase numbers from `**Depends on:**`. Deferred and backlog items have no dependency edge.",
	"- Blocked input: the exact text that must become true. Backlog classification reads only the bullet text; status recorded elsewhere in ROADMAP is not consulted.",
];

function toLines(text: string): Line[] {
	return text.split("\n").map((raw, i) => ({ no: i + 1, text: raw.replace(/\r$/, "") }));
}

function escapeCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isComplete(status: string): boolean {
	return /^Complete\b/.test(status);
}

function parseDeps(raw: string, at: string): string[] {
	const text = raw.trim().replace(/\.$/, "");
	if (text === "none") return [];
	const nums = [...text.matchAll(/\d+/g)].map((m) => m[0]);
	if (nums.length === 0) {
		throw new Error(`${at}: "Depends on" must be "none" or phase numbers, got "${text}"`);
	}
	return nums;
}

function parsePhases(ls: Line[], label: string): PhaseDef[] {
	const phases: PhaseDef[] = [];
	for (const [idx, heading] of ls.entries()) {
		const m = PHASE_HEADING.exec(heading.text);
		if (!m) continue;
		const num = m[1] ?? "";
		if (phases.some((p) => p.num === num)) {
			throw new Error(`${label}:${heading.no}: phase ${num} is defined more than once`);
		}
		let statusLine: Line | undefined;
		let depsLine: Line | undefined;
		for (let j = idx + 1; j < ls.length; j++) {
			const line = ls[j];
			if (!line || SECTION_HEADING.test(line.text)) break;
			if (!statusLine && line.text.startsWith("Status: ")) statusLine = line;
			if (!depsLine && line.text.startsWith("**Depends on:** ")) depsLine = line;
		}
		if (!statusLine) throw new Error(`${label}:${heading.no}: phase ${num} has no "Status:" line`);
		if (!depsLine) {
			throw new Error(`${label}:${heading.no}: phase ${num} has no "**Depends on:**" line`);
		}
		phases.push({
			num,
			title: m[2] ?? "",
			status: statusLine.text.slice("Status: ".length).trim().replace(/\.$/, ""),
			deps: parseDeps(depsLine.text.slice("**Depends on:** ".length), `${label}:${depsLine.no}`),
			line: heading.no,
		});
	}
	return phases;
}

function inventoryForPhase(num: string, inv: Line[]): string {
	const re = new RegExp(`^\\| ${num}(?:-[^|]*)?\\s*\\|`);
	const hit = inv.find((l) => re.test(l.text));
	return hit ? `I:${hit.no}` : "-";
}

function inventoryForKey(key: string, inv: Line[]): string {
	const re = new RegExp(`\\b${escapeRegex(key)}\\b`);
	const hit = inv.find((l) => re.test(l.text));
	return hit ? `I:${hit.no}` : "-";
}

function phaseItems(defs: PhaseDef[], inv: Line[], label: string): Item[] {
	const byNum = new Map(defs.map((d) => [d.num, d] as const));
	for (const d of defs) {
		for (const dep of d.deps) {
			if (!byNum.has(dep)) {
				throw new Error(
					`${label}:${d.line}: phase ${d.num} depends on phase ${dep}, which is not defined`,
				);
			}
		}
	}
	const openDeps = (num: string): string[] =>
		(byNum.get(num)?.deps ?? []).filter((dep) => !isComplete(byNum.get(dep)?.status ?? ""));
	const levels = new Map<string, number>();
	const levelOf = (num: string, path: string[]): number => {
		const known = levels.get(num);
		if (known !== undefined) return known;
		if (path.includes(num)) {
			const cycle = [...path, num].map((n) => `phase ${n}`).join(" -> ");
			throw new Error(`${label}: dependency cycle ${cycle}`);
		}
		const open = openDeps(num);
		const level =
			open.length === 0 ? 0 : 1 + Math.max(...open.map((dep) => levelOf(dep, [...path, num])));
		levels.set(num, level);
		return level;
	};
	return defs.map((d) => {
		const base = {
			id: `PHASE-${d.num}`,
			kind: "phase" as const,
			label: d.title,
			status: d.status,
			source: `R:${d.line}`,
			dependsOn: d.deps,
			inventory: inventoryForPhase(d.num, inv),
		};
		if (isComplete(d.status)) return { ...base, bucket: "closed", group: "-", missing: "" };
		const group = `G${levelOf(d.num, [])}`;
		const open = openDeps(d.num);
		if (open.length > 0) {
			const missing = open
				.map(
					(dep) => `phase ${dep} must reach Complete (currently: ${byNum.get(dep)?.status ?? ""})`,
				)
				.join("; ");
			return { ...base, bucket: "blocked", group, missing };
		}
		return { ...base, bucket: "executable", group, missing: "" };
	});
}

function backlogItems(ls: Line[], inv: Line[]): Item[] {
	const items: Item[] = [];
	let inBacklog = false;
	let plain = 0;
	for (const line of ls) {
		if (line.text.startsWith("## ")) {
			inBacklog = /^## Backlog\b/.test(line.text);
			continue;
		}
		const bullet = inBacklog ? /^- (.+)$/.exec(line.text) : null;
		if (!bullet) continue;
		const body = bullet[1] ?? "";
		const bold = /^\*\*([^*]+):\*\* (.+)$/.exec(body);
		const key = bold?.[1];
		const text = bold?.[2] ?? body;
		const source = `R:${line.no}`;
		const base = {
			id: key ? `BACKLOG-${key}` : `BACKLOG-${String(++plain).padStart(2, "0")}`,
			kind: "backlog" as const,
			label: text,
			status: "backlog",
			source,
			dependsOn: [],
			inventory: key ? inventoryForKey(key, inv) : "-",
		};
		if (STANDING_RULE.test(text)) {
			items.push({ ...base, bucket: "constraint", group: "-", missing: "" });
		} else {
			const missing = `condition in ${source} is not yet met: ${text}`;
			items.push({ ...base, bucket: "blocked", group: "external", missing });
		}
	}
	return items;
}

function tableRows(ls: Line[], title: string, header: string, label: string): TableRow[] {
	const start = ls.findIndex((l) => l.text === `## ${title}`);
	if (start < 0) throw new Error(`${label}: no "## ${title}" section`);
	const width = header.split("|").length;
	const rows: TableRow[] = [];
	let headerSeen = false;
	for (let j = start + 1; j < ls.length; j++) {
		const line = ls[j];
		if (!line || line.text.startsWith("## ")) break;
		if (!line.text.trim().startsWith("|")) continue;
		const cells = line.text
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((c) => c.trim());
		if (!headerSeen) {
			if (cells.join("|") !== header) {
				throw new Error(`${label}:${line.no}: "${title}" table header must match "${header}"`);
			}
			headerSeen = true;
			continue;
		}
		if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
		if (cells.length !== width) {
			throw new Error(
				`${label}:${line.no}: "${title}" row has ${cells.length} cells, expected ${width}`,
			);
		}
		rows.push({ no: line.no, cells });
	}
	if (!headerSeen) throw new Error(`${label}: "${title}" section has no table`);
	return rows;
}

function deferredItem(row: DeferredRow, inv: Line[], label: string): Item {
	const key = row.state.split(/[\s(]/)[0] ?? "";
	const source = row.sources.join(", ");
	const base = {
		id: `DEFERRED-${row.phase}`,
		kind: "deferred" as const,
		label: `Phase ${row.phase} verification`,
		status: row.state,
		source,
		dependsOn: [],
		inventory: inventoryForPhase(row.phase, inv),
	};
	if (Object.hasOwn(CLOSED_STATES, key))
		return { ...base, bucket: "closed", group: "-", missing: "" };
	if (!Object.hasOwn(OPEN_STATES, key)) {
		throw new Error(
			`${label}: phase ${row.phase} has unrecognised deferred state "${row.state}" (${source})`,
		);
	}
	const missing = row.resume
		? `human verification pending: run \`${row.resume}\` (${key}, ${source})`
		: `phase ${row.phase} ${key} with no resume command (${source}): owner decision or verification evidence required`;
	return { ...base, bucket: "blocked", group: "external", missing };
}

function deferredItems(ls: Line[], inv: Line[], label: string): Item[] {
	const rows = new Map<string, DeferredRow>();
	for (const row of tableRows(ls, "Deferred Verification", DV_HEADER, label)) {
		const phase = row.cells[0] ?? "";
		if (!/^\d+$/.test(phase)) {
			throw new Error(`${label}:${row.no}: phase cell "${phase}" is not a number`);
		}
		if (rows.has(phase)) {
			throw new Error(
				`${label}:${row.no}: phase ${phase} is listed twice in Deferred Verification`,
			);
		}
		rows.set(phase, {
			phase,
			state: row.cells[1] ?? "",
			resume: row.cells[2] ?? "",
			sources: [`S:${row.no}`],
		});
	}
	for (const row of tableRows(ls, "Deferred Items", DI_HEADER, label)) {
		const item = row.cells[1] ?? "";
		const phase = /^(\d+)\//.exec(item)?.[1];
		if (!phase) {
			throw new Error(`${label}:${row.no}: Item "${item}" does not start with a phase number`);
		}
		const existing = rows.get(phase);
		if (existing) {
			existing.sources.push(`S:${row.no}`);
		} else {
			rows.set(phase, {
				phase,
				state: row.cells[2] ?? "",
				resume: "",
				sources: [`S:${row.no}`],
			});
		}
	}
	return [...rows.values()].map((row) => deferredItem(row, inv, label));
}

function renderMatrix(items: Item[], labels: Labels): string {
	const nonOverlap = (item: Item): string => {
		if (item.kind !== "phase" || item.group === "-" || item.group === "external") return "-";
		const peers = items.filter((o) => o !== item && o.kind === "phase" && o.group === item.group);
		return peers.length > 0 ? peers.map((p) => p.id).join(", ") : "none";
	};
	const rows = items.map((item) => {
		const deps =
			item.dependsOn.length > 0 ? item.dependsOn.map((n) => `PHASE-${n}`).join(", ") : "-";
		return `| ${item.id} | ${item.kind} | ${escapeCell(item.label)} | ${escapeCell(item.status)} | ${item.bucket} | ${item.group} | ${deps} | ${nonOverlap(item)} | ${item.source} | ${item.inventory} |`;
	});
	const of = (bucket: Bucket): Item[] => items.filter((i) => i.bucket === bucket);
	const executable = of("executable").map((i) => `- ${i.id} (${i.group})`);
	const blocked = of("blocked").map((i) => `- ${i.id} (blocked): ${i.missing}`);
	const closed = of("closed").map((i) => `- ${i.id}`);
	const constraints = of("constraint").map((i) => `- ${i.id}`);
	const section = (lines: string[], header: string[] = []): string =>
		lines.length === 0 ? "None." : [...header, ...lines].join("\n");
	return [
		"# V1.24 task matrix",
		"",
		"Generated by `scripts/build-task-matrix.ts` from the sources below. Do not edit by hand; regenerate it.",
		"",
		"## Sources",
		"",
		`- \`R\`: \`${labels.roadmap}\``,
		`- \`S\`: \`${labels.state}\``,
		`- \`I\`: \`${labels.inventory}\``,
		"",
		"## Rules",
		"",
		...RULES,
		"",
		"## Matrix",
		"",
		"| ID | Kind | Item | Status | Bucket | Group | Depends on | Non-overlap | Source | Inventory |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"## Executable now",
		"",
		section(executable),
		"",
		"## Blocked",
		"",
		section(blocked),
		"",
		"## Closed",
		"",
		section(closed),
		"",
		"## Standing constraints (not work)",
		"",
		section(constraints),
		"",
	].join("\n");
}

/**
 * Builds the task matrix Markdown from the three planning sources. Throws when the
 * ROADMAP has no phase lines, a phase is defined twice, or a source is malformed.
 */
export function buildTaskMatrix(input: MatrixInput): string {
	const labels: Labels = {
		roadmap: input.paths?.roadmap ?? DEFAULT_ROADMAP,
		state: input.paths?.state ?? DEFAULT_STATE,
		inventory: input.paths?.inventory ?? DEFAULT_INVENTORY,
	};
	const roadmapLines = toLines(input.roadmap);
	const phases = parsePhases(roadmapLines, labels.roadmap);
	if (phases.length === 0) {
		throw new Error(
			`${labels.roadmap} has no phase lines ("### Phase N: title"); refusing to write an empty matrix`,
		);
	}
	const inventory = toLines(input.inventory);
	const items = [
		...phaseItems(phases, inventory, labels.roadmap),
		...backlogItems(roadmapLines, inventory),
		...deferredItems(toLines(input.state), inventory, labels.state),
	];
	return renderMatrix(items, labels);
}

type Source = { label: string; abs: string };
const FLAGS = ["--roadmap", "--state", "--inventory", "--out"];
const USAGE =
	"usage: bun scripts/build-task-matrix.ts [--roadmap <path>] [--state <path>] [--inventory <path>] [--out <path>]";

function parseFlags(argv: string[]): Map<string, string> {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i] ?? "";
		const value = argv[i + 1];
		if (!FLAGS.includes(flag)) throw new Error(`unknown argument "${flag}"\n${USAGE}`);
		if (value === undefined || value.startsWith("--"))
			throw new Error(`${flag} needs a path\n${USAGE}`);
		flags.set(flag, value);
	}
	return flags;
}

function locate(flags: Map<string, string>, flag: string, fallback: string): Source {
	const given = flags.get(flag);
	if (given === undefined) return { label: fallback, abs: resolve(REPO_ROOT, fallback) };
	return { label: given, abs: resolve(given) };
}

async function readSource(src: Source): Promise<string> {
	try {
		return await readFile(src.abs, "utf8");
	} catch (err) {
		throw new Error(`cannot read ${src.label}: ${(err as Error).message}`);
	}
}

/** The header label for a source: the repo-relative .planning path when the basename is one of the three planning files. */
function headerLabel(src: Source): string {
	return Object.hasOwn(PLANNING_LABELS, basename(src.abs))
		? (PLANNING_LABELS[basename(src.abs)] ?? src.label)
		: src.label;
}

async function runCli(argv: string[]): Promise<number> {
	let flags: Map<string, string>;
	try {
		flags = parseFlags(argv);
	} catch (err) {
		console.error(`build-task-matrix: ${(err as Error).message}`);
		return 2;
	}
	const roadmap = locate(flags, "--roadmap", DEFAULT_ROADMAP);
	const state = locate(flags, "--state", DEFAULT_STATE);
	const inventory = locate(flags, "--inventory", DEFAULT_INVENTORY);
	const out = locate(flags, "--out", DEFAULT_OUT);
	try {
		const markdown = buildTaskMatrix({
			roadmap: await readSource(roadmap),
			state: await readSource(state),
			inventory: await readSource(inventory),
			paths: {
				roadmap: headerLabel(roadmap),
				state: headerLabel(state),
				inventory: headerLabel(inventory),
			},
		});
		await mkdir(dirname(out.abs), { recursive: true });
		await Bun.write(out.abs, markdown);
	} catch (err) {
		console.error(`build-task-matrix: ${(err as Error).message}`);
		return 1;
	}
	console.log(`wrote ${out.label}`);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await runCli(process.argv.slice(2));
}
