// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrdValidationError } from "./generator.ts";
import { checkpointPath, inputHash, MANIFEST_FILE, runTot } from "./runner.ts";
import { sha256Hex } from "./template.ts";
import type { GeneratedPrd, PrdRequest, TotProgress } from "./types.ts";

const made: string[] = [];

afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
	const dir = mkdtempSync(join(homedir(), "ut-tot-run-"));
	made.push(dir);
	return dir;
}

function makeRequests(count: number): PrdRequest[] {
	return Array.from({ length: count }, (_, i) => ({
		key: `n${i + 1}.1`,
		graphId: "ut-g1",
		nodeId: `n${i + 1}`,
		step: 1,
		title: `Step ${i + 1}`,
		thought: `Do thing ${i + 1}`,
	}));
}

const prd = (request: PrdRequest): GeneratedPrd => ({
	markdown: `# PRD ${request.key}\n`,
	model: "m-1",
	fallback: false,
	attempts: 1,
});

/** Backoff that costs nothing and records what it was asked to wait. */
function seams(): { sleep: (ms: number) => Promise<void>; random: () => number; waits: number[] } {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms) => {
			waits.push(ms);
		},
		random: () => 0.5,
	};
}

function statusError(message: string, status: number): Error {
	return Object.assign(new Error(message), { status });
}

/** Lets every worker that is ready start before any of them finishes: one macrotask, not a wall-clock wait. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("runTot: 50 items, failure at item 37, resume", () => {
	test("a failing item is recorded, the rest finish, and a rerun redoes only that item", async () => {
		const dir = makeDir();
		const requests = makeRequests(50);
		const pace = seams();
		const first = await runTot({
			requests,
			checkpointDir: dir,
			concurrency: 4,
			seams: pace,
			generate: async (request) => {
				if (request.key === "n37.1") throw new Error("provider exploded");
				return prd(request);
			},
		});
		expect(first).toMatchObject({ total: 50, generated: 49, failed: 1, fallbacks: 0 });
		const failed = first.records.find((record) => record.status === "failed");
		expect(failed?.key).toBe("n37.1");
		expect(failed?.error).toContain("provider exploded");
		expect(failed?.attempts).toBe(3);
		expect(pace.waits).toHaveLength(2);
		for (let i = 1; i <= 36; i++) expect(existsSync(checkpointPath(dir, `n${i}.1`))).toBe(true);
		expect(existsSync(checkpointPath(dir, "n37.1"))).toBe(false);
		expect(first.records.map((record) => record.key)).toEqual(requests.map((r) => r.key));

		const calls: string[] = [];
		const events: TotProgress[] = [];
		const second = await runTot({
			requests,
			checkpointDir: dir,
			concurrency: 4,
			seams: pace,
			onProgress: (event) => events.push(event),
			generate: async (request) => {
				calls.push(request.key);
				return prd(request);
			},
		});
		expect(calls).toEqual(["n37.1"]);
		expect(second).toMatchObject({ total: 50, generated: 50, failed: 0 });
		for (let i = 0; i < 36; i++) {
			expect(second.records[i]?.markdown).toBe(first.records[i]?.markdown);
		}
		expect(events.filter((event) => event.kind === "resumed")).toHaveLength(49);
		expect(
			events.find((event) => event.key === "n37.1" && event.kind === "generated"),
		).toBeDefined();
		expect(Math.max(...events.map((event) => event.done))).toBe(50);
	});

	test("an abort at item 37 keeps 1-36, skips the rest, and the rerun finishes them", async () => {
		const dir = makeDir();
		const requests = makeRequests(50);
		const controller = new AbortController();
		const first = await runTot({
			requests,
			checkpointDir: dir,
			concurrency: 1,
			signal: controller.signal,
			generate: async (request) => {
				if (request.key === "n37.1") {
					controller.abort();
					throw Object.assign(new Error("aborted"), { name: "AbortError" });
				}
				return prd(request);
			},
		});
		expect(first).toMatchObject({ total: 50, generated: 36, failed: 0 });
		expect(first.records.filter((record) => record.status === "skipped")).toHaveLength(14);
		expect(first.records.slice(0, 36).every((record) => record.status === "generated")).toBe(true);
		for (let i = 1; i <= 36; i++) expect(existsSync(checkpointPath(dir, `n${i}.1`))).toBe(true);

		const calls: string[] = [];
		const second = await runTot({
			requests,
			checkpointDir: dir,
			concurrency: 1,
			generate: async (request) => {
				calls.push(request.key);
				return prd(request);
			},
		});
		expect(calls).toEqual(requests.slice(36).map((request) => request.key));
		expect(second).toMatchObject({ total: 50, generated: 50, failed: 0 });
	});
});

describe("runTot: checkpoints", () => {
	test("reruns an item whose input changed, whose file is damaged, or whose markdown was altered", async () => {
		const dir = makeDir();
		const requests = makeRequests(6);
		await runTot({ requests, checkpointDir: dir, generate: async (request) => prd(request) });

		const changed = requests.map((request, i) =>
			i === 0 ? { ...request, thought: "changed" } : request,
		);
		writeFileSync(checkpointPath(dir, "n2.1"), "{ not json");
		const tampered = JSON.parse(readFileSync(checkpointPath(dir, "n3.1"), "utf8"));
		tampered.record.markdown = "# edited by hand\n";
		writeFileSync(checkpointPath(dir, "n3.1"), JSON.stringify(tampered));
		const wrongKey = JSON.parse(readFileSync(checkpointPath(dir, "n4.1"), "utf8"));
		wrongKey.record.key = "n99.1";
		writeFileSync(checkpointPath(dir, "n4.1"), JSON.stringify(wrongKey));

		const calls: string[] = [];
		const manifest = await runTot({
			requests: changed,
			checkpointDir: dir,
			generate: async (request) => {
				calls.push(request.key);
				return prd(request);
			},
		});
		expect(calls.sort()).toEqual(["n1.1", "n2.1", "n3.1", "n4.1"]);
		expect(manifest.generated).toBe(6);
	});

	test("the input hash covers the request and the caller's salt", () => {
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		expect(inputHash(request)).toBe(inputHash({ ...request }));
		expect(inputHash(request)).not.toBe(inputHash({ ...request, title: "other" }));
		expect(inputHash(request)).not.toBe(inputHash({ ...request, thought: "other" }));
		expect(inputHash(request, "model-a")).not.toBe(inputHash(request, "model-b"));
	});

	test("a changed salt regenerates everything", async () => {
		const dir = makeDir();
		const requests = makeRequests(3);
		await runTot({ requests, checkpointDir: dir, inputSalt: "a", generate: async (r) => prd(r) });
		let calls = 0;
		await runTot({
			requests,
			checkpointDir: dir,
			inputSalt: "b",
			generate: async (r) => {
				calls++;
				return prd(r);
			},
		});
		expect(calls).toBe(3);
	});

	test("checkpoint paths are unique per key and safe", () => {
		const dir = makeDir();
		const one = checkpointPath(dir, "a/b");
		const two = checkpointPath(dir, "a_b");
		expect(one).not.toBe(two);
		expect(checkpointPath(dir, "../../etc/passwd").startsWith(`${dir}/`)).toBe(true);
		expect(checkpointPath(dir, "../../etc/passwd").slice(dir.length + 1)).not.toContain("/");
	});

	test("writes the manifest next to the checkpoints", async () => {
		const dir = makeDir();
		const requests = makeRequests(3);
		const manifest = await runTot({
			requests,
			checkpointDir: dir,
			generate: async (request) => ({ ...prd(request), fallback: request.key === "n2.1" }),
		});
		expect(manifest.fallbacks).toBe(1);
		const saved = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8"));
		expect(saved).toEqual(JSON.parse(JSON.stringify(manifest)));
		const record = manifest.records[0];
		expect(record?.hash).toBe(sha256Hex(record?.markdown ?? ""));
	});

	test("a checkpoint that cannot be written fails the item instead of claiming it is saved", async () => {
		const dir = makeDir();
		const blocker = join(dir, "not-a-directory");
		writeFileSync(blocker, "file");
		const manifest = await runTot({
			requests: makeRequests(2),
			checkpointDir: blocker,
			generate: async (request) => prd(request),
		});
		expect(manifest).toMatchObject({ total: 2, generated: 0, failed: 2 });
		expect(manifest.records[0]?.error).toContain("checkpoint write failed");
		expect(manifest.records[0]?.markdown).toBe("");
	});
});

describe("runTot: pool and retries", () => {
	test("never runs more than `concurrency` items at once", async () => {
		const dir = makeDir();
		let running = 0;
		let peak = 0;
		await runTot({
			requests: makeRequests(12),
			checkpointDir: dir,
			concurrency: 3,
			generate: async (request) => {
				running++;
				peak = Math.max(peak, running);
				await tick();
				running--;
				return prd(request);
			},
		});
		expect(peak).toBe(3);
	});

	test("defaults to 4 workers and caps absurd values", async () => {
		for (const [concurrency, expected] of [
			[undefined, 4],
			[1000, 16],
			[0, 1],
		] as const) {
			const dir = makeDir();
			let running = 0;
			let peak = 0;
			await runTot({
				requests: makeRequests(40),
				checkpointDir: dir,
				concurrency,
				generate: async (request) => {
					running++;
					peak = Math.max(peak, running);
					await tick();
					running--;
					return prd(request);
				},
			});
			expect(peak).toBe(expected);
		}
	});

	test("retries a transient failure with backoff and counts the attempts", async () => {
		const dir = makeDir();
		const pace = seams();
		let calls = 0;
		const events: TotProgress[] = [];
		const manifest = await runTot({
			requests: makeRequests(1),
			checkpointDir: dir,
			seams: pace,
			onProgress: (event) => events.push(event),
			generate: async (request) => {
				calls++;
				if (calls === 1) throw statusError("overloaded", 529);
				return { ...prd(request), attempts: 2 };
			},
		});
		expect(calls).toBe(2);
		expect(pace.waits).toEqual([250]);
		expect(manifest.records[0]).toMatchObject({ status: "generated", attempts: 3 });
		expect(events.map((event) => event.kind)).toEqual(["started", "retry", "generated"]);
	});

	test("does not retry a permanent failure or a validation failure", async () => {
		const dir = makeDir();
		const calls: string[] = [];
		const manifest = await runTot({
			requests: makeRequests(2),
			checkpointDir: dir,
			concurrency: 1,
			seams: seams(),
			generate: async (request) => {
				calls.push(request.key);
				if (request.key === "n1.1") throw statusError("forbidden", 403);
				throw new PrdValidationError("PRD n2.1 failed validation", ["bad"], 3);
			},
		});
		expect(calls).toEqual(["n1.1", "n2.1"]);
		expect(manifest).toMatchObject({ generated: 0, failed: 2 });
		expect(manifest.records.map((record) => record.attempts)).toEqual([1, 1]);
	});

	test("redacts secrets from a recorded error", async () => {
		const dir = makeDir();
		const manifest = await runTot({
			requests: makeRequests(1),
			checkpointDir: dir,
			seams: seams(),
			retry: { maxAttempts: 1, baseMs: 1, capMs: 1 },
			generate: async () => {
				throw new Error("401 for key sk-ant-abcdefghijklmnop12345");
			},
		});
		expect(manifest.records[0]?.error).not.toContain("sk-ant-abcdefghijklmnop12345");
	});

	test("a throwing progress listener does not fail the run", async () => {
		const dir = makeDir();
		const manifest = await runTot({
			requests: makeRequests(3),
			checkpointDir: dir,
			onProgress: () => {
				throw new Error("listener bug");
			},
			generate: async (request) => prd(request),
		});
		expect(manifest.generated).toBe(3);
	});

	test("an empty request list settles at once", async () => {
		const dir = makeDir();
		const manifest = await runTot({
			requests: [],
			checkpointDir: dir,
			generate: async () => {
				throw new Error("unreachable");
			},
		});
		expect(manifest).toEqual({ total: 0, generated: 0, failed: 0, fallbacks: 0, records: [] });
	});

	test("rejects duplicate keys and a relative checkpoint directory", async () => {
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		await expect(
			runTot({
				requests: [request, request],
				checkpointDir: makeDir(),
				generate: async (r) => prd(r),
			}),
		).rejects.toThrow("duplicate PRD key");
		await expect(
			runTot({ requests: [request], checkpointDir: "relative/dir", generate: async (r) => prd(r) }),
		).rejects.toThrow("absolute");
	});
});
