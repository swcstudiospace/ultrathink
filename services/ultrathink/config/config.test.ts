// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ROUTE_DEFAULT_MODELS } from "../../../src/route-defaults.ts";
import { randomHash } from "../../../src/test.helpers.ts";
import { ConfigError, loadConfig } from "./config.ts";

function randomSecret(): string {
	return randomBytes(24).toString("base64url");
}

function baseEnv(): Record<string, string | undefined> {
	return {
		ULTRATHINK_PUBLIC_ORIGIN: "https://ultrathink.swcstudio.space",
		ULTRATHINK_OWNER_PASSWORD_HASH: randomHash(),
		ULTRATHINK_SESSION_SECRET: randomSecret(),
		ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
	};
}

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as Error).message;
	}
	throw new Error("expected function to throw");
}

/** The aggregated block: a header with the problem count, then one two-space-indented line per problem. */
function expectProblem(message: string, problem: string, count = 1): void {
	const lines = message.split("\n");
	expect(lines[0]).toBe(`ultrathink: ${count} configuration problems`);
	expect(lines).toContain(`  ${problem}`);
}

describe("loadConfig required variables", () => {
	test("a missing required variable throws a ConfigError naming it without its value", () => {
		const env = baseEnv();
		const hash = env.ULTRATHINK_OWNER_PASSWORD_HASH as string;
		delete env.ULTRATHINK_OWNER_PASSWORD_HASH;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_OWNER_PASSWORD_HASH");
		expect(message).not.toContain(hash);
	});

	test("a blank required variable counts as unset", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "   ";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PUBLIC_ORIGIN");
	});
});

describe("loadConfig defaults", () => {
	test("applies documented defaults and the Claude route planning model", () => {
		const config = loadConfig(baseEnv());
		expect(config.stateDir).toBe("/var/lib/ultrathink");
		expect(config.dbPath).toBe("/var/lib/ultrathink/ultrathink.sqlite");
		expect(config.port).toBe(8795);
		expect(config.maxInputChars).toBe(4000000);
		expect(config.maxAnswerChars).toBe(20000);
		expect(config.maxBodyBytes).toBe(1048576);
		expect(config.runTokenCeiling).toBe(0);
		expect(config.dailyTokenCeiling).toBe(0);
		expect(config.planningModel).toBe(ROUTE_DEFAULT_MODELS.claude);
	});

	test("trims values before use", () => {
		const env = baseEnv();
		env.ULTRATHINK_PORT = "  9000  ";
		expect(loadConfig(env).port).toBe(9000);
	});

	test("derives dbPath from a custom stateDir", () => {
		const env = baseEnv();
		env.ULTRATHINK_STATE_DIR = "/tmp/ut-state";
		expect(loadConfig(env).dbPath).toBe("/tmp/ut-state/ultrathink.sqlite");
	});

	test("strips trailing slashes from stateDir before building dbPath", () => {
		const env = baseEnv();
		env.ULTRATHINK_STATE_DIR = "/var/x/";
		const config = loadConfig(env);
		expect(config.stateDir).toBe("/var/x");
		expect(config.dbPath).toBe("/var/x/ultrathink.sqlite");
	});

	test("rejects a relative stateDir naming the variable", () => {
		for (const value of ["relative/dir/", "./state", "state"]) {
			const env = baseEnv();
			env.ULTRATHINK_STATE_DIR = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_STATE_DIR");
			expect(message).toContain("absolute");
		}
	});
});

describe("planningModel", () => {
	test("defaults to the Claude route model", () => {
		expect(loadConfig(baseEnv()).planningModel).toBe("claude-haiku-5-5");
	});

	test("takes a Claude model id", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLANNING_MODEL = "claude-sonnet-5-5";
		expect(loadConfig(env).planningModel).toBe("claude-sonnet-5-5");
	});

	test("a slash is a ConfigError saying the id looks like OpenRouter's, without echoing it", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLANNING_MODEL = "x-ai/grok-4.7";
		const message = messageOf(() => loadConfig(env));
		expect(message).toBe(
			"ultrathink: 1 configuration problems\n  ULTRATHINK_PLANNING_MODEL names an OpenRouter-style model id; the hosted planner runs on the Claude plan login (default claude-haiku-5-5). Remove the line or set a Claude model id.",
		);
		expect(message).not.toContain("grok");
	});

	test("a model name outside the allowed pattern is rejected without echoing it", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLANNING_MODEL = "bad model name!";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PLANNING_MODEL");
		expect(message).not.toContain("bad model name!");
	});
});

describe("strict integers", () => {
	for (const value of ["12abc", "1.5", "-3"]) {
		test(`rejects malformed port ${JSON.stringify(value)} without echoing it`, () => {
			const env = baseEnv();
			env.ULTRATHINK_PORT = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_PORT");
			expect(message).not.toContain(value);
		});
	}

	test("rejects a port below 1024", () => {
		const env = baseEnv();
		env.ULTRATHINK_PORT = "1023";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_PORT");
	});

	test("rejects a port above 65535", () => {
		const env = baseEnv();
		env.ULTRATHINK_PORT = "65536";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_PORT");
	});

	test("maxInputChars accepts 0, meaning no input gate", () => {
		const env = baseEnv();
		env.ULTRATHINK_MAX_INPUT_CHARS = "0";
		expect(loadConfig(env).maxInputChars).toBe(0);
	});

	test("rejects maxAnswerChars above 200000, naming the variable", () => {
		const env = baseEnv();
		env.ULTRATHINK_MAX_ANSWER_CHARS = "200001";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_MAX_ANSWER_CHARS");
	});

	test("a zero token ceiling is unlimited", () => {
		const env = baseEnv();
		env.ULTRATHINK_RUN_TOKEN_CEILING = "0";
		env.ULTRATHINK_DAILY_TOKEN_CEILING = "0";
		const config = loadConfig(env);
		expect([config.runTokenCeiling, config.dailyTokenCeiling]).toEqual([0, 0]);
	});

	test("rejects a malformed daily token ceiling", () => {
		const env = baseEnv();
		env.ULTRATHINK_DAILY_TOKEN_CEILING = "1e6";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_DAILY_TOKEN_CEILING");
	});
});

describe("publicOrigin", () => {
	test("rejects a non-loopback http origin", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "http://ultrathink.swcstudio.space";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PUBLIC_ORIGIN");
		expect(message).not.toContain("ultrathink.swcstudio.space");
	});

	test("accepts http for localhost and 127.0.0.1", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "http://localhost:8792";
		expect(loadConfig(env).publicOrigin).toBe("http://localhost:8792");
		env.ULTRATHINK_PUBLIC_ORIGIN = "http://127.0.0.1:8792";
		expect(loadConfig(env).publicOrigin).toBe("http://127.0.0.1:8792");
	});

	test("rejects a value that is not an absolute URL", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "ultrathink.swcstudio.space";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_PUBLIC_ORIGIN");
	});
});

describe("publicOrigin normalization", () => {
	test("drops a trailing slash and lower-cases the host", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "https://Ultrathink.SWCStudio.space/";
		expect(loadConfig(env).publicOrigin).toBe("https://ultrathink.swcstudio.space");
	});

	test("keeps an explicit non-default port", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "https://ultrathink.swcstudio.space:8443";
		expect(loadConfig(env).publicOrigin).toBe("https://ultrathink.swcstudio.space:8443");
	});

	test("rejects a path, a query, a fragment and credentials without echoing the value", () => {
		for (const value of [
			"https://ultrathink.swcstudio.space/some/path",
			"https://ultrathink.swcstudio.space/?a=1",
			"https://ultrathink.swcstudio.space/#frag",
			"https://owner:secret@ultrathink.swcstudio.space",
		]) {
			const env = baseEnv();
			env.ULTRATHINK_PUBLIC_ORIGIN = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_PUBLIC_ORIGIN");
			expect(message).not.toContain("swcstudio.space");
			expect(message).not.toContain("secret");
		}
	});
});

describe("ownerPasswordHash", () => {
	test("accepts the argon2id and bcrypt hashes Bun.password produces", () => {
		const env = baseEnv();
		const argon = Bun.password.hashSync("pw", "argon2id");
		env.ULTRATHINK_OWNER_PASSWORD_HASH = argon;
		expect(loadConfig(env).ownerPasswordHash).toBe(argon);
		const bcrypt = Bun.password.hashSync("pw", { algorithm: "bcrypt", cost: 4 });
		env.ULTRATHINK_OWNER_PASSWORD_HASH = bcrypt;
		expect(loadConfig(env).ownerPasswordHash).toBe(bcrypt);
	});

	test("rejects a plaintext value and a shell-expanded hash without echoing either", () => {
		const expanded = Bun.password.hashSync("pw", "argon2id").replace("$argon2id", "");
		for (const value of ["plaintext-not-a-hash", expanded, "$argon2id$truncated"]) {
			const env = baseEnv();
			env.ULTRATHINK_OWNER_PASSWORD_HASH = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_OWNER_PASSWORD_HASH");
			expect(message).not.toContain(value);
		}
	});
});

describe("sessionSecret", () => {
	test("rejects a secret shorter than 32 characters without echoing it", () => {
		const env = baseEnv();
		const short = randomSecret().slice(0, 31);
		env.ULTRATHINK_SESSION_SECRET = short;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_SESSION_SECRET");
		expect(message).not.toContain(short);
	});

	test("accepts a secret of exactly 32 characters", () => {
		const env = baseEnv();
		env.ULTRATHINK_SESSION_SECRET = randomSecret().slice(0, 32);
		expect(loadConfig(env).sessionSecret).toHaveLength(32);
	});
});

describe("server planning defaults", () => {
	test("new fields default to disabled server planning with documented limits", () => {
		const config = loadConfig(baseEnv());
		expect(config.allowedOrigins).toEqual([]);
		expect(config.oauthRedirectOrigins).toEqual([]);
		expect(config.serverPlanning).toBe(false);
		expect(config.maxConcurrentPlans).toBe(2);
		expect(config.modelTimeoutMs).toBe(0);
		expect(config.planTimeoutMs).toBe(0);
		expect(config.modelMaxOutputTokens).toBe(0);
	});

	test("maxBodyBytes defaults to 1 MB", () => {
		expect(loadConfig(baseEnv()).maxBodyBytes).toBe(1048576);
	});

	test("0 is accepted as unlimited for the model and plan timeouts and the output cap", () => {
		const env = baseEnv();
		env.ULTRATHINK_MODEL_TIMEOUT_MS = "0";
		env.ULTRATHINK_PLAN_TIMEOUT_MS = "0";
		env.ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS = "0";
		const config = loadConfig(env);
		expect([config.modelTimeoutMs, config.planTimeoutMs, config.modelMaxOutputTokens]).toEqual([
			0, 0, 0,
		]);
	});

	test("explicit values are read", () => {
		const env = baseEnv();
		env.ULTRATHINK_MAX_CONCURRENT_PLANS = "4";
		env.ULTRATHINK_MODEL_TIMEOUT_MS = "30000";
		env.ULTRATHINK_PLAN_TIMEOUT_MS = "90000";
		env.ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS = "4096";
		const config = loadConfig(env);
		expect(config.maxConcurrentPlans).toBe(4);
		expect(config.modelTimeoutMs).toBe(30000);
		expect(config.planTimeoutMs).toBe(90000);
		expect(config.modelMaxOutputTokens).toBe(4096);
	});
});

describe("server planning bounds", () => {
	const bounds: Array<[string, number, number]> = [
		["ULTRATHINK_MAX_CONCURRENT_PLANS", 1, 8],
		["ULTRATHINK_MODEL_TIMEOUT_MS", 5000, 600000],
		["ULTRATHINK_PLAN_TIMEOUT_MS", 30000, 1800000],
		["ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS", 256, 32000],
	];
	for (const [name, min, max] of bounds) {
		test(`${name} accepts ${min} and ${max}`, () => {
			for (const value of [min, max]) {
				const env = baseEnv();
				env[name] = String(value);
				expect(() => loadConfig(env)).not.toThrow();
			}
		});

		test(`${name} rejects out-of-range and malformed values`, () => {
			for (const value of [String(min - 1), String(max + 1), "1.5", "-1", "12abc", "1e3"]) {
				const env = baseEnv();
				env[name] = value;
				expect(messageOf(() => loadConfig(env))).toContain(name);
			}
		});
	}
});

describe("serverPlanning derivation", () => {
	test("is false by default: the connector keeps offering client planning", () => {
		expect(loadConfig(baseEnv()).serverPlanning).toBe(false);
	});

	test("is true only with ULTRATHINK_SERVER_PLANNING=1", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_SERVER_PLANNING: "1" }).serverPlanning).toBe(true);
	});

	test("ULTRATHINK_SERVER_PLANNING=0 is false", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_SERVER_PLANNING: "0" }).serverPlanning).toBe(
			false,
		);
	});

	test("any other ULTRATHINK_SERVER_PLANNING value is rejected", () => {
		const message = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_SERVER_PLANNING: "true" }),
		);
		expect(message).toContain("ULTRATHINK_SERVER_PLANNING");
	});
});

describe("origin lists", () => {
	test("trims, skips empty entries, normalizes and de-duplicates", () => {
		const env = baseEnv();
		env.ULTRATHINK_ALLOWED_ORIGINS =
			" https://a.example.test , http://b.example.test:8080,, HTTPS://A.EXAMPLE.TEST ,https://a.example.test ";
		expect(loadConfig(env).allowedOrigins).toEqual([
			"https://a.example.test",
			"http://b.example.test:8080",
		]);
	});

	test("a blank list is empty", () => {
		const env = baseEnv();
		env.ULTRATHINK_ALLOWED_ORIGINS = "  ";
		expect(loadConfig(env).allowedOrigins).toEqual([]);
	});

	test("oauth redirect origins accept https and parse like allowed origins", () => {
		const env = baseEnv();
		env.ULTRATHINK_OAUTH_REDIRECT_ORIGINS =
			"https://app.example.test, https://app.example.test,https://c.example.test:8443";
		expect(loadConfig(env).oauthRedirectOrigins).toEqual([
			"https://app.example.test",
			"https://c.example.test:8443",
		]);
	});

	test("oauth redirect origins reject http", () => {
		const env = baseEnv();
		env.ULTRATHINK_OAUTH_REDIRECT_ORIGINS = "http://app.example.test";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_OAUTH_REDIRECT_ORIGINS");
	});

	const notBare = [
		"https://a.example.test/",
		"https://a.example.test/path",
		"https://a.example.test?x=1",
		"https://a.example.test#frag",
		"https://user:secret@a.example.test",
		"https://user@a.example.test",
		"ftp://a.example.test",
		"a.example.test",
		"//a.example.test",
		"javascript:alert(1)",
		"https://",
		"*",
	];
	for (const value of notBare) {
		test(`allowed origins reject ${value}`, () => {
			const env = baseEnv();
			env.ULTRATHINK_ALLOWED_ORIGINS = `https://ok.example.test,${value}`;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_ALLOWED_ORIGINS");
			expect(message).not.toContain("secret");
		});
	}

	test("a bad entry in the oauth list names that variable", () => {
		const env = baseEnv();
		env.ULTRATHINK_OAUTH_REDIRECT_ORIGINS = "https://app.example.test/callback";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_OAUTH_REDIRECT_ORIGINS");
	});
});

describe("previous session secrets", () => {
	test("is empty when unset", () => {
		expect(loadConfig(baseEnv()).sessionSecretPrevious).toEqual([]);
	});

	test("parses a comma list, trimming entries and dropping empty ones", () => {
		const env = baseEnv();
		const older = randomSecret();
		const oldest = randomSecret();
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = ` ${older} ,, ${oldest} , `;
		expect(loadConfig(env).sessionSecretPrevious).toEqual([older, oldest]);
	});

	test("accepts up to four entries and rejects a fifth", () => {
		const env = baseEnv();
		const four = Array.from({ length: 4 }, () => randomSecret());
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = four.join(",");
		expect(loadConfig(env).sessionSecretPrevious).toEqual(four);
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = [...four, randomSecret()].join(",");
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_SESSION_SECRET_PREVIOUS");
	});

	test("rejects a previous secret shorter than 32 characters without echoing it", () => {
		const env = baseEnv();
		const short = randomSecret().slice(0, 31);
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = `${randomSecret()},${short}`;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_SESSION_SECRET_PREVIOUS");
		expect(message).not.toContain(short);
	});
});

describe("operations settings", () => {
	test("apply documented defaults", () => {
		const config = loadConfig(baseEnv());
		expect(config.breakerFailures).toBe(5);
		expect(config.breakerWindowMs).toBe(60000);
		expect(config.breakerOpenMs).toBe(30000);
		expect(config.maxInflight).toBe(256);
		expect(config.drainMs).toBe(5000);
		expect(config.retentionDays).toBe(30);
		expect(config.auditLog).toBe(true);
	});

	test("zero is valid for the breaker, drain and retention settings where documented", () => {
		const env = baseEnv();
		env.ULTRATHINK_BREAKER_FAILURES = "0";
		env.ULTRATHINK_DRAIN_MS = "0";
		env.ULTRATHINK_RETENTION_DAYS = "0";
		const config = loadConfig(env);
		expect(config.breakerFailures).toBe(0);
		expect(config.drainMs).toBe(0);
		expect(config.retentionDays).toBe(0);
	});

	const ranges = [
		{ name: "ULTRATHINK_BREAKER_FAILURES", field: "breakerFailures", min: "0", max: "100" },
		{ name: "ULTRATHINK_BREAKER_WINDOW_MS", field: "breakerWindowMs", min: "1000", max: "3600000" },
		{ name: "ULTRATHINK_BREAKER_OPEN_MS", field: "breakerOpenMs", min: "1000", max: "600000" },
		{ name: "ULTRATHINK_MAX_INFLIGHT", field: "maxInflight", min: "1", max: "10000" },
		{ name: "ULTRATHINK_DRAIN_MS", field: "drainMs", min: "0", max: "60000" },
		{ name: "ULTRATHINK_RETENTION_DAYS", field: "retentionDays", min: "0", max: "3650" },
	] as const;

	for (const range of ranges) {
		test(`${range.name} accepts its bounds`, () => {
			for (const value of [range.min, range.max]) {
				const env = baseEnv();
				env[range.name] = value;
				expect(loadConfig(env)[range.field]).toBe(Number(value));
			}
		});

		test(`${range.name} rejects values outside its bounds, naming the variable`, () => {
			for (const value of [String(Number(range.max) + 1), "-1", "1.5"]) {
				const env = baseEnv();
				env[range.name] = value;
				const message = messageOf(() => loadConfig(env));
				expect(message).toContain(range.name);
				expect(message).not.toContain(value);
			}
		});
	}

	test("ULTRATHINK_AUDIT_LOG=0 turns the audit log off and 1 turns it on", () => {
		const env = baseEnv();
		env.ULTRATHINK_AUDIT_LOG = "0";
		expect(loadConfig(env).auditLog).toBe(false);
		env.ULTRATHINK_AUDIT_LOG = "1";
		expect(loadConfig(env).auditLog).toBe(true);
	});

	test("ULTRATHINK_AUDIT_LOG accepts only 0 or 1", () => {
		const env = baseEnv();
		env.ULTRATHINK_AUDIT_LOG = "true";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_AUDIT_LOG");
	});
});

describe("audit sink configuration", () => {
	test("defaults with no audit variables set match the documented table", () => {
		const config = loadConfig(baseEnv());
		expect(config.auditAnchorEvery).toBe(1000);
		expect(config.auditSegmentBytes).toBe(67108864);
		expect(config.auditRetentionDays).toBe(365);
		expect(config.auditWatchMs).toBe(1000);
		expect(config.auditSinkQueue).toBe(10000);
		expect(config.auditRules).toBeUndefined();
		expect(config.auditHttpUrl).toBeUndefined();
		expect(config.auditHttpToken).toBeUndefined();
		expect(config.auditSyslog).toBeUndefined();
		expect(config.auditKafkaRestUrl).toBeUndefined();
		expect(config.auditKafkaTopic).toBeUndefined();
	});

	const integerFields = [
		{ name: "ULTRATHINK_AUDIT_ANCHOR_EVERY", field: "auditAnchorEvery", min: 1, max: 1000000 },
		{
			name: "ULTRATHINK_AUDIT_SEGMENT_BYTES",
			field: "auditSegmentBytes",
			min: 1048576,
			max: 4294967296,
		},
		{ name: "ULTRATHINK_AUDIT_RETENTION_DAYS", field: "auditRetentionDays", min: 0, max: 36500 },
		{ name: "ULTRATHINK_AUDIT_WATCH_MS", field: "auditWatchMs", min: 100, max: 1000 },
		{ name: "ULTRATHINK_AUDIT_SINK_QUEUE", field: "auditSinkQueue", min: 1, max: 1000000 },
	] as const;

	for (const spec of integerFields) {
		test(`${spec.name} accepts its lowest and highest value`, () => {
			expect(loadConfig({ ...baseEnv(), [spec.name]: String(spec.min) })[spec.field]).toBe(
				spec.min,
			);
			expect(loadConfig({ ...baseEnv(), [spec.name]: String(spec.max) })[spec.field]).toBe(
				spec.max,
			);
		});

		test(`${spec.name} rejects out-of-range or malformed values, naming the variable`, () => {
			for (const value of [String(spec.min - 1), String(spec.max + 1), "1e3", "abc"]) {
				expect(messageOf(() => loadConfig({ ...baseEnv(), [spec.name]: value }))).toContain(
					spec.name,
				);
			}
		});
	}

	test("ULTRATHINK_AUDIT_WATCH_MS rejects 1001 and 99 by name", () => {
		expect(
			messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_WATCH_MS: "1001" })),
		).toContain("ULTRATHINK_AUDIT_WATCH_MS");
		expect(
			messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_WATCH_MS: "99" })),
		).toContain("ULTRATHINK_AUDIT_WATCH_MS");
	});

	test("ULTRATHINK_AUDIT_RULES returns the parsed rules for a valid array", () => {
		const rules = [{ name: "login-burst", event: "login_failed", count: 5, windowSec: 60 }];
		expect(
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_RULES: JSON.stringify(rules) }).auditRules,
		).toEqual(rules);
	});

	test("ULTRATHINK_AUDIT_RULES rejects malformed JSON, non-array values and invalid rules, naming the variable", () => {
		for (const value of ["[", '{"name":"login-burst"}', '[{"name":"login-burst"}]']) {
			expect(
				messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_RULES: value })),
			).toContain("ULTRATHINK_AUDIT_RULES");
		}
	});

	test("ULTRATHINK_AUDIT_HTTP_URL accepts https and loopback http", () => {
		expect(
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_URL: "https://siem.example.com/ingest" })
				.auditHttpUrl,
		).toBe("https://siem.example.com/ingest");
		expect(
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_URL: "http://127.0.0.1:9" }).auditHttpUrl,
		).toBe("http://127.0.0.1:9");
	});

	test("ULTRATHINK_AUDIT_HTTP_URL rejects plaintext, non-loopback, credentialed and malformed URLs", () => {
		for (const value of [
			"http://example.com",
			"ftp://siem.example.com",
			"https://user:secret@siem.example.com",
			"http://user@127.0.0.1:9",
			"not a url",
		]) {
			const message = messageOf(() =>
				loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_URL: value }),
			);
			expect(message).toContain("ULTRATHINK_AUDIT_HTTP_URL");
			expect(message).not.toContain("secret");
		}
	});

	test("ULTRATHINK_AUDIT_HTTP_TOKEN accepts a printable token of 16 characters or more", () => {
		expect(
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_TOKEN: "abcdefghijklmnop" }).auditHttpToken,
		).toBe("abcdefghijklmnop");
	});

	test("ULTRATHINK_AUDIT_HTTP_TOKEN rejects short or malformed tokens without echoing them", () => {
		for (const token of ["short-token", "has space inside this token"]) {
			const message = messageOf(() =>
				loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_TOKEN: token }),
			);
			expect(message).toContain("ULTRATHINK_AUDIT_HTTP_TOKEN");
			expect(message).not.toContain(token);
		}
	});

	test("ULTRATHINK_AUDIT_SYSLOG parses host and port", () => {
		expect(
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_SYSLOG: "siem.example.com:514" }).auditSyslog,
		).toEqual({
			host: "siem.example.com",
			port: 514,
		});
	});

	test("ULTRATHINK_AUDIT_SYSLOG rejects ports outside 1..65535 and malformed targets, naming the variable", () => {
		for (const value of [
			"siem.example.com:0",
			"siem.example.com:70000",
			"siem.example.com",
			":514",
			"siem.example.com:",
			"siem.example.com:5x",
			"bad host:514",
		]) {
			expect(
				messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_SYSLOG: value })),
			).toContain("ULTRATHINK_AUDIT_SYSLOG");
		}
	});

	test("the Kafka REST sink needs its URL and its topic together", () => {
		const config = loadConfig({
			...baseEnv(),
			ULTRATHINK_AUDIT_KAFKA_REST_URL: "https://kafka-rest.example.com",
			ULTRATHINK_AUDIT_KAFKA_TOPIC: "audit",
		});
		expect(config.auditKafkaRestUrl).toBe("https://kafka-rest.example.com");
		expect(config.auditKafkaTopic).toBe("audit");

		const urlOnly = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_AUDIT_KAFKA_REST_URL: "https://kafka-rest.example.com",
			}),
		);
		expect(urlOnly).toContain("ULTRATHINK_AUDIT_KAFKA_TOPIC");

		const topicOnly = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_KAFKA_TOPIC: "audit" }),
		);
		expect(topicOnly).toContain("ULTRATHINK_AUDIT_KAFKA_REST_URL");
	});

	test("ULTRATHINK_AUDIT_KAFKA_REST_URL follows the HTTP URL rule", () => {
		const message = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_AUDIT_KAFKA_REST_URL: "http://example.com",
				ULTRATHINK_AUDIT_KAFKA_TOPIC: "audit",
			}),
		);
		expect(message).toContain("ULTRATHINK_AUDIT_KAFKA_REST_URL");
	});
});

describe("rate limiting settings", () => {
	test("apply the phase 70 defaults with an empty env", () => {
		const config = loadConfig(baseEnv());
		expect(config.priorityReservePct).toBe(25);
		expect(config.adaptiveQuotaMinPct).toBe(50);
		expect(config.lagTargetMs).toBe(100);
		expect(config.replicaCapacityRps).toBe(20);
		expect(config.abuseFailuresPerMinute).toBe(20);
		expect(config.penaltyBaseSec).toBe(60);
		expect(config.penaltyMaxSec).toBe(3600);
	});

	test("each variable overrides its default", () => {
		const env = baseEnv();
		env.ULTRATHINK_PRIORITY_RESERVE_PCT = "40";
		env.ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT = "30";
		env.ULTRATHINK_LAG_TARGET_MS = "250";
		env.ULTRATHINK_REPLICA_CAPACITY_RPS = "75";
		env.ULTRATHINK_ABUSE_FAILURES_PER_MINUTE = "5";
		env.ULTRATHINK_PENALTY_BASE_SEC = "120";
		env.ULTRATHINK_PENALTY_MAX_SEC = "1800";
		const config = loadConfig(env);
		expect(config.priorityReservePct).toBe(40);
		expect(config.adaptiveQuotaMinPct).toBe(30);
		expect(config.lagTargetMs).toBe(250);
		expect(config.replicaCapacityRps).toBe(75);
		expect(config.abuseFailuresPerMinute).toBe(5);
		expect(config.penaltyBaseSec).toBe(120);
		expect(config.penaltyMaxSec).toBe(1800);
	});

	const ranges = [
		{ name: "ULTRATHINK_PRIORITY_RESERVE_PCT", field: "priorityReservePct", min: "0", max: "90" },
		{
			name: "ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT",
			field: "adaptiveQuotaMinPct",
			min: "10",
			max: "100",
		},
		{ name: "ULTRATHINK_LAG_TARGET_MS", field: "lagTargetMs", min: "10", max: "5000" },
		{
			name: "ULTRATHINK_REPLICA_CAPACITY_RPS",
			field: "replicaCapacityRps",
			min: "1",
			max: "100000",
		},
		{
			name: "ULTRATHINK_ABUSE_FAILURES_PER_MINUTE",
			field: "abuseFailuresPerMinute",
			min: "1",
			max: "10000",
		},
		{ name: "ULTRATHINK_FAIR_QUEUE_DEPTH", field: "fairQueueDepth", min: "0", max: "1000" },
		{ name: "ULTRATHINK_FAIR_QUEUE_WAIT_MS", field: "fairQueueWaitMs", min: "1", max: "60000" },
	] as const;

	for (const range of ranges) {
		test(`${range.name} accepts its bounds`, () => {
			for (const value of [range.min, range.max]) {
				const env = baseEnv();
				env[range.name] = value;
				expect(loadConfig(env)[range.field]).toBe(Number(value));
			}
		});

		test(`${range.name} rejects values outside its bounds, naming the variable`, () => {
			for (const value of [String(Number(range.max) + 1), "-1", "1.5"]) {
				const env = baseEnv();
				env[range.name] = value;
				const message = messageOf(() => loadConfig(env));
				expect(message).toContain(range.name);
				expect(message).not.toContain(value);
			}
		});
	}

	test("penalty base accepts 1 and 86400 when the cap allows it", () => {
		const low = baseEnv();
		low.ULTRATHINK_PENALTY_BASE_SEC = "1";
		expect(loadConfig(low).penaltyBaseSec).toBe(1);
		const high = baseEnv();
		high.ULTRATHINK_PENALTY_BASE_SEC = "86400";
		high.ULTRATHINK_PENALTY_MAX_SEC = "86400";
		expect(loadConfig(high).penaltyBaseSec).toBe(86400);
	});

	test("penalty base and max reject values outside 1..86400, naming the variable", () => {
		for (const name of ["ULTRATHINK_PENALTY_BASE_SEC", "ULTRATHINK_PENALTY_MAX_SEC"]) {
			for (const value of ["0", "86401", "-1", "1.5"]) {
				const env = baseEnv();
				env[name] = value;
				expect(messageOf(() => loadConfig(env))).toContain(name);
			}
		}
	});

	test("a penalty max below the penalty base throws a ConfigError naming both variables", () => {
		const env = baseEnv();
		env.ULTRATHINK_PENALTY_BASE_SEC = "600";
		env.ULTRATHINK_PENALTY_MAX_SEC = "300";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PENALTY_MAX_SEC");
		expect(message).toContain("ULTRATHINK_PENALTY_BASE_SEC");
	});

	test("a penalty max equal to the penalty base is accepted", () => {
		const env = baseEnv();
		env.ULTRATHINK_PENALTY_BASE_SEC = "300";
		env.ULTRATHINK_PENALTY_MAX_SEC = "300";
		const config = loadConfig(env);
		expect(config.penaltyBaseSec).toBe(300);
		expect(config.penaltyMaxSec).toBe(300);
	});
});

describe("ULTRATHINK_OTLP_ENDPOINT", () => {
	test("unset and empty both give undefined", () => {
		expect(loadConfig(baseEnv()).otlpEndpoint).toBeUndefined();
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: "" }).otlpEndpoint).toBeUndefined();
	});

	test("a trailing slash is removed from the stored endpoint", () => {
		expect(
			loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: "https://collector.example/otel/" })
				.otlpEndpoint,
		).toBe("https://collector.example/otel");
	});

	test("plaintext http is refused for a non-loopback host", () => {
		const message = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: "http://collector.example:4318" }),
		);
		expect(message).toContain("ULTRATHINK_OTLP_ENDPOINT");
	});

	test("http is accepted for 127.0.0.1, localhost and [::1]", () => {
		for (const value of ["http://127.0.0.1:4318", "http://localhost:4318", "http://[::1]:4318"]) {
			expect(loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: value }).otlpEndpoint).toBe(
				value,
			);
		}
	});

	test("credentials, a query or a fragment are refused, and the message echoes neither the secret nor the query", () => {
		for (const value of [
			"https://user:secret@collector.example",
			"https://collector.example/?key=1",
			"https://collector.example/#key=1",
		]) {
			const message = messageOf(() =>
				loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: value }),
			);
			expect(message).toContain("ULTRATHINK_OTLP_ENDPOINT");
			expect(message).not.toContain("secret");
			expect(message).not.toContain("key=1");
		}
	});
});

const TLS_PATHS = {
	ULTRATHINK_TLS_CERT: "/etc/ultrathink/tls/app/cert.pem",
	ULTRATHINK_TLS_KEY: "/etc/ultrathink/tls/app/key.pem",
	ULTRATHINK_TLS_CLIENT_CA: "/etc/ultrathink/tls/ca.pem",
};

function tlsEnv(): Record<string, string | undefined> {
	const env = baseEnv();
	delete env.ULTRATHINK_PLAINTEXT_LOOPBACK;
	return { ...env, ...TLS_PATHS };
}

describe("mTLS and plaintext opt-in", () => {
	test("no TLS and no opt-in throws, naming the three TLS variables and the opt-in", () => {
		const env = baseEnv();
		delete env.ULTRATHINK_PLAINTEXT_LOOPBACK;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_TLS_CERT");
		expect(message).toContain("ULTRATHINK_TLS_KEY");
		expect(message).toContain("ULTRATHINK_TLS_CLIENT_CA");
		expect(message).toContain("ULTRATHINK_PLAINTEXT_LOOPBACK");
	});

	test("ULTRATHINK_PLAINTEXT_LOOPBACK=0 is not an opt-in", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLAINTEXT_LOOPBACK = "0";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_TLS_CERT");
	});

	test("a partial TLS set throws naming only the missing variables, even with the opt-in", () => {
		const env = {
			...baseEnv(),
			ULTRATHINK_TLS_CERT: TLS_PATHS.ULTRATHINK_TLS_CERT,
			ULTRATHINK_TLS_KEY: TLS_PATHS.ULTRATHINK_TLS_KEY,
		};
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("missing ULTRATHINK_TLS_CLIENT_CA");
		expectProblem(
			message,
			"ULTRATHINK_TLS_CERT, ULTRATHINK_TLS_KEY, ULTRATHINK_TLS_CLIENT_CA must be set together; missing ULTRATHINK_TLS_CLIENT_CA",
		);
		expect(message).not.toContain("missing ULTRATHINK_TLS_CERT");
		expect(message).not.toContain("missing ULTRATHINK_TLS_KEY");
	});

	test("a single TLS variable names both of the others as missing", () => {
		const env = { ...tlsEnv(), ULTRATHINK_TLS_CERT: undefined, ULTRATHINK_TLS_KEY: undefined };
		expect(messageOf(() => loadConfig(env))).toContain(
			"missing ULTRATHINK_TLS_CERT, ULTRATHINK_TLS_KEY",
		);
	});

	test("full TLS with absolute paths loads with tls set and the default trust domain", () => {
		const config = loadConfig(tlsEnv());
		expect(config.tls).toEqual({
			certFile: TLS_PATHS.ULTRATHINK_TLS_CERT,
			keyFile: TLS_PATHS.ULTRATHINK_TLS_KEY,
			clientCaFile: TLS_PATHS.ULTRATHINK_TLS_CLIENT_CA,
		});
		expect(config.spiffeTrustDomain).toBe("ultrathink.internal");
		expect(config.plaintextLoopback).toBe(false);
	});

	test("TLS set together with the opt-in keeps tls set", () => {
		const config = loadConfig({ ...baseEnv(), ...TLS_PATHS });
		expect(config.tls?.certFile).toBe(TLS_PATHS.ULTRATHINK_TLS_CERT);
		expect(config.plaintextLoopback).toBe(true);
	});

	test("ULTRATHINK_PLAINTEXT_LOOPBACK=1 with no TLS loads with tls undefined", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLAINTEXT_LOOPBACK = "1";
		const config = loadConfig(env);
		expect(config.tls).toBeUndefined();
		expect(config.plaintextLoopback).toBe(true);
	});

	test("ULTRATHINK_PLAINTEXT_LOOPBACK must be 0 or 1", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLAINTEXT_LOOPBACK = "yes";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PLAINTEXT_LOOPBACK must be 0 or 1");
		expectProblem(message, "ULTRATHINK_PLAINTEXT_LOOPBACK must be 0 or 1");
	});

	test("a relative TLS path throws naming the variable and not the path", () => {
		const env = { ...tlsEnv(), ULTRATHINK_TLS_KEY: "tls/app/key.pem" };
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_TLS_KEY must be an absolute path");
		expectProblem(message, "ULTRATHINK_TLS_KEY must be an absolute path");
		expect(message).not.toContain("tls/app/key.pem");
	});

	test("a lowercase trust domain with dots, dashes and underscores is accepted", () => {
		const config = loadConfig({
			...tlsEnv(),
			ULTRATHINK_SPIFFE_TRUST_DOMAIN: "spiffe.example-1_x",
		});
		expect(config.spiffeTrustDomain).toBe("spiffe.example-1_x");
	});

	test("an uppercase trust domain throws naming the variable and not the value", () => {
		const env = { ...tlsEnv(), ULTRATHINK_SPIFFE_TRUST_DOMAIN: "Ultrathink.Internal" };
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_SPIFFE_TRUST_DOMAIN");
		expect(message).not.toContain("Ultrathink.Internal");
	});

	test("a trust domain is limited to 255 characters", () => {
		expect(
			loadConfig({ ...tlsEnv(), ULTRATHINK_SPIFFE_TRUST_DOMAIN: "a".repeat(255) })
				.spiffeTrustDomain,
		).toBe("a".repeat(255));
		expect(() =>
			loadConfig({ ...tlsEnv(), ULTRATHINK_SPIFFE_TRUST_DOMAIN: "a".repeat(256) }),
		).toThrow(ConfigError);
	});
});

describe("loadConfig chaos gate", () => {
	const PLAN = "/var/lib/ultrathink-chaos/plan.json";

	function withEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
		return { ...baseEnv(), ...extra };
	}

	test("chaos is off by default and carries no plan path", () => {
		const config = loadConfig(baseEnv());
		expect(config.chaosEnabled).toBe(false);
		expect(config.chaosEnv).toBeUndefined();
		expect(config.chaosPlanPath).toBeUndefined();
	});

	test("ULTRATHINK_CHAOS=0 keeps chaos off", () => {
		expect(loadConfig(withEnv({ ULTRATHINK_CHAOS: "0" })).chaosEnabled).toBe(false);
	});

	test("a blank plan path counts as unset while chaos is off", () => {
		expect(loadConfig(withEnv({ ULTRATHINK_CHAOS_PLAN: "   " })).chaosPlanPath).toBeUndefined();
	});

	test("ULTRATHINK_CHAOS=1 with staging and an absolute plan path loads", () => {
		const config = loadConfig(
			withEnv({
				ULTRATHINK_CHAOS: "1",
				ULTRATHINK_CHAOS_ENV: "staging",
				ULTRATHINK_CHAOS_PLAN: PLAN,
			}),
		);
		expect(config.chaosEnabled).toBe(true);
		expect(config.chaosEnv).toBe("staging");
		expect(config.chaosPlanPath).toBe(PLAN);
	});

	test("ULTRATHINK_CHAOS=1 without ULTRATHINK_CHAOS_ENV throws naming the variable", () => {
		const message = messageOf(() =>
			loadConfig(withEnv({ ULTRATHINK_CHAOS: "1", ULTRATHINK_CHAOS_PLAN: PLAN })),
		);
		expect(message).toContain("ULTRATHINK_CHAOS_ENV");
	});

	test("ULTRATHINK_CHAOS=1 refuses a production environment", () => {
		const message = messageOf(() =>
			loadConfig(
				withEnv({
					ULTRATHINK_CHAOS: "1",
					ULTRATHINK_CHAOS_ENV: "production",
					ULTRATHINK_CHAOS_PLAN: PLAN,
				}),
			),
		);
		expect(message).toContain("ULTRATHINK_CHAOS_ENV");
	});

	test("ULTRATHINK_CHAOS=1 without a plan path throws naming the variable", () => {
		const message = messageOf(() =>
			loadConfig(withEnv({ ULTRATHINK_CHAOS: "1", ULTRATHINK_CHAOS_ENV: "staging" })),
		);
		expect(message).toContain("ULTRATHINK_CHAOS_PLAN");
	});

	test("a relative plan path throws naming the variable and not the path", () => {
		const relative = "plans/faults.json";
		const message = messageOf(() =>
			loadConfig(
				withEnv({
					ULTRATHINK_CHAOS: "1",
					ULTRATHINK_CHAOS_ENV: "staging",
					ULTRATHINK_CHAOS_PLAN: relative,
				}),
			),
		);
		expect(message).toContain("ULTRATHINK_CHAOS_PLAN");
		expect(message).not.toContain(relative);
	});

	test("a plan path without ULTRATHINK_CHAOS=1 throws naming the variable", () => {
		const message = messageOf(() => loadConfig(withEnv({ ULTRATHINK_CHAOS_PLAN: PLAN })));
		expect(message).toContain("ULTRATHINK_CHAOS_PLAN");
	});

	test("a plan path with ULTRATHINK_CHAOS=0 throws naming the variable", () => {
		const message = messageOf(() =>
			loadConfig(
				withEnv({
					ULTRATHINK_CHAOS: "0",
					ULTRATHINK_CHAOS_ENV: "staging",
					ULTRATHINK_CHAOS_PLAN: PLAN,
				}),
			),
		);
		expect(message).toContain("ULTRATHINK_CHAOS_PLAN");
	});

	test("ULTRATHINK_CHAOS other than 0 or 1 throws naming the variable", () => {
		const message = messageOf(() => loadConfig(withEnv({ ULTRATHINK_CHAOS: "true" })));
		expect(message).toContain("ULTRATHINK_CHAOS must be 0 or 1");
		expectProblem(message, "ULTRATHINK_CHAOS must be 0 or 1");
	});
});

describe("planning backend", () => {
	test("defaults to the Claude route model, no fallback and concurrency 2", () => {
		const config = loadConfig(baseEnv());
		expect(config.planFallback).toBe("none");
		expect(config.planConcurrency).toBe(2);
		expect(config.planningModel).toBe(ROUTE_DEFAULT_MODELS.claude);
	});

	test("the fallback accepts none and grok only", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_PLANNING_FALLBACK: "grok" }).planFallback).toBe(
			"grok",
		);
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_PLANNING_FALLBACK: "none" }).planFallback).toBe(
			"none",
		);
		const message = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_PLANNING_FALLBACK: "sekrit-fallback" }),
		);
		expect(message).toContain("ULTRATHINK_PLANNING_FALLBACK");
		expect(message).not.toContain("sekrit-fallback");
	});

	test("concurrency accepts 1..6 and rejects anything else", () => {
		const withConcurrency = (value: string) => ({
			...baseEnv(),
			ULTRATHINK_PLAN_CONCURRENCY: value,
		});
		expect(loadConfig(withConcurrency("1")).planConcurrency).toBe(1);
		expect(loadConfig(withConcurrency("6")).planConcurrency).toBe(6);
		for (const value of ["0", "7", "2.5", "-1", "abc"]) {
			const message = messageOf(() => loadConfig(withConcurrency(value)));
			expect(message).toContain("ULTRATHINK_PLAN_CONCURRENCY");
		}
	});

	test("any ULTRATHINK_PLANNING_BACKEND value is a ConfigError that never echoes it", () => {
		for (const value of ["plan", "openrouter", "sekrit-backend"]) {
			const message = messageOf(() =>
				loadConfig({ ...baseEnv(), ULTRATHINK_PLANNING_BACKEND: value }),
			);
			expect(message).toBe(
				"ultrathink: 1 configuration problems\n  ULTRATHINK_PLANNING_BACKEND was removed: the hosted planner always runs on the Claude plan login; OpenRouter is reserved for Jev decisions. Remove the line.",
			);
		}
	});
});

describe("legacyEnvIgnored", () => {
	test("is empty when none of the removed variables is set", () => {
		expect(loadConfig(baseEnv()).legacyEnvIgnored).toEqual([]);
	});

	test("lists the names of the removed variables that are set, sorted, and never a value", () => {
		const secret = "sk-or-sekrit-value-0123456789";
		const config = loadConfig({
			...baseEnv(),
			ULTRATHINK_OPENROUTER_KEY: secret,
			OPENROUTER_API_KEY: secret,
			ULTRATHINK_OPENROUTER_BASE_URL: "https://example.test/v1",
			ULTRATHINK_MODEL_REASONING_EFFORT: "high",
		});
		expect(config.legacyEnvIgnored).toEqual([
			"OPENROUTER_API_KEY",
			"ULTRATHINK_MODEL_REASONING_EFFORT",
			"ULTRATHINK_OPENROUTER_BASE_URL",
			"ULTRATHINK_OPENROUTER_KEY",
		]);
		expect(JSON.stringify(config.legacyEnvIgnored)).not.toContain(secret);
	});

	test("a blank value counts as unset", () => {
		expect(
			loadConfig({ ...baseEnv(), OPENROUTER_API_KEY: "  ", ULTRATHINK_OPENROUTER_KEY: "" })
				.legacyEnvIgnored,
		).toEqual([]);
	});
});

describe("loadConfig aggregation", () => {
	test("three bad variables throw one ConfigError listing all three in reader order", () => {
		const env: Record<string, string | undefined> = {
			...baseEnv(),
			ULTRATHINK_PORT: "80",
			ULTRATHINK_TLS_CERT: TLS_PATHS.ULTRATHINK_TLS_CERT,
		};
		delete env.ULTRATHINK_PUBLIC_ORIGIN;
		expect(messageOf(() => loadConfig(env)).split("\n")).toEqual([
			"ultrathink: 3 configuration problems",
			"  ULTRATHINK_PUBLIC_ORIGIN is required",
			"  ULTRATHINK_PORT must be an integer between 1024 and 65535",
			"  ULTRATHINK_TLS_CERT, ULTRATHINK_TLS_KEY, ULTRATHINK_TLS_CLIENT_CA must be set together; missing ULTRATHINK_TLS_KEY, ULTRATHINK_TLS_CLIENT_CA",
		]);
	});

	test("a single bad variable keeps the plural header and its original text", () => {
		expect(
			messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_PORT: "80" })).split("\n"),
		).toEqual([
			"ultrathink: 1 configuration problems",
			"  ULTRATHINK_PORT must be an integer between 1024 and 65535",
		]);
	});

	test("cross-variable checks run next to ordinary ones: partial TLS and a bad port both appear", () => {
		const message = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_PORT: "80",
				ULTRATHINK_TLS_KEY: TLS_PATHS.ULTRATHINK_TLS_KEY,
			}),
		);
		expect(message.split("\n")[0]).toBe("ultrathink: 2 configuration problems");
		expect(message).toContain("ULTRATHINK_PORT must be an integer between 1024 and 65535");
		expect(message).toContain("missing ULTRATHINK_TLS_CERT, ULTRATHINK_TLS_CLIENT_CA");
	});

	test("the penalty order is judged only when both values parsed", () => {
		const broken = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_PENALTY_BASE_SEC: "abc",
				ULTRATHINK_PENALTY_MAX_SEC: "5",
			}),
		);
		expect(broken.split("\n")).toEqual([
			"ultrathink: 1 configuration problems",
			"  ULTRATHINK_PENALTY_BASE_SEC must be an integer between 1 and 86400",
		]);
		const crossed = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_PENALTY_BASE_SEC: "600",
				ULTRATHINK_PENALTY_MAX_SEC: "300",
				ULTRATHINK_DRAIN_MS: "-1",
			}),
		);
		expect(crossed.split("\n")[0]).toBe("ultrathink: 2 configuration problems");
		expect(crossed).toContain("ULTRATHINK_DRAIN_MS must be an integer between 0 and 60000");
		expect(crossed).toContain(
			"ULTRATHINK_PENALTY_MAX_SEC must be greater than or equal to ULTRATHINK_PENALTY_BASE_SEC",
		);
	});

	test("a rejected Kafka URL does not also report the missing topic, and a missing topic still does", () => {
		const rejected = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_KAFKA_REST_URL: "http://example.com" }),
		);
		expect(rejected.split("\n")).toEqual([
			"ultrathink: 1 configuration problems",
			"  ULTRATHINK_AUDIT_KAFKA_REST_URL must use https://, or http:// to 127.0.0.1 or localhost",
		]);
		const unpaired = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_AUDIT_KAFKA_REST_URL: "https://kafka-rest.example.com",
				ULTRATHINK_AUDIT_LOG: "2",
			}),
		);
		expect(unpaired.split("\n")[0]).toBe("ultrathink: 2 configuration problems");
		expect(unpaired).toContain("ULTRATHINK_AUDIT_LOG must be 0 or 1");
		expect(unpaired).toContain(
			"ULTRATHINK_AUDIT_KAFKA_REST_URL and ULTRATHINK_AUDIT_KAFKA_TOPIC must be set together",
		);
	});

	test("a rejected gate flag does not add problems that depend on its value", () => {
		const plaintext = messageOf(() => {
			const env = baseEnv();
			env.ULTRATHINK_PLAINTEXT_LOOPBACK = "yes";
			return loadConfig(env);
		});
		expect(plaintext.split("\n")).toEqual([
			"ultrathink: 1 configuration problems",
			"  ULTRATHINK_PLAINTEXT_LOOPBACK must be 0 or 1",
		]);
		const chaos = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_CHAOS: "true",
				ULTRATHINK_CHAOS_PLAN: "/var/lib/ultrathink-chaos/plan.json",
			}),
		);
		expect(chaos.split("\n")).toEqual([
			"ultrathink: 1 configuration problems",
			"  ULTRATHINK_CHAOS must be 0 or 1",
		]);
	});

	test("chaos reports a wrong environment and a missing plan together", () => {
		const message = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_CHAOS: "1", ULTRATHINK_CHAOS_ENV: "production" }),
		);
		expect(message.split("\n")).toEqual([
			"ultrathink: 2 configuration problems",
			"  ULTRATHINK_CHAOS=1 requires ULTRATHINK_CHAOS_ENV=staging; chaos never runs outside staging",
			"  ULTRATHINK_CHAOS=1 requires ULTRATHINK_CHAOS_PLAN to be set",
		]);
	});

	test("the block names every bad variable and echoes no value planted in any of them", () => {
		const env: Record<string, string | undefined> = {
			...baseEnv(),
			ULTRATHINK_STATE_DIR: "relative-STATECANARY",
			ULTRATHINK_PLANNING_MODEL: "bad CANARYMODEL!",
			ULTRATHINK_PUBLIC_ORIGIN: "https://user:CANARYPW@origin.example",
			ULTRATHINK_OWNER_PASSWORD_HASH: "$argon2id$HASHCANARY",
			ULTRATHINK_SESSION_SECRET: "sk-or-v1-CANARYSHORT",
			ULTRATHINK_SESSION_SECRET_PREVIOUS: "sk-or-v1-CANARYPREVIOUS",
			ULTRATHINK_CONNECTOR_KEY: "sk-or-v1-CANARYCANARYCANARY1234",
			ULTRATHINK_ALLOWED_ORIGINS: "ftp://CANARYORIGIN",
			ULTRATHINK_AUDIT_RULES: '[{"name":"RULECANARY","bogusCANARY":1}]',
			ULTRATHINK_AUDIT_HTTP_URL: "https://user:CANARYPW@collector.example",
			ULTRATHINK_AUDIT_HTTP_TOKEN: "TOKENCANARY",
			ULTRATHINK_AUDIT_SYSLOG: "SYSLOGCANARY",
			ULTRATHINK_OTLP_ENDPOINT: "https://user:CANARYPW@otel.example",
			ULTRATHINK_TLS_CERT: "relative/CERTCANARY.pem",
			ULTRATHINK_TLS_KEY: "relative/KEYCANARY.pem",
			ULTRATHINK_TLS_CLIENT_CA: "relative/CACANARY.pem",
			ULTRATHINK_SPIFFE_TRUST_DOMAIN: "TrustCANARY.Domain",
			ULTRATHINK_CHAOS: "1",
			ULTRATHINK_CHAOS_ENV: "staging",
			ULTRATHINK_CHAOS_PLAN: "relative/CHAOSCANARY.json",
			ULTRATHINK_AUDIT_KAFKA_REST_URL: "http://KAFKACANARY.example",
			ULTRATHINK_AUDIT_KAFKA_TOPIC: "TOPICCANARY",
		};
		const names = [
			"ULTRATHINK_STATE_DIR",
			"ULTRATHINK_PLANNING_MODEL",
			"ULTRATHINK_PUBLIC_ORIGIN",
			"ULTRATHINK_OWNER_PASSWORD_HASH",
			"ULTRATHINK_SESSION_SECRET",
			"ULTRATHINK_SESSION_SECRET_PREVIOUS",
			"ULTRATHINK_CONNECTOR_KEY",
			"ULTRATHINK_ALLOWED_ORIGINS",
			"ULTRATHINK_AUDIT_RULES",
			"ULTRATHINK_AUDIT_HTTP_URL",
			"ULTRATHINK_AUDIT_HTTP_TOKEN",
			"ULTRATHINK_AUDIT_SYSLOG",
			"ULTRATHINK_OTLP_ENDPOINT",
			"ULTRATHINK_TLS_CERT",
			"ULTRATHINK_TLS_KEY",
			"ULTRATHINK_TLS_CLIENT_CA",
			"ULTRATHINK_SPIFFE_TRUST_DOMAIN",
			"ULTRATHINK_CHAOS_PLAN",
			"ULTRATHINK_AUDIT_KAFKA_REST_URL",
		];
		const lines = messageOf(() => loadConfig(env)).split("\n");
		expect(lines[0]).toBe(`ultrathink: ${names.length} configuration problems`);
		expect(lines).toHaveLength(names.length + 1);
		names.forEach((name, index) => {
			expect(lines[index + 1]).toStartWith(`  ${name}`);
		});
		const block = lines.join("\n");
		for (const secret of ["CANARY", "$argon2id", "user:", "relative", "bogus"]) {
			expect(block).not.toContain(secret);
		}
	});
});
