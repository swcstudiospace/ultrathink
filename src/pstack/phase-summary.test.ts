// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	PHASE_SUMMARY_LINE_CAP,
	REDACTED_PLACEHOLDER,
	TRUNCATED_MARKER,
	elideWithTruncatedMarker,
	fleetToken,
	formatPhaseSummaryLine,
	renderDispatchGateSurface,
	renderFleetFallbackSurface,
	renderPhaseBlockedSurface,
	renderPhaseSummarySurface,
	renderProvenanceLines,
	resolvePhaseSummaryLine,
	sanitizeRenderText,
	wordTagForState,
	type FleetOutcomeView,
	type PhaseDispatchRecordView,
} from "./phase-summary.ts";

const OK: FleetOutcomeView = {
	state: "ok",
	ok: true,
	reason: "ok",
	fallback: "blocked",
	strict: false,
	playbook: "feature",
};

const FALLBACK: FleetOutcomeView = {
	state: "unresolvable",
	ok: false,
	reason: "no pstack skills resolved",
	fallback: "vanilla",
	strict: false,
	playbook: "feature",
};

const BLOCKED: FleetOutcomeView = {
	state: "blocked",
	ok: false,
	reason: "explicit override active and fleet unresolvable",
	fallback: "blocked",
	strict: true,
	playbook: "feature",
};

describe("word tags (NFR-20: words, never color-only)", () => {
	test("ok carries [ok] and ✓", () => {
		expect(wordTagForState("ok")).toEqual({ tag: "[ok]", symbol: "✓", word: "ok" });
	});
	test("fallback states carry [fallback] and ↪", () => {
		for (const s of ["disabled", "unresolvable", "forced-off"] as const) {
			expect(wordTagForState(s).tag).toBe("[fallback]");
			expect(wordTagForState(s).symbol).toBe("↪");
		}
	});
	test("blocked carries [blocked] and ⊘", () => {
		expect(wordTagForState("blocked")).toEqual({ tag: "[blocked]", symbol: "⊘", word: "blocked" });
	});
});

describe("formatPhaseSummaryLine (SCR-PhaseSummary)", () => {
	test("matches the spec example exactly", () => {
		expect(
			formatPhaseSummaryLine({
				phaseType: "execute",
				playbook: "feature",
				skillNames: ["tdd"],
				outcomeWord: "complete",
				fallback: "blocked",
			}),
		).toBe("[ok] ✓ phase:execute playbook:feature fleet:tdd outcome:complete");
	});
	test("fallback renders fleet:vanilla, not a silent empty", () => {
		expect(
			formatPhaseSummaryLine({
				phaseType: "execute",
				playbook: "feature",
				outcomeWord: "complete",
				fallback: "vanilla",
				state: "unresolvable",
			}),
		).toContain("fleet:vanilla");
	});
	test("fleetToken joins named skills for a resolved fleet", () => {
		expect(fleetToken({ fallback: "blocked" }, ["tdd", "architect"])).toBe("tdd+architect");
		expect(fleetToken({ fallback: "blocked" })).toBe("resolved");
	});
});

describe("elision (never silent)", () => {
	test("short lines pass through unchanged", () => {
		expect(elideWithTruncatedMarker("[ok] phase:plan", 240)).toBe("[ok] phase:plan");
	});
	test("over-cap lines carry the «…truncated» marker in words", () => {
		const long = `[ok] phase:plan playbook:multi-phase-plan fleet:${"skill-".repeat(80)} outcome:complete`;
		const out = elideWithTruncatedMarker(long, 80);
		expect(out.length).toBeLessThanOrEqual(80);
		expect(out).toContain(TRUNCATED_MARKER);
	});
});

describe("resolvePhaseSummaryLine (consumes FleetOutcome.summaryLine)", () => {
	test("backend summaryLine wins verbatim", () => {
		const line = "[ok] phase:execute playbook:feature fleet:tdd outcome:landed";
		expect(
			resolvePhaseSummaryLine(
				{ ...OK, summaryLine: line },
				{ phaseType: "execute", outcomeWord: "ignored" },
			),
		).toBe(line);
	});
	test("blank summaryLine falls back to local format", () => {
		expect(
			resolvePhaseSummaryLine(
				{ ...OK, summaryLine: "  " },
				{ phaseType: "execute", outcomeWord: "complete" },
			),
		).toContain("phase:execute playbook:feature");
	});
});

describe("surfaces (state parity with ux.spec)", () => {
	test("SCR-PhaseSummary: loading/empty/blocked/success/default", () => {
		expect(renderPhaseSummarySurface(OK, { phaseType: "execute" }, "loading")).toEqual([
			"[running] phase:execute … (phase executing; summary pending)",
		]);
		expect(renderPhaseSummarySurface(null, { phaseType: "execute" }, "empty")).toEqual([
			"[info] No phase summary yet. (0 phases completed this run.)",
		]);
		expect(renderPhaseSummarySurface(BLOCKED, { phaseType: "execute" }, "error.blocked")).toEqual([
			"[blocked] phase:execute playbook:feature reason:explicit override active and fleet unresolvable (see SCR-PhaseBlockedNotice)",
		]);
		expect(renderPhaseSummarySurface(OK, { phaseType: "execute" }, "success")).toEqual([
			"[ok] Phase summary emitted: playbook + fleet-or-fallback named. (AC-47)",
		]);
		expect(renderPhaseSummarySurface(OK, { phaseType: "execute", skillNames: ["tdd"] })).toEqual([
			"[ok] ✓ phase:execute playbook:feature fleet:tdd outcome:complete",
		]);
	});
	test("SCR-FleetFallbackNotice: named reason, 0 units stopped", () => {
		const lines = renderFleetFallbackSurface(FALLBACK);
		expect(lines[0]).toContain(
			"[fallback] Poteto fleet unavailable — continuing vanilla gsd-autonomous.",
		);
		expect(lines[1]).toContain(
			"Reason: no pstack skills resolved. (0 units stopped; recorded in SUMMARY.)",
		);
		expect(renderFleetFallbackSurface(null, "empty")).toEqual([
			"[info] No fallback occurred this run. (Fleet resolved; see SCR-PhaseSummary.)",
		]);
		expect(renderFleetFallbackSurface(FALLBACK, "loading")).toEqual([
			"Resolving fleet… N s (fail-open: vanilla continues meanwhile)",
		]);
		expect(renderFleetFallbackSurface(FALLBACK, "error.network")).toEqual([
			"Fleet resolution error (network). Continuing vanilla; reason recorded.",
		]);
	});
	test("SCR-PhaseBlockedNotice: 0 vanilla units, phase held", () => {
		expect(renderPhaseBlockedSurface(BLOCKED)).toEqual([
			"[blocked] Phase blocked: explicit override active and fleet unresolvable.",
			"(0 vanilla units ran; phase did not advance.)",
		]);
		expect(
			renderPhaseBlockedSurface(BLOCKED, "error.missing-playbook", {
				path: "playbooks/feature.md",
				unit: "U1",
			}),
		).toEqual(["[blocked] Missing playbook playbooks/feature.md for unit U1; 0 improvised steps."]);
		expect(renderPhaseBlockedSurface(null, "empty")).toEqual(["[info] No blocked units this run."]);
	});
	test("SCR-DispatchGate: order notice, 0 dispatch before PLAN", () => {
		expect(renderDispatchGateSurface()).toEqual([
			"[info] Order: uplift → swarm → poteto inside phases. (0 dispatch before PLAN.)",
		]);
		expect(renderDispatchGateSurface("success")).toEqual([
			"[ok] PLAN exists; poteto dispatch allowed inside phase. (AC-46)",
		]);
	});
});

describe("provenance (per-unit rows for SUMMARY)", () => {
	test("one row per unit naming phase, playbook, outcome", () => {
		const records: PhaseDispatchRecordView[] = [
			{
				phaseType: "execute",
				playbook: "feature",
				state: "ok",
				fallback: "blocked",
				strict: false,
				reason: "ok",
				units: [
					{ unit: "U1", outcome: "landed" },
					{ unit: "U2", outcome: "failed", detail: "red unit retry" },
				],
			},
		];
		const lines = renderProvenanceLines(records);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("phase:execute playbook:feature unit:U1 outcome:landed");
		expect(lines[0]).toContain("state:ok fallback:blocked strict:off reason:ok");
		expect(lines[1]).toContain("unit:U2 outcome:failed");
		expect(lines[1]).toContain("detail:red unit retry");
	});
	test("empty records render no rows (empty state)", () => {
		expect(renderProvenanceLines([])).toEqual([]);
	});
});

describe("THREAT-FE-RENDER defense-in-depth (reason/detail sanitized before render)", () => {
	// Fake secret-shaped fixtures, assembled at runtime so no literal secret
	// lands in source (the secret scan would otherwise flag this test file).
	const FAKE_SK = ["sk-", "FAKETOKEN1234567"].join("");
	const FAKE_GH = ["ghp_", "A".repeat(21)].join("");
	const FAKE_ASSIGN = ["api_", "key=FAKESECRETVALUE123"].join("");

	test("sanitizeRenderText redacts secret-shaped substrings (NFR-19), passes normal text through", () => {
		expect(sanitizeRenderText("no pstack skills resolved")).toBe("no pstack skills resolved");
		expect(sanitizeRenderText(`fleet failed ${FAKE_SK} now`)).toBe(
			`fleet failed ${REDACTED_PLACEHOLDER} now`,
		);
		expect(sanitizeRenderText(`token ${FAKE_GH} seen`)).toBe(`token ${REDACTED_PLACEHOLDER} seen`);
		expect(sanitizeRenderText(`leaked ${FAKE_ASSIGN} here`)).toBe(
			`leaked ${REDACTED_PLACEHOLDER} here`,
		);
		expect(sanitizeRenderText("Bearer abc.def.ghi")).toBe(REDACTED_PLACEHOLDER);
	});

	test("strips HTML markup and collapses whitespace to one plain line (NFR-20)", () => {
		const out = sanitizeRenderText("<script>alert(1)</script>  line1\nline2\tend  ");
		expect(out).not.toContain("<");
		expect(out).not.toContain(">");
		expect(out).not.toContain("\n");
		expect(out).not.toContain("\t");
		expect(out).toContain("line1 line2 end");
		expect(out).not.toContain("script");
	});

	test("preserves word tags/symbols; empty stays empty; never throws", () => {
		expect(sanitizeRenderText("[ok] ✓ phase:execute")).toBe("[ok] ✓ phase:execute");
		expect(sanitizeRenderText(TRUNCATED_MARKER)).toBe(TRUNCATED_MARKER);
		expect(sanitizeRenderText("   ")).toBe("");
		expect(sanitizeRenderText("")).toBe("");
		expect((sanitizeRenderText as (v: unknown) => string)(undefined)).toBe("");
	});

	test("provenance rows redact detail, collapse newlines, keep one row per unit", () => {
		const records: PhaseDispatchRecordView[] = [
			{
				phaseType: "execute",
				playbook: "feature",
				state: "blocked",
				fallback: "blocked",
				strict: true,
				reason: `blocked\nwith ${FAKE_SK} and <b>markup</b>`,
				units: [{ unit: "U1", outcome: "failed", detail: `retry ${FAKE_GH} done` }],
			},
		];
		const lines = renderProvenanceLines(records);
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain("\n");
		expect(lines[0]).not.toContain(FAKE_SK);
		expect(lines[0]).not.toContain(FAKE_GH);
		expect(lines[0]).not.toContain("<");
		expect(lines[0]).toContain(REDACTED_PLACEHOLDER);
		expect(lines[0]).toContain("outcome:failed");
	});

	test("surfaces keep word tags while redacting reason (fallback/blocked/summary/resolve)", () => {
		const FAKE_IMG = ["<im", "g src=x>"].join("");
		const malicious = `no fleet ${FAKE_SK} ${FAKE_IMG}`;
		const fallback = renderFleetFallbackSurface({ ...FALLBACK, reason: malicious });
		expect(fallback[0]).toStartWith("[fallback]");
		expect(fallback[1]).toContain(REDACTED_PLACEHOLDER);
		expect(fallback[1]).not.toContain(FAKE_SK);
		expect(fallback.join(" ")).not.toContain("<");

		const blocked = renderPhaseBlockedSurface({ ...BLOCKED, reason: malicious });
		expect(blocked[0]).toStartWith("[blocked]");
		expect(blocked[0]).toContain(REDACTED_PLACEHOLDER);
		expect(blocked[0]).not.toContain(FAKE_SK);

		const summary = renderPhaseSummarySurface(
			{ ...BLOCKED, reason: malicious },
			{ phaseType: "execute" },
			"error.blocked",
		);
		expect(summary[0]).toStartWith("[blocked]");
		expect(summary[0]).toContain(REDACTED_PLACEHOLDER);
		expect(summary[0]).not.toContain(FAKE_SK);

		const resolved = resolvePhaseSummaryLine(
			{ ...OK, summaryLine: `[ok] phase:execute leaked ${FAKE_SK}` },
			{ phaseType: "execute", outcomeWord: "ignored" },
		);
		expect(resolved).toContain(REDACTED_PLACEHOLDER);
		expect(resolved).not.toContain(FAKE_SK);
	});

	test("over-long adversarial reason is capped with the explicit marker, never silent", () => {
		const lines = renderPhaseBlockedSurface({
			...BLOCKED,
			reason: `${FAKE_SK} ${"x".repeat(600)}`,
		});
		const firstLine = lines[0] ?? "";
		expect(firstLine.length).toBeLessThanOrEqual(PHASE_SUMMARY_LINE_CAP);
		expect(firstLine).toContain(TRUNCATED_MARKER);
		expect(firstLine).toContain(REDACTED_PLACEHOLDER);
	});
});
