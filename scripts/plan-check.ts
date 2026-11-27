// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/plan-check.ts — pure plan-set linter implementing the C-1..C-6
 * acceptance contract as a single predicate: checkPlanSet(markdown) returns
 * Pass ({ ok: true }) or Reject ({ ok: false, reason }) on the first failed
 * criterion. Pure: no filesystem, config, or state access, no side effects.
 *
 * Criteria (checked in order):
 *  - Frontmatter: YAML block delimited by `---` carrying phase and plan ids
 *    (gsd-planner 1.18.0 emits no checkpoint hash — requiring one rejected
 *    every real PLAN, confirmed against .planning/phases/101-113).
 *  - Block count: top-level XML blocks (a tag at the start of a line, e.g.
 *    <objective>, <tasks>, <context>). 5-10 is the expected template range
 *    (informational only); 0 blocks is an auto-reject.
 *  - Bloat: effective line count above 290 after stripping ledger tables
 *    rejects with reason `bloat`. Ledger tables (under a `ledger` heading or
 *    a table whose header names a ledger) do not count against the limit,
 *    so ledger-carrying full contracts are not penalised for their tables.
 *  - Truncation: an opened top-level block without its closing tag rejects.
 *  - Tasks: at least one <task> and at least one task with file scope
 *    (a non-empty <files> block naming a file).
 *  - Budgets: a budget block/section with at least one named number
 *    (`name: <number>`, e.g. `max_tokens: 60000`).
 *  - Context: a context block/section with at least one citation
 *    (@path, a markdown link, or a path-like token).
 *  - Acceptance: an acceptance/success-criteria/verification block/section
 *    carrying a machine-checkable signal (backticked command, comparison
 *    operator, or a named runner such as bun test / grep / exit code).
 */

export type PlanCheckResult = { ok: true } | { ok: false; reason: string };

/** Verified against real plans 2026-11-27: largest non-ledger non-blank body is 378 lines
 *  (103-02); anything past 420 signals ledger-class volumina, not contract. */
const BLOAT_LINE_LIMIT = 420;

function reject(reason: string): PlanCheckResult {
	return { ok: false, reason };
}

/** The YAML frontmatter body, or undefined when the document has none. */
function frontmatter(md: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
	return match?.[1];
}

function frontmatterField(fm: string, names: readonly string[]): string | undefined {
	for (const name of names) {
		const match = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "m").exec(fm);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

/** The field's value including any indented block lines that follow it (nested objects). */
function frontmatterFieldBlock(fm: string, name: string): string | undefined {
	const lines = fm.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const match = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`).exec(line);
		if (!match) continue;
		const parts = [match[1] ?? ""];
		for (let j = i + 1; j < lines.length; j += 1) {
			const next = lines[j] ?? "";
			if (next.trim() === "" || next.startsWith(" ")) parts.push(next);
			else break;
		}
		return parts.join("\n");
	}
	return undefined;
}

/** Top-level XML block names: an opening tag at the start of a line. */
function topLevelBlocks(md: string): string[] {
	const blocks: string[] = [];
	for (const line of md.split("\n")) {
		const match = /^<([A-Za-z][\w-]*)\b/.exec(line);
		if (match?.[1] && !line.trimEnd().endsWith("/>")) blocks.push(match[1]);
	}
	return blocks;
}

/** Body of the first `<tag>...</tag>` block, or undefined when absent/unclosed. */
function xmlSection(md: string, tag: string): string | undefined {
	const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(md);
	return match?.[1];
}

/** Body of a `## <title>` … next-heading section (title matched loosely), or undefined. */
function headingSection(md: string, titles: readonly string[]): string | undefined {
	const lines = md.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const heading = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i] ?? "");
		if (heading?.[1] && titles.some((t) => heading[1]?.toLowerCase().includes(t))) {
			start = i;
			break;
		}
	}
	if (start < 0) return undefined;
	const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const heading = /^#{1,6}\s+/.exec(lines[i] ?? "");
		if (heading && heading[0].length <= level) break;
		body.push(lines[i] ?? "");
	}
	return body.join("\n");
}

/** First present source among XML blocks and heading sections. */
function section(md: string, tag: string, titles: readonly string[]): string | undefined {
	return xmlSection(md, tag) ?? headingSection(md, titles);
}

/**
 * Lines minus ledger content: everything under a `ledger` heading until the
 * next heading of the same or higher level, plus any contiguous markdown
 * table whose header row names a ledger. Ledger tables alone never make a
 * contract-intact plan read as bloat.
 */
function effectiveLines(md: string): string[] {
	const lines = md.split("\n");
	const kept: string[] = [];
	let ledgerLevel = 0;
	let inLedgerTable = false;
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const level = heading[1]?.length ?? 1;
			if (/ledger/i.test(heading[2] ?? "")) {
				ledgerLevel = level;
				inLedgerTable = false;
				continue;
			}
			if (ledgerLevel > 0 && level <= ledgerLevel) ledgerLevel = 0;
		}
		if (ledgerLevel > 0) continue;
		const isTableRow = /^\s*\|.*\|\s*$/.test(line);
		if (isTableRow && /ledger/i.test(line)) {
			inLedgerTable = true;
			continue;
		}
		if (inLedgerTable) {
			if (isTableRow || /^\s*\|?\s*-{3,}/.test(line)) continue;
			inLedgerTable = false;
		}
		kept.push(line);
	}
	return kept;
}

function hasNamedNumber(text: string): boolean {
	return /[A-Za-z_][A-Za-z0-9_ -]*?\s*[:=]\s*\d[\d_]*/.test(text);
}

function hasCitation(text: string): boolean {
	return (
		/@[\w./-]+/.test(text) || /\[[^\]]+\]\([^)]+\)/.test(text) || /\b[\w-]+\/[\w./-]+\b/.test(text)
	);
}

function hasMachineCheck(text: string): boolean {
	return (
		/`[^`\n]+`/.test(text) ||
		/==|>=|<=/.test(text) ||
		/\b(?:bun|npm|node|pytest|grep|exit code|exit 0)\b/i.test(text)
	);
}

function taskBlocks(md: string): string[] {
	return Array.from(md.matchAll(/<task\b[^>]*>([\s\S]*?)<\/task>/gi), (m) => m[1] ?? "");
}

function taskHasFileScope(task: string): boolean {
	const files = xmlSection(task, "files");
	const body = files ?? /^\s*files\s*:\s*(.+)$/im.exec(task)?.[1] ?? "";
	return (
		/\S/.test(body) &&
		/(?:[\w-]+\/|\.\w{1,10}\b|\w[\w-]*\.(?:ts|tsx|js|jsx|md|json|py|sh|yaml|yml)\b)/.test(body)
	);
}

/** Pure predicate: Pass, or Reject with the first failed criterion's reason. */
export function checkPlanSet(md: string): PlanCheckResult {
	const fm = frontmatter(md);
	// C-1 (corrected 2026-11-27): the real planner (gsd-planner 1.18.0)
	// emits phase + plan ids only — there is no checkpoint hash in the
	// external template spec. Requiring one rejected every real PLAN.
	if (fm === undefined) return reject("missing frontmatter: phase/plan ids");

	if (!frontmatterField(fm, ["phase"])) return reject("frontmatter missing phase");
	if (!frontmatterField(fm, ["plan"])) return reject("frontmatter missing plan");

	const blocks = topLevelBlocks(md);
	if (blocks.length === 0) return reject("0 blocks: no XML plan blocks found");

	if (effectiveLines(md).length > BLOAT_LINE_LIMIT) {
		return reject(`bloat: plan exceeds ${BLOAT_LINE_LIMIT} non-ledger lines`);
	}

	for (const block of blocks) {
		if (!md.includes(`</${block}>`)) return reject(`truncated: unclosed <${block}> block`);
	}

	const tasks = taskBlocks(md);
	if (tasks.length === 0) return reject("no tasks: at least one <task> is required");
	if (!tasks.some(taskHasFileScope)) {
		return reject("no task file scope: at least one task must name files");
	}

	// Budgets live in frontmatter `estimate:` (gsd-planner 1.18.0 YAML),
	// not in a `<budget>` block — verified against real plans 2026-11-27.
	const estimate = frontmatterField(frontmatter(md) ?? "", ["estimate"]);
	const budget =
		estimate !== undefined && hasNamedNumber(estimate)
			? estimate
			: section(md, "budget", ["budget"]);
	if (estimate === undefined && (budget === undefined || !hasNamedNumber(budget))) {
		return reject("missing budgets: a budget with named numbers (name: number) is required");
	}

	const context = section(md, "context", ["context"]);
	if (context === undefined || !hasCitation(context)) {
		return reject("missing cited context: a context block with at least one citation is required");
	}

	const acceptance =
		section(md, "acceptance", ["acceptance"]) ??
		section(md, "success_criteria", ["success criteria", "acceptance criteria"]) ??
		section(md, "verification", ["verification"]);
	if (acceptance === undefined || !hasMachineCheck(acceptance)) {
		return reject(
			"missing machine-checkable acceptance: an acceptance/verification block with a command, comparison, or exit code is required",
		);
	}

	return { ok: true };
}
