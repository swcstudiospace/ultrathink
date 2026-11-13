// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	CAPABILITY_FALLBACKS,
	CAPABILITY_FLAGS,
	type CapabilityManifest,
	type CapabilityReports,
	planCommand,
	resolveCapabilities,
} from "../../../core/src/capabilities/manifest.ts";
import {
	type CategorizedError,
	type CommandDefinition,
	type CommandPort,
	type CommandResult,
	ERROR_CATEGORIES,
	type ErrorCategory,
	type Schema,
} from "../../../core/src/ports/command.ts";
import type { ClockPort, FileSystemPort, ProcessPort } from "../../../core/src/ports/injection.ts";
import type {
	LifecycleEvent,
	LifecycleEventPort,
	LifecyclePayload,
} from "../../../core/src/ports/lifecycle.ts";

const ROOT = "/repo";
const LIFECYCLE_PAYLOAD_KEYS = ["command", "correlationId", "errorCategory"];
const FORBIDDEN_PAYLOAD_KEYS = ["token", "secret", "password"];

function categorized(category: ErrorCategory, message: string): CategorizedError {
	return Object.assign(new Error(message), { category });
}

/** Lexically resolves `path` against `root` and rejects anything that escapes it. Reference behavior for adapters. */
function confine(root: string, path: string): string {
	const absolute = path.startsWith("/") ? path : `${root}/${path}`;
	const segments: string[] = [];
	for (const segment of absolute.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	const normalized = `/${segments.join("/")}`;
	if (normalized !== root && !normalized.startsWith(`${root}/`)) {
		throw categorized("permission_denied", `path escapes root: ${path}`);
	}
	return normalized;
}

function fakeFileSystem(root: string): FileSystemPort {
	const files = new Map<string, string>();
	return {
		async read(path) {
			const content = files.get(confine(root, path));
			if (content === undefined) throw categorized("invalid_input", `no such file: ${path}`);
			return content;
		},
		async atomicWrite(path, content) {
			files.set(confine(root, path), content);
		},
		async list(path) {
			const dir = confine(root, path);
			const names = new Set<string>();
			for (const key of files.keys()) {
				if (key.startsWith(`${dir}/`)) {
					const [head = ""] = key.slice(dir.length + 1).split("/");
					names.add(head);
				}
			}
			return [...names].sort();
		},
		async stat(path) {
			const target = confine(root, path);
			const content = files.get(target);
			if (content !== undefined) return { size: content.length, mtimeMs: 0, isDirectory: false };
			if ([...files.keys()].some((key) => key.startsWith(`${target}/`))) {
				return { size: 0, mtimeMs: 0, isDirectory: true };
			}
			throw categorized("invalid_input", `no such path: ${path}`);
		},
	};
}

function fakeClock(start: number): ClockPort & { advance(ms: number): void } {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
}

function fakeProcess(allowlist: readonly string[]): ProcessPort {
	return {
		async spawn(request) {
			if (!allowlist.includes(request.command)) {
				throw categorized("permission_denied", `command not allowlisted: ${request.command}`);
			}
			return { exitCode: 0, stdout: request.args.join(" "), stderr: "" };
		},
	};
}

function recordingLifecycle(): LifecycleEventPort & { readonly events: LifecycleEvent[] } {
	const events: LifecycleEvent[] = [];
	return {
		events,
		emit: (event) => {
			events.push(event);
		},
	};
}

const targetSchema: Schema<{ readonly target: string }> = {
	parse(value) {
		if (
			typeof value === "object" &&
			value !== null &&
			"target" in value &&
			typeof value.target === "string"
		) {
			return { target: value.target };
		}
		throw new Error("target must be a string");
	},
};

const passthrough: Schema<unknown> = { parse: (value) => value };

interface CommandEntry {
	readonly definition: CommandDefinition<unknown, unknown>;
	readonly handle: (input: unknown) => unknown;
}

const echoEntry: CommandEntry = {
	definition: {
		name: "echo",
		input: targetSchema,
		output: passthrough,
		idempotency: "idempotent",
		errorCategories: ["invalid_input", "internal"],
	},
	handle: (input) => input,
};

/** Reference CommandPort: validates input, emits lifecycle events, and builds payloads from explicit fields only. */
function fakeCommandPort(
	entries: readonly CommandEntry[],
	lifecycle: LifecycleEventPort,
): CommandPort {
	const fail = (
		command: string,
		correlationId: string,
		category: ErrorCategory,
		message: string,
	): CommandResult<unknown> => {
		lifecycle.emit({
			stage: "error",
			payload: { command, correlationId, errorCategory: category },
		});
		return { ok: false, error: { category, message } };
	};
	return {
		list: () => entries.map((entry) => entry.definition),
		async invoke(name, input, context) {
			const { correlationId } = context;
			const entry = entries.find((candidate) => candidate.definition.name === name);
			if (entry === undefined)
				return fail(name, correlationId, "invalid_input", `unknown command: ${name}`);
			lifecycle.emit({ stage: "invoke", payload: { command: name, correlationId } });
			if (entry.definition.idempotency === "keyed" && context.idempotencyKey === undefined) {
				return fail(name, correlationId, "invalid_input", "keyed command requires idempotencyKey");
			}
			let parsed: unknown;
			try {
				parsed = entry.definition.input.parse(input);
			} catch {
				return fail(name, correlationId, "invalid_input", "input failed validation");
			}
			try {
				const output = entry.definition.output.parse(entry.handle(parsed));
				lifecycle.emit({ stage: "complete", payload: { command: name, correlationId } });
				return { ok: true, value: output };
			} catch {
				return fail(name, correlationId, "internal", "command failed");
			}
		},
	};
}

describe("shared error categories", () => {
	test("enumerate the seven categories", () => {
		expect([...ERROR_CATEGORIES]).toEqual([
			"invalid_input",
			"capability_missing",
			"version_mismatch",
			"host_unreachable",
			"state_corrupt",
			"permission_denied",
			"internal",
		]);
	});
});

describe("FileSystemPort contract", () => {
	test("rejects a '..' path that escapes the root and accepts one that stays inside", async () => {
		const fs = fakeFileSystem(ROOT);
		await fs.atomicWrite("STATE.md", "ok");
		await expect(fs.read("../../etc/passwd")).rejects.toMatchObject({
			category: "permission_denied",
		});
		await expect(fs.atomicWrite("../escape.md", "x")).rejects.toMatchObject({
			category: "permission_denied",
		});
		await expect(fs.read("notes/../STATE.md")).resolves.toBe("ok");
	});
});

describe("ClockPort contract", () => {
	test("now() is a number and advances only when the fake is advanced", () => {
		const clock = fakeClock(1_000);
		expect(clock.now()).toBe(1_000);
		clock.advance(5);
		expect(clock.now()).toBe(1_005);
	});
});

describe("ProcessPort contract", () => {
	test("spawns allowlisted commands with argv and rejects anything else", async () => {
		const processPort = fakeProcess(["git"]);
		await expect(processPort.spawn({ command: "git", args: ["status"] })).resolves.toMatchObject({
			exitCode: 0,
			stdout: "status",
		});
		await expect(
			processPort.spawn({ command: "sh", args: ["-c", "rm -rf /"] }),
		).rejects.toMatchObject({ category: "permission_denied" });
	});
});

describe("LifecycleEventPort contract", () => {
	test("payloads never carry token, secret, or password keys", async () => {
		const lifecycle = recordingLifecycle();
		const commands = fakeCommandPort([echoEntry], lifecycle);

		const ok = await commands.invoke(
			"echo",
			{ target: "x", token: "t-123", secret: "s-456", password: "p-789" },
			{ correlationId: "c-1" },
		);
		const bad = await commands.invoke("echo", { token: "t-123" }, { correlationId: "c-2" });

		expect(ok).toEqual({ ok: true, value: { target: "x" } });
		expect(bad).toMatchObject({ ok: false, error: { category: "invalid_input" } });
		expect(lifecycle.events.map((event) => event.stage)).toEqual([
			"invoke",
			"complete",
			"invoke",
			"error",
		]);
		for (const event of lifecycle.events) {
			for (const key of Object.keys(event.payload)) {
				expect(LIFECYCLE_PAYLOAD_KEYS).toContain(key);
				expect(FORBIDDEN_PAYLOAD_KEYS).not.toContain(key.toLowerCase());
			}
		}
		expect(JSON.stringify(lifecycle.events)).not.toContain("t-123");
	});

	test("payload type is closed against credential-named keys", () => {
		const payload: LifecyclePayload = {
			command: "echo",
			correlationId: "c-3",
			// @ts-expect-error token is not a LifecyclePayload key
			token: "t-123",
		};
		expect(payload.command).toBe("echo");
	});
});

describe("CapabilityManifest resolution", () => {
	const manifest = {
		execute: { required: [], optional: ["supports_subagents", "supports_hooks"] },
		resume: { required: ["supports_persistent_state"], optional: [] },
	} satisfies CapabilityManifest;

	test("an unset flag resolves to false and selects its fallback", () => {
		const reports: CapabilityReports = {
			supports_hooks: { value: true, source: "claude-code" },
		};
		const resolved = resolveCapabilities(reports);

		expect(Object.keys(resolved).sort()).toEqual([...CAPABILITY_FLAGS].sort());
		expect(resolved.supports_subagents).toEqual({
			enabled: false,
			source: "unset",
			fallback: CAPABILITY_FALLBACKS.supports_subagents,
		});
		expect(resolved.supports_hooks).toEqual({
			enabled: true,
			source: "claude-code",
			fallback: null,
		});

		const execute = planCommand(manifest.execute, resolved);
		expect(execute.status).toBe("degraded");
		expect(execute.missingRequired).toEqual([]);
		expect(execute.fallbacks).toEqual({
			supports_subagents: "run discuss/plan/execute inline in order",
		});

		const resume = planCommand(manifest.resume, resolved);
		expect(resume.status).toBe("blocked");
		expect(resume.missingRequired).toEqual(["supports_persistent_state"]);
	});
});

describe("per-flag fallback contract", () => {
	const everyOptional = {
		all: { required: [], optional: [...CAPABILITY_FLAGS] },
	} satisfies CapabilityManifest;

	for (const flag of CAPABILITY_FLAGS) {
		test(`${flag}: disabled selects a non-empty fallback; enabled selects none`, () => {
			const disabled = resolveCapabilities({ [flag]: { value: false, source: "adapter" } });
			expect(disabled[flag].enabled).toBe(false);
			expect(disabled[flag].fallback).toBe(CAPABILITY_FALLBACKS[flag]);
			expect(CAPABILITY_FALLBACKS[flag].length).toBeGreaterThan(0);

			const enabled = resolveCapabilities({ [flag]: { value: true, source: "adapter" } });
			expect(enabled[flag].enabled).toBe(true);
			expect(enabled[flag].fallback).toBeNull();
		});
	}

	test("a command with every flag enabled is ready with no fallbacks", () => {
		const reports: CapabilityReports = Object.fromEntries(
			CAPABILITY_FLAGS.map((flag) => [flag, { value: true, source: "adapter" }]),
		);
		const plan = planCommand(everyOptional.all, resolveCapabilities(reports));
		expect(plan).toEqual({ status: "ready", missingRequired: [], fallbacks: {} });
	});

	test("a report of value false still names its source in the resolved entry", () => {
		const resolved = resolveCapabilities({
			supports_hooks: { value: false, source: "prime-agent" },
		});
		expect(resolved.supports_hooks.source).toBe("prime-agent");
	});
});
