// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PrdRecord } from "../think/tot/types.ts";
import type { ToolCaller } from "./create.ts";
import type { SyncDeps } from "./prd-types.ts";
import { syncPrds } from "./prd-sync.ts";

const refs = {
	linear: {
		steps: {
			"n1.1": {
				id: "uuid-1",
				identifier: "ENG-1",
				url: "https://linear.app/t/issue/ENG-1",
				title: "step",
			},
		},
	},
	notion: {
		steps: {},
	},
};

function prd(markdown: string, hash = "a".repeat(64)): PrdRecord {
	return {
		key: "n1.1",
		hash,
		markdown,
		status: "generated",
		model: "m",
		fallback: false,
		attempts: 1,
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(homedir(), "ultrathink-test-prdsync-hardening-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function deps(extra: Partial<SyncDeps> = {}): SyncDeps {
	return {
		graphId: "ut-g1",
		stateDir: dir,
		refs,
		sleep: async () => undefined,
		random: () => 0.5,
		...extra,
	};
}

describe("syncPrds Linear readback", () => {
	test("a description overwritten between read and save is not recorded as synced", async () => {
		let stored = "Existing notes";
		let clobber = true;
		const caller: ToolCaller = {
			async call(name, args) {
				if (name === "get_issue") {
					return { id: "uuid-1", description: stored, url: "https://linear.app/t/issue/ENG-1" };
				}
				if (name === "save_issue") {
					stored = String(args.description);
					// Another writer read the description before our save, and its save lands after ours.
					if (clobber) stored = "Someone else's notes";
					return { id: "uuid-1" };
				}
				throw new Error(`unexpected ${name}`);
			},
		};
		const d = deps({ linear: caller });
		const first = await syncPrds([prd("# Title\n\nBody")], d);
		expect(first.keys[0]?.linear.outcome).toBe("pending");
		expect(first.keys[0]?.linear.error).toContain("PRD region missing");
		const pending = JSON.parse(readFileSync(first.ledgerPath, "utf8"));
		expect(pending.entries[0].linear.status).toBe("pending");

		clobber = false;
		const second = await syncPrds([prd("# Title\n\nBody")], d);
		expect(second.keys[0]?.linear.outcome).toBe("created");
		expect(stored).toContain("# Title");
		const synced = JSON.parse(readFileSync(second.ledgerPath, "utf8"));
		expect(synced.entries[0].linear.status).toBe("synced");
	});
});

describe("syncPrds ledger version", () => {
	/** Runs a sync over an existing ledger file and returns the tool calls and log lines it produced. */
	async function syncOverLedger(content: string) {
		const ledgerPath = join(dir, "prd-sync", "ut-g1", "ledger.json");
		mkdirSync(join(dir, "prd-sync", "ut-g1"), { recursive: true });
		writeFileSync(ledgerPath, content);
		const calls: string[] = [];
		const logs: string[] = [];
		const caller: ToolCaller = {
			async call(name) {
				calls.push(name);
				throw new Error(`unexpected ${name}`);
			},
		};
		const report = await syncPrds(
			[prd("x")],
			deps({ linear: caller, log: (message) => logs.push(message) }),
		);
		return { ledgerPath, report, calls, logs };
	}

	test("a ledger with an unknown version is not overwritten", async () => {
		const content = `${JSON.stringify({ version: 2, graphId: "ut-g1", entries: [] }, null, "\t")}\n`;
		const { ledgerPath, report, calls, logs } = await syncOverLedger(content);
		expect(readFileSync(ledgerPath, "utf8")).toBe(content);
		expect(calls).toEqual([]);
		expect(report.keys[0]?.state).toBe("pending");
		expect(report.keys[0]?.linear.errorClass).toBe("local-write");
		expect(logs.some((line) => line.includes("not a version 1 ledger"))).toBe(true);
	});

	test("a ledger without an entries array is not overwritten", async () => {
		const content = `${JSON.stringify({ version: 1, graphId: "ut-g1" }, null, "\t")}\n`;
		const { ledgerPath, report, calls, logs } = await syncOverLedger(content);
		expect(readFileSync(ledgerPath, "utf8")).toBe(content);
		expect(calls).toEqual([]);
		expect(report.keys[0]?.state).toBe("pending");
		expect(logs.some((line) => line.includes("not a version 1 ledger"))).toBe(true);
	});
});
