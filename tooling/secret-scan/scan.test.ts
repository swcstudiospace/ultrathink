// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { scanText } from "./scan.ts";

function findingsOf(text: string) {
	return scanText(".env", text).map(({ line, pattern, preview }) => ({ line, pattern, preview }));
}

describe("credential scan unquoted assignments", () => {
	test("flags an unquoted secret-shaped .env assignment", () => {
		expect(findingsOf("ULTRATHINK_API_TOKEN=abc123def456\n")).toEqual([
			{ line: 1, pattern: "secret-env-assignment", preview: "abc1****" },
		]);
	});

	test("does not flag a short unquoted value under the secret-env-assignment rule", () => {
		expect(findingsOf("DB_TOKEN=abc12\n")).toEqual([]);
	});

	test("flags an exported unquoted private key assignment", () => {
		expect(findingsOf("export MY_PRIVATE_KEY=zq9pLx2wVb7r\n")).toEqual([
			{ line: 1, pattern: "secret-env-assignment", preview: "zq9p****" },
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
			{ line: 1, pattern: "secret-assignment", preview: "abcd****" },
			{ line: 2, pattern: "secret-assignment", preview: "zyxw****" },
		]);
	});
});
