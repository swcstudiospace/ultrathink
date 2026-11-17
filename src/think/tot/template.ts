// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { createHash } from "node:crypto";
import { redactSecretShapes } from "../../redact.ts";
import { clip } from "../../resilience/limits.ts";
import { defangMarkup } from "./escape.ts";
import type { PrdCodeBlock, PrdDocument, PrdLimits, PrdRequest } from "./types.ts";

/** Bump when the rendered shape changes: it is part of every checkpoint's input hash. */
export const PRD_TEMPLATE_VERSION = 2;

/** A PRD this long is a design essay, not a hand-off for one Sub Issue. */
export const DEFAULT_PRD_LIMITS: PrdLimits = { maxLines: 150, maxChars: 6000 };

/** The fixed sections, in order. */
export const PRD_SECTIONS = [
	"Objective",
	"Acceptance Criteria",
	"Affected Files/Modules",
	"Interfaces/Signatures",
	"Implementation Shape",
	"Test Skeleton",
	"Assumptions",
	"Link to the CoT Sub Issue",
	"Code Blocked PRD",
] as const;

type PrdSectionTitle = (typeof PRD_SECTIONS)[number];

const CODE_MARKERS = ["illustrative", "verified"] as const;
const LANGUAGE = /^[A-Za-z0-9_+#.-]+$/;
const TAG = /\[(?:verified|assumption)\]/;
const ILLUSTRATIVE_NOTE =
	"_Code blocks are illustrative unless tagged verified against the repository._";

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * One line of untrusted text for the template: whitespace collapsed, fences and a leading heading/quote mark neutralized,
 * and no spoofed `[verified]` / `[assumption]` tag, so model or repository text can never forge structure.
 */
function inline(text: string, max: number): string {
	const flat = text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/`{3,}/g, "'''")
		.replace(/~{3,}/g, "---")
		.replace(/\[(verified|assumption)\]/gi, "($1)")
		.replace(/^[#>]/, "\\$&");
	return clip(flat, max).text;
}

/** A code-span body: backticks would end the span. */
function span(text: string, max: number): string {
	return inline(text, max).replace(/`/g, "'");
}

function renderCode(block: PrdCodeBlock): string[] {
	const longestRun = Math.max(0, ...(block.code.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	const language = block.language.replace(/[^A-Za-z0-9_+#.-]/g, "") || "text";
	const marker = block.verified ? "verified" : "illustrative";
	return [`${fence}${language} ${marker}`, block.code.replace(/\s+$/, ""), fence];
}

export interface RenderOptions {
	/** The Sub Issue's URL once the tracker has one. */
	readonly linkUrl?: string;
}

/** The only way a `PrdDocument` becomes markdown. The result has exactly the `PRD_SECTIONS`, in order. */
export function renderPrd(
	request: PrdRequest,
	doc: PrdDocument,
	options: RenderOptions = {},
): string {
	const out: string[] = [`# PRD: ${inline(request.title, 160)}`, ""];
	const section = (title: PrdSectionTitle, body: readonly string[]): void => {
		out.push(`## ${title}`, ...body, "");
	};
	section("Objective", [inline(doc.objective, 800)]);
	section(
		"Acceptance Criteria",
		doc.acceptanceCriteria.map((item) => `- [ ] ${inline(item, 300)}`),
	);
	section(
		"Affected Files/Modules",
		doc.affectedFiles.length === 0
			? ["- _none identified_ [assumption] — no file or module was found for this step"]
			: doc.affectedFiles.map(
					(file) =>
						`- \`${span(file.path, 200)}\` [${file.tag}]${file.note ? ` — ${inline(file.note, 200)}` : ""}`,
				),
	);
	section(
		"Interfaces/Signatures",
		doc.interfaces.length === 0
			? ["_No new or changed interfaces._"]
			: doc.interfaces.map((item) => `- \`${span(item.signature, 240)}\` [${item.tag}]`),
	);
	section("Implementation Shape", [
		ILLUSTRATIVE_NOTE,
		...doc.implementation.flatMap((block) => renderCode(block)),
	]);
	section("Test Skeleton", renderCode(doc.testSkeleton));
	section(
		"Assumptions",
		doc.assumptions.length === 0
			? ["_None._"]
			: doc.assumptions.map((item) => `- ${inline(item, 300)}`),
	);
	section("Link to the CoT Sub Issue", [
		`- Sub Issue: \`${span(request.key, 80)}\` — ${inline(request.title, 160)}`,
		`- Graph: \`${span(request.graphId, 80)}\` · node \`${span(request.nodeId, 64)}\` · step ${request.step}`,
		...(options.linkUrl ? [`- URL: ${inline(options.linkUrl, 300)}`] : []),
	]);
	section("Code Blocked PRD", [
		"Blocked until a reviewer confirms the acceptance criteria above and approves this Sub Issue for implementation.",
	]);
	return `${defangMarkup(out.join("\n")).trimEnd()}\n`;
}

/** A PRD built from the Sub Issue alone, for when no model draft is usable. Passes `validatePrd`. */
export function renderFallbackPrd(source: PrdRequest, options: RenderOptions = {}): string {
	// The Sub Issue text is untrusted and unvalidated here: secret-shaped values are masked so the result passes the validator.
	const request = {
		...source,
		title: redactSecretShapes(source.title),
		thought: redactSecretShapes(source.thought),
	};
	const title = inline(request.title, 160);
	return renderPrd(
		request,
		{
			objective: request.thought.trim() === "" ? title : request.thought,
			acceptanceCriteria: [
				`The change described by "${title}" is implemented as the CoT step says.`,
				"Existing checks keep passing.",
			],
			affectedFiles: [],
			interfaces: [],
			implementation: [
				{
					language: "text",
					code: `No code was drafted for this step. Follow the CoT step:\n${clip(request.thought.replace(/\s+/g, " ").trim(), 1200).text}`,
					verified: false,
				},
			],
			testSkeleton: { language: "text", code: `Verify: ${title}`, verified: false },
			assumptions: [
				"This PRD was built from the Sub Issue text alone, without a model-written draft: files, interfaces and scope are not verified against the repository.",
			],
		},
		options,
	);
}

interface Fence {
	readonly line: number;
	readonly info: string;
	readonly section: number;
}

interface Scan {
	readonly sections: { title: string; line: number; body: string[] }[];
	readonly fences: Fence[];
	readonly problems: string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;
const TILDE_FENCE = /^ {0,3}~{3,}/;
const H2 = /^## (.+?)\s*$/;

/** One pass over the markdown: level-2 sections and fences, with headings inside fences ignored. */
function scan(markdown: string): Scan {
	const sections: Scan["sections"] = [];
	const fences: Fence[] = [];
	const problems: string[] = [];
	let open: { length: number; line: number } | undefined;
	const lines = markdown.split("\n");
	for (const [index, text] of lines.entries()) {
		const lineNo = index + 1;
		const current = sections.at(-1);
		if (open !== undefined) {
			const close = FENCE_CLOSE.exec(text);
			if (close?.[1] !== undefined && close[1].length >= open.length) open = undefined;
			current?.body.push(text);
			continue;
		}
		const opener = FENCE_OPEN.exec(text);
		if (opener?.[1] !== undefined) {
			open = { length: opener[1].length, line: lineNo };
			fences.push({ line: lineNo, info: (opener[2] ?? "").trim(), section: sections.length - 1 });
			current?.body.push(text);
			continue;
		}
		if (TILDE_FENCE.test(text)) problems.push(`line ${lineNo}: use backtick fences, not ~~~`);
		const heading = H2.exec(text);
		if (heading?.[1] !== undefined) {
			sections.push({ title: heading[1], line: lineNo, body: [] });
			continue;
		}
		current?.body.push(text);
	}
	if (open !== undefined) problems.push(`line ${open.line}: code fence is never closed`);
	return { sections, fences, problems };
}

function fenceIssues(fences: readonly Fence[]): string[] {
	const issues: string[] = [];
	for (const fence of fences) {
		const [language, marker, ...rest] = fence.info.split(/\s+/).filter(Boolean);
		if (language === undefined || !LANGUAGE.test(language)) {
			issues.push(`line ${fence.line}: code fence needs a language tag (for example \`ts\`)`);
		} else if (
			marker === undefined ||
			!(CODE_MARKERS as readonly string[]).includes(marker) ||
			rest.length > 0
		) {
			issues.push(
				`line ${fence.line}: code fence info must be "<language> illustrative" or "<language> verified"`,
			);
		}
	}
	return issues;
}

const bullets = (body: readonly string[]): string[] => body.filter((line) => line.startsWith("- "));

function sectionIssues(scanned: Scan, key: string | undefined): string[] {
	const issues: string[] = [];
	const titles = scanned.sections.map((section) => section.title);
	const expected: readonly string[] = PRD_SECTIONS;
	if (titles.length !== expected.length || titles.some((title, i) => title !== expected[i])) {
		issues.push(
			`sections must be exactly, in order: ${expected.map((title) => `"## ${title}"`).join(", ")}; found ${titles.length === 0 ? "none" : titles.map((title) => `"${title}"`).join(", ")}`,
		);
		return issues;
	}
	const [objective, criteria, affected, interfaces, , , , link, blocked] = scanned.sections;
	if (objective?.body.join("").trim() === "") issues.push("Objective is empty");
	if (bullets(criteria?.body ?? []).length === 0)
		issues.push("Acceptance Criteria needs at least one bullet");
	const affectedBullets = bullets(affected?.body ?? []);
	if (affectedBullets.length === 0) issues.push("Affected Files/Modules needs at least one bullet");
	for (const line of [...affectedBullets, ...bullets(interfaces?.body ?? [])]) {
		if (!TAG.test(line)) {
			issues.push(`bullet lacks a [verified] or [assumption] tag: ${clip(line, 80).text}`);
		}
	}
	const inSection = (section: number): number =>
		scanned.fences.filter((fence) => fence.section === section).length;
	if (inSection(4) === 0) issues.push("Implementation Shape needs at least one fenced code block");
	if (inSection(5) === 0) issues.push("Test Skeleton needs a fenced code block");
	if (key !== undefined && !(link?.body.join("\n") ?? "").includes(key)) {
		issues.push(`Link to the CoT Sub Issue must name the Sub Issue key ${key}`);
	}
	if (!(blocked?.body ?? []).some((line) => line.startsWith("Blocked until"))) {
		issues.push("Code Blocked PRD needs a 'Blocked until' line");
	}
	return issues;
}

export interface ValidateOptions {
	readonly limits?: PrdLimits;
	/** The Sub Issue key the Link section must carry. */
	readonly key?: string;
}

/**
 * Every reason `markdown` is not an acceptable PRD; empty when it is: fixed sections in order, tagged references,
 * balanced and language-tagged fences, within the length bound, and free of secret-shaped values.
 */
export function validatePrd(markdown: string, options: ValidateOptions = {}): string[] {
	const limits = options.limits ?? DEFAULT_PRD_LIMITS;
	const issues: string[] = [];
	const trimmed = markdown.trimEnd();
	const lineCount = trimmed === "" ? 0 : trimmed.split("\n").length;
	if (lineCount > limits.maxLines) {
		issues.push(`PRD has ${lineCount} lines; the limit is ${limits.maxLines}`);
	}
	if (trimmed.length > limits.maxChars) {
		issues.push(`PRD has ${trimmed.length} characters; the limit is ${limits.maxChars}`);
	}
	if (redactSecretShapes(markdown) !== markdown) {
		issues.push(
			"PRD contains a secret-shaped value (key, token, credential or private key); remove it",
		);
	}
	const scanned = scan(markdown);
	issues.push(
		...scanned.problems,
		...fenceIssues(scanned.fences),
		...sectionIssues(scanned, options.key),
	);
	return issues;
}
