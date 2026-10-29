// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one secret redactor. Every boundary that surfaces child stderr, an upstream body or an error message runs its
 * text through `redactSecrets`; the Teachable Moments redactor (`src/teach/redact.ts`) reuses `redactSecretShapes` and adds
 * its path and home masking on top. There is no second pattern table.
 *
 * `redactSecrets(text, ...exactSecrets)` masks the exact secrets first (a literal match, never a regex, so a live key is
 * gone whatever shape it has), then every supported key shape: `sk-or-`, `sk-ant-`, `vck_`, GitHub, Slack, AWS, Google,
 * Linear (`lin_api_`) and Notion (`ntn_`, `secret_`) key prefixes, argon2 hashes, `Bearer <token>`, JWTs, PEM private-key blocks (an unterminated block goes to the end), URL user-info,
 * `Authorization`/`Cookie` style headers and `key=value` for secret-named keys. The `xai-` prefix is not a pattern: it also
 * names non-secret ids such as `xai-oauth` and `xai-grok-cli`, so an xAI key is masked only as an exact secret.
 *
 * It never throws and never truncates: callers cut the result to their own length cap after redaction, so a cut can never
 * split a secret the redactor has already masked.
 */

const REDACTED = "[redacted]";

/** A PEM private-key block; one cut off by a length cap has no END line, so everything after BEGIN goes. A single lazy pass keeps this linear. */
const PEM_BLOCK =
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/** The lookbehinds on this and the other run-scanning patterns below let a match start only at the start of a run, so a huge unbroken run is scanned once, not once per character. */
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/]+@/g;
const AUTH_HEADER =
	/((?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|cookie|set-cookie)["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"',;]+/gi;
/** A Cookie or Set-Cookie header value runs to the end of its line or to a quote: every pair in it is a credential, not only the first. */
const COOKIE_HEADER = /((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\r\n"']+/gi;
const BEARER = /\bBearer(\s+)([A-Za-z0-9._~+/-]+=*)/gi;
/** Error boundaries are diagnostics, not prose: every word after `Bearer` is masked, as the old grok helper did, so `Bearer abcdefgh` goes too. The prose-safe rule is `redactBearer`, used by `redactSecretShapes`. */
const BEARER_ANY = /\bBearer\s+\S+/g;
const JWT = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g;

/** Key-prefix shapes. Every entry is global, so a replace masks each occurrence, and the specific prefixes come before the generic `sk-`. */
export const SECRET_TOKEN_PATTERNS: readonly RegExp[] = [
	/sk-or-[A-Za-z0-9_-]+/g,
	/sk-ant-[A-Za-z0-9_-]{8,}/g,
	/\bvck_[A-Za-z0-9_-]{8,}/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\blin_api_[A-Za-z0-9]{20,}/g,
	/\b(?:ntn|secret)_[A-Za-z0-9]{20,}/g,
	/\$argon2(?:id|i|d)\$\S*/g,
];

/**
 * The head of a `name = value` pair. The value is scanned separately (see `ASSIGNMENT_VALUE`) and only for a secret name, so
 * a long run of `a:a:a:...` costs one short head match per token instead of one whole-rest value scan per token.
 */
const ASSIGNMENT_HEAD = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1([ \t]*[:=][ \t]*)/g;
const ASSIGNMENT_VALUE = /(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"',;&|]+))/y;
const LINE_REST = /[ \t]*(?:\r?\n|$)/y;
const SECRET_WORDS = ["key", "token", "secret", "password", "passwd"];

/** Name tokens (split on non-alphanumerics and camelCase) that end in a secret word: API_KEY, apiKey, client-secret. "keyboard" is not. */
function isSecretName(name: string): boolean {
	const tokens = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/);
	return tokens.some((token) =>
		SECRET_WORDS.some((word) => token.endsWith(word) || token.endsWith(`${word}s`)),
	);
}

/** A value is credential-shaped when it is long or carries a digit: "abcdef123456" is, "key" and "rotation" are not. */
function isCredentialShaped(value: string): boolean {
	return value.length >= 16 || (value.length >= 6 && /\d/.test(value));
}

/** `Bearer <word>` is a credential only when the word looks like one; "the Bearer key" and "Bearer token rotation" are prose. */
function redactBearer(text: string): string {
	return text.replace(BEARER, (match, _space: string, value: string) => {
		const dots = /\.+$/.exec(value)?.[0] ?? "";
		const core = dots ? value.slice(0, -dots.length) : value;
		if (!isCredentialShaped(core)) return match;
		return `${REDACTED}${dots}`;
	});
}

/** The replacement for one `name = value` pair (value starting at `valueStart`), or undefined when it holds no secret. `end` is where the pair ends. */
function assignmentReplacement(
	text: string,
	quote: string,
	name: string,
	sep: string,
	valueStart: number,
): { replacement: string | undefined; end: number } | undefined {
	// Template references and JSX props (`key={id}`, `TOKEN=$TOKEN`) hold no secret; the value is not scanned at all.
	const first = text[valueStart] ?? "";
	if (/^[$({<%]/.test(first)) return { replacement: undefined, end: valueStart };
	ASSIGNMENT_VALUE.lastIndex = valueStart;
	const value = ASSIGNMENT_VALUE.exec(text);
	if (value === null) return undefined;
	const [whole, dq, sq, bare] = value;
	const end = valueStart + whole.length;
	// `the password: is required` and `Key: use import type` are prose: a plain-word name (not an env or header name
	// like `API_KEY`, `X-API-Key`, `db.password`), an unquoted `:`, an unquoted value that neither fills the rest of
	// the line (YAML, header and .env lines do) nor looks like a credential. `password: hunter2` is redacted.
	if (
		sep.includes(":") &&
		quote === "" &&
		bare !== undefined &&
		!/[-_.]/.test(name) &&
		name !== name.toUpperCase()
	) {
		LINE_REST.lastIndex = end;
		const fillsLine = LINE_REST.test(text);
		if (!fillsLine && !isCredentialShaped(bare.replace(/[.,:;!?]+$/, ""))) {
			return { replacement: undefined, end: valueStart };
		}
	}
	const head = `${quote}${name}${quote}${sep}`;
	if (dq !== undefined) return { replacement: `${head}"${REDACTED}"`, end };
	if (sq !== undefined) return { replacement: `${head}'${REDACTED}'`, end };
	return { replacement: `${head}${REDACTED}`, end };
}

function redactAssignments(text: string): string {
	const pattern = new RegExp(ASSIGNMENT_HEAD.source, "g");
	let out = "";
	let copied = 0;
	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		const quote = match[1] ?? "";
		const name = match[2] ?? "";
		const sep = match[3] ?? "";
		const headEnd = match.index + match[0].length;
		// No secret in this match: resume right after its `name =`, so a secret assignment nested in the value
		// (`error: API_KEY=...`, `detail: password: ...`) is still seen. The head regex already stops there.
		if (!isSecretName(name)) continue;
		const result = assignmentReplacement(text, quote, name, sep, headEnd);
		if (result === undefined || result.replacement === undefined) continue;
		out += text.slice(copied, match.index) + result.replacement;
		copied = result.end;
		pattern.lastIndex = result.end;
	}
	return out + text.slice(copied);
}

/**
 * Masks every secret shape in `text` (no exact secrets, no path masking). Throws only if a regex does; `redactSecrets` and
 * `redactText` catch that and fail closed.
 */
export function redactSecretShapes(text: string): string {
	let out = text.replace(PEM_BLOCK, REDACTED);
	out = out.replace(URL_USERINFO, `$1${REDACTED}@`);
	out = out.replace(COOKIE_HEADER, `$1${REDACTED}`);
	out = out.replace(AUTH_HEADER, `$1${REDACTED}`);
	out = redactBearer(out).replace(JWT, REDACTED);
	for (const pattern of SECRET_TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
	return redactAssignments(out);
}

/** The forms one secret takes inside error text: as given, trimmed, JSON-escaped (inside a quoted body) and URL-encoded. A blank secret has none. */
function exactForms(secret: string): string[] {
	const trimmed = secret.trim();
	if (trimmed === "") return [];
	const forms = new Set<string>([secret, trimmed, JSON.stringify(trimmed).slice(1, -1)]);
	forms.add(encodeURIComponent(trimmed));
	return [...forms];
}

/** Replaces every occurrence of every exact secret, longest first, with a literal split/join. */
function maskExact(text: string, exactSecrets: readonly string[]): string {
	const forms = new Set<string>();
	for (const secret of exactSecrets) {
		if (typeof secret !== "string") continue;
		for (const form of exactForms(secret)) forms.add(form);
	}
	let out = text;
	for (const form of [...forms].sort((a, b) => b.length - a.length)) {
		out = out.split(form).join(REDACTED);
	}
	return out;
}

/**
 * Masks every exact secret, then every supported secret shape, so the text is safe to log, throw or print. A non-string
 * input gives "". An exact secret is masked whatever its length; only empty and blank ones are ignored. It does not
 * collapse whitespace and does not truncate: cut the result to the caller's cap afterwards.
 */
export function redactSecrets(text: string, ...exactSecrets: string[]): string {
	try {
		if (typeof text !== "string" || text === "") return "";
		return redactSecretShapes(maskExact(text, exactSecrets)).replace(BEARER_ANY, REDACTED);
	} catch {
		return REDACTED;
	}
}
