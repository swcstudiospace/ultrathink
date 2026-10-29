// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { randomHash } from "../../src/test.helpers.ts";

const SERVER = new URL("./server.ts", import.meta.url).pathname;

interface CheckResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs `server.ts --check-config` with exactly these variables; the flag exits before any store or socket exists. */
async function checkConfig(extra: Record<string, string> = {}): Promise<CheckResult> {
	const child = Bun.spawn([process.execPath, SERVER, "--check-config"], {
		env: {
			PATH: process.env.PATH ?? "",
			ULTRATHINK_PUBLIC_ORIGIN: "https://ultrathink.example.test",
			ULTRATHINK_OWNER_PASSWORD_HASH: randomHash(),
			ULTRATHINK_SESSION_SECRET: randomBytes(24).toString("base64url"),
			ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
			...extra,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

describe("server --check-config", () => {
	test("warns, and still passes, when server planning runs with both timeouts at 0", async () => {
		const result = await checkConfig({ ULTRATHINK_SERVER_PLANNING: "1" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("config ok");
		expect(result.stderr).toContain("ULTRATHINK_MODEL_TIMEOUT_MS");
		expect(result.stderr).toContain("ULTRATHINK_PLAN_TIMEOUT_MS");
		expect(result.stderr).toMatch(/warning/i);
	});

	test("is silent about timeouts once either one is set", async () => {
		const model = await checkConfig({
			ULTRATHINK_SERVER_PLANNING: "1",
			ULTRATHINK_MODEL_TIMEOUT_MS: "120000",
		});
		expect(model.exitCode).toBe(0);
		expect(model.stderr).not.toMatch(/warning/i);
		const plan = await checkConfig({
			ULTRATHINK_SERVER_PLANNING: "1",
			ULTRATHINK_PLAN_TIMEOUT_MS: "600000",
		});
		expect(plan.exitCode).toBe(0);
		expect(plan.stderr).not.toMatch(/warning/i);
	});

	test("has nothing to warn about when the service does not plan", async () => {
		const result = await checkConfig();
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("config ok");
		expect(result.stderr).toBe("");
	});
});

describe("server child reaper", () => {
	test("installs the exit reaper without signal handlers, after the config loads and before the store opens", () => {
		const source = readFileSync(SERVER, "utf8");
		const call = source.indexOf("installChildReaper();");
		expect(call).toBeGreaterThan(source.indexOf("const config = loadConfigOrExit();"));
		expect(call).toBeLessThan(source.indexOf("const store = openStore("));
		// The service has its own SIGTERM drain: the reaper must not exit the process on a signal.
		expect(source).not.toContain("installChildReaper({ signals: true })");
	});
});
