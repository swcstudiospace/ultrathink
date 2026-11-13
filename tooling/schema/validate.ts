// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Schema gate for the plugin source and the generated host manifests.
 *
 * - plugin/source/plugin.source.yaml must validate against plugin/schema/plugin-source.schema.json.
 * - every file under plugin/generated/ must parse as JSON (.json) or YAML (.yaml, .yml).
 *
 * No JSON Schema library is installed (no ajv in node_modules), so this file implements the keyword subset the schema
 * uses: type, required, properties, additionalProperties (false), enum, minLength, and local $ref into $defs. A schema
 * keyword outside that subset is reported as an error instead of being silently ignored.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_PATH = join(REPO_ROOT, "plugin/source/plugin.source.yaml");
const SCHEMA_PATH = join(REPO_ROOT, "plugin/schema/plugin-source.schema.json");
const GENERATED_DIR = join(REPO_ROOT, "plugin/generated");

const SUPPORTED_KEYWORDS: Readonly<Record<string, true>> = {
	$schema: true,
	$id: true,
	title: true,
	description: true,
	type: true,
	required: true,
	properties: true,
	additionalProperties: true,
	enum: true,
	minLength: true,
	$ref: true,
	$defs: true,
};

interface SchemaNode {
	readonly type?: "object" | "string";
	readonly required?: readonly string[];
	readonly properties?: Readonly<Record<string, SchemaNode>>;
	readonly additionalProperties?: boolean;
	readonly enum?: readonly unknown[];
	readonly minLength?: number;
	readonly $ref?: string;
	readonly $defs?: Readonly<Record<string, SchemaNode>>;
	readonly [keyword: string]: unknown;
}

function resolveRef(ref: string, root: SchemaNode): SchemaNode {
	const prefix = "#/$defs/";
	if (!ref.startsWith(prefix)) {
		throw new Error(`unsupported $ref "${ref}"`);
	}
	const target = root.$defs?.[ref.slice(prefix.length)];
	if (target === undefined) {
		throw new Error(`unresolved $ref "${ref}"`);
	}
	return target;
}

function validateNode(value: unknown, node: SchemaNode, root: SchemaNode, where: string): string[] {
	for (const keyword of Object.keys(node)) {
		if (!Object.hasOwn(SUPPORTED_KEYWORDS, keyword)) {
			return [`${where}: unsupported schema keyword "${keyword}"`];
		}
	}
	if (node.$ref !== undefined) {
		return validateNode(value, resolveRef(node.$ref, root), root, where);
	}

	if (node.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return [`${where}: expected object`];
		}
		const record = value as Record<string, unknown>;
		const errors: string[] = [];
		for (const key of node.required ?? []) {
			if (!Object.hasOwn(record, key)) {
				errors.push(`${where}: missing required key "${key}"`);
			}
		}
		const properties = node.properties ?? {};
		for (const [key, child] of Object.entries(record)) {
			if (Object.hasOwn(properties, key)) {
				const childSchema = properties[key];
				if (childSchema !== undefined) {
					errors.push(...validateNode(child, childSchema, root, `${where}.${key}`));
				}
			} else if (node.additionalProperties === false) {
				errors.push(`${where}: unexpected key "${key}"`);
			}
		}
		return errors;
	}

	if (node.type === "string") {
		if (typeof value !== "string") {
			return [`${where}: expected string`];
		}
		if (node.minLength !== undefined && value.length < node.minLength) {
			return [`${where}: shorter than minLength ${node.minLength}`];
		}
	}

	if (node.enum !== undefined && !node.enum.includes(value)) {
		const allowed = node.enum.map((v) => JSON.stringify(v)).join(", ");
		return [`${where}: must be one of ${allowed}`];
	}
	return [];
}

/** Validates plugin source YAML text against a parsed schema. Returns error messages; empty means valid. */
export function checkSource(sourceText: string, schema: SchemaNode): string[] {
	let parsed: unknown;
	try {
		parsed = parse(sourceText);
	} catch (err) {
		return [`not valid YAML: ${err instanceof Error ? err.message : String(err)}`];
	}
	return validateNode(parsed, schema, schema, "$");
}

/** Checks that one generated manifest parses as JSON or YAML according to its extension. */
export function checkGeneratedFile(fileName: string, text: string): string[] {
	try {
		if (/\.json$/i.test(fileName)) {
			JSON.parse(text);
		} else if (/\.ya?ml$/i.test(fileName)) {
			parse(text);
		} else {
			return [`${fileName}: unsupported extension (expected .json, .yaml or .yml)`];
		}
		return [];
	} catch (err) {
		return [`${fileName}: does not parse: ${err instanceof Error ? err.message : String(err)}`];
	}
}

async function listFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(full)));
		} else if (entry.isFile()) {
			files.push(full);
		}
	}
	return files.sort();
}

/** Runs every check against the repository. Returns error messages; empty means the tree is valid. */
export async function validateRepo(): Promise<string[]> {
	const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8")) as SchemaNode;
	const sourceName = relative(REPO_ROOT, SOURCE_PATH);
	const errors = checkSource(await readFile(SOURCE_PATH, "utf8"), schema).map(
		(message) => `${sourceName}: ${message}`,
	);

	const manifests = await listFiles(GENERATED_DIR);
	if (manifests.length === 0) {
		errors.push(`${relative(REPO_ROOT, GENERATED_DIR)}: no generated manifests found`);
	}
	for (const file of manifests) {
		const name = relative(REPO_ROOT, file);
		errors.push(...checkGeneratedFile(name, await readFile(file, "utf8")));
	}
	return errors;
}

if (import.meta.main) {
	const errors = await validateRepo();
	if (errors.length > 0) {
		for (const error of errors) {
			console.error(`schema: ${error}`);
		}
		process.exit(1);
	}
	console.log("schema: plugin source and generated manifests are valid");
}
