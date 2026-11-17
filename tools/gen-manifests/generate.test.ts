// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildGenerated, requireMaps, writeManifests } from "./generate.ts";

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
			"prime-agent": { description: "Prime Agent description", status: "unmapped" },
		},
	};
}

describe("buildGenerated", () => {
	test("emits exactly the verified hosts of the committed source", async () => {
		const source: unknown = parse(await readFile(SOURCE_PATH, "utf8"));
		const keys = [...buildGenerated(source).keys()];
		expect(keys).toEqual(["claude-code", "hermes", "muse", "omp"]);
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
		expect(generated.has("prime-agent")).toBe(false);
	});

	test("is deterministic: two calls yield identical content", () => {
		expect([...buildGenerated(validSource())]).toEqual([...buildGenerated(validSource())]);
	});
});

describe("requireMaps", () => {
	test("throws naming every verified host that has no map file", () => {
		expect(() => requireMaps(["claude-code", "muse", "hermes"], new Set(["claude-code"]))).toThrow(
			"verified hosts without a map file: muse, hermes",
		);
	});

	test("passes when every verified host has a map file", () => {
		expect(() => requireMaps(["claude-code"], new Set(["claude-code"]))).not.toThrow();
	});
});

describe("writeManifests", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "gen-manifests-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function seed(id: string, content: string): Promise<void> {
		await mkdir(join(root, id), { recursive: true });
		await writeFile(join(root, id, "manifest.json"), content);
	}

	async function generate(source: unknown): Promise<void> {
		await writeManifests(buildGenerated(source), root);
	}

	test("a rendering failure for one host leaves every existing manifest unchanged", async () => {
		await seed("omp", "old omp\n");
		await seed("hermes", "old hermes\n");
		const source = {
			...validSource(),
			hosts: {
				omp: { description: "Omp description", status: "verified" },
				hermes: { description: "Hermes description", status: "bogus" },
			},
		};
		await expect(generate(source)).rejects.toThrow("$.hosts.hermes.status");
		expect(await readFile(join(root, "omp", "manifest.json"), "utf8")).toBe("old omp\n");
		expect(await readFile(join(root, "hermes", "manifest.json"), "utf8")).toBe("old hermes\n");
		expect(await readdir(join(root, "omp"))).toEqual(["manifest.json"]);
		expect(await readdir(join(root, "hermes"))).toEqual(["manifest.json"]);
	});

	test("a failed write leaves existing manifests whole and removes its temp files", async () => {
		await seed("omp", "old omp\n");
		// A directory where hermes' manifest belongs makes its rename fail after staging.
		await mkdir(join(root, "hermes", "manifest.json"), { recursive: true });
		await expect(generate(validSource())).rejects.toThrow();
		expect(await readFile(join(root, "omp", "manifest.json"), "utf8")).toBe("old omp\n");
		expect(await readdir(join(root, "omp"))).toEqual(["manifest.json"]);
		expect(await readdir(join(root, "hermes"))).toEqual(["manifest.json"]);
	});

	test("a successful run writes exactly the rendered bytes and leaves no temp files", async () => {
		await seed("omp", "stale\n");
		await generate(validSource());
		const generated = buildGenerated(validSource());
		expect(await readFile(join(root, "omp", "manifest.json"), "utf8")).toBe(
			generated.get("omp") ?? "",
		);
		expect(await readFile(join(root, "hermes", "manifest.json"), "utf8")).toBe(
			generated.get("hermes") ?? "",
		);
		expect((await readdir(root)).sort()).toEqual(["hermes", "omp"]);
		expect(await readdir(join(root, "omp"))).toEqual(["manifest.json"]);
	});
});
