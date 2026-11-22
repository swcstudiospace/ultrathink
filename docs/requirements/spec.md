# Requirements Spec: ToT Removal Program (Tf0b0-req)

Status: draft for gate review. Correlation: f0b0e21f-f469-46da-9609-3c4030a11d7f. Branch: removal/tot-codeblocked-prd at a2d676b. Prior ToT excision landed (-7104 lines, docs/blueprint-tot-excision.md, docs/adr/0002, docs/adr/0003). This spec covers the remaining non-blocking closeout only.

## 1. Goal
Remove the new-prompt wait step and the reply-proceed step that existed for Codeblocked PRD long generation, so prompts proceed at once with plan delivery inline when ready or as an aside when late, validation advisory-only, session never STOP-blocked, and the ToT/Codeblocked backlog shows zero open items.

## 2. Scope
In scope: omp host handler and completion gate hold removal; omp and gate test update to the non-blocking contract; architecture, install, troubleshooting, configuration docs update; Linear closure for the ToT/Codeblocked PRD, robustness, pause/proceed sets including SPE-35422-35427, SPE-35369-35375, and carriers with ultrathink:prd markers; type, lint, test and grep gates; pull request update from removal/tot-codeblocked-prd to main.

Out of scope: GoT plus CoT think pipeline behavior; tracker closeout mechanics (closeSubIssue); fail-open skips; aside delivery mechanism itself; CHANGELOG history; runtime install scripts.

## 3. Stakeholders and constraints
Omp session user (needs immediate start), session owner (needs advisory validation), maintainer (needs no stale instructions), operator (needs accurate guides), program owner (needs evidence closure), release owner (needs green gates). Constraints: direct implementation required; human or owner evidence items close as superseded-by-removal, never faked; file-disjoint slices only; ToT excision history untouched.

## 4. Stories and criteria
Stories US-006..US-012 in docs/requirements/stories.md. Criteria 16..29 in docs/acceptance.md (14 criteria, each tied to one story by its story field). Every story carries 2 criteria. Every criterion states an observable result with a number and names a check. Manual share: 0 of 14.

## 5. NFRs
NFR-08..NFR-12 in docs/requirements/nfr.md. Perf 5000 ms handler bound with 0 STOP texts; security 0 secrets and 100% redaction; a11y 0 color-only meanings and 100% dialog-free reading; i18n en-US with 0 locale-dependent formats; compliance 0 new dependencies and 100% AGPL retention.

## 6. Decisions
KEEP closeSubIssue, advisory gate validation, fail-open skips, aside delivery. DELETE hold and wait texts, bounded wait helper, polling timers and blocked flags, dialog and hold doc language. Supersede prior dialog and STOP-hold decisions in the ADR-0003 consequences where they state the session cannot start during generation.

## 7. Assumptions and confidence
Assumption: polling hold removal means polling timers, poll budget, blocked flag, plan provider, and bounded wait helper go, and the gate state for missing plans stops producing STOP texts; if the state value itself is retained for transition compatibility, implementers keep it non-blocking. Confidence: high for handler contract, medium for gate state depth. Assumption: Linear closure counts exclude withdrawn phase-114 annotations, which stay. Confidence: high.

## 8. Traceability
Matrix in docs/requirements/traceability.json links every story and every NFR to its artifacts. Coverage target: 100%. Pull request evidence and gate summaries attach at release time and do not change identifiers.
