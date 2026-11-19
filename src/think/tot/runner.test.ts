// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PrdValidationError } from "./generator.ts";
import { checkpointPath, inputHash, MANIFEST_FILE, runTot } from "./runner.ts";
import { PRD_TEMPLATE_VERSION, sha256Hex } from "./template.ts";
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

/** The pre-wave input hash: the canonical array without any wave element. No-wave requests must keep it. */
function legacyPreWaveHash(request: PrdRequest): string {
	return sha256Hex(
		JSON.stringify([
			PRD_TEMPLATE_VERSION,
			"",
			request.key,
			request.graphId,
			request.nodeId,
			request.step,
			request.title,
			request.thought,
		]),
	);
}

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

	test("the input hash covers the explicit execution wave", () => {
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		// The generator emits wave="..." iff request.wave is set, so an explicit wave changes the prompt and
		// must change the hash — including when it equals `step`, where the prompt still gains the attribute.
		expect(inputHash({ ...request, wave: 1 })).not.toBe(inputHash({ ...request, wave: 99 }));
		expect(inputHash({ ...request, wave: 99 })).not.toBe(inputHash(request));
		expect(inputHash({ ...request, wave: request.step })).not.toBe(inputHash(request));
		expect(inputHash({ ...request, wave: 7 })).toBe(inputHash({ ...request, wave: 7 }));
	});

	test("the input hash without a wave matches the pre-wave hash format", () => {
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		// No wave is set, so the generator emits no wave attribute and the canonical array is unchanged:
		// checkpoints written before waves existed keep matching.
		expect(inputHash(request)).toBe(legacyPreWaveHash(request));
		expect(inputHash({ ...request, wave: 7 })).not.toBe(legacyPreWaveHash(request));
	});

	test("a checkpoint written with the pre-wave hash format is resumed when no wave is set", async () => {
		const dir = makeDir();
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		const markdown = "# Pre-existing PRD\n";
		const legacy = legacyPreWaveHash(request);
		expect(legacy).toBe(inputHash(request));
		const record = {
			key: request.key,
			hash: sha256Hex(markdown),
			markdown,
			status: "generated" as const,
			model: "m-1",
			fallback: false,
			attempts: 1,
		};
		writeFileSync(
			checkpointPath(dir, request.key),
			JSON.stringify({ version: 1, inputHash: legacy, record }),
		);
		const calls: string[] = [];
		const manifest = await runTot({
			requests: [request],
			checkpointDir: dir,
			generate: async (r) => {
				calls.push(r.key);
				return prd(r);
			},
		});
		expect(calls).toEqual([]);
		expect(manifest.records).toEqual([record]);
	});

	test("a pre-wave checkpoint is not reused when an explicit wave is set", async () => {
		const dir = makeDir();
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		const waved = { ...request, wave: 7 };
		const markdown = "# Pre-existing PRD\n";
		const legacy = legacyPreWaveHash(waved);
		expect(legacy).not.toBe(inputHash(waved));
		const record = {
			key: waved.key,
			hash: sha256Hex(markdown),
			markdown,
			status: "generated" as const,
			model: "m-1",
			fallback: false,
			attempts: 1,
		};
		writeFileSync(
			checkpointPath(dir, waved.key),
			JSON.stringify({ version: 1, inputHash: legacy, record }),
		);
		const calls: string[] = [];
		const manifest = await runTot({
			requests: [waved],
			checkpointDir: dir,
			generate: async (r) => {
				calls.push(r.key);
				return prd(r);
			},
		});
		// The prompt under wave 7 carries wave="7" and differs from the pre-wave prompt, so the legacy
		// checkpoint must be regenerated rather than resumed.
		expect(calls).toEqual([waved.key]);
		expect(manifest.generated).toBe(1);
		expect(manifest.records[0]?.markdown).toBe(prd(waved).markdown);
	});

	test("a checkpoint with an explicit wave is resumed for the same wave, not for another", async () => {
		const dir = makeDir();
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		const waved = { ...request, wave: 7 };
		await runTot({ requests: [waved], checkpointDir: dir, generate: async (r) => prd(r) });
		let calls = 0;
		const generate = async (r: PrdRequest) => {
			calls++;
			return prd(r);
		};
		await runTot({ requests: [waved], checkpointDir: dir, generate });
		expect(calls).toBe(0);
		await runTot({ requests: [{ ...waved, wave: 8 }], checkpointDir: dir, generate });
		expect(calls).toBe(1);
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
describe("runTot: dependency-ready queue", () => {
	function depRequests(): PrdRequest[] {
		return [
			{ ...makeRequests(1)[0]!, key: "b.1", nodeId: "b", blockedBy: ["a.1"] },
			{ ...makeRequests(1)[0]!, key: "a.1", nodeId: "a" },
			{ ...makeRequests(1)[0]!, key: "c.1", nodeId: "c" },
		];
	}

	test("a step is generated only after its blockedBy PRD, and independent steps overlap", async () => {
		const dir = makeDir();
		const started: string[] = [];
		const finished: string[] = [];
		const events: string[] = [];
		const manifest = await runTot({
			requests: depRequests(),
			checkpointDir: dir,
			concurrency: 3,
			generate: async (request) => {
				started.push(request.key);
				events.push(`start:${request.key}`);
				if (request.key === "a.1") {
					await tick();
					await tick();
				}
				finished.push(request.key);
				events.push(`finish:${request.key}`);
				return prd(request);
			},
		});
		expect(manifest).toMatchObject({ total: 3, generated: 3, failed: 0 });
		// b.1 was listed first but starts only after its dependency; c.1 ran in parallel with a.1.
		expect(started.slice(0, 2).sort()).toEqual(["a.1", "c.1"]);
		expect(started.indexOf("b.1")).toBeGreaterThan(started.indexOf("a.1"));
		expect(started.indexOf("b.1")).toBeGreaterThan(started.indexOf("c.1"));
		expect(events.indexOf("start:b.1")).toBeGreaterThan(events.indexOf("finish:a.1"));
		expect(finished.indexOf("a.1")).toBeLessThan(finished.indexOf("b.1"));
		expect(finished.indexOf("c.1")).toBeLessThan(finished.indexOf("a.1"));
	});

	test("a dependent of a failed PRD is held, never generated", async () => {
		const dir = makeDir();
		const calls: string[] = [];
		const manifest = await runTot({
			requests: depRequests(),
			checkpointDir: dir,
			retry: { maxAttempts: 1, baseMs: 1, capMs: 1 },
			generate: async (request) => {
				calls.push(request.key);
				if (request.key === "a.1") throw new Error("no provider");
				return prd(request);
			},
		});
		expect(manifest.generated).toBe(1);
		expect(manifest.records.find((record) => record.key === "a.1")?.status).toBe("failed");
		const held = manifest.records.find((record) => record.key === "b.1");
		expect(held).toMatchObject({ status: "skipped" });
		expect(held?.error).toContain("blocked by a.1");
		expect(calls).not.toContain("b.1");
	});

	test("an unknown dependency and a dependency cycle are recorded failed, never generated", async () => {
		const dir = makeDir();
		const unknown = await runTot({
			requests: [{ ...makeRequests(1)[0]!, key: "x.1", nodeId: "x", blockedBy: ["ghost.1"] }],
			checkpointDir: dir,
			generate: async (request) => prd(request),
		});
		expect(unknown.records[0]).toMatchObject({ status: "failed" });
		expect(unknown.records[0]?.error).toContain("unknown dependency ghost.1");

		const cyclic = await runTot({
			requests: [
				{ ...makeRequests(1)[0]!, key: "y.1", nodeId: "y", blockedBy: ["z.1"] },
				{ ...makeRequests(1)[0]!, key: "z.1", nodeId: "z", blockedBy: ["y.1"] },
			],
			checkpointDir: dir,
			generate: async (request) => prd(request),
		});
		expect(cyclic.records.every((record) => record.status === "failed")).toBe(true);
		expect(cyclic.records[0]?.error).toContain("dependency cycle");
	});

	test("the input hash covers the dependency fingerprint, and edge-free hashes are unchanged", () => {
		const [request] = makeRequests(1);
		if (request === undefined) throw new Error("no request");
		expect(inputHash(request)).toBe(legacyPreWaveHash(request));
		expect(inputHash({ ...request, blockedBy: [] })).toBe(legacyPreWaveHash(request));
		expect(inputHash({ ...request, blockedBy: ["a.1"] })).not.toBe(legacyPreWaveHash(request));
		expect(inputHash({ ...request, blockedBy: ["a.1", "b.1"] })).toBe(
			inputHash({ ...request, blockedBy: ["b.1", "a.1"] }),
		);
		expect(inputHash({ ...request, blocks: ["q.1"] })).not.toBe(
			inputHash({ ...request, blockedBy: ["q.1"] }),
		);
	});
});
