# Phases Inventory

**Generated:** 2026-11-17 (current date per system)
**Focus:** v1.22 (101-108), v1.15 (67-76), older human_needed, complete enumeration of .planning/phases/* and .planning/milestones/*-phases/*
**Source:** glob + bash find/ls + targeted reads of ROADMAP/AUDIT/STATE/MILESTONES + per-phase file checks for CONTEXT, PLAN, SUMMARY, VERIFICATION

## Current Active Phases (.planning/phases/)

| Phase | Dir | CONTEXT | PLANs | SUMMARYs | VERIFICATIONs | Status | Notes |
|-------|-----|---------|-------|----------|---------------|--------|-------|
| 101 | 101-cimd-document-model-no-network | 1 | 2 (01 + PLAN-CHECK) | 1 | 2 (incl dated + main) | complete (passed) | Withdrawn CIMD feature; code removed; v1.22 audit passed |
| 102 | 102-switch-guarded-bounded-fetch | 1 | 2 (01 + PLAN-CHECK) | 1 | 6 (R1-R5 + main) | complete (passed) | Shared guard warning (no prod consumer); v1.22 passed |
| 103 | 103-resolution-cache-storage-failures-and-drift | 1 | 10 (01-02 + 8 PLAN-CHECK-Rx) | 2 | 4 (R1-R3 + main) | complete (passed) | Owner decisions W-1/W-3 open (tech debt); v1.22 passed |
| 106 | 106-mcp-pins-and-trigger-record | 1 | 2 (01 + PLAN-CHECK) | 1 | 2 (dated + main) | complete (passed) | MCP-01..04; v1.22 passed |
| 107 | 107-mcp-2026-07-28-stateless-revision | 1 | 3 (01-03) | 3 | 1 | complete (passed) | MCP-05..11; locally verified; not deployed (PR #86 pending); v1.22 passed |
| 108 | 108-mcp-live-verification-and-revision-docs | 1 | 2 (01-02) | 1 (01 partial) | 0 | **needs VERIFICATION (pending)** | 108-01 SUMMARY: "partial"; no 02-SUMMARY, no 108-LIVE-EVIDENCE.md; MCP-12/13 owner-gated live hosted checks; v1.22 closed as accepted tech debt (no VERIF) |

**Current summary:** 6 phases present. 5/6 verified per v1.22 audit. 108 incomplete (no VERIF, partial docs). Current milestone v1.22 (complete w/ tech debt), current_phase=108 per STATE.md.

## v1.22 Withdrawn (in .planning/milestones/v1.22-withdrawn-cimd-phases/ and retired-originals/)

| Phase | Dir | CONTEXT | PLANs | SUMMARYs | VERIFICATIONs | Status | Notes |
|-------|-----|---------|-------|----------|---------------|--------|-------|
| 104 | 104-advertise-the-flag-and-document-cimd | 1 | multiple (01-05 + checks) | multiple (01-05) | 1 | withdrawn | Owner withdrew 2026-11-10; artifacts preserved for history; CIMD-01..13/15-17 withdrawn |
| 105 | 105-live-cimd-verification | 0 | 0 | 0 | 0 | withdrawn (empty) | Withdrawn; only OWNER-CHECKLIST in some copies; no execution |

## v1.15 Phases (archived, .planning/milestones/v1.15-phases/) — Open milestone w/ human_needed

Per v1.15-MILESTONE-AUDIT (2026-10-21, status: tech_debt) and ROADMAP: "human verification pending for phases 68 to 76"; kept open by owner decision. 2/10 fully verified (67,76); 8 human_needed.

| Phase | Dir | CONTEXT | PLANs | SUMMARYs | VERIFICATIONs | Status (from audit/VERIF) | Notes |
|-------|-----|---------|-------|----------|---------------|---------------------------|-------|
| 67 | 67-enterprise-security-hardening-and-feature-enhancements | 1+ | 1+ | 1+ | 1+ | passed (re-verified in 76) | 7/7; gaps closed in 76 |
| 68 | 68-advanced-audit-logging | 1+ | 1 | 0? | 1+ | human_needed | 7 passed, 5 human_needed (SIEM, Kafka, pager, immutability, off-host) |
| 69 | 69-zero-trust-network-segmentation | 1+ | 1 | 0? | 1+ | human_needed | 1 passed, 4 human_needed (mesh/SPIRE); ZT-03 documented gap |
| 70 | 70-intelligent-rate-limiting | 1+ | 1 | 0? | 1+ | human_needed | 3 passed (incl RATE-03), 3 human_needed (scale, Redis, SIEM) |
| 71 | 71-comprehensive-observability-stack | 1+ | 1 | 0? | 1+ | human_needed | 2 passed, 8 human_needed (collectors, Prometheus, Alertmanager, etc.) |
| 72 | 72-automated-security-scanning-pipeline | 1+ | 1 | 0? | 1+ | human_needed | 2 passed, 4 human_needed (branch prot, DAST, registry, tag) |
| 73 | 73-chaos-engineering-framework | 1+ | 1 | 0? | 1+ | human_needed | 0 passed, 5 human_needed (staging host, scheduling, policy) |
| 74 | 74-enterprise-backup-and-dr | 1+ | 1 | 0? | 1+ | human_needed | 0 passed, 5 human_needed (RPO/failover/RTO/drill/keys) |
| 75 | 75-policy-as-code-governance | 1+ | 1 | 0? | 1+ | human_needed | 1 passed, 4 human_needed (org policy, host evidence, gate, attestation) |
| 76 | 76-v115-gap-closure | 2 | 0 | 0 | 2 | passed | 6/6; PR #50 (f8612af); CI 13/13, Greptile 5/5; closes 67-75 gaps |

**v1.15 overall:** Open. Audit tech_debt. Many live enterprise features (staging, external services) require human operator evidence. PR #46 (091c206) and #50 shipped the work. "milestone complete v1.15 --confirm" irreversible, deferred.

## Other Archived with human_needed / deferred (v1.14, v1.18, some v1.21+)

| Phase(s) | Milestone | Status | human_needed count | Notes |
|----------|-----------|--------|--------------------|-------|
| 63-client-protocol-compatibility | v1.14 | human_needed (VERIF) | 2 live-client items | 6/6 must-haves; completed milestone per ROADMAP but live deferred |
| 64-graph-chain-views | v1.14 | human_needed | listed | Completed in ROADMAP |
| 65-connector-command-surface | v1.14 | human_needed | listed | Completed in ROADMAP |
| 66-stdio-docs-regression | v1.14 | passed | 0 | Completed |
| 85-plan-first-inference-foundations | v1.18 | human_needed (VERIF) | listed | Milestone completed w/ tech debt |
| 87-hosted-service-plan-backend | v1.18 | human_needed (VERIF) | listed | Milestone completed w/ tech debt |
| 100 (and others) | v1.21 | some mention | - | Most passed; v1.21 completed |

v1.16: 77-80 passed, 81 gaps_found (tech debt accepted)
v1.17: 82-84 passed
v1.20: 89-95 all passed
v1.21: 96-100 all passed (some re-verified post-merge)

## Older Phases (v1.0-v1.9) Status

- All listed as completed in ROADMAP.md.
- Artifacts: Many early phases (esp v1.9 28-34) backfilled (per v1.9 audit note "Phase artifacts backfilled 2026-10-17").
- Common pattern: low C/P counts (0-1), S/V present. E.g.:
  - 01-03 (v1.0): full multi-plan (C=1 P=3 S=3 V=1)
  - 28-dependencies (v1.9): C=0 P=1 S=2 V=1
  - 29-34 (v1.9): mostly C=0 P=0 S=1 V=1
  - 22,25 (v1.5/v1.6): some missing C/P
- No active "open" or "human_needed" beyond historical mentions; treated as completed.
- v1.8, v1.7 etc single-phase milestones completed.

**Withdrawn/empty:** 105 (and 104 partial history only).

**Non-phase subdirs picked up in scans (ignored for status):** evidence/, retired-originals/, superseded/, scripts/, greptile/ etc. inside milestone phase trees.

## Open / Pending / Needs Completion or Audit

**Current needing completion/audit:**
- **Phase 108**: No VERIFICATION.md. 01-SUMMARY partial ("plan verification and hosted acceptance remain pending"). 02-PLAN written (for LIVE-EVIDENCE etc.) but no 02-SUMMARY, no 108-LIVE-EVIDENCE.md. Owner-gated live checks vs deployed (MCP-12, MCP-13). v1.22 audit: "missing", accepted as tech debt. Local docs prepared. Uncommitted Tab6a changes noted in git status.
- Phase 107: Locally complete/passed but "not deployed"; PR pending.

**v1.15 open (deferred human_needed):**
- 68-75: human_needed for live/prod verification (staging hosts, external services like SIEM/Kafka/Prometheus/Alertmanager/DAST/registry/drills/policy enforcement etc.). 67+76 passed. Milestone kept open; audit tech_debt. No owner evidence supplied per notes.

**Older deferred (human_needed in VERIFs but milestones marked complete w/ tech debt):**
- v1.14: 63-65 (live client items, mesh etc.)
- v1.18: 85,87
- Some mentions in v1.21/100 and current v1.22 VERIFs (historical references).

**Backlog (from ROADMAP + STATE, non-phase or post-v1.22):**
- HERMES-02: Live proof after Hermes inference route funded.
- JEV-03: Green live (OpenRouter only); needs paid credits (402 observed).
- CONNECTOR-LIVE: Real Grok Chat + Claude Desktop (needs operator accounts).
- MCP-2026-07-28: Stateless revision serve if hosted client stops fallback (106-108 track; 107/108 gated).
- CIMD: Withdrawn (was 101-105).
- v1.23 partial: AC3 (min-version per-host records pending merge?), AC5 (some hosts login-only), AC10 (milestone complete not run?), install rollback, permission model, conformance CI.
- Tab6a: Marked complete for v1.23 (graphId assoc, ToT PRD, Omp gate, GSD 18 adapters); uncommitted changes present.
- General: Do-nots (auto graphify, cache_control, keep-warm, bidirectional notes, graph.html as input).
- Owner decisions open in v1.22 (W-1/W-3 for 103; shared guard wiring).

**Archived needing audit / reconciliation:**
- 14 archived VERIFICATIONs (v1.14, v1.15, v1.18) are "external-evidence records accepted as tech debt" (see ARCHIVED-VERIFICATION-RECONCILIATION-2026-11-12.md). Statuses on disk unchanged.
- Backfilled phases (v1.9 etc.) have sparse artifacts.
- Some phase dirs lack full CONTEXT/PLAN/SUMMARY/VERIF set (minimal for completed older ones).

## Milestone Status Snapshot (from MILESTONES.md, ROADMAP, STATE, AUDITs)

- v1.22: Shipped 2026-11-12 (tech debt accepted). Phases 101-103,106,107 verified; 104/105 withdrawn; 108 closed w/o VERIF. Audit: gaps_found. STATE: status complete, current_phase 108.
- v1.21: Shipped 2026-10-29 (override_closeout, tech debt). 96-100 passed (some re-verif post merge).
- v1.20: Completed (tech debt).
- v1.18: Completed (tech debt, human_needed on 85/87).
- v1.17/16: Completed.
- v1.15: **Open** (human_needed 68-75).
- v1.14: Completed (human_needed on 63-65).
- v1.0-v1.9: All completed (some local-only or backfilled).
- v1.23: Tab6a complete (no new phases); partial ACs; reconciliation done.

**v1.22-STATUS-2026-11-10.md, ARCHIVED-PHASE-REVIEW etc.:** Owner decisions recorded; CIMD removal local only (commit 4f1c350); no deploy.

## Uncommitted / Other Notes
- git status shows multiple M (modified) files (Tab6a related: adapters, docs, src, tests).
- Tab6a complete per STATE/TAB6A-V1.23-RECONCILIATION-SUMMARY.md + v1.23 file.
- No TODOs or new phases beyond 108 started in .planning/phases/.
- Focus areas per assignment covered: globs done, file checks done, v1.22/v1.15/older human_needed enumerated, archived vs current distinguished, needing completion/audit flagged (108 primary current; human_needed deferred in archived open milestone).

**Recommendations for roadmap (inferred):**
- Resolve/audit 108 (owner live evidence or explicit tech-debt close).
- Decide on v1.15 (complete or continue deferring human_needed items).
- Reconcile/audit archived human_needed VERIFs if needed for history.
- Address backlog items as separate (not new GSD phases unless specified).
- Tab6a uncommitted: integrate if part of v1.23 closeout.

Sources: .planning/phases/* (ls/glob), .planning/milestones/* (globs + ls + reads), STATE.md, ROADMAP.md (top + per-version), MILESTONES.md, *AUDIT.md, *REQUIREMENTS.md excerpts, per-phase VERIF/SUMMARY reads, git status.
