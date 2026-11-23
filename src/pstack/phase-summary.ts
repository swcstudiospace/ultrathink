// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Phase-summary presentation (SCR-PhaseSummary, SCR-FleetFallbackNotice,
 * SCR-PhaseBlockedNotice, SCR-DispatchGate; ux.spec 1.3, tokens 0.1.0).
 *
 * Consumes the typed FleetOutcome / PhaseDispatchRecord contract
 * (contracts/pstack-dispatch.openapi.json@1.3.0) and resolves nothing:
 * fleet resolution stays in subagents.ts, dispatch state stays with the
 * backend owner. When a FleetOutcome arrives with `summaryLine`, that line
 * is consumed verbatim; otherwise this module formats the same one-line
 * shape locally so a backend that has no formatter yet still renders.
 *
 * NFR-20: status is never color-only. Every line carries a word tag
 * ([ok] / [fallback] / [blocked] / [info] / [running]) plus a symbol
 * (✓ / ↪ / ⊘); colour (success/warning/error tokens) is decorative only
 * and there is no colour in this text surface at all. Elision is never
 * silent: any cut carries the explicit «…truncated» marker in words.
 */

/** FleetOutcome.state values (contract: FleetOutcome.state). */
export type FleetOutcomeState = "ok" | "disabled" | "unresolvable" | "forced-off" | "blocked";
/** Contract FleetOutcome.fallback values. */
export type FleetFallback = "vanilla" | "blocked";
/** Phase types a pstack playbook can play (PLAYBOOK_ROUTES stages). */
export type PhaseType = "discuss" | "plan" | "execute" | "review";
/** Contract PhaseDispatchRecord unit outcomes. */
export type DispatchUnitOutcome = "landed" | "blocked" | "failed";

/** Presentation view of contract FleetOutcome; only rendered fields. */
export interface FleetOutcomeView {
	readonly state: FleetOutcomeState;
	readonly ok: boolean;
	readonly reason: string;
	readonly reasonCode?: string;
	readonly fallback: FleetFallback;
	readonly strict: boolean;
	readonly playbook?: string;
	readonly summaryLine?: string;
	readonly roster?: string | null;
}

/** Presentation view of contract PhaseDispatchRecord; only rendered fields. */
export interface PhaseDispatchRecordView {
	readonly phaseType: PhaseType;
	readonly playbook: string;
	readonly state: FleetOutcomeState;
	readonly fallback: FleetFallback;
	readonly strict: boolean;
	readonly reason: string;
	readonly units: readonly PhaseDispatchUnitView[];
}

export interface PhaseDispatchUnitView {
	readonly unit: string;
	readonly outcome: DispatchUnitOutcome;
	readonly detail?: string;
}

export type PhaseSummaryUiState = "default" | "loading" | "error.blocked" | "empty" | "success";
export type FleetFallbackUiState = "default" | "loading" | "error.network" | "empty" | "success";
export type PhaseBlockedUiState =
	| "default"
	| "loading"
	| "error.blocked"
	| "error.missing-playbook"
	| "empty"
	| "success";
export type DispatchGateUiState = "default" | "loading" | "error.network" | "empty" | "success";

/** Default one-line cap; mirrors the roster cap family in subagents.ts. */
export const PHASE_SUMMARY_LINE_CAP = 240;
/** Explicit elision marker required by the spec (never silent truncation). */
export const TRUNCATED_MARKER = "«…truncated»";

/** Placeholder for a redacted secret-shaped substring (NFR-19). */
export const REDACTED_PLACEHOLDER = "[redacted]";

/**
 * Secret-shaped substrings never survive into a rendered line (NFR-19,
 * defense-in-depth): the families the backend redactor covers
 * (`src/pstack/outcome.ts` SECRET_PATTERNS) plus the repo token families in
 * `src/redact.ts` SECRET_TOKEN_PATTERNS. Mirrored here (not imported) so the
 * presentation module stays dependency-free; anything else passes through.
 */
const RENDER_SECRET_PATTERNS: readonly RegExp[] = [
	/\bsk-or-[A-Za-z0-9_-]+/g,
	/\bsk-ant-[A-Za-z0-9_-]{8,}/g,
	/\bsk-[A-Za-z0-9_-]{8,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\b(?:api[_-]?key|password|passwd|secret|token|authorization|bearer)\s*[:=]\s*\S+/gi,
	/\bBearer\s+\S+/g,
];

/**
 * Defense-in-depth sanitization for backend-supplied `reason` / `detail` /
 * `summaryLine` (and identifier) text before it reaches a rendered line
 * (THREAT-FE-RENDER): backends already redact (NFR-19), but the renderer
 * never trusts that and re-redacts. Returns plain one-line text: secrets
 * become `[redacted]`, HTML markup is stripped, control, zero-width and
 * bidi characters are removed, and whitespace runs (including newlines)
 * collapse to single spaces. Word tags, symbols and the «…truncated»
 * marker are added by this module after sanitizing, so word tags stay
 * untouched by construction. Never throws; non-string or empty input
 * yields "".
 */
export function sanitizeRenderText(text: string): string {
	if (typeof text !== "string") return "";
	let out = text;
	for (const pattern of RENDER_SECRET_PATTERNS) out = out.replace(pattern, REDACTED_PLACEHOLDER);
	// Strip HTML-ish markup so a reason can never become a tag or attribute.
	out = out.replace(/<[^>]*>?/g, " ").replace(/[<>]/g, " ");
	// Plain one-line text: collapse every whitespace run (including
	// newlines/tabs) BEFORE control-character removal, so line breaks
	// become separators instead of vanishing.
	out = out.replace(/\s+/g, " ");
	// Remove remaining control, zero-width and bidi characters.
	out = out.replace(/[\u0000-\u001F\u007f-\u009f\u200b-\u200f\u202a-\u202e\ufeff]/g, "");
	out = out.replace(/\s+/g, " ").trim();
	return out;
}

/** Word tag + symbol per state; the words are the accessible signal (NFR-20). */
export function wordTagForState(state: FleetOutcomeState): {
	tag: string;
	symbol: string;
	word: string;
} {
	if (state === "ok") return { tag: "[ok]", symbol: "✓", word: "ok" };
	if (state === "blocked") return { tag: "[blocked]", symbol: "⊘", word: "blocked" };
	return { tag: "[fallback]", symbol: "↪", word: "fallback" };
}

/**
 * Elides `text` to `cap` code units, never silently: any cut appends the
 * explicit «…truncated» marker in words. Text at or under the cap, and
 * empty input, pass through unchanged.
 */
export function elideWithTruncatedMarker(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const budget = Math.max(0, cap - TRUNCATED_MARKER.length - 1);
	return `${text.slice(0, budget)} ${TRUNCATED_MARKER}`;
}

/** `fleet:<skills-or-fallback>` token: named skills, or the fallback target. */
export function fleetToken(
	outcome: Pick<FleetOutcomeView, "fallback">,
	skillNames: readonly string[] = [],
): string {
	if (outcome.fallback === "vanilla") return "vanilla";
	const named = skillNames.map((n) => sanitizeRenderText(n)).filter(Boolean);
	return named.length > 0 ? named.join("+") : "resolved";
}

/**
 * One-line phase summary format (SCR-PhaseSummary):
 * `[<state>] phase:<type> playbook:<title> fleet:<skills-or-fallback> outcome:<outcome>`
 * e.g. `[ok] phase:execute playbook:feature fleet:tdd outcome:complete`.
 */
export function formatPhaseSummaryLine(input: {
	phaseType: PhaseType;
	playbook: string;
	skillNames?: readonly string[];
	outcomeWord: string;
	fallback: FleetFallback;
	state?: FleetOutcomeState;
}): string {
	const state = input.state ?? "ok";
	const { tag, symbol } = wordTagForState(state);
	const playbook = sanitizeRenderText(input.playbook) || "unresolved";
	const outcomeWord = sanitizeRenderText(input.outcomeWord) || "complete";
	const line = `${tag} ${symbol} phase:${input.phaseType} playbook:${playbook} fleet:${fleetToken(input, input.skillNames)} outcome:${outcomeWord}`;
	return elideWithTruncatedMarker(line, PHASE_SUMMARY_LINE_CAP);
}

/**
 * Resolves the line to render for one phase: consumes `summaryLine` from
 * the FleetOutcome when the backend supplied it, otherwise formats the
 * same shape locally. Elision marker applies either way.
 */
export function resolvePhaseSummaryLine(
	outcome: FleetOutcomeView,
	input: { phaseType: PhaseType; skillNames?: readonly string[]; outcomeWord: string },
): string {
	const backendLine = sanitizeRenderText(outcome.summaryLine ?? "");
	if (backendLine) {
		return elideWithTruncatedMarker(backendLine, PHASE_SUMMARY_LINE_CAP);
	}
	return formatPhaseSummaryLine({
		phaseType: input.phaseType,
		playbook: outcome.playbook ?? "unresolved",
		skillNames: input.skillNames,
		outcomeWord: input.outcomeWord,
		fallback: outcome.fallback,
		state: outcome.state,
	});
}

/** Per-unit provenance rows for the phase SUMMARY (SCR-PhaseSummary/ProvenanceList). */
export function renderProvenanceLines(
	records: readonly PhaseDispatchRecordView[],
	cap = PHASE_SUMMARY_LINE_CAP,
): string[] {
	return records.flatMap((record) => {
		const reason = sanitizeRenderText(record.reason);
		const playbook = sanitizeRenderText(record.playbook);
		return record.units.map((unit) => {
			const sanitizedDetail = sanitizeRenderText(unit.detail ?? "");
			const detail = sanitizedDetail ? ` detail:${sanitizedDetail}` : "";
			const line =
				`phase:${record.phaseType} playbook:${playbook} unit:${sanitizeRenderText(unit.unit)} ` +
				`outcome:${unit.outcome} state:${record.state} fallback:${record.fallback} ` +
				`strict:${record.strict ? "on" : "off"} reason:${reason}${detail}`;
			return elideWithTruncatedMarker(line, cap);
		});
	});
}

/** SCR-PhaseSummary surface: one line per phase; full rows live in SUMMARY. */
export function renderPhaseSummarySurface(
	outcome: FleetOutcomeView | null,
	input: { phaseType: PhaseType; skillNames?: readonly string[]; outcomeWord?: string },
	uiState: PhaseSummaryUiState = "default",
): string[] {
	if (uiState === "loading") {
		return [`[running] phase:${input.phaseType} … (phase executing; summary pending)`];
	}
	if (uiState === "empty" || outcome === null) {
		return ["[info] No phase summary yet. (0 phases completed this run.)"];
	}
	if (uiState === "error.blocked" || outcome.state === "blocked") {
		const line = `[blocked] phase:${input.phaseType} playbook:${sanitizeRenderText(outcome.playbook ?? "unresolved") || "unresolved"} reason:${sanitizeRenderText(outcome.reason)} (see SCR-PhaseBlockedNotice)`;
		return [elideWithTruncatedMarker(line, PHASE_SUMMARY_LINE_CAP)];
	}
	if (uiState === "success") {
		return [`[ok] Phase summary emitted: playbook + fleet-or-fallback named. (AC-47)`];
	}
	return [
		resolvePhaseSummaryLine(outcome, { ...input, outcomeWord: input.outcomeWord ?? "complete" }),
	];
}

/** SCR-FleetFallbackNotice surface (fail-open: vanilla continues, 0 units stopped). */
export function renderFleetFallbackSurface(
	outcome: FleetOutcomeView | null,
	uiState: FleetFallbackUiState = "default",
): string[] {
	if (uiState === "loading") {
		return ["Resolving fleet… N s (fail-open: vanilla continues meanwhile)"];
	}
	if (uiState === "error.network") {
		return ["Fleet resolution error (network). Continuing vanilla; reason recorded."];
	}
	if (uiState === "empty" || outcome === null) {
		return ["[info] No fallback occurred this run. (Fleet resolved; see SCR-PhaseSummary.)"];
	}
	if (uiState === "success") {
		return ["[fallback] Fallback notice shown with named reason; run continued. (AC-44)"];
	}
	const reason = sanitizeRenderText(outcome.reason) || "unspecified";
	return [
		"[fallback] Poteto fleet unavailable — continuing vanilla gsd-autonomous.",
		elideWithTruncatedMarker(
			`Reason: ${reason}. (0 units stopped; recorded in SUMMARY.)`,
			PHASE_SUMMARY_LINE_CAP,
		),
	];
}

/** SCR-PhaseBlockedNotice surface (strict/override: phase held, 0 vanilla units ran). */
export function renderPhaseBlockedSurface(
	outcome: FleetOutcomeView | null,
	uiState: PhaseBlockedUiState = "default",
	missingPlaybook?: { path: string; unit: string },
): string[] {
	if (uiState === "loading") {
		return ["Resolving fleet (override active)… N s"];
	}
	if (uiState === "empty" || outcome === null) {
		return ["[info] No blocked units this run."];
	}
	if (uiState === "error.missing-playbook" && missingPlaybook) {
		const line = `[blocked] Missing playbook ${sanitizeRenderText(missingPlaybook.path)} for unit ${sanitizeRenderText(missingPlaybook.unit)}; 0 improvised steps.`;
		return [elideWithTruncatedMarker(line, PHASE_SUMMARY_LINE_CAP)];
	}
	if (uiState === "error.blocked") {
		const reason = sanitizeRenderText(outcome.reason) || "unspecified";
		return [
			elideWithTruncatedMarker(
				`[blocked] Explicit override active and fleet unresolvable: ${reason}.`,
				PHASE_SUMMARY_LINE_CAP,
			),
		];
	}
	if (uiState === "success") {
		return ["[blocked] Block reason shown with named path/reason; phase held. (AC-45, AC-48)"];
	}
	const reason = sanitizeRenderText(outcome.reason) || "unspecified";
	return [
		elideWithTruncatedMarker(`[blocked] Phase blocked: ${reason}.`, PHASE_SUMMARY_LINE_CAP),
		"(0 vanilla units ran; phase did not advance.)",
	];
}

/** SCR-DispatchGate surface (uplift → swarm → poteto inside phases; 0 dispatch before PLAN). */
export function renderDispatchGateSurface(uiState: DispatchGateUiState = "default"): string[] {
	switch (uiState) {
		case "loading":
			return ["Planning… uplift N s (0 subagents spawned)"];
		case "error.network":
			return ["Planning unavailable (network). 0 subagents spawned; session waits."];
		case "empty":
			return ["[info] No dispatch gate reached yet. (Awaiting uplifted prompt.)"];
		case "success":
			return ["[ok] PLAN exists; poteto dispatch allowed inside phase. (AC-46)"];
		default:
			return ["[info] Order: uplift → swarm → poteto inside phases. (0 dispatch before PLAN.)"];
	}
}
