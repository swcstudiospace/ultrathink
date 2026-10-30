// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeEngineSelector } from "./engine.ts";
import { defaultConfig, mergeConfig, type UltrathinkConfig } from "../config.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { engineLabel, GROK_LOGIN_REQUIRED, selectEngine, selectNativeEngine } from "./engine.ts";
import {
	AUTO,
	binder,
	configWith,
	createEngineFixtures,
	engineOf,
	fakeModel,
	fakeQuery,
	resolutionOf,
	skipOf,
} from "./engine-test.helpers.ts";

const { tempDir, emptyHome, grokLogin, claudeSpy, cleanup } = createEngineFixtures();
afterEach(cleanup);

describe("route defaults (AD-1, AC-15-042)", () => {
	test("unpinned Claude Code plans on the central map's Claude entry, recorded as a route default", async () => {
		const selected = engineOf(
			await selectEngine(defaultConfig(), {}, "/repo", { host: "claude-code" }),
		);
		expect(selected.label).toBe(`claude:${ROUTE_DEFAULT_MODELS.claude}`);
		expect(selected.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "claude-code",
			transport: "claude-cli",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: AUTO,
			modelId: "claude-haiku-5-5",
			modelKnown: true,
			label: "claude:claude-haiku-5-5 [route default]",
		});
	});

	test("unpinned Grok Build plans on the Grok entry over http with a login", async () => {
		const http = engineOf(
			await selectEngine(
				configWith({ grok: { ...defaultConfig().grok, home: grokLogin() } }),
				{},
				"/repo",
				{ host: "grok-build" },
			),
		);
		expect(http.label).toBe(ROUTE_DEFAULT_MODELS.grok);
		expect(http.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "grok-build",
			transport: "grok-http",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: AUTO,
			modelId: "grok-build-0.1",
			modelKnown: true,
			label: "grok:grok-build-0.1 [route default]",
		});
	});

	test("unpinned Muse plans on the Muse entry", async () => {
		const resolution = await resolutionOf(defaultConfig(), {}, "muse");
		expect(resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "muse",
			transport: "muse-cli",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: AUTO,
			modelId: ROUTE_DEFAULT_MODELS.muse,
			modelKnown: true,
			label: "muse:muse-spark-1.3-contributor [route default]",
		});
	});

	test("a file pin is an override even when it equals the route default; so is any other configured value", async () => {
		const pinned = mergeConfig(
			{ claude: { model: "claude-haiku-5-5" }, muse: { model: "muse-spark-1.3-contributor" } },
			defaultConfig(),
		);
		expect(await resolutionOf(pinned, {}, "claude-code")).toMatchObject({
			state: "override",
			source: "engine-model",
			reason: "explicit-model",
			modelId: "claude-haiku-5-5",
			modelKnown: true,
			label: "claude:claude-haiku-5-5 [override]",
		});
		expect(await resolutionOf(pinned, {}, "muse")).toMatchObject({
			state: "override",
			source: "engine-model",
			modelId: ROUTE_DEFAULT_MODELS.muse,
		});
		const other = configWith({ claude: { ...defaultConfig().claude, model: "opus" } });
		expect(await resolutionOf(other, {}, "claude-code")).toMatchObject({
			state: "override",
			source: "engine-model",
			label: "claude:opus [override]",
		});
	});

	test("an explicit blank Claude or Muse model delegates to the CLI default with the model unobserved", async () => {
		const blank = mergeConfig(
			{ claude: { model: "" }, muse: { model: "   " } },
			mergeConfig({ claude: { model: "opus" } }, defaultConfig()),
		);
		const claude = engineOf(await selectEngine(blank, {}, "/repo", { host: "claude-code" }));
		expect(claude.label).toBe("claude:session default");
		expect(claude.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "claude-code",
			transport: "claude-cli",
			source: "cli-default",
			reason: "cli-delegation",
			engineSelection: AUTO,
			modelKnown: false,
			label: "claude:CLI default (model unobserved)",
		});
		const muse = await resolutionOf(blank, {}, "muse");
		expect(muse).toMatchObject({
			state: "default",
			source: "cli-default",
			reason: "cli-delegation",
			modelKnown: false,
			label: "muse:CLI default (model unobserved)",
		});
		for (const field of ["modelId", "provider", "api", "providerType"])
			expect(field in muse).toBe(false);
	});

	test("blank grok.model keeps the non-empty merge: the route default, never a pin", async () => {
		const config = mergeConfig({ grok: { model: "  ", home: grokLogin() } }, defaultConfig());
		expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({
			state: "default",
			source: "route-default",
			reason: "route-default-model",
			modelId: ROUTE_DEFAULT_MODELS.grok,
			label: "grok:grok-build-0.1 [route default]",
		});
	});

	test("Hermes plans on its routed engine's route default and is never detected", async () => {
		for (const [sessionModel, transport, modelId] of [
			["claude-sonnet-4-5", "claude-cli", ROUTE_DEFAULT_MODELS.claude],
			["meta/Muse-Spark", "muse-cli", ROUTE_DEFAULT_MODELS.muse],
			["kimi-k2", "claude-cli", ROUTE_DEFAULT_MODELS.claude],
		] as const) {
			const resolution = await resolutionOf(defaultConfig(), {}, "hermes", { sessionModel });
			expect(resolution).toMatchObject({
				state: "default",
				transport,
				source: "route-default",
				modelId,
				engineSelection: AUTO,
			});
		}
	});

	test("provider defaults are never consumed on a legacy route: the eligible set is empty", async () => {
		const config = mergeConfig(
			{
				models: {
					providerDefaults: {
						anthropic: "opus",
						xai: "grok-x",
						"xai-oauth": "grok-y",
						openai: "gpt-x",
						openrouter: "router-x",
					},
				},
			},
			configWith({ grok: { ...defaultConfig().grok, home: grokLogin() } }),
		);
		expect(await resolutionOf(config, {}, "claude-code")).toMatchObject({
			source: "route-default",
			modelId: ROUTE_DEFAULT_MODELS.claude,
		});
		expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({
			source: "route-default",
			modelId: ROUTE_DEFAULT_MODELS.grok,
		});
		expect(await resolutionOf(config, {}, "muse")).toMatchObject({
			source: "route-default",
			modelId: ROUTE_DEFAULT_MODELS.muse,
		});
	});
});

describe("merged host selector ownership (POL-FUNC-009)", () => {
	test("inherited-only and mixed-own fields select the retained lower/own native targets, never prototype targets", async () => {
		const lowerTarget = fakeModel("LowerProvider", "LowerTarget");
		const ownProviderTarget = fakeModel("OwnProvider", "OwnProviderTarget");
		const ownModelTarget = fakeModel("LowerProvider", "OwnModelTarget");
		const live = fakeModel("LiveProvider", "LiveTarget");
		const lower = mergeConfig(
			{ models: { hosts: { omp: { provider: "LowerProvider", model: "lower-alias" } } } },
			defaultConfig(),
		);
		for (const [fields, lookup, target, hostQuery] of [
			[
				Object.create({ provider: "InheritedProvider", model: "inherited-alias" }) as Record<
					string,
					unknown
				>,
				"LowerProvider|lower-alias",
				lowerTarget,
				fakeQuery({
					live: { model: live, source: "ctx.model" },
					models: { "lower-alias": lowerTarget },
				}),
			],
			[
				Object.assign(Object.create({ model: "inherited-alias" }) as Record<string, unknown>, {
					provider: "OwnProvider",
				}),
				"OwnProvider|lower-alias",
				ownProviderTarget,
				fakeQuery({
					live: { model: live, source: "ctx.model" },
					models: { "lower-alias": ownProviderTarget },
				}),
			],
			[
				Object.assign(Object.create({ provider: "InheritedProvider" }) as Record<string, unknown>, {
					model: "own-alias",
				}),
				"LowerProvider|own-alias",
				ownModelTarget,
				fakeQuery({
					live: { model: live, source: "ctx.model" },
					models: { "own-alias": ownModelTarget },
				}),
			],
		] as const) {
			const { query, resolved } = hostQuery;
			const { bind, bound } = binder();
			const config = mergeConfig({ models: { hosts: { omp: fields } } }, lower);
			const native: NativeEngineSelector = async (intent) =>
				selectNativeEngine(intent, query, bind);
			const selected = engineOf(await selectEngine(config, {}, "/repo", { host: "omp", native }));
			expect(resolved).toEqual([lookup]);
			expect(bound).toEqual([target]);
			expect(bound[0]).toBe(target);
			expect(selected.resolution).toMatchObject({
				state: "override",
				transport: "omp-native",
				source: "host-override",
				provider: target.provider,
				modelId: target.id,
			});
			expect(await selected.complete("system", "user")).toBe(
				`answer from ${target.provider}/${target.id}`,
			);
		}
		const inherited = Object.create({
			provider: "InheritedProvider",
			model: "inherited-alias",
		}) as Record<string, unknown>;
		const { query, resolved } = fakeQuery({ live: { model: live, source: "ctx.model" } });
		const { bind, bound } = binder();
		const native: NativeEngineSelector = async (intent) => selectNativeEngine(intent, query, bind);
		const unpinned = mergeConfig({ models: { hosts: { omp: inherited } } }, defaultConfig());
		const detected = engineOf(await selectEngine(unpinned, {}, "/repo", { host: "omp", native }));
		expect(detected.resolution).toMatchObject({
			state: "detected",
			source: "ctx.model",
			provider: "LiveProvider",
			modelId: "LiveTarget",
		});
		expect(resolved).toEqual([]);
		expect(bound).toEqual([live]);
	});
});

describe("legacy host overrides and selector validation (§5.2)", () => {
	test("a provider-less host model is the route's explicit wire selector", async () => {
		const config = mergeConfig(
			{
				models: { hosts: { "claude-code": { model: "opus" }, "grok-build": { model: "grok-x" } } },
			},
			configWith({ grok: { ...defaultConfig().grok, home: grokLogin() } }),
		);
		const claude = engineOf(await selectEngine(config, {}, "/repo", { host: "claude-code" }));
		expect(claude.label).toBe("claude:opus");
		expect(claude.resolution).toMatchObject({
			state: "override",
			source: "host-override",
			reason: "explicit-model",
			modelId: "opus",
			label: "claude:opus [override]",
		});
		const grok = engineOf(await selectEngine(config, {}, "/repo", { host: "grok-build" }));
		expect(grok.label).toBe("grok-x");
		expect(grok.resolution).toMatchObject({
			state: "override",
			source: "host-override",
			label: "grok:grok-x [override]",
		});
	});

	test("a host provider constraint is a visible transport-incompatible skip on every legacy route, never ignored", async () => {
		const config = mergeConfig(
			{
				models: {
					hosts: {
						"claude-code": { provider: "anthropic" },
						muse: { provider: "meta", model: "muse-x" },
					},
				},
			},
			defaultConfig(),
		);
		const claude = skipOf(await selectEngine(config, {}, "/repo", { host: "claude-code" }));
		expect(claude).toEqual({
			skipped: "transport-incompatible",
			notice: "Prompt Uplift skipped · claude:unresolved [transport-incompatible]",
			resolution: {
				version: "1.0.0",
				state: "unresolved",
				host: "claude-code",
				transport: "claude-cli",
				source: "provider-override",
				reason: "transport-incompatible",
				engineSelection: AUTO,
				modelKnown: false,
				label: "claude:unresolved [transport-incompatible]",
			},
		});
		expect(await resolutionOf(config, {}, "muse")).toMatchObject({
			state: "unresolved",
			source: "host-override",
			reason: "transport-incompatible",
		});
	});

	test("a selector carrying a control character is selector-invalid before any auth, and never echoed", async () => {
		const nul = configWith({ claude: { ...defaultConfig().claude, model: "zz\u0000qq" } });
		const skip = skipOf(await selectEngine(nul, {}, "/repo", { host: "claude-code" }));
		expect(skip.resolution).toMatchObject({
			state: "unresolved",
			source: "engine-model",
			reason: "selector-invalid",
			modelKnown: false,
		});
		expect(JSON.stringify(skip)).not.toMatch(/zz|qq/);
		const provider = mergeConfig(
			{ models: { hosts: { "claude-code": { provider: "anth\nropic" } } } },
			defaultConfig(),
		);
		expect(await resolutionOf(provider, {}, "claude-code")).toMatchObject({
			source: "provider-override",
			reason: "selector-invalid",
		});
		// Checked before the login lookup: an empty Grok home would otherwise be grok-unavailable.
		const grok = configWith({
			grok: { ...defaultConfig().grok, model: "grok\u001b[31m", home: emptyHome() },
		});
		expect(await resolutionOf(grok, {}, "grok-build")).toMatchObject({
			source: "engine-model",
			reason: "selector-invalid",
		});
	});

	test("merged nonblank legacy pins reject leading/trailing C0/C1 controls before auth or execution (POL-FUNC-011)", async () => {
		const spy = claudeSpy();
		const lower = mergeConfig(
			{
				claude: { bin: spy.bin, model: "LowerClaude" },
				muse: { bin: spy.bin, model: "LowerMuse" },
				grok: { bin: spy.bin, home: emptyHome(), model: "LowerGrok" },
			},
			defaultConfig(),
		);
		for (const control of [
			"\u0000",
			"\t",
			"\n",
			"\v",
			"\f",
			"\r",
			"\u001b",
			"\u007f",
			"\u0085",
			"\u009f",
		]) {
			for (const model of [`${control}Opaque-X`, `Opaque-X${control}`]) {
				for (const route of ["claude", "muse", "grok"] as const) {
					for (const transport of route === "grok"
						? (["http", "cli"] as const)
						: (["http"] as const)) {
						const config = mergeConfig(
							{ [route]: { model }, grok: { ...(route === "grok" ? { model } : {}), transport } },
							lower,
						);
						let authLookups = 0;
						Object.defineProperty(config.grok, "home", {
							get: () => {
								authLookups++;
								return lower.grok.home;
							},
						});
						const skipped = skipOf(
							await selectEngine(config, { engine: route }, "/repo", { host: "omp" }),
						);
						expect(skipped).toMatchObject({
							skipped: "selector-invalid",
							resolution: {
								state: "unresolved",
								source: "engine-model",
								reason: "selector-invalid",
								modelKnown: false,
								engineSelection: { engine: route, source: "control", nativeOptOut: true },
							},
						});
						expect("complete" in skipped).toBe(false);
						expect("modelId" in skipped.resolution).toBe(false);
						expect(JSON.stringify(skipped)).not.toContain("Opaque-X");
						expect(engineLabel(config, { engine: route }, "omp")).toBe(skipped.resolution.label);
						expect(authLookups).toBe(0);
						expect(spy.ran()).toBe(false);
					}
				}
			}
		}
	});

	test("all-whitespace merged legacy selectors keep CLI delegation and Grok lower pins (POL-FUNC-011, AD-1)", async () => {
		const lower = mergeConfig(
			{
				claude: { model: "LowerClaude" },
				muse: { model: "LowerMuse" },
				grok: { model: "LowerGrok", home: grokLogin() },
			},
			defaultConfig(),
		);
		for (const model of ["", "  ", "\t \r\n\v\f"]) {
			const config = mergeConfig({ claude: { model }, muse: { model }, grok: { model } }, lower);
			for (const host of ["claude-code", "muse"] as const) {
				expect(await resolutionOf(config, {}, host)).toMatchObject({
					state: "default",
					source: "cli-default",
					reason: "cli-delegation",
					modelKnown: false,
				});
			}
			expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({
				state: "override",
				source: "engine-model",
				modelId: "LowerGrok",
			});
		}
	});

	test("a Grok route needs a concrete wire model", async () => {
		const blank = configWith({ grok: { ...defaultConfig().grok, model: "" } });
		expect(await resolutionOf(blank, {}, "grok-build")).toMatchObject({
			state: "unresolved",
			source: "none",
			reason: "concrete-model-required",
		});
	});

	test("records never carry endpoints or credentials", async () => {
		const grok = {
			...defaultConfig().grok,
			baseUrl: "https://proxy-secret.example/v1",
			home: grokLogin(),
		};
		const viaHttp = await resolutionOf(configWith({ grok }), {}, "grok-build");
		expect(JSON.stringify(viaHttp)).not.toMatch(/secret|fixture-session/);
		const endpoint = configWith({
			claude: { ...defaultConfig().claude, model: "https://evil.example/v1" },
		});
		const shown = await resolutionOf(endpoint, {}, "claude-code");
		expect(shown).toMatchObject({
			state: "override",
			modelId: "<opaque-model>",
			modelKnown: true,
			label: "claude:<opaque-model> [override]",
		});
	});
});

describe("Grok availability (AD-2, AD-2a, AC-15-043)", () => {
	test("auto Grok Build with a missing or expired login skips with GROK_LOGIN_REQUIRED and zero Claude calls", async () => {
		for (const home of [emptyHome(), grokLogin(true)]) {
			const spy = claudeSpy();
			const config = configWith({
				claude: { ...defaultConfig().claude, bin: spy.bin },
				grok: { ...defaultConfig().grok, home },
			});
			const selection = await selectEngine(config, {}, "/repo", { host: "grok-build" });
			expect(selection).toEqual({
				skipped: GROK_LOGIN_REQUIRED,
				notice: GROK_LOGIN_REQUIRED,
				resolution: {
					version: "1.0.0",
					state: "unresolved",
					host: "grok-build",
					transport: "grok-http",
					source: "route-default",
					reason: "grok-unavailable",
					engineSelection: AUTO,
					modelKnown: false,
					label: "grok:unresolved [grok-unavailable]",
				},
			});
			expect("complete" in selection).toBe(false);
			expect(spy.ran()).toBe(false);
		}
	});

	test("named Grok skips the same way; the record names the attempted Grok source and transport", async () => {
		const config = mergeConfig(
			{ grok: { model: "grok-pin", transport: "cli", home: emptyHome() } },
			defaultConfig(),
		);
		const skip = skipOf(
			await selectEngine(config, { engine: "grok" }, "/repo", { host: "claude-code" }),
		);
		expect(skip.skipped).toBe(GROK_LOGIN_REQUIRED);
		expect(skip.resolution).toMatchObject({
			state: "unresolved",
			transport: "grok-cli",
			source: "engine-model",
			reason: "grok-unavailable",
			engineSelection: { engine: "grok", source: "control", nativeOptOut: false },
		});
	});

	test("grok.fallbackToClaude: true runs the actual Claude route on Claude's own model, labeled a configured fallback", async () => {
		const spy = claudeSpy();
		const config = mergeConfig(
			{
				claude: { bin: spy.bin },
				grok: { home: emptyHome(), fallbackToClaude: true },
				models: { hosts: { "grok-build": { model: "grok-x" } } },
			},
			defaultConfig(),
		);
		// A real cwd: the spy must be able to spawn when the fallback completer runs.
		const selected = engineOf(
			await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "grok-build" }),
		);
		expect(selected.label).toBe("claude:claude-haiku-5-5 (grok fallback)");
		expect(selected.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "grok-build",
			transport: "claude-cli",
			source: "configured-fallback",
			reason: "grok-unavailable",
			engineSelection: AUTO,
			modelId: ROUTE_DEFAULT_MODELS.claude,
			modelKnown: true,
			label: "claude:claude-haiku-5-5 [configured fallback · grok unavailable]",
		});
		await expect(selected.complete("system", "user")).rejects.toThrow();
		expect(spy.ran()).toBe(true);
	});

	test("the configured fallback takes its state from the Claude model provenance", async () => {
		const optIn = mergeConfig(
			{ grok: { home: emptyHome(), fallbackToClaude: true } },
			defaultConfig(),
		);
		const pinned = await resolutionOf(
			mergeConfig({ claude: { model: "opus" } }, optIn),
			{},
			"grok-build",
		);
		expect(pinned).toMatchObject({
			state: "override",
			source: "configured-fallback",
			reason: "grok-unavailable",
			modelId: "opus",
		});
		expect(pinned.label).toBe("claude:opus [configured fallback · grok unavailable]");
		const blank = await resolutionOf(
			mergeConfig({ claude: { model: "" } }, optIn),
			{},
			"grok-build",
		);
		expect(blank).toMatchObject({
			state: "default",
			source: "configured-fallback",
			modelKnown: false,
		});
		expect("modelId" in blank).toBe(false);
		expect(blank.label).toBe(
			"claude:CLI default (model unobserved) [configured fallback · grok unavailable]",
		);
	});

	test("grok.enabled: false keeps the documented Claude route, recorded as a configured fallback", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, enabled: false } });
		const auto = engineOf(await selectEngine(config, {}, "/repo", { host: "grok-build" }));
		expect(auto.label).toBe("claude:claude-haiku-5-5");
		expect(auto.resolution).toMatchObject({
			state: "default",
			transport: "claude-cli",
			source: "configured-fallback",
			reason: "grok-unavailable",
		});
		const named = await resolutionOf(config, { engine: "grok" }, "claude-code");
		expect(named).toMatchObject({
			source: "configured-fallback",
			engineSelection: { engine: "grok", source: "control", nativeOptOut: false },
		});
	});

	test("an explicit think.engine claude is a deliberate route, not a configured fallback", async () => {
		const config = configWith({
			think: { ...defaultConfig().think, engine: "claude" },
			grok: { ...defaultConfig().grok, home: emptyHome() },
		});
		expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({
			state: "default",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: { engine: "claude", source: "config", nativeOptOut: false },
		});
	});

	test("Hermes family routing onto Grok without a login skips visibly too, never Claude", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, home: emptyHome() } });
		const skip = skipOf(
			await selectEngine(config, {}, "/repo", {
				host: "hermes",
				sessionModel: "xai-oauth/grok-4.6",
			}),
		);
		expect(skip.skipped).toBe(GROK_LOGIN_REQUIRED);
		expect(skip.resolution).toMatchObject({
			state: "unresolved",
			host: "hermes",
			transport: "grok-http",
			source: "route-default",
			reason: "grok-unavailable",
		});
	});

	test("provider-disabled is never used on a Grok path", async () => {
		const missing = { ...defaultConfig().grok, home: emptyHome() };
		const records = [
			await resolutionOf(configWith({ grok: missing }), {}, "grok-build"),
			await resolutionOf(configWith({ grok: missing }), { engine: "grok" }, "muse"),
			await resolutionOf(
				configWith({ grok: { ...missing, fallbackToClaude: true } }),
				{},
				"grok-build",
			),
			await resolutionOf(configWith({ grok: { ...missing, enabled: false } }), {}, "grok-build"),
		];
		for (const record of records) expect(record.reason).not.toBe("provider-disabled");
	});
});

describe("call-time failover (claude.fallbackToGrok and the Grok model chain)", () => {
	const PLAN_LIMIT = JSON.stringify({
		type: "result",
		is_error: true,
		result: "You've hit your session limit · resets 3:45pm",
	});
	const OK_RESULT = JSON.stringify({ type: "result", is_error: false, result: "CLAUDE_REPLY" });
	const CLAUDE_FIRST = "claude:claude-haiku-5-5";
	const RATE_LIMIT_ZERO =
		'{"code":"resource-exhausted","error":"Too many requests for team t-1 and model grok-build-0.1. Your team\'s rate limit is — Requests per Minute (actual/limit): 0/0. Your rate limit tier is determined based on your historical API spend."}';

	/** A `claude` stub that logs whether `ANTHROPIC_API_KEY` reached it, then prints `out` and exits `code`. */
	function claudeStub(out: string, code = 0): { bin: string; keyLog: () => string[] } {
		const dir = tempDir("ultrathink-engine-claude-stub-");
		const bin = join(dir, "claude");
		const outFile = join(dir, "out.json");
		const logFile = join(dir, "calls.log");
		writeFileSync(outFile, out);
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
				"cat >/dev/null",
				`echo "key=\${ANTHROPIC_API_KEY:+set}" >> '${logFile}'`,
				`cat '${outFile}'`,
				`exit ${code}`,
			].join("\n"),
		);
		chmodSync(bin, 0o755);
		return {
			bin,
			keyLog: () => {
				try {
					return readFileSync(logFile, "utf8").trim().split("\n");
				} catch {
					// reason: the stub never ran, so no log exists
					return [];
				}
			},
		};
	}

	/** A local gateway; `answer` decides each reply and sees the request path and JSON body. */
	function gateway(answer: (path: string, body: { model?: string }) => Response): {
		origin: string;
		models: string[];
		stop: () => void;
	} {
		const models: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = (await request.json()) as { model?: string };
				models.push(body.model ?? "");
				return answer(new URL(request.url).pathname, body);
			},
		});
		return { origin: `http://127.0.0.1:${server.port}`, models, stop: () => server.stop(true) };
	}

	function claudeConfig(
		bin: string,
		fallbackToGrok: boolean,
		grok: Partial<UltrathinkConfig["grok"]>,
		auth: "plan" | "api-key" = "plan",
	) {
		return configWith({
			claude: { ...defaultConfig().claude, bin, fallbackToGrok, auth },
			grok: { ...defaultConfig().grok, ...grok },
		});
	}

	test("fallbackToGrok: a plan-limit Claude failure continues on Grok, reported as a failover, not an error", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const gw = gateway(() => Response.json({ output_text: "HTTP_REPLY" }));
		try {
			const config = claudeConfig(claude.bin, true, {
				home: grokLogin(),
				baseUrl: `${gw.origin}/v1`,
			});
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "claude-code" }),
			);
			expect(selected.label).toBe(CLAUDE_FIRST);
			expect(selected.resolution.modelId).toBe("claude-haiku-5-5");
			expect(selected.failover?.()).toBeUndefined();
			expect(await selected.complete("system", "user")).toBe("HTTP_REPLY");
			expect(selected.failover?.()).toBe(`${CLAUDE_FIRST} → grok:grok-build-0.1 (plan-limit)`);
			expect(selected.label).toBe(CLAUDE_FIRST);
			expect(selected.resolution.modelId).toBe("claude-haiku-5-5");
			expect(selected.error()).toBeUndefined();
			expect(claude.keyLog()).toHaveLength(1);
			expect(gw.models).toEqual(["grok-build-0.1"]);
		} finally {
			gw.stop();
		}
	});

	test("fallbackToGrok skips a grok.model with a control character and answers on the next valid model", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const gw = gateway(() => Response.json({ output_text: "HTTP_REPLY" }));
		try {
			const config = claudeConfig(claude.bin, true, {
				home: grokLogin(),
				baseUrl: `${gw.origin}/v1`,
				model: "bad\nmodel",
				fallbackModels: ["grok-4.7"],
			});
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "claude-code" }),
			);
			expect(await selected.complete("system", "user")).toBe("HTTP_REPLY");
			expect(selected.failover?.()).toBe(`${CLAUDE_FIRST} → grok:grok-4.7 (plan-limit)`);
			expect(gw.models).toEqual(["grok-4.7"]);
		} finally {
			gw.stop();
		}
	});

	test("fallbackToGrok with only unusable Grok selectors stays a single Claude candidate", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const config = claudeConfig(claude.bin, true, {
			home: grokLogin(),
			model: "bad\nmodel",
			fallbackModels: [],
		});
		const selected = engineOf(
			await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "claude-code" }),
		);
		expect(selected.failover).toBeUndefined();
		await expect(selected.complete("system", "user")).rejects.toThrow(/session limit/);
	});

	test("fallbackToGrok off: the plan-limit error propagates and there is no failover", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const gw = gateway(() => Response.json({ output_text: "HTTP_REPLY" }));
		try {
			const config = claudeConfig(claude.bin, false, {
				home: grokLogin(),
				baseUrl: `${gw.origin}/v1`,
			});
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "claude-code" }),
			);
			await expect(selected.complete("system", "user")).rejects.toThrow(/session limit/);
			expect(selected.failover).toBeUndefined();
			expect(selected.error()).toContain("session limit");
			expect(gw.models).toEqual([]);
		} finally {
			gw.stop();
		}
	});

	test("fallbackToGrok on without a usable Grok login stays a single Claude candidate", async () => {
		const claude = claudeStub(PLAN_LIMIT, 1);
		const config = claudeConfig(claude.bin, true, { transport: "http", home: emptyHome() });
		const selected = engineOf(
			await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "claude-code" }),
		);
		expect(selected.failover).toBeUndefined();
		await expect(selected.complete("system", "user")).rejects.toThrow(/session limit/);
		expect(selected.failover).toBeUndefined();
	});

	test("a selected Grok route walks grok.model then grok.fallbackModels, skipping a model the session cannot use", async () => {
		const gw = gateway((_path, body) =>
			body.model === "grok-build-0.1"
				? new Response(RATE_LIMIT_ZERO, { status: 429 })
				: Response.json({ output_text: "HTTP_REPLY" }),
		);
		try {
			const config = configWith({
				grok: {
					...defaultConfig().grok,
					home: grokLogin(),
					baseUrl: `${gw.origin}/v1`,
					fallbackModels: ["grok-4.7"],
				},
			});
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "grok-build" }),
			);
			expect(selected.label).toBe("grok-build-0.1");
			expect(await selected.complete("system", "user")).toBe("HTTP_REPLY");
			expect(selected.failover?.()).toBe("grok:grok-build-0.1 → grok:grok-4.7 (model-unavailable)");
			expect(selected.label).toBe("grok-build-0.1");
			expect(selected.resolution.modelId).toBe("grok-build-0.1");
			// The dead model is in cooldown: the second call goes straight to the fallback model.
			expect(await selected.complete("system", "user")).toBe("HTTP_REPLY");
			expect(gw.models).toEqual(["grok-build-0.1", "grok-4.7", "grok-4.7"]);
		} finally {
			gw.stop();
		}
	});

	test("a cooldown learned on one Grok route never skips the same model on another route", async () => {
		const savedState = process.env.ULTRATHINK_STATE_DIR;
		const home = grokLogin();
		process.env.ULTRATHINK_STATE_DIR = tempDir("ultrathink-engine-state-");
		const dead = gateway((_path, body) =>
			body.model === "grok-build-0.1"
				? new Response(RATE_LIMIT_ZERO, { status: 429 })
				: Response.json({ output_text: "HTTP_REPLY" }),
		);
		const healthy = gateway(() => Response.json({ output_text: "HTTP_REPLY" }));
		const configFor = (origin: string) =>
			configWith({
				grok: {
					...defaultConfig().grok,
					home,
					baseUrl: `${origin}/v1`,
					fallbackModels: ["grok-4.7"],
				},
			});
		const select = async (origin: string) =>
			engineOf(
				await selectEngine(configFor(origin), {}, tempDir("ultrathink-engine-cwd-"), {
					host: "grok-build",
				}),
			);
		try {
			// Route one learns that grok-build-0.1 is unusable there and records it for the next hook process.
			expect(await (await select(dead.origin)).complete("system", "user")).toBe("HTTP_REPLY");
			expect(dead.models).toEqual(["grok-build-0.1", "grok-4.7"]);
			// A fresh process on the same route starts with that model cooling.
			expect(await (await select(dead.origin)).complete("system", "user")).toBe("HTTP_REPLY");
			expect(dead.models).toEqual(["grok-build-0.1", "grok-4.7", "grok-4.7"]);
			// Another route to the same model name is a different access path: its first model still answers.
			expect(await (await select(healthy.origin)).complete("system", "user")).toBe("HTTP_REPLY");
			expect(healthy.models).toEqual(["grok-build-0.1"]);
		} finally {
			dead.stop();
			healthy.stop();
			if (savedState === undefined) delete process.env.ULTRATHINK_STATE_DIR;
			else process.env.ULTRATHINK_STATE_DIR = savedState;
		}
	});

	test("a host wire override names one exact model: no model chain", async () => {
		const gw = gateway(() => new Response(RATE_LIMIT_ZERO, { status: 429 }));
		try {
			const config = configWith({
				grok: { ...defaultConfig().grok, home: grokLogin(), baseUrl: `${gw.origin}/v1` },
			});
			config.models.hosts["grok-build"] = { provider: "", model: "wire-model" };
			const selected = engineOf(
				await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "grok-build" }),
			);
			expect(selected.failover).toBeUndefined();
			await expect(selected.complete("system", "user")).rejects.toThrow(/HTTP 429/);
			expect(gw.models).toEqual(["wire-model"]);
		} finally {
			gw.stop();
		}
	});

	test("the claude child never sees ANTHROPIC_API_KEY by default, and sees it with claude.auth api-key", async () => {
		const saved = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fixture-not-a-real-key";
		try {
			for (const [auth, expected] of [
				["plan", "key="],
				["api-key", "key=set"],
			] as const) {
				const claude = claudeStub(OK_RESULT);
				const config = claudeConfig(claude.bin, false, {}, auth);
				const selected = engineOf(
					await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), {
						host: "claude-code",
					}),
				);
				expect(await selected.complete("system", "user")).toBe("CLAUDE_REPLY");
				expect(claude.keyLog()).toEqual([expected]);
			}
		} finally {
			if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = saved;
		}
	});
});
