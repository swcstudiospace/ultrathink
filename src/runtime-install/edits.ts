// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Keyed edits: small reversible changes to a config file the installer does not own. A JSON edit sets one key path;
 * a block edit owns the lines between a BEGIN and an END marker comment (TOML and other `#` comment formats). Both are
 * pure text transforms. `applyEdit` returns the new text plus a record with what undoing needs; `revertEdit` undoes
 * exactly that and gives up (undefined) when the user has changed the edit since, so a revert never overwrites
 * their work.
 */
import { isRecord } from "../shared.ts";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type KeyedEdit =
	| {
			readonly kind: "json";
			/** Path relative to the config root. */
			readonly file: string;
			readonly key: readonly string[];
			readonly value: JsonValue;
	  }
	| {
			readonly kind: "block";
			readonly file: string;
			/** Kebab-case id naming the block. */
			readonly id: string;
			readonly body: string;
	  };

/** What applying an edit changed, kept in the manifest so the edit can be undone exactly. */
export type EditRecord =
	| {
			readonly kind: "json";
			readonly file: string;
			readonly key: readonly string[];
			/** The value the edit wrote. */
			readonly value: JsonValue;
			/** The value the key held before; absent when the key did not exist. */
			readonly previous?: JsonValue;
			/** How many leading key segments existed before the edit (the key length when the key itself did). */
			readonly existing: number;
	  }
	| { readonly kind: "block"; readonly file: string; readonly id: string };

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function applyEdit(
	text: string | undefined,
	edit: KeyedEdit,
): { readonly text: string; readonly record: EditRecord } {
	return edit.kind === "json" ? applyJson(text, edit) : applyBlock(text, edit);
}

/** The text with the edit undone, or undefined when the edit is gone or its value was changed since. */
export function revertEdit(text: string, record: EditRecord): string | undefined {
	return record.kind === "json" ? revertJson(text, record) : revertBlock(text, record);
}

/** True for text with nothing left in it: a created config file whose last edit was undone. */
export function isEmptyConfig(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "" || trimmed === "{}";
}

function parseObject(text: string | undefined, file: string): Record<string, unknown> {
	if (text === undefined || text.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${file} is not plain JSON (comments are not supported): ${reason}`);
	}
	if (!isRecord(parsed)) throw new Error(`${file} does not hold a JSON object`);
	assertExactNumbers(parsed, file);
	return parsed;
}

/**
 * Throws when a number would not survive JSON.parse then JSON.stringify unchanged: NaN and the infinities serialize as
 * null, and an integer past the safe range keeps only some of its digits. Decimals with more than 17 significant digits
 * are still rounded silently; catching those needs a check of the source text.
 */
function assertExactNumbers(value: unknown, file: string): void {
	if (typeof value === "number") {
		if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
			throw new Error(
				`${file}: refusing to rewrite the number ${value}, which JSON cannot round-trip exactly`,
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertExactNumbers(item, file);
	} else if (isRecord(value)) {
		for (const item of Object.values(value)) assertExactNumbers(item, file);
	}
}

function serialize(root: Record<string, unknown>, original: string | undefined): string {
	const indent = /^([ \t]+)\S/m.exec(original ?? "")?.[1];
	const space = indent === undefined ? 2 : indent.startsWith("\t") ? "\t" : indent.length;
	const newline = original === undefined || original.endsWith("\n") ? "\n" : "";
	return `${JSON.stringify(root, null, space)}${newline}`;
}

function applyJson(
	text: string | undefined,
	edit: Extract<KeyedEdit, { kind: "json" }>,
): { readonly text: string; readonly record: EditRecord } {
	const { key, file } = edit;
	const leaf = key[key.length - 1];
	if (leaf === undefined || key.includes("__proto__")) {
		throw new Error(`${file}: the JSON edit key must be a non-empty path without __proto__`);
	}
	const root = parseObject(text, file);
	assertExactNumbers(edit.value, file);
	let node = root;
	let creating = false;
	let existing = 0;
	for (const segment of key.slice(0, -1)) {
		const child = node[segment];
		if (!creating && child !== undefined) {
			if (!isRecord(child)) throw new Error(`${file}: ${key.join(".")} runs through a non-object`);
			node = child;
			existing += 1;
			continue;
		}
		creating = true;
		const created: Record<string, unknown> = {};
		node[segment] = created;
		node = created;
	}
	const had = !creating && Object.hasOwn(node, leaf);
	const previous = had ? (node[leaf] as JsonValue) : undefined;
	node[leaf] = edit.value;
	const record: EditRecord = {
		kind: "json",
		file,
		key,
		value: edit.value,
		...(had ? { previous } : {}),
		existing: had ? key.length : existing,
	};
	return { text: serialize(root, text), record };
}

function revertJson(
	text: string,
	record: Extract<EditRecord, { kind: "json" }>,
): string | undefined {
	let root: Record<string, unknown>;
	try {
		root = parseObject(text, record.file);
	} catch {
		return undefined;
	}
	const { key, existing } = record;
	const chain: Record<string, unknown>[] = [root];
	for (const segment of key.slice(0, -1)) {
		const child = chain[chain.length - 1]?.[segment];
		if (!isRecord(child)) return undefined;
		chain.push(child);
	}
	const leaf = key[key.length - 1];
	const holder = chain[chain.length - 1];
	if (leaf === undefined || holder === undefined || !Object.hasOwn(holder, leaf)) return undefined;
	if (!sameJson(holder[leaf], record.value)) return undefined;
	if (existing === key.length) {
		holder[leaf] = record.previous;
	} else {
		Reflect.deleteProperty(holder, leaf);
		for (let depth = key.length - 1; depth > existing; depth--) {
			const container = chain[depth];
			const parent = chain[depth - 1];
			const name = key[depth - 1];
			if (container === undefined || parent === undefined || name === undefined) break;
			if (Object.keys(container).length > 0) break;
			Reflect.deleteProperty(parent, name);
		}
	}
	return serialize(root, text);
}

function sameJson(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length && left.every((item, index) => sameJson(item, right[index]))
		);
	}
	if (isRecord(left) && isRecord(right)) {
		const keys = Object.keys(left);
		return (
			keys.length === Object.keys(right).length &&
			keys.every((name) => Object.hasOwn(right, name) && sameJson(left[name], right[name]))
		);
	}
	return left === right;
}

function applyBlock(
	text: string | undefined,
	edit: Extract<KeyedEdit, { kind: "block" }>,
): { readonly text: string; readonly record: EditRecord } {
	if (!ID_PATTERN.test(edit.id)) {
		throw new Error(`${edit.file}: "${edit.id}" is not a kebab-case id`);
	}
	const original = text ?? "";
	const body = edit.body.replace(/\n+$/, "");
	const block = `${beginMarker(edit.id)}\n${body}\n${endMarker(edit.id)}\n`;
	const found = locateBlock(original, edit.id, edit.file);
	const next = found
		? `${original.slice(0, found.start)}${block}${original.slice(found.end)}`
		: `${original}${original === "" || original.endsWith("\n") ? "" : "\n"}${block}`;
	return { text: next, record: { kind: "block", file: edit.file, id: edit.id } };
}

function revertBlock(
	text: string,
	record: Extract<EditRecord, { kind: "block" }>,
): string | undefined {
	let found: { readonly start: number; readonly end: number } | undefined;
	try {
		found = locateBlock(text, record.id, record.file);
	} catch {
		return undefined;
	}
	return found ? `${text.slice(0, found.start)}${text.slice(found.end)}` : undefined;
}

const beginMarker = (id: string) => `# BEGIN ultrathink-managed:${id}`;
const endMarker = (id: string) => `# END ultrathink-managed:${id}`;

/** Character range of the block, from its BEGIN line through the newline of its END line. */
function locateBlock(
	text: string,
	id: string,
	file: string,
): { readonly start: number; readonly end: number } | undefined {
	let offset = 0;
	let start: number | undefined;
	for (const line of text.split("\n")) {
		const next = offset + line.length + 1;
		const trimmed = line.trimEnd();
		if (start === undefined && trimmed === beginMarker(id)) {
			start = offset;
		} else if (start !== undefined && trimmed === endMarker(id)) {
			return { start, end: Math.min(next, text.length) };
		}
		offset = next;
	}
	if (start !== undefined) throw new Error(`${file}: block "${id}" has no END marker`);
	return undefined;
}
