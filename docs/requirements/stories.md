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

# User Stories: pstack Autonomy Uplift (T3b18-req)

Correlation: `3b18f741-390c-4422-bdd2-4b18499c4490`. Source: `docs/requirements/spec-T3b18-req.md`. Each story states what and how well, never how.

## US-018 — Workflow drives poteto playbooks per phase

As a Michael, I want gsd-autonomous to dispatch the playbook for each phase type through the existing fleet resolver so that each phase runs its poteto playbook through the fleet roster.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: T3b18-req. Scope: discuss, plan, execute, review mapping per PLAYBOOK_ROUTES in src/pstack/subagents.ts; no second resolver.

## US-019 — Missing pstack degrades openly

As a operator, I want an absent pstack install to fall back to vanilla gsd-autonomous with the reason recorded so that a missing plugin never stops a run silently.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: T3b18-req. Scope: fail-open default; fail-closed only under an explicit user override flag.

## US-020 — Autonomy confined inside phases

As a session owner, I want poteto dispatch to start only inside a phase with a PLAN context so that no subagent runs before planning completes.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: T3b18-req. Scope: orchestration order is uplift first, Swarm after, poteto autonomy inside phases.

## US-021 — Phase summary names playbook and fleet

As a release owner, I want each phase to emit 1 summary line naming its playbook and fleet or fallback reason so that I can trace every phase to its driver.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: T3b18-req. Scope: per-unit provenance in phase SUMMARY; 0 silent truncations.

## US-022 — Typed failure states, no silent paths

As a maintainer, I want every fleet outcome typed with a named reason so that disabled, unresolvable, and forced-off states stay distinguishable.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: T3b18-req. Scope: contract states ok, disabled, unresolvable, forced-off, blocked.

## US-023 — Gates green and trackers closed through gateway

As a program owner, I want type, lint, deadcode, and test gates green with Linear and Notion rows closed through the gateway so that the change merges with evidence.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: T3b18-req. Scope: bun run check, biome, knip, bun test; PR to main; CI green before merge.

# User Stories: Dense 500-line XML Prompts via Double Uplift (Tdde6-req)

Correlation: `dde6accb-e288-424f-8913-cb429e5f88ef`. Source: `docs/requirements/spec-Tdde6-req.md`. Each story states what and how well, never how. All 7 scored INVEST 6/6 with req_invest_score; 0 duplicate pairs with req_story_duplicates.

## US-024 — Density loss pinpointed by measurement

As a maintainer, I want density loss pinpointed from measured session XML samples and older branch diffs, so that the restore targets the exact stage where detail was lost.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: Tdde6-req. Scope: FR-1 measurement across `/root/.omp/agent/ultrathink/sessions/*.xml` (263 files, median 327 lines) and `backup/local-main-pre-restore` + `backup/pr53-guards` diffs.

## US-025 — Second uplift after tracker completion

As a session owner, I want a second full uplift pass after tracker rows exist and issue references are injected, so that the final prompt carries the complete plan and its links.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: Tdde6-req. Scope: FR-2 Double Uplift order GoT -> per-node CoT -> XML with rationales -> track complete -> ISSUES injected -> second uplift.

## US-026 — Dense final XML prompt

As a coding agent, I want the final prompt delivered as dense XML of about 500 lines preserving every node rationale and conclusion, so that I execute from complete detail without re-deriving the plan.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: Tdde6-req. Scope: FR-3 density bar, 500+ lines, 100% rationale preservation, Linked-issues carried.

## US-027 — 10th-prompt accounting documented

As a maintainer, I want the prompt-count accounting documented as 1 graph plus 7 node chains plus 2 uplifts equals 10, so that provider limits and costs stay visible and bounded.

- Estimate: 2 points.
- Dependencies: none.
- Priority class: Should.
- Source: Tdde6-req. Scope: FR-4, formula 1 + N + 2 for N in 5..8, defaults N=7.

## US-028 — Full prompt beneath plan summary

As an Omp user, I want the complete final prompt shown beneath the plan summary in normal mode with 0 truncation, so that I read the exact prompt the agent receives.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: Tdde6-req. Scope: FR-6 PR #261 presentation preserved.

## US-029 — No dispatch before final prompt

As a session owner, I want no specialist dispatch before the final prompt lands, so that planning finishes in one order and execution starts only after.

- Estimate: 3 points.
- Dependencies: none.
- Priority class: Must.
- Source: Tdde6-req. Scope: FR-5 dispatch gate.

## US-030 — Trackers closed with evidence, gates green

As a program owner, I want tracker rows closed through the gateway with evidence and gates green before merge, so that the change lands with a clean record.

- Estimate: 5 points.
- Dependencies: none.
- Priority class: Must.
- Source: Tdde6-req. Scope: FR-7 gateway closure, bun run check/test/lint/knip, PR to main, CI green before merge.
