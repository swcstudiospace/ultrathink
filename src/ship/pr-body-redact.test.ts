// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import { buildPr } from "./pr-body.ts";
import type { Assessment } from "./types.ts";

const TOKEN = "9f8e7d6c5b4a3210fedcba";

const ASSESSMENT: Assessment = {
	done: true,
	confidence: 0.9,
	summary: "ok",
	gaps: [],
	signals: { git: { onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true } },
	source: "llm",
	mode: "gate",
	at: 1,
};

describe("buildPr redaction", () => {
	test("redacts a Bearer token from title and body when it appears in the summary", () => {
		const record = {
			sessionId: "s",
			at: 1,
			result: { xml: "", original: "Add a retry", root: "" },
		} as unknown as SessionRecord;
		const { title, body } = buildPr(record, {
			...ASSESSMENT,
			summary: `Calls the API with Authorization: Bearer ${TOKEN} and retries.`,
		});
		expect(title).not.toContain(TOKEN);
		expect(body).not.toContain(TOKEN);
		expect(body).toContain("[redacted]");
	});

	test("redacts a Bearer token from title and body when it appears in the request", () => {
		const record = {
			sessionId: "s",
			at: 1,
			result: { xml: "", original: `Use Bearer ${TOKEN} for the upstream call`, root: "" },
		} as unknown as SessionRecord;
		const { title, body } = buildPr(record);
		expect(title).not.toContain(TOKEN);
		expect(body).not.toContain(TOKEN);
	});

	test("redacts a Bearer token from a body section other than the summary", () => {
		const record = {
			sessionId: "s",
			at: 1,
			result: { xml: "", original: "Add a retry", root: "" },
		} as unknown as SessionRecord;
		const { title, body } = buildPr(record, {
			...ASSESSMENT,
			gaps: [`Missing wiring for Bearer ${TOKEN} in the client`],
		});
		expect(title).not.toContain(TOKEN);
		expect(body).not.toContain(TOKEN);
		expect(body).toContain("- Gaps:");
	});
});
