// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { stripXmlInvalid } from "../../resilience/limits.ts";
import { ROOT_TAGS } from "../../types.ts";
import { escapeXml } from "../../uplift/xml.ts";

/**
 * Every tag name the spec, graph and tracking XML give a meaning to. A PRD is model output built from untrusted
 * repository text: an `</ISSUES>` or `<GRAPH_OF_THOUGHT>` inside it must never reach the injected XML as markup.
 */
export const COMMAND_SCHEMA_TAGS: readonly string[] = [
	...ROOT_TAGS,
	"SYSTEM_ROLE",
	"CONTEXT",
	"APP_CONTEXT",
	"SCOPE",
	"CONSTRAINTS",
	"ACCEPTANCE_CRITERIA",
	"GRAPH_OF_THOUGHT",
	"GOAL",
	"NODE",
	"DEPENDS_ON",
	"QUESTION",
	"RATIONALE",
	"CONCLUSION",
	"WORKFLOW",
	"WAVE",
	"ISSUES",
	"ISSUE",
	"SUBISSUE",
	"PRD",
	"PRDS",
];

const TAG_ALTERNATION = [...COMMAND_SCHEMA_TAGS].sort((a, b) => b.length - a.length).join("|");
/** `<TAG`, `</TAG` (case-insensitive, whole name): the `<` and the optional `/` are captured apart from the name. */
const SCHEMA_TAG = new RegExp(`<(/?)(${TAG_ALTERNATION})(?![\\w.-])`, "gi");
const CDATA_END = /\]\]>/g;
const HTML_COMMENT_OPEN = /<!--/g;

/** Full entity escaping for element text and attribute values: no raw `<`, `>`, `&` or `"` survives. */
export function escapeText(value: string): string {
	return escapeXml(value);
}

/**
 * Markdown-safe defanging, applied to a finished PRD: every command-schema tag opener loses its raw `<` (it becomes
 * `&lt;`, which markdown renderers show as `<`), and so does an HTML comment opener, so neither can close or open the
 * managed blocks the Linear and Notion writers own. Characters XML cannot carry are dropped.
 */
export function defangMarkup(markdown: string): string {
	return stripXmlInvalid(markdown)
		.replace(HTML_COMMENT_OPEN, "&lt;!--")
		.replace(SCHEMA_TAG, (_m, slash: string, name: string) => `&lt;${slash}${name}`);
}

/**
 * The content of one CDATA section, ready to sit between `<![CDATA[` and `]]>`. The terminator `]]>` is split across two
 * sections, and a command-schema tag opener leaves the section as an entity (`]]>&lt;<![CDATA[TAG`), so a serialized
 * document never carries the raw text `<TAG` or `</TAG` from this value, while an XML parser reads back the original text.
 */
export function escapeCdata(value: string): string {
	return stripXmlInvalid(value)
		.replace(CDATA_END, "]]]]><![CDATA[>")
		.replace(SCHEMA_TAG, (_m, slash: string, name: string) => `]]>&lt;<![CDATA[${slash}${name}`);
}

/** `value` as one complete CDATA section (empty sections the escaping may leave are valid XML). */
export function wrapCdata(value: string): string {
	return `<![CDATA[${escapeCdata(value)}]]>`;
}
