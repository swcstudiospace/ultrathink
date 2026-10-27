// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runDoctorCommand } from "./cli.ts";
import { checkTeach } from "./teach-check.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FIX = "bin/ultrathink teach sync";

interface RunLine {
	at: number;
	sessionId: string;
	outcome: "captured" | "skipped";
	captured: number;
	skipped?: string;
	detail?: string;
}

describe("checkTeach", () => {
	let dir: string;
	let deps: DoctorDeps;

	const teachDir = (): string => join(dir, "state", "teach");

	function writeJson(path: string, value: unknown): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	}

	function outbox(id: string, entry: Record<string, unknown>): void {
		writeJson(join(teachDir(), "outbox", `${id}.json`), { id, ...entry });
	}

	function runs(lines: RunLine[], extra = ""): void {
		mkdirSync(teachDir(), { recursive: true });
		writeFileSync(
			join(teachDir(), "observe-runs.ndjson"),
			`${lines.map((line) => JSON.stringify(line)).join("\n")}\n${extra}`,
		);
	}

	function failed(n: number, detail = "Credit balance is too low"): RunLine {
		return {
			at: NOW - n * HOUR,
			sessionId: `s${n}`,
			outcome: "skipped",
			captured: 0,
			skipped: "distiller failed",
			detail,
		};
	}

	const noSignal = (n: number): RunLine => ({
		at: NOW - n * HOUR,
		sessionId: `n${n}`,
		outcome: "skipped",
		captured: 0,
		skipped: "no signal",
	});

	const captured = (n: number): RunLine => ({
		at: NOW - n * HOUR,
		sessionId: `c${n}`,
		outcome: "captured",
		captured: 2,
	});

	const byId = (findings: Finding[], id: string): Finding => {
		const found = findings.find((finding) => finding.id === id);
		if (!found) throw new Error(`no finding ${id}`);
		return found;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-teach-"));
		mkdirSync(join(dir, "project"));
		deps = {
			env: {
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "xdg"),
				CLAUDE_CONFIG_DIR: join(dir, "claude"),
				ULTRATHINK_STATE_DIR: join(dir, "state"),
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				GH_CONFIG_DIR: join(dir, "gh"),
			},
			cwd: join(dir, "project"),
			now: () => NOW,
			which: (command) =>
				["git", "gh", "python3"].includes(command) ? `/usr/bin/${command}` : undefined,
			bunVersion: "1.2.0",
			runVersion: () => "Python 3.12.1",
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("empty state: empty outbox ok, no runs info, no moments finding, nothing created", () => {
		const findings = checkTeach(deps);
		expect(findings.map((finding) => finding.id)).toEqual(["memory.outbox", "memory.observe"]);
		expect(byId(findings, "memory.outbox")).toMatchObject({
			level: "ok",
			title: "Hindsight outbox is empty",
		});
		expect(byId(findings, "memory.observe")).toMatchObject({
			level: "info",
			title: "No teach observe runs recorded yet",
		});
		expect(findings.every((finding) => finding.section === "memory")).toBe(true);
		expect(existsSync(teachDir())).toBe(false);
	});

	test("a 3-day-old never-attempted entry warns with count, age, newest error and the fix", () => {
		outbox("a", { op: { op: "tags" }, attempts: 0, nextAt: 0, enqueuedAt: NOW - 3 * DAY });
		outbox("b", {
			op: { op: "tags" },
			attempts: 2,
			nextAt: 0,
			enqueuedAt: NOW - 2 * DAY,
			lastError: "retain failed (server): boom",
		});
		const finding = byId(checkTeach(deps), "memory.outbox");
		expect(finding.level).toBe("warn");
		expect(finding.title).toBe("2 Hindsight writes have waited over 24 h (oldest 3 days)");
		expect(finding.detail).toContain("1 of them were never attempted");
		expect(finding.detail).toContain("retain failed (server): boom");
		expect(finding.fix).toBe(FIX);
	});

	test("a fresh entry is info; malformed entries are ignored", () => {
		outbox("fresh", { attempts: 0, enqueuedAt: NOW - HOUR });
		outbox("bad", { attempts: "x", enqueuedAt: NOW - 5 * DAY });
		mkdirSync(join(teachDir(), "outbox"), { recursive: true });
		writeFileSync(join(teachDir(), "outbox", "junk.json"), "{nope");
		const finding = byId(checkTeach(deps), "memory.outbox");
		expect(finding.level).toBe("info");
		expect(finding.title).toContain("1 Hindsight write pending");
	});

	test("three failed runs give an error with the detail; two do not", () => {
		runs([failed(3), failed(2), failed(1)]);
		const finding = byId(checkTeach(deps), "memory.observe");
		expect(finding.level).toBe("error");
		expect(finding.title).toBe("Teach observe failed 3 times in a row (last 1 hour ago)");
		expect(finding.detail).toBe("Credit balance is too low");
		expect(finding.fix).toContain("bin/ultrathink doctor");

		runs([failed(2), failed(1)]);
		expect(byId(checkTeach(deps), "memory.observe").level).toBe("ok");
	});

	test("no engine skips count as failures and fall back to skipped when detail is absent", () => {
		const noEngine = (n: number): RunLine => ({
			...noSignal(n),
			skipped: "no engine: claude CLI not found",
		});
		runs([noEngine(3), noEngine(2), noEngine(1)]);
		const finding = byId(checkTeach(deps), "memory.observe");
		expect(finding.level).toBe("error");
		expect(finding.detail).toBe("no engine: claude CLI not found");
	});

	test("three unexpected-error skips give the observe error", () => {
		const errored = (n: number): RunLine => ({ ...noSignal(n), skipped: "error" });
		runs([errored(3), errored(2), errored(1)]);
		const finding = byId(checkTeach(deps), "memory.observe");
		expect(finding.level).toBe("error");
		expect(finding.detail).toBe("error");
	});

	describe("inbox", () => {
		function digest(name: string, ageMs: number): string {
			const path = join(teachDir(), "inbox", name);
			writeJson(path, { digest: true });
			const when = (NOW - ageMs) / 1000;
			utimesSync(path, when, when);
			return path;
		}

		test("no inbox directory gives no finding and creates nothing", () => {
			expect(checkTeach(deps).map((f) => f.id)).not.toContain("memory.inbox");
			expect(existsSync(join(teachDir(), "inbox"))).toBe(false);
		});

		test("a fresh file gives no finding", () => {
			digest("1800000000000-abcdef01.json", 30 * 60 * 1000);
			expect(checkTeach(deps).map((f) => f.id)).not.toContain("memory.inbox");
		});

		test("one 3-hour-old digest warns in the singular with the full path", () => {
			const path = digest("1800000000000-abcdef01.json", 3 * HOUR);
			const finding = byId(checkTeach(deps), "memory.inbox");
			expect(finding.level).toBe("warn");
			expect(finding.title).toBe("1 observe digest was never processed (oldest 3 hours)");
			expect(finding.fix).toBe(
				`Run the oldest by hand to see the error: bin/ultrathink teach observe --file ${path}`,
			);
		});

		test("two stale digests warn in the plural with the oldest age and path", () => {
			digest("1800000000001-abcdef02.json", 2 * HOUR);
			const oldest = digest("1800000000002-abcdef03.json.tmp", 30 * HOUR);
			const finding = byId(checkTeach(deps), "memory.inbox");
			expect(finding.title).toBe("2 observe digests were never processed (oldest 30 hours)");
			expect(finding.fix).toContain(`--file ${oldest}`);
		});

		test("files with foreign names are ignored and the warning keeps exit code 0", async () => {
			digest("notes.txt", 5 * HOUR);
			digest("1800000000000-ABCDEF01.json", 5 * HOUR);
			expect(checkTeach(deps).map((f) => f.id)).not.toContain("memory.inbox");
			digest("1800000000000-abcdef01.json", 3 * HOUR);
			const result = await runDoctorCommand([], deps);
			expect(result.output).toContain("never processed");
			expect(result.exitCode).toBe(0);
		});
	});

	test("failures followed by a captured run are ok", () => {
		runs([failed(4), failed(3), failed(2), captured(1)]);
		expect(byId(checkTeach(deps), "memory.observe")).toMatchObject({
			level: "ok",
			title: "Last teach observe run: captured 1 hour ago",
		});
	});

	test("normal skips such as no signal never raise the error", () => {
		runs([noSignal(4), noSignal(3), noSignal(2), noSignal(1)]);
		expect(byId(checkTeach(deps), "memory.observe").level).toBe("ok");
	});

	test("malformed NDJSON lines are ignored", () => {
		runs([failed(3), failed(2), failed(1)], "{not json\n[]\n");
		expect(byId(checkTeach(deps), "memory.observe").level).toBe("error");
	});

	test("local lessons are counted with the age of the newest by mtime", () => {
		writeJson(join(teachDir(), "moments", "a.json"), { id: "a" });
		writeJson(join(teachDir(), "moments", "b.json"), { id: "b" });
		const stamp = (NOW - 3 * DAY) / 1000;
		utimesSync(join(teachDir(), "moments", "a.json"), stamp, stamp);
		utimesSync(join(teachDir(), "moments", "b.json"), stamp, stamp);
		expect(byId(checkTeach(deps), "memory.moments")).toMatchObject({
			level: "info",
			title: "2 local lessons, newest 3 days old",
		});
	});

	test("teach disabled gives the single info finding", () => {
		writeJson(join(dir, "xdg", "ultrathink", "config.json"), { teach: { enabled: false } });
		runs([failed(3), failed(2), failed(1)]);
		const findings = checkTeach(deps);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ id: "memory.teach.off", level: "info" });
	});

	test("through runDoctorCommand three failures exit 1 and a secret in detail is masked", async () => {
		runs([failed(3), failed(2), failed(1, "rejected Bearer sk-test-not-a-real-key-4242424242")]);
		const result = await runDoctorCommand([], deps);
		expect(result.exitCode).toBe(1);
		expect(result.output).toContain("Teach observe failed 3 times in a row");
		expect(result.output).not.toContain("sk-test-not-a-real-key-4242424242");

		runs([failed(3), failed(2), failed(1)]);
		const plain = await runDoctorCommand([], deps);
		expect(plain.exitCode).toBe(1);
		expect(plain.output).toContain("Credit balance is too low");
	});
});
