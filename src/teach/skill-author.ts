// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Auto-authored reusable skills (Linear SPE-34396, SPE-34459): the pure logic that decides whether a Teachable Moment
 * or recalled lesson is worth a skill, drafts it from the record's own fields, validates it and merges it into an
 * existing skill. No filesystem, network or clock: the caller passes `now`, the existence and symbol predicates, the
 * existing skills and the recurrence pool, and writes the result.
 *
 * `authorSkill` runs: qualify -> secret scan of the full source text -> plan (create or merge) -> validate.
 * Validation order: schema and length bounds; minimum description length; secret scan; referenced paths (a missing path
 * rejects the skill as stale); backticked symbols (a missing symbol warns and marks the skill stale); instruction-like
 * steps are stripped last.
 *
 * Facts a moment does not record (task type, scope globs, root cause, resolution, explicit user confirmation) come from
 * the caller in `SkillFacts`. Steps and the description come from a template over the record's name, description, body
 * and root cause; the body contributes only a preview of its first lines.
 */
import { createHash } from "node:crypto";
import { redactSecretShapes } from "../redact.ts";
import { unique } from "../shared.ts";
import { MAX_DESCRIPTION_CHARS } from "./types.ts";

/**
 * Placeholder threshold: token-set (Jaccard) similarity of two normalized descriptions at or above which a new draft
 * merges into an existing skill. To be tuned on real drafts.
 */
const SKILL_SIMILARITY_THRESHOLD = 0.6;
/** Records of one signature inside the window that qualify a lesson without a root cause. */
const SKILL_RECURRENCE_MIN = 2;
const SKILL_NAME_MAX_CHARS = 64;
const SKILL_DESCRIPTION_MIN_CHARS = 16;
const SKILL_MAX_STEPS = 12;
const SKILL_STEP_MAX_CHARS = 240;

const PREVIEW_LINES = 5;
const PREVIEW_LINE_CHARS = 200;
const SIGNATURE_CHARS = 120;
const NAME_BASE_CHARS = SKILL_NAME_MAX_CHARS - 8;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const PATH_TOKEN_RE = /(?:[\w.@-]+\/)+[\w.@-]*/g;
const HASH_TOKEN_RE = /\b[0-9a-f]{8,}\b/g;
const NUMBER_TOKEN_RE = /\b\d+\b/g;
const NON_WORD_RE = /[^a-z0-9\s]+/g;
const BACKTICKED_RE = /`([^`\n]{1,200})`/g;
const SYMBOL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const LINE_BREAK_RE = /[\r\n]/;
const INSTRUCTION_LIKE_RE: readonly RegExp[] = [
	/\b(?:ignore|disregard|forget)\b.{0,40}\b(?:previous|prior|above|earlier|all|system|instructions?|prompts?)\b/i,
	/^\s*(?:system|assistant|developer)\s*:/i,
	/<\/?\s*(?:system|instructions?|prompt)\s*>/i,
	/\byou are now\b/i,
	/\bnew instructions?\b/i,
];

/** The fields a moment (`TeachableMoment`) and a recalled lesson (`RecalledLesson`) share; `status` is only on moments. */
export interface SkillSource {
	id: string;
	name: string;
	description: string;
	/** Lesson text. Only a preview of it reaches a skill; the full text is scanned for secrets first. */
	body: string;
	/** ISO 8601 UTC. */
	createdAt: string;
}

/** What a moment does not record: supplied by the caller. */
export interface SkillFacts {
	/** The task the lesson applies to, e.g. "typescript-build". */
	taskType: string;
	/** Repository path globs the lesson applies to. */
	scopeGlobs: string[];
	/** The recorded root cause, when the capture has one. */
	rootCause?: string;
	/** The problem was fixed. */
	resolved: boolean;
	/** The user explicitly confirmed the lesson as a skill; bypasses the recurrence and root-cause conditions. */
	userConfirmed: boolean;
}

export interface SkillCandidate {
	source: SkillSource;
	facts: SkillFacts;
}

export interface QualifyWindow {
	/** ISO 8601 UTC; the window ends here. */
	now: string;
	/** A record counts when its `createdAt` falls in (now - windowMs, now]. */
	windowMs: number;
}

export type Qualification =
	| {
			qualified: true;
			by: "user-confirmed" | "recurrence" | "resolved-root-cause";
			signature: string;
			/** Records of the signature inside the window (0 when `now` is not a valid time). */
			recurrence: number;
	  }
	| {
			qualified: false;
			reason: "below-threshold" | "invalid-time";
			signature: string;
			recurrence: number;
	  };

interface AppliesWhen {
	task_types: string[];
	scope_globs: string[];
	/** Normalized error signatures (see `normalizeSignature`). */
	error_signatures: string[];
}

type AutoSkillStatus = "draft" | "disabled";

export interface AutoSkill {
	/** Kebab-case slug, unique among skills. */
	name: string;
	/** One line ending with a period; names the task type and the error signature. */
	description: string;
	applies_when: AppliesWhen;
	/** Imperative checks. */
	steps: string[];
	/** Moment or lesson ids the skill was made from. */
	source_ids: string[];
	generated_by: "auto";
	/** ISO 8601 UTC, passed in by the caller. */
	generated_at: string;
	/** sha256 hex of the name, description, applies_when and steps. */
	content_hash: string;
	version: number;
	status: AutoSkillStatus;
	/** First 32 hex characters of sha256(normalized signature): the exact-match key for merges. */
	signature_hash: string;
	/** A symbol the steps reference was unknown when validated: review before relying on the skill. */
	stale: boolean;
	warnings: string[];
}

export interface SkillChecks {
	/** True when the repository path (relative to the repository root) exists. */
	exists: (path: string) => boolean;
	/** True when the symbol is defined in the repository. */
	symbolKnown: (symbol: string) => boolean;
}

type SkillRejection =
	| { kind: "invalid-schema"; field: string; detail: string }
	| { kind: "description-too-short"; length: number; min: number }
	/** `field` names the text that matched; the matched text is never returned. */
	| { kind: "secret-detected"; field: string }
	/** A path the steps reference does not exist: the lesson is stale. */
	| { kind: "stale-path"; path: string };

export type SkillValidation =
	| { ok: true; skill: AutoSkill }
	| { ok: false; reason: SkillRejection };

type SkillMatch =
	| { by: "signature-hash" }
	| { by: "task-scope" }
	| { by: "similarity"; score: number };

export interface PlanInput {
	candidate: SkillCandidate;
	/** Skills already on disk, any status. */
	existing: readonly AutoSkill[];
	/** ISO 8601 UTC: `generated_at` of a new draft or of a merged update. */
	now: string;
	/** Names taken outside `existing` (authored skills, other installs). */
	takenNames?: ReadonlySet<string>;
}

export type SkillPlan =
	| { action: "create"; skill: AutoSkill }
	| { action: "update"; match: SkillMatch; skill: AutoSkill }
	| { action: "refused"; reason: SkillRejection };

export interface AuthorInput {
	candidate: SkillCandidate;
	/** Records the recurrence window counts; the candidate's own record is counted too, once. */
	pool: readonly SkillSource[];
	existing: readonly AutoSkill[];
	takenNames?: ReadonlySet<string>;
	/** ISO 8601 UTC: window end and `generated_at`. */
	now: string;
	windowMs: number;
	checks: SkillChecks;
}

export type AuthorOutcome =
	| { status: "skipped"; qualification: Qualification }
	| { status: "rejected"; reason: SkillRejection; qualification: Qualification }
	| {
			status: "ready";
			action: "create" | "update";
			match?: SkillMatch;
			skill: AutoSkill;
			qualification: Qualification;
	  };

/**
 * Lowercase words only: paths become `path`, hashes and bare numbers are dropped, punctuation is removed. The same rule
 * names a skill and matches signatures, so "tsc rejects value imports of types: use import type" and its variant with
 * a different line number or path normalize alike.
 */
export function normalizeSignature(text: string): string {
	return text
		.toLowerCase()
		.replace(PATH_TOKEN_RE, " path ")
		.replace(HASH_TOKEN_RE, " ")
		.replace(NUMBER_TOKEN_RE, " ")
		.replace(NON_WORD_RE, " ")
		.split(/\s+/)
		.filter(Boolean)
		.join(" ");
}

/** Jaccard similarity of the normalized token sets; 0 when both are empty. */
function tokenSimilarity(a: string, b: string): number {
	const left = new Set(normalizeSignature(a).split(" ").filter(Boolean));
	const right = new Set(normalizeSignature(b).split(" ").filter(Boolean));
	if (left.size === 0 && right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / (left.size + right.size - shared);
}

/** sha256 of the normalized signature, first 32 hex characters (the `dedupeKey` convention). */
function signatureHashOf(signature: string): string {
	return createHash("sha256").update(signature).digest("hex").slice(0, 32);
}

/** sha256 hex of the authored content in a fixed field order, so a re-read record hashes the same. */
export function contentHashOf(
	content: Pick<AutoSkill, "name" | "description" | "applies_when" | "steps">,
): string {
	const { applies_when: when } = content;
	const canonical = [
		content.name,
		content.description,
		[when.task_types, when.scope_globs, when.error_signatures],
		content.steps,
	];
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The first lines of a text, trimmed, non-empty, each cut to a preview length. */
function previewOf(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.slice(0, PREVIEW_LINES)
		.map((line) => cutText(line, PREVIEW_LINE_CHARS));
}

/** Backticked spans that look like repository paths (contain `/`, no whitespace, not URLs). */
function referencedPaths(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(BACKTICKED_RE)) {
		const span = match[1] ?? "";
		if (span.includes("/") && !/\s/.test(span) && !span.includes("://")) out.push(span);
	}
	return unique(out);
}

/** Backticked spans that are identifiers, optionally dotted (`parseFlags`, `config.teach`); a trailing `()` is dropped. */
function referencedSymbols(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(BACKTICKED_RE)) {
		const span = (match[1] ?? "").replace(/\(\)$/, "");
		if (SYMBOL_RE.test(span)) out.push(span);
	}
	return unique(out);
}

/** A line that tries to give the reader new instructions. Stripped from skill steps: lesson text is untrusted. */
function isInstructionLike(line: string): boolean {
	return INSTRUCTION_LIKE_RE.some((pattern) => pattern.test(line));
}

/**
 * Whether the candidate is a skill candidate. Explicit user confirmation qualifies alone. Otherwise the normalized
 * signature must recur at least `SKILL_RECURRENCE_MIN` times in the window (the candidate counts), or the record must
 * carry a root cause and be resolved.
 */
export function qualifySkillCandidate(
	candidate: SkillCandidate,
	pool: readonly SkillSource[],
	window: QualifyWindow,
): Qualification {
	const signature = normalizeSignature(candidate.source.name);
	const recurrence = recurrenceOf(candidate.source, signature, pool, window);
	const { facts } = candidate;
	if (facts.userConfirmed) return { qualified: true, by: "user-confirmed", signature, recurrence };
	if (recurrence >= SKILL_RECURRENCE_MIN)
		return { qualified: true, by: "recurrence", signature, recurrence };
	if ((facts.rootCause ?? "").trim() !== "" && facts.resolved) {
		return { qualified: true, by: "resolved-root-cause", signature, recurrence };
	}
	const reason = Number.isNaN(Date.parse(window.now)) ? "invalid-time" : "below-threshold";
	return { qualified: false, reason, signature, recurrence };
}

/**
 * Create or merge. An exact signature-hash match wins, then the same task type with the same scope, then the best
 * description similarity at or above `SKILL_SIMILARITY_THRESHOLD`. A merge keeps the existing name, description and
 * status (a disabled skill stays disabled), unions the sources and the applicability and bumps the version.
 * A new skill's name is the signature slug, suffixed `-2`, `-3`, ... until it is free.
 */
export function planSkill(input: PlanInput): SkillPlan {
	const { source, facts } = input.candidate;
	const signature = normalizeSignature(source.name);
	if (signature === "") {
		return {
			action: "refused",
			reason: { kind: "invalid-schema", field: "name", detail: "the title has no words" },
		};
	}
	const description = `Use for ${facts.taskType} tasks that hit "${cutText(signature, SIGNATURE_CHARS)}".`;
	const incoming = {
		applies_when: {
			task_types: [facts.taskType],
			scope_globs: unique(facts.scopeGlobs),
			error_signatures: [signature],
		},
		steps: stepsFor(source, facts, signature),
	};
	const merge = (existing: AutoSkill, match: SkillMatch): SkillPlan => ({
		action: "update",
		match,
		skill: mergeSkill(existing, incoming, source.id, input.now),
	});

	const signatureHash = signatureHashOf(signature);
	const bySignature = input.existing.find((skill) => skill.signature_hash === signatureHash);
	if (bySignature) return merge(bySignature, { by: "signature-hash" });

	const byScope = input.existing.find(
		(skill) =>
			skill.applies_when.task_types.includes(facts.taskType) &&
			sameSet(skill.applies_when.scope_globs, incoming.applies_when.scope_globs),
	);
	if (byScope) return merge(byScope, { by: "task-scope" });

	let best: { skill: AutoSkill; score: number } | undefined;
	for (const skill of input.existing) {
		const score = tokenSimilarity(description, skill.description);
		if (score >= SKILL_SIMILARITY_THRESHOLD && (best === undefined || score > best.score)) {
			best = { skill, score };
		}
	}
	if (best) return merge(best.skill, { by: "similarity", score: best.score });

	const taken = new Set<string>([
		...input.existing.map((skill) => skill.name),
		...(input.takenNames ?? []),
	]);
	const content = {
		name: uniqueName(
			signature.replace(/ /g, "-").slice(0, NAME_BASE_CHARS).replace(/-+$/, ""),
			taken,
		),
		description,
		applies_when: incoming.applies_when,
		steps: incoming.steps,
	};
	return {
		action: "create",
		skill: {
			...content,
			source_ids: [source.id],
			generated_by: "auto",
			generated_at: input.now,
			content_hash: contentHashOf(content),
			version: 1,
			status: "draft",
			signature_hash: signatureHash,
			stale: false,
			warnings: [],
		},
	};
}

/**
 * Validates a planned skill in the documented order. Returns the skill with `content_hash` recomputed after the
 * instruction-like steps were stripped, `stale` set when a referenced symbol is unknown, and those symbols in `warnings`.
 */
export function validateSkill(skill: AutoSkill, checks: SkillChecks): SkillValidation {
	const problem = schemaProblem(skill);
	if (problem !== undefined) return { ok: false, reason: { kind: "invalid-schema", ...problem } };
	if (skill.description.length < SKILL_DESCRIPTION_MIN_CHARS) {
		return {
			ok: false,
			reason: {
				kind: "description-too-short",
				length: skill.description.length,
				min: SKILL_DESCRIPTION_MIN_CHARS,
			},
		};
	}
	for (const [field, text] of authoredTexts(skill)) {
		if (redactSecretShapes(text) !== text)
			return { ok: false, reason: { kind: "secret-detected", field } };
	}
	for (const step of skill.steps) {
		for (const path of referencedPaths(step)) {
			if (!checks.exists(path)) return { ok: false, reason: { kind: "stale-path", path } };
		}
	}
	const unknown = unique(skill.steps.flatMap(referencedSymbols)).filter(
		(symbol) => !checks.symbolKnown(symbol),
	);
	const steps = skill.steps.filter((step) => !isInstructionLike(step));
	if (steps.length === 0) {
		return {
			ok: false,
			reason: {
				kind: "invalid-schema",
				field: "steps",
				detail: "every step was an instruction-like line",
			},
		};
	}
	const stripped = skill.steps.length - steps.length;
	const warnings = [
		...unknown.map((symbol) => `symbol-unknown: ${symbol}`),
		...(stripped > 0 ? [`stripped ${stripped} instruction-like step(s)`] : []),
	];
	const content = {
		name: skill.name,
		description: skill.description,
		applies_when: skill.applies_when,
		steps,
	};
	return {
		ok: true,
		skill: {
			...skill,
			steps,
			content_hash: contentHashOf(content),
			stale: unknown.length > 0,
			warnings,
		},
	};
}

/**
 * The whole pipeline for one candidate. Nothing is written: the caller stores a `ready` skill (create or replace the
 * existing one with the same name) and records the qualification.
 */
export function authorSkill(input: AuthorInput): AuthorOutcome {
	const qualification = qualifySkillCandidate(input.candidate, input.pool, {
		now: input.now,
		windowMs: input.windowMs,
	});
	if (!qualification.qualified) return { status: "skipped", qualification };
	const secretIn = secretFieldOf(input.candidate);
	if (secretIn !== undefined) {
		return {
			status: "rejected",
			reason: { kind: "secret-detected", field: secretIn },
			qualification,
		};
	}
	const plan = planSkill({
		candidate: input.candidate,
		existing: input.existing,
		now: input.now,
		...(input.takenNames === undefined ? {} : { takenNames: input.takenNames }),
	});
	if (plan.action === "refused") return { status: "rejected", reason: plan.reason, qualification };
	const validation = validateSkill(plan.skill, input.checks);
	if (!validation.ok) return { status: "rejected", reason: validation.reason, qualification };
	if (plan.action === "create") {
		return { status: "ready", action: "create", skill: validation.skill, qualification };
	}
	return {
		status: "ready",
		action: "update",
		match: plan.match,
		skill: validation.skill,
		qualification,
	};
}

function recurrenceOf(
	source: SkillSource,
	signature: string,
	pool: readonly SkillSource[],
	window: QualifyWindow,
): number {
	const end = Date.parse(window.now);
	if (Number.isNaN(end) || signature === "") return 0;
	const byId = new Map<string, SkillSource>();
	for (const record of [source, ...pool]) if (!byId.has(record.id)) byId.set(record.id, record);
	let count = 0;
	for (const record of byId.values()) {
		const at = Date.parse(record.createdAt);
		if (Number.isNaN(at) || at > end || at <= end - window.windowMs) continue;
		if (normalizeSignature(record.name) === signature) count += 1;
	}
	return count;
}

function stepsFor(source: SkillSource, facts: SkillFacts, signature: string): string[] {
	const steps = [
		`Confirm the failure matches "${cutText(signature, SIGNATURE_CHARS)}" before changing anything.`,
	];
	const rootCause = (facts.rootCause ?? "").replace(/\s+/g, " ").trim();
	if (rootCause !== "")
		steps.push(`Confirm the root cause: ${cutText(rootCause, PREVIEW_LINE_CHARS)}`);
	for (const line of previewOf(source.body)) steps.push(`Check: ${line}`);
	return steps;
}

function mergeSkill(
	existing: AutoSkill,
	incoming: Pick<AutoSkill, "applies_when" | "steps">,
	sourceId: string,
	now: string,
): AutoSkill {
	const applies_when: AppliesWhen = {
		task_types: union(existing.applies_when.task_types, incoming.applies_when.task_types),
		scope_globs: union(existing.applies_when.scope_globs, incoming.applies_when.scope_globs),
		error_signatures: union(
			existing.applies_when.error_signatures,
			incoming.applies_when.error_signatures,
		),
	};
	const steps = union(existing.steps, incoming.steps);
	return {
		...existing,
		applies_when,
		steps,
		source_ids: union(existing.source_ids, [sourceId]),
		generated_at: now,
		content_hash: contentHashOf({
			name: existing.name,
			description: existing.description,
			applies_when,
			steps,
		}),
		version: existing.version + 1,
		stale: false,
		warnings: [],
	};
}

function schemaProblem(skill: AutoSkill): { field: string; detail: string } | undefined {
	const when = skill.applies_when;
	const rules: Array<[field: string, ok: boolean, detail: string]> = [
		["name", NAME_RE.test(skill.name), "kebab-case, 1 to 64 characters"],
		[
			"description",
			skill.description.trim() !== "" &&
				skill.description.length <= MAX_DESCRIPTION_CHARS &&
				!LINE_BREAK_RE.test(skill.description) &&
				skill.description.endsWith("."),
			"one line of at most 300 characters ending with a period",
		],
		["generated_by", skill.generated_by === "auto", 'must be "auto"'],
		["generated_at", ISO_UTC_RE.test(skill.generated_at), "ISO 8601 UTC"],
		["status", skill.status === "draft" || skill.status === "disabled", '"draft" or "disabled"'],
		["version", Number.isInteger(skill.version) && skill.version >= 1, "integer of at least 1"],
		["source_ids", listOf(skill.source_ids, 1, 50, 200), "1 to 50 non-empty ids"],
		[
			"steps",
			listOf(skill.steps, 1, SKILL_MAX_STEPS, SKILL_STEP_MAX_CHARS),
			`1 to ${SKILL_MAX_STEPS} single-line steps`,
		],
		[
			"applies_when.task_types",
			listOf(when.task_types, 1, 10, 80),
			"1 to 10 task types of at most 80 characters",
		],
		[
			"applies_when.scope_globs",
			listOf(when.scope_globs, 0, 20, 200),
			"at most 20 globs of at most 200 characters",
		],
		[
			"applies_when.error_signatures",
			listOf(when.error_signatures, 1, 10, 200),
			"1 to 10 signatures of at most 200 characters",
		],
		["signature_hash", HEX32_RE.test(skill.signature_hash), "32 lowercase hex characters"],
		[
			"content_hash",
			HEX64_RE.test(skill.content_hash) && skill.content_hash === contentHashOf(skill),
			"sha256 of the authored content",
		],
		["stale", typeof skill.stale === "boolean", "boolean"],
		["warnings", listOf(skill.warnings, 0, 20, 200), "at most 20 single-line warnings"],
	];
	const failed = rules.find(([, ok]) => !ok);
	return failed === undefined ? undefined : { field: failed[0], detail: failed[2] };
}

function authoredTexts(skill: AutoSkill): Array<[field: string, text: string]> {
	const when = skill.applies_when;
	return [
		["name", skill.name],
		["description", skill.description],
		...when.task_types.map((text): [string, string] => ["applies_when.task_types", text]),
		...when.scope_globs.map((text): [string, string] => ["applies_when.scope_globs", text]),
		...when.error_signatures.map((text): [string, string] => [
			"applies_when.error_signatures",
			text,
		]),
		...skill.steps.map((text): [string, string] => ["steps", text]),
	];
}

function secretFieldOf(candidate: SkillCandidate): string | undefined {
	const { source, facts } = candidate;
	const fields: Array<[field: string, text: string]> = [
		["name", source.name],
		["description", source.description],
		["body", source.body],
		["rootCause", facts.rootCause ?? ""],
	];
	return fields.find(([, text]) => redactSecretShapes(text) !== text)?.[0];
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, SKILL_NAME_MAX_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

function listOf(value: readonly string[], min: number, max: number, itemMax: number): boolean {
	return (
		Array.isArray(value) &&
		value.length >= min &&
		value.length <= max &&
		value.every(
			(item) =>
				typeof item === "string" &&
				item.trim() !== "" &&
				item.length <= itemMax &&
				!LINE_BREAK_RE.test(item),
		)
	);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	const left = unique(a).sort();
	const right = unique(b).sort();
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
	return unique([...a, ...b]);
}

function cutText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}
