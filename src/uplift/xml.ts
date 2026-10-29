// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { stripXmlInvalid } from "../resilience/limits.ts";
import { ROOT_TAGS } from "../types.ts";

const NAME_CHAR_RE = /[\w.-]/;
const ROOT_OPEN_RE = /^<([A-Za-z_][\w.-]*)\b([^>]*)>/;
/** Children every uplift spec must carry; `CONTEXT` is satisfied by `APP_CONTEXT`. */
const REQUIRED_CHILDREN: readonly (readonly string[])[] = [
	["SYSTEM_ROLE"],
	["CONTEXT", "APP_CONTEXT"],
	["SCOPE"],
	["CONSTRAINTS"],
	["ACCEPTANCE_CRITERIA"],
];

/** The kernel removes NUL, C0 controls but tab/LF/CR and lone surrogates; U+FFFE and U+FFFF are not XML characters either. */
function stripInvalid(value: string): string {
	return stripXmlInvalid(value).replace(/[\ufffe\uffff]/g, "");
}

export function escapeXml(value: string): string {
	return stripInvalid(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Strips one leading fence line and one trailing fence line by index scans, so hostile whitespace or backticks stay linear. */
export function stripFences(text: string): string {
	let value = text.trim();
	if (value.startsWith("```")) {
		const newline = value.indexOf("\n");
		if (newline !== -1) value = value.slice(newline + 1);
	}
	const last = value.lastIndexOf("\n");
	if (last !== -1 && value.slice(last + 1).trimEnd() === "```") value = value.slice(0, last);
	return value.trim();
}

function matchRootTag(xml: string): string | null {
	const match = xml.trim().match(/^<([A-Za-z_][\w.-]*)\b/);
	return match?.[1] ?? null;
}

export function looksLikeUpliftXml(text: string): boolean {
	return matchRootTag(stripFences(text)) !== null;
}

/** Index and name of the first `<ROOT_TAG` opener (case-insensitive, whole tag name), or undefined. */
function findRootOpen(text: string): { index: number; name: string } | undefined {
	for (let from = text.indexOf("<"); from !== -1; from = text.indexOf("<", from + 1)) {
		const head = text.slice(from + 1, from + 1 + 16);
		for (const tag of ROOT_TAGS) {
			if (head.slice(0, tag.length).toUpperCase() !== tag) continue;
			if (NAME_CHAR_RE.test(head.charAt(tag.length))) continue;
			return { index: from, name: head.slice(0, tag.length) };
		}
	}
	return undefined;
}

/** Index of the last `</name>` (case-insensitive) at or after `min`, or -1. */
function findLastClose(text: string, name: string, min: number): number {
	const wanted = `${name.toUpperCase()}>`;
	for (let at = text.lastIndexOf("</"); at >= min; at = text.lastIndexOf("</", at - 1)) {
		if (text.slice(at + 2, at + 2 + wanted.length).toUpperCase() === wanted) return at;
		if (at === 0) break;
	}
	return -1;
}

function hasElement(lowerInner: string, name: string): boolean {
	const tag = name.toLowerCase();
	const open = lowerInner.indexOf(`<${tag}`);
	if (open === -1) return false;
	return lowerInner.lastIndexOf(`</${tag}>`) > open;
}

/** Every model-written ORIGINAL block (or lone tag) is removed; the code, not the model, owns that text. */
function removeOriginal(xml: string): string {
	const tag = /<(\/?)ORIGINAL\b/gi;
	let out = "";
	let copied = 0;
	let openAt = -1;
	for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
		const end = xml.indexOf(">", match.index);
		if (end === -1) break;
		if (match[1] === "") {
			if (openAt === -1) openAt = match.index;
			continue;
		}
		const start = openAt === -1 ? match.index : openAt;
		out += xml.slice(copied, start);
		copied = end + 1;
		openAt = -1;
		tag.lastIndex = copied;
	}
	out += xml.slice(copied);
	// An opener the model never closed: drop the tag, keep what follows it.
	return out.replace(/<ORIGINAL\b[^>]*>/gi, "");
}

/** Replaces any model-written ORIGINAL with the escaped verbatim user text, inserted as the first child of the root. */
export function ensureOriginal(xml: string, original: string): string {
	const trimmed = removeOriginal(xml.trim());

	const open = trimmed.match(ROOT_OPEN_RE);
	if (!open) return trimmed;

	const tag = open[1]!;
	const inner = open[2] ?? "";
	const originalEl = `<ORIGINAL>${escapeXml(original)}</ORIGINAL>`;

	if (inner.trimEnd().endsWith("/")) {
		const attrs = inner.replace(/\/\s*$/, "");
		return `<${tag}${attrs}>${originalEl}</${tag}>`;
	}

	return `${open[0]}\n${originalEl}\n${trimmed.slice(open[0].length)}`;
}

/** Why a reply was refused: an unclosed known root (cut off), no usable known root, or a closed root short of children. */
export type UpliftCheck =
	| { ok: true; xml: string }
	| { ok: false; reason: "unclosed_root" | "no_root" }
	| { ok: false; reason: "missing_child"; missing: string[] };

/**
 * Accepts only a complete uplift: a closed root named in ROOT_TAGS carrying every required child. Everything before the
 * opener (prose, fences, declarations, thinking) and after the closer is dropped. A refusal says why.
 */
export function checkUpliftXml(raw: string, original: string): UpliftCheck {
	const stripped = stripFences(stripInvalid(raw));
	const root = findRootOpen(stripped);
	if (!root) return { ok: false, reason: "no_root" };
	const openEnd = stripped.indexOf(">", root.index);
	if (openEnd === -1) return { ok: false, reason: "unclosed_root" };
	if (stripped.charAt(openEnd - 1) === "/") return { ok: false, reason: "no_root" };
	const close = findLastClose(stripped, root.name, openEnd + 1);
	if (close === -1) return { ok: false, reason: "unclosed_root" };
	const closeEnd = stripped.indexOf(">", close) + 1;
	const lowerInner = stripped.slice(openEnd + 1, close).toLowerCase();
	const missing = REQUIRED_CHILDREN.filter(
		(alternatives) => !alternatives.some((name) => hasElement(lowerInner, name)),
	).map((alternatives) => alternatives[0]!);
	if (missing.length > 0) return { ok: false, reason: "missing_child", missing };
	return { ok: true, xml: ensureOriginal(stripped.slice(root.index, closeEnd), original) };
}

/** The accepted uplift XML, or null for any refusal (see `checkUpliftXml` for the reason). */
export function sanitizeUpliftXml(raw: string, original: string): string | null {
	const checked = checkUpliftXml(raw, original);
	return checked.ok ? checked.xml : null;
}
