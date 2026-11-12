// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";

export interface ConformanceSubject {
	readonly name: string;
	readonly capabilities: Readonly<Record<string, boolean>>;
	readonly invoke: (
		command: string,
		input: unknown,
		correlationId: string,
	) => Promise<{
		readonly ok: boolean;
		readonly error?: { readonly category: string; readonly message: string };
	}>;
	readonly commands: readonly string[];
}

const UNKNOWN_COMMAND = "__conformance_unknown_command__";
const PROBE_INPUT: unknown = {};
const FORBIDDEN_MESSAGE_SUBSTRINGS: readonly string[] = ["token", "secret", "password"];

export function registerConformance(subject: ConformanceSubject): void {
	describe(subject.name, () => {
		test("unknown command returns ok false with category invalid_input", async () => {
			const result = await subject.invoke(UNKNOWN_COMMAND, PROBE_INPUT, "conformance-unknown");
			expect(result.ok).toBe(false);
			expect(result.error?.category).toBe("invalid_input");
		});

		test("every declared command can be invoked and returns a result object with boolean ok", async () => {
			for (const command of subject.commands) {
				const result = await subject.invoke(command, PROBE_INPUT, `conformance-invoke-${command}`);
				expect(typeof result).toBe("object");
				expect(result).not.toBeNull();
				expect(typeof result.ok).toBe("boolean");
			}
		});

		test("error messages do not contain token, secret, or password", async () => {
			const probes = [UNKNOWN_COMMAND, ...subject.commands];
			for (const command of probes) {
				const result = await subject.invoke(command, PROBE_INPUT, `conformance-message-${command}`);
				const message = (result.error?.message ?? "").toLowerCase();
				for (const forbidden of FORBIDDEN_MESSAGE_SUBSTRINGS) {
					expect(message).not.toContain(forbidden);
				}
			}
		});

		test("re-invoking a command with same input and correlation id returns the same ok value", async () => {
			for (const command of subject.commands) {
				const correlationId = `conformance-idempotent-${command}`;
				const first = await subject.invoke(command, PROBE_INPUT, correlationId);
				const second = await subject.invoke(command, PROBE_INPUT, correlationId);
				expect(second.ok).toBe(first.ok);
			}
		});

		test("every reported capability value is a boolean", () => {
			const nonBoolean = Object.entries(subject.capabilities)
				.filter(([, value]) => typeof value !== "boolean")
				.map(([key]) => key);
			expect(nonBoolean).toEqual([]);
		});
	});
}
