# Requirements Spec: Corrective Closeout (T8751-req)

Status: draft for gate review. Correlation: 8751d51d-f16a-447f-bba5-2773493f4b03.
Branch: removal/tot-codeblocked-prd. This spec covers the corrective closeout only.
Prior non-blocking closeout spec: docs/requirements/spec.md (Tf0b0-req). Implementation: A05.

## 1. Goal

Remove the 4 dead modules left on this branch, make the completion-gate/omp incomplete-plan
path advisory-only, and close the loop with green gates, Linear closure and a pull-request update.

## 2. Scope

In scope: DELETE src/host/uplift-gate.ts, src/host/uplift-gate.test.ts, src/track/code-blocked-prd.ts,
src/track/code-blocked-prd.test.ts after a zero-import verification; completion-gate incomplete-plan path
advisory-only with no STOP/hold/confirm/proceed language; omp tracker-pending notice removed from prompt
time (aside only); update of affected tests; rerun of tokenOpt standalone, full bun test, tsc, biome,
knip and residual greps; Linear ToT/Codeblocked issue closure with evidence; pull request to main
updated with a plugin-reload note.

Out of scope: implementing code changes (A05); redesigning beyond advisory-only; new features.

## 3. Stakeholders and constraints

Maintainer (zero imports verified before deletion, see brief-T8751-req.md); session owner (incomplete
plan advises, never stops); Omp user (no tracker-pending notice at prompt time); release owner (all
gates green); program owner (Linear closure with evidence); reviewer (plugin-reload note on the pull
request). PII scan found none; no regulated data in scope.

## 4. Stories and criteria

Stories US-013..US-017 in docs/requirements/stories.md. Criteria in docs/acceptance.md under
"Corrective Closeout (T8751-req)": each story carries 2 or 3 criteria, each tied to one story by its
story field, each stating an observable result with a number and naming a check. Manual share: 2 of 11.

## 5. NFRs

NFR-13..NFR-17 in docs/requirements/nfr.md. Perf 1000 ms or less with 0 blocked turns; security 0 secrets
with 100% redaction; a11y 0 color-only meanings; i18n en-US with 0 locale-dependent formats;
compliance 0 new dependencies and 100% AGPL retention.

## 6. Decisions

DELETE the 4 files as a set (each file's own test travels with it; no other file imports them).
Advisory-only: partial gate verdicts become advisory notes on the incomplete-plan path; prompt-time
tracker-pending notice moves to the aside. Affected tests are updated to the advisory contract, not deleted
except the 2 removed test files.

## 7. Assumptions and confidence

Assumption: completion-gate partial verdicts (rows_pending, tracking_incomplete, count shorts, degraded)
are the incomplete-plan path in scope; fatal verdicts (empty, truncated, unclosed root) stay fatal.
Confidence: high. Assumption: Linear closure sets are the ToT/Codeblocked sets from the prior spec;
the pull request reload note means a plugin reload is required after merge. Confidence: high.

## 8. Traceability

Matrix in docs/requirements/traceability.md ("Corrective Closeout (T8751-req)") links every story and
every NFR to its artifacts. Coverage target: 100%.
