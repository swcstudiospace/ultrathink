// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export interface SecretPattern {
	readonly name: string;
	readonly pattern: RegExp;
	/** Index of the capture group that holds the secret value. */
	readonly valueGroup: number;
}

/**
 * Credential-shaped patterns checked line by line by scan.ts.
 * Placeholders such as `<...>`, `${...}`, and `<REDACTED>` never match the assignment rule.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
	{
		name: "aws-access-key-id",
		pattern: /\b(AKIA[0-9A-Z]{16})\b/,
		valueGroup: 1,
	},
	{
		name: "github-token",
		pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/,
		valueGroup: 1,
	},
	{
		name: "bearer-token",
		pattern: /\bBearer\s+([A-Za-z0-9._-]{20,})/,
		valueGroup: 1,
	},
	{
		// NAME containing TOKEN, SECRET, KEY, or PASSWORD assigned a literal of 8+ chars.
		// Group 1: optional quote. Group 2: the value.
		name: "secret-assignment",
		pattern:
			/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Za-z0-9_]*\b["']?\s*[:=]\s*(["'`])(?!<[^>\n]*>|\$\{|process\.env|Bun\.env|import\.meta)([^"'`\n]{8,})\1/i,
		valueGroup: 2,
	},
];
