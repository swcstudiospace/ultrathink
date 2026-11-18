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
// Without flags (`bun run matrix`) the sources are the repo's .planning files and the
// output is docs/roadmap/task-matrix.md. Relative --out and source paths resolve from the
// cwd; defaults resolve from the repo root.

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
/** A backlog bullet is closed when its text starts with "Superseded by" or names "withdrawn". */
const CLOSED_BULLET = /^superseded by\b|\bwithdrawn\b/i;
const CLOSED_WORDS =
	/\b(withdrawn|superseded|accepted[ _]tech[ _]debt|complete|completed|closed|passed)\b/gi;
const OPEN_WORDS =
	/\b(pending|blocked|gaps?[ _]found|human[ _]needed|verification_deferred_human|not started|partial|needs?)\b/gi;
/** "phase N", "phases N and M", "phases N to M", "phases N/M": the list of numbers after the word. */
const PHASE_LIST = /\bphases?\s+(\d+(?:\s*(?:\/|,|\u2013|-|to|and)\s*\d+)*)/gi;
/** The first verdict word after "Verified" in a phase status line. */
const VERDICT = /\bVerified\b.*?\b(passed|human_needed|gaps_found)\b/i;
const CLOSED_STATES: Record<string, true> = { accepted_tech_debt: true, withdrawn: true };
const OPEN_STATES: Record<string, true> = {
	verification_deferred_human: true,
	human_needed: true,
	gaps_found: true,
};
const DV_HEADER = "Phase|State|Resume";
const DI_HEADER = "Category|Item|Status|Deferred At|Milestone";
const NOT_IN_SOURCES = "not in sources";

type MatrixInput = {
	roadmap: string;
	state: string;
	inventory: string;
	/** Labels printed in the header. Defaults to the repo-relative .planning paths. */
	paths?: { roadmap?: string; state?: string; inventory?: string };
};

type Bucket = "executable" | "blocked" | "deferred" | "closed" | "constraint";
type Claim = { cls: "open" | "closed"; words: string[] };
type Witness = { file: "R" | "S" | "I"; no: number; claim: Claim };
type Match = { mode: "number" | "word"; key: string };

type Item = {
	id: string;
	kind: "phase" | "backlog" | "deferred";
	label: string;
	status: string;
	source: string;
	/** The line that carries the item's own status claim. */
	own: { file: "R" | "S"; no: number };
	ownClaim: Claim | null;
	/** How other sources name this item; null when they cannot be matched. */
	match: Match | null;
	/** Phase numbers this item depends on. */
	dependsOn: string[];
	bucket: Bucket;
	group: string;
	/** The exact input that must become true. Empty unless blocked. */
	missing: string;
	inventory: string;
	evidence: string[];
	owner: string;
	validation: string;
};

type Line = { no: number; text: string };
type InventoryRow = { no: number; num: string; status: string };
type Sources = {
	roadmap: Line[];
	state: Line[];
	inventory: Line[];
	invRows: InventoryRow[];
	backlogKeys: string[];
};
type Labels = { roadmap: string; state: string; inventory: string };
type PhaseDef = {
	num: string;
	title: string;
	status: string;
	statusLine: number;
	deps: string[];
	owner: string | null;
	validation: string | null;
	line: number;
};
type TableRow = { no: number; cells: string[] };
type DeferredRow = { phase: string; state: string; resume: string; lines: number[] };

const RULES = [
	"- Status: a phase shows its ROADMAP `Status:` line, trailing period removed. A deferred item shows its STATE state from Deferred Verification, or from Deferred Items when it has no Deferred Verification row. A backlog item shows `backlog`.",
	"- Bucket: `closed` when a phase status starts with `Complete` or its verdict word after `Verified` is `passed`, a deferred state is `accepted_tech_debt` or `withdrawn`, or a backlog bullet starts with `Superseded by` or contains `withdrawn`. `deferred` when a phase's verdict word after `Verified` is `human_needed`: the owner runs its verification, so it is not executable. `constraint` for a standing rule whose text starts with `Do not` or `One-way`; it is not work. `blocked` when a dependency is not closed or a human or external input is missing. `executable` otherwise.",
	"- Parallel group: `G0` has no open dependency. `Gn` is one more than its deepest open dependency. `external` waits on a human or external input. `-` means closed or constraint.",
	"- Non-overlap: the other phase items in the same group. Items in one group have no dependency edge between them. File overlap is not derivable from these sources; check file sets before dispatching a group.",
	"- Depends on: phase numbers from `**Depends on:**`. Entry condition: those IDs, or `none`; a blocked or deferred item adds `missing:` and its exact missing input.",
	"- Evidence: the STATE (`S:`) and PHASES-INVENTORY (`I:`) lines the row cites, or `-`.",
	"- Owner and Validation command: a phase's `**Owner:**` and `**Validation:**` lines, and a deferred item's STATE resume cell when it is a slash command. Otherwise `not in sources`; nothing is inferred.",
	"- Conflicts: an item whose own status is open or closed, and whose first status-bearing line in each source file that names it (phase or deferred: `phase N` or an inventory row for N; backlog: its bold key) states the opposite class. A line that names more than one phase or backlog ID is not used for any of them. A line carrying both open and closed words is not a status claim. The item's own line is excluded.",
	"- Blocked input: the exact text that must become true. Backlog classification reads only the bullet text; status recorded elsewhere in ROADMAP is not consulted, except through Conflicts.",
];

function toLines(text: string): Line[] {
	return text.split("\n").map((raw, i) => ({ no: i + 1, text: raw.replace(/\r$/, "") }));
}

function escapeCell(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A phase's bucket from its ROADMAP status line and its open dependencies, in order: a status
 * starting with "Complete" is closed; verdict "passed" is closed; verdict "human_needed" is
 * deferred to the owner; otherwise the phase is blocked by an open dependency, else executable.
 * A dependency is satisfied when its phase is closed.
 */
function phaseBucket(status: string, openDeps: string[]): Bucket {
	const verdict = VERDICT.exec(status)?.[1]?.toLowerCase();
	if (/^Complete\b/.test(status) || verdict === "passed") return "closed";
	if (verdict === "human_needed") return "deferred";
	return openDeps.length > 0 ? "blocked" : "executable";
}

function splitRow(text: string): string[] {
	return text
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

function uniqueMatches(text: string, re: RegExp): string[] {
	const found = [...text.matchAll(re)].map((m) => m[0].toLowerCase().replace(/[ _]/g, "_"));
	return found.filter((word, i) => found.indexOf(word) === i);
}

/** A status claim: open or closed words, but not both. Null when the text makes no claim. */
function claimOf(text: string): Claim | null {
	const closed = uniqueMatches(text, CLOSED_WORDS);
	const open = uniqueMatches(text, OPEN_WORDS);
	if (closed.length > 0 && open.length === 0) return { cls: "closed", words: closed };
	if (open.length > 0 && closed.length === 0) return { cls: "open", words: open };
	return null;
}

/** The distinct IDs a line names: phase numbers in "phase(s) N ..." lists, and backlog keys. */
function namedIds(text: string, backlogKeys: string[]): string[] {
	const phases = [...text.matchAll(PHASE_LIST)].flatMap((m) =>
		[...(m[1] ?? "").matchAll(/\d+/g)].map((n) => n[0]),
	);
	const keys = backlogKeys.filter((k) => new RegExp(`\\b${escapeRegex(k)}\\b`).test(text));
	return [...phases, ...keys].filter((id, i, all) => all.indexOf(id) === i);
}

function backlogKeysOf(ls: Line[]): string[] {
	const keys: string[] = [];
	let inBacklog = false;
	for (const line of ls) {
		if (line.text.startsWith("## ")) {
			inBacklog = /^## Backlog\b/.test(line.text);
			continue;
		}
		const key = inBacklog ? /^- \*\*([^*]+):\*\* /.exec(line.text)?.[1] : undefined;
		if (key) keys.push(key);
	}
	return keys;
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
		let owner: string | null = null;
		let validation: string | null = null;
		for (let j = idx + 1; j < ls.length; j++) {
			const line = ls[j];
			if (!line || SECTION_HEADING.test(line.text)) break;
			if (!statusLine && line.text.startsWith("Status: ")) statusLine = line;
			if (!depsLine && line.text.startsWith("**Depends on:** ")) depsLine = line;
			const ownerLine = /^\*\*Owner:\*\* (.+)$/.exec(line.text);
			if (ownerLine && owner === null) owner = ownerLine[1] ?? null;
			const validationLine = /^\*\*Validation:\*\* `([^`]+)`/.exec(line.text);
			if (validationLine && validation === null) validation = validationLine[1] ?? null;
		}
		if (!statusLine) throw new Error(`${label}:${heading.no}: phase ${num} has no "Status:" line`);
		if (!depsLine) {
			throw new Error(`${label}:${heading.no}: phase ${num} has no "**Depends on:**" line`);
		}
		phases.push({
			num,
			title: m[2] ?? "",
			status: statusLine.text.slice("Status: ".length).trim().replace(/\.$/, ""),
			statusLine: statusLine.no,
			deps: parseDeps(depsLine.text.slice("**Depends on:** ".length), `${label}:${depsLine.no}`),
			owner,
			validation,
			line: heading.no,
		});
	}
	return phases;
}

/** Rows of every table whose first header cell starts with "Phase", with the Status column. */
function inventoryRows(ls: Line[]): InventoryRow[] {
	const rows: InventoryRow[] = [];
	let statusIdx = -1;
	for (const line of ls) {
		if (!line.text.trim().startsWith("|")) continue;
		const cells = splitRow(line.text);
		if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
		if (cells[0]?.startsWith("Phase")) {
			statusIdx = cells.findIndex((c) => c.startsWith("Status"));
			continue;
		}
		const num = /^(\d+)(?:-|$)/.exec(cells[0] ?? "")?.[1];
		if (num) {
			rows.push({ no: line.no, num, status: statusIdx >= 0 ? (cells[statusIdx] ?? "") : "" });
		}
	}
	return rows;
}

function inventoryFor(num: string, rows: InventoryRow[]): string {
	const hit = rows.find((r) => r.num === num);
	return hit ? `I:${hit.no}` : "-";
}

function inventoryForKey(key: string, inv: Line[]): string {
	const re = new RegExp(`\\b${escapeRegex(key)}\\b`);
	const hit = inv.find((l) => re.test(l.text));
	return hit ? `I:${hit.no}` : "-";
}

function phaseItems(defs: PhaseDef[], src: Sources, label: string): Item[] {
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
		(byNum.get(num)?.deps ?? []).filter(
			(dep) => phaseBucket(byNum.get(dep)?.status ?? "", []) !== "closed",
		);
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
	return defs.map((d): Item => {
		const inventory = inventoryFor(d.num, src.invRows);
		const base = {
			id: `PHASE-${d.num}`,
			kind: "phase" as const,
			label: d.title,
			status: d.status,
			source: `R:${d.line}`,
			own: { file: "R" as const, no: d.statusLine },
			ownClaim: claimOf(d.status),
			match: { mode: "number" as const, key: d.num },
			dependsOn: d.deps,
			inventory,
			evidence: inventory === "-" ? [] : [inventory],
			owner: d.owner ?? NOT_IN_SOURCES,
			validation: d.validation ?? NOT_IN_SOURCES,
		};
		const open = openDeps(d.num);
		const bucket = phaseBucket(d.status, open);
		if (bucket === "closed") return { ...base, bucket, group: "-", missing: "" };
		if (bucket === "deferred") {
			const missing = `owner human verification of phase ${d.num} must pass (currently: ${d.status})`;
			return { ...base, bucket, group: "external", missing };
		}
		const group = `G${levelOf(d.num, [])}`;
		if (bucket === "blocked") {
			const missing = open
				.map((dep) => `phase ${dep} must be closed (currently: ${byNum.get(dep)?.status ?? ""})`)
				.join("; ");
			return { ...base, bucket, group, missing };
		}
		return { ...base, bucket, group, missing: "" };
	});
}

function backlogItems(src: Sources): Item[] {
	const items: Item[] = [];
	let inBacklog = false;
	let plain = 0;
	for (const line of src.roadmap) {
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
		const inventory = key ? inventoryForKey(key, src.inventory) : "-";
		const base = {
			id: key ? `BACKLOG-${key}` : `BACKLOG-${String(++plain).padStart(2, "0")}`,
			kind: "backlog" as const,
			label: text,
			status: "backlog",
			source,
			own: { file: "R" as const, no: line.no },
			match: key ? { mode: "word" as const, key } : null,
			dependsOn: [],
			inventory,
			evidence: inventory === "-" ? [] : [inventory],
			owner: NOT_IN_SOURCES,
			validation: NOT_IN_SOURCES,
		};
		if (STANDING_RULE.test(text)) {
			items.push({ ...base, ownClaim: null, bucket: "constraint", group: "-", missing: "" });
		} else if (CLOSED_BULLET.test(text)) {
			items.push({
				...base,
				ownClaim: { cls: "closed", words: uniqueMatches(text, CLOSED_WORDS) },
				bucket: "closed",
				group: "-",
				missing: "",
			});
		} else {
			items.push({
				...base,
				ownClaim: { cls: "open", words: ["blocked"] },
				bucket: "blocked",
				group: "external",
				missing: `condition in ${source} is not yet met: ${text}`,
			});
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
		const cells = splitRow(line.text);
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

function deferredItem(row: DeferredRow, src: Sources, label: string): Item {
	const key = row.state.split(/[\s(]/)[0] ?? "";
	const refs = row.lines.map((n) => `S:${n}`);
	const inventory = inventoryFor(row.phase, src.invRows);
	const base = {
		id: `DEFERRED-${row.phase}`,
		kind: "deferred" as const,
		label: `Phase ${row.phase} verification`,
		status: row.state,
		source: refs.join(", "),
		own: { file: "S" as const, no: row.lines[0] ?? 0 },
		ownClaim: claimOf(row.state),
		match: { mode: "number" as const, key: row.phase },
		dependsOn: [],
		inventory,
		evidence: inventory === "-" ? refs : [...refs, inventory],
		owner: NOT_IN_SOURCES,
		validation: row.resume.startsWith("/") ? row.resume : NOT_IN_SOURCES,
	};
	if (Object.hasOwn(CLOSED_STATES, key)) {
		return { ...base, bucket: "closed", group: "-", missing: "" };
	}
	if (!Object.hasOwn(OPEN_STATES, key)) {
		throw new Error(
			`${label}: phase ${row.phase} has unrecognised deferred state "${row.state}" (${base.source})`,
		);
	}
	const missing = row.resume
		? `human verification pending: run \`${row.resume}\` (${key}, ${base.source})`
		: `phase ${row.phase} ${key} with no resume command (${base.source}): owner decision or verification evidence required`;
	return { ...base, bucket: "blocked", group: "external", missing };
}

function deferredItems(src: Sources, label: string): Item[] {
	const rows = new Map<string, DeferredRow>();
	for (const row of tableRows(src.state, "Deferred Verification", DV_HEADER, label)) {
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
			lines: [row.no],
		});
	}
	for (const row of tableRows(src.state, "Deferred Items", DI_HEADER, label)) {
		const item = row.cells[1] ?? "";
		const phase = /^(\d+)\//.exec(item)?.[1];
		if (!phase) {
			throw new Error(`${label}:${row.no}: Item "${item}" does not start with a phase number`);
		}
		const existing = rows.get(phase);
		if (existing) {
			existing.lines.push(row.no);
		} else {
			rows.set(phase, { phase, state: row.cells[2] ?? "", resume: "", lines: [row.no] });
		}
	}
	return [...rows.values()].map((row) => deferredItem(row, src, label));
}

/**
 * The first status-bearing line per source file that names the item, other than the item's
 * own status line. Phase and deferred items match `phase N` in prose and inventory rows for N;
 * backlog items match their bold key as a whole word.
 */
function witnesses(item: Item, src: Sources): Witness[] {
	if (!item.match) return [];
	const { mode, key } = item.match;
	const re =
		mode === "number"
			? new RegExp(`\\bphases?\\s+${key}\\b`, "i")
			: new RegExp(`\\b${escapeRegex(key)}\\b`);
	const found: Witness[] = [];
	/** True when the line names this item and no other phase or backlog ID. */
	const namesOnly = (text: string): boolean => {
		const ids = namedIds(text, src.backlogKeys);
		return ids.length === 1 && ids[0] === key;
	};
	const scan = (file: "R" | "S", ls: Line[]): void => {
		for (const line of ls) {
			if (item.own.file === file && item.own.no === line.no) continue;
			if (!re.test(line.text) || !namesOnly(line.text)) continue;
			const claim = claimOf(line.text);
			if (claim) found.push({ file, no: line.no, claim });
		}
	};
	scan("R", src.roadmap);
	scan("S", src.state);
	if (mode === "number") {
		for (const row of src.invRows) {
			const claim = row.num === key ? claimOf(row.status) : null;
			if (claim) found.push({ file: "I", no: row.no, claim });
		}
	} else {
		for (const line of src.inventory) {
			if (!re.test(line.text) || !namesOnly(line.text)) continue;
			const claim = claimOf(line.text);
			if (claim) found.push({ file: "I", no: line.no, claim });
		}
	}
	return (["R", "S", "I"] as const).flatMap((file) =>
		found.filter((w) => w.file === file).slice(0, 1),
	);
}

function conflictLines(items: Item[], src: Sources): string[] {
	const lines: string[] = [];
	for (const item of items) {
		const own = item.ownClaim;
		if (!own) continue;
		const disagree = witnesses(item, src).filter((w) => w.claim.cls !== own.cls);
		if (disagree.length === 0) continue;
		const claims = [{ file: item.own.file, no: item.own.no, claim: own }, ...disagree];
		const parts = claims.map(
			(c, i) =>
				`${i === 0 ? "own " : ""}${c.file}:${c.no} says ${c.claim.cls} (${c.claim.words.map((w) => `"${w}"`).join(", ")})`,
		);
		lines.push(`- ${item.id}: ${parts.join("; ")}`);
	}
	return lines;
}

function renderMatrix(items: Item[], src: Sources, labels: Labels): string {
	const nonOverlap = (item: Item): string => {
		if (item.kind !== "phase" || item.group === "-" || item.group === "external") return "-";
		const peers = items.filter((o) => o !== item && o.kind === "phase" && o.group === item.group);
		return peers.length > 0 ? peers.map((p) => p.id).join(", ") : "none";
	};
	const rows = items.map((item): string => {
		const deps =
			item.dependsOn.length > 0 ? item.dependsOn.map((n) => `PHASE-${n}`).join(", ") : "none";
		const entry = item.missing ? `${deps}; missing: ${item.missing}` : deps;
		const cells = [
			item.id,
			item.kind,
			item.label,
			item.status,
			item.bucket,
			item.group,
			deps === "none" ? "-" : deps,
			entry,
			nonOverlap(item),
			item.evidence.join(", ") || "-",
			item.owner,
			item.validation,
			item.source,
			item.inventory,
		];
		return `| ${cells.map(escapeCell).join(" | ")} |`;
	});
	const of = (bucket: Bucket): Item[] => items.filter((i) => i.bucket === bucket);
	const executable = of("executable").map((i) => `- ${i.id} (${i.group})`);
	const blocked = of("blocked").map((i) => `- ${i.id} (blocked): ${i.missing}`);
	const deferred = of("deferred").map((i) => `- ${i.id} (deferred): ${i.missing}`);
	const closed = of("closed").map((i) => `- ${i.id}`);
	const constraints = of("constraint").map((i) => `- ${i.id}`);
	const conflicts = conflictLines(items, src);
	const section = (lines: string[]): string => (lines.length === 0 ? "None." : lines.join("\n"));
	return [
		"# V1.24 task matrix",
		"",
		"Generated by `scripts/build-task-matrix.ts` from the sources below. Do not edit by hand.",
		"Regenerate with `bun run matrix` from a checkout that has `.planning/`. `ROADMAP.md`, `STATE.md` and `PHASES-INVENTORY.md` are tracked in git; `REQUIREMENTS.md` and other untracked `.planning/` files are gitignored.",
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
		"| ID | Kind | Item | Status | Bucket | Group | Depends on | Entry condition | Non-overlap | Evidence | Owner | Validation command | Source | Inventory |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
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
		"## Deferred to owner",
		"",
		section(deferred),
		"",
		"## Closed",
		"",
		section(closed),
		"",
		"## Standing constraints (not work)",
		"",
		section(constraints),
		"",
		"## Conflicts",
		"",
		section(conflicts),
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
	const inventoryLines = toLines(input.inventory);
	const src: Sources = {
		roadmap: roadmapLines,
		state: toLines(input.state),
		inventory: inventoryLines,
		invRows: inventoryRows(inventoryLines),
		backlogKeys: backlogKeysOf(roadmapLines),
	};
	const items = [
		...phaseItems(phases, src, labels.roadmap),
		...backlogItems(src),
		...deferredItems(src, labels.state),
	];
	return renderMatrix(items, src, labels);
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

/** The header label for a source: the repo-relative .planning path when the basename is one of the three planning files. */
function headerLabel(src: Source): string {
	const name = basename(src.abs);
	return Object.hasOwn(PLANNING_LABELS, name) ? (PLANNING_LABELS[name] ?? src.label) : src.label;
}

async function readSource(src: Source): Promise<string> {
	try {
		return await readFile(src.abs, "utf8");
	} catch (err) {
		throw new Error(`cannot read ${src.label}: ${(err as Error).message}`);
	}
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
