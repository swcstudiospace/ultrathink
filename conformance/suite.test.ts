// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { type ConformanceSubject, registerConformance } from "./suite.ts";

const DECLARED_COMMANDS: readonly string[] = ["ping", "status"];

const fakeSubject: ConformanceSubject = {
	name: "fake-adapter",
	capabilities: { streaming: false, cancellation: true },
	commands: DECLARED_COMMANDS,
	invoke: async (command, _input, _correlationId) => {
		if (DECLARED_COMMANDS.includes(command)) {
			return { ok: true };
		}
		return {
			ok: false,
			error: { category: "invalid_input", message: `unknown command: ${command}` },
		};
	},
};

registerConformance(fakeSubject);
