// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Generates plugin/generated/<host>/manifest.json for each host whose status is "verified" in
// plugin/source/plugin.source.yaml. Hosts with any other status write nothing.
// Run with: bun tools/gen-manifests/generate.ts

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE_PATH = join(REPO_ROOT, "plugin/source/plugin.source.yaml");
const GENERATED_DIR = join(REPO_ROOT, "plugin/generated");

const TOP_LEVEL_KEYS = ["name", "version", "license", "author", "hosts"];
const AUTHOR_KEYS = ["name"];
const HOST_IDS = ["claude-code", "muse", "cursor", "omp", "hermes", "prime-agent", "grok-build"];
const HOST_KEYS = ["description", "status"];
const HOST_STATUSES = ["verified", "unmapped"];

export interface HostEntry {
	description: string;
	status: "verified" | "unmapped";
}

export interface PluginSource {
	name: string;
	version: string;
	license: string;
	author: { name: string };
	hosts: Record<string, HostEntry>;
}

function fail(at: string, message: string): never {
	throw new Error(`${at}: ${message}`);
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(at, "must be an object");
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], at: string): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.includes(key)) fail(`${at}.${key}`, "unknown key");
	}
}

function requiredField(obj: Record<string, unknown>, key: string, at: string): unknown {
	if (!Object.hasOwn(obj, key)) fail(`${at}.${key}`, "is required");
	return obj[key];
}

function nonEmptyString(value: unknown, at: string): string {
	if (typeof value !== "string" || value.length === 0) fail(at, "must be a non-empty string");
	return value;
}

function validateHost(value: unknown, at: string): HostEntry {
	const entry = asRecord(value, at);
	rejectUnknownKeys(entry, HOST_KEYS, at);
	const description = nonEmptyString(requiredField(entry, "description", at), `${at}.description`);
	const status = requiredField(entry, "status", at);
	if (typeof status !== "string" || !HOST_STATUSES.includes(status)) {
		const allowed = HOST_STATUSES.map((s) => `"${s}"`).join(", ");
		fail(`${at}.status`, `must be one of ${allowed}`);
	}
	return { description, status: status as HostEntry["status"] };
}

function validateSource(source: unknown): PluginSource {
	const root = asRecord(source, "$");
	rejectUnknownKeys(root, TOP_LEVEL_KEYS, "$");
	const name = nonEmptyString(requiredField(root, "name", "$"), "$.name");
	const version = nonEmptyString(requiredField(root, "version", "$"), "$.version");
	const license = nonEmptyString(requiredField(root, "license", "$"), "$.license");

	const author = asRecord(requiredField(root, "author", "$"), "$.author");
	rejectUnknownKeys(author, AUTHOR_KEYS, "$.author");
	const authorName = nonEmptyString(requiredField(author, "name", "$.author"), "$.author.name");

	const hostsRecord = asRecord(requiredField(root, "hosts", "$"), "$.hosts");
	const hosts: Record<string, HostEntry> = {};
	for (const id of Object.keys(hostsRecord)) {
		const at = `$.hosts.${id}`;
		if (!HOST_IDS.includes(id)) fail(at, "unknown key");
		hosts[id] = validateHost(hostsRecord[id], at);
	}

	return { name, version, license, author: { name: authorName }, hosts };
}

function renderManifest(source: PluginSource, host: HostEntry): string {
	// Keys are written in sorted order so the output is stable.
	const manifest = {
		author: source.author,
		description: host.description,
		license: source.license,
		name: source.name,
		version: source.version,
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Validates the source, then returns host id -> manifest content for verified hosts only.
export function buildGenerated(source: unknown): Map<string, string> {
	const validated = validateSource(source);
	const generated = new Map<string, string>();
	for (const id of Object.keys(validated.hosts).sort()) {
		const host = validated.hosts[id];
		if (host.status === "verified") generated.set(id, renderManifest(validated, host));
	}
	return generated;
}

export async function main(): Promise<void> {
	const source = validateSource(parse(await readFile(SOURCE_PATH, "utf8")));
	const generated = buildGenerated(source);
	for (const [id, content] of generated) {
		const dir = join(GENERATED_DIR, id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "manifest.json"), content);
	}
	for (const [id, host] of Object.entries(source.hosts).sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (host.status !== "verified") console.log(`skipped ${id}: no verified mapping`);
	}
}

if (import.meta.main) {
	await main();
}
