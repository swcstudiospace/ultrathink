// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COOL_DOWN_BASE_MS,
	COOL_DOWN_MAX_MS,
	describeJevHealth,
	JEV_RAILS,
	type JevCall,
	type JevHealth,
	type JevRail,
	openJevHealth,
	openMemoryJevHealth,
	REWARN_MS,
	takeJevWarning,
	unavailableMessage,
} from "./health.ts";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const FILE = "decisions-health-openrouter.json";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-jev-health-"));
	dirs.push(dir);
	return dir;
}

/** rng 0.5 makes the +-20% jitter exactly 1, so cool-downs are the plain doubled values. */
function open(dir: string, rail: JevRail = "openrouter", rng: () => number = () => 0.5): JevHealth {
	return openJevHealth(dir, rail, { rng });
}

/** The ticket of a call the breaker lets through. */
function take(health: JevHealth, now: number, opts?: { force?: boolean }): JevCall {
	const verdict = health.shouldCall(now, opts);
	if (!verdict.call) throw new Error("expected the breaker to let the call through");
	return verdict;
}

describe("tolerant read", () => {
	test("a missing file is closed and every call is allowed", () => {
		const health = open(tempDir());
		expect(health.read()).toEqual({ v: 1, state: "closed", failures: 0 });
		expect(health.shouldCall(T0)).toEqual({ call: true, probe: false });
		expect(health.describe(T0)).toBeUndefined();
		expect(health.takeWarning(T0)).toBeUndefined();
	});

	test("an empty, corrupt, foreign or half-built file is closed and never throws", () => {
		const openBase = { v: 1, state: "open" };
		const bodies = [
			"",
			"{corrupt",
			"null",
			"[]",
			"42",
			JSON.stringify({ v: 2, state: "open", cause: "credits", nextProbeAt: T0 + 1e6 }),
			JSON.stringify({ v: 1, state: "paused" }),
			JSON.stringify({ ...openBase, nextProbeAt: T0 + 1e6 }),
			JSON.stringify({ ...openBase, cause: "weird", nextProbeAt: T0 + 1e6 }),
			JSON.stringify({ ...openBase, cause: "credits" }),
			JSON.stringify({ ...openBase, cause: "credits", nextProbeAt: "soon" }),
			JSON.stringify({ ...openBase, cause: "credits", nextProbeAt: 1e300 }),
		];
		for (const body of bodies) {
			const dir = tempDir();
			writeFileSync(join(dir, FILE), body);
			const health = open(dir);
			expect(health.read().state).toBe("closed");
			expect(health.shouldCall(T0)).toEqual({ call: true, probe: false });
			expect(health.describe(T0)).toBeUndefined();
		}
	});

	test("a directory where the file should be is closed", () => {
		const dir = tempDir();
		mkdirSync(join(dir, FILE));
		expect(open(dir).shouldCall(T0)).toEqual({ call: true, probe: false });
	});

	test("an unwritable state dir drops the write but still answers", () => {
		const dir = tempDir();
		const blocker = join(dir, "plain-file");
		writeFileSync(blocker, "x");
		const health = open(join(blocker, "state"));
		expect(health.recordFailure("credits", T0)).toEqual({ opened: true });
		expect(health.shouldCall(T0 + 1)).toEqual({ call: true, probe: false });
		expect(() => health.recordSuccess(T0)).not.toThrow();
		expect(health.takeWarning(T0)).toBeUndefined();
	});

	test("the retired single-file state is ignored", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, "decisions-health.json"),
			JSON.stringify({ v: 1, state: "open", cause: "credits", nextProbeAt: T0 + 1e6, failures: 1 }),
		);
		expect(open(dir).shouldCall(T0)).toEqual({ call: true, probe: false });
		expect(open(dir, "vercel").shouldCall(T0)).toEqual({ call: true, probe: false });
	});
});

describe("one breaker per rail", () => {
	test("a spent Vercel account leaves OpenRouter closed, in separate files", () => {
		const dir = tempDir();
		const vercel = open(dir, "vercel");
		const openrouter = open(dir, "openrouter");
		expect(vercel.recordFailure("credits", T0)).toEqual({ opened: true });
		expect(openrouter.shouldCall(T0 + 1)).toEqual({ call: true, probe: false });
		expect(vercel.shouldCall(T0 + 1)).toMatchObject({ call: false, cause: "credits" });
		expect(openrouter.recordFailure("auth", T0 + 2)).toEqual({ opened: true });
		expect(
			readdirSync(dir)
				.filter((name) => name.startsWith("decisions-health"))
				.sort(),
		).toEqual(["decisions-health-openrouter.json", "decisions-health-vercel.json"]);
		expect(vercel.read()).toMatchObject({ cause: "credits", failures: 1 });
		expect(openrouter.read()).toMatchObject({ cause: "auth", failures: 1 });
	});

	test("every text names the failing rail and its own fix", () => {
		const dir = tempDir();
		open(dir, "openrouter").recordFailure("credits", T0);
		open(dir, "vercel").recordFailure("auth", T0);
		expect(open(dir, "openrouter").describe(T0 + 1)).toBe(
			"Jev unavailable: OpenRouter reports insufficient credits since 2026-10-28. Decisions fall back to their defaults until you top up at https://openrouter.ai/settings/credits (next check 2026-10-28T12:05:00Z).",
		);
		expect(open(dir, "vercel").describe(T0 + 1)).toBe(
			"Jev unavailable: Vercel AI Gateway rejected the key since 2026-10-28. Fix: bin/ultrathink-mcp auth set-key vercel --stdin (next check 2026-10-28T12:05:00Z).",
		);
		const other = tempDir();
		open(other, "openrouter").recordFailure("auth", T0);
		open(other, "vercel").recordFailure("credits", T0);
		expect(open(other, "openrouter").describe(T0 + 1)).toBe(
			"Jev unavailable: OpenRouter rejected the key since 2026-10-28. Fix: bin/ultrathink-mcp auth set-key openrouter --stdin (next check 2026-10-28T12:05:00Z).",
		);
		expect(open(other, "vercel").describe(T0 + 1)).toBe(
			"Jev unavailable: Vercel AI Gateway reports insufficient credits since 2026-10-28. Decisions fall back to their defaults until you add credits in your Vercel AI Gateway dashboard (next check 2026-10-28T12:05:00Z).",
		);
		expect(unavailableMessage({ cause: "auth", nextProbeAt: T0 }, "vercel")).toBe(
			"decisions unavailable: Vercel AI Gateway rejected the key; next check 2026-10-28T12:00:00Z",
		);
	});

	test("describeJevHealth and takeJevWarning cover every rail, naming each open one once", () => {
		const dir = tempDir();
		expect(JEV_RAILS).toEqual(["openrouter", "vercel"]);
		expect(describeJevHealth(dir, T0)).toBeUndefined();
		expect(takeJevWarning(dir, T0)).toBeUndefined();
		open(dir, "vercel").recordFailure("credits", T0);
		expect(describeJevHealth(dir, T0 + 1)).toContain(
			"Vercel AI Gateway reports insufficient credits",
		);
		expect(describeJevHealth(dir, T0 + 1)).not.toContain("OpenRouter");
		expect(takeJevWarning(dir, T0 + 2)).toContain("Vercel AI Gateway");
		expect(takeJevWarning(dir, T0 + 3)).toBeUndefined();
		// OpenRouter failing later is its own entry: it warns although Vercel already did.
		open(dir, "openrouter").recordFailure("auth", T0 + 4);
		const warning = takeJevWarning(dir, T0 + 5);
		expect(warning).toContain("OpenRouter rejected the key");
		expect(warning).not.toContain("Vercel");
		expect(describeJevHealth(dir, T0 + 6)).toContain("OpenRouter rejected the key");
		expect(describeJevHealth(dir, T0 + 6)).toContain("Vercel AI Gateway");
	});
});

describe("what opens the breaker", () => {
	test("credits and auth open it at once, persisted owner-only", () => {
		for (const kind of ["credits", "auth"] as const) {
			const dir = tempDir();
			const health = open(dir);
			expect(health.recordFailure(kind, T0)).toEqual({ opened: true });
			expect(health.read()).toEqual({
				v: 1,
				state: "open",
				cause: kind,
				since: T0,
				nextProbeAt: T0 + COOL_DOWN_BASE_MS,
				coolDownMs: COOL_DOWN_BASE_MS,
				failures: 1,
			});
			expect(statSync(join(dir, FILE)).mode & 0o777).toBe(0o600);
			expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		}
	});

	test("every other kind is ignored: closed, no file, no new cause", () => {
		const dir = tempDir();
		const health = open(dir);
		for (const kind of [
			"rate-limit",
			"upstream",
			"timeout",
			"network",
			"bad-request",
			"too-large",
			"invalid-response",
			"model",
			"unavailable",
			"something-new",
		]) {
			expect(health.recordFailure(kind, T0)).toEqual({ opened: false });
		}
		expect(readdirSync(dir)).toEqual([]);
		expect(health.shouldCall(T0 + 1)).toEqual({ call: true, probe: false });
	});

	test("an ignored kind leaves an open breaker exactly as it was", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		const before = health.read();
		expect(health.recordFailure("timeout", T0 + 10)).toEqual({ opened: false });
		expect(health.read()).toEqual(before);
	});

	test("the cool-down is spread by up to 20% either way from the injected rng", () => {
		const low = open(tempDir(), "openrouter", () => 0);
		low.recordFailure("credits", T0);
		expect(low.read().nextProbeAt).toBe(T0 + 240_000);
		const high = open(tempDir(), "openrouter", () => 1);
		high.recordFailure("credits", T0);
		expect(high.read().nextProbeAt).toBe(T0 + 360_000);
		// The persisted cool-down stays the plain doubled value so doubling is deterministic.
		expect(high.read().coolDownMs).toBe(COOL_DOWN_BASE_MS);
	});
});

describe("calls while open and the probe", () => {
	test("a hand-built file with a future nextProbeAt refuses the call in a fresh process", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, FILE),
			JSON.stringify({
				v: 1,
				state: "open",
				cause: "credits",
				since: T0 - 1000,
				nextProbeAt: T0 + 60_000,
				coolDownMs: COOL_DOWN_BASE_MS,
				failures: 1,
			}),
		);
		expect(open(dir).shouldCall(T0)).toEqual({
			call: false,
			cause: "credits",
			nextProbeAt: T0 + 60_000,
		});
	});

	test("refused until the cool-down passes, then exactly one claimed probe per minute", () => {
		const dir = tempDir();
		const first = open(dir);
		const second = open(dir);
		first.recordFailure("auth", T0);
		const due = T0 + COOL_DOWN_BASE_MS;
		expect(first.shouldCall(due - 1)).toEqual({ call: false, cause: "auth", nextProbeAt: due });
		const claimed = take(first, due);
		expect(typeof claimed.claim).toBe("string");
		// A second process, a moment later, sees the claim and stays off.
		expect(second.shouldCall(due + 1)).toEqual({
			call: false,
			cause: "auth",
			nextProbeAt: due + 60_000,
		});
		expect(first.shouldCall(due + 59_999)).toMatchObject({ call: false });
		expect(second.shouldCall(due + 60_000)).toMatchObject({ call: true, probe: true });
	});

	test("only the claimed probe's success closes an open breaker, for every process, and resets the cool-down", () => {
		const dir = tempDir();
		const first = open(dir);
		const second = open(dir);
		first.recordFailure("credits", T0);
		const due = T0 + COOL_DOWN_BASE_MS;
		const probe = take(first, due);
		first.recordSuccess(due + 5, probe);
		expect(second.read()).toEqual({ v: 1, state: "closed", failures: 0, lastOkAt: due + 5 });
		expect(second.shouldCall(due + 6)).toEqual({ call: true, probe: false });
		expect(second.describe(due + 6)).toBeUndefined();
		// The next spell starts from the base cool-down again.
		second.recordFailure("credits", due + 10);
		expect(second.read().coolDownMs).toBe(COOL_DOWN_BASE_MS);
		expect(second.read().failures).toBe(1);
	});

	test("an ordinary success (a call begun before the breaker opened) never closes it, claim or no claim", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		const before = health.read();
		health.recordSuccess(T0 + 1);
		health.recordSuccess(T0 + 2, {});
		health.recordSuccess(T0 + 3, { claim: "not-the-claim" });
		expect(health.read()).toEqual({ ...before, lastOkAt: T0 + 3 });
		expect(health.shouldCall(T0 + 4)).toMatchObject({ call: false, cause: "credits" });
	});

	test("a probe whose claim was taken over cannot close the breaker; the new claim can", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		const due = T0 + COOL_DOWN_BASE_MS;
		const stale = take(health, due);
		const current = take(health, due + 60_000);
		health.recordSuccess(due + 60_001, stale);
		expect(health.read().state).toBe("open");
		health.recordSuccess(due + 60_002, current);
		expect(health.read().state).toBe("closed");
	});

	test("stragglers (calls begun before it opened) do not touch the schedule, however many fail", () => {
		const health = open(tempDir());
		expect(health.recordFailure("credits", T0)).toEqual({ opened: true });
		const opened = health.read();
		// Several decisions started together passed shouldCall before the first 402 arrived.
		for (const offset of [1, 2, 3]) {
			expect(health.recordFailure("credits", T0 + offset)).toEqual({ opened: false });
		}
		expect(health.recordFailure("auth", T0 + 4)).toEqual({ opened: false });
		expect(health.read()).toEqual({ ...opened, failures: 5 });
	});

	test("a failed claimed probe doubles the cool-down; a failed stale claim does not", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		const due = T0 + COOL_DOWN_BASE_MS;
		const stale = take(health, due);
		const current = take(health, due + 60_000);
		expect(health.recordFailure("credits", due + 60_001, stale)).toEqual({ opened: false });
		expect(health.read().coolDownMs).toBe(COOL_DOWN_BASE_MS);
		expect(health.recordFailure("credits", due + 60_002, current)).toEqual({ opened: true });
		expect(health.read()).toMatchObject({
			coolDownMs: 600_000,
			nextProbeAt: due + 60_002 + 600_000,
			since: T0,
		});
	});

	test("each failed probe doubles the cool-down up to the cap and counts consecutive failures", () => {
		const health = open(tempDir());
		let now = T0;
		health.recordFailure("credits", now);
		const coolDowns: number[] = [];
		for (let round = 0; round < 9; round++) {
			const state = health.read();
			coolDowns.push(state.coolDownMs ?? 0);
			expect(state.since).toBe(T0);
			expect(state.failures).toBe(round + 1);
			now = state.nextProbeAt ?? 0;
			const probe = take(health, now);
			expect(health.recordFailure("credits", now, probe)).toEqual({ opened: true });
			expect(health.read().nextProbeAt).toBe(now + (health.read().coolDownMs ?? 0));
		}
		expect(coolDowns).toEqual([
			COOL_DOWN_BASE_MS,
			600_000,
			1_200_000,
			2_400_000,
			4_800_000,
			9_600_000,
			19_200_000,
			COOL_DOWN_MAX_MS,
			COOL_DOWN_MAX_MS,
		]);
	});

	test("a failing probe of another cause starts a new spell at the base cool-down", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		const due = health.read().nextProbeAt ?? 0;
		const probe = take(health, due);
		health.recordFailure("auth", due, probe);
		expect(health.read()).toMatchObject({
			cause: "auth",
			since: due,
			coolDownMs: COOL_DOWN_BASE_MS,
			nextProbeAt: due + COOL_DOWN_BASE_MS,
		});
	});

	test("an inconclusive probe (429, timeout) leaves the breaker open and retries in a minute", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		const due = health.read().nextProbeAt ?? 0;
		expect(health.shouldCall(due)).toMatchObject({ call: true, probe: true });
		health.recordFailure("rate-limit", due + 5);
		expect(health.shouldCall(due + 10)).toMatchObject({ call: false, nextProbeAt: due + 60_000 });
		expect(health.shouldCall(due + 60_000)).toMatchObject({ call: true, probe: true });
	});
});

describe("an operator's forced call", () => {
	test("goes out whatever the cool-down says, without moving the schedule, and its success closes the breaker", () => {
		const dir = tempDir();
		const health = open(dir);
		health.recordFailure("credits", T0);
		const before = health.read();
		const forced = health.shouldCall(T0 + 1, { force: true });
		expect(forced).toEqual({ call: true, probe: true, forced: true });
		expect(health.read()).toEqual(before);
		health.recordSuccess(T0 + 2, take(health, T0 + 1, { force: true }));
		expect(health.read()).toEqual({ v: 1, state: "closed", failures: 0, lastOkAt: T0 + 2 });
		expect(health.shouldCall(T0 + 3)).toEqual({ call: true, probe: false });
	});

	test("its failure is recorded like a probe's: it re-schedules an open breaker and opens a closed one", () => {
		const health = open(tempDir());
		expect(health.shouldCall(T0, { force: true })).toEqual({
			call: true,
			probe: false,
			forced: true,
		});
		expect(health.recordFailure("credits", T0, { forced: true })).toEqual({ opened: true });
		expect(health.read().coolDownMs).toBe(COOL_DOWN_BASE_MS);
		expect(health.recordFailure("credits", T0 + 1, { forced: true })).toEqual({ opened: true });
		expect(health.read()).toMatchObject({
			coolDownMs: 600_000,
			nextProbeAt: T0 + 1 + 600_000,
			since: T0,
		});
	});
});

describe("visible text", () => {
	test("describe names the rail, cause, date and next check; closed is silent", () => {
		const credits = open(tempDir());
		expect(credits.describe(T0)).toBeUndefined();
		credits.recordFailure("credits", T0);
		expect(credits.describe(T0 + 1)).toBe(
			"Jev unavailable: OpenRouter reports insufficient credits since 2026-10-28. Decisions fall back to their defaults until you top up at https://openrouter.ai/settings/credits (next check 2026-10-28T12:05:00Z).",
		);
	});

	test("once the check is due the text says so instead of a past time", () => {
		const health = open(tempDir());
		health.recordFailure("auth", T0);
		expect(health.describe(T0 + COOL_DOWN_BASE_MS)).toContain("(next check: the next decision)");
	});

	test("the refusal message is one short decisions line", () => {
		const message = unavailableMessage({ cause: "credits", nextProbeAt: T0 }, "openrouter");
		expect(message).toBe(
			"decisions unavailable: OpenRouter reports insufficient credits; next check 2026-10-28T12:00:00Z",
		);
		expect(message.length).toBeLessThanOrEqual(200);
	});

	test("takeWarning speaks once per cause entry, across processes, and again after 24 hours", () => {
		const dir = tempDir();
		const first = open(dir);
		const second = open(dir);
		expect(first.takeWarning(T0)).toBeUndefined();
		first.recordFailure("credits", T0);
		expect(first.takeWarning(T0 + 10)).toBe(first.describe(T0 + 10));
		expect(first.takeWarning(T0 + 11)).toBeUndefined();
		expect(second.takeWarning(T0 + 12)).toBeUndefined();
		// A failed probe of the same cause is the same entry.
		const due = first.read().nextProbeAt ?? 0;
		first.recordFailure("credits", due, take(first, due));
		expect(second.takeWarning(due + 1)).toBeUndefined();
		expect(second.takeWarning(T0 + 10 + REWARN_MS - 1)).toBeUndefined();
		expect(second.takeWarning(T0 + 10 + REWARN_MS)).toContain("insufficient credits");
		expect(first.takeWarning(T0 + 10 + REWARN_MS + 1)).toBeUndefined();
	});

	test("a new cause or a new spell after a closing probe warns again", () => {
		const health = open(tempDir());
		health.recordFailure("credits", T0);
		expect(health.takeWarning(T0)).toContain("insufficient credits");
		const due = health.read().nextProbeAt ?? 0;
		health.recordFailure("auth", due, take(health, due));
		expect(health.takeWarning(due + 1)).toContain("rejected the key");
		expect(health.takeWarning(due + 2)).toBeUndefined();
		const next = health.read().nextProbeAt ?? 0;
		health.recordSuccess(next, take(health, next));
		health.recordFailure("auth", next + 4);
		expect(health.takeWarning(next + 5)).toContain("rejected the key");
	});
});

describe("in-memory health (no state dir)", () => {
	test("runs the same state machine: opens, refuses, probes once, doubles, warns once, closes", () => {
		const health = openMemoryJevHealth("openrouter", { rng: () => 0.5 });
		expect(health.shouldCall(T0)).toEqual({ call: true, probe: false });
		expect(health.recordFailure("credits", T0)).toEqual({ opened: true });
		expect(health.shouldCall(T0 + 1)).toMatchObject({ call: false, cause: "credits" });
		const due = T0 + COOL_DOWN_BASE_MS;
		const probe = take(health, due);
		expect(health.shouldCall(due + 1)).toEqual({
			call: false,
			cause: "credits",
			nextProbeAt: due + 60_000,
		});
		health.recordFailure("credits", due + 2, probe);
		expect(health.read().coolDownMs).toBe(600_000);
		expect(health.takeWarning(due + 3)).toContain("insufficient credits");
		expect(health.takeWarning(due + 4)).toBeUndefined();
		const next = health.read().nextProbeAt ?? 0;
		health.recordSuccess(next + 5, take(health, next));
		expect(health.read()).toEqual({ v: 1, state: "closed", failures: 0, lastOkAt: next + 5 });
	});

	test("each instance is its own breaker, names its rail, and read() hands out a copy", () => {
		const first = openMemoryJevHealth("vercel");
		const second = openMemoryJevHealth("vercel");
		first.recordFailure("auth", T0);
		expect(first.describe(T0 + 1)).toContain("Vercel AI Gateway rejected the key");
		expect(second.shouldCall(T0 + 1)).toEqual({ call: true, probe: false });
		const snapshot = first.read();
		snapshot.state = "closed";
		expect(first.read().state).toBe("open");
	});
});
