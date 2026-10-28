// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { PROVIDERS } from "./providers.ts";

describe("provider registry", () => {
	test("the openrouter key variable is the dedicated one, never the generic name SDKs auto-read", () => {
		const provider = PROVIDERS.openrouter;
		expect(provider.kind).toBe("key");
		if (provider.kind !== "key") return;
		expect(provider.envVar).toBe("ULTRATHINK_OPENROUTER_KEY");
		expect(provider.envVar).not.toBe("OPENROUTER_API_KEY");
	});
});
