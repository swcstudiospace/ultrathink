# User Stories: ToT Removal Program (Tf0b0-req)

Status: draft. Numbering continues from US-001..US-005 (prior ToT excision spec referenced in docs/blueprint-tot-excision.md and docs/adr/0002). Stories US-006..US-012 cover the non-blocking closeout work. Each story states what and how well, never how.

## US-006 — Prompt starts at once

As a Omp user, I want each prompt to start work at once without a stop step, so that I can keep working while planning finishes in background.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.

## US-007 — Plan arrives as aside

As a Omp user, I want a completed plan to arrive as an aside after the turn starts, so that I see the full plan without losing my place.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.

## US-008 — Validation advises without stopping

As a session owner, I want plan checks to advise without stopping the session, so that an incomplete plan never blocks my work.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.

## US-009 — Hold texts removed

As a maintainer, I want hold and wait texts removed from the codebase, so that no stale instruction reaches the model.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.

## US-010 — Guides describe real behavior

As an operator, I want current guides to describe background planning with no dialog step, so that I follow the real behavior when diagnosing issues.

- Estimate: 2 points.
- Dependencies: none.
- Priority class: Should.

## US-011 — Backlog closed with evidence

As a program owner, I want every ToT and Codeblocked PRD issue closed with evidence, so that the backlog shows no open items for this work.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.

## US-012 — Gates green before merge

As a release owner, I want type, lint, and test gates green before merge, so that the pull request holds production quality.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.

## US-013 — Dead modules removed

As a maintainer, I want the four dead modules removed from the tree so that the codebase carries no unreachable code.

- Estimate: 2 points.
- Dependencies: none.
- Priority class: Must.
- Source: T8751-req corrective closeout (docs/requirements/brief-T8751-req.md). Files: src/host/uplift-gate.ts, src/host/uplift-gate.test.ts, src/track/code-blocked-prd.ts, src/track/code-blocked-prd.test.ts.

## US-014 — Incomplete plan advises only

As a session owner, I want an incomplete plan to produce an advisory note only so that my session never stops.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: T8751-req. Scope: completion-gate incomplete-plan path; 0 STOP/hold/confirm/proceed language on that path.

## US-015 — No tracker-pending notice at prompt time

As an Omp user, I want no tracker-pending notice at prompt time so that the turn starts without interruption and the plan arrives as an aside.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: T8751-req. Scope: omp prompt-time path; any tracker-pending notice moves to the aside only.

## US-016 — Gates green before merge

As a release owner, I want the full gate suite green on this branch so that the corrective closeout merges with production quality.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: T8751-req. Scope: tokenOpt standalone, full bun test, tsc, biome, knip, residual greps; affected tests updated.

## US-017 — Backlog and pull request closed with evidence

As a program owner, I want every ToT and Codeblocked issue and the pull request closed with evidence so that the backlog shows zero open items for this work.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: T8751-req. Scope: Linear closure with evidence; pull request to main updated with a plugin-reload note.
