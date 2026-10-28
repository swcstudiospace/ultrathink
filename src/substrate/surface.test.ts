// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOSTS } from "../host/types.ts";
import {
	SUBSTRATE_SURFACES,
	hostToEventSurface,
	hostToSurface,
	isSurfaceName,
	resolveSubstrateToken,
} from "./surface.ts";

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";

/** A read seam backed by a map; records every path it is asked for. */
function fakeRead(files: Record<string, string | null>): {
	read: (path: string) => string | null;
	asked: string[];
} {
	const asked: string[] = [];
	return {
		asked,
		read: (path) => {
			asked.push(path);
			return files[path] ?? null;
		},
	};
}

describe("resolveSubstrateToken precedence", () => {
	test("SUBSTRATE_TOKEN beats the token file and the per-surface file, and no file is read", () => {
		const { read, asked } = fakeRead({ "/f": "from-file", "/d/omp": "from-dir" });
		const token = resolveSubstrateToken(
			{
				SUBSTRATE_TOKEN: "  from-env  ",
				SUBSTRATE_TOKEN_FILE: "/f",
				SUBSTRATE_TOKENS_DIR: "/d",
			},
			"omp",
			read,
		);
		expect(token).toBe("from-env");
		expect(asked).toEqual([]);
	});

	test("a blank SUBSTRATE_TOKEN does not win; the token file does", () => {
		const { read, asked } = fakeRead({ "/f": "from-file", "/d/omp": "from-dir" });
		const token = resolveSubstrateToken(
			{ SUBSTRATE_TOKEN: "   ", SUBSTRATE_TOKEN_FILE: " /f ", SUBSTRATE_TOKENS_DIR: "/d" },
			"omp",
			read,
		);
		expect(token).toBe("from-file");
		expect(asked).toEqual(["/f"]);
	});

	test("an unreadable token file falls through to the per-surface file in SUBSTRATE_TOKENS_DIR", () => {
		const { read, asked } = fakeRead({ "/f": null, "/d/omp": "from-dir" });
		const token = resolveSubstrateToken(
			{ SUBSTRATE_TOKEN_FILE: "/f", SUBSTRATE_TOKENS_DIR: " /d " },
			"omp",
			read,
		);
		expect(token).toBe("from-dir");
		expect(asked).toEqual(["/f", "/d/omp"]);
	});

	test("with nothing set the per-surface file is read from /etc/substrate/tokens", () => {
		const { read, asked } = fakeRead({ "/etc/substrate/tokens/claude-code": "from-default" });
		expect(resolveSubstrateToken({}, "claude-code", read)).toBe("from-default");
		expect(asked).toEqual(["/etc/substrate/tokens/claude-code"]);
		// A blank SUBSTRATE_TOKENS_DIR is the same as none.
		const blank = fakeRead({});
		expect(resolveSubstrateToken({ SUBSTRATE_TOKENS_DIR: "  " }, "omp", blank.read)).toBeNull();
		expect(blank.asked).toEqual(["/etc/substrate/tokens/omp"]);
	});

	test("each surface reads its own file", () => {
		const { read } = fakeRead({ "/d/omp": "omp-token", "/d/pi": "pi-token" });
		const env = { SUBSTRATE_TOKENS_DIR: "/d" };
		expect(resolveSubstrateToken(env, "omp", read)).toBe("omp-token");
		expect(resolveSubstrateToken(env, "pi", read)).toBe("pi-token");
		expect(resolveSubstrateToken(env, "cursor", read)).toBeNull();
	});

	test("an invalid surface returns null without a path join or any file read", () => {
		const { read, asked } = fakeRead({ "/d/../etc/passwd": "x", "/d/OMP": "x", "/d/": "x" });
		const env = { SUBSTRATE_TOKENS_DIR: "/d" };
		for (const surface of ["../etc/passwd", "OMP", "", "-omp", "a/b", "a".repeat(65)]) {
			expect(resolveSubstrateToken(env, surface, read)).toBeNull();
		}
		expect(asked).toEqual([]);
	});
});

describe("resolveSubstrateToken default file read", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ut-surface-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("reads the trimmed first line of the per-surface file", () => {
		writeFileSync(join(root, "omp"), `  ${CANARY}  \nsecond line\n`);
		expect(resolveSubstrateToken({ SUBSTRATE_TOKENS_DIR: root }, "omp")).toBe(CANARY);
	});

	test("a missing, empty, directory or oversize file is null and never throws", () => {
		writeFileSync(join(root, "empty"), "");
		mkdirSync(join(root, "isdir"));
		writeFileSync(join(root, "big"), `${CANARY}${"x".repeat(5000)}`);
		const env = { SUBSTRATE_TOKENS_DIR: root };
		expect(resolveSubstrateToken(env, "absent")).toBeNull();
		expect(resolveSubstrateToken(env, "empty")).toBeNull();
		expect(resolveSubstrateToken(env, "isdir")).toBeNull();
		// An oversize file is not a token file: its content must not leak through the result.
		expect(resolveSubstrateToken(env, "big")).toBeNull();
	});

	test("SUBSTRATE_TOKEN_FILE is read from the named path and wins over the per-surface file", () => {
		const named = join(root, "named-token");
		writeFileSync(named, `${CANARY}\n`);
		writeFileSync(join(root, "omp"), "per-surface\n");
		expect(
			resolveSubstrateToken({ SUBSTRATE_TOKEN_FILE: named, SUBSTRATE_TOKENS_DIR: root }, "omp"),
		).toBe(CANARY);
	});
});

describe("hostToSurface", () => {
	test("every plugin host maps to a Substrate surface", () => {
		for (const host of HOSTS) {
			expect(SUBSTRATE_SURFACES as readonly string[]).toContain(hostToSurface(host));
			expect(isSurfaceName(hostToSurface(host))).toBe(true);
		}
	});

	test("a host that is already a surface maps to itself", () => {
		for (const host of HOSTS.filter((h) => h !== "prime-agent")) {
			expect(hostToSurface(host)).toBe(host);
		}
		expect(hostToSurface("grok-bot")).toBe("grok-bot");
		expect(hostToSurface("swarm-a05-be")).toBe("swarm-a05-be");
	});

	test("prime-agent is not a Substrate surface and maps to pi", () => {
		expect(hostToSurface("prime-agent")).toBe("pi");
	});

	test("an absent or unknown host keeps the claude-code default", () => {
		expect(hostToSurface(undefined)).toBe("claude-code");
		expect(hostToSurface("")).toBe("claude-code");
		expect(hostToSurface("gpt-dot")).toBe("claude-code");
		expect(hostToSurface("Omp")).toBe("claude-code");
	});
});

describe("hostToEventSurface (D-06: /events accepts a missing surface)", () => {
	test("prime-agent sends no surface; the caller carries payload.host", () => {
		expect(hostToEventSurface("prime-agent")).toBeUndefined();
	});

	test("every other host sends the same surface the brief uses", () => {
		for (const host of [...HOSTS.filter((h) => h !== "prime-agent"), undefined, "unknown"]) {
			expect(hostToEventSurface(host)).toBe(hostToSurface(host));
		}
	});
});
