// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, scanPaths, scanText } from "./scan.ts";

function findingsOf(text: string) {
	return scanText(".env", text).map(({ line, pattern }) => ({ line, pattern }));
}

describe("credential scan unquoted assignments", () => {
	test("flags an unquoted secret-shaped .env assignment", () => {
		expect(findingsOf("ULTRATHINK_API_TOKEN=abc123def456\n")).toEqual([
			{ line: 1, pattern: "secret-env-assignment" },
		]);
	});

	test("does not flag a short unquoted value under the secret-env-assignment rule", () => {
		expect(findingsOf("DB_TOKEN=abc12\n")).toEqual([]);
	});

	test("does not apply the unquoted env rule to a non-.env source file", () => {
		expect(scanText("src/app.ts", "API_TOKEN=abc123def456\n")).toEqual([]);
	});

	test("does not flag a count-like name that only contains a secret word", () => {
		expect(findingsOf("MAX_TOKENS=40960000\n")).toEqual([]);
	});

	test("flags a secret word in the middle of a name", () => {
		expect(findingsOf("SECRET_KEY_BASE=abc123def456\n")).toEqual([
			{ line: 1, pattern: "secret-env-assignment" },
		]);
	});

	test("does not flag a count-suffixed name such as MAX_TOKEN_COUNT", () => {
		expect(findingsOf("MAX_TOKEN_COUNT=40960000\n")).toEqual([]);
	});

	test("flags a secret value that starts with a dollar sign", () => {
		expect(findingsOf("API_KEY=$ecretPassw0rd\n")).toEqual([
			{ line: 1, pattern: "secret-env-assignment" },
		]);
	});

	test("flags an exported unquoted private key assignment", () => {
		expect(findingsOf("export MY_PRIVATE_KEY=zq9pLx2wVb7r\n")).toEqual([
			{ line: 1, pattern: "secret-env-assignment" },
		]);
	});

	test("does not flag an empty, placeholder, or reference unquoted value", () => {
		const placeholders = [
			"API_KEY=",
			"API_KEY=  # set it in your credential store",
			"API_KEY=changeme",
			"PASSWORD=Changeme",
			"API_KEY=xxx",
			"API_KEY=xxxxxxxxxxxx",
			"API_KEY=<your-api-key>",
			"ACCESS_KEY=your-access-key",
			"SECRET=${OTHER_SECRET}",
			"SECRET=$OTHER_SECRET",
			"PRIVATE_KEY=process.env.PRIVATE_KEY",
		];
		for (const line of placeholders) {
			expect({ line, findings: findingsOf(`${line}\n`) }).toEqual({ line, findings: [] });
		}
	});

	test("does not flag an unquoted assignment of a non-secret name", () => {
		expect(findingsOf("LOG_LEVEL=debug\n")).toEqual([]);
	});

	test("keeps flagging quoted secret assignments under secret-assignment", () => {
		const quoted = `${["API", "TOKEN"].join("_")}="abcdefgh1234"\n${["const apiTo", "ken"].join("")} = "zyxwvuts9876";\n`;
		expect(findingsOf(quoted)).toEqual([
			{ line: 1, pattern: "secret-assignment" },
			{ line: 2, pattern: "secret-assignment" },
		]);
	});

	test("a long word with many keywords is scanned in linear time and still flagged", () => {
		const name = "TOKEN".repeat(20_000);
		expect(findingsOf(`${name}="abcdefgh1234"\n`)).toEqual([
			{ line: 1, pattern: "secret-assignment" },
		]);
		expect(findingsOf(`${name}=zq9pLx2wVb7r\n`)).toEqual([
			{ line: 1, pattern: "secret-env-assignment" },
		]);
	});

	test("a long word with many keywords and no assignment is not flagged", () => {
		expect(findingsOf(`${"KEY".repeat(20_000)} and more text\n`)).toEqual([]);
	});
});

describe("credential scan files and output", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "secret-scan-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("skips a file over the size bound without reading it", async () => {
		const file = path.join(dir, ".env");
		await writeFile(file, `API_TOKEN=abc123def456\n${"x".repeat(1024 * 1024)}`);
		const report = await scanPaths([file]);
		expect(report.findings).toEqual([]);
		expect(report.filesScanned).toBe(0);
		expect(report.failures).toEqual([{ file, message: "skipped: larger than 1048576 bytes" }]);
	});

	test("skips a binary file whose first 8 KiB contain a NUL byte", async () => {
		const file = path.join(dir, ".env");
		await writeFile(file, "\0API_TOKEN=abc123def456\n");
		const report = await scanPaths([file]);
		expect(report.findings).toEqual([]);
		expect(report.failures).toEqual([]);
	});

	test("prints the pattern, file and line without any part of the secret", async () => {
		const file = path.join(dir, ".env");
		await writeFile(file, "API_TOKEN=abc123def456\n");
		const lines: string[] = [];
		const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			lines.push(args.join(" "));
		});
		try {
			expect(await main([file])).toBe(1);
		} finally {
			spy.mockRestore();
		}
		expect(lines.join("\n")).toContain(`${file}:1: secret-env-assignment matched`);
		expect(lines.join("\n")).not.toContain("abc1");
	});

	test("scanText findings carry no part of the matched value", () => {
		const findings = scanText(".env", "API_TOKEN=abc123def456\n");
		expect(findings).toEqual([{ file: ".env", line: 1, pattern: "secret-env-assignment" }]);
		expect(JSON.stringify(findings)).not.toContain("abc1");
	});
});
