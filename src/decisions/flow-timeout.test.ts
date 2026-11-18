// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { evaluateFlowOutput } from "./flow.ts";
import { DEFAULT_DECISIONS_CONFIG } from "./types.ts";

describe("evaluateFlowOutput timeout", () => {
	test("a never-answering request times out after the configured config.timeoutMs", async () => {
		const record = await evaluateFlowOutput({
			subject: "phase:execute",
			output: "work done",
			apiKey: "sk-test",
			config: { ...DEFAULT_DECISIONS_CONFIG, timeoutMs: 60 },
			fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
		});
		expect(record.state).toBe("error");
		expect(record.errorClass).toBe("timeout");
		expect(record.rationale).toBe("decisions timeout: no answer within 60 ms");
	});
});
