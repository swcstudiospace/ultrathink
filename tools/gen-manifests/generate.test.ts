// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildGenerated } from "./generate.ts";

const SOURCE_PATH = fileURLToPath(
	new URL("../../plugin/source/plugin.source.yaml", import.meta.url),
);

function validSource(): Record<string, unknown> {
	return {
		name: "ultrathink",
		version: "1.4.0",
		license: "AGPL-3.0-or-later",
		author: { name: "SWC Studio" },
		hosts: {
			omp: { description: "Omp description", status: "verified" },
			hermes: { description: "Hermes description", status: "verified" },
			cursor: { description: "Cursor description", status: "unmapped" },
		},
	};
}

describe("buildGenerated", () => {
	test("emits exactly the verified hosts of the committed source", async () => {
		const source: unknown = parse(await readFile(SOURCE_PATH, "utf8"));
		const keys = [...buildGenerated(source).keys()];
		expect(keys).toEqual(["claude-code", "cursor", "hermes", "muse", "omp"]);
		expect(keys).not.toContain("prime-agent");
		expect(keys).not.toContain("grok-build");
	});

	test("renders sorted keys, a two-space indent, and a trailing newline", () => {
		const expected = [
			"{",
			'  "author": {',
			'    "name": "SWC Studio"',
			"  },",
			'  "description": "Omp description",',
			'  "license": "AGPL-3.0-or-later",',
			'  "name": "ultrathink",',
			'  "version": "1.4.0"',
			"}",
			"",
		].join("\n");
		expect(buildGenerated(validSource()).get("omp")).toBe(expected);
	});

	test("rejects an unknown top-level key, naming it", () => {
		expect(() => buildGenerated({ ...validSource(), codename: "x" })).toThrow(
			"$.codename: unknown key",
		);
	});

	test("rejects an unknown key inside a host entry, naming it", () => {
		const source = {
			...validSource(),
			hosts: { omp: { description: "Omp description", status: "verified", extra: true } },
		};
		expect(() => buildGenerated(source)).toThrow("$.hosts.omp.extra: unknown key");
	});

	test("produces no entry for an unmapped host", () => {
		const generated = buildGenerated(validSource());
		expect([...generated.keys()]).toEqual(["hermes", "omp"]);
		expect(generated.has("cursor")).toBe(false);
	});

	test("is deterministic: two calls yield identical content", () => {
		expect([...buildGenerated(validSource())]).toEqual([...buildGenerated(validSource())]);
	});
});
