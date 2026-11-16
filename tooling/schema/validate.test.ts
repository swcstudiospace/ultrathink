// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkGeneratedFile, checkSource, validateRepo } from "./validate.ts";

const SOURCE_PATH = fileURLToPath(
	new URL("../../plugin/source/plugin.source.yaml", import.meta.url),
);
const SCHEMA_PATH = fileURLToPath(
	new URL("../../plugin/schema/plugin-source.schema.json", import.meta.url),
);

async function loadSchema() {
	return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

describe("plugin source schema validation", () => {
	test("passes on the current source and generated manifests", async () => {
		expect(await validateRepo()).toEqual([]);
	});

	test("rejects a source missing a required top-level key", async () => {
		const original = await readFile(SOURCE_PATH, "utf8");
		const withoutLicense = original.replace(/^license:.*\n/m, "");
		expect(withoutLicense).not.toBe(original);

		const errors = checkSource(withoutLicense, await loadSchema());
		expect(errors.join("\n")).toContain('missing required key "license"');
	});

	test("rejects a host status outside the schema enum", async () => {
		const original = await readFile(SOURCE_PATH, "utf8");
		const badStatus = original.replace("status: verified", "status: maybe");
		expect(badStatus).not.toBe(original);

		const errors = checkSource(badStatus, await loadSchema());
		expect(errors.join("\n")).toContain('must be one of "verified", "unmapped"');
	});

	test("accepts a generated manifest that parses as JSON or YAML", () => {
		expect(checkGeneratedFile("claude-code/manifest.json", '{"name": "ultrathink"}')).toEqual([]);
		expect(checkGeneratedFile("muse/manifest.yaml", "name: ultrathink\n")).toEqual([]);
	});

	test("rejects a generated manifest that does not parse", () => {
		const errors = checkGeneratedFile("omp/manifest.json", "{ not json");
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("omp/manifest.json: does not parse");
	});
});
