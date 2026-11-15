// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export interface SecretPattern {
	readonly name: string;
	readonly pattern: RegExp;
	/** Index of the capture group that holds the secret value. */
	readonly valueGroup: number;
	/** Returns true when the captured value is a placeholder, so the match is not a finding. */
	readonly isPlaceholder?: (value: string) => boolean;
}

const PLACEHOLDER_WORDS: Record<string, true> = {
	changeme: true,
	"change-me": true,
	placeholder: true,
	redacted: true,
	dummy: true,
	example: true,
	none: true,
	null: true,
};

/** True for an empty value, a reference, an angle-bracket or x/asterisk-only value, or an obvious fake. */
export function isPlaceholderValue(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed === "") return true;
	if (/^<.*>$/.test(trimmed)) return true;
	if (trimmed.startsWith("$")) return true;
	if (/^(?:process\.env|Bun\.env|import\.meta)\b/.test(trimmed)) return true;
	if (/^[x*._-]+$/i.test(trimmed)) return true;
	if (/^your[-_]/i.test(trimmed)) return true;
	return PLACEHOLDER_WORDS[trimmed.toLowerCase()] === true;
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
	{
		// Unquoted .env-style assignment, optionally `export`ed, of an uppercase NAME containing a
		// secret word. Group 1: the name. Group 2: the value, which ends at whitespace.
		// Quoted values are left to secret-assignment.
		name: "secret-env-assignment",
		pattern:
			/^\s*(?:export\s+)?([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`#]\S*)/,
		valueGroup: 2,
		isPlaceholder: isPlaceholderValue,
	},
];
