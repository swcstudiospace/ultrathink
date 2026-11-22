# Cleaned Brief: Corrective Closeout (T8751-req)

Correlation: 8751d51d-f16a-447f-bba5-2773493f4b03. Branch: removal/tot-codeblocked-prd.
Source: corrective closeout brief in the task.assign (verbatim in the plan record).

## Cleaned text

Corrective closeout on removal/tot-codeblocked-prd: DELETE src/host/uplift-gate.ts,
src/host/uplift-gate.test.ts, src/track/code-blocked-prd.ts, src/track/code-blocked-prd.test.ts
(verify zero imports first); make completion-gate/omp incomplete-plan path advisory-only with no
STOP/hold/confirm/proceed language and no tracker-pending notice at prompt time (aside only);
update affected tests; rerun tokenOpt standalone + full bun test + tsc + biome + knip + residual
greps; close Linear ToT/Codeblocked issues with evidence; update PR to main with plugin-reload note.

## Intake results

- PII scan (req_pii_scan): SUCCESS, found none, has_pii false, regimes_hint empty.
- Ambiguity scan (req_ambiguity_scan): SUCCESS, score 0, sentence_count 7, flagged_sentences 0,
  needs_clarification false.
- Repo evidence gathered: the 4 target files exist; import scan shows 0 imports outside the 4
  files themselves (only each removed file's own test imports it); completion-gate.ts still emits
  partial-failure verdicts (rows_pending, tracking_incomplete) on the incomplete-plan path;
  package.json gates: test (bun test), check (tsc --noEmit), lint (biome check), deadcode (knip).

## Stakeholders and constraints (quoted from the brief)

- Maintainer: "verify zero imports first" before DELETE.
- Session owner: "incomplete-plan path advisory-only with no STOP/hold/confirm/proceed language".
- Omp user: "no tracker-pending notice at prompt time (aside only)".
- Release owner: "rerun tokenOpt standalone + full bun test + tsc + biome + knip + residual greps".
- Program owner: "close Linear ToT/Codeblocked issues with evidence".
- Reviewer: "update PR to main with plugin-reload note".

Out of scope: implementing code changes (A05 owns them); redesigning gate semantics beyond
advisory-only; new features.
