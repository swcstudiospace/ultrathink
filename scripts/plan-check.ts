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
 *  - Bloat: effective line count above BLOAT_LIMIT after stripping ledger tables
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

/**
 * Reject over this many non-ledger, non-blank lines.
 * Verified against real plans 2026-11-27: largest non-ledger non-blank body
 * is 480 lines (103-02); anything past the limit signals ledger-class
 * volumina, not contract.
 */
export const BLOAT_LIMIT = 520;

/** Historic name for BLOAT_LIMIT; kept so older imports keep resolving to the same value. */
export const BLOAT_LINE_LIMIT = BLOAT_LIMIT;

/** Optional hooks. The default (no options) stays silent: no logging, no side effects. */
export interface PlanCheckOptions {
	/**
	 * Observes the final verdict exactly once per call. A throw propagates
	 * to the caller; the verdict itself is unaffected.
	 */
	onDecision?: (result: PlanCheckResult) => void;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;
const TOP_LEVEL_OPEN_TAG_PATTERN = /^<([A-Za-z][\w-]*)\b/;
const TASK_BLOCK_PATTERN = /<task\b[^>]*>([\s\S]*?)<\/task>/gi;
const FILES_VALUE_PATTERN = /^\s*files\s*:\s*(.+)$/im;
const FILE_SCOPE_PATTERN =
	/(?:[\w-]+\/|\.\w{1,10}\b|\w[\w-]*\.(?:ts|tsx|js|jsx|md|json|py|sh|yaml|yml))\b/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const TABLE_ROW_PATTERN = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*-{3,}/;
const NAMED_NUMBER_PATTERN = /[A-Za-z_][A-Za-z0-9_ -]*?\s*[:=]\s*\d[\d_]*/;
const CITATION_PATTERNS = [/@[\w./-]+/, /\[[^\]]+\]\([^)]+\)/, /\b[\w-]+\/[\w./-]+\b/];
const MACHINE_CHECK_PATTERNS = [
	/`[^`\n]+`/,
	/==|>=|<=/,
	/\b(?:bun|npm|node|pytest|grep|exit code|exit 0)\b/i,
];

function reject(reason: string): PlanCheckResult {
	return { ok: false, reason };
}

/** The YAML frontmatter body, or undefined when the document has none. */
function parseFrontmatter(md: string): string | undefined {
	return FRONTMATTER_PATTERN.exec(md)?.[1];
}

function frontmatterField(fm: string, names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "m").exec(fm)?.[1];
		if (value) return value;
	}
	return undefined;
}

/** The field's value including any indented block lines that follow it (nested objects). */
function frontmatterFieldBlock(fm: string, name: string): string | undefined {
	const opener = new RegExp(`^\\s*${name}\\s*:\\s*(.*)$`);
	const lines = fm.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const match = opener.exec(lines[i] ?? "");
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
		const tag = TOP_LEVEL_OPEN_TAG_PATTERN.exec(line)?.[1];
		if (tag && !line.trimEnd().endsWith("/>")) blocks.push(tag);
	}
	return blocks;
}

/** Body of the first `<tag>...</tag>` block, or undefined when absent/unclosed. */
function xmlSection(md: string, tag: string): string | undefined {
	// Safe to interpolate: every tag here comes from topLevelBlocks, whose
	// charset is limited to [A-Za-z][\w-]*, or from a static call-site literal.
	return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(md)?.[1];
}

/** Body of a `## <title>` … next-heading section (title matched loosely), or undefined. */
function headingSection(md: string, titles: readonly string[]): string | undefined {
	const lines = md.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const title = HEADING_PATTERN.exec(lines[i] ?? "")?.[2];
		if (title && titles.some((t) => title.toLowerCase().includes(t))) {
			start = i;
			break;
		}
	}
	if (start < 0) return undefined;
	const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const heading = HEADING_PATTERN.exec(lines[i] ?? "");
		if (heading && (heading[1]?.length ?? 0) <= level) break;
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
		const heading = HEADING_PATTERN.exec(line);
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
		if (TABLE_ROW_PATTERN.test(line)) {
			if (/ledger/i.test(line)) {
				inLedgerTable = true;
				continue;
			}
			if (inLedgerTable) continue;
		} else if (inLedgerTable) {
			if (TABLE_SEPARATOR_PATTERN.test(line)) continue;
			inLedgerTable = false;
		}
		if (line.trim() === "") continue;
		kept.push(line);
	}
	return kept;
}

function hasNamedNumber(text: string): boolean {
	return NAMED_NUMBER_PATTERN.test(text);
}

function hasCitation(text: string): boolean {
	return CITATION_PATTERNS.some((pattern) => pattern.test(text));
}

function hasMachineCheck(text: string): boolean {
	return MACHINE_CHECK_PATTERNS.some((pattern) => pattern.test(text));
}

function taskBlocks(md: string): string[] {
	return Array.from(md.matchAll(TASK_BLOCK_PATTERN), (m) => m[1] ?? "");
}

function taskHasFileScope(task: string): boolean {
	const files = xmlSection(task, "files");
	const body = files ?? FILES_VALUE_PATTERN.exec(task)?.[1] ?? "";
	return /\S/.test(body) && FILE_SCOPE_PATTERN.test(body);
}

function checkBlocks(blocks: string[]): PlanCheckResult | null {
	if (blocks.length === 0) return reject("0 blocks: no XML plan blocks found");
	return null;
}

function checkBloat(md: string): PlanCheckResult | null {
	if (effectiveLines(md).length > BLOAT_LIMIT) {
		return reject(`bloat: plan exceeds ${BLOAT_LIMIT} non-ledger lines`);
	}
	return null;
}

function checkTruncation(md: string, blocks: string[]): PlanCheckResult | null {
	for (const block of blocks) {
		if (!md.includes(`</${block}>`)) return reject(`truncated: unclosed <${block}> block`);
	}
	return null;
}

function checkTasks(md: string): PlanCheckResult | null {
	const tasks = taskBlocks(md);
	if (tasks.length === 0) return reject("no tasks: at least one <task> is required");
	if (!tasks.some(taskHasFileScope)) {
		return reject("no task file scope: at least one task must name files");
	}
	return null;
}

function checkBudgets(fm: string, md: string): PlanCheckResult | null {
	// Budgets live in frontmatter `estimate:` (gsd-planner 1.18.0 YAML),
	// not in a `<budget>` block — verified against real plans 2026-11-27.
	// (Earlier plans carry budgets only as prose; C-3 rejects those since
	// min-total unenforceable budgets cannot be machine-checked.)
	const estimate = frontmatterFieldBlock(fm, "estimate");
	const budget = section(md, "budget", ["budget"]);
	if (
		(estimate === undefined || !hasNamedNumber(estimate)) &&
		(budget === undefined || !hasNamedNumber(budget))
	) {
		return reject("missing budgets: a budget with named numbers (name: number) is required");
	}
	return null;
}

function checkContext(md: string): PlanCheckResult | null {
	const context = section(md, "context", ["context"]);
	if (context === undefined || !hasCitation(context)) {
		return reject("missing cited context: a context block with at least one citation is required");
	}
	return null;
}

function checkAcceptance(md: string): PlanCheckResult | null {
	const acceptanceSources = [
		section(md, "acceptance", ["acceptance"]),
		section(md, "success_criteria", ["success criteria", "acceptance criteria"]),
		section(md, "verification", ["verification"]),
	];
	// A machine-checkable signal in ANY accepted-criteria source satisfies C-5:
	// real plans split signals across verification + prose success_criteria.
	if (!acceptanceSources.some((s) => s !== undefined && hasMachineCheck(s))) {
		return reject(
			"missing machine-checkable acceptance: an acceptance/verification block with a command, comparison, or exit code is required",
		);
	}
	return null;
}

/** Pure predicate: Pass, or Reject with the first failed criterion's reason. */
export function checkPlanSet(md: string, options?: PlanCheckOptions): PlanCheckResult {
	const finish = (result: PlanCheckResult): PlanCheckResult => {
		options?.onDecision?.(result);
		return result;
	};
	// Boundary validation: non-string input has no frontmatter by definition.
	// C-1 (corrected 2026-11-27): the real planner (gsd-planner 1.18.0)
	// emits phase + plan ids only — there is no checkpoint hash in the
	// external template spec. Requiring one rejected every real PLAN.
	if (typeof md !== "string") return finish(reject("missing frontmatter: phase/plan ids"));
	const fm = parseFrontmatter(md);
	if (fm === undefined) return finish(reject("missing frontmatter: phase/plan ids"));

	if (!frontmatterField(fm, ["phase"])) return finish(reject("frontmatter missing phase"));
	if (!frontmatterField(fm, ["plan"])) return finish(reject("frontmatter missing plan"));

	const blocks = topLevelBlocks(md);
	const failed =
		checkBlocks(blocks) ??
		checkBloat(md) ??
		checkTruncation(md, blocks) ??
		checkTasks(md) ??
		checkBudgets(fm, md) ??
		checkContext(md) ??
		checkAcceptance(md);
	if (failed) return finish(failed);

	return finish({ ok: true });
}
