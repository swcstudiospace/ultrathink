import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runGraphify, setGraphifyBinForTests } from "./graph.ts";

function fixture(): { cwd: string; bin: string; log: string } {
	const root = mkdtempSync(join(tmpdir(), "graphify-l1-stamp-"));
	const binDir = join(root, "bin");
	mkdirSync(binDir);
	const log = join(root, "calls");
	const bin = join(binDir, "graphify");
	writeFileSync(bin, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\necho "n=$(wc -l < ${JSON.stringify(log)} | tr -d ' ')"\nexit 0\n`);
	chmodSync(bin, 0o755);
	const cwd = join(root, "proj");
	mkdirSync(cwd);
	return { cwd, bin, log };
}

function writeGraph(cwd: string, body: string, mtimeSeconds: number): void {
	const dir = join(cwd, "graphify-out");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "graph.json");
	writeFileSync(file, body);
	utimesSync(file, mtimeSeconds, mtimeSeconds);
}

describe("runGraphify L1 cache with keyedCache off", () => {
	test("after graph.json changes, the same query misses the cache and returns the new text", async () => {
		const { cwd, bin, log } = fixture();
		writeGraph(cwd, "v1", 1_700_000_000);
		try {
			setGraphifyBinForTests(bin);
			const before = await runGraphify(cwd, ["query", "q"]);
			expect(before.cached).toBe(false);
			expect(before.text).toContain("n=1");

			const repeat = await runGraphify(cwd, ["query", "q"]);
			expect(repeat.cached).toBe(true);
			expect(repeat.text).toBe(before.text);

			writeGraph(cwd, "version-two", 1_700_000_100);
			const after = await runGraphify(cwd, ["query", "q"]);
			expect(after.cached).toBe(false);
			expect(after.text).toContain("n=2");
			expect(after.text).not.toBe(before.text);
			expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
		} finally {
			setGraphifyBinForTests(null);
		}
	});
});
