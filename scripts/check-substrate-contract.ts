#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * scripts/check-substrate-contract.ts — compares the pinned Agent Substrate contract in
 * `src/substrate/fixtures/substrate-schema.ts` with the sibling repo it was copied from.
 *
 * When `../agent-substrate` exists, every pinned list, field set and fact is read back from the cited file and
 * lines; any difference is reported field by field and the exit code is 1. When the directory is absent the script
 * prints a skip note naming it and exits 0, so a machine without the sibling is not blocked.
 *
 * Read-only: it never writes, never runs git and never reads the environment. Usage:
 * `bun scripts/check-substrate-contract.ts [--sibling <dir>]`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	EDGE_KINDS,
	EVENT_INPUT,
	GRAPH_REGISTER_EDGE_FIELDS,
	GRAPH_REGISTER_FIELDS,
	GRAPH_REGISTER_NODE_FIELDS,
	GRAPH_REGISTER_STEP_FIELDS,
	NODE_STATES,
	PINNED_FACTS,
	type PinnedField,
	type PinnedFields,
	type PinnedList,
	type PinnedSource,
	SURFACES,
} from "../src/substrate/fixtures/substrate-schema.ts";

export interface DriftIo {
	out: (line: string) => void;
	err: (line: string) => void;
	/** The plugin repository root; the sibling is `<root>/../agent-substrate` unless `--sibling` says otherwise. */
	root: string;
}

const USAGE = "usage: bun scripts/check-substrate-contract.ts [--sibling <dir>]";

const NAMED_LISTS: ReadonlyArray<readonly [string, PinnedList]> = [
	["SURFACES", SURFACES],
	["NODE_STATES", NODE_STATES],
	["EDGE_KINDS", EDGE_KINDS],
];

const NAMED_FIELDS: ReadonlyArray<readonly [string, PinnedFields]> = [
	["EVENT_INPUT", EVENT_INPUT],
	["GRAPH_REGISTER_FIELDS", GRAPH_REGISTER_FIELDS],
	["GRAPH_REGISTER_NODE_FIELDS", GRAPH_REGISTER_NODE_FIELDS],
	["GRAPH_REGISTER_STEP_FIELDS", GRAPH_REGISTER_STEP_FIELDS],
	["GRAPH_REGISTER_EDGE_FIELDS", GRAPH_REGISTER_EDGE_FIELDS],
];

function cite(source: PinnedSource): string {
	return `${source.file}:${source.from}-${source.to}`;
}

/** The cited lines of a sibling file, or a problem when the file or the range is missing. */
function cited(
	siblingRoot: string,
	source: PinnedSource,
): { lines: string[] } | { problem: string } {
	let text: string;
	try {
		text = readFileSync(join(siblingRoot, source.file), "utf8");
	} catch {
		return { problem: `${cite(source)}: file is unreadable` };
	}
	const all = text.split("\n");
	if (source.to > all.length)
		return { problem: `${cite(source)}: file has only ${all.length} lines` };
	return { lines: all.slice(source.from - 1, source.to) };
}

function quotedStrings(lines: readonly string[]): string[] {
	return lines.flatMap((line) => Array.from(line.matchAll(/"([^"\n]+)"/g), (m) => m[1] ?? ""));
}

function interfaceFields(lines: readonly string[]): PinnedField[] {
	const out: PinnedField[] = [];
	for (const line of lines) {
		const m = /^\t(\w+)(\?)?:/.exec(line);
		if (m?.[1]) out.push({ name: m[1], required: m[2] === undefined });
	}
	return out;
}

function zodFields(lines: readonly string[]): PinnedField[] {
	const out: PinnedField[] = [];
	for (const line of lines) {
		const m = /^\t+(\w+):\s*(?:z\b|surfaceSchema)/.exec(line);
		if (m?.[1]) out.push({ name: m[1], required: !line.includes(".optional()") });
	}
	return out;
}

function diffList(
	name: string,
	source: PinnedSource,
	pinned: readonly string[],
	found: readonly string[],
): string[] {
	const have = new Set(found);
	const want = new Set(pinned);
	const problems: string[] = [];
	for (const value of pinned)
		if (!have.has(value))
			problems.push(`${name} (${cite(source)}): pinned "${value}" is not in the sibling`);
	for (const value of found)
		if (!want.has(value))
			problems.push(`${name} (${cite(source)}): sibling has "${value}", not pinned`);
	return problems;
}

function diffFields(name: string, spec: PinnedFields, found: readonly PinnedField[]): string[] {
	const problems: string[] = [];
	const byName = new Map(found.map((f) => [f.name, f]));
	const pinnedNames = new Set(spec.fields.map((f) => f.name));
	for (const field of spec.fields) {
		const actual = byName.get(field.name);
		if (!actual)
			problems.push(
				`${name} (${cite(spec.source)}): pinned field ${field.name} is not in the sibling`,
			);
		else if (actual.required !== field.required)
			problems.push(
				`${name} (${cite(spec.source)}): field ${field.name} is ${actual.required ? "required" : "optional"} in the sibling, pinned ${field.required ? "required" : "optional"}`,
			);
	}
	for (const field of found)
		if (!pinnedNames.has(field.name))
			problems.push(`${name} (${cite(spec.source)}): sibling has field ${field.name}, not pinned`);
	return problems;
}

/** Every difference between the pinned contract and the sibling checkout at `siblingRoot`; empty means no drift. */
export function checkContract(siblingRoot: string): string[] {
	const problems: string[] = [];
	for (const [name, list] of NAMED_LISTS) {
		const read = cited(siblingRoot, list.source);
		if ("problem" in read) problems.push(`${name}: ${read.problem}`);
		else problems.push(...diffList(name, list.source, list.values, quotedStrings(read.lines)));
	}
	for (const [name, spec] of NAMED_FIELDS) {
		const read = cited(siblingRoot, spec.source);
		if ("problem" in read) {
			problems.push(`${name}: ${read.problem}`);
			continue;
		}
		const found =
			spec.extract === "interface-fields" ? interfaceFields(read.lines) : zodFields(read.lines);
		problems.push(...diffFields(name, spec, found));
	}
	for (const fact of PINNED_FACTS) {
		const read = cited(siblingRoot, fact.source);
		if ("problem" in read) problems.push(`${fact.id}: ${read.problem}`);
		else if (!read.lines.join("\n").includes(fact.evidence))
			problems.push(
				`${fact.id} (${cite(fact.source)}): rule "${fact.rule}" no longer holds; expected text ${JSON.stringify(fact.evidence)}`,
			);
	}
	return problems;
}

export function main(argv: readonly string[], io: DriftIo): number {
	let sibling = resolve(io.root, "..", "agent-substrate");
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--sibling" && argv[i + 1] !== undefined) {
			sibling = resolve(argv[i + 1] as string);
			i++;
		} else {
			io.err(USAGE);
			return 2;
		}
	}
	if (!existsSync(sibling)) {
		io.out(
			`check-substrate-contract: skipped, ${sibling} does not exist (nothing to compare against)`,
		);
		return 0;
	}
	const problems = checkContract(sibling);
	if (problems.length === 0) {
		io.out(`check-substrate-contract: the pinned contract matches ${sibling}`);
		return 0;
	}
	io.err(`check-substrate-contract: ${problems.length} difference(s) from ${sibling}:`);
	for (const problem of problems) io.err(`  ${problem}`);
	return 1;
}

if (import.meta.main) {
	process.exitCode = main(Bun.argv.slice(2), {
		out: (line) => console.log(line),
		err: (line) => console.error(line),
		root: resolve(import.meta.dir, ".."),
	});
}
