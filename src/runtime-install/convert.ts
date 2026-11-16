// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Converts one Claude-format Ultrathink source (a skill's SKILL.md or a command's markdown) into the form a runtime
 * loads. A skill and a Markdown command are copied byte for byte; a TOML command wraps the body in `prompt` and
 * lifts the frontmatter `description`. Placeholders such as `$ARGUMENTS` are never rewritten, because only the runtime
 * itself knows its own syntax. Every output starts with an `ultrathink-managed` marker (after the frontmatter for
 * Markdown, which loaders require on the first line), naming the source and the clone it came from.
 */
import type { ArtifactForm } from "./plan.ts";

const MARKER = "ultrathink-managed";
const MARKER_LINE = /^(?:<!-- |# )ultrathink-managed /m;
/** Leading `---` block; group 1 holds its lines. */
const FRONTMATTER = /^---[ \t]*\r?\n((?:[\s\S]*?\r?\n)?)---[ \t]*(?:\r?\n|$)/;
/** Control characters TOML literal strings reject: everything below space except tab and newline, and DEL. */
const TOML_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

interface SourceText {
	readonly text: string;
	/** Source path relative to the clone, recorded in the marker. */
	readonly source: string;
	readonly cloneRoot: string;
}

/** True when `text` carries the marker line an install writes, whichever form it was converted to. */
export function isManaged(text: string): boolean {
	return MARKER_LINE.test(text);
}

export function convertArtifact(input: SourceText, form: ArtifactForm): string {
	const marker = `${MARKER} source=${quote(input.source)} root=${quote(input.cloneRoot)}`;
	const match = FRONTMATTER.exec(input.text);
	const head = match?.[0] ?? "";
	const body = input.text.slice(head.length);
	if (form === "toml") return toToml(marker, match?.[1], body);
	const frontmatter = head === "" || head.endsWith("\n") ? head : `${head}\n`;
	return `${frontmatter}<!-- ${marker} -->\n${body}`;
}

/** A JSON string whose angle brackets are escaped, so it can never close the HTML comment it sits in. */
function quote(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function toToml(marker: string, frontmatter: string | undefined, body: string): string {
	const description = frontmatter === undefined ? undefined : scalar(frontmatter, "description");
	const lines = [`# ${marker}`];
	if (description !== undefined) lines.push(`description = ${tomlString(description)}`);
	lines.push(`prompt = ${tomlMultiline(body.replace(/^(?:[ \t]*\r?\n)+/, ""))}`);
	return `${lines.join("\n")}\n`;
}

/** Single-line value of a top-level frontmatter key; block scalars and absent keys give undefined. */
function scalar(frontmatter: string, key: string): string | undefined {
	for (const line of frontmatter.split(/\r?\n/)) {
		const match = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
		if (match?.[1] !== key) continue;
		const raw = match[2] ?? "";
		if (raw === "" || /^[>|]/.test(raw)) return undefined;
		const quoteChar = raw[0];
		if ((quoteChar === '"' || quoteChar === "'") && raw.length >= 2 && raw.endsWith(quoteChar)) {
			const inner = raw.slice(1, -1);
			return quoteChar === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
		}
		return raw;
	}
	return undefined;
}

/** A TOML basic string: JSON escapes are a subset of TOML's, plus DEL. */
function tomlString(value: string): string {
	return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

/** A multi-line literal string when the text allows it (nothing to escape), else a basic one. */
function tomlMultiline(text: string): string {
	const body = text.endsWith("\n") ? text : `${text}\n`;
	if (!body.includes("'''") && !TOML_CONTROL.test(body)) return `'''\n${body}'''`;
	const escaped = body
		.replace(/[\\"]/g, "\\$&")
		.replace(
			/[\u0000-\u0008\u000b-\u001f\u007f]/g,
			(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
	return `"""\n${escaped}"""`;
}
