# Roadmap: Ultrathink

## Milestones

- Completed **v1.0 Ultrathink on Hermes** — Phases 1–3 (2026-09-25) — [archive](milestones/v1.0-ROADMAP.md).
- Completed **v1.1 Ultrathink for everyone** — Phases 4–6 (2026-09-26) — [archive](milestones/v1.1-ROADMAP.md).
- Completed **v1.2 Greptile-aware planning and merging** — Phases 7–8 (2026-09-26) — [archive](milestones/v1.2-ROADMAP.md).
- Completed **v1.3 Teachable Moments** — Phases 9–14 (2026-10-03) — [archive](milestones/v1.3-ROADMAP.md).
- Completed **v1.4 Session-native reasoning and cross-agent discovery** — Phase 15 (2026-10-08) — [archive](milestones/v1.4-ROADMAP.md).
- Completed **v1.5 Hardening and operability** — Phases 16–22 (2026-10-09) — [archive](milestones/v1.5-ROADMAP.md).
- Completed **v1.6 Cursor pstack bridge** — Phases 23–25 (2026-10-10) — [archive](milestones/v1.6-ROADMAP.md).
- Completed **v1.7 Native Omp GenUI** — Phase 26, 4/4 plans, 10/10 requirements (2026-10-10) — [roadmap](milestones/v1.7-ROADMAP.md), [requirements](milestones/v1.7-REQUIREMENTS.md), [audit](milestones/v1.7-MILESTONE-AUDIT.md).
- Completed locally **v1.8 Unbounded Omp Planning** — Phase 27 (2026-10-10) — [roadmap](milestones/v1.8-ROADMAP.md).
- Completed **v1.9 Measured token savings** — Phases 28–34 (2026-10-17) — [roadmap](milestones/v1.9-ROADMAP.md), [requirements](milestones/v1.9-REQUIREMENTS.md), [audit](milestones/v1.9-MILESTONE-AUDIT.md). Audit: tech_debt. Phase artifacts backfilled 2026-10-17.
- Completed **v1.14 Connector commands and Graph x Chain views** — Phases 63–66, 15 requirements — [roadmap](milestones/v1.14-ROADMAP.md), [requirements](milestones/v1.14-REQUIREMENTS.md), [audit](milestones/v1.14-MILESTONE-AUDIT.md). (v1.10–v1.13 shipped as the vendored token-opt plugin and are not GSD phases; see the Next Milestone note below.)
- Open **v1.15 Enterprise hardening and feature enhancements** — Phases 67–76 (open by owner decision on 2026-11-03; kept open on 2026-10-21; human verification pending for phases 68 to 76, see STATE.md Deferred Verification; the 2026-10-22 closed-and-archived record is superseded) — [roadmap](milestones/v1.15-ROADMAP.md), [requirements](milestones/v1.15-REQUIREMENTS.md), [audit](milestones/v1.15-MILESTONE-AUDIT.md).
- Completed **v1.16 Code quality sweep** — Phases 77–81, tech debt accepted, 2026-10-26 — [roadmap](milestones/v1.16-ROADMAP.md), [requirements](milestones/v1.16-REQUIREMENTS.md), [audit](milestones/v1.16-MILESTONE-AUDIT.md).
- Completed **v1.17 Code quality: verified defects and residuals** — Phases 82–84, 10 requirements, 3 milestone gates, tech debt accepted, 2026-10-26 — [roadmap](milestones/v1.17-ROADMAP.md), [requirements](milestones/v1.17-REQUIREMENTS.md), [audit](milestones/v1.17-MILESTONE-AUDIT.md). Gate evidence: audit addendum 2026-10-27.
- Completed **v1.18 Coding-plan inference** — Phases 85–88, 11 requirements, 3 milestone gates, tech debt accepted, 2026-10-28 — [roadmap](milestones/v1.18-ROADMAP.md), [requirements](milestones/v1.18-REQUIREMENTS.md), [audit](milestones/v1.18-MILESTONE-AUDIT.md). Shipped as PR #65 (`d752bc5`, Greptile 5/5 in round 3, main CI 8 of 8).
- Completed **v1.19 Memory lane and Jev-only OpenRouter** — shipped as PR #66 to #68 (2026-10-28), no GSD phases and no archive (out of that plan's scope) — record in [v1.19-findings.md](v1.19-findings.md).
- Completed **v1.20 USSR Stack interconnect and deployable MCP** — Phases 89–95, 33 requirements, 7 phases, 24 plans, tech debt accepted, 2026-10-28 — [roadmap](milestones/v1.20-ROADMAP.md), [requirements](milestones/v1.20-REQUIREMENTS.md), [audit](milestones/v1.20-MILESTONE-AUDIT.md). Shipped as PR #69 (`20dd8a2`, CI 11 of 11 on head `3ecc125`).
- Completed **v1.21 Pipeline resilience under load** — Phases 96–100, 46 requirements, 5 phases, 17 plans, tech debt accepted, 2026-10-29 — [roadmap](milestones/v1.21-ROADMAP.md), [requirements](milestones/v1.21-REQUIREMENTS.md), [audit](milestones/v1.21-MILESTONE-AUDIT.md). Shipped as PR #70 (`29142a1`, Greptile 5/5 in round 7, CI 11 of 11) and the test-only follow-up PR #71 (`d3cc069`, main CI green).
- Completed **v1.22 CIMD and MCP stateless revision** — Phases 101–108, 30 requirements, tech debt accepted, 2026-11-12 — [roadmap](milestones/v1.22-ROADMAP.md), [requirements](milestones/v1.22-REQUIREMENTS.md), [audit](milestones/v1.22-MILESTONE-AUDIT.md). CIMD withdrawn by owner 2026-11-10; phase 107 is locally verified and not deployed; phase 108 and MCP-12/13 closed as accepted tech debt, no hosted evidence.
- **Tab6a complete for v1.23** (graphId association, ToT PRD, Omp gate, GSD 18 adapters) — direct GoT execution (n2/n4/n6 waves, gsd-n6-18-plugin-connection example); no GSD phases. Recorded in .planning/milestones/v1.23-plugin-portability.md (updated), STATE.md Graph Association + Tab6a GoT close, docs/gsd-review.md. PhaseLoopState + <spec graph> for ToT PRDs. Plugin portability ACs remain partial (AC3/AC5).
- **v1.24 Decompose work** (approved 2026-11-17; phases 109 to 113 in the active section below): SPE-10128 and SPE-7636. See milestones/v1.24-decompose-work.md.
# 4 Tab6a todo items (n2 Omp gate, n4 ToT CodeBlockedPRD, n5 model routing for cheapest on ToT, n6 GSD 18 adapters+graph assoc) MARKED DONE 2026-11-17 (verification: targeted phase-loop/inventory/omp/codeblocked+plan green 10/30/9p; pipeline 41p after minimal runToT flags; GSD18 confirmed 18, graph threaded, ToT PRD attach post CoT). 
Verification correction (2026-11-17): the "complete" and "MARKED DONE" claims above are superseded. Tab6a is implemented in the working tree, uncommitted and unshipped, with the review findings fixed and the Omp host suites at 235 of 235. See STATE.md (Tab6a close) for the open decisions.
## Completed Milestone: v1.22 CIMD and MCP stateless revision

Phases 101–108 (107 verified; 108 closed as accepted tech debt), 30 requirements (CIMD withdrawn; MCP-01–11 satisfied; MCP-12/13 accepted as tech debt), 2026-11-12 — [roadmap](milestones/v1.22-ROADMAP.md), [requirements](milestones/v1.22-REQUIREMENTS.md), [audit](milestones/v1.22-MILESTONE-AUDIT.md).

## Tab6a / v1.23 reconciliation note (2026-11-17; no new phases)

**Tab6a complete** (graphId association, ToT PRD, Omp gate, GSD 18 adapters) for v1.23 plugin portability. Direct GoT execution (n2 Omp gate, n4 ToT CodeBlockedPRD, n6 GSD 18 plugin + graph assoc); graphId e.g. `gsd-n6-18-plugin-connection`. PhaseLoopState declares graphId; ToT PRDs via `<spec graph="...">`. Recorded in .planning/milestones/v1.23-plugin-portability.md (status + Graph Association updated), STATE.md (Graph Association + Tab6a GoT close updated), docs/gsd-review.md. v1.23 plugin AC3/AC5 remain partial; Tab6a marked complete.

## Next Milestone
**v1.13 vendored.** Plugin source is `plugins/omp-token-opt`, commit `40f34b9`, finished in `1392f75`, with fixes in `5f2281b` and `bbef5f6`, linked as `omp-token-opt`.

- v1.10 phases 35–41: missing-graph fast-fail, RTK delta, empty-result collapse, payload size, ledger lock, compact command, TTFT. Bar commit `945f23a`.
- v1.11 phases 42–48: session-scoped dedupe, idle gap, cost cents, graph ready text, source skim, warm-cost note, session-id gate. Bar commit `785797e`.
- v1.12 phases 49–55: cache reads are not savings; bill totals; prefix and tool drift; graphReady flag. Bar commit `abda201`.
- v1.13 phases 56–62: prefix hashes reset on session start, a late usage event is billed once, and `read_span` serves a bounded skim archive. Included in `40f34b9`.
## Backlog after v1.13

- Do not auto-run `graphify extract`.
- Do not inject `cache_control` until a captured Anthropic payload proves the field.
- Do not spend tokens on keep-warm.
- Do not bidirectional-sync generated notes into the human vault.
- One-way `graph.html` publish stays a human browse path, not a prompt input.

## Backlog

- **HERMES-02:** Live proof after a Hermes inference route is funded.
- **JEV-03:** Superseded by PR #77 (the Vercel rail is removed; Decisions run on OpenRouter only). Green live Jev leg needs paid OpenRouter credits: HTTP 402 observed on 2026-10-30.
- **CONNECTOR-LIVE:** First real Grok Chat and Claude Desktop connection (USER_ACTION_1, VALIDATION_1 in `ultrathink-mcp/BLOCKER_LEDGER.md`); needs the operator's accounts and is not claimed by v1.14.
- **MCP-2026-07-28:** Serve the stateless revision (`server/discover`, `Mcp-Method`/`Mcp-Name` headers, `resultType`, `ttlMs`/`cacheScope`) if a hosted client stops falling back; delta and prototype in `milestones/v1.14-phases/63-client-protocol-compatibility/evidence/R1-mcp-2026-07-28-findings.md`. Scheduled as v1.22 phases 106 to 108; 107 and 108 are gated on the trigger.
- **CIMD:** Client ID Metadata Document support to relieve the 10 registrations per hour per IP limit when a hosted client registers on every connect. Scheduled as v1.22 phases 101 to 105. Withdrawn by owner 2026-11-10; phases 104 and 105 are withdrawn.

## Active Milestone: v1.24 Phase lifecycle design and remaining-work decomposition

Approved 2026-11-17; phase 109 complete; phases 110, 111 and 112 deferred for owner verification (verification_deferred_human); phase 113 in gap closure (PR #171). Requirements: `.planning/REQUIREMENTS.md`. Drafts: `.planning/v1.24-REQUIREMENTS-DRAFT.md`, `.planning/v1.24-ROADMAP-DRAFT.md`.
- Wave 5 n7 synthesis (workspace-only working copy, not reviewable from this PR): no phase status changed; phase 114 is 6/7 criteria verified with criterion 7 blocked on Notion payment (403); live Linear/Notion writes stay blocked-on-integration (q3). No targeted-test existence or result claim is made or proved by this PR.

### Phase 109: Design the phase lifecycle

Status: Complete (ADR and state-machine spec merged in PR #116, 2026-11-17).

**Goal:** specify the persistent, checkpointed, audit-gated lifecycle as an ADR and a state-machine spec.
**Requirements:** LIFE-01 to LIFE-05 (design only).
**Depends on:** none.
**Owner:** SomeRandmGuyy
**Success criteria:** the ADR is merged; the state machine lists every phase-loop transition; out-of-repo changes are named.

### Phase 110: Persist and checkpoint the phase loop

Status: Verified human_needed on 2026-11-18 at origin/main 99ce989. The three in-repo criteria are met on a production path: restore at `src/host/omp.ts:2314` via `restoreSessionPhases`; pause and SIGINT/SIGTERM checkpoints via `installKillCheckpoint` (PR #159). The hard kill is a stated limit (ADR 0001). Deferred: verification_deferred_human, resume with `/gsd:verify-work 110`; the live Omp restart and Ctrl-C checks need the owner.

**Goal:** the phase loop writes its state at every transition and resumes after an interrupt.
**Requirements:** LIFE-01, LIFE-04.
**Depends on:** 109.
**Owner:** SomeRandmGuyy
**Success criteria:** a restart restores the same state; an interrupt writes a checkpoint; resume reports what was restored.

### Phase 111: Audit gate and owner override record

Status: Verified human_needed on 2026-11-18 at origin/main 99ce989. The three in-repo criteria are met on a production path: the close refusal and owner-override record (PR #162) and HTIL entries. Deferred: verification_deferred_human, resume with `/gsd:verify-work 111`; the owner identity policy and a live HTIL check need the owner, and the milestone-complete gate is in gsd-core.

**Goal:** a phase or milestone cannot close without an audit record; an override needs a recorded owner decision.
**Requirements:** LIFE-02, LIFE-05.
**Depends on:** 110.
**Owner:** SomeRandmGuyy
**Success criteria:** a close without an audit is refused; an override without an owner record is refused; human items appear as HTIL entries. The milestone-complete gate is in gsd-core (out of repo).

### Phase 112: Single guarded writer for STATE and ROADMAP

Status: Complete at origin/main c3348a2. Criteria 1 and 2 are met in-repo: a four-process contention test, and a contract that matches the writer. Criterion 3, the writer in gsd-core (out of repo), now refuses a write when the file changed since it was read (ConcurrentWriteError); a throwaway check showed a normal write, a refused write after an external change, and no lock left behind; no committed test covers it. Residual: the migration rollback in gsd-core roadmap-upgrade.cjs (lines 2113-2116) can rewrite its snapshot over that external change; not changed. Deferred: verification_deferred_human, resume with `/gsd:verify-work 112`.

**Goal:** one guarded writer for STATE.md and ROADMAP.md; concurrent writes fail loudly.
**Requirements:** LIFE-03.
**Depends on:** 109.
**Owner:** SomeRandmGuyy
**Success criteria:** a concurrent write fails loudly in a test; the contract is documented. The writer itself is in gsd-core (out of repo).

### Phase 113: Decomposition task matrix

Status: Verified 2026-11-18: passed 3/3 success criteria on origin/main a95752c (`phases/113-decomposition-task-matrix/VERIFICATION.md`). The earlier gaps_found (generator classified every Backlog bullet as blocked, stale header, stale row statuses) was closed by PR #171 and PR #173. Matrix regenerated with `bun run matrix`. Residual limits N1 to N4 are recorded in that file; N1 lists human-deferred phases 110 and 112 under Executable now.

**Goal:** a source-grounded task matrix for every remaining phase and Backlog item.
**Requirements:** DEC-01, DEC-02, DEC-03.
**Depends on:** none.
**Owner:** SomeRandmGuyy
**Success criteria:** every remaining phase and Backlog item has a row, each citing its source; the non-overlap check is recorded.
