// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { stackSummaryLine } from "./summary.ts";

const CANARY = "sk-or-v1-CANARYCANARYCANARY1234";

let dir: string;
let checkout: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-stack-summary-"));
	checkout = join(dir, "swarm");
	mkdirSync(join(checkout, "hooks"), { recursive: true });
	writeFileSync(join(checkout, "hooks", "autonomous_run.py"), "");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** An env that never reaches the real credential store, config or home directory. */
function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
	return {
		ULTRATHINK_MCP_STORE: join(dir, "no-such-store.json"),
		XDG_CONFIG_HOME: join(dir, "xdg"),
		HOME: join(dir, "home"),
		...over,
	};
}

function hindsightOn(): UltrathinkConfig {
	const config = defaultConfig();
	config.hindsight = { ...config.hindsight, enabled: true, url: "https://hindsight.example.test" };
	return config;
}

describe("stackSummaryLine", () => {
	test("all five ready renders a single bucket", () => {
		const line = stackSummaryLine(
			hindsightOn(),
			env({
				SUBSTRATE_URL: "https://substrate.example.test",
				ULTRATHINK_SWARM_ROOT: checkout,
				AI_GATEWAY_API_KEY: CANARY,
				HINDSIGHT_API_KEY: CANARY,
			}),
			{ existsPath: () => true },
		);
		expect(line).toBe("Stack: 5 ready (run ultrathink stack)");
	});

	test("mixed members render ready, off and missing in fixed order and omit empty buckets", () => {
		// substrate ready, swarm missing (no root), realm ready, decisions off (kill switch), hindsight missing (no key).
		const line = stackSummaryLine(
			hindsightOn(),
			env({ SUBSTRATE_URL: "https://substrate.example.test", ULTRATHINK_DECISIONS: "0" }),
			{ existsPath: () => true },
		);
		expect(line).toBe("Stack: 2 ready · 1 off · 2 missing (run ultrathink stack)");
	});

	test("everything switched off leaves only swarm, which has no off state, as missing", () => {
		const line = stackSummaryLine(
			defaultConfig(),
			env({
				SUBSTRATE_DISABLED: "1",
				SUBSTRATE_URL: "https://substrate.example.test",
				ULTRATHINK_REALM: " OFF ",
				ULTRATHINK_DECISIONS: "0",
				ULTRATHINK_HINDSIGHT: "0",
			}),
			{ existsPath: () => true },
		);
		expect(line).toBe("Stack: 4 off · 1 missing (run ultrathink stack)");
	});

	test("decisions is ready from a stored key and missing when only OPENROUTER_API_KEY is exported", () => {
		const store = join(dir, "store.json");
		writeFileSync(
			store,
			JSON.stringify({
				version: 1,
				providers: { openrouter: { kind: "api_key", apiKey: CANARY, updatedAt: 1 } },
			}),
		);
		const base = { SUBSTRATE_DISABLED: "1", ULTRATHINK_REALM: "off" };
		const config = defaultConfig();
		const withStore = stackSummaryLine(config, env({ ...base, ULTRATHINK_MCP_STORE: store }));
		const exportedOnly = stackSummaryLine(config, env({ ...base, OPENROUTER_API_KEY: CANARY }));
		expect(withStore).toBe("Stack: 1 ready · 3 off · 1 missing (run ultrathink stack)");
		expect(exportedOnly).toBe("Stack: 3 off · 2 missing (run ultrathink stack)");
	});

	test("realm readiness stats the config path Realm derives: absolute XDG, else absolute HOME, else none", () => {
		const seen: string[] = [];
		const existsPath = (path: string): boolean => {
			seen.push(path);
			return true;
		};
		const base = { SUBSTRATE_DISABLED: "1", ULTRATHINK_DECISIONS: "0", ULTRATHINK_HINDSIGHT: "0" };
		const abs = env({ ...base, XDG_CONFIG_HOME: "/abs/xdg", HOME: "/abs/home" });
		stackSummaryLine(defaultConfig(), abs, { existsPath });
		const relXdg = env({ ...base, XDG_CONFIG_HOME: "rel/xdg", HOME: "/abs/home" });
		stackSummaryLine(defaultConfig(), relXdg, { existsPath });
		expect(seen).toEqual(["/abs/xdg/realm/config.json", "/abs/home/.config/realm/config.json"]);

		seen.length = 0;
		const none = stackSummaryLine(
			defaultConfig(),
			env({ ...base, XDG_CONFIG_HOME: "rel", HOME: "rel" }),
			{ existsPath },
		);
		// No derivable path: realm is missing without any stat.
		expect(seen).toEqual([]);
		expect(none).toBe("Stack: 3 off · 2 missing (run ultrathink stack)");
	});

	test("no input value appears in the line", () => {
		const config = defaultConfig();
		config.hindsight = {
			...config.hindsight,
			enabled: true,
			url: "https://CANARYCANARYhost.example.test",
		};
		config.substrate = { ...config.substrate, url: "https://CANARYCANARYsubstrate.example.test" };
		const line = stackSummaryLine(
			config,
			env({
				SUBSTRATE_TOKEN: CANARY,
				SUBSTRATE_URL: "https://CANARYCANARYsubstrate.example.test/x",
				HINDSIGHT_API_KEY: CANARY,
				HINDSIGHT_API_URL: "https://CANARYCANARYhindsight.example.test",
				AI_GATEWAY_API_KEY: CANARY,
				ULTRATHINK_OPENROUTER_KEY: CANARY,
				ULTRATHINK_SWARM_ROOT: "/CANARYCANARYroot",
				XDG_CONFIG_HOME: "/CANARYCANARYxdg",
				OPENROUTER_API_KEY: CANARY,
			}),
			{ existsPath: () => true },
		);
		expect(line).not.toContain("CANARY");
		expect(line).toMatch(/^Stack: (\d+ (ready|off|missing)( · )?)+ \(run ultrathink stack\)$/);
	});

	test("renders with a throwing fetch and never reaches the realm stat when realm is opted out", () => {
		const realFetch = globalThis.fetch;
		const stats: string[] = [];
		globalThis.fetch = (() => {
			throw new Error("network reached");
		}) as unknown as typeof fetch;
		try {
			const line = stackSummaryLine(
				hindsightOn(),
				env({
					SUBSTRATE_URL: "https://substrate.example.test",
					ULTRATHINK_REALM: "off",
					AI_GATEWAY_API_KEY: CANARY,
					HINDSIGHT_API_KEY: CANARY,
				}),
				{
					existsPath: (path) => {
						stats.push(path);
						throw new Error("socket path reached");
					},
				},
			);
			expect(line).toBe("Stack: 3 ready · 1 off · 1 missing (run ultrathink stack)");
			expect(stats).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("a throwing stat seam still renders the line, counting realm as missing", () => {
		const line = stackSummaryLine(
			defaultConfig(),
			env({ SUBSTRATE_DISABLED: "1", ULTRATHINK_DECISIONS: "0", ULTRATHINK_HINDSIGHT: "0" }),
			{
				existsPath: () => {
					throw new Error("EACCES");
				},
			},
		);
		expect(line).toBe("Stack: 3 off · 2 missing (run ultrathink stack)");
	});

	describe("substrate readiness follows the selected backend", () => {
		// Only substrate varies: realm, decisions and hindsight are switched off and swarm has no root (missing).
		const quiet = { ULTRATHINK_REALM: "off", ULTRATHINK_DECISIONS: "0", ULTRATHINK_HINDSIGHT: "0" };
		const gateway = {
			ULTRATHINK_SUBSTRATE_BACKEND: "gateway",
			DESK_GATEWAY_URL: "https://gateway.example.test",
			DESK_GATEWAY_TOKEN: "ut7test",
		};

		test("a gateway backend with a usable gateway is ready without any Substrate URL", () => {
			const line = stackSummaryLine(defaultConfig(), env({ ...quiet, ...gateway }));
			expect(line).toBe("Stack: 1 ready · 3 off · 1 missing (run ultrathink stack)");
		});

		test("a gateway backend without a usable gateway is missing even when a Substrate URL is set", () => {
			const config = defaultConfig();
			config.substrate = { ...config.substrate, backend: "gateway" };
			const line = stackSummaryLine(
				config,
				env({ ...quiet, SUBSTRATE_URL: "https://substrate.example.test" }),
			);
			expect(line).toBe("Stack: 3 off · 2 missing (run ultrathink stack)");
		});

		test("the direct backend still reads off without a Substrate URL and ready with one", () => {
			const direct = { ...gateway, ULTRATHINK_SUBSTRATE_BACKEND: "direct" };
			expect(stackSummaryLine(defaultConfig(), env({ ...quiet, ...direct }))).toBe(
				"Stack: 4 off · 1 missing (run ultrathink stack)",
			);
			expect(
				stackSummaryLine(
					defaultConfig(),
					env({ ...quiet, ...direct, SUBSTRATE_URL: "https://substrate.example.test" }),
				),
			).toBe("Stack: 1 ready · 3 off · 1 missing (run ultrathink stack)");
		});

		test("SUBSTRATE_DISABLED=1 keeps a gateway-backed Substrate off", () => {
			const line = stackSummaryLine(
				defaultConfig(),
				env({ ...quiet, ...gateway, SUBSTRATE_DISABLED: "1" }),
			);
			expect(line).toBe("Stack: 4 off · 1 missing (run ultrathink stack)");
		});
	});
});
