// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { stampedVersion } from "./version.ts";

describe("stampedVersion", () => {
	test("an undefined stamp leaves the release unchanged", () => {
		expect(stampedVersion("1.4.0", () => undefined)).toBe("1.4.0");
	});

	test("a whitespace-only stamp leaves the release unchanged", () => {
		expect(stampedVersion("1.4.0", () => "  \n ")).toBe("1.4.0");
	});

	test("a stamp is appended to the release after a plus sign", () => {
		expect(stampedVersion("1.21.0", () => "v1.21-3-gabc1234-dirty")).toBe(
			"1.21.0+v1.21-3-gabc1234-dirty",
		);
	});
});
