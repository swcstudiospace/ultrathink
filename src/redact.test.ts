// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { redactSecrets, redactSecretShapes, SECRET_TOKEN_PATTERNS } from "./redact.ts";

const JWT = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(12)}`;

interface ShapeCase {
	name: string;
	planted: string;
	/** A fragment of the planted secret that must not survive. */
	canary: string;
	/** False when the shape swallows the rest of the message (an unterminated PEM block). */
	keepsTail: boolean;
}

const CANARY = "CANARYCANARY";
const FAKE = `${CANARY}CANARY1234`;
const PEM_BODY = "Q0FOQVJZQ0FOQVJZ";

const SHAPES: ShapeCase[] = [
	{ name: "sk-or- key", planted: `sk-or-v1-${FAKE}`, canary: CANARY, keepsTail: true },
	{ name: "sk-ant- key", planted: `sk-ant-api03-${FAKE}`, canary: CANARY, keepsTail: true },
	{ name: "vck_ key", planted: `vck_${FAKE}`, canary: CANARY, keepsTail: true },
	{ name: "ghp_ token", planted: `ghp_${FAKE}`, canary: CANARY, keepsTail: true },
	{ name: "github_pat_ token", planted: `github_pat_${FAKE}`, canary: CANARY, keepsTail: true },
	{ name: "AWS access key id", planted: "AKIACANARYCANARY1234", canary: CANARY, keepsTail: true },
	{
		name: "Bearer token",
		planted: "Bearer canary-bearer-token-9876",
		canary: "canary-bearer",
		keepsTail: true,
	},
	{ name: "JWT", planted: JWT, canary: "aaaaaaaaaaaa", keepsTail: true },
	{
		name: "PEM block",
		planted: `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`,
		canary: "Q0FOQVJZ",
		keepsTail: true,
	},
	{
		name: "unterminated PEM block",
		planted: `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}`,
		canary: "Q0FOQVJZ",
		keepsTail: false,
	},
	{
		name: "KEY=value",
		planted: "OPENROUTER_API_KEY=canaryvalue123456",
		canary: "canaryvalue123456",
		keepsTail: true,
	},
	{
		name: "password: value",
		planted: "password: canaryhunter99",
		canary: "canaryhunter99",
		keepsTail: true,
	},
	{
		name: "x-api-key header",
		planted: "x-api-key: canaryapikeyvalue",
		canary: "canaryapikeyvalue",
		keepsTail: true,
	},
	{
		name: "URL user-info",
		planted: "https://user:canarypass99@host.example/path",
		canary: "canarypass99",
		keepsTail: true,
	},
];

const LIN = "lin_api_CANARYCANARYCANARY1234";
const NOTION_NTN = "ntn_CANARYCANARYCANARY1234";
const NOTION_SECRET = "secret_CANARYCANARYCANARY1234";
const ARGON = "$argon2id$v=19$m=65536,t=3,p=4$Q0FOQVJZc2FsdA$CANARYhashCANARYhash1234";

SHAPES.push(
	{ name: "Linear API key", planted: LIN, canary: CANARY, keepsTail: true },
	{ name: "Notion ntn_ token", planted: NOTION_NTN, canary: CANARY, keepsTail: true },
	{ name: "Notion secret_ token", planted: NOTION_SECRET, canary: CANARY, keepsTail: true },
	{ name: "argon2id hash", planted: ARGON, canary: "CANARYhash", keepsTail: true },
	{
		name: "argon2i hash",
		planted: "$argon2i$v=19$m=16,t=2,p=1$c2FsdHNhbHQ$CANARYhashCANARYhash1234",
		canary: "CANARYhash",
		keepsTail: true,
	},
	{
		name: "argon2d hash",
		planted: "$argon2d$v=19$m=16,t=2,p=1$c2FsdHNhbHQ$CANARYhashCANARYhash1234",
		canary: "CANARYhash",
		keepsTail: true,
	},
);

describe("redactSecrets: key shapes", () => {
	for (const shape of SHAPES) {
		test(`masks a ${shape.name} inside a thrown-style message`, () => {
			const out = redactSecrets(`upstream said: ${shape.planted} (HTTP 401)`);
			expect(out).not.toContain(shape.canary);
			expect(out).toContain("[redacted]");
			expect(out).toContain("upstream said:");
			if (shape.keepsTail) expect(out).toContain("(HTTP 401)");
		});
	}

	test("masks every occurrence of a shape, not only the first", () => {
		const key = "sk-or-v1-CANARYCANARYCANARY1234";
		expect(redactSecrets(`${key} then ${key} then Bearer canary-bearer-token-9876`)).toBe(
			"[redacted] then [redacted] then [redacted]",
		);
	});

	test("the pattern table is global, so one replace masks every occurrence", () => {
		expect(SECRET_TOKEN_PATTERNS.length).toBeGreaterThan(0);
		for (const pattern of SECRET_TOKEN_PATTERNS) expect(pattern.global).toBe(true);
	});

	test("redactSecretShapes masks shapes without an exact secret", () => {
		expect(redactSecretShapes("a sk-or-v1-CANARYCANARYCANARY1234 b")).toBe("a [redacted] b");
	});

	test("an xai- prefix is exact-secret only: it also names non-secret ids", () => {
		const key = "xai-CANARYCANARYCANARY1234";
		expect(redactSecrets("provider xai-oauth failed via xai-grok-cli")).toBe(
			"provider xai-oauth failed via xai-grok-cli",
		);
		expect(redactSecrets(`rejected ${key}`)).toContain(key);
		expect(redactSecrets(`rejected ${key}`, key)).toBe("rejected [redacted]");
	});
});

describe("redactSecrets: exact secrets", () => {
	const LIVE = "plain-live-key-value-0001";

	test("masks a secret that has no known shape, only when it is passed", () => {
		const message = `gateway rejected ${LIVE} for this request`;
		expect(redactSecrets(message)).toContain(LIVE);
		expect(redactSecrets(message, LIVE)).toBe("gateway rejected [redacted] for this request");
	});

	test("masks every occurrence and a secret padded with whitespace", () => {
		expect(redactSecrets(`${LIVE} and ${LIVE}`, `  ${LIVE}\n`)).toBe("[redacted] and [redacted]");
	});

	test("masks the secret as JSON-escaped and as URL-encoded inside an error body", () => {
		const quoted = 'live"secret"value-0001';
		const body = JSON.stringify({ error: `bad ${quoted}` });
		expect(body).not.toContain(quoted);
		expect(redactSecrets(body, quoted)).not.toContain("value-0001");
		const spaced = "live key/secret+value=0001";
		const url = `https://api.example/v1?k=${encodeURIComponent(spaced)}`;
		expect(redactSecrets(url, spaced)).not.toContain("secret%2Bvalue");
	});

	test("a caller that cuts the redacted text never exposes part of the secret", () => {
		const out = redactSecrets(`${"y".repeat(30)}${LIVE}`, LIVE).slice(0, 45);
		expect(out).not.toContain(LIVE.slice(0, 10));
	});

	test("masks a secret before the shape table runs, so a shaped key is one marker", () => {
		const key = "sk-or-v1-CANARYCANARYCANARY1234";
		expect(redactSecrets(key, key)).toBe("[redacted]");
	});

	test("masks the longer of two overlapping secrets first", () => {
		const short = "live-key-prefix-1234";
		const long = `${short}-and-more`;
		expect(redactSecrets(`got ${long}`, short, long)).toBe("got [redacted]");
	});

	test("ignores empty and blank exact secrets so they cannot blank the text", () => {
		const text = "the word short and its spaces are fine, 7chars! too";
		expect(redactSecrets(text, "", "   ", "\t\n")).toBe(text);
	});

	test("masks a short explicit secret whatever its length, trimmed or not", () => {
		// A 7-character gateway token: an upstream error must not echo it back.
		expect(redactSecrets("invalid credential ut7test", "ut7test")).toBe(
			"invalid credential [redacted]",
		);
		expect(redactSecrets("invalid credential ut7test", " ut7test ")).toBe(
			"invalid credential [redacted]",
		);
		expect(redactSecrets("got 7chars! back", "7chars!")).toBe("got [redacted] back");
	});

	test("a one-character explicit secret is masked everywhere it occurs without throwing", () => {
		expect(redactSecrets("a-b-a", "a")).toBe("[redacted]-b-[redacted]");
	});

	test("skips a non-string secret at runtime instead of throwing", () => {
		expect(redactSecrets("plain text", undefined as unknown as string)).toBe("plain text");
	});
});

describe("redactSecrets: text that carries no secret", () => {
	test("passes prose and non-secret assignments through unchanged", () => {
		for (const text of [
			"HTTP 503 from https://api.example.com/v1/chat: upstream timeout after 30s",
			"HTTP 429 retry-after=30 model=grok-4",
			"keyboard=us retries=3",
			"model=grok-4 status: degraded",
			"Key: use import type",
		]) {
			expect(redactSecrets(text)).toBe(text);
		}
	});

	test("diagnostics are not prose: every word after Bearer is masked, even short plain letters", () => {
		expect(redactSecrets("token Bearer abcdefgh rejected")).toBe("token [redacted] rejected");
		expect(redactSecrets("the Bearer key is missing")).toBe("the [redacted] is missing");
	});

	test("the prose-safe shape table keeps a Bearer word that is plain prose", () => {
		expect(redactSecretShapes("the Bearer key is missing")).toBe("the Bearer key is missing");
		expect(redactSecretShapes("Bearer canary-bearer-token-9876")).not.toContain("canary-bearer");
	});

	test("short or lookalike prefixes stay: secret_santa, a bare ntn_, a short lin_api_ and a prose $argon2 mention", () => {
		for (const text of [
			"we are running secret_santa this year",
			"the ntn_ prefix marks a Notion token",
			"ntn_short and secret_short and lin_api_short",
			"argon2id is the recommended variant",
		]) {
			expect(redactSecrets(text)).toBe(text);
		}
	});

	test("keeps line breaks and indentation: it neither collapses nor truncates", () => {
		const text = `first line\n  indented ${"z".repeat(5000)}`;
		expect(redactSecrets(text)).toBe(text);
	});

	test("an empty string stays empty", () => {
		expect(redactSecrets("")).toBe("");
		expect(redactSecrets("", "live-secret-value-0001")).toBe("");
	});
});

describe("redactSecrets: never throws", () => {
	test("a non-string input yields an empty string", () => {
		expect(redactSecrets(undefined as unknown as string)).toBe("");
		expect(redactSecrets(null as unknown as string)).toBe("");
		expect(redactSecrets(42 as unknown as string)).toBe("");
		expect(redactSecrets({ message: "x" } as unknown as string)).toBe("");
	});

	test("huge unbroken and repetitive input returns, and secrets inside it are still masked", () => {
		const run = "a".repeat(300_000);
		expect(redactSecrets(run)).toBe(run);
		const dots = "a.".repeat(100_000);
		expect(redactSecrets(dots)).toBe(dots);
		expect(redactSecrets("-----BEGIN PRIVATE KEY-----".repeat(5000))).toBe("[redacted]");
		const key = "sk-or-v1-CANARYCANARYCANARY1234";
		expect(redactSecrets(`${run} ${key}`)).toBe(`${run} [redacted]`);
	});

	test("assignment redaction is linear: a long `a:a:a:` or `a=a:` run completes quickly", () => {
		const budgetMs = 3000;
		const colons = "a:".repeat(100_000);
		const mixed = "a=a:".repeat(50_000);
		const templ = "key=$".repeat(50_000);
		for (const input of [colons, mixed, templ]) {
			const started = performance.now();
			const out = redactSecrets(input);
			expect(performance.now() - started).toBeLessThan(budgetMs);
			expect(out.length).toBeGreaterThan(0);
		}
	});

	test("a real assignment secret inside a long noisy line is still masked", () => {
		const noise = "a:".repeat(100_000);
		const started = performance.now();
		const out = redactSecrets(`${noise} API_KEY=sk-or-v1-CANARYCANARYCANARY1234 ${noise}`);
		expect(performance.now() - started).toBeLessThan(3000);
		expect(out).not.toContain("CANARYCANARY");
		expect(out).toContain("API_KEY=[redacted]");
		const equalsNoise = "x=y:".repeat(50_000);
		const out2 = redactSecrets(`${equalsNoise} API_KEY=plainvalue123456 end`);
		expect(out2).not.toContain("plainvalue123456");
		expect(out2.endsWith(" end")).toBe(true);
	});

	test("lone surrogates and control characters pass through without an error", () => {
		const odd = "\ud800 \u0000 \u001b[31m tail";
		expect(redactSecrets(odd)).toBe(odd);
	});
});
